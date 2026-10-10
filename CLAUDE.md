# Workspace Agent Hub — project context for Claude Code

VS Code extension that gives one overview of all Claude Code sessions across several
isolated workspaces. Each agent only ever sees its own root (cwd); the hub never passes
`--add-dir` and never shares files between roots. Read `SPEC.md` for the product spec.

## Stack

- TypeScript, VS Code Extension API (`engines.vscode ^1.105`), bundled with esbuild → `dist/extension.js`
- No runtime dependencies. Node ≥ 20 on the dev machine (`hooks/hub-event.js` runs under the user's Node).
- `npm run build` (bundle), `npm run typecheck` (tsc), `npm test` (node:test via esbuild), `npm run watch`, F5 → Extension Development Host.

## Layout

| Path | Role |
|---|---|
| `src/extension.ts` | activation, command registration, wiring |
| `src/config.ts` | settings + root discovery (workspace folders ∪ `agentHub.roots`) |
| `src/sessionTracker.ts` | tails the NDJSON spool, session state machine (pure, no `vscode` import) |
| `src/paths.ts`, `src/emitter.ts` | vscode-free helpers so pure modules stay testable |
| `src/claudeProjects.ts` | reads `~/.claude/projects/<encoded cwd>/*.jsonl` transcripts |
| `src/launcher.ts` | spawns `claude` terminals with cwd = root |
| `src/hookInstaller.ts` | merges our hooks into `~/.claude/settings.json` (idempotent, with backup) |
| `src/workspaceTree.ts` | TreeDataProvider for the sidebar |
| `src/connectionTree.ts` | small health view (hooks / spool / transcripts) |
| `src/diagnostics.ts` | Markdown report that checks SPEC open questions on the user's machine |
| `src/rootEnv.ts` | per-root `env` / `envFile` for that root's terminals |
| `src/overviewPanel.ts` + `media/` | read-only webview overview |
| `src/statusBar.ts` | status bar counter |
| `hooks/hub-event.js` | the Claude Code hook: stdin JSON → one NDJSON line, exit 0 always |
| `test/*.test.ts` | unit tests (`npm test`); `scripts/test.mjs` bundles and runs them |

## Data flow

```
claude (any root) ──hooks──▶ ~/.claude/hub/events.ndjson ──tail──▶ SessionTracker ──▶ Tree / Overview / StatusBar
                  └─ transcripts ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl ──▶ resume list, titles
```

The hub is **read-only** towards Claude Code: it never blocks a hook, never edits transcripts,
and makes no API calls. All intelligence stays in Claude Code; the extension is a viewer + launcher.

## Conventions

- `SessionTracker` and `claudeProjects` must not import `vscode` (directly or via `config.ts`); `npm test` runs them under plain Node.
- The hook script must never throw, never print to stdout, and always `exit(0)`.
- Any assumption about Claude Code internals (project dir encoding, hook payload fields,
  transcript fields) goes into `SPEC.md › Open questions` with how to verify it.
- UI strings in English; comments in English. User-facing docs may be German.
- Commit messages: imperative, one line, optional body.

## Roadmap (work top-down, one feature per PR/commit)

1. [x] Scaffold: package.json contributions, tree, launcher, hooks, overview, status bar
2. [ ] Verify on a real machine: run *Agent Hub: Diagnose* (covers encoding, payload fields, `Notification` types, terminal revival) → fix `SPEC.md`
3. [x] Terminal ↔ session mapping robustness (`AGENT_HUB_TERMINAL` env is the primary key; fall back to cwd)
4. [–] ~~Chat mode~~ — dropped: the Claude Code chat always runs in the window's first folder (SPEC › Open questions 4)
5. [x] "Answer" action: focus terminal and, if the session waits for permission, show the pending question in the tree
6. [ ] Coordinator root: generated `CLAUDE.md` that reads the spool via a tiny MCP server or `cat` and nothing else
7. [ ] Context usage per session from transcript token counts (last `usage` block of the JSONL)
8. [x] Tests for `SessionTracker` (feed NDJSON fixtures) and `claudeProjects` (fixture transcripts)
9. [ ] Marketplace packaging (`vsce package`), icon, screenshots
