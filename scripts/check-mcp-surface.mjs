// MCP, CLI and HTTP parity for projects, ticket trees, claims, shared context and status.
// Boots a scratch server unless --url is an existing loopback server other than port 7317.
//   node scripts/check-mcp-surface.mjs
//   node scripts/check-mcp-surface.mjs --url http://127.0.0.1:7411
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const urlArg = process.argv.indexOf('--url');
const external = urlArg >= 0 ? process.argv[urlArg + 1] : '';
if (external) {
  const parsed = new URL(external);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname) || Number(parsed.port) === 7317) {
    throw new Error('use an explicit scratch loopback URL other than port 7317');
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const dataDir = external ? '' : mkdtempSync(join(tmpdir(), 'hud-mcp-surface-'));
if (dataDir) {
  mkdirSync(join(dataDir, 'probes'));
  mkdirSync(join(dataDir, 'views'));
}
const port = external ? new URL(external).port : String(await freePort());
const base = external ? external.replace(/\/$/, '') : `http://127.0.0.1:${port}`;
const scratchEnv = {
  HUD_SCRATCH: '1',
  HUD_PORT: port,
  HUD_URL: base,
  ...(dataDir ? { HUD_DATA: dataDir, HUD_PROBES: join(dataDir, 'probes'), HUD_VIEWS: join(dataDir, 'views') } : {}),
};

let server;
let serverLog = '';
if (!external) {
  server = spawn(process.execPath, [join(root, 'src/server.ts')], {
    cwd: root,
    env: { ...process.env, ...scratchEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
}

const actor = 'mcp-surface-check';
async function req(path, init = {}, session) {
  const headers = { 'x-hud-actor': actor, ...(session ? { 'x-hud-session': session } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) };
  const res = await fetch(new URL(path, base), { ...init, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { res, body };
}
async function ok(path, init, session) {
  const { res, body } = await req(path, init, session);
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} → ${res.status}: ${body?.error || JSON.stringify(body)}`);
  return body;
}

async function waitForHealth() {
  const deadline = Date.now() + 20000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const health = await ok('/api/health');
      if (health?.name === 'hud') return health;
      last = JSON.stringify(health);
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`scratch server did not become healthy (${last})\n${serverLog}`);
}

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin/hud.js'), ...args], {
      cwd: root,
      env: { ...process.env, ...scratchEnv, HUD_ACTOR: 'cli-surface', ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`hud ${args.join(' ')} exited ${code}: ${err || out}`))));
  });
}

class Mcp {
  constructor(extraEnv = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.child = spawn(process.execPath, [join(root, 'src/mcp.ts')], {
      cwd: root,
      env: { ...process.env, ...scratchEnv, HUD_ACTOR: 'mcp-surface', HUD_SESSION: 'mcp-surface', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    });
    this.child.stderr.on('data', (chunk) => (this.stderr += String(chunk)));
    this.child.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP exited (${code ?? signal})${this.stderr ? `: ${this.stderr}` : ''}`));
      }
      this.pending.clear();
    });
  }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async tool(name, arguments_ = {}) {
    const response = await this.request('tools/call', { name, arguments: arguments_ });
    assert(!response.error, `MCP ${name} RPC error: ${JSON.stringify(response.error)}`);
    const text = response.result?.content?.find((part) => part.type === 'text')?.text;
    assert.equal(typeof text, 'string', `MCP ${name} returned no text`);
    assert(!response.result.isError, `MCP ${name} failed: ${text}`);
    return text;
  }
  close() {
    this.lines.close();
    this.child.kill('SIGTERM');
  }
}

function projectId(text) {
  const m = /\(id ([^)]+)\)/.exec(text);
  assert(m, `project id missing from: ${text}`);
  return m[1];
}
function place(forest, id) {
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      if (node.id === id) return { node, depth };
      const hit = walk(node.children ?? [], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(forest.nodes ?? [], 0);
}
function assertLease(lease, session, label) {
  assert.equal(lease.session, session, `${label} session`);
  assert.equal(lease.live, true, `${label} live`);
  assert.equal(lease.sessionLive, true, `${label} sessionLive`);
  assert.equal(typeof lease.expiresAt, 'number', `${label} expiresAt`);
  assert.ok(lease.expiresAt > Date.now(), `${label} expiry is in the future`);
}

// A lease row can report live=false and sessionLive=false before prune releases it. The scratch
// server prunes every few seconds, so this uses a store directly and backdates the record.
async function assertStaleLeaseRow() {
  const { Store } = await import('../src/store.ts');
  const dir = mkdtempSync(join(tmpdir(), 'hud-mcp-stale-'));
  const store = new Store(join(dir, 'state.json'));
  try {
    store.setBoard('main', { autoOrganize: false }, actor);
    const ticket = store.create({ type: 'ticket', title: 'stale lease', status: 'todo' }, actor);
    store.sessionStart({ id: 'ghost', kind: 'agent' }, actor);
    const fresh = store.claim(ticket.id, { session: 'ghost', ttl: 30 }, actor);
    assert.equal(fresh.live, true);
    assert.equal(fresh.sessionLive, true);
    store.claims.get(ticket.id).expiresAt = Date.now() - 1;
    store.liveSessions.get('ghost').lastSeenAt = Date.now() - 90_001;
    const listed = store.claimsList({ board: 'main' });
    assert.equal(listed.items.length, 1);
    assert.equal(typeof listed.now, 'number');
    assert.equal(listed.items[0].live, false, 'an expired lease is live=false until prune');
    assert.equal(listed.items[0].sessionLive, false, 'a silent holder is sessionLive=false');
    const one = store.claimOf(ticket.id);
    assert.equal(one.live, false);
    assert.equal(one.sessionLive, false);
  } finally {
    store.stopBackups();
    rmSync(dir, { recursive: true, force: true });
  }
}

let mcp;
const clients = [];
let boardId;
try {
  const health = await waitForHealth();
  assert.equal(health.name, 'hud');
  assert.notEqual(Number(health.port), 7317, 'refusing the default board port');

  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const n = Math.floor(Math.random() * 90 + 10);
  const keys = { http: `H${n}A`, cli: `C${n}B`, mcp: `M${n}C`, tree: `T${n}D`, renamed: `R${n}E` };
  boardId = (await ok('/api/boards', { method: 'POST', body: { name: `MCP surface ${nonce}` } })).id;

  // create / list / update projects on all three surfaces
  const httpProject = await ok('/api/projects', { method: 'POST', body: { name: `HTTP ${nonce}`, key: keys.http, board: boardId, description: 'from http' } });
  assert.equal(httpProject.key, keys.http);
  assert.equal(httpProject.title, `HTTP ${nonce}`);
  const cliProject = JSON.parse(await cli(['project', 'new', `CLI ${nonce}`, '--key', keys.cli, '--board', boardId, '--json']));
  assert.equal(cliProject.key, keys.cli);
  mcp = new Mcp();
  clients.push(mcp);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'mcp-surface-check' } });
  const tools = (await mcp.request('tools/list')).result.tools.map((t) => t.name);
  for (const name of ['hud_project', 'hud_tree', 'hud_claim', 'hud_context', 'hud_update']) assert.ok(tools.includes(name), `MCP exposes ${name}`);
  const mcpCreated = await mcp.tool('hud_project', { action: 'create', name: `MCP ${nonce}`, key: keys.mcp, board: boardId });
  const mcpProjectId = projectId(mcpCreated);
  assert.match(mcpCreated, new RegExp(`project ${keys.mcp} `));

  const listed = await ok(`/api/projects?board=${encodeURIComponent(boardId)}`);
  for (const key of [keys.http, keys.cli, keys.mcp]) assert.ok(listed.some((g) => g.key === key), `HTTP list has ${key}`);
  const cliList = JSON.parse(await cli(['project', 'list', '--board', boardId, '--json']));
  for (const key of [keys.http, keys.cli, keys.mcp]) assert.ok(cliList.some((g) => g.key === key), `CLI list has ${key}`);
  const mcpList = await mcp.tool('hud_project', { action: 'list', board: boardId });
  for (const key of [keys.http, keys.cli, keys.mcp]) assert.match(mcpList, new RegExp(`\\b${key}\\b`));

  const httpUpdated = await ok(`/api/projects/${encodeURIComponent(cliProject.id)}`, { method: 'PATCH', body: { name: `CLI renamed ${nonce}`, lead: 'ada', board: boardId } });
  assert.equal(httpUpdated.title, `CLI renamed ${nonce}`);
  assert.equal(httpUpdated.lead, 'ada');
  const cliUpdated = JSON.parse(await cli(['project', 'set', mcpProjectId, '--title', `MCP renamed ${nonce}`, '--target', '2026-12-31', '--board', boardId, '--json']));
  assert.equal(cliUpdated.title, `MCP renamed ${nonce}`);
  assert.equal(cliUpdated.target, '2026-12-31');
  const mcpUpdated = await mcp.tool('hud_project', { action: 'update', id: httpProject.id, board: boardId, name: `HTTP renamed ${nonce}`, key: keys.renamed, description: 'renamed by mcp' });
  assert.match(mcpUpdated, new RegExp(`updated project ${keys.renamed} "HTTP renamed ${nonce}"`));
  const empty = await req(`/api/projects/${encodeURIComponent(httpProject.id)}`, { method: 'PATCH', body: { board: boardId } });
  assert.equal(empty.res.status, 400, 'empty project update is rejected');

  // ticket tree: nest, reject a cycle, read, detach, reattach, unlink
  const treeProject = await ok('/api/projects', { method: 'POST', body: { name: `Tree ${nonce}`, key: keys.tree, board: boardId } });
  const parent = await ok('/api/items', { method: 'POST', body: { type: 'ticket', board: boardId, title: `Parent ${nonce}`, project: keys.tree, status: 'todo' } });
  const child = await ok('/api/items', { method: 'POST', body: { type: 'ticket', board: boardId, title: `Child ${nonce}`, project: keys.tree, status: 'todo' } });
  const moved = await ok('/api/tree', { method: 'POST', body: { action: 'move', id: child.ident, parent: parent.ident, project: keys.tree } });
  assert.equal(moved.graph.parent.id, parent.id, 'HTTP move sets the parent');
  const cycle = await req('/api/tree', { method: 'POST', body: { action: 'move', id: parent.id, parent: child.id } });
  assert.equal(cycle.res.status, 400, 'a parent cycle is rejected');
  const forest = await ok(`/api/tree?board=${encodeURIComponent(boardId)}&project=${encodeURIComponent(keys.tree)}`);
  assert.equal(place(forest, child.id)?.depth, 1, 'child is nested');
  const treeText = await mcp.tool('hud_tree', { action: 'get', board: boardId, project: keys.tree });
  assert.match(treeText, new RegExp(`^${parent.ident} \\[todo\\] Parent ${nonce}\\n  ${child.ident} \\[todo\\] Child ${nonce}$`));
  const detached = await mcp.tool('hud_tree', { action: 'detach', id: child.ident });
  assert.match(detached, new RegExp(`detached .*${child.ident}`));
  const flat = await ok(`/api/tree?board=${encodeURIComponent(boardId)}&project=${keys.tree}`);
  assert.equal(place(flat, child.id)?.depth, 0, 'MCP detach lifts the child');
  const reattached = JSON.parse(await cli(['tree', 'move', child.ident, '--parent', parent.ident, '--json']));
  assert.equal(reattached.graph.parent.ident, parent.ident, 'CLI move reattaches');
  const unlinked = JSON.parse(await cli(['unlink', child.ident, 'parent', '--json']));
  assert.equal(unlinked.graph.parent, null, 'CLI unlink clears the parent');
  const afterUnlink = await ok(`/api/tree?board=${encodeURIComponent(boardId)}&project=${keys.tree}`);
  assert.equal(place(afterUnlink, child.id)?.depth, 0);

  // HTTP unlink accepts "" and null as clear. A falsy non-empty sentinel is not a clear.
  await ok('/api/tree', { method: 'POST', body: { action: 'move', id: child.id, parent: parent.id } });
  const ignored = await req(`/api/items/${encodeURIComponent(child.id)}/unlink`, { method: 'POST', body: { parent: false } });
  assert.equal(ignored.res.status, 400, 'parent:false is not a clear');
  assert.equal((await ok(`/api/items/${encodeURIComponent(child.id)}`)).graph.parent.id, parent.id, 'rejected unlink leaves the parent');
  const clearedEmpty = await ok(`/api/items/${encodeURIComponent(child.id)}/unlink`, { method: 'POST', body: { parent: '' } });
  assert.equal(clearedEmpty.graph.parent, null, 'HTTP unlink parent:"" clears the parent');
  assert.equal(clearedEmpty.project, treeProject.id, 'clearing the parent leaves the project');
  await ok('/api/tree', { method: 'POST', body: { action: 'move', id: child.id, parent: parent.id } });
  const clearedNull = await ok(`/api/items/${encodeURIComponent(child.id)}/unlink`, { method: 'POST', body: { parent: null } });
  assert.equal(clearedNull.graph.parent, null, 'HTTP unlink parent:null clears the parent');
  const clearedProject = await ok(`/api/items/${encodeURIComponent(child.id)}/unlink`, { method: 'POST', body: { project: '' } });
  assert.equal(clearedProject.project, undefined, 'HTTP unlink project:"" clears the project');
  assert.equal(clearedProject.graph.parent, null);
  const stillInProject = await ok(`/api/tree?board=${encodeURIComponent(boardId)}&project=${keys.tree}`);
  assert.equal(place(stillInProject, child.id), null, 'a cleared project drops the ticket from that tree');

  // claim, lease visibility, release — one holder at a time, including conflicts and list scope
  assert.equal(await ok(`/api/items/${encodeURIComponent(parent.id)}/claim`), null, 'an unclaimed ticket has no lease');
  assert.match(await mcp.tool('hud_claim', { action: 'list', board: boardId }), /^no active claim for mcp-surface$/);
  assert.equal(await mcp.tool('hud_claim', { action: 'list', all: true, board: boardId }), 'no active claims');
  const httpSession = `http-surface-${nonce}`;
  const peer = `peer-${nonce}`;
  await ok('/api/sessions', { method: 'POST', body: { id: httpSession, kind: 'agent' } });
  await ok('/api/sessions', { method: 'POST', body: { id: peer, kind: 'agent' } });
  const httpClaim = await ok(`/api/items/${encodeURIComponent(parent.ident)}/claim`, { method: 'POST', body: { session: httpSession, ttl: 60 } }, httpSession);
  assertLease(httpClaim, httpSession, 'HTTP claim');
  assertLease(await ok(`/api/items/${encodeURIComponent(parent.id)}/claim`), httpSession, 'HTTP status');
  const httpClaims = await ok(`/api/claims?session=${encodeURIComponent(httpSession)}&board=${encodeURIComponent(boardId)}`);
  assert.equal(httpClaims.items.length, 1);
  assertLease(httpClaims.items[0], httpSession, 'HTTP list');
  const conflict = await req(`/api/items/${encodeURIComponent(parent.id)}/claim`, { method: 'POST', body: { session: peer, ttl: 60 } }, peer);
  assert.equal(conflict.res.status, 409, 'a second session is refused');
  assert.equal(conflict.body.code, 'claimed');
  const wrongRelease = await req(`/api/items/${encodeURIComponent(parent.id)}/claim?session=${encodeURIComponent(peer)}&reason=not-mine`, { method: 'DELETE' }, peer);
  assert.equal(wrongRelease.res.status, 403, 'a non-holder cannot release');
  assertLease(await ok(`/api/items/${encodeURIComponent(parent.id)}/claim`), httpSession, 'refused release leaves the holder');
  await ok(`/api/items/${encodeURIComponent(parent.id)}/claim?session=${encodeURIComponent(httpSession)}&reason=http-done`, { method: 'DELETE' }, httpSession);
  assert.equal(await ok(`/api/items/${encodeURIComponent(parent.id)}/claim`), null, 'HTTP release frees the lease');

  const mcpClaim = await mcp.tool('hud_claim', { action: 'claim', ticket: parent.ident, session: 'mcp-surface', ttl: 60 });
  assert.match(mcpClaim, new RegExp(`${parent.ident} .*claimed by mcp-surface`));
  const mcpStatus = await mcp.tool('hud_claim', { action: 'status', ticket: parent.ident });
  assert.match(mcpStatus, new RegExp(`${parent.ident} claimed by mcp-surface`));
  assert.match(mcpStatus, /live=true/);
  assert.match(mcpStatus, /sessionLive=true/);
  assert.match(mcpStatus, /expiresAt=\d+/);
  const peerClaim = await ok(`/api/items/${encodeURIComponent(child.id)}/claim`, { method: 'POST', body: { session: peer, ttl: 90 } }, peer);
  assertLease(peerClaim, peer, 'peer claim');
  const mcpLeases = await mcp.tool('hud_claim', { action: 'list', board: boardId });
  assert.match(mcpLeases, new RegExp(`^${parent.ident} claimed by mcp-surface`));
  assert.match(mcpLeases, /live=true sessionLive=true/);
  assert.doesNotMatch(mcpLeases, new RegExp(peer), 'list without session stays on this MCP session');
  const namedLeases = await mcp.tool('hud_claim', { action: 'list', session: 'mcp-surface', board: boardId });
  assert.equal(namedLeases, mcpLeases);
  const everyLease = await mcp.tool('hud_claim', { action: 'list', all: true, board: boardId });
  assert.match(everyLease, new RegExp(`${parent.ident} claimed by mcp-surface`));
  assert.match(everyLease, new RegExp(`${peerClaim.ident} claimed by ${peer}`));
  const mixed = await mcp.request('tools/call', { name: 'hud_claim', arguments: { action: 'list', all: true, session: 'mcp-surface', board: boardId } });
  assert.equal(mixed.result.isError, true, 'list rejects session and all together');
  const httpAll = await ok(`/api/claims?board=${encodeURIComponent(boardId)}`);
  assert.equal(typeof httpAll.now, 'number', 'GET /api/claims returns {items, now}');
  assert.deepEqual(httpAll.items.map((c) => c.session).sort(), [peer, 'mcp-surface'].sort(), 'HTTP list without session is every lease');
  const cliDefault = await cli(['claim', 'list', '--board', boardId], { HUD_SESSION: 'cli-surface-check' });
  assert.match(cliDefault, /no active claim for cli-surface-check/);
  assert.doesNotMatch(cliDefault, /claimed by/);
  const cliAll = await cli(['claim', 'list', '--all', '--board', boardId]);
  assert.match(cliAll, new RegExp(`${parent.ident} claimed by mcp-surface`));
  assert.match(cliAll, new RegExp(`${peerClaim.ident} claimed by ${peer}`));
  await assert.rejects(() => cli(['claim', 'list', '--all', '--session', peer, '--board', boardId]), /not both/);

  const parentLine = await mcp.tool('hud_claim', { action: 'status', ticket: parent.ident });
  const oneFooter = '… 1 more omitted (2 total); narrow with session or board';
  const fitBudget = parentLine.length + 1 + oneFooter.length;
  const fitOne = new Mcp({ HUD_SESSION: 'mcp-cap-fit', HUD_CLAIM_LIST_MAX: String(fitBudget) });
  clients.push(fitOne);
  await fitOne.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'mcp-cap-fit' } });
  const fitted = await fitOne.tool('hud_claim', { action: 'list', all: true, board: boardId });
  assert.equal(fitted, `${parentLine}\n${oneFooter}`);
  assert.ok(fitted.length <= fitBudget, 'a kept lease plus the omission line stays inside the budget');
  const fullNote = '… 2 more omitted (2 total); narrow with session or board';
  const exact = new Mcp({ HUD_SESSION: 'mcp-cap-exact', HUD_CLAIM_LIST_MAX: String(fullNote.length) });
  clients.push(exact);
  await exact.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'mcp-cap-exact' } });
  const exactText = await exact.tool('hud_claim', { action: 'list', all: true, board: boardId });
  assert.equal(exactText, fullNote);
  assert.ok(exactText.length <= fullNote.length);
  const tiny = new Mcp({ HUD_SESSION: 'mcp-cap-tiny', HUD_CLAIM_LIST_MAX: '1' });
  clients.push(tiny);
  await tiny.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'mcp-cap-tiny' } });
  const omitted = await tiny.tool('hud_claim', { action: 'list', all: true, board: boardId });
  assert.equal(omitted.length, 1, 'the omission line is clamped to the budget');
  assert.equal(omitted, fullNote.slice(0, 1));
  assert.doesNotMatch(omitted, /claimed by/, 'a truncated list does not cut a lease line');

  const mcpReleased = await mcp.tool('hud_claim', { action: 'release', ticket: parent.ident, session: 'mcp-surface', reason: 'mcp-done' });
  assert.match(mcpReleased, new RegExp(`released ${parent.ident} \\(mcp-done\\)`));
  assert.match(await mcp.tool('hud_claim', { action: 'status', ticket: parent.id }), /is not claimed/);
  await ok(`/api/items/${encodeURIComponent(child.id)}/claim?session=${encodeURIComponent(peer)}&reason=peer-done`, { method: 'DELETE' }, peer);

  const cliSession = `cli-surface-${nonce}`;
  const cliClaim = JSON.parse(await cli(['claim', parent.ident, '--session', cliSession, '--ttl', '60', '--json']));
  assertLease(cliClaim, cliSession, 'CLI claim');
  const cliStatus = JSON.parse(await cli(['claim', 'status', parent.ident, '--json']));
  assertLease(cliStatus, cliSession, 'CLI status');
  const cliLeases = JSON.parse(await cli(['claim', 'list', '--session', cliSession, '--board', boardId, '--json']));
  assert.equal(cliLeases.items.length, 1);
  assertLease(cliLeases.items[0], cliSession, 'CLI list');
  const renewed = JSON.parse(await cli(['claim', 'renew', parent.ident, '--session', cliSession, '--ttl', '90', '--json']));
  assertLease(renewed, cliSession, 'CLI renew');
  assert.ok(renewed.expiresAt >= cliClaim.expiresAt, 'renew extends the lease');
  await cli(['release', parent.ident, '--session', cliSession, '--reason', 'cli-done', '--json']);
  assert.equal(JSON.parse(await cli(['claim', 'status', parent.id, '--json'])), null, 'CLI release frees the lease');
  const gone = await ok(`/api/claims?board=${encodeURIComponent(boardId)}`);
  assert.equal(gone.items.some((c) => c.ticket === parent.id), false, 'no lease remains on the board');
  assert.equal(typeof gone.now, 'number');

  // 9→10 makes note(10) one character longer than note(9). Budget note(9) and require the result to fit.
  const capHint = 'narrow with session or board';
  const capNote = (omitted, total) => `… ${omitted} more omitted (${total} total); ${capHint}`;
  const capTotal = 10;
  const capRows = [];
  for (let i = 0; i < capTotal; i++) {
    const ticket = await ok('/api/items', { method: 'POST', body: { type: 'ticket', board: boardId, title: `Cap ${nonce} ${i}`, status: 'todo' } });
    const session = `cap-${nonce}-${i}`;
    await ok('/api/sessions', { method: 'POST', body: { id: session, kind: 'agent' } });
    await ok(`/api/items/${encodeURIComponent(ticket.id)}/claim`, { method: 'POST', body: { session, ttl: 60 } }, session);
    capRows.push({ id: ticket.id, session });
  }
  const digitBudget = capNote(capTotal - 1, capTotal).length;
  const digit = new Mcp({ HUD_SESSION: 'mcp-cap-digit', HUD_CLAIM_LIST_MAX: String(digitBudget) });
  clients.push(digit);
  await digit.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'mcp-cap-digit' } });
  const digitText = await digit.tool('hud_claim', { action: 'list', all: true, board: boardId });
  const digitFull = capNote(capTotal, capTotal);
  assert.equal(digitFull.length, digitBudget + 1, 'the 9→10 footer is one character over note(9)');
  assert.ok(digitText.length <= digitBudget, 'omit-everything stays inside the budget across a digit boundary');
  assert.equal(digitText, digitFull.slice(0, digitBudget));
  assert.doesNotMatch(digitText, /claimed by/);
  for (const row of capRows) {
    await ok(`/api/items/${encodeURIComponent(row.id)}/claim?session=${encodeURIComponent(row.session)}&reason=cap-done`, { method: 'DELETE' }, row.session);
  }

  await assertStaleLeaseRow();

  // shared context publish
  const scope = `project:${treeProject.id}`;
  const httpFact = await ok('/api/context', { method: 'POST', body: { scope, kind: 'FACT', text: `http finding ${nonce}`, session: httpSession } }, httpSession);
  assert.equal(httpFact.kind, 'FACT');
  const cliFact = JSON.parse(await cli(['context', 'publish', '--scope', scope, '--kind', 'FACT', '--text', `cli finding ${nonce}`, '--session', cliSession, '--json']));
  assert.equal(cliFact.text, `cli finding ${nonce}`);
  const mcpFact = await mcp.tool('hud_context', { action: 'publish', scope, kind: 'STATUS', text: `mcp finding ${nonce}`, session: 'mcp-surface' });
  assert.match(mcpFact, new RegExp(`published STATUS #\\d+ ${scope}`));
  const read = await ok(`/api/context?scope=${encodeURIComponent(scope)}&since=0`);
  const texts = read.entries.map((e) => e.text);
  assert.ok(texts.includes(`http finding ${nonce}`));
  assert.ok(texts.includes(`cli finding ${nonce}`));
  assert.ok(texts.includes(`mcp finding ${nonce}`));
  const cliRead = JSON.parse(await cli(['context', 'read', '--scope', scope, '--since', '0', '--peek', '--json']));
  assert.deepEqual(cliRead.entries.map((e) => e.text), texts);
  const mcpRead = await mcp.tool('hud_context', { action: 'read', scope, since: 0, mark: false, session: 'mcp-surface' });
  for (const text of texts) assert.match(mcpRead, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // status updates
  const doing = await ok(`/api/items/${encodeURIComponent(parent.ident)}`, { method: 'PATCH', body: { status: 'doing' } });
  assert.equal(doing.status, 'doing');
  await mcp.tool('hud_update', { id: parent.ident, status: 'review' });
  assert.equal((await ok(`/api/items/${encodeURIComponent(parent.id)}`)).status, 'review');
  const done = JSON.parse(await cli(['set', parent.ident, 'done', '--json']));
  assert.equal(done.status, 'done');
  assert.equal((await ok(`/api/items/${encodeURIComponent(child.id)}`)).status, 'todo', 'status update stays on the named ticket');

  await ok(`/api/boards/${encodeURIComponent(boardId)}`, { method: 'DELETE' });
  boardId = undefined;
  console.log('PASS mcp surface: projects, trees, claims, context, status');
} catch (e) {
  console.error(`FAIL mcp surface: ${e?.stack || e}`);
  if (serverLog) console.error(serverLog.slice(-4000));
  process.exitCode = 1;
} finally {
  if (boardId) await ok(`/api/boards/${encodeURIComponent(boardId)}`, { method: 'DELETE' }).catch(() => {});
  for (const client of clients) client.close();
  if (server) {
    await req('/api/shutdown', { method: 'POST' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    if (server.exitCode === null) server.kill('SIGTERM');
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
