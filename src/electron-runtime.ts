import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { appImageCliInvocation } from './appimage-cli.ts';
import { SOURCE_ROOT, isElectron, isPackaged } from './assets.ts';

export { isElectron };

/** Electron's node mode: the app binary behaves as plain node when this is set */
export const isElectronNodeMode = (): boolean => isElectron() && process.env.ELECTRON_RUN_AS_NODE === '1';

/**
 * The bundled CLI entry node mode runs. Packaged, it sits at `<resources>/hud/bin/hud.mjs` beside
 * the web/ + probes/ mirror; in dev the build script sets HUD_CLI_ENTRY to its output.
 */
export const bundledCli = (): string => process.env.HUD_CLI_ENTRY || join(SOURCE_ROOT, 'bin', 'hud.mjs');

let cachedLoginEnv: NodeJS.ProcessEnv | null = null;

const SHELL_ARGS = ['-ilc', 'env -0'];
const shellPath = () => process.env.SHELL || '/bin/zsh';
const loginEnvDisabled = () => process.platform === 'win32' || !!process.env.HUD_NO_LOGIN_SHELL || !isElectron();

function parseEnv(out: Buffer | string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of out.toString('utf8').split('\0')) {
    const i = entry.indexOf('=');
    if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return env;
}

/** Ask the login shell for its env without blocking the event loop; call once at app startup. */
export function primeLoginEnv(refresh = false): Promise<void> {
  if (loginEnvDisabled() || cachedLoginEnv && !refresh) return Promise.resolve();
  return new Promise((done) => {
    execFile(shellPath(), SHELL_ARGS, { encoding: 'buffer', timeout: 5000 }, (err, out) => {
      cachedLoginEnv = err ? {} : parseEnv(out); // probe failed: fall back to the inherited env
      done();
    });
  });
}

/** how to run the hud CLI here: command, args to prefix, and the env it needs */
export function cliInvocation(): { cmd: string; prefix: string[]; env: NodeJS.ProcessEnv } {
  if (isElectron()) {
    // AppImage: re-exec the .AppImage file so the child owns a mount that outlives this process.
    const appImage = appImageCliInvocation();
    if (appImage) return appImage;
    // the app binary is its own CLI in node mode — no second runtime to ship
    return { cmd: process.execPath, prefix: [bundledCli()], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { cmd: process.execPath, prefix: [join(SOURCE_ROOT, 'src', 'server.ts')], env: process.env };
}

/** Env for a fresh GUI process. The installed command sets node mode; a window must not inherit it or the parent mount. */
export function guiLaunchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (env.APPIMAGE) {
    delete env.APPDIR;
    delete env.ARGV0;
    delete env.LD_LIBRARY_PATH;
  }
  return env;
}

/** how to start the isolated Electron capture runner, when this checkout has Electron available */
export function renderInvocation(): { cmd: string; prefix: string[]; env: NodeJS.ProcessEnv } | null {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HUD_ALERT_CMD;

  if (isPackaged()) return { cmd: process.execPath, prefix: ['--hud-render-helper'], env };

  try {
    const electron = createRequire(import.meta.url)('electron');
    if (typeof electron !== 'string' || !electron) return null;
    return { cmd: electron, prefix: [join(SOURCE_ROOT, 'electron', 'render.mjs')], env };
  } catch {
    return null;
  }
}

/**
 * Env for a child process. A GUI launched from Finder/Dock inherits a minimal PATH and no SHELL, which would
 * break everything that relies on Homebrew tools or the user's shell config, so the login shell's PATH/SHELL are
 * folded in. When `base` is the inherited process.env, ELECTRON_RUN_AS_NODE is scrubbed (it would turn a spawned
 * app binary into node, and leak into monitors); a caller that builds its own env, like `cliInvocation()`, keeps
 * the flag it set on purpose.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (base === process.env) delete env.ELECTRON_RUN_AS_NODE;
  if (loginEnvDisabled()) return env;
  if (!cachedLoginEnv) {
    // not primed (e.g. the node-mode server): one synchronous probe
    try {
      cachedLoginEnv = parseEnv(
        execFileSync(shellPath(), SHELL_ARGS, { encoding: 'buffer', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }),
      );
    } catch {
      cachedLoginEnv = {};
    }
  }
  if (cachedLoginEnv.PATH) env.PATH = cachedLoginEnv.PATH;
  if (cachedLoginEnv.SHELL) env.SHELL = cachedLoginEnv.SHELL;
  return env;
}
