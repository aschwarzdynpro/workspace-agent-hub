import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { compact, encodeProjectDir, listTranscripts, readTranscriptTitle, transcriptBelongsTo } from "../src/claudeProjects";
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
