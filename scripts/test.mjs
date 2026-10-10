// Bundles test/*.test.ts with esbuild and runs them with Node's built-in test runner.
// No test framework dependency; the code under test must not import `vscode`.
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";

const outdir = "out-test";
rmSync(outdir, { recursive: true, force: true });
const entryPoints = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `test/${f}`);

await esbuild.build({
  entryPoints,
  bundle: true,
  outdir,
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: "inline",
  external: ["vscode"],
  logLevel: "warning",
});

const files = entryPoints.map((e) => `${outdir}/${e.slice(5).replace(/\.ts$/, ".js")}`);
const r = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
