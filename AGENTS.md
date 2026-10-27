# AGENTS.md

Instructions for coding agents working **on** hud. If you're here to **use** hud (create tickets, push monitor
readings), read `GUIDE.md` instead. Agents sharing a board fetch one coordination playbook
(`hud guide decentralized` or `hud guide lead`). The guide is served at `GET /api/guide` and by `hud guide`.

## What this is
hud is a local, live canvas of tickets, monitors, notes and frames, shared by a human (browser) and agents
(MCP, CLI, HTTP). It's a single Node process, with no runtime dependencies in the server and no build step for the source tree.
Node ≥ 23.6 runs the `.ts` files directly through type stripping. The UI is plain ES modules served as-is. A
separate Electron shell (`electron/`, `npm run dist`) wraps the same server and UI as a desktop app for macOS,
Windows and Linux; it bundles the sources with esbuild at build time only.

## Layout
```
src/types.ts     data model (Item, Board, Alert, MonitorResult, HudEvent). Start here.
src/store.ts     all state + mutations: create/update/remove(→trash)/push/ping, groups & organize, alerts, stale checks,
                 linked-ticket automation, persistence (data/state.json), backups, migrations (STATE_VERSION 10)
src/layout.ts    fixed 1600×900 board bounds and stable automatic card/group layout
src/lock.ts      single-writer lock (`<data>/hud.lock`, exclusive create, pid liveness)
src/engine.ts    runs automatic monitors: command (shell), http, probe (probes/*.ts, polled or watch()); heartbeat is
                 passive (store checks it)
src/monitoring.ts        metric validation, observation readouts, comparison evaluation and lint
src/attachments.ts       attachment bytes under <data>/attachments: confinement, hashing, atomic writes
src/diff.ts              bounded unified diff used by attachment expand
src/views.ts             generated view modules: templates, static validation, file writes
src/monitoring-server.ts dashboard, annotation, comparison, snapshot and custom-program routes
src/programs.ts          isolated custom-program document and action broker
src/render.ts            serialized Electron page and program/view capture
src/server.ts    HTTP routes, /ping/:id heartbeats, SSE stream (/api/events), static files, Host/Origin checks,
                 security headers + CSP, alert hook
src/mcp.ts       MCP stdio server (hand-written JSON-RPC) → HTTP client; also streams alerts into Claude Code
                 sessions as channel notifications
src/cli.ts       `hud` CLI → HTTP client
src/client.ts    the HTTP client (also the public TS API for external processes); autostarts the server
src/summary.ts   plain-text board overview used by `hud ls` / hud_overview
src/docs.ts      served guide text (`guideText`): relative links become URLs or in-page anchors
src/guide.ts     full guide and coordination playbooks served to the CLI, HTTP and MCP; `fullGuide` is `guideText`
src/config.ts    ROOT and env config (fixed port + per-user data dir; HUD_PORT/HUD_DATA/HUD_PROBES/HUD_VIEWS/HUD_URL need HUD_SCRATCH=1); packaged builds use per-user dirs
src/assets.ts    source-vs-packaged file access. `isPackaged()` (Electron), `asset()`, `assetKeys()`,
                 SOURCE_ROOT, isElectron/isElectronDev. The ONLY place that knows where files live
src/electron-runtime.ts  `cliInvocation()` / `bundledCli()` — how the app shell runs the CLI+server in node mode
src/cliinstall.ts  `hud cli install|uninstall|status` — the PATH shim the desktop app writes
src/mcpinstall.ts `hud mcp install|uninstall|status|print` — wires hud into other agents' MCP configs
src/updates.ts     stable GitHub release checks and safe replacement of the app's older packaged backend
electron/main.ts the desktop shell: window, tray, menu, single-instance lock, keep-server-on-quit
electron/settings.ts native Settings window, update and connection actions, and its narrow IPC boundary
electron/settings-preload.cjs the Settings-only, allowlisted context bridge
electron/render.mjs screenshot helper used by the packaged server
web/settings.html, settings.js, settings.css native desktop Settings interface (not the board renderer)
web/             index.html, app.js, views.js, utils.js, style.css, programs.js, program-preview.js, table-controls.js
views/           agent-authored chart renderers (display `view:<name>`), seeded into the data dir when packaged
probes/          built-in probes (tcp tls dns disk file-age) + examples (git process tail) + README
bin/hud.js       source CLI entry
scripts/build.mjs  esbuild bundles -> bundle/{hud,main}.mjs (npm run bundle); bundle/ and appdir/main.mjs are generated
scripts/dev.mjs    dev launcher: Electron against the repo, scratch port + scratch data dir
scripts/icons.mjs  generates build/icon.svg + icon.png, tray PNGs, web favicons from one geometry
scripts/adhoc-sign.mjs  electron-builder afterPack hook: ad-hoc signs unsigned macOS builds so downloads launch
scripts/check.mjs               JavaScript syntax checks and all pure regression suites (`npm test`)
scripts/check-packaged.mjs      packaged runtime smoke test using a temporary data dir and loopback port
scripts/check-layout.ts          fixed 1600×900 layout, UUID, persistence and migration checks
scripts/check-monitoring.ts      metric provenance/freshness, native views and dashboard transaction checks
scripts/check-monitoring-views.mjs semantic view selection, targets, events, tables, grids, pipelines and escaping
scripts/check-monitoring-api.mjs HTTP/CLI/MCP monitoring check against an existing scratch server
scripts/check-monitoring-ui.mjs headless monitoring dashboard, custom program and snapshot check
scripts/check-supervision.ts     store-level attention, reports, decisions, runs and changes regression checks
scripts/check-coordination.ts    presence, claim leases, queue, shared context and attachment metadata checks
scripts/check-context-timeline.mjs shared-context timeline labels, filters, handoff text and escaping
scripts/check-views.ts           generated view templates, static validation, writes and deletes
scripts/check-coordination-api.mjs HTTP/MCP/CLI coordination parity check against an existing scratch server
scripts/check-coordination-ui.mjs headless sessions, queue, claim and inspector checks
scripts/check-supervision-api.mjs HTTP/CLI/MCP supervision API check against an existing scratch server
scripts/check-supervision-ui.mjs headless browser supervision landing, navigation, report and sidebar checks
scripts/check-settings-ui.mjs    Electron Settings UI check with disposable board/client fixtures and screenshots
scripts/check-markdown.mjs       Markdown/plain-text rendering and escaping checks
appdir/          the packaged app dir: package.json (main.mjs is generated by the build; see the gotcha below)
GUIDE.md         end-user/agent usage guide (served by the app; keep it in sync with features)
PLAYBOOKS.md     coordination runbooks (decentralized, lead); `hud guide <name>`, `GET /api/guide?playbook=`
data/            runtime state, hud.pid, hud.lock, server.log and backups/. User data, never commit or delete it.
bundle/, dist/   build output (git-ignored)
```

## Architecture rules
- **The store is the only place state changes.** Every route, the engine and the MCP server go through `Store`
  methods, which emit `HudEvent`s. The server forwards events over SSE, and the UI and MCP alert stream react to them.
  Don't mutate items anywhere else.
- **Monitor readings go through `push()` / `update()` → `settle()` → `record()` → `afterReading()`.** That pipeline
  owns threshold evaluation, history and per-minute trend, state-change logging, alerts and linked-ticket sync.
  New reading-related behavior belongs there.
- **Frame membership is the stored `group` field** (the frame's title), never position. Untitled frames are the
  one exception: they hold whatever ungrouped item sits inside them. Use `membersOf()` (UI) or the group
  comparisons in `store.ts`. Don't infer membership with `contains()` alone.
- **Ticket structure is store state, not free text.** A `project` item owns the `KEY` that gives its tickets their
  `KEY-n` ident (`Store.ident`), and `parent` / `blockedBy` / `refs` are the edges between tickets. Every write goes
  through `Store.link()`, which validates board and rejects cycles *before* anything changes; `Store.resolveId()`
  lets any `:id` route accept an ident. `projectsView()` is the read model the list UI, `hud ls tickets`, `hud_tickets`
  and the CLI all share. Don't write these fields directly and don't infer links from titles.
- **Presence and claims are runtime-only.** `Store.liveSessions` and `Store.claims` are never persisted, exported or
  written on a heartbeat; a restart intentionally forgets them. Claim release is wired into every "became done"
  path (`update`, `finish`, `syncTickets`) plus trash, board clear/delete and reassign. A claim never changes status
  by itself; `start:true` goes through `update()`. Use the 409 `code` values (`claimed`, `one-claim`, `finished`,
  `assigned`, `blocked`) rather than adding status codes.
- **The shared context is append-only and out of item payloads.** Entries live in `state.context`, are never edited,
  and corrections are new entries with `corrects`. `lite()`, `/api/state` and item SSE events never carry them; they
  are fetched through `/api/context`. Cursors are runtime-only. Attachment bytes live under
  `<dataDir>/attachments`, never in `state.json`; `apply` runs in the CLI/MCP process, not the server.
- **Generated views are trusted code, not a sandbox.** `src/views.ts` static checks are advisory; the Electron render
  gate is the real check, and the module runs in the board page. `generate` may write its own output. Caller-supplied
  source (`hud_view` write / `hud view set`) is staged: the tool result shows a review diff, and the file lands only
  after `approve` of that proposal id and sha256. `hud_view` write does not stage a proposal when the full diff does
  not fit in the tool result. Keep the trust warning in every tool result and in `views/README.md`.
  Sandboxed `hud_graph`/`hud_canvas` remain the choice for untrusted UI.
- **`trend` is heavy.** `Store.lite()` strips it from SSE, `/api/state` and `/api/items` lists; keep it out of anything
  that is not a single-item read (`GET /api/items/:id`, which also adds `uptime`).
- **Files come from `assets.ts`.** Anything the app reads from its own tree (web/, views/, GUIDE.md, PLAYBOOKS.md, package.json, example
  probes) goes through `asset()` / `hasAsset()`, never a raw `join(ROOT, …)` — that is what lets the same code run from
  source and from the packaged app. Anything the *user* owns (data, probes) uses `config()`.
- **The MCP server is a thin client.** Logic belongs in the store/server so the CLI, HTTP and MCP stay equivalent.
  New caller-visible behavior follows Change surfaces, in order: route → client → MCP → CLI → GUIDE.
- **Persisted state is versioned** (`state.version`, currently 10: observation provenance, metric definitions, dashboards, custom programs, shared context and attachment metadata). If you change the meaning of stored
  data, add a migration in the `Store` constructor and bump `STATE_VERSION`. A state file newer than the code is refused,
  never rewritten. Users have live boards. Never write code that drops their data: deletes go to `state.trash`
  (`remove()` / `restore()` / `purge()`), and only purge is permanent.
- **Backups and the lock protect the board.** `Store.backup()` writes `<data>/backups/state-<ts>[-reason].json` on start
  (before migrations), before import/board delete and hourly (newest 30 kept); a corrupt `state.json` is moved to
  `.corrupt-<ts>` and the newest valid backup loaded. `src/lock.ts` makes a second server on the same data dir refuse to
  start. Keep both when touching persistence.
- **A failed save must never take the process down.** `Store.flush()` writes to a temp file unique per write
  (`<file>.<pid>.<n>.tmp`), logs and swallows failed renames, then retries on the next mutation. Keep temp names unique
  and never let persistence throw out of a timer.
- **Security:** the server binds to 127.0.0.1/::1 only and rejects foreign `Host`/`Origin` headers, because command
  monitors execute shell commands. Don't relax this, add CORS headers, or bind to other interfaces.
- **One binary, two modes.** The app executable is the GUI, and — under `ELECTRON_RUN_AS_NODE=1` — the CLI and MCP
  server too. Everything that spawns the server goes through `cliInvocation()`. Never hard-code a path to
  `src/server.ts` outside it, or the packaged app breaks.
- **Settings is a separate privileged surface.** Keep its IPC handler in `electron/settings.ts`, validate that calls
  come from the dedicated Settings window's main frame and URL, and expose only named operations through
  `electron/settings-preload.cjs`. The board renderer and sandboxed custom programs must never receive this bridge or
  generic IPC, app-command installation, client-configuration access, clipboard writes, external URL opening, or
  update actions.

## Change surfaces

New caller-visible behavior lands as one change across five surfaces, in this order:
route → client → MCP → CLI → GUIDE. Copy the checklist into the PR and fill every box with the
path or command added. An empty box means the feature is unfinished. These five are non-skippable.

- [ ] **Route.** `src/server.ts`: an HTTP route calls a `Store` method, validates the body, and passes
  `actorOf`. Item changes stay in the store.
- [ ] **Client.** `src/client.ts`: a `Hud` method is the only caller of that route. MCP and the CLI call
  this method.
- [ ] **MCP.** `src/mcp.ts`: a `hud_<verb>` entry in `TOOLS` and a `tools/call` case call that method.
- [ ] **CLI.** `src/cli.ts`: a `hud <verb>` line in `HELP`, a `CMDS` entry, and a dispatch `case` call
  the same method.
- [ ] **GUIDE.** `GUIDE.md`: the route, the `hud` command, and the `hud_` tool describe the same behavior
  (see "Ways in").

A read-only addition fills the same boxes. When the three clients must stay equivalent, extend the
matching `scripts/check-*-api.mjs` harness in the same PR.

### Example

Comments are the shape to copy. A new verb replaces `comment` in every row before the PR opens.

| Surface | Comments |
|---|---|
| Route | `POST /api/items/:id/comments` in `src/server.ts` calls `store.comment()` |
| Client | `Hud.comment()` in `src/client.ts` posts that route |
| MCP | `hud_comment` in `TOOLS` and `case 'hud_comment'` in `src/mcp.ts` call `hud.comment()` |
| CLI | `hud comment` in `HELP`, the `comment` entry in `CMDS`, and `case 'comment'` in `src/cli.ts` call `hud.comment()` |
| GUIDE | `GUIDE.md` "Ways in" lists `POST /api/items/:id/comments`, `hud comment`, and `hud_comment` |

## Conventions
- TypeScript under Node type stripping: use explicit `.ts` import extensions and `import type` for types. No enums,
  namespaces or parameter properties (`erasableSyntaxOnly` is on).
- Zero runtime dependencies in the server. Use Node built-ins (`node:http`, `fetch`, `child_process`). Ask before adding a package.
  The only build-time dependency is esbuild (bundling for the desktop app); `electron`/`electron-builder` are dev
  dependencies of the packaging step, not of the server.
- UI: vanilla JS, no framework or bundler. Visual language is a monochrome terminal style in a
  monospace font, with state shown by glyphs (● ▲ ✕ ○ ◐ ✓), inverse video and dashed borders. Exactly
  two semantic colours are allowed, and nothing else: **red** (`--red`) for a ticket that is blocked
  or awaiting a decision, and for a monitor in error; **green** (`--green`) for done/ok. Everything
  else stays black/white/gray. Colour never encodes anything a glyph doesn't also say. All colours
  are CSS variables in `web/style.css`.
- Match the surrounding code's density and naming. Keep comments short and only where the *why* isn't obvious.
- Actor attribution: every mutation takes an `actor` (`user` = browser, `hud` = system/engine, otherwise the agent
  or process name). Preserve it.

## Develop & verify
```sh
npm test                            # typecheck, JS syntax checks and pure regression suites
node scripts/check-packaged.mjs <outputdir> [arch] # smoke-test a prepared package in temporary data/port
```
Also verify changes against a **scratch instance**, never the user's live one:
```sh
export HUD_SCRATCH=1 HUD_PORT=7399 HUD_DATA=/tmp/hud-scratch
node bin/hud.js start
node bin/hud.js add ticket "test" --group G && node bin/hud.js ls
node bin/hud.js stop                                              # same env vars, or it stops the live server
```
With an already-running source scratch server on a non-7317 loopback port, the API harness exercises HTTP, CLI and MCP
without restarting or stopping it; pass its explicit URL, for example:
```sh
node scripts/check-coordination-api.mjs --url http://127.0.0.1:7411
node scripts/check-supervision-api.mjs --url http://127.0.0.1:7411
node scripts/check-monitoring-api.mjs --url http://127.0.0.1:7411 --render
```
For monitoring UI and custom-program rendering against that same existing scratch server, provide a writable artifact
directory; this harness does not start or stop a server:
```sh
./node_modules/.bin/electron scripts/check-monitoring-ui.mjs http://127.0.0.1:7411 /tmp/hud-monitoring-ui-check
./node_modules/.bin/electron scripts/check-coordination-ui.mjs http://127.0.0.1:7411 /tmp/hud-coordination-ui-check
```
For the native Settings UI, the Electron harness uses disposable board and client-configuration fixtures and writes
screenshots to the optional artifact directory. It does not install or modify the live app or connect to the user's
server:
```sh
./node_modules/.bin/electron scripts/check-settings-ui.mjs /tmp/hud-settings-ui-check
```
hud has **no test mode**: monitors are live whenever the server is up, so a scratch instance runs real
`command` monitors. Never copy the user's `data/state.json` into a scratch instance unless you mean to run
their ssh/cluster commands. For UI changes, also check rendering with the headless Electron harness below; syntax
checks cannot detect module-initialization or rendering failures.

**Pointer event contract:** `setPointerCapture` on `pointerdown` retargets the follow-up `click`/`dblclick` to the
capture element and breaks delegated canvas handlers. `capturePointer()` therefore captures only after a drag moves.
If a click handler does nothing, inspect the event target.

**A throw during module evaluation leaves a blank page**, which syntax checks cannot catch (for example, using a
missing `$('#id')` result). Load the page in a hidden Electron window and read the console:

```sh
mkdir -p /tmp/hudcheck && cat > /tmp/hudcheck/main.mjs <<'EOF'
import { app, BrowserWindow } from 'electron';
app.on('ready', async () => {
  const win = new BrowserWindow({ show: false });
  const errs = [];
  win.webContents.on('console-message', (e, _l, m) => errs.push(m));
  win.webContents.on('did-fail-load', (_e, c, d, u) => errs.push(`FAIL ${c} ${d} ${u}`));
  await win.loadURL(process.argv[2]).catch((e) => errs.push(e.message));
  await new Promise((r) => setTimeout(r, 2000));
  console.log(await win.webContents.executeJavaScript(
    `JSON.stringify({items:document.querySelectorAll('.item').length,conn:(document.getElementById('conn')||{}).textContent})`));
  console.log('ERRORS', errs);
  app.exit(0);
});
EOF
./node_modules/.bin/electron /tmp/hudcheck/main.mjs http://127.0.0.1:7317/    # assert conn === "● live"
```

MCP can be exercised by piping JSON-RPC lines into `node src/mcp.ts` (initialize → tools/list → tools/call)
with the same env vars.

### The desktop app
```sh
npm run dev     # Electron against this repo, scratch port 7399 + /tmp/hud-scratch
npm run pack    # unpacked app in dist/ — the quick "does it still package?" check
npm run dist    # installers (per-OS; each OS builds its own artifact)
```
`npm run dev` always uses a scratch port and data dir, so it can never touch the live board.
To exercise the packaged path without installing, run the built binary with `HUD_BIN_DIR` set and
`ELECTRON_RUN_AS_NODE=1 <binary> <resources>/hud/bin/hud.mjs <command>`.

The native GitHub Actions workflow `.github/workflows/build.yml` runs on pushes to `release/**` branches or manual
dispatch, and `v*` tag pushes. Branch/manual runs validate that `package.json`, `appdir/package.json` and both version
fields in `package-lock.json` agree, then run four native jobs for macOS arm64/x64, Windows x64 and Linux x64. Each job
runs `npm test`, builds unsigned installers, checks the packaged runtime, normalizes names and uploads seven-day
artifacts. A tag must also be a stable `vX.Y.Z` matching all package versions. Only after all four jobs pass, CI gathers
exactly five installers, validates their names and file signatures, writes `SHA256SUMS`, and creates a GitHub draft
release. A person must review and publish that draft; Settings ignores drafts and prereleases.

For a future release, keep v0.1.0 immutable, bump `package.json` and `appdir/package.json`, update `package-lock.json`,
push the matching `vX.Y.Z` tag, review the generated draft and publish it manually. Branch pushes and manual workflow
dispatch build temporary artifacts but do not create a release.

## Running & deploying
The runtime the user actually uses is the **packaged desktop app** (`dist/mac-arm64/hud.app` on macOS). It owns the
board: the app spawns its own bundled server (`…/hud.app/Contents/Resources/hud/bin/hud.mjs serve`, `mode: packaged`)
on **7317**, with data in the per-user dir (`~/Library/Application Support/hud`). Agents reach that same server on
7317; their MCP entries launch the source CLI, which is a thin HTTP client, so no second server is created.

**There must be exactly one server per data dir.** `hud.lock` now enforces it: a second server on the same data dir
prints `hud is already running for <dir> on port N (pid P)` and exits 1 (a dead pid's lock is taken over). Two servers on
*different* data dirs are still two boards, and the port decides which one the app and the CLI talk to. Check before
you start anything:

```sh
lsof -nP -iTCP:7317 -sTCP:LISTEN      # whatever answers here already owns the board
pgrep -fl "server.ts serve|hud.mjs serve"
```

Where the data comes from depends on how it is launched — the same command hits *different boards* depending on env:

| launch | port | data |
|---|---|---|
| packaged app | 7317 | `~/Library/Application Support/hud` (`%APPDATA%\hud`, `$XDG_DATA_HOME/hud`) |
| `node bin/hud.js …` from this repo | 7317 | same per-user dir as the app |
| `npm run dev` (Electron) | 7399 | `/tmp/hud-scratch` |

To ship a source change to the app you must **rebuild** — the bundle (`bundle/hud.mjs`) holds the server code, and
`web/`, `views/`, `probes/`, `GUIDE.md` are copied loose into `Resources/hud/`, so an un-rebuilt app serves stale UI and
stale server code. Use `npm run pack` for a local package check or `npm run dist` for installers, as above.

Then quit and relaunch the app. Confirm the change landed in the *packaged* copy, not just the working tree:

```sh
grep -c "<server change>" dist/mac-arm64/hud.app/Contents/Resources/hud/bin/hud.mjs      # server code
grep -c "<ui change>" dist/mac-arm64/hud.app/Contents/Resources/hud/web/app.js             # UI
find src web views probes GUIDE.md -newer dist/mac-arm64/hud.app/Contents/Resources/hud/bin/hud.mjs   # must be empty
```

Open browser tabs reload themselves when the server's pid changes, but running agent sessions keep their old MCP
process — new or changed MCP tools appear only after they reconnect (`/mcp` in Claude Code). Mention that to the user.

## Gotchas
- `hud stop` asks whatever answers at `HUD_URL` / `HUD_PORT` (default 7317) to shut down, so the **port is the
  selector**: set `HUD_SCRATCH=1`, `HUD_PORT` and `HUD_DATA` together (without HUD_SCRATCH they are ignored and you hit the live board). Only when nothing answers does it fall back to `$HUD_DATA/hud.pid`,
  and then it signals that pid only if it really is a hud server. A bare `hud stop` uses the default port and can stop
  the live board; to stop scratch use all scratch vars. When in doubt, check `lsof`/`pgrep`. `hud status`
  shows pid, port, data dir and mode without autostarting anything.
- Scratch instances: also set `HUD_PROBES` and `HUD_VIEWS`, or they serve and write the repo's `probes/` and `views/`.
- The app **reuses any server already answering on its port** (`ensureServer()` returns early when `/api/health`
  passes). A stray source server therefore becomes the app's backend silently: you get the source UI and the
  source data dir while believing you are testing the packaged app. Check `/api/health` → `mode` (`packaged` vs
  `source`) and `pid` when the app shows something unexpected.
- A reload against a dead server renders a **completely blank document**, not an error page. `electron/main.ts`
  handles `did-fail-load` by showing the unreachable page and then healing itself (respawn + reload). Startup alone
  goes through `connect()`; don't let a future edit drop the `did-fail-load` handler or Cmd+R goes black again.
- Probes are imported with a `?v=<mtime>` cache-buster. A `watch()` probe only restarts when its monitor's
  `source` changes.
- Explicitly reported monitor states (`error`, `done`, …) are never overridden by thresholds. Thresholds only judge
  plain readings.
- Alerts fire only when severity rises (to warn/error), on `done`, and on going stale. Recoveries don't alert.
- Claude Code channel servers must answer `initialize` with a protocol version ≤ 2025-06-18, which `mcp.ts` already
  does. Channels need the client launched with `--dangerously-load-development-channels server:hud`. That flag is
  ignored under `claude -p`, so test the alert stream through `hud_alerts` there.
- **electron-builder drops the app's `package.json`.** Its transformer returns `null` when the manifest needs no
  cleaning, and the file is then omitted from the app directory (the build fails with "package.json was not found").
  That is why `appdir/package.json` is injected into the app dir through `extraResources` (`to: app/package.json`)
  instead of being copied by the `files` filter. Don't "simplify" that away without re-testing `npm run pack`.
- `scripts/build.mjs` writes to `bundle/`; `build/` is electron-builder's `buildResources` (icons only; there is no entitlements file, builds are unsigned).
  They are deliberately separate — a bundler that cleans its own output dir must not delete the icons.
