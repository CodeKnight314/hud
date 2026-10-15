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

Agents get `hud_overview`, `hud_tickets`, `hud_create`, `hud_update`, `hud_push`, `hud_comment`, … (full list in
`GUIDE.md`, also served at `GET /api/guide` and by `hud guide`). The MCP server and CLI start the hud server on demand.
Anything with a shell can use the `hud` CLI or plain HTTP.

## Tickets (local Linear)
- A **project** owns a `KEY` (`EGO`) that gives its tickets idents (`EGO-3`) and git branch names. Anything that takes
  an id takes an ident.
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
uptime, and alerts. There are 19 views (number, progress, line, bar, pie, histogram, heatmap, 3-D, …), and `auto` picks
from the data shape; press `v` to cycle by hand, or write your own renderer in `views/`.

```sh
curl -fsS localhost:7317/ping/nightly-backup?period=86400      # heartbeat: no ping in period+grace is an error
hud add monitor "api" --source.kind http --source.url https://example.com/health --source.contains ok
hud push etl --progress 40 --message "batch 4/10"                # creates the monitor on first push
```
```ts
import { Hud } from './src/client.ts';
await new Hud({ actor: 'etl' }).push('etl', { progress: 40, message: 'batch 4/10' });
```
Notes are markdown with `- [ ]` checkboxes, frames are labelled regions that carry what is inside, utilities are
on-canvas tools (timer, calculator, sheet, …). Boards are separate canvases (the tabs at the top).

## CLI cheatsheet
```sh
hud ls [board] · hud ls tickets [--status s,s --assignee a --project KEY --tag t --overdue]
hud find <text> · hud show <id> · hud log <id>
hud add ticket "title" --project EGO --blockedBy EGO-2 · hud set <id> --status doing · hud link <id> parent=EGO-1
hud comment <id> <text> · hud ask <id> --option A --option B · hud decide <id> <optionId>
hud push <id> 42 · hud ping <id> [start|fail|<code>] · hud run <id> · hud finish
hud rm <id> · hud trash · hud restore <id> · hud purge <id>|--all
hud backup [--list] · hud export [file] · hud import <file> [--merge]
hud status · hud start|stop|open · hud guide
```
Every command takes `--help` and `--json`. Nothing is deleted outright: `rm` moves to the trash, state is backed up
hourly and before risky operations, and a corrupt state file is recovered from the newest backup.

## Keys
Press `?` in the app. In short: **double-click a card to expand it in place**, double-click empty space to add, drag to
pan, ⌘/ctrl+scroll to zoom, `t m n f w` to create (ticket, monitor, note, frame, widget), `⏎` to open the drawer, `l` for
the list view, `v` to cycle a monitor's view, `⌫` to delete, `u` or ⌘/ctrl+Z to undo, `:` for the command line, `a`
for the activity feed.

## Standalone app

A real desktop window (Electron), one build per OS, no Node install needed to run it. The app binary is also the CLI
and the MCP server, so `hud mcp install` and the CLI shim point at the same file.

```sh
npm install
npm run dev          # run the app from source on a scratch port + scratch data dir
npm run pack         # unpacked app in dist/ (fast smoke test)
npm run dist         # installers: .dmg, .exe (NSIS), .AppImage/.deb
npm run dist:mac     # or dist:win / dist:linux
```

Each OS builds its own artifact. A packaged app keeps its data under the per-user dir (`~/Library/Application Support/hud`
on macOS, `%APPDATA%\hud` on Windows, `~/.local/share/hud` elsewhere), seeds the example probes and views there on first
run, and closes to the tray with the server still up so agents keep working. `Help → Install "hud" command…` puts
`hud` on your PATH. There is no auto-updater: install a new build to update.

Builds are not signed or notarized (no Developer ID, no entitlements file). macOS Gatekeeper will warn on first launch;
right-click → Open, or sign the build yourself. Command monitors and the alert hook need a POSIX shell, so those are
macOS/Linux features; the `tail` and `process` probes are POSIX only too.

## Files
`src/server.ts` HTTP + SSE + static · `src/store.ts` state, persistence, backups, trash · `src/lock.ts` one server per
data dir · `src/engine.ts` monitor runner · `src/mcp.ts` MCP stdio server · `src/mcpinstall.ts` agent wiring ·
`src/cli.ts` CLI · `src/cliinstall.ts` the `hud` command shim · `src/client.ts` TS client · `src/summary.ts` text
overview · `src/types.ts` data model · `src/config.ts`, `src/assets.ts`, `src/electron-runtime.ts` paths and entry
points · `electron/main.ts` the desktop shell · `web/` UI (`app.js`, `views.js` charts, `utils.js`) · `views/` renderer
modules · `probes/` probe modules · `scripts/` build, dev and icon scripts · your data lives in the per-user dir (`~/Library/Application Support/hud` on macOS): `state.json`,
`backups/`, `server.log`.

Env: the port (7317) and data dir (per-user) are fixed: one board, one server. `HUD_PORT`, `HUD_DATA`,
`HUD_PROBES`, `HUD_VIEWS` and `HUD_URL` are ignored unless `HUD_SCRATCH=1` (throwaway test instances only). `HUD_ACTOR` (name shown on changes), `HUD_SESSION` (alert session name), `HUD_TIMEOUT` / `HUD_MCP_TIMEOUT` (ms), `HUD_ALERT_CMD` (shell hook; alert JSON on stdin), `HUD_BIN_DIR` (where
`hud cli install` writes), `HUD_TRAY=0` (no tray icon). Internal/dev: `HUD_SOURCE_ROOT`, `HUD_CLI_ENTRY`, `HUD_SHIM`,
`HUD_NO_LOGIN_SHELL`, `HUD_DEV_PORT`, `HUD_DEV_DATA`.

Security: binds to 127.0.0.1/::1 only, rejects foreign `Host`/`Origin` headers (command monitors run shell
commands, so no web page can reach the API), and sends a strict CSP.
