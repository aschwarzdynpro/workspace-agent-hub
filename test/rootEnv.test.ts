import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parseDotenv, resolveRootEnv } from "../src/rootEnv";
import { root, tmpDir } from "./helpers";

test("parseDotenv handles comments, export, quotes and inline comments", () => {
  const env = parseDotenv(
    [
      "# comment",
      "export TENANT=contoso",
      'DATAVERSE_URL="https://org.crm4.dynamics.com"',
      "SECRET='a#b c'",
      "PLAIN=value # trailing comment",
      'MULTI="line1\\nline2"',
      "EMPTY=",
      "not a line",
    ].join("\n")
  );
  assert.deepEqual(env, {
    TENANT: "contoso",
    DATAVERSE_URL: "https://org.crm4.dynamics.com",
    SECRET: "a#b c",
    PLAIN: "value",
    MULTI: "line1\nline2",
    EMPTY: "",
  });
});

test("resolveRootEnv: envFile relative to the root, inline env wins", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, ".env.agent"), "A=file\nB=file\n");
  const r = { ...root(dir), envFile: ".env.agent", env: { B: "inline" } };
  assert.deepEqual(resolveRootEnv(r), { env: { A: "file", B: "inline" }, error: undefined });
});

test("resolveRootEnv reports a missing envFile but keeps inline env", () => {
  const dir = tmpDir();
  const res = resolveRootEnv({ ...root(dir), envFile: "missing.env", env: { X: "1" } });
  assert.deepEqual(res.env, { X: "1" });
  assert.match(res.error ?? "", /missing\.env/);
});
