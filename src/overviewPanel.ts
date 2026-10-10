import * as os from "os";
import * as vscode from "vscode";
import { displayPath } from "./format";
import { SessionTracker } from "./sessionTracker";
import { Root, Session } from "./types";

interface OverviewState {
  roots: (Root & { displayPath: string; sessions: Session[] })[];
  counts: Record<string, number>;
  generatedAt: number;
}

/**
 * Read-only overview as a webview panel. It renders state pushed from the
 * extension host; actions are posted back and routed to the normal commands.
 */
export class OverviewPanel {
  static current: OverviewPanel | undefined;

  static show(context: vscode.ExtensionContext, tracker: SessionTracker, roots: () => Root[]): void {
    if (OverviewPanel.current) {
      OverviewPanel.current.panel.reveal();
      OverviewPanel.current.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel("agentHub.overview", "Agent Hub · Overview", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    OverviewPanel.current = new OverviewPanel(panel, context, tracker, roots);
  }

  private readonly subs: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly tracker: SessionTracker,
    private readonly roots: () => Root[]
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "hub.svg");
    panel.webview.html = this.html();
    this.subs.push(
      tracker.onDidChange(() => this.update()),
      panel.webview.onDidReceiveMessage((m: { type: string; rootId?: string; sessionId?: string }) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose())
    );
    this.update();
  }

  private dispose(): void {
    OverviewPanel.current = undefined;
    for (const d of this.subs) d.dispose();
  }

  private update(): void {
    const state: OverviewState = {
      roots: this.tracker.sortByAttention(this.roots()).map((r) => ({
        ...r,
        displayPath: displayPath(r.path, os.homedir()),
        sessions: this.tracker.forRoot(r.id).filter((s) => s.status !== "ended"),
      })),
      counts: this.tracker.counts(),
      generatedAt: Date.now(),
    };
    void this.panel.webview.postMessage({ type: "state", state });
  }

  private async onMessage(m: { type: string; rootId?: string; sessionId?: string }): Promise<void> {
    const session = m.sessionId ? this.tracker.get(m.sessionId) : undefined;
    const rootId = session?.rootId ?? m.rootId;
    const root = this.roots().find((r) => r.id === rootId);
    switch (m.type) {
      case "newSession":
        if (root) await vscode.commands.executeCommand("agentHub.newSession", { kind: "root", root });
        break;
      case "focus":
        if (root && session) await vscode.commands.executeCommand("agentHub.focusSession", { kind: "session", root, session });
        break;
      case "resume":
        if (root) await vscode.commands.executeCommand("agentHub.resumeSession", { kind: "root", root });
        break;
      case "refresh":
        this.update();
        break;
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = Math.random().toString(36).slice(2);
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "overview.css"));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "overview.js"));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Agent Hub · Overview</title>
</head>
<body>
<header>
  <div>
    <h1>Workspace Agent Hub</h1>
    <p id="subtitle" class="dim">loading…</p>
  </div>
  <div class="actions"><button id="refresh" class="btn">Refresh</button></div>
</header>
<section id="kpis" class="kpis"></section>
<section id="cards" class="cards"></section>
<footer class="dim" id="footer"></footer>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
