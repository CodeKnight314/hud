# hud — agent guide

This is the agent contract for MCP, CLI and HTTP. Humans install the app and use Settings, Attention and Tickets
from [QUICKSTART.md](QUICKSTART.md).

hud is a local, live canvas shared between a human and agents. It holds **tickets**, **monitors**,
**notes** and **frames** on one or more **boards**. The product contract — board-enforced leases,
reclaim of a stuck agent, and a parent that owns its decomposition — is [PRODUCT.md](PRODUCT.md).
Everything you change appears instantly in the
human's browser at http://localhost:{{PORT}} and vice versa. The human rearranges things too, so
re-read state (`hud ls` / `hud_overview`) before assuming positions or statuses.

- [Ways in](#ways-in-all-equivalent) · [Tool matrix](#tool-matrix) · [Browser navigation](#browser-navigation) · [Items](#items) ·
  [Projects, tickets and links](#projects-tickets-and-links) · [Coordination](#coordination) ·
  [Shared context](#shared-context) · [Monitors](#monitors) · [Renderers](#renderers) ·
  [Utilities](#utilities) · [Attention, runs and changes](#attention-runs-and-incremental-changes) ·
  [Decisions](#decisions-when-youre-blocked) · [Finishing a run](#finishing-a-run) ·
  [Trash and backups](#trash-backups-and-undo) · [Conventions](#conventions) ·
  [Install and connect](#install-and-connect) · [Connect your agent](#connect-your-agent)

`hud guide` and `GET /api/guide` return this whole document. A table-of-contents anchor reads one part:
`hud guide --section coordination`, `hud_guide {section:"monitors"}`, or `GET /api/guide?section=renderers`. The slice
is that heading and its body, through the line before the next table-of-contents heading. `hud guide --json` and
`GET /api/guide?format=json` list those anchors as `{anchor,title,level}`; with a section they return
`{anchor,title,level,markdown}`. An unknown section is an error whose `sections` list is that table of contents.
`?playbook=` (`decentralized` or `lead`) is a separate optional filter and cannot be combined with `section`.
`hud://guide#<anchor>` reads the same slice.

## Ways in (all equivalent)
- **MCP**: tools `hud_overview`, `hud_tickets`, `hud_search`, `hud_project`, `hud_link`, `hud_create`, `hud_update`,
  `hud_push`, `hud_comment`, `hud_get`, `hud_delete`, `hud_trash`, `hud_backup`, `hud_reveal`, `hud_board`, `hud_organize`,
  `hud_arrange`, `hud_run`, `hud_views`, `hud_watch`, `hud_alerts`, `hud_attention`, `hud_runs`, `hud_changes`,
  `hud_readout`, `hud_snapshot`, `hud_dashboard`, `hud_annotate`, `hud_compare`, `hud_lint`, `hud_graph`,
  `hud_canvas`, `hud_clear_canvas`, `hud_ask`, `hud_decide`, `hud_finish`, `hud_session`, `hud_claim`, `hud_queue`,
  `hud_context`, `hud_attach`, `hud_wait`, `hud_view`, `hud_tree`, `hud_approve_command`, `hud_guide`, `hud_quickstart`. MCP also exposes the
  `hud://guide` and `hud://quickstart` resources. Served guide text rewrites quickstart links to `GET /api/quickstart`.
  Times in tool output are in the machine's local time zone. `source.kind: "command"` does not run until the human
  approves that command and cwd in Attention. Do not set your actor to `user` and do not approve it yourself.
- **CLI**: `hud ls`, `hud add`, `hud set`, `hud push`, `hud project`, `hud tree`, `hud attention`, `hud runs`, `hud queue`, `hud session`,
  `hud claim`, `hud release`, `hud context`, `hud attach`, `hud wait`, `hud view`, `hud changes`, `hud readout`,
  `hud snapshot`, `hud dashboard`, `hud annotate`, `hud compare`, `hud lint`, `hud graph`, `hud canvas`, `hud board clear <id>`,
  `hud comment`, `hud ask`, `hud decide`, `hud finish`, `hud approve`, `hud guide [decentralized|lead] [--section anchor]`, `hud quickstart`, … (`hud help`;
  every command takes `--help`, and `--json` prints machine-readable output). If `hud` is not on PATH use
  `node <repo>/bin/hud.js`. Set `HUD_ACTOR=<your-name>` (or `--as`) so changes are attributed to you.
- **HTTP** (JSON, localhost only; send header `x-hud-actor: <name>`). Malformed input is a 400, an unknown id or board
  a 404; ids may be a `KEY-12` ident.
  - read: `GET /api/summary[?board=]` text overview · `GET /api/readout[?board=]` metrics and evidence ·
    `POST /api/snapshot {board?,format?}` · `GET /api/state` · `GET /api/events` SSE · `GET /api/projects` ·
    `GET /api/tickets[?format=text]` · `GET /api/claims[?session=&board=]` live leases (omit `session` for every lease on the board) · `GET /api/items` · `GET /api/items/:id` (includes `trend` and `uptime`) ·
    `GET /api/items/:id/activity[?limit=]` · `GET /api/activity[?limit=&board=]` · `GET /api/attention` · `GET /api/runs` ·
    `GET /api/changes?since=<epoch-ms>` · `GET /api/views` · `GET /api/guide[?section=<anchor>|?playbook=decentralized|lead]` · `GET /api/quickstart`
  - search filters, on `GET /api/items` and `GET /api/tickets`: `board type status` (comma list) `priority assignee
    owner project tag q overdue=1 parent limit`. `owner` is the claimer while a lease is held, otherwise the
    assignee; `owner=none` (or `-`) matches tickets with neither. An unknown board is a 404.
  - write: `POST /api/items` (one or an array) · `PATCH /api/items/:id` · `PATCH /api/items` (array of `{id,...}`) ·
    `DELETE /api/items/:id` (to the trash) · `POST /api/projects {name,key?,board?,description?,lead?,target?}` ·
    `PATCH /api/projects/:id {name?,key?,description?,lead?,target?,status?}` ·
    `POST /api/tree {action:"move"|"detach",id,parent?,project?}` ·
    `POST /api/items/:id/link {project?,parent?,blockedBy?,refs?,branch?}` ·
    `POST /api/items/:id/unlink {project?,parent?,blockedBy?,refs?}` · `POST /api/items/:id/comments {text,format?}` ·
    `PATCH /api/items/:id/comments/:cid {text,format?}` · `DELETE /api/items/:id/comments/:cid`
  - monitors: `POST /api/monitors/:id/push {value,state,message,messageFormat,details,progress,...}` · `POST /api/monitors/:id/run` ·
    `POST /api/monitors/:id/approve {revision}` (actor `user` only; approves the command currently waiting in Attention) ·
    heartbeat **`/ping/:id`** (see Monitors)
  - decisions and runs: `POST /api/items/:id/ask {question?,questionFormat?,options}` ·
    `POST /api/items/:id/decide {optionId,note?,decisionVersion}` ·
    `POST /api/finish {board?,ids?,note?,organize?,export?,exportAll?}` ·
    `POST /api/runs/:id/export` · `GET /api/runs/exports` · `GET /api/runs/:id/exports` ·
    `GET /api/runs/:id/exports/:name` (zip, or `?format=markdown`)
  - boards: `GET/POST /api/boards` · `PATCH|DELETE /api/boards/:id` (`main` cannot be deleted; a delete goes to the
    trash) · `POST /api/organize {board, auto?}` · `POST /api/arrange {board|frame, ids?, width?}` ·
    `POST /api/boards/:id/clear` (clear canvas while keeping board) ·
    `GET|PUT /api/boards/:id/dashboard` · `GET|POST|DELETE /api/boards/:id/annotations` ·
    `GET|POST|DELETE /api/boards/:id/comparisons` · `GET /api/boards/:id/lint` ·
    `GET|POST|DELETE /api/boards/:id/program` · `GET|POST|DELETE /api/items/:id/program`
  - coordination: `GET|POST /api/sessions` · `POST /api/sessions/:id/heartbeat` · `DELETE /api/sessions/:id` ·
    `GET /api/claims[?session=&board=]` · `GET|POST /api/items/:id/claim` · `DELETE /api/items/:id/claim?session=&reason=` ·
    `GET /api/queue` · `POST /api/context` · `GET /api/context` · `POST /api/context/read` · `GET /api/context/scopes` ·
    `POST /api/wait` · `GET|POST /api/attachments` · `GET /api/attachments/:id` · `GET /api/attachments/:id/content` ·
    `GET /api/attachments/:id/expand` · `DELETE /api/attachments/:id` · `POST /api/attachments/:id/applied`
  - alerts: `GET /api/alerts[?all=1&notify=name&since=]` · `POST /api/alerts/ack {ids?}` · `POST /api/watch {name, ids?, boards?, off?}` ·
    `POST /api/attention/:id {action,revision,until?}` (`review`, `unreview`, `snooze`; review is separate from alert acknowledgement)
  - safety net: `GET /api/trash[?board=]` · `POST /api/trash/:id/restore` · `DELETE /api/trash/:id` and `DELETE /api/trash`
    (permanent) · `GET|POST /api/backups` · `POST /api/backups/:name/restore` · `POST /api/data/reveal` ·
    `GET /api/export` · `POST /api/import {state, mode}`
  - lifecycle: `GET /api/health` (pid, port, mode, dataDir, version, stateVersion, items, `saveError?`, `recoveredFrom?`) ·
    `POST /api/shutdown`
- **TypeScript**: `import { Hud } from '<repo>/src/client.ts'` → `new Hud({actor}).push(id, {...})`. Requests time out
  after 15 s (`HUD_TIMEOUT` ms) and failures throw `HudRequestError` with a `status`.

The server starts automatically the first time the CLI, MCP server or client needs it.

## Tool matrix
MCP, the CLI and HTTP call the same store methods. A `KEY-n` ident is accepted anywhere an id is.

### Projects, trees, claims, context and status

| Operation | MCP | CLI | HTTP |
| --- | --- | --- | --- |
| Create a project | `hud_project {action:"create", name, key?, board?, description?, lead?, target?}` | `hud project new <name> [--key EGO] [--lead @who] [--target date] [--body text]` | `POST /api/projects {name, key?, board?, description?, lead?, target?}` |
| List projects | `hud_project {action:"list", board?}` | `hud project list [--board b]` | `GET /api/projects?board=` |
| Update a project | `hud_project {action:"update", id, name?, key?, description?, lead?, target?}` | `hud project set <id> [--key NEW] [--title t] [--body text] [--lead @who] [--target date]` | `PATCH /api/projects/:id {name?, key?, description?, lead?, target?, status?}` |
| Read a ticket tree | `hud_tree {action:"get", board?, project?}` | `hud tree [board] [--project KEY]` | `GET /api/tree?board=&project=` |
| Move a ticket in the tree | `hud_tree {action:"move", id, parent?, project?}` | `hud tree move <id> [--parent EGO-1] [--project KEY]` | `POST /api/tree {action:"move", id, parent?, project?}` |
| Detach a sub-ticket | `hud_tree {action:"detach", id}` | `hud tree detach <id>` | `POST /api/tree {action:"detach", id}` |
| Set links | `hud_link {id, project?, parent?, blockedBy?, refs?, branch?}` | `hud link <id> parent=EGO-1 ...` | `POST /api/items/:id/link` |
| Clear links | `hud_link` with `parent:""`, `project:""`, `blockedBy:[]` or `refs:[]` | `hud unlink <id> [parent blockedBy refs project]` | `POST /api/items/:id/unlink {parent?, project?, blockedBy?, refs?}` |
| Claim a ticket | `hud_claim {action:"claim", ticket, session?, ttl?, start?, takeover?}` | `hud claim <id> [--session s] [--ttl sec] [--start] [--takeover]` | `POST /api/items/:id/claim {session, ttl?, start?, takeover?}` |
| Renew a lease | `hud_claim {action:"renew", ticket, ttl?}` | `hud claim renew <id> [--ttl sec]` | `POST /api/items/:id/claim` again as the holder |
| Lease on one ticket | `hud_claim {action:"status", ticket}` | `hud claim status <id>` | `GET /api/items/:id/claim` |
| List leases | `hud_claim {action:"list", all?:true, session?, board?}` | `hud claim list [--session s] [--board b] [--all]` | `GET /api/claims?session=&board=` |
| Release a lease | `hud_claim {action:"release", ticket, reason?}` | `hud release <id> [--reason text]` | `DELETE /api/items/:id/claim?session=&reason=` |
| Publish shared context | `hud_context {action:"publish", scope, kind, text}` | `hud context publish --scope s --kind FACT --text t` | `POST /api/context {scope, kind, text}` |
| Read shared context | `hud_context {action:"read", scope?, since?}` | `hud context read [--scope s] [--since n]` | `GET /api/context` or `POST /api/context/read` |
| List context scopes | `hud_context {action:"scopes", board?}` | `hud context scopes [--board b]` | `GET /api/context/scopes?board=` |
| Update ticket status | `hud_update {id, status}` | `hud set <id> <status>` | `PATCH /api/items/:id {status}` |

A lease row is `{ticket, ident, title, board, session, actor, claimedAt, renewedAt, expiresAt, live, sessionLive}`. `live` is the lease itself; `sessionLive` is whether the holder is still present. `hud_claim {action:"list"}` returns this session's leases; pass `all:true` for every lease, or `session` for one holder. `hud claim list` defaults to the CLI session; `--all` lists every lease. `GET /api/claims` has no implicit session, so leaving `session` off lists every lease. MCP list text is at most 60,000 characters, including the omission line. It keeps whole lease lines and says how many were omitted; narrow it with `session` or `board`.

A tree node is `{id, ident, title, status, project?, parent?, children}`. Roots are tickets whose parent is missing from the same board and project filter. `move` with `parent:""` detaches. Cycles and cross-board parents are rejected before anything changes.

### Every other tool

| MCP | CLI | HTTP |
| --- | --- | --- |
| `hud_overview` | `hud ls [board]` | `GET /api/summary` |
| `hud_tickets` | `hud ls tickets` / `hud tickets` | `GET /api/tickets` |
| `hud_search` | `hud find <text>` | `GET /api/items` |
| `hud_create` | `hud add <type>` | `POST /api/items` |
| `hud_get` | `hud show <id>` | `GET /api/items/:id` |
| `hud_delete` | `hud rm <id>` | `DELETE /api/items/:id` |
| `hud_comment` | `hud comment` | `POST / PATCH / DELETE /api/items/:id/comments` |
| `hud_push` | `hud push <id>` | `POST /api/monitors/:id/push` |
| `hud_run` | `hud run <id>` | `POST /api/monitors/:id/run` |
| `hud_watch` | `hud watch <name>` | `POST /api/watch` |
| `hud_alerts` | `hud alerts` | `GET /api/alerts`, `POST /api/alerts/ack` |
| `hud_attention` | `hud attention` | `GET /api/attention`, `POST /api/attention/:id` |
| `hud_runs` | `hud runs` | `GET /api/runs` |
| `hud_changes` | `hud changes --since ms` | `GET /api/changes?since=` |
| `hud_readout` | `hud readout` | `GET /api/readout` |
| `hud_snapshot` | `hud snapshot` | `POST /api/snapshot` |
| `hud_dashboard` | `hud dashboard` | `GET / PUT /api/boards/:id/dashboard` |
| `hud_annotate` | `hud annotate` | `GET / POST / DELETE /api/boards/:id/annotations` |
| `hud_compare` | `hud compare` | `GET / POST / DELETE /api/boards/:id/comparisons` |
| `hud_lint` | `hud lint` | `GET /api/boards/:id/lint` |
| `hud_graph` | `hud graph <item>` | `GET / POST / DELETE /api/items/:id/program` |
| `hud_canvas` | `hud canvas` | `GET / POST / DELETE /api/boards/:id/program` |
| `hud_board` | `hud board` | `GET / POST /api/boards`, `PATCH / DELETE /api/boards/:id`, `POST /api/boards/:id/clear` |
| `hud_clear_canvas` | `hud board clear <id>` | `POST /api/boards/:id/clear` |
| `hud_organize` | `hud organize` | `POST /api/organize` |
| `hud_arrange` | `hud arrange` | `POST /api/arrange` |
| `hud_views` | `hud views` | `GET /api/views` |
| `hud_view` | `hud view` | `GET / PUT / POST / DELETE /api/views` |
| `hud_ask` | `hud ask <id>` | `POST /api/items/:id/ask` |
| `hud_decide` | `hud decide <id>` | `POST /api/items/:id/decide` |
| `hud_finish` | `hud finish` | `POST /api/finish` |
| `hud_session` | `hud session` | `GET / POST /api/sessions`, `POST /api/sessions/:id/heartbeat`, `DELETE /api/sessions/:id` |
| `hud_queue` | `hud queue` | `GET /api/queue` |
| `hud_attach` | `hud attach` | `/api/attachments` |
| `hud_wait` | `hud wait` | `POST /api/wait` |
| `hud_trash` | `hud trash` / `hud restore` / `hud purge` | `/api/trash` |
| `hud_backup` | `hud backup` | `GET / POST /api/backups` |
| `hud_guide` | `hud guide` | `GET /api/guide` |

## Browser navigation
The app opens on the last board. A persistent **left rail** switches **Attention**, **Runs** and boards; the board rows
show their item counts and double-click to rename, and `+` creates one. Attention groups command approvals, current decisions, blocked
work, warnings, errors and stale reporters by board and run. A command card shows the shell and an **approve** button;
review keeps another issue active, it only records human review and does not start a command. Runs lists tickets tagged `run` with their explicit `summaryMonitor`, progress, ETA and linked work. Its
**queue** tab lists open, claimed and done work with owner, live session, blockers and a claim/release action.
The board canvas keeps the same glance in a compact corner widget: the ready count, and each current claim's
session name, ticket and remaining lease, soonest lease first. ● is a live holder with time left on the lease;
○ is an ended session or an expired lease. The holder's name and presence come from the newer snapshot:
the session list only when its time is later than the queue snapshot, and the queue row otherwise.
The corner scrolls instead of dropping claims. Choosing a claim opens that ticket in the inspector and stays on the canvas.
A quiet board with nothing ready and nothing claimed leaves the corner empty.
Completed runs are hidden until **show completed** is selected.

The top bar holds **search** (`⌘/Ctrl+K`), the live actor count, the session popover and the connection pill. Search is
cross-board: titles, ids, UUIDs, ticket idents, bodies and notes. Opening a result switches to its board and opens the
inspector without acknowledging attention or alerts.

While `GET /api/health` reports `saveError` or `recoveredFrom`, a banner sits under the top bar. It is not a toast and
it has no close control: it stays until health stops reporting that field (`saveError` clears on the next successful
save; `recoveredFrom` stays until hud restarts on a readable `state.json`, or until that snapshot is removed from
`backups/`). If health cannot be reached, the banner comes down instead of keeping the last report. **open data dir** reveals the data
directory (`POST /api/data/reveal`, `hud reveal`, `hud_reveal`). **restore** replaces the live board with the recovery
snapshot, or with the newest backup when this process did not recover one (`POST /api/backups/:name/restore`,
`hud backup restore <name>`, `hud_backup {action:"restore", name}`). Restore backs up the current state first.

## Items
Common fields: `id`, `type`, `board` (default `main`), `title`, `group`, `x`, `y`, `w`, `h` (board pixels),
`meta` (free-form object for your own bookkeeping). Dashboard surfaces are fixed **1600 × 900**. Geometry is clamped
to those bounds. The window letterboxes that surface: one scale for both axes, centered, with bars on the longer
side. Card coordinates stay in the 1600 × 900 space when the window changes — do not reflow a board to match the
window. Auto layout is on by default; omit coordinates and let hud place and size visual cards.

**Tickets are list objects, not canvas cards.** Use **Tickets** (or `l`) to search and manage them; clicking a row opens
the inspector. Done and canceled tickets are hidden by default; **completed** reveals them, and an explicit status
filter or search also finds them. The canvas shows monitors, notes, utilities and their frames. Double-click any
visual card to open the inspector. Ticket-only frames and projects do not take canvas space. Ticket-heavy boards
initially open the list; view choice is remembered per board. Ticket identities, groups and relationships remain
shared with agents. Never size or position tickets to improve visual layout.

Tickets have an immutable `uuid`. New ticket ids are UUIDs unless a custom id is supplied. Existing ids and
`KEY-n` identifiers remain valid; existing tickets gain a UUID alias without breaking links. Use the SVG copy
button beside a ticket identifier in the inspector, then paste the UUID into MCP, CLI, or HTTP anywhere a ticket id
is accepted. `hud_get` returns the full UUID.

### Details sidebar
Opening an item shows one scrolling **inspector** with **overview**, **activity** and **settings** sections, plus jump
links at the top; the source inspector for a board opens in the same place from the rail. There are no tabs. The
inspector can be resized with its grip or keyboard: it stays between **360 px** and **900 px**, capped by the window
width, and the chosen width is remembered in that browser. Overview carries the current report, linked run, decision,
claim and the shared-context timeline; activity carries readings, report history and the audit log; settings edits fields and
configuration. Resizing or opening details does not move cards or acknowledge attention.

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
- Keep overview cards readable. If the board gets crowded, create separate boards per run or experiment.
  The board opens letterboxed into the window. Fit (`.`) returns to that view; zoom-out stops at Fit, zoom-in
  at 300% (or Fit on an unusually large display), and panning cannot lose the board. A remembered zoom above
  that letterbox is discarded on open. A camera at or under the fit keeps its pan, clamped so the board stays visible.
  Switching boards closes the inspector first and keeps that pan. Resizing the window, or returning to the board,
  refits a centered letterbox only; a kept pan or a zoom stays. Coming back from the ticket list with the
  inspector still open uses that full-window camera, then fits a centered letterbox into the remaining strip.

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
    hud_project {action: "list", board?}
    hud_project {action: "update", id: "EGO", name?, key?, description?, lead?, target?}
    hud_tree    {action: "get", board?, project?}                 # nested {id, ident, title, status, children}
    hud_tree    {action: "move", id: "EGO-3", parent?: "EGO-1", project?: "EGO"}
    hud_tree    {action: "detach", id: "EGO-3"}                   # clear parent; project membership stays
    hud_tickets {board?, status?, assignee?, owner?, project?, tag?, priority?, overdue?, limit?}   # list, or format:"json"
    hud_search  {text?, board?, type?, status?, assignee?, owner?, project?, tag?, priority?, overdue?, limit?}
    hud_create  {type: "ticket", title: "…", project: "EGO"}
    hud_link    {id: "EGO-3", project?, parent?, blockedBy?, refs?, branch?}
    hud_update  {id: "EGO-3", status: "doing"}

`hud_create`/`hud_update` also accept `project`, `parent`, `blockedBy`, `refs` and `branch` directly, so one call can
create a ticket already in its place. Anything that takes an item id also accepts a `KEY-12` ident (resolved as exact id, then `KEY-n`, then `#n`/`n` among
loose tickets on the board). Rename a project's key with `hud_project {action:"update", id, key}`, `hud project set <id> --key NEW`, or `PATCH /api/projects/:id`. Tickets keep their numbers and their idents follow the new key.

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

The human reads the same structure in the **Tickets view** (or press `l` on a board). The human walkthrough — chips,
list/tree/board, the completed filter — is [Tickets](QUICKSTART.md#tickets). Project chips switch
the view to one project (or all of them); the project filter does the same. **list** groups by status, **tree**
nests sub-tickets under their parents, and **board** is a column per status. Every task shows its assignee
(`→name`) and its live claimer (`⊕name`); a dash means that side is unset. `＋` beside a status adds a ticket
inline. `hud ls tickets` prints the same ownership on each line. Filter that list with `project` and `owner`:
`owner` is the claimer while a lease is held, otherwise the assignee, and `owner=none` (or `-`) matches tickets
with neither.

## Coordination
Several agents can work one board without a coordinator. hud tracks **who is live** and **what each agent has taken**;
the agents decide the work.

    hud_session {action: "start" | "heartbeat" | "end" | "list", name?, kind?, run?}
    hud_queue   {board?, status?, project?, assignee?, owner?, includeDone?, limit?}
    hud_claim   {action?: "claim" | "renew" | "release" | "status" | "list", ticket?, session?, ttl?, start?, takeover?, reason?, board?, all?}

- **Presence is automatic.** An MCP client registers a session on `initialize` and renews it every 20 s; the framework
  records the session, never the agent. A session that stops renewing expires after 90 s, and its claims are released.
  `hud_session {action:"list"}` (or `hud session list`) shows name, kind, age and claims.
- **A claim is an exclusive lease.** `hud_claim {ticket:"EGO-3"}` succeeds for the first caller and returns a 409 with
  `code:"claimed"` for everyone else. Leases last 120 s by default (15–900 via `ttl`); renew by calling `claim` again,
  or rely on the session heartbeat. One session holds at most one unfinished claim, so two agents cannot silently grab
  the same work. `start: true` also moves the ticket to `doing`; it is refused while the ticket is blocked.
  `hud_claim {action:"status", ticket}` and `GET /api/items/:id/claim` return the lease (`expiresAt`, `live`,
  `sessionLive`) or null when the ticket is free. `hud_claim {action:"list"}` lists this session's leases; pass
  `all:true` for every lease, or `session` for one holder. `GET /api/claims` lists every lease unless `session` is set.
  MCP list text is at most 60,000 characters, including the omission line. It keeps whole lease lines and says how many
  were omitted; narrow with `session` or `board`. `release` takes an optional `reason`.
- **Ownership is explicit.** A live lease is never stolen, even with `takeover: true`. `takeover` only applies to a claim
  whose session is no longer live; an expired lease is released automatically. A ticket's `assignee` is durable human
  ownership: an agent cannot claim work assigned to someone else.
- **Claims end with the work.** Finishing, canceling, trashing, clearing or deleting the board releases the lease.
  Reopening a finished ticket does not restore it. Assigning the ticket to someone else releases it too.
- **The queue is the read model.** `hud_queue` returns `open`, `claimed` and `done` rows with owner, live session state,
  blockers and a `ready` flag (open, unblocked, unclaimed). Sort order is ready first, then priority, then recency.
  `hud_queue {includeDone: true}` includes finished tickets. Each claimed row names the holding session. The board
  canvas shows that ready count and each claim's session name, ticket and lease time without opening Runs.

Two coordination policies use the same primitives. Each has a copy-paste playbook — claim, publish a FACT, wait,
finish — plus what to do on an expired lease, a blocked ticket, and an assignee conflict. Fetch that playbook on its
own:

    hud guide decentralized          # every agent pulls ready work; no lead
    hud guide lead                   # one lead links and assigns; the others pull
    hud_guide {playbook: "decentralized"}
    GET /api/guide?playbook=lead

`centralized` is an alias of `lead`. The playbook is the procedure. The primitives above are the reference.

- **Decentralized:** every agent calls `hud_queue`, picks a `ready` row, claims it with `start: true`, publishes a
  FACT, waits when a peer holds the next fact, and finishes. No planner.
- **Lead:** a lead creates sub-tickets with `parent` and `blockedBy`, pre-assigns `assignee` where ownership is
  fixed, and leaves the rest in the queue for pull. Workers run the worker loop in the lead playbook. The lead's
  waits show up as blocked or claimed rows.

## Shared context
The queue says *what* to do; the shared context records *what was learned*. It is an append-only log scoped to a
**run**, a **project** or a **board**, and agents read only what changed since their last read.

    hud_context {action: "publish", scope: "run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80", kind: "FACT", text: "…", refs?, data?, attachments?, corrects?}
    hud_context {action: "read", scope: "run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80", since?, kind?, limit?, mark?}
    hud_context {action: "scopes", board?}

- **Scopes:** `run:<uuid>` is `run:` plus the ticket's `id` from `hud_get` (a uuid; the example above is the shape), and
  that ticket must be tagged `run`. `project:<id>` is the project item's id. `board:<board id>` is the board id
  (`board:main`). Claim, link, wait and finish take a `KEY-n` ident such as `EGO-1`; the scope takes the uuid. The board is
  derived from the scope, so entries never drift across boards. A lead FACT on `run:<uuid>` is not included in a
  `board:main` read — list scopes, or `hud_get` the run ticket, and read `run:<uuid>`. A finished run (`done` or
  `canceled`) keeps the tag and the scope log. The playbooks follow lead only while that ticket is open (`backlog`,
  `todo`, `doing`, `review`, or `blocked`).
- **Kinds:** `FACT` is a finding supported by observations; `FAIL` is an approach or hypothesis that was contradicted,
  with the conditions under which it failed; `SUMMARY` is the state of a finished or handed-off piece of work;
  `STATUS` is a short progress note. Facts and failures are what let a peer skip a dead end.
- **Append-only.** There is no edit or delete. Correct an entry by publishing a new one with `corrects: "<entry id>"`.
  Readers see both, so the correction is visible without erasing the history.
- **Delta reads.** Every entry has a monotonically increasing `seq`. `read` with `since: <seq>` returns only newer
  entries; omit `since` and a session's cursor is used, advancing it when `mark` is true (the default). `cursor` in the
  response is the value to pass next time. `complete: false` or `truncated: true` means older entries were pruned or a
  limit cut the result — read again with the returned cursor.
- **Bounds.** Text is at most 4 KB, `data` at most 8 KB, up to 50 refs and 50 attachments. Retention keeps the newest
  10,000 entries globally and 2,000 per scope. A session may publish at most 60 entries per minute. That pruning is
  why a finished run should be snapshotted: `hud context export <run>` (`hud_context {action:"export", scope:"run:<id>"}`,
  `POST /api/runs/:id/export`) writes `backups/context-<id>-<YYYYMMDD-HHMMSS>.zip`. The zip contains `context.md`
  (the run's context entries) and the attachment files for that scope, including files a context entry references.
  The run ticket has to be `done` or `canceled`. An unfinished run is 409 `unfinished`. The snapshot includes
  every retained context entry for that run, not one page of a delta read. A missing file is named in `missing`
  and in the markdown, and its bytes are left out. If the file on disk does not match the stored sha256 or size,
  the zip packs those bytes and the markdown's sha256 and size are the packed file. The live log is
  not deleted. `hud context exports [run]` lists the files. `GET /api/runs/:id/exports/:name?format=markdown` returns
  the report. These zips are not part of the 30 state-backup rotation.
- **What not to publish.** No routine restatements of the ticket description, no whole file dumps (use attachments),
  and no claims that a check passed without the evidence. Peers rely on these entries to choose work, so scope them:
  say what you measured, on which inputs, and what remains unverified.

The run inspector and the project inspector show that scope as a timeline, not a raw log. Each entry is labeled
**FACT** (a finding), **FAIL** (a dead end), **SUMMARY** (a handoff) or **STATUS** (a progress note), with who wrote it
and when. Filter chips narrow the list. A read is oldest-first and one page can omit the newest entries, so the
inspector follows the cursor until every retained entry for that scope is loaded. **copy for handoff** puts the
standing findings, the dead ends and the latest handoff on the clipboard only when that forward read is complete; it
refuses while newer entries are still missing. A read that stops short is not kept, so the next look fetches again.
An entry that a later one corrects is listed under Corrected. A ticket that is not a run shows
its project's timeline, or the board timeline when it has no project. Agents remain the primary writers. Context
entries never appear in `/api/state` or item SSE payloads — fetch them explicitly.

### Attachments
Publish a file by reference so peers can inspect it without pasting it into the context log.

    hud_attach {action: "add", path: "/abs/notes.md", scope: "run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80", baseId?, baseSha256?}
    hud_attach {action: "list", board?, scope?}
    hud_attach {action: "get" | "content" | "expand" | "delete", id}
    hud_attach {action: "apply", id, target: "/abs/notes.md", expectedSha256?, mode?: "overwrite" | "create"}

- **Bytes live outside `state.json`** under `<dataDir>/attachments/<board>/<id>/<name>`, with only metadata in state.
  Files are capped at 2 MB; a board holds at most 500 records and a scope at most 100.
- **Publish a version, then a diff.** The first version is the original. Publish a later version with `baseId` and
  `baseSha256`; `expand` then returns a unified diff against that base, not against your current file.
- **Apply is local and deliberate.** `apply` runs in the agent's process (MCP/CLI), not on the server. It writes only
  an absolute regular-file target, refuses symlinks, backs up the old file to `<target>.hud-backup-<timestamp>`, and
  checks the hash you based your work on. If the target has changed, it returns 409 `conflict` with the actual hash;
  re-read and reconcile instead of forcing the write.
- **References are protected.** An attachment referenced by a context entry cannot be deleted without `force: true`.

### Waiting for peers
    hud_wait {scope?: "run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80", ticket?: "EGO-3", sessions?: ["agent-b"], kinds?, since?, timeoutSeconds?, includeSelf?}
    hud wait --scope run:3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80 --timeout 20

`hud_wait` blocks (up to 25 s) and returns on the first matching event instead of sleeping and polling. Give it at
least one selector — a scope, a ticket or peer session names — so unrelated activity never wakes it.

- **Wait for a finding:** `hud_context read` first, then `hud_wait {scope, since: cursor}` returns as soon as a peer
  publishes, and the response includes the entry.
- **Wait for a blocker:** `hud_wait {ticket: "EGO-3"}` returns on that ticket's claim, reference or item change.
- **Wait for a claim to free:** `hud_wait {scope: "board:main", kinds: ["claim"]}`.
- **Wait for a peer to end:** `hud_wait {sessions: ["agent-b"]}`.

Own-session events are excluded unless `includeSelf` is set. The MCP call blocks that session's serialized tool chain
for the duration, so keep `timeoutSeconds` at 20 rather than the maximum. Default kinds are `context`, `claim` and
`session`; `item` can be requested explicitly.


## Monitors
Built-in templates (`hud add monitor --template`, Settings → Templates, `GET /api/monitor-templates`) are the Disk template, TLS template, HTTP template, and Cron heartbeat template below. Their defaults do not run a shell command, and an override cannot change a template's source kind into one.

`source.kind` decides how a monitor is updated:
- `manual` — edited by hand or via `hud_update` / push.
- `push` — an external process reports: `POST /api/monitors/<id>/push`, `hud push <id> …`, `hud_push`, or the TS client.
  Pushing to an id that doesn't exist creates the monitor. Set `staleAfter` (s) to flag silence. Keep `message` a short
  headline and put a longer Markdown report in `details` (up to 20 KB); `messageFormat` is `plain` by default and may be
  `markdown`.
- `command` — `{kind:"command", command, cwd?, interval?=30, timeout?=30}` runs in a shell. A command written by the
  human in the browser (actor `user`) is approved by that edit. A command created or changed by anyone else, including
  an agent, the CLI, or a custom program, does not run until the human approves it in Attention. The gate is the
  command and cwd: changing either asks again; changing interval or timeout does not. Approval is
  `POST /api/monitors/:id/approve {revision}` with actor `user` and the current Attention revision (`hud approve <id>
  --revision v` does the same, and is refused for any other actor). Reviewing or snoozing the Attention card does not
  start the command. stdout that is a JSON
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

### Disk template
`hud add monitor --template disk` watches the percent of the local filesystem in use (`probes/disk.ts`, path `/`). It is a read-only probe: no shell command. Defaults: interval 60s, warn above 80%, error above 95%. Override the path with `--source.config.path /var`.

### TLS template
`hud add monitor --template tls --host example.com` reports days until that host's certificate expires (`probes/tls.ts`). The template has no default host, so nothing is contacted until you set `--host` or `--source.config.host`. Defaults: port 443, warn under 14 days, error under 3 days, interval 1 hour.

### HTTP template
`hud add monitor --template http` sends a GET to `http://127.0.0.1/` and reports latency in milliseconds. The default URL is loopback-only and has no request body. Point it at a local service with `--source.url http://127.0.0.1:8080/health` (`127.0.0.1`, `localhost`, or `::1`, http or https). Overrides cannot switch this template to a shell command, change the method, send a body, or point the URL off loopback. Warn above 1000 ms, error above 5000 ms.

### Cron heartbeat template
`hud add monitor --template cron-heartbeat` expects a daily ping (`source.kind` `heartbeat`, period 86400, grace 3600). hud does not run the job. A missing ping for 25 hours marks the monitor error. A cron line pings it:

    curl -fsS "http://127.0.0.1:{{PORT}}/ping/<id>"

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
and `hit(px, py, value, label)` registers a point for the hover readout. Keep series neutral (opacity, not extra hues)
and size to `w`/`h`. See `views/README.md`, `views/bullet.js` and [STYLE.md](STYLE.md). A module that throws shows its error in its own
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
    label.setAttribute('x', '8'); label.setAttribute('y', '18'); label.setAttribute('fill', hud.theme.foreground);
    label.textContent = m ? m.title + ': ' + (m.value ?? '—') + ' ' + m.unit : 'waiting for gpu-memory-used';
    svg.append(label);
    if (m && typeof m.value === 'number') {
      const max = Math.max(1, Number(m.max) || m.value), x = 8, y = Math.round(height / 2), w = width - 16;
      const rail = document.createElementNS(ns, 'rect');
      rail.setAttribute('x', x); rail.setAttribute('y', y); rail.setAttribute('width', w);
      rail.setAttribute('height', '8'); rail.setAttribute('fill', hud.theme.muted); rail.setAttribute('fill-opacity', '0.35');
      const bar = document.createElementNS(ns, 'rect');
      bar.setAttribute('x', x); bar.setAttribute('y', y);
      bar.setAttribute('width', w * Math.max(0, Math.min(1, m.value / max)));
      bar.setAttribute('height', '8'); bar.setAttribute('fill', hud.theme.foreground);
      svg.append(rail, bar);
      const provenance = document.createElementNS(ns, 'text');
      provenance.setAttribute('x', '8'); provenance.setAttribute('y', height - 8);
      provenance.setAttribute('fill', hud.theme.muted); provenance.setAttribute('font-size', '10');
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
      root.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;padding:16px;background:#0e1218;color:#e6ebf2;font:13px/1.45 ui-sans-serif,system-ui,sans-serif';
      for (const id of ['gpu-memory-used', 'worker-count']) {
        const m = hud.data.byId[id];
        const card = document.createElement('section');
        card.style.cssText = 'border:1px solid rgba(232,238,248,.16);border-radius:10px;background:#1e2530;padding:12px;min-width:0';
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
| `finish` | `{board?,ids?,note?,organize?,export?,exportAll?}` |
| `importState`, `exportState`, `backup`, `shutdown` | `{state,mode:"replace"|"merge"}`; `{}`; `{reason?}`; `{}`; all require `*` |

Omitted `board` uses the program's target board. `hud.action()` resolves to `{result,revision}` and rejects on a broker
or action error. Expose each action in the UI with a clear label and result. Existing
`view:<name>` modules remain trusted filesystem
renderers with their separate contract in [views/README.md](views/README.md); they are not persisted custom programs.

### Generated views
For a reusable chart that follows one of the standard shapes, generate a view module instead of hand-writing HTML.

    hud_view {action: "generate", name: "latency-bar", spec: {kind: "bar", series: "categories", unit: "ms"}, write: true}
    hud_view {action: "write", name: "latency-bar", code: "<module source>"}
    hud_view {action: "approve", name: "latency-bar", proposalId: "<id from write>", sha256: "<sha256 from write>"}
    hud_view {action: "validate", name: "latency-bar"}
    hud_view {action: "list" | "get" | "delete", name?}
    hud set <monitor> --display "view:latency-bar"

`spec.kind` is one of `bar`, `line`, `sparkline`, `gauge`, `bullet`, `scatter`, `heatmap`, `table` or `slo`.
`series` is a dot path into `meta` (or omitted for history/table reads); `unit`, `max`, `targets`, `thresholds` and
`maxRows` shape the output. `generate` returns the code and its validation; add `write: true` to install that
generated module in the views directory, and `display` to point a monitor at it in one step. `write` (and
`hud view set`) is for caller-supplied source: it returns a review diff and does not install the file. `approve`
installs the staged bytes when `proposalId` and `sha256` match that review. A review expires after 15 minutes.
A write that also sets `approve` does not skip the review. `hud_view` write does not stage a proposal when the full
diff does not fit in the tool result, so a truncated review cannot be approved.

- **Validation is two-stage.** Static checks reject imports, network/storage access, `eval`, script/iframe tags and
  inline handlers, then compile the module without executing it. `validate` also renders it in a headless Electron
  window against a fixture, so a blank or throwing renderer is caught before it reaches a card.
- **Trust boundary.** Views execute unsandboxed in the board page. Generated modules are installed by hud itself.
  Caller-supplied and other remote modules cannot land until their review diff is approved. Publish a view as an
  attachment and inspect it before staging it. Sandboxed custom programs (`hud_graph`/`hud_canvas`) are the right tool
  for untrusted or data-heavy UI.
- **Native alternatives.** `bullet` (value against warn/error ticks and a target) and `waterfall` (categorical
  contributions to a total) are built in, so an agent can use `display: "bullet"` with `max`/`warnAbove`/`target`
  without generating a module.

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
`hud_attention {action:"list"}` (or `hud attention`) is the human-attention queue for command approvals, decisions,
blocked work, warnings, errors and stale monitors. The inbox UI is [Attention](QUICKSTART.md#attention). It is
intentionally separate from `hud_alerts`: reviewing an attention item does not acknowledge old agent alerts, and
reviewing a `command` item does not approve or start the shell. Use the returned `revision` when calling
`hud_attention` with `action:"review"`,
`"unreview"`, or `"snooze"`; snoozing requires `until` as an epoch-millisecond deadline. A changed or stale revision is
rejected so one agent cannot overwrite a newer human-review state. The human approves a pending command in the Attention
UI (or `POST /api/monitors/:id/approve` as actor `user`).

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
When you're done, call `hud_finish {board?, ids?, note?, export?, exportAll?}` (`hud finish [--export] [--all]`). It marks the named items complete and tidies
the board (re-runs organize) so the canvas ends up clean. Pass `organize: false` to leave the layout alone. With no `ids` it only completes items you created or are assigned, and
only push/manual monitors; it never touches tickets awaiting a decision, `canceled` tickets or other actors' work.
Finishing releases your claim on those tickets. If you coordinated with peers, publish a final `SUMMARY` entry before
finishing so the next session can start from what you learned. `export: true` (`--export`) snapshots each run ticket this call marks `done`, to
`backups/context-<id>-<ts>.zip`. It does not walk back through runs that are already finished. Pass `ids` to snapshot those runs as well, including one that is already `done` or `canceled` (`hud finish <id> --export`, or `hud context export <id>` after the fact). `exportAll: true` (`--export --all`) snapshots every `done` or `canceled` run you created or are assigned on the board, and leaves a canceled run `canceled`. The response includes `exports`. The same snapshot is `hud context export <run>`
after the run is finished.

## Trash, backups and undo
Nothing is deleted outright. `hud_delete` / `hud rm` / `DELETE /api/items/:id` move the item to the **trash**
(deleting a board trashes its items plus the board; `main` cannot be deleted). `hud_trash {action:"list|restore|purge"}`
(`hud trash`, `hud restore <id>`, `hud purge <id>|--all`) brings things back, recreating the board if needed and dropping
links that no longer resolve; only `purge` deletes for good. The trash keeps 500 entries for 30 days. The UI's `u` /
⌘Z undoes a delete the same way. Trashing or clearing a board releases its claims. Sessions and claims are runtime
state: they are not exported, and a restart starts with none. Shared context and attachment metadata are exported;
attachment bytes live under `<data>/attachments` and are copied with a state backup only when you copy that directory too.
A finished-run snapshot (`backups/context-<id>-<ts>.zip`) is the copy that keeps those bytes with the context report.

State is backed up to `<data>/backups/state-<YYYYMMDD-HHMMSS>[-reason].json` on server start (before migrations),
before an import or board delete, and hourly; the newest 30 are kept. `hud backup [--list] [--reason r]`,
`hud_backup`, `GET|POST /api/backups`. `hud export [file]` / `GET /api/export` dump the whole state; `hud import <file>
[--merge]` / `POST /api/import {state, mode:"replace"|"merge"}` load one (replace takes a backup first). A corrupt
`state.json` is moved aside as `state.json.corrupt-<ts>` and the newest valid backup is loaded; `GET /api/health` then
reports `recoveredFrom`, and `saveError` if saving is failing (it is retried every 2 s). `recoveredFrom` is cleared
once that snapshot is no longer in `backups/` (only the newest 30 are kept). The desktop board repeats
either field in a persistent banner and hides it when health cannot be reached (see Browser navigation). `hud backup restore <name>` / `POST /api/backups/:name/restore`
loads one snapshot in replace mode. `hud reveal` / `POST /api/data/reveal` opens the data directory. Only one server may use a data
dir (`hud.lock`); a second one refuses to start.

## Conventions
- Start with `hud_overview`. Reuse existing boards/frames/tickets instead of duplicating them.
- One board per project or area; frames for sub-areas (e.g. "CI", "Release 1.4", "Agent: claude").
- When several agents work the same board, follow one playbook (`hud guide decentralized` or `hud guide lead`).
  Take one claim at a time, publish a `FACT` as soon as it can unblock a peer, and release or finish the claim when you stop.
- Track your own work as tickets: set `status: doing` when you start (or claim with `start: true`), `hud_comment`
  progress notes, `done` when finished, `blocked` with a comment saying what you need from the human — and if you are
  waiting on another *ticket*, set `blockedBy` instead so it clears itself when that ticket finishes.
- Prefer a typed context entry over a long comment when the finding should outlive the ticket: `FACT` for evidence,
  `FAIL` for a dead end with its conditions, `SUMMARY` for a handoff.
- For long tasks, push a progress monitor (`hud_push id=<task> progress=… message=…`), and `state: done` at the end.
- Link tickets to the monitors that track them (`monitors`, `autoStatus`), and `hud_watch` the monitors you're
  responsible for so you're woken instead of polling.
- Give monitors meaningful ids (`ci-main`, `disk-root`) so scripts can push to them.
- Respect the human's manual layout; add related items to a group and keep them inside the fixed board.
- Use `group` rather than coordinates; run `hud_organize` after adding a batch of items (or turn on `auto`).
- `hud_arrange` fits the whole board; prefer `hud_organize` for explicit auto/manual control.

## Install and connect

Humans install hud from a terminal and use the board, Attention and Tickets in a browser — see
[QUICKSTART.md](QUICKSTART.md). This file is the agent contract. The install serves the quickstart at
`GET /api/quickstart` (`hud quickstart`, `hud_quickstart`); `GET /api/guide` and `hud guide` rewrite the relative links
in this file to that URL.

Releases live on [GitHub Releases](https://github.com/CodeKnight314/hud/releases/latest).
`scripts/install.sh` (POSIX) and `scripts/install.ps1` (Windows) fetch the latest stable release tarball, check it against that
release's `SHA256SUMS`, and write `~/.hud/app` (the bundle) plus `~/.hud/bin/hud` (the launcher). Node.js 18 or newer
is the only prerequisite. Nothing is code-signed and no app bundle is shipped, so there is no Gatekeeper or SmartScreen
step and no installer to trust.

    hud                                start the server if needed, open the board in the browser
    hud status                         pid, port, mode, data dir, save health
    hud stop | reveal                  stop the server / open the data dir
    hud update [--check]               verified in-place update of ~/.hud/app
    hud mcp install | status | print | uninstall
    hud serve                          run the server in the foreground
    hud quickstart | hud guide [--section anchor | decentralized | lead]

The installed bundle runs the same local server the CLI and MCP use. It keeps data in the per-user directory
(`~/Library/Application Support/hud`, `%APPDATA%\hud`, `$XDG_DATA_HOME/hud` or `~/.local/share/hud`) and seeds example
probes and renderers into `<data>/probes` and `<data>/views` on first run. The port and data directory are fixed
(one board, one server); `HUD_*` path and port overrides apply only with `HUD_SCRATCH=1`. `HUD_HOME` moves the install
directory. This tree's version is 0.3.0 (`package.json`, `appdir/package.json`, both `package-lock.json` fields);
`hud version` prints it.

### Connections

`hud mcp install` registers the installed launcher (`~/.hud/bin/hud`) with Claude Code, Codex and OpenCode, so a client
never depends on `PATH`. `hud mcp status` is read-only: saved registrations, not live sessions. `hud mcp repair`
refreshes an entry, including one that still points at a source checkout, and `hud mcp uninstall` removes only hud's
entry. Configuration files are backed up before writes, and existing client sessions must be restarted or reconnected
to load changes.

    hud mcp status [--json]
    hud mcp install [clients...] [--json]
    hud mcp repair [clients...] [--json]
    hud mcp uninstall [clients...] [--json]
    hud mcp reconnect [--dry-run] [--json]

`--json` prints machine-readable status. Config backups stay beside the config file.

### Updates

    hud update --check    report the latest stable release without changing anything
    hud update            download, verify SHA256SUMS, swap ~/.hud/app, restart a running server

Drafts and prereleases are ignored, so a version appears only after a person publishes it. The swap keeps the old tree
until the new one is in place, and the data directory is untouched. An update writes `reconnect.json` beside the board
with the clients connected at that moment, so the next start offers a one-shot reconnect checklist: `hud status` prints
it, and `hud mcp reconnect` prints it and clears the reminder (`--dry-run` prints it and keeps the reminder). In Claude
Code the step is `/mcp`; restart Codex and OpenCode so they respawn the MCP process. A missing client version or `0.0.0`
is not a different build, and a client already on the server's version drops off the list.

The release workflow runs `npm test` on Linux, macOS and Windows, then builds one tarball (`scripts/pack-cli.mjs`: the
esbuild bundle plus `web/`, `views/`, `probes/` and the shipped docs), writes `SHA256SUMS`, and smoke-tests the installer
against it. A stable `vX.Y.Z` tag also creates a GitHub draft release with `hud-<version>.tar.gz`, `SHA256SUMS`,
`install.sh` and `install.ps1`; it does not publish that draft, and nothing is signed.

For v0.3.0, leave every published stable release unchanged. The four version fields already agree at 0.3.0.
Merging does not create a tag or a GitHub release.

1. A person pushes the stable tag `v0.3.0`. CI verifies the tag against the four version fields, runs the test
   matrix, and builds the tarball.
2. CI validates the tarball, its checksums and both install scripts, then creates a draft release. It does not publish it.
3. Review the draft's four assets and generated notes, then publish it manually. Only then does `hud update` offer 0.3.0.

## Connect your agent
    hud mcp reconnect               # one-shot checklist after an update; clears the reminder
    hud mcp install                 # claude + codex + opencode (skips any that aren't installed)
    hud mcp install claude          # just one
    hud mcp install all --dry-run   # show exactly what would change
    hud mcp status [--json]         # read-only: saved registrations, no MCP handshake
    hud mcp repair [clients...]     # refresh an entry, including one that still points at a source checkout
    hud mcp uninstall               # remove the hud entry again
    hud mcp print generic           # a snippet to paste into any other client (e.g. muse)

**Registered** means the `hud` entry is saved. It does not mean a client session is connected. Config files are parsed
and backed up before any write, and only the `hud` entry is ever touched. Backups stay beside the config file.
Disconnect removes that entry and nothing else. OpenCode JSONC is detected and left untouched so its comments survive;
use `hud mcp print` and edit it by hand. `--json` on `status`, `install`, `repair` and `uninstall` prints
machine-readable status. Install registers the absolute launcher path, so nothing needs to be on `PATH`. Existing client sessions must be
restarted or reconnected after a change.

In the packaged desktop app, Settings → Connections → **Install command** (or `hud cli install`) puts the `hud` command
on your `PATH`; the managed shim points at the app binary, so the CLI and MCP server use the same program. The app
refreshes its managed shim on launch to keep registered client paths valid after normal app replacement.
`HUD_BIN_DIR` chooses where it goes. An AppImage install points the shim at that `.AppImage` file; reinstall the
command after moving the file. The `.deb` install points at the binary the package owns.
