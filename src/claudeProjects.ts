import * as fs from "fs";
import * as path from "path";
import { normalizePath } from "./config";
import { TranscriptInfo } from "./types";

/**
 * Claude Code stores transcripts under `<claudeHome>/projects/<encoded cwd>/<sessionId>.jsonl`.
 * The encoding replaces every character that is not [A-Za-z0-9] with `-`
 * (`/Users/andy/src/app` → `-Users-andy-src-app`, `C:\src\app` → `C--src-app`).
 *
 * NOTE: verify against your installed Claude Code version — see SPEC.md "Open questions".
 */
export function encodeProjectDir(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

export function projectDirFor(claudeHome: string, cwd: string): string {
  return path.join(claudeHome, "projects", encodeProjectDir(cwd));
}

interface TranscriptLine {
  type?: string;
  cwd?: string;
  sessionId?: string;
  summary?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** List transcripts for a root (most recent first). Cheap: reads only the head of each file. */
export function listTranscripts(claudeHome: string, cwd: string, limit = 20): TranscriptInfo[] {
  const dir = projectDirFor(claudeHome, cwd);
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { p, f, st };
    })
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, limit);

  const out: TranscriptInfo[] = [];
  for (const { p, f, st } of files) {
    const head = readHead(p, 64 * 1024);
    const info = summarizeHead(head);
    out.push({
      sessionId: f.replace(/\.jsonl$/, ""),
      cwd: info.cwd ?? cwd,
      path: p,
      title: info.title ?? "(no prompt yet)",
      modifiedAt: st.mtimeMs,
      sizeBytes: st.size,
    });
  }
  return out;
}

export function readTranscriptTitle(transcriptPath: string): string | undefined {
  try {
    return summarizeHead(readHead(transcriptPath, 64 * 1024)).title;
  } catch {
    return undefined;
  }
}

/** Does the given transcript belong to this root? (cwd stored in the first lines) */
export function transcriptBelongsTo(transcriptPath: string, rootPath: string): boolean {
  try {
    const { cwd } = summarizeHead(readHead(transcriptPath, 16 * 1024));
    return !!cwd && normalizePath(cwd) === normalizePath(rootPath);
  } catch {
    return false;
  }
}

function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function summarizeHead(head: string): { title?: string; cwd?: string } {
  let title: string | undefined;
  let cwd: string | undefined;
  for (const raw of head.split("\n")) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue; // truncated last line
    }
    if (!cwd && line.cwd) cwd = line.cwd;
    if (line.type === "summary" && line.summary) {
      title = line.summary;
      break;
    }
    if (!title && line.type === "user" && line.message?.role === "user") {
      const text = extractText(line.message.content);
      if (text && !text.startsWith("<")) title = text;
    }
    if (title && cwd) break;
  }
  return { title: title ? compact(title) : undefined, cwd };
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const t = (part as { text?: string }).text;
        if (t) return t;
      }
    }
  }
  return undefined;
}

export function compact(s: string, max = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
