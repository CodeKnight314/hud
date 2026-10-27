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

assert.ok(lead.startsWith('## Lead\n'));
assert.ok(!lead.includes('## Decentralized'));
assert.ok(lead.includes('hud_project'));
assert.ok(lead.includes('blockedBy'));
assert.ok(lead.includes('assignee'));
assert.ok(lead.includes('parent'));
assert.ok(lead.includes('tags: ["run"]'));
assert.ok(lead.includes('### Worker loop'));
order(lead, ['### Lead loop', '### Worker loop', '### Expired lease'], 'lead roles');

assert.equal(playbookText('centralized'), lead);
assert.equal(playbookText('LEAD'), lead);
assert.equal(coordinationDoc('playbooks', 1), index);
assert.equal(coordinationDoc('index', 1), index);
assert.ok(index.includes('hud guide decentralized'));
assert.ok(index.includes('hud guide lead'));
assert.ok(!index.includes('## Decentralized'));
assert.ok(!index.includes('hud_finish'));
assert.ok(guide.includes('hud guide decentralized') && guide.includes('GET /api/guide?playbook=lead'));
assert.ok(guide.includes('## Monitors'));
assert.equal(coordinationDoc(undefined, 7317), guide);
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
const bad = cli(['guide', 'nope']);
assert.equal(bad.status, 2);
assert.match(bad.stderr, /unknown playbook/);

console.log('PASS coordination playbooks: decentralized and lead runbooks, failure modes, CLI slices');
