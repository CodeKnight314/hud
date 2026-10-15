# hud — agent guide

hud is a local, live canvas shared between a human and agents. It holds **tickets**, **monitors**,
**notes** and **frames** on one or more **boards**. Everything you change appears instantly in the
human's browser at http://localhost:{{PORT}} and vice versa. The human rearranges things too, so
re-read state (`hud ls` / `hud_overview`) before assuming positions or statuses.

## Ways in (all equivalent)
- **MCP**: tools `hud_overview`, `hud_tickets`, `hud_search`, `hud_project`, `hud_link`, `hud_create`, `hud_update`,
  `hud_push`, `hud_comment`, `hud_get`, `hud_delete`, `hud_trash`, `hud_backup`, `hud_board`, `hud_organize`,
  `hud_arrange`, `hud_run`, `hud_views`, `hud_watch`, `hud_alerts`, `hud_ask`, `hud_decide`, `hud_finish`, `hud_guide`.
  Times in tool output are in the machine's local time zone. `source.kind: "command"` runs a shell command on the
  user's machine, so only set it for checks the user would run themselves.
- **CLI**: `hud ls`, `hud add`, `hud set`, `hud push`, `hud comment`, `hud ask`, `hud decide`, `hud finish`, … (`hud help`;
  every command takes `--help`, and `--json` prints machine-readable output). If `hud` is not on PATH use
  `node <repo>/bin/hud.js`. Set `HUD_ACTOR=<your-name>` (or `--as`) so changes are attributed to you.
- **HTTP** (JSON, localhost only; send header `x-hud-actor: <name>`). Malformed input is a 400, an unknown id or board
  a 404; ids may be a `KEY-12` ident.
  - read: `GET /api/summary[?board=]` text overview · `GET /api/state` · `GET /api/events` SSE · `GET /api/projects` ·
    `GET /api/tickets[?format=text]` · `GET /api/items` · `GET /api/items/:id` (includes `trend` and `uptime`) ·
    `GET /api/items/:id/activity[?limit=]` · `GET /api/activity[?limit=&board=]` · `GET /api/views` · `GET /api/guide`
  - search filters, on `GET /api/items` and `GET /api/tickets`: `board type status` (comma list) `priority assignee
    project tag q overdue=1 parent limit`. An unknown board is a 404.
  - write: `POST /api/items` (one or an array) · `PATCH /api/items/:id` · `PATCH /api/items` (array of `{id,...}`) ·
    `DELETE /api/items/:id` (to the trash) · `POST /api/items/:id/link {project?,parent?,blockedBy?,refs?,branch?}` ·
    `POST /api/items/:id/unlink {fields?}` · `POST /api/items/:id/comments {text}` ·
    `PATCH|DELETE /api/items/:id/comments/:cid`
  - monitors: `POST /api/monitors/:id/push {value,state,message,progress,...}` · `POST /api/monitors/:id/run` ·
    heartbeat **`/ping/:id`** (see Monitors)
  - decisions and runs: `POST /api/items/:id/ask {question?,options}` · `POST /api/items/:id/decide {optionId,note?}` ·
    `POST /api/finish {board?,ids?,note?,organize?}`
  - boards: `GET/POST /api/boards` · `PATCH|DELETE /api/boards/:id` (`main` cannot be deleted; a delete goes to the
    trash) · `POST /api/organize {board, auto?}` · `POST /api/arrange {board|frame, ids?, width?}`
  - alerts: `GET /api/alerts[?all=1&notify=name&since=]` · `POST /api/alerts/ack {ids?}` · `POST /api/watch {name, ids?, boards?, off?}`
  - safety net: `GET /api/trash[?board=]` · `POST /api/trash/:id/restore` · `DELETE /api/trash/:id` and `DELETE /api/trash`
    (permanent) · `GET|POST /api/backups` · `GET /api/export` · `POST /api/import {state, mode}`
  - lifecycle: `GET /api/health` (pid, port, mode, dataDir, version, stateVersion, items, `saveError?`, `recoveredFrom?`) ·
    `POST /api/shutdown`
- **TypeScript**: `import { Hud } from '<repo>/src/client.ts'` → `new Hud({actor}).push(id, {...})`. Requests time out
  after 15 s (`HUD_TIMEOUT` ms) and failures throw `HudRequestError` with a `status`.

The server starts automatically the first time the CLI, MCP server or client needs it.

## Items
Common fields: `id`, `type`, `board` (default `main`), `title`, `group`, `x`, `y`, `w`, `h` (canvas px, grid 20),
`meta` (free-form object for your own bookkeeping). Omit `x`/`y` to auto-place in free space.

**Groups** are the main way to organize: give an item `group: "CI"` and it lives in the frame titled "CI" (created if
missing). Changing `group` moves it; `group: ""` ungroups it. Renaming a frame renames its group. When a human drags an
item into or out of a frame, its group changes to match.

**Organize** (`hud_organize`, `hud organize`, `POST /api/organize {board, auto?}`) tidies a board: each group's frame is
packed with its members (monitors first, then tickets by status: blocked → doing → review → todo → backlog → done,
then notes), and frames + ungrouped items are packed into rows. `auto: true` keeps the board organized
continuously as items are added, removed, regrouped, resized or change status.

| type | purpose | fields |
|---|---|---|
| `ticket` | unit of work | `body` (markdown), `status` (`backlog` `todo` `doing` `review` `blocked` `done` `canceled`), `priority` (`low` `med` `high` `urgent`), `assignee`, `notify[]`, `tags[]`, `monitors[]` (linked monitor ids, shown live on the card), `autoStatus`, `project`, `parent`, `blockedBy[]`, `refs[]`, `branch`, `target`, comments via comment API |
| `monitor` | live status | `value`, `label`, `unit`, `state` (`ok` `warn` `error` `unknown` `running` `done`), `message`, `progress` (0-100), `max`, `source`, `display` + `plot` (see **Monitors**), thresholds, `staleAfter`, `notify` |
| `util` | on-canvas tool the human operates (timer, stopwatch, clock, counter, calculator, sheet, dice, markdown) | `kind`, `util` (per-kind state) — see **Utilities** |
| `note` | free text | `text` (markdown: `#`, `-`, `- [ ]`, `` ` ``, `**bold**`, `| tables |`) |
| `project` | groups tickets, gives them a `KEY-n` ident and a git branch | `key` (e.g. `EGO`), `lead`, `target`, `body` |
| `frame` | labelled region that groups whatever sits inside it | `title` |

**Canonical values.** Status and priority are normalised case-insensitively; anything else is a 400 that lists the
valid values. Status aliases: `cancelled`→`canceled`, `in progress`/`in-progress`/`started`→`doing`,
`closed`/`complete`/`completed`→`done`, `open`→`todo`. Priority aliases: `medium`→`med`, `p0`→`urgent`, `p1`→`high`,
`p2`→`med`, `p3`→`low`; `none` or `""` clears it.

**Limits** (400 on violation): title 300 chars; body/text 200 KB; comment 20 KB; message 2 KB (truncated); label 200;
unit 32; assignee/lead 80; at most 50 tags of 50 chars; `meta`/`util`/`plot`/`source` JSON 256 KB and 20 levels deep;
1000 comments per ticket (oldest automatic ones drop first). Custom item ids must not look like an ident (`ABC-12`,
`#3`, digits only) or be a reserved name (`__proto__`, `constructor`, …).

## Projects, tickets and links
Tickets are the work tracker, and they do not need the canvas at all. A **project** groups them and gives each one a
`KEY-n` ident (`EGO-3`) that every other tool, comment and branch name uses.

    hud_project {action: "create", name: "Eng org", key?: "EGO"}   # key is derived from the name when omitted
    hud_tickets {board?, status?, assignee?, project?, tag?, priority?, overdue?, limit?}   # list, or format:"json"
    hud_search  {text?, board?, type?, status?, assignee?, project?, tag?, priority?, overdue?, limit?}
    hud_create  {type: "ticket", title: "…", project: "EGO"}
    hud_link    {id: "EGO-3", project?, parent?, blockedBy?, refs?, branch?}

`hud_create`/`hud_update` also accept `project`, `parent`, `blockedBy`, `refs` and `branch` directly, so one call can
create a ticket already in its place. Anything that takes an item id also accepts a `KEY-12` ident (resolved as exact id, then `KEY-n`, then `#n`/`n` among
loose tickets on the board). Rename a project's key with `hud_update {id, key}` or `hud project set <id> --key NEW`.

- **`parent`** makes a sub-ticket. Subtrees nest in the list view and in `hud_tickets`; `ident` and `rollup` report
  progress (`3/5 done`) for the parent.
- **`blockedBy`** is the dependency edge. A ticket waiting on unfinished blockers is moved to `blocked`
  automatically (also when created with `blockedBy`), with a comment naming them, and returns to `todo` when they finish
  (or are `canceled`, or deleted). This is
  how to say "I can't proceed" — set the dependency rather than a bare `blocked` status, so it can clear itself.
- **`refs`** are loose "related to" links. Any `KEY-12` written in a ticket's title, body or comments is picked up
  automatically, so you rarely need to set this by hand.
- **`branch`** is generated on create as `key-12-some-title` (e.g. `ego-3-tune-the-loader`). Set `branch: "regen"`
  to rebuild it after a rename, or give an explicit name.

Relationships are validated: a parent or dependency must be a ticket on the same board, and cycles are rejected, so
the graph stays a DAG. Errors name the tickets involved rather than failing silently.

**Keys and deletes.** Project keys are unique per board (409 on a duplicate). Moving a ticket to another project gives it
the next number there, with a comment recording the old ident. Deleting a project detaches its tickets (renumbered into
the board's loose sequence); deleting a ticket removes it from other tickets' `parent` (children move up to its parent),
`blockedBy`, `refs` and `monitors`, and dependents unblock.

**Notifications.** A ticket with a non-empty `notify` list raises an alert (to those sessions) when someone *not* in that
list comments on it, changes its status or changes its assignee. The alert's `to` is `comment`, `status` or `assigned`.

The human reads the same structure in the **list view** (the `list` button in the top bar, or press `l`): one row per
ticket with its ident, status glyph, blockers and branch, sub-tickets nested, and `＋` beside any status to add a
ticket inline. `hud ls tickets` prints the same thing on the command line.

## Monitors
`source.kind` decides how a monitor is updated:
- `manual` — edited by hand or via `hud_update` / push.
- `push` — an external process reports: `POST /api/monitors/<id>/push`, `hud push <id> …`, `hud_push`, or the TS client.
  Pushing to an id that doesn't exist creates the monitor. Set `staleAfter` (s) to flag silence.
- `command` — `{kind:"command", command, cwd?, interval?=30, timeout?=30}` runs in a shell. stdout that is a JSON
  object like `{"value":3,"state":"warn","message":"…","progress":50}` is used as-is; otherwise the last line is the
  value (number if numeric). Non-zero exit → `error`.
- `http` — `{kind:"http", url, method?, headers?, body?, expectStatus?, contains?, jsonPath?, maxBytes?=5MB, interval?}`.
  Value is latency in ms, or the field at `jsonPath` (dot path, e.g. `data.items.0.status`). Unexpected status, or a
  body that lacks `contains`, → `error`; errors carry the real cause (`ECONNREFUSED`, `ENOTFOUND`, `timeout`, …).
- `heartbeat` — `{kind:"heartbeat", period?=60, grace?=60}` for jobs that report in. A job pings
  `/ping/<id>`; no ping within `period + grace` seconds (from the last update, or from creation if it never pinged)
  turns the monitor `error` (`no ping for 150s`), raises a `stale` alert, and the next ping recovers it. Pinging an
  unknown id creates the monitor.

      curl -fsS "http://localhost:{{PORT}}/ping/nightly-backup?period=86400&grace=3600&group=Ops"   # ok
      # crontab: start, run, then report the exit code (0 = ok, anything else = fail)
      0 3 * * *  curl -fsS localhost:{{PORT}}/ping/backup/start; ./backup.sh; curl -fsS localhost:{{PORT}}/ping/backup/$?

  Forms: `/ping/:id`, `/ping/:id/start`, `/ping/:id/fail`, `/ping/:id/:code`; GET or POST (a POST body up to 10 KB
  becomes the message); query `board group period grace title`. The reply is plain-text `ok`. CLI: `hud ping <id>
  [start|fail|<code>]`.
- `probe` — `{kind:"probe", probe:"<name>", config?, interval?}` loads `probes/<name>.ts` (or an absolute path).
  A probe module exports any of:
  ```ts
  export const interval = 10;                          // default poll seconds
  export default async function (ctx) {               // polled
    return { value: 42, state: 'ok', message: '…', progress: 50 };
  }
  export async function watch(ctx) {                  // long-lived link to an external process
    const p = spawnSomething(); p.on('data', d => ctx.emit({ value: d }));
    return () => p.kill();                            // cleanup when the monitor changes or is deleted
  }
  ```
  `ctx = { config, item, signal, emit(result), log(...) }`. A probe that fails to load or whose `watch` throws is
  retried, so fixing the file is enough; edits are picked up on the next poll. **Built-in probes** (in `probes/`):
  `tcp {host,port}` (value = connect ms), `tls {host,port?=443,warnDays?=14,errorDays?=3}` (value = days to expiry),
  `dns {name,type?='A'}` (value = lookup ms), `disk {path?='/'}` (value = % used), `file-age {path}` (value = seconds
  since mtime), plus the examples `git`, `process` and `tail` (POSIX only). See `probes/README.md`.

**Limits and validation.** `interval` is clamped to 1 s – 86400 s, `timeout` to 1 s – 3600 s, `staleAfter` ≥ 1,
`expectStatus` 100-599; thresholds and `max` must be finite numbers. A monitor with `staleAfter` that has never reported
goes stale after creation + `staleAfter`. A reading that changes state without a message clears the old message, and
re-sending an unchanged value still counts as a reading.

**Uptime.** `hud_get` / `GET /api/items/:id` on a monitor report `uptime: {h1, h24}`: the percentage of minutes with data
that were not in `error` over the last hour and day (`null` when there is no data).

**Numbers + labels.** Keep `value` numeric and put display text in `label` (value `2`, label `"2/4 busy"`): thresholds,
the trend chart, rate and ETA all work off the number. Progress monitors show throughput and an ETA
(`~90/h · ETA 11:00`) computed from recent readings; every monitor keeps 24h of per-minute history for the chart.

**Fan-out.** One reading can feed many monitors: a push (or command stdout, or probe result) with
`{"monitors": {"gpu0": {"value": 98, "label": "98% 12GB"}, "gpu1": {...}}}` updates/creates each id (in the parent's
board and group) and gives the parent a summary (`value` = count, `state` = worst child). One ssh call → one tile per GPU.

**Pushes can configure.** `hud push <id> … --max 4 --unit % --warnBelow 2 --staleAfter 120 --label "…" --group G`
(and the same fields in `hud_push` / the push API) so a monitor created by pushing is fully set up.

**Done.** Report `state: "done"` when a job finishes. Tickets with `monitors: [...]` and `autoStatus: true` move to
`done` when all linked monitors are done (state `done` or progress 100), to `blocked` when any is in `error`, and back
to `doing` when it recovers (each with a comment).

**Alerts.** A monitor going to `warn`, `error`, `done`, or stale (no update within `staleAfter`) raises an alert; recoveries
do not. An alert's `to` is one of `warn`, `error`, `stale`, `done`, `answered` (a decision was made), or the ticket events
`comment`, `status`, `assigned`. Acknowledged alerts are evicted first when the queue is full.
Alerts go to the session names in the monitor's `notify` list (or the board's), and `*` means every watching
session. Subscribe a session with `hud_watch {ids|boards, name?}` (`hud watch <name> <ids…> [--board b]`). `name` defaults to the
session name: `HUD_SESSION` if set, else `<actor>-<parent pid>`, so concurrent sessions don't receive each other's alerts.
In Claude Code, alerts arrive live in the conversation as `<channel source="hud">` messages when
claude is launched with `--dangerously-load-development-channels server:hud`. Alerts are also always queued for
`hud_alerts` (`hud alerts [--ack]`), shown as a badge in the UI, and passed to `HUD_ALERT_CMD` (a shell hook) if set: the alert JSON arrives on stdin and `HUD_ALERT_ID`, `_TITLE`,
`_STATE`, `_FROM`, `_MESSAGE`, `_BOARD` are set.
When you receive one: inspect it (`hud_get`), act if it's yours, tell the user, then `hud_alerts ack=true`.

State rules: a reading with a value and no explicit `state` counts as `ok`, then `warnAbove` / `errorAbove` /
`warnBelow` / `errorBelow` can worsen it (an explicit `state` in the reading always stands). `max` derives `progress` from a numeric value.

`display` picks the view. Non-chart views render inside the card; the rest are inline SVG sized to the card:

| group | kinds |
|---|---|
| plain | `value` (big number + sparkline), `progress` (bar + throughput/ETA), `status`, `text`, `log` (recent messages), `spark` (character sparkline) |
| time series | `line`, `area`, `bars` |
| distribution | `histogram` (bins of the series), `box` (min/q1/median/q3/max), `ridgeline` (several distributions stacked) |
| categorical | `pie`, `donut` |
| matrix / points | `heatmap`, `scatter`, `scatter3d`, `surface3d` |
| gauge | `gauge` |
| your own | `view:<name>` — see **Renderers** below |

`auto` (default) re-picks on every render from the **shape of the data**: a progress bar when `progress` is set, a
**line chart** once a numeric value has a couple of readings, a big number before that, a **pie** once
`meta.categories` holds named values, `scatter3d` once `meta.points` has 3-D points, else text or state. So a
monitor grows from a number into a chart without anyone reconfiguring it. In the UI, press `v` on a selected
monitor to cycle views by hand, or pick one in the drawer; hovering a chart names the exact value under the cursor.

**Chart options** live in `plot` alongside `display`:

| key | for | meaning |
|---|---|---|
| `series` | pie, donut, bars, scatter, scatter3d, surface3d, heatmap, ridgeline | dot path into `meta`, e.g. `categories`, `points`, `grid` (defaults match the key name) |
| `bins` | histogram, ridgeline | bucket count (default 12) · donut: inner radius % (default 55) |
| `yMin` / `yMax` | line, area, bars, scatter, box | pin the value axis; unset means auto from the data |
| `points` | line, area | draw a dot per reading |
| `tilt` / `spin` | scatter3d, surface3d | azimuth / elevation in degrees |
| `animate` | any | `replay` or `orbit` for a 3-D view |

Where the data comes from for the non-time-series kinds — all inside `meta`, so nothing else has to change:

```json
{"categories": {"cpu": 12, "mem": 30}}                       // pie, donut, bars
{"categories": [["a", 4], ["b", 7]]}                          // same, ordered
{"points": [[1, 2], [3, 4]]}                                  // scatter (x, y)
{"points": [[1, 2, 3], [4, 5, 6]]}                            // scatter3d (x, y, z)
{"grid": [[1, 2, 3], [4, 5, 6]]}                              // heatmap, surface3d
```

In the UI, hover a chart to read the value under the cursor, and **alt+scroll** over a chart to stretch the value
axis (stored in `plot.yMin`/`plot.yMax`; scrolling back out to the full data range returns it to auto).

## Renderers

When the built-in kinds can't express what you need, name a module in `views/`:

    hud_create {type: "monitor", id: "gpu", display: "view:bullet"}

`hud_views` lists what the server can see. A module is an ES module exporting `render(ctx)` (or a default
function) that returns an HTML/SVG string. `ctx` is `{item, w, h, helpers, hit}` — `helpers` carries the same
primitives the built-ins use (`esc, fmt, clamp, shade, seriesOf, categoriesOf, pointsOf, gridOf, rangeOf, svg`),
and `hit(px, py, value, label)` registers a point for the hover readout. Keep it monochrome (opacity, not colour)
and size to `w`/`h`. See `views/README.md` and `views/bullet.js`. A module that throws shows its error in its own
card and never takes the canvas down.

## Utilities

A `util` item is an on-canvas tool the human can operate — not a monitor. `kind` picks it, `util` holds its state:

| kind | state (`util`) | card |
|---|---|---|
| `timer` | `{seconds, remaining, running, endsAt}` | countdown + start/pause/reset/+5m |
| `stopwatch` | `{running, elapsed, startedAt, laps[]}` | elapsed + start/pause/lap/reset |
| `clock` | — | local + UTC time and date |
| `counter` | `{value, step, target}` | tally + −/+/zero, bar when `target` is set |
| `calculator` | `{expr, result, history[]}` | live expression evaluator |
| `sheet` | `{rows, cols}` + `text` (tab-separated cells) | spreadsheet; a cell starting `=` is a formula (`A1+B2`, `SUM(A1:A9)`, `AVG`, `MIN`, `MAX`, `IF`) |
| `dice` | `{sides, last, rolls[]}` | die roller |
| `markdown` | `text` | a small rendered note |

Run through the CLI/API like anything else (`hud add util "deploy timer" --kind timer`), or press `w` on the canvas.
State is ordinary item state, so it persists and survives a reload; a running timer keeps counting.


## Decisions (when you're blocked)
When you need a human to choose, don't just comment — propose options and let them click one.
`hud_ask {id, question?, options:[{label, detail?, status?}]}` (or `hud ask <id> --option A --option B --question "…"`)
stores the options, marks the ticket `blocked`, and shows it in **red** on the canvas. Each option's `status` is where
the ticket moves when that option is chosen (default `doing`; use `done` for options that finish the work).

The human clicks an option on the card (or `hud decide <id> <optionId> [--note "…"]`). That records the answer, moves the
ticket to the option's status, adds a `decision:` comment, and **raises an alert to the asking session** — so if you put
your session name in the ticket's `notify` (or the board's), you are woken with the answer. Read it back with `hud_get`.
With no human around you can also answer yourself with `hud_decide {id, optionId, note?}`.
`_red means a decision is waiting; green means done._`

## Finishing a run
When you're done, call `hud_finish {board?, ids?, note?}` (`hud finish`). It marks the named items complete and tidies
the board (re-runs organize) so the canvas ends up clean. Pass `organize: false` to leave the layout alone. With no `ids` it only completes items you created or are assigned, and
only push/manual monitors; it never touches tickets awaiting a decision, `canceled` tickets or other actors' work.

## Trash, backups and undo
Nothing is deleted outright. `hud_delete` / `hud rm` / `DELETE /api/items/:id` move the item to the **trash**
(deleting a board trashes its items plus the board; `main` cannot be deleted). `hud_trash {action:"list|restore|purge"}`
(`hud trash`, `hud restore <id>`, `hud purge <id>|--all`) brings things back, recreating the board if needed and dropping
links that no longer resolve; only `purge` deletes for good. The trash keeps 500 entries for 30 days. The UI's `u` /
⌘Z undoes a delete the same way.

State is backed up to `<data>/backups/state-<YYYYMMDD-HHMMSS>[-reason].json` on server start (before migrations),
before an import or board delete, and hourly; the newest 30 are kept. `hud backup [--list] [--reason r]`,
`hud_backup`, `GET|POST /api/backups`. `hud export [file]` / `GET /api/export` dump the whole state; `hud import <file>
[--merge]` / `POST /api/import {state, mode:"replace"|"merge"}` load one (replace takes a backup first). A corrupt
`state.json` is moved aside as `state.json.corrupt-<ts>` and the newest valid backup is loaded; `GET /api/health` then
reports `recoveredFrom`, and `saveError` if saving is failing (it is retried every 2 s). Only one server may use a data
dir (`hud.lock`); a second one refuses to start.

## Conventions
- Start with `hud_overview`. Reuse existing boards/frames/tickets instead of duplicating them.
- One board per project or area; frames for sub-areas (e.g. "CI", "Release 1.4", "Agent: claude").
- Track your own work as tickets: set `status: doing` when you start, `hud_comment` progress notes, `done` when finished,
  `blocked` with a comment saying what you need from the human — and if you are waiting on another *ticket*, set
  `blockedBy` instead so it clears itself when that ticket finishes.
- For long tasks, push a progress monitor (`hud_push id=<task> progress=… message=…`), and `state: done` at the end.
- Link tickets to the monitors that track them (`monitors`, `autoStatus`), and `hud_watch` the monitors you're
  responsible for so you're woken instead of polling.
- Give monitors meaningful ids (`ci-main`, `disk-root`) so scripts can push to them.
- Don't move or resize items the human placed unless asked; place new things in free space or in a frame.
- Use `group` rather than coordinates; run `hud_organize` after adding a batch of items (or turn on `auto`).
- `hud_arrange` does a simple flow layout of one frame or a board without regrouping.

## Install hud as an app (macOS, Windows, Linux)
hud ships as a desktop app (Electron shell around the same local server): a real window, a menu-bar/tray icon,
and the CLI + MCP server built into the same binary.

    npm install        # once, for the build tooling
    npm run dev        # run the app against this repo on a scratch port + scratch data dir

    npm run dist       # installers for the current OS -> dist/
    npm run dist:mac   # dmg + zip (arm64, x64)
    npm run dist:win   # nsis installer (x64, arm64)
    npm run dist:linux # AppImage + deb

Each OS builds its own artifact, and macOS signing only works on macOS. `dist/` output is produced by
`electron-builder` from `electron-builder.yml`; `npm run bundle` alone just rebuilds `bundle/hud.mjs` (the CLI +
server) with esbuild.

A packaged app keeps its data in the per-user dir (`~/Library/Application Support/hud`, `%APPDATA%\hud`,
`$XDG_DATA_HOME/hud`) and seeds the example probes and renderers into `<data>/probes` and `<data>/views` on first
run. The port and data dir are fixed (one board, one server); the `HUD_*` path/port overrides only apply with `HUD_SCRATCH=1`.

## Connect your agent
    hud mcp install                 # claude + codex + opencode (skips any that aren't installed)
    hud mcp install claude          # just one
    hud mcp install all --dry-run   # show exactly what would change
    hud mcp status                  # where hud is wired in, and which command is used
    hud mcp uninstall               # remove the hud entry again
    hud mcp print generic           # a snippet to paste into any other client (e.g. muse)

Config files are parsed and backed up before any write, and only the `hud` entry is ever touched.
When run from a packaged binary it registers `<hud> mcp`, so nothing else needs to be on `PATH`.

In the desktop app, `Help → Install "hud" command…` (or `hud cli install`) puts the `hud` command on your `PATH`; the
shim points at the app binary, so the CLI and the MCP server are the same program. `HUD_BIN_DIR` chooses where it goes.
