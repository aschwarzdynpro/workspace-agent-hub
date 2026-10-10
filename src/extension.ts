import * as path from "path";
import * as vscode from "vscode";
import { listTranscripts } from "./claudeProjects";
import { CHAT_ENTRYPOINT } from "./chatTarget";
import { addRootToSettings, getConfig, normalizePath } from "./config";
import { ConnectionTree } from "./connectionTree";
import { buildDiagnostics } from "./diagnostics";
import { hooksInstalled, installHooks } from "./hookInstaller";
import { Launcher } from "./launcher";
import { OverviewPanel } from "./overviewPanel";
import { SessionTracker } from "./sessionTracker";
import { StatusBar } from "./statusBar";
import { Root, Session } from "./types";
import { relTime } from "./format";
import { isMarkdown, Node, WorkspaceTree } from "./workspaceTree";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Agent Hub");
  const tracker = new SessionTracker(log, getConfig);
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
    void vscode.commands.executeCommand("setContext", "agentHub.hasWaiting", waiting > 0);
    tree.refresh();
  };

  const rootOf = (s: Session) => tree.getRoots().find((r) => r.id === s.rootId);
  const openSession = (s: Session) =>
    vscode.commands.executeCommand("agentHub.focusSession", { kind: "session", root: rootOf(s), session: s });

  // Cycle through waiting sessions, longest-waiting first.
  let lastJumped: string | undefined;
  const focusNextWaiting = async () => {
    const waiting = tracker.waiting();
    if (!waiting.length) {
      vscode.window.setStatusBarMessage("$(check) Agent Hub: nobody is waiting for you", 3000);
      return;
    }
    const next = waiting[(waiting.findIndex((s) => s.id === lastJumped) + 1) % waiting.length];
    lastJumped = next.id;
    await openSession(next);
    await offerShortcutInTerminals();
  };

  // Extension keybindings go to the shell while a terminal has focus — which is exactly where
  // the user is after the first jump. Ask once to let the shortcut through.
  const SKIP_SHELL_ASKED = "agentHub.skipShellAsked";
  const offerShortcutInTerminals = async () => {
    if (context.globalState.get<boolean>(SKIP_SHELL_ASKED)) return;
    const terminalCfg = vscode.workspace.getConfiguration("terminal.integrated");
    const skip = terminalCfg.get<string[]>("commandsToSkipShell", []);
    if (skip.includes("agentHub.focusNextWaiting")) return;
    await context.globalState.update(SKIP_SHELL_ASKED, true);
    const choice = await vscode.window.showInformationMessage(
      "Agent Hub: let the 'next waiting session' shortcut work while a terminal has focus? This adds it to terminal.integrated.commandsToSkipShell.",
      "Allow",
      "Not now"
    );
    if (choice === "Allow") {
      await terminalCfg.update("commandsToSkipShell", [...skip, "agentHub.focusNextWaiting"], vscode.ConfigurationTarget.Global);
    }
  };

  // Always announce: VS Code cannot tell whether a terminal is actually focused or visible
  // (activeTerminal is only the last one used), and a missed question costs more than a toast.
  const announceWaiting = async (s: Session) => {
    if (!getConfig().notifyWhenWaiting) return;
    const where = rootOf(s)?.name ?? s.cwd;
    const choice = await vscode.window.showWarningMessage(`${where}: ${s.lastMessage || "waiting for you"}`, "Show");
    const current = tracker.get(s.id);
    if (choice && current) await openSession(current);
  };

  const OFFER_SAVE = "agentHub.offerSaveWorkspace";
  let offeringSave = false;
  const offerSaveWorkspace = async () => {
    if (offeringSave || !context.globalState.get<boolean>(OFFER_SAVE)) return;
    if (vscode.workspace.workspaceFile?.scheme === "file") {
      await context.globalState.update(OFFER_SAVE, undefined); // already saved
      return;
    }
    if (!vscode.workspace.workspaceFile) return; // folders not applied yet; the restarted host will ask
    offeringSave = true;
    try {
      await context.globalState.update(OFFER_SAVE, undefined);
      const choice = await vscode.window.showInformationMessage(
        "Agent Hub: all roots are open in this window. Save the workspace so it opens like this next time.",
        "Save Workspace As…"
      );
      if (choice) await vscode.commands.executeCommand("workbench.action.saveWorkspaceAs");
    } finally {
      offeringSave = false;
    }
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
    tracker.onDidStartWaiting((s) => void announceWaiting(s)),
    vscode.commands.registerCommand("agentHub.focusNextWaiting", focusNextWaiting),

    vscode.commands.registerCommand("agentHub.diagnose", async () => {
      const cfg = getConfig();
      const report = buildDiagnostics({
        claudeHome: cfg.claudeHome,
        spoolPath: cfg.spoolPath,
        roots: tree.getRoots(),
        hooksInstalled: hooksInstalled(context),
        terminals: vscode.window.terminals.map((t) => ({
          name: t.name,
          hubId: (t.creationOptions as vscode.TerminalOptions).env?.AGENT_HUB_TERMINAL ?? undefined,
        })),
        extensionVersion: String(context.extension.packageJSON.version ?? ""),
      });
      const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand("agentHub.refresh", () => {
      tree.reload();
      connection.refresh();
    }),

    vscode.commands.registerCommand("agentHub.newSession", async (node?: Node) => {
      const root = await pickRoot(node);
      if (root) await launcher.newSession(root);
    }),

    vscode.commands.registerCommand("agentHub.resumeSession", async (node?: Node) => {
      if (node?.kind === "transcript") return launcher.resume(node.root, node.sessionId, node.entrypoint);
      if (node?.kind === "session") return launcher.resume(node.root, node.session.id, node.session.entrypoint);
      const root = await pickRoot(node);
      if (!root) return;
      const items = listTranscripts(getConfig().claudeHome, root.path, 30).map((t) => ({
        label: t.title,
        description: relTime(t.modifiedAt),
        detail: t.sessionId,
        id: t.sessionId,
        entrypoint: t.entrypoint,
      }));
      if (!items.length) {
        void vscode.window.showInformationMessage(`No transcripts found for ${root.name}.`);
        return;
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Resume a session in ${root.name}`, matchOnDetail: true });
      if (pick) await launcher.resume(root, pick.id, pick.entrypoint);
    }),

    vscode.commands.registerCommand("agentHub.focusSession", async (node?: Node) => {
      if (node?.kind !== "session") return;
      if (await launcher.focus(node.root, node.session)) return;
      // Not reachable from this window (external terminal, or a chat this window cannot run
      // in the session's root): offer resume.
      const question = node.session.status === "waiting" && node.session.lastMessage ? ` It asks: "${node.session.lastMessage}"` : "";
      const actions = node.root ? ["Resume in new terminal", "Open transcript"] : ["Open transcript"];
      const where = node.session.entrypoint === CHAT_ENTRYPOINT ? "runs in a Claude Code chat this window cannot open for its root" : "is not attached to a terminal in this window";
      const choice = await vscode.window.showInformationMessage(`Session "${node.session.title || node.session.id}" ${where}.${question}`, ...actions);
      if (choice === "Resume in new terminal") await launcher.resume(node.root, node.session.id);
      if (choice === "Open transcript") await vscode.commands.executeCommand("agentHub.openTranscript", node);
    }),

    vscode.commands.registerCommand("agentHub.openTranscript", async (node?: Node) => {
      if (node?.kind !== "session" || !node.session.transcriptPath) return;
      await vscode.window.showTextDocument(vscode.Uri.file(node.session.transcriptPath), { preview: true });
    }),

    // revealInExplorer does nothing for a folder outside this window, so fall back to the OS.
    vscode.commands.registerCommand("agentHub.revealRoot", async (node?: Node) => {
      if (node?.kind !== "root") return;
      const uri = vscode.Uri.file(node.root.path);
      const inWindow = vscode.workspace.getWorkspaceFolder(uri) !== undefined;
      await vscode.commands.executeCommand(inWindow ? "revealInExplorer" : "revealFileInOS", uri);
    }),

    // Files a session wrote: a real tab (not the replaceable preview tab), Markdown rendered.
    vscode.commands.registerCommand("agentHub.openFile", async (node?: Node) => {
      if (node?.kind !== "file") return;
      const uri = vscode.Uri.file(node.path);
      if (isMarkdown(node.path) && getConfig().openMarkdownAs === "preview") {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
      } else {
        await vscode.window.showTextDocument(uri, { preview: false });
      }
    }),
    vscode.commands.registerCommand("agentHub.openFileSource", async (node?: Node) => {
      if (node?.kind === "file") await vscode.window.showTextDocument(vscode.Uri.file(node.path), { preview: false });
    }),
    vscode.commands.registerCommand("agentHub.revealFile", async (node?: Node) => {
      if (node?.kind !== "file" && node?.kind !== "dir") return;
      const uri = vscode.Uri.file(node.path);
      const inWindow = vscode.workspace.getWorkspaceFolder(uri) !== undefined;
      await vscode.commands.executeCommand(inWindow ? "revealInExplorer" : "revealFileInOS", uri);
    }),

    vscode.commands.registerCommand("agentHub.showOverview", () => OverviewPanel.show(context, tracker, () => tree.getRoots())),

    vscode.commands.registerCommand("agentHub.installHooks", async () => {
      await installHooks(context);
      connection.refresh();
    }),

    // The pickers follow a native folder dialog; without ignoreFocusOut they vanish on the
    // first click elsewhere and the command ends silently, so every exit is reported.
    vscode.commands.registerCommand("agentHub.addRoot", async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: "Add workspace root" });
      const folder = picked?.[0];
      if (!folder) return;
      const existing = tree.getRoots().find((r) => r.id === normalizePath(folder.fsPath));
      if (existing) {
        void vscode.window.showInformationMessage(`Agent Hub: ${folder.fsPath} is already a root ("${existing.name}").`);
        return;
      }
      const kind = await vscode.window.showQuickPick(
        [
          { label: "Repository", description: "Normal root with code", value: "repo" as const },
          { label: "Coordinator", description: "No code; only reads the hub status", value: "coordinator" as const },
        ],
        { title: `Add root: ${folder.fsPath}`, placeHolder: "Kind of root", ignoreFocusOut: true }
      );
      if (!kind) return void vscode.window.setStatusBarMessage("Agent Hub: adding the root was cancelled", 4000);
      const name = await vscode.window.showInputBox({
        title: `Add root: ${folder.fsPath}`,
        prompt: "Display name",
        value: path.basename(folder.fsPath) || "root",
        ignoreFocusOut: true,
      });
      if (!name) return void vscode.window.setStatusBarMessage("Agent Hub: adding the root was cancelled", 4000);
      try {
        const result = await addRootToSettings({ name, path: folder.fsPath, kind: kind.value });
        tree.reload();
        log.appendLine(`addRoot ${folder.fsPath}: ${result}`);
        if (result === "exists") void vscode.window.showInformationMessage(`Agent Hub: ${folder.fsPath} is already a root.`);
        else void vscode.window.showInformationMessage(`Agent Hub: added root "${name}".`);
      } catch (err) {
        log.appendLine(`addRoot ${folder.fsPath} failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showErrorMessage(`Agent Hub: could not save the root to settings — ${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    // One window instead of one per customer: every root becomes a folder of this window,
    // so Explorer, Git and Search cover all of them. Agents stay isolated by their cwd.
    vscode.commands.registerCommand("agentHub.addAllRootsToWindow", async () => {
      const open = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => normalizePath(f.uri.fsPath)));
      const missing = tree.getRoots().filter((r) => !open.has(r.id));
      if (missing.length) {
        // Entering a multi-root workspace restarts the extension host, so the save offer
        // is remembered and made by whichever activation runs next (this one or the new one).
        if (vscode.workspace.workspaceFile?.scheme !== "file") await context.globalState.update(OFFER_SAVE, true);
        const start = vscode.workspace.workspaceFolders?.length ?? 0;
        const ok = vscode.workspace.updateWorkspaceFolders(start, 0, ...missing.map((r) => ({ uri: vscode.Uri.file(r.path), name: r.name })));
        if (!ok) {
          void vscode.window.showErrorMessage("Agent Hub: VS Code refused to add the workspace folders.");
          return;
        }
      }
      if (!missing.length) void vscode.window.showInformationMessage("Agent Hub: all roots are already open in this window.");
      await offerSaveWorkspace();
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      tree.reload();
      void offerSaveWorkspace();
    }),
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

  void offerSaveWorkspace();

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
