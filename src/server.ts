import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Engine } from './engine.ts';
import { HudError, STATE_VERSION, Store } from './store.ts';
import { acquireLock } from './lock.ts';
import { summarize, ticketsView } from './summary.ts';
import type { Alert, HudEvent, Item, SearchQuery } from './types.ts';
import { spawn } from 'node:child_process';
import { asset, assetKeys, isPackaged } from './assets.ts';
import { ROOT, config } from './config.ts';
import { publicState, registerMonitoring } from './monitoring-server.ts';

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

/** the renderer modules on offer, newest mtime first — also what GET /api/views reports */
function listViews(): { name: string; mtime: number; bytes: number }[] {
  try {
    return readdirSync(viewsDir)
      .filter((n) => /^[\w][\w.-]*\.js$/.test(n))
      .map((n) => {
        const st = statSync(join(viewsDir, n));
        return { name: n, mtime: st.mtimeMs, bytes: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
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
store.on('event', (e: HudEvent) => {
  try {
    const out = e.kind === 'item' ? { ...e, item: Store.lite(e.item) } : e.kind === 'board' ? { ...e, board: Store.boardLite(e.board) } : e;
    broadcast(`data: ${JSON.stringify(out)}\n\n`);
    if (e.kind === 'alert') runAlertHook(e.alert);
  } catch (err) {
    console.error('[hud] event handler:', err);
  }
});
setInterval(() => {
  try {
    store.checkStale();
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

function guide() {
  return `${asset('GUIDE.md', 'utf8') ?? ''}\n\n${asset('STYLE.md', 'utf8') ?? ''}`.replaceAll('{{PORT}}', String(PORT));
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
  return {
    id: t.id,
    ident: store.ident(t),
    title: t.title,
    status: t.status ?? 'todo',
    priority: t.priority ?? null,
    assignee: t.assignee ?? null,
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
route('GET', '/api/guide', (_q, res) => send(res, 200, guide(), 'text/markdown; charset=utf-8'));
route('GET', '/api/views', () => ({ dir: viewsDir, views: listViews() }));
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

route('GET', '/api/items', (_r, _s, _m, q) => store.items(queryOf(q)).map(Store.lite));
route('POST', '/api/items', async (req) => {
  const b = await readBody(req);
  const actor = actorOf(req, b);
  if (Array.isArray(b)) {
    if (b.some((x) => !isObj(x))) throw new HudError(400, 'expected an array of item objects');
    return b.map((x) => withGraph(store.create(x, actor)));
  }
  if (!isObj(b)) throw new HudError(400, 'body must be a JSON object');
  return withGraph(store.create(b, actor));
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
  for (const k of ['project', 'parent', 'blockedBy', 'refs']) if (b[k]) clear[k] = [];
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
  const r = store.finish({ board: b.board, ids: strList(b.ids, 'ids').map((x) => store.resolveId(x)), note: b.note, organize: b.organize }, actorOf(req, b));
  // report idents so the CLI/MCP messages read the same as everywhere else
  return { ...r, done: r.done.map((x: string) => store.identOf(store.resolveId(x))) };
});
route('POST', '/api/monitors/:id/push', async (req, _s, [id], q) => {
  const b = await readObj(req);
  return Store.lite(store.push(rid(id, q), b, actorOf(req, b)));
});
route('POST', '/api/monitors/:id/run', async (_r, _s, [id], q) => {
  const mid = rid(id, q);
  await engine.runNow(mid).catch((e) => {
    throw new HudError(400, e.message);
  });
  return Store.lite(store.get(mid));
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
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : uri ? 'malformed URL encoding' : (e as Error).message });
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
