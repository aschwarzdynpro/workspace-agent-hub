import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { age, displayPath, relTime, statusLabel } from "../src/format";
import { Session } from "../src/types";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const min = (m: number) => NOW - m * 60_000;

function session(p: Partial<Session>): Session {
  return { id: "s", rootId: "r", cwd: "/r", status: "done", title: "t", lastEventAt: NOW, startedAt: NOW, lastEvent: "Stop", turns: 1, ...p };
}

test("age and relTime", () => {
  assert.equal(age(min(0.5), NOW), "now");
  assert.equal(age(min(3), NOW), "3m");
  assert.equal(age(min(125), NOW), "2h");
  assert.equal(age(min(3 * 24 * 60), NOW), "3d");
  assert.equal(relTime(min(3), NOW), "3 min ago");
});

test("statusLabel stays short; waiting counts from waitingSince", () => {
  assert.equal(statusLabel(session({ status: "waiting", waitingSince: min(7), lastEventAt: min(1) }), NOW), "waiting 7m");
  assert.equal(statusLabel(session({ status: "working", currentTool: "Edit" }), NOW), "working · Edit");
  assert.equal(statusLabel(session({ status: "working" }), NOW), "working");
  assert.equal(statusLabel(session({ status: "done", lastEventAt: min(9) }), NOW), "done 9m");
  assert.equal(statusLabel(session({ status: "idle", lastEventAt: min(60) }), NOW), "idle 1h");
});

test("displayPath: home becomes ~, long paths keep the last two segments", () => {
  if (process.platform === "win32") return;
  assert.equal(displayPath("/home/andy/src/waldmann/crm", "/home/andy"), "~/src/waldmann/crm");
  assert.equal(displayPath("/home/andy", "/home/andy"), "~");
  assert.equal(displayPath("/home/andyx/src", "/home/andy"), "/home/andyx/src", "prefix of another user's home is not home");
  const long = "/tmp/claude-0/very-long-session-directory-name/scratchpad/demo/kunden/waldmann-crm";
  assert.equal(displayPath(long, "/home/andy"), `…${path.sep}kunden${path.sep}waldmann-crm`);
});
