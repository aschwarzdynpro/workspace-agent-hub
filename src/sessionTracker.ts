import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { compact, readTranscriptTitle } from "./claudeProjects";
import { getConfig, normalizePath } from "./config";
import { Root, Session, SessionStatus, SpoolEvent } from "./types";

/**
 * Tails the NDJSON spool written by hooks/hub-event.js and keeps an in-memory
 * session table. Pure state machine; no VS Code UI in here.
 *
 * Status transitions (per session):
 *   SessionStart            → done   (ready for a prompt)
 *   UserPromptSubmit        → working
 *   PreToolUse / PostToolUse→ working (currentTool = tool_name)
 *   Notification            → waiting (permission / idle prompt / question)
 *   Stop                    → done
 *   SessionEnd              → ended
 *   (no events for N min)   → idle   (computed on read)
 */
export class SessionTracker implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private offset = 0;
  private partial = "";
  private watcher?: fs.FSWatcher;
  private poll?: NodeJS.Timeout;
  private roots: Root[] = [];
  private spool = "";
  private debounce?: NodeJS.Timeout;

  constructor(private readonly log: vscode.OutputChannel) {}

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
    this.spool = getConfig().spoolPath;
    this.offset = 0;
    this.partial = "";
    this.sessions.clear();
    fs.mkdirSync(path.dirname(this.spool), { recursive: true });
    if (!fs.existsSync(this.spool)) fs.writeFileSync(this.spool, "");
    this.readNew(); // replay history so restarts keep state
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
  }

  all(): Session[] {
    const now = Date.now();
    const stale = getConfig().staleAfterMs;
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
    this.fire();
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
    }
    if (st.size === this.offset) return;

    const fd = fs.openSync(this.spool, "r");
    try {
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = st.size;
      const text = this.partial + buf.toString("utf8");
      const lines = text.split("\n");
      this.partial = lines.pop() ?? "";
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

    switch (ev.event) {
      case "SessionStart":
        s.status = "done";
        if (!s.title && s.transcriptPath) s.title = readTranscriptTitle(s.transcriptPath) ?? "";
        break;
      case "UserPromptSubmit":
        s.status = "working";
        s.turns++;
        s.currentTool = undefined;
        s.currentToolHint = undefined;
        s.lastMessage = undefined;
        if (ev.prompt && (!s.title || s.turns === 1)) s.title = compact(ev.prompt);
        break;
      case "PreToolUse":
        s.status = "working";
        s.currentTool = ev.tool_name ?? undefined;
        s.currentToolHint = ev.tool_hint ?? undefined;
        break;
      case "PostToolUse":
        s.status = "working";
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
        }
        break;
      case "SessionEnd":
        s.status = "ended";
        break;
      default:
        break;
    }
    if (!s.title && s.transcriptPath) s.title = readTranscriptTitle(s.transcriptPath) ?? "";
    return true;
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
    this._onDidChange.fire();
  }
}

function rank(s: SessionStatus): number {
  return { waiting: 0, working: 1, done: 2, idle: 3, ended: 4 }[s];
}
