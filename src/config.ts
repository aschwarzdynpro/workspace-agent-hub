import * as path from "path";
import * as vscode from "vscode";
import { expandHome, normalizePath } from "./paths";
import { Root, RootKind } from "./types";

export { expandHome, normalizePath };

export interface HubConfig {
  includeWorkspaceFolders: boolean;
  launchMode: "terminal" | "chat";
  claudeCommand: string;
  extraArgs: string[];
  chatCommandId: string;
  spoolPath: string;
  claudeHome: string;
  staleAfterMs: number;
  notifyWhenWaiting: boolean;
  openMarkdownAs: "preview" | "editor";
}

export function getConfig(): HubConfig {
  const c = vscode.workspace.getConfiguration("agentHub");
  return {
    includeWorkspaceFolders: c.get<boolean>("includeWorkspaceFolders", true),
    launchMode: c.get<"terminal" | "chat">("launchMode", "terminal"),
    claudeCommand: c.get<string>("claudeCommand", "claude"),
    extraArgs: c.get<string[]>("extraArgs", []),
    chatCommandId: c.get<string>("chatCommandId", "claude-vscode.editor.open"),
    spoolPath: expandHome(c.get<string>("spoolPath", "~/.claude/hub/events.ndjson")),
    claudeHome: expandHome(c.get<string>("claudeHome", "~/.claude")),
    staleAfterMs: Math.max(1, c.get<number>("staleAfterMinutes", 30)) * 60_000,
    notifyWhenWaiting: c.get<boolean>("notifyWhenWaiting", true),
    openMarkdownAs: c.get<"preview" | "editor">("openMarkdownAs", "preview"),
  };
}

interface RootSetting {
  name?: string;
  path: string;
  kind?: RootKind;
  env?: Record<string, string>;
  envFile?: string;
  extraArgs?: string[];
  color?: string;
}

/**
 * Roots = open workspace folders (optional) + `agentHub.roots`, de-duplicated by path.
 * A settings entry with the path of a workspace folder adds its per-root options to that folder.
 */
export function getRoots(): Root[] {
  const cfg = getConfig();
  const out = new Map<string, Root>();

  if (cfg.includeWorkspaceFolders) {
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== "file") continue;
      const id = normalizePath(f.uri.fsPath);
      out.set(id, { id, name: f.name, path: path.resolve(f.uri.fsPath), kind: "repo", source: "workspace" });
    }
  }

  const extra = vscode.workspace.getConfiguration("agentHub").get<RootSetting[]>("roots", []);
  for (const r of extra) {
    if (!r?.path) continue;
    const abs = path.resolve(expandHome(r.path));
    const id = normalizePath(abs);
    const existing = out.get(id);
    out.set(id, {
      id,
      name: r.name || existing?.name || path.basename(abs),
      path: abs,
      kind: r.kind ?? existing?.kind ?? "repo",
      source: existing ? existing.source : "settings",
      env: r.env,
      envFile: r.envFile,
      extraArgs: r.extraArgs,
      color: r.color,
    });
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Appends a root to `agentHub.roots`. Writes to the workspace value when one exists —
 * a global entry would be shadowed by it and never show up.
 */
export async function addRootToSettings(root: RootSetting & { name: string }): Promise<"added" | "exists"> {
  const c = vscode.workspace.getConfiguration("agentHub");
  const abs = path.resolve(expandHome(root.path));
  const id = normalizePath(abs);
  if (getRoots().some((r) => r.id === id)) return "exists";
  const info = c.inspect<RootSetting[]>("roots");
  const inWorkspace = info?.workspaceValue !== undefined;
  const current = (inWorkspace ? info?.workspaceValue : info?.globalValue) ?? [];
  await c.update(
    "roots",
    [...current, { ...root, path: abs }],
    inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
  );
  return "added";
}
