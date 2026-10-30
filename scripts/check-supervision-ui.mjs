import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';

const requestedBase = process.argv[2] || 'http://127.0.0.1:7399/';
const requestedArtifacts = process.argv[3];

function loopbackBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`base URL is invalid: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const port = Number(url.port || 0);
  if (url.protocol !== 'http:' || !loopback.has(host) || !url.port || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 7317) {
    throw new Error('base URL must be an explicit loopback HTTP scratch port other than 7317');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

const base = loopbackBase(requestedBase);

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** chrome the revamp removed; none of it may come back */
const REMOVED_CHROME = ['#rail', '#board-list', '#btn-new-board', '#btn-runs', '#supervision', '#supervision-head', '#claim-widget', '#bar', '#mode', '#cmd', '#hint', '#pos', '#btn-view', '#monitor-attention-strip', '#who', '#btn-alerts', '.attention-card', '.run-card'];
const TOP_BAR = ['.brand', '#btn-board', '#view-toggle', '#btn-attention', '#btn-search', '#conn', '#btn-more'];
const MORE_MENU = ['btn-sessions', 'btn-activity', 'btn-source', 'btn-organize', 'btn-auto', 'btn-trash', 'btn-help'];

async function jsonRequest(path, init = {}) {
  const headers = { 'x-hud-actor': 'ui-supervision-check', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) };
  const response = await fetch(new URL(path, base), { ...init, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path} → ${response.status}: ${body.error || JSON.stringify(body)}`);
  return body;
}

async function waitForAPI(fn, label, timeout = 15_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await wait(250);
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
}

/**
 * "Needs you", read from the API: a question, a command to approve, a monitor in error, and a ticket marked blocked
 * with nothing open to wait on. A dependency-blocked (or auto-blocked) ticket is the agents' business.
 */
async function expectedNeeds() {
  const [attention, items] = await Promise.all([jsonRequest('/api/attention'), jsonRequest('/api/items')]);
  const byId = new Map(items.map((item) => [item.id, item]));
  const now = Number(attention.now) || Date.now();
  return attention.items
    .filter((a) => !a.snoozedUntil || Number(a.snoozedUntil) <= now)
    .filter((a) => {
      if (['decision', 'command', 'error'].includes(a.kind)) return true;
      if (a.kind !== 'blocked') return false;
      const it = byId.get(a.itemId);
      return !!it && !it.autoBlocked && !(it.blockedBy || []).some((id) => { const b = byId.get(id); return b && b.status !== 'done' && b.status !== 'canceled'; });
    })
    .map((a) => ({ itemId: a.itemId, kind: a.kind, board: a.board }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
}

async function seedBoard() {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const board = await jsonRequest('/api/boards', { method: 'POST', body: { name: `UI supervision ${nonce}` } });
  const runs = [];
  const monitorInputs = [];
  for (let r = 0; r < 20; r++) {
    const runId = `ui-${nonce}-run-${String(r + 1).padStart(2, '0')}`;
    const title = `Run ${String(r + 1).padStart(2, '0')} · supervision`;
    const ids = [];
    for (let m = 0; m < 5; m++) {
      const id = `ui-${nonce}-r${String(r + 1).padStart(2, '0')}-m${String(m + 1).padStart(2, '0')}`;
      ids.push(id);
      const input = {
        id,
        type: 'monitor',
        board: board.id,
        title: `${title} · metric ${m + 1}`,
        source: { kind: 'push' },
        progress: m === 0 ? Math.min(95, 10 + r * 4) : undefined,
        value: m === 0 ? 10 + r : undefined,
        unit: m === 0 ? '%' : undefined,
      };
      if (r === 0 && m === 0) {
        Object.assign(input, { value: 31, progress: 31, unit: '%', label: '31% · evals 0/4' });
        input.details = '| Metric | Value |\n| --- | ---: |\n| status | <script>alert(1)</script> |';
        input.messageFormat = 'markdown';
      }
      if (r === 0 && m === 1) Object.assign(input, { value: 75, warnAbove: 50, message: 'synthetic warning' });
      if (r === 0 && m === 2) Object.assign(input, { value: 95, errorAbove: 90, message: 'synthetic error' });
      if (r === 0 && m === 3) Object.assign(input, { value: 1, staleAfter: 1, message: 'synthetic stale candidate' });
      monitorInputs.push(input);
    }
    runs.push({ id: runId, title, monitors: ids });
  }
  const monitors = await jsonRequest('/api/items', { method: 'POST', body: monitorInputs });
  assert.equal(monitors.length, 100, 'seeded exactly 100 push monitors');

  const runInputs = runs.map((run, i) => ({
    id: run.id,
    type: 'ticket',
    board: board.id,
    title: run.title,
    status: i === runs.length - 1 ? 'done' : 'doing',
    tags: ['run', 'synthetic'],
    body: `# ${run.title}\n\nSynthetic supervision run ${i + 1}.`,
    monitors: run.monitors,
    summaryMonitor: run.monitors[0],
  }));
  const roots = await jsonRequest('/api/items', { method: 'POST', body: runInputs });
  assert.equal(roots.length, 20, 'seeded exactly 20 run tickets');

  const childInputs = [];
  const doneChildTitle = `${runs[0].title} · child 01`;
  for (let r = 0; r < 20; r++) {
    for (let c = 0; c < 10; c++) {
      childInputs.push({
        id: `ui-${nonce}-r${String(r + 1).padStart(2, '0')}-c${String(c + 1).padStart(2, '0')}`,
        type: 'ticket',
        board: board.id,
        parent: runs[r].id,
        title: r === 0 && c === 0 ? doneChildTitle : `${runs[r].title} · child ${String(c + 1).padStart(2, '0')}`,
        status: r === 0 && c === 0 ? 'done' : r === 2 && c === 0 ? 'blocked' : 'todo',
        body: c === 0 ? `Child work for ${runs[r].title}.` : '',
      });
    }
  }
  const children = await jsonRequest('/api/items', { method: 'POST', body: childInputs });
  assert.equal(children.length, 200, 'seeded exactly 200 child tickets');
  const stuck = children.find((child) => child.status === 'blocked');
  assert.ok(stuck, 'one child was marked blocked by its agent, with nothing to wait on');

  // a ticket waiting on another ticket is auto-blocked: attention in the API, but not "needs you"
  const gate = await jsonRequest('/api/items', { method: 'POST', body: { id: `ui-${nonce}-gate`, type: 'ticket', board: board.id, title: 'Synthetic gate', status: 'todo' } });
  const waiter = await jsonRequest('/api/items', { method: 'POST', body: { id: `ui-${nonce}-waiter`, type: 'ticket', board: board.id, title: 'Synthetic waiter on the gate', status: 'todo' } });
  await jsonRequest(`/api/items/${encodeURIComponent(waiter.id)}/link`, { method: 'POST', body: { blockedBy: [gate.id] } });
  assert.equal((await jsonRequest(`/api/items/${encodeURIComponent(waiter.id)}`)).status, 'blocked', 'the waiter is blocked by its open dependency');

  // an agent-authored command monitor waits for the person's approval
  const commandId = `ui-${nonce}-cmd`;
  await jsonRequest('/api/items', { method: 'POST', body: { id: commandId, type: 'monitor', board: board.id, title: 'Synthetic command awaiting approval', source: { kind: 'command', command: 'echo 1', interval: 3600 } } });
  assert.equal((await jsonRequest(`/api/items/${encodeURIComponent(commandId)}`)).commandApproval?.status, 'pending', 'an agent-authored command starts pending');

  const decision = await jsonRequest(`/api/items/${encodeURIComponent(runs[0].id)}/ask`, {
    method: 'POST',
    body: {
      question: 'Choose the synthetic run disposition.',
      questionFormat: 'markdown',
      options: [
        { id: 'ship', label: 'Ship the report', status: 'doing' },
        { id: 'hold', label: 'Hold for review', status: 'todo' },
      ],
    },
  });
  assert.equal(decision.id, runs[0].id, 'decision issue attached to first run');

  const expectedKinds = new Set(['decision', 'warn', 'error', 'blocked', 'command']);
  await waitForAPI(async () => {
    const attention = await jsonRequest('/api/attention');
    const kinds = new Set(attention.items.filter((item) => item.board === board.id).map((item) => item.kind));
    return [...expectedKinds].every((kind) => kinds.has(kind)) ? attention : false;
  }, 'initial attention scenarios');
  const attentionWithStale = await waitForAPI(async () => {
    const attention = await jsonRequest('/api/attention');
    return attention.items.some((item) => item.board === board.id && item.kind === 'stale') ? attention : false;
  }, 'stale attention scenario', 12_000);
  const kindOf = (id) => attentionWithStale.items.find((item) => item.itemId === id)?.kind;
  assert.equal(kindOf(waiter.id), 'blocked', 'the API still reports the dependency-blocked ticket as blocked attention');
  assert.equal(kindOf(stuck.id), 'blocked', 'the API reports the agent-marked ticket as blocked attention');
  assert.equal(kindOf(commandId), 'command', 'the API reports the pending command');

  const monitorId = (m) => `ui-${nonce}-r01-m${String(m).padStart(2, '0')}`;
  return {
    board,
    roots,
    children,
    root: roots[0],
    detailMonitor: monitors[0],
    doneChildTitle,
    attention: attentionWithStale.items,
    boardName: board.name,
    nonce,
    needs: {
      decision: { id: runs[0].id, title: runs[0].title },
      command: { id: commandId, title: 'Synthetic command awaiting approval' },
      error: { id: monitorId(3), title: `${runs[0].title} · metric 3` },
      stuck: { id: stuck.id, title: stuck.title },
    },
    notNeeds: { waiter: waiter.id, warn: monitorId(2), stale: monitorId(4) },
  };
}

async function browserEval(win, expression) {
  return win.webContents.executeJavaScript(expression);
}

async function waitForDOM(win, expression, label, timeout = 15_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await browserEval(win, expression);
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await wait(100);
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function click(win, selector) {
  const encoded = JSON.stringify(selector);
  const clicked = await browserEval(win, `(() => { const el = document.querySelector(${encoded}); if (!el) return false; el.click(); return true; })()`);
  assert.equal(clicked, true, `click target exists: ${selector}`);
}

/** a key press on the page, the way the window listener receives it (nothing focused) */
async function press(win, key) {
  await browserEval(win, `(() => { document.activeElement?.blur?.(); document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); return true; })()`);
}

/** boot the page fresh on a URL: navigate (a hash change alone keeps the document), then reload it */
async function freshBoot(win, url) {
  await win.loadURL(url);
  const loaded = new Promise((resolvePromise) => win.webContents.once('did-finish-load', resolvePromise));
  win.webContents.reload();
  await loaded;
}

async function screenshot(win, artifactDir, name) {
  const png = await win.capturePage();
  const path = join(artifactDir, name);
  await writeFile(path, png.toPNG());
  return path;
}

async function settlePaint(win) {
  await browserEval(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}

async function dragElement(win, selector, dx, dy = 0) {
  const rect = await browserEval(win, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`);
  assert.ok(rect, `drag target exists: ${selector}`);
  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  const toX = Math.round(x + dx);
  const toY = Math.round(y + dy);
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: toX, y: toY });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: toX, y: toY, button: 'left', clickCount: 1 });
  await wait(80);
}

async function navbarSnapshot(win) {
  return browserEval(win, `(() => {
    const selectors = ${JSON.stringify(TOP_BAR)};
    const visible = selectors.map((selector) => document.querySelector(selector)).filter((el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id || el.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, visible };
  })()`);
}

function assertNavbarFits(snapshot, view) {
  assert.ok(snapshot.width <= 1000, `${view} navbar check runs at a compact viewport`);
  assert.equal(snapshot.visible.length, TOP_BAR.length, `${view} top bar keeps every control visible: ${snapshot.visible.map((b) => b.id).join(', ')}`);
  assert.ok(snapshot.visible.every((box) => box.left >= -1 && box.right <= snapshot.width + 1), `${view} top bar controls fit the viewport`);
  assert.ok(snapshot.scrollWidth <= snapshot.width + 1, `${view} page does not scroll sideways`);
}

/** the "needs you" badge and popover, as rendered */
async function needsState(win) {
  return JSON.parse(await browserEval(win, `JSON.stringify({
    count: document.querySelector('#attention-count')?.textContent ?? null,
    has: !!document.querySelector('#btn-attention')?.classList.contains('has'),
    open: document.querySelector('#needs')?.hidden === false,
    expanded: document.querySelector('#btn-attention')?.getAttribute('aria-expanded'),
    head: document.querySelector('#needs .needs-head')?.textContent || '',
    rows: [...document.querySelectorAll('#needs .needs-row[data-needs-open]')].map((r) => ({
      id: r.dataset.needsOpen, glyph: r.querySelector('.g')?.textContent || '', kind: r.querySelector('.kind')?.textContent || '',
      title: r.querySelector('.ttl')?.textContent || '', ws: r.querySelector('.ws')?.textContent || '',
      buttons: [...r.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), open: b.dataset.needsOpen || '' })),
    })),
  })`));
}

/** wait until the badge shows exactly what the API says needs the person, and return that list */
async function waitForNeedsBadge(win, label) {
  let last;
  try {
    return await waitForAPI(async () => {
      const expected = await expectedNeeds();
      const state = await needsState(win);
      last = { expected: expected.length, shown: state.count, has: state.has };
      return state.count === String(expected.length) && state.has === expected.length > 0 ? expected : false;
    }, label);
  } catch (error) {
    throw new Error(`${error.message}: ${JSON.stringify(last)}`);
  }
}

async function openNeeds(win, mustList = []) {
  await click(win, '#btn-attention');
  await waitForDOM(win, `(() => {
    const pop = document.querySelector('#needs');
    if (!pop || pop.hidden) return false;
    const ids = new Set([...pop.querySelectorAll('.needs-row[data-needs-open]')].map((r) => r.dataset.needsOpen));
    return ${JSON.stringify(mustList)}.every((id) => ids.has(id));
  })()`, '"needs you" popover');
  return needsState(win);
}

async function openMore(win) {
  await click(win, '#btn-more');
  await waitForDOM(win, `document.querySelector('#more-menu')?.hidden === false && document.querySelector('#btn-more')?.getAttribute('aria-expanded') === 'true'`, 'more menu opens');
}

async function pickFromMore(win, id) {
  await openMore(win);
  await click(win, `#more-menu #${id}`);
  await waitForDOM(win, `document.querySelector('#more-menu')?.hidden === true`, `more menu closes after ${id}`);
}

async function runUI(seed, artifactDir) {
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `ui-supervision-${Date.now()}`,
    },
  });
  win.webContents.on('console-message', (event, levelArg, messageArg) => {
    const level = typeof event?.level === 'number' ? event.level : levelArg;
    const message = typeof event?.message === 'string' ? event.message : messageArg;
    if (Number(level) >= 2) consoleErrors.push(String(message));
  });
  win.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) consoleErrors.push(`load ${code} ${description} ${failedUrl}`);
  });

  try {
    // ---- landing: one top bar and the workspace, nothing around it
    await win.loadURL(base.href);
    await waitForDOM(win, `(() => (document.querySelector('#btn-board #board-name')?.textContent || '').trim().length > 0 && document.querySelectorAll('#view-toggle [data-view]').length === 2 && document.querySelector('#conn')?.textContent === '● live')()`, 'default workspace landing');
    const landing = JSON.parse(await browserEval(win, `JSON.stringify({
      hash: location.hash,
      supervision: document.body.classList.contains('supervision'),
      leftovers: ${JSON.stringify(REMOVED_CHROME)}.filter((s) => document.querySelector(s)),
      inspector: !!document.querySelector('#drawer'),
      closed: ['#needs', '#more-menu', '#board-menu'].every((s) => document.querySelector(s)?.hidden === true),
      selected: [...document.querySelectorAll('#view-toggle [data-view]')].filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.dataset.view),
      list: document.body.classList.contains('list'),
    })`));
    assert.ok(landing.hash === '' || landing.hash === '#board', 'default landing is the workspace');
    assert.equal(landing.supervision, false, 'there is no supervision page shell');
    assert.deepEqual(landing.leftovers, [], 'the rail, Attention/Runs pages, queue widget and bottom bar are gone');
    assert.equal(landing.inspector, true, 'the details panel is present');
    assert.equal(landing.closed, true, 'popovers and menus start closed');
    assert.deepEqual(landing.selected, [landing.list ? 'list' : 'canvas'], 'exactly one view is selected, and it matches the page');
    await settlePaint(win);
    const boardScreenshot = await screenshot(win, artifactDir, 'supervision-1440x960.png');

    // ---- workspace picker: lists every workspace with its "needs you" count, then the workspace actions
    const boards = await jsonRequest('/api/boards');
    const main = boards.find((b) => b.id === 'main');
    assert.ok(main, 'the main workspace exists');
    const seedNeedsCount = (await waitForNeedsBadge(win, 'badge before the picker')).filter((n) => n.board === seed.board.id).length;
    assert.equal(seedNeedsCount, 4, 'the seeded workspace has four items that need the person');
    await click(win, '#btn-board');
    const seedPick = `#board-menu [data-board-pick="${seed.board.id}"]`;
    await waitForDOM(win, `(() => document.querySelector('#board-menu')?.hidden === false && document.querySelector('#btn-board')?.getAttribute('aria-expanded') === 'true' && document.querySelector(${JSON.stringify(`${seedPick} .needs-n`)})?.textContent.trim() === '● ${seedNeedsCount}')()`, 'workspace picker with "needs you" counts');
    const picker = JSON.parse(await browserEval(win, `JSON.stringify({
      picks: [...document.querySelectorAll('#board-menu [data-board-pick]')].map((r) => r.dataset.boardPick).sort(),
      on: [...document.querySelectorAll('#board-menu .board-row.on')].map((r) => r.querySelector('.name')?.textContent),
      name: document.querySelector('#board-name')?.textContent,
      seedName: document.querySelector(${JSON.stringify(`${seedPick} .name`)})?.textContent,
      actions: ['data-board-add', 'data-board-rename', 'data-board-clear', 'data-board-delete'].filter((a) => document.querySelector('#board-menu [' + a + ']')),
    })`));
    assert.deepEqual(picker.picks, boards.map((b) => b.id).sort(), 'the picker lists every workspace');
    assert.deepEqual(picker.on, [picker.name], 'the current workspace is marked and named on the picker button');
    assert.equal(picker.seedName, seed.boardName, 'rows carry the workspace name');
    assert.deepEqual(picker.actions, ['data-board-add', 'data-board-rename', 'data-board-clear', 'data-board-delete'], 'new, rename, clear and delete live in the picker');
    await browserEval(win, `(() => { const q = document.querySelector('#board-menu [data-board-query]'); q.value = ${JSON.stringify(seed.nonce)}; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const filtered = await browserEval(win, `[...document.querySelectorAll('#board-menu [data-board-pick]')].filter((r) => !r.hidden).map((r) => r.dataset.boardPick)`);
    assert.deepEqual(filtered, [seed.board.id], 'typing in the picker filters workspaces');
    await click(win, '#board-menu [data-board-pick="main"]');
    await waitForDOM(win, `document.querySelector('#board-name')?.textContent === ${JSON.stringify(main.name)} && document.querySelector('#board-menu')?.hidden === true && document.querySelector('#btn-board')?.getAttribute('aria-expanded') === 'false'`, 'picking a workspace switches to it and closes the picker');

    // ---- "needs you": the badge counts, and the popover lists, exactly what waits on the person
    const expected = await waitForNeedsBadge(win, '"needs you" badge');
    assert.ok(expected.length >= 4, 'the seed adds four items that need the person');
    const needIds = Object.values(seed.needs).map((n) => n.id);
    const pop = await openNeeds(win, needIds);
    assert.equal(pop.expanded, 'true', 'the badge reports its popover open');
    assert.deepEqual(pop.rows.map((r) => r.id).sort(), expected.map((n) => n.itemId), 'the popover lists exactly what needs the person');
    assert.equal(pop.rows.length, Number(pop.count), 'the badge count equals the popover rows');
    assert.equal(pop.head, `${expected.length} waiting on you`, 'the popover says how many wait');
    const row = (id) => pop.rows.find((r) => r.id === id);
    const expectRow = (key, glyph, kind, act) => {
      const r = row(seed.needs[key].id);
      assert.ok(r, `${key} row is listed`);
      assert.deepEqual([r.glyph, r.kind, r.title], [glyph, kind, seed.needs[key].title], `${key} row shows its glyph, kind and title`);
      assert.ok(r.ws.includes(seed.boardName), `${key} row names its workspace`);
      assert.deepEqual(r.buttons, [{ text: act, open: seed.needs[key].id }], `${key} row offers one action: ${act}`);
    };
    expectRow('decision', '?', 'question', 'answer');
    expectRow('command', '▸', 'approve command', 'review');
    expectRow('error', '✕', 'monitor error', 'open');
    expectRow('stuck', '▲', 'stuck', 'open');
    for (const [key, id] of Object.entries(seed.notNeeds)) assert.equal(row(id), undefined, `${key} is not in "needs you"`);
    assert.equal(await browserEval(win, `document.querySelector('#needs [data-attention-approve], #needs [data-act="approve-command"]')`), null, 'the popover has no approve control');
    await press(win, 'A');
    await waitForDOM(win, `document.querySelector('#needs')?.hidden === true && document.querySelector('#btn-attention')?.getAttribute('aria-expanded') === 'false'`, 'A closes "needs you"');
    await press(win, 'A');
    await waitForDOM(win, `document.querySelector('#needs')?.hidden === false`, 'A opens "needs you"');
    await browserEval(win, `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) || true`);
    await waitForDOM(win, `document.querySelector('#needs')?.hidden === true`, 'a click elsewhere closes "needs you"');

    // ---- opening a row switches workspace and opens the details panel
    await openNeeds(win, [seed.needs.decision.id]);
    await click(win, `#needs .needs-row[data-needs-open="${seed.needs.decision.id}"] .ttl`);
    await waitForDOM(win, `(() => document.querySelector('#board-name')?.textContent === ${JSON.stringify(seed.boardName)}
      && document.querySelector('#needs')?.hidden === true
      && document.body.classList.contains('list') && document.querySelector('#view-toggle [data-view="list"]')?.getAttribute('aria-selected') === 'true'
      && document.querySelector('#drawer.open .detail-title')?.textContent === ${JSON.stringify(seed.needs.decision.title)}
      && location.hash === ${JSON.stringify(`#item=${encodeURIComponent(seed.needs.decision.id)}`)})()`, 'question row opens its ticket in its workspace');
    const question = await browserEval(win, `document.querySelector('#drawer')?.textContent || ''`);
    assert.match(question, /Ship the report/, 'the question shows its options');
    assert.match(question, /Hold for review/, 'the question shows every option');
    await waitForDOM(win, `(() => !!document.querySelector('#drawer .run-summary-link') && /\\b\\d+%/.test(document.querySelector('#drawer .run-summary-link')?.closest('.drawer-report')?.textContent || ''))()`, 'run progress in the details panel');

    await click(win, '#btn-board');
    await click(win, '#board-menu [data-board-pick="main"]');
    await waitForDOM(win, `document.querySelector('#board-name')?.textContent === ${JSON.stringify(main.name)} && !document.querySelector('#drawer.open')`, 'back on main, details closed');
    await openNeeds(win, [seed.needs.error.id]);
    await click(win, `#needs .needs-row[data-needs-open="${seed.needs.error.id}"] button`);
    await waitForDOM(win, `(() => document.querySelector('#board-name')?.textContent === ${JSON.stringify(seed.boardName)} && !document.body.classList.contains('list') && document.querySelector('#view-toggle [data-view="canvas"]')?.getAttribute('aria-selected') === 'true'
      && document.querySelector('#drawer.open .detail-title')?.textContent === ${JSON.stringify(seed.needs.error.title)}
      && (document.querySelector('#drawer .monitor-current')?.textContent || '').includes('reported error'))()`, 'monitor error row opens the monitor on Monitors');

    // ---- a command is approved only from the details panel
    await openNeeds(win, [seed.needs.command.id]);
    await click(win, `#needs .needs-row[data-needs-open="${seed.needs.command.id}"] button`);
    await waitForDOM(win, `(() => document.querySelector('#drawer.open .detail-title')?.textContent === ${JSON.stringify(seed.needs.command.title)} && !!document.querySelector('#drawer [data-act="approve-command"]') && (document.querySelector('#drawer')?.textContent || '').includes('awaiting approval'))()`, 'command row opens the details panel with its approve button');
    assert.equal((await jsonRequest(`/api/items/${encodeURIComponent(seed.needs.command.id)}`)).commandApproval?.status, 'pending', 'opening a command from "needs you" does not approve it');
    assert.equal((await jsonRequest('/api/attention')).items.find((a) => a.itemId === seed.needs.command.id)?.kind, 'command', 'the command still waits for approval');
    await click(win, '#drawer [data-act="approve-command"]');
    const approved = await waitForAPI(async () => {
      const item = await jsonRequest(`/api/items/${encodeURIComponent(seed.needs.command.id)}`);
      return item.commandApproval?.status === 'approved' ? item : false;
    }, 'drawer approval');
    assert.equal(approved.commandApproval.approvedBy, 'user', 'the person approved the command from the browser');
    await waitForDOM(win, `!document.querySelector('#drawer [data-act="approve-command"]')`, 'the approve button leaves once approved');
    const afterApproval = await waitForNeedsBadge(win, 'badge after approval');
    assert.equal(afterApproval.some((n) => n.itemId === seed.needs.command.id), false, 'the approved command no longer needs the person');
    const popAfter = await openNeeds(win, [seed.needs.decision.id]);
    assert.equal(popAfter.rows.some((r) => r.id === seed.needs.command.id), false, 'the approved command leaves the popover');
    await click(win, '#btn-attention');
    await waitForDOM(win, `document.querySelector('#needs')?.hidden === true`, 'the badge closes its popover');

    // ---- ⋯ menu: agents, activity, sources, organize, auto layout, trash, help
    await openMore(win);
    // the agents count fills in on the first presence poll after boot
    await waitForDOM(win, `/^agents · \\d+ live$/.test(document.querySelector('#btn-sessions')?.textContent || '')`, 'agents counts live sessions');
    const more = JSON.parse(await browserEval(win, `JSON.stringify({
      ids: [...document.querySelectorAll('#more-menu button')].map((b) => b.id),
      visible: ${JSON.stringify(MORE_MENU)}.every((id) => document.getElementById(id)?.getBoundingClientRect().width > 0),
      sessions: document.querySelector('#btn-sessions')?.textContent || '',
      auto: document.querySelector('#btn-auto')?.textContent || '',
    })`));
    assert.deepEqual(more.ids, MORE_MENU, 'the more menu holds agents, activity, sources, organize, auto layout, trash and help');
    assert.equal(more.visible, true, 'every more-menu entry is visible while it is open');
    assert.match(more.sessions, /^agents · \d+ live$/, `agents counts live sessions: ${JSON.stringify(more.sessions)}`);
    assert.match(more.auto, /^auto layout · (on|off)$/, 'auto layout says whether it is on');
    await browserEval(win, `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) || true`);
    await waitForDOM(win, `document.querySelector('#more-menu')?.hidden === true && document.querySelector('#btn-more')?.getAttribute('aria-expanded') === 'false'`, 'a click elsewhere closes the more menu');
    await pickFromMore(win, 'btn-help');
    await waitForDOM(win, `document.querySelector('#help')?.classList.contains('open') && (document.querySelector('#help')?.textContent || '').includes('two views')`, 'help opens');
    await press(win, 'Escape');
    await waitForDOM(win, `!document.querySelector('#help')?.classList.contains('open')`, 'esc closes help');
    await pickFromMore(win, 'btn-trash');
    await waitForDOM(win, `document.querySelector('#trash')?.classList.contains('open')`, 'trash opens');
    await press(win, 'Escape');
    await waitForDOM(win, `!document.querySelector('#trash')?.classList.contains('open')`, 'esc closes trash');
    await pickFromMore(win, 'btn-activity');
    await waitForDOM(win, `document.querySelector('#activity')?.classList.contains('open')`, 'activity opens');
    await pickFromMore(win, 'btn-activity');
    await waitForDOM(win, `!document.querySelector('#activity')?.classList.contains('open')`, 'activity closes');
    const autoBefore = !!(await jsonRequest('/api/boards')).find((b) => b.id === seed.board.id)?.autoOrganize;
    for (const want of [!autoBefore, autoBefore]) {
      await pickFromMore(win, 'btn-auto');
      await waitForAPI(async () => (await jsonRequest('/api/boards')).find((b) => b.id === seed.board.id)?.autoOrganize === want, `auto layout ${want ? 'on' : 'off'}`);
      await waitForDOM(win, `document.querySelector('#btn-auto')?.textContent === ${JSON.stringify(`auto layout · ${want ? 'on' : 'off'}`)}`, 'auto layout label follows the setting');
    }

    // ---- view toggle and l
    await click(win, '#view-toggle [data-view="list"]');
    await waitForDOM(win, `document.body.classList.contains('list') && document.querySelector('#view-toggle [data-view="list"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('#view-toggle [data-view="canvas"]')?.getAttribute('aria-selected') === 'false'`, 'Tasks toggle');
    await press(win, 'l');
    await waitForDOM(win, `!document.body.classList.contains('list') && document.querySelector('#view-toggle [data-view="canvas"]')?.getAttribute('aria-selected') === 'true'`, 'l switches to Monitors');
    await press(win, 'l');
    await waitForDOM(win, `document.body.classList.contains('list') && document.querySelector('#view-toggle [data-view="list"]')?.getAttribute('aria-selected') === 'true'`, 'l switches back to Tasks');

    // ---- picker actions: new and rename
    const addName = `UI picker ${seed.nonce}`;
    await browserEval(win, `(() => { window.__prompts = []; window.prompt = (message) => { window.__prompts.push(String(message)); return window.__promptAnswer; }; return true; })()`);
    await browserEval(win, `window.__promptAnswer = ${JSON.stringify(addName)}`);
    await click(win, '#btn-board');
    await click(win, '#board-menu [data-board-add]');
    const added = await waitForAPI(async () => (await jsonRequest('/api/boards')).find((b) => b.name === addName) || false, 'new workspace from the picker');
    await waitForDOM(win, `document.querySelector('#board-name')?.textContent === ${JSON.stringify(addName)}`, 'the new workspace is current');
    await browserEval(win, `window.__promptAnswer = ${JSON.stringify(`${addName} renamed`)}`);
    await click(win, '#btn-board');
    await click(win, '#board-menu [data-board-rename]');
    await waitForAPI(async () => (await jsonRequest('/api/boards')).find((b) => b.id === added.id)?.name === `${addName} renamed`, 'workspace rename from the picker');
    await waitForDOM(win, `document.querySelector('#board-name')?.textContent === ${JSON.stringify(`${addName} renamed`)}`, 'the picker names the renamed workspace');
    assert.deepEqual(await browserEval(win, 'window.__prompts'), ['new workspace name', 'rename workspace'], 'the picker asks for the new name and the rename');
    await jsonRequest(`/api/boards/${encodeURIComponent(added.id)}`, { method: 'DELETE' });
    await waitForDOM(win, `document.querySelector('#board-name')?.textContent !== ${JSON.stringify(`${addName} renamed`)}`, 'a deleted workspace leaves the picker button');
    await click(win, '#btn-board');
    await click(win, `#board-menu [data-board-pick="${seed.board.id}"]`);
    await waitForDOM(win, `document.querySelector('#board-name')?.textContent === ${JSON.stringify(seed.boardName)}`, 'back on the seeded workspace');

    // ---- old #attention and #runs links land on the workspace
    await freshBoot(win, `${base.href}#runs`);
    await waitForDOM(win, `(() => (document.querySelector('#board-name')?.textContent || '').trim().length > 0 && document.querySelector('#conn')?.textContent === '● live' && document.querySelectorAll('#view-toggle [data-view][aria-selected="true"]').length === 1)()`, '#runs lands on the workspace');
    assert.equal(await browserEval(win, `document.querySelector('#needs')?.hidden === true && !document.querySelector('#supervision') && !document.body.classList.contains('supervision')`), true, '#runs opens no Runs page and no popover');
    await freshBoot(win, `${base.href}#attention`);
    await waitForDOM(win, `(() => (document.querySelector('#board-name')?.textContent || '').trim().length > 0 && document.querySelector('#needs')?.hidden === false && document.querySelectorAll('#needs .needs-row').length > 0)()`, '#attention lands on the workspace with "needs you" open');
    assert.equal(await browserEval(win, `!document.querySelector('#supervision') && !document.body.classList.contains('supervision')`), true, '#attention opens no Attention page');

    // ---- compact top bar
    await win.setSize(1000, 700);
    await wait(100);
    await settlePaint(win);
    const popBox = await browserEval(win, `(() => { const r = document.querySelector('#needs').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; })()`);
    assert.ok(popBox.left >= -1 && popBox.right <= popBox.width + 1, '"needs you" fits a compact viewport');
    const runScreenshot = await screenshot(win, artifactDir, 'supervision-1000x700.png');
    await click(win, '#btn-attention');
    await click(win, '#btn-board');
    await click(win, `#board-menu [data-board-pick="${seed.board.id}"]`);
    await waitForDOM(win, `document.querySelector('#board-name')?.textContent === ${JSON.stringify(seed.boardName)}`, 'seeded workspace at the compact size');
    for (const view of ['list', 'canvas']) {
      await click(win, `#view-toggle [data-view="${view}"]`);
      await waitForDOM(win, `document.body.classList.contains('list') === ${view === 'list'}`, `${view} view at the compact size`);
      await settlePaint(win);
      assertNavbarFits(await navbarSnapshot(win), view === 'list' ? 'Tasks' : 'Monitors');
    }

    await click(win, '#btn-search');
    const uuid = seed.root.uuid || seed.root.id;
    await browserEval(win, `(() => { const input = document.querySelector('#global-search-input'); input.value = ${JSON.stringify(uuid)}; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitForDOM(win, `(() => document.querySelectorAll('[data-search-open]').length > 0)()`, 'UUID search result');
    const resultId = await browserEval(win, `document.querySelector('[data-search-open]')?.dataset.searchOpen`);
    assert.equal(resultId, seed.root.id, 'global search resolves a ticket UUID');
    await click(win, '[data-search-open]');
    await waitForDOM(win, `(() => document.querySelector('#drawer.open') !== null && location.hash === ${JSON.stringify(`#item=${encodeURIComponent(seed.root.id)}`)})()`, 'search deep link');
    await win.loadURL(`${base.href}#item=${encodeURIComponent(seed.root.id)}`);
    await waitForDOM(win, `(() => document.querySelector('#drawer.open') !== null && location.hash === ${JSON.stringify(`#item=${encodeURIComponent(seed.root.id)}`)})()`, 'deep-link reload');

    await browserEval(win, `(() => { window.__uiClipboard = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => window.__uiClipboard.push(String(value)) } }); return true; })()`);
    await click(win, '#drawer [data-copy-ticket]');
    await waitForDOM(win, `(() => window.__uiClipboard?.length > 0)()`, 'mock clipboard write');
    assert.equal(await browserEval(win, 'window.__uiClipboard[0]'), uuid, 'copy action writes the ticket UUID to mocked clipboard');
    await browserEval(win, 'window.__uiClipboard = []');
    // a ticket keeps its link under the "more" fold
    await click(win, '#drawer details[data-fold="more"] > summary');
    await waitForDOM(win, `document.querySelector('#drawer details[data-fold="more"]')?.open && document.querySelector('#drawer [data-act="copy"]')?.getBoundingClientRect().width > 0`, 'more fold shows copy link');
    await click(win, '#drawer [data-act="copy"]');
    await waitForDOM(win, `(() => window.__uiClipboard?.length > 0)()`, 'mock deep-link clipboard write');
    const copiedLink = await browserEval(win, 'window.__uiClipboard[0]');
    assert.equal(copiedLink, `${base.origin}/#item=${encodeURIComponent(uuid)}`, 'copy link uses the ticket UUID deep link');
    assert.equal(copiedLink.includes(`#item=${seed.root.id}`), false, 'copy link does not fall back to the legacy id');

    const commentText = `UI comment ${Date.now()}`;
    await browserEval(win, `(() => { const box = document.querySelector('#drawer #comment-in'); box.value = ${JSON.stringify(commentText)}; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await click(win, '#drawer [data-act="comment-send"]');
    await waitForDOM(win, `(() => { const rows = [...document.querySelectorAll('#drawer .comment .txt')].filter((el) => el.textContent.trim() === ${JSON.stringify(commentText)}); return rows.length === 1 && document.querySelector('#drawer #comment-in')?.value === ''; })()`, 'comment POST rendering and input clear');
    const fullAfterComment = await jsonRequest(`/api/items/${encodeURIComponent(seed.root.id)}`);
    assert.equal((fullAfterComment.comments || []).filter((comment) => comment.text === commentText).length, 1, 'comment POST stores exactly one comment');
    await waitForDOM(win, `(() => [...document.querySelectorAll('#drawer .comment .txt')].filter((el) => el.textContent.trim() === ${JSON.stringify(commentText)}).length === 1 && document.querySelector('#drawer #comment-in')?.value === '')()`, 'comment rendered once in the inspector');
    const sseTitle = `${seed.root.title} · SSE`;
    await jsonRequest(`/api/items/${encodeURIComponent(seed.root.id)}`, { method: 'PATCH', body: { title: sseTitle } });
    await waitForDOM(win, `(() => document.querySelector('#drawer .detail-title')?.textContent === ${JSON.stringify(sseTitle)} && [...document.querySelectorAll('#drawer .comment .txt')].filter((el) => el.textContent.trim() === ${JSON.stringify(commentText)}).length === 1 && document.querySelector('#drawer #comment-in')?.value === '')()`, 'comment after SSE item update');

    // a ticket's details are one scroll: summary, comments, then folds for edit, history and more
    const folds = await browserEval(win, `([...document.querySelectorAll('#drawer details[data-fold]')]).map((el) => el.dataset.fold)`);
    assert.deepEqual(folds, ['edit', 'history', 'more'], 'ticket inspector folds edit, history and more');
    assert.equal(await browserEval(win, `document.querySelectorAll('#drawer [data-section], #drawer .drawer-tab, #drawer .inspector-jump').length`), 0, 'ticket inspector has no sections, tabs or jump nav');
    assert.equal(await browserEval(win, `document.querySelectorAll('#drawer .comment .txt').length`), 1, 'comment appears once in the inspector');
    const gripLimits = await browserEval(win, `(() => ({ min: Number(document.querySelector('#drawer-grip')?.getAttribute('aria-valuemin')), max: Number(document.querySelector('#drawer-grip')?.getAttribute('aria-valuemax')) }))()`);
    assert.ok(gripLimits.min >= 360 && gripLimits.max <= 900 && gripLimits.max >= gripLimits.min, 'drawer handle exposes bounded limits');
    await dragElement(win, '#drawer-grip', -5000);
    assert.equal(Number(await browserEval(win, 'Number(document.querySelector("#drawer-grip").getAttribute("aria-valuenow"))')), gripLimits.max, 'real mouse drag expands and clamps the drawer');
    await dragElement(win, '#drawer-grip', 5000);
    assert.equal(Number(await browserEval(win, 'Number(document.querySelector("#drawer-grip").getAttribute("aria-valuenow"))')), gripLimits.min, 'real mouse drag shrinks and clamps the drawer');
    await dragElement(win, '#drawer-grip', -120);
    const rememberedWidth = Number(await browserEval(win, 'Number(document.querySelector("#drawer-grip").getAttribute("aria-valuenow"))'));
    assert.ok(rememberedWidth > gripLimits.min && rememberedWidth < gripLimits.max, 'real mouse drag reaches an interior drawer width');
    await win.loadURL(`${base.href}#item=${encodeURIComponent(seed.root.id)}`);
    await waitForDOM(win, `(() => document.querySelector('#drawer.open') !== null && document.querySelector('#drawer-grip')?.getAttribute('aria-valuenow') === ${JSON.stringify(String(rememberedWidth))})()`, 'remembered drawer width after reload');

    await win.loadURL(`${base.href}#item=${encodeURIComponent(seed.detailMonitor.id)}`);
    await waitForDOM(win, `(() => document.querySelector('#drawer.open') !== null && document.querySelector('#drawer .md-table') !== null)()`, 'safe Markdown details table');
    const details = await browserEval(win, `(() => ({ html: document.querySelector('#drawer')?.innerHTML || '', text: document.querySelector('#drawer')?.textContent || '', current: document.querySelector('#drawer .monitor-current')?.textContent || '' }))()`);
    assert.match(details.html, /class="md-table"/, 'Markdown details table rendered');
    assert.match(details.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'details HTML is escaped');
    assert.doesNotMatch(details.html, /<script|<img/i, 'details cannot inject script or image tags');
    assert.match(details.current, /31% · evals 0\/4/);
    assert.equal((details.current.match(/31%/g) || []).length, 1, 'monitor current reading shows the label percentage once');
    assert.ok(await browserEval(win, `(() => { const d = document.querySelector('#drawer'); return d.scrollWidth <= d.clientWidth + 1; })()`), 'sidebar content does not cause horizontal overflow');
    await settlePaint(win);
    await screenshot(win, artifactDir, 'supervision-sidebar.png');

    // the tree keeps finished work in place; the list tucks it away until "completed" is on
    await click(win, '#view-toggle [data-view="list"]');
    await waitForDOM(win, `document.body.classList.contains('list') && document.querySelector('#view-toggle [data-view="list"]')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#list .lwrap')`, 'Tasks view');
    if (!(await browserEval(win, `!!document.querySelector('.lwrap.shape-tree')`))) await click(win, '#list [data-shape="tree"]');
    assert.equal(await browserEval(win, `document.querySelector('#list [data-f-completed]')?.getAttribute('aria-pressed')`), 'false', 'completed filter is off');
    await waitForDOM(win, `[...document.querySelectorAll('#list .tt-node title')].some((t) => t.textContent.includes(${JSON.stringify(seed.doneChildTitle)}))`, 'the tree shows the done ticket with completed off');
    // "hide done" drops the finished branch from the tree, then brings it back
    await click(win, '#list [data-f-hidedone]');
    await waitForDOM(win, `document.querySelector('#list [data-f-hidedone]')?.getAttribute('aria-pressed') === 'true' && ![...document.querySelectorAll('#list .tt-node title')].some((t) => t.textContent.includes(${JSON.stringify(seed.doneChildTitle)}))`, 'hide done drops the done ticket from the tree');
    await click(win, '#list [data-f-hidedone]');
    await waitForDOM(win, `[...document.querySelectorAll('#list .tt-node title')].some((t) => t.textContent.includes(${JSON.stringify(seed.doneChildTitle)}))`, 'hide done off restores the done ticket');
    await click(win, '#list [data-shape="list"]');
    assert.equal(await browserEval(win, `document.querySelector('#list [data-f-hidedone]')?.hidden`), true, 'hide done is a tree-only control');
    await waitForDOM(win, `!!document.querySelector('.lwrap.shape-list .trow')`, 'list shape');
    const activeText = await browserEval(win, `document.querySelector('#list')?.textContent || ''`);
    assert.equal(activeText.includes(seed.doneChildTitle), false, 'completed ticket is hidden from the list by default');
    await click(win, '#list [data-f-toggle]');
    await waitForDOM(win, `document.querySelector('#list .lfbar')?.classList.contains('lf-open') && document.querySelector('#list [data-f-completed]')?.getBoundingClientRect().width > 0`, 'filter disclosure shows completed');
    await click(win, '#list [data-f-completed]');
    await waitForDOM(win, `(() => (document.querySelector('#list')?.textContent || '').includes(${JSON.stringify(seed.doneChildTitle)}))()`, 'completed ticket toggle');

    await win.loadURL(`${base.href}#item=${encodeURIComponent(seed.root.id)}`);
    await waitForDOM(win, `(() => document.querySelector('#drawer.open') !== null)()`, 'live-update drawer');
    if (!(await browserEval(win, `!!document.querySelector('#drawer details[data-fold="edit"]')?.open`))) await click(win, '#drawer details[data-fold="edit"] > summary');
    await waitForDOM(win, `(() => document.querySelector('#drawer details[data-fold="edit"]')?.open && document.querySelector('#drawer [data-k="title"]')?.getBoundingClientRect().width > 0)()`, 'focused settings input').catch(async (error) => {
      throw new Error(`${error.message} DIAG ${await browserEval(win, `JSON.stringify({ hash: location.hash, title: document.querySelector('#drawer .detail-title')?.textContent, folds: [...document.querySelectorAll('#drawer details[data-fold]')].map((d) => d.dataset.fold + ':' + d.open), inputs: [...document.querySelectorAll('#drawer [data-k="title"]')].map((i) => Math.round(i.getBoundingClientRect().width)), drawerOpen: !!document.querySelector('#drawer.open') })`)}`);
    });
    const focusBefore = await browserEval(win, `(() => { const input = document.querySelector('#drawer [data-k="title"]'); const drawer = document.querySelector('#drawer'); input.focus(); input.value = 'preserve this typed value'; drawer.scrollTop = 123; return { top: drawer.scrollTop, value: input.value }; })()`);
    assert.ok(focusBefore.top >= 100, 'the open edit fold makes the details panel scroll');
    await jsonRequest(`/api/items/${encodeURIComponent(seed.root.id)}`, { method: 'PATCH', body: { priority: 'high' } });
    await waitForDOM(win, `(() => { const input = document.querySelector('#drawer [data-k="title"]'); const drawer = document.querySelector('#drawer'); return document.activeElement === input && input.value === 'preserve this typed value' && drawer.scrollTop >= 100; })()`, 'focused input and sidebar scroll after live update');
    const focusAfter = await browserEval(win, `(() => ({ active: document.activeElement?.dataset?.k || '', value: document.querySelector('#drawer [data-k="title"]')?.value || '', top: document.querySelector('#drawer')?.scrollTop || 0 }))()`);
    assert.equal(focusAfter.active, 'title', 'live update preserves focused input');
    assert.equal(focusAfter.value, focusBefore.value, 'live update preserves unsaved input text');
    assert.ok(focusAfter.top >= focusBefore.top - 2, 'live update preserves sidebar scroll');

    return { boardScreenshot, runScreenshot, consoleErrors };
  } catch (error) {
    try {
      await settlePaint(win);
      await screenshot(win, artifactDir, 'supervision-failure.png');
    } catch {}
    throw error;
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

app.whenReady().then(async () => {
  let artifactDir;
  try {
    artifactDir = requestedArtifacts ? resolve(requestedArtifacts) : await mkdtemp(join(tmpdir(), 'hud-supervision-ui-'));
    await mkdir(artifactDir, { recursive: true });
    const seed = await seedBoard();
    const result = await runUI(seed, artifactDir);
    assert.deepEqual(result.consoleErrors, [], `renderer errors: ${result.consoleErrors.join(' | ')}`);
    console.log(`PASS: supervision UI landing without the old chrome, workspace picker (counts, filter, switch, new, rename), "needs you" badge and popover (question, command, monitor error, stuck; not dependency-blocked/warn/stale), row opens across workspaces, drawer-only command approval, more menu, view toggle and l, old #attention/#runs links, compact top bar fit, UUID/deep-link copy, safe Markdown details, monitor label/progress, ticket folds/drawer limits/persistence, comments across SSE, tree vs list completed filtering, clipboard mock, and live-update focus/scroll`);
    console.log(`artifacts: ${result.boardScreenshot}, ${result.runScreenshot}`);
    console.log(`seed: ${seed.boardName} (${seed.roots.length} runs, ${seed.detailMonitor.id} details monitor)`);
    app.exit(0);
  } catch (error) {
    console.error(`FAIL: supervision UI regression — ${error?.stack || error}`);
    if (artifactDir) console.error(`artifacts: ${artifactDir}`);
    app.exit(1);
  }
});
