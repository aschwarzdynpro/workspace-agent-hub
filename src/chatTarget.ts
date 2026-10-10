/**
 * When the Anthropic Claude Code chat may run a root's session. Verified against
 * anthropic.claude-code 2.1.296 (see SPEC.md › Open questions 4):
 * - `claude-vscode.editor.open(sessionId?)` opens a chat tab: a new conversation without an id,
 *   otherwise it reveals the open tab of that session or resumes it.
 * - The chat's working directory is always the window's first workspace folder; no command
 *   argument changes it. A chat for any other root would run in the wrong folder.
 * - The chat process gets VS Code's environment, never a root's `env` / `envFile`.
 */
export const CHAT_EXTENSION_ID = "anthropic.claude-code";
/** `entrypoint` recorded in transcripts of sessions started from the chat panel. */
export const CHAT_ENTRYPOINT = "claude-vscode";

export interface ChatContext {
  commandId: string;
  extensionInstalled: boolean;
  /** Normalized path and name of the window's first workspace folder. */
  firstFolder?: { id: string; name: string };
  root: { id: string; name: string; env?: Record<string, string>; envFile?: string };
}

/** Why the chat must not run this root's session, or undefined when it may. */
export function chatBlocker(c: ChatContext): string | undefined {
  if (!c.commandId) return "agentHub.chatCommandId is empty";
  if (!c.extensionInstalled) return "the Claude Code extension is not installed";
  if (c.root.env && Object.keys(c.root.env).length) return `the chat cannot take ${c.root.name}'s env`;
  if (c.root.envFile) return `the chat cannot load ${c.root.name}'s envFile`;
  if (c.firstFolder?.id !== c.root.id) {
    return `the Claude Code chat always runs in the window's first folder (${c.firstFolder?.name ?? "none open"})`;
  }
  return undefined;
}
