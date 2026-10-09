import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "./config";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
const MARKER = "hub-event.js";

interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type HooksMap = Record<string, HookGroup[]>;

/**
 * Merges our hook into ~/.claude/settings.json without touching anything else.
 * Idempotent: an existing group containing `hub-event.js` is updated in place.
 */
export async function installHooks(context: vscode.ExtensionContext): Promise<void> {
  const cfg = getConfig();
  const settingsPath = path.join(cfg.claudeHome, "settings.json");
  const script = path.join(context.extensionPath, "hooks", MARKER);
  const command = `node ${JSON.stringify(script)}`;

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Hub: cannot parse ${settingsPath}: ${String(e)}`);
      return;
    }
    fs.copyFileSync(settingsPath, settingsPath + ".agent-hub.bak");
  }

  const hooks: HooksMap = (settings.hooks as HooksMap) ?? {};
  for (const ev of EVENTS) {
    const groups = hooks[ev] ?? [];
    const ours = groups.find((g) => g.hooks?.some((h) => h.command?.includes(MARKER)));
    const entry: HookCommand = { type: "command", command, timeout: 5 };
    if (ours) {
      ours.hooks = ours.hooks.filter((h) => !h.command?.includes(MARKER));
      ours.hooks.push(entry);
    } else {
      // Tool events accept a matcher; "" matches everything. Others take no matcher.
      const group: HookGroup = /ToolUse$/.test(ev) ? { matcher: "", hooks: [entry] } : { hooks: [entry] };
      groups.push(group);
    }
    hooks[ev] = groups;
  }
  settings.hooks = hooks;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  fs.mkdirSync(path.dirname(cfg.spoolPath), { recursive: true });

  const choice = await vscode.window.showInformationMessage(
    `Agent Hub hooks installed in ${settingsPath}. Running Claude sessions pick them up after a restart.`,
    "Open settings.json"
  );
  if (choice) await vscode.window.showTextDocument(vscode.Uri.file(settingsPath));
}

/** True when settings.json points at THIS extension's hook script (path may differ between dev host and installed). */
export function hooksInstalled(context: vscode.ExtensionContext): boolean {
  const settingsPath = path.join(getConfig().claudeHome, "settings.json");
  try {
    const text = fs.readFileSync(settingsPath, "utf8");
    const script = path.join(context.extensionPath, "hooks", MARKER);
    return text.includes(JSON.stringify(script).slice(1, -1));
  } catch {
    return false;
  }
}
