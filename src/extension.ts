import * as vscode from "vscode";
import { listTranscripts } from "./claudeProjects";
import { addRootToSettings, getConfig } from "./config";
import { ConnectionTree } from "./connectionTree";
import { hooksInstalled, installHooks } from "./hookInstaller";
import { Launcher } from "./launcher";
import { OverviewPanel } from "./overviewPanel";
import { SessionTracker } from "./sessionTracker";
import { StatusBar } from "./statusBar";
import { Root } from "./types";
import { Node, WorkspaceTree, relTime } from "./workspaceTree";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Agent Hub");
  const tracker = new SessionTracker(log);
  const tree = new WorkspaceTree(tracker);
  const connection = new ConnectionTree(context);
  const launcher = new Launcher(tracker, log);
  const statusBar = new StatusBar(tracker);

  tracker.start();

  const treeView = vscode.window.createTreeView("agentHub.workspaces", { treeDataProvider: tree, showCollapseAll: true });
  const connView = vscode.window.createTreeView("agentHub.connection", { treeDataProvider: connection });

  // Badge on the view container: number of sessions waiting for the user.
  const updateBadge = () => {
    const waiting = tracker.counts().waiting;
    treeView.badge = waiting ? { value: waiting, tooltip: `${waiting} session(s) waiting for you` } : undefined;
    tree.refresh();
  };

  // Resolve the root from a tree node, a webview message, or by asking.
  const pickRoot = async (node?: Node): Promise<Root | undefined> => {
    if (node && (node.kind === "root" || node.kind === "session" || node.kind === "transcript")) return node.root;
    const roots = tree.getRoots();
    if (roots.length === 1) return roots[0];
    const pick = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: r.name, description: r.path, root: r })),
      { placeHolder: "Which workspace root?" }
    );
    return pick?.root;
  };

  context.subscriptions.push(
    log,
    tracker,
    launcher,
    statusBar,
    treeView,
    connView,
    tracker.onDidChange(updateBadge),

    vscode.commands.registerCommand("agentHub.refresh", () => {
      tree.reload();
      connection.refresh();
    }),

    vscode.commands.registerCommand("agentHub.newSession", async (node?: Node) => {
      const root = await pickRoot(node);
      if (root) await launcher.newSession(root);
    }),

    vscode.commands.registerCommand("agentHub.resumeSession", async (node?: Node) => {
      if (node?.kind === "transcript") return launcher.resume(node.root, node.sessionId);
      if (node?.kind === "session") return launcher.resume(node.root, node.session.id);
      const root = await pickRoot(node);
      if (!root) return;
      const items = listTranscripts(getConfig().claudeHome, root.path, 30).map((t) => ({
        label: t.title,
        description: relTime(t.modifiedAt),
        detail: t.sessionId,
        id: t.sessionId,
      }));
      if (!items.length) {
        void vscode.window.showInformationMessage(`No transcripts found for ${root.name}.`);
        return;
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Resume a session in ${root.name}`, matchOnDetail: true });
      if (pick) await launcher.resume(root, pick.id);
    }),

    vscode.commands.registerCommand("agentHub.focusSession", async (node?: Node) => {
      if (node?.kind !== "session") return;
      if (launcher.focus(node.session)) return;
      // Not spawned by us (started in an external terminal or the chat panel): offer resume.
      const choice = await vscode.window.showInformationMessage(
        `Session "${node.session.title || node.session.id}" is not attached to a hub terminal.`,
        "Resume in new terminal",
        "Open transcript"
      );
      if (choice === "Resume in new terminal") await launcher.resume(node.root, node.session.id);
      if (choice === "Open transcript") await vscode.commands.executeCommand("agentHub.openTranscript", node);
    }),

    vscode.commands.registerCommand("agentHub.openTranscript", async (node?: Node) => {
      if (node?.kind !== "session" || !node.session.transcriptPath) return;
      await vscode.window.showTextDocument(vscode.Uri.file(node.session.transcriptPath), { preview: true });
    }),

    vscode.commands.registerCommand("agentHub.revealRoot", async (node?: Node) => {
      if (node?.kind !== "root") return;
      await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(node.root.path));
    }),

    vscode.commands.registerCommand("agentHub.showOverview", () => OverviewPanel.show(context, tracker, () => tree.getRoots())),

    vscode.commands.registerCommand("agentHub.installHooks", async () => {
      await installHooks(context);
      connection.refresh();
    }),

    vscode.commands.registerCommand("agentHub.addRoot", async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: "Add workspace root" });
      const folder = picked?.[0];
      if (!folder) return;
      const kind = await vscode.window.showQuickPick(
        [
          { label: "Repository", description: "Normal root with code", value: "repo" as const },
          { label: "Coordinator", description: "No code; only reads the hub status", value: "coordinator" as const },
        ],
        { placeHolder: "Kind of root" }
      );
      if (!kind) return;
      const name = await vscode.window.showInputBox({ prompt: "Display name", value: folder.path.split("/").pop() ?? "root" });
      if (!name) return;
      await addRootToSettings({ name, path: folder.fsPath, kind: kind.value });
      tree.reload();
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.reload()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("agentHub")) return;
      if (e.affectsConfiguration("agentHub.spoolPath") || e.affectsConfiguration("agentHub.claudeHome")) tracker.start();
      tree.reload();
      connection.refresh();
    })
  );

  // Periodic refresh so relative times ("3 min ago") and idle detection stay current
  // in every view (tree, badge, status bar, overview).
  const tick = setInterval(() => tracker.tick(), 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });

  updateBadge();

  if (!hooksInstalled(context)) {
    void vscode.window
      .showInformationMessage("Agent Hub: Claude Code hooks are not installed yet, so session status stays empty.", "Install hooks")
      .then((c) => c && vscode.commands.executeCommand("agentHub.installHooks"));
  }
  log.appendLine("Workspace Agent Hub activated");
}

export function deactivate(): void {
  // disposables handled via context.subscriptions
}
