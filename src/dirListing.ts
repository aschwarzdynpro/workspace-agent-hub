import * as fs from "fs";
import * as path from "path";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface DirListing {
  entries: DirEntry[];
  /** Entries left out because of `max`. */
  more: number;
}

/**
 * One folder level for the tree: folders first, then files, each by name (case-insensitive,
 * numeric-aware so "wi/2049" sorts before "wi/2125"). Unreadable folders list as empty.
 */
export function listDir(dir: string, excluded: (name: string) => boolean, max = 500): DirListing {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { entries: [], more: 0 };
  }
  const entries = dirents
    .filter((d) => !excluded(d.name))
    .map((d) => {
      const p = path.join(dir, d.name);
      return { name: d.name, path: p, isDir: d.isDirectory() || (d.isSymbolicLink() && isDirTarget(p)) };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  return { entries: entries.slice(0, max), more: Math.max(0, entries.length - max) };
}

function isDirTarget(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Names hidden by a `files.exclude` setting. Only whole-name patterns (`**\/.git`, `.DS_Store`)
 * are honoured; patterns with further globs or paths would need a matcher and are ignored.
 */
export function excludedNames(filesExclude: Record<string, unknown> | undefined): (name: string) => boolean {
  const names = new Set<string>();
  for (const [pattern, on] of Object.entries(filesExclude ?? {})) {
    if (on !== true) continue;
    const name = pattern.replace(/^\*\*\//, "");
    if (!/[*?[\]{}/\\]/.test(name)) names.add(name);
  }
  return (name) => names.has(name);
}
