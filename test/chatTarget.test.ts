import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ChatContext, chatBlocker } from "../src/chatTarget";

const ok: ChatContext = {
  commandId: "claude-vscode.editor.open",
  extensionInstalled: true,
  firstFolder: { id: "/w/a", name: "a" },
  root: { id: "/w/a", name: "a" },
};

test("chat is allowed only for the window's first folder, with the extension and a command", () => {
  assert.equal(chatBlocker(ok), undefined);
  assert.match(chatBlocker({ ...ok, root: { id: "/w/b", name: "b" } })!, /first folder \(a\)/);
  assert.match(chatBlocker({ ...ok, firstFolder: undefined })!, /none open/);
  assert.match(chatBlocker({ ...ok, extensionInstalled: false })!, /not installed/);
  assert.match(chatBlocker({ ...ok, commandId: "" })!, /chatCommandId is empty/);
});

test("a root with its own env or envFile never runs in the chat", () => {
  assert.match(chatBlocker({ ...ok, root: { ...ok.root, env: { TENANT: "x" } } })!, /env/);
  assert.match(chatBlocker({ ...ok, root: { ...ok.root, envFile: ".env.agent" } })!, /envFile/);
  assert.equal(chatBlocker({ ...ok, root: { ...ok.root, env: {} } }), undefined);
});
