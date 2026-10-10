# Workspace Agent Hub

One overview for all your [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions across
several isolated workspaces — inside VS Code, on your own Claude subscription.

- **One sidebar, many roots.** Every folder of your multi-root workspace (plus any extra path you add)
  is a root. Each root lists its running sessions with live status: *working · waiting for you · done · idle*.
- **Agents stay isolated.** A session is just `claude` started with `cwd = root`. No `--add-dir`,
  no shared context. The agent in `invia/` cannot see `waldmann/`.
- **Read-only, zero API cost.** Status comes from Claude Code hooks writing an NDJSON spool and
  from the transcripts under `~/.claude/projects`. The hub never calls a model.
- **Launcher.** New session, resume a previous one, jump to the terminal that is waiting for you.
- **Overview panel + status bar** for the "what needs me right now?" question.

## Requirements

- VS Code ≥ 1.105
- Claude Code CLI installed and logged in (`claude` on your PATH)
- Node ≥ 20 (the hook script runs under your Node)

## Getting started (development)

```bash
git clone https://github.com/aschwarzdynpro/workspace-agent-hub
cd workspace-agent-hub
npm install
npm run build
```

Open the folder in VS Code and press **F5** → an Extension Development Host starts.

1. Open a multi-root workspace there (or add roots via *Agent Hub: Add Workspace Root*).
2. Run *Agent Hub: Install Claude Code Hooks* once. This merges our hook into `~/.claude/settings.json`
   (a backup is written next to it).
3. Click **+** on a root → a terminal opens with `claude` in that folder. Status appears as soon as
   the first hook fires.

Sessions you start elsewhere (another terminal, the Claude Code chat panel) show up too, as long as
the hooks are installed — the hub then offers *Resume in new terminal* instead of focusing a terminal.

## Settings

See `SPEC.md` for the full table. The two you are most likely to touch:

```jsonc
"agentHub.roots": [
  {
    "name": "waldmann-crm",
    "path": "~/src/waldmann/crm",
    "envFile": ".env.agent",          // customer credentials, git-ignored, only in this root's terminals
    "extraArgs": ["--model", "opus"],
    "color": "terminal.ansiBlue"      // terminal tab color, tells customers apart at a glance
  },
  { "name": "invia", "path": "~/src/invia", "color": "terminal.ansiGreen" }
],
"agentHub.extraArgs": ["--permission-mode", "acceptEdits"]
```

Run *Agent Hub: Open All Roots in This Window* once and save the workspace: from then on a single
VS Code window holds every customer — Explorer, Git and Search across all roots, one Claude terminal
per root, and each agent still sees only its own folder.

## How it works

```
claude (any root) ──hooks──▶ ~/.claude/hub/events.ndjson ──tail──▶ extension ──▶ tree · overview · status bar
                  └─ transcripts ~/.claude/projects/<encoded cwd>/<id>.jsonl ──▶ resume list, titles
```

## Status

Early scaffold. Things to verify on a real machine are listed in `SPEC.md › Offene Punkte`.
Roadmap in `CLAUDE.md`.

## License

MIT
