import * as fs from "fs";
import * as path from "path";
import { normalizePath } from "./paths";
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

/** cwd recorded in the first lines of a transcript. */
export function readTranscriptCwd(transcriptPath: string): string | undefined {
  try {
    return summarizeHead(readHead(transcriptPath, 16 * 1024)).cwd;
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
  // A summary line anywhere in the head beats the first prompt, so a prompt alone does not stop the scan.
  let summary: string | undefined;
  let prompt: string | undefined;
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
    if (!summary && line.type === "summary" && line.summary) summary = line.summary;
    if (!prompt && line.type === "user" && line.message?.role === "user") prompt = extractPrompt(line.message.content);
    if (summary && cwd) break;
  }
  const title = summary ?? prompt;
  return { title: title ? compact(title) : undefined, cwd };
}

/**
 * First text the user actually typed. Text starting with "<" is injected by Claude Code or
 * an integration (command caveats, `<browser_instruction>`, `<ide_selection>`) and can come
 * as an earlier part of the same message as the prompt.
 */
function extractPrompt(content: unknown): string | undefined {
  const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content.map(partText) : [];
  return parts.find((t): t is string => !!t?.trim() && !t.trimStart().startsWith("<"));
}

function partText(part: unknown): string | undefined {
  if (!part || typeof part !== "object" || (part as { type?: string }).type !== "text") return undefined;
  return (part as { text?: string }).text;
}

export function compact(s: string, max = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
