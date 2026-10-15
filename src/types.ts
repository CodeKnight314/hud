export type ItemType = 'ticket' | 'monitor' | 'note' | 'frame' | 'util' | 'project';
export type MonState = 'ok' | 'warn' | 'error' | 'unknown' | 'running' | 'done';

/** the canonical ticket workflow, in the order a board reads (Linear's set plus review/blocked) */
export const TICKET_STATUSES = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done', 'canceled'] as const;
export const TICKET_PRIORITIES = ['low', 'med', 'high', 'urgent'] as const;

/** fixed monitor views drawn by web/views.js ('view:<name>' loads a module from views/ instead) */
export type DisplayKind =
  | 'auto' | 'value' | 'progress' | 'status' | 'text' | 'log' | 'spark'
  | 'line' | 'area' | 'bars' | 'gauge' | 'histogram' | 'scatter' | 'pie' | 'donut'
  | 'heatmap' | 'box' | 'ridgeline' | 'scatter3d' | 'surface3d';

/**
 * Options for a chart display. Where the numbers come from, how to draw them, and how to frame them.
 * `series` is a dot path into the item's `meta`: an object gives named values (pie/bars/heatmap),
 * an array of [x,y(,z)] gives points (scatter/scatter3d), an array of arrays gives a grid (surface3d).
 */
export interface PlotSpec {
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
  id: string;
  name: string;
  createdAt: number;
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
  value?: string | number | boolean | null;
  state?: MonState;
  message?: string;
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
  history?: { t: number; v: number | null; s: MonState; p?: number | null }[];
  /**
   * per-minute buckets for the last 24h (not sent over the live stream; GET /api/items/:id):
   * `n` numeric readings averaged into `v`, `w` the worst severity seen (0 ok/other, 1 warn, 2 error)
   */
  trend?: { t: number; v: number | null; p?: number | null; n: number; w?: number }[];
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
  project?: string;
  tag?: string;
  text?: string;
  overdue?: boolean;
  parent?: string;
  limit?: number;
}

export interface State {
  version: number;
  seq: Record<string, number>;
  boards: Board[];
  /** id → item; a null-prototype object, always accessed by own key */
  items: Record<string, Item>;
  activity: Activity[];
  alerts: Alert[];
  trash: TrashEntry[];
}

export type HudEvent =
  | { kind: 'item'; item: Item; actor: string; created?: boolean }
  | { kind: 'item.deleted'; id: string; board: string; actor: string }
  | { kind: 'board'; board: Board }
  | { kind: 'board.deleted'; id: string }
  | { kind: 'activity'; activity: Activity }
  | { kind: 'alert'; alert: Alert };
