// Keeps the user-facing README short, current and link-correct. No dependencies.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${msg}`);
};

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const guide = readFileSync(join(root, 'GUIDE.md'), 'utf8');
const lines = readme.split('\n').length;

ok(lines <= 100, `README is ${lines} lines; keep it under 100 (move detail to GUIDE.md/AGENTS.md)`);
ok(readme.includes('/releases/latest'), 'README links to /releases/latest');
ok(!/releases\/tag\/v\d/.test(readme), 'README must not pin an old release tag');
ok(!/\b0\.1\.[01]\b/.test(readme), 'README must not hard-code an old version');
ok(readme.includes('build/icon.svg'), 'README shows the logo');
ok(existsSync(join(root, 'build/icon.svg')), 'build/icon.svg exists');
ok(!/npm run dist/.test(readme), 'README leaves release mechanics to AGENTS.md');
ok(!/HUD_SCRATCH|HUD_SOURCE_ROOT/.test(readme), 'README leaves dev env vars to AGENTS.md');
ok(readme.includes('GUIDE.md'), 'README links the guide');

function slug(heading) {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, '')
    .replace(/\s+/g, '-');
}
const slugs = new Set(guide.split('\n').filter((l) => /^#{2,3} /.test(l)).map((l) => slug(l.replace(/^#+\s+/, ''))));
for (const m of readme.matchAll(/GUIDE\.md#([\w-]+)/g)) ok(slugs.has(m[1]), `README anchor GUIDE.md#${m[1]} resolves`);

const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const store = readFileSync(join(root, 'src/store.ts'), 'utf8');
const version = Number(/STATE_VERSION = (\d+)/.exec(store)?.[1]);
ok(Number.isFinite(version), 'STATE_VERSION is declared');
ok(agents.includes(`STATE_VERSION ${version}`), `AGENTS.md mentions the current state version (${version})`);

const change = agents.split(/^## /m).find((part) => part.startsWith('Change surfaces\n'));
ok(!!change, 'AGENTS.md has a Change surfaces section');
if (change) {
  for (const bit of [
    '- [ ] **Route.**',
    '- [ ] **Client.**',
    '- [ ] **MCP.**',
    '- [ ] **CLI.**',
    '- [ ] **GUIDE.**',
    'non-skippable',
    'route → client → MCP → CLI → GUIDE',
    'POST /api/items/:id/comments',
    'Hud.comment()',
    'hud_comment',
    "case 'comment'",
    'hud comment',
  ]) ok(change.includes(bit), `Change surfaces section includes ${bit}`);
}

if (failures) {
  console.error(`FAIL ${failures} docs check(s)`);
  process.exit(1);
}
console.log('PASS docs: README shape, release link, logo, GUIDE anchors, change surfaces');
