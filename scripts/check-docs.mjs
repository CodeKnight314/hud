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
ok(readme.includes('latest stable release'), 'README names the latest stable release');
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

// The comments worked example is a copy target. These tokens have to exist on the
// live surfaces, or a rename leaves AGENTS.md describing code that is gone.
const server = readFileSync(join(root, 'src/server.ts'), 'utf8');
const client = readFileSync(join(root, 'src/client.ts'), 'utf8');
const mcp = readFileSync(join(root, 'src/mcp.ts'), 'utf8');
const cli = readFileSync(join(root, 'src/cli.ts'), 'utf8');
ok(
  /route\('POST', '\/api\/items\/:id\/comments'[\s\S]{0,400}?store\.comment\(/.test(server),
  'comments example route: POST /api/items/:id/comments calls store.comment()',
);
ok(
  /comment\(id: string, text: string[\s\S]{0,240}?\/api\/items\/\$\{encodeURIComponent\(id\)\}\/comments/.test(client),
  'comments example client: Hud.comment() posts /api/items/:id/comments',
);
ok(mcp.includes("name: 'hud_comment'"), 'comments example MCP: TOOLS names hud_comment');
ok(
  /case 'hud_comment':[\s\S]{0,1200}?hud\.comment\(/.test(mcp),
  "comments example MCP: case 'hud_comment' calls hud.comment()",
);
const help = /const HELP = `([\s\S]*?)`;/.exec(cli)?.[1] ?? '';
ok(help.includes('hud comment <id>'), 'comments example CLI: HELP documents hud comment');
ok(/^\s*comment:\s*\{[^}\n]*hud comment/m.test(cli), 'comments example CLI: CMDS has a comment entry');
ok(
  /case 'comment':[\s\S]{0,900}?hud\.comment\(/.test(cli),
  "comments example CLI: case 'comment' calls hud.comment()",
);
const ways = guide.split(/^## /m).find((part) => part.startsWith('Ways in'));
ok(!!ways, 'GUIDE.md has a Ways in section');
if (ways) {
  for (const bit of ['POST /api/items/:id/comments', '`hud comment`', '`hud_comment`']) {
    ok(ways.includes(bit), `comments example GUIDE Ways in includes ${bit}`);
  }
}

ok(guide.includes('/releases/latest'), 'GUIDE links downloads to /releases/latest');
ok(guide.includes('latest stable release'), 'GUIDE names the latest stable release');
ok(!/releases\/tag\/v\d/.test(guide), 'GUIDE must not pin a release tag for downloads');
ok(guide.includes('update checker has existed since 0.1.1'), 'GUIDE keeps the update-checker version gate');
ok(guide.includes('0.1.0 has none'), 'GUIDE keeps the 0.1.0 manual-upgrade gate');
ok(guide.includes('leave every published stable release unchanged'), 'GUIDE does not freeze one historical release');
ok(!/v0\.1\.0/.test(agents), 'AGENTS.md must not treat v0.1.0 as the standing release');
ok(agents.includes('published stable releases unchanged'), 'AGENTS.md leaves published releases unchanged');

const workflow = readFileSync(join(root, '.github/workflows/build.yml'), 'utf8');
ok(workflow.includes('latest stable download'), 'draft release notes point at the latest stable download');
ok(workflow.includes('update checker has existed since 0.1.1'), 'draft release notes keep the update-checker version gate');
ok(workflow.includes('0.1.0 has none'), 'draft release notes keep the 0.1.0 manual-upgrade gate');
ok(!/releases\/tag\/v\d/.test(workflow), 'release workflow must not pin a download tag');

if (failures) {
  console.error(`FAIL ${failures} docs check(s)`);
  process.exit(1);
}
console.log('PASS docs: README shape, latest stable links, version gates, GUIDE anchors, change surfaces match comments');
