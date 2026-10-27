// Coordination playbooks are copy-paste runbooks. One playbook must stand alone, shorter than the guide.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
assert.ok(decentralized.indexOf('### 0. Read a lead FACT') < decentralized.indexOf('### 1. Claim'));
assert.ok(decentralized.includes('hud_tickets {tag: "run"}'));
assert.ok(decentralized.includes('action: "scopes"'));
assert.ok(decentralized.includes(`run:${RUN_UUID}`));
assert.ok(decentralized.includes('hud guide lead'));
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
assert.ok(worker.includes('hud_tickets {tag: "run"}') && worker.includes('action: "scopes"') && worker.includes(`run:${RUN_UUID}`));
assert.ok(!lead.includes('run:EGO-'));

assert.equal(playbookText('centralized'), lead);
assert.equal(playbookText('LEAD'), lead);
assert.equal(coordinationDoc('playbooks', 1), index);
assert.equal(coordinationDoc('index', 1), index);
assert.ok(index.includes('hud guide decentralized'));
assert.ok(index.includes('hud guide lead'));
assert.ok(!index.includes('## Decentralized'));
assert.ok(!index.includes('hud_finish'));
assert.ok(index.includes('hud_tickets {tag: "run"}') && index.includes('action: "scopes"') && index.includes(`run:${RUN_UUID}`));
assert.ok(!guide.includes('run:EGO-'), 'GUIDE still demos a KEY-n as a run scope');
assert.ok(guide.includes(`run:${RUN_UUID}`));
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

console.log('PASS coordination playbooks: decentralized and lead runbooks, failure modes, CLI slices');
