import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { app, BrowserWindow } from 'electron';

const requestedBase = process.argv[2] || 'http://127.0.0.1:7399/';
const artifactDir = process.argv[3] || null;

function loopbackBase(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (url.protocol !== 'http:' || !loopback.has(host) || !url.port || Number(url.port) === 7317) throw new Error('base URL must be an explicit loopback HTTP scratch port other than 7317');
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}
const base = loopbackBase(requestedBase);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonRequest(path, init = {}) {
  const headers = { 'x-hud-actor': 'ui-coordination-check', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) };
  const res = await fetch(new URL(path, base), { ...init, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${body.error || ''}`);
  return body;
}

async function seed() {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const board = await jsonRequest('/api/boards', { method: 'POST', body: { name: `UI coordination ${nonce}` } });
  const run = await jsonRequest('/api/items', { method: 'POST', body: {
    id: `ui-${nonce}-run`, type: 'ticket', board: board.id, title: `Queue run ${nonce}`, status: 'todo', tags: ['run'], body: 'Coordination fixture.',
  } });
  const project = await jsonRequest('/api/items', { method: 'POST', body: {
    id: `ui-${nonce}-project`, type: 'project', board: board.id, title: `Context project ${nonce}`, key: 'UIP',
  } });
  const open = await jsonRequest('/api/items', { method: 'POST', body: {
    id: `ui-${nonce}-open`, type: 'ticket', board: board.id, title: `Open task ${nonce}`, status: 'todo', body: 'Claim me.',
  } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'FACT', text: 'the parser drops trailing commas', session: 'peer' } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'FAIL', text: 'retrying the printer path failed on empty input', session: 'peer' } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'SUMMARY', text: 'handoff: parser fix is in', session: 'peer' } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `project:${project.id}`, kind: 'SUMMARY', text: 'project handoff is ready for review', session: 'peer' } });
  return { board, run, project, open, nonce };
}

async function browserEval(win, expression) { return win.webContents.executeJavaScript(expression); }
async function waitForDOM(win, expression, label, timeout = 15_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try { last = await browserEval(win, expression); if (last) return last; } catch (e) { last = e; }
    await wait(100);
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
}
async function click(win, selector) { await browserEval(win, `document.querySelector(${JSON.stringify(selector)})?.click()`); }

async function runUI(seedData) {
  const errors = [];
  const win = new BrowserWindow({ show: false, width: 1440, height: 960, backgroundColor: '#000000', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: `ui-coordination-${Date.now()}` } });
  win.webContents.on('console-message', (event, levelArg, messageArg) => {
    const level = typeof event?.level === 'number' ? event.level : levelArg;
    if (Number(level) >= 2) errors.push(String(typeof event?.message === 'string' ? event.message : messageArg));
  });
  try {
    await win.loadURL(`${base.href}#${encodeURIComponent(seedData.board.id)}`);
    await waitForDOM(win, `(() => document.querySelector('#board-list .board-row.on .name')?.textContent?.includes(${JSON.stringify(seedData.nonce)}))()`, 'seeded board');
    // sessions popover
    await click(win, '#btn-sessions');
    await waitForDOM(win, `(() => !document.querySelector('#sessions').hidden && document.querySelector('#sessions').textContent.includes('user'))()`, 'sessions popover');
    const scrollBefore = await browserEval(win, `document.querySelector('#sessions').textContent`);
    assert.match(scrollBefore, /human/, 'human session is registered');
    await browserEval(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitForDOM(win, `document.querySelector('#sessions').hidden`, 'esc closes sessions');

    // queue
    await click(win, '#btn-runs');
    await waitForDOM(win, `document.querySelector('#supervision-head h1')?.textContent === 'runs'`, 'runs page');
    await click(win, '[data-sup-tab="queue"]');
    await waitForDOM(win, `(() => document.querySelector('.queue-table')?.textContent?.includes(${JSON.stringify('Open task ' + seedData.nonce)}))()`, 'queue rows');
    const rowCount = await browserEval(win, `document.querySelectorAll('.queue-table tbody tr').length`);
    assert.ok(rowCount >= 2, 'queue lists open work');
    await click(win, `[data-claim="${seedData.open.id}"]`);
    await waitForDOM(win, `(() => { const row = [...document.querySelectorAll('.queue-table tbody tr')].find(r => r.textContent.includes(${JSON.stringify('Open task ' + seedData.nonce)})); return row && row.textContent.includes('user') && row.textContent.includes('release'); })()`, 'claim reflected in queue');
    const claimed = await jsonRequest(`/api/items/${encodeURIComponent(seedData.open.id)}/claim`);
    assert.equal(claimed.session, 'user', 'queue claim records the human session');
    await click(win, `[data-release="${seedData.open.id}"]`);
    await waitForDOM(win, `(() => ![...document.querySelectorAll('.queue-table tbody tr')].find(r => r.textContent.includes(${JSON.stringify('Open task ' + seedData.nonce)}))?.textContent.includes('user'))()`, 'release reflected in queue');
    assert.equal(await jsonRequest(`/api/items/${encodeURIComponent(seedData.open.id)}/claim`), null, 'release clears the claim');

    // inspector: one scroll, claim and context blocks
    await win.loadURL(`${base.href}#item=${encodeURIComponent(seedData.run.id)}`);
    await waitForDOM(win, `(() => document.querySelector('#drawer.open') && document.querySelector('#context-box')?.textContent.includes('the parser drops trailing commas'))()`, 'context in inspector');
    const timeline = await browserEval(win, `document.querySelector('#context-box')?.textContent || ''`);
    assert.match(timeline, /finding/, 'FACT reads as a finding');
    assert.match(timeline, /dead end/, 'FAIL reads as a dead end');
    assert.match(timeline, /copy for handoff/, 'handoff copy is offered');
    assert.match(timeline, /retrying the printer path failed on empty input/);
    await click(win, '#context-box [data-chips="context-kind"] [data-v="FACT"]');
    await waitForDOM(win, `(() => { const box = document.querySelector('#context-box'); const on = box?.querySelector('[data-v="FACT"]')?.classList.contains('on'); return on && box.textContent.includes('the parser drops trailing commas') && !box.textContent.includes('retrying the printer path failed'); })()`, 'FACT filter hides other kinds');
    await click(win, '#context-box [data-chips="context-kind"] [data-v="all"]');
    await waitForDOM(win, `(() => document.querySelector('#context-box')?.textContent.includes('retrying the printer path failed on empty input'))()`, 'all filter restores the timeline');
    const sections = await browserEval(win, `[...document.querySelectorAll('#drawer [data-section]')].map(el => el.dataset.section)`);
    assert.deepEqual(sections, ['overview', 'activity', 'settings'], 'one inspector with three sections');
    assert.equal(await browserEval(win, `document.querySelectorAll('#drawer [data-dtab]').length`), 0, 'no tab UI');
    assert.ok(await browserEval(win, `document.querySelector('#claim-box')?.textContent.includes('unclaimed')`), 'claim box present');
    assert.ok(await browserEval(win, `document.querySelectorAll('#drawer [data-jump]').length >= 3`), 'jump links present');
    await win.loadURL(`${base.href}#item=${encodeURIComponent(seedData.project.id)}`);
    await waitForDOM(win, `(() => { const box = document.querySelector('#context-box'); return box && box.textContent.includes('project handoff is ready for review') && box.textContent.includes('this project') && box.textContent.includes('copy for handoff'); })()`, 'project inspector timeline');
    assert.equal(errors.length, 0, `no console errors: ${errors.join(' | ')}`);
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${artifactDir}/coordination.png`, (await win.capturePage()).toPNG());
    }
    return { errors, sections };
  } finally {
    win.destroy();
  }
}

app.on('ready', async () => {
  let code = 0;
  const seedData = await seed();
  try {
    const result = await runUI(seedData);
    console.log(`PASS: coordination UI on ${base.href} (sessions, queue claim/release, inspector context, one-scroll sections)`);
    if (artifactDir) console.log(`artifacts: ${artifactDir}/coordination.png`);
    assert.deepEqual(result.sections, ['overview', 'activity', 'settings']);
  } catch (e) {
    code = 1;
    console.error(`FAIL: coordination UI regression — ${e?.stack || e}`);
  } finally {
    await jsonRequest(`/api/boards/${encodeURIComponent(seedData.board.id)}`, { method: 'DELETE' }).catch(() => {});
    app.exit(code);
  }
});
