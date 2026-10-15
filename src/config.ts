import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SOURCE_ROOT, isPackaged } from './assets.ts';

/** @deprecated alias of SOURCE_ROOT, kept for importers; assets.ts is the one place that knows */
export const ROOT = SOURCE_ROOT;

/** per-user writable dir for a packaged app, so the app itself can stay read-only */
export function userDataDir(): string {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'hud');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'hud');
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'hud');
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 7317;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n < 1 || n > 65535) {
    throw new Error(`invalid HUD_PORT "${raw}" (expected an integer 1-65535)`);
  }
  return n;
}

export function config() {
  const packaged = isPackaged();
  const dataDir = resolve(process.env.HUD_DATA || (packaged ? userDataDir() : join(SOURCE_ROOT, 'data')));
  return {
    port: parsePort(process.env.HUD_PORT),
    dataDir,
    // packaged: probes live beside the user's data (seeded from the shipped defaults on first run)
    probesDir: resolve(process.env.HUD_PROBES || (packaged ? join(dataDir, 'probes') : join(SOURCE_ROOT, 'probes'))),
    // agent-authored chart renderers, loaded by the web UI; same layout rule as probes
    viewsDir: resolve(process.env.HUD_VIEWS || (packaged ? join(dataDir, 'views') : join(SOURCE_ROOT, 'views'))),
    packaged,
  };
}
