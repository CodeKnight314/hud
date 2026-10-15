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
import { config } from './config.ts';
import { childEnv, cliInvocation } from './electron-runtime.ts';
import type { Board, DecisionOption, Item, MonitorResult } from './types.ts';

export interface HudOptions {
  url?: string;
  actor?: string;
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
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HudRequestError';
    this.status = status;
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

const qs = (q: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v === true ? '1' : String(v));
  const s = p.toString();
  return s ? '?' + s : '';
};
const enc = encodeURIComponent;

function isConnError(e: unknown): boolean {
  const err = e as { name?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return false;
  return e instanceof TypeError;
}

export class Hud {
  url: string;
  actor: string;
  autostart: boolean;
  timeout: number;
  private verified = false;
  private starting: Promise<void> | null = null;
  private warned = false;

  constructor(opts: HudOptions = {}) {
    this.url = (opts.url ?? process.env.HUD_URL ?? `http://localhost:${config().port}`).replace(/\/$/, '');
    this.actor = opts.actor ?? process.env.HUD_ACTOR ?? 'api';
    this.autostart = opts.autostart ?? true;
    const t = Number(process.env.HUD_TIMEOUT);
    this.timeout = t > 0 ? t : 15000;
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
    if (this.warned || !info.dataDir || this.url !== `http://localhost:${config().port}`) return;
    const mine = config().dataDir;
    if (resolve(info.dataDir) !== resolve(mine)) {
      this.warned = true;
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
    if (this.verified) return Promise.resolve();
    return (this.starting ??= (async () => {
      let h = await this.probe();
      if (h === 'foreign') throw new HudRequestError(0, `something that is not hud answers at ${this.url}; free the port or set HUD_PORT / HUD_URL`);
      if (h) {
        this.checkOwnership(h);
        this.verified = true;
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
          this.verified = true;
          return;
        }
        // a server that lost the single-instance race exits early; keep waiting only while the child lives
        if (exited !== undefined && i > 5) break;
      }
      throw new HudRequestError(0, `hud did not start at ${this.url}; see ${join(dataDir, 'server.log')}${this.lastLog()}`);
    })().finally(() => {
      this.starting = null;
    }));
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const send = () =>
      fetch(this.url + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-hud-actor': enc(this.actor) },
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
      this.verified = false;
      await this.ensureServer();
      try {
        res = await send();
      } catch (e2) {
        this.verified = false;
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
      try {
        msg = JSON.parse(text).error ?? text;
      } catch {}
      throw new HudRequestError(res.status, `${res.status}: ${msg}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text as T;
    }
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
  /** set a ticket's structure: project, parent, blockedBy, refs, branch */
  link(id: string, patch: { project?: string; parent?: string; blockedBy?: string[]; refs?: string[]; branch?: string }): Promise<Item> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/link`, patch);
  }
  /** drop links of the named kinds (project, parent, blockedBy, refs) */
  unlink(id: string, keys: ('project' | 'parent' | 'blockedBy' | 'refs')[]): Promise<Item> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/unlink`, Object.fromEntries(keys.map((k) => [k, true])));
  }
  guide(): Promise<string> {
    return this.request('GET', '/api/guide');
  }
  /** the chart renderer modules agents can use (`display: 'view:<name>'`) */
  views(): Promise<{ dir: string; views: { name: string; mtime: number; bytes: number }[] }> {
    return this.request('GET', '/api/views');
  }
  boards(): Promise<Board[]> {
    return this.request('GET', '/api/boards');
  }
  createBoard(name: string): Promise<Board> {
    return this.request('POST', '/api/boards', { name });
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
  create(item: Partial<Item> & { type: Item['type']; frame?: string }): Promise<Item> {
    return this.request('POST', '/api/items', item);
  }
  update(id: string, patch: Partial<Item>): Promise<Item> {
    return this.request('PATCH', `/api/items/${encodeURIComponent(id)}`, patch);
  }
  remove(id: string): Promise<Item> {
    return this.request('DELETE', `/api/items/${encodeURIComponent(id)}`);
  }
  comment(id: string, text: string) {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/comments`, { text });
  }
  /** Propose options on a ticket and block it until one is picked. */
  ask(id: string, options: (Partial<DecisionOption> & { label: string })[], question?: string): Promise<Item> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/ask`, { options, question });
  }
  /** Pick one of a ticket's proposed options. */
  decide(id: string, optionId: string, note?: string): Promise<Item> {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/decide`, { optionId, note });
  }
  /** Signal that work is finished: complete the board's items (or the named ones) and tidy up. */
  finish(opts: { board?: string; ids?: string[]; note?: string; organize?: boolean } = {}): Promise<{ board: string; done: string[] }> {
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
  organize(board?: string, auto?: boolean): Promise<{ groups: string[]; moved: number }> {
    return this.request('POST', '/api/organize', { board, auto });
  }
  arrange(opts: { board?: string; frame?: string; ids?: string[]; width?: number }) {
    return this.request('POST', '/api/arrange', opts);
  }
  activityOf(id: string, limit?: number): Promise<any[]> {
    return this.request('GET', `/api/items/${enc(id)}/activity` + qs({ limit }));
  }
  editComment(id: string, cid: string, text: string) {
    return this.request('PATCH', `/api/items/${enc(id)}/comments/${enc(cid)}`, { text });
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
}
