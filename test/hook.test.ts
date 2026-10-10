import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tmpDir } from "./helpers";

/** Runs the real hook script (cwd = repo root under `npm test`) and returns the spooled line. */
function runHook(payload: object): Record<string, unknown> {
  const spool = path.join(tmpDir(), "events.ndjson");
  const r = spawnSync(process.execPath, [path.resolve("hooks/hub-event.js")], {
    input: JSON.stringify(payload),
    env: { ...process.env, AGENT_HUB_SPOOL: spool },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  return JSON.parse(fs.readFileSync(spool, "utf8").trim());
}

test("hook: AskUserQuestion's first question becomes the tool hint", () => {
  const ev = runHook({
    hook_event_name: "PreToolUse",
    session_id: "s",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which tenant?", header: "Tenant", options: [] }, { question: "Second?" }] },
  });
  assert.equal(ev.tool_hint, "Which tenant?");
});

test("hook: ordinary tools keep their first string field as hint; invalid input still exits 0", () => {
  assert.equal(runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }).tool_hint, "npm test");
  const spool = path.join(tmpDir(), "events.ndjson");
  const r = spawnSync(process.execPath, [path.resolve("hooks/hub-event.js")], { input: "{not json", env: { ...process.env, AGENT_HUB_SPOOL: spool } });
  assert.equal(r.status, 0);
});
