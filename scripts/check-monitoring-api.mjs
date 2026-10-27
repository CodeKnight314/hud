import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACTOR = 'monitoring-api-check';
const MCP_ACTOR = 'monitoring-api-mcp';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function usage() {
  console.error('usage: node scripts/check-monitoring-api.mjs --url http://127.0.0.1:<scratch-port> [--render]');
}

function parseArgs(argv) {
  let rawUrl;
  let render = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      return null;
    }
    if (arg === '--render') {
      render = true;
      continue;
    }
    if (arg === '--url') {
      rawUrl = argv[++i];
      if (!rawUrl) throw new Error('--url needs a value');
      continue;
    }
    if (arg.startsWith('--url=')) {
      rawUrl = arg.slice('--url='.length);
      if (!rawUrl) throw new Error('--url needs a value');
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (!rawUrl) throw new Error('--url is required; point this check at an existing scratch server');
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || 0);
  if (url.protocol !== 'http:' || !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(host) || !url.port || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 7317) {
    throw new Error('URL must be an explicit loopback HTTP scratch port other than 7317');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('URL must not contain credentials, query, or fragment');
  url.pathname = '/';
  return { base: url, port, render };
}

function assertScratchDataDir(value) {
  assert.equal(typeof value, 'string', '/api/health must report the target dataDir');
  const target = resolve(value);
  const roots = [tmpdir(), '/tmp', '/private/tmp'].map(root => resolve(root));
  const scratch = roots.some((root) => {
    const rel = relative(root, target);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
  assert(scratch, `refusing non-scratch dataDir: ${target}`);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  usage();
  console.error(`FAIL: ${error.message}`);
  process.exit(2);
}
if (!options) process.exit(0);
const { base, port, render } = options;

let childEnv;
let scratchWork;
let serverVerified = false;
const boards = [];
const sessions = [];
let mcp;

function decodeBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function rawRequest(path, { method = 'GET', body, actor = ACTOR } = {}) {
  const headers = { accept: 'application/json', 'x-hud-actor': encodeURIComponent(actor) };
  const init = { method, headers, signal: AbortSignal.timeout(90_000) };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(path, base), init);
  const text = await response.text();
  return { status: response.status, body: decodeBody(text), text };
}

async function request(path, options = {}) {
  const response = await rawRequest(path, options);
  assert(response.status >= 200 && response.status < 300, `${options.method || 'GET'} ${path} → ${response.status}: ${response.text.slice(0, 600)}`);
  return response.body;
}

async function expectStatus(path, status, options = {}) {
  const response = await rawRequest(path, options);
  assert.equal(response.status, status, `${options.method || 'GET'} ${path} expected ${status}, got ${response.status}: ${response.text.slice(0, 600)}`);
  return response.body;
}

function cli(args, actor = ACTOR) {
  const result = spawnSync(process.execPath, [join(ROOT, 'bin/hud.js'), ...args], {
    cwd: ROOT,
    env: { ...childEnv, HUD_ACTOR: actor },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `CLI ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function cliJson(args, actor = ACTOR) {
  const output = cli([...args, '--json'], actor);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`CLI ${args.join(' ')} did not return JSON: ${output}\n${error.message}`);
  }
}

class McpClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.child = spawn(process.execPath, [join(ROOT, 'src/mcp.ts')], {
      cwd: ROOT,
      env: { ...childEnv, HUD_ACTOR: MCP_ACTOR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
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
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, 60_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async toolResult(name, arguments_ = {}) {
    const response = await this.request('tools/call', { name, arguments: arguments_ });
    assert(!response.error, `MCP ${name} returned RPC error: ${JSON.stringify(response.error)}`);
    const result = response.result;
    assert(result && Array.isArray(result.content), `MCP ${name} returned no content`);
    const text = result.content.find((part) => part.type === 'text')?.text;
    assert.equal(typeof text, 'string', `MCP ${name} returned no text content`);
    assert(!result.isError, `MCP ${name} failed: ${text}`);
    return result;
  }

  async tool(name, arguments_ = {}) {
    const result = await this.toolResult(name, arguments_);
    return result.content.find((part) => part.type === 'text').text;
  }

  async close() {
    this.lines.close();
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      await Promise.race([once(this.child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))]);
    }
  }
}

function rowById(items, id, label = 'readout') {
  const row = items.find((item) => item.id === id);
  assert(row, `${label} is missing item ${id}`);
  return row;
}

function assertPng(image, label) {
  assert.equal(image?.mimeType, 'image/png', `${label} must contain image/png`);
  assert.equal(typeof image.data, 'string', `${label} must include untruncated base64 data`);
  const bytes = Buffer.from(image.data, 'base64');
  assert(bytes.length > 100, `${label} image payload is unexpectedly small`);
  assert(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${label} does not contain PNG bytes`);
}

function dashboardSpec(inputAt) {
  const metric = (value, definition) => ({
    type: 'monitor',
    source: { kind: 'push' },
    value,
    metric: { kind: 'rate', key: 'requests', scope: 'cluster-a', unit: 'req/s', windowSeconds: 60, definition, source: 'synthetic api fixture' },
    observedAt: inputAt,
    evidence: 'reported',
  });
  return {
    rows: [{ key: 'measurements', cards: [
      { key: 'input', span: 3, item: { ...metric(12, 'Requests accepted per second.'), title: 'API input rate' } },
      { key: 'output', span: 3, item: { ...metric(10, 'Requests completed per second.'), title: 'API output rate' } },
      { key: 'table', span: 3, item: {
        type: 'monitor', source: { kind: 'push' }, title: 'Worker table',
        metric: { kind: 'table', key: 'workers', scope: 'cluster-a', unit: 'workers', definition: 'One row per synthetic worker.', source: 'synthetic table fixture' },
        data: { columns: [{ key: 'worker', type: 'string' }, { key: 'active', type: 'number', unit: 'workers' }], rows: [{ worker: 'worker-a', active: 2 }, { worker: 'worker-b', active: 0 }] },
      } },
      { key: 'pipeline', span: 3, item: {
        type: 'monitor', source: { kind: 'push' }, title: 'API fixture pipeline',
        metric: { kind: 'scalar', key: 'pipeline', scope: 'cluster-a', unit: 'stages', definition: 'References synthetic throughput and queue metrics.', source: 'synthetic pipeline fixture' },
        pipeline: { stages: [
          { key: 'ingest', label: 'Ingest', throughput: 'input' },
          { key: 'deliver', label: 'Deliver', throughput: 'output', queued: 'table' },
        ] },
      } },
    ] }],
  };
}

async function integration() {
  const health = await request('/api/health');
  assert.equal(health.name, 'hud', 'target must be hud');
  assert.equal(Number(health.port), port, 'target port mismatch');
  assert(['source', 'packaged'].includes(health.mode), 'target must be a source or packaged scratch server');
  assertScratchDataDir(health.dataDir);
  serverVerified = true;
  childEnv = {
    ...process.env,
    HUD_SCRATCH: '1',
    HUD_PORT: String(port),
    HUD_DATA: resolve(health.dataDir),
    HUD_PROBES: join(resolve(health.dataDir), 'probes'),
    HUD_VIEWS: join(resolve(health.dataDir), 'views'),
    HUD_URL: base.origin,
    HUD_ACTOR: ACTOR,
  };

  scratchWork = mkdtempSync(join(tmpdir(), 'hud-monitoring-api-check-'));
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const board = await request('/api/boards', { method: 'POST', body: { name: `Monitoring API ${nonce}` } });
  boards.push(board.id);
  const otherBoard = await request('/api/boards', { method: 'POST', body: { name: `Monitoring API scope ${nonce}` } });
  boards.push(otherBoard.id);

  const firstAt = Date.now();
  const spec = dashboardSpec(firstAt);
  const applied = await request(`/api/boards/${encodeURIComponent(board.id)}/dashboard`, { method: 'PUT', body: { spec } });
  assert.equal(applied.board, board.id);
  assert(Array.isArray(applied.created) && applied.created.length === 4, 'dashboard application must create its four managed cards');
  const dashboard = await request(`/api/boards/${encodeURIComponent(board.id)}/dashboard`);
  assert(dashboard && dashboard.revision, 'dashboard GET must return its revision');
  assert.deepEqual(dashboard.spec, spec);
  const keys = dashboard.keys;
  for (const key of ['input', 'output', 'table', 'pipeline']) assert(keys[key], `dashboard key map is missing ${key}`);

  const input = await request(`/api/items/${encodeURIComponent(keys.input)}`);
  const inputHistoryBefore = input.history?.length ?? 0;
  const nextAt = Math.max(Date.now(), (input.observation?.observedAt ?? 0) + 1);
  await request(`/api/monitors/${encodeURIComponent(keys.input)}/push`, {
    method: 'POST', body: { value: 13, observedAt: nextAt, evidence: 'estimate' },
  });
  const inputAfterPush = await request(`/api/items/${encodeURIComponent(keys.input)}`);
  assert.equal(inputAfterPush.value, 13);
  assert((inputAfterPush.history?.length ?? 0) > inputHistoryBefore, 'fresh reading must append history');

  const unrelatedId = `monitoring-${nonce}-unmanaged`;
  const unrelated = await request(`/api/monitors/${encodeURIComponent(unrelatedId)}/push`, {
    method: 'POST', body: {
      board: board.id, title: 'Unmanaged API fixture', value: 4,
      metric: { kind: 'counter', key: 'unmanaged', scope: 'cluster-a', unit: 'items', definition: 'Unmanaged card fixture.', source: 'synthetic external reporter' },
      observedAt: Date.now(), evidence: 'estimate', coverage: { responding: 1, total: 2 },
    },
  });
  assert.equal(unrelated.board, board.id);
  const unrelatedBefore = await request(`/api/items/${encodeURIComponent(unrelatedId)}`);

  const reapply = await request(`/api/boards/${encodeURIComponent(board.id)}/dashboard`, {
    method: 'PUT', body: { spec, expectedRevision: applied.revision },
  });
  assert.equal(reapply.created.length, 0, 'reapplying the same spec must not create duplicate managed cards');
  assert.equal(reapply.revision, applied.revision, 'idempotent reapplication should keep its revision');
  const inputAfterReapply = await request(`/api/items/${encodeURIComponent(keys.input)}`);
  assert.equal(inputAfterReapply.value, 13, 'reapplication must preserve the latest reading');
  assert.deepEqual(inputAfterReapply.history, inputAfterPush.history, 'reapplication must preserve reading history');
  assert.deepEqual([inputAfterReapply.x, inputAfterReapply.y, inputAfterReapply.w, inputAfterReapply.h], [inputAfterPush.x, inputAfterPush.y, inputAfterPush.w, inputAfterPush.h], 'reapplication must preserve managed card position');
  assert.deepEqual(await request(`/api/items/${encodeURIComponent(unrelatedId)}`), unrelatedBefore, 'dashboard updates must leave an unrelated card untouched');

  const readoutPath = `/api/readout?board=${encodeURIComponent(board.id)}`;
  const readout = await request(readoutPath);
  assert.equal(typeof readout.now, 'number');
  assert.equal(readout.boards.find((entry) => entry.id === board.id)?.name, board.name);
  const externalReading = rowById(readout.items, unrelatedId);
  assert.equal(externalReading.expirySeconds, 300, 'push monitors without staleAfter use the five-minute default expiry');
  assert.equal(externalReading.evidence, 'estimate');
  assert.equal(externalReading.observedAt, unrelatedBefore.observation.observedAt);
  assert(externalReading.receivedAt >= externalReading.observedAt, 'readout separates source observation from receipt time');
  assert.equal(externalReading.availability, 'partial');
  assert.deepEqual(externalReading.coverage, { responding: 1, total: 2 });
  const tableReading = rowById(readout.items, keys.table);
  assert.equal(tableReading.metric?.kind, 'table', 'table metric kind must survive public readout');
  const tableItem = await request(`/api/items/${encodeURIComponent(keys.table)}`);
  assert.equal(tableItem.data?.rows?.length, 2, 'typed table data must survive the public item endpoint');
  const pipelineReading = rowById(readout.items, keys.pipeline);
  assert.equal(pipelineReading.pipelineView?.stages[0]?.throughput?.id, keys.input, 'pipeline binding resolves its dashboard key');
  assert.equal(pipelineReading.pipelineView?.stages[1]?.queued?.id, keys.table, 'pipeline queue binding resolves its dashboard key');

  const annotationTime = Date.now();
  const annotation = await request(`/api/boards/${encodeURIComponent(board.id)}/annotations`, {
    method: 'POST', body: { time: annotationTime, text: 'synthetic deploy complete' },
  });
  const annotations = await request(`/api/boards/${encodeURIComponent(board.id)}/annotations`);
  assert(annotations.some((entry) => entry.id === annotation.id && entry.text === 'synthetic deploy complete'));
  const readoutWithAnnotation = await request(readoutPath);
  assert(readoutWithAnnotation.boards.find((entry) => entry.id === board.id)?.annotations.some((entry) => entry.id === annotation.id));

  const comparisonId = `cmp-${nonce}`;
  const comparison = await request(`/api/boards/${encodeURIComponent(board.id)}/comparisons`, {
    method: 'POST', body: { id: comparisonId, left: keys.input, right: keys.output, relation: 'equal', tolerance: 0, holdFor: 0, maxSkew: 60 },
  });
  assert.equal(comparison.id, comparisonId);
  const comparisons = await request(`/api/boards/${encodeURIComponent(board.id)}/comparisons`);
  assert(Array.isArray(comparisons), 'comparison GET must return a list');
  const comparisonRow = comparisons.find((entry) => entry.id === comparisonId);
  assert(comparisonRow, 'comparison GET must include the created rule');
  assert.equal(comparisonRow.left, keys.input);
  assert.equal(comparisonRow.right, keys.output);
  assert.equal(comparisonRow.state, 'conflict', 'comparison list should expose its evaluated conflict state');
  const readoutWithComparison = await request(readoutPath);
  assert.equal(readoutWithComparison.boards.find((entry) => entry.id === board.id)?.comparisons.find((entry) => entry.id === comparisonId)?.state, 'conflict');

  const lint = await request(`/api/boards/${encodeURIComponent(board.id)}/lint`);
  assert.equal(lint.board, board.id);
  assert(Array.isArray(lint.findings));
  assert.equal(typeof lint.errors, 'number');
  assert.equal(typeof lint.warnings, 'number');

  const snapshot = await request('/api/snapshot', { method: 'POST', body: { board: board.id, format: 'text' } });
  assert.equal(snapshot.board, board.id);
  assert.equal(typeof snapshot.capturedAt, 'number');
  assert.equal(typeof snapshot.text, 'string');
  assert.match(snapshot.text, new RegExp(board.id));
  assert.match(snapshot.text, new RegExp(unrelatedId));
  assert.equal(snapshot.image, undefined, 'text snapshot must not attempt image rendering');

  const specFile = join(scratchWork, 'dashboard.json');
  writeFileSync(specFile, JSON.stringify({ spec, expectedRevision: applied.revision }));
  const cliReadout = cliJson(['readout', board.id]);
  assert.equal(rowById(cliReadout.items, unrelatedId, 'CLI readout').expirySeconds, externalReading.expirySeconds);
  assert.equal(rowById(cliReadout.items, unrelatedId, 'CLI readout').evidence, externalReading.evidence);
  const cliDashboard = cliJson(['dashboard', board.id]);
  assert.equal(cliDashboard.revision, applied.revision);
  assert.deepEqual(cliDashboard.spec, spec);
  const cliDryRun = cliJson(['dashboard', board.id, '--file', specFile, '--dry-run']);
  assert.equal(cliDryRun.dryRun, true);
  assert.equal(cliDryRun.revision, applied.revision);
  const cliLint = cliJson(['lint', board.id]);
  assert.equal(cliLint.board, lint.board);
  assert.equal(cliLint.errors, lint.errors);
  assert.equal(cliLint.warnings, lint.warnings);
  const cliSnapshot = cliJson(['snapshot', board.id, '--format', 'text']);
  assert.equal(cliSnapshot.board, board.id);
  assert.equal(typeof cliSnapshot.text, 'string');
  assert.match(cliSnapshot.text, new RegExp(unrelatedId));
  const cliSnapshotText = cli(['snapshot', board.id, '--format', 'text']);
  assert.match(cliSnapshotText, new RegExp(unrelatedId));

  const cliComparisons = cliJson(['compare', board.id]);
  assert(cliComparisons.some((entry) => entry.id === comparisonId), 'CLI comparison list must expose the API rule');
  const deletedAnnotation = await request(`/api/boards/${encodeURIComponent(board.id)}/annotations`, { method: 'DELETE', body: { id: annotation.id } });
  assert.equal(deletedAnnotation.deleted, true);
  assert(!(await request(`/api/boards/${encodeURIComponent(board.id)}/annotations`)).some((entry) => entry.id === annotation.id));
  const deletedComparison = await request(`/api/boards/${encodeURIComponent(board.id)}/comparisons`, { method: 'DELETE', body: { id: comparisonId } });
  assert.equal(deletedComparison.deleted, true);
  assert(!(await request(`/api/boards/${encodeURIComponent(board.id)}/comparisons`)).some((entry) => entry.id === comparisonId));

  mcp = new McpClient();
  const initialized = await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'monitoring-api-check', version: '1' }, capabilities: {} });
  assert.equal(initialized.result?.serverInfo?.name, 'hud');
  assert.match(initialized.result?.instructions ?? '', /hud_readout/);
  assert.match(initialized.result?.instructions ?? '', /dark desktop/);
  const tools = await mcp.request('tools/list');
  const names = new Set(tools.result?.tools?.map((tool) => tool.name));
  for (const name of ['hud_readout', 'hud_snapshot', 'hud_dashboard', 'hud_annotate', 'hud_compare', 'hud_lint', 'hud_graph', 'hud_canvas', 'hud_clear_canvas']) assert(names.has(name), `MCP tools/list missing ${name}`);
  const boardTool = tools.result?.tools?.find((tool) => tool.name === 'hud_board');
  assert(boardTool?.inputSchema?.properties?.action?.enum?.includes('clear'), 'hud_board must expose clear as a separate action');
  const resources = await mcp.request('resources/list');
  assert(resources.result?.resources?.some((resource) => resource.uri === 'hud://guide'), 'resources/list must expose hud://guide');
  const guide = await mcp.request('resources/read', { uri: 'hud://guide' });
  assert.match(guide.result?.contents?.[0]?.text ?? '', /dashboard/i, 'hud://guide should be readable');

  const mcpReadout = await mcp.toolResult('hud_readout', { board: board.id });
  assert(mcpReadout.structuredContent, 'hud_readout must provide structuredContent');
  assert.equal(rowById(mcpReadout.structuredContent.items, unrelatedId, 'MCP readout').evidence, 'estimate');
  const mcpSnapshot = await mcp.toolResult('hud_snapshot', { board: board.id, format: 'text' });
  assert.equal(mcpSnapshot.structuredContent?.board, board.id);
  assert.match(mcpSnapshot.structuredContent?.text ?? '', new RegExp(unrelatedId));
  assert(!mcpSnapshot.content.some((part) => part.type === 'image'), 'text snapshot must return no image block');

  let rendererProgram;
  let itemProgramApplied;
  if (render) {
    const itemProgramPath = `/api/items/${encodeURIComponent(keys.input)}/program`;
    const html = '<main style="font:20px monospace;color:#eee;background:#080808;padding:24px"><h1>API renderer</h1><div id="metric"></div><script>const row=window.hud.data.items.find(item=>item.id===' + JSON.stringify(keys.input) + ');document.getElementById("metric").textContent=String(row?.value??"no data")</script></main>';
    rendererProgram = { code: html, language: 'html', description: 'monitoring api self-contained renderer', bindings: [keys.input], capabilities: [] };
    const preview = await request(itemProgramPath, { method: 'POST', body: { action: 'preview', program: rendererProgram } });
    assert.equal(preview.valid, true, `item program preview failed: ${preview.errors?.join('; ')}`);
    assertPng(preview.image, 'item program preview');
    itemProgramApplied = await request(itemProgramPath, { method: 'POST', body: { action: 'apply', program: rendererProgram } });
    assert(itemProgramApplied.revision && itemProgramApplied.program);
    const storedItemProgram = await request(itemProgramPath);
    assert.equal(storedItemProgram.program.code, html);

    const readOnlySession = await request('/api/program-sessions', { method: 'POST', body: { scope: 'item', id: keys.input, readonly: true } });
    sessions.push(readOnlySession.sessionId);
    await expectStatus(`/api/program-sessions/${encodeURIComponent(readOnlySession.sessionId)}/action`, 403, {
      method: 'POST', body: { operation: 'create', args: { item: { type: 'monitor', title: 'Denied readonly' } } },
    });

    const noGrantSession = await request('/api/program-sessions', { method: 'POST', body: { scope: 'item', id: keys.input } });
    sessions.push(noGrantSession.sessionId);
    await expectStatus(`/api/program-sessions/${encodeURIComponent(noGrantSession.sessionId)}/action`, 403, {
      method: 'POST', body: { operation: 'create', args: { item: { type: 'monitor', title: 'Denied no grant' } } },
    });

    const grantProgram = { ...rendererProgram, description: 'monitoring api scoped management renderer', capabilities: [
      { operation: 'update', scope: board.id },
      { operation: 'create', scope: board.id },
      { operation: 'push', scope: board.id },
      { operation: 'purge', scope: board.id },
    ] };
    const granted = await request(itemProgramPath, { method: 'POST', body: { action: 'apply', program: grantProgram, expectedRevision: itemProgramApplied.revision } });
    assert(granted.revision);
    const grantedSession = await request('/api/program-sessions', { method: 'POST', body: { scope: 'item', id: keys.input } });
    sessions.push(grantedSession.sessionId);
    const actionPath = `/api/program-sessions/${encodeURIComponent(grantedSession.sessionId)}/action`;

    const updateResult = await request(actionPath, { method: 'POST', body: { operation: 'update', args: { id: keys.input, patch: { label: 'renderer update' } } } });
    assert.equal(updateResult.result.label, 'renderer update', 'a board-scoped update grant should work on its board');

    const commandMonitorId = `command-${nonce}`;
    const createdCommand = await request(actionPath, { method: 'POST', body: { operation: 'create', args: { item: {
      id: commandMonitorId, type: 'monitor', board: board.id, title: 'Harmless command monitor',
      source: { kind: 'command', command: 'true', interval: 3600 }, metric: { unit: 'count', definition: 'Safe command fixture.' },
    } } } });
    assert.equal(createdCommand.result.source.kind, 'command');
    assert.equal(createdCommand.result.source.command, undefined, 'action replies redact source commands');
    const projected = await request(`/api/state?board=${encodeURIComponent(board.id)}`);
    assert.equal(projected.items.find(item => item.id === commandMonitorId).source.command, undefined, 'live board projections redact source configuration');
    assert.equal(projected.items.find(item => item.id === keys.input).program.code, undefined, 'live board projections omit executable program source');
    const disabledCommand = await request(actionPath, { method: 'POST', body: { operation: 'update', args: { id: commandMonitorId, patch: { source: { kind: 'manual' } } } } });
    assert.equal(disabledCommand.result.source.kind, 'manual', 'the harmless command fixture is disabled after the grant check');

    const foreignItemId = `foreign-${nonce}`;
    const foreign = await request(`/api/monitors/${encodeURIComponent(foreignItemId)}/push`, { method: 'POST', body: { board: otherBoard.id, title: 'Other-scope monitor', value: 7 } });
    const beforeForeign = await request(`/api/items/${encodeURIComponent(foreignItemId)}`);
    await expectStatus(actionPath, 403, { method: 'POST', body: { operation: 'update', args: { id: foreignItemId, patch: { title: 'cross-scope denied' } } } });
    const afterForeignUpdate = await request(`/api/items/${encodeURIComponent(foreignItemId)}`);
    assert.deepEqual(afterForeignUpdate, beforeForeign, 'cross-scope update denial must leave the foreign monitor unchanged');
    await expectStatus(actionPath, 403, { method: 'POST', body: { operation: 'push', args: { id: keys.input, reading: { value: 14, monitors: { [foreignItemId]: { value: 8 } } } } } });
    const afterFanout = await request(`/api/items/${encodeURIComponent(foreignItemId)}`);
    assert.deepEqual(afterFanout, beforeForeign, 'cross-scope fanout denial must leave the foreign monitor unchanged');
    const foreignFrame = await request('/api/items', { method: 'POST', body: { type: 'frame', title: 'Other board frame', board: otherBoard.id } });
    await expectStatus(actionPath, 403, { method: 'POST', body: { operation: 'create', args: { item: { type: 'monitor', board: board.id, frame: foreignFrame.id, title: 'Denied foreign frame' } } } });
    const reusedId = `reuse-${nonce}`;
    for (const ownedBoard of [otherBoard.id, board.id]) {
      await request(`/api/monitors/${reusedId}/push`, { method: 'POST', body: { board: ownedBoard, value: 1 } });
      await request(`/api/items/${reusedId}`, { method: 'DELETE' });
    }
    await expectStatus(actionPath, 403, { method: 'POST', body: { operation: 'purge', args: { id: reusedId } } });
    assert.equal((await request('/api/trash')).filter(entry => entry.item.id === reusedId).length, 2, 'scoped purge cannot erase same-id trash entries on another board');
    await expectStatus(itemProgramPath, 400, { method: 'POST', body: { action: 'apply', program: { ...rendererProgram, language: 'javascript', code: 'throw new Error("intentional renderer fixture")' }, expectedRevision: granted.revision } });
    const retained = await request(itemProgramPath);
    assert.equal(retained.program.revision, granted.revision, 'invalid program preserves the active revision');
    assert(retained.draft?.errors?.length, 'failed publication remains an inspectable draft');
    const emptyPreview = await request(itemProgramPath, { method: 'POST', body: { action: 'preview', program: { ...rendererProgram, language: 'javascript', code: 'void 0' } } });
    assert.equal(emptyPreview.valid, false, 'a program with no visible pixels must fail validation');
    const hungAt = Date.now();
    const hungPreview = await request(itemProgramPath, { method: 'POST', body: { action: 'preview', program: { ...rendererProgram, language: 'javascript', code: 'while (true) {}' } } });
    assert.equal(hungPreview.valid, false, 'a hung program must fail validation');
    assert(hungPreview.errors.some(error => /within 10 seconds|timed out/.test(error)), 'hung program has an explicit deadline error');
    assert(Date.now() - hungAt < 20_000, 'a hung program is terminated within the render deadline');

    const mcpGraph = await mcp.toolResult('hud_graph', { id: keys.input, action: 'preview', program: rendererProgram });
    const graphImage = mcpGraph.content.find((part) => part.type === 'image');
    assertPng(graphImage, 'MCP hud_graph preview');
    const mcpSnapshotPng = await mcp.toolResult('hud_snapshot', { board: board.id, format: 'png' });
    assertPng(mcpSnapshotPng.content.find((part) => part.type === 'image'), 'MCP hud_snapshot');
    assert.equal(mcpSnapshotPng.structuredContent?.image?.mimeType, 'image/png');
    assert(mcpSnapshotPng.structuredContent?.image?.bytes > 0, 'MCP structuredContent describes the image without duplicating base64');
    const apiSnapshotPng = await request('/api/snapshot', { method: 'POST', body: { board: board.id, format: 'png' } });
    assertPng(apiSnapshotPng.image, 'API PNG snapshot');

    const boardProgramPath = `/api/boards/${encodeURIComponent(board.id)}/program`;
    const canvasPreview = await request(boardProgramPath, { method: 'POST', body: { action: 'preview', program: rendererProgram } });
    assert.equal(canvasPreview.valid, true);
    assertPng(canvasPreview.image, 'board canvas preview');
    const canvasApplied = await request(boardProgramPath, { method: 'POST', body: { action: 'apply', program: { ...rendererProgram, bindings: [keys.pipeline] } } });
    assert(canvasApplied.revision);
    const pipelineSession = await request('/api/program-sessions', { method: 'POST', body: { scope: 'board', id: board.id } });
    sessions.push(pipelineSession.sessionId);
    const boundData = await request(`/api/program-sessions/${pipelineSession.sessionId}/data`);
    assert.deepEqual(boundData.items.map(item => item.id), [keys.pipeline]);
    assert.equal(boundData.items[0].pipelineView.stages[0].throughput, undefined, 'a pipeline binding cannot expose an undeclared stage monitor');
    const mcpCanvas = await mcp.toolResult('hud_canvas', { board: board.id, action: 'get' });
    assert.equal(mcpCanvas.structuredContent?.program?.description, rendererProgram.description);
    const canvasDisabled = await request(boardProgramPath, { method: 'POST', body: { action: 'disable', expectedRevision: canvasApplied.revision } });
    assert.equal(canvasDisabled.program.disabled, true);

    const failedApply = rawRequest(itemProgramPath, { method: 'POST', body: { action: 'apply', program: { ...rendererProgram, language: 'javascript', code: 'throw new Error("superseded renderer draft")' }, expectedRevision: granted.revision } });
    await new Promise(resolve => setTimeout(resolve, 200));
    const itemDeleted = await request(itemProgramPath, { method: 'DELETE', body: { expectedRevision: granted.revision } });
    assert.equal(itemDeleted.program.disabled, true, 'DELETE program route should disable the item program');
    assert.equal((await failedApply).status, 409, 'a failed preview superseded by a new revision cannot overwrite its draft');
    const itemAfterDelete = await request(itemProgramPath);
    assert.equal(itemAfterDelete.program.disabled, true);
    assert.deepEqual(itemAfterDelete.draft, retained.draft, 'superseded preview leaves the prior draft intact');
  }

  const makeDisposableBoard = async (name) => {
    const value = await request('/api/boards', { method: 'POST', body: { name: `${name} ${nonce}` } });
    boards.push(value.id);
    return value;
  };
  const makeDisposableNote = async (target, label) => {
    const id = `${label}-${nonce}`;
    await request('/api/items', { method: 'POST', body: { id, type: 'note', board: target.id, title: label, text: 'temporary clear/delete fixture' } });
    return id;
  };
  const boardList = async () => request('/api/boards');
  const hasBoard = async (id) => (await boardList()).some((entry) => entry.id === id);

  const clearApiBoard = await makeDisposableBoard('Clear API board');
  await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}`, { method: 'PATCH', body: { autoOrganize: false, notify: ['clear-test'] } });
  const clearApiLeft = `clear-left-${nonce}`;
  const clearApiRight = `clear-right-${nonce}`;
  for (const [id, title, value] of [[clearApiLeft, 'Clear comparison left', 3], [clearApiRight, 'Clear comparison right', 3]]) {
    await request('/api/items', { method: 'POST', body: {
      id, type: 'monitor', board: clearApiBoard.id, title, source: { kind: 'push' }, value, unit: 'items',
      metric: { kind: 'counter', key: id, scope: 'clear-test', unit: 'items', definition: 'Disposable clear board comparison fixture.', source: 'monitoring api check' },
    } });
  }
  const clearApiDashboard = { rows: [{ key: 'clear-row', cards: [{ key: 'managed', item: {
    type: 'monitor', title: 'Managed clear fixture', source: { kind: 'push' }, value: 1,
    metric: { kind: 'scalar', key: 'managed', scope: 'clear-test', unit: 'items', definition: 'Disposable dashboard fixture.', source: 'monitoring api check' },
  } }] }] };
  const dashboardBeforeClear = await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}/dashboard`, { method: 'PUT', body: { spec: clearApiDashboard } });
  const clearAnnotation = await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}/annotations`, { method: 'POST', body: { time: Date.now(), text: 'clear tombstone fixture' } });
  const clearComparison = await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}/comparisons`, { method: 'POST', body: { left: clearApiLeft, right: clearApiRight, relation: 'equal' } });
  let clearProgramBefore;
  if (render) {
    const clearProgram = {
      code: '<main style="font:20px monospace;color:#eee;background:#080808;padding:24px"><h1>Clear program fixture</h1></main>',
      language: 'html', description: 'clear canvas program fixture', bindings: [clearApiLeft], capabilities: [],
    };
    const clearProgramPath = `/api/boards/${encodeURIComponent(clearApiBoard.id)}/program`;
    clearProgramBefore = await request(clearProgramPath, { method: 'POST', body: { action: 'apply', program: clearProgram } });
    await expectStatus(clearProgramPath, 400, { method: 'POST', body: { action: 'apply', expectedRevision: clearProgramBefore.revision, program: { ...clearProgram, language: 'javascript', description: 'clear draft fixture', code: 'throw new Error("clear draft fixture")' } } });
    const withDraft = await request(clearProgramPath);
    assert(withDraft.draft?.errors?.length, 'fixture should have a canvas program draft before clear');
  }
  const beforeClearBoard = (await boardList()).find((entry) => entry.id === clearApiBoard.id);
  assert(beforeClearBoard);
  const clearSettings = { id: beforeClearBoard.id, name: beforeClearBoard.name, createdAt: beforeClearBoard.createdAt, width: beforeClearBoard.width, height: beforeClearBoard.height, autoOrganize: beforeClearBoard.autoOrganize, notify: beforeClearBoard.notify };
  const clearResponse = await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}/clear`, { method: 'POST', body: {} });
  assert.equal(clearResponse.board, clearApiBoard.id);
  assert.equal(clearResponse.cleared, 3);
  assert.deepEqual(new Set(clearResponse.removed), new Set([clearApiLeft, clearApiRight, dashboardBeforeClear.created[0]]));
  assert(await hasBoard(clearApiBoard.id), 'HTTP clear must retain the board');
  const afterClearBoard = (await boardList()).find((entry) => entry.id === clearApiBoard.id);
  assert.deepEqual({ id: afterClearBoard.id, name: afterClearBoard.name, createdAt: afterClearBoard.createdAt, width: afterClearBoard.width, height: afterClearBoard.height, autoOrganize: afterClearBoard.autoOrganize, notify: afterClearBoard.notify }, clearSettings, 'clear retains board identity and settings');
  assert.deepEqual(await request(`/api/items?board=${encodeURIComponent(clearApiBoard.id)}`), [], 'clear removes all live board items');
  const clearTrash = await request(`/api/trash?board=${encodeURIComponent(clearApiBoard.id)}`);
  for (const id of clearResponse.removed) assert(clearTrash.some((entry) => entry.item.id === id), `cleared item ${id} should be in trash`);
  assert.equal(await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}/dashboard`), null, 'clear removes the dashboard draft');
  assert.deepEqual(await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}/annotations`), []);
  assert.deepEqual(await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}/comparisons`), []);
  const tombstones = (await boardList()).find((entry) => entry.id === clearApiBoard.id);
  assert(tombstones.annotations.some((entry) => entry.id === clearAnnotation.id && entry.deletedAt), 'clear tombstones annotations');
  assert(tombstones.comparisons.some((entry) => entry.id === clearComparison.id && entry.deletedAt), 'clear tombstones comparisons');
  if (render) {
    const clearedProgram = await request(`/api/boards/${encodeURIComponent(clearApiBoard.id)}/program`);
    assert.equal(clearedProgram.program.disabled, true, 'clear disables an applied canvas program');
    assert.notEqual(clearedProgram.program.revision, clearProgramBefore.revision, 'clear rotates the disabled program revision');
    assert.equal(clearedProgram.draft, null, 'clear removes an unpublished program draft');
  }

  const clearCliBoard = await makeDisposableBoard('Clear CLI board');
  const clearCliNote = await makeDisposableNote(clearCliBoard, 'clear-cli-note');
  const cliClear = cliJson(['board', 'clear', clearCliBoard.id]);
  assert.equal(cliClear.board, clearCliBoard.id);
  assert.equal(cliClear.cleared, 1);
  assert(await hasBoard(clearCliBoard.id), 'CLI clear must retain the board');
  assert(!(await request(`/api/items?board=${encodeURIComponent(clearCliBoard.id)}`)).some((item) => item.id === clearCliNote));
  assert((await request(`/api/trash?board=${encodeURIComponent(clearCliBoard.id)}`)).some((entry) => entry.item.id === clearCliNote));

  const clearMcpBoard = await makeDisposableBoard('Clear MCP board');
  const clearMcpNote = await makeDisposableNote(clearMcpBoard, 'clear-mcp-note');
  const mcpClearText = await mcp.tool('hud_clear_canvas', { board: clearMcpBoard.id });
  assert.match(mcpClearText, new RegExp(clearMcpBoard.id));
  assert(await hasBoard(clearMcpBoard.id), 'hud_clear_canvas must retain the board');
  assert(!(await request(`/api/items?board=${encodeURIComponent(clearMcpBoard.id)}`)).some((item) => item.id === clearMcpNote));
  const mcpBoardClearText = await mcp.tool('hud_board', { action: 'clear', id: clearMcpBoard.id });
  assert.match(mcpBoardClearText, /0 items moved to trash/, 'hud_board clear action is distinct and idempotent');

  const deleteApiBoard = await makeDisposableBoard('Delete HTTP board');
  const deletedApi = await request(`/api/boards/${encodeURIComponent(deleteApiBoard.id)}`, { method: 'DELETE' });
  assert.equal(deletedApi.ok, true);
  assert.equal(await hasBoard(deleteApiBoard.id), false, 'HTTP delete removes the board');
  const deleteCliBoard = await makeDisposableBoard('Delete CLI board');
  const deletedCli = cliJson(['board', 'rm', deleteCliBoard.id]);
  assert.equal(deletedCli.ok, true);
  assert.equal(await hasBoard(deleteCliBoard.id), false, 'CLI rm deletes the board instead of clearing it');
  const deleteMcpBoard = await makeDisposableBoard('Delete MCP board');
  const deletedMcp = await mcp.tool('hud_board', { action: 'delete', id: deleteMcpBoard.id });
  assert.match(deletedMcp, new RegExp(deleteMcpBoard.id));
  assert.equal(await hasBoard(deleteMcpBoard.id), false, 'MCP delete removes the board instead of clearing it');
  await expectStatus('/api/boards/main', 400, { method: 'DELETE' });

  console.log(`PASS: monitoring HTTP/CLI/MCP checks on ${base.origin} (board ${board.id}, mode ${health.mode}${render ? ', render/program/clear checks' : ', clear/delete checks'})`);
}

async function cleanup() {
  if (mcp) {
    try { await mcp.close(); } catch {}
  }
  if (serverVerified) {
    for (const session of sessions.reverse()) {
      try { await rawRequest(`/api/program-sessions/${encodeURIComponent(session)}`, { method: 'DELETE' }); } catch {}
    }
    for (const board of boards.reverse()) {
      try { await rawRequest(`/api/boards/${encodeURIComponent(board)}`, { method: 'DELETE' }); } catch {}
    }
  }
  if (scratchWork) rmSync(scratchWork, { recursive: true, force: true });
}

try {
  await integration();
} catch (error) {
  console.error(`FAIL: monitoring API check: ${error?.stack || error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
