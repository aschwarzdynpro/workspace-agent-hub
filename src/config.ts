import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Root, RootKind } from "./types";

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Normalize a path so the same folder always yields the same id. */
export function normalizePath(p: string): string {
  let n = path.resolve(expandHome(p));
  if (process.platform === "win32") n = n.toLowerCase();
  return n.replace(/[\\/]+$/, "");
}

export interface HubConfig {
  includeWorkspaceFolders: boolean;
  launchMode: "terminal" | "chat";
  claudeCommand: string;
  extraArgs: string[];
  chatCommandId: string;
  spoolPath: string;
  claudeHome: string;
  staleAfterMs: number;
}

export function getConfig(): HubConfig {
  const c = vscode.workspace.getConfiguration("agentHub");
  return {
    includeWorkspaceFolders: c.get<boolean>("includeWorkspaceFolders", true),
    launchMode: c.get<"terminal" | "chat">("launchMode", "terminal"),
    claudeCommand: c.get<string>("claudeCommand", "claude"),
    extraArgs: c.get<string[]>("extraArgs", []),
    chatCommandId: c.get<string>("chatCommandId", ""),
    spoolPath: expandHome(c.get<string>("spoolPath", "~/.claude/hub/events.ndjson")),
    claudeHome: expandHome(c.get<string>("claudeHome", "~/.claude")),
    staleAfterMs: Math.max(1, c.get<number>("staleAfterMinutes", 30)) * 60_000,
  };
}

interface RootSetting {
  name: string;
  path: string;
  kind?: RootKind;
}

/** Roots = open workspace folders (optional) + `agentHub.roots`, de-duplicated by path. */
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
    });
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function addRootToSettings(root: RootSetting): Promise<void> {
  const c = vscode.workspace.getConfiguration("agentHub");
  const current = c.get<RootSetting[]>("roots", []);
  const abs = path.resolve(expandHome(root.path));
  if (current.some((r) => normalizePath(r.path) === normalizePath(abs))) return;
  await c.update("roots", [...current, { ...root, path: abs }], vscode.ConfigurationTarget.Global);
}
