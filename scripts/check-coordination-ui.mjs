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
  const held = await jsonRequest('/api/items', { method: 'POST', body: {
    id: `ui-${nonce}-held`, type: 'ticket', board: board.id, title: `Held task ${nonce}`, status: 'todo', body: 'Already claimed.',
  } });
  await jsonRequest('/api/sessions', { method: 'POST', body: { id: `peer-${nonce}`, name: `Peer ${nonce}`, kind: 'agent' } });
  await jsonRequest(`/api/items/${encodeURIComponent(held.id)}/claim`, { method: 'POST', body: { session: `peer-${nonce}`, ttl: 180 } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'FACT', text: 'the parser drops trailing commas', session: 'peer' } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'FAIL', text: 'retrying the printer path failed on empty input', session: 'peer' } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'SUMMARY', text: 'handoff: parser fix is in', session: 'peer' } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `project:${project.id}`, kind: 'SUMMARY', text: 'project handoff is ready for review', session: 'peer' } });
  await jsonRequest('/api/context', { method: 'POST', body: { scope: `run:${run.id}`, kind: 'FACT', text: 'the held task needs the parser fix first', refs: [held.id], session: 'peer' } });
  return { board, run, project, open, held, nonce };
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
    await waitForDOM(win, `(() => document.querySelector('#board-name')?.textContent?.includes(${JSON.stringify(seedData.nonce)}))()`, 'seeded workspace in the picker');
    const nodeFor = (title) => `[...document.querySelectorAll('#list .tt-node')].find((n) => n.querySelector('title')?.textContent.includes(${JSON.stringify(title)}))`;
    const heldTitle = `Held task ${seedData.nonce}`;
    const openTitle = `Open task ${seedData.nonce}`;
    // a claimed ticket's tree node carries the claimed ring; an unclaimed one does not
    await waitForDOM(win, `(() => { const held = ${nodeFor(heldTitle)}; const open = ${nodeFor(openTitle)}; return document.body.classList.contains('list') && held?.classList.contains('claimed') && open && !open.classList.contains('claimed'); })()`, 'claimed ring on the held ticket node');
    assert.match(await browserEval(win, `${nodeFor(heldTitle)}.querySelector('title').textContent`), /claimed by ui-coordination-check/, 'held node names its claimer');
    assert.match(await browserEval(win, `${nodeFor(heldTitle)}.getAttribute('aria-label')`), /claimed by ui-coordination-check/, 'held node announces its claimer');
    assert.equal(await browserEval(win, `document.querySelector('#claim-widget, #supervision, #btn-runs, [data-sup-tab]')`), null, 'no canvas queue widget, Runs page or queue tab');

    // the peer's lease reads in the drawer: who holds it, and (on hover) which session and how long is left
    await browserEval(win, `(${nodeFor(heldTitle)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await waitForDOM(win, `(() => { const box = document.querySelector('#drawer.open #claim-box'); return (box?.textContent || '').includes('⊕ ui-coordination-check is on it'); })()`, 'peer claim in the drawer');
    assert.match(await browserEval(win, `document.querySelector('#claim-box .claim-state.held')?.title || ''`), new RegExp(`^session peer-${seedData.nonce} · lease \\d+s left$`), 'the lease names its session and the time left');
    assert.equal(await browserEval(win, `document.querySelector('#claim-box [data-release], #claim-box [data-claim]')`), null, 'a peer lease offers neither release nor claim to the human');
    // a ticket's findings come from every scope that refs it
    await waitForDOM(win, `(() => { const t = document.querySelector('#context-box')?.textContent || ''; return t.includes('the held task needs the parser fix first') && t.includes('about this ticket') && t.includes('every scope') && !t.includes('the parser drops trailing commas'); })()`, 'ticket findings from every scope');
    await click(win, '#drawer [data-act="close"]');
    await waitForDOM(win, `!document.querySelector('#drawer.open')`, 'drawer closes');

    // sessions popover, now under ⋯ → agents
    await click(win, '#btn-more');
    await waitForDOM(win, `(() => { const m = document.querySelector('#more-menu'); return m && !m.hidden && document.querySelector('#btn-more')?.getAttribute('aria-expanded') === 'true'; })()`, 'more menu');
    assert.equal(await browserEval(win, `document.querySelector('#more-menu #btn-sessions') !== null`), true, 'agents lives in the more menu');
    await waitForDOM(win, `/^agents · [1-9]\\d* live$/.test(document.querySelector('#btn-sessions')?.textContent || '')`, 'agents entry counts live sessions');
    await click(win, '#btn-sessions');
    await waitForDOM(win, `(() => !document.querySelector('#sessions').hidden && document.querySelector('#sessions').textContent.includes('user') && document.querySelector('#sessions').textContent.includes(${JSON.stringify(`peer-${seedData.nonce}`)}))()`, 'sessions popover');
    await waitForDOM(win, `document.querySelector('#more-menu').hidden`, 'picking agents closes the more menu');
    const scrollBefore = await browserEval(win, `document.querySelector('#sessions').textContent`);
    assert.match(scrollBefore, /human/, 'human session is registered');
    assert.match(scrollBefore, /agents/, 'popover is titled agents');
    await browserEval(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitForDOM(win, `document.querySelector('#sessions').hidden`, 'esc closes sessions');

    // claim and release through the drawer's claim box
    await browserEval(win, `(${nodeFor(openTitle)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await waitForDOM(win, `(() => { const box = document.querySelector('#drawer.open #claim-box'); return box?.textContent.includes('⊕ unclaimed') && box.querySelector(${JSON.stringify(`[data-claim="${seedData.open.id}"]`)}); })()`, 'unclaimed open ticket in the drawer');
    await waitForDOM(win, `(() => { const t = document.querySelector('#context-box')?.textContent || ''; return t.includes('findings') && t.includes('No FACT, FAIL or STATUS refers to this ticket yet.'); })()`, 'empty ticket findings');
    await click(win, `#claim-box [data-claim="${seedData.open.id}"]`);
    await waitForDOM(win, `(() => { const box = document.querySelector('#claim-box'); return box?.textContent.includes('⊕ user is on it') && /^session user · lease \\d+s left$/.test(box.querySelector('.claim-state.held')?.title || '') && box.querySelector(${JSON.stringify(`[data-release="${seedData.open.id}"]`)}); })()`, 'claim reflected in the drawer');
    const claimed = await jsonRequest(`/api/items/${encodeURIComponent(seedData.open.id)}/claim`);
    assert.equal(claimed.session, 'user', 'drawer claim records the human session');
    assert.equal((await jsonRequest(`/api/items/${encodeURIComponent(seedData.open.id)}`)).status, 'doing', 'drawer claim starts the ticket');
    await waitForDOM(win, `${nodeFor(openTitle)}?.classList.contains('claimed')`, 'claimed ring on the newly claimed node');
    await click(win, `#claim-box [data-release="${seedData.open.id}"]`);
    await waitForDOM(win, `(() => { const box = document.querySelector('#claim-box'); return box?.textContent.includes('⊕ unclaimed') && box.querySelector(${JSON.stringify(`[data-claim="${seedData.open.id}"]`)}); })()`, 'release reflected in the drawer');
    assert.equal(await jsonRequest(`/api/items/${encodeURIComponent(seedData.open.id)}/claim`), null, 'release clears the claim');
    await waitForDOM(win, `${nodeFor(openTitle)} && !${nodeFor(openTitle)}.classList.contains('claimed')`, 'release clears the claimed ring');

    // inspector: a run ticket reads its run scope; claim, context and folds in one scroll
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
    assert.match(timeline, /this run/, 'a run ticket reads its run scope');
    const folds = await browserEval(win, `[...document.querySelectorAll('#drawer details[data-fold]')].map(el => el.dataset.fold + ':' + el.open).join(',')`);
    assert.equal(folds, 'edit:false,history:false,more:false', 'a ticket keeps edit, history and more in closed folds');
    assert.equal(await browserEval(win, `document.querySelectorAll('#drawer [data-section], #drawer .inspector-jump, #drawer [data-dtab]').length`), 0, 'a ticket inspector has no sections, jump nav or tabs');
    await waitForDOM(win, `document.querySelector('#claim-box')?.textContent.includes('unclaimed')`, 'claim box present');
    await click(win, '#drawer details[data-fold="edit"] > summary');
    await waitForDOM(win, `document.querySelector('#drawer details[data-fold="edit"]')?.open && document.querySelector('#drawer details[data-fold="edit"] [data-k="title"]')?.getBoundingClientRect().width > 0`, 'edit fold opens the settings form');
    await win.loadURL(`${base.href}#item=${encodeURIComponent(seedData.project.id)}`);
    await waitForDOM(win, `(() => { const box = document.querySelector('#context-box'); return box && box.textContent.includes('project handoff is ready for review') && box.textContent.includes('this project') && box.textContent.includes('copy for handoff'); })()`, 'project inspector timeline');
    const sections = await browserEval(win, `[...document.querySelectorAll('#drawer [data-section]')].map(el => el.dataset.section)`);
    assert.deepEqual(sections, ['overview', 'activity', 'settings'], 'a project inspector is one scroll with three sections');
    assert.equal(await browserEval(win, `document.querySelectorAll('#drawer [data-dtab]').length`), 0, 'no tab UI');
    assert.ok(await browserEval(win, `document.querySelectorAll('#drawer [data-jump]').length >= 3`), 'jump links present');
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
    console.log(`PASS: coordination UI on ${base.href} (claimed tree nodes, peer lease in the drawer, agents under the more menu, drawer claim/release, ticket and run/project context, ticket folds, project sections)`);
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
