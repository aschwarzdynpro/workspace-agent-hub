import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { SessionTracker } from "../src/sessionTracker";
import { ago, harness, line, root, tmpDir } from "./helpers";

const A = path.resolve("/work/a");
const B = path.resolve("/work/b");

test("status machine: start → working → tool → done", () => {
  const h = harness([A]);
  h.emit({ event: "SessionStart", session_id: "s1" });
  assert.equal(h.tracker.get("s1")?.status, "done");
  h.emit({ event: "UserPromptSubmit", session_id: "s1", prompt: "Fix  the\nbuild" });
  assert.equal(h.tracker.get("s1")?.status, "working");
  assert.equal(h.tracker.get("s1")?.title, "Fix the build");
  assert.equal(h.tracker.get("s1")?.turns, 1);
  h.emit({ event: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_hint: "npm test" });
  assert.equal(h.tracker.get("s1")?.currentTool, "Bash");
  assert.equal(h.tracker.get("s1")?.currentToolHint, "npm test");
  h.emit({ event: "Stop", session_id: "s1" });
  const s = h.tracker.get("s1");
  assert.equal(s?.status, "done");
  assert.equal(s?.currentTool, undefined);
});

test("permission notification → waiting, next prompt clears the question", () => {
  const h = harness([A]);
  h.emit({ event: "Notification", session_id: "s1", notification_type: "permission_prompt", message: "Allow Bash?" });
  assert.equal(h.tracker.get("s1")?.status, "waiting");
  assert.equal(h.tracker.get("s1")?.lastMessage, "Allow Bash?");
  assert.equal(h.tracker.counts().waiting, 1);
  h.emit({ event: "UserPromptSubmit", session_id: "s1", prompt: "go" });
  assert.equal(h.tracker.get("s1")?.status, "working");
  assert.equal(h.tracker.get("s1")?.lastMessage, undefined);
});

test("idle_prompt and auth_success do not mark a session as waiting", () => {
  const h = harness([A]);
  h.emit({ event: "Stop", session_id: "s1" });
  h.emit({ event: "Notification", session_id: "s1", notification_type: "idle_prompt", message: "Claude is waiting" });
  h.emit({ event: "Notification", session_id: "s1", notification_type: "auth_success", message: "ok" });
  assert.equal(h.tracker.get("s1")?.status, "done");
});

test("untyped notification (older Claude Code) still means waiting", () => {
  const h = harness([A]);
  h.emit({ event: "Notification", session_id: "s1", message: "needs permission" });
  assert.equal(h.tracker.get("s1")?.status, "waiting");
});

test("sessions are assigned to roots by exact cwd or longest prefix", () => {
  const nested = path.join(A, "pkg");
  const h = harness([A, B, nested]);
  h.emit({ event: "SessionStart", session_id: "a", cwd: A });
  h.emit({ event: "SessionStart", session_id: "deep", cwd: path.join(nested, "src") });
  h.emit({ event: "SessionStart", session_id: "b", cwd: path.join(B, "x") });
  h.emit({ event: "SessionStart", session_id: "none", cwd: path.resolve("/elsewhere") });
  assert.equal(h.tracker.get("a")?.rootId, A);
  assert.equal(h.tracker.get("deep")?.rootId, nested);
  assert.equal(h.tracker.get("b")?.rootId, B);
  assert.equal(h.tracker.get("none")?.rootId, "");
  assert.deepEqual(h.tracker.forRoot(A).map((s) => s.id), ["a"]);
});

test("a root added later picks up its orphaned sessions", () => {
  const h = harness([A]);
  h.emit({ event: "SessionStart", session_id: "b", cwd: B });
  assert.equal(h.tracker.get("b")?.rootId, "");
  h.tracker.setRoots([root(A), root(B)]);
  assert.equal(h.tracker.get("b")?.rootId, B);
});

test("forRoot sorts waiting → working → done, newest first", () => {
  const h = harness([A]);
  h.emit(
    { event: "Stop", session_id: "done-old", ts: ago(5 * 60_000) },
    { event: "Stop", session_id: "done-new", ts: ago(60_000) },
    { event: "UserPromptSubmit", session_id: "working", prompt: "x" },
    { event: "Notification", session_id: "waiting", message: "?" }
  );
  assert.deepEqual(h.tracker.forRoot(A).map((s) => s.id), ["waiting", "working", "done-new", "done-old"]);
});

test("stale done/working sessions read as idle; waiting stays waiting", () => {
  const h = harness([A], 10 * 60_000);
  h.emit(
    { event: "UserPromptSubmit", session_id: "w", prompt: "x", ts: ago(20 * 60_000) },
    { event: "Notification", session_id: "q", message: "?", ts: ago(20 * 60_000) }
  );
  assert.equal(h.tracker.get("w")?.status, "idle");
  assert.equal(h.tracker.get("q")?.status, "waiting");
});

test("closing the hub terminal ends the session; tick prunes ended and 24h-old sessions", () => {
  const h = harness([A]);
  h.emit(
    { event: "SessionStart", session_id: "t", terminal: "T1" },
    { event: "Stop", session_id: "old", ts: ago(25 * 60 * 60_000) },
    { event: "Stop", session_id: "keep" }
  );
  h.tracker.terminalClosed("T1");
  assert.equal(h.tracker.get("t")?.status, "ended");
  h.tracker.tick();
  assert.equal(h.tracker.get("t"), undefined);
  assert.equal(h.tracker.get("old"), undefined);
  assert.equal(h.tracker.get("keep")?.status, "done");
});

test("SessionEnd removes the session from live views after the next tick", () => {
  const h = harness([A]);
  h.emit({ event: "SessionStart", session_id: "s" }, { event: "SessionEnd", session_id: "s", reason: "exit" });
  assert.equal(h.tracker.get("s")?.status, "ended");
  h.tracker.tick();
  assert.equal(h.tracker.get("s"), undefined);
});

test("a line split inside a multi-byte character is decoded correctly", () => {
  const h = harness([A]);
  const buf = Buffer.from(JSON.stringify(line({ event: "UserPromptSubmit", session_id: "u", prompt: "Übergröße" }, A)) + "\n");
  const cut = buf.indexOf(Buffer.from("Ü")) + 1;
  fs.appendFileSync(h.spool, buf.subarray(0, cut));
  (h.tracker as unknown as { readNew(): void }).readNew();
  assert.equal(h.tracker.get("u"), undefined);
  fs.appendFileSync(h.spool, buf.subarray(cut));
  (h.tracker as unknown as { readNew(): void }).readNew();
  assert.equal(h.tracker.get("u")?.title, "Übergröße");
});

test("malformed lines are logged and skipped", () => {
  const h = harness([A]);
  fs.appendFileSync(h.spool, "{not json\n");
  h.emit({ event: "Stop", session_id: "ok" });
  assert.equal(h.tracker.get("ok")?.status, "done");
  assert.ok(h.logs.some((l) => l.startsWith("bad spool line")));
});

test("replay on start reads only the tail and drops the cut first line", () => {
  const dir = tmpDir();
  const spool = path.join(dir, "events.ndjson");
  const big = JSON.stringify(line({ event: "Stop", session_id: "head", pad: "y".repeat(9 * 1024 * 1024) }, A));
  fs.writeFileSync(spool, big + "\n" + JSON.stringify(line({ event: "Stop", session_id: "tail" }, A)) + "\n");
  const logs: string[] = [];
  const t = new SessionTracker({ appendLine: (l) => logs.push(l) }, () => ({ spoolPath: spool, staleAfterMs: 60_000 }));
  t.setRoots([root(A)]);
  t.start();
  t.stop();
  assert.equal(t.get("head"), undefined);
  assert.equal(t.get("tail")?.status, "done");
  assert.ok(!logs.some((l) => l.startsWith("bad spool line")));
});

test("truncated spool is re-read from the beginning", () => {
  const h = harness([A]);
  h.emit({ event: "Stop", session_id: "before" });
  fs.writeFileSync(h.spool, JSON.stringify(line({ event: "Stop", session_id: "after" }, A)) + "\n");
  (h.tracker as unknown as { readNew(): void }).readNew();
  assert.equal(h.tracker.get("after")?.status, "done");
});

test("transcript title is used when no prompt was seen", () => {
  const dir = tmpDir();
  const transcript = path.join(dir, "s.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", cwd: A, message: { role: "user", content: "Refactor the importer" } }) + "\n");
  const h = harness([A]);
  h.emit({ event: "SessionStart", session_id: "s", transcript_path: transcript });
  assert.equal(h.tracker.get("s")?.title, "Refactor the importer");
});

test("onDidStartWaiting fires once per transition into waiting, with waitingSince", () => {
  const h = harness([A]);
  const fired: string[] = [];
  h.tracker.onDidStartWaiting((s) => fired.push(`${s.id}:${s.lastMessage}`));
  h.emit({ event: "Notification", session_id: "s", message: "Allow Bash?", ts: ago(2 * 60_000) });
  h.emit({ event: "Notification", session_id: "s", message: "Allow Bash? (again)" });
  assert.deepEqual(fired, ["s:Allow Bash?"]);
  const since = h.tracker.get("s")?.waitingSince ?? 0;
  assert.ok(Date.now() - since >= 2 * 60_000 - 1000);
  h.emit({ event: "PostToolUse", session_id: "s" });
  assert.equal(h.tracker.get("s")?.waitingSince, undefined);
  h.emit({ event: "Notification", session_id: "s", message: "Next question" });
  assert.deepEqual(fired, ["s:Allow Bash?", "s:Next question"]);
});

test("replay on start does not announce old questions", () => {
  const dir = tmpDir();
  const spool = path.join(dir, "events.ndjson");
  fs.writeFileSync(spool, JSON.stringify(line({ event: "Notification", session_id: "old", message: "?" }, A)) + "\n");
  const t = new SessionTracker({ appendLine: () => undefined }, () => ({ spoolPath: spool, staleAfterMs: 60_000 }));
  const fired: string[] = [];
  t.onDidStartWaiting((s) => fired.push(s.id));
  t.setRoots([root(A)]);
  t.start();
  t.stop();
  assert.equal(t.get("old")?.status, "waiting");
  assert.deepEqual(fired, []);
});

test("waiting() lists longest-waiting first", () => {
  const h = harness([A]);
  h.emit(
    { event: "Notification", session_id: "recent", message: "?", ts: ago(60_000) },
    { event: "Notification", session_id: "longest", message: "?", ts: ago(10 * 60_000) },
    { event: "Stop", session_id: "done" }
  );
  assert.deepEqual(h.tracker.waiting().map((s) => s.id), ["longest", "recent"]);
});

test("late events from a closed hub terminal cannot revive its session", () => {
  const h = harness([A]);
  h.emit({ event: "UserPromptSubmit", session_id: "s", terminal: "T", prompt: "x" });
  // written but not yet read when the terminal closes
  fs.appendFileSync(h.spool, JSON.stringify(line({ event: "PreToolUse", session_id: "s", terminal: "T", tool_name: "Bash" }, A)) + "\n");
  h.tracker.terminalClosed("T");
  assert.equal(h.tracker.get("s")?.status, "ended");
  const fired: string[] = [];
  h.tracker.onDidStartWaiting((s) => fired.push(s.id));
  h.emit({ event: "Notification", session_id: "s", terminal: "T", message: "?" });
  assert.equal(h.tracker.get("s")?.status, "ended");
  assert.deepEqual(fired, []);
  h.tracker.tick(); // pruned …
  h.emit({ event: "Stop", session_id: "s", terminal: "T" }); // … and a straggler recreates it
  assert.equal(h.tracker.get("s")?.status, "ended");
});

test("tail replay keeps a complete first line when the cut lands on a line boundary", () => {
  const dir = tmpDir();
  const spool = path.join(dir, "events.ndjson");
  const ev = (o: Record<string, unknown>) => JSON.stringify(line(o, A)) + "\n";
  const tail = ev({ event: "Stop", session_id: "tail" });
  const base = ev({ event: "Stop", session_id: "first", pad: "" });
  const first = ev({ event: "Stop", session_id: "first", pad: "y".repeat(8 * 1024 * 1024 - Buffer.byteLength(base) - Buffer.byteLength(tail)) });
  const head = ev({ event: "Stop", session_id: "head" });
  fs.writeFileSync(spool, head + first + tail);
  assert.equal(fs.statSync(spool).size - 8 * 1024 * 1024, Buffer.byteLength(head), "fixture: cut exactly after head");
  const t = new SessionTracker({ appendLine: () => undefined }, () => ({ spoolPath: spool, staleAfterMs: 60_000 }));
  t.setRoots([root(A)]);
  t.start();
  t.stop();
  assert.equal(t.get("head"), undefined);
  assert.equal(t.get("first")?.status, "done");
  assert.equal(t.get("tail")?.status, "done");
});
