// Dev launcher: starts Electron against the repo with a scratch port and data dir, so a dev run never
// touches the user's live board. Inherited HUD_PORT/HUD_DATA are deliberately ignored; use
// HUD_DEV_PORT / HUD_DEV_DATA to override.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = (await import('electron')).default;

const env = {
  ...process.env,
  HUD_SOURCE_ROOT: ROOT,
  HUD_CLI_ENTRY: join(ROOT, 'bundle', 'hud.mjs'),
  HUD_PORT: process.env.HUD_DEV_PORT || '7399',
  HUD_DATA: process.env.HUD_DEV_DATA || join(tmpdir(), 'hud-scratch'),
};
delete env.HUD_PROBES;
delete env.HUD_VIEWS;
delete env.ELECTRON_RUN_AS_NODE;

console.log(`hud dev — port ${env.HUD_PORT}, data ${env.HUD_DATA}`);
const child = spawn(electron, [ROOT], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
