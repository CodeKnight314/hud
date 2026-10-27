// Headless Electron check: the board banner tracks saveError / recoveredFrom and cannot be dismissed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { app, BrowserWindow } from 'electron';

const repo = resolve(import.meta.dirname, '..');
const port = 7467;
const dataDir = mkdtempSync(join(tmpdir(), 'hud-persistence-ui-'));
const userData = join(dataDir, 'electron');
const nodeBin = existsSync('/exec-daemon/node') ? '/exec-daemon/node' : process.execPath;
const base = `http://127.0.0.1:${port}`;
const consoleFailures = [];
const loadFailures = [];
let server;
let serverLog = '';
let win;

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function startServer() {
  serverLog = '';
  server = spawn(nodeBin, [join(repo, 'src/server.ts')], {
    cwd: repo,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HUD_SCRATCH: '1',
      HUD_PORT: String(port),
      HUD_DATA: dataDir,
      HUD_PROBES: join(dataDir, 'probes'),
      HUD_VIEWS: join(dataDir, 'views'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const take = (chunk) => { serverLog += chunk.toString(); };
  server.stdout.on('data', take);
  server.stderr.on('data', take);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  await fetch(`${base}/api/shutdown`, { method: 'POST' }).catch(() => {});
  const child = server;
  await new Promise((done) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); done(); });
  });
}

async function waitFor(fn, label, timeout = 12_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? ` (${last.message})` : last ? ` (${JSON.stringify(last)})` : ''}\n${serverLog.slice(-2000)}`);
}

async function health() {
  const response = await fetch(`${base}/api/health`);
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json();
}

async function pageEval(source) {
  const json = await win.webContents.executeJavaScript(`Promise.resolve(${source}).then((value) => JSON.stringify(value ?? null))`);
  return JSON.parse(json);
}

async function bannerState() {
  return pageEval(`(() => {
    const banner = document.getElementById('persistence-banner');
    const top = document.getElementById('top').getBoundingClientRect();
    const box = banner.getBoundingClientRect();
    const canvas = document.getElementById('canvas').getBoundingClientRect();
    const buttons = [...banner.querySelectorAll('button')].map((button) => button.textContent);
    return {
      hidden: banner.hidden,
      text: banner.textContent,
      buttons,
      dismiss: banner.innerHTML.includes('dismiss') || banner.innerHTML.includes('data-close') || banner.innerHTML.includes('×'),
      belowHeader: box.top >= top.bottom - 1,
      aboveCanvas: canvas.top >= box.bottom - 1,
      conn: document.getElementById('conn').textContent,
    };
  })()`);
}

async function run() {
  mkdirSync(userData, { recursive: true });
  mkdirSync(join(dataDir, 'probes'), { recursive: true });
  mkdirSync(join(dataDir, 'views'), { recursive: true });
  app.setPath('userData', userData);
  await app.whenReady();
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event, level, message) => {
      try {
        const text = typeof message === 'string' ? message : event?.message;
        const kind = typeof level === 'number' ? level : event?.level;
        if (kind === 'error' || kind === 2) consoleFailures.push(String(text));
      } catch (error) {
        consoleFailures.push(String(error));
      }
    });
    contents.on('did-fail-load', (_event, code, description, url) => {
      if (code === -3) return;
      loadFailures.push(`${code} ${description} ${url}`);
    });
  });

  startServer();
  const clean = await waitFor(async () => {
    const info = await health();
    return info.ok && !info.saveError && !info.recoveredFrom ? info : false;
  }, 'clean health');
  assert.equal(clean.saveError, undefined);
  assert.equal(clean.recoveredFrom, undefined);

  win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadURL(`${base}/`);
  await waitFor(async () => {
    const state = await bannerState();
    return state.hidden && state.conn === '● live' ? state : false;
  }, 'hidden banner on a healthy board');

  const created = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hud-actor': 'ui-check' },
    body: JSON.stringify({ type: 'note', title: 'kept', text: 'yes' }),
  });
  assert.equal(created.ok, true, 'created a note');
  const backed = await fetch(`${base}/api/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hud-actor': 'ui-check' },
    body: JSON.stringify({ reason: 'kept' }),
  });
  assert.equal(backed.ok, true, 'wrote a backup');
  await stopServer();
  writeFileSync(join(dataDir, 'state.json'), '{');
  startServer();
  const recovered = await waitFor(async () => {
    const info = await health();
    return info.recoveredFrom ? info : false;
  }, 'recovered health');
  assert.match(recovered.recoveredFrom, /^state-.*\.json$/);

  await win.loadURL(`${base}/`);
  const shown = await waitFor(async () => {
    const state = await bannerState();
    return !state.hidden && state.text.includes(recovered.recoveredFrom) && state.conn === '● live' ? state : false;
  }, 'recovery banner');
  assert.deepEqual(shown.buttons, ['open data dir', 'restore']);
  assert.equal(shown.dismiss, false);
  assert.equal(shown.belowHeader, true);
  assert.equal(shown.aboveCanvas, true);
  assert.match(shown.text, /▲/);
  assert.doesNotMatch(shown.text, /not saving/);

  await pageEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await pageEval(`document.querySelector('#persistence-banner .persistence-text').click()`);
  const stayed = await bannerState();
  assert.equal(stayed.hidden, false, 'escape and a text click leave the banner up');
  assert.deepEqual(stayed.buttons, ['open data dir', 'restore']);

  await pageEval(`(window.confirm = () => true, true)`);
  await pageEval(`document.querySelector('[data-persistence="restore"]').click()`);
  await waitFor(async () => {
    const toast = await pageEval(`document.getElementById('toast').textContent`);
    return toast.includes(`restored ${recovered.recoveredFrom}`) ? toast : false;
  }, 'restore toast');
  const afterRestore = await waitFor(async () => {
    const state = await bannerState();
    const info = await health();
    return !state.hidden && state.text.includes(recovered.recoveredFrom) && info.recoveredFrom === recovered.recoveredFrom ? state : false;
  }, 'banner remains after restore');
  assert.deepEqual(afterRestore.buttons, ['open data dir', 'restore']);
  const items = await fetch(`${base}/api/items`).then((response) => response.json());
  assert.equal(items.some((item) => item.title === 'kept'), true, 'restore kept the recovered note');

  chmodSync(dataDir, 0o555);
  const extra = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hud-actor': 'ui-check' },
    body: JSON.stringify({ type: 'note', title: 'unsaved', text: 'memory' }),
  });
  assert.equal(extra.ok, true, 'accepted a note while the data dir was not writable');
  const failing = await waitFor(async () => {
    const info = await health();
    return info.saveError ? info : false;
  }, 'saveError health');
  const saving = await waitFor(async () => {
    const state = await bannerState();
    return !state.hidden && state.text.includes('not saving') && state.text.includes(failing.saveError) && state.text.includes(recovered.recoveredFrom) ? state : false;
  }, 'save-error banner');
  assert.deepEqual(saving.buttons, ['open data dir', 'restore']);
  assert.match(saving.text, /✕/);
  assert.equal(saving.dismiss, false);

  chmodSync(dataDir, 0o755);
  await waitFor(async () => {
    const info = await health();
    return info.recoveredFrom === recovered.recoveredFrom && !info.saveError ? info : false;
  }, 'save recovery');
  const healed = await waitFor(async () => {
    const state = await bannerState();
    return !state.hidden && state.text.includes(recovered.recoveredFrom) && !state.text.includes('not saving') ? state : false;
  }, 'banner drops only the cleared save error');
  assert.deepEqual(healed.buttons, ['open data dir', 'restore']);

  const revealed = await pageEval(`fetch('/api/data/reveal', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hud-actor': 'ui-check' } }).then(async (response) => ({ status: response.status, body: await response.json() }))`);
  assert.equal(revealed.status === 200 || revealed.status === 503, true, `reveal status ${revealed.status}`);
  if (revealed.status === 200) assert.equal(revealed.body.dataDir, dataDir);
  else assert.match(revealed.body.error, /data directory/);

  const shot = await win.capturePage();
  const png = shot.toPNG();
  assert.equal(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  writeFileSync('/tmp/hud-persistence-banner.png', png);
  assert.deepEqual(loadFailures, [], `load failures: ${loadFailures.join(' | ')}`);
  assert.deepEqual(consoleFailures, [], `console errors: ${consoleFailures.join(' | ')}`);
  console.log(`PASS: persistence banner follows recoveredFrom and saveError, stays after restore, and has no dismiss control`);
  console.log(`Screenshot: /tmp/hud-persistence-banner.png`);
}

const deadline = setTimeout(() => { console.error('persistence UI check exceeded 60s'); app.exit(1); }, 60_000);
let exitCode = 0;
void run().catch((error) => {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  console.error(serverLog.slice(-2000));
}).finally(async () => {
  clearTimeout(deadline);
  try { chmodSync(dataDir, 0o755); } catch {}
  try { await stopServer(); } catch {}
  try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
  app.exit(exitCode);
});
