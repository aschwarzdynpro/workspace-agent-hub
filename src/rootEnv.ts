import * as fs from "fs";
import * as path from "path";
import { expandHome } from "./paths";
import { Root } from "./types";

/**
 * Minimal dotenv parser: `KEY=value`, optional `export `, `#` comments, single/double quotes,
 * `\n` escapes inside double quotes. No variable expansion on purpose.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Environment for a root's terminals: `envFile` (relative to the root) first, then inline `env`.
 * Only ever applied to terminals of this root, so customer credentials never leak into another root.
 */
export function resolveRootEnv(root: Root): { env: Record<string, string>; error?: string } {
  let env: Record<string, string> = {};
  let error: string | undefined;
  if (root.envFile) {
    const file = path.resolve(root.path, expandHome(root.envFile));
    try {
      env = parseDotenv(fs.readFileSync(file, "utf8"));
    } catch (e) {
      error = `cannot read envFile ${file}: ${(e as Error).message}`;
    }
  }
  return { env: { ...env, ...(root.env ?? {}) }, error };
}
