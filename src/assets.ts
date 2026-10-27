import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Electron adds these to `process`; type them here rather than pulling in electron's types everywhere */
const proc = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };

export const isElectron = (): boolean => !!process.versions.electron;
/** running from a checkout rather than an installed app (HUD_SOURCE_ROOT is the dev marker) */
export const isElectronDev = (): boolean =>
  isElectron() && (!!proc.defaultApp || !!process.env.HUD_SOURCE_ROOT);

/** an installed desktop app (as opposed to a checkout, or `npm run dev`) */
export function isPackaged(): boolean {
  return isElectron() && !isElectronDev();
}

/**
 * Where the app's own files live. The only place that knows.
 *
 * Packaged Electron: `<resources>/hud`, the repo mirror electron-builder copies via extraResources.
 * Dev Electron: HUD_SOURCE_ROOT. Otherwise (source, npm link, library use, the bundled CLI): the parent of
 * the directory holding this module (src/ or bundle/ or hud/bin/), resolved through symlinks.
 */
function computeSourceRoot(): string {
  if (isPackaged() && proc.resourcesPath && existsSync(join(proc.resourcesPath, 'hud'))) {
    return join(proc.resourcesPath, 'hud');
  }
  if (isElectronDev() && process.env.HUD_SOURCE_ROOT) return process.env.HUD_SOURCE_ROOT;
  let here = fileURLToPath(import.meta.url);
  try {
    here = realpathSync(here);
  } catch {}
  return resolve(dirname(here), '..');
}

export const SOURCE_ROOT = computeSourceRoot();

/** read an asset by its repo-relative path (e.g. "web/app.js") */
export function asset(name: string, encoding: 'utf8' = 'utf8'): string | undefined {
  const p = join(SOURCE_ROOT, name);
  return existsSync(p) ? readFileSync(p, encoding) : undefined;
}

/** does the asset exist on disk? */
export function hasAsset(name: string): boolean {
  return existsSync(join(SOURCE_ROOT, name));
}

/**
 * Real path of a `file:` URL that is a file inside `root`.
 * Rejects other hosts, missing paths, the root itself, and anything that realpath resolves outside it.
 */
export function confineFileUrl(url: string, root: string = SOURCE_ROOT): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('file URL is not allowed'); }
  if (parsed.protocol !== 'file:') throw new Error('file URL is not allowed');
  if (parsed.hostname !== '' && parsed.hostname !== 'localhost') throw new Error('file URL is not allowed');
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(fileURLToPath(parsed));
  } catch {
    throw new Error('file URL is not allowed');
  }
  const rel = relative(realRoot, realFile);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('file URL is not allowed');
  return realFile;
}

/** Files shipped loose in the packaged app, used by the server to seed the user's probes/views. Empty from source. */
export function assetKeys(): string[] {
  if (!isPackaged()) return [];
  const out: string[] = [];
  for (const dir of ['probes', 'web', 'views']) {
    try {
      for (const e of readdirSync(join(SOURCE_ROOT, dir), { withFileTypes: true })) {
        if (!e.name.startsWith('.') && e.isFile()) out.push(`${dir}/${e.name}`);
      }
    } catch {
      /* dir may not exist in a given build */
    }
  }
  return out;
}
