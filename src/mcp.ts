/**
 * MCP server (stdio, newline-delimited JSON-RPC) exposing hud to any MCP-capable agent harness.
 *   claude mcp add hud -- node /path/to/dashboard/src/mcp.ts
 *   codex mcp add hud -- node /path/to/dashboard/src/mcp.ts
 * Starts the hud server in the background if it isn't running.
 */
import { createInterface } from 'node:readline';
import { Hud } from './client.ts';
import { line } from './summary.ts';
import type { Item } from './types.ts';

const hud = new Hud({ actor: process.env.HUD_ACTOR ?? 'agent' });

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
      'monitor view: auto (default), value, progress, status, text, log, spark, line, area, bars, gauge, histogram, scatter, pie, donut, heatmap, box, ridgeline, scatter3d, surface3d, or "view:<name>" (hud_views)',
  },
  plot: {
    type: 'object',
    description:
      'chart options: {series} dot path into meta; {bins}, {points}, {stacked}, {tilt, spin}, {yMin, yMax, auto}, {animate}. See hud_guide',
  },
  value: { description: 'monitor: current value. Prefer a number (thresholds, charts, ETA need one) and put display text in label' },
  label: { type: 'string', description: 'monitor: text shown instead of the value, e.g. value 2 → label "2/4 busy"' },
  notify: { type: 'array', items: { type: 'string' }, description: 'sessions to wake on this item\'s events: a monitor\'s warn/error/stale/done, a ticket\'s decision ("*" = every watching session)' },
  monitors: { type: 'array', items: { type: 'string' }, description: 'ticket: linked monitor ids, shown live on the ticket' },
  autoStatus: { type: 'boolean', description: 'ticket: all linked monitors done → done; any in error → blocked (back to doing on recovery)' },
  question: { type: 'string', description: 'ticket: the question that goes with proposed options' },
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
    description: 'Full usage guide for hud (data model, monitor sources, probe modules, layout conventions, HTTP API).',
    inputSchema: { type: 'object', properties: {} },
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
        state: ITEM_FIELDS.state,
        message: { type: 'string' },
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
    name: 'hud_comment',
    description: 'Append a comment to an item. With cid: edit it (text) or delete it (delete:true).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, text: { type: 'string' }, cid: { type: 'string', description: 'comment id to edit/delete' }, delete: { type: 'boolean' } },
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
    name: 'hud_board',
    description: 'Boards. action: list | create (name) | rename (id, name) | delete (id; items go to trash; "main" cannot be deleted).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: { action: { type: 'string', enum: ['list', 'create', 'rename', 'delete'] }, id: { type: 'string' }, name: { type: 'string' } },
    },
  },
  {
    name: 'hud_organize',
    description:
      'Clean up a board: every group becomes a frame, members are sorted (monitors, then tickets by status/priority, then utils, then notes) and packed inside, then frames and ungrouped items are packed into rows. auto=true keeps the board organized automatically whenever items are added, removed or regrouped; auto=false turns that off.',
    inputSchema: { type: 'object', properties: { board: { type: 'string' }, auto: { type: 'boolean' } } },
  },
  {
    name: 'hud_arrange',
    description: 'Tidy layout: flow items left-to-right in rows. With frame: arranges that frame\'s contents (frame resizes to fit). Without: arranges top-level items of a board (frames move with their contents). ids sets explicit order.',
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
      required: ['id', 'optionId'],
      properties: { id: { type: 'string' }, optionId: { type: 'string' }, note: { type: 'string' } },
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
];

const RO = new Set(['hud_overview', 'hud_tickets', 'hud_search', 'hud_guide', 'hud_get', 'hud_views']);
const DESTRUCTIVE = new Set(['hud_delete', 'hud_finish', 'hud_trash', 'hud_board']);
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

const MAX_OUT = 60_000;
function cap(text: string) {
  return text.length > MAX_OUT ? `${text.slice(0, MAX_OUT)}\n… truncated (${text.length} chars); narrow it with filters (board, status, limit, hud_search)` : text;
}

async function needBoard(board?: string) {
  if (!board) return;
  const boards = await hud.boards();
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

async function call(name: string, a: any): Promise<string> {
  validate(name, a);
  const { actor, ...args } = a ?? {};
  hud.actor = actor ? String(actor) : baseActor;
  switch (name) {
    case 'hud_overview': {
      await needBoard(args.board);
      const alerts: any[] = await hud.request('GET', '/api/alerts');
      const al = alerts.length ? `\n\nunacknowledged alerts (${alerts.length}):\n${alerts.slice(-10).map(alertText).join('\n')}` : '';
      return cap(`${await hud.summary(args.board)}${al}\n\nlive canvas: ${hud.url}`);
    }
    case 'hud_guide':
      return hud.guide();
    case 'hud_search': {
      await needBoard(args.board);
      const q = filters(args);
      if (!q.has('limit')) q.set('limit', '50');
      const items: Item[] = await hud.request('GET', `/api/items?${q}`);
      return items.length ? cap(items.map((it) => brief(it)).join('\n')) : 'no matches';
    }
    case 'hud_tickets': {
      const board = args.board ?? 'main';
      await needBoard(board);
      const q = filters({ ...args, board });
      if (args.format === 'json') return cap(JSON.stringify((await hud.request('GET', `/api/tickets?${q}`)).groups, null, 2));
      q.set('format', 'text');
      return cap(await hud.request('GET', `/api/tickets?${q}`));
    }
    case 'hud_project': {
      await needBoard(args.board);
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
      return brief(await hud.push(id, r));
    }
    case 'hud_comment': {
      const path = `/api/items/${encodeURIComponent(args.id)}/comments`;
      if (args.cid && args.delete) {
        await hud.request('DELETE', `${path}/${encodeURIComponent(args.cid)}`);
        return `deleted comment ${args.cid} on ${args.id}`;
      }
      if (args.text === undefined || args.text === '') throw new Error('missing required argument "text" for hud_comment');
      if (args.cid) {
        await hud.request('PATCH', `${path}/${encodeURIComponent(args.cid)}`, { text: args.text });
        return `edited comment ${args.cid} on ${args.id}`;
      }
      await hud.comment(args.id, args.text);
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
    case 'hud_board':
      if (args.action === 'list') return (await hud.boards()).map((b) => `${b.id}  "${b.name}"${b.autoOrganize ? '  (auto-organize)' : ''}`).join('\n');
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
      if (args.action === 'delete') {
        if (!args.id) throw new Error('missing required argument "id" for delete');
        await hud.request('DELETE', `/api/boards/${encodeURIComponent(args.id)}`);
        return `deleted board ${args.id} (its items are in the trash)`;
      }
      throw new Error('action must be list|create|rename|delete');
    case 'hud_organize': {
      await needBoard(args.board);
      const r = await hud.organize(args.board, args.auto);
      return `organized ${args.board ?? 'main'}: ${r.groups.length} groups (${r.groups.join(', ') || 'none'}), ${r.moved} items moved${args.auto !== undefined ? `; auto-organize ${args.auto ? 'on' : 'off'}` : ''}`;
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
    case 'hud_views': {
      const { dir, views } = await hud.views();
      return views.length
        ? `renderer modules in ${dir}:\n${views.map((v) => `  ${v.name.replace(/\.js$/, '')}  (${new Date(v.mtime).toLocaleString()}, ${v.bytes}b)`).join('\n')}\nUse display: "view:<name>" and see hud_guide's Renderers section.`
        : `no renderer modules in ${dir} — drop an ES module there exporting render(ctx) and reference it as display: "view:<name>". See hud_guide.`;
    }
    case 'hud_run':
      return brief(await hud.run(args.id));
    case 'hud_ask': {
      if (!Array.isArray(args.options) || !args.options.length) throw new Error('options must be a non-empty array');
      if (args.options.some((o: any) => !o || typeof o.label !== 'string' || !o.label)) throw new Error('every option needs a label');
      let tk = await hud.ask(args.id, args.options, args.question);
      // wake THIS session when answered
      const me = sessionName();
      const notify: string[] = (tk as any).notify ?? [];
      if (!notify.includes(me) && !notify.includes('*')) tk = await hud.update(tk.id, { notify: [...notify, me] } as any).catch(() => tk);
      startAlertStream();
      const opts = (tk.options ?? []).map((o) => `  ${o.id}  ${o.label}${o.detail ? ` — ${o.detail}` : ''}${o.status ? ` [→${o.status}]` : ''}`).join('\n');
      const id = (tk as any).ident ?? tk.id;
      return `${id} needs a decision${tk.question ? `: ${tk.question}` : ''}\n${opts}\nthe human picks it on the canvas (or hud_decide ${id} <optionId>). Read the answer with hud_get ${id} → decision.`;
    }
    case 'hud_decide': {
      const tk = await hud.decide(args.id, args.optionId, args.note);
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
let baseActor = hud.actor;
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
      await hud.ensureServer();
      const res = await fetch(hud.url + '/api/events');
      if (!res.ok || !res.body) throw new Error('events ' + res.status);
      // catch up on alerts raised while we were disconnected (first connect only skips history)
      const missed: any[] = await hud.request('GET', `/api/alerts?all=1${lastAlert >= 0 ? `&since=${lastAlert}` : ''}`).catch(() => []);
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
  'Work with tickets through the Linear-style tools, not the canvas: hud_tickets / hud_search list work with KEY-n idents, hud_project makes projects, hud_create {type:"ticket", project, title, body} adds one, hud_link sets project/parent/blockers/refs, hud_update moves it (status/priority/assignee/target). Reference tickets by ident (EGO-12). A ticket waiting on unfinished work is auto-blocked: use hud_link {blockedBy} rather than setting status blocked, and use hud_ask when you need a human decision. Use hud_push for progress, hud_comment for notes. Deletes go to the trash (hud_trash restores). ' +
  'A monitor with source.kind "command" runs a shell command as the user: only create one when the user wants it. ' +
  'Alerts from monitors this session watches (hud_watch) or from hud_ask answers arrive as <channel source="hud"> messages: look (hud_get), act if it is yours, tell the user, then hud_alerts ack=true. This session is named by HUD_SESSION, else <actor>-<ppid>.';

// stdin: one JSON-RPC message per line, tools/call strictly in order
let chain: Promise<unknown> = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  chain = chain.then(() => handle(raw)).catch(() => {});
});
rl.on('close', async () => {
  await chain;
  process.stdout.write('', () => process.exit(0));
});

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
        if (!process.env.HUD_ACTOR) hud.actor = baseActor = actorFromClient(params?.clientInfo?.name) ?? baseActor;
        // start streaming once the session has any watches (or HUD_SESSION is set); hud_watch/hud_ask also start it
        setTimeout(async () => {
          try {
            const boards: any[] = await hud.boards();
            const items: any[] = await hud.items({ type: 'monitor' });
            const me = sessionName();
            if (process.env.HUD_SESSION || boards.some((b) => b.notify?.includes(me)) || items.some((m) => m.notify?.includes(me))) startAlertStream();
          } catch {}
        }, 500);
        const want = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
        return void reply({
          // channel servers must use the pre-2026 handshake
          protocolVersion: want > '2025-06-18' ? '2025-06-18' : want,
          capabilities: { tools: { listChanged: false }, experimental: { 'claude/channel': {} } },
          serverInfo: { name: 'hud', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return void reply({});
      case 'tools/list':
        return void reply({ tools: listed });
      case 'tools/call':
        try {
          const text = await withTimeout(call(params?.name, params?.arguments), CALL_TIMEOUT, String(params?.name));
          return void reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return void reply({ content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true });
        }
      case 'resources/list':
        return void reply({ resources: [] });
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
