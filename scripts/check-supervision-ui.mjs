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

  const expectedKinds = new Set(['decision', 'warn', 'error', 'blocked']);
  await waitForAPI(async () => {
    const attention = await jsonRequest('/api/attention');
    const kinds = new Set(attention.items.map((item) => item.kind));
    return [...expectedKinds].every((kind) => kinds.has(kind)) ? attention : false;
  }, 'initial attention scenarios');
  const attentionWithStale = await waitForAPI(async () => {
    const attention = await jsonRequest('/api/attention');
    return attention.items.some((item) => item.kind === 'stale') ? attention : false;
  }, 'stale attention scenario', 12_000);

  return {
    board,
    roots,
    children,
    root: roots[0],
    detailMonitor: monitors[0],
    doneChildTitle,
    attention: attentionWithStale.items,
    boardName: board.name,
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
    const selectors = ['.brand', '#btn-attention', '#btn-runs', '#board-switcher', '#btn-search', '#tabs', '#who', '#btn-alerts', '#btn-organize', '#btn-auto', '#btn-dashboard', '#btn-view', '#btn-trash', '#btn-activity', '#btn-help', '#conn'];
    const visible = selectors.map((selector) => document.querySelector(selector)).filter((el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.id || el.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, visible };
  })()`);
}

function assertNavbarFits(snapshot, page) {
  assert.ok(snapshot.width <= 1000, `${page} navbar check runs at a compact viewport`);
  assert.ok(snapshot.visible.length >= 6, `${page} navbar retains visible controls`);
  assert.ok(snapshot.visible.every((box) => box.left >= -1 && box.right <= snapshot.width + 1), `${page} navbar controls fit the viewport`);
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
    await win.loadURL(base.href);
    await waitForDOM(win, `(() => document.querySelector('#supervision-head h1')?.textContent?.trim() === 'attention')()`, 'default Attention landing');
    const landing = await browserEval(win, `(() => ({ hash: location.hash, page: document.querySelector('#supervision-head h1')?.textContent?.trim(), supervision: document.body.classList.contains('supervision') }))()`);
    assert.ok(landing.hash === '' || landing.hash === '#attention', 'default landing has no board hash');
    assert.equal(landing.page, 'attention', 'default landing is Attention');
    assert.equal(landing.supervision, true, 'supervision shell is active');
    assert.ok(await browserEval(win, `document.querySelectorAll('.attention-card').length >= 5`), 'attention shows issue cards');
    await settlePaint(win);
    const attentionScreenshot = await screenshot(win, artifactDir, 'supervision-1440x960.png');

    await click(win, '#btn-attention');
    assert.ok(await browserEval(win, `document.querySelector('#supervision-head h1')?.textContent?.trim() === 'attention'`), 'issue sidebar opens Attention');
    const firstAttention = await browserEval(win, `(() => { const c = document.querySelector('.attention-card'); return c ? { id: c.dataset.attentionId, kind: c.querySelector('.ac-kind')?.textContent || '', title: c.querySelector('.ac-open')?.textContent || '' } : null; })()`);
    assert.ok(firstAttention?.id, 'first issue has an attention id');
    await click(win, `.attention-card[data-attention-id="${firstAttention.id}"] [data-attention-open]`);
    await waitForDOM(win, `(() => document.querySelector('#drawer.open') !== null)()`, 'issue drawer');
    await click(win, '#drawer [data-act="close"]');
    await click(win, '#btn-attention');
    await waitForDOM(win, `(() => document.querySelector('#supervision-head h1')?.textContent?.trim() === 'attention')()`, 'Attention after issue open');

    await click(win, `.attention-card[data-attention-id="${firstAttention.id}"] [data-attention-review]`);
    await wait(350);
    const reviewed = await jsonRequest('/api/attention');
    const reviewedRecord = reviewed.items.find((item) => item.id === firstAttention.id);
    assert.ok(reviewedRecord?.reviewedAt, 'review marks the issue reviewed');
    assert.equal(reviewedRecord.resolvedAt, undefined, 'review does not resolve the issue');

    await click(win, '#btn-runs');
    await waitForDOM(win, `(() => document.querySelector('#supervision-head h1')?.textContent?.trim() === 'runs' && document.querySelectorAll('.run-card').length > 0)()`, 'runs page');
    const runsView = await browserEval(win, `(() => { const ids = new Set(${JSON.stringify(seed.roots.map(r => r.id))}); const cards = [...document.querySelectorAll('.run-card')].filter(c => ids.has(c.dataset.runId)); return { cards: cards.length, progress: cards.filter(c => c.querySelector('.run-progress[aria-label]')).length, text: cards.map(c => c.textContent).join(' ') }; })()`);
    assert.equal(runsView.cards, 19, 'completed run is hidden by default');
    assert.ok(runsView.progress >= 18, 'run cards expose explicit progress');
    assert.match(runsView.text, /\d+%/, 'run listing includes progress text');
    await win.setSize(1000, 700);
    await wait(100);
    await settlePaint(win);
    const runScreenshot = await screenshot(win, artifactDir, 'supervision-1000x700.png');
    assertNavbarFits(await navbarSnapshot(win), 'runs');

    await click(win, '#btn-board');
    await click(win, `[data-board-pick="${seed.board.id}"]`);
    await waitForDOM(win, `(() => !document.body.classList.contains('supervision'))()`, 'board view');
    assertNavbarFits(await navbarSnapshot(win), 'board');
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
    await click(win, '[data-copy-ticket]');
    await waitForDOM(win, `(() => window.__uiClipboard?.length > 0)()`, 'mock clipboard write');
    assert.equal(await browserEval(win, 'window.__uiClipboard[0]'), uuid, 'copy action writes the ticket UUID to mocked clipboard');
    await browserEval(win, 'window.__uiClipboard = []');
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
    await click(win, '#drawer .drawer-tab[data-dtab="history"]');
    await waitForDOM(win, `(() => document.querySelector('#drawer .drawer-tab.on[data-dtab="history"]') !== null)()`, 'comment History tab');
    const historyCommentCount = await browserEval(win, `(() => [...document.querySelectorAll('#drawer .history-record')].filter((row) => row.querySelector(':scope > div')?.textContent.trim() === ${JSON.stringify(commentText)}).length)()`);
    assert.equal(historyCommentCount, 1, 'comment appears once in History');
    await click(win, '#drawer .drawer-tab[data-dtab="overview"]');
    await waitForDOM(win, `(() => [...document.querySelectorAll('#drawer .comment .txt')].filter((el) => el.textContent.trim() === ${JSON.stringify(commentText)}).length === 1 && document.querySelector('#drawer #comment-in')?.value === '')()`, 'comment Overview tab');
    const sseTitle = `${seed.root.title} · SSE`;
    await jsonRequest(`/api/items/${encodeURIComponent(seed.root.id)}`, { method: 'PATCH', body: { title: sseTitle } });
    await waitForDOM(win, `(() => document.querySelector('#drawer .detail-title')?.textContent === ${JSON.stringify(sseTitle)} && [...document.querySelectorAll('#drawer .comment .txt')].filter((el) => el.textContent.trim() === ${JSON.stringify(commentText)}).length === 1 && document.querySelector('#drawer #comment-in')?.value === '')()`, 'comment after SSE item update');

    const tabs = await browserEval(win, `([...document.querySelectorAll('#drawer .drawer-tab')]).map((el) => el.dataset.dtab)`);
    assert.deepEqual(tabs, ['overview', 'history', 'settings'], 'details sidebar has Overview/History/Settings tabs');
    await click(win, '#drawer .drawer-tab[data-dtab="history"]');
    await waitForDOM(win, `(() => document.querySelector('#drawer .drawer-tab.on[data-dtab="history"]') !== null)()`, 'History tab');
    await click(win, '#drawer .drawer-tab[data-dtab="settings"]');
    await waitForDOM(win, `(() => document.querySelector('#drawer .drawer-tab.on[data-dtab="settings"]') !== null)()`, 'Settings tab');
    await click(win, '#drawer .drawer-tab[data-dtab="overview"]');
    await waitForDOM(win, `(() => document.querySelector('#drawer .drawer-tab.on[data-dtab="overview"]') !== null)()`, 'Overview tab');
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

    await click(win, '#btn-view');
    await waitForDOM(win, `(() => document.body.classList.contains('list'))()`, 'ticket list');
    const activeText = await browserEval(win, `document.querySelector('#list')?.textContent || ''`);
    assert.equal(activeText.includes(seed.doneChildTitle), false, 'completed ticket is hidden by default');
    await click(win, '[data-f-completed]');
    await waitForDOM(win, `(() => (document.querySelector('#list')?.textContent || '').includes(${JSON.stringify(seed.doneChildTitle)}))()`, 'completed ticket toggle');

    await win.loadURL(`${base.href}#item=${encodeURIComponent(seed.root.id)}`);
    await waitForDOM(win, `(() => document.querySelector('#drawer.open') !== null)()`, 'live-update drawer');
    await click(win, '#drawer .drawer-tab[data-dtab="settings"]');
    await waitForDOM(win, `(() => document.querySelector('#drawer [data-k="title"]') !== null)()`, 'focused settings input');
    const focusBefore = await browserEval(win, `(() => { const input = document.querySelector('#drawer [data-k="title"]'); const drawer = document.querySelector('#drawer'); input.focus(); input.value = 'preserve this typed value'; drawer.scrollTop = 123; return { top: drawer.scrollTop, value: input.value }; })()`);
    await jsonRequest(`/api/items/${encodeURIComponent(seed.root.id)}`, { method: 'PATCH', body: { priority: 'high' } });
    await waitForDOM(win, `(() => { const input = document.querySelector('#drawer [data-k="title"]'); const drawer = document.querySelector('#drawer'); return document.activeElement === input && input.value === 'preserve this typed value' && drawer.scrollTop >= 100; })()`, 'focused input and sidebar scroll after live update');
    const focusAfter = await browserEval(win, `(() => ({ active: document.activeElement?.dataset?.k || '', value: document.querySelector('#drawer [data-k="title"]')?.value || '', top: document.querySelector('#drawer')?.scrollTop || 0 }))()`);
    assert.equal(focusAfter.active, 'title', 'live update preserves focused input');
    assert.equal(focusAfter.value, focusBefore.value, 'live update preserves unsaved input text');
    assert.ok(focusAfter.top >= focusBefore.top - 2, 'live update preserves sidebar scroll');

    return { attentionScreenshot, runScreenshot, consoleErrors };
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
    console.log(`PASS: supervision UI landing, attention review, runs/progress, compact navbar fit, UUID/deep-link copy, safe Markdown details, monitor label/progress, sidebar tabs/mouse limits/persistence, comments across tabs/SSE, completed filtering, clipboard mock, and live-update focus/scroll`);
    console.log(`artifacts: ${result.attentionScreenshot}, ${result.runScreenshot}`);
    console.log(`seed: ${seed.boardName} (${seed.roots.length} runs, ${seed.detailMonitor.id} details monitor)`);
    app.exit(0);
  } catch (error) {
    console.error(`FAIL: supervision UI regression — ${error?.stack || error}`);
    if (artifactDir) console.error(`artifacts: ${artifactDir}`);
    app.exit(1);
  }
});
