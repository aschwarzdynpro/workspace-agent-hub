import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizePath } from "../src/paths";
import { SessionTracker } from "../src/sessionTracker";
import { Root } from "../src/types";

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-test-"));
}

/** Root ids are normalized like config.getRoots() does (lower-case on Windows). */
export function root(p: string, name = path.basename(p)): Root {
  return { id: normalizePath(p), name, path: p, kind: "repo", source: "settings" };
}

/** The id a root at this path gets, for comparing with Session.rootId. */
export const id = normalizePath;

export interface Harness {
  spool: string;
  tracker: SessionTracker;
  logs: string[];
  /** Append events (ts defaults to now, cwd to the first root) and read them synchronously. */
  emit(...events: Record<string, unknown>[]): void;
}

export function harness(roots: string[], staleAfterMs = 30 * 60_000): Harness {
  const dir = tmpDir();
  const spool = path.join(dir, "events.ndjson");
  const logs: string[] = [];
  const tracker = new SessionTracker({ appendLine: (l) => logs.push(l) }, () => ({ spoolPath: spool, staleAfterMs }));
  tracker.setRoots(roots.map((r) => root(r)));
  tracker.start();
  tracker.stop(); // tests drive reads explicitly; no watcher/poll timers keeping Node alive
  return {
    spool,
    tracker,
    logs,
    emit(...events) {
      const text = events.map((e) => JSON.stringify(line(e, roots[0]))).join("\n") + "\n";
      fs.appendFileSync(spool, text);
      (tracker as unknown as { readNew(): void }).readNew();
    },
  };
}

export function line(e: Record<string, unknown>, cwd: string): Record<string, unknown> {
  return { ts: new Date().toISOString(), cwd, ...e };
}

export function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}
