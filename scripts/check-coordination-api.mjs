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

function mcpText(tool, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'src/mcp.ts')], {
      cwd: root,
      env: { ...process.env, HUD_SCRATCH: '1', HUD_PORT: base.port, HUD_URL: base.origin, HUD_ACTOR: 'api-coordination-check' },
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP ${tool} timed out`)); }, 30000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          if (msg.id !== 2) continue;
          clearTimeout(timer);
          child.kill();
          const text = msg.result?.content?.[0]?.text ?? '';
          if (msg.result?.isError) reject(new Error(text));
          else resolve(text);
        } catch {}
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'coordination-api-check' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
  });
}

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

function mcpRpc(messages, pick) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'src/mcp.ts')], { cwd: root, env: { ...process.env, HUD_SCRATCH: '1', HUD_PORT: base.port, HUD_URL: base.origin, HUD_ACTOR: 'api-coordination-check' } });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timed out')); }, 20000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          const hit = pick(msg);
          if (hit !== undefined) {
            clearTimeout(timer);
            child.kill();
            resolve(hit);
            return;
          }
        } catch {}
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    for (const message of messages) child.stdin.write(JSON.stringify(message) + '\n');
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

  // multi-project ownership: switch the list by project and owner, and show assignee plus claimer
  const eng = await ok('/api/items', { method: 'POST', body: { type: 'project', board: boardId, title: `Eng ${nonce}`, key: 'ENG' } });
  await ok('/api/items', { method: 'POST', body: { type: 'project', board: boardId, title: `Hud ${nonce}`, key: 'HUD' } });
  const alpha = await ok('/api/items', { method: 'POST', body: { type: 'ticket', board: boardId, title: `Alpha ${nonce}`, project: eng.id, assignee: 'alice' } });
  const beta = await ok('/api/items', { method: 'POST', body: { type: 'ticket', board: boardId, title: `Beta ${nonce}`, project: 'ENG' } });
  const gamma = await ok('/api/items', { method: 'POST', body: { type: 'ticket', board: boardId, title: `Gamma ${nonce}`, project: 'HUD', assignee: 'alice' } });
  await ok(`/api/items/${encodeURIComponent(beta.id)}/claim`, { method: 'POST', body: { session: `owner-${nonce}` } });
  const owned = await ok(`/api/tickets?board=${encodeURIComponent(boardId)}&project=ENG&owner=alice`);
  assert.equal(owned.groups.length, 1, 'project filter keeps one group');
  assert.deepEqual(owned.groups[0].tickets.map((t) => t.id), [alpha.id], 'owner filter keeps the assignee when unclaimed');
  assert.equal(owned.groups[0].tickets[0].claimer, null);
  assert.equal(owned.groups[0].tickets[0].owner, 'alice');
  const tree = await ok(`/api/tickets?board=${encodeURIComponent(boardId)}&project=ENG&format=text`);
  assert.match(tree, new RegExp(`Alpha ${nonce} →alice ⊕—`));
  assert.match(tree, new RegExp(`Beta ${nonce} →— ⊕api-coordination-check`));
  assert.doesNotMatch(tree, new RegExp(`Gamma ${nonce}`));
  const claims = await ok(`/api/claims?board=${encodeURIComponent(boardId)}`);
  assert.equal(typeof claims.now, 'number', 'claims list shares the { items, now } shape');
  assert.ok(claims.items.some((c) => c.ticket === beta.id && c.actor === 'api-coordination-check'), 'claims list names the claimer');
  const sessionClaims = await ok(`/api/claims?board=${encodeURIComponent(boardId)}&session=${encodeURIComponent(`owner-${nonce}`)}`);
  assert.ok(sessionClaims.items.some((c) => c.ticket === beta.id), 'session filter keeps that holder');
  assert.ok(sessionClaims.items.every((c) => c.session === `owner-${nonce}`), 'session filter drops other holders');
  const queued = await ok(`/api/queue?board=${encodeURIComponent(boardId)}&project=HUD&owner=alice&includeDone=1`);
  assert.deepEqual(queued.items.map((t) => t.id), [gamma.id], 'queue filters by project and owner');
  const cliTree = await cli(['tickets', boardId, '--project', 'ENG', '--owner', 'alice']);
  assert.match(cliTree, new RegExp(`Alpha ${nonce}`));
  assert.doesNotMatch(cliTree, new RegExp(`Beta ${nonce}`));
  const ticketTool = await mcpRpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'coordination-api-check' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], (msg) => (msg.id === 2 ? msg.result.tools : undefined));
  for (const name of ['hud_tickets', 'hud_search', 'hud_queue']) {
    const tool = ticketTool.find((t) => t.name === name);
    assert.ok(tool?.inputSchema?.properties?.project, `${name} filters by project`);
    assert.ok(tool?.inputSchema?.properties?.owner, `${name} filters by owner`);
  }
  const mcpText = await mcpRpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'coordination-api-check' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hud_tickets', arguments: { board: boardId, project: 'ENG', owner: 'claude' } } },
  ], (msg) => (msg.id === 3 ? msg.result : undefined));
  assert.equal(mcpText.isError, undefined, JSON.stringify(mcpText));
  const mcpBody = mcpText.content.map((c) => c.text).join('\n');
  assert.match(mcpBody, /no matching tickets/, 'MCP owner filter does not treat the claimer as someone else');
  const mcpAlice = await mcpRpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'coordination-api-check' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hud_tickets', arguments: { board: boardId, project: 'HUD', owner: 'alice' } } },
  ], (msg) => (msg.id === 3 ? msg.result : undefined));
  const aliceBody = mcpAlice.content.map((c) => c.text).join('\n');
  assert.match(aliceBody, new RegExp(`Gamma ${nonce} →alice ⊕—`));
  assert.doesNotMatch(aliceBody, new RegExp(`Alpha ${nonce}|Beta ${nonce}`));
  const mcpSearch = await mcpRpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'coordination-api-check' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hud_search', arguments: { board: boardId, type: 'ticket', project: 'HUD', owner: 'alice' } } },
  ], (msg) => (msg.id === 3 ? msg.result : undefined));
  assert.equal(mcpSearch.isError, undefined, JSON.stringify(mcpSearch));
  const searchBody = mcpSearch.content.map((c) => c.text).join('\n');
  assert.match(searchBody, new RegExp(`Gamma ${nonce}`));
  assert.doesNotMatch(searchBody, new RegExp(`Alpha ${nonce}|Beta ${nonce}`));
  const mcpQueue = await mcpRpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'coordination-api-check' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hud_queue', arguments: { board: boardId, project: 'ENG', owner: 'alice' } } },
  ], (msg) => (msg.id === 3 ? msg.result : undefined));
  assert.equal(mcpQueue.isError, undefined, JSON.stringify(mcpQueue));
  const queueBody = mcpQueue.content.map((c) => c.text).join('\n');
  assert.match(queueBody, new RegExp(`Alpha ${nonce}`));
  assert.match(queueBody, /\| alice \|/);
  assert.doesNotMatch(queueBody, new RegExp(`Beta ${nonce}|Gamma ${nonce}`));
  const mcpNone = await mcpRpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'coordination-api-check' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hud_search', arguments: { board: boardId, type: 'ticket', project: 'ENG', owner: 'none' } } },
  ], (msg) => (msg.id === 3 ? msg.result : undefined));
  const noneBody = mcpNone.content.map((c) => c.text).join('\n');
  assert.match(noneBody, /no matches/);

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

  // finished-run context export: refused until the run is done, then zip + markdown on every surface
  const early = await req(`/api/runs/${encodeURIComponent(run.id)}/export`, { method: 'POST' });
  assert.equal(early.res.status, 409, 'unfinished run is not exported');
  assert.equal(early.body.code, 'unfinished', 'unfinished export carries a code');
  const finished = await ok('/api/finish', { method: 'POST', body: { ids: [run.id], export: true, organize: false } });
  assert.equal(finished.exports?.length, 1, 'finish snapshots the run');
  const exp = finished.exports[0];
  const md = await ok(`/api/runs/${encodeURIComponent(run.id)}/exports/${encodeURIComponent(exp.name)}?format=markdown`);
  assert.match(String(md), /first finding/, 'markdown export contains the run context');
  assert.match(String(md), /peer woke you/, 'markdown export keeps later entries');
  const zipRes = await fetch(new URL(`/api/runs/${encodeURIComponent(run.id)}/exports/${encodeURIComponent(exp.name)}`, base), { headers: { 'x-hud-actor': 'api-coordination-check' } });
  assert.equal(zipRes.status, 200, 'zip download');
  assert.match(zipRes.headers.get('content-type') || '', /zip/);
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  assert.equal(zipBuf.subarray(0, 2).toString(), 'PK', 'download is a zip');
  assert.ok(zipBuf.includes(Buffer.from('alpha\nbeta\n')), 'zip keeps attachment bytes');
  const listed = await ok(`/api/runs/${encodeURIComponent(run.id)}/exports`);
  assert.ok(listed.some((row) => row.name === exp.name), 'export is listed');
  const all = await ok('/api/runs/exports');
  assert.ok(all.some((row) => row.name === exp.name), 'global export list includes the snapshot');
  const escaped = await req(`/api/runs/${encodeURIComponent(run.id)}/exports/${encodeURIComponent('../state.json')}`);
  assert.equal(escaped.res.status, 400, 'export names cannot escape backups');
  const cliExport = JSON.parse(await cli(['context', 'export', run.id, '--json']));
  assert.equal(cliExport.runId, run.id, 'CLI exports the finished run');
  const cliList = JSON.parse(await cli(['context', 'exports', run.id, '--json']));
  assert.ok(cliList.some((row) => row.name === cliExport.name), 'CLI lists the snapshot');
  const mcpExport = await mcpText('hud_context', { action: 'export', scope: `run:${run.id}` });
  assert.match(mcpExport, /exported .+backups\/context-/, 'MCP exports the finished run');

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
