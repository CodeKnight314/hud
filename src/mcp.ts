/**
 * MCP server (stdio, newline-delimited JSON-RPC) exposing hud to any MCP-capable agent harness.
 *   claude mcp add hud -- node /path/to/dashboard/src/mcp.ts
 *   codex mcp add hud -- node /path/to/dashboard/src/mcp.ts
 * Starts the hud server in the background if it isn't running.
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Hud } from './client.ts';
import { applyAttachment } from './apply.ts';
import { asset } from './assets.ts';
import { line } from './summary.ts';
import type { Item, QueueResult } from './types.ts';
import { formatAgentViewReview, VIEW_REVIEW_MAX_CHARS } from './views.ts';

const VERSION = JSON.parse(asset('package.json', 'utf8') ?? '{"version":"0.0.0"}').version;

const baseHud = new Hud({ actor: process.env.HUD_ACTOR ?? 'agent' });

const ITEM_FIELDS = {
  title: { type: 'string' },
  board: { type: 'string', description: 'board id (default "main")' },
  group: { type: 'string', description: 'frame title to live in (created if missing); "" ungroups. Prefer over frame/x/y' },
  frame: { type: 'string', description: 'frame id to place the item inside' },
  x: { type: 'number' },
  y: { type: 'number' },
  w: { type: 'number' },
  h: { type: 'number' },
  body: { type: 'string', description: 'ticket: markdown description' },
  status: { type: 'string', description: 'ticket: backlog|todo|doing|review|blocked|done|canceled (aliases like "in progress" accepted)' },
  priority: { type: 'string', description: 'ticket: low | med | high | urgent' },
  assignee: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' } },
  text: { type: 'string', description: 'note: markdown. sheet/util: tab-separated rows' },
  kind: {
    type: 'string',
    enum: ['timer', 'stopwatch', 'clock', 'counter', 'calculator', 'sheet', 'markdown', 'dice'],
    description: 'util: which utility this is',
  },
  util: { type: 'object', description: 'util: per-kind state, e.g. {seconds:300} timer, {step,target} counter, {rows,cols} sheet' },
  source: {
    type: 'object',
    description:
      'monitor source: {kind:"manual"} | {kind:"push"} | {kind:"heartbeat", period?, grace?} | {kind:"command", command, cwd?, interval?, timeout?} (RUNS A SHELL COMMAND AS THE USER) | {kind:"http", url, method?, headers?, body?, expectStatus?, jsonPath?, interval?} | {kind:"probe", probe, config?, interval?}. Seconds.',
  },
  display: {
    type: 'string',
    description:
      'monitor view: auto (default), value, progress, status, text, log, spark, line, area, bars, gauge, histogram, scatter, pie, donut, heatmap, box, ridgeline, scatter3d, surface3d, composite, capacity, breakdown, table, grid, pipeline, bullet, waterfall, custom, or "view:<name>" (hud_views)',
  },
  plot: {
    type: 'object',
    description:
      'chart options: {series} dot path into meta; {targets}, {events}, {metrics} for metric overlays; {bins}, {points}, {stacked}, {tilt, spin}, {yMin, yMax, auto}, {animate}. See hud_guide',
  },
  metric: { type: 'object', description: 'metric identity and meaning: kind, key, scope, unit, definition, windowSeconds, target, denominator, source, sourceId' },
  observedAt: { type: 'number', description: 'source observation time in epoch milliseconds; distinct from receive time' },
  evidence: { type: 'string', enum: ['reported', 'estimate'], description: 'evidence basis for this value; do not describe estimates as measured' },
  coverage: { type: 'object', description: '{responding,total} population covered by the observation' },
  availability: { type: 'string', enum: ['available', 'partial', 'unavailable'] },
  data: { type: 'object', description: 'table data: {columns:[{key,label?,unit?,type?}],rows:[...]}' },
  pipeline: { type: 'object', description: 'pipeline stage bindings: {stages:[{key,label,throughput?,queued?,inFlight?,oldestAge?,retries?,rejected?}]}' },
  freshness: { type: 'object', description: '{mode:"live"|"static",reason?}; state why a reading is static when applicable' },
  value: { description: 'monitor: current value. Prefer a number (thresholds, charts, ETA need one) and put display text in label' },
  label: { type: 'string', description: 'monitor: text shown instead of the value, e.g. value 2 → label "2/4 busy"' },
  messageFormat: { type: 'string', enum: ['plain', 'markdown'], description: 'monitor: format of the short message headline (default plain)' },
  details: { type: 'string', description: 'monitor: longer Markdown report, at most 20 KB; keep message short' },
  notify: { type: 'array', items: { type: 'string' }, description: 'sessions to wake on this item\'s events: a monitor\'s warn/error/stale/done, a ticket\'s decision ("*" = every watching session)' },
  monitors: { type: 'array', items: { type: 'string' }, description: 'ticket: linked monitor ids, shown live on the ticket' },
  autoStatus: { type: 'boolean', description: 'ticket: all linked monitors done → done; any in error → blocked (back to doing on recovery)' },
  question: { type: 'string', description: 'ticket: the question that goes with proposed options' },
  questionFormat: { type: 'string', enum: ['plain', 'markdown'], description: 'ticket: format of question and option details (default plain)' },
  summaryMonitor: { type: 'string', description: 'ticket tagged run: explicit linked monitor id used for run progress and ETA' },
  options: {
    type: 'array',
    description: 'ticket: [{label, detail?, status?}]. Prefer hud_ask',
    items: { type: 'object' },
  },
  unit: { type: 'string' },
  state: { type: 'string', enum: ['ok', 'warn', 'error', 'unknown', 'running', 'done'] },
  message: { type: 'string' },
  progress: { type: 'number', description: 'monitor: percent 0-100' },
  max: { type: 'number', description: 'monitor: numeric value that means 100% (derives progress)' },
  staleAfter: { type: 'number', description: 'monitor: seconds without an update before it is shown stale' },
  warnAbove: { type: 'number' },
  errorAbove: { type: 'number' },
  warnBelow: { type: 'number' },
  errorBelow: { type: 'number' },
  meta: { type: 'object', description: 'free-form data for your own bookkeeping' },
  // ---- Linear-style structure (projects and ticket relationships) ----
  project: {
    type: 'string',
    description: 'ticket: project id or KEY (e.g. "EGO"); ident becomes KEY-n',
  },
  parent: { type: 'string', description: 'ticket: parent ticket (id or KEY-12). Makes this a sub-ticket of that one.' },
  blockedBy: {
    type: 'array',
    items: { type: 'string' },
    description: 'ticket: ids/idents it waits on; auto-blocked until they finish',
  },
  refs: {
    type: 'array',
    items: { type: 'string' },
    description: 'ticket: related ids/idents (KEY-n in text is picked up automatically)',
  },
  branch: { type: 'string', description: 'ticket: git branch; "regen" regenerates it' },
  target: { type: 'string', description: 'target date, yyyy-mm-dd (project or ticket)' },
  key: { type: 'string', description: 'project: 2-8 char KEY, A-Z/0-9 starting with a letter; derived from name if omitted' },
  lead: { type: 'string', description: 'project: who leads it' },
};

const TOOLS = [
  {
    name: 'hud_search',
    description: 'Find items by text and filters (ids, idents, status, assignee, project, tag, overdue). Prefer over hud_overview on big boards.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        board: { type: 'string' },
        type: { type: 'string', enum: ['ticket', 'monitor', 'note', 'frame', 'util', 'project'] },
        status: { type: 'string', description: 'comma-separated ok' },
        assignee: { type: 'string' },
        project: { type: 'string' },
        tag: { type: 'string' },
        priority: { type: 'string' },
        overdue: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'hud_trash',
    description: 'Deleted items live in the trash for 30 days. action: list | restore (id) | purge (id or "all"; permanent).',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['list', 'restore', 'purge'] }, id: { type: 'string' }, board: { type: 'string' } } },
  },
  {
    name: 'hud_backup',
    description: 'action: create (snapshot of all state, optional reason) | list.',
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['create', 'list'] }, reason: { type: 'string' } } },
  },
  {
    name: 'hud_overview',
    description:
      'Text overview of the hud dashboard: every board, frame, ticket, monitor and note with ids and current status. Call this first. The human sees the same canvas live at the URL returned.',
    inputSchema: { type: 'object', properties: { board: { type: 'string', description: 'limit to one board' } } },
  },
  {
    name: 'hud_tickets',
    description:
      'Ticket list for a board by project and status, sub-tickets nested, KEY-n idents. Optional filters; format:"json" for rows.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'board id (default "main")' },
        format: { type: 'string', enum: ['text', 'json'], description: 'text (default) or json rows' },
        status: { type: 'string', description: 'comma-separated ok' },
        assignee: { type: 'string' },
        project: { type: 'string' },
        tag: { type: 'string' },
        priority: { type: 'string' },
        text: { type: 'string' },
        overdue: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'hud_project',
    description:
      'Create or list Linear-style projects. A project groups tickets and gives them a KEY-n ident (EGO-12), a git branch name and a home in the list view. List first to reuse an existing KEY rather than making a near-duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list'], description: 'default list' },
        name: { type: 'string', description: 'create: project name. The KEY is derived from it unless you pass key.' },
        key: { type: 'string', description: 'create: 2-8 char prefix, A-Z/0-9 starting with a letter' },
        board: { type: 'string' },
        description: { type: 'string', description: 'create: markdown description' },
        lead: { type: 'string' },
        target: { type: 'string', description: 'create: target date yyyy-mm-dd' },
      },
    },
  },
  {
    name: 'hud_link',
    description:
      'Set the structure of an existing ticket: move it to a project, hang it under a parent, mark what it is blocked by or related to, or regenerate its branch. Relationships are validated (same board, no cycles); a ticket waiting on unfinished blockers is auto-blocked and returns to todo when they finish.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'ticket id or KEY-12' },
        project: { type: 'string', description: 'project id or KEY. Pass "" to remove it from its project.' },
        parent: { type: 'string', description: 'parent ticket id or KEY-12. Pass "" to detach.' },
        blockedBy: { type: 'array', items: { type: 'string' }, description: 'tickets this waits on (replaces the current list; [] to clear)' },
        refs: { type: 'array', items: { type: 'string' }, description: 'related tickets (replaces the current list; [] to clear)' },
        branch: { type: 'string', description: '"regen" to regenerate the branch name, or an explicit name' },
      },
    },
  },
  {
    name: 'hud_guide',
    description:
      'Full usage guide for hud (data model, monitor sources, probe modules, layout conventions, HTTP API). Pass playbook "decentralized" or "lead" to get only that coordination runbook (claim, publish a FACT, wait, finish, and the failure modes) without the rest of the guide.',
    inputSchema: {
      type: 'object',
      properties: {
        playbook: {
          type: 'string',
          enum: ['decentralized', 'lead', 'centralized', 'playbooks'],
          description: 'decentralized: every agent pulls ready work. lead (alias centralized): one lead links and assigns, workers pull. playbooks: which one to fetch. Omit for the full guide.',
        },
      },
    },
  },
  {
    name: 'hud_create',
    description:
      'Create an item: ticket, monitor (manual/push/heartbeat/command/http/probe), note, frame, util, or project. Position is automatic. WARNING: a monitor with source.kind "command" runs that shell command as the user, repeatedly. Monitors may take a custom id (slug) for external pushes.',
    inputSchema: {
      type: 'object',
      required: ['type'],
      properties: { type: { type: 'string', enum: ['ticket', 'monitor', 'note', 'frame', 'util', 'project'] }, id: { type: 'string' }, ...ITEM_FIELDS },
    },
  },
  {
    name: 'hud_update',
    description: 'Patch an existing item (fields as hud_create, except type/id). WARNING: setting source.kind "command" runs a shell command as the user.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, ...ITEM_FIELDS } },
  },
  {
    name: 'hud_push',
    description:
      'Report a monitor reading (value/state/message/progress). Creates a push monitor with this id if it does not exist (title/board/frame used on creation). Use for progress updates on long-running work.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        value: ITEM_FIELDS.value,
        metric: ITEM_FIELDS.metric,
        observedAt: ITEM_FIELDS.observedAt,
        evidence: ITEM_FIELDS.evidence,
        availability: ITEM_FIELDS.availability,
        coverage: ITEM_FIELDS.coverage,
        data: ITEM_FIELDS.data,
        pipeline: ITEM_FIELDS.pipeline,
        freshness: ITEM_FIELDS.freshness,
        state: ITEM_FIELDS.state,
        message: { type: 'string' },
        messageFormat: ITEM_FIELDS.messageFormat,
        details: ITEM_FIELDS.details,
        progress: ITEM_FIELDS.progress,
        unit: { type: 'string' },
        label: ITEM_FIELDS.label,
        title: { type: 'string' },
        board: { type: 'string' },
        group: ITEM_FIELDS.group,
        frame: { type: 'string' },
        max: ITEM_FIELDS.max,
        staleAfter: ITEM_FIELDS.staleAfter,
        warnAbove: ITEM_FIELDS.warnAbove,
        errorAbove: ITEM_FIELDS.errorAbove,
        warnBelow: ITEM_FIELDS.warnBelow,
        errorBelow: ITEM_FIELDS.errorBelow,
        display: ITEM_FIELDS.display,
        notify: ITEM_FIELDS.notify,
        monitors: { type: 'object', description: 'fan-out: {"<monitor id>": {value, label, state, message, progress, title}, ...} — updates/creates several monitors in one push' },
      },
    },
  },
  {
    name: 'hud_watch',
    description:
      'Subscribe THIS session to alerts for monitors (ids) or boards. Alerts are pushed into the conversation when claude runs with --dangerously-load-development-channels server:hud, and always queue for hud_alerts. name defaults to the session name (HUD_SESSION, else <actor>-<ppid>). off=true unsubscribes.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, boards: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, off: { type: 'boolean' } },
    },
  },
  {
    name: 'hud_alerts',
    description: 'List unacknowledged alerts (monitor went warn/error/stale/done). ack=true acknowledges what is returned. all=true includes acknowledged.',
    inputSchema: { type: 'object', properties: { ack: { type: 'boolean' }, all: { type: 'boolean' }, mine: { type: 'boolean', description: 'only alerts addressed to this session' } } },
  },
  {
    name: 'hud_attention',
    description: 'Human-attention queue, separate from agent alert acknowledgement. action=list reads open items; review/unreview/snooze require the current revision from the list. Snooze requires until (epoch milliseconds). Reviewing does not acknowledge old agent alerts.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'review', 'unreview', 'snooze'] },
        id: { type: 'string' },
        revision: { type: 'string', description: 'current attention revision from hud_attention list' },
        until: { type: 'number', description: 'snooze deadline as epoch milliseconds' },
      },
    },
  },
  {
    name: 'hud_runs',
    description: 'List run summaries: progress and ETA from the tagged summary monitor, plus linked monitors and tickets. Numeric readings and progress remain available in the structured data.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hud_changes',
    description: 'Read an incremental change window after a timestamp. Use the returned now as the next since value; complete is false when the requested window was truncated.',
    inputSchema: { type: 'object', required: ['since'], properties: { since: { type: 'number', description: 'epoch milliseconds' } } },
  },
  {
    name: 'hud_readout',
    description: 'Read current metrics and monitor evidence for one board or all boards. Start here before designing a dashboard; use hud_lint to check the result and hud_guide for field meanings.',
    inputSchema: { type: 'object', properties: { board: { type: 'string', description: 'board id; omit for all boards' } } },
  },
  {
    name: 'hud_snapshot',
    description: 'Capture the current board as text and, when available, a real PNG image. Keep captures as evidence; consult hud_guide for metric and availability meanings.',
    inputSchema: { type: 'object', properties: { board: { type: 'string' }, format: { type: 'string', enum: ['auto', 'png', 'text'] } } },
  },
  {
    name: 'hud_dashboard',
    description: 'Read or set a declarative dashboard spec. Use hud_readout to choose metrics, preview with dryRun before applying, then run hud_lint. Keep panels legible in hud’s monochrome terminal style; see hud_guide.',
    inputSchema: { type: 'object', properties: { board: { type: 'string' }, action: { type: 'string', enum: ['get', 'set'] }, spec: { type: 'object' }, dryRun: { type: 'boolean' }, expectedRevision: { type: 'string' } } },
  },
  {
    name: 'hud_annotate',
    description: 'List, add, or remove a timestamped board annotation. Add uses time in epoch milliseconds and concise text; annotations appear on the metric timeline. See hud_guide.',
    inputSchema: { type: 'object', properties: { board: { type: 'string' }, action: { type: 'string', enum: ['list', 'add', 'delete'] }, time: { type: 'number' }, text: { type: 'string' }, id: { type: 'string' } } },
  },
  {
    name: 'hud_compare',
    description: 'List, add, or remove a comparison between metric identifiers. Rules use equal/lte/gte and optional tolerance, holdFor, and maxSkew; inspect hud_readout first. See hud_guide.',
    inputSchema: { type: 'object', properties: { board: { type: 'string' }, action: { type: 'string', enum: ['list', 'add', 'delete'] }, id: { type: 'string' }, left: { type: 'string' }, right: { type: 'string' }, relation: { type: 'string', enum: ['equal', 'lte', 'gte'] }, tolerance: { type: 'number' }, holdFor: { type: 'number' }, maxSkew: { type: 'number' } } },
  },
  {
    name: 'hud_lint',
    description: 'Check a board’s dashboard, references, metrics, annotations, and comparisons for issues. Run after editing; use hud_readout for current observations and hud_guide for conventions.',
    inputSchema: { type: 'object', properties: { board: { type: 'string' } } },
  },
  {
    name: 'hud_graph',
    description: 'Read, preview, apply, disable, or delete an item renderer program. Always preview before apply; bindings and capabilities must match the intended data and scope. Use the hud_guide resource for the API and monochrome rendering style.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, action: { type: 'string', enum: ['get', 'preview', 'apply', 'disable', 'delete'] }, program: { type: 'object', properties: { code: { type: 'string' }, language: { type: 'string', enum: ['html', 'javascript', 'svg'] }, description: { type: 'string' }, bindings: { type: 'array', items: { type: 'string' } }, capabilities: { type: 'array', items: { type: 'object', properties: { operation: { type: 'string' }, scope: { type: 'string' } } } } } }, expectedRevision: { type: 'string' } } },
  },
  {
    name: 'hud_canvas',
    description: 'Read, preview, apply, disable, or delete a board canvas renderer program. Always preview before apply; keep charts readable in hud’s black, white, and gray style, with red/green reserved for stated status. See hud_guide.',
    inputSchema: { type: 'object', properties: { board: { type: 'string' }, action: { type: 'string', enum: ['get', 'preview', 'apply', 'disable', 'delete'] }, program: { type: 'object', properties: { code: { type: 'string' }, language: { type: 'string', enum: ['html', 'javascript', 'svg'] }, description: { type: 'string' }, bindings: { type: 'array', items: { type: 'string' } }, capabilities: { type: 'array', items: { type: 'object', properties: { operation: { type: 'string' }, scope: { type: 'string' } } } } } }, expectedRevision: { type: 'string' } } },
  },
  {
    name: 'hud_comment',
    description: 'Append a comment to an item. With cid: edit it (text) or delete it (delete:true).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, text: { type: 'string' }, format: { type: 'string', enum: ['plain', 'markdown'] }, cid: { type: 'string', description: 'comment id to edit/delete' }, delete: { type: 'boolean' } },
    },
  },
  {
    name: 'hud_get',
    description: 'Full JSON for one item (comments, monitor source, recent history/log, uptime).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'hud_delete',
    description: 'Move an item to the trash (restorable with hud_trash).',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'hud_clear_canvas',
    description: 'Clear a board’s canvas while keeping the board and its settings. Items move to trash; dashboard draft, annotations, comparisons, and canvas program are cleared or disabled. Use this to reset content without deleting the board. See hud_guide.',
    inputSchema: { type: 'object', required: ['board'], properties: { board: { type: 'string', description: 'board id to clear; the board itself is retained' } } },
  },
  {
    name: 'hud_board',
    description: 'Boards. action: list | create (name) | rename (id, name) | clear (id; keep the board/settings and move items to trash) | delete (id; delete the board; "main" cannot be deleted). Use hud_clear_canvas for an explicit canvas reset.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: { action: { type: 'string', enum: ['list', 'create', 'rename', 'clear', 'delete'] }, id: { type: 'string' }, name: { type: 'string' } },
    },
  },
  {
    name: 'hud_organize',
    description:
      'Fit cards and group frames into the fixed 1600×900 dashboard. Few cards are centered at readable sizes; larger collections fill the board. Creation order is stable across readings. Auto layout is on by default; auto=true enables structural reflow, auto=false allows deliberate manual x/y/w/h placement within bounds. Call after a batch. Split crowded dashboards into separate boards.',
    inputSchema: { type: 'object', properties: { board: { type: 'string' }, auto: { type: 'boolean' } } },
  },
  {
    name: 'hud_arrange',
    description: 'Fit the whole fixed board, including group contents. frame selects its board; ids are validated on the selected board. Legacy width is accepted but the surface stays 1600×900. Prefer hud_organize; use auto=false and hud_update coordinates for a custom layout.',
    inputSchema: {
      type: 'object',
      properties: { board: { type: 'string' }, frame: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, width: { type: 'number' } },
    },
  },
  {
    name: 'hud_views',
    description:
      'List the chart renderer modules available to `display: "view:<name>"`, with the directory to drop new ones in. A module is an ES module exporting render(ctx) → HTML/SVG string; see the "Renderers" section of hud_guide. Prefer the built-in display kinds unless you need something they cannot express.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hud_run',
    description: 'Run an automatic monitor (command/http/probe) immediately and return its new reading.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'hud_ask',
    description:
      'Ask the human for a decision: propose options on a ticket and block it until one is picked. Use this instead of guessing when a choice is theirs — it flags the ticket red on the canvas and wakes you (if you are in its notify list) when answered. The answer is on the ticket as `decision` (optionId) plus the chosen option.',
    inputSchema: {
      type: 'object',
      required: ['id', 'options'],
      properties: {
        id: { type: 'string' },
        question: { type: 'string', description: 'what you need decided' },
        questionFormat: { type: 'string', enum: ['plain', 'markdown'], description: 'format of question and option details (default plain)' },
        options: {
          type: 'array',
          description: 'at least one choice. Each: {label, detail?, status?} — status is where the ticket goes when chosen (default doing).',
          items: { type: 'object' },
        },
      },
    },
  },
  {
    name: 'hud_decide',
    description: 'Pick one of a ticket\'s proposed options yourself (headless use). Normally the human clicks it on the canvas.',
    inputSchema: {
      type: 'object',
      required: ['id', 'optionId', 'decisionVersion'],
      properties: { id: { type: 'string' }, optionId: { type: 'string' }, decisionVersion: { type: 'string', description: 'current ticket decisionVersion from hud_get/hud_ask; stale versions are rejected' }, note: { type: 'string' } },
    },
  },
  {
    name: 'hud_finish',
    description:
      'Signal that you are finished: mark the board\'s items (or the named ids) complete — tickets → done, monitors → done — and tidy the board. This is how an agent ends a run. Polled monitors will report again on their next run.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'board to finish (default: main, or the board of the first id)' },
        ids: { type: 'array', items: { type: 'string' }, description: 'finish just these items' },
        note: { type: 'string', description: 'added as a final comment' },
        organize: { type: 'boolean', description: 'tidy the board afterwards (default true)' },
      },
    },
  },
  {
    name: 'hud_session',
    description:
      'Register this agent\'s presence so peers can see it on the queue. MCP registers automatically on connect and heartbeat; use this to start a named session, list live sessions, or end one. Claims are renewed with the session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'heartbeat', 'end', 'list'], description: 'default: start' },
        name: { type: 'string', description: 'session name (default: this MCP session)' },
        kind: { type: 'string', enum: ['agent', 'cli', 'human', 'unknown'] },
        run: { type: 'string', description: 'run ticket id/ident this session is working on' },
      },
    },
  },
  {
    name: 'hud_claim',
    description:
      'Take an exclusive, time-limited lease on a ticket so peers do not duplicate the work. First claim wins; one unfinished claim per session; a lease is released when the session ends, the ticket finishes, or it expires. Pass start:true to also move the ticket to doing (refused while blocked).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['claim', 'renew', 'release', 'status', 'list'], description: 'default: claim' },
        ticket: { type: 'string', description: 'ticket id or KEY-12' },
        session: { type: 'string', description: 'session name (default: this MCP session)' },
        ttl: { type: 'number', description: 'lease seconds (default 120, 15-900)' },
        start: { type: 'boolean', description: 'also set the ticket to doing' },
        takeover: { type: 'boolean', description: 'take a lease whose holder is no longer live' },
      },
    },
  },
  {
    name: 'hud_queue',
    description:
      'Read the work queue: open, claimed and done tickets with owner, live session state, blockers and ready flag. Use it before claiming to pick complementary work; use hud_claim to take a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string' },
        status: { type: 'string', description: 'comma-separated statuses' },
        project: { type: 'string', description: 'project id or KEY' },
        assignee: { type: 'string' },
        includeDone: { type: 'boolean', description: 'include finished tickets (default false)' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'hud_context',
    description:
      'Shared, append-only context for a run, project or board. Publish typed entries — FACT (a finding), FAIL (a contradicted approach), SUMMARY (state of the work), STATUS (short progress note) — and read only what changed since your last read. Corrections are new entries with corrects:<entryId>; entries are never edited.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['publish', 'read', 'scopes'], description: 'default: read' },
        scope: { type: 'string', description: 'run:<uuid> (ticket id from hud_get, tagged run), project:<id> or board:<board id>' },
        kind: { type: 'string', enum: ['FACT', 'FAIL', 'SUMMARY', 'STATUS'], description: 'publish: entry type; read: comma-separated filter' },
        text: { type: 'string', description: 'publish: the finding or correction (≤4 KB)' },
        data: { type: 'object', description: 'publish: optional structured payload (≤8 KB)' },
        refs: { type: 'array', items: { type: 'string' }, description: 'publish: related item ids/idents' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'publish: attachment ids' },
        corrects: { type: 'string', description: 'publish: id of an earlier entry this one corrects' },
        since: { type: 'number', description: 'read: last seen sequence number (omit to use your session cursor)' },
        limit: { type: 'number', description: 'read: at most this many entries (default 200)' },
        mark: { type: 'boolean', description: 'read: advance your session cursor (default true)' },
        session: { type: 'string', description: 'publish/read: session name (default: this MCP session)' },
      },
    },
  },
  {
    name: 'hud_attach',
    description:
      'Share a file with peers by reference, or apply a peer version with conflict detection. add copies bytes into hud storage (the server never reads an arbitrary local path); expand shows a unified diff against the version it was based on; apply writes a real file in this process — it refuses paths outside your intent, symlinks and changed targets.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'get', 'content', 'expand', 'apply', 'delete'] },
        id: { type: 'string', description: 'attachment id (get/content/expand/apply/delete)' },
        board: { type: 'string', description: 'add/list: board (default main)' },
        scope: { type: 'string', description: 'add/list: run:<uuid> (ticket id from hud_get, tagged run), project:<id> or board:<board id>' },
        name: { type: 'string', description: 'add: file name (default: basename of path)' },
        kind: { type: 'string', enum: ['file', 'text', 'diff'] },
        mime: { type: 'string' },
        path: { type: 'string', description: 'add: absolute local file to publish' },
        content: { type: 'string', description: 'add: text content instead of path' },
        target: { type: 'string', description: 'add: display-only intended destination; apply: absolute path to write' },
        baseId: { type: 'string', description: 'add: earlier attachment this version is based on (enables expand)' },
        baseSha256: { type: 'string', description: 'add: hash of the base version' },
        corrects: { type: 'string' },
        expectedSha256: { type: 'string', description: 'apply: hash of the local target you based your work on' },
        mode: { type: 'string', enum: ['create', 'overwrite'], description: 'apply: default overwrite' },
        force: { type: 'boolean', description: 'delete: remove even when a context entry references it' },
      },
    },
  },
  {
    name: 'hud_wait',
    description:
      'Block until a peer publishes shared context, claims/releases a ticket, or ends its session — up to 25 s. Give a scope, a ticket or session names; unrelated events never wake it. Check hud_queue/hud_context first so you do not wait for something already there. The call blocks this session\'s tool chain for its duration.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'run:<uuid> (ticket id from hud_get, tagged run), project:<id> or board:<board id>' },
        ticket: { type: 'string', description: 'wake on this ticket\'s claim changes, refs or item updates' },
        sessions: { type: 'array', items: { type: 'string' }, description: 'wake when one of these sessions ends' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'context | claim | session | item (default: context, claim, session)' },
        since: { type: 'number', description: 'context sequence already seen; a matching backlog wakes immediately' },
        timeoutSeconds: { type: 'number', description: '1-25 (default 20)' },
        includeSelf: { type: 'boolean', description: 'include this session\'s own events (default false)' },
      },
    },
  },
  {
    name: 'hud_view',
    description:
      'Create, inspect or validate a chart renderer module for display:"view:<name>". generate turns a small declarative spec into a module and may install that generated source. write stages caller-supplied source and returns a review diff; it does not install. approve installs only that reviewed proposal, and only when the full diff fit in the tool result. These modules run unsandboxed in the board page. Prefer hud_graph/hud_canvas for sandboxed custom programs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'generate', 'write', 'approve', 'validate', 'delete'], description: 'default: list' },
        name: { type: 'string', description: 'module name (lowercase letters, digits, . _ -)' },
        spec: {
          type: 'object',
          description: '{kind:"bar"|"line"|"sparkline"|"gauge"|"bullet"|"scatter"|"heatmap"|"table"|"slo", series?, unit?, max?, targets?, thresholds?, maxRows?}',
        },
        code: { type: 'string', description: 'write/validate: module source. write stages a review and does not install.' },
        write: { type: 'boolean', description: 'generate: write the generated module to disk (default false). Does not apply to caller-supplied code.' },
        overwrite: { type: 'boolean' },
        expectedSha256: { type: 'string' },
        proposalId: { type: 'string', description: 'approve: id from the write review' },
        sha256: { type: 'string', description: 'approve: sha256 of the reviewed module' },
        display: { type: 'string', description: 'monitor id to set display:"view:<name>" on after a successful generate write' },
      },
    },
  },
];

const RO = new Set(['hud_overview', 'hud_tickets', 'hud_search', 'hud_guide', 'hud_get', 'hud_views', 'hud_runs', 'hud_changes', 'hud_readout', 'hud_snapshot', 'hud_lint', 'hud_queue']);
const DESTRUCTIVE = new Set(['hud_delete', 'hud_finish', 'hud_trash', 'hud_board', 'hud_clear_canvas']);
const OPEN_WORLD = new Set(['hud_create', 'hud_update', 'hud_run']); // can start shell-command / http monitors
const listed = TOOLS.map((t) => ({
  ...t,
  annotations: {
    readOnlyHint: RO.has(t.name),
    destructiveHint: DESTRUCTIVE.has(t.name),
    openWorldHint: OPEN_WORLD.has(t.name),
  },
}));
const SCHEMAS = new Map<string, any>(TOOLS.map((t) => [t.name, t.inputSchema]));

/** enforce required args and basic types from the tool's inputSchema */
function validate(name: string, args: any) {
  const schema = SCHEMAS.get(name);
  if (!schema) throw new Error(`unknown tool ${name}`);
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) throw new Error('arguments must be an object');
  const a = args ?? {};
  for (const k of schema.required ?? []) if (a[k] === undefined || a[k] === null || a[k] === '') throw new Error(`missing required argument "${k}" for ${name}`);
  for (const [k, v] of Object.entries(a)) {
    const p = schema.properties?.[k];
    if (!p || v === undefined || v === null || !p.type) continue;
    const ok = p.type === 'array' ? Array.isArray(v) : p.type === 'object' ? typeof v === 'object' && !Array.isArray(v) : typeof v === p.type;
    if (!ok) throw new Error(`argument "${k}" must be ${p.type}`);
    if (p.enum && !p.enum.includes(v)) throw new Error(`argument "${k}" must be one of ${p.enum.join(' | ')}`);
  }
}

const MAX_OUT = VIEW_REVIEW_MAX_CHARS;
function cap(text: string) {
  return text.length > MAX_OUT ? `${text.slice(0, MAX_OUT)}\n… truncated (${text.length} chars); narrow it with filters (board, status, limit, hud_search)` : text;
}

async function needBoard(board?: string, client: Hud = baseHud) {
  if (!board) return;
  const boards = await client.boards();
  if (!boards.some((b) => b.id === board)) throw new Error(`unknown board "${board}" (have: ${boards.map((b) => b.id).join(', ')})`);
}

function filters(a: any) {
  const q = new URLSearchParams();
  for (const k of ['board', 'type', 'status', 'priority', 'assignee', 'project', 'tag', 'parent', 'limit']) if (a[k] !== undefined && a[k] !== '') q.set(k, String(a[k]));
  if (a.text) q.set('q', String(a.text));
  if (a.overdue) q.set('overdue', '1');
  return q;
}

function brief(it: Item | (Item & { ident?: string; graph?: any })) {
  const g = (it as any).graph;
  if (!(it as any).ident || !g) return line(it);
  const names = new Map<string, string>();
  for (const k of ['blockedBy', 'blocks', 'refs', 'children']) for (const r of g[k] ?? []) names.set(r.id, r.ident);
  if (g.parent) names.set(g.parent.id, g.parent.ident);
  return line(it, { ident: () => (it as any).ident, name: (id: string) => names.get(id) ?? id });
}

function briefReport(it: Item | (Item & { ident?: string; graph?: any })) {
  const headline = brief(it);
  return (it as any).details ? `${headline}\n\n${String((it as any).details).replace(/\r/g, '').trim()}` : headline;
}

function trimItem(it: Item) {
  const { history, log, trend, ...rest } = it;
  const lt = (t?: number) => (t ? localTime(t) : undefined);
  return {
    ...rest,
    createdAt: lt(it.createdAt),
    updatedAt: lt(it.updatedAt),
    lastUpdate: lt(it.lastUpdate),
    lastRun: lt(it.lastRun),
    comments: it.comments?.map((c) => ({ ...c, t: lt(c.t) })),
    history: history?.slice(-20).map((h) => ({ ...h, t: lt(h.t) })),
    log: log?.slice(-10).map((l) => ({ ...l, t: lt(l.t) })),
    trend: trend?.length ? `${trend.length} per-minute points since ${lt(trend[0].t)}` : undefined,
  };
}

const mdCell = (v: unknown) => String(v ?? '—').replace(/[|\r\n]+/g, ' ').trim() || '—';
function attentionMarkdown(r: any): string {
  const items = Array.isArray(r?.items) ? r.items : [];
  if (!items.length) return `## Human attention\n\nNo open human-attention items.\n\n_checked ${localTime(Number(r?.now) || Date.now())}_`;
  const rows = items.map((a: any) => `| ${mdCell(a.kind)} | ${mdCell(a.itemId)} | ${mdCell(a.title)} | ${mdCell(a.owner)} | ${mdCell(a.priority)} | ${a.reviewedAt ? 'yes' : 'no'} | ${a.snoozedUntil ? mdCell(a.snoozedUntil) : '—'} | ${mdCell(a.runTitle ?? a.runId)} | ${mdCell(a.revision)} | ${mdCell(a.message)} |`);
  return [`## Human attention`, ``, `Reviewing this queue does not acknowledge old agent alerts.`, ``, `| Kind | Item | Title | Owner | Priority | Reviewed | Snoozed until | Run | Revision | Message |`, `|---|---|---|---|---:|---|---:|---|---|---|`, ...rows, ``, `_updated ${localTime(Number(r?.now) || Date.now())}_`].join('\n');
}

function attentionRecordMarkdown(record: any): string {
  return [`## Human attention`, ``, `- item: ${mdCell(record?.itemId)}`, `- kind: ${mdCell(record?.kind)}`, `- revision: ${mdCell(record?.revision)}`, `- reviewed: ${record?.reviewedAt ? 'yes' : 'no'}`, `- snoozed until: ${record?.snoozedUntil ? mdCell(record.snoozedUntil) : '—'}`, ``, `Reviewing this queue does not acknowledge old agent alerts.`].join('\n');
}

function sessionsMarkdown(r: { items: any[]; now: number }): string {
  if (!r.items.length) return '## Sessions\n\nNo agent sessions. MCP clients register on connect.';
  const rows = r.items.map((s) => {
    const age = Math.max(0, Math.round((r.now - s.lastSeenAt) / 1000));
    const claims = (s.claims ?? []).map((c: any) => c.ident).join(', ') || '—';
    return `| ${mdCell(s.id)} | ${mdCell(s.kind)} | ${s.live ? 'live' : 'ended'} | ${age}s ago | ${mdCell(claims)} |`;
  });
  return ['## Sessions', '', '| Session | Kind | State | Last seen | Claims |', '|---|---|---|---:|---|', ...rows].join('\n');
}

function queueMarkdown(r: QueueResult): string {
  const c = r.counts;
  const head = `## Queue · ${r.board}\n\n${c.ready} ready · ${c.open} open · ${c.claimed} claimed · ${c.blocked} blocked · ${c.done} done`;
  if (!r.items.length) return `${head}\n\nNo matching work.`;
  const rows = r.items.map((t) => `| ${mdCell(t.ident)} | ${mdCell(t.status)}${t.ready ? ' · ready' : ''} | ${mdCell(t.owner ?? '—')} | ${t.session ? (t.session.live ? 'live' : 'ended') : '—'} | ${mdCell(t.blockedBy.join(', ') || '—')} | ${mdCell(t.title)} |`);
  return [head, '', '| Ticket | Status | Owner | Session | Blocked by | Title |', '|---|---|---|---|---|---|', ...rows].join('\n');
}

function contextMarkdown(r: { entries: any[]; cursor: number; complete: boolean; truncated: boolean; oldest: number }, scope?: string): string {
  const head = `## Shared context${scope ? ` · ${scope}` : ''}\n\ncursor ${r.cursor}${r.truncated ? ' · older entries were pruned' : ''}${r.complete ? '' : ' · more entries remain'}`;
  if (!r.entries.length) return `${head}\n\nNothing new.`;
  const rows = r.entries.map((e) => `| ${e.seq} | ${mdCell(e.kind)} | ${mdCell(e.actor)} | ${mdCell(e.session ?? '—')} | ${mdCell(e.text)} | ${mdCell((e.refs ?? []).join(', ') || '—')} | ${mdCell(e.corrects ?? '—')} |`);
  return [head, '', '| Seq | Kind | Actor | Session | Text | Refs | Corrects |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

function contextScopesMarkdown(rows: any[]): string {
  if (!rows.length) return '## Context scopes\n\nNo shared context yet.';
  return ['## Context scopes', '', '| Scope | Board | Entries | Last |', '|---|---|---:|---|', ...rows.map((s) => `| ${mdCell(s.scope)} | ${mdCell(s.board)} | ${mdCell(s.count)} | ${mdCell(localTime(s.lastAt))} |`)].join('\n');
}

function attachmentsMarkdown(rows: any[]): string {
  if (!rows.length) return 'No attachments.';
  return ['| Id | Name | Bytes | Scope | Created | Applied |', '|---|---|---:|---|---|---|', ...rows.map((a) => `| ${mdCell(a.id)} | ${mdCell(a.name)} | ${mdCell(a.bytes)} | ${mdCell(a.scope ?? '—')} | ${mdCell(localTime(a.createdAt))} | ${mdCell(a.appliedTo ?? '—')} |`)].join('\n');
}

function runsMarkdown(r: any): string {  const items = Array.isArray(r?.items) ? r.items : [];
  if (!items.length) return '## Runs\n\nNo runs found.';
  const rows = items.map((run: any) => {
    const progress = run.progress === null || run.progress === undefined ? '—' : `${run.progress}%`;
    return `| ${mdCell(run.ident || run.id)} | ${mdCell(run.title)} | ${mdCell(run.status)} | ${mdCell(progress)} | ${mdCell(run.eta)} | ${mdCell(run.issues)} | ${mdCell(run.summaryMonitor)} |`;
  });
  const out = [`## Runs`, ``, `| Run | Title | Status | Progress | ETA | Issues | Summary monitor |`, `|---|---|---|---:|---|---:|---|`, ...rows];
  for (const run of items) {
    if (Array.isArray(run.monitors) && run.monitors.length) {
      out.push('', `### ${mdCell(run.ident || run.id)} monitors`, '', '| Monitor | State | Value | Unit | Progress | Headline |', '|---|---|---:|---|---:|---|');
      for (const m of run.monitors) {
        out.push(`| ${mdCell(m.id)} | ${mdCell(m.state)} | ${mdCell(m.value)} | ${mdCell(m.unit)} | ${m.progress == null ? '—' : `${mdCell(m.progress)}%`} | ${mdCell(m.message)} |`);
        if (m.details) out.push('', String(m.details).replace(/\r/g, '').trim());
      }
    }
    if (Array.isArray(run.tickets) && run.tickets.length) {
      out.push('', `### ${mdCell(run.ident || run.id)} tickets`);
      for (const t of run.tickets) out.push(`- ${mdCell(t.id)} [${mdCell(t.status)}] ${mdCell(t.title)}`);
    }
  }
  return out.join('\n');
}

function changesMarkdown(r: any): string {
  const events: any[] = Array.isArray(r?.events) ? r.events : [];
  const lines = [`## Changes`, ``, `- since: ${mdCell(r?.since)}`, `- now: ${mdCell(r?.now)}`, `- complete: ${mdCell(r?.complete)}`, ``];
  if (!events.length) return lines.concat(['No changes.']).join('\n');
  lines.push('| Time | Action | Item | Board | Actor | Change |', '|---|---|---|---|---|---|');
  for (const e of events) {
    if (e.action !== undefined) {
      lines.push(`| ${mdCell(e.t ? localTime(e.t) : undefined)} | ${mdCell(e.action)} | ${mdCell(e.itemId)} | ${mdCell(e.board)} | ${mdCell(e.actor)} | ${mdCell(e.text)} |`);
      continue;
    }
    const it = e.item;
    const value = it?.value === undefined || it?.value === null ? '—' : `${mdCell(it.value)}${it?.progress == null ? '' : ` (${mdCell(it.progress)}%)`}`;
    lines.push(`| ${mdCell(e.t ? localTime(e.t) : undefined)} | ${mdCell(e.kind)} | ${mdCell(it?.id ?? e.itemId ?? e.alert?.itemId)} | ${mdCell(it?.board ?? e.board)} | ${mdCell(e.actor ?? e.activity?.actor ?? e.alert?.title)} | ${mdCell(it?.message ?? e.alert?.message ?? e.activity?.text)}${value === '—' ? '' : ` [${value}]`} |`);
    if (it?.details) lines.push(`|  |  |  |  |  | ${String(it.details).replace(/\r/g, '').trim()} |`);
  }
  return lines.join('\n');
}

type ToolContent = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };
type RichToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown> };
const richResult = (value: Record<string, unknown>, text: string, image?: { mimeType: string; data: string }): RichToolResult => ({
  content: [{ type: 'text', text }, ...(image ? [{ type: 'image' as const, mimeType: image.mimeType, data: image.data }] : [])],
  structuredContent: image ? { ...value, image: { mimeType: image.mimeType, bytes: Math.floor(image.data.length * 3 / 4) } } : value,
});

async function call(name: string, a: any): Promise<string | RichToolResult> {
  validate(name, a);
  const { actor, ...args } = a ?? {};
  const hud = baseHud.forActor(actor ? String(actor) : baseActor);
  switch (name) {
    case 'hud_overview': {
      await needBoard(args.board, hud);
      const alerts: any[] = await hud.request('GET', '/api/alerts');
      const al = alerts.length ? `\n\nunacknowledged alerts (${alerts.length}):\n${alerts.slice(-10).map(alertText).join('\n')}` : '';
      return cap(`${await hud.summary(args.board)}${al}\n\nlive canvas: ${hud.url}`);
    }
    case 'hud_guide':
      return hud.guide(args.playbook);
    case 'hud_search': {
      await needBoard(args.board, hud);
      const q = filters(args);
      if (!q.has('limit')) q.set('limit', '50');
      const items: Item[] = await hud.request('GET', `/api/items?${q}`);
      return items.length ? cap(items.map((it) => brief(it)).join('\n')) : 'no matches';
    }
    case 'hud_tickets': {
      const board = args.board ?? 'main';
      await needBoard(board, hud);
      const q = filters({ ...args, board });
      if (args.format === 'json') return cap(JSON.stringify((await hud.request('GET', `/api/tickets?${q}`)).groups, null, 2));
      q.set('format', 'text');
      return cap(await hud.request('GET', `/api/tickets?${q}`));
    }
    case 'hud_project': {
      await needBoard(args.board, hud);
      if ((args.action ?? 'list') === 'list') {
        const list = await hud.projects(args.board);
        if (!list.length) return `no projects on board ${args.board ?? 'main'}. Create one: hud_project {action:"create", name:"..."}`;
        return cap(
          list
            .map((g) => `${g.key}  ${g.name}  (${g.total} tickets${g.project?.target ? `, target ${g.project.target}` : ''}${g.project?.lead ? `, lead @${g.project.lead}` : ''})  id=${g.project?.id}`)
            .join('\n'),
        );
      }
      if (args.action !== 'create') throw new Error('action must be list|create');
      if (!args.name) throw new Error('missing required argument "name" for create');
      const p = await hud.create({ type: 'project', title: args.name, key: args.key, board: args.board, body: args.description, lead: args.lead, target: args.target });
      return `project ${p.key} "${p.title}" (id ${p.id}). New tickets in it: hud_create {type:"ticket", project:"${p.key}", title:"..."}`;
    }
    case 'hud_link': {
      const { id, ...patch } = args;
      const t: any = await hud.link(id, patch);
      const g = t.graph ?? {};
      const names = (arr: any[]) => (arr ?? []).map((r) => r.ident ?? r).join(', ');
      const extra = [
        t.branch && `branch ${t.branch}`,
        g.parent && `under ${names([g.parent])}`,
        g.blockedBy?.length && `blocked by ${names(g.blockedBy)}`,
        g.refs?.length && `related to ${names(g.refs)}`,
        g.children?.length && `${g.children.length} sub-ticket${g.children.length > 1 ? 's' : ''}`,
        t.autoBlocked && 'auto-blocked until its blockers finish',
      ].filter(Boolean);
      return `linked ${brief(t)}${extra.length ? '\n  ' + extra.join('\n  ') : ''}`;
    }
    case 'hud_create':
      await needBoard(args.board);
      return `created ${brief(await hud.create(args))}`;
    case 'hud_update': {
      const { id, ...patch } = args;
      return `updated ${brief(await hud.update(id, patch))}`;
    }
    case 'hud_push': {
      const { id, ...r } = args;
      return briefReport(await hud.push(id, r));
    }
    case 'hud_comment': {
      const path = `/api/items/${encodeURIComponent(args.id)}/comments`;
      if (args.cid && args.delete) {
        await hud.request('DELETE', `${path}/${encodeURIComponent(args.cid)}`);
        return `deleted comment ${args.cid} on ${args.id}`;
      }
      if (args.text === undefined || args.text === '') throw new Error('missing required argument "text" for hud_comment');
      if (args.cid) {
        await hud.editComment(args.id, args.cid, args.text, args.format);
        return `edited comment ${args.cid} on ${args.id}`;
      }
      await hud.comment(args.id, args.text, args.format);
      return `commented on ${args.id}`;
    }
    case 'hud_get': {
      const it: any = await hud.get(args.id);
      return cap(JSON.stringify(trimItem(it), null, 2));
    }
    case 'hud_delete':
      return `trashed ${brief(await hud.remove(args.id))} (restore with hud_trash)`;
    case 'hud_trash': {
      if (args.action === 'list') {
        const q = args.board ? `?board=${encodeURIComponent(args.board)}` : '';
        const list: any[] = await hud.request('GET', `/api/trash${q}`);
        return list.length ? cap(list.map((e) => `${e.item?.id ?? e.id}  ${e.item ? line(e.item) : ''}  (deleted ${e.deletedAt ? localTime(e.deletedAt) : '?'})`).join('\n')) : 'trash is empty';
      }
      if (!args.id) throw new Error(`missing required argument "id" for ${args.action}`);
      if (args.action === 'restore') return `restored ${brief(await hud.request('POST', `/api/trash/${encodeURIComponent(args.id)}/restore`))}`;
      if (args.action === 'purge') {
        const r = await hud.request('DELETE', args.id === 'all' ? '/api/trash' : `/api/trash/${encodeURIComponent(args.id)}`);
        return `permanently deleted ${r.purged ?? 0} trashed item(s)`;
      }
      throw new Error('action must be list|restore|purge');
    }
    case 'hud_backup': {
      if (args.action === 'create') return `backup ${(await hud.request('POST', '/api/backups', { reason: args.reason })).name}`;
      if (args.action !== 'list') throw new Error('action must be create|list');
      const list: any[] = await hud.request('GET', '/api/backups');
      return list.length ? list.map((b) => `${b.name}  ${localTime(b.t)}  ${b.bytes}b`).join('\n') : 'no backups';
    }
    case 'hud_clear_canvas': {
      await needBoard(args.board, hud);
      const result = await hud.clearBoard(args.board);
      return `cleared canvas ${args.board}: ${result.cleared} items moved to trash; board settings retained`;
    }
    case 'hud_board':
      if (args.action === 'list') return (await hud.boards()).map((b) => `${b.id}  "${b.name}"  ${b.width}×${b.height}  (${b.autoOrganize ? 'auto' : 'manual'} layout)`).join('\n');
      if (args.action === 'create') {
        if (!args.name) throw new Error('missing required argument "name" for create');
        const b = await hud.createBoard(args.name);
        return `board ${b.id} "${b.name}"`;
      }
      if (args.action === 'rename') {
        if (!args.id || !args.name) throw new Error('rename needs id and name');
        const b = await hud.request('PATCH', `/api/boards/${encodeURIComponent(args.id)}`, { name: args.name });
        return `board ${b.id} "${b.name}"`;
      }
      if (args.action === 'clear') {
        if (!args.id) throw new Error('clear needs id');
        const result = await hud.clearBoard(args.id);
        return `cleared canvas ${args.id}: ${result.cleared} items moved to trash; board settings retained`;
      }
      if (args.action === 'delete') {
        if (!args.id) throw new Error('missing required argument "id" for delete');
        await hud.request('DELETE', `/api/boards/${encodeURIComponent(args.id)}`);
        return `deleted board ${args.id} (its items are in the trash)`;
      }
      throw new Error('action must be list|create|rename|clear|delete');
    case 'hud_organize': {
      await needBoard(args.board);
      const r = await hud.organize(args.board, args.auto);
      return `organized ${args.board ?? 'main'}: ${r.canvas.width}×${r.canvas.height}, ${r.items} dashboard cards, ${r.tickets} tickets in list, ${r.groups.length} groups (${r.groups.join(', ') || 'none'}), ${r.moved} items moved${args.auto !== undefined ? `; auto-organize ${args.auto ? 'on' : 'off'}` : ''}. Tickets open in the sidebar; completed tickets are tucked away in the list. If dashboard cards are crowded, split runs across boards.`;
    }
    case 'hud_arrange': {
      await needBoard(args.board);
      const r = await hud.arrange(args);
      return `arranged ${r.length} items`;
    }
    case 'hud_watch': {
      if (args.name) session.name = String(args.name);
      const name = sessionName();
      const r = await hud.request('POST', '/api/watch', { name, ids: args.ids ?? [], boards: args.boards ?? [], off: !!args.off });
      startAlertStream();
      return `${r.off ? 'unwatched' : 'watching'} as "${name}": ${[...r.ids, ...r.boards.map((b: string) => `board ${b}`)].join(', ') || 'nothing'}`;
    }
    case 'hud_alerts': {
      const q = new URLSearchParams();
      if (args.all) q.set('all', '1');
      if (args.mine) q.set('notify', sessionName());
      const list: any[] = await hud.request('GET', `/api/alerts?${q}`);
      if (args.ack && list.length) await hud.request('POST', '/api/alerts/ack', { ids: list.map((a) => a.id) });
      return list.length ? cap(list.map(alertText).join('\n') + (args.ack ? `\n(acknowledged ${list.length})` : '')) : 'no alerts';
    }
    case 'hud_attention': {
      const action = args.action ?? 'list';
      if (action === 'list') return cap(attentionMarkdown(await hud.attention()));
      if (action !== 'review' && action !== 'unreview' && action !== 'snooze') throw new Error('action must be list|review|unreview|snooze');
      if (!args.id) throw new Error(`missing required argument "id" for ${action}`);
      if (!args.revision) throw new Error('revision is required; call hud_attention {action:"list"} first');
      if (action === 'snooze' && args.until === undefined) throw new Error('until is required for snooze');
      return cap(attentionRecordMarkdown(await hud.reviewAttention(args.id, { action, revision: String(args.revision), ...(args.until === undefined ? {} : { until: Number(args.until) }) })));
    }
    case 'hud_runs':
      return cap(runsMarkdown(await hud.runs()));
    case 'hud_changes': {
      const since = Number(args.since);
      if (!Number.isFinite(since) || since < 0) throw new Error('since must be a non-negative timestamp');
      return cap(changesMarkdown(await hud.changes(since)));
    }
    case 'hud_session': {
      const action = args.action ?? 'start';
      const name = String(args.name ?? sessionName());
      if (action === 'list') return cap(sessionsMarkdown(await hud.sessions()));
      if (action === 'start') {
        const s = await hud.sessionStart(name, { kind: args.kind ?? 'agent', run: args.run });
        session.name = name;
        return `session ${s.id} started (${s.kind})${s.run ? ` for ${s.run}` : ''}. Peers can see it in hud_queue.`;
      }
      if (action === 'heartbeat') {
        const r = await hud.sessionHeartbeat(name);
        session.name = name;
        return `session ${r.session.id} live; ${r.renewed.length} claim${r.renewed.length === 1 ? '' : 's'} renewed`;
      }
      if (action === 'end') {
        const r = await hud.sessionEnd(name);
        return `session ${r.session.id} ended; released ${r.released.length} claim${r.released.length === 1 ? '' : 's'}`;
      }
      throw new Error('action must be start|heartbeat|end|list');
    }
    case 'hud_claim': {
      const action = args.action ?? 'claim';
      const name = String(args.session ?? sessionName());
      if (action === 'list') {
        const s = (await hud.sessions()).items.find((x) => x.id === name);
        return s?.claims.length ? s.claims.map((c) => `${c.ident}  until ${localTime(c.expiresAt)}`).join('\n') : `no active claim for ${name}`;
      }
      if (!args.ticket) throw new Error(`ticket is required for ${action}`);
      if (action === 'status') {
        const c = await hud.claimOf(args.ticket);
        return c ? `${c.ident} claimed by ${c.session} until ${localTime(c.expiresAt)}${c.live ? '' : ' (expired)'}` : `${args.ticket} is not claimed`;
      }
      if (action === 'release') {
        const c = await hud.releaseClaim(args.ticket, name);
        return `released ${c.ident}`;
      }
      if (action === 'renew') {
        const c = await hud.claim(args.ticket, { session: name, ttl: args.ttl });
        return `${c.ident} renewed until ${localTime(c.expiresAt)}`;
      }
      if (action !== 'claim') throw new Error('action must be claim|renew|release|status|list');
      const c = await hud.claim(args.ticket, { session: name, ttl: args.ttl, start: args.start, takeover: args.takeover });
      return `${c.ident} "${c.title}" claimed by ${c.session} until ${localTime(c.expiresAt)}${args.start ? '; ticket moved to doing' : ''}`;
    }
    case 'hud_queue': {
      await needBoard(args.board, hud);
      return cap(queueMarkdown(await hud.queue({ board: args.board ?? 'main', status: args.status, project: args.project, assignee: args.assignee, includeDone: args.includeDone, limit: args.limit })));
    }
    case 'hud_context': {
      const action = args.action ?? 'read';
      const session = String(args.session ?? sessionName());
      if (action === 'scopes') return cap(contextScopesMarkdown(await hud.contextScopes(args.board)));
      if (action === 'publish') {
        if (!args.scope || !args.kind || !args.text) throw new Error('scope, kind and text are required to publish');
        const e = await hud.contextPublish({ scope: args.scope, kind: args.kind, text: args.text, data: args.data, refs: args.refs, attachments: args.attachments, corrects: args.corrects, session });
        return `published ${e.kind} #${e.seq} ${e.scope} id=${e.id}`;
      }
      if (action !== 'read') throw new Error('action must be publish|read|scopes');
      const r = await hud.contextRead({ scope: args.scope, since: args.since, kinds: args.kind ? String(args.kind).split(',') : undefined, limit: args.limit, session, mark: args.mark });
      return cap(contextMarkdown(r, args.scope));
    }
    case 'hud_wait': {
      const r = await hud.wait({ scope: args.scope, ticket: args.ticket, sessions: args.sessions, kinds: args.kinds, since: args.since, timeoutSeconds: args.timeoutSeconds, includeSelf: args.includeSelf });
      if (!r.woke) return `no matching event within ${args.timeoutSeconds ?? 20}s`;
      return cap(JSON.stringify(r, null, 2));
    }
    case 'hud_view': {
      const action = args.action ?? 'list';
      if (action === 'list') {
        const r = await hud.views();
        return cap(`renderer modules in ${r.dir}\n` + (r.views.length ? r.views.map((v) => `${v.name}  ${v.bytes}b  ${v.valid === false ? `INVALID: ${(v.errors || []).join('; ')}` : 'valid'}`).join('\n') : 'none'));
      }
      if (!args.name) throw new Error('name is required');
      if (action === 'get') {
        const r = await hud.viewGet(args.name);
        return cap(`// ${r.name} (sha256 ${r.sha256})\n${r.code}`);
      }
      if (action === 'generate') {
        if (!args.spec) throw new Error('spec is required');
        const r = await hud.viewGenerate(args.name, args.spec, { write: !!args.write, overwrite: !!args.overwrite });
        let out = `${r.written ? 'wrote' : 'generated (not written)'} ${r.name}${r.written ? ` at ${r.path}` : ''}\nvalidation: ${r.validation.ok ? 'ok' : r.validation.errors.join('; ')}`;
        if (args.display && r.written) {
          await hud.update(String(args.display), { display: `view:${args.name}` });
          out += `\nset display "view:${args.name}" on ${args.display}`;
        }
        out += `\nTrust: this module runs unsandboxed in the board page. Only install code you trust.`;
        return cap(out);
      }
      if (action === 'write') {
        if (typeof args.code !== 'string') throw new Error('code is required');
        const r = await hud.viewWrite(args.name, { code: args.code, overwrite: !!args.overwrite, expectedSha256: args.expectedSha256, maxChars: MAX_OUT });
        if (r.approvable === false) return r.text;
        return formatAgentViewReview(r);
      }
      if (action === 'approve') {
        if (typeof args.proposalId !== 'string' || typeof args.sha256 !== 'string') throw new Error('approve requires proposalId and sha256 from the review');
        const r = await hud.viewApprove(args.name, { proposalId: args.proposalId, sha256: args.sha256 });
        return `installed ${r.name} at ${r.path} (sha256 ${r.sha256.slice(0, 12)}…)\nTrust: this module runs unsandboxed in the board page. The installed bytes are the reviewed module.`;
      }
      if (action === 'validate') {
        const r = await hud.viewValidate(args.name, args.code);
        return cap(JSON.stringify({ ok: r.ok, rendered: r.rendered, errors: r.errors, warnings: r.warnings, renderErrors: r.renderErrors, sha256: r.sha256 }, null, 2));
      }
      if (action === 'delete') {
        const r = await hud.viewDelete(args.name, args.expectedSha256);
        return `deleted ${args.name}: ${r.deleted}`;
      }
      throw new Error('action must be list|get|generate|write|approve|validate|delete');
    }
    case 'hud_attach': {
      const action = args.action ?? 'list';
      if (action === 'list') {
        await needBoard(args.board, hud);
        return cap(attachmentsMarkdown(await hud.attachments({ board: args.board, scope: args.scope })));
      }
      if (action === 'add') {
        let content: Buffer;
        if (typeof args.content === 'string') content = Buffer.from(args.content);
        else if (typeof args.path === 'string') content = readFileSync(args.path);
        else throw new Error('add needs path or content');
        const name = String(args.name ?? (args.path ? basename(args.path) : '')) || 'attachment.txt';
        const a = await hud.attachmentAdd({ board: args.board, scope: args.scope, name, kind: args.kind, mime: args.mime, target: args.target, baseId: args.baseId, baseSha256: args.baseSha256, corrects: args.corrects, content });
        return `attachment ${a.id} ${a.name} (${a.bytes}b, sha256 ${a.sha256.slice(0, 12)}…)`;
      }
      if (action === 'delete') {
        if (!args.id) throw new Error('id is required');
        const a = await hud.deleteAttachment(String(args.id), !!args.force);
        return `deleted attachment ${a.id}`;
      }
      if (!args.id) throw new Error('id is required');
      if (action === 'get') return cap(JSON.stringify(await hud.attachment(args.id), null, 2));
      if (action === 'content') return cap(await hud.attachmentText(args.id));
      if (action === 'expand') {
        const d = await hud.expandAttachment(args.id);
        return cap(`+${d.added ?? '?'} -${d.removed ?? '?'}${d.truncated ? ' (truncated)' : ''}\n${d.text}`);
      }
      if (action === 'apply') {
        if (!args.target) throw new Error('target is required');
        const r = await applyAttachment(hud, args.id, { target: args.target, expectedSha256: args.expectedSha256, mode: args.mode });
        return `applied ${r.attachment} to ${r.path}${r.backup ? ` (backup ${r.backup})` : ''}`;
      }
      throw new Error('action must be add|list|get|content|expand|apply|delete');
    }
    case 'hud_readout': {
      await needBoard(args.board, hud);
      const r = await hud.readout(args.board);
      return richResult({ ...r }, typeof r.text === 'string' ? r.text : JSON.stringify(r, null, 2));
    }
    case 'hud_snapshot': {
      await needBoard(args.board, hud);
      const r = await hud.snapshot({ board: args.board, format: args.format });
      const warnings = [...(r.warnings ?? []), ...(r.imageUnavailable ? [r.imageUnavailable] : [])];
      const text = `${r.text}${warnings.length ? `\n\n${warnings.join('\n')}` : ''}`;
      return richResult({ ...r }, text, r.image);
    }
    case 'hud_dashboard': {
      const board = args.board ?? 'main';
      const action = args.action ?? (args.spec ? 'set' : 'get');
      await needBoard(board, hud);
      if (action === 'get') {
        const dashboard = await hud.dashboard(board);
        const value = { board, dashboard };
        return richResult(value, dashboard ? JSON.stringify(value, null, 2) : `no dashboard spec on ${board}`);
      }
      if (action !== 'set') throw new Error('action must be get|set');
      if (!args.spec || typeof args.spec !== 'object' || Array.isArray(args.spec)) throw new Error('spec must be an object for set');
      const result = await hud.updateDashboard(board, { spec: args.spec, dryRun: args.dryRun, expectedRevision: args.expectedRevision });
      return richResult({ ...result }, JSON.stringify(result, null, 2));
    }
    case 'hud_annotate': {
      const board = args.board ?? 'main';
      const action = args.action ?? (args.time !== undefined || args.text !== undefined ? 'add' : 'list');
      await needBoard(board, hud);
      if (action === 'list') {
        const annotations = await hud.annotations(board);
        return richResult({ board, annotations }, annotations.length ? annotations.map((a) => `${a.id}  ${new Date(a.time).toISOString()}  ${a.text}`).join('\n') : `no annotations on ${board}`);
      }
      if (action === 'add') {
        if (args.time === undefined || typeof args.text !== 'string') throw new Error('add requires time and text');
        const annotation = await hud.addAnnotation(board, { time: args.time, text: args.text });
        return richResult({ board, annotation }, `added annotation ${annotation.id} on ${board}`);
      }
      if (action === 'delete') {
        if (!args.id) throw new Error('delete requires id');
        const result = await hud.deleteAnnotation(board, args.id);
        return richResult({ board, ...result }, `deleted annotation ${result.id} on ${board}`);
      }
      throw new Error('action must be list|add|delete');
    }
    case 'hud_compare': {
      const board = args.board ?? 'main';
      const action = args.action ?? (args.left !== undefined || args.right !== undefined ? 'add' : 'list');
      await needBoard(board, hud);
      if (action === 'list') {
        const comparisons = await hud.comparisons(board);
        return richResult({ board, comparisons }, comparisons.length ? comparisons.map((r) => `${r.id}  ${r.left} ${r.relation} ${r.right}${r.tolerance === undefined ? '' : ` ±${r.tolerance}`}${r.holdFor === undefined ? '' : ` hold=${r.holdFor}s`}${r.maxSkew === undefined ? '' : ` maxSkew=${r.maxSkew}s`}`).join('\n') : `no comparisons on ${board}`);
      }
      if (action === 'add') {
        if (!args.left || !args.right || !args.relation) throw new Error('add requires left, right, and relation');
        const rule = await hud.addComparison(board, { id: args.id, left: args.left, right: args.right, relation: args.relation, tolerance: args.tolerance, holdFor: args.holdFor, maxSkew: args.maxSkew });
        return richResult({ board, rule }, `added comparison ${rule.id}: ${rule.left} ${rule.relation} ${rule.right}`);
      }
      if (action === 'delete') {
        if (!args.id) throw new Error('delete requires id');
        const result = await hud.deleteComparison(board, args.id);
        return richResult({ board, ...result }, `deleted comparison ${result.id} on ${board}`);
      }
      throw new Error('action must be list|add|delete');
    }
    case 'hud_lint': {
      const board = args.board ?? 'main';
      await needBoard(board, hud);
      const report = await hud.lint(board);
      const text = report.findings.length ? report.findings.map((f) => `${f.severity.toUpperCase()} ${f.code} ${f.id}: ${f.message}`).join('\n') : `no lint findings on ${board}`;
      return richResult({ ...report }, text);
    }
    case 'hud_graph':
    case 'hud_canvas': {
      const isCanvas = name === 'hud_canvas';
      const target = isCanvas ? args.board ?? 'main' : args.id;
      const action = args.action ?? (args.program ? 'preview' : 'get');
      if (isCanvas) await needBoard(target, hud);
      if (action === 'get') {
        const result = isCanvas ? await hud.boardProgram(target) : await hud.itemProgram(target);
        return richResult({ ...(isCanvas ? { board: target } : { id: target }), ...result }, result.program ? JSON.stringify(result.program, null, 2) : `no ${isCanvas ? 'canvas' : 'item'} program on ${target}`);
      }
      if (action === 'delete') {
        const result = isCanvas ? await hud.deleteBoardProgram(target, args.expectedRevision) : await hud.deleteItemProgram(target, args.expectedRevision);
        return richResult({ ...(isCanvas ? { board: target } : { id: target }), ...result }, `deleted ${isCanvas ? 'canvas' : 'item'} program on ${target}`);
      }
      if (!['preview', 'apply', 'disable'].includes(action)) throw new Error('action must be get|preview|apply|disable|delete');
      const request = { action, program: args.program, expectedRevision: args.expectedRevision } as any;
      const result = isCanvas ? await hud.boardProgramAction(target, request) : await hud.itemProgramAction(target, request);
      const image = 'image' in result ? result.image : undefined;
      const textResult = image ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'image')) : result;
      return richResult({ ...(isCanvas ? { board: target } : { id: target }), ...result }, JSON.stringify(textResult, null, 2), image);
    }
    case 'hud_views': {
      const { dir, views } = await hud.views();
      return views.length
        ? `renderer modules in ${dir}:\n${views.map((v) => `  ${v.name.replace(/\.js$/, '')}  (${new Date(v.mtime).toLocaleString()}, ${v.bytes}b)`).join('\n')}\nUse display: "view:<name>" and see hud_guide's Renderers section.`
        : `no renderer modules in ${dir} — drop an ES module there exporting render(ctx) and reference it as display: "view:<name>". See hud_guide.`;
    }
    case 'hud_run':
      return briefReport(await hud.run(args.id));
    case 'hud_ask': {
      if (!Array.isArray(args.options) || !args.options.length) throw new Error('options must be a non-empty array');
      if (args.options.some((o: any) => !o || typeof o.label !== 'string' || !o.label)) throw new Error('every option needs a label');
      let tk = await hud.ask(args.id, args.options, args.question, args.questionFormat);
      // wake THIS session when answered
      const me = sessionName();
      const notify: string[] = (tk as any).notify ?? [];
      if (!notify.includes(me) && !notify.includes('*')) tk = await hud.update(tk.id, { notify: [...notify, me] } as any).catch(() => tk);
      startAlertStream();
      const opts = (tk.options ?? []).map((o) => `  ${o.id}  ${o.label}${o.detail ? ` — ${o.detail}` : ''}${o.status ? ` [→${o.status}]` : ''}`).join('\n');
      const id = (tk as any).ident ?? tk.id;
      return `${id} needs a decision${tk.question ? `: ${tk.question}` : ''}\n${opts}\nrevision: ${(tk as any).decisionVersion ?? '—'}\nthe human picks it on the canvas (or hud_decide ${id} <optionId> with decisionVersion). Read the answer with hud_get ${id} → decision.`;
    }
    case 'hud_decide': {
      const tk = await hud.decide(args.id, args.optionId, args.note, args.decisionVersion);
      const opt = tk.options?.find((o) => o.id === tk.decision?.optionId);
      return `decided ${(tk as any).ident ?? tk.id}: ${opt?.label ?? args.optionId} → ${tk.status}`;
    }
    case 'hud_finish': {
      await needBoard(args.board);
      const r = await hud.finish({ board: args.board, ids: args.ids, note: args.note, organize: args.organize });
      return r.done.length ? `finished ${r.board}: ${r.done.join(', ')}` : `finished ${r.board}: nothing left to complete`;
    }
  }
  throw new Error(`unknown tool ${name}`);
}

function localTime(t: number) {
  return new Date(t).toLocaleString('sv-SE', { hour12: false }).slice(0, 19) + ' ' + (Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')?.value ?? '');
}

function alertText(a: any) {
  const v = a.value !== undefined && a.value !== null ? ` (${a.value})` : '';
  return `[alert ${a.id}] ${localTime(a.t)} ${a.itemId} "${a.title}" ${a.from} → ${a.to}${v}${a.message ? `: ${a.message}` : ''} [board ${a.board}]`;
}

// ---------- alerts → this conversation (Claude Code channels) ----------
const session: { name?: string } = {};
let baseActor = baseHud.actor;
let streaming = false;
let lastAlert = -1;
/** unique per session so alerts don't cross-deliver: HUD_SESSION, else <actor>-<parent pid> */
function sessionName() {
  return session.name ?? process.env.HUD_SESSION ?? `${baseActor}-${process.ppid}`;
}
function deliver(al: any) {
  if (!al || typeof al.id !== 'number' || al.id <= lastAlert) return;
  lastAlert = al.id;
  const notify: string[] = al.notify ?? [];
  if (!notify.includes(sessionName()) && !notify.includes('*')) return;
  out({
    jsonrpc: '2.0',
    method: 'notifications/claude/channel',
    params: {
      content: `${alertText(al)}\nCheck it with hud_get ${al.itemId}; acknowledge with hud_alerts ack=true.`,
      meta: { monitor: al.itemId, state: al.to, board: al.board, alert_id: String(al.id) },
    },
  });
}
async function startAlertStream() {
  if (streaming) return;
  streaming = true;
  for (;;) {
    try {
      await baseHud.ensureServer();
      const res = await fetch(baseHud.url + '/api/events');
      if (!res.ok || !res.body) throw new Error('events ' + res.status);
      // catch up on alerts raised while we were disconnected (first connect only skips history)
      const missed: any[] = await baseHud.request('GET', `/api/alerts?all=1${lastAlert >= 0 ? `&since=${lastAlert}` : ''}`).catch(() => []);
      if (lastAlert < 0) lastAlert = missed.reduce((m, a) => Math.max(m, a.id ?? 0), 0);
      else for (const al of missed) deliver(al);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          try {
            const e = JSON.parse(data);
            if (e.kind === 'alert') deliver(e.alert);
          } catch {}
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function out(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function actorFromClient(name?: string) {
  if (!name) return;
  const n = name.toLowerCase();
  if (n.includes('claude')) return 'claude';
  if (n.includes('codex')) return 'codex';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('opencode')) return 'opencode';
  if (n.includes('muse')) return 'muse';
  return n.replace(/[^a-z0-9-]/g, '').slice(0, 24) || undefined;
}

const CALL_TIMEOUT = Number(process.env.HUD_MCP_TIMEOUT) || 60_000;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(res, rej).finally(() => clearTimeout(t));
  });

const INSTRUCTIONS =
  'hud is a live local dashboard shared with the human: tickets, monitors, on-canvas utilities and notes. ' +
  'For monitoring work, start with hud_readout, then use hud_dashboard, hud_annotate, and hud_compare as needed; run hud_lint after changes and hud_snapshot to retain a view. For custom renderers, inspect with hud_graph/hud_canvas, preview before apply, and bind only the required metric data. Read the hud://guide resource or call hud_guide for schemas and examples. ' +
  'To reset a board while keeping its identity and settings, use hud_clear_canvas or hud_board {action:"clear",id}; hud_board {action:"delete",id} deletes the board. ' +
  'Visual style: use a monochrome terminal palette of black, white, and gray; reserve red for stated blocked/error/attention conditions and green for stated done/ok conditions. Every status color must have a readable label or glyph, and panels should stay concise and legible. ' +
  'Use hud_attention for the human-attention queue (review is separate from acknowledging old agent alerts); use hud_runs for run summaries and hud_changes {since} for incremental sync. These reports are readable structured Markdown tables/lists, while numeric value/progress stays numeric in item data. ' +
  'Tickets and projects are list objects: never place or size them on the canvas. The Tickets view opens rows in a scrollable sidebar and tucks away completed work by default. Dashboard shows monitors, notes, utilities and visual frames; double-click opens the same sidebar. Ticket-only groups take no dashboard space. Use hud_tickets and hud_get for all ticket details, including completed tickets. ' +
  'Visual layout: every board is a fixed 1600×900 surface with bounded zoom. Auto layout is enabled by default and fills the surface as cards accumulate; small collections are centered. Group related training/job monitors by a run tag, create a concise run-summary ticket first, set its summaryMonitor to the one explicit progress/ETA source, then add detail charts and linked tickets. Use concise titles with units, keep numeric value/progress separate from the short message headline, put a longer Markdown report in details, and set staleAfter or a heartbeat so freshness is visible. Call hud_organize after a batch. Reading updates preserve positions. For a deliberate sparse layout, use hud_organize {auto:false} then hud_update x/y/w/h within the board; keep cards readable and nonoverlapping. Respect a human-selected manual layout, and split crowded runs into separate boards. Tickets have an immutable uuid that can be copied with the SVG button; paste it anywhere an id or KEY-n is accepted. ' +
  'Work with tickets through the Linear-style tools, not the canvas: hud_tickets / hud_search list work with KEY-n idents, hud_project makes projects, hud_create {type:"ticket", project, title, body} adds one, hud_link sets project/parent/blockers/refs, hud_update moves it (status/priority/assignee/target). Reference tickets by ident (EGO-12). A ticket waiting on unfinished work is auto-blocked: use hud_link {blockedBy} rather than setting status blocked, and use hud_ask when you need a human decision. Decision answers require the current decisionVersion from hud_get/hud_ask; never guess or silently fetch a newer version. Use hud_push for progress, hud_comment for notes (format plain or markdown). Deletes go to the trash (hud_trash restores). ' +
  'When several agents share a board, follow one coordination playbook and no other protocol: hud_guide {playbook:"decentralized"} (everyone pulls ready work) or hud_guide {playbook:"lead"} (one lead links and assigns). The playbook is claim, publish a FACT, wait, finish, plus an expired lease, a blocked ticket, and an assignee conflict. ' +
  'A monitor with source.kind "command" runs a shell command as the user: only create one when the user wants it. ' +
  'Alerts from monitors this session watches (hud_watch) or from hud_ask answers arrive as <channel source="hud"> messages: look (hud_get), act if it is yours, tell the user, then hud_alerts ack=true. This session is named by HUD_SESSION, else <actor>-<ppid>.';

// ---------- presence ----------
let heartbeatTimer: NodeJS.Timeout | null = null;
let presenceRegistered = false;
async function registerPresence() {
  if (presenceRegistered) return;
  presenceRegistered = true;
  try { await baseHud.sessionStart(sessionName(), { actor: baseActor, kind: 'agent', pid: process.pid }); } catch {}
  heartbeatTimer = setInterval(() => { baseHud.sessionHeartbeat(sessionName()).catch(() => {}); }, 20_000);
  heartbeatTimer.unref();
}
async function endPresence() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (!presenceRegistered) return;
  presenceRegistered = false;
  try { await baseHud.sessionEnd(sessionName()); } catch {}
}

// stdin: one JSON-RPC message per line, tools/call strictly in order
let chain: Promise<unknown> = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  chain = chain.then(() => handle(raw)).catch(() => {});
});
rl.on('close', async () => {
  await chain;
  await endPresence();
  process.stdout.write('', () => process.exit(0));
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { endPresence().finally(() => process.exit(0)); });

const rpcError = (id: unknown, code: number, message: string) => out({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(raw: string): Promise<void> {
  if (!raw.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, 'parse error');
  }
  if (Array.isArray(msg)) {
    if (!msg.length) return rpcError(null, -32600, 'empty batch');
    for (const m of msg) await handleOne(m);
    return;
  }
  await handleOne(msg);
}

async function handleOne(msg: any): Promise<void> {
  if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'invalid request');
  const { method, params } = msg;
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : undefined;
  if (msg.id !== undefined && id === undefined) return rpcError(null, -32600, 'invalid id');
  if (typeof method !== 'string') {
    if (id !== undefined && msg.result === undefined && msg.error === undefined) rpcError(id, -32600, 'missing method');
    return; // a response from the client: ignore
  }
  const reply = (result: unknown) => id !== undefined && out({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize': {
        if (!process.env.HUD_ACTOR) baseHud.actor = baseActor = actorFromClient(params?.clientInfo?.name) ?? baseActor;
        void registerPresence();
        // start streaming once the session has any watches (or HUD_SESSION is set); hud_watch/hud_ask also start it
        setTimeout(async () => {
          try {
            const boards: any[] = await baseHud.boards();
            const items: any[] = await baseHud.items({ type: 'monitor' });
            const me = sessionName();
            if (process.env.HUD_SESSION || boards.some((b) => b.notify?.includes(me)) || items.some((m) => m.notify?.includes(me))) startAlertStream();
          } catch {}
        }, 500);
        const want = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
        return void reply({
          // channel servers must use the pre-2026 handshake
          protocolVersion: want > '2025-06-18' ? '2025-06-18' : want,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, experimental: { 'claude/channel': {} } },
          serverInfo: { name: 'hud', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return void reply({});
      case 'tools/list':
        return void reply({ tools: listed });
      case 'tools/call':
        try {
          const result = await withTimeout(call(params?.name, params?.arguments), CALL_TIMEOUT, String(params?.name));
          return void reply(typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result);
        } catch (e) {
          return void reply({ content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true });
        }
      case 'resources/list':
        return void reply({
          resources: [
            { uri: 'hud://guide', name: 'Hud guide', description: 'Full hud usage guide, metric fields, dashboard schemas, and rendering conventions.', mimeType: 'text/markdown' },
            { uri: 'hud://playbook/decentralized', name: 'Decentralized coordination playbook', description: 'Copy-paste runbook: claim, publish a FACT, wait, finish. No lead. Includes expired lease, blocked ticket, and assignee conflict.', mimeType: 'text/markdown' },
            { uri: 'hud://playbook/lead', name: 'Lead coordination playbook', description: 'Copy-paste runbook for a lead who links and assigns work, and for workers who pull. Includes expired lease, blocked ticket, and assignee conflict.', mimeType: 'text/markdown' },
          ],
        });
      case 'resources/read': {
        const uri = String(params?.uri ?? '');
        const play = /^hud:\/\/playbook\/([A-Za-z0-9_-]+)$/.exec(uri);
        if (uri === 'hud://guide') {
          const text = await baseHud.guide();
          return void reply({ contents: [{ uri, mimeType: 'text/markdown', text }] });
        }
        if (play) {
          const text = await baseHud.guide(play[1]);
          return void reply({ contents: [{ uri, mimeType: 'text/markdown', text }] });
        }
        throw new Error(`unknown resource ${uri}`);
      }
      case 'prompts/list':
        return void reply({ prompts: [] });
      default:
        if (id === undefined) return; // notification
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) rpcError(id, -32603, (e as Error).message);
  }
}
