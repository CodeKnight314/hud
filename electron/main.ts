import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, screen, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOURCE_ROOT, asset } from '../src/assets.ts';
import { isElectronNodeMode, primeLoginEnv } from '../src/electron-runtime.ts';
import { Hud } from '../src/client.ts';
import { config } from '../src/config.ts';
import { refreshInstalledCli } from '../src/cliinstall.ts';
import { prepareBackendUpdate, stopBackendForUpdate } from '../src/updates.ts';
import { desktopSettings } from './settings.ts';

const renderHelperMode = process.argv.includes('--hud-render-helper');

if (renderHelperMode) {
  const profile = mkdtempSync(join(tmpdir(), 'hud-render-profile-'));
  app.setPath('userData', profile);
  app.on('will-quit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
  app.whenReady().then(async () => {
    try {
      const helperUrl = pathToFileURL(join(SOURCE_ROOT, 'electron', 'render.mjs')).href;
      const { runRenderHelper } = await import(helperUrl);
      await runRenderHelper();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[hud render helper] ${message}\n`);
      process.stdout.write(`${JSON.stringify({ image: { mimeType: 'image/png', data: '' }, errors: [message] })}\n`, () => app.exit(1));
    }
  });
}

// The app binary is also the CLI (node mode). If that env leaked in, do not open a window.
if (!renderHelperMode && isElectronNodeMode()) {
  console.error('hud: refusing to start the GUI in node mode');
  app.exit(1);
}

if (!renderHelperMode) {
let cfg: ReturnType<typeof config>;
try {
  cfg = config();
} catch (e) {
  dialog.showErrorBox('hud: bad configuration', (e as Error).message);
  app.exit(1);
  throw e;
}
const { port, dataDir } = cfg;
const url = `http://127.0.0.1:${port}/`;
let hud = new Hud({ actor: 'user', autostart: true });
const version = JSON.parse(asset('package.json') ?? '{"version":"0.0.0"}').version as string;

// Chromium's profile (and with it the single-instance lock) is keyed to the data dir, so a dev run with
// a scratch dir can sit beside the installed app.
app.setPath('userData', join(dataDir, 'electron'));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let quittingForUpdate = false;
const stateFile = () => join(app.getPath('userData'), 'window.json');

function readPrefs(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

// default: agents may depend on the server after the window closes
let keepServer = readPrefs().keepServer !== false;
let saveTimer: NodeJS.Timeout | null = null;
const settings = desktopSettings({
  version, packaged: cfg.packaged, dataDir,
  checkOnLaunch: () => readPrefs().checkUpdatesOnLaunch !== false,
  setCheckOnLaunch: (enabled) => {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ ...readPrefs(), checkUpdatesOnLaunch: enabled }));
  },
  quitForUpdate: async () => {
    await stopBackendForUpdate(new Hud({ actor: 'user', autostart: false }), dataDir, version);
    quittingForUpdate = true;
    app.quit();
  },
});
const settingsEntry: Electron.MenuItemConstructorOptions = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => settings.show() };

function bounds(): Electron.BrowserWindowConstructorOptions {
  try {
    const s = readPrefs();
    if (typeof s.x !== 'number') return { width: 1280, height: 860 };
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width && s.x + s.width > a.x && s.y < a.y + a.height && s.y + s.height > a.y;
    });
    if (visible) return { x: s.x, y: s.y, width: s.width, height: s.height };
  } catch {}
  return { width: 1280, height: 860 };
}

function savePrefsNow(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const b = win && !win.isDestroyed() ? { ...win.getNormalBounds(), maximized: win.isMaximized() } : {};
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ ...readPrefs(), ...b, keepServer }));
  } catch {}
}

function saveBounds(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(savePrefsNow, 500);
}

function icon() {
  const p = join(process.resourcesPath ?? '', 'trayTemplate.png');
  let img = nativeImage.createFromPath(p);
  if (process.platform === 'darwin') {
    img.setTemplateImage(true);
  } else if (!img.isEmpty()) {
    // the asset is black-on-transparent (a mac template); other trays need a light glyph to be visible
    const buf = img.toBitmap();
    for (let i = 0; i < buf.length; i += 4) buf[i] = buf[i + 1] = buf[i + 2] = 255;
    img = nativeImage.createFromBitmap(buf, img.getSize());
  }
  return img;
}

function show(): void {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(): void {
  win = new BrowserWindow({
    ...bounds(),
    show: false,
    backgroundColor: '#000000',
    title: 'hud',
    ...(process.platform === 'darwin' ? {} : { icon: join(process.resourcesPath ?? '', 'icon.png') }),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // the canvas is a plain web page: no preload, no node in the renderer
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // links in notes and the guide belong in the real browser, not in the app frame
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    try {
      if (new URL(target).origin === `http://127.0.0.1:${port}`) return;
    } catch {}
    e.preventDefault();
    if (/^https?:/.test(target)) shell.openExternal(target);
  });

  if (readPrefs().maximized) win.maximize();

  win.on('close', (e) => {
    // macOS convention: the window closes, the app (and the server agents use) stays alive
    if (!quitting) {
      e.preventDefault();
      savePrefsNow();
      win?.hide();
    }
  });
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // a blank-but-alive window beats a connection error while the server boots
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(STARTING));
  win.once('ready-to-show', () => win?.show());
  win.webContents.on('did-finish-load', () => console.log(`[hud] loaded ${win?.webContents.getURL().slice(0, 60)}`));
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED: a normal cancelled navigation
    if (String(failedUrl).startsWith('data:')) return;
    console.error(`[hud renderer] load failed ${code} ${desc} ${failedUrl}`);
    showUnreachable(true);
    void heal();
  });
  // surface renderer failures (a tripped Host/Origin check would show up here) in the app log
  win.webContents.on('console-message', (e) => {
    const { level, message } = e as unknown as { level: number | string; message: string };
    if (level === 'error' || level === 'warning' || Number(level) >= 2) console.error(`[hud renderer] ${message}`);
  });
}

const STARTING = `<body style="font:13px ui-monospace,monospace;background:#000;color:#8c8c8c;padding:40px">
  hud — starting server…</body>`;

function showUnreachable(retrying = false): void {
  const html = `<body style="font:13px ui-monospace,monospace;background:#000;color:#e8e8e8;padding:40px">
    <p>hud server is not reachable at <b>${url}</b>.</p>
    <p style="color:#8c8c8c">${
      retrying
        ? 'Starting it again — this window reloads by itself once the server answers.'
        : 'Start it from the Server menu, or run <code>hud start</code> in a terminal.'
    }</p>
  </body>`;
  win?.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

/** After a failed load (a reload against a server that has died), bring the server back and reconnect.
 *  Without this a Cmd+R against a dead server left a completely black window. */
let healing = false;
let connecting: Promise<void> | null = null;
function ensureCurrentServer(): Promise<void> {
  return connecting ??= (async () => {
    if (cfg.packaged) await prepareBackendUpdate(new Hud({ actor: 'user', autostart: false }), dataDir, version);
    hud = new Hud({ actor: 'user', autostart: true });
    await hud.ensureServer();
  })().finally(() => { connecting = null; });
}
async function heal(retries = 20): Promise<void> {
  if (healing) return;
  healing = true;
  try {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await ensureCurrentServer();
        await win?.loadURL(url);
        return;
      } catch {
        /* still down — keep trying */
      }
    }
    console.error(`[hud] giving up reconnecting to ${url}`);
  } finally {
    healing = false;
  }
}

/** start (or find) the server, then load it; never silently respawn after an explicit stop */
async function connect(): Promise<void> {
  try {
    await ensureCurrentServer();
    await win?.loadURL(url);
  } catch (e) {
    dialog.showErrorBox('hud could not start its server', (e as Error).message);
    showUnreachable();
  }
}

function menu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const, submenu: [
      { role: 'about' as const }, { type: 'separator' as const }, settingsEntry, { type: 'separator' as const },
      { role: 'services' as const }, { type: 'separator' as const }, { role: 'hide' as const },
      { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const },
    ] }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Canvas', accelerator: 'CmdOrCtrl+O', click: show },
        { label: 'Open in Browser', click: () => shell.openExternal(url) },
        ...(!isMac ? [settingsEntry] : []),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Server',
      submenu: [
        { label: 'Start / Reconnect', click: () => void connect() },
        {
          label: 'Stop Server',
          click: async () => {
            await hud.request('POST', '/api/shutdown').catch(() => {});
            showUnreachable();
          },
        },
        { type: 'separator' },
        {
          label: 'Keep server running after quit',
          type: 'checkbox',
          checked: keepServer,
          click: (i) => {
            keepServer = i.checked;
            savePrefsNow();
          },
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open guide', click: () => shell.openExternal(`${url}api/guide`) },
        {
          label: 'Install "hud" command…',
          click: async () => {
            const { installCli } = await import('../src/cliinstall.ts');
            dialog.showMessageBox({ message: installCli(), type: 'info', buttons: ['OK'] });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function makeTray(): void {
  if (process.env.HUD_TRAY === '0') return;
  try {
    tray = new Tray(icon());
  } catch {
    return; // no icon available (dev run) — the dock/menu still work
  }
  tray.setToolTip(`hud — ${url}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Canvas', click: show },
      { label: 'Open in Browser', click: () => shell.openExternal(url) },
      { label: 'Settings…', click: () => settings.show() },
      { type: 'separator' },
      {
        label: 'Stop Server',
        click: async () => {
          await hud.request('POST', '/api/shutdown').catch(() => {});
          showUnreachable();
        },
      },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', show);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', show);
  app.on('window-all-closed', () => {
    // deliberately not quitting: the server may be serving agents
  });
  app.on('activate', show);
  app.on('before-quit', () => {
    quitting = true;
    savePrefsNow();
    if (!keepServer && !quittingForUpdate) hud.request('POST', '/api/shutdown').catch(() => {});
  });

  app.whenReady().then(async () => {
    menu();
    makeTray();
    createWindow();
    await primeLoginEnv(); // async, so the window paints while the shell probe runs
    if (cfg.packaged) {
      try { refreshInstalledCli(); } catch (error) { console.error(`[hud] command repair failed: ${(error as Error).message}`); }
    }
    await connect();
    if (process.env.HUD_SCRATCH !== '1') void settings.checkAtLaunch();
    console.log(`[hud] app ready — ${url} (data: ${dataDir})`);
  });
}
}
