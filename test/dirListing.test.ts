import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { excludedNames, listDir } from "../src/dirListing";
import { tmpDir } from "./helpers";

test("listDir: folders first, then files, by name ignoring case and numbering naturally", () => {
  const dir = tmpDir();
  for (const d of ["wi", "Out", ".git"]) fs.mkdirSync(path.join(dir, d));
  for (const f of ["b.md", "A.md", "CLAUDE.md"]) fs.writeFileSync(path.join(dir, f), "");
  fs.mkdirSync(path.join(dir, "wi", "2125"));
  fs.mkdirSync(path.join(dir, "wi", "2049"));
  fs.mkdirSync(path.join(dir, "wi", "10"));
  const hidden = excludedNames({ "**/.git": true });
  assert.deepEqual(listDir(dir, hidden).entries.map((e) => `${e.isDir ? "d" : "f"}:${e.name}`), ["d:Out", "d:wi", "f:A.md", "f:b.md", "f:CLAUDE.md"]);
  assert.deepEqual(listDir(path.join(dir, "wi"), hidden).entries.map((e) => e.name), ["10", "2049", "2125"]);
});

test("listDir: caps the entries and counts the rest; a missing folder is empty", () => {
  const dir = tmpDir();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "");
  const r = listDir(dir, () => false, 3);
  assert.equal(r.entries.length, 3);
  assert.equal(r.more, 2);
  assert.deepEqual(listDir(path.join(dir, "nope"), () => false), { entries: [], more: 0 });
});

test("excludedNames honours whole-name patterns that are switched on", () => {
  const hidden = excludedNames({ "**/.git": true, "**/.DS_Store": true, "Thumbs.db": true, "**/node_modules": false, "**/*.tmp": true, "out/**": true });
  assert.ok(hidden(".git") && hidden(".DS_Store") && hidden("Thumbs.db"));
  assert.ok(!hidden("node_modules") && !hidden("a.tmp") && !hidden("out"));
  assert.ok(!excludedNames(undefined)(".git"));
});
