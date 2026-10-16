import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { app, BrowserWindow } from 'electron';

const ACTOR = 'monitoring-ui-check';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function parseBase(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`invalid scratch URL: ${raw || '(missing)'}`); }
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || 0);
  if (url.protocol !== 'http:' || !new Set(['127.0.0.1', 'localhost', '::1', '[::1]']).has(host) ||
      !url.port || !Number.isInteger(port) || port < 1024 || port > 65535 || port === 7317 ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('URL must be an explicit loopback HTTP scratch port other than 7317, without credentials/query/fragment');
  }
  url.pathname = '/';
  return { base: url, port };
}

function assertScratchDataDir(value) {
  assert.equal(typeof value, 'string', '/api/health must report dataDir');
  const target = resolve(value);
  const roots = [tmpdir(), '/tmp', '/private/tmp'].map((root) => resolve(root));
  const scratch = roots.some((root) => {
    const rel = relative(root, target);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  });
  assert(scratch, `refusing non-scratch server dataDir: ${target}`);
}

async function request(base, path, { method = 'GET', body, actor = ACTOR } = {}) {
  const headers = { accept: 'application/json', 'x-hud-actor': encodeURIComponent(actor) };
  const init = { method, headers, signal: AbortSignal.timeout(90_000) };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(path, base), init);
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  assert(response.ok, `${method} ${path} → ${response.status}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return value;
}

async function waitFor(fn, label, timeout = 20_000, interval = 100) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await wait(interval);
  }
  throw new Error(`timed out waiting for ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
}

function nonce() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

function boardProgramCode(itemId) {
  return `<main style="box-sizing:border-box;width:100%;height:100%;padding:28px;background:#080808;color:#eee;font:20px monospace">
  <h1 style="margin:0 0 28px">custom monitoring board</h1>
  <p>value <output id="value">waiting</output></p>
  <label>local filter <input id="filter" autocomplete="off"></label>
  <p>filter state <output id="filter-state"></output></p>
  <button id="action" type="button">Update monitor label</button>
  <output id="action-state"></output>
</main>
<script>
(() => {
  const id = ${JSON.stringify(itemId)};
  const value = document.getElementById('value');
  const filter = document.getElementById('filter');
  const filterState = document.getElementById('filter-state');
  const actionState = document.getElementById('action-state');
  const draw = data => { value.textContent = String(data.byId[id]?.value ?? '—'); };
  draw(window.hud.data);
  window.hud.onData(draw);
  filter.addEventListener('input', () => { filterState.textContent = filter.value; });
  document.getElementById('action').addEventListener('click', async () => {
    try { await window.hud.action('update', { id, patch: { label: 'clicked' } }); actionState.textContent = 'updated'; }
    catch (error) { window.hud.error(error.message); }
  });
  window.hud.rendered();
})();
</script>`;
}

function cardProgramCode(itemId) {
  return `<main style="box-sizing:border-box;width:100%;height:100%;padding:12px;background:#080808;color:#eee;font:16px monospace">
  <div>card program</div><output id="card-value">waiting</output>
</main>
<script>
(() => {
  const id = ${JSON.stringify(itemId)};
  const output = document.getElementById('card-value');
  const draw = data => { output.textContent = String(data.byId[id]?.value ?? '—'); };
  draw(window.hud.data);
  window.hud.onData(draw);
  window.hud.rendered();
})();
</script>`;
}

async function seed(base) {
  const id = nonce();
  const board = await request(base, '/api/boards', { method: 'POST', body: { name: `Monitoring UI ${id}` } });
  await request(base, `/api/boards/${encodeURIComponent(board.id)}`, { method: 'PATCH', body: { autoOrganize: false } });
  const metricId = `ui-metric-${id}`;
  const tableId = `ui-table-${id}`;
  const now = Date.now();
  const columns = Array.from({ length: 9 }, (_, index) => ({ key: `col${index}`, label: index === 0 ? 'value' : `field ${index}`, type: index === 0 ? 'number' : 'string' }));
  const rows = Array.from({ length: 12 }, (_, index) => Object.fromEntries([
    [`col0`, index + 1],
    ...Array.from({ length: 8 }, (_, field) => [`col${field + 1}`, `row ${String(index + 1).padStart(2, '0')} field ${field + 1}`]),
  ]));
  const items = await request(base, '/api/items', { method: 'POST', body: [
    {
      id: metricId, type: 'monitor', board: board.id, title: 'Custom program metric',
      source: { kind: 'push' }, display: 'custom', x: 30, y: 35, w: 520, h: 440,
      value: 17, unit: 'req/s', observedAt: now, evidence: 'reported',
      coverage: { responding: 3, total: 4 },
      metric: { kind: 'rate', key: 'requests', scope: 'ui-fixture', unit: 'req/s', windowSeconds: 60, definition: 'Synthetic request rate used by the monitoring UI exercise.', source: 'synthetic UI reporter', sourceId: `reporter-${id}` },
    },
    {
      id: tableId, type: 'monitor', board: board.id, title: 'Twelve by nine table',
      source: { kind: 'push' }, display: 'table', x: 590, y: 35, w: 970, h: 620,
      observedAt: now, evidence: 'reported',
      metric: { kind: 'table', key: 'workers', scope: 'ui-fixture', unit: 'rows', definition: 'Twelve synthetic worker rows and nine sortable columns.', source: 'synthetic UI table' },
      data: { columns, rows },
    },
  ] });
  assert.equal(items.length, 2, 'created custom metric and table monitors');

  const cardProgram = {
    code: cardProgramCode(metricId), language: 'html', description: 'monitoring UI card renderer',
    bindings: [metricId], capabilities: [],
  };
  const itemProgramPath = `/api/items/${encodeURIComponent(metricId)}/program`;
  const itemPreview = await request(base, itemProgramPath, { method: 'POST', body: { action: 'preview', program: cardProgram } });
  assert.equal(itemPreview.valid, true, `custom card program preview: ${(itemPreview.errors || []).join('; ')}`);
  const itemApplied = await request(base, itemProgramPath, { method: 'POST', body: { action: 'apply', program: cardProgram } });
  assert(itemApplied.revision, 'custom card program published');

  const boardProgram = {
    code: boardProgramCode(metricId), language: 'html', description: 'monitoring UI board renderer',
    bindings: [metricId], capabilities: [{ operation: 'update', scope: board.id }],
  };
  const boardProgramPath = `/api/boards/${encodeURIComponent(board.id)}/program`;
  const boardPreview = await request(base, boardProgramPath, { method: 'POST', body: { action: 'preview', program: boardProgram } });
  assert.equal(boardPreview.valid, true, `custom board program preview: ${(boardPreview.errors || []).join('; ')}`);
  const boardApplied = await request(base, boardProgramPath, { method: 'POST', body: { action: 'apply', program: boardProgram } });
  assert(boardApplied.revision, 'custom board program published');
  return { board, metricId, tableId, boardProgramApplied: boardApplied, nonce: id };
}

async function pageEval(win, script) { return win.webContents.executeJavaScript(script); }

async function waitForPage(win, script, label, timeout = 20_000) {
  return waitFor(async () => await pageEval(win, script), label, timeout);
}

async function waitForProgramFrame(win, selector, label, timeout = 20_000) {
  return waitFor(async () => {
    const frames = win.webContents.mainFrame.frames;
    for (const frame of frames) {
      try {
        if (await frame.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)) return frame;
      } catch {}
    }
    return false;
  }, label, timeout);
}

async function programFrameState(win, selector, script) {
  for (const frame of win.webContents.mainFrame.frames) {
    try {
      if (await frame.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)) return frame.executeJavaScript(script);
    } catch {}
  }
  return null;
}

async function settlePaint(win) {
  await pageEval(win, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}

async function saveScreenshot(win, artifactDir, name) {
  const image = await win.capturePage();
  const bytes = image.toPNG();
  assert(bytes.length > 100 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${name} is a PNG screenshot`);
  const path = resolve(artifactDir, name);
  await writeFile(path, bytes);
  return path;
}

async function runUI(base, seedData, artifactDir) {
  const consoleErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1680,
    height: 1020,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `monitoring-ui-${seedData.nonce}`,
    },
  });
  win.webContents.on('console-message', (event, levelArg, messageArg, lineArg, sourceArg) => {
    const level = typeof event?.level === 'number' ? event.level : levelArg;
    const message = typeof event?.message === 'string' ? event.message : messageArg;
    const source = typeof event?.sourceId === 'string' ? event.sourceId : sourceArg;
    if (Number(level) >= 2) consoleErrors.push(`${source || 'renderer'}:${lineArg || ''} ${String(message)}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) consoleErrors.push(`load ${code} ${description} ${failedUrl}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => consoleErrors.push(`render process gone: ${JSON.stringify(details)}`));
  const screenshots = [];

  try {
    await win.loadURL(`${base.href}#${encodeURIComponent(seedData.board.id)}`);
    await waitForPage(win, `(() => !!(document.querySelector('#world.has-board-program .hud-program[data-program-board] iframe') && document.querySelector('#board-program-root')))()`, 'board custom program frame');
    const canvas = await pageEval(win, `(() => {
      const world = document.querySelector('#world');
      const iframe = document.querySelector('#board-program-root iframe');
      const r = iframe?.getBoundingClientRect();
      return { width: world?.offsetWidth, height: world?.offsetHeight, hostWidth: iframe?.parentElement?.offsetWidth, hostHeight: iframe?.parentElement?.offsetHeight, frameRect: r ? { width:r.width, height:r.height } : null };
    })()`);
    assert.deepEqual([canvas.width, canvas.height], [1600, 900], 'custom board overlays the fixed 1600×900 drawing surface');
    assert.deepEqual([canvas.hostWidth, canvas.hostHeight], [1600, 900], 'custom board host fills the drawing surface');
    await waitForProgramFrame(win, '#filter', 'board program isolated frame');
    const initialProgramState = await waitFor(async () => {
      const state = await programFrameState(win, '#filter', `({ value: document.querySelector('#value')?.textContent, width: innerWidth, height: innerHeight })`);
      return state?.value === '17' ? state : false;
    }, 'custom board initial data render');
    assert.equal(initialProgramState.value, '17', 'board program reads its initial value through hud.data.byId');
    assert.deepEqual([initialProgramState.width, initialProgramState.height], [1600, 900], 'custom board frame receives the full fixed drawing area');
    const boardFrame = await waitForProgramFrame(win, '#filter', 'board program frame handle');

    const retryMount = await pageEval(win, `(async () => {
      const module = await import('/programs.js');
      const fixtureRoot = document.createElement('section');
      fixtureRoot.setAttribute('aria-hidden', 'true');
      fixtureRoot.style.cssText = 'position:fixed;left:0;top:40px;width:520px;height:240px;z-index:10000;pointer-events:none;overflow:hidden';
      const host = document.createElement('div');
      host.className = 'hud-program';
      host.style.cssText = 'width:100%;height:100%';
      host.dataset.programBoard = ${JSON.stringify(seedData.board.id)};
      fixtureRoot.append(host);
      document.body.append(fixtureRoot);
      const originalFetch = window.fetch;
      let failedRequests = 0;
      let firstReport;
      let secondReport;
      let renderedIframe = false;
      try {
        try {
          window.fetch = async function(input, init) {
            const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
            if (path === '/api/program-sessions' && init?.method === 'POST' && failedRequests === 0) {
              failedRequests++;
              return new Response(JSON.stringify({ error: 'synthetic one-time session failure' }), { status: 503, headers: { 'content-type': 'application/json' } });
            }
            return originalFetch.call(window, input, init);
          };
          firstReport = await module.mountPrograms(fixtureRoot);
        } finally {
          window.fetch = originalFetch;
        }
        secondReport = await module.mountPrograms(fixtureRoot);
        renderedIframe = !!host.querySelector('iframe');
      } finally {
        window.fetch = originalFetch;
        await module.disposePrograms(fixtureRoot);
        fixtureRoot.remove();
      }
      return { firstErrors: firstReport?.errors || [], secondErrors: secondReport?.errors || [], failedRequests, renderedIframe, fixtureRemoved: !fixtureRoot.isConnected };
    })()`);
    assert.equal(retryMount.failedRequests, 1, 'retry regression injects exactly one synthetic 503 session response');
    assert.equal(retryMount.firstErrors.length, 1, 'first custom mount reports its failed session request');
    assert.match(retryMount.firstErrors[0], /synthetic one-time session failure/);
    assert.deepEqual(retryMount.secondErrors, [], 'second mount retries the removed failed session entry without errors');
    assert.equal(retryMount.renderedIframe, true, 'second mount creates and renders a real custom-program session');
    assert.equal(retryMount.fixtureRemoved, true, 'retry fixture is removed after the regression');

    const chrome = await pageEval(win, `(() => ({ top: document.querySelector('#top')?.getBoundingClientRect().height, bar: document.querySelector('#bar')?.getBoundingClientRect().height }))()`);
    assert(chrome.top > 0 && chrome.bar > 0, 'native navigation and status chrome remain visible around the custom board');
    await pageEval(win, `document.querySelector('#top-more summary')?.click()`);
    await waitForPage(win, `(() => document.querySelector('#btn-source')?.getBoundingClientRect().width > 0)()`, 'source inspector control');
    await pageEval(win, `document.querySelector('#btn-source')?.click()`);
    const inspector = await waitForPage(win, `(() => { const e=document.querySelector('#program-inspector'); return e && !e.hidden && e.textContent.includes('monitoring UI board renderer') && e.textContent.includes(${JSON.stringify(seedData.metricId)}); })()`, 'visible native source inspector with bindings');
    assert.equal(inspector, true, 'source inspector exposes the program description and bound metric');
    await settlePaint(win);
    screenshots.push(await saveScreenshot(win, artifactDir, 'monitoring-board-custom.png'));

    await boardFrame.executeJavaScript(`document.querySelector('#filter').value = 'keep-local-filter'; document.querySelector('#filter').dispatchEvent(new Event('input', { bubbles: true }));`, true);
    await boardFrame.executeJavaScript(`document.querySelector('#action').click()`, true);
    const itemAfterAction = await waitFor(async () => {
      const item = await request(base, `/api/items/${encodeURIComponent(seedData.metricId)}`);
      return item.label === 'clicked' ? item : false;
    }, 'granted custom program update action', 15_000);
    assert.equal(itemAfterAction.label, 'clicked', 'board-scoped update grant changed the bound metric label');
    const activity = await waitFor(async () => {
      const events = await request(base, `/api/activity?board=${encodeURIComponent(seedData.board.id)}&limit=100`);
      return events.find((entry) => entry.action === 'program.action' && entry.actor.includes('monitoring UI board renderer') && entry.text.endsWith(': update')) || false;
    }, 'program.action audit entry', 10_000);
    assert.equal(activity.action, 'program.action', 'custom management action is audited');

    const latest = await request(base, `/api/items/${encodeURIComponent(seedData.metricId)}`);
    const observedAt = Math.max(Date.now(), Number(latest.observation?.observedAt || 0) + 1);
    const refreshedAt = Date.now();
    await request(base, `/api/monitors/${encodeURIComponent(seedData.metricId)}/push`, {
      method: 'POST', body: { value: 23, observedAt, evidence: 'reported' },
    });
    const changedState = await waitFor(async () => {
      const state = await programFrameState(win, '#filter', `({ value: document.querySelector('#value')?.textContent, filter: document.querySelector('#filter')?.value, filterState: document.querySelector('#filter-state')?.textContent })`);
      return state?.value === '23' ? state : false;
    }, 'board program data update', 10_000, 100);
    assert(Date.now() - refreshedAt <= 10_000, 'custom program receives the reading within ten seconds');
    assert.deepEqual([changedState.filter, changedState.filterState], ['keep-local-filter', 'keep-local-filter'], 'onData updates preserve local filter interaction state');

    await pageEval(win, `document.querySelector('#btn-source')?.click()`);
    const disabled = await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/program`, {
      method: 'POST', body: { action: 'disable', expectedRevision: seedData.boardProgramApplied.revision },
    });
    assert.equal(disabled.program?.disabled, true, 'board custom program disabled through the API');
    await waitForPage(win, `(() => !!(!document.querySelector('#board-program-root') && document.querySelector('.item[data-id="${seedData.metricId}"]') && document.querySelector('.item[data-id="${seedData.tableId}"]')))()`, 'native board after custom program is disabled');
    const nativeVisibility = await pageEval(win, `(() => ({
      boardProgram: !!document.querySelector('#world.has-board-program'),
      metric: getComputedStyle(document.querySelector('.item[data-id="${seedData.metricId}"]')).display,
      table: getComputedStyle(document.querySelector('.item[data-id="${seedData.tableId}"]')).display,
    }))()`);
    assert.deepEqual(nativeVisibility, { boardProgram: false, metric: 'flex', table: 'flex' }, 'disabling the whole-board program restores native cards');

    await waitForPage(win, `(() => !!(document.querySelector('.item[data-id="${seedData.tableId}"] .monitor-data table tbody tr[data-monitor-row]') && document.querySelector('.item[data-id="${seedData.tableId}"] .monitor-data table thead button[data-monitor-sort]')))()`, 'native sortable table');
    const tableBefore = await pageEval(win, `(() => {
      const card = document.querySelector('.item[data-id="${seedData.tableId}"]');
      const table = card?.querySelector('.monitor-data table');
      return { rows: table?.querySelectorAll('tbody tr[data-monitor-row]').length, columns: table?.querySelectorAll('thead th').length, sortButtons: table?.querySelectorAll('thead button[data-monitor-sort]').length, footer: card?.querySelector('.readout-footer')?.textContent || '' };
    })()`);
    assert.deepEqual([tableBefore.rows, tableBefore.columns, tableBefore.sortButtons], [12, 9, 9], 'table retains all twelve rows, nine columns, and sortable headers');
    assert.match(tableBefore.footer, /source .*evidence .*age .*coverage .*Twelve synthetic worker/si, 'table keeps the provenance footer');
    await pageEval(win, `document.querySelector('.item[data-id="${seedData.tableId}"] thead button[data-monitor-sort="0"]')?.click()`);
    const sortedFirst = await waitForPage(win, `(() => document.querySelector('.item[data-id="${seedData.tableId}"] tbody tr[data-monitor-row] td')?.textContent.trim() === '12')()`, 'local numeric table sort');
    assert.equal(sortedFirst, true, 'local table sort orders the numeric value column');

    const nativeCardFrame = await waitForProgramFrame(win, '#card-value', 'native custom card program frame');
    const drawingSize = await nativeCardFrame.executeJavaScript(`(() => {
      const drawing = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      drawing.setAttribute('width', '100%'); drawing.setAttribute('height', '100%'); drawing.setAttribute('viewBox', '0 0 500 200');
      document.body.append(drawing);
      const box = drawing.getBoundingClientRect();
      drawing.remove();
      return { width:box.width, height:box.height, expectedWidth:innerWidth, expectedHeight:innerHeight };
    })()`);
    assert(Math.abs(drawingSize.width - drawingSize.expectedWidth) <= 1 && Math.abs(drawingSize.height - drawingSize.expectedHeight) <= 1, 'percentage-sized SVG drawings use the custom canvas viewport');
    const cardGeometry = await pageEval(win, `(() => {
      const card = document.querySelector('.item[data-id="${seedData.metricId}"]');
      const body = card?.querySelector('.bd'), footer = card?.querySelector('.readout-footer');
      const frame = body?.querySelector('.hud-program iframe');
      const b = body?.getBoundingClientRect(), f = frame?.getBoundingClientRect();
      return { contained: !!b && !!f && f.left >= b.left - 1 && f.top >= b.top - 1 && f.right <= b.right + 1 && f.bottom <= b.bottom + 1, body: b ? { width:b.width, height:b.height } : null, frame: f ? { width:f.width, height:f.height } : null, footer: footer?.textContent || '', footerHeight: footer?.getBoundingClientRect().height || 0 };
    })()`);
    assert.equal(cardGeometry.contained, true, 'custom-card iframe is contained by its body after the metadata footer');
    assert(cardGeometry.footerHeight > 0, 'custom-card metadata footer remains visible below the iframe body');
    assert.match(cardGeometry.footer, /source .*evidence .*age .*coverage .*Synthetic request rate/si, 'custom-card footer exposes source, evidence, age, coverage, and definition');
    await settlePaint(win);
    screenshots.push(await saveScreenshot(win, artifactDir, 'monitoring-board-native.png'));

    const selected = await pageEval(win, `(() => {
      const card = document.querySelector('.item[data-id="${seedData.metricId}"]');
      const target = card?.querySelector('.hd .t');
      const r = target?.getBoundingClientRect();
      if (!target || !r) return false;
      const event = { bubbles:true, cancelable:true, pointerId:71, pointerType:'mouse', button:0, clientX:r.left + 4, clientY:r.top + 4 };
      target.dispatchEvent(new PointerEvent('pointerdown', event));
      document.querySelector('#canvas').dispatchEvent(new PointerEvent('pointerup', event));
      return card.classList.contains('sel');
    })()`);
    assert.equal(selected, true, 'native metric can be selected before clearing');
    await pageEval(win, `document.querySelector('.item[data-id="${seedData.metricId}"] .expand-btn')?.click()`);
    await waitForPage(win, `(() => document.querySelector('#drawer.open') !== null)()`, 'open monitor details before board clear');

    const extraMetricId = `ui-compare-${seedData.nonce}`;
    await request(base, '/api/items', { method: 'POST', body: {
      id: extraMetricId, type: 'monitor', board: seedData.board.id, title: 'Clear comparison fixture',
      source: { kind: 'push' }, value: 17, unit: 'req/s', observedAt: Date.now(), evidence: 'reported',
      metric: { kind: 'rate', key: 'requests-copy', scope: 'ui-fixture', unit: 'req/s', windowSeconds: 60, definition: 'Second reading for the clear comparison fixture.', source: 'synthetic UI reporter' },
    } });
    await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/annotations`, { method: 'POST', body: { time: Date.now(), text: 'clear fixture annotation' } });
    await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/comparisons`, { method: 'POST', body: {
      id: `ui-comparison-${seedData.nonce}`, left: seedData.metricId, right: extraMetricId, relation: 'equal', tolerance: 0, holdFor: 0, maxSkew: 60,
    } });
    const dashboardSpec = { rows: [{ key: 'clear-check', cards: [{ key: 'clear-card', span: 12, item: {
      type: 'monitor', title: 'Clear dashboard fixture', source: { kind: 'push' }, value: 1,
      metric: { kind: 'scalar', key: 'clear-check', scope: 'ui-fixture', unit: 'checks', definition: 'Managed card used to verify dashboard reset.', source: 'synthetic UI dashboard' },
    } }] }] };
    await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/dashboard`, { method: 'PUT', body: { spec: dashboardSpec } });
    const boardProgramPath = `/api/boards/${encodeURIComponent(seedData.board.id)}/program`;
    const activeBoardProgram = await request(base, boardProgramPath, { method: 'POST', body: {
      action: 'apply', expectedRevision: disabled.revision,
      program: { code: boardProgramCode(seedData.metricId), language: 'html', description: 'monitoring UI board renderer', bindings: [seedData.metricId], capabilities: [{ operation: 'update', scope: seedData.board.id }] },
    } });
    assert(activeBoardProgram.revision, 'board custom program re-enabled for clear coverage');
    await waitForPage(win, `(() => !!document.querySelector('#world.has-board-program .hud-program[data-program-board] iframe'))()`, 're-enabled custom board before clear');

    const itemsBeforeClear = await request(base, `/api/items?board=${encodeURIComponent(seedData.board.id)}`);
    assert(itemsBeforeClear.length >= 4, 'clear exercise has native, comparison, and dashboard items');
    const boardBeforeClear = (await request(base, '/api/boards')).find((board) => board.id === seedData.board.id);
    const activeAnnotations = await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/annotations`);
    const activeComparisons = await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/comparisons`);
    assert(boardBeforeClear && boardBeforeClear.autoOrganize === false, 'clear fixture has a board setting to preserve');
    assert(activeAnnotations.length > 0 && activeComparisons.length > 0, 'clear fixture has annotations and comparisons to reset');
    assert(await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/dashboard`), 'clear fixture has a dashboard to reset');

    await pageEval(win, `Object.defineProperty(window, '__confirmMessages', { configurable:true, value:[] }); window.confirm = message => { window.__confirmMessages.push(String(message)); return true; }; true;`);
    await pageEval(win, `document.querySelector('#btn-board')?.click()`);
    await waitForPage(win, `(() => !!(document.querySelector('#board-menu [data-board-clear]') && document.querySelector('#board-menu [data-board-delete]')))()`, 'separate board maintenance actions');
    const maintenance = await pageEval(win, `(() => {
      const clear = document.querySelector('#board-menu [data-board-clear]');
      const del = document.querySelector('#board-menu [data-board-delete]');
      return { clear:clear?.textContent.trim(), delete:del?.textContent.trim(), clearHelp:document.getElementById('board-clear-help')?.textContent, deleteHelp:document.getElementById('board-delete-help')?.textContent, deleteDisabled:!!del?.disabled };
    })()`);
    assert.deepEqual([maintenance.clear, maintenance.delete, maintenance.deleteDisabled], ['clear canvas', 'delete canvas', false], 'clear and delete are separate, enabled actions for this board');
    assert.match(maintenance.clearHelp, /move.*Trash.*keeps this board and its settings/i, 'clear help explains Trash and board preservation');
    assert.match(maintenance.deleteHelp, /removes this board.*items move to Trash/i, 'delete help explains board removal and Trash');
    await pageEval(win, `document.querySelector('#board-menu [data-board-clear]')?.click()`);
    const clearConfirm = await pageEval(win, `window.__confirmMessages.at(-1) || ''`);
    assert.match(clearConfirm, /Clear canvas .*move to Trash/i, 'clear confirmation explains that items move to Trash');
    assert.match(clearConfirm, /keeps the board and its settings/i, 'clear confirmation explains that the board is retained');
    await waitFor(async () => (await request(base, `/api/items?board=${encodeURIComponent(seedData.board.id)}`)).length === 0, 'board clear removes all canvas items', 20_000);
    const clearedBoard = (await request(base, '/api/boards')).find((board) => board.id === seedData.board.id);
    assert(clearedBoard, 'clear preserves the board identity');
    assert.equal(clearedBoard.name, boardBeforeClear.name, 'clear preserves board name');
    assert.equal(clearedBoard.autoOrganize, boardBeforeClear.autoOrganize, 'clear preserves board settings');
    const trashedAfterClear = await request(base, `/api/trash?board=${encodeURIComponent(seedData.board.id)}`);
    const trashedIds = new Set(trashedAfterClear.map((entry) => entry.item?.id));
    assert(itemsBeforeClear.every((item) => trashedIds.has(item.id)), 'clear moves every board item to Trash');
    assert.equal(await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/dashboard`), null, 'clear resets the managed dashboard');
    assert.deepEqual(await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/annotations`), [], 'clear resets annotations');
    assert.deepEqual(await request(base, `/api/boards/${encodeURIComponent(seedData.board.id)}/comparisons`), [], 'clear resets comparisons');
    const clearedProgram = await request(base, boardProgramPath);
    assert.equal(clearedProgram.program?.disabled, true, 'clear disables the full-board program');
    await waitForPage(win, `(() => !document.querySelector('#board-program-root') && !document.querySelector('#world .item') && !document.querySelector('#drawer.open'))()`, 'empty native board after clear');
    const clearUI = await pageEval(win, `({ blank:document.body.classList.contains('blank'), mode:document.querySelector('#mode')?.textContent.trim() })`);
    assert.equal(clearUI.blank, true, 'clear returns the native board to its blank-canvas state');
    assert.equal(clearUI.mode, 'NORMAL', 'clear removes the active selection');

    const deleteItemId = `ui-delete-${seedData.nonce}`;
    await request(base, '/api/items', { method: 'POST', body: { id: deleteItemId, type: 'note', board: seedData.board.id, title: 'Delete fixture', text: 'This item must go to Trash with its deleted board.' } });
    await waitForPage(win, `(() => !!document.querySelector('.item[data-id="${deleteItemId}"]'))()`, 'disposable item before board deletion');
    await pageEval(win, `document.querySelector('#btn-board')?.click()`);
    await waitForPage(win, `(() => !!document.querySelector('#board-menu [data-board-delete]:not([disabled])'))()`, 'enabled delete canvas action');
    await pageEval(win, `document.querySelector('#board-menu [data-board-delete]')?.click()`);
    const deleteConfirm = await pageEval(win, `window.__confirmMessages.at(-1) || ''`);
    assert.match(deleteConfirm, /Delete canvas .*removes the board and its settings/i, 'delete confirmation distinguishes board deletion from clear');
    assert.match(deleteConfirm, /item will move to Trash/i, 'delete confirmation explains item Trash behavior');
    await waitFor(async () => !(await request(base, '/api/boards')).some((board) => board.id === seedData.board.id), 'board deletion from the switcher', 20_000);
    const allTrash = await request(base, '/api/trash');
    assert(allTrash.some((entry) => entry.item?.id === deleteItemId), 'delete moves remaining board items to Trash');
    const validBoardIds = new Set((await request(base, '/api/boards')).map((board) => board.id));
    const activeHash = await waitForPage(win, `(() => decodeURIComponent(location.hash.replace(/^#/, '')) === 'main' ? 'main' : false)()`, 'navigation to the protected main board after deletion');
    assert(validBoardIds.has(activeHash), `deleted board navigation resolved to a valid board: ${activeHash}`);
    assert.equal(await pageEval(win, `document.querySelector('#btn-board')?.textContent.trim()`), `board: ${(await request(base, '/api/boards')).find((board) => board.id === activeHash)?.name}`, 'board switcher reflects the surviving board');
    await pageEval(win, `document.querySelector('#btn-board')?.click()`);
    await waitForPage(win, `(() => !!document.querySelector('#board-menu [data-board-delete]'))()`, 'main board maintenance controls');
    const mainActions = await pageEval(win, `(() => {
      const clear = document.querySelector('#board-menu [data-board-clear]');
      const del = document.querySelector('#board-menu [data-board-delete]');
      return { board:document.querySelector('#board-menu .board-maintenance-title')?.textContent, clearDisabled:!!clear?.disabled, deleteDisabled:!!del?.disabled, deleteHelp:document.getElementById('board-delete-help')?.textContent };
    })()`);
    assert.equal(activeHash, 'main', 'deleting a disposable board navigates to the protected main board');
    assert.equal(mainActions.clearDisabled, false, 'main board can still be cleared');
    assert.equal(mainActions.deleteDisabled, true, 'main board delete action is visibly disabled');
    assert.match(mainActions.deleteHelp, /main board cannot be deleted/i, 'main board disable state has an explanation');

    return { consoleErrors, screenshots, board: seedData.board.id, metricId: seedData.metricId, tableId: seedData.tableId };
  } catch (error) {
    try { await settlePaint(win); screenshots.push(await saveScreenshot(win, artifactDir, 'monitoring-ui-failure.png')); } catch {}
    throw error;
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

async function main() {
  const rawBase = process.argv[2];
  const rawArtifacts = process.argv[3];
  if (!rawBase || !rawArtifacts) throw new Error('usage: electron scripts/check-monitoring-ui.mjs http://127.0.0.1:<scratch-port> <artifact-dir>');
  const { base, port } = parseBase(rawBase);
  const artifactDir = resolve(rawArtifacts);
  await mkdir(artifactDir, { recursive: true });

  const health = await request(base, '/api/health');
  assert.equal(health.name, 'hud', 'target is a hud server');
  assert.equal(health.port, port, 'health confirms the explicit target port');
  assertScratchDataDir(health.dataDir);

  const seedData = await seed(base);
  const result = await runUI(base, seedData, artifactDir);
  assert.deepEqual(result.consoleErrors, [], `renderer/module errors: ${result.consoleErrors.join(' | ')}`);
  console.log(`PASS: real Electron monitoring UI on ${base.origin} (scratch ${health.dataDir})`);
  console.log('PASS: 1600×900 custom board/native chrome and source inspector; program action/audit and live onData state; native fallback and 12×9 table sort; distinct clear/delete actions, Trash behavior, metadata reset, and valid navigation');
  console.log(`board: ${result.board}; metric: ${result.metricId}; table: ${result.tableId}`);
  console.log(`artifacts: ${result.screenshots.join(', ')}`);
}

app.whenReady().then(() => main()).then(
  () => app.exit(0),
  (error) => { console.error(`FAIL: monitoring UI integration — ${error?.stack || error}`); app.exit(1); },
);
