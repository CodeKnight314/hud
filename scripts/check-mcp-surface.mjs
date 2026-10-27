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
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.child = spawn(process.execPath, [join(root, 'src/mcp.ts')], {
      cwd: root,
      env: { ...process.env, ...scratchEnv, HUD_ACTOR: 'mcp-surface', HUD_SESSION: 'mcp-surface' },
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

let mcp;
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

  // claim, lease visibility, release — one holder at a time
  assert.equal(await ok(`/api/items/${encodeURIComponent(parent.id)}/claim`), null, 'an unclaimed ticket has no lease');
  const httpSession = `http-surface-${nonce}`;
  await ok('/api/sessions', { method: 'POST', body: { id: httpSession, kind: 'agent' } });
  const httpClaim = await ok(`/api/items/${encodeURIComponent(parent.ident)}/claim`, { method: 'POST', body: { session: httpSession, ttl: 60 } }, httpSession);
  assertLease(httpClaim, httpSession, 'HTTP claim');
  assertLease(await ok(`/api/items/${encodeURIComponent(parent.id)}/claim`), httpSession, 'HTTP status');
  const httpClaims = await ok(`/api/claims?session=${encodeURIComponent(httpSession)}&board=${encodeURIComponent(boardId)}`);
  assert.equal(httpClaims.items.length, 1);
  assertLease(httpClaims.items[0], httpSession, 'HTTP list');
  await ok(`/api/items/${encodeURIComponent(parent.id)}/claim?session=${encodeURIComponent(httpSession)}&reason=http-done`, { method: 'DELETE' }, httpSession);
  assert.equal(await ok(`/api/items/${encodeURIComponent(parent.id)}/claim`), null, 'HTTP release frees the lease');

  const mcpClaim = await mcp.tool('hud_claim', { action: 'claim', ticket: parent.ident, session: 'mcp-surface', ttl: 60 });
  assert.match(mcpClaim, new RegExp(`${parent.ident} .*claimed by mcp-surface`));
  const mcpStatus = await mcp.tool('hud_claim', { action: 'status', ticket: parent.ident });
  assert.match(mcpStatus, new RegExp(`${parent.ident} claimed by mcp-surface`));
  assert.match(mcpStatus, /live=true/);
  assert.match(mcpStatus, /sessionLive=true/);
  assert.match(mcpStatus, /expiresAt=\d+/);
  const mcpLeases = await mcp.tool('hud_claim', { action: 'list', board: boardId });
  assert.match(mcpLeases, new RegExp(`${parent.ident} claimed by mcp-surface`));
  assert.match(mcpLeases, /live=true sessionLive=true/);
  const mcpReleased = await mcp.tool('hud_claim', { action: 'release', ticket: parent.ident, session: 'mcp-surface', reason: 'mcp-done' });
  assert.match(mcpReleased, new RegExp(`released ${parent.ident} \\(mcp-done\\)`));
  assert.match(await mcp.tool('hud_claim', { action: 'status', ticket: parent.id }), /is not claimed/);

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
  mcp?.close();
  if (server) {
    await req('/api/shutdown', { method: 'POST' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    if (server.exitCode === null) server.kill('SIGTERM');
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
