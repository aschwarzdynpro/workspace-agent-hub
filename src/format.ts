import * as path from "path";
import { Session } from "./types";

/** "just now", "3 min ago", "2 h ago", "4 d ago" */
export function relTime(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return `${Math.round(d / 86_400_000)} d ago`;
}

/** Compact age for narrow places: "now", "3m", "2h", "4d". */
export function age(ms: number, now = Date.now()): string {
  const d = now - ms;
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}

/**
 * Short status that prefixes a session row in the tree. VS Code truncates a row at its end,
 * so the status goes first and has to stay short enough to survive a narrow sidebar.
 */
export function statusLabel(s: Session, now = Date.now()): string {
  switch (s.status) {
    case "working":
      return s.currentTool ? `working · ${s.currentTool}` : "working";
    case "waiting":
      return `waiting ${age(s.waitingSince ?? s.lastEventAt, now)}`;
    case "done":
      return `done ${age(s.lastEventAt, now)}`;
    case "idle":
      return `idle ${age(s.lastEventAt, now)}`;
    case "ended":
      return "ended";
  }
}

/**
 * Path for display: home becomes `~`, and long paths keep only their last two segments
 * (`…/kunden/waldmann-crm`). The full path stays available as a tooltip.
 */
export function displayPath(p: string, home: string, max = 48): string {
  let out = p;
  if (home && (p === home || p.startsWith(home + path.sep))) out = "~" + p.slice(home.length);
  if (out.length <= max) return out;
  const parts = out.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? `…${path.sep}${parts.slice(-2).join(path.sep)}` : out;
}

/** Folder of a file for a tree description: relative to the root ("" directly in it), else shortened absolute. */
export function fileFolder(file: string, rootPath: string, home: string): string {
  const dir = path.dirname(file);
  const rel = path.relative(rootPath, dir);
  if (!rel) return "";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return displayPath(dir, home);
}
