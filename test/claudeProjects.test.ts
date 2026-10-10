import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { compact, encodeProjectDir, listTranscripts, readTranscriptTitle, transcriptBelongsTo, WrittenFilesIndex } from "../src/claudeProjects";
import { tmpDir } from "./helpers";

function writeTranscript(home: string, cwd: string, id: string, lines: object[], mtime?: Date): string {
  const dir = path.join(home, "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

const user = (content: unknown, cwd = "/x") => ({ type: "user", cwd, message: { role: "user", content } });

test("encodeProjectDir replaces every non-alphanumeric character", () => {
  if (process.platform === "win32") return;
  assert.equal(encodeProjectDir("/Users/andy/src/my_app.v2"), "-Users-andy-src-my-app-v2");
});

test("title: summary line wins over the first prompt", () => {
  const home = tmpDir();
  const p = writeTranscript(home, "/r", "a", [user("first prompt"), { type: "summary", summary: "Importer refactor" }]);
  assert.equal(readTranscriptTitle(p), "Importer refactor");
});

test("title: skips command/caveat messages starting with '<' and reads text parts", () => {
  const home = tmpDir();
  const p = writeTranscript(home, "/r", "a", [
    user("<command-name>/clear</command-name>"),
    user([{ type: "image" }, { type: "text", text: "Add   tests\nplease" }]),
  ]);
  assert.equal(readTranscriptTitle(p), "Add tests please");
});

test("title: skips injected '<…>' text parts before the prompt in the same message", () => {
  const home = tmpDir();
  const p = writeTranscript(home, "/r", "a", [
    user([
      { type: "text", text: "<browser_instruction># Claude in Chrome</browser_instruction>" },
      { type: "text", text: "wi-analyse ITGDYN-364" },
    ]),
  ]);
  assert.equal(readTranscriptTitle(p), "wi-analyse ITGDYN-364");
});

test("title: skips isMeta user lines (skill bodies injected by Claude Code)", () => {
  const home = tmpDir();
  const p = writeTranscript(home, "/r", "a", [
    { ...user([{ type: "text", text: "Base directory for this skill: C:\\x" }]), isMeta: true },
    user("Mach mir ein Update"),
  ]);
  assert.equal(readTranscriptTitle(p), "Mach mir ein Update");
});

test("title: /rename beats the AI title, which beats summary and prompt; the last record wins", () => {
  const home = tmpDir();
  const ai = (aiTitle: string) => ({ type: "ai-title", aiTitle, sessionId: "a" });
  const custom = (customTitle: string) => ({ type: "custom-title", customTitle, sessionId: "a" });
  const p = writeTranscript(home, "/r", "a", [user("first prompt"), { type: "summary", summary: "S" }, ai("Old AI"), ai("New AI")]);
  assert.equal(readTranscriptTitle(p), "New AI");
  fs.appendFileSync(p, [custom("ITGDYN-1"), ai("Newer AI"), custom("ITGDYN-2")].map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(readTranscriptTitle(p), "ITGDYN-2");
});

test("title: a /rename appended after a large transcript body is found in the tail", () => {
  const home = tmpDir();
  const filler = Array.from({ length: 400 }, (_, i) => ({ type: "assistant", message: { role: "assistant", content: "x".repeat(1000) + i } }));
  const p = writeTranscript(home, "/r", "a", [user("first prompt"), ...filler, { type: "custom-title", customTitle: "Renamed", sessionId: "a" }]);
  assert.ok(fs.statSync(p).size > 2 * 64 * 1024);
  assert.equal(readTranscriptTitle(p), "Renamed");
  assert.equal(listTranscripts(home, "/r", 1)[0].title, "Renamed");
});

test("title of a missing file is undefined, not an exception", () => {
  assert.equal(readTranscriptTitle(path.join(tmpDir(), "nope.jsonl")), undefined);
});

test("listTranscripts returns newest first with titles, limited", () => {
  const home = tmpDir();
  const cwd = path.join(tmpDir(), "root");
  writeTranscript(home, cwd, "old", [user("old one", cwd)], new Date(Date.now() - 3_600_000));
  writeTranscript(home, cwd, "new", [user("new one", cwd)], new Date());
  writeTranscript(home, cwd, "empty", [{ type: "system", cwd }], new Date(Date.now() - 7_200_000));
  const list = listTranscripts(home, cwd, 2);
  assert.deepEqual(list.map((t) => t.sessionId), ["new", "old"]);
  assert.equal(list[0].title, "new one");
  assert.equal(listTranscripts(home, cwd, 10)[2].title, "(no prompt yet)");
});

test("listTranscripts of an unknown root is empty", () => {
  assert.deepEqual(listTranscripts(tmpDir(), "/does/not/exist"), []);
});

test("transcriptBelongsTo compares the recorded cwd", () => {
  const home = tmpDir();
  const cwd = path.join(tmpDir(), "root");
  const p = writeTranscript(home, cwd, "a", [user("x", cwd)]);
  assert.equal(transcriptBelongsTo(p, cwd), true);
  assert.equal(transcriptBelongsTo(p, path.join(cwd, "other")), false);
});

test("compact collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(compact("a  b\n c"), "a b c");
  assert.equal(compact("x".repeat(100), 10), "xxxxxxxxx…");
});

const toolUse = (cwd: string, timestamp: string, ...uses: [string, Record<string, unknown>][]) => ({
  type: "assistant",
  cwd,
  timestamp,
  message: { role: "assistant", content: [{ type: "text", text: "ok" }, ...uses.map(([name, input]) => ({ type: "tool_use", id: "t", name, input }))] },
});

test("WrittenFilesIndex lists Write/Edit/NotebookEdit targets newest first, relative paths resolved", () => {
  const dir = tmpDir();
  const cwd = path.join(dir, "root");
  const p = path.join(dir, "s.jsonl");
  fs.writeFileSync(
    p,
    [
      user("go", cwd),
      toolUse(cwd, "2026-10-08T09:00:00Z", ["Write", { file_path: path.join(cwd, "out", "a.md"), content: "x" }], ["Read", { file_path: path.join(cwd, "r.md") }]),
      toolUse(cwd, "2026-10-08T10:00:00Z", ["Edit", { file_path: "wi/b.md", old_string: "", new_string: "" }]),
      toolUse(cwd, "2026-10-08T11:00:00Z", ["NotebookEdit", { notebook_path: path.join(cwd, "n.ipynb") }], ["Bash", { command: "echo > c.md" }]),
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n"
  );
  const files = new WrittenFilesIndex().get(p);
  assert.deepEqual(
    files.map((f) => [f.tool, f.path]),
    [
      ["NotebookEdit", path.join(cwd, "n.ipynb")],
      ["Edit", path.join(cwd, "wi", "b.md")],
      ["Write", path.join(cwd, "out", "a.md")],
    ]
  );
});

test("WrittenFilesIndex reads appended lines only, waits for a complete line, and restarts on truncation", () => {
  const dir = tmpDir();
  const cwd = path.join(dir, "root");
  const p = path.join(dir, "s.jsonl");
  const write = (file: string, ts: string) => JSON.stringify(toolUse(cwd, ts, ["Write", { file_path: path.join(cwd, file) }]));
  const index = new WrittenFilesIndex();
  fs.writeFileSync(p, write("a.md", "2026-10-08T09:00:00Z") + "\n");
  assert.deepEqual(index.get(p).map((f) => path.basename(f.path)), ["a.md"]);
  // a line still being written (no newline yet, cut inside "Ä") is not read
  const next = write("Ä.md", "2026-10-08T10:00:00Z");
  const bytes = Buffer.from(next + "\n");
  const cut = bytes.indexOf(Buffer.from("Ä")) + 1;
  fs.appendFileSync(p, bytes.subarray(0, cut));
  assert.deepEqual(index.get(p).map((f) => path.basename(f.path)), ["a.md"]);
  fs.appendFileSync(p, bytes.subarray(cut));
  assert.deepEqual(index.get(p).map((f) => path.basename(f.path)), ["Ä.md", "a.md"]);
  // writing a.md again moves it to the top
  fs.appendFileSync(p, write("a.md", "2026-10-08T11:00:00Z") + "\n");
  assert.deepEqual(index.get(p).map((f) => path.basename(f.path)), ["a.md", "Ä.md"]);
  // a rewritten (shorter) transcript is indexed from scratch
  fs.writeFileSync(p, write("z.md", "2026-10-08T12:00:00Z") + "\n");
  assert.deepEqual(index.get(p).map((f) => path.basename(f.path)), ["z.md"]);
  assert.deepEqual(index.get(path.join(dir, "missing.jsonl")), []);
});
