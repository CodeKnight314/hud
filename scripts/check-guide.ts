// Coordination playbooks are copy-paste runbooks. One playbook must stand alone, shorter than the guide.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordinationDoc, fullGuide, GuideError, playbookIndex, playbookText } from '../src/guide.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const STEPS = ['hud_claim', 'kind: "FACT"', 'hud_wait', 'hud_finish', '### Expired lease', '### Blocked ticket', '### Assignee conflict'];
const CODES = ['`claimed`', '`blocked`', '`assigned`'];

function order(text: string, parts: string[], label: string) {
  let at = -1;
  for (const part of parts) {
    const i = text.indexOf(part);
    assert.ok(i > at, `${label} missing or out of order: ${part}`);
    at = i;
  }
}

const guide = fullGuide(7317);
const decentralized = playbookText('decentralized');
const lead = playbookText('lead');
const index = playbookIndex();

for (const [name, text] of [['decentralized', decentralized], ['lead', lead]] as const) {
  order(text, STEPS, name);
  for (const code of CODES) assert.ok(text.includes(code), `${name} missing ${code}`);
  assert.ok(!text.includes('## Monitors'), `${name} includes the guide`);
  assert.ok(!text.includes('<!-- playbook:'), `${name} includes a slice marker`);
  assert.ok(text.length < guide.length / 2, `${name} is ${text.length} chars; the guide is ${guide.length}`);
  assert.equal(text, coordinationDoc(name, 1));
}

assert.ok(decentralized.startsWith('## Decentralized\n'));
assert.ok(!decentralized.includes('## Lead'));
assert.ok(!decentralized.includes('hud_project'));
assert.ok(decentralized.includes('start: true'));
assert.ok(decentralized.includes('takeover: true'));
assert.ok(decentralized.includes('board:main'));
const RUN_UUID = '3f2a9c1e-7b4d-4e8a-9c21-0b6d5e4a1f80';
const OPEN = 'hud_tickets {tag: "run", status: "backlog,todo,doing,review,blocked"}';
const STALE = 'A `done` or `canceled` run keeps its `run` tag, and `scopes` still lists that `run:<uuid>`. Neither is a live lead. Follow `hud guide decentralized` when the open list is empty.';
assert.ok(decentralized.indexOf('### 0. Read a lead FACT') < decentralized.indexOf('### 1. Claim'));
assert.ok(decentralized.includes(OPEN));
assert.ok(decentralized.includes('action: "scopes"'));
assert.ok(decentralized.includes(`run:${RUN_UUID}`));
assert.ok(decentralized.includes('hud guide lead'));
assert.ok(decentralized.includes(STALE));
assert.ok(decentralized.indexOf(STALE) < decentralized.indexOf('### 1. Claim'));
assert.ok(!decentralized.includes('any ticket tagged'));
assert.ok(!decentralized.includes('run:EGO-'));

assert.ok(lead.startsWith('## Lead\n'));
assert.ok(!lead.includes('## Decentralized'));
assert.ok(lead.includes('hud_project'));
assert.ok(lead.includes('blockedBy'));
assert.ok(lead.includes('assignee'));
assert.ok(lead.includes('parent'));
assert.ok(lead.includes('tags: ["run"]'));
assert.ok(lead.includes('### Worker loop'));
order(lead, ['### Lead loop', '### Worker loop', '### Expired lease'], 'lead roles');
const worker = lead.slice(lead.indexOf('### Worker loop'));
assert.ok(worker.indexOf('#### 0. Read the lead FACT') < worker.indexOf('#### 1. Claim'));
assert.ok(worker.includes(OPEN) && worker.includes('action: "scopes"') && worker.includes(`run:${RUN_UUID}`));
assert.ok(worker.includes(STALE));
assert.ok(worker.indexOf(STALE) < worker.indexOf('#### 1. Claim'));
assert.ok(lead.includes('open list is empty'));
assert.ok(!lead.includes('run:EGO-'));

assert.equal(playbookText('centralized'), lead);
assert.equal(playbookText('LEAD'), lead);
assert.equal(coordinationDoc('playbooks', 1), index);
assert.equal(coordinationDoc('index', 1), index);
assert.ok(index.includes('hud guide decentralized'));
assert.ok(index.includes('hud guide lead'));
assert.ok(!index.includes('## Decentralized'));
assert.ok(!index.includes('hud_finish'));
assert.ok(index.includes(OPEN) && index.includes(STALE) && index.includes('action: "scopes"') && index.includes(`run:${RUN_UUID}`));
assert.ok(!index.includes('any ticket tagged'));
assert.ok(!guide.includes('run:EGO-'), 'GUIDE still demos a KEY-n as a run scope');
assert.ok(guide.includes(`run:${RUN_UUID}`));
assert.ok(guide.includes('follow lead only while that ticket is open'));
assert.ok(!read('src/cli.ts').includes('run:EGO-'));
assert.ok(guide.includes('hud guide decentralized') && guide.includes('GET /api/guide?playbook=lead'));
assert.ok(guide.includes('## Monitors'));
assert.equal(coordinationDoc(undefined, 7317), guide);
// Repo markdown stays relative for GitHub. The served guide (fullGuide → guideText) must not.
const repoGuide = read('GUIDE.md');
const repoStyle = read('STYLE.md');
assert.ok(repoGuide.includes('](STYLE.md)') && repoGuide.includes('](views/README.md)'));
assert.ok(repoStyle.includes('](views/README.md)'));
function unresolved(markdown: string): string[] {
  const found: string[] = [];
  for (const m of markdown.matchAll(/\]\(([^)\s]+)/g)) {
    const target = m[1];
    if (target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    found.push(target);
  }
  return found;
}
const dead = unresolved(guide);
assert.deepEqual(dead, [], `served guide has relative links: ${dead.join(', ')}`);
assert.ok(guide.includes('](#hud-visual-contract)'));
assert.ok(guide.includes('# HUD visual contract'));
assert.ok(guide.includes('https://github.com/CodeKnight314/hud/blob/0.2.0/views/README.md'));
assert.ok(!guide.includes('](STYLE.md)') && !guide.includes('](views/README.md)'));
for (const [name, text] of [['decentralized', decentralized], ['lead', lead], ['playbooks', index]] as const) {
  const links = unresolved(text);
  assert.deepEqual(links, [], `${name} has relative links: ${links.join(', ')}`);
}
assert.equal(coordinationDoc('  ', 7317), guide);

assert.throws(() => playbookText('pair'), (e) => e instanceof GuideError && e.status === 400 && /decentralized or lead/.test(e.message));

const packaged = read('electron-builder.yml');
assert.ok(packaged.includes('from: PLAYBOOKS.md') && packaged.includes('to: hud/PLAYBOOKS.md'), 'packaged app ships PLAYBOOKS.md');
for (const file of ['src/server.ts', 'src/cli.ts', 'src/mcp.ts', 'src/client.ts']) {
  assert.ok(read(file).includes('playbook'), `${file} does not serve a playbook`);
}
assert.ok(read('src/mcp.ts').includes('hud://playbook/decentralized'));
assert.ok(read('src/mcp.ts').includes('hud://playbook/lead'));

function cli(args: string[]) {
  const env = { ...process.env, HUD_SCRATCH: '', HUD_PORT: '' };
  return spawnSync(process.execPath, [join(root, 'bin/hud.js'), ...args], { cwd: root, encoding: 'utf8', env });
}

const one = cli(['guide', 'decentralized']);
assert.equal(one.status, 0, one.stderr);
assert.equal(one.stdout.trimEnd(), decentralized.trimEnd());
const alias = cli(['guide', 'centralized']);
assert.equal(alias.status, 0, alias.stderr);
assert.equal(alias.stdout.trimEnd(), lead.trimEnd());
const chooser = cli(['guide', 'playbooks']);
assert.equal(chooser.status, 0, chooser.stderr);
assert.equal(chooser.stdout.trimEnd(), index.trimEnd());
const full = cli(['guide']);
assert.equal(full.status, 0, full.stderr);
assert.ok(full.stdout.includes('## Monitors') && full.stdout.includes('localhost:7317'));
assert.deepEqual(unresolved(full.stdout), []);
assert.ok(full.stdout.includes('](#hud-visual-contract)') && !full.stdout.includes('](STYLE.md)'));
const bad = cli(['guide', 'nope']);
assert.equal(bad.status, 2);
assert.match(bad.stderr, /unknown playbook/);

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function mcpCall(env: NodeJS.ProcessEnv, messages: { id?: number }[]): Promise<{ id?: number; result?: any; error?: { message?: string } }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'src/mcp.ts')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    const replies: { id?: number; result?: any; error?: { message?: string } }[] = [];
    const wanted = messages.filter((message) => message.id !== undefined).length;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP timed out\n${err}\n${buf}`));
    }, 20000);
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        replies.push(JSON.parse(line));
      }
      if (replies.filter((reply) => reply.id !== undefined).length >= wanted) {
        clearTimeout(timer);
        child.kill();
        resolve(replies);
      }
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

let port = 0;
for (let attempt = 0; attempt < 8 && (port === 0 || port === 7317); attempt++) port = await reservePort();
assert.ok(port > 0 && port !== 7317, 'scratch port');
const dataDir = mkdtempSync(join(tmpdir(), 'hud-playbook-'));
const probesDir = join(dataDir, 'probes');
const viewsDir = join(dataDir, 'views');
mkdirSync(probesDir);
mkdirSync(viewsDir);
const base = `http://127.0.0.1:${port}`;
const scratchEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HUD_SCRATCH: '1',
  HUD_PORT: String(port),
  HUD_DATA: dataDir,
  HUD_PROBES: probesDir,
  HUD_VIEWS: viewsDir,
  HUD_URL: base,
};
const server = spawn(process.execPath, [join(root, 'bin/hud.js'), 'serve'], { cwd: root, env: scratchEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
const serverExit = new Promise<void>((resolve) => server.once('exit', () => resolve()));
try {
  const deadline = Date.now() + 15000;
  let health = '';
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/api/health`);
      health = await res.text();
      if (res.ok && health.includes('"ok":true')) break;
    } catch (error) {
      health = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(health.includes('"ok":true'), `scratch server did not come up\n${health}\n${serverLog}`);

  async function guideHttp(query: string) {
    const res = await fetch(`${base}/api/guide${query}`);
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') ?? '', text };
  }
  const dec = await guideHttp('?playbook=decentralized');
  assert.equal(dec.status, 200);
  assert.match(dec.type, /text\/markdown/);
  assert.equal(dec.text, decentralized);
  const led = await guideHttp('?playbook=lead');
  assert.equal(led.status, 200);
  assert.equal(led.text, lead);
  const aliasHttp = await guideHttp('?playbook=centralized');
  assert.equal(aliasHttp.status, 200);
  assert.equal(aliasHttp.text, lead);
  const chooserHttp = await guideHttp('?playbook=playbooks');
  assert.equal(chooserHttp.status, 200);
  assert.equal(chooserHttp.text, index);
  const unknown = await guideHttp('?playbook=nope');
  assert.equal(unknown.status, 400);
  assert.match(unknown.text, /unknown playbook/);
  const served = await guideHttp('');
  assert.equal(served.status, 200);
  assert.ok(served.text.includes('## Monitors') && served.text.includes('](#hud-visual-contract)'));
  assert.deepEqual(unresolved(served.text), []);

  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'playbook-check' } } };
  const listed = await mcpCall(scratchEnv, [init, { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} }]);
  const uris = (listed.find((reply) => reply.id === 2)?.result?.resources ?? []).map((resource: { uri: string }) => resource.uri);
  assert.ok(uris.includes('hud://playbook/decentralized') && uris.includes('hud://playbook/lead'), uris.join(','));
  for (const [uri, text] of [['hud://playbook/decentralized', decentralized], ['hud://playbook/lead', lead]] as const) {
    const read = await mcpCall(scratchEnv, [init, { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri } }]);
    const body = read.find((reply) => reply.id === 3);
    assert.equal(body?.result?.contents?.[0]?.text, text, uri);
  }
  const fullResource = await mcpCall(scratchEnv, [init, { jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'hud://guide' } }]);
  const fullText = fullResource.find((reply) => reply.id === 7)?.result?.contents?.[0]?.text ?? '';
  assert.ok(fullText.includes('## Monitors') && fullText.includes('](#hud-visual-contract)'));
  assert.deepEqual(unresolved(fullText), []);
  const tool = await mcpCall(scratchEnv, [init, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hud_guide', arguments: { playbook: 'decentralized' } } }]);
  assert.equal(tool.find((reply) => reply.id === 4)?.result?.content?.[0]?.text, decentralized);
  const toolLead = await mcpCall(scratchEnv, [init, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hud_guide', arguments: { playbook: 'centralized' } } }]);
  assert.equal(toolLead.find((reply) => reply.id === 5)?.result?.content?.[0]?.text, lead);
  const toolBad = await mcpCall(scratchEnv, [init, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'hud_guide', arguments: { playbook: 'nope' } } }]);
  const badTool = toolBad.find((reply) => reply.id === 6)?.result;
  assert.equal(badTool?.isError, true);
  assert.match(badTool?.content?.[0]?.text ?? '', /decentralized \| lead \| centralized \| playbooks/);
} finally {
  await fetch(`${base}/api/shutdown`, { method: 'POST' }).catch(() => {});
  await Promise.race([serverExit, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (server.exitCode === null) server.kill('SIGTERM');
  await Promise.race([serverExit, new Promise((resolve) => setTimeout(resolve, 2000))]);
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('PASS coordination playbooks: decentralized and lead runbooks, failure modes, CLI, HTTP and MCP slices');
