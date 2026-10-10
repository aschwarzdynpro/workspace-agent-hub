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
  /** Where the session was started: `claude-vscode` (chat panel), `cli`, `sdk-cli`, … */
  entrypoint?: string;
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
      entrypoint: info.entrypoint,
      modifiedAt: st.mtimeMs,
      sizeBytes: st.size,
    });
  }
  return out;
}

export function readTranscriptTitle(transcriptPath: string): string | undefined {
  return readTranscriptSummary(transcriptPath).title;
}

/** Title and entrypoint of a transcript; empty when it cannot be read (yet). */
export function readTranscriptSummary(transcriptPath: string): TranscriptSummary {
  try {
    return summarizeTranscript(transcriptPath, fs.statSync(transcriptPath).size);
  } catch {
    return {};
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
  return readRangeBytes(file, start, bytes).toString("utf8");
}

interface TitleScan {
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  prompt?: string;
  cwd?: string;
  entrypoint?: string;
}

export interface TranscriptSummary {
  title?: string;
  cwd?: string;
  entrypoint?: string;
}

/**
 * Title precedence: `/rename` (custom-title) > Claude Code's generated ai-title > summary >
 * first real prompt. Both title records are appended again when they change, so the last one wins
 * and the tail of the file is scanned as well.
 */
function summarizeTranscript(file: string, size: number): TranscriptSummary {
  const scan: TitleScan = {};
  scanLines(readRange(file, 0, TITLE_SCAN_BYTES), scan);
  if (size > TITLE_SCAN_BYTES) scanLines(readRange(file, Math.max(TITLE_SCAN_BYTES, size - TITLE_SCAN_BYTES), TITLE_SCAN_BYTES), scan);
  return toSummary(scan);
}

function summarizeHead(head: string): TranscriptSummary {
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
    if (!scan.entrypoint && line.entrypoint) scan.entrypoint = line.entrypoint;
    if (line.type === "custom-title" && line.customTitle) scan.customTitle = line.customTitle;
    if (line.type === "ai-title" && line.aiTitle) scan.aiTitle = line.aiTitle;
    if (!scan.summary && line.type === "summary" && line.summary) scan.summary = line.summary;
    // isMeta marks text Claude Code injects as a user message (skill bodies, reminders).
    if (!scan.prompt && line.type === "user" && line.message?.role === "user" && !line.isMeta) {
      scan.prompt = extractPrompt(line.message.content);
    }
  }
}

function toSummary(scan: TitleScan): TranscriptSummary {
  const title = scan.customTitle ?? scan.aiTitle ?? scan.summary ?? scan.prompt;
  return { title: title ? compact(title) : undefined, cwd: scan.cwd, entrypoint: scan.entrypoint };
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

/** Tools whose input names a file they create or change, and the input field holding it. */
const WRITE_TOOLS = new Map([
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
]);

export interface WrittenFile {
  /** Absolute path as the tool call named it (resolved against the transcript cwd if relative). */
  path: string;
  /** Time of the last write in this transcript (ms). */
  at: number;
  tool: string;
}

interface IndexEntry {
  offset: number;
  cwd?: string;
  files: Map<string, WrittenFile>;
}

/**
 * Files a session created or changed, from the Write/Edit tool calls in its transcript.
 * Reads each transcript incrementally (only complete lines appended since the last call),
 * so a live session can be asked on every tree refresh. Files written via Bash are not seen.
 */
export class WrittenFilesIndex {
  private readonly entries = new Map<string, IndexEntry>();

  /** Most recently written first. Deleted files are included; callers filter as needed. */
  get(transcriptPath: string): WrittenFile[] {
    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      this.entries.delete(transcriptPath);
      return [];
    }
    let e = this.entries.get(transcriptPath);
    if (!e || size < e.offset) {
      e = { offset: 0, files: new Map() };
      this.entries.set(transcriptPath, e);
    }
    if (size > e.offset) {
      const buf = readRangeBytes(transcriptPath, e.offset, size - e.offset);
      // Stop at the last newline: a line still being written (or a split UTF-8 character)
      // is read completely next time.
      const end = buf.lastIndexOf(0x0a);
      if (end >= 0) {
        this.scan(e, buf.subarray(0, end).toString("utf8"));
        e.offset += end + 1;
      }
    }
    return [...e.files.values()].sort((a, b) => b.at - a.at);
  }

  private scan(e: IndexEntry, text: string): void {
    for (const raw of text.split("\n")) {
      if (!raw.includes('"tool_use"')) {
        if (!e.cwd && raw.includes('"cwd"')) e.cwd = parseLine(raw)?.cwd;
        continue;
      }
      const line = parseLine(raw);
      if (!line) continue;
      if (line.cwd) e.cwd = line.cwd;
      const content = line.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const p = part as { type?: string; name?: string; input?: Record<string, unknown> };
        const field = p?.type === "tool_use" && p.name ? WRITE_TOOLS.get(p.name) : undefined;
        const file = field ? p.input?.[field] : undefined;
        if (typeof file !== "string" || !file.trim()) continue;
        const abs = path.resolve(e.cwd ?? "", file);
        const key = normalizePath(abs);
        e.files.delete(key); // re-insert so the latest write wins on equal timestamps
        e.files.set(key, { path: abs, at: Date.parse(line.timestamp ?? "") || 0, tool: p.name! });
      }
    }
  }
}

function parseLine(raw: string): TranscriptLine | undefined {
  try {
    return JSON.parse(raw) as TranscriptLine;
  } catch {
    return undefined;
  }
}

function readRangeBytes(file: string, start: number, bytes: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, start);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
