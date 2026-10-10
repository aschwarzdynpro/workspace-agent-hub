import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { compact, readTranscriptSummary } from "./claudeProjects";
import { Emitter } from "./emitter";
import { normalizePath } from "./paths";
import { Root, Session, SessionStatus, SpoolEvent } from "./types";

/**
 * Tails the NDJSON spool written by hooks/hub-event.js and keeps an in-memory
 * session table. Pure state machine: no `vscode` import, so it runs under plain Node tests.
 *
 * Status transitions (per session):
 *   SessionStart            → done   (ready for a prompt)
 *   UserPromptSubmit        → working
 *   PreToolUse / PostToolUse→ working (currentTool = tool_name)
 *   Notification            → waiting (permission / idle prompt / question)
 *   Stop                    → done
 *   SessionEnd              → ended
 *   (no events for N min)   → idle   (computed on read)
 *   hub terminal closed     → ended
 *
 * Ended sessions and sessions silent for PRUNE_AFTER_MS are dropped on the next tick.
 */
const PRUNE_AFTER_MS = 24 * 60 * 60_000;
/**
 * Tools that block until the user answers in the terminal. No Notification is guaranteed for
 * them, so the PreToolUse itself means "waiting"; the PostToolUse after the answer clears it.
 */
const QUESTION_TOOLS = new Map([
  ["AskUserQuestion", "Claude asks a question"],
  ["ExitPlanMode", "Plan ready for your approval"],
]);
/** On start only the tail of the spool is replayed; older events cannot matter after pruning anyway. */
const REPLAY_TAIL_BYTES = 8 * 1024 * 1024;

export interface TrackerSettings {
  spoolPath: string;
  staleAfterMs: number;
}

export interface TrackerLog {
  appendLine(line: string): void;
}

export class SessionTracker {
  private readonly sessions = new Map<string, Session>();
  private readonly _onDidChange = new Emitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidStartWaiting = new Emitter<Session>();
  /** A session started waiting for the user. Live events only, never during the replay on start. */
  readonly onDidStartWaiting = this._onDidStartWaiting.event;
  private replaying = false;
  private startedWaiting: Session[] = [];

  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");
  /** Set when replay starts mid-file: the first (partial) line is discarded. */
  private skipFirstLine = false;
  /** Sessions whose transcript title was already looked up (avoid re-reading on every event). */
  private readonly titleTried = new Set<string>();
  /** Hub terminals that were closed: late events from them must not revive their session. */
  private readonly closedTerminals = new Set<string>();
  private watcher?: fs.FSWatcher;
  private poll?: NodeJS.Timeout;
  private roots: Root[] = [];
  private spool = "";
  private debounce?: NodeJS.Timeout;

  constructor(
    private readonly log: TrackerLog,
    private readonly settings: () => TrackerSettings
  ) {}

  setRoots(roots: Root[]): void {
    this.roots = roots;
    // Re-assign sessions whose root may have appeared.
    for (const s of this.sessions.values()) {
      if (!s.rootId) s.rootId = this.rootIdFor(s.cwd) ?? "";
    }
    this.fire();
  }

  start(): void {
    this.stop();
    this.spool = this.settings().spoolPath;
    this.partial = "";
    this.decoder = new StringDecoder("utf8");
    this.sessions.clear();
    this.titleTried.clear();
    try {
      fs.mkdirSync(path.dirname(this.spool), { recursive: true });
      if (!fs.existsSync(this.spool)) fs.writeFileSync(this.spool, "");
    } catch (e) {
      this.log.appendLine(`cannot create spool ${this.spool}: ${String(e)}`);
    }
    let size = 0;
    try {
      size = fs.statSync(this.spool).size;
    } catch {
      size = 0;
    }
    this.offset = Math.max(0, size - REPLAY_TAIL_BYTES);
    // Discard the first line only if the cut lands mid-line.
    this.skipFirstLine = this.offset > 0 && !this.byteBeforeOffsetIsNewline();
    this.replaying = true;
    try {
      this.readNew(); // replay history so restarts keep state
    } finally {
      this.replaying = false;
    }
    this.prune();
    this.fire();
    try {
      this.watcher = fs.watch(this.spool, () => this.scheduleRead());
    } catch (e) {
      this.log.appendLine(`fs.watch failed, polling only: ${String(e)}`);
    }
    // fs.watch is unreliable on some platforms/filesystems: poll as a fallback.
    this.poll = setInterval(() => this.scheduleRead(), 2000);
    this.log.appendLine(`tracking ${this.spool}`);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  dispose(): void {
    this.stop();
    this._onDidChange.dispose();
    this._onDidStartWaiting.dispose();
  }

  all(): Session[] {
    const now = Date.now();
    const stale = this.settings().staleAfterMs;
    return [...this.sessions.values()].map((s) => {
      if ((s.status === "done" || s.status === "working") && now - s.lastEventAt > stale) {
        return { ...s, status: "idle" as SessionStatus };
      }
      return s;
    });
  }

  forRoot(rootId: string): Session[] {
    return this.all()
      .filter((s) => s.rootId === rootId)
      .sort((a, b) => rank(a.status) - rank(b.status) || b.lastEventAt - a.lastEventAt);
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    return s ? this.all().find((x) => x.id === s.id) : undefined;
  }

  counts(): Record<SessionStatus, number> {
    const c: Record<SessionStatus, number> = { working: 0, waiting: 0, done: 0, idle: 0, ended: 0 };
    for (const s of this.all()) c[s.status]++;
    return c;
  }

  /** Re-notify listeners so derived state (idle, relative times) is recomputed without new events. */
  tick(): void {
    this.prune();
    this.fire();
  }

  /** A hub terminal was closed: its session cannot be running any more. */
  terminalClosed(terminalId: string): void {
    this.readNew(); // apply events already in the spool first, so they cannot override "ended"
    this.closedTerminals.add(terminalId);
    this.pendingTerminals.delete(terminalId);
    let changed = false;
    for (const s of this.sessions.values()) {
      if (s.terminalId === terminalId && s.status !== "ended") {
        s.status = "ended";
        changed = true;
      }
    }
    if (changed) this.fire();
  }

  /** Called by the terminal launcher so a freshly spawned terminal is linked before the first event. */
  expectSession(terminalId: string, rootId: string): void {
    this.pendingTerminals.set(terminalId, rootId);
  }
  private readonly pendingTerminals = new Map<string, string>();

  // ---- internals ------------------------------------------------------------

  private scheduleRead(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.readNew();
    }, 150);
  }

  private readNew(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.spool);
    } catch {
      return;
    }
    if (st.size < this.offset) {
      // truncated / rotated
      this.offset = 0;
      this.partial = "";
      this.decoder = new StringDecoder("utf8");
    }
    if (st.size === this.offset) return;

    const fd = fs.openSync(this.spool, "r");
    try {
      const buf = Buffer.alloc(st.size - this.offset);
      let read = 0;
      while (read < buf.length) {
        const n = fs.readSync(fd, buf, read, buf.length - read, this.offset + read);
        if (n === 0) break;
        read += n;
      }
      this.offset += read;
      // StringDecoder keeps a multi-byte character that was cut mid-write for the next read.
      const text = this.partial + this.decoder.write(buf.subarray(0, read));
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
      if (this.skipFirstLine && lines.length) {
        lines.shift();
        this.skipFirstLine = false;
      }
      let changed = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          changed = this.apply(JSON.parse(line) as SpoolEvent) || changed;
        } catch (e) {
          this.log.appendLine(`bad spool line: ${line.slice(0, 120)} (${String(e)})`);
        }
      }
      if (changed) this.fire();
      const started = this.startedWaiting;
      this.startedWaiting = [];
      for (const s of started) if (this.sessions.get(s.id)?.status === "waiting") this._onDidStartWaiting.fire({ ...s });
    } finally {
      fs.closeSync(fd);
    }
  }

  private apply(ev: SpoolEvent): boolean {
    if (!ev.session_id) return false;
    const ts = Date.parse(ev.ts) || Date.now();
    let s = this.sessions.get(ev.session_id);
    if (!s) {
      s = {
        id: ev.session_id,
        rootId: this.rootIdFor(ev.cwd) ?? (ev.terminal ? this.pendingTerminals.get(ev.terminal) ?? "" : ""),
        cwd: ev.cwd,
        status: "done",
        title: "",
        lastEventAt: ts,
        startedAt: ts,
        lastEvent: ev.event,
        turns: 0,
        transcriptPath: ev.transcript_path ?? undefined,
        terminalId: ev.terminal ?? undefined,
      };
      this.sessions.set(s.id, s);
    }
    if (ev.terminal) {
      s.terminalId = ev.terminal;
      this.pendingTerminals.delete(ev.terminal);
    }
    if (ev.transcript_path) s.transcriptPath = ev.transcript_path;
    s.lastEventAt = Math.max(s.lastEventAt, ts);
    s.lastEvent = ev.event;
    const wasWaiting = s.status === "waiting";

    switch (ev.event) {
      case "SessionStart":
        s.status = "done";
        this.loadTitle(s);
        break;
      case "UserPromptSubmit":
        s.status = "working";
        s.turns++;
        s.currentTool = undefined;
        s.currentToolHint = undefined;
        s.lastMessage = undefined;
        if (ev.prompt && !s.title) s.title = compact(ev.prompt);
        break;
      case "PreToolUse": {
        const question = ev.tool_name ? QUESTION_TOOLS.get(ev.tool_name) : undefined;
        if (question) {
          s.status = "waiting";
          s.lastMessage = ev.tool_hint || question;
          s.currentTool = undefined;
          s.currentToolHint = undefined;
          break;
        }
        s.status = "working";
        s.currentTool = ev.tool_name ?? undefined;
        s.currentToolHint = ev.tool_hint ?? undefined;
        break;
      }
      case "PostToolUse":
        // The tool finished: don't keep showing it (e.g. under a later permission question),
        // and any question about it or asked by it has been answered.
        s.status = "working";
        s.currentTool = undefined;
        s.currentToolHint = undefined;
        s.lastMessage = undefined;
        break;
      case "Notification":
        // idle_prompt fires ~60 s after Stop and auth_success is informational: neither is a
        // question, so the session stays "done". Everything else (permission_prompt,
        // elicitation_dialog, untyped notifications from older versions) needs the user.
        if (ev.notification_type === "idle_prompt" || ev.notification_type === "auth_success") break;
        s.status = "waiting";
        s.lastMessage = ev.message ?? undefined;
        break;
      case "Stop":
      case "SubagentStop":
        if (ev.event === "Stop") {
          s.status = "done";
          s.currentTool = undefined;
          s.currentToolHint = undefined;
          if (!this.replaying) this.loadTitle(s, true);
        }
        break;
      case "SessionEnd":
        s.status = "ended";
        break;
      default:
        break;
    }
    // A hook that outlives its closed terminal (or an event read late) keeps the session ended.
    if (ev.terminal && this.closedTerminals.has(ev.terminal)) s.status = "ended";
    if (s.status !== "waiting") s.waitingSince = undefined;
    else if (!wasWaiting) {
      s.waitingSince = ts;
      if (!this.replaying) this.startedWaiting.push(s);
    }
    this.loadTitle(s);
    return true;
  }

  /** How urgently a root needs the user: rank of its most urgent live session (waiting = 0). */
  attentionRank(rootId: string): number {
    return Math.min(rank("ended"), ...this.forRoot(rootId).map((s) => rank(s.status)));
  }

  /** Roots ordered by attention (waiting → working → done → idle → nothing), then by name. */
  sortByAttention<T extends { id: string; name: string }>(roots: T[]): T[] {
    const r = new Map(roots.map((x) => [x.id, this.attentionRank(x.id)]));
    return [...roots].sort((a, b) => r.get(a.id)! - r.get(b.id)! || a.name.localeCompare(b.name));
  }

  /** Waiting sessions, longest-waiting first. */
  waiting(): Session[] {
    return this.all()
      .filter((s) => s.status === "waiting")
      .sort((a, b) => (a.waitingSince ?? a.lastEventAt) - (b.waitingSince ?? b.lastEventAt));
  }

  private byteBeforeOffsetIsNewline(): boolean {
    try {
      const fd = fs.openSync(this.spool, "r");
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, this.offset - 1);
        return b[0] === 0x0a;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  /**
   * `refresh` re-reads an existing title: Claude Code writes its ai-title after a turn and a
   * `/rename` at any time, so the transcript beats the prompt we saw in the hook. The entrypoint
   * (chat panel or terminal) comes from the same read.
   */
  private loadTitle(s: Session, refresh = false): void {
    if (!s.transcriptPath) return;
    if (!refresh && (s.title || this.titleTried.has(s.id))) return;
    this.titleTried.add(s.id);
    const t = readTranscriptSummary(s.transcriptPath);
    s.title = t.title ?? s.title;
    s.entrypoint = t.entrypoint ?? s.entrypoint;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.status === "ended" || now - s.lastEventAt > PRUNE_AFTER_MS) {
        this.sessions.delete(id);
        this.titleTried.delete(id);
      }
    }
  }

  private rootIdFor(cwd: string): string | undefined {
    if (!cwd) return undefined;
    const n = normalizePath(cwd);
    // exact match first, then longest prefix (agent may cd into a subfolder)
    const exact = this.roots.find((r) => r.id === n);
    if (exact) return exact.id;
    const prefix = this.roots
      .filter((r) => n.startsWith(r.id + path.sep))
      .sort((a, b) => b.id.length - a.id.length)[0];
    return prefix?.id;
  }

  private fire(): void {
    this._onDidChange.fire(undefined);
  }
}

function rank(s: SessionStatus): number {
  return { waiting: 0, working: 1, done: 2, idle: 3, ended: 4 }[s];
}
