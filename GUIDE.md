# hud — agent guide

hud is a local, live canvas shared between a human and agents. It holds **tickets**, **monitors**,
**notes** and **frames** on one or more **boards**. Everything you change appears instantly in the
human's browser at http://localhost:{{PORT}} and vice versa. The human rearranges things too, so
re-read state (`hud ls` / `hud_overview`) before assuming positions or statuses.

## Ways in (all equivalent)
- **MCP**: tools `hud_overview`, `hud_tickets`, `hud_search`, `hud_project`, `hud_link`, `hud_create`, `hud_update`,
  `hud_push`, `hud_comment`, `hud_get`, `hud_delete`, `hud_trash`, `hud_backup`, `hud_board`, `hud_organize`,
  `hud_arrange`, `hud_run`, `hud_views`, `hud_watch`, `hud_alerts`, `hud_attention`, `hud_runs`, `hud_changes`,
  `hud_readout`, `hud_snapshot`, `hud_dashboard`, `hud_annotate`, `hud_compare`, `hud_lint`, `hud_graph`,
  `hud_canvas`, `hud_clear_canvas`, `hud_ask`, `hud_decide`, `hud_finish`, `hud_guide`. MCP also exposes the
  `hud://guide` resource.
  Times in tool output are in the machine's local time zone. `source.kind: "command"` runs a shell command on the
  user's machine, so only set it for checks the user would run themselves.
- **CLI**: `hud ls`, `hud add`, `hud set`, `hud push`, `hud attention`, `hud runs`, `hud changes`, `hud readout`,
  `hud snapshot`, `hud dashboard`, `hud annotate`, `hud compare`, `hud lint`, `hud graph`, `hud canvas`, `hud board clear <id>`,
  `hud comment`, `hud ask`, `hud decide`, `hud finish`, … (`hud help`;
  every command takes `--help`, and `--json` prints machine-readable output). If `hud` is not on PATH use
  `node <repo>/bin/hud.js`. Set `HUD_ACTOR=<your-name>` (or `--as`) so changes are attributed to you.
- **HTTP** (JSON, localhost only; send header `x-hud-actor: <name>`). Malformed input is a 400, an unknown id or board
  a 404; ids may be a `KEY-12` ident.
  - read: `GET /api/summary[?board=]` text overview · `GET /api/readout[?board=]` metrics and evidence ·
    `POST /api/snapshot {board?,format?}` · `GET /api/state` · `GET /api/events` SSE · `GET /api/projects` ·
    `GET /api/tickets[?format=text]` · `GET /api/items` · `GET /api/items/:id` (includes `trend` and `uptime`) ·
    `GET /api/items/:id/activity[?limit=]` · `GET /api/activity[?limit=&board=]` · `GET /api/attention` · `GET /api/runs` ·
    `GET /api/changes?since=<epoch-ms>` · `GET /api/views` · `GET /api/guide`
  - search filters, on `GET /api/items` and `GET /api/tickets`: `board type status` (comma list) `priority assignee
    project tag q overdue=1 parent limit`. An unknown board is a 404.
  - write: `POST /api/items` (one or an array) · `PATCH /api/items/:id` · `PATCH /api/items` (array of `{id,...}`) ·
    `DELETE /api/items/:id` (to the trash) · `POST /api/items/:id/link {project?,parent?,blockedBy?,refs?,branch?}` ·
    `POST /api/items/:id/unlink {fields?}` · `POST /api/items/:id/comments {text,format?}` ·
    `PATCH /api/items/:id/comments/:cid {text,format?}` · `DELETE /api/items/:id/comments/:cid`
  - monitors: `POST /api/monitors/:id/push {value,state,message,messageFormat,details,progress,...}` · `POST /api/monitors/:id/run` ·
    heartbeat **`/ping/:id`** (see Monitors)
  - decisions and runs: `POST /api/items/:id/ask {question?,questionFormat?,options}` ·
    `POST /api/items/:id/decide {optionId,note?,decisionVersion}` ·
    `POST /api/finish {board?,ids?,note?,organize?}`
  - boards: `GET/POST /api/boards` · `PATCH|DELETE /api/boards/:id` (`main` cannot be deleted; a delete goes to the
    trash) · `POST /api/organize {board, auto?}` · `POST /api/arrange {board|frame, ids?, width?}` ·
    `POST /api/boards/:id/clear` (clear canvas while keeping board) ·
    `GET|PUT /api/boards/:id/dashboard` · `GET|POST|DELETE /api/boards/:id/annotations` ·
    `GET|POST|DELETE /api/boards/:id/comparisons` · `GET /api/boards/:id/lint` ·
    `GET|POST|DELETE /api/boards/:id/program` · `GET|POST|DELETE /api/items/:id/program`
  - alerts: `GET /api/alerts[?all=1&notify=name&since=]` · `POST /api/alerts/ack {ids?}` · `POST /api/watch {name, ids?, boards?, off?}` ·
    `POST /api/attention/:id {action,revision,until?}` (`review`, `unreview`, `snooze`; review is separate from alert acknowledgement)
  - safety net: `GET /api/trash[?board=]` · `POST /api/trash/:id/restore` · `DELETE /api/trash/:id` and `DELETE /api/trash`
    (permanent) · `GET|POST /api/backups` · `GET /api/export` · `POST /api/import {state, mode}`
  - lifecycle: `GET /api/health` (pid, port, mode, dataDir, version, stateVersion, items, `saveError?`, `recoveredFrom?`) ·
    `POST /api/shutdown`
- **TypeScript**: `import { Hud } from '<repo>/src/client.ts'` → `new Hud({actor}).push(id, {...})`. Requests time out
  after 15 s (`HUD_TIMEOUT` ms) and failures throw `HudRequestError` with a `status`.

The server starts automatically the first time the CLI, MCP server or client needs it.

## Browser navigation
The browser opens on the cross-board **Attention** landing: current decisions, blocked work, warnings, errors and stale
reporters are grouped by board and run. Review keeps an issue active; it only records human review. **Runs** lists
tickets tagged `run`, with their explicit `summaryMonitor`, progress, ETA and linked work. **Board** returns to the
selected dashboard or Tickets view. Completed runs are hidden until **show completed** is selected.

Use the searchable **board** switcher in the top bar to find or create a board; recent boards are kept near the top.
Use **search** or `⌘/Ctrl+K` for a cross-board search of titles, ids, UUIDs, ticket idents, bodies and notes. Opening a
result switches to its board and opens the details sidebar without acknowledging attention or alerts.

## Items
Common fields: `id`, `type`, `board` (default `main`), `title`, `group`, `x`, `y`, `w`, `h` (board pixels),
`meta` (free-form object for your own bookkeeping). Dashboard surfaces are fixed **1600 × 900**. Geometry is clamped
to those bounds. Auto layout is on by default; omit coordinates and let hud place and size visual cards.

**Tickets are list objects, not canvas cards.** Use **Tickets** to search and manage them; clicking a row opens
its scrollable sidebar. Done and canceled tickets are hidden by default; **completed** reveals them, and an
explicit status filter or search also finds them. **Dashboard** shows monitors, notes, utilities and their
frames. Double-click any visual card to open its sidebar. Ticket-only frames and projects do not take dashboard
space. Ticket-heavy boards initially open the list; view choice is remembered per board. Ticket identities,
groups and relationships remain shared with agents. Never size or position tickets to improve visual layout.

Tickets have an immutable `uuid`. New ticket ids are UUIDs unless a custom id is supplied. Existing ids and
`KEY-n` identifiers remain valid; existing tickets gain a UUID alias without breaking links. Use the SVG copy
button beside a ticket identifier on its card, list row, or details panel, then paste the UUID into MCP, CLI,
or HTTP anywhere a ticket id is accepted. `hud_get` returns the full UUID.

### Details sidebar
Opening an item shows **Overview**, **History**, and **Settings** tabs. The sidebar can be resized with its grip or
keyboard: it stays between **360 px** and **900 px**, capped by the window width, and the chosen width is remembered
in that browser. Overview is for the current report, linked run, decision, comments and follow-up; History contains
readings, report history, comments and activity; Settings edits fields and configuration. Resizing or opening details
does not move cards or acknowledge attention.

**Groups** are the main way to organize: give an item `group: "CI"` and it lives in the frame titled "CI" (created if
missing). Changing `group` moves it; `group: ""` ungroups it. Renaming a frame renames its group. When a human drags an
item into or out of a frame, its group changes to match.

**Organize** (`hud_organize`, `hud organize`, `POST /api/organize {board, auto?}`) fits visual groups and cards into the
fixed surface. Small collections are centered at readable sizes; larger collections use the available area.
Creation order stays stable: readings and status changes do not reshuffle a monitoring dashboard.
`auto: true` (the default) reflows after additions, deletions, regrouping and resizing. `auto: false` lets humans
and agents position cards deliberately with `x/y/w/h`. Organize performs one layout even when disabling auto.
`hud_arrange` is a compatibility alias for whole-board layout; `frame` selects its board, while legacy `width`
does not change the fixed surface. The organize response includes `canvas`, visual card count `items`, list
count `tickets`, and `moved`. Tickets do not reduce the space available for monitors.

Use **Clear canvas** to empty a board while keeping its identity and settings: items move to Trash, the managed
dashboard is removed, annotations and comparisons are tombstoned, and the canvas program is disabled with any draft
removed. Use **Delete board** when the board itself should be removed; its items go to Trash, and `main` cannot be
deleted. The UI exposes these as separate actions. CLI is `hud board clear <id>`; MCP supports `hud_clear_canvas {board}` and
`hud_board {action:"clear",id}`. The HTTP route is `POST /api/boards/:id/clear`; the client method is
`clearBoard(board)` and returns `{board,cleared,removed}`.

### Visual layout instructions for agents

- Read `hud_overview` and `hud_board {action:"list"}` first. Respect boards in manual layout mode.
- For training or other long-running jobs, group related cards by a run tag. Create a concise run-summary ticket first,
  tag it `run`, link its monitors, and set `summaryMonitor` to the one monitor that owns progress and ETA. Then add
  detail charts, resource readings, and linked tickets. Include units in titles or `unit`.
- Set `staleAfter` or a heartbeat so a stopped reporter is visible; use `hud_watch` for alerts and push `done`
  or `error` when the job ends. Reading updates leave the layout stable.
- After a batch, call `hud_organize {board, auto:true}`. With only a few cards, the default centered layout is
  sufficient. For a custom sparse composition, disable auto, then place the summary prominently with related
  charts beside it, using nonoverlapping rectangles inside `0..1600` × `0..900`.
- Keep overview cards readable. If the board gets crowded, create separate boards per run or experiment;
  use Fit board (`.`) to see the whole surface and zoom in for details. Zoom-out stops at Fit, zoom-in at 300%
  (or Fit on an unusually large display), and panning cannot lose the board.

Existing boards are backed up before migration to this layout. Their cards and relationships are retained,
and auto layout is enabled once during migration.

| type | purpose | fields |
|---|---|---|
| `ticket` | unit of work | `body` (markdown), `status` (`backlog` `todo` `doing` `review` `blocked` `done` `canceled`), `priority` (`low` `med` `high` `urgent`), `assignee`, `notify[]`, `tags[]` (tag run summaries with `run`), `monitors[]` (linked monitor ids, shown live on the card), `summaryMonitor`, `autoStatus`, `project`, `parent`, `blockedBy[]`, `refs[]`, `branch`, `target`, `question` + `questionFormat`, options (their `detail` uses the same format), comments via comment API |
| `monitor` | live status | `value`, `label`, `unit`, `state` (`ok` `warn` `error` `unknown` `running` `done`), short `message` + `messageFormat`, long Markdown `details`, `progress` (0-100), `max`, `source`, `display` + `plot` (see **Monitors**), thresholds, `staleAfter`, `notify` |
| `util` | on-canvas tool the human operates (timer, stopwatch, clock, counter, calculator, sheet, dice, markdown) | `kind`, `util` (per-kind state) — see **Utilities** |
| `note` | free text | `text` (markdown: `#`, `-`, `- [ ]`, `` ` ``, `**bold**`, `| tables |`) |
| `project` | groups tickets, gives them a `KEY-n` ident and a git branch | `key` (e.g. `EGO`), `lead`, `target`, `body` |
| `frame` | labelled region that groups whatever sits inside it | `title` |

**Canonical values.** Status and priority are normalised case-insensitively; anything else is a 400 that lists the
valid values. Status aliases: `cancelled`→`canceled`, `in progress`/`in-progress`/`started`→`doing`,
`closed`/`complete`/`completed`→`done`, `open`→`todo`. Priority aliases: `medium`→`med`, `p0`→`urgent`, `p1`→`high`,
`p2`→`med`, `p3`→`low`; `none` or `""` clears it.

**Limits** (400 on violation): title 300 chars; body/text 200 KB; comment 20 KB; message 2 KB (truncated); monitor `details` 20 KB;
`messageFormat` and `questionFormat` are `plain` or `markdown` (both default to `plain`); label 200;
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

The human reads the same structure in the **Tickets view** (or press `l` on a board): one row per
ticket with its ident, status glyph, blockers and branch, sub-tickets nested, and `＋` beside any status to add a
ticket inline. `hud ls tickets` prints the same thing on the command line.

## Monitors
`source.kind` decides how a monitor is updated:
- `manual` — edited by hand or via `hud_update` / push.
- `push` — an external process reports: `POST /api/monitors/<id>/push`, `hud push <id> …`, `hud_push`, or the TS client.
  Pushing to an id that doesn't exist creates the monitor. Set `staleAfter` (s) to flag silence. Keep `message` a short
  headline and put a longer Markdown report in `details` (up to 20 KB); `messageFormat` is `plain` by default and may be
  `markdown`.
- `command` — `{kind:"command", command, cwd?, interval?=30, timeout?=30}` runs in a shell. stdout that is a JSON
  object like `{"value":3,"state":"warn","message":"…","messageFormat":"plain","details":"## report\n…","progress":50}` is used as-is; otherwise the last line is the
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

**Rich reports.** Keep `message` short enough for a headline and set `messageFormat: "plain"` (the default) or
`"markdown"`; put the longer Markdown report in `details` (maximum 20 KB). The browser renders reports safely in cards,
the details sidebar and monitor History, while `hud ls` and other terminal summaries emit a compact plain-text excerpt.
Keep `value` and `progress` numeric even when the message or details contain tables, links or code. A report update is
recorded in monitor report history; unchanged readings do not grow that history.

### Metrics, observations and freshness

Give measurements a `metric` description so readers can tell what a number means and which system produced it:

```json
{
  "metric": {
    "kind": "capacity",
    "key": "gpu.memory.used",
    "scope": "node-0",
    "unit": "GiB",
    "definition": "Allocated device memory",
    "target": 80,
    "denominator": 96,
    "source": "nvidia-smi",
    "sourceId": "gpu-0"
  },
  "value": 72,
  "observedAt": 1792152000000,
  "evidence": "reported",
  "availability": "partial",
  "coverage": {"responding": 3, "total": 4}
}
```

This push example is reported by an external process; a local command, HTTP or probe collector can mark its own
measurement `measured`. For a bounded capacity display, also set `metric.denominator` (or monitor `max`) to the total.

`metric.kind` is one of `scalar`, `capacity`, `rate`, `counter`, `breakdown`, `table` or `grid`. Use `key` for a
stable metric name, `scope` for the entity or population measured, and `unit` and `definition` to make its meaning
clear. `windowSeconds` describes the rate or aggregation window; `target` is a meaningful target value, not a second
reading. `denominator`, `source` and `sourceId` describe how the value was computed and where it came from. Keep
`observedAt` (when the source measured it) separate from the receipt time hud records. Observation metadata also
records the actor, evidence (`measured`, `reported`, `estimate` or `unknown`), availability (`available`, `partial` or
`unavailable`) and optional `{responding,total}` coverage. Timestamps are epoch milliseconds.

External pushes without an evidence value are `reported`; mark derived or forecast values explicitly as `estimate`.
Only hud's command, HTTP and probe collectors can assign `measured`. Legacy readings with no provenance remain
`unknown`. For a fleet or batch, report partial availability and its coverage instead of presenting the responding
subset as complete. A failed poll records the failed attempt and error without
advancing the observation time or replacing the last good value. Push and manual monitors default to five minutes of
freshness; set `staleAfter` to the expected reporting cadence. Polled sources use the larger of 60 seconds, three
poll intervals, or one interval plus its timeout as the stale window. Heartbeats keep their `period + grace` rule.
`state: "done"` is a historical completion and does not become stale. For a value that is intentionally fixed, use
`freshness: {"mode":"static","reason":"..."}` and explain why age is not meaningful.

Structured data stays structured. `table` and `grid` use `data: {"columns":[{"key":"worker","label":"Worker"},
{"key":"rate","unit":"rows/s","type":"number"}],"rows":[{"worker":"a","rate":12.5}]}`.
Rows are objects keyed by column `key`; `grid` uses the same rows and adds grayscale intensity to numeric cells.
`breakdown` uses named values in `meta.categories` (or compatible table rows). The separate `heatmap` and `surface3d`
views read numeric matrices in `meta.grid`. Table data supports up to 50 columns, 1,000 rows and 256 KB.

### Composite monitors and plot context

Use `display: "composite"` for one metric's current value and recent history; use `display: "line"` with
`plot.metrics: [<metric-id>, ...]` to compare related monitor histories in one card. Use `capacity`, `breakdown`,
`table`, `grid` or `pipeline` when the monitor has that native shape. A pipeline declares
stages by stable key and points each field at a metric id:

```json
{
  "pipeline": {"stages": [
    {"key":"ingest","label":"Ingest","throughput":"ingest.rate","queued":"ingest.queue","oldestAge":"ingest.oldest","retries":"ingest.retries"},
    {"key":"transform","label":"Transform","throughput":"transform.rate","queued":"transform.queue","inFlight":"transform.active","rejected":"transform.rejected"}
  ]}
}
```

A multi-series line plot can compare related metric ids and overlay target and event context:

```json
{
  "display": "line",
  "plot": {
    "metrics": ["ingest.rate", "transform.rate"],
    "targets": [{"value": 120, "label": "expected throughput"}],
    "events": [{"time": 1792152000000, "text": "release 4.2"}]
  }
}
```

Target values use the plotted metric's unit. Event times and board annotations use epoch milliseconds. `breakdown`
reads named values from `meta.categories` or compatible table rows; `grid` reads `data` with declared columns and
object rows; `heatmap` and `surface3d` read numeric matrices from `meta.grid`.

Stages can name `throughput`, `queued`, `oldestAge`, `inFlight`, `retries` and `rejected` metric ids. Keep those
metrics separately readable so agents can inspect and compare each stage. hud labels a bottleneck a *candidate* only
when the upstream and downstream throughput are available, fresh and compatible in scope, unit and window, and the
downstream queue is growing while output is below incoming throughput. This is a signal to inspect, not a causal
diagnosis. A chart's `plot.targets` adds labeled target lines; `plot.events` adds time-stamped event markers. These
overlays add context to the measured history and do not change its values.

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
| structured metrics | `composite`, `capacity`, `breakdown`, `table`, `grid`, `pipeline` |
| gauge | `gauge` |
| custom | `custom` — isolated program set by `hud_graph`; see **Custom graphs and full canvas programs** |
| trusted file renderer | `view:<name>` — see **Renderers** below |

`auto` (default) first honors `metric.kind`: capacity, rate, breakdown, table and grid select their matching views;
scalar and counter select `composite`. It also selects `pipeline` from a pipeline definition and table from structured
rows. Without a declared kind it uses progress, a numeric composite, categories, points, then text or state. In the UI,
press `v` on a selected monitor to cycle views by hand, or pick one in the drawer; hovering a chart names the exact
value under the cursor.

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

### Readouts, snapshots and dashboards

`hud_readout({board?})` returns `{now,boards,items,text}`. Each item is a `MetricReading` with identity, value and
unit, state, stale/age, observation and receipt times, evidence, source, definition, availability, coverage and expiry;
pipeline cards also include `pipelineView`. Each board has its id/name/revision, annotations and comparison results.
Omit `board` to read all boards. `hud_snapshot({board?,format?})` returns `{board,capturedAt,text,image?,warnings?,imageUnavailable?}`;
`image`, when present over HTTP, is `{mimeType:"image/png",data:<base64>}`. Formats are `auto`, `png` and `text`.
`auto` reports a capture failure and falls back to text; `png` fails if no image can be captured. Check the result
before claiming an image exists. A text snapshot is a portable readout, but it is not visual evidence. The CLI saves
a returned image to `snapshot.png` by default; `--out` selects another path.

`hud_dashboard({board,action:"get"})` returns `{board,dashboard}`, where `dashboard` is `null` or
`{revision,spec,keys}`. Set it with `hud_dashboard({board,action:"set",spec,dryRun?,expectedRevision?})` to reconcile
a declarative spec. The result is `{board,revision,url,created,updated,removed,dryRun,lint}`; each change list contains
item IDs, and `lint` is `{board,findings,errors,warnings}` with findings `{code,severity,id,message}`. A dry run
returns the proposed reconciliation without saving it. The spec shape is:

```json
{
  "rows": [
    {"key":"flow","height":2,"cards":[
      {"key":"pipeline","span":12,"id":"etl-pipeline","item":{"type":"monitor","title":"ETL pipeline","display":"pipeline","pipeline":{"stages":[
        {"key":"ingest","label":"Ingest","throughput":"ingest-rate","queued":"ingest-queue"},
        {"key":"transform","label":"Transform","throughput":"transform-rate","queued":"transform-queue"}
      ]}}}
    ]},
    {"key":"metrics","cards":[
      {"key":"ingest-rate","span":3,"id":"ingest-rate","item":{"type":"monitor","title":"Ingest rate","unit":"rows/s","staleAfter":60,"metric":{"kind":"rate","key":"etl.ingest.rate","scope":"etl","unit":"rows/s","definition":"Rows accepted per second","windowSeconds":60,"source":"ETL collector"}}},
      {"key":"ingest-queue","span":3,"id":"ingest-queue","item":{"type":"monitor","title":"Ingest queue","unit":"rows","staleAfter":60,"metric":{"kind":"scalar","key":"etl.ingest.queue","scope":"etl","unit":"rows","definition":"Rows waiting to be ingested","source":"ETL collector"}}},
      {"key":"transform-rate","span":3,"id":"transform-rate","item":{"type":"monitor","title":"Transform rate","unit":"rows/s","staleAfter":60,"metric":{"kind":"rate","key":"etl.transform.rate","scope":"etl","unit":"rows/s","definition":"Rows transformed per second","windowSeconds":60,"source":"ETL collector"}}},
      {"key":"transform-queue","span":3,"id":"transform-queue","item":{"type":"monitor","title":"Transform queue","unit":"rows","staleAfter":60,"metric":{"kind":"scalar","key":"etl.transform.queue","scope":"etl","unit":"rows","definition":"Rows waiting to be transformed","source":"ETL collector"}}}
    ]}
  ],
  "annotations": [{"time":1792152000000,"text":"Release 4.2"}],
  "comparisons": [{"left":"ingest-rate","right":"transform-rate","relation":"gte","tolerance":5,"holdFor":60,"maxSkew":30}]
}
```

The pipeline and comparison references use card keys; hud resolves them to the managed item ids on apply. The reporters
can then push each metric using the same ids. This spec creates layout and metric definitions only; its first readout
will remain `unknown` until the reporters send observations.

Rows and cards require stable, unique keys. `height` is a positive relative row proportion (default 1); `span` is a
positive share of a 12-column row, and each row's spans must add up to no more than 12. Cards may provide an existing
monitor, note or utility id to keep updating that item. A dry run previews the reconciliation; pass `expectedRevision` when applying a spec based on a
previous read so an intervening board edit is detected. hud tracks which items the spec owns: omitted managed cards
are moved to trash, matched cards retain their reading history, and unrelated board content is left alone. Use
`hud_lint` to inspect the board before and after reconciliation. It reports missing units, definitions or sources,
default freshness windows, unknown provenance, duplicate metric identities, incompatible comparisons, unresolved
pipeline or program bindings, small or out-of-bounds cards and overlaps. Treat warnings as limits on interpretation;
fix errors such as unresolved bindings before relying on the board.

`hud_annotate` lists, adds or deletes a timestamped note on the board; times are epoch milliseconds. MCP list/add/delete
results wrap records as `{board,annotations}`, `{board,annotation}` and `{board,id,deleted}`. `hud_compare` lists,
adds or deletes a comparison between monitor ids, returning `{board,comparisons}`, `{board,rule}` or `{board,id,deleted}`:
`equal`, `lte` or `gte`, with optional numeric `tolerance`, `holdFor` and `maxSkew` limits. Comparisons make the
relationship between measurements explicit; they do not change either source metric. A comparison is unknown when an
input is missing, stale, partial/unavailable, nonnumeric, or incompatible in scope, unit or window. The maximum
observation skew defaults to 60 seconds; mismatches stay pending for `holdFor` seconds (60 by default), then become a
conflict. `tolerance` uses the compared metrics' unit; `holdFor` and `maxSkew` are seconds. Put shared incidents or
releases on the timeline as annotations, and use chart event markers when the context belongs to one plot.

CLI forms mirror these operations: `hud readout [board]`, `hud snapshot [board] --format auto|png|text [--out path]`,
`hud dashboard [board] --file path [--dry-run] [--expected-revision rev]` (or JSON from stdin),
`hud annotate <board> <epoch-ms> <text...>` plus `hud annotate list <board>` and `hud annotate delete <board> <id>`,
`hud compare <board> <left> <equal|lte|gte> <right> [--tolerance n] [--holdFor s] [--maxSkew s]` plus
`hud compare delete <board> <id>`, and `hud lint [board]`. `hud graph <monitor>` and `hud canvas [board]` accept
`--action get|preview|apply|disable|delete`, `--file` for a JSON program or `--code-file` for raw code. For raw
code, set `--language` and `--description`; repeat `--binding` and `--capability operation:scope` as needed.

The HTTP annotation and comparison routes return their bare record/list (`GET`), created record (`POST`) or
`{id,deleted:true}` (`DELETE`). Comparison list entries include `state`, `reason` and a `result` with the evaluated
inputs. `hud_lint({board?})` returns `{board,findings,errors,warnings}`; each finding has `code`, `severity`, `id` and
`message`.

### Custom graphs and full canvas programs

Ordinary Markdown code blocks stay inert. Use `hud_graph` for an explicit custom graph, and `hud_canvas` only when a
complete custom board surface is needed. Both accept a program with `code`, `language` (`html`, `javascript` or `svg`),
`description`, `bindings` and `capabilities`, and support `preview`, `apply`, `disable` and `delete`. Preview returns
`{valid,image,errors,warnings}`; get returns the active `{program,draft}` pair, either of which may be `null` (MCP
also includes the target id).
`hud_graph` applies a program to the selected monitor and `hud_canvas` applies it to the selected board. A successful
apply returns `{board,id,revision,program}`; the stored active record keeps the prior revision under `previous`. A
render or capture failure during apply saves the candidate and its errors as `draft`, leaves the active program/revision
intact, and rejects the request; read it back with `get`. Shape errors and an early revision conflict happen before
draft saving. `disable` and `delete` deactivate the program and restore the native monitor or board view; stored source
and draft remain available from `get`. Custom code runs in an isolated browser surface with `window.hud` initialized
before source code starts. Programs allow up to 200 bindings and 100 capabilities, with code limited to 1 MiB:

```js
const graphProgram = {
  language: 'javascript',
  description: 'GPU memory used against its capacity',
  bindings: ['gpu-memory-used'],
  capabilities: [],
  code: `function draw() {
    const m = hud.data.byId['gpu-memory-used'];
    const ns = 'http://www.w3.org/2000/svg';
    const width = Math.max(160, hud.size.width), height = Math.max(100, hud.size.height);
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', '8'); label.setAttribute('y', '18'); label.setAttribute('fill', '#e8e8e8');
    label.textContent = m ? m.title + ': ' + (m.value ?? '—') + ' ' + m.unit : 'waiting for gpu-memory-used';
    svg.append(label);
    if (m && typeof m.value === 'number') {
      const max = Math.max(1, Number(m.max) || m.value), x = 8, y = Math.round(height / 2), w = width - 16;
      const rail = document.createElementNS(ns, 'rect');
      rail.setAttribute('x', x); rail.setAttribute('y', y); rail.setAttribute('width', w);
      rail.setAttribute('height', '8'); rail.setAttribute('fill', '#333');
      const bar = document.createElementNS(ns, 'rect');
      bar.setAttribute('x', x); bar.setAttribute('y', y);
      bar.setAttribute('width', w * Math.max(0, Math.min(1, m.value / max)));
      bar.setAttribute('height', '8'); bar.setAttribute('fill', '#fff');
      svg.append(rail, bar);
      const provenance = document.createElementNS(ns, 'text');
      provenance.setAttribute('x', '8'); provenance.setAttribute('y', height - 8);
      provenance.setAttribute('fill', '#8c8c8c'); provenance.setAttribute('font-size', '10');
      provenance.textContent = (m.stale ? 'stale' : m.ageSeconds + 's') + ' · ' + m.evidence + ' · ' + m.source;
      svg.append(provenance);
    }
    document.body.replaceChildren(svg);
  }
  draw();
  hud.onData(draw);
  hud.onResize(draw);
  hud.rendered();`
};

hud_graph({ id: 'gpu-memory-used', action: 'preview', program: graphProgram });
```

For a full board surface, bind the specific monitors and make the code render them as a responsive set of cards:

```js
hud_canvas({
  board: 'ops',
  action: 'preview',
  program: {
    language: 'javascript',
    description: 'GPU and worker overview',
    bindings: ['gpu-memory-used', 'worker-count'],
    capabilities: [],
    code: `function draw() {
      const root = document.createElement('main');
      root.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;padding:16px;background:#000;color:#e8e8e8;font:12px monospace';
      for (const id of ['gpu-memory-used', 'worker-count']) {
        const m = hud.data.byId[id];
        const card = document.createElement('section');
        card.style.cssText = 'border:1px solid #444;padding:12px;min-width:0';
        card.textContent = m ? m.title + ': ' + (m.label ?? m.value ?? '—') + ' ' + m.unit + ' · ' + m.state + (m.stale ? ' stale' : '') + ' · ' + m.evidence + ' · ' + m.source + ' · ' + m.ageSeconds + 's old' : id + ': unavailable';
        root.append(card);
      }
      document.body.replaceChildren(root);
    }
    function drawAndReady() { draw(); }
    drawAndReady();
    hud.onData(drawAndReady);
    hud.onResize(drawAndReady);
    hud.rendered();`
  }
});
```

The SDK is `hud = {data, size, theme, onData, onResize, onDispose, rendered, error, action}`. `data` contains
only explicitly bound items as `items` (`MetricReading[]`) and `byId`, plus `now` and target-board `annotations`;
binding IDs can name monitors on other boards. `size` is `{width,height}` in CSS
pixels. `onData(fn)` and `onResize(fn)` return unsubscribe functions; register cleanup with `onDispose(fn)`.
Call `rendered()` when the first view is ready, or `error(message)` when it cannot render. JavaScript receives the
initial data before its source executes. See [STYLE.md](STYLE.md) for the visual contract and keep code's data needs
explicit in `bindings`.

Preview and snapshot are display-only: they never invoke actions. The `capabilities` list is the program's operation
and board-scope allowlist. `hud.action(operation,args)` works only for a listed operation and an authorized resource
scope; bound readings may cross boards, while writes still need a grant for each affected board. A scope is an exact
board ID; `*` is required for global operations (`createBoard`, `importState`, `exportState`, `backup`, `shutdown`,
and `restore`/`purge` with `id:"all"`). The operation argument shapes are:

| operation | `args` |
|---|---|
| `create`, `update`, `push`, `remove` | `{item:{type,title,...}}`; `{id,patch:{...}}`; `{id,reading:{...}}`; `{id}` |
| `restore`, `purge` | `{id}`; `id:"all"` requires `*` |
| `createBoard`, `setBoard`, `deleteBoard`, `organize`, `watch`, `clearBoard` | `{name}`; `{board?,patch}`; `{board?}`; `{board?}`; `{board?,notify}`; `{board?}` |
| `annotate`, `compare`, `ackAlerts` | `{board?,time,text}`; `{board?,rule:{left,right,relation,...}}` or rule fields directly; `{ids:[alertId,...]}` or `{ids:"all"}` |
| `reviewAttention`, `link`, `unlink` | `{id,action,revision,until?}`; `{id,patch}`; `{id,keys:["parent",...]}` |
| `comment`, `ask`, `decide`, `run` | `{id,text,format?}`; `{id,question?,options}`; `{id,optionId,decisionVersion,note?}`; `{id}` |
| `finish` | `{board?,ids?,note?,organize?}` |
| `importState`, `exportState`, `backup`, `shutdown` | `{state,mode:"replace"|"merge"}`; `{}`; `{reason?}`; `{}`; all require `*` |

Omitted `board` uses the program's target board. `hud.action()` resolves to `{result,revision}` and rejects on a broker
or action error. Expose each action in the UI with a clear label and result. Existing
`view:<name>` modules remain trusted filesystem
renderers with their separate contract in [views/README.md](views/README.md); they are not persisted custom programs.

### Agent dashboard workflow

For an MCP-built board, use this sequence:

1. Call `hud_readout` without a board to inspect available board IDs, names, revisions and current metrics. Reuse a
   suitable board or create a clearly named one; pass its explicit ID to every later operation rather than relying on
   the `main` default.
2. Read the board's current dashboard spec with `hud_dashboard {board,action:"get"}` and inspect it with `hud_lint`.
3. Submit the proposed spec with `hud_dashboard {board,action:"set",spec,dryRun:true,expectedRevision}`. Review the
   returned mapping, changes and lint report. Fix errors and resolve material warnings before applying.
4. Apply with the same `expectedRevision`, then run `hud_lint`, `hud_readout {board}` and `hud_snapshot {board}` to
   verify the resulting card IDs, metric references, observations, freshness and comparison states.
5. Report whether the snapshot contains a PNG or text. PNG is portable visual evidence; text is portable textual
   evidence when an image renderer is unavailable. A spec or text snapshot alone does not establish visual verification.

The same operations are available through the local HTTP API: `GET /api/readout?board=...` returns the readout plus
`text`; `POST /api/snapshot` with `{board,format}` returns the snapshot shape above. `GET|PUT /api/boards/:id/dashboard`
(`PUT` takes `{spec,dryRun?,expectedRevision?}`), annotation resources at `/api/boards/:id/annotations`
(`POST {time,text}`, `DELETE {id}`), comparison resources at
`/api/boards/:id/comparisons` (`POST {left,right,relation,tolerance?,holdFor?,maxSkew?}`, `DELETE {id}`),
`GET /api/boards/:id/lint`, and program resources under `GET|POST|DELETE /api/items/:id/program` or
`/api/boards/:id/program` (`POST {action,program?,expectedRevision?}`). Use the API guide served at `GET /api/guide`
for exact request bodies and current routes.

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


## Attention, runs and incremental changes
`hud_attention {action:"list"}` (or `hud attention`) is the human-attention queue for decisions, blocked work, warnings,
errors and stale monitors. It is intentionally separate from `hud_alerts`: reviewing an attention item does not
acknowledge old agent alerts. Use the returned `revision` when calling `hud_attention` with `action:"review"`,
`"unreview"`, or `"snooze"`; snoozing requires `until` as an epoch-millisecond deadline. A changed or stale revision is
rejected so one agent cannot overwrite a newer human-review state.

`hud_runs` lists tickets tagged `run`, their linked monitors/tickets, and the explicit `summaryMonitor` progress/ETA
source. Keep numeric `value` and `progress` in the monitor fields; use the short `message` for a headline and `details`
for a longer Markdown report. Set `staleAfter` or a heartbeat on expected reporters so run freshness is meaningful.
There is no direct job-launch command in the run surface: jobs report into hud through push or heartbeat monitors.

`hud_changes --since <epoch-ms>` (or `GET /api/changes?since=<epoch-ms>`) returns `{since, now, complete, events}`.
Use the returned `now` as the next cursor. MCP renders attention, runs and changes as readable Markdown tables/lists;
the JSON/HTTP responses retain numeric values, progress, and event details.

## Decisions (when you're blocked)
When you need a human to choose, don't just comment — propose options and let them click one.
`hud_ask {id, question?, questionFormat?, options:[{label, detail?, status?}]}` (or `hud ask <id> --option A --option B --question "…"`)
stores the options, marks the ticket `blocked`, and highlights the pending decision in the Attention landing and ticket
sidebar. Each option's `status` is where
the ticket moves when that option is chosen (default `doing`; use `done` for options that finish the work). The question
and option details use `plain` by default or Markdown when `questionFormat: "markdown"`; `hud_ask` returns the current
`decisionVersion`.

The human clicks an option in the ticket sidebar (or `hud decide <id> <optionId> --version <decisionVersion> [--note "…"]`). That records the answer, moves the
ticket to the option's status, adds a `decision:` comment, and **raises an alert to the asking session** — so if you put
your session name in the ticket's `notify` (or the board's), you are woken with the answer. Read it back with `hud_get`.
With no human around you can also answer yourself with `hud_decide {id, optionId, decisionVersion, note?}`. The
`decisionVersion` must match the value returned by `hud_get`/`hud_ask`; an already answered ticket or stale version is a
409 conflict. Never fetch a newer version automatically to bypass this check.

An answer is not an agent response. After the alert, inspect the decision, perform the requested work, and only then
report a response or completion. Creating a follow-up ticket records a request; it does not claim that an agent has
responded.

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
- Respect the human's manual layout; add related items to a group and keep them inside the fixed board.
- Use `group` rather than coordinates; run `hud_organize` after adding a batch of items (or turn on `auto`).
- `hud_arrange` fits the whole board; prefer `hud_organize` for explicit auto/manual control.

## Install hud as an app (macOS, Windows, Linux)
hud ships as a desktop app (Electron shell around the same local server): a real window, a menu-bar/tray icon,
and the CLI + MCP server built into the same binary.

    npm install        # once, for the build tooling
    npm run dev        # run the app against this repo on a scratch port + scratch data dir

    npm run dist       # installers for the current OS -> dist/
    npm run dist:mac   # dmg (arm64, x64)
    npm run dist:win   # nsis installer (x64, arm64)
    npm run dist:linux # AppImage + deb

Prebuilt 0.1.0 downloads are on [GitHub Releases](https://github.com/CodeKnight314/hud/releases/tag/v0.1.0):
macOS arm64/x64 DMGs, Windows x64 installer and Linux x64 AppImage/deb. Release builds are unsigned and not notarized;
macOS may show a first-launch warning. Each OS builds its own artifact, and macOS signing only works on macOS.
`dist/` output is produced by `electron-builder` from `electron-builder.yml`; `npm run bundle` alone just rebuilds
`bundle/hud.mjs` (the CLI + server) with esbuild.

A packaged app keeps its data in the per-user dir (`~/Library/Application Support/hud`, `%APPDATA%\hud`,
`$XDG_DATA_HOME/hud`) and seeds the example probes and renderers into `<data>/probes` and `<data>/views` on first
run. The port and data dir are fixed (one board, one server); the `HUD_*` path/port overrides only apply with `HUD_SCRATCH=1`.

Open **Settings** from the app menu with ⌘, on macOS or File → Settings (Ctrl+,) on Windows/Linux; it is also available
from the tray menu. Connections and update checks are native app features. Saved boards and their backups remain in the
per-user data directory. On startup, a newer app backs up and replaces only its own older packaged server using that
same directory. It refuses to replace a source or other installation, a newer server, or a server reporting a save
error.

### Connections

Settings → **Connections** shows monochrome status glyphs for Claude Code, Codex and OpenCode. **Registered** means
the `hud` MCP entry is saved; it does not mean a client session is currently connected. Connecting or repairing from
the packaged app installs or refreshes its managed stable `hud` command shim, then registers that command in the
client's user-level configuration. Repair also fixes a stale registration that still points to a source checkout.
Disconnect removes only hud's registration. Configuration files are backed up before writes, and existing client
sessions must be restarted or reconnected to load changes.

Use **Copy MCP configuration** for other clients or for manual setup. OpenCode JSONC is detected and left untouched so
its comments are preserved; Settings provides copy/manual instructions. The **Install command** action requires the
packaged app; a source checkout cannot install the app command. Linux AppImage command integration is unsupported; use
the `.deb` package for stable CLI integration. The source CLI also supports:

    hud mcp status [--json]
    hud mcp install [clients...] [--json]
    hud mcp repair [clients...] [--json]
    hud mcp uninstall [clients...] [--json]

`status` is read-only and checks saved registrations; it does not start or handshake with an MCP server. `--json`
returns machine-readable status. Config backups are retained beside the config file.

### Updates

Settings → **Updates** shows the installed version and can check GitHub for the latest stable release. It offers the
matching installer for the app's OS and architecture when that asset exists; **Download update** opens it in the browser,
and **View release** opens the release page. HUD never installs an update automatically: download the installer, quit
HUD and replace the app. The optional **Check when HUD opens** preference enables launch-time checks. The 0.1.1 build
adds this checker; version 0.1.0 has none, so upgrading from it the first time requires downloading the installer
manually.

The native workflow runs for pushes to `release/**` branches and manual dispatches, which build installers on native
OS runners and upload seven-day workflow artifacts. A stable `vX.Y.Z` tag push runs the same four native build jobs
after checking the tag against `package.json`, `appdir/package.json` and both version fields in `package-lock.json`.
After every build and packaged-runtime check passes, CI gathers exactly five named installers (two macOS DMGs, the
Windows installer, Linux AppImage and Linux `.deb`), validates them, writes `SHA256SUMS`, and creates a GitHub draft
release. It does not publish the draft. The update checker ignores drafts and prereleases, so a release appears to
users only after someone reviews and manually publishes it.

For the next release, keep the existing v0.1.0 release unchanged and:

1. Bump the version in `package.json` and `appdir/package.json`, then update `package-lock.json` so all recorded package
   versions agree.
2. Push the matching stable tag, such as `vX.Y.Z`. CI verifies the tag and versions, then creates the draft only after
   all native builds and installer checks pass.
3. Review the draft's five installers, `SHA256SUMS` and generated notes, then publish it manually. Only then can Settings
   find it as the latest stable release.

## Connect your agent
    hud mcp install                 # claude + codex + opencode (skips any that aren't installed)
    hud mcp install claude          # just one
    hud mcp install all --dry-run   # show exactly what would change
    hud mcp status                  # where hud is wired in, and which command is used
    hud mcp uninstall               # remove the hud entry again
    hud mcp print generic           # a snippet to paste into any other client (e.g. muse)

Config files are parsed and backed up before any write, and only the `hud` entry is ever touched.
When run from a packaged binary it registers `<hud> mcp`, so nothing else needs to be on `PATH`.

In the packaged desktop app, Settings → Connections → **Install command** (or `hud cli install`) puts the `hud` command
on your `PATH`; the managed shim points at the app binary, so the CLI and MCP server use the same program. The app
refreshes its managed shim on launch to keep registered client paths valid after normal app replacement.
`HUD_BIN_DIR` chooses where it goes. Linux AppImage builds do not support this command integration; use the `.deb`.
