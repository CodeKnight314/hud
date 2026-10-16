import { app, BrowserWindow } from 'electron';
import { existsSync, mkdtempSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 1040;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function output(result) {
  const buffer = Buffer.from(`${JSON.stringify(result)}\n`);
  let offset = 0;
  while (offset < buffer.length) {
    try { offset += writeSync(1, buffer, offset, Math.min(65536, buffer.length - offset)); }
    catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
    }
  }
}

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function dimensions(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringifyPageErrors(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    try {
      return JSON.stringify(entry);
    } catch {
      return String(entry);
    }
  });
}

async function readCaptureState(win) {
  return win.webContents.executeJavaScript(`(async () => {
    const state = window.__hudCapture;
    const errors = Array.isArray(state?.errors) ? state.errors : [];
    return {
      ready: state?.ready === true,
      errors
    };
  })()`);
}

async function waitForCaptureState(win) {
  while (true) {
    const state = await readCaptureState(win);
    if (state.ready) return state;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

function isSameOrigin(target, origin) {
  try {
    return new URL(target).origin === origin;
  } catch {
    return false;
  }
}

/** Run the isolated capture window. Called directly by source Electron and by the packaged app's helper mode. */
export async function runRenderHelper() {
  const startedAt = Date.now();
  const errors = [];
  let win;
  let imageData = '';
  let imageSize;
  let failure;
  let mode = 'page';
  const addError = (message) => {
    if (message && !errors.includes(message)) errors.push(message);
  };

  try {
    const request = await readRequest();
    if (!request || typeof request.url !== 'string') throw new Error('request must include a URL');
    const initial = new URL(request.url);
    const origin = initial.origin;
    const width = dimensions(request.width, DEFAULT_WIDTH);
    const height = dimensions(request.height, DEFAULT_HEIGHT);
    mode = request.mode === 'program' || request.job?.mode === 'program' ? 'program' : 'page';

    win = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      addError(`popup blocked: ${url}`);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, target) => {
      if (isSameOrigin(target, origin)) return;
      addError(`navigation blocked: ${target}`);
      event.preventDefault();
    });
    win.webContents.on('will-redirect', (event, target) => {
      if (isSameOrigin(target, origin)) return;
      addError(`redirect blocked: ${target}`);
      event.preventDefault();
    });
    win.webContents.on('will-frame-navigate', (event, details) => {
      const target = typeof details === 'string' ? details : details?.url;
      if (!target || isSameOrigin(target, origin)) return;
      addError(`frame navigation blocked: ${target}`);
      event.preventDefault();
    });
    win.webContents.on('console-message', (event, details) => {
      const item = details && typeof details === 'object' ? details : event;
      const level = item?.level;
      const label = typeof level === 'string' ? level.toLowerCase() : Number(level) === 2 ? 'warning' : Number(level) >= 3 ? 'error' : 'info';
      if (label === 'verbose' || label === 'info' || label === 'log' || label === 'debug') return;
      const message = item?.message ?? item?.text ?? String(item);
      const source = item?.sourceId ? ` (${item.sourceId}${item.lineNumber ? `:${item.lineNumber}` : ''})` : '';
      addError(`console ${label}: ${message}${source}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      addError(`renderer process exited: ${details?.reason || 'unknown'}${details?.exitCode != null ? ` (${details.exitCode})` : ''}`);
    });
    win.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      addError(`page load failed ${code}: ${description} (${failedUrl})`);
    });

    await win.loadURL(request.url);
    const state = await waitForCaptureState(win);
    for (const message of stringifyPageErrors(state.errors)) addError(message);

    const pageErrors = await win.webContents.executeJavaScript(
      'Array.isArray(window.__hudCapture?.errors) ? window.__hudCapture.errors : []',
    );
    for (const message of stringifyPageErrors(pageErrors)) addError(message);

    const capture = await win.webContents.capturePage(undefined, { stayHidden: true });
    if (mode === 'program') {
      const pixels = capture.toBitmap();
      let varied = false;
      for (let i = 4; i < pixels.length; i += 4) if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) { varied = true; break; }
      if (!varied) addError('Custom program rendered no visible pixels.');
    }
    imageSize = capture.getSize();
    imageData = capture.toPNG().toString('base64');
  } catch (error) {
    failure = errorText(error);
    addError(failure);
  } finally {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {}
    if (!imageData) {
      process.exitCode = 1;
      process.stderr.write(`[hud render helper] capture failed: ${failure || errors.at(-1) || 'empty image'}\n`);
    }
    await output({
      image: { mimeType: 'image/png', data: imageData },
      errors,
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        mode,
        ...(imageSize ? { width: imageSize.width, height: imageSize.height } : {}),
      },
    });
    app.quit();
  }
}

const directEntry = process.argv[1] ? resolve(process.argv[1]) : '';
if (directEntry && existsSync(directEntry) && directEntry === fileURLToPath(import.meta.url)) {
  const profile = mkdtempSync(join(tmpdir(), 'hud-render-profile-'));
  app.setPath('userData', profile);
  app.on('will-quit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
  app.whenReady().then(() => runRenderHelper()).catch(async (error) => {
    const message = errorText(error);
    process.stderr.write(`[hud render helper] startup failed: ${message}\n`);
    await output({ image: { mimeType: 'image/png', data: '' }, errors: [message] });
    app.exit(1);
  });
}
