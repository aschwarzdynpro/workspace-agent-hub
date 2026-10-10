import * as fs from "fs";
import * as path from "path";
import { encodeProjectDir, listTranscripts, readTranscriptCwd } from "./claudeProjects";
import { Root, SpoolEvent } from "./types";

export interface DiagnosticsInput {
  claudeHome: string;
  spoolPath: string;
  roots: Root[];
  hooksInstalled: boolean;
  /** Collected by the extension; this module stays free of `vscode`. */
  terminals: { name: string; hubId?: string }[];
  platform?: string;
  extensionVersion?: string;
}

const SPOOL_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Markdown report that answers SPEC.md › open questions on the user's machine:
 * project-dir encoding, hook payload fields, notification types, terminal revival.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines);

  add(
    "# Agent Hub diagnostics",
    "",
    "> Contains local paths and notification texts (no prompts). Review before sharing.",
    "",
    "## Environment",
    "",
    `- Platform: \`${input.platform ?? process.platform}\`, Node \`${process.version}\`${input.extensionVersion ? `, extension \`${input.extensionVersion}\`` : ""}`,
    `- Claude home: \`${input.claudeHome}\``,
    `- Hooks installed: ${input.hooksInstalled ? "yes" : "**no**"}`,
    ""
  );

  // ---- 1. project dir encoding ------------------------------------------------
  add("## 1. Project directory encoding", "");
  const projects = path.join(input.claudeHome, "projects");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projects).filter((d) => fs.statSync(path.join(projects, d)).isDirectory());
  } catch {
    add(`No \`${projects}\` directory.`, "");
  }
  if (dirs.length) {
    let ok = 0;
    let unknown = 0;
    const mismatches: string[] = [];
    for (const d of dirs) {
      const cwd = newestTranscriptCwd(path.join(projects, d));
      if (!cwd) {
        unknown++;
        continue;
      }
      const expected = encodeProjectDir(cwd);
      // NTFS is case-insensitive: Claude Code keeps the drive letter as VS Code passes it (c: or C:).
      const same = (input.platform ?? process.platform) === "win32" ? expected.toLowerCase() === d.toLowerCase() : expected === d;
      if (same) ok++;
      else mismatches.push(`| \`${cwd}\` | \`${d}\` | \`${expected}\` |`);
    }
    add(`${dirs.length} project dirs: **${ok} match** \`encodeProjectDir()\`, **${mismatches.length} mismatch**, ${unknown} without a readable cwd.`, "");
    if (mismatches.length) {
      add("| cwd in transcript | actual dir | our encoding |", "|---|---|---|", ...mismatches.slice(0, 15), "");
    }
  }

  // ---- roots -------------------------------------------------------------------
  add("## Roots", "", "| Root | Path | Project dir exists | Transcripts |", "|---|---|---|---|");
  for (const r of input.roots) {
    const dir = path.join(projects, encodeProjectDir(r.path));
    const exists = fs.existsSync(dir);
    const count = exists ? listTranscripts(input.claudeHome, r.path, 1000).length : 0;
    add(`| ${r.name}${r.kind === "coordinator" ? " (coordinator)" : ""} | \`${r.path}\` | ${exists ? "yes" : "no"} | ${count} |`);
  }
  add("");

  // ---- 2./3. hook payload + notification types --------------------------------------
  add("## 2. Hook payloads (spool)", "");
  const events = readSpoolTail(input.spoolPath);
  if (!events.length) {
    add(`No events in \`${input.spoolPath}\` yet. Start a session, send one prompt, then run Diagnose again.`, "");
  } else {
    add(`Last ${events.length} events from \`${input.spoolPath}\`.`, "", "| Event | Count | Payload fields seen |", "|---|---|---|");
    const byEvent = new Map<string, { count: number; keys: Set<string>; withKeys: number }>();
    for (const e of events) {
      const b = byEvent.get(e.event) ?? { count: 0, keys: new Set<string>(), withKeys: 0 };
      b.count++;
      if (Array.isArray(e.keys)) {
        b.withKeys++;
        for (const k of e.keys) b.keys.add(k);
      }
      byEvent.set(e.event, b);
    }
    let anyKeys = false;
    for (const [ev, b] of [...byEvent].sort((x, y) => y[1].count - x[1].count)) {
      anyKeys ||= b.withKeys > 0;
      add(`| ${ev} | ${b.count} | ${b.withKeys ? [...b.keys].sort().map((k) => `\`${k}\``).join(" ") : "–"} |`);
    }
    add("");
    if (!anyKeys) add("_No field names recorded: the hook predates this check. Run **Install Claude Code Hooks** again and restart your sessions._", "");

    add("## 3. Notification types", "");
    const notes = events.filter((e) => e.event === "Notification");
    if (!notes.length) add("No Notification events yet. Trigger a permission prompt (e.g. ask for a Bash command) and wait a minute after a reply.", "");
    else {
      add("| notification_type | Count | Sample messages |", "|---|---|---|");
      const byType = new Map<string, string[]>();
      for (const n of notes) {
        const t = n.notification_type ?? "(none)";
        const list = byType.get(t) ?? [];
        list.push(n.message ?? "");
        byType.set(t, list);
      }
      for (const [t, msgs] of byType) {
        const samples = [...new Set(msgs)].slice(0, 2).map((m) => `“${cell(m)}”`).join("<br>");
        add(`| \`${t}\` | ${msgs.length} | ${samples} |`);
      }
      add("");
    }
    const withTerminal = new Set(events.filter((e) => e.terminal).map((e) => e.session_id)).size;
    const sessions = new Set(events.map((e) => e.session_id)).size;
    add(`Sessions in this window of the spool: ${sessions}, of which ${withTerminal} started from a hub terminal.`, "");
  }

  // ---- 6. terminals ----------------------------------------------------------------
  add("## 6. Terminals in this window", "", "| Terminal | Hub id from creationOptions.env |", "|---|---|");
  for (const t of input.terminals) add(`| ${cell(t.name)} | ${t.hubId ? `\`${t.hubId.slice(0, 8)}…\`` : "–"} |`);
  if (!input.terminals.length) add("| (none) | |");
  add(
    "",
    "_To check revival: start a hub session, run **Developer: Reload Window**, run Diagnose again — the terminal should still show a hub id._"
  );
  return out.join("\n") + "\n";
}

function newestTranscriptCwd(dir: string): string | undefined {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files.slice(0, 3)) {
      const cwd = readTranscriptCwd(f);
      if (cwd) return cwd;
    }
  } catch {
    // unreadable dir: reported as "without a readable cwd"
  }
  return undefined;
}

function readSpoolTail(spool: string): SpoolEvent[] {
  let text: string;
  try {
    const st = fs.statSync(spool);
    const start = Math.max(0, st.size - SPOOL_TAIL_BYTES);
    const fd = fs.openSync(spool, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return [];
  }
  const out: SpoolEvent[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as SpoolEvent);
    } catch {
      // partial line
    }
  }
  return out;
}

function cell(s: string): string {
  const one = s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return one.length > 120 ? one.slice(0, 119) + "…" : one;
}
