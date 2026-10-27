import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { deleteViewFile, formatViewReview, generateViewCode, installUntrustedView, listViewInfos, readViewFile, setViewsDir, validateViewCode, VIEW_KINDS, writeViewFile } from '../src/views.ts';

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

// caller-supplied modules are untrusted: a review diff is surfaced and nothing lands until that exact review is approved
const remote = "export function render() { return '<div>' + esc('remote') + '</div>'; }\n";
const absent = (name: string) => readdirSync(dir).includes(`${name}.js`);
const staged = installUntrustedView('remote-mod', { code: remote, now: 1_000, ttlMs: 60_000 });
assert.equal(staged.installed, false);
assert.equal(staged.trust, 'untrusted');
assert.equal(absent('remote-mod'), false, 'staging a remote module does not write it');
assert.match(staged.diff, /\+export function render/);
const reviewText = formatViewReview(staged);
assert.match(reviewText, /NOT INSTALLED/);
assert.match(reviewText, /remote-mod/);
assert.match(reviewText, new RegExp(staged.id));
assert.match(reviewText, /\+export function render/);

assert.throws(() => installUntrustedView('remote-mod', { approve: true, code: remote, sha256: staged.sha256, now: 1_000 }), /approval/);
assert.equal(absent('remote-mod'), false, 'approve on the submit itself does not install');
assert.throws(() => installUntrustedView('remote-mod', { approve: true, proposalId: 'not-a-review', sha256: staged.sha256, now: 1_000 }), /approval/);
assert.equal(absent('remote-mod'), false, 'an unknown review cannot install a module');
assert.throws(() => installUntrustedView('remote-mod', { approve: true, proposalId: staged.id, sha256: '0'.repeat(64), now: 1_000 }), /reviewed/);
assert.equal(absent('remote-mod'), false, 'a mismatched sha256 cannot install a module');
const other = "export function render() { return '<div>' + esc('other') + '</div>'; }\n";
assert.throws(() => installUntrustedView('remote-mod', { approve: true, proposalId: staged.id, sha256: staged.sha256, code: other, now: 1_000 }), /reviewed|approval/);
assert.equal(absent('remote-mod'), false, 'different code cannot ride along with an approval');

const installed = installUntrustedView('remote-mod', { approve: true, proposalId: staged.id, sha256: staged.sha256, now: 1_000 });
assert.equal(installed.installed, true);
assert.equal(readViewFile('remote-mod'), remote);
assert.throws(() => installUntrustedView('remote-mod', { approve: true, proposalId: staged.id, sha256: staged.sha256, now: 1_000 }), /approval/);
assert.equal(readViewFile('remote-mod'), remote, 'a spent review cannot write again');

const expired = installUntrustedView('expired-mod', { code: remote, now: 2_000, ttlMs: 0 });
assert.equal(expired.installed, false);
assert.match(formatViewReview(expired), /NOT INSTALLED/);
assert.throws(() => installUntrustedView('expired-mod', { approve: true, proposalId: expired.id, sha256: expired.sha256, now: 2_000 }), /approval/);
assert.equal(absent('expired-mod'), false, 'an expired review cannot install a module');

assert.throws(() => installUntrustedView('blocked-mod', { code: "export function render() { return fetch('/api/state'); }" }), /did not validate/);
assert.equal(absent('blocked-mod'), false, 'a module that fails static checks is not staged or written');

const nextCode = "export function render() { return '<div>' + esc('next') + '</div>'; }\n";
const pending = installUntrustedView('remote-mod', { code: nextCode, overwrite: true, now: 3_000, ttlMs: 60_000 });
assert.equal(pending.installed, false);
assert.match(pending.diff, /^-export function render/m);
assert.match(pending.diff, /^\+export function render/m);
assert.equal(readViewFile('remote-mod'), remote, 'a replacement review leaves the installed module untouched');
writeViewFile('remote-mod', other, { overwrite: true });
assert.throws(() => installUntrustedView('remote-mod', { approve: true, proposalId: pending.id, sha256: pending.sha256, now: 3_000 }), /changed since/);
assert.equal(readViewFile('remote-mod'), other, 'approval does not overwrite a module that changed after review');

assert.throws(() => installUntrustedView('remote-mod', { code: remote, now: 4_000 }), /already exists/);
assert.equal(readViewFile('remote-mod'), other);

deleteViewFile('remote-mod');

console.log('PASS generated view modules: templates, static validation, writes and deletes');
