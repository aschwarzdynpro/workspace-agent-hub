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
  customTitle?: string;
  aiTitle?: string;
  isMeta?: boolean;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Bytes read from each end of a transcript; title records sit near the start or are appended. */
const TITLE_SCAN_BYTES = 64 * 1024;

/** List transcripts for a root (most recent first). Cheap: reads only the head and tail of each file. */
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
    const info = summarizeTranscript(p, st.size);
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
    return summarizeTranscript(transcriptPath, fs.statSync(transcriptPath).size).title;
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
  return readRange(file, 0, bytes);
}

function readRange(file: string, start: number, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

interface TitleScan {
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  prompt?: string;
  cwd?: string;
}

/**
 * Title precedence: `/rename` (custom-title) > Claude Code's generated ai-title > summary >
 * first real prompt. Both title records are appended again when they change, so the last one wins
 * and the tail of the file is scanned as well.
 */
function summarizeTranscript(file: string, size: number): { title?: string; cwd?: string } {
  const scan: TitleScan = {};
  scanLines(readRange(file, 0, TITLE_SCAN_BYTES), scan);
  if (size > TITLE_SCAN_BYTES) scanLines(readRange(file, Math.max(TITLE_SCAN_BYTES, size - TITLE_SCAN_BYTES), TITLE_SCAN_BYTES), scan);
  return toSummary(scan);
}

function summarizeHead(head: string): { title?: string; cwd?: string } {
  const scan: TitleScan = {};
  scanLines(head, scan);
  return toSummary(scan);
}

function scanLines(text: string, scan: TitleScan): void {
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue; // line cut off at either end of the scanned range
    }
    if (!scan.cwd && line.cwd) scan.cwd = line.cwd;
    if (line.type === "custom-title" && line.customTitle) scan.customTitle = line.customTitle;
    if (line.type === "ai-title" && line.aiTitle) scan.aiTitle = line.aiTitle;
    if (!scan.summary && line.type === "summary" && line.summary) scan.summary = line.summary;
    // isMeta marks text Claude Code injects as a user message (skill bodies, reminders).
    if (!scan.prompt && line.type === "user" && line.message?.role === "user" && !line.isMeta) {
      scan.prompt = extractPrompt(line.message.content);
    }
  }
}

function toSummary(scan: TitleScan): { title?: string; cwd?: string } {
  const title = scan.customTitle ?? scan.aiTitle ?? scan.summary ?? scan.prompt;
  return { title: title ? compact(title) : undefined, cwd: scan.cwd };
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
