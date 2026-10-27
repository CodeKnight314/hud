// Headless tickets view: project chips stay in sync with the project filter, list/tree/board
// each show assignee (→) and claimer (⊕), and loadClaims fills the claimer without a reload.
//   ./node_modules/.bin/electron scripts/check-tickets-ui.mjs http://127.0.0.1:7411 /tmp/hud-tickets-ui-check
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
  const headers = { 'x-hud-actor': 'ui-tickets-check', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) };
  const res = await fetch(new URL(path, base), { ...init, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${body.error || ''}`);
  return body;
}

async function seed() {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const board = await jsonRequest('/api/boards', { method: 'POST', body: { name: `UI tickets ${nonce}` } });
  const eng = await jsonRequest('/api/items', { method: 'POST', body: { type: 'project', board: board.id, title: `Eng ${nonce}`, key: 'ENG' } });
  const hud = await jsonRequest('/api/items', { method: 'POST', body: { type: 'project', board: board.id, title: `Hud ${nonce}`, key: 'HUD' } });
  const parent = await jsonRequest('/api/items', { method: 'POST', body: { type: 'ticket', board: board.id, title: `Ship ${nonce}`, project: eng.id, assignee: 'alice', status: 'todo' } });
  const child = await jsonRequest('/api/items', { method: 'POST', body: { type: 'ticket', board: board.id, title: `Nested ${nonce}`, project: eng.id, parent: parent.id, assignee: 'bob', status: 'todo' } });
  const claimed = await jsonRequest('/api/items', { method: 'POST', body: { type: 'ticket', board: board.id, title: `Claimed ${nonce}`, project: eng.id, status: 'review' } });
  const other = await jsonRequest('/api/items', { method: 'POST', body: { type: 'ticket', board: board.id, title: `Other ${nonce}`, project: hud.id, assignee: 'alice', status: 'review' } });
  await jsonRequest(`/api/items/${encodeURIComponent(claimed.id)}/claim`, { method: 'POST', body: { session: `ui-tickets-${nonce}` } });
  return { board, eng, hud, parent, child, claimed, other, nonce };
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

function rowPad(title) {
  return `(() => {
    const row = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes(${JSON.stringify(title)}));
    if (!row) return 0;
    return Number.parseFloat(getComputedStyle(row).paddingLeft) || 0;
  })()`;
}

async function runUI(seedData) {
  const errors = [];
  const win = new BrowserWindow({ show: false, width: 1440, height: 960, backgroundColor: '#000000', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: `ui-tickets-${Date.now()}` } });
  win.webContents.on('console-message', (event, levelArg, messageArg) => {
    const level = typeof event?.level === 'number' ? event.level : levelArg;
    if (Number(level) >= 2) errors.push(String(typeof event?.message === 'string' ? event.message : messageArg));
  });
  const ship = `Ship ${seedData.nonce}`;
  const nested = `Nested ${seedData.nonce}`;
  const claimed = `Claimed ${seedData.nonce}`;
  const other = `Other ${seedData.nonce}`;
  try {
    await win.loadURL(`${base.href}#${encodeURIComponent(seedData.board.id)}`);
    await waitForDOM(win, `document.body.classList.contains('list') && document.querySelector('.lwrap.shape-list')`, 'tickets list');
    await waitForDOM(win, `(() => {
      const chips = [...document.querySelectorAll('[data-proj-switch]')].map((b) => b.textContent);
      return chips.includes('all') && chips.includes('ENG') && chips.includes('HUD');
    })()`, 'project chips');
    await waitForDOM(win, `(() => ['list', 'tree', 'board'].every((s) => document.querySelector('[data-shape="' + s + '"]')))()`, 'shape buttons');
    await waitForDOM(win, `(() => {
      const text = document.querySelector('#list')?.textContent || '';
      return text.includes(${JSON.stringify(ship)}) && text.includes('→alice') && text.includes('⊕—') && text.includes(${JSON.stringify(claimed)}) && text.includes('⊕ui-tickets-check') && !text.includes('⊕…');
    })()`, 'list ownership from loadClaims');
    await waitForDOM(win, `(() => performance.getEntriesByType('resource').some((e) => {
      const name = e.name || '';
      return name.includes('/api/claims') && name.includes('board=') && !name.includes('session=');
    }))()`, 'claims request omits session so every lease is loaded');

    await click(win, '[data-shape="tree"]');
    await waitForDOM(win, `document.querySelector('.lwrap.shape-tree') && !document.querySelector('.tstat')`, 'tree drops status groups');
    const pads = await browserEval(win, `JSON.stringify({ parent: ${rowPad(ship)}, child: ${rowPad(nested)} })`);
    const { parent, child } = JSON.parse(pads);
    assert.ok(child > parent, `nested row is indented (${child} > ${parent})`);
    const treeText = await browserEval(win, `document.querySelector('#list').textContent`);
    assert.match(treeText, /→bob/);
    assert.match(treeText, /⊕—/);

    await click(win, `[data-proj-switch="${seedData.hud.id}"]`);
    await waitForDOM(win, `(() => {
      const on = document.querySelector('[data-proj-switch="${seedData.hud.id}"].on');
      const select = document.querySelector('[data-f="project"]');
      const text = document.querySelector('#list')?.textContent || '';
      return on && select?.value === ${JSON.stringify(seedData.hud.id)} && text.includes(${JSON.stringify(other)}) && !text.includes(${JSON.stringify(ship)});
    })()`, 'HUD chip syncs the project filter');

    await browserEval(win, `(() => { const s = document.querySelector('[data-f="project"]'); s.value = ${JSON.stringify(seedData.eng.id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitForDOM(win, `(() => {
      const on = document.querySelector('[data-proj-switch="${seedData.eng.id}"].on');
      const text = document.querySelector('#list')?.textContent || '';
      return on && text.includes(${JSON.stringify(nested)}) && !text.includes(${JSON.stringify(other)});
    })()`, 'project filter syncs the chip');

    await click(win, `[data-proj-switch="${seedData.hud.id}"]`);
    await click(win, '[data-shape="board"]');
    await waitForDOM(win, `(() => {
      const cards = [...document.querySelectorAll('.kcard')];
      return document.querySelector('.lwrap.shape-board') && cards.length === 1 && cards[0].textContent.includes(${JSON.stringify(other)}) && cards[0].textContent.includes('→alice') && cards[0].textContent.includes('⊕—');
    })()`, 'HUD board card');

    await click(win, '[data-proj-switch="*"]');
    await waitForDOM(win, `(() => {
      const cards = [...document.querySelectorAll('.kcard')];
      const text = cards.map((c) => c.textContent).join('\\n');
      const select = document.querySelector('[data-f="project"]');
      return document.querySelector('[data-proj-switch="*"].on') && select?.value === '' && cards.length === 4
        && text.includes(${JSON.stringify(ship)}) && text.includes(${JSON.stringify(nested)})
        && text.includes(${JSON.stringify(claimed)}) && text.includes('⊕ui-tickets-check')
        && text.includes(${JSON.stringify(other)}) && !text.includes('⊕…');
    })()`, 'all-projects board');
    assert.equal(errors.length, 0, `no console errors: ${errors.join(' | ')}`);

    // A claim event that arrives while /api/claims is in flight must survive the older snapshot.
    const late = await jsonRequest('/api/items', { method: 'POST', body: { type: 'ticket', board: seedData.board.id, title: `Late ${seedData.nonce}`, project: seedData.eng.id, status: 'todo' } });
    await waitForDOM(win, `document.querySelector('#list')?.textContent.includes(${JSON.stringify('Late ' + seedData.nonce)})`, 'late ticket row');
    await browserEval(win, `(() => {
      const orig = window.fetch.bind(window);
      let release;
      window.__claimsGate = new Promise((r) => { release = r; });
      window.__releaseClaims = release;
      window.__claimsHeld = false;
      window.__claimsFetches = 0;
      window.fetch = async (url, opts) => {
        const name = typeof url === 'string' ? url : (url && url.url) || '';
        if (!name.includes('/api/claims')) return orig(url, opts);
        window.__claimsFetches++;
        const res = await orig(url, opts);
        if (window.__claimsFetches === 1) {
          window.__claimsHeld = true;
          await window.__claimsGate;
        }
        return res;
      };
      return true;
    })()`);
    await click(win, '#btn-board');
    await waitForDOM(win, `document.querySelector(${JSON.stringify(`[data-board-pick="${seedData.board.id}"]`)})`, 'board menu');
    await click(win, `[data-board-pick="${seedData.board.id}"]`);
    await waitForDOM(win, `window.__claimsHeld === true`, 'claims snapshot held');
    await jsonRequest(`/api/items/${encodeURIComponent(late.id)}/claim`, { method: 'POST', body: { session: `ui-late-${seedData.nonce}` } });
    await waitForDOM(win, `(() => {
      const card = [...document.querySelectorAll('.kcard, .trow')].find((el) => el.textContent.includes(${JSON.stringify('Late ' + seedData.nonce)}));
      return card && card.textContent.includes('⊕ui-tickets-check');
    })()`, 'SSE claim before the snapshot returns');
    await browserEval(win, `window.__releaseClaims()`);
    await waitForDOM(win, `window.__claimsFetches >= 2`, 'stale snapshot retries claimsList');
    await wait(400);
    const lateText = await browserEval(win, `(() => {
      const card = [...document.querySelectorAll('.kcard, .trow')].find((el) => el.textContent.includes(${JSON.stringify('Late ' + seedData.nonce)}));
      return card ? card.textContent : '';
    })()`);
    assert.match(lateText, /⊕ui-tickets-check/, 'older claims snapshot must not clear the SSE claimer');
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${artifactDir}/tickets-board.png`, (await win.capturePage()).toPNG());
    }
  } finally {
    win.destroy();
  }
}

app.on('ready', async () => {
  let code = 0;
  const seedData = await seed();
  try {
    await runUI(seedData);
    console.log(`PASS: tickets UI on ${base.href} (project chips, list/tree/board, assignee and claimer)`);
    if (artifactDir) console.log(`artifacts: ${artifactDir}/tickets-board.png`);
  } catch (e) {
    code = 1;
    console.error(`FAIL: tickets UI — ${e?.stack || e}`);
  } finally {
    await jsonRequest(`/api/boards/${encodeURIComponent(seedData.board.id)}`, { method: 'DELETE' }).catch(() => {});
    app.exit(code);
  }
});
