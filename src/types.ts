export type ItemType = 'ticket' | 'monitor' | 'note' | 'frame' | 'util' | 'project';
export type MonState = 'ok' | 'warn' | 'error' | 'unknown' | 'running' | 'done';
export type TextFormat = 'plain' | 'markdown';

export interface MetricSpec {
  kind?: 'scalar' | 'capacity' | 'rate' | 'counter' | 'breakdown' | 'table' | 'grid';
  key?: string;
  scope?: string;
  unit?: string;
  definition?: string;
  windowSeconds?: number;
  target?: number;
  denominator?: number;
  source?: string;
  sourceId?: string;
}
export interface Observation {
  observedAt: number | null;
  receivedAt: number;
  actor: string;
  evidence: 'measured' | 'reported' | 'estimate' | 'unknown';
  availability: 'available' | 'partial' | 'unavailable';
  coverage?: { responding: number; total: number };
}
export interface TableData {
  columns: { key: string; label?: string; unit?: string; type?: 'number' | 'string' | 'boolean' }[];
  rows: Record<string, unknown>[];
}
export interface PipelineSpec {
  stages: { key: string; label: string; throughput?: string; queued?: string; inFlight?: string; oldestAge?: string; retries?: string; rejected?: string }[];
}
export interface Annotation { id: string; time: number; text: string; actor: string; deletedAt?: number }
export interface ComparisonRule { id: string; left: string; right: string; relation: 'equal' | 'lte' | 'gte'; tolerance?: number; holdFor?: number; maxSkew?: number; since?: number; deletedAt?: number }
export interface ProgramSpec {
  code: string;
  language: 'html' | 'javascript' | 'svg';
  description: string;
  bindings: string[];
  capabilities: { operation: string; scope: string }[];
}
export interface CanvasProgram extends ProgramSpec { revision: string; actor: string; validatedAt: number; disabled?: boolean; previous?: CanvasProgram }
export interface ProgramDraft { program: ProgramSpec; actor: string; createdAt: number; errors: string[] }
export interface DashboardSpec {
  rows: { key: string; height?: number; cards: { key: string; span?: number; id?: string; item: Partial<Item> & { type: ItemType } }[] }[];
  annotations?: { time: number; text: string }[];
  comparisons?: Omit<ComparisonRule, 'id'>[];
}

/** the canonical ticket workflow, in the order a board reads (Linear's set plus review/blocked) */
export const TICKET_STATUSES = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done', 'canceled'] as const;
export const TICKET_PRIORITIES = ['low', 'med', 'high', 'urgent'] as const;

/** fixed monitor views drawn by web/views.js ('view:<name>' loads a module from views/ instead) */
export type DisplayKind =
  | 'auto' | 'value' | 'progress' | 'status' | 'text' | 'log' | 'spark'
  | 'line' | 'area' | 'bars' | 'gauge' | 'histogram' | 'scatter' | 'pie' | 'donut'
  | 'heatmap' | 'box' | 'ridgeline' | 'scatter3d' | 'surface3d'
  | 'composite' | 'capacity' | 'breakdown' | 'table' | 'grid' | 'pipeline' | 'bullet' | 'waterfall' | 'custom';

/**
 * Options for a chart display. Where the numbers come from, how to draw them, and how to frame them.
 * `series` is a dot path into the item's `meta`: an object gives named values (pie/bars/heatmap),
 * an array of [x,y(,z)] gives points (scatter/scatter3d), an array of arrays gives a grid (surface3d).
 */
export interface PlotSpec {
  targets?: { value: number; label?: string }[];
  events?: { id?: string; time: number; text: string }[];
  metrics?: string[];
  /** dot path into meta, e.g. "gpu" or "runs.0.cells" */
  series?: string;
  /** bins for histogram/ridgeline, inner radius % for donut */
  bins?: number;
  /** draw point markers on a line */
  points?: boolean;
  /** number of windows for ridgeline */
  stacked?: boolean | number;
  /** camera: azimuth in degrees (scatter3d / surface3d) */
  tilt?: number;
  /** camera: elevation in degrees */
  spin?: number;
  /** pinned y-range; either edge on its own leaves the other automatic */
  yMin?: number;
  yMax?: number;
  /** false pins the range to yMin/yMax exactly (no padding) */
  auto?: boolean;
  /** legend labels */
  label?: string;
  legend?: boolean;
  /** 'orbit' keeps a 3D view turning; 'replay' animates a series over time */
  animate?: 'none' | 'replay' | 'orbit';
}

export interface Board {
  dashboard?: { revision: string; spec: DashboardSpec; keys: Record<string, string> };
  annotations?: Annotation[];
  comparisons?: ComparisonRule[];
  program?: CanvasProgram;
  programDraft?: ProgramDraft;
  id: string;
  name: string;
  createdAt: number;
  width: number;
  height: number;
  /** re-run organize automatically whenever items are added, removed, regrouped or resized */
  autoOrganize?: boolean;
  /** sessions woken by alerts from any monitor on this board */
  notify?: string[];
}

export interface Comment {
  id: string;
  t: number;
  actor: string;
  text: string;
  format?: TextFormat;
  /** set when the text was edited after posting */
  edited?: number;
}

/** a choice an agent proposes on a blocked ticket for a human to pick */
export interface DecisionOption {
  id: string;
  label: string;
  detail?: string;
  /** ticket status to move to when this option is chosen (default doing) */
  status?: string;
}

export interface Decision {
  optionId: string;
  t: number;
  actor: string;
  note?: string;
}

export interface MonitorSource {
  /**
   * manual: set by hand / API. push: an external process POSTs results. command/http/probe: polled by hud.
   * heartbeat: a job pings /ping/:id; no ping within period+grace is an error.
   */
  kind: 'manual' | 'push' | 'command' | 'http' | 'probe' | 'heartbeat';
  /** seconds between runs (command/http/probe), 1-86400 */
  interval?: number;
  /** seconds before a run is aborted, 1-3600 */
  timeout?: number;
  /** heartbeat: expected seconds between pings (default 60) */
  period?: number;
  /** heartbeat: extra seconds allowed before the missing ping is an error (default 60) */
  grace?: number;
  command?: string;
  cwd?: string;
  url?: string;
  method?: string;
  expectStatus?: number;
  /** http: request headers */
  headers?: Record<string, string>;
  /** http: request body */
  body?: string;
  /** http: text the response body must include, else the check errors */
  contains?: string;
  /** http: bytes of response read before the check gives up (default 5 MB) */
  maxBytes?: number;
  /** dot path into a JSON response, e.g. "data.count" or "items.0.state" */
  jsonPath?: string;
  /** probe name in probes/ (without extension) or an absolute path to a .ts/.js module */
  probe?: string;
  /** passed to the probe as ctx.config */
  config?: Record<string, unknown>;
}

export interface MonitorResult {
  metric?: MetricSpec;
  observedAt?: number;
  evidence?: 'reported' | 'estimate';
  availability?: Observation['availability'];
  coverage?: Observation['coverage'];
  data?: TableData;
  value?: string | number | boolean | null;
  state?: MonState;
  message?: string;
  messageFormat?: TextFormat;
  /** Longer Markdown report. Numeric readings remain separate. */
  details?: string;
  /** percent, 0-100 */
  progress?: number | null;
  unit?: string;
  /** text shown instead of the value (the value stays numeric for thresholds, charts and ETA) */
  label?: string | null;
  /** fan-out: readings for other monitors, keyed by monitor id (created on first sight) */
  monitors?: Record<string, MonitorResult & { title?: string }>;
}

export interface Item {
  id: string;
  /** Stable copy/paste reference for tickets, including tickets with legacy ids. */
  uuid?: string;
  type: ItemType;
  board: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  /** group name; items in a group live inside the frame titled with that name */
  group?: string;
  /** free-form data owned by whoever created the item */
  meta?: Record<string, unknown>;

  // ticket
  num?: number;
  body?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  tags?: string[];
  comments?: Comment[];
  /** monitor ids whose live state the ticket shows */
  monitors?: string[];
  /** move the ticket automatically: all linked monitors done → done; any error → blocked (and back) */
  autoStatus?: boolean;
  autoBlocked?: boolean;
  /** choices an agent proposed when it got blocked, for a human to pick from */
  options?: DecisionOption[];
  /** the question that goes with those options */
  question?: string;
  questionFormat?: TextFormat;
  decisionVersion?: string;
  /** Explicit progress source for a ticket tagged run; must be in monitors. */
  summaryMonitor?: string;
  /** the chosen option, once a human (or agent) has decided */
  decision?: Decision;

  // ticket — Linear-style structure
  /** the project this ticket belongs to (a `project` item's id); sets its KEY-n identifier */
  project?: string;
  /** parent ticket id: this ticket is a subticket of it */
  parent?: string;
  /** tickets this one waits on; while any is unfinished this ticket is auto-blocked */
  blockedBy?: string[];
  /** other tickets this one mentions/relates to, on top of any KEY-n found in the text */
  refs?: string[];
  /** git branch name, generated on create (regenerate with `branch: "regen"`) */
  branch?: string;
  /** target/due date, ISO yyyy-mm-dd */
  target?: string;
  /** the status to return to when an automatic block (blockers, errored monitors) clears */
  resumeStatus?: string;
  /** who owns the project / leads it (project items) */
  lead?: string;

  // project
  /** short uppercase prefix for this project's tickets, e.g. "EGO" -> EGO-12 */
  key?: string;

  // monitor
  metric?: MetricSpec;
  observedAt?: number;
  evidence?: 'reported' | 'estimate';
  availability?: Observation['availability'];
  coverage?: Observation['coverage'];
  observation?: Observation;
  lastAttempt?: number;
  lastGood?: { value?: Item['value']; progress?: number | null; data?: TableData; observation: Observation };
  freshness?: { mode: 'live' | 'static'; reason?: string };
  data?: TableData;
  pipeline?: PipelineSpec;
  program?: CanvasProgram;
  programDraft?: ProgramDraft;
  source?: MonitorSource;
  /**
   * Monitor view. 'auto' adapts to the data; the fixed kinds are drawn by web/views.js;
   * 'view:<name>' loads a renderer module from views/ that exports render(ctx).
   */
  display?: DisplayKind | `view:${string}`;
  /** options for the chart kinds: series path, bins, y-range, 3D camera, animation */
  plot?: PlotSpec;
  value?: string | number | boolean | null;
  unit?: string;
  state?: MonState;
  message?: string;
  messageFormat?: TextFormat;
  details?: string;
  reportHistory?: { t: number; actor: string; message?: string; messageFormat?: TextFormat; details?: string }[];
  progress?: number | null;
  max?: number;
  staleAfter?: number;
  warnAbove?: number;
  errorAbove?: number;
  warnBelow?: number;
  errorBelow?: number;
  label?: string | null;
  /** sessions to wake on this item's events: a monitor's warn/error/stale/done, a ticket's decision ("*" = every watching session) */
  notify?: string[];
  /** currently stale (no update within staleAfter) */
  stale?: boolean;
  history?: { t: number; v: number | null; s: MonState; p?: number | null; e?: Observation['evidence']; receivedAt?: number }[];
  /**
   * per-minute buckets for the last 24h (not sent over the live stream; GET /api/items/:id):
   * `n` numeric readings averaged into `v`, `w` the worst severity seen (0 ok/other, 1 warn, 2 error)
   */
  trend?: { t: number; v: number | null; p?: number | null; n: number; w?: number; e?: Observation['evidence'] }[];
  /** percent of recorded minutes that were not error; only on GET /api/items/:id */
  uptime?: { h1: number | null; h24: number | null };
  log?: { t: number; s: MonState; m: string }[];
  lastUpdate?: number;
  lastRun?: number;

  // note
  text?: string;

  // util
  /** which utility this is: timer | stopwatch | clock | counter | calculator | sheet | markdown | dice */
  kind?: string;
  /** per-kind state (timer duration, counter step, sheet size, …) */
  util?: Record<string, unknown>;
}

export interface Activity {
  id: number;
  t: number;
  actor: string;
  action: string;
  itemId?: string;
  board?: string;
  text: string;
}

export interface Alert {
  id: number;
  t: number;
  itemId: string;
  board: string;
  title: string;
  from: string;
  to: 'warn' | 'error' | 'stale' | 'done' | 'answered' | 'comment' | 'status' | 'assigned';
  message?: string;
  value?: unknown;
  notify: string[];
  acked?: boolean;
}

/** a deleted item (or board snapshot) kept so it can be restored */
export interface TrashEntry {
  item: Item;
  t: number;
  actor: string;
  /** set when the whole board was deleted: the board the item belonged to */
  board?: Board;
}

export interface SearchQuery {
  board?: string;
  type?: string;
  status?: string | string[];
  priority?: string;
  assignee?: string;
  /** claimer while a lease is held, otherwise the assignee. `none` or `-` means neither. */
  owner?: string;
  project?: string;
  tag?: string;
  text?: string;
  overdue?: boolean;
  parent?: string;
  limit?: number;
}

/** assignee is durable; claimer is the live lease; owner is the claimer while claimed, else the assignee */
export interface Ownership {
  assignee: string | null;
  claimer: string | null;
  claimSession: string | null;
  owner: string | null;
}

export interface State {
  version: number;
  seq: Record<string, number>;
  boards: Board[];
  /** id → item; a null-prototype object, always accessed by own key */
  items: Record<string, Item>;
  /** append-only shared context, ordered by seq */
  context: ContextEntry[];
  /** attachment metadata; bytes live under <dataDir>/attachments */
  attachments: Record<string, AttachmentRecord>;
  activity: Activity[];
  alerts: Alert[];
  trash: TrashEntry[];
  attention: Record<string, AttentionRecord>;
}

export interface AttentionRecord {
  id: string;
  itemId: string;
  kind: 'decision' | 'error' | 'stale' | 'warn' | 'blocked';
  priority: number;
  openedAt: number;
  revision: string;
  /** A decision replacement also starts a new episode. */
  signature: string;
  resolvedAt?: number;
  reviewedAt?: number;
  reviewedBy?: string;
  snoozedUntil?: number;
  snoozedBy?: string;
}

export interface AttentionItem extends AttentionRecord {
  board: string;
  title: string;
  owner: string;
  lastUpdate?: number;
  message?: string;
  messageFormat?: TextFormat;
  runId?: string;
  runTitle?: string;
}

// ---------- coordination: presence, claims, shared context ----------

export const CONTEXT_KINDS = ['FACT', 'FAIL', 'SUMMARY', 'STATUS'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/** an immutable entry in the shared context; corrections are new entries that point at `corrects` */
export interface ContextEntry {
  /** global monotonic sequence, the cursor for delta reads */
  seq: number;
  id: string;
  t: number;
  actor: string;
  session?: string;
  board: string;
  /** "run:<ticketId>" | "project:<projectId>" | "board:<boardId>" */
  scope: string;
  scopeType: 'run' | 'project' | 'board';
  scopeId: string;
  kind: ContextKind;
  text: string;
  data?: Record<string, unknown>;
  refs?: string[];
  attachments?: string[];
  corrects?: string;
}

/** file bytes live outside state.json; this is the metadata record */
export interface AttachmentRecord {
  id: string;
  board: string;
  scope?: string;
  name: string;
  kind: 'file' | 'text' | 'diff';
  mime?: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  createdBy: string;
  session?: string;
  target?: string;
  baseId?: string;
  baseSha256?: string;
  corrects?: string;
  appliedAt?: number;
  appliedTo?: string;
}

export type SessionKind = 'agent' | 'cli' | 'human' | 'unknown';

export interface SessionView {
  id: string;
  name: string;
  actor: string;
  kind: SessionKind;
  pid?: number;
  run?: string;
  startedAt: number;
  lastSeenAt: number;
  endedAt?: number;
  /** not ended and seen within the presence TTL */
  live: boolean;
  claims: { ticket: string; ident: string; expiresAt: number }[];
}

export interface ClaimView {
  ticket: string;
  ident: string;
  title: string;
  board: string;
  session: string;
  actor: string;
  claimedAt: number;
  renewedAt: number;
  expiresAt: number;
  /** lease not expired */
  live: boolean;
  /** holder session still present */
  sessionLive: boolean;
}

/** one node of a ticket tree: children are sub-tickets, in ident order */
export interface TicketNode {
  id: string;
  ident: string;
  title: string;
  status: string;
  project?: string;
  parent?: string;
  children: TicketNode[];
}

/** nested tickets on a board, optionally limited to one project */
export interface TicketForest {
  board: string;
  project?: string;
  nodes: TicketNode[];
}

export interface QueueRow {
  id: string;
  ident: string;
  title: string;
  board: string;
  status: string;
  priority?: string;
  project?: string;
  assignee?: string;
  blocked: boolean;
  blockedBy: string[];
  claim: ClaimView | null;
  owner: string | null;
  session: { id: string; name: string; live: boolean; lastSeenAt: number; kind: SessionKind } | null;
  bucket: 'open' | 'claimed' | 'done';
  /** open, unblocked and unclaimed */
  ready: boolean;
  updatedAt: number;
}

export interface QueueResult {
  now: number;
  board: string;
  counts: { open: number; claimed: number; done: number; blocked: number; ready: number };
  items: QueueRow[];
}


/** a durable snapshot of one finished run's context and attachment bytes */
export interface RunContextExport {
  runId: string;
  ident: string;
  /** file name under `<data>/backups`, never an absolute path */
  name: string;
  bytes: number;
  entries: number;
  /** attachment files packed into the zip */
  attachments: number;
  /** attachment ids whose bytes were missing or did not match the stored hash */
  missing: string[];
}

export interface RunContextExportFile {
  name: string;
  runId: string;
  t: number;
  bytes: number;
}

export interface RunOverview {
  id: string;
  uuid?: string;
  ident: string;
  title: string;
  board: string;
  status: string;
  owner: string;
  summaryMonitor?: string;
  progress: number | null;
  eta: string | null;
  lastUpdate: number | null;
  issues: number;
  monitors: Item[];
  tickets: Item[];
  updatedAt: number;
}

export type HudEvent =
  | { kind: 'heartbeat'; now: number }
  | { kind: 'attention'; itemId: string }
  | { kind: 'item'; item: Item; actor: string; created?: boolean }
  | { kind: 'item.deleted'; id: string; board: string; actor: string }
  | { kind: 'board'; board: Board }
  | { kind: 'board.deleted'; id: string }
  | { kind: 'activity'; activity: Activity }
  | { kind: 'alert'; alert: Alert }
  | { kind: 'session'; action: 'started' | 'updated' | 'ended'; session: SessionView }
  | { kind: 'claim'; action: 'claimed' | 'renewed' | 'released' | 'expired'; claim: ClaimView; reason?: string }
  | { kind: 'context'; entry: ContextEntry }
  | { kind: 'attachment'; action: 'added' | 'removed' | 'applied'; attachment: AttachmentRecord };
