import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';

/**
 * AppImage launches unpack to a new mount path every run, so a shim that stores
 * `process.execPath` is stale the next time the app starts. The stable command is the
 * `.AppImage` file (`APPIMAGE`). A small bootstrap outside the mount — written beside the
 * board data — runs under that fresh process and imports `resources/hud/bin/hud.mjs`.
 */

const ENTRY_FROM_EXEC = "join(dirname(process.execPath), 'resources', 'hud', 'bin', 'hud.mjs')";
const ENTRY_FROM_RESOURCES = "join(process.resourcesPath, 'hud', 'bin', 'hud.mjs')";
const ENTRY_FROM_APPDIR = "join(process.env.APPDIR, 'resources', 'hud', 'bin', 'hud.mjs')";

let tempCounter = 0;

function atomicWriteFile(path: string, contents: string, mode: number): void {
  let temp: string | undefined;
  let fd: number | undefined;
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = `${path}.${process.pid}.${++tempCounter}.tmp`;
      try {
        fd = openSync(candidate, 'wx');
        temp = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (fd === undefined || temp === undefined) throw new Error(`could not choose a temporary path for ${path}`);
    writeFileSync(fd, contents, 'utf8');
    chmodSync(temp, mode);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    temp = undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    if (temp !== undefined) {
      try { rmSync(temp); } catch {}
    }
  }
}

export type AppImageTarget = { ok: true; path: string } | { ok: false; detail: string };

/** The running `.AppImage`, or null when this process is not an AppImage. */
export function appImageTarget(): AppImageTarget | null {
  if (process.platform === 'win32') return null;
  const raw = process.env.APPIMAGE;
  if (raw === undefined || raw === '') return null;
  if (/[\0\r\n]/.test(raw)) return { ok: false, detail: 'AppImage path contains a newline' };
  let path: string;
  try {
    path = realpathSync(raw);
  } catch {
    return { ok: false, detail: `AppImage is missing or not executable: ${raw}` };
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return { ok: false, detail: `AppImage is missing or not executable: ${path}` };
  }
  return { ok: true, path };
}

export function appImageBootstrapPath(): string {
  return join(config().dataDir, 'appimage-boot.mjs');
}

/** Standalone ESM the AppImage runs in node mode. Keep the candidate order aligned with `resolveAppImageCliEntry`. */
export function appImageBootstrapSource(): string {
  return `import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const requested = process.env.HUD_CLI_ENTRY;
const candidates = requested ? [requested] : [
  ${ENTRY_FROM_EXEC},
  ...(process.resourcesPath ? [${ENTRY_FROM_RESOURCES}] : []),
  ...(process.env.APPDIR ? [${ENTRY_FROM_APPDIR}] : []),
];
const entry = candidates.find((candidate) => existsSync(candidate));
if (!entry) {
  console.error('hud: could not find the CLI inside the AppImage. Reinstall the hud command from the app.');
  process.exit(1);
}
process.argv = [process.execPath, entry, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);
`;
}

export function ensureAppImageBootstrap(): string {
  const path = appImageBootstrapPath();
  const source = appImageBootstrapSource();
  try {
    if (readFileSync(path, 'utf8') === source) return path;
  } catch { /* missing or unreadable: rewrite below */ }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, source, 0o644);
  return path;
}

export type EntryProbe = {
  execPath: string;
  resourcesPath?: string;
  appDir?: string;
  cliEntry?: string;
  exists?: (path: string) => boolean;
};

/** First packaged CLI entry that exists. `HUD_CLI_ENTRY` wins and does not fall through. */
export function resolveAppImageCliEntry(probe?: EntryProbe): string | undefined {
  const exists = probe?.exists ?? existsSync;
  const cliEntry = probe ? probe.cliEntry : process.env.HUD_CLI_ENTRY;
  if (cliEntry) return exists(cliEntry) ? cliEntry : undefined;
  const execPath = probe?.execPath ?? process.execPath;
  const resourcesPath = probe ? probe.resourcesPath : (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const appDir = probe ? probe.appDir : process.env.APPDIR;
  const candidates = [
    join(dirname(execPath), 'resources', 'hud', 'bin', 'hud.mjs'),
    ...(resourcesPath ? [join(resourcesPath, 'hud', 'bin', 'hud.mjs')] : []),
    ...(appDir ? [join(appDir, 'resources', 'hud', 'bin', 'hud.mjs')] : []),
  ];
  return candidates.find((candidate) => exists(candidate));
}

/**
 * Spawn the `.AppImage` itself, not the temporary mount. The child runtime builds a new mount
 * and keeps it after the parent exits, which is what `hud start` and "keep server running" need.
 * `APPDIR` / `LD_LIBRARY_PATH` from the parent point at the parent's mount and are left for the
 * new runtime to set.
 */
export function appImageCliInvocation(): { cmd: string; prefix: string[]; env: NodeJS.ProcessEnv } | null {
  const image = appImageTarget();
  if (!image?.ok) return null;
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.APPDIR;
  delete env.ARGV0;
  delete env.LD_LIBRARY_PATH;
  return { cmd: image.path, prefix: [ensureAppImageBootstrap()], env };
}
