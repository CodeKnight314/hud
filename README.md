# hud

A local Linear plus monitoring, on a live canvas shared by you and any agent: **tickets** with projects, `KEY-n`
idents, sub-tickets and dependencies, and **monitors** that watch commands, HTTP endpoints, ports, certificates,
cron heartbeats and anything a probe can reach. Black and white, terminal-style. The server has no runtime
dependencies; Node ≥ 23.6 runs the TypeScript directly.

```
node bin/hud.js open        # start the server (if needed) and open http://localhost:7317
```

## Hook up agents

```sh
hud mcp install          # wire into claude + codex + opencode
hud mcp status           # show where hud is configured
hud mcp uninstall        # remove it again
hud mcp print generic    # snippet for any other client
```
From the repo, prefix with `node bin/hud.js`, or `npm link` to put `hud` on PATH. Each command only touches the `hud`
entry and backs the config up first. To have monitor alerts wake a Claude Code session, start it with
`claude --dangerously-load-development-channels server:hud`, then have the agent `hud_watch` the monitors it owns.

Agents can use the full MCP, CLI and HTTP surfaces. See [GUIDE.md](GUIDE.md), `hud guide`, `hud://guide` or
`GET /api/guide` for current tools, command syntax, schemas and examples. The MCP server and CLI start hud on demand.

The cross-board **Attention** landing collects decisions, blocked work, warnings, errors and stale monitors. **Runs**
shows each tagged run ticket with its explicit progress/ETA monitor and linked work; review is separate from alert
acknowledgement.

## Tickets (local Linear)
- A **project** owns a `KEY` (`EGO`) that gives its tickets idents (`EGO-3`) and git branch names. Tickets also have
  copyable immutable UUIDs; ticket references accept either form.
- `parent` makes sub-tickets, `blockedBy` is the dependency edge (a ticket waiting on open blockers blocks itself and
  clears itself), `refs` are loose links; cycles are rejected.
- Statuses `backlog todo doing review blocked done canceled`, priorities `low med high urgent` (case-insensitive,
  common aliases accepted). An agent that needs a human to choose proposes **decision options** on a ticket; the human
  clicks one on the card and the agent is woken with the answer (red = waiting, green = done).
- Read it as a canvas card, or press `l` for the list view; `hud ls tickets` prints the same on the command line.

## Monitors
Value, state, message, progress. Fed by hand, by pushes from outside processes, polled by hud via a shell `command`,
an `http` check or a TypeScript **probe** (built in: `tcp`, `tls`, `dns`, `disk`, `file-age`; examples: `git`,
`process`, `tail`), or reported by a cron job through a **heartbeat** URL. Thresholds, staleness, 24 h history with
uptime, and alerts. Built-in views cover scalar and progress readings, time series, distributions, categories, matrices,
structured tables and pipelines; `auto` picks from the data shape. Press `v` to cycle by hand, use an installed
`view:<name>` renderer, or preview a board-bound program.

Metrics can also carry a definition, scope, unit, source, observation time, evidence and coverage. Native displays
include composite, capacity, breakdown, table, grid and pipeline; chart targets and event markers add context to the
history. `hud_readout`, `hud_snapshot`, `hud_dashboard`, `hud_annotate`, `hud_compare` and `hud_lint` help agents inspect,
compose and verify a board. `hud_graph` and `hud_canvas` create isolated custom programs for a graph or a complete
surface. See [GUIDE.md](GUIDE.md) for the schemas and workflow, and [STYLE.md](STYLE.md) for the visual contract.

```sh
curl -fsS localhost:7317/ping/nightly-backup?period=86400      # heartbeat: no ping in period+grace is an error
hud add monitor "api" --source.kind http --source.url https://example.com/health --source.contains ok
hud push etl --progress 40 --message "batch 4/10"                # creates the monitor on first push
```
```ts
import { Hud } from './src/client.ts';
await new Hud({ actor: 'etl' }).push('etl', { progress: 40, message: 'batch 4/10' });
```
Notes are markdown with `- [ ]` checkboxes, frames are labelled regions that carry what is inside, and utilities are
on-canvas tools (timer, calculator, sheet, …). Boards are separate canvases. **Clear canvas** moves its items to Trash
while keeping the board and settings; **Delete board** removes the board, and `main` cannot be deleted.

## CLI cheatsheet
```sh
hud ls [board] · hud ls tickets [--status s,s --assignee a --project KEY --tag t --overdue]
hud find <text> · hud show <id> · hud log <id>
hud add ticket "title" --project EGO --blockedBy EGO-2 · hud set <id> --status doing · hud link <id> parent=EGO-1
hud comment <id> <text> · hud ask <id> --option A --option B · hud decide <id> <optionId> --version <decisionVersion>
hud push <id> 42 · hud ping <id> [start|fail|<code>] · hud run <id> · hud finish
hud readout [board] · hud snapshot [board] --format auto|png|text [--out path]
hud dashboard [board] --file <json> [--dry-run] · hud annotate <board> <epoch-ms> <text...>
hud compare <board> <left> <equal|lte|gte> <right> · hud lint [board]
hud graph <monitor> --action get|preview|apply|disable|delete --file <json> · hud canvas [board] --action get|preview|apply|disable|delete --code-file <path>
hud board clear <id> · hud board rm <id>
hud rm <id> · hud trash · hud restore <id> · hud purge <id>|--all
hud backup [--list] · hud export [file] · hud import <file> [--merge]
hud status · hud start|stop|open · hud guide
```
Every command takes `--help` and `--json`. Deletes move to Trash by default; `purge` is permanent. State is backed up
hourly and before risky operations, and a corrupt state file is recovered from the newest backup.

## Keys
Press `?` in the app. In short: **double-click a card to open scrollable details**, double-click empty space to add, drag to
pan, ⌘/ctrl+scroll to zoom, `t m n f w` to create (ticket, monitor, note, frame, widget), `⏎` to open the drawer, `l` for
the list view, `v` to cycle a monitor's view, `⌫` to delete, `u` or ⌘/ctrl+Z to undo, `:` for the command line, `a`
for the activity feed.

## Standalone app

A real desktop window (Electron), one build per OS, no Node install needed to run it. The app binary is also the CLI
and the MCP server, so `hud mcp install` and the CLI shim point at the same file.

Download the 0.1.0 installers from [GitHub Releases](https://github.com/CodeKnight314/hud/releases/tag/v0.1.0):
macOS arm64/x64 DMGs, Windows x64 installer, or Linux x64 AppImage/deb. These releases are unsigned and may prompt
an operating-system warning on first launch.

```sh
npm install
npm run dev          # run the app from source on a scratch port + scratch data dir
npm run pack         # unpacked app in dist/ (fast smoke test)
npm run dist         # installers: .dmg, .exe (NSIS), .AppImage/.deb
npm run dist:mac     # or dist:win / dist:linux
```

Each OS builds its own artifact. A packaged app keeps its data under the per-user dir (`~/Library/Application Support/hud`
on macOS, `%APPDATA%\hud` on Windows, `~/.local/share/hud` elsewhere), seeds the example probes and views there on first
run, and closes to the tray with the server still up so agents keep working. Open native Settings with ⌘, on macOS,
File → Settings (Ctrl+,) on Windows/Linux, or Settings from the tray menu. Connections can register detected Claude Code,
Codex and OpenCode clients; restart existing client sessions after a change. The status shows saved registration, not
whether a client session is live. Other clients can use **Copy MCP configuration**. Settings also installs or repairs
the app-managed `hud` command; this requires the packaged app, and Linux AppImage builds do not support that command
integration (use the `.deb`). OpenCode JSONC files are left untouched and get copy/manual setup instructions.

Settings → Updates checks GitHub for the latest stable release and opens the matching installer for this OS and
architecture; download and replace the app manually. There is no automatic install. The 0.1.1 build adds this checker;
version 0.1.0 has none, so upgrading from it the first time must be manual. The check-on-launch preference controls
whether later app launches check too.
Native CI runs on `release/**` branch pushes and manual dispatches; these builds upload seven-day artifacts. Pushing a
stable `vX.Y.Z` tag also validates the package versions, builds and checks all four native jobs, validates the five
installers plus `SHA256SUMS`, then creates a GitHub draft release. Publishing that draft is manual, and the update
checker ignores drafts. Keep the existing v0.1.0 release unchanged; see [GUIDE.md](GUIDE.md) for the next-release steps.

On startup, an updated app backs up the saved board and replaces only its own older packaged server using the same
per-user data directory. It refuses to replace another/source/newer server or continue if the old server reports a save
error. The app refreshes its managed command shim on launch so client registrations keep working across normal app
replacement.

Builds are not Developer ID signed or notarized. macOS Gatekeeper may warn on first launch; right-click → Open, or sign
the build yourself. Command monitors and the alert hook need a POSIX shell, so those are
macOS/Linux features; the `tail` and `process` probes are POSIX only too.

For the source layout and development conventions, see [AGENTS.md](AGENTS.md). Your board and backups live in hud's
per-user data directory.

Env: the port (7317) and data dir (per-user) are fixed: one board, one server. `HUD_PORT`, `HUD_DATA`,
`HUD_PROBES`, `HUD_VIEWS` and `HUD_URL` are ignored unless `HUD_SCRATCH=1` (throwaway test instances only). `HUD_ACTOR` (name shown on changes), `HUD_SESSION` (alert session name), `HUD_TIMEOUT` / `HUD_MCP_TIMEOUT` (ms), `HUD_ALERT_CMD` (shell hook; alert JSON on stdin), `HUD_BIN_DIR` (where
`hud cli install` writes), `HUD_TRAY=0` (no tray icon). Internal/dev: `HUD_SOURCE_ROOT`, `HUD_CLI_ENTRY`, `HUD_SHIM`,
`HUD_NO_LOGIN_SHELL`, `HUD_DEV_PORT`, `HUD_DEV_DATA`.

Security: binds to 127.0.0.1/::1 only, rejects foreign `Host`/`Origin` headers (command monitors run shell
commands, so no web page can reach the API), and sends a strict CSP.
