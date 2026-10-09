import * as vscode from "vscode";
import { SessionTracker } from "./sessionTracker";

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly sub: vscode.Disposable;

  constructor(private readonly tracker: SessionTracker) {
    this.item = vscode.window.createStatusBarItem("agentHub.status", vscode.StatusBarAlignment.Left, 50);
    this.item.name = "Agent Hub";
    this.item.command = "agentHub.showOverview";
    this.sub = tracker.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  update(): void {
    const c = this.tracker.counts();
    const parts = [`${c.working} working`];
    if (c.waiting) parts.push(`${c.waiting} waiting`);
    if (c.done) parts.push(`${c.done} done`);
    this.item.text = `$(hubot) ${parts.join(" · ")}`;
    this.item.tooltip = "Workspace Agent Hub — click for overview";
    this.item.backgroundColor = c.waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
