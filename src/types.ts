export type RootKind = "repo" | "coordinator";

export interface Root {
  /** Stable id: normalized absolute path. */
  id: string;
  name: string;
  /** Absolute, `~`-expanded path. */
  path: string;
  kind: RootKind;
  /** Where the root came from. */
  source: "workspace" | "settings";
}

export type SessionStatus =
  | "working" // agent is executing (prompt submitted / tool running)
  | "waiting" // agent needs input (permission or question)
  | "done" // turn finished, waiting for next prompt
  | "idle" // no events for a while, process may still be alive
  | "ended"; // SessionEnd seen or only known from transcript

export interface Session {
  id: string;
  rootId: string;
  cwd: string;
  status: SessionStatus;
  /** First user prompt or transcript summary. */
  title: string;
  lastEventAt: number;
  startedAt: number;
  lastEvent: string;
  currentTool?: string;
  currentToolHint?: string;
  /** Last Notification message, e.g. the question the agent is asking. */
  lastMessage?: string;
  /** Terminal id set by the extension when it spawned the session. */
  terminalId?: string;
  transcriptPath?: string;
  /** Number of prompts submitted in this session (turns). */
  turns: number;
}

/** One NDJSON line written by hooks/hub-event.js */
export interface SpoolEvent {
  ts: string;
  event: string;
  session_id: string | null;
  cwd: string;
  transcript_path: string | null;
  tool_name: string | null;
  tool_hint: string | null;
  message: string | null;
  prompt: string | null;
  notification_type: string | null;
  stop_hook_active: boolean | null;
  source: string | null;
  reason: string | null;
  terminal: string | null;
  root: string | null;
  pid: number;
}

/** A session discovered from ~/.claude/projects/<encoded>/<id>.jsonl */
export interface TranscriptInfo {
  sessionId: string;
  cwd: string;
  path: string;
  title: string;
  modifiedAt: number;
  sizeBytes: number;
}
