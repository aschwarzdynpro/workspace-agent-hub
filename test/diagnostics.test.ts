import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { encodeProjectDir } from "../src/claudeProjects";
import { buildDiagnostics } from "../src/diagnostics";
import { root, tmpDir } from "./helpers";

test("diagnostics report encoding matches, payload fields and notification types", () => {
  const home = tmpDir();
  const cwd = path.join(tmpDir(), "my_root");
  // one dir that matches our encoding, one that does not
  for (const [dir, recorded] of [
    [encodeProjectDir(cwd), cwd],
    ["weird-name", path.join(tmpDir(), "other")],
  ]) {
    fs.mkdirSync(path.join(home, "projects", dir), { recursive: true });
    fs.writeFileSync(path.join(home, "projects", dir, "s.jsonl"), JSON.stringify({ type: "user", cwd: recorded, message: { role: "user", content: "hi" } }) + "\n");
  }
  const spool = path.join(home, "events.ndjson");
  const ev = (e: object) => JSON.stringify({ ts: new Date().toISOString(), cwd, session_id: "s", ...e });
  fs.writeFileSync(
    spool,
    [
      ev({ event: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash", keys: ["session_id", "message", "notification_type"] }),
      ev({ event: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input", keys: ["session_id", "message"] }),
      ev({ event: "Stop", keys: ["session_id", "stop_hook_active"], terminal: "T" }),
    ].join("\n") + "\n"
  );
  const md = buildDiagnostics({
    claudeHome: home,
    spoolPath: spool,
    roots: [root(cwd)],
    hooksInstalled: true,
    terminals: [{ name: "claude · my_root", hubId: "1234567890" }],
  });
  assert.match(md, /2 project dirs: \*\*1 match\*\* `encodeProjectDir\(\)`, \*\*1 mismatch\*\*/);
  assert.match(md, /\| `weird-name` \|/);
  assert.match(md, /\| Notification \| 2 \| `message` `notification_type` `session_id` \|/);
  assert.match(md, /\| `permission_prompt` \| 1 \| “Claude needs your permission to use Bash” \|/);
  assert.match(md, /\| `idle_prompt` \| 1 \|/);
  assert.match(md, /\| my_root \| `.*my_root` \| yes \| 1 \|/);
  assert.match(md, /1 started from a hub terminal/);
  assert.match(md, /\| claude · my_root \| `12345678…` \|/);
});

test("diagnostics without any Claude data explains what to do", () => {
  const home = tmpDir();
  const md = buildDiagnostics({ claudeHome: home, spoolPath: path.join(home, "none.ndjson"), roots: [], hooksInstalled: false, terminals: [] });
  assert.match(md, /Hooks installed: \*\*no\*\*/);
  assert.match(md, /No events in/);
  assert.match(md, /\| \(none\) \| \|/);
});
