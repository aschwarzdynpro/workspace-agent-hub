import * as os from "os";
import * as path from "path";

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Normalize a path so the same folder always yields the same id. */
export function normalizePath(p: string): string {
  let n = path.resolve(expandHome(p));
  if (process.platform === "win32") n = n.toLowerCase();
  return n.replace(/[\\/]+$/, "");
}
