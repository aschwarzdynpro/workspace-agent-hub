import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { listTranscripts, WrittenFile, WrittenFilesIndex } from "./claudeProjects";
import { getConfig, getRoots, normalizePath } from "./config";
import { age, fileFolder, relTime, statusLabel } from "./format";
import { SessionTracker } from "./sessionTracker";
import { Root, Session, SessionStatus, TranscriptInfo } from "./types";

/** Transcript listings hit the disk; tree refreshes happen on every hook event. */
const TRANSCRIPT_CACHE_MS = 15_000;
/** Files listed under one session; older writes stay reachable through the Explorer. */
const MAX_FILES = 15;

export type Node = RootNode | SessionNode | DetailNode | TranscriptNode | FileNode;

export interface RootNode {
  kind: "root";
  root: Root;
}
export interface SessionNode {
  kind: "session";
  root: Root;
  session: Session;
}
export interface DetailNode {
  kind: "detail";
  text: string;
  icon?: string;
}
export interface TranscriptNode {
  kind: "transcript";
  root: Root;
  sessionId: string;
  title: string;
  modifiedAt: number;
  transcriptPath: string;
}
export interface FileNode {
  kind: "file";
  root: Root;
  path: string;
  at: number;
}

export class WorkspaceTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private roots: Root[] = [];
  private readonly transcriptCache = new Map<string, { at: number; list: TranscriptInfo[] }>();
  private readonly writtenFiles = new WrittenFilesIndex();

  constructor(private readonly tracker: SessionTracker) {
    this.reload();
  }

  reload(): void {
    this.roots = getRoots();
    this.transcriptCache.clear();
    this.tracker.setRoots(this.roots);
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getRoots(): Root[] {
    return this.roots;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "root":
        return this.rootItem(node.root);
      case "session":
        return this.sessionItem(node.root, node.session);
      case "detail": {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
        item.contextValue = "detail";
        return item;
      }
      case "transcript": {
        // Expands to the files the session wrote; resuming is the inline button, so a click
        // on the row does not start a terminal by accident.
        const item = new vscode.TreeItem(`${age(node.modifiedAt)} · ${node.title}`, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `transcript:${node.root.id}:${node.sessionId}`;
        item.iconPath = new vscode.ThemeIcon("history");
        item.contextValue = "transcript";
        item.tooltip = `${node.title}\nLast active ${relTime(node.modifiedAt)} · resume ${node.sessionId}`;
        return item;
      }
      case "file":
        return this.fileItem(node);
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.tracker.sortByAttention(this.roots).map((root) => ({ kind: "root", root }));
    if (node.kind === "root") {
      const live = this.tracker.forRoot(node.root.id).filter((s) => s.status !== "ended");
      const liveIds = new Set(live.map((s) => s.id));
      const children: Node[] = live.map((session) => ({ kind: "session", root: node.root, session }));
      if (node.root.kind !== "coordinator") {
        const recent = this.recentTranscripts(node.root).filter((t) => !liveIds.has(t.sessionId));
        for (const t of recent.slice(0, live.length ? 2 : 3)) {
          children.push({ kind: "transcript", root: node.root, sessionId: t.sessionId, title: t.title, modifiedAt: t.modifiedAt, transcriptPath: t.path });
        }
      }
      if (!children.length) children.push({ kind: "detail", text: "No sessions yet — click + to start one", icon: "info" });
      return children;
    }
    if (node.kind === "session") {
      const s = node.session;
      const out: Node[] = [];
      if (s.status === "waiting" && s.lastMessage) out.push({ kind: "detail", text: s.lastMessage, icon: "comment-discussion" });
      if (s.currentTool) out.push({ kind: "detail", text: `${s.currentTool}${s.currentToolHint ? " · " + s.currentToolHint : ""}`, icon: "tools" });
      out.push({ kind: "detail", text: `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${relTime(s.lastEventAt)} · ${s.id.slice(0, 8)}`, icon: "clock" });
      if (s.transcriptPath) out.push(...this.files(node.root, s.transcriptPath));
      return out;
    }
    if (node.kind === "transcript") {
      const files = this.files(node.root, node.transcriptPath);
      return files.length ? files : [{ kind: "detail", text: "No files written in this session", icon: "info" }];
    }
    return [];
  }

  /**
   * Existing files a session wrote: the root's own files first, then those outside it (memory,
   * plans), each newest first. Scratch files in the temp dir are helpers, not results.
   */
  private files(root: Root, transcriptPath: string): FileNode[] {
    let written: WrittenFile[] = [];
    try {
      written = this.writtenFiles.get(transcriptPath);
    } catch {
      written = [];
    }
    const tmp = normalizePath(os.tmpdir()) + path.sep;
    const inRoot = (f: WrittenFile) => normalizePath(f.path).startsWith(root.id + path.sep);
    const kept = written.filter((f) => !normalizePath(f.path).startsWith(tmp) && fs.existsSync(f.path));
    return [...kept.filter(inRoot), ...kept.filter((f) => !inRoot(f))]
      .slice(0, MAX_FILES)
      .map((f) => ({ kind: "file", root, path: f.path, at: f.at }));
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(node.path), vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(node.path);
    item.iconPath = vscode.ThemeIcon.File;
    item.description = fileFolder(node.path, node.root.path, os.homedir());
    item.tooltip = `${node.path}${node.at ? `\nWritten ${relTime(node.at)}` : ""}`;
    item.contextValue = isMarkdown(node.path) ? "file-md" : "file";
    item.command = { command: "agentHub.openFile", title: "Open", arguments: [node] };
    return item;
  }

  getParent(): Node | undefined {
    return undefined;
  }

  private recentTranscripts(root: Root): TranscriptInfo[] {
    const hit = this.transcriptCache.get(root.id);
    if (hit && Date.now() - hit.at < TRANSCRIPT_CACHE_MS) return hit.list;
    let list: TranscriptInfo[] = [];
    try {
      list = listTranscripts(getConfig().claudeHome, root.path, 5);
    } catch {
      list = [];
    }
    this.transcriptCache.set(root.id, { at: Date.now(), list });
    return list;
  }

  // ---- items -----------------------------------------------------------------

  private rootItem(root: Root): vscode.TreeItem {
    const sessions = this.tracker.forRoot(root.id).filter((s) => s.status !== "ended");
    const item = new vscode.TreeItem(root.name, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `root:${root.id}`;
    item.contextValue = "root";
    item.resourceUri = vscode.Uri.file(root.path);
    item.iconPath = new vscode.ThemeIcon(root.kind === "coordinator" ? "organization" : "folder");
    item.tooltip = `${root.path}\n${root.source === "workspace" ? "workspace folder" : "agentHub.roots"}`;
    const waiting = sessions.filter((s) => s.status === "waiting").length;
    const working = sessions.filter((s) => s.status === "working").length;
    item.description = waiting
      ? `${waiting} waiting · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`
      : working
        ? `${working} working`
        : sessions.length
          ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}`
          : "idle";
    return item;
  }

  private sessionItem(root: Root, s: Session): vscode.TreeItem {
    // Status first: VS Code truncates a row at its end, so a narrow sidebar cuts the title,
    // never the status. (Label highlights would render like search matches, so none.)
    const label = `${statusLabel(s)} · ${s.title || "(untitled session)"}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `session:${s.id}`;
    item.contextValue = `session-${s.status}`;
    item.iconPath = statusIcon(s.status);
    item.tooltip = new vscode.MarkdownString(
      [`**${s.title || s.id}**`, "", `Status: ${s.status}`, `cwd: \`${s.cwd}\``, s.lastMessage ? `\n> ${s.lastMessage}` : ""].join("\n")
    );
    item.command = { command: "agentHub.focusSession", title: "Open", arguments: [{ kind: "session", root, session: s }] };
    return item;
  }
}

export function isMarkdown(file: string): boolean {
  return /\.(md|markdown)$/i.test(file);
}

export function statusIcon(status: SessionStatus): vscode.ThemeIcon {
  switch (status) {
    case "working":
      return new vscode.ThemeIcon("sync~spin", new vscode.ThemeColor("charts.blue"));
    case "waiting":
      return new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.yellow"));
    case "done":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
    case "idle":
      return new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("disabledForeground"));
    case "ended":
      return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
  }
}
