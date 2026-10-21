// HTTP/MCP/CLI parity for the coordination layer. Runs against an existing scratch server.
//   node scripts/check-coordination-api.mjs --url http://127.0.0.1:7411
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const urlArg = process.argv.indexOf('--url');
const base = new URL(urlArg >= 0 ? process.argv[urlArg + 1] : 'http://127.0.0.1:7411');
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(base.hostname) || Number(base.port) === 7317) throw new Error('use an explicit scratch loopback URL other than port 7317');

async function req(path, init = {}, session) {
  const headers = { 'x-hud-actor': 'api-coordination-check', ...(session ? { 'x-hud-session': session } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin/hud.js'), ...args], {
      cwd: root,
      env: { ...process.env, HUD_SCRATCH: '1', HUD_PORT: base.port, HUD_URL: base.origin, ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`hud ${args.join(' ')} exited ${code}: ${err || out}`))));
  });
}

async function mcpTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'src/mcp.ts')], { cwd: root, env: { ...process.env, HUD_SCRATCH: '1', HUD_PORT: base.port, HUD_URL: base.origin } });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const lines = out.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) {
            child.kill();
            resolve(msg.result.tools.map((t) => t.name));
            return;
          }
        } catch {}
      }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'coordination-api-check' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    setTimeout(() => { child.kill(); reject(new Error('MCP tools/list timed out')); }, 15000).unref();
  });
}

const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
let board;
try {
  board = await ok('/api/boards', { method: 'POST', body: { name: `API coordination ${nonce}` } });
  const boardId = board.id;
  const t1 = await ok('/api/items', { method: 'POST', body: { id: `api-${nonce}-a`, type: 'ticket', board: boardId, title: `First ${nonce}`, status: 'todo' } });
  const t2 = await ok('/api/items', { method: 'POST', body: { id: `api-${nonce}-b`, type: 'ticket', board: boardId, title: `Second ${nonce}`, status: 'todo', blockedBy: [t1.id] } });
  const run = await ok('/api/items', { method: 'POST', body: { id: `api-${nonce}-run`, type: 'ticket', board: boardId, title: `Run ${nonce}`, status: 'todo', tags: ['run'] } });

  // sessions
  const s = await ok('/api/sessions', { method: 'POST', body: { id: `api-check-${nonce}`, kind: 'agent', actor: 'api-check' } });
  assert.equal(s.live, true, 'session is live');
  const hb = await ok(`/api/sessions/${encodeURIComponent(s.id)}/heartbeat`, { method: 'POST' });
  assert.equal(hb.session.live, true, 'heartbeat keeps the session live');

  // claims
  const c1 = await ok(`/api/items/${encodeURIComponent(t1.id)}/claim`, { method: 'POST', body: { session: s.id, start: true } }, s.id);
  assert.equal(c1.session, s.id, 'first claim wins');
  assert.equal((await ok(`/api/items/${encodeURIComponent(t1.id)}`)).status, 'doing', 'start moves the ticket to doing');
  const conflict = await req(`/api/items/${encodeURIComponent(t1.id)}/claim`, { method: 'POST', body: { session: `other-${nonce}` } });
  assert.equal(conflict.res.status, 409, 'second claim conflicts');
  assert.equal(conflict.body.code, 'claimed', 'conflict carries a code');

  // queue
  const q = await ok(`/api/queue?board=${encodeURIComponent(boardId)}`);
  assert.equal(q.counts.open, 2, `queue open: ${JSON.stringify(q.counts)}`);
  assert.equal(q.counts.claimed, 1, 'queue shows the claim');
  assert.equal(q.items.find((r) => r.id === t2.id)?.blocked, true, 'blocked ticket is marked');
  assert.equal(q.items.find((r) => r.id === t1.id)?.owner, 'api-check', 'owner comes from the claim');

  // shared context: publish, delta, correction
  const fact = await ok('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'FACT', text: 'first finding', session: s.id } }, s.id);
  const delta = await ok(`/api/context?scope=${encodeURIComponent(`run:${run.id}`)}&since=0`);
  assert.equal(delta.entries.length, 1, 'delta read returns the finding');
  const fix = await ok('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'FAIL', text: 'first finding was wrong', corrects: fact.id } }, s.id);
  const after = await ok(`/api/context?scope=${encodeURIComponent(`run:${run.id}`)}&since=${fact.seq}`);
  assert.deepEqual(after.entries.map((e) => e.id), [fix.id], 'delta read returns only newer entries');
  assert.equal(after.entries[0].corrects, fact.id, 'correction points at the earlier entry');

  // attachments
  const a1 = await ok('/api/attachments', { method: 'POST', body: { board: boardId, scope: `run:${run.id}`, name: 'notes.txt', kind: 'text', contentBase64: Buffer.from('alpha\nbeta\n').toString('base64') } }, s.id);
  assert.equal(await ok(`/api/attachments/${a1.id}/content?format=text`), 'alpha\nbeta\n', 'attachment content round-trips');
  const a2 = await ok('/api/attachments', { method: 'POST', body: { board: boardId, scope: `run:${run.id}`, name: 'notes.txt', kind: 'text', baseId: a1.id, baseSha256: a1.sha256, contentBase64: Buffer.from('alpha\nBETA\n').toString('base64') } }, s.id);
  const diff = await ok(`/api/attachments/${a2.id}/expand`);
  assert.match(diff.text, /-beta/, 'expand shows the removed line');
  assert.match(diff.text, /\+BETA/, 'expand shows the added line');

  // wait: publish from another session after the waiter is registered
  const waiting = req('/api/wait', { method: 'POST', body: { session: s.id, scope: `run:${run.id}`, since: after.cursor, timeoutSeconds: 10 } }, s.id);
  await sleep(300);
  await ok('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'SUMMARY', text: 'peer woke you', session: `peer-${nonce}` } }, `peer-${nonce}`);
  const woke = await waiting;
  assert.equal(woke.res.status, 200, 'wait responds');
  assert.equal(woke.body.woke, true, 'wait wakes on a peer publish');
  assert.equal(woke.body.reason, 'context', 'wait reports the reason');
  const timeout = await ok('/api/wait', { method: 'POST', body: { session: s.id, ticket: run.id, timeoutSeconds: 1 } }, s.id);
  assert.equal(timeout.timeout, true, 'wait times out cleanly');

  // state never carries context/attachments/sessions
  const state = await ok(`/api/state?board=${encodeURIComponent(boardId)}`);
  assert.equal(state.context, undefined, '/api/state has no context');
  assert.equal(state.attachments, undefined, '/api/state has no attachments');
  assert.equal(state.sessions, undefined, '/api/state has no sessions');

  // MCP parity
  const tools = await mcpTools();
  for (const name of ['hud_session', 'hud_claim', 'hud_queue', 'hud_context', 'hud_attach', 'hud_wait', 'hud_view']) assert.ok(tools.includes(name), `MCP exposes ${name}`);

  // CLI parity
  const queueOut = JSON.parse(await cli(['queue', boardId, '--json'], { HUD_SESSION: s.id }));
  assert.equal(queueOut.board, boardId, 'CLI queue reads the same board');
  const cliSession = `api-cli-${nonce}`;
  const claimOut = JSON.parse(await cli(['claim', t2.id, '--session', cliSession, '--json']));
  assert.equal(claimOut.session, cliSession, 'CLI claims through the same route');

  // cleanup
  await ok(`/api/attachments/${a1.id}?force=1`, { method: 'DELETE' });
  await ok(`/api/attachments/${a2.id}?force=1`, { method: 'DELETE' });
  await ok(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
  await ok(`/api/boards/${encodeURIComponent(boardId)}`, { method: 'DELETE' });
  console.log('PASS coordination HTTP/MCP/CLI parity');
} catch (e) {
  if (board) await ok(`/api/boards/${encodeURIComponent(board.id)}`, { method: 'DELETE' }).catch(() => {});
  console.error(`FAIL coordination API: ${e?.stack || e}`);
  process.exit(1);
}
