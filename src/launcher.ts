import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { getConfig } from "./config";
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
    this.subs.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [id, term] of this.terminals) if (term === t) this.terminals.delete(id);
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
    this.spawn(root, ["--resume", sessionId]);
  }

  /** Bring the terminal of a running session to the front. */
  focus(session: Session): boolean {
    const t = session.terminalId ? this.terminals.get(session.terminalId) : undefined;
    if (!t) return false;
    t.show(false);
    return true;
  }

  // ---- internals ------------------------------------------------------------

  private spawn(root: Root, args: string[]): void {
    const cfg = getConfig();
    const terminalId = randomUUID();
    const terminal = vscode.window.createTerminal({
      name: `claude · ${root.name}`,
      cwd: root.path,
      iconPath: new vscode.ThemeIcon("sparkle"),
      env: {
        AGENT_HUB_TERMINAL: terminalId,
        AGENT_HUB_ROOT: root.name,
        AGENT_HUB_SPOOL: cfg.spoolPath,
      },
    });
    this.terminals.set(terminalId, terminal);
    this.tracker.expectSession(terminalId, root.id);

    const cmd = [cfg.claudeCommand, ...cfg.extraArgs, ...args].map(quote).join(" ");
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

function quote(a: string): string {
  return /[\s"']/.test(a) ? JSON.stringify(a) : a;
}
