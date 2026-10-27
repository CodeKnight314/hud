// Keeps the user-facing README short, the human quickstart linked and shipped, and each doc's TOC matched to its sections.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guideText, quickstartText } from '../src/docs.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${msg}`);
};

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const guide = readFileSync(join(root, 'GUIDE.md'), 'utf8');
const quickstart = readFileSync(join(root, 'QUICKSTART.md'), 'utf8');
const lines = readme.split('\n').length;
const quickLines = quickstart.split('\n').length;

ok(lines <= 100, `README is ${lines} lines; keep it under 100 (move detail to QUICKSTART.md/GUIDE.md/AGENTS.md)`);
ok(readme.includes('/releases/latest'), 'README links to /releases/latest');
ok(readme.includes('latest stable release'), 'README names the latest stable release');
ok(!/releases\/tag\/v\d/.test(readme), 'README must not pin an old release tag');
ok(!/\b0\.1\.[01]\b/.test(readme), 'README must not hard-code an old version');
ok(readme.includes('build/icon.svg'), 'README shows the logo');
ok(existsSync(join(root, 'build/icon.svg')), 'build/icon.svg exists');
ok(!/npm run dist/.test(readme), 'README leaves release mechanics to AGENTS.md');
ok(!/HUD_SCRATCH|HUD_SOURCE_ROOT/.test(readme), 'README leaves dev env vars to AGENTS.md');
ok(readme.includes('GUIDE.md'), 'README links the guide');
ok(readme.includes('Developer ID') && readme.includes('notarized'), 'README says signed macOS releases are Developer ID-signed and notarized');
ok(readme.includes('Authenticode'), 'README says signed Windows installers are Authenticode-signed');
const signedReadme = readme.split(/Unsigned/)[0];
ok(!/right-click/.test(signedReadme), 'signed-release instructions do not use the right-click workaround');
ok(/Unsigned[\s\S]{0,400}right-click/.test(readme), 'the right-click workaround stays attached to unsigned builds');
ok(guide.includes('Developer ID') && guide.includes('Authenticode'), 'GUIDE distinguishes signed macOS and Windows releases');
ok(readme.includes('QUICKSTART.md'), 'README links the human quickstart');
ok(quickLines <= 120, `QUICKSTART is ${quickLines} lines; keep the human quickstart under 120`);
ok(quickstart.includes('/releases/latest'), 'QUICKSTART links to /releases/latest');
ok(!/releases\/tag\/v\d/.test(quickstart), 'QUICKSTART must not pin an old release tag');
ok(!/\b0\.1\.[01]\b/.test(quickstart), 'QUICKSTART must not hard-code an old version');
ok(!/npm run dist/.test(quickstart), 'QUICKSTART leaves release mechanics to AGENTS.md');
ok(!/HUD_SCRATCH|HUD_SOURCE_ROOT/.test(quickstart), 'QUICKSTART leaves dev env vars to AGENTS.md');
for (const id of ['install', 'settings', 'attention', 'tickets']) {
  ok(new RegExp(`^## ${id[0].toUpperCase()}${id.slice(1)}$`, 'm').test(quickstart), `QUICKSTART has a ${id} section`);
}

function slug(heading) {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, '')
    .replace(/\s+/g, '-');
}
function headingSlugs(markdown, levels) {
  return markdown.split('\n').filter((l) => levels.test(l)).map((l) => slug(l.replace(/^#+\s+/, '')));
}
/** The first markdown list before any section. Its anchors must equal the h2 slugs, in order. */
function tocAnchors(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^- \[/.test(l));
  if (start < 0) return [];
  const anchors = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    if (!/^- \[/.test(line) && !/^\s+\[/.test(line)) break;
    for (const m of line.matchAll(/\]\(#([\w-]+)\)/g)) anchors.push(m[1]);
  }
  return anchors;
}
function tocInSync(markdown, name) {
  const headings = headingSlugs(markdown, /^## [^#]/);
  const toc = tocAnchors(markdown);
  const same = toc.length === headings.length && toc.every((anchor, i) => anchor === headings[i]);
  ok(same, `${name} TOC is out of sync\n  TOC: ${toc.join(' | ') || '(none)'}\n  H2:  ${headings.join(' | ')}`);
}
tocInSync(guide, 'GUIDE');
tocInSync(quickstart, 'QUICKSTART');

const guideSlugs = new Set(headingSlugs(guide, /^#{2,3} [^#]/));
const quickSlugs = new Set(headingSlugs(quickstart, /^#{2,3} [^#]/));
for (const m of readme.matchAll(/GUIDE\.md#([\w-]+)/g)) ok(guideSlugs.has(m[1]), `README anchor GUIDE.md#${m[1]} resolves`);
for (const m of readme.matchAll(/QUICKSTART\.md#([\w-]+)/g)) ok(quickSlugs.has(m[1]), `README anchor QUICKSTART.md#${m[1]} resolves`);
for (const m of quickstart.matchAll(/GUIDE\.md#([\w-]+)/g)) ok(guideSlugs.has(m[1]), `QUICKSTART anchor GUIDE.md#${m[1]} resolves`);
for (const m of guide.matchAll(/QUICKSTART\.md#([\w-]+)/g)) ok(quickSlugs.has(m[1]), `GUIDE anchor QUICKSTART.md#${m[1]} resolves`);
ok(existsSync(join(root, 'QUICKSTART.md')), 'QUICKSTART.md exists');
ok(guide.includes('](QUICKSTART.md'), 'GUIDE links the quickstart with a relative path for the repo');

const servedGuide = guideText(7317);
const servedQuick = quickstartText(7317);
const style = readFileSync(join(root, 'STYLE.md'), 'utf8');
const styleSlug = slug((/^#\s+(.+)$/m.exec(style)?.[1] ?? '').trim());
const servedHeadings = new Set(headingSlugs(servedGuide, /^#{1,3} [^#]/));
/** A markdown link target the served text can open: in-page anchor or an absolute URL. */
function unresolvedLinks(markdown) {
  const found = [];
  for (const m of markdown.matchAll(/\]\(([^)\s]+)/g)) {
    const target = m[1];
    if (target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    found.push(target);
  }
  return found;
}
const guideLinks = unresolvedLinks(servedGuide);
const quickLinks = unresolvedLinks(servedQuick);
ok(guideLinks.length === 0, `served guide has relative links: ${guideLinks.join(', ') || '(none)'}`);
ok(quickLinks.length === 0, `served quickstart has relative links: ${quickLinks.join(', ') || '(none)'}`);
ok(servedGuide.includes('http://localhost:7317/api/quickstart'), 'served guide points at GET /api/quickstart');
ok(servedQuick.includes('http://localhost:7317/api/guide'), 'served quickstart points at GET /api/guide');
ok(styleSlug && servedGuide.includes(`](#${styleSlug})`), `served guide links STYLE.md to #${styleSlug || '?'}`);
ok(servedHeadings.has(styleSlug), `served guide includes the visual-contract heading #${styleSlug || '?'}`);
ok(servedGuide.includes('https://github.com/CodeKnight314/hud/blob/0.2.0/views/README.md'), 'served guide points views/README.md at GitHub');
for (const m of servedGuide.matchAll(/\/api\/quickstart#([\w-]+)/g)) ok(quickSlugs.has(m[1]), `served guide anchor /api/quickstart#${m[1]} resolves`);
for (const m of servedQuick.matchAll(/\/api\/guide#([\w-]+)/g)) ok(guideSlugs.has(m[1]), `served quickstart anchor /api/guide#${m[1]} resolves`);
for (const m of servedGuide.matchAll(/\]\(#([\w-]+)\)/g)) ok(servedHeadings.has(m[1]), `served guide in-page anchor #${m[1]} resolves`);

const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
ok(/from:\s*QUICKSTART\.md\s*\n\s*to:\s*hud\/QUICKSTART\.md/.test(builder), 'electron-builder ships QUICKSTART.md to hud/QUICKSTART.md');
ok(/from:\s*GUIDE\.md\s*\n\s*to:\s*hud\/GUIDE\.md/.test(builder), 'electron-builder ships GUIDE.md to hud/GUIDE.md');
const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf8');
ok(serverSrc.includes("'/api/quickstart'"), 'server registers GET /api/quickstart');
const cliSrc = readFileSync(join(root, 'src/cli.ts'), 'utf8');
ok(cliSrc.includes('guideText(') && cliSrc.includes('quickstartText('), 'CLI prints the served guide and quickstart');

const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const store = readFileSync(join(root, 'src/store.ts'), 'utf8');
const version = Number(/STATE_VERSION = (\d+)/.exec(store)?.[1]);
ok(Number.isFinite(version), 'STATE_VERSION is declared');
ok(agents.includes(`STATE_VERSION ${version}`), `AGENTS.md mentions the current state version (${version})`);
ok(existsSync(join(root, 'PRODUCT.md')), 'PRODUCT.md exists');
ok(readme.includes('PRODUCT.md'), 'README links PRODUCT.md');

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

if (failures) {
  console.error(`FAIL ${failures} docs check(s)`);
  process.exit(1);
}
console.log('PASS docs: README shape, human quickstart, shipped quickstart, PRODUCT.md link, latest stable links, version gates, GUIDE anchors, change surfaces match comments');
