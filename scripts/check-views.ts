import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { deleteViewFile, generateViewCode, listViewInfos, readViewFile, setViewsDir, validateViewCode, VIEW_KINDS, writeViewFile } from '../src/views.ts';

const dir = mkdtempSync(join(tmpdir(), 'hud-views-'));
setViewsDir(dir);

const item = {
  id: 'm', type: 'monitor', value: 42, unit: 'ms', max: 100, progress: 42,
  history: Array.from({ length: 30 }, (_, i) => ({ t: 1000 + i * 60_000, v: 10 + i, s: 'ok', p: null })),
  meta: { categories: [{ name: 'a', value: 3 }, { name: 'b', value: 7 }], points: [[1, 2], [2, 5], [3, 4]], grid: [[1, 2], [3, 4]] },
  data: { columns: [{ key: 'name' }, { key: 'value', type: 'number' }], rows: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }] },
};
const helpers = {
  esc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)),
  fmt: (v: unknown) => String(v ?? '—'),
  clamp: (v: number, a: number, b: number) => Math.max(a, Math.min(b, v)),
  seriesOf: () => ({ pts: item.history.map((h) => ({ t: h.t, v: h.v })), allPts: [], key: 'v' }),
  categoriesOf: () => item.meta.categories,
  pointsOf: () => item.meta.points,
  gridOf: () => ({ rows: item.meta.grid, width: 2, height: 2 }),
  rangeOf: () => ({ lo: 0, hi: 50 }),
  svg: (it: any, cls: string, w: number, h: number, body: string) => `<svg class="${cls}" width="${w}" height="${h}">${body}</svg>`,
};

function executable(code: string) {
  const plain = code
    .replace(/^\s*export\s+default\s+function\s+(\w+)/gm, 'function $1')
    .replace(/^\s*export\s+default\s+/gm, 'const __default = ')
    .replace(/^\s*export\s+(const|let|var|function|class)\s+/gm, '$1 ');
  return `${plain}\n;({ render: typeof render === 'function' ? render : (typeof __default === 'function' ? __default : __default?.render) })`;
}

for (const kind of VIEW_KINDS) {
  const name = `check-${kind}`;
  const code = generateViewCode(name, { kind, series: kind === 'bar' ? 'categories' : kind === 'scatter' ? 'points' : kind === 'heatmap' ? 'grid' : undefined, unit: 'ms', max: 100, targets: [{ value: 80 }], thresholds: { warn: 60, error: 90 } });
  const v = validateViewCode(code);
  assert.equal(v.ok, true, `${kind}: ${v.errors.join('; ')}`);
  assert.match(code, /export function render/);
  const api = runInNewContext(executable(code), { helpers });
  const out = api.render({ item, w: 420, h: 160, helpers });
  assert.equal(typeof out, 'string', `${kind} returns markup`);
  assert.ok(out.length > 0, `${kind} returns something visible`);
  assert.ok(!/<script|<img|NaN|Infinity/.test(out), `${kind} output is safe and finite: ${out.slice(0, 120)}`);
}

// static validation rejects code that can escape the page
const bad = [
  ['no render', 'export const x = 1;'],
  ['import', "import x from '/views.js'; export function render() { return ''; }"],
  ['dynamic import', "export function render() { return import('/x.js'); }"],
  ['fetch', "export function render() { return fetch('/api/state'); }"],
  ['eval', "export function render() { return eval('1'); }"],
  ['script tag', "export function render() { return '<script>alert(1)</script>'; }"],
  ['storage', "export function render() { return localStorage.getItem('x'); }"],
  ['handler', "export function render() { return '<div onclick=\"x\">x</div>'; }"],
];
for (const [label, code] of bad) {
  const v = validateViewCode(code);
  assert.equal(v.ok, false, `${label} must be rejected`);
  assert.ok(v.errors.length > 0, `${label} reports an error`);
}
assert.equal(validateViewCode('export function render( {').ok, false, 'syntax errors are reported');

// write / read / list / overwrite / delete
const wrote = writeViewFile('check-file', generateViewCode('check-file', { kind: 'bar' }));
assert.match(wrote.path, /check-file\.js$/);
assert.equal(readViewFile('check-file'), generateViewCode('check-file', { kind: 'bar' }));
assert.throws(() => writeViewFile('check-file', generateViewCode('check-file', { kind: 'line' })), /already exists/);
const replaced = writeViewFile('check-file', generateViewCode('check-file', { kind: 'line' }), { overwrite: true });
assert.notEqual(replaced.sha256, wrote.sha256);
assert.throws(() => writeViewFile('check-file', generateViewCode('check-file', { kind: 'bar' }), { overwrite: true, expectedSha256: wrote.sha256 }), /changed since/);
const infos = listViewInfos();
assert.ok(infos.some((v) => v.name === 'check-file' && v.validation.ok));
deleteViewFile('check-file');
assert.equal(readdirSync(dir).includes('check-file.js'), false);
assert.throws(() => readViewFile('check-file'), /no view named/);

// a view with a blocked construct never lands on disk
assert.throws(() => writeViewFile('bad-view', "export function render() { return fetch('/api/state'); }"), /did not validate/);
assert.equal(readdirSync(dir).includes('bad-view.js'), false);

writeFileSync(join(dir, 'unrelated.txt'), 'ignored');
assert.equal(listViewInfos().some((v) => v.name === 'unrelated'), false, 'non-js files are ignored');

console.log('PASS generated view modules: templates, static validation, writes and deletes');
