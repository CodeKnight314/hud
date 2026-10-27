/**
 * Tiny HTTP client for hud. Used by the CLI and MCP server, and importable from any
 * external TypeScript process that wants to report into the dashboard:
 *
 *   import { Hud } from '/path/to/dashboard/src/client.ts';
 *   const hud = new Hud({ actor: 'etl-job' });
 *   await hud.push('etl-progress', { progress: 42, message: 'batch 42/100' });
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { asset } from './assets.ts';
import { config, scratch } from './config.ts';
import { childEnv, cliInvocation } from './electron-runtime.ts';
import type { MonitorTemplate } from './monitor-templates.ts';
import { stableVersion } from './reconnect.ts';
import type { ReconnectChecklist } from './reconnect.ts';
import type { Activity, Annotation, AttachmentRecord, AttentionItem, AttentionRecord, Board, CanvasProgram, ClaimView, ComparisonRule, ContextEntry, DashboardSpec, DecisionOption, Item, MetricSpec, MonitorResult, Observation, ProgramDraft, ProgramSpec, QueueResult, RunContextExport, RunContextExportFile, RunOverview, SessionKind, SessionView, TextFormat, TicketForest } from './types.ts';
import type { ViewInstall, ViewReview, ViewReviewRefusal } from './views.ts';

export interface HudOptions {
  url?: string;
  actor?: string;
  /** coordination session used for presence and claims (x-hud-session) */
  session?: string;
  /** start the server in the background if it isn't running (default true) */
  autostart?: boolean;
}

/** a ticket as the Linear-style list returns it */
export interface TicketRow {
  id: string;
  ident: string;
  title: string;
  status: string;
  priority: string | null;
  assignee: string | null;
  project: string | null;
  parent: string | null;
  parentId: string | null;
  blockedBy: string[];
  refs: string[];
  branch: string | null;
  target: string | null;
  tags: string[];
  monitors: string[];
  isSub?: boolean;
  comments: number;
  children: number;
  rollup: { total: number; done: number };
  updatedAt: number;
}

export interface TicketGroup {
  project: Item | null;
  key: string;
  name: string;
  counts: Record<string, number>;
  total: number;
  tickets: TicketRow[];
}

export interface ProjectGroup {
  project: Item | undefined;
  key: string;
  name: string;
  counts: Record<string, number>;
  total: number;
  tickets: Item[];
}

export type SearchQuery = {
  board?: string;
  type?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  project?: string;
  tag?: string;
  q?: string;
  overdue?: boolean | string;
  parent?: string;
  limit?: number | string;
};

/** a failed request; `status` is the HTTP status, or 0 when the server was unreachable / timed out */
export class HudRequestError extends Error {
  status: number;
  /** machine-readable conflict code, e.g. claimed / one-claim / finished / assigned / blocked */
  code?: string;
  details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HudRequestError';
    this.status = status;
    this.details = details;
    this.code = typeof details?.code === 'string' ? details.code : undefined;
  }
}

export interface HealthInfo {
  name: 'hud';
  pid?: number;
  port?: number;
  mode?: string;
  dataDir?: string;
  version?: string;
  stateVersion?: number;
  items?: number;
  saveError?: string;
  lastSave?: number;
  recoveredFrom?: string;
  [k: string]: unknown;
}

export interface AttentionResponse {
  items: AttentionItem[];
  now: number;
}

export interface RunsResponse {
  items: RunOverview[];
}

export interface ChangesResponse {
  since: number;
  now: number;
  complete: boolean;
  events: Activity[];
}

export interface SnapshotResponse {
  board: string;
  capturedAt: number;
  text: string;
  image?: { mimeType: 'image/png'; data: string };
  warnings?: string[];
  imageUnavailable?: string;
}

export interface MetricReading {
  id: string;
  board: string;
  title: string;
  type: Item['type'];
  value: Item['value'] | null;
  label?: string | null;
  unit: string;
  state: string;
  stale: boolean;
  ageSeconds: number;
  observedAt: number | null;
  receivedAt: number | null;
  source: string;
  sourceId?: string;
  evidence: Observation['evidence'];
  definition: string;
  metric?: MetricSpec;
  availability: Observation['availability'];
  coverage?: Observation['coverage'];
  expirySeconds: number | null;
  progress?: number | null;
  max?: number;
  pipelineView?: unknown;
}

export interface ReadoutResponse {
  now: number;
  boards: { id: string; name: string; revision?: string; annotations: Annotation[]; comparisons: unknown[] }[];
  items: MetricReading[];
  text?: string;
}

export interface DashboardUpdate {
  spec: DashboardSpec;
  dryRun?: boolean;
  expectedRevision?: string;
}

export interface BoardLint {
  board: string;
  findings: { code: string; severity: 'warning' | 'error'; id: string; message: string }[];
  errors: number;
  warnings: number;
}

export interface ClearBoardResponse {
  board: string;
  cleared: number;
  removed: string[];
}

export type ProgramAction =
  | { action: 'preview' | 'apply'; program?: Partial<ProgramSpec> & Pick<ProgramSpec, 'code' | 'description'>; expectedRevision?: string }
  | { action: 'disable'; expectedRevision?: string };

export interface ProgramPreview {
  valid: boolean;
  image?: { mimeType: 'image/png'; data: string };
  errors: string[];
  warnings: string[];
}

export interface ProgramResult {
  program: Omit<CanvasProgram, 'code' | 'previous'> | null;
  board: string;
  id?: string;
  revision?: string;
}

const qs = (q: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  const s = p.toString();
  return s ? '?' + s : '';
};
const enc = encodeURIComponent;
function clientBuild(): string | null {
  const raw = asset('package.json', 'utf8');
  if (!raw) return null;
  try { return stableVersion(JSON.parse(raw).version); } catch { return null; }
}
const CLIENT_VERSION = clientBuild();

function isConnError(e: unknown): boolean {
  const err = e as { name?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return false;
  return e instanceof TypeError;
}

export class Hud {
  url: string;
  actor: string;
  session?: string;
  autostart: boolean;
  timeout: number;
  private runtime: { verified: boolean; starting: Promise<void> | null; warned: boolean };

  constructor(opts: HudOptions = {}) {
    this.url = (opts.url ?? (scratch ? process.env.HUD_URL : undefined) ?? `http://localhost:${config().port}`).replace(/\/$/, '');
    this.actor = opts.actor ?? process.env.HUD_ACTOR ?? 'api';
    this.session = opts.session ?? process.env.HUD_SESSION ?? undefined;
    this.autostart = opts.autostart ?? true;
    const t = Number(process.env.HUD_TIMEOUT);
    this.timeout = t > 0 ? t : 15000;
    this.runtime = { verified: false, starting: null, warned: false };
  }

  /** raw /api/health of whatever is listening: the hud payload, 'foreign' for a non-hud answer, null when nothing answers */
  private async probe(): Promise<HealthInfo | 'foreign' | null> {
    try {
      const r = await fetch(this.url + '/api/health', { signal: AbortSignal.timeout(1500) });
      try {
        const j = await r.json();
        return r.ok && j?.name === 'hud' ? j : 'foreign';
      } catch {
        return 'foreign';
      }
    } catch {
      return null;
    }
  }

  async healthInfo(): Promise<HealthInfo | null> {
    const h = await this.probe();
    return h && h !== 'foreign' ? h : null;
  }

  async health(): Promise<boolean> {
    return (await this.healthInfo()) !== null;
  }

  private checkOwnership(info: HealthInfo): void {
    if (this.runtime.warned || !info.dataDir || this.url !== `http://localhost:${config().port}`) return;
    const mine = config().dataDir;
    if (resolve(info.dataDir) !== resolve(mine)) {
      this.runtime.warned = true;
      console.error(`hud: warning: the server at ${this.url} uses data dir ${info.dataDir}, not ${mine} (HUD_DATA); talking to it anyway`);
    }
  }

  private lastLog(): string {
    try {
      const t = readFileSync(join(config().dataDir, 'server.log'), 'utf8').trimEnd().split('\n').slice(-8).join('\n');
      return t ? `\n--- server.log (tail) ---\n${t}` : '';
    } catch {
      return '';
    }
  }

  /** Check the server is up (and start it detached if allowed). Never caches a success for good: a failed request re-runs it. */
  ensureServer(): Promise<void> {
    if (this.runtime.verified) return Promise.resolve();
    return (this.runtime.starting ??= (async () => {
      let h = await this.probe();
      if (h === 'foreign') throw new HudRequestError(0, `something that is not hud answers at ${this.url}; free the port or set HUD_PORT / HUD_URL`);
      if (h) {
        this.checkOwnership(h);
        this.runtime.verified = true;
        return;
      }
      if (!this.autostart) throw new HudRequestError(0, `hud is not running at ${this.url}`);
      const { dataDir } = config();
      mkdirSync(dataDir, { recursive: true });
      const log = openSync(join(dataDir, 'server.log'), 'a');
      // under Electron the app binary is its own CLI in node mode; from source it's the .ts entry
      const { cmd, prefix, env } = cliInvocation();
      const child = spawn(cmd, [...prefix, 'serve'], { detached: true, stdio: ['ignore', log, log], env: childEnv(env) });
      let exited: number | null | undefined;
      child.on('exit', (c) => (exited = c ?? -1));
      child.on('error', (e) => (exited = -1, console.error(`hud: could not spawn server: ${e.message}`)));
      child.unref();
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100));
        h = await this.probe();
        if (h === 'foreign') throw new HudRequestError(0, `something that is not hud answers at ${this.url}`);
        if (h) {
          this.checkOwnership(h);
          this.runtime.verified = true;
          return;
        }
        // a server that lost the single-instance race exits early; keep waiting only while the child lives
        if (exited !== undefined && i > 5) break;
      }
      throw new HudRequestError(0, `hud did not start at ${this.url}; see ${join(dataDir, 'server.log')}${this.lastLog()}`);
    })().finally(() => {
      this.runtime.starting = null;
    }));
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const send = () =>
      fetch(this.url + path, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
    await this.ensureServer();
    let res: Response;
    try {
      res = await send();
    } catch (e) {
      if (!isConnError(e)) throw new HudRequestError(0, `request ${method} ${path} timed out after ${this.timeout}ms (HUD_TIMEOUT)`);
      // the server went away since we last looked: re-check (and re-autostart once), then retry
      this.runtime.verified = false;
      await this.ensureServer();
      try {
        res = await send();
      } catch (e2) {
        this.runtime.verified = false;
        throw new HudRequestError(0, `cannot reach hud at ${this.url}: ${(e2 as Error).message}`);
      }
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new HudRequestError(0, `reading response failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      let msg = text;
      let details: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(text);
        msg = parsed.error ?? text;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const { error: _e, ...rest } = parsed;
          if (Object.keys(rest).length) details = rest;
        }
      } catch {}
      throw new HudRequestError(res.status, `${res.status}: ${msg}`, details);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text as T;
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-hud-actor': enc(this.actor),
      ...(this.session ? { 'x-hud-session': enc(this.session) } : {}),
      ...(CLIENT_VERSION ? { 'x-hud-client-version': CLIENT_VERSION } : {}),
    };
  }

  /** Make an invocation-specific client so concurrent calls cannot change each other's actor header. */
  forActor(actor: string): Hud {
    const client = new Hud({ url: this.url, actor, session: this.session, autostart: this.autostart });
    client.timeout = this.timeout;
    client.runtime = this.runtime;
    return client;
  }

  summary(board?: string): Promise<string> {
    return this.request('GET', '/api/summary' + (board ? `?board=${encodeURIComponent(board)}` : ''));
  }
  /** the Linear-style ticket list, grouped by project */
  tickets(board = 'main', q: SearchQuery = {}): Promise<{ board: string; groups: TicketGroup[] }> {
    return this.request('GET', '/api/tickets' + qs({ ...q, board }));
  }
  /** the same list as plain text, for reading in a terminal */
  ticketTree(board = 'main', q: SearchQuery = {}): Promise<string> {
    return this.request('GET', '/api/tickets' + qs({ ...q, format: 'text', board }));
  }
  projects(board?: string): Promise<ProjectGroup[]> {
    return this.request('GET', '/api/projects' + (board ? `?board=${encodeURIComponent(board)}` : ''));
  }
  /** create a project; `name` and `title` are the same field */
  createProject(input: { name?: string; title?: string; key?: string; board?: string; body?: string; description?: string; lead?: string; target?: string }): Promise<Item> {
    return this.request('POST', '/api/projects', input);
  }
  /** patch a project by id or KEY: title/name, key, body/description, lead, target, status */
  updateProject(id: string, patch: { name?: string; title?: string; key?: string; board?: string; body?: string; description?: string; lead?: string; target?: string; status?: string }): Promise<Item> {
    return this.request('PATCH', `/api/projects/${encodeURIComponent(id)}`, patch);
  }
  /** nested ticket tree for a board, optionally one project */
  tree(board = 'main', project?: string): Promise<TicketForest> {
    return this.request('GET', '/api/tree' + qs({ board, project }));
  }
  /** move a ticket under a parent and/or into a project */
  treeMove(id: string, patch: { parent?: string; project?: string } = {}): Promise<Item> {
    return this.request('POST', '/api/tree', { action: 'move', id, ...patch });
  }
  /** clear a ticket's parent; the ticket stays in its project */
  treeDetach(id: string): Promise<Item> {
    return this.request('POST', '/api/tree', { action: 'detach', id });
  }
  /** set a ticket's structure: project, parent, blockedBy, refs, branch */
  link(id: string, patch: { project?: string; parent?: string; blockedBy?: string[]; refs?: string[]; branch?: string }): Promise<Item> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/link`, patch);
  }
  /** drop links of the named kinds (project, parent, blockedBy, refs) */
  unlink(id: string, keys: ('project' | 'parent' | 'blockedBy' | 'refs')[]): Promise<Item> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/unlink`, Object.fromEntries(keys.map((k) => [k, true])));
  }
  /** Full guide, or one coordination playbook (`decentralized`, `lead`; `centralized` is `lead`). */
  guide(playbook?: string): Promise<string> {
    const q = playbook ? `?playbook=${encodeURIComponent(playbook)}` : '';
    return this.request('GET', `/api/guide${q}`);
  }
  /** the chart renderer modules agents can use (`display: 'view:<name>'`) */
  views(): Promise<{ dir: string; views: { name: string; mtime: number; bytes: number; sha256?: string; valid?: boolean; errors?: string[] }[] }> {
    return this.request('GET', '/api/views');
  }
  /** Built-in monitor templates (disk, tls, http, cron-heartbeat) with safe defaults and docs links. */
  monitorTemplates(): Promise<MonitorTemplate[]> {
    return this.request('GET', '/api/monitor-templates');
  }
  viewGet(name: string): Promise<{ name: string; code: string; sha256: string; validation: { ok: boolean; errors: string[]; warnings: string[]; sha256: string } }> {
    return this.request('GET', `/api/views/${encodeURIComponent(name)}`);
  }
  viewGenerate(name: string, spec: Record<string, unknown>, opts: { write?: boolean; overwrite?: boolean } = {}): Promise<{ name: string; code: string; validation: { ok: boolean; errors: string[]; warnings: string[]; sha256: string }; written: boolean; sha256?: string; mtime?: number; path?: string }> {
    return this.request('POST', '/api/views', { name, spec, ...opts });
  }
  /** stage caller-supplied renderer source. Returns the review diff; the module is not installed. */
  viewWrite(name: string, input: { code: string; overwrite?: boolean; expectedSha256?: string }): Promise<ViewReview>;
  /** stage source that must fit in `maxChars`. A review that does not fit is dropped and cannot be approved. */
  viewWrite(name: string, input: { code: string; overwrite?: boolean; expectedSha256?: string; maxChars: number }): Promise<ViewReview | ViewReviewRefusal>;
  viewWrite(name: string, input: { code: string; overwrite?: boolean; expectedSha256?: string; maxChars?: number }): Promise<ViewReview | ViewReviewRefusal> {
    return this.request('PUT', `/api/views/${encodeURIComponent(name)}`, input);
  }
  /** install a previously staged review. The sha256 must be the one from that review. */
  viewApprove(name: string, input: { proposalId: string; sha256: string }): Promise<ViewInstall> {
    return this.request('PUT', `/api/views/${encodeURIComponent(name)}`, { approve: true, proposalId: input.proposalId, sha256: input.sha256 });
  }
  viewValidate(name: string, code?: string): Promise<{ ok: boolean; errors: string[]; warnings: string[]; sha256: string; rendered: boolean; renderErrors?: string[]; image?: { mimeType: string; data: string } }> {
    return this.request('POST', `/api/views/${encodeURIComponent(name)}/validate`, code === undefined ? {} : { code });
  }
  viewDelete(name: string, expectedSha256?: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/api/views/${encodeURIComponent(name)}` + qs({ expectedSha256 }));
  }
  boards(): Promise<Board[]> {
    return this.request('GET', '/api/boards');
  }
  createBoard(name: string): Promise<Board> {
    return this.request('POST', '/api/boards', { name });
  }
  /** Clear a board's canvas while retaining the board and its settings. */
  clearBoard(board: string): Promise<ClearBoardResponse> {
    return this.request('POST', `/api/boards/${enc(board)}/clear`);
  }
  items(q: SearchQuery = {}): Promise<Item[]> {
    return this.request('GET', '/api/items' + qs(q));
  }
  search(q: SearchQuery = {}): Promise<Item[]> {
    return this.items(q);
  }
  get(id: string): Promise<Item> {
    return this.request('GET', `/api/items/${encodeURIComponent(id)}`);
  }
  create(item: Partial<Item> & { type: Item['type']; frame?: string; template?: string; host?: string }): Promise<Item> {
    return this.request('POST', '/api/items', item);
  }
  update(id: string, patch: Partial<Item>): Promise<Item> {
    return this.request('PATCH', `/api/items/${encodeURIComponent(id)}`, patch);
  }
  remove(id: string): Promise<Item> {
    return this.request('DELETE', `/api/items/${encodeURIComponent(id)}`);
  }
  comment(id: string, text: string, format?: TextFormat) {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/comments`, { text, format });
  }
  /** Propose options on a ticket and block it until one is picked. */
  ask(id: string, options: (Partial<DecisionOption> & { label: string })[], question?: string, questionFormat?: TextFormat): Promise<Item> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/ask`, { options, question, questionFormat });
  }
  /** Pick one of a ticket's proposed options. */
  decide(id: string, optionId: string, note?: string, decisionVersion?: string): Promise<Item> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/decide`, { optionId, note, decisionVersion });
  }
  /** Signal that work is finished: complete the board's items (or the named ones) and tidy up. `export` snapshots runs this call finishes; `exportAll` also snapshots owned finished runs. */
  finish(opts: { board?: string; ids?: string[]; note?: string; organize?: boolean; export?: boolean; exportAll?: boolean } = {}): Promise<{ board: string; done: string[]; exports?: RunContextExport[] }> {
    return this.request('POST', '/api/finish', opts);
  }
  /** Report a reading; creates a push monitor named `id` if it doesn't exist. */
  push(id: string, r: MonitorResult & { title?: string; board?: string; frame?: string }): Promise<Item> {
    return this.request('POST', `/api/monitors/${encodeURIComponent(id)}/push`, r);
  }
  run(id: string): Promise<Item> {
    return this.request('POST', `/api/monitors/${encodeURIComponent(id)}/run`);
  }
  /** Tidy a board by group; `auto` turns continuous auto-organize on/off for that board. */
  organize(board?: string, auto?: boolean): Promise<{ groups: string[]; moved: number; canvas: { width: number; height: number }; items: number; tickets: number }> {
    return this.request('POST', '/api/organize', { board, auto });
  }
  arrange(opts: { board?: string; frame?: string; ids?: string[]; width?: number }) {
    return this.request('POST', '/api/arrange', opts);
  }
  activityOf(id: string, limit?: number): Promise<any[]> {
    return this.request('GET', `/api/items/${enc(id)}/activity` + qs({ limit }));
  }
  editComment(id: string, cid: string, text: string, format?: TextFormat) {
    return this.request('PATCH', `/api/items/${enc(id)}/comments/${enc(cid)}`, { text, format });
  }
  deleteComment(id: string, cid: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/api/items/${enc(id)}/comments/${enc(cid)}`);
  }
  trash(board?: string): Promise<any[]> {
    return this.request('GET', '/api/trash' + qs({ board }));
  }
  restore(id: string): Promise<Item> {
    return this.request('POST', `/api/trash/${enc(id)}/restore`);
  }
  purge(id: string): Promise<{ purged: number }> {
    return this.request('DELETE', id === 'all' ? '/api/trash' : `/api/trash/${enc(id)}`);
  }
  backups(): Promise<any[]> {
    return this.request('GET', '/api/backups');
  }
  backup(reason?: string): Promise<{ name: string }> {
    return this.request('POST', '/api/backups', { reason });
  }
  restoreBackup(name: string): Promise<{ name: string; items: number; boards: number; backup: string }> {
    return this.request('POST', `/api/backups/${enc(name)}/restore`);
  }
  /** open the running server's data directory in the system file manager */
  revealData(): Promise<{ ok: boolean; dataDir: string }> {
    return this.request('POST', '/api/data/reveal');
  }
  exportState(): Promise<any> {
    return this.request('GET', '/api/export');
  }
  importState(state: unknown, mode: 'replace' | 'merge' = 'replace'): Promise<any> {
    return this.request('POST', '/api/import', { state, mode });
  }
  /** heartbeat ping for a cron-style monitor: kind is 'start', 'fail' or an exit code */
  ping(id: string, kind?: string | number): Promise<string> {
    return this.request('POST', `/ping/${enc(id)}` + (kind === undefined || kind === '' ? '' : `/${enc(String(kind))}`));
  }
  attention(): Promise<AttentionResponse> {
    return this.request('GET', '/api/attention');
  }
  reviewAttention(id: string, opts: { action: 'review' | 'unreview' | 'snooze'; revision: string; until?: number }): Promise<AttentionRecord> {
    return this.request('POST', `/api/attention/${enc(id)}`, opts);
  }
  runs(): Promise<RunsResponse> {
    return this.request('GET', '/api/runs');
  }
  changes(since: number): Promise<ChangesResponse> {
    return this.request('GET', '/api/changes' + qs({ since }));
  }
  // ---------- coordination ----------
  sessions(): Promise<{ items: SessionView[]; now: number }> {
    return this.request('GET', '/api/sessions');
  }
  sessionStart(name: string, opts: { actor?: string; kind?: SessionKind; run?: string; pid?: number; clientVersion?: string } = {}): Promise<SessionView> {
    const clientVersion = stableVersion(opts.clientVersion ?? CLIENT_VERSION);
    return this.request('POST', '/api/sessions', { id: name, name, ...opts, clientVersion: clientVersion ?? undefined });
  }
  /** Post-update MCP reconnect checklist. Pending until this server build is acknowledged. */
  reconnect(): Promise<ReconnectChecklist> {
    return this.request('GET', '/api/reconnect');
  }
  reconnectAck(): Promise<ReconnectChecklist> {
    return this.request('POST', '/api/reconnect/ack');
  }
  sessionHeartbeat(name = this.session): Promise<{ session: SessionView; renewed: ClaimView[] }> {
    if (!name) throw new HudRequestError(0, 'this client has no session; pass a name or set HUD_SESSION');
    return this.request('POST', `/api/sessions/${encodeURIComponent(name)}/heartbeat`);
  }
  sessionEnd(name = this.session): Promise<{ session: SessionView; released: ClaimView[] }> {
    if (!name) throw new HudRequestError(0, 'this client has no session; pass a name or set HUD_SESSION');
    return this.request('DELETE', `/api/sessions/${encodeURIComponent(name)}`);
  }
  claim(id: string, opts: { session?: string; ttl?: number; start?: boolean; takeover?: boolean } = {}): Promise<ClaimView> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/claim`, { session: opts.session ?? this.session, ttl: opts.ttl, start: opts.start, takeover: opts.takeover });
  }
  claimOf(id: string): Promise<ClaimView | null> {
    return this.request('GET', `/api/items/${encodeURIComponent(id)}/claim`);
  }
  releaseClaim(id: string, sessionOrOpts?: string | { session?: string; reason?: string }): Promise<ClaimView> {
    const opts = sessionOrOpts !== undefined && typeof sessionOrOpts === 'object' && sessionOrOpts !== null ? sessionOrOpts : { session: sessionOrOpts };
    const session = opts.session ?? this.session;
    if (!session) throw new HudRequestError(0, 'this client has no session; pass one or set HUD_SESSION');
    return this.request('DELETE', `/api/items/${encodeURIComponent(id)}/claim` + qs({ session, reason: opts.reason }));
  }
  /** active leases, with expiry and whether the lease and its session are still live */
  claims(q: { session?: string; board?: string } = {}): Promise<{ items: ClaimView[]; now: number }> {
    return this.request('GET', '/api/claims' + qs(q));
  }
  queue(q: { board?: string; status?: string; project?: string; assignee?: string; includeDone?: boolean; limit?: number } = {}): Promise<QueueResult> {
    return this.request('GET', '/api/queue' + qs({ ...q, includeDone: q.includeDone ? 1 : undefined }));
  }
  /** block until a peer publishes context, claims the ticket, or ends; at most 25 s */
  async wait(input: { scope?: string; ticket?: string; sessions?: string[]; kinds?: string[]; since?: number; timeoutSeconds?: number; includeSelf?: boolean; session?: string } = {}): Promise<{ woke: boolean; timeout?: boolean; reason?: string; event?: unknown; now?: number }> {
    await this.ensureServer();
    const seconds = Math.max(1, Math.min(25, Number(input.timeoutSeconds) || 20));
    const res = await fetch(this.url + '/api/wait', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...input, session: input.session ?? this.session, timeoutSeconds: seconds }),
      signal: AbortSignal.timeout(seconds * 1000 + 5000),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch {}
    if (!res.ok) throw new HudRequestError(res.status, `${res.status}: ${parsed?.error ?? text}`, parsed && typeof parsed === 'object' ? parsed : undefined);
    return parsed;
  }
  contextPublish(input: { scope: string; kind: string; text: string; data?: Record<string, unknown>; refs?: string[]; attachments?: string[]; corrects?: string; session?: string }): Promise<ContextEntry> {
    return this.request('POST', '/api/context', { ...input, session: input.session ?? this.session });
  }
  contextRead(q: { scope?: string; since?: number; kinds?: string[]; limit?: number; session?: string; mark?: boolean } = {}): Promise<{ entries: ContextEntry[]; cursor: number; oldest: number; complete: boolean; truncated: boolean; now: number }> {
    return this.request('POST', '/api/context/read', { ...q, session: q.session ?? this.session });
  }
  contextScopes(board?: string): Promise<{ scope: string; scopeType: string; scopeId: string; board: string; count: number; lastAt: number }[]> {
    return this.request('GET', '/api/context/scopes' + qs({ board }));
  }
  /** Snapshot a finished run's context and attachment bytes to backups/context-<id>-<ts>.zip. */
  exportRun(id: string): Promise<RunContextExport> {
    return this.request('POST', `/api/runs/${enc(id)}/export`);
  }
  runExports(id?: string): Promise<RunContextExportFile[]> {
    return this.request('GET', id ? `/api/runs/${enc(id)}/exports` : '/api/runs/exports');
  }
  runExportMarkdown(id: string, name: string): Promise<string> {
    return this.request('GET', `/api/runs/${enc(id)}/exports/${enc(name)}?format=markdown`);
  }
  async runExportBytes(id: string, name: string): Promise<Buffer> {
    await this.ensureServer();
    const res = await fetch(`${this.url}/api/runs/${enc(id)}/exports/${enc(name)}`, { headers: { 'x-hud-actor': enc(this.actor) }, signal: AbortSignal.timeout(this.timeout) });
    if (!res.ok) throw new HudRequestError(res.status, `${res.status}: could not read context export ${name}`);
    return Buffer.from(await res.arrayBuffer());
  }
  // ---------- attachments ----------
  attachmentAdd(input: { board?: string; scope?: string; name: string; kind?: 'file' | 'text' | 'diff'; mime?: string; target?: string; baseId?: string; baseSha256?: string; corrects?: string; content: Buffer | string }): Promise<AttachmentRecord> {
    const bytes = typeof input.content === 'string' ? Buffer.from(input.content) : input.content;
    return this.request('POST', '/api/attachments', { ...input, content: undefined, contentBase64: bytes.toString('base64') });
  }
  attachments(q: { board?: string; scope?: string } = {}): Promise<AttachmentRecord[]> {
    return this.request('GET', '/api/attachments' + qs(q));
  }
  attachment(id: string): Promise<AttachmentRecord> {
    return this.request('GET', `/api/attachments/${encodeURIComponent(id)}`);
  }
  attachmentText(id: string): Promise<string> {
    return this.request('GET', `/api/attachments/${encodeURIComponent(id)}/content?format=text`);
  }
  async attachmentBytes(id: string): Promise<Buffer> {
    await this.ensureServer();
    const res = await fetch(`${this.url}/api/attachments/${encodeURIComponent(id)}/content`, { headers: { 'x-hud-actor': enc(this.actor) }, signal: AbortSignal.timeout(this.timeout) });
    if (!res.ok) throw new HudRequestError(res.status, `${res.status}: could not read attachment ${id}`);
    return Buffer.from(await res.arrayBuffer());
  }
  expandAttachment(id: string): Promise<{ text: string; added: number | null; removed: number | null; truncated: boolean; kind: string }> {
    return this.request('GET', `/api/attachments/${encodeURIComponent(id)}/expand`);
  }
  attachmentApplied(id: string, target: string): Promise<AttachmentRecord> {
    return this.request('POST', `/api/attachments/${encodeURIComponent(id)}/applied`, { target });
  }
  deleteAttachment(id: string, force = false): Promise<AttachmentRecord> {
    return this.request('DELETE', `/api/attachments/${encodeURIComponent(id)}` + (force ? '?force=1' : ''));
  }
  readout(board?: string): Promise<ReadoutResponse> {
    return this.request('GET', '/api/readout' + qs({ board }));
  }
  snapshot(opts: { board?: string; format?: 'auto' | 'png' | 'text' } = {}): Promise<SnapshotResponse> {
    return this.request('POST', '/api/snapshot', { board: opts.board, format: opts.format ?? 'auto' });
  }
  dashboard(board: string): Promise<{ revision: string; spec: DashboardSpec; keys: Record<string, string> } | null> {
    return this.request('GET', `/api/boards/${enc(board)}/dashboard`);
  }
  updateDashboard(board: string, update: DashboardUpdate): Promise<Record<string, unknown>> {
    return this.request('PUT', `/api/boards/${enc(board)}/dashboard`, update);
  }
  annotations(board: string): Promise<Annotation[]> {
    return this.request('GET', `/api/boards/${enc(board)}/annotations`);
  }
  addAnnotation(board: string, annotation: { time: number; text: string }): Promise<Annotation> {
    return this.request('POST', `/api/boards/${enc(board)}/annotations`, annotation);
  }
  deleteAnnotation(board: string, id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request('DELETE', `/api/boards/${enc(board)}/annotations`, { id });
  }
  comparisons(board: string): Promise<ComparisonRule[]> {
    return this.request('GET', `/api/boards/${enc(board)}/comparisons`);
  }
  addComparison(board: string, rule: Omit<ComparisonRule, 'id' | 'since' | 'deletedAt'> & { id?: string }): Promise<ComparisonRule> {
    return this.request('POST', `/api/boards/${enc(board)}/comparisons`, rule);
  }
  deleteComparison(board: string, id: string): Promise<{ id: string; deleted: boolean }> {
    return this.request('DELETE', `/api/boards/${enc(board)}/comparisons`, { id });
  }
  lint(board: string): Promise<BoardLint> {
    return this.request('GET', `/api/boards/${enc(board)}/lint`);
  }
  itemProgram(id: string): Promise<{ program: CanvasProgram | null; draft: ProgramDraft | null }> {
    return this.request('GET', `/api/items/${enc(id)}/program`);
  }
  boardProgram(board: string): Promise<{ program: CanvasProgram | null; draft: ProgramDraft | null }> {
    return this.request('GET', `/api/boards/${enc(board)}/program`);
  }
  itemProgramAction(id: string, action: ProgramAction): Promise<ProgramPreview | ProgramResult> {
    return this.request('POST', `/api/items/${enc(id)}/program`, action);
  }
  boardProgramAction(board: string, action: ProgramAction): Promise<ProgramPreview | ProgramResult> {
    return this.request('POST', `/api/boards/${enc(board)}/program`, action);
  }
  deleteItemProgram(id: string, expectedRevision?: string): Promise<ProgramResult> {
    return this.request('DELETE', `/api/items/${enc(id)}/program`, expectedRevision ? { expectedRevision } : undefined);
  }
  deleteBoardProgram(board: string, expectedRevision?: string): Promise<ProgramResult> {
    return this.request('DELETE', `/api/boards/${enc(board)}/program`, expectedRevision ? { expectedRevision } : undefined);
  }
}
