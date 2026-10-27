// Persistence banner: loud, persistent, and non-dismissible when health reports a save or recovery problem.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistenceBannerHTML, persistenceNotice, restoreTarget } from '../web/persistence-banner.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

assert.equal(persistenceNotice(null), null);
assert.equal(persistenceNotice(undefined), null);
assert.equal(persistenceNotice({}), null);
assert.equal(persistenceNotice({ saveError: '   ', recoveredFrom: '' }), null);
assert.equal(persistenceNotice({ saveError: 12, recoveredFrom: null }), null);

const saving = persistenceNotice({ saveError: 'ENOSPC: no space left on device' });
assert.equal(saving.dismissible, false);
assert.equal(saving.glyph, '✕');
assert.match(saving.text, /not saving: ENOSPC: no space left on device/);
assert.deepEqual(saving.actions.map((action) => action.label), ['open data dir', 'restore']);
assert.deepEqual(saving.actions.map((action) => action.id), ['open-data-dir', 'restore']);

const recovered = persistenceNotice({ recoveredFrom: 'state-20261027-010101-kept.json' });
assert.equal(recovered.dismissible, false);
assert.equal(recovered.glyph, '▲');
assert.match(recovered.text, /recovered from backup state-20261027-010101-kept.json/);
assert.equal(recovered.saveError, '');

const both = persistenceNotice({ saveError: 'EACCES: permission denied', recoveredFrom: 'state-kept.json' });
assert.equal(both.glyph, '✕');
assert.match(both.text, /recovered from backup state-kept.json/);
assert.match(both.text, /not saving: EACCES: permission denied/);

const hostile = persistenceNotice({ saveError: '<img src=x onerror=alert(1)>', recoveredFrom: 'state-<x>.json' });
const html = persistenceBannerHTML(hostile);
assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.match(html, /state-&lt;x&gt;\.json/);
assert.equal((html.match(/<button\b/g) || []).length, 2);
assert.match(html, />open data dir</);
assert.match(html, />restore</);
assert.equal(html.includes('dismiss'), false);
assert.equal(html.includes('data-close'), false);
assert.equal(html.includes('×'), false);
assert.equal(html.includes('<img'), false);
assert.equal(persistenceBannerHTML(null), '');
assert.equal(persistenceBannerHTML({ ...saving, dismissible: true }), '');

assert.equal(restoreTarget(recovered, [{ name: 'state-newer.json' }]), 'state-20261027-010101-kept.json');
assert.equal(restoreTarget(saving, [{ name: 'state-newer.json' }, { name: 'state-older.json' }]), 'state-newer.json');
assert.equal(restoreTarget(saving, []), '');
assert.equal(restoreTarget(null, [{ name: 'state-newer.json' }]), '');

const page = read('web/index.html');
const app = read('web/app.js');
const css = read('web/style.css');
assert.match(page, /id="persistence-banner"[^>]*role="alert"[^>]*hidden/);
assert.equal(page.includes('data-persistence'), false, 'actions are rendered only from health, never as a static dismiss control');
assert.match(app, /persistenceNotice/);
assert.match(app, /persistenceBannerHTML/);
assert.match(app, /\/api\/data\/reveal/);
assert.match(app, /\/api\/backups\/\$\{encodeURIComponent\(name\)\}\/restore/);
assert.equal(app.includes('data-persistence="dismiss"'), false);
assert.equal(app.includes("data-persistence'] === 'dismiss'"), false);
assert.match(css, /#persistence-banner\[hidden\]\s*\{[^}]*display:\s*none/);
assert.match(css, /body\.persistence-alert/);
assert.match(css, /--chrome-top:\s*calc\(var\(--top-height\)\s*\+\s*var\(--persistence-banner-height/);
assert.match(css, /#canvas\s*\{[^}]*var\(--chrome-top\)/);
assert.match(css, /#rail\s*\{[^}]*var\(--chrome-top\)/);

console.log('PASS: persistence banner is loud, non-dismissible, and tied to saveError / recoveredFrom');
