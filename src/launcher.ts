import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { CHAT_ENTRYPOINT, CHAT_EXTENSION_ID, chatBlocker } from "./chatTarget";
import { getConfig, normalizePath } from "./config";
import { resolveRootEnv } from "./rootEnv";
import { SessionTracker } from "./sessionTracker";
import { Root, Session } from "./types";

/**
 * Starts / resumes Claude Code sessions. Isolation comes for free: the
 * terminal's cwd is the root, nothing else is passed (no --add-dir).
 */
export class Launcher implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>(); // terminalId → terminal
  private readonly subs: vscode.Disposable[] = [];
  /** Roots whose "why not in the chat" was already shown in this window. */
  private readonly chatExplained = new Set<string>();

  constructor(private readonly tracker: SessionTracker, private readonly log: vscode.OutputChannel) {
    // Terminals survive a window reload (persistent sessions) but this map does not:
    // re-adopt every terminal that carries our id, now and when VS Code revives more later.
    for (const t of vscode.window.terminals) this.adopt(t);
    this.subs.push(
      vscode.window.onDidOpenTerminal((t) => this.adopt(t)),
      vscode.window.onDidCloseTerminal((t) => {
        for (const [id, term] of this.terminals) {
          if (term !== t) continue;
          this.terminals.delete(id);
          this.tracker.terminalClosed(id);
        }
      })
    );
  }

  dispose(): void {
    for (const d of this.subs) d.dispose();
  }

  async newSession(root: Root): Promise<void> {
    if (getConfig().launchMode === "chat" && (await this.openChat(root))) return;
    await this.spawn(root, []);
  }

  /**
   * A session started in the chat panel resumes there, as does any session in chat mode,
   * when the chat may run this root; otherwise in a hub terminal.
   */
  async resume(root: Root, sessionId: string, entrypoint?: string): Promise<void> {
    // Never run the same session twice: if it is still open here, go there.
    const live = this.tracker.get(sessionId);
    if (live && live.status !== "ended" && (await this.focus(root, live))) return;
    const fromChat = (entrypoint ?? live?.entrypoint) === CHAT_ENTRYPOINT;
    if ((fromChat || getConfig().launchMode === "chat") && (await this.openChat(root, sessionId))) return;
    await this.spawn(root, ["--resume", sessionId]);
  }

  /** Bring a running session to the front: its terminal, or its chat tab when that is safe. */
  async focus(root: Root | undefined, session: Session): Promise<boolean> {
    const t = this.terminalFor(session);
    if (t) {
      t.show(false);
      return true;
    }
    return session.entrypoint === CHAT_ENTRYPOINT && root !== undefined && this.openChat(root, session.id);
  }

  /**
   * 1. `AGENT_HUB_TERMINAL` → hub terminal (exact, survives `cd` and window reloads via `adopt`).
   * 2. Fallback for sessions started outside the hub: the only open, non-hub terminal named
   *    "claude…" whose cwd is the session's cwd. Hub terminals never match here: they are mapped
   *    by id, and one whose `claude` has exited is just an idle shell. Ambiguous → none.
   */
  terminalFor(session: Session): vscode.Terminal | undefined {
    if (session.terminalId) {
      const t = this.terminals.get(session.terminalId);
      if (t) return t;
    }
    const want = normalizePath(session.cwd);
    const candidates = vscode.window.terminals.filter((t) => {
      if (hubTerminalId(t) || t.exitStatus !== undefined || !/claude/i.test(t.name)) return false;
      const cwd = terminalCwd(t);
      return cwd !== undefined && normalizePath(cwd) === want;
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private adopt(t: vscode.Terminal): void {
    const id = hubTerminalId(t);
    if (id && !this.terminals.has(id)) this.terminals.set(id, t);
  }

  // ---- internals ------------------------------------------------------------

  private async spawn(root: Root, args: string[]): Promise<void> {
    const cfg = getConfig();
    const terminalId = randomUUID();
    const rootEnv = resolveRootEnv(root);
    if (rootEnv.error) {
      // Without the root's env the terminal inherits VS Code's environment, which may hold
      // another customer's tenant or credentials. Never launch silently in that state.
      this.log.appendLine(`[${root.name}] ${rootEnv.error}`);
      const choice = await vscode.window.showWarningMessage(
        `Agent Hub: ${rootEnv.error}`,
        {
          modal: true,
          detail: `Without it, Claude in "${root.name}" runs with VS Code's own environment, which may belong to another customer.`,
        },
        "Launch Anyway"
      );
      if (choice !== "Launch Anyway") return;
    }
    const terminal = vscode.window.createTerminal({
      name: `claude · ${root.name}`,
      cwd: root.path,
      iconPath: new vscode.ThemeIcon("sparkle"),
      color: root.color ? new vscode.ThemeColor(root.color) : undefined,
      env: {
        ...rootEnv.env,
        // Hub variables last so a root's env cannot break session tracking.
        AGENT_HUB_TERMINAL: terminalId,
        AGENT_HUB_ROOT: root.name,
        AGENT_HUB_SPOOL: cfg.spoolPath,
      },
    });
    this.terminals.set(terminalId, terminal);
    this.tracker.expectSession(terminalId, root.id);

    const cmd = [cfg.claudeCommand, ...cfg.extraArgs, ...(root.extraArgs ?? []), ...args].map(quote).join(" ");
    this.log.appendLine(`[${root.name}] ${cmd}`);
    terminal.show(false);
    terminal.sendText(cmd, true);
  }

  /**
   * Opens (no id) or reveals/resumes (id) a chat tab of the Anthropic Claude Code extension,
   * but only where the chat runs in this root (see chatTarget.ts). Returns false otherwise, after
   * telling the user once per root why the terminal is used instead.
   */
  private async openChat(root: Root, sessionId?: string): Promise<boolean> {
    const cfg = getConfig();
    const first = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file");
    const blocker = chatBlocker({
      commandId: cfg.chatCommandId,
      extensionInstalled: vscode.extensions.getExtension(CHAT_EXTENSION_ID) !== undefined,
      firstFolder: first && { id: normalizePath(first.uri.fsPath), name: first.name },
      root,
    });
    if (blocker) {
      this.log.appendLine(`[${root.name}] not in the chat: ${blocker}`);
      if (!this.chatExplained.has(root.id)) {
        this.chatExplained.add(root.id);
        void vscode.window.showInformationMessage(`Agent Hub: ${root.name} uses a terminal, because ${blocker}.`);
      }
      return false;
    }
    try {
      await vscode.commands.executeCommand(cfg.chatCommandId, sessionId);
      return true;
    } catch (e) {
      this.log.appendLine(`[${root.name}] chat launch failed: ${String(e)}`);
      void vscode.window.showWarningMessage(`Agent Hub: could not open the Claude Code chat (${cfg.chatCommandId}); using a terminal.`);
      return false;
    }
  }
}

function hubTerminalId(t: vscode.Terminal): string | undefined {
  const opts = t.creationOptions as vscode.TerminalOptions;
  return opts.env?.AGENT_HUB_TERMINAL ?? undefined;
}

/** Live cwd from shell integration if available, else the cwd the terminal was created with. */
function terminalCwd(t: vscode.Terminal): string | undefined {
  const live = t.shellIntegration?.cwd;
  if (live?.scheme === "file") return live.fsPath;
  const created = (t.creationOptions as vscode.TerminalOptions).cwd;
  if (!created) return undefined;
  return typeof created === "string" ? created : created.fsPath;
}

function quote(a: string): string {
  return /[\s"']/.test(a) ? JSON.stringify(a) : a;
}
