#!/usr/bin/env node
/**
 * Claude Code hook → Workspace Agent Hub spool.
 *
 * Claude Code invokes this script for every configured hook event and pipes a
 * JSON payload on stdin (session_id, transcript_path, cwd, hook_event_name, …).
 * We append one compact NDJSON line to the spool file; the VS Code extension
 * tails that file. Nothing is ever blocked or modified: exit code is always 0
 * and nothing is written to stdout, so Claude Code continues normally.
 *
 * Usage (installed into ~/.claude/settings.json by the extension):
 *   node "<ext>/hooks/hub-event.js"
 *
 * Environment:
 *   AGENT_HUB_SPOOL     override spool path (default ~/.claude/hub/events.ndjson)
 *   AGENT_HUB_TERMINAL  set by the extension on terminals it spawns; lets the
 *                       hub map a session to the terminal it runs in.
 *   AGENT_HUB_ROOT      display name of the root the extension launched in.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function spoolPath() {
  const p = process.env.AGENT_HUB_SPOOL || path.join(os.homedir(), ".claude", "hub", "events.ndjson");
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function readStdin(cb) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (data += c));
  process.stdin.on("end", () => cb(data));
  process.stdin.on("error", () => cb(data));
  // Safety net: never hang Claude Code if stdin stays open.
  setTimeout(() => cb(data), 1500).unref();
}

let done = false;
readStdin((raw) => {
  if (done) return;
  done = true;
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = { parse_error: true, raw: raw.slice(0, 500) };
  }

  const event = {
    ts: new Date().toISOString(),
    event: payload.hook_event_name || process.argv[2] || "Unknown",
    session_id: payload.session_id || null,
    cwd: payload.cwd || process.cwd(),
    transcript_path: payload.transcript_path || null,
    tool_name: payload.tool_name || null,
    // Keep tool input tiny: just the first string-ish field, truncated.
    tool_hint: toolHint(payload.tool_input),
    message: typeof payload.message === "string" ? payload.message.slice(0, 300) : null,
    prompt: typeof payload.prompt === "string" ? payload.prompt.slice(0, 300) : null,
    notification_type: payload.notification_type || null,
    stop_hook_active: payload.stop_hook_active ?? null,
    source: payload.source || null, // SessionStart: startup | resume | clear | compact
    reason: payload.reason || null, // SessionEnd reason
    terminal: process.env.AGENT_HUB_TERMINAL || null,
    root: process.env.AGENT_HUB_ROOT || null,
    pid: process.ppid,
  };

  try {
    const file = spoolPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Never fail the hook because of the spool.
  }
  process.exit(0);
});

function toolHint(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.slice(0, 160);
  }
  return null;
}
