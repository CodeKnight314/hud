import { BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SOURCE_ROOT } from '../src/assets.ts';
import { cliInfo, installCli } from '../src/cliinstall.ts';
import { primeLoginEnv } from '../src/electron-runtime.ts';
import { CLIENT_IDS, ConnectionService, configSnippet } from '../src/mcpinstall.ts';
import type { ClientId } from '../src/mcpinstall.ts';
import { UpdateChecker } from '../src/updates.ts';

export function desktopSettings(options: {
  version: string; packaged: boolean; dataDir: string;
  checkOnLaunch: () => boolean; setCheckOnLaunch: (enabled: boolean) => void;
  quitForUpdate?: () => Promise<void>;
  connectionService?: ConnectionService; updateChecker?: UpdateChecker;
  openExternal?: (url: string) => Promise<unknown>; copyText?: (text: string) => void; visible?: boolean;
}) {
  let window: BrowserWindow | null = null;
  let service: ConnectionService | null = options.connectionService ?? null;
  let cachedConnections: Awaited<ReturnType<ConnectionService['list']>> | null = null;
  let changing = false;
  const file = join(SOURCE_ROOT, 'web', 'settings.html');
  const settingsUrl = pathToFileURL(file).href;
  const updates = options.updateChecker ?? new UpdateChecker({ version: options.version });
  const openExternal = options.openExternal ?? shell.openExternal;
  const connections = async () => { await primeLoginEnv(); return service ??= new ConnectionService(); };
  const state = async (refresh = false) => {
    if (refresh || !cachedConnections) cachedConnections = await (await connections()).list();
    return {
    version: options.version,
    platformName: `${({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[process.platform] ?? process.platform} ${process.arch}`,
    packaged: options.packaged,
    dataDir: options.dataDir,
    command: cliInfo(),
    connections: cachedConnections,
    updates: updates.state(options.checkOnLaunch()),
    };
  };

  // The board and its sandboxed custom programs never receive this bridge.
  ipcMain.handle('hud:settings', async (event, action: unknown, value: unknown) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== settingsUrl) throw new Error('Settings requests must come from the Settings window');
    if (typeof action !== 'string') throw new Error('Invalid Settings action');
    if (action === 'state') return state();
    if (action === 'connections') {
      await primeLoginEnv(true);
      service = options.connectionService ?? new ConnectionService();
      return state(true);
    }
    if (action === 'copy-config') {
      if (!cliInfo().ready) throw new Error('Install or repair the hud command before copying a configuration.');
      (options.copyText ?? clipboard.writeText)(configSnippet());
      return;
    }
    if (action === 'check-updates') { await updates.check(); return state(); }
    if (action === 'check-on-launch') {
      if (typeof value !== 'boolean') throw new Error('Expected a boolean preference');
      options.setCheckOnLaunch(value);
      return state();
    }
    if (action === 'open-release') { await openExternal(updates.state(options.checkOnLaunch()).releaseUrl); return; }
    if (action === 'download-update') {
      const update = updates.state(options.checkOnLaunch());
      if (update.status !== 'available' || !update.downloadUrl) throw new Error('Check for a newer release with a matching installer first.');
      await openExternal(update.downloadUrl);
      return;
    }
    if (action === 'quit-for-update') {
      if (!options.packaged || !options.quitForUpdate) throw new Error('Quit for update is only available in the packaged app.');
      if (changing) throw new Error('Wait for the current Settings change to finish before quitting.');
      changing = true;
      try { await options.quitForUpdate(); } finally { changing = false; }
      return;
    }
    if (!['install-command', 'connect', 'disconnect'].includes(action)) throw new Error('Unknown Settings action');
    if (changing) throw new Error('Another Settings change is in progress. Try again when it finishes.');
    changing = true;
    try {
      if (action !== 'install-command' && (typeof value !== 'string' || !CLIENT_IDS.includes(value as ClientId))) throw new Error('Unknown coding CLI');
      if (action === 'install-command' || action === 'connect') {
        if (!options.packaged) throw new Error('Install the packaged HUD app before registering its command.');
        installCli();
        if (!cliInfo().ready) throw new Error(cliInfo().detail);
      }
      if (action === 'connect' || action === 'disconnect') await (await connections()).change(value as ClientId, action === 'connect');
      return await state(true);
    } finally { changing = false; }
  });

  return {
    show() {
      if (window && !window.isDestroyed()) { if (options.visible !== false) { window.show(); window.focus(); } return window; }
      window = new BrowserWindow({
        title: 'hud — Settings', width: 900, height: 760, minWidth: 560, minHeight: 500,
        backgroundColor: '#000000', show: false, autoHideMenuBar: true,
        webPreferences: { preload: join(SOURCE_ROOT, 'electron', 'settings-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: options.visible !== false },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, target) => { if (target !== settingsUrl) event.preventDefault(); });
      window.once('ready-to-show', () => { if (options.visible !== false) window?.show(); });
      window.on('closed', () => { window = null; });
      void window.loadFile(file);
      return window;
    },
    close() { window?.close(); },
    async checkAtLaunch() { if (options.packaged && options.checkOnLaunch()) await updates.check(); },
  };
}
