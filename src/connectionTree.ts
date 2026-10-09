import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "./config";
import { hooksInstalled } from "./hookInstaller";

interface Line {
  label: string;
  description?: string;
  ok: boolean | null;
  command?: string;
}

/** Small "Connection" view: are the hooks in place, is the spool being written, where do transcripts live. */
export class ConnectionTree implements vscode.TreeDataProvider<Line> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(l: Line): vscode.TreeItem {
    const item = new vscode.TreeItem(l.label);
    item.description = l.description;
    item.iconPath =
      l.ok === null
        ? new vscode.ThemeIcon("circle-outline")
        : l.ok
          ? new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.green"))
          : new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
    if (l.command) item.command = { command: l.command, title: l.label };
    return item;
  }

  getChildren(): Line[] {
    const cfg = getConfig();
    const hooks = hooksInstalled(this.context);
    let spoolAge: number | undefined;
    try {
      spoolAge = Date.now() - fs.statSync(cfg.spoolPath).mtimeMs;
    } catch {
      spoolAge = undefined;
    }
    const projects = path.join(cfg.claudeHome, "projects");
    let projectCount = 0;
    try {
      projectCount = fs.readdirSync(projects).length;
    } catch {
      projectCount = 0;
    }
    return [
      {
        label: hooks ? "Hooks installed" : "Hooks not installed",
        description: hooks ? path.join(cfg.claudeHome, "settings.json") : "click to install",
        ok: hooks,
        command: hooks ? undefined : "agentHub.installHooks",
      },
      {
        label: "Event spool",
        description: spoolAge === undefined ? "not created yet" : `last write ${Math.round(spoolAge / 1000)} s ago`,
        ok: spoolAge === undefined ? false : spoolAge < 10 * 60_000 ? true : null,
      },
      {
        label: "Transcripts",
        description: `${projectCount} project dir${projectCount === 1 ? "" : "s"} · ${projects}`,
        ok: projectCount > 0 ? true : null,
      },
      {
        label: `Launch mode: ${cfg.launchMode}`,
        description: cfg.launchMode === "chat" && !cfg.chatCommandId ? "chatCommandId missing → terminal fallback" : cfg.claudeCommand,
        ok: cfg.launchMode === "terminal" || !!cfg.chatCommandId ? true : false,
      },
    ];
  }
}
