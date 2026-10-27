// Guide slices: TOC anchors return one heading and its body, on the CLI and over HTTP.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asset } from '../src/assets.ts';
import { config } from '../src/config.ts';
import { guideText } from '../src/docs.ts';
import { coordinationDoc, fullGuide, guideToc, headingSlug, parseGuide, parseGuideResource, playbookText, renderGuide } from '../src/guide.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const norm = (s: string) => s.replace(/\s+$/, '');

assert.equal(headingSlug('Decisions (when you\'re blocked)'), 'decisions-when-youre-blocked');
assert.equal(headingSlug('Ways in (all equivalent)'), 'ways-in-all-equivalent');

const sample = [
  '# Doc',
  '',
  '- [Alpha](#alpha) · [Beta](#beta-two)',
  '',
  '## Alpha',
  'one',
  '',
  '### Nested',
  'inner',
  '',
  '## Beta two',
  'two',
  '',
  '```',
  '## Alpha',
  'not a heading',
  '```',
  '',
  '## Gamma',
  'three',
].join('\n');
const parsed = parseGuide(sample);
const by = (anchor: string) => {
  const found = parsed.find((s) => s.anchor === anchor);
  assert.ok(found, anchor);
  return found;
};
assert.equal(by('alpha').markdown, '## Alpha\none\n\n### Nested\ninner\n');
assert.equal(by('nested').level, 3);
assert.equal(by('nested').markdown, '### Nested\ninner\n');
assert.match(by('beta-two').markdown, /^## Beta two\n/);
assert.match(by('beta-two').markdown, /```\n## Alpha\nnot a heading\n```/);
assert.doesNotMatch(by('beta-two').markdown, /^## Gamma/m);
assert.equal(by('gamma').markdown, '## Gamma\nthree');
assert.equal(parsed.filter((s) => s.anchor === 'alpha').length, 1);

const guide = (asset('GUIDE.md', 'utf8') ?? '').replaceAll('{{PORT}}', '7317').replace(/\r\n/g, '\n');
const style = (asset('STYLE.md', 'utf8') ?? '').replace(/\r\n/g, '\n');
const fileSections = parseGuide(guide);
const h2 = fileSections.filter((s) => s.level === 2);
const body = guide.slice(guide.search(/^## /m));
const joined = h2.map((s) => s.markdown).join('\n');
assert.equal(norm(joined), norm(body), 'h2 slices must cover the guide from the first section through the end without gaps');
for (const section of fileSections) {
  assert.match(section.markdown, new RegExp(`^#{${section.level}} `));
  assert.equal(section.anchor, headingSlug(section.title), section.title);
}

const toc = guideToc(guide).map((entry) => entry.anchor);
assert.ok(toc.includes('coordination') && toc.includes('monitors'));
assert.equal(toc.includes('status'), false, 'the appended visual contract is not a guide slice');
assert.equal(toc.includes('surfaces'), false, 'the appended visual contract is not a guide slice');
const level2 = new Set(h2.map((s) => s.anchor));
for (const anchor of toc) assert.ok(level2.has(anchor), `TOC anchor ${anchor} is not an h2 slice`);

function unresolved(markdown: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)/g)) {
    const target = match[1];
    if (target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    found.push(target);
  }
  return found;
}

const full = renderGuide(7317, undefined, undefined);
assert.equal(full.status, 200);
assert.equal(full.type, 'text/markdown; charset=utf-8');
assert.equal(full.body, guideText(7317));
assert.equal(fullGuide(7317), guideText(7317));
assert.match(String(full.body), /^# hud /);
assert.match(String(full.body), /# HUD visual contract/);
assert.match(String(full.body), /\]\(#hud-visual-contract\)/);
assert.match(String(full.body), /https:\/\/github.com\/CodeKnight314\/hud\/blob\/0\.2\.0\/views\/README\.md/);
assert.deepEqual(unresolved(String(full.body)), []);
assert.doesNotMatch(String(full.body), /\{\{PORT\}\}/);
const guideModule = readFileSync(join(root, 'src/guide.ts'), 'utf8');
const docsModule = readFileSync(join(root, 'src/docs.ts'), 'utf8');
assert.match(guideModule, /guideText\(/);
assert.doesNotMatch(guideModule, /asset\(\s*['"](?:GUIDE|STYLE|QUICKSTART)\.md['"]/);
assert.doesNotMatch(guideModule, /\]\((?:\.\/)?(?:GUIDE|STYLE|QUICKSTART|views\/README)\.md/);
assert.match(docsModule, /export function guideText/);
assert.match(docsModule, /export function quickstartText/);
assert.match(docsModule, /The only served-doc builder/);
for (const file of ['src/server.ts', 'src/cli.ts', 'src/mcp.ts', 'src/client.ts']) {
  assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /asset\(\s*['"](?:GUIDE|STYLE|QUICKSTART)\.md['"]/, file);
}

const coordination = renderGuide(7317, 'coordination', undefined);
assert.equal(coordination.status, 200);
assert.match(String(coordination.body), /^## Coordination\n/);
assert.match(String(coordination.body), /hud_claim/);
assert.doesNotMatch(String(coordination.body), /^## Shared context/m);
assert.doesNotMatch(String(coordination.body), /^## Projects, tickets and links/m);
assert.ok(String(coordination.body).length < String(full.body).length);
assert.ok(String(coordination.body).length > 200);

const monitors = renderGuide(7317, 'monitors', 'markdown');
assert.equal(monitors.type, 'text/markdown; charset=utf-8');
assert.match(String(monitors.body), /^## Monitors\n/);
assert.match(String(monitors.body), /localhost:7317\/ping/);
assert.doesNotMatch(String(monitors.body), /\{\{PORT\}\}/);
assert.match(String(monitors.body), /^### Metrics, observations and freshness/m);
assert.match(String(monitors.body), /^### Composite monitors and plot context/m);
assert.doesNotMatch(String(monitors.body), /^## Renderers/m);
assert.doesNotMatch(String(monitors.body), /^## Coordination/m);
assert.ok(String(monitors.body).length < String(full.body).length / 2);

assert.equal(renderGuide(7317, 'metrics-observations-and-freshness', null).status, 400);
assert.equal(renderGuide(7317, 'utilities', null).status, 200, 'utilities is a guide h2');
assert.equal(renderGuide(7317, 'conventions', null).status, 200, 'conventions is a guide h2');
assert.equal(renderGuide(7317, 'palette-and-state', null).status, 400);
assert.equal(String(renderGuide(7317, '#coordination', null).body), String(coordination.body));
assert.equal(String(renderGuide(7317, 'DECISIONS-WHEN-YOURE-BLOCKED', null).body).startsWith('## Decisions'), true);

const renderers = renderGuide(7317, 'renderers', null);
assert.match(String(renderers.body), /^## Renderers\n/);
assert.doesNotMatch(String(renderers.body), /^## Utilities/m);
assert.doesNotMatch(String(renderers.body), /^## Attention, runs and incremental changes/m);
assert.match(String(renderers.body), /\]\(http:\/\/localhost:7317\/api\/guide#hud-visual-contract\)/);
assert.doesNotMatch(String(renderers.body), /\]\(#hud-visual-contract\)/);
assert.match(String(renderers.body), /https:\/\/github.com\/CodeKnight314\/hud\/blob\/0\.2\.0\/views\/README\.md/);
assert.deepEqual(unresolved(String(renderers.body)), []);
const trash = renderGuide(7317, 'trash-backups-and-undo', null);
assert.match(String(trash.body), /^## Trash, backups and undo\n/);
assert.doesNotMatch(String(trash.body), /^## Conventions/m);
assert.doesNotMatch(String(trash.body), /^## Install hud as an app/m);

const connect = renderGuide(7317, 'connect-your-agent', null);
assert.match(String(connect.body), /^## Connect your agent\n/);
assert.doesNotMatch(String(connect.body), /## Status/);
assert.match(style, /## Status/);
const tocSlices = toc.map((anchor) => {
  const rendered = renderGuide(7317, anchor, null);
  assert.equal(rendered.status, 200, anchor);
  return String(rendered.body);
});
const servedGuide = guideText(7317).replace(/\r\n/g, '\n');
const guideLines = servedGuide.split('\n');
let h1s = 0;
let styleAt = guideLines.length;
for (let i = 0; i < guideLines.length; i++) {
  if (guideLines[i].startsWith('# ')) {
    h1s++;
    if (h1s === 2) { styleAt = i; break; }
  }
}
const guideHalf = guideLines.slice(0, styleAt).join('\n').replace(/\n+$/, '')
  .replaceAll('](#hud-visual-contract)', '](http://localhost:7317/api/guide#hud-visual-contract)');
assert.equal(norm(tocSlices.join('\n')), norm(guideHalf.slice(guideHalf.search(/^## /m))), 'TOC slices are the GUIDE half of guideText');
const folded = tocSlices.join('\n').replaceAll('](http://localhost:7317/api/guide#', '](#');
assert.ok(servedGuide.includes(folded), 'a slice folds back into guideText');

const catalog = renderGuide(7317, '', 'json');
assert.equal(catalog.status, 200);
assert.equal(catalog.type, 'application/json');
assert.ok(catalog.body && typeof catalog.body === 'object' && 'sections' in catalog.body);
const listed = catalog.body.sections;
assert.equal('markdown' in listed[0], false);
const anchors = listed.map((s) => s.anchor);
assert.deepEqual(anchors, toc);
assert.equal(anchors.includes('status'), false, 'the appended visual contract is not a catalog section');
assert.equal(anchors.includes('surfaces'), false, 'the appended visual contract is not a catalog section');
assert.equal(anchors.includes('palette-and-state'), false);
assert.equal(anchors.includes('metrics-observations-and-freshness'), false);

const one = renderGuide(7317, 'Monitors', 'json');
assert.equal(one.status, 200);
assert.ok(one.body && typeof one.body === 'object' && 'markdown' in one.body);
assert.equal(one.body.anchor, 'monitors');
assert.equal(one.body.title, 'Monitors');
assert.equal(one.body.level, 2);
assert.equal(one.body.markdown, monitors.body);

const missing = renderGuide(7317, 'nope', null);
assert.equal(missing.status, 400);
assert.equal(missing.type, 'application/json');
assert.ok(missing.body && typeof missing.body === 'object' && 'error' in missing.body);
assert.match(missing.body.error, /unknown guide section "nope"/);
assert.ok(missing.body.sections?.includes('coordination'));
assert.ok(missing.body.sections?.includes('monitors'));
assert.deepEqual(missing.body.sections, toc);
assert.equal(missing.body.sections?.includes('status'), false, 'the appended visual contract is not a guide slice');
const both = renderGuide(7317, { section: 'monitors', playbook: 'lead' });
assert.equal(both.status, 400);
assert.match(String((both.body as { error?: string }).error), /section or playbook/);
const unknownPlay = renderGuide(7317, { playbook: 'nope' });
assert.equal(unknownPlay.status, 400);
assert.match(String((unknownPlay.body as { error?: string }).error), /unknown playbook/);
assert.doesNotMatch(String((unknownPlay.body as { error?: string }).error), /unknown guide section/);
assert.equal(coordinationDoc('centralized', 7317), playbookText('lead'));
assert.equal(coordinationDoc('LEAD', 7317), playbookText('lead'));
assert.equal(String(renderGuide(7317, { playbook: 'lead' }).body), playbookText('lead'));
assert.equal(String(renderGuide(7317, { playbook: 'centralized' }).body), playbookText('lead'));
assert.equal(coordinationDoc('playbooks', 7317), playbookText('playbooks'));
assert.equal(coordinationDoc('index', 7317), playbookText('playbooks'));
assert.equal(coordinationDoc(undefined, 7317), fullGuide(7317));
assert.equal(coordinationDoc('  ', 7317), fullGuide(7317));
assert.equal(fullGuide(7317), full.body);
const badFormat = renderGuide(7317, 'monitors', 'html');
assert.equal(badFormat.status, 400);
assert.match(String((badFormat.body as { error?: string }).error), /format/);

assert.deepEqual(parseGuideResource('hud://guide'), { section: undefined });
assert.deepEqual(parseGuideResource('hud://guide#monitors'), { section: 'monitors' });
assert.deepEqual(parseGuideResource('hud://guide?section=coordination'), { section: 'coordination' });
assert.deepEqual(parseGuideResource('hud://guide?section=monitors#coordination'), { section: 'monitors' });
assert.deepEqual(parseGuideResource('hud://guide?playbook=lead'), { playbook: 'lead' });
assert.deepEqual(parseGuideResource('hud://playbook/decentralized'), { playbook: 'decentralized' });
assert.equal(parseGuideResource('hud://other'), undefined);
assert.equal(parseGuideResource('https://example.com/guide'), undefined);

const source = asset('GUIDE.md', 'utf8') ?? '';
assert.match(source, /hud guide --section/);
assert.match(source, /\/api\/guide\?section=/);
assert.match(source, /GET \/api\/guide(?!\?)/);
assert.match(source, /\bhud guide(?!\s+--section\b)/);
assert.match(source, /hud_guide/);

function run(args: string[]) {
  return spawnSync(process.execPath, ['bin/hud.js', ...args], { cwd: root, encoding: 'utf8' });
}
const strip = (s: string) => s.replace(/\n+$/, '');
const port = config().port;
const cli = run(['guide', '--section', 'monitors']);
assert.equal(cli.status, 0, cli.stderr);
assert.equal(strip(cli.stdout), strip(String(renderGuide(port, 'monitors', 'markdown').body)));
assert.match(cli.stdout, new RegExp(`localhost:${port}/ping`));
assert.doesNotMatch(cli.stdout, /\{\{PORT\}\}/);
assert.doesNotMatch(cli.stdout, /^## Renderers/m);

const cliSection = run(['guide', '--section', 'coordination']);
assert.equal(cliSection.status, 0, cliSection.stderr);
assert.match(cliSection.stdout, /^## Coordination\n/);
assert.doesNotMatch(cliSection.stdout, /^## Shared context/m);
assert.ok(cliSection.stdout.length < run(['guide']).stdout.length);

const cliBad = run(['guide', '--section', 'nope']);
assert.equal(cliBad.status, 2, cliBad.stdout);
assert.match(cliBad.stderr, /unknown guide section "nope"/);
assert.match(cliBad.stderr, /\bcoordination\b/);
assert.match(cliBad.stderr, /\bmonitors\b/);

const cliJson = run(['guide', '--json']);
assert.equal(cliJson.status, 0, cliJson.stderr);
const cliCatalog = JSON.parse(cliJson.stdout);
assert.ok(cliCatalog.sections.some((s: { anchor: string; level: number }) => s.anchor === 'coordination' && s.level === 2));
assert.doesNotMatch(cliJson.stdout, /source\.kind/);

const cliSlice = JSON.parse(run(['guide', '--section', 'coordination', '--json']).stdout);
assert.equal(cliSlice.anchor, 'coordination');
assert.match(cliSlice.markdown, /^## Coordination\n/);
assert.doesNotMatch(cliSlice.markdown, /^## Shared context/m);

const cliPlay = run(['guide', 'nope']);
assert.equal(cliPlay.status, 2, cliPlay.stdout);
assert.match(cliPlay.stderr, /unknown playbook/);
const cliAlias = run(['guide', 'centralized']);
assert.equal(cliAlias.status, 0, cliAlias.stderr);
assert.equal(strip(cliAlias.stdout), strip(playbookText('lead')));
const cliLead = run(['guide', 'lead']);
assert.equal(cliLead.status, 0, cliLead.stderr);
assert.equal(strip(cliLead.stdout), strip(playbookText('lead')));
const cliBoth = run(['guide', '--section', 'monitors', '--playbook', 'lead']);
assert.equal(cliBoth.status, 2, cliBoth.stdout);
assert.match(cliBoth.stderr, /section or playbook/);
const cliBare = run(['guide']);
assert.equal(cliBare.status, 0, cliBare.stderr);
assert.match(cliBare.stdout, /^# hud /);
assert.match(cliBare.stdout, /# HUD visual contract/);
assert.match(cliBare.stdout, /\]\(#hud-visual-contract\)/);
assert.doesNotMatch(cliBare.stdout, /\]\(STYLE\.md\)/);

const help = run(['guide', '--help']);
assert.equal(help.status, 0);
assert.match(help.stdout, /--section/);
assert.match(help.stdout, /--playbook/);
assert.match(help.stdout, /--json/);

function mcpTools(): Promise<{ name: string; description: string; inputSchema: { properties?: Record<string, { type?: string; enum?: string[] }> } }[]> {
  const data = mkdtempSync(join(tmpdir(), 'hud-mcp-guide-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/mcp.ts'], {
      cwd: root,
      env: { ...process.env, HUD_SCRATCH: '1', HUD_PORT: '9', HUD_DATA: data, HUD_PROBES: join(data, 'probes'), HUD_VIEWS: join(data, 'views') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mcp tools/list timed out\n${out}\n${err}`));
    }, 8000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    child.stdin.end();
    child.on('close', () => {
      clearTimeout(timer);
      rmSync(data, { recursive: true, force: true });
      const line = out.split('\n').find((entry) => entry.includes('"tools"'));
      if (!line) return reject(new Error(`no mcp response\n${out}\n${err}`));
      resolve(JSON.parse(line).result.tools);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const n = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(n));
    });
  });
}

async function httpSlices() {
  const data = mkdtempSync(join(tmpdir(), 'hud-guide-'));
  const listen = await freePort();
  let logs = '';
  const child = spawn(process.execPath, ['bin/hud.js', 'serve'], {
    cwd: root,
    env: {
      ...process.env,
      HUD_SCRATCH: '1',
      HUD_PORT: String(listen),
      HUD_DATA: data,
      HUD_PROBES: join(data, 'probes'),
      HUD_VIEWS: join(data, 'views'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${listen}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      if (child.exitCode !== null) break;
      try {
        const health = await fetch(`${base}/api/health`);
        up = health.ok;
      } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(up, true, `scratch server did not start on ${listen}\n${logs}`);

    const slice = await fetch(`${base}/api/guide?section=coordination`);
    assert.equal(slice.status, 200);
    assert.match(slice.headers.get('content-type') ?? '', /text\/markdown/);
    const sliceText = await slice.text();
    assert.match(sliceText, /^## Coordination\n/);
    assert.doesNotMatch(sliceText, /^## Shared context/m);

    const monitorRes = await fetch(`${base}/api/guide?section=monitors`);
    const monitorText = await monitorRes.text();
    assert.match(monitorText, /^## Monitors\n/);
    assert.match(monitorText, new RegExp(`localhost:${listen}/ping`));
    assert.doesNotMatch(monitorText, /^## Renderers/m);

    const listedRes = await fetch(`${base}/api/guide?format=json`);
    assert.equal(listedRes.status, 200);
    assert.match(listedRes.headers.get('content-type') ?? '', /application\/json/);
    const listedJson = await listedRes.json() as { sections: { anchor: string }[] };
    assert.ok(listedJson.sections.some((s) => s.anchor === 'monitors'));
    assert.ok(listedJson.sections.some((s) => s.anchor === 'coordination'));

    const oneRes = await fetch(`${base}/api/guide?section=renderers&format=json`);
    const oneJson = await oneRes.json() as { anchor: string; markdown: string };
    assert.equal(oneRes.status, 200);
    assert.equal(oneJson.anchor, 'renderers');
    assert.match(oneJson.markdown, /^## Renderers\n/);
    assert.doesNotMatch(oneJson.markdown, /^## Utilities/m);
    assert.doesNotMatch(oneJson.markdown, /^## Attention, runs and incremental changes/m);
    assert.match(oneJson.markdown, new RegExp(`\\]\\(http://localhost:${listen}/api/guide#hud-visual-contract\\)`));
    assert.doesNotMatch(oneJson.markdown, /\]\(#hud-visual-contract\)/);
    assert.deepEqual(unresolved(oneJson.markdown), []);

    const bad = await fetch(`${base}/api/guide?section=nope`);
    assert.equal(bad.status, 400);
    const err = await bad.json() as { error: string; sections: string[] };
    assert.match(err.error, /unknown guide section "nope"/);
    assert.ok(err.sections.includes('coordination'));
    assert.ok(err.sections.includes('monitors'));
    assert.equal(err.sections.includes('status'), false, 'the appended visual contract is not a guide slice');
    assert.equal(err.sections.includes('palette-and-state'), false);

    const play = await fetch(`${base}/api/guide?playbook=nope`);
    assert.equal(play.status, 400);
    const playErr = await play.json() as { error: string };
    assert.match(playErr.error, /unknown playbook/);
    const leadRes = await fetch(`${base}/api/guide?playbook=lead`);
    assert.equal(leadRes.status, 200);
    assert.match(leadRes.headers.get('content-type') ?? '', /text\/markdown/);
    assert.equal((await leadRes.text()).trimEnd(), playbookText('lead').trimEnd());
    const alias = await fetch(`${base}/api/guide?playbook=centralized`);
    assert.equal(alias.status, 200);
    assert.equal((await alias.text()).trimEnd(), playbookText('lead').trimEnd());
    const clash = await fetch(`${base}/api/guide?section=monitors&playbook=lead`);
    assert.equal(clash.status, 400);

    const whole = await fetch(`${base}/api/guide`);
    const wholeText = await whole.text();
    assert.equal(whole.status, 200);
    assert.match(wholeText, /^# hud /);
    assert.match(wholeText, /# HUD visual contract/);
    assert.ok(wholeText.length > monitorText.length);
    assert.equal(wholeText, guideText(listen));
    assert.match(wholeText, /\]\(#hud-visual-contract\)/);
    assert.deepEqual(unresolved(wholeText), []);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(data, { recursive: true, force: true });
  }
}

const tools = await mcpTools();
const hudGuide = tools.find((tool) => tool.name === 'hud_guide');
assert.ok(hudGuide, 'hud_guide is listed');
assert.equal(hudGuide.inputSchema.properties?.section?.type, 'string');
assert.ok(hudGuide.inputSchema.properties?.playbook?.enum?.includes('decentralized'));
assert.ok(hudGuide.inputSchema.properties?.playbook?.enum?.includes('lead'));
assert.ok(hudGuide.inputSchema.properties?.format?.enum?.includes('json'));
assert.match(hudGuide.description, /section/i);
assert.match(hudGuide.description, /playbook/i);
assert.match(hudGuide.description, /omit section and playbook/i);
assert.match(hudGuide.description, /whole guide/i);

await httpSlices();

console.log('PASS guide slices: TOC anchors, CLI --section, JSON catalog, playbook alias, GET /api/guide?section=');
