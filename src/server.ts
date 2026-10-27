import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Engine } from './engine.ts';
import { HudError, STATE_VERSION, Store } from './store.ts';
import { acquireLock } from './lock.ts';
import { summarize, ticketsView } from './summary.ts';
import type { Alert, HudEvent, Item, SearchQuery } from './types.ts';
import { spawn } from 'node:child_process';
import { asset, assetKeys, isPackaged } from './assets.ts';
import { coordinationDoc, GuideError } from './guide.ts';
import { ROOT, config } from './config.ts';
import { publicState, registerMonitoring } from './monitoring-server.ts';
import { hashBytes, readAttachmentBytes, removeAttachmentBytes, sanitizeName, textOf, writeAttachmentBytes } from './attachments.ts';
import { zipEntry } from './context-export.ts';
import { unifiedDiff } from './diff.ts';
import { capturePage } from './render.ts';
import { MonitorTemplateError, applyMonitorTemplate, listMonitorTemplates } from './monitor-templates.ts';
import { revealDirectory } from './reveal.ts';
import { deleteViewFile, generateViewCode, installUntrustedView, listViewInfos, readViewFile, validateViewCode, viewFixture, writeViewFile } from './views.ts';
import { clientsFromSessions, loadReconnectChecklist, stableVersion, syncServerVersion, takeReconnectChecklist } from './reconnect.ts';

const { port: PORT, dataDir, probesDir, viewsDir } = config();
const WEB = join(ROOT, 'web');
const VERSION = JSON.parse(asset('package.json', 'utf8') ?? '{"version":"0.0.0"}').version;

// A stray error in one request, monitor or timer must not take the live board down.
process.on('uncaughtException', (e) => console.error('[hud] uncaught exception:', e));
process.on('unhandledRejection', (e) => console.error('[hud] unhandled rejection:', e));

mkdirSync(dataDir, { recursive: true });
let releaseLock: () => void;
try {
  releaseLock = acquireLock(dataDir, PORT); // before the store: two writers on one data dir corrupt it
} catch (e) {
  console.error(`[hud] ${(e as Error).message}`);
  process.exit(1);
}
seedDir(probesDir, 'probes');
seedDir(viewsDir, 'views');
let store: Store;
try {
  store = new Store(join(dataDir, 'state.json'));
} catch (e) {
  console.error(`[hud] ${(e as Error).message}`);
  releaseLock();
  process.exit(1);
}
store.startBackups();
try { syncServerVersion(dataDir, VERSION); } catch (error) { console.error(`[hud] reconnect reminder: ${(error as Error).message}`); }
const engine = new Engine(store, probesDir);

/** packaged builds carry the default probes/views inside the app; copy any the user doesn't have yet */
function seedDir(dir: string, prefix: 'probes' | 'views') {
  if (!isPackaged()) return;
  try {
    mkdirSync(dir, { recursive: true });
    for (const key of assetKeys()) {
      if (!key.startsWith(`${prefix}/`)) continue;
      const rel = key.slice(prefix.length + 1);
      if (!rel || rel.includes('/')) continue; // top-level files only
      const dest = join(dir, rel);
      if (existsSync(dest)) continue;
      const body = asset(key);
      if (body !== undefined) writeFileSync(dest, body);
    }
  } catch (e) {
    console.error(`[hud] could not seed ${prefix}:`, (e as Error).message);
  }
}

/**
 * Serve an agent-authored renderer module. Read-only, GET-only, path-stripped, and the same loopback
 * Host/Origin gate as everything else — these execute in the page, so treat them like probes.
 */
function serveView(name: string, res: ServerResponse) {
  const clean = name.replace(/\\/g, '/');
  if (!/^[\w][\w.-]*\.js$/.test(clean) || clean.includes('..')) return send(res, 400, { error: 'bad view name' });
  const file = resolve(viewsDir, clean);
  if (!file.startsWith(viewsDir + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'no such view' });
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}

// ---------- live events ----------
const clients = new Set<ServerResponse>();
const MAX_BUFFERED = 1 << 20;
function broadcast(msg: string) {
  for (const c of clients) {
    if (c.destroyed || c.writableLength > MAX_BUFFERED) {
      clients.delete(c); // a stalled browser tab must not make the server buffer without bound
      c.destroy();
      continue;
    }
    c.write(msg);
  }
}
// ---------- waiters: event-driven hud_wait ----------
interface Waiter {
  session?: string;
  scope?: string;
  ticket?: string;
  ticketBoard?: string;
  sessions: Set<string>;
  kinds: Set<string>;
  includeSelf: boolean;
  done: (value: unknown) => void;
}
const waiters = new Set<Waiter>();

function matchWaiter(w: Waiter, e: HudEvent): boolean {
  const self = w.session;
  if (!w.includeSelf && self) {
    if (e.kind === 'context' && e.entry.session === self) return false;
    if (e.kind === 'claim' && e.claim.session === self) return false;
    if (e.kind === 'session' && e.session.id === self) return false;
  }
  switch (e.kind) {
    case 'context': {
      if (!w.kinds.has('context')) return false;
      if (w.scope && e.entry.scope === w.scope) return true;
      if (w.ticket && (e.entry.refs?.includes(w.ticket) || e.entry.scope === `run:${w.ticket}`)) return true;
      return false;
    }
    case 'claim': {
      if (!w.kinds.has('claim')) return false;
      if (w.ticket && e.claim.ticket === w.ticket) return true;
      if (w.scope && (w.scope === `board:${e.claim.board}` || w.scope === `run:${e.claim.ticket}`)) return true;
      return false;
    }
    case 'session':
      return w.kinds.has('session') && w.sessions.has(e.session.id);
    case 'item':
      return w.kinds.has('item') && !!w.ticket && e.item.id === w.ticket;
    case 'item.deleted':
      return w.kinds.has('item') && !!w.ticket && e.id === w.ticket;
    default:
      return false;
  }
}

function matchWaiters(e: HudEvent) {
  if (!waiters.size) return;
  for (const w of [...waiters]) {
    let matched = false;
    try { matched = matchWaiter(w, e); } catch { matched = false; }
    if (matched) w.done({ woke: true, reason: e.kind, event: e, now: Date.now() });
  }
}

store.on('event', (e: HudEvent) => {
  try {
    const out = e.kind === 'item' ? { ...e, item: Store.lite(e.item) } : e.kind === 'board' ? { ...e, board: Store.boardLite(e.board) } : e;
    broadcast(`data: ${JSON.stringify(out)}\n\n`);
    if (e.kind === 'alert') runAlertHook(e.alert);
    matchWaiters(e);
  } catch (err) {
    console.error('[hud] event handler:', err);
  }
});
setInterval(() => {
  try {
    store.checkStale();
    store.pruneCoordination();
  } catch (e) {
    console.error('[hud] stale check:', e);
  }
}, 5000).unref();
setInterval(() => broadcast(`data: ${JSON.stringify({ kind: 'heartbeat', now: Date.now() })}\n\n`), 20000).unref();

/** HUD_ALERT_CMD: shell command run for every alert, alert JSON on stdin and HUD_ALERT_* env vars */
let hooksRunning = 0;
const envText = (v: unknown) => String(v ?? '').replace(/\0/g, '').slice(0, 4000);
function runAlertHook(a: Alert) {
  const cmd = process.env.HUD_ALERT_CMD;
  if (!cmd) return;
  if (hooksRunning >= 4) return console.error('[hud] alert hook: too many running, skipped one alert');
  try {
    const child = spawn(process.env.SHELL || '/bin/sh', ['-c', cmd], {
      stdio: ['pipe', 'ignore', 'inherit'],
      timeout: 30_000,
      env: {
        ...process.env,
        HUD_ALERT_ID: envText(a.itemId),
        HUD_ALERT_TITLE: envText(a.title),
        HUD_ALERT_STATE: envText(a.to),
        HUD_ALERT_FROM: envText(a.from),
        HUD_ALERT_MESSAGE: envText(a.message),
        HUD_ALERT_BOARD: envText(a.board),
      },
    });
    hooksRunning++;
    let done = false;
    const finish = () => {
      if (!done) hooksRunning--;
      done = true;
    };
    child.on('error', (err) => {
      finish();
      console.error('[hud] alert hook:', err.message);
    });
    child.on('close', (code, sig) => {
      finish();
      if (code || sig) console.error(`[hud] alert hook exited ${code ?? sig}`);
    });
    child.stdin.on('error', () => {}); // EPIPE when the hook never reads stdin
    child.stdin.end(JSON.stringify(a));
  } catch (err) {
    console.error('[hud] alert hook:', (err as Error).message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

async function readRaw(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new HudError(413, 'body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function readBody(req: IncomingMessage, max = 2 << 20): Promise<any> {
  const raw = await readRaw(req, max);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HudError(400, 'body must be JSON');
  }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
/** a JSON object body; arrays, strings and null are a client error, not a crash */
async function readObj(req: IncomingMessage, max?: number): Promise<Record<string, any>> {
  const b = await readBody(req, max);
  if (!isObj(b)) throw new HudError(400, 'body must be a JSON object');
  return b;
}
function strList(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' && typeof x !== 'number')) throw new HudError(400, `${what} must be an array of strings`);
  return v.map(String);
}
function textFormat(v: unknown, what: string): 'plain' | 'markdown' | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v !== 'plain' && v !== 'markdown') throw new HudError(400, `${what} must be plain or markdown`);
  return v;
}
function numParam(q: URLSearchParams, name: string): number | undefined {
  const raw = q.get(name);
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new HudError(400, `${name} must be a non-negative number`);
  return n;
}
const dec = (s: string) => decodeURIComponent(s);

function actorOf(req: IncomingMessage, body?: any, q?: URLSearchParams) {
  // clients percent-encode the header so non-Latin names survive HTTP's Latin-1 header rules
  let h = req.headers['x-hud-actor'] as string | undefined;
  if (h) try { h = decodeURIComponent(h); } catch {}
  const a = h || (isObj(body) ? body.actor : undefined) || q?.get('actor') || 'api';
  return String(a).slice(0, 40);
}

/** the session making a call: header, body or query; undefined when the caller has none */
function sessionOf(req: IncomingMessage, body?: any, q?: URLSearchParams): string | undefined {
  const h = req.headers['x-hud-session'];
  const s = (typeof h === 'string' ? h : undefined) || (isObj(body) ? body.session : undefined) || q?.get('session');
  return s === undefined || s === null || s === '' ? undefined : String(s).slice(0, 64);
}

/** the filters shared by GET /api/items and GET /api/tickets */
function queryOf(q: URLSearchParams): SearchQuery {
  const board = q.get('board');
  const status = q.get('status');
  const limit = numParam(q, 'limit');
  return {
    board: board ? store.requireBoard(board).id : undefined,
    type: q.get('type') || undefined,
    status: status ? status.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    priority: q.get('priority') || undefined,
    assignee: q.get('assignee') || undefined,
    owner: q.get('owner') || undefined,
    project: q.get('project') || undefined,
    tag: q.get('tag') || undefined,
    text: q.get('q') || undefined,
    overdue: q.get('overdue') === '1' || q.get('overdue') === 'true' ? true : undefined,
    parent: q.get('parent') || undefined,
    limit: limit === undefined ? undefined : Math.floor(limit),
  };
}

/** a ticket reference as other tickets see it: enough to render a chip */
function refOf(x: Item) {
  return { id: x.id, ident: store.ident(x), title: x.title, status: x.status ?? 'todo' };
}

/** the Linear graph around one ticket, so a single GET renders the whole context */
function graphOf(it: Item) {
  const get = (id: string) => (Object.hasOwn(store.state.items, id) ? store.state.items[id] : undefined);
  return {
    ident: store.ident(it),
    parent: it.parent ? (get(it.parent) ? refOf(get(it.parent)!) : null) : null,
    ancestors: store.ancestorsOf(it.id).map(refOf),
    children: store.childrenOf(it.id).map(refOf),
    blockedBy: (it.blockedBy ?? []).map(get).filter((x): x is Item => !!x).map(refOf),
    blocks: store.blocksOf(it.id).map(refOf),
    refs: store.refsOf(it).map(refOf),
    rollup: store.rollup(it.id),
  };
}

/**
 * Items go out without their 24h trend (only GET /api/items/:id carries it). A ticket carries its Linear
 * graph so one round-trip gives the ident, branch, blockers and subtree, namespaced under `graph` so the
 * raw `parent`/`blockedBy` ids the editors patch stay intact.
 */
function withGraph(it: Item): unknown {
  const lite = Store.lite(it);
  return it.type === 'ticket' ? { ...lite, ident: store.ident(it), graph: graphOf(it) } : lite;
}

/** the single-item read: the only response that includes the trend (and a monitor's uptime) */
function fullItem(it: Item): unknown {
  if (it.type === 'monitor') return { ...it, uptime: store.uptime(it.id) };
  return it.type === 'ticket' ? { ...it, ident: store.ident(it), graph: graphOf(it) } : it;
}

/** one row of the ticket list */
function ticketView(t: Item) {
  const own = store.ownership(t);
  return {
    id: t.id,
    ident: store.ident(t),
    title: t.title,
    status: t.status ?? 'todo',
    priority: t.priority ?? null,
    assignee: own.assignee,
    claimer: own.claimer,
    claimSession: own.claimSession,
    owner: own.owner,
    project: t.project ?? null,
    parent: t.parent ? store.identOf(t.parent) : null,
    parentId: t.parent ?? null,
    blockedBy: (t.blockedBy ?? []).map((id) => store.identOf(id)),
    refs: (t.refs ?? []).map((id) => store.identOf(id)),
    branch: t.branch ?? null,
    target: t.target ?? null,
    tags: t.tags ?? [],
    monitors: t.monitors ?? [],
    isSub: !!t.parent,
    comments: t.comments?.length ?? 0,
    children: store.childrenOf(t.id).length,
    rollup: store.rollup(t.id),
    updatedAt: t.updatedAt,
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse, m: string[], q: URLSearchParams) => Promise<unknown> | unknown;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '/?$'), h]);
/** resolve an id-or-ident from the URL (idents like KEY-3 are accepted everywhere) */
const rid = (id: string, q?: URLSearchParams) => store.resolveId(dec(id), q?.get('board') || undefined);

registerMonitoring({ route, store, engine, port: PORT, readObj, actorOf, send, shutdown });

route('GET', '/api/health', () => ({
  ...store.health(),
  ok: true,
  name: 'hud',
  version: VERSION,
  stateVersion: STATE_VERSION,
  pid: process.pid,
  port: PORT,
  mode: isPackaged() ? 'packaged' : 'source',
  dataDir,
}));

// Cross-platform stop: Windows cannot deliver SIGTERM to a detached child, so the CLI prefers this
// (it runs the same shutdown path as a signal, flushing state and removing the pid file).
route('POST', '/api/shutdown', () => {
  setTimeout(shutdown, 50);
  return { ok: true, stopping: process.pid };
});
route('GET', '/api/guide', (_req, res, _m, q) => {
  try {
    send(res, 200, coordinationDoc(q.get('playbook'), PORT), 'text/markdown; charset=utf-8');
  } catch (e) {
    if (e instanceof GuideError) throw new HudError(e.status, e.message);
    throw e;
  }
});
route('GET', '/api/monitor-templates', () => listMonitorTemplates());
route('GET', '/api/views', () => ({
  dir: viewsDir,
  views: listViewInfos(viewsDir).map(({ name, mtime, bytes, sha256, validation }) => ({ name: `${name}.js`, mtime, bytes, sha256, valid: validation.ok, errors: validation.errors })),
}));

// ---------- view modules (they run unsandboxed in the board page) ----------
// Generated modules are written by this process. Caller-supplied source is staged and
// installed only when a later request approves that exact review.
const viewPreviews = new Map<string, { name: string; code: string; expires: number }>();
const viewPreviewUrl = (token: string) => `http://127.0.0.1:${PORT}/api/view-preview/${token}`;

route('GET', '/api/views/:name', (_req, _res, [name]) => {
  const n = dec(name).replace(/\.js$/i, '');
  const code = readViewFile(n);
  return { name: n, code, sha256: validateViewCode(code).sha256, validation: validateViewCode(code) };
});
route('PUT', '/api/views/:name', async (req, _res, [name]) => {
  const b = await readObj(req);
  // Clock and ttl stay server-side. A client cannot approve a module that was never staged.
  if (b.maxChars !== undefined && (!Number.isInteger(b.maxChars) || b.maxChars < 1)) throw new HudError(400, 'maxChars must be a positive integer');
  return installUntrustedView(dec(name).replace(/\.js$/i, ''), {
    code: typeof b.code === 'string' ? b.code : undefined,
    overwrite: b.overwrite === true,
    expectedSha256: b.expectedSha256 === undefined ? undefined : String(b.expectedSha256),
    approve: b.approve === true,
    proposalId: typeof b.proposalId === 'string' ? b.proposalId : undefined,
    sha256: typeof b.sha256 === 'string' ? b.sha256 : undefined,
    maxChars: b.maxChars === undefined ? undefined : b.maxChars,
  });
});
route('POST', '/api/views', async (req) => {
  const b = await readObj(req);
  if (typeof b.name !== 'string') throw new HudError(400, 'name is required');
  if (!isObj(b.spec)) throw new HudError(400, 'spec must be an object');
  const code = generateViewCode(b.name, b.spec as any);
  const validation = validateViewCode(code);
  if (b.write === true && validation.ok) {
    const r = writeViewFile(b.name, code, { overwrite: b.overwrite === true, expectedSha256: b.expectedSha256 === undefined ? undefined : String(b.expectedSha256) });
    return { name: b.name, code, validation, written: true, ...r };
  }
  return { name: b.name, code, validation, written: false };
});
route('DELETE', '/api/views/:name', (req, _res, [name], q) => deleteViewFile(dec(name).replace(/\.js$/i, ''), q.get('expectedSha256') || undefined));
route('POST', '/api/views/:name/validate', async (req, _res, [name]) => {
  const b = await readObj(req);
  const code = typeof b.code === 'string' ? b.code : readViewFile(dec(name).replace(/\.js$/i, ''));
  const validation = validateViewCode(code);
  if (!validation.ok) return { ...validation, rendered: false };
  const token = randomUUID();
  viewPreviews.set(token, { name: dec(name), code, expires: Date.now() + 120_000 });
  try {
    const shot = await capturePage(viewPreviewUrl(token), 'page');
    const errors = shot.errors ?? [];
    return { ...validation, rendered: errors.length === 0, renderErrors: errors, image: shot.image };
  } catch (e) {
    return { ...validation, rendered: false, renderErrors: [(e as Error).message] };
  } finally {
    viewPreviews.delete(token);
  }
});
route('GET', '/api/view-preview/:token', (_req, res, [token]) => {
  const p = viewPreviews.get(dec(token));
  if (!p || p.expires < Date.now()) throw new HudError(404, 'preview expired');
  const fixture = JSON.stringify(viewFixture()).replaceAll('<', '\\u003c');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'" });
  res.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#0e1218;color:#e6ebf2;font:13px/1.45 ui-sans-serif,system-ui,sans-serif}svg{display:block}</style><body><div id="out"></div><script type="module">
import { render } from '/api/view-preview-source/${token}';
import { helpers } from '/views.js';
const errors = [];
window.__hudCapture = { ready: false, errors };
try {
  const out = render({ item: ${fixture}, w: 420, h: 160, helpers });
  document.getElementById('out').innerHTML = out || '';
} catch (e) { errors.push(String(e && e.message || e)); }
window.__hudCapture.ready = true;
</script>`);
});
route('GET', '/api/view-preview-source/:token', (_req, res, [token]) => {
  const p = viewPreviews.get(dec(token));
  if (!p || p.expires < Date.now()) throw new HudError(404, 'preview expired');
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
  res.end(p.code);
});
route('GET', '/api/state', (_r, _s, _m, q) => {
  const board = q.get('board') ? store.requireBoard(q.get('board')!).id : undefined;
  return publicState(store, board);
});
route('GET', '/api/summary', (_r, res, _m, q) => {
  const board = q.get('board');
  const boards = board ? [store.requireBoard(board)] : store.boards();
  send(res, 200, summarize(boards, store.items(), { ident: (it) => store.ident(it), name: (id) => store.identOf(id) }), 'text/plain; charset=utf-8');
});
// the Linear-style read model: projects with their tickets, counts and trees
route('GET', '/api/projects', (_r, _s, _m, q) => {
  const board = store.requireBoard(q.get('board') || 'main').id;
  return store.projectsView(board).map((g) => ({ ...g, project: g.project ? Store.lite(g.project) : undefined }));
});
route('POST', '/api/projects', async (req) => {
  const b = await readObj(req);
  const title = typeof b.name === 'string' ? b.name : b.title;
  if (typeof title !== 'string' || !title.trim()) throw new HudError(400, 'name is required');
  const input: Record<string, unknown> = { type: 'project', title };
  if (b.key !== undefined) input.key = b.key;
  if (b.board !== undefined) input.board = b.board;
  if (b.body !== undefined || b.description !== undefined) input.body = b.body ?? b.description;
  if (b.lead !== undefined) input.lead = b.lead;
  if (b.target !== undefined) input.target = b.target;
  return Store.lite(store.create(input, actorOf(req, b)));
});
route('PATCH', '/api/projects/:id', async (req, _res, [id]) => {
  const b = await readObj(req);
  const board = typeof b.board === 'string' ? b.board : undefined;
  const found = store.project(dec(id), board);
  if (!found) throw new HudError(404, `no project "${dec(id).slice(0, 80)}"`);
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined || b.title !== undefined) patch.title = b.name ?? b.title;
  if (b.key !== undefined) patch.key = b.key;
  if (b.body !== undefined || b.description !== undefined) patch.body = b.body ?? b.description;
  if (b.lead !== undefined) patch.lead = b.lead;
  if (b.target !== undefined) patch.target = b.target;
  if (b.status !== undefined) patch.status = b.status;
  if (!Object.keys(patch).length) throw new HudError(400, 'nothing to update');
  return Store.lite(store.update(found.id, patch, actorOf(req, b)));
});
route('GET', '/api/tree', (_r, _s, _m, q) => store.ticketForest(q.get('board') || 'main', q.get('project') || undefined));
route('POST', '/api/tree', async (req) => {
  const b = await readObj(req);
  if (typeof b.id !== 'string' || !b.id.trim()) throw new HudError(400, 'id is required');
  const action = String(b.action ?? 'move');
  const id = store.resolveId(b.id, typeof b.board === 'string' ? b.board : undefined);
  if (action === 'detach') return withGraph(store.link(id, { parent: '' }, actorOf(req, b)));
  if (action !== 'move') throw new HudError(400, 'action must be move|detach');
  const patch: Record<string, unknown> = {};
  if (b.parent !== undefined) patch.parent = b.parent;
  if (b.project !== undefined) patch.project = b.project;
  if (!('parent' in patch) && !('project' in patch)) throw new HudError(400, 'move needs parent and/or project');
  return withGraph(store.link(id, patch, actorOf(req, b)));
});
route('GET', '/api/tickets', (_r, res, _m, q) => {
  const filter = queryOf(q);
  const board = filter.board ?? store.requireBoard('main').id;
  const sq: SearchQuery = { ...filter, board, type: undefined };
  if (q.get('format') === 'text') return send(res, 200, ticketsView(store, board, sq), 'text/plain; charset=utf-8');
  return {
    board,
    groups: store.projectsView(board, sq).map((g) => ({
      project: g.project ? Store.lite(g.project) : null,
      key: g.key,
      name: g.name,
      counts: g.counts,
      total: g.total,
      tickets: g.tickets.map((t) => ticketView(t)),
    })),
  };
});
route('GET', '/api/activity', (_r, _s, _m, q) => store.activity(Math.floor(numParam(q, 'limit') || 50), q.get('board') ? store.requireBoard(q.get('board')!).id : undefined));

route('GET', '/api/boards', () => store.boards().map(Store.boardLite));
route('POST', '/api/boards', async (req) => {
  const b = await readObj(req);
  return store.createBoard(b.name, actorOf(req, b), b.id);
});
route('PATCH', '/api/boards/:id', async (req, _s, [id]) => {
  const b = await readObj(req);
  return store.setBoard(dec(id), { name: b.name, autoOrganize: b.autoOrganize, notify: b.notify }, actorOf(req, b));
});
route('DELETE', '/api/boards/:id', (req, _s, [id], q) => {
  store.deleteBoard(dec(id), actorOf(req, undefined, q));
  return { ok: true };
});
route('POST', '/api/boards/:id/clear', async (req, _res, [id]) => {
  const body = await readObj(req);
  return store.clearBoard(dec(id), actorOf(req, body));
});

// ---------- coordination: presence, claims, queue ----------
route('GET', '/api/sessions', () => store.sessions());
route('POST', '/api/sessions', async (req) => {
  const b = await readObj(req);
  const id = b.id ?? b.name;
  if (typeof id !== 'string' || !id.trim()) throw new HudError(400, 'id (or name) is required');
  return store.sessionStart({ id, name: typeof b.name === 'string' ? b.name : undefined, actor: typeof b.actor === 'string' ? b.actor : undefined, kind: b.kind, pid: Number.isFinite(b.pid) ? b.pid : undefined, run: typeof b.run === 'string' ? b.run : undefined, clientVersion: typeof b.clientVersion === 'string' ? b.clientVersion : undefined }, actorOf(req, b));
});
function reconnectLiveClients() {
  return clientsFromSessions(store.sessions().items.filter((item) => item.live));
}
route('GET', '/api/reconnect', () => loadReconnectChecklist(dataDir, VERSION, reconnectLiveClients()));
route('POST', '/api/reconnect/ack', () => takeReconnectChecklist(dataDir, VERSION, reconnectLiveClients()));
route('POST', '/api/sessions/:id/heartbeat', (_req, _res, [id]) => store.sessionHeartbeat(dec(id)));
route('DELETE', '/api/sessions/:id', (req, _res, [id], q) => store.sessionEnd(dec(id), actorOf(req, undefined, q)));

// Sole claims list. Omit session for every lease; board narrows it. Shape is {items, now} from claimsList.
route('GET', '/api/claims', (_req, _res, _m, q) => store.claimsList({
  session: q.get('session') || undefined,
  board: q.get('board') || undefined,
}));
route('GET', '/api/items/:id/claim', (_req, _res, [id], q) => store.claimOf(rid(id, q)));
route('POST', '/api/items/:id/claim', async (req, _res, [id], q) => {
  const b = await readObj(req);
  const session = sessionOf(req, b, q);
  if (!session) throw new HudError(400, 'session is required to claim work');
  return store.claim(rid(id, q), {
    session,
    ttl: b.ttl === undefined ? undefined : Number(b.ttl),
    start: b.start === true || b.start === 'true' || b.start === 1,
    takeover: b.takeover === true || b.takeover === 'true' || b.takeover === 1,
  }, actorOf(req, b, q));
});
route('DELETE', '/api/items/:id/claim', (req, _res, [id], q) => store.releaseClaim(rid(id, q), { session: sessionOf(req, undefined, q), reason: q.get('reason') ?? undefined }, actorOf(req, undefined, q)));
route('GET', '/api/queue', (_req, _res, _m, q) => store.queue(q.get('board') || 'main', {
  status: q.get('status') || undefined,
  project: q.get('project') || undefined,
  assignee: q.get('assignee') || undefined,
  owner: q.get('owner') || undefined,
  includeDone: q.get('includeDone') === '1' || q.get('includeDone') === 'true' || q.get('all') === '1',
  limit: numParam(q, 'limit'),
}));

// ---------- shared context ----------
const kindsOf = (v: unknown) => {
  const list = Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : undefined;
  return list?.map(x => String(x).trim().toUpperCase()).filter(Boolean);
};
route('POST', '/api/context', async (req) => {
  const b = await readObj(req);
  return store.contextPublish({
    scope: String(b.scope ?? ''), kind: b.kind, text: b.text, data: b.data, refs: strList(b.refs, 'refs'),
    attachments: strList(b.attachments, 'attachments'), corrects: b.corrects === undefined ? undefined : String(b.corrects),
    session: sessionOf(req, b),
  }, actorOf(req, b));
});
route('GET', '/api/context', (req, _res, _m, q) => store.contextRead({
  scope: q.get('scope') || undefined,
  since: numParam(q, 'since'),
  kinds: kindsOf(q.get('kind')) as any,
  limit: numParam(q, 'limit'),
}, { session: sessionOf(req, undefined, q), mark: q.get('mark') === '1' }));
route('POST', '/api/context/read', async (req) => {
  const b = await readObj(req);
  return store.contextRead({
    scope: b.scope === undefined ? undefined : String(b.scope),
    since: b.since === undefined ? undefined : Number(b.since),
    kinds: kindsOf(b.kinds ?? b.kind) as any,
    limit: b.limit === undefined ? undefined : Number(b.limit),
  }, { session: sessionOf(req, b), mark: b.mark !== false });
});
route('GET', '/api/context/scopes', (_req, _res, _m, q) => store.contextScopes(q.get('board') ? store.requireBoard(q.get('board')!).id : undefined));

// ---------- long-poll: wait for a peer ----------
route('POST', '/api/wait', async (req, res) => {
  if (waiters.size >= 100) throw new HudError(429, 'too many waiters');
  const b = await readObj(req);
  const session = sessionOf(req, b);
  const scope = b.scope === undefined ? undefined : String(b.scope);
  const ticket = b.ticket === undefined ? undefined : store.resolveId(String(b.ticket));
  const sessions = new Set(strList(b.sessions, 'sessions'));
  if (!scope && !ticket && !sessions.size) throw new HudError(400, 'a wait needs scope, ticket or sessions');
  const kinds = new Set((b.kinds === undefined ? ['context', 'claim', 'session'] : Array.isArray(b.kinds) ? b.kinds : String(b.kinds).split(',')).map((k: unknown) => String(k)));
  const includeSelf = b.includeSelf === true || b.includeSelf === 'true';
  if (ticket && (!store.state.items[ticket] || store.state.items[ticket]!.type !== 'ticket')) throw new HudError(400, `ticket ${String(b.ticket)} not found`);
  const since = b.since === undefined ? undefined : Number(b.since);
  if (since !== undefined && (!Number.isFinite(since) || since < 0)) throw new HudError(400, 'since must be a non-negative sequence number');
  // catch up on context first, so a delta read and a wait cannot miss an entry
  if (since !== undefined && scope) {
    const r = store.contextRead({ scope, since, limit: 20 });
    const first = r.entries.find(e => includeSelf || e.session !== session);
    if (first) return { woke: true, reason: 'context', event: { kind: 'context', entry: first }, cursor: first.seq, now: Date.now() };
  }
  const seconds = Math.max(1, Math.min(25, Number(b.timeoutSeconds) || 20));
  return await new Promise((resolve) => {
    const waiter: Waiter = {
      session, scope, ticket, ticketBoard: ticket ? store.state.items[ticket]!.board : undefined, sessions, kinds, includeSelf,
      done: () => {},
    };
    const finish = (value: unknown) => {
      clearTimeout(timer);
      waiters.delete(waiter);
      res.off('close', onClose);
      if (!res.headersSent && !res.destroyed) send(res, 200, value);
      resolve(undefined);
    };
    const onClose = () => {
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve(undefined);
    };
    const timer = setTimeout(() => finish({ woke: false, timeout: true, now: Date.now() }), seconds * 1000);
    waiter.done = finish;
    waiters.add(waiter);
    res.on('close', onClose);
  });
});

// ---------- attachments (bytes live outside state.json) ----------
route('POST', '/api/attachments', async (req) => {
  const b = await readObj(req, 8 << 20);
  if (typeof b.contentBase64 !== 'string' || !b.contentBase64) throw new HudError(400, 'contentBase64 is required');
  const bytes = Buffer.from(b.contentBase64, 'base64');
  const name = sanitizeName(String(b.name ?? ''));
  const id = randomUUID();
  const board = store.requireBoard(String(b.board ?? 'main')).id;
  const written = writeAttachmentBytes(board, id, name, bytes);
  try {
    return store.attachmentAdd({
      id, board, name, scope: b.scope === undefined ? undefined : String(b.scope), kind: b.kind, mime: b.mime,
      bytes: written.bytes, sha256: written.sha256, session: sessionOf(req, b), target: b.target,
      baseId: b.baseId, baseSha256: b.baseSha256, corrects: b.corrects,
    }, actorOf(req, b));
  } catch (e) {
    removeAttachmentBytes({ id, board, name } as any);
    throw e;
  }
});
route('GET', '/api/attachments', (_req, _res, _m, q) => store.attachments({ board: q.get('board') ? store.requireBoard(q.get('board')!).id : undefined, scope: q.get('scope') || undefined }));
route('GET', '/api/attachments/:id', (_req, _res, [id]) => store.attachment(dec(id)));
route('GET', '/api/attachments/:id/content', (_req, res, [id], q) => {
  const a = store.attachment(dec(id));
  const bytes = readAttachmentBytes(a);
  if (q.get('format') === 'text') {
    const text = textOf(bytes);
    if (text === null) throw new HudError(415, 'attachment is not UTF-8 text');
    return send(res, 200, text, 'text/plain; charset=utf-8');
  }
  res.writeHead(200, { 'content-type': a.mime || 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
});
route('GET', '/api/attachments/:id/expand', (_req, _res, [id]) => {
  const a = store.attachment(dec(id));
  if (a.kind === 'diff') {
    const text = textOf(readAttachmentBytes(a));
    if (text === null) throw new HudError(415, 'attachment is not UTF-8 text');
    return { text, added: null, removed: null, truncated: false, kind: 'diff' };
  }
  if (!a.baseId) throw new HudError(400, 'expand needs a base attachment (publish a diff against an earlier version)');
  const base = store.attachment(a.baseId);
  const baseBytes = readAttachmentBytes(base);
  if (a.baseSha256 && hashBytes(baseBytes) !== a.baseSha256) throw new HudError(409, 'base attachment changed since this version was published', { code: 'base-mismatch' });
  const before = textOf(baseBytes);
  const after = textOf(readAttachmentBytes(a));
  if (before === null || after === null) throw new HudError(415, 'expand only works on UTF-8 text');
  return { ...unifiedDiff(before, after), kind: 'diff' };
});
route('DELETE', '/api/attachments/:id', (req, _res, [id], q) => {
  const a = store.attachmentRemove(dec(id), actorOf(req, undefined, q), { force: q.get('force') === '1' || q.get('force') === 'true' });
  removeAttachmentBytes(a);
  return a;
});
route('POST', '/api/attachments/:id/applied', async (req, _res, [id]) => {
  const b = await readObj(req);
  if (typeof b.target !== 'string' || !b.target) throw new HudError(400, 'target is required');
  return store.attachmentApplied(dec(id), b.target, actorOf(req, b));
});

route('GET', '/api/items', (_r, _s, _m, q) => store.items(queryOf(q)).map(Store.lite));
function materializeItem(body: Record<string, unknown>): Record<string, unknown> {
  try {
    return applyMonitorTemplate(body);
  } catch (e) {
    if (e instanceof MonitorTemplateError) throw new HudError(400, e.message);
    throw e;
  }
}
route('POST', '/api/items', async (req) => {
  const b = await readBody(req);
  const actor = actorOf(req, b);
  if (Array.isArray(b)) {
    if (b.some((x) => !isObj(x))) throw new HudError(400, 'expected an array of item objects');
    return b.map((x) => withGraph(store.create(materializeItem(x), actor)));
  }
  if (!isObj(b)) throw new HudError(400, 'body must be a JSON object');
  return withGraph(store.create(materializeItem(b), actor));
});
route('PATCH', '/api/items', async (req, _s, _m, q) => {
  const b = await readBody(req);
  if (!Array.isArray(b) || b.some((x) => !isObj(x) || x.id === undefined)) throw new HudError(400, 'expected an array of {id, ...patch}');
  const actor = actorOf(req, undefined, q);
  return b.map(({ id, ...patch }) => withGraph(store.update(store.resolveId(String(id)), patch, actor)));
});
route('GET', '/api/items/:id', (_r, _s, [id], q) => fullItem(store.get(rid(id, q))));
route('GET', '/api/items/:id/activity', (_r, _s, [id], q) => store.itemActivity(rid(id, q), Math.floor(numParam(q, 'limit') || 100)));
/** set a ticket's structure: project, parent, blockers, refs, branch */
route('POST', '/api/items/:id/link', async (req, _s, [id], q) => {
  const b = await readObj(req);
  return withGraph(store.link(rid(id, q), b, actorOf(req, b)));
});
route('POST', '/api/items/:id/unlink', async (req, _s, [id], q) => {
  const b = await readObj(req);
  const clear: Record<string, unknown> = {};
  // Naming a link clears it. "" and null are empty clears; any truthy value is a sentinel (the CLI sends true).
  const named = (v: unknown) => v === '' || v === null || !!v;
  for (const k of ['project', 'parent'] as const) if (named(b[k])) clear[k] = null;
  for (const k of ['blockedBy', 'refs'] as const) if (named(b[k])) clear[k] = [];
  if (!Object.keys(clear).length) throw new HudError(400, 'name at least one of project, parent, blockedBy, refs');
  return withGraph(store.link(rid(id, q), clear, actorOf(req, b)));
});
route('PATCH', '/api/items/:id', async (req, _s, [id], q) => {
  const b = await readObj(req);
  return withGraph(store.update(rid(id, q), b, actorOf(req, b)));
});
route('DELETE', '/api/items/:id', (req, _s, [id], q) => Store.lite(store.remove(rid(id, q), actorOf(req, undefined, q))));
route('POST', '/api/items/:id/comments', async (req, _s, [id], q) => {
  const b = await readObj(req);
  if (typeof b.text !== 'string') throw new HudError(400, 'text must be a string');
  return store.comment(rid(id, q), b.text, actorOf(req, b), textFormat(b.format, 'format'));
});
route('PATCH', '/api/items/:id/comments/:cid', async (req, _s, [id, cid], q) => {
  const b = await readObj(req);
  if (typeof b.text !== 'string') throw new HudError(400, 'text must be a string');
  return store.editComment(rid(id, q), dec(cid), b.text, actorOf(req, b), textFormat(b.format, 'format'));
});
route('DELETE', '/api/items/:id/comments/:cid', (req, _s, [id, cid], q) => {
  store.deleteComment(rid(id, q), dec(cid), actorOf(req, undefined, q));
  return { ok: true };
});
/** an agent asks for a decision: propose options on a ticket and block it until one is picked */
route('POST', '/api/items/:id/ask', async (req, _s, [id], q) => {
  const b = await readObj(req);
  if ((b.question !== undefined && typeof b.question !== 'string') || !Array.isArray(b.options)) throw new HudError(400, 'question (string, optional) and options (array) required');
  return withGraph(store.ask(rid(id, q), { question: b.question, options: b.options, questionFormat: textFormat(b.questionFormat, 'questionFormat') }, actorOf(req, b)));
});
/** pick one of a ticket's proposed options */
route('POST', '/api/items/:id/decide', async (req, _s, [id], q) => {
  const b = await readObj(req);
  if (!b.optionId) throw new HudError(400, 'optionId required');
  if (b.decisionVersion !== undefined && typeof b.decisionVersion !== 'string') throw new HudError(400, 'decisionVersion must be a string');
  return withGraph(store.decide(rid(id, q), String(b.optionId), actorOf(req, b), b.note, b.decisionVersion));
});
/** an agent signals it is finished: complete its items and tidy the board */
route('POST', '/api/finish', async (req) => {
  const b = await readObj(req);
  if (b.export !== undefined && typeof b.export !== 'boolean') throw new HudError(400, 'export must be a boolean');
  if (b.exportAll !== undefined && typeof b.exportAll !== 'boolean') throw new HudError(400, 'exportAll must be a boolean');
  const r = store.finish({ board: b.board, ids: strList(b.ids, 'ids').map((x) => store.resolveId(x)), note: b.note, organize: b.organize, export: b.export, exportAll: b.exportAll }, actorOf(req, b));
  // report idents so the CLI/MCP messages read the same as everywhere else
  return { ...r, done: r.done.map((x: string) => store.identOf(store.resolveId(x))) };
});
route('POST', '/api/runs/:id/export', (req, _res, [id]) => store.exportRunContext(rid(id), actorOf(req)));
route('GET', '/api/runs/exports', () => store.listRunExports());
route('GET', '/api/runs/:id/exports', (_req, _res, [id]) => store.listRunExports(rid(id)));
route('GET', '/api/runs/:id/exports/:name', (_req, res, [id, name], q) => {
  const safe = dec(name);
  const bytes = store.readRunExport(rid(id), safe);
  const format = q.get('format');
  if (format === 'markdown') {
    let md: Buffer;
    try { md = zipEntry(bytes, 'context.md'); } catch (e) { throw new HudError(500, (e as Error).message); }
    return send(res, 200, md.toString('utf8'), 'text/markdown; charset=utf-8');
  }
  if (format !== null && format !== 'zip') throw new HudError(400, 'format must be markdown or zip');
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': bytes.length,
    'content-disposition': `attachment; filename="${safe.replace(/"/g, '')}"`,
    'cache-control': 'no-store',
  });
  res.end(bytes);
});
route('POST', '/api/monitors/:id/push', async (req, _s, [id], q) => {
  const b = await readObj(req);
  return Store.lite(store.push(rid(id, q), b, actorOf(req, b)));
});
route('POST', '/api/monitors/:id/run', async (_r, _s, [id], q) => {
  const mid = rid(id, q);
  await engine.runNow(mid).catch((e) => {
    if (e instanceof HudError) throw e;
    throw new HudError(400, (e as Error).message);
  });
  return Store.lite(store.get(mid));
});
/** The browser actor `user` approves the command currently shown in Attention. */
route('POST', '/api/monitors/:id/approve', async (req, _s, [id], q) => {
  const b = await readObj(req);
  if (typeof b.revision !== 'string' || !b.revision) throw new HudError(400, 'revision must be a string');
  return Store.lite(store.approveCommand(rid(id, q), b.revision, actorOf(req, b)));
});
route('GET', '/api/alerts', (_r, _s, _m, q) =>
  store.alerts({ all: q.get('all') === '1', since: numParam(q, 'since'), notify: q.get('notify') || undefined }),
);
/** human attention is separate from the agent alert acknowledgement queue */
route('GET', '/api/attention', () => store.attention());
route('POST', '/api/attention/:id', async (req, _s, [id], q) => {
  const b = await readObj(req);
  if (b.action !== 'review' && b.action !== 'unreview' && b.action !== 'snooze') throw new HudError(400, 'action must be review, unreview or snooze');
  if (typeof b.revision !== 'string' || !b.revision) throw new HudError(400, 'revision must be a string');
  if (b.until !== undefined && (typeof b.until !== 'number' || !Number.isFinite(b.until) || b.until < 0)) throw new HudError(400, 'until must be a non-negative number');
  if (b.action === 'snooze' && b.until === undefined) throw new HudError(400, 'until is required for snooze');
  return store.reviewAttention(rid(id, q), { action: b.action, revision: b.revision, ...(b.until === undefined ? {} : { until: b.until }) }, actorOf(req, b));
});
route('GET', '/api/runs', () => store.runs());
route('GET', '/api/changes', (_r, _s, _m, q) => store.changesSince(numParam(q, 'since') ?? 0));
route('POST', '/api/alerts/ack', async (req) => {
  const b = await readObj(req);
  if (b.ids !== undefined && b.ids !== 'all' && !Array.isArray(b.ids)) throw new HudError(400, "ids must be an array or 'all'");
  return { acked: store.ackAlerts(b.ids ?? 'all') };
});
/** subscribe a session name to alerts from monitors (ids) and/or whole boards */
route('POST', '/api/watch', async (req) => {
  const b = await readObj(req);
  const name = String(b.name ?? '').trim();
  if (!name) throw new HudError(400, 'name required');
  const ids = strList(b.ids, 'ids');
  const boards = strList(b.boards, 'boards');
  const off = b.off === true;
  const edit = (list: string[] | undefined) => (off ? (list ?? []).filter((n) => n !== name) : [...new Set([...(list ?? []), name])]);
  const actor = actorOf(req, b);
  for (const id of ids) store.update(id, { notify: edit(store.get(id).notify) }, actor, { silent: true });
  for (const bid of boards) store.setBoard(bid, { notify: edit(store.requireBoard(bid).notify) }, actor);
  return { name, ids, boards, off };
});
route('POST', '/api/organize', async (req) => {
  const b = await readObj(req);
  const actor = actorOf(req, b);
  if (b.auto !== undefined) store.setBoard(b.board ?? 'main', { autoOrganize: !!b.auto }, actor);
  return store.organize(b.board, actor);
});
route('POST', '/api/arrange', async (req) => {
  const b = await readObj(req);
  for (const k of ['width', 'gap'])
    if (b[k] !== undefined && (typeof b[k] !== 'number' || !Number.isFinite(b[k]) || b[k] < 0 || b[k] > 100000)) throw new HudError(400, `${k} must be a non-negative number`);
  return store.arrange({ ...b, ids: b.ids === undefined ? undefined : strList(b.ids, 'ids') }, actorOf(req, b)).map((i) => ({ id: i.id, x: i.x, y: i.y, w: i.w, h: i.h }));
});

// ---------- trash, backups, export/import ----------
route('GET', '/api/trash', (_r, _s, _m, q) => {
  const board = q.get('board') ? store.requireBoard(q.get('board')!).id : undefined;
  return store.trash(board).map((e) => ({ ...e, item: Store.lite(e.item) }));
});
route('POST', '/api/trash/:id/restore', (req, _s, [id], q) => withGraph(store.restore(dec(id), actorOf(req, undefined, q))));
route('DELETE', '/api/trash/:id', (req, _s, [id], q) => ({ purged: store.purge(dec(id), actorOf(req, undefined, q)) }));
route('DELETE', '/api/trash', (req, _s, _m, q) => ({ purged: store.purge('all', actorOf(req, undefined, q)) }));
route('GET', '/api/backups', () => store.listBackups());
route('POST', '/api/backups', async (req) => {
  const b = await readObj(req);
  return { name: store.backup(b.reason === undefined ? undefined : String(b.reason)) };
});
route('POST', '/api/backups/:name/restore', (req, _s, [name], q) => store.restoreBackup(dec(name), actorOf(req, undefined, q)));
route('POST', '/api/data/reveal', async () => {
  try {
    await revealDirectory(dataDir);
  } catch (e) {
    throw new HudError(503, `could not open the data directory: ${(e as Error).message}`);
  }
  return { ok: true, dataDir };
});
route('GET', '/api/export', () => store.exportState());
route('POST', '/api/import', async (req) => {
  const b = await readObj(req, 64 << 20);
  if (b.mode !== 'replace' && b.mode !== 'merge') throw new HudError(400, "mode must be 'replace' or 'merge'");
  if (!isObj(b.state)) throw new HudError(400, 'state must be a JSON object');
  return store.importState(b.state, b.mode, actorOf(req, b));
});

route('GET', '/api/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write(`retry: 1000\ndata: ${JSON.stringify({ kind: 'hello', pid: process.pid })}\n\n`);
  clients.add(res);
  const drop = () => clients.delete(res);
  req.on('close', drop);
  res.on('error', drop);
});

/** heartbeat pings: /ping/:id[/start|/fail|/<exit code>], GET or POST, plain-text reply */
async function handlePing(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams) {
  const m = path.match(/^\/ping\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const id = dec(m[1]);
  let kind: 'ok' | 'start' | 'fail' | number = 'ok';
  if (m[2] !== undefined) {
    const k = dec(m[2]);
    if (k === 'start' || k === 'fail') kind = k;
    else if (/^\d{1,3}$/.test(k)) kind = Number(k);
    else throw new HudError(400, 'ping kind must be start, fail or an exit code');
  }
  const body = req.method === 'POST' ? (await readRaw(req, 10 * 1024)) || undefined : undefined;
  const pos = (name: string) => {
    const n = numParam(q, name);
    if (n !== undefined && n < 1) throw new HudError(400, `${name} must be at least 1`);
    return n;
  };
  const actor = actorOf(req, undefined, q);
  store.ping(id, kind, actor === 'api' ? 'ping' : actor, {
    body,
    board: q.get('board') ? store.requireBoard(q.get('board')!).id : undefined,
    group: q.get('group') || undefined,
    period: pos('period'),
    grace: pos('grace'),
    title: q.get('title') || undefined,
  });
  send(res, 200, 'ok', 'text/plain; charset=utf-8');
}

function serveStatic(path: string, res: ServerResponse) {
  const rel = normalize(dec(path === '/' ? '/index.html' : path)).replace(/^(\.\.[/\\])+/, '');
  const headers = (n: string): Record<string, string> => ({
    'content-type': MIME[extname(n)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    ...(extname(n) === '.html' ? { 'content-security-policy': CSP } : {}),
  });
  if (isPackaged()) {
    const name = rel.replace(/^\/+/, '');
    const body = name.startsWith('..') ? undefined : asset(`web/${name}`, 'utf8');
    if (body === undefined) return send(res, 404, { error: 'not found' });
    res.writeHead(200, headers(name));
    return res.end(body);
  }
  const file = resolve(WEB, '.' + rel);
  if (!file.startsWith(WEB + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, headers(file));
  res.end(readFileSync(file));
}

const handler = async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  try {
    // Only this machine, and only pages served by hud itself: blocks DNS rebinding and cross-site requests
    // (command monitors run shell commands, so the API must never be reachable from arbitrary web pages).
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 403, { error: 'bad host' });
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'cross-origin requests are not allowed' });

    // fixed base: a request target like "//" or "*" must not be parsed as a host
    const raw = req.url ?? '/';
    let url: URL;
    try {
      url = new URL('http://hud' + (raw.startsWith('/') ? raw : '/' + raw));
    } catch {
      return send(res, 400, { error: 'bad request target' });
    }
    const method = req.method ?? 'GET';
    const lookup = method === 'HEAD' ? 'GET' : method;
    if (['iframe', 'frame', 'object', 'embed'].includes(String(req.headers['sec-fetch-dest'] ?? '')) && !/^\/api\/program-frame\/[\w-]+$/.test(url.pathname)) return send(res, 403, { error: 'embedded navigation is restricted to program frames' });
    if (url.pathname.startsWith('/api/program-preview/')) res.setHeader('content-security-policy', CSP);
    if (url.pathname.startsWith('/api/')) {
      const reported = stableVersion(req.headers['x-hud-client-version']);
      if (reported) {
        const sid = sessionOf(req);
        if (sid) store.noteClientVersion(sid, reported);
        const beat = url.pathname.match(/^\/api\/sessions\/([^/]+)\/heartbeat\/?$/);
        if (beat) store.noteClientVersion(dec(beat[1]), reported);
      }
      for (const [m, re, h] of routes) {
        const match = m === lookup && url.pathname.match(re);
        if (!match) continue;
        if (method === 'HEAD' && url.pathname.startsWith('/api/events')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          return res.end();
        }
        const out = await h(req, res, match.slice(1), url.searchParams);
        if (!res.headersSent) send(res, 200, out === undefined ? { ok: true } : out);
        return;
      }
      return send(res, 404, { error: `no route ${method} ${url.pathname}. See GET /api/guide` });
    }
    if (url.pathname.startsWith('/ping/')) return await handlePing(req, res, url.pathname, url.searchParams);
    if (lookup !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (url.pathname.startsWith('/views/')) return serveView(dec(url.pathname.slice('/views/'.length)), res);
    serveStatic(url.pathname, res);
  } catch (e) {
    const uri = e instanceof URIError;
    const status = e instanceof HudError ? e.status : uri ? 400 : 500;
    if (status === 500) console.error(`[hud] ${req.method} ${String(req.url).slice(0, 200)}:`, e);
    const details = e instanceof HudError && e.details ? e.details : undefined;
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : uri ? 'malformed URL encoding' : (e as Error).message, ...(details ?? {}) });
    else res.end();
  }
};

const pidFile = join(dataDir, 'hud.pid');
const server = createServer(handler);
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
    console.error(`[hud] port ${PORT} is unavailable (${e.code}) — is hud already running? (http://localhost:${PORT})`);
    releaseLock();
    process.exit(1);
  }
  console.error('[hud] server error:', e);
});
server.on('clientError', (_e, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
});
server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(pidFile, String(process.pid));
  engine.start(); // always live: there is no test mode
  console.log(`[hud] http://localhost:${PORT}  (data: ${dataDir}, probes: ${probesDir})`);
  // also answer on ::1 so "localhost" resolving to IPv6 doesn't stall; ignore if IPv6 is unavailable
  createServer(handler).on('error', () => {}).listen(PORT, '::1');
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    store.stopBackups();
    engine.stopAll();
    store.flush();
    try { store.backup('stop'); } catch {} // the last good state, should state.json be damaged before the next start
    if (readFileSync(pidFile, 'utf8') === String(process.pid)) rmSync(pidFile);
  } catch {}
  releaseLock();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
