# Workspace Agent Hub — Spezifikation (Stufe 1)

## Ziel

Mehrere Kunden-/Projekt-Workspaces in **einem** VS-Code-Fenster überblicken, während jeder
Claude-Code-Agent ausschließlich seinen eigenen Workspace kennt. Das Tool ersetzt weder
Claude Code noch dessen Chat-Panel; es ist Launcher + Statusanzeige.

Nicht-Ziele (Stufe 1): eigenes Chat-UI, eigener Agent-Loop, API-Aufrufe, Fork von VS Code.

## Begriffe

- **Root**: ein Ordner, der als isolierter Arbeitsbereich für Claude dient. Quelle: die Ordner des
  geöffneten Multi-Root-Workspace (`.code-workspace`) plus `agentHub.roots` aus den Settings.
  `kind: coordinator` kennzeichnet einen Root ohne Code, der nur den Status-Spool liest.
- **Session**: eine Claude-Code-Session (Terminal oder Chat), identifiziert über `session_id`.
- **Spool**: `~/.claude/hub/events.ndjson`, von den Hooks beschrieben, von der Extension getailt.

## Isolation

- Sessions werden mit `cwd = Root` gestartet. Kein `--add-dir`, keine Symlinks, keine
  Workspace-weiten Settings, die Pfade anderer Roots enthalten.
- Der Koordinator-Root bekommt eine eigene `CLAUDE.md`, die nur den Spool und Zusammenfassungen
  kennt; Dateizugriff auf andere Roots ist dort nicht vorgesehen (Roadmap 6).
- Die Extension teilt keine Informationen *in* Sessions hinein; sie liest nur.

## Oberfläche

### Sidebar „Workspace Agent Hub"

- View „Workspaces": TreeView, ein Knoten pro Root (Name, Pfad als Tooltip, Badge: „2 waiting ·
  3 sessions"), darunter die laufenden Sessions (Titel = erster Prompt oder Transcript-Summary,
  Status-Icon, Beschreibung „working · Edit"), darunter Details (offene Frage, aktuelles Tool,
  Turns/Zeit). Pro Root zusätzlich die letzten Transkripte als „Resume"-Einträge.
- Inline-Aktionen: Root → New Session, Resume; Session → Terminal öffnen, Transkript öffnen.
- View „Connection": Hooks installiert?, Spool-Alter, Transkript-Verzeichnis, Launch-Mode.
- Welcome-Content ohne Roots: „Add Root", „Install Hooks".
- Badge am View-Container = Anzahl Sessions im Status `waiting`.

### Overview (Webview)

KPI-Zeile (working / waiting / done / idle), eine Karte pro Root mit Sessions, offener Frage
hervorgehoben, Buttons: Open, New session, Resume. Read-only, bekommt State per `postMessage`.

### Statusleiste

`$(hubot) 3 working · 1 waiting` links; gelb hinterlegt, sobald etwas wartet. Klick → nächste wartende
Session, wenn eine wartet, sonst Overview.

### „Was braucht mich?“

- `Agent Hub: Go to Next Session Waiting for Me` (`Ctrl+Alt+W` / `Cmd+Alt+W`, auch als Glocke im
  View-Titel): springt zur am längsten wartenden Session, jeder weitere Aufruf zur nächsten.
- Benachrichtigung „<Root>: <Frage>“ mit „Show“, sobald eine Session *live* auf `waiting` wechselt
  (nicht beim Replay nach dem Start). Immer, auch wenn das Terminal zuletzt aktiv war: VS Code kann
  nicht erkennen, ob ein Terminal wirklich fokussiert oder sichtbar ist. Abschaltbar über
  `agentHub.notifyWhenWaiting`.
- Mit Fokus im Terminal gehen Tastenkürzel von Extensions an die Shell. Beim ersten Sprung fragt der
  Hub einmal, ob er `agentHub.focusNextWaiting` in `terminal.integrated.commandsToSkipShell` eintragen darf.
- Tree: wartende Session zeigt „waiting for you · 3 min ago“ und darunter die offene Frage.

## Status-Maschine (pro Session)

| Hook-Event | Status | Zusatz |
|---|---|---|
| SessionStart | done | Titel aus Transkript laden |
| UserPromptSubmit | working | turns++, Titel beim ersten Prompt setzen |
| PreToolUse / PostToolUse | working | currentTool, currentToolHint |
| Notification | waiting | lastMessage (Frage/Permission); `idle_prompt`/`auth_success` ändern den Status nicht |
| Stop | done | currentTool löschen |
| SessionEnd | ended | wird aus dem Tree entfernt |
| keine Events seit `staleAfterMinutes` | idle | berechnet beim Lesen |
| Hub-Terminal geschlossen | ended | |
| `ended` oder 24 h ohne Events | — | beim nächsten Tick aus dem Speicher entfernt |

Beim Start werden nur die letzten 8 MB des Spools nachgespielt.

Sortierung in Tree und Overview: Roots nach ihrer dringendsten Session (waiting → working → done →
idle → keine), bei Gleichstand nach Name; Sessions innerhalb eines Roots ebenso, neueste zuerst.
Session-Zeilen im Tree beginnen mit dem kurzen Status („waiting 3m · <Titel>“,
„working · Edit · <Titel>“, „done 9m · <Titel>“): VS Code kürzt eine Zeile hinten, so bleibt der Status
auch in einer schmalen Sidebar sichtbar. Voller Titel im Tooltip. Resume-Einträge: „1d · <Titel>“.
`PostToolUse` löscht das aktuelle Tool; eine Permission-Frage zwischen Pre- und PostToolUse zeigt also
das Tool, um das es geht. Pfade im Overview: `~` für Home, lange Pfade als `…/<eltern>/<root>`.

## Ein Fenster

`Agent Hub: Open All Roots in This Window` fügt alle Roots als Workspace-Ordner ins aktuelle Fenster
ein und bietet „Save Workspace As…“ an. Explorer, Git und Suche decken danach alle Roots ab; die
Agenten bleiben trotzdem isoliert, weil jede Session nur ihr eigenes cwd kennt.

Pro Root (nur für dessen Terminals): `env`, `envFile` (Dotenv relativ zum Root, für Zugangsdaten
des Kunden), `extraArgs` (nach den globalen), `color` (Terminal-Tab-Farbe, z. B. `terminal.ansiBlue`).
Die `AGENT_HUB_*`-Variablen werden immer zuletzt gesetzt und können nicht überschrieben werden.
Ist das `envFile` nicht lesbar, startet das Terminal erst nach modaler Bestätigung („Launch Anyway“),
weil es sonst die Umgebung von VS Code erbt, die zu einem anderen Kunden gehören kann.

Wechselt das Fenster dabei in einen Multi-Root-Workspace, startet VS Code den Extension-Host neu;
das Angebot „Save Workspace As…“ wird deshalb in `globalState` gemerkt und nach dem Neustart gezeigt.

## Launch

- `launchMode: terminal` (Default): `vscode.window.createTerminal({ cwd: root.path, env })`,
  dann `claude [extraArgs] [--resume <id>]`. Die Env-Variablen `AGENT_HUB_TERMINAL` (UUID) und
  `AGENT_HUB_ROOT` werden vom Hook-Skript in jedes Event geschrieben → eindeutige Zuordnung
  Terminal ↔ Session, unabhängig von cwd-Wechseln. Nach einem Reload liest der Launcher die ID aus
  `creationOptions.env` der wiederhergestellten Terminals. Fallback für außerhalb des Hubs gestartete
  Sessions: das einzige offene Nicht-Hub-Terminal, dessen Name „claude“ enthält, mit cwd = Session-cwd;
  mehrdeutig → keins. Hub-Terminals matchen nie per cwd (nach `/exit` sind sie nur noch eine Shell).
- Resume einer Session, die noch in einem Hub-Terminal läuft, fokussiert dieses statt sie doppelt zu starten.
- `launchMode: chat`: ruft `agentHub.chatCommandId` der Anthropic-Extension auf; wenn leer oder
  Fehler → Terminal-Fallback mit Hinweis. Status-Tracking funktioniert für Chat-Sessions
  identisch, weil Hooks und Transkripte dieselben sind.

## Hooks

`agentHub.installHooks` mergt in `~/.claude/settings.json` (Backup `settings.json.agent-hub.bak`):

```json
"hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node \"<ext>/hooks/hub-event.js\"", "timeout": 5 }] }],
  "UserPromptSubmit": [ … ],
  "PreToolUse":       [{ "matcher": "", "hooks": [ … ] }],
  "PostToolUse":      [{ "matcher": "", "hooks": [ … ] }],
  "Notification":     [ … ],
  "Stop":             [ … ],
  "SessionEnd":       [ … ]
}
```

Das Skript liest stdin-JSON, schreibt eine NDJSON-Zeile, gibt nichts aus, Exit 0. Laufende
Sessions lesen Hooks erst nach Neustart.

## Settings

| Key | Default | Bedeutung |
|---|---|---|
| `agentHub.roots` | `[]` | Roots `{path, name?, kind?, env?, envFile?, extraArgs?, color?}`; ein Eintrag mit dem Pfad eines Workspace-Ordners ergänzt dessen Optionen |
| `agentHub.includeWorkspaceFolders` | `true` | Workspace-Ordner als Roots |
| `agentHub.launchMode` | `terminal` | `terminal` \| `chat` |
| `agentHub.claudeCommand` | `claude` | Executable |
| `agentHub.extraArgs` | `[]` | z. B. `["--model","opus"]` |
| `agentHub.chatCommandId` | `""` | Command-ID der Anthropic-Extension |
| `agentHub.spoolPath` | `~/.claude/hub/events.ndjson` | Spool |
| `agentHub.claudeHome` | `~/.claude` | Claude-Home |
| `agentHub.staleAfterMinutes` | `30` | Idle-Schwelle |
| `agentHub.notifyWhenWaiting` | `true` | Benachrichtigung, wenn eine Session auf dich wartet |

## Offene Punkte (auf dem echten Rechner verifizieren)

`Agent Hub: Diagnose` beantwortet 1, 2, 3 und 6 automatisch und öffnet einen Markdown-Bericht.
Der Hook schreibt dafür die *Namen* der Payload-Felder mit (`keys`), keine Inhalte.

1. **Projektverzeichnis-Encoding** in `~/.claude/projects/`: Annahme `[^A-Za-z0-9] → -`.
   Prüfen: `ls ~/.claude/projects` neben einem bekannten Pfad; ggf. `encodeProjectDir()` anpassen.
2. **Hook-Payload-Felder**: `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
   `tool_name`, `tool_input`, `message`, `notification_type`, `prompt`, `source`, `reason`.
   Prüfen: Spool nach einer kurzen Session ansehen; fehlende Felder im Skript ergänzen.
3. **Notification-Typen**: welche Werte kommen (`permission_prompt`, `idle_prompt`, …) und ob
   eine gestellte Frage (AskUserQuestion) als Notification oder nur via Transkript sichtbar ist.
4. **Chat-Command-IDs**: `cat ~/.vscode/extensions/anthropic.claude-code-*/package.json | jq
   '.contributes.commands'` → passende ID in `agentHub.chatCommandId`; prüfen, ob cwd/Resume-ID
   übergeben werden können.
5. **Windows**: Pfad-Quoting im Hook-Command (`node "C:\…\hub-event.js"`) und `fs.watch` auf
   NTFS; Polling-Fallback ist aktiv.
6. **Terminal-Wiederherstellung**: Behalten von VS Code nach einem Reload wiederbelebte Terminals
   `creationOptions.env.AGENT_HUB_TERMINAL`? Und zeigt `Terminal.name` für ein von Hand gestartetes
   `claude` „claude“ (Fallback-Zuordnung über cwd)? Prüfen: Hub-Session starten, Fenster neu laden,
   Session im Tree anklicken → muss das alte Terminal fokussieren.
7. **Kontextverbrauch**: aus dem letzten `usage`-Block im Transkript ableitbar (Roadmap 7).
