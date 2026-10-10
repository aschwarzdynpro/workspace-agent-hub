import { randomUUID } from "crypto";
import * as vscode from "vscode";
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
    const cfg = getConfig();
    if (cfg.launchMode === "chat") {
      if (await this.openChat(root)) return;
      void vscode.window.showWarningMessage(
        "Agent Hub: chat launch not configured (agentHub.chatCommandId). Falling back to terminal."
      );
    }
    this.spawn(root, []);
  }

  async resume(root: Root, sessionId: string): Promise<void> {
    // Never run the same session twice: if it is still open in a hub terminal, go there.
    const live = this.tracker.get(sessionId);
    if (live && live.status !== "ended" && this.focus(live)) return;
    this.spawn(root, ["--resume", sessionId]);
  }

  /** Bring the terminal of a running session to the front. */
  focus(session: Session): boolean {
    const t = this.terminalFor(session);
    if (!t) return false;
    t.show(false);
    return true;
  }

  /**
   * 1. `AGENT_HUB_TERMINAL` → hub terminal (exact, survives `cd`).
   * 2. Fallback for sessions we did not spawn (or whose id was lost): the only unclaimed
   *    Claude-looking terminal (hub-spawned or named "claude…") whose cwd is the session's cwd.
   *    Ambiguous → none, rather than a wrong one; a plain shell in the root never matches.
   */
  terminalFor(session: Session): vscode.Terminal | undefined {
    if (session.terminalId) {
      const t = this.terminals.get(session.terminalId);
      if (t) return t;
    }
    const claimed = new Set<vscode.Terminal>();
    for (const s of this.tracker.all()) {
      if (s.id === session.id || s.status === "ended" || !s.terminalId) continue;
      const t = this.terminals.get(s.terminalId);
      if (t) claimed.add(t);
    }
    const want = normalizePath(session.cwd);
    const candidates = vscode.window.terminals.filter((t) => {
      if (claimed.has(t)) return false;
      if (!hubTerminalId(t) && !/claude/i.test(t.name)) return false;
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

  private spawn(root: Root, args: string[]): void {
    const cfg = getConfig();
    const terminalId = randomUUID();
    const rootEnv = resolveRootEnv(root);
    if (rootEnv.error) {
      this.log.appendLine(`[${root.name}] ${rootEnv.error}`);
      void vscode.window.showWarningMessage(`Agent Hub: ${rootEnv.error}`);
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
   * Chat mode: delegate to the Anthropic Claude Code extension.
   * The command id is deliberately a setting: it has to be read from that
   * extension's package.json (see SPEC.md → "Open questions") and may change.
   */
  private async openChat(root: Root): Promise<boolean> {
    const cfg = getConfig();
    if (!cfg.chatCommandId) return false;
    try {
      // Focus a file inside the root first so the extension picks that workspace folder.
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root.path));
      if (folder) await vscode.commands.executeCommand("workbench.view.explorer");
      await vscode.commands.executeCommand(cfg.chatCommandId);
      return true;
    } catch (e) {
      this.log.appendLine(`chat launch failed: ${String(e)}`);
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
