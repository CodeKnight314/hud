import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'http://127.0.0.1:7411/';
const SCRATCH = mkdtempSync(join(tmpdir(), 'hud-supervision-api-'));
const DATA = join(SCRATCH, 'data');
const PROBES = join(SCRATCH, 'probes');
const VIEWS = join(SCRATCH, 'views');
const ACTOR = 'api-supervision-check';
const HUMAN = 'api-supervision-human';

function usage() {
  console.error('usage: node scripts/check-supervision-api.mjs [--url http://127.0.0.1:<scratch-port>]');
}

function parseUrl(argv) {
  let raw = DEFAULT_URL;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--url') {
      raw = argv[++i];
      if (!raw) throw new Error('--url needs a value');
      continue;
    }
    if (arg.startsWith('--url=')) {
      raw = arg.slice('--url='.length);
      if (!raw) throw new Error('--url needs a value');
      continue;
    }
    positional.push(arg);
  }
  if (positional.length) {
    if (positional.length > 1 || raw !== DEFAULT_URL) throw new Error('only one URL may be supplied, using --url');
    raw = positional[0];
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
  const port = Number(url.port || 0);
  if (url.protocol !== 'http:' || !loopback.has(host) || !url.port || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 7317) {
    throw new Error('URL must be an explicit loopback HTTP scratch port other than 7317');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('URL must not contain credentials, query, or fragment');
  url.pathname = '/';
  return { base: url, port };
}

const { base, port } = parseUrl(process.argv.slice(2));
const childEnv = {
  ...process.env,
  HUD_SCRATCH: '1',
  HUD_PORT: String(port),
  HUD_DATA: DATA,
  HUD_PROBES: PROBES,
  HUD_VIEWS: VIEWS,
  HUD_URL: base.origin,
  HUD_ACTOR: ACTOR,
};

mkdirSync(DATA, { recursive: true });
mkdirSync(PROBES, { recursive: true });
mkdirSync(VIEWS, { recursive: true });

function jsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function rawRequest(path, { method = 'GET', body, actor = ACTOR } = {}) {
  const headers = { accept: 'application/json', 'x-hud-actor': encodeURIComponent(actor) };
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(path, base), init);
  const text = await response.text();
  return { status: response.status, body: jsonBody(text), text };
}

async function request(path, options = {}) {
  const response = await rawRequest(path, options);
  assert(response.status >= 200 && response.status < 300, `${options.method || 'GET'} ${path} → ${response.status}: ${response.text}`);
  return response.body;
}

async function expectStatus(path, status, options = {}) {
  const response = await rawRequest(path, options);
  assert.equal(response.status, status, `${options.method || 'GET'} ${path} expected ${status}, got ${response.status}: ${response.text}`);
  return response.body;
}

function cli(args, actor = ACTOR) {
  const result = spawnSync(process.execPath, [join(ROOT, 'bin/hud.js'), ...args], {
    cwd: ROOT,
    env: { ...childEnv, HUD_ACTOR: actor },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `CLI ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function parseCliJson(args, actor = ACTOR) {
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
    this.child = spawn(process.execPath, [join(ROOT, 'src/mcp.ts')], { cwd: ROOT, env: { ...childEnv, HUD_ACTOR: 'api-supervision-mcp' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
      }, 30_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async tool(name, arguments_ = {}) {
    const response = await this.request('tools/call', { name, arguments: arguments_ });
    assert(!response.error, `MCP ${name} returned RPC error: ${JSON.stringify(response.error)}`);
    assert(response.result && Array.isArray(response.result.content), `MCP ${name} returned no content`);
    const text = response.result.content.find((part) => part.type === 'text')?.text;
    assert.equal(typeof text, 'string', `MCP ${name} returned no text content`);
    assert(!response.result.isError, `MCP ${name} failed: ${text}`);
    return text;
  }

  close() {
    this.lines.close();
    this.child.kill('SIGTERM');
  }
}

function assertActivityShape(events) {
  assert(Array.isArray(events) && events.length > 0, 'changes must contain activity events');
  for (const event of events.slice(-10)) {
    for (const key of ['id', 't', 'actor', 'action', 'text']) assert(Object.hasOwn(event, key), `activity event missing ${key}`);
    assert.equal(typeof event.id, 'number');
    assert.equal(typeof event.t, 'number');
    assert.equal(typeof event.actor, 'string');
    assert.equal(typeof event.action, 'string');
    assert.equal(typeof event.text, 'string');
  }
}

async function main() {
  const health = await request('/api/health');
  assert.equal(health.name, 'hud', 'target must be hud');
  assert.equal(Number(health.port), port, 'target port mismatch');
  assert.ok(['source', 'packaged'].includes(health.mode), 'target must be a source or packaged scratch server');
  const testSince = Date.now() - 1;

  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const board = await request('/api/boards', { method: 'POST', body: { name: `API supervision ${nonce}` } });
  const summaryId = `api-${nonce}-summary`;
  const issueId = `api-${nonce}-issue`;
  const runId = `api-${nonce}-run`;
  const commentTicketId = `api-${nonce}-comment`;
  const decisionTicketId = `api-${nonce}-decision`;

  const summary = await request('/api/items', {
    method: 'POST',
    body: {
      id: summaryId,
      type: 'monitor',
      board: board.id,
      title: 'API summary',
      source: { kind: 'push' },
      value: 40,
      progress: 40,
      state: 'ok',
      unit: '%',
      message: 'summary headline',
      messageFormat: 'markdown',
      details: '# Summary report\n\nvalue remains numeric',
    },
  });
  assert.equal(summary.messageFormat, 'markdown');
  assert.equal(summary.details, '# Summary report\n\nvalue remains numeric');
  assert.equal(summary.value, 40);
  assert.equal(summary.progress, 40);

  const pushed = await request(`/api/monitors/${encodeURIComponent(summaryId)}/push`, {
    method: 'POST',
    body: { value: 41, progress: 41, state: 'ok', message: 'updated headline', messageFormat: 'markdown', details: '## Updated report' },
  });
  assert.equal(pushed.value, 41);
  assert.equal(pushed.progress, 41);
  assert.equal(pushed.messageFormat, 'markdown');
  assert.equal(pushed.details, '## Updated report');

  const beforeInvalid = await request(`/api/items/${encodeURIComponent(summaryId)}`);
  await expectStatus(`/api/monitors/${encodeURIComponent(summaryId)}/push`, 400, {
    method: 'POST',
    body: { value: 42, details: 'x'.repeat(20_001) },
  });
  const afterInvalid = await request(`/api/items/${encodeURIComponent(summaryId)}`);
  assert.deepEqual(afterInvalid, beforeInvalid, 'oversized details push must be atomic');

  const issue = await request(`/api/monitors/${encodeURIComponent(issueId)}/push`, {
    method: 'POST',
    body: { title: 'API warning', state: 'warn', message: 'attention headline', messageFormat: 'plain', details: 'warning details' },
  });
  assert.equal(issue.state, 'warn');
  const issueAttention = (await request('/api/attention')).items.find((item) => item.itemId === issueId);
  assert(issueAttention, 'warning monitor must create attention');
  const oldAlerts = await request('/api/alerts?all=1');
  assert(oldAlerts.some((alert) => alert.itemId === issueId && !alert.acked), 'warning must leave an unacknowledged agent alert');
  const reviewed = await request(`/api/attention/${encodeURIComponent(issueId)}`, {
    method: 'POST',
    actor: HUMAN,
    body: { action: 'review', revision: issueAttention.revision },
  });
  assert.equal(reviewed.reviewedBy, HUMAN);
  const attentionAfterReview = (await request('/api/attention')).items.find((item) => item.itemId === issueId);
  assert(attentionAfterReview?.reviewedAt, 'review must remain visible on attention');
  const alertsAfterReview = await request('/api/alerts?all=1');
  assert(alertsAfterReview.some((alert) => alert.itemId === issueId && !alert.acked), 'review must not acknowledge old alerts');

  const run = await request('/api/items', {
    method: 'POST',
    body: {
      id: runId,
      type: 'ticket',
      board: board.id,
      title: 'API supervision run',
      status: 'doing',
      tags: ['run', 'synthetic'],
      monitors: [summaryId, issueId],
      summaryMonitor: summaryId,
    },
  });
  assert.equal(run.summaryMonitor, summaryId);
  const runView = (await request('/api/runs')).items.find((item) => item.id === runId);
  assert(runView, 'run tag must produce a run overview');
  assert.equal(runView.summaryMonitor, summaryId);
  assert.equal(runView.progress, 41, 'run progress must use explicit summaryMonitor');
  assert(runView.monitors.some((monitor) => monitor.id === summaryId));

  const commentTicket = await request('/api/items', { method: 'POST', body: { id: commentTicketId, type: 'ticket', board: board.id, title: 'API comments' } });
  assert.equal(commentTicket.id, commentTicketId);
  const comment = await request(`/api/items/${encodeURIComponent(commentTicketId)}/comments`, {
    method: 'POST',
    body: { text: '**markdown comment**', format: 'markdown' },
  });
  assert.equal(comment.format, 'markdown');
  const editedComment = await request(`/api/items/${encodeURIComponent(commentTicketId)}/comments/${encodeURIComponent(comment.id)}`, {
    method: 'PATCH',
    body: { text: '*edited comment*' },
  });
  assert.equal(editedComment.format, 'markdown', 'editing without format must preserve it');

  const decisionTicket = await request('/api/items', { method: 'POST', body: { id: decisionTicketId, type: 'ticket', board: board.id, title: 'API decision' } });
  const asked = await request(`/api/items/${encodeURIComponent(decisionTicketId)}/ask`, {
    method: 'POST',
    body: {
      question: 'Choose the API path',
      questionFormat: 'markdown',
      options: [{ id: 'keep', label: 'Keep', detail: '**keep**', status: 'doing' }, { id: 'drop', label: 'Drop', status: 'canceled' }],
    },
  });
  assert.equal(asked.questionFormat, 'markdown');
  assert.equal(asked.options[0].detail, '**keep**');
  assert.equal(typeof asked.decisionVersion, 'string');
  const decisionVersion = asked.decisionVersion;
  await expectStatus(`/api/items/${encodeURIComponent(decisionTicketId)}/decide`, 409, { method: 'POST', body: { optionId: 'keep', decisionVersion: 'stale-version' } });
  const decided = await request(`/api/items/${encodeURIComponent(decisionTicketId)}/decide`, { method: 'POST', body: { optionId: 'keep', decisionVersion } });
  assert.equal(decided.decision.optionId, 'keep');
  await expectStatus(`/api/items/${encodeURIComponent(decisionTicketId)}/decide`, 409, { method: 'POST', body: { optionId: 'keep', decisionVersion } });

  // since=0 is an independent retention/shape check; a crowded board may legitimately omit the latest events.
  const changesSinceZero = await request('/api/changes?since=0');
  assert.equal(typeof changesSinceZero.since, 'number');
  assert.equal(typeof changesSinceZero.now, 'number');
  assert.equal(typeof changesSinceZero.complete, 'boolean');
  assertActivityShape(changesSinceZero.events);
  const changes = await request(`/api/changes?since=${testSince}`);
  assertActivityShape(changes.events);
  assert(changes.events.some((event) => event.itemId === decisionTicketId && event.action === 'decide'), 'changes since test start must include the decision activity');

  const cliAttention = parseCliJson(['attention', 'list']);
  assert(Array.isArray(cliAttention.items), 'CLI attention list must be JSON');
  const cliRuns = parseCliJson(['runs']);
  assert(cliRuns.items.some((item) => item.id === runId), 'CLI runs must include synthetic run');
  const cliChanges = parseCliJson(['changes', '--since', '0']);
  assertActivityShape(cliChanges.events);
  const cliMonitor = parseCliJson(['show', summaryId]);
  assert.equal(cliMonitor.details, '## Updated report');
  assert.equal(cliMonitor.messageFormat, 'markdown');
  const cliDecision = parseCliJson(['show', decisionTicketId]);
  assert.equal(typeof cliDecision.decisionVersion, 'string');

  const mcp = new McpClient();
  try {
    const initialized = await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'supervision-api-check', version: '1' }, capabilities: {} });
    assert.equal(initialized.result?.serverInfo?.name, 'hud');
    const tools = await mcp.request('tools/list');
    const names = new Set(tools.result?.tools?.map((tool) => tool.name));
    for (const name of ['hud_attention', 'hud_runs', 'hud_changes']) assert(names.has(name), `MCP tools/list missing ${name}`);

    const mcpAttention = await mcp.tool('hud_attention', { action: 'list' });
    assert.match(mcpAttention, /Human attention/);
    assert.match(mcpAttention, new RegExp(issueId));
    const mcpRuns = await mcp.tool('hud_runs');
    assert.match(mcpRuns, /API supervision run/);
    assert.match(mcpRuns, new RegExp(summaryId));
    assert.match(mcpRuns, /41%/);
    const mcpChangesSinceZero = await mcp.tool('hud_changes', { since: 0 });
    assert.match(mcpChangesSinceZero, /## Changes/);
    const mcpChanges = await mcp.tool('hud_changes', { since: testSince });
    assert.match(mcpChanges, /## Changes/);
    assert.match(mcpChanges, /decide/);
    const mcpMonitor = JSON.parse(await mcp.tool('hud_get', { id: summaryId }));
    assert.equal(mcpMonitor.value, 41);
    assert.equal(mcpMonitor.progress, 41);
    assert.equal(mcpMonitor.messageFormat, 'markdown');
    assert.equal(mcpMonitor.details, '## Updated report');
    const mcpDecision = JSON.parse(await mcp.tool('hud_get', { id: decisionTicketId }));
    assert.equal(typeof mcpDecision.decisionVersion, 'string');
    assert.equal(mcpDecision.questionFormat, 'markdown');
  } finally {
    mcp.close();
  }

  console.log(`PASS: supervision HTTP, CLI, and MCP API checks on ${base.origin} (board ${board.id})`);
}

main().catch((error) => {
  console.error(`FAIL: supervision API check: ${error?.stack || error}`);
  process.exitCode = 1;
});
