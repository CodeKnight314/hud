// Bundles hud for Electron: a node-mode CLI/server entry and the Electron main process.
// Everything is compiled to plain JS so the app never depends on Electron's Node stripping types.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'bundle');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  splitting: false, // inline dynamic imports so one file is self-contained
  sourcemap: false,
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. the CLI + MCP + server, run as `ELECTRON_RUN_AS_NODE=1 <app> build/hud.mjs <cmd>`
await build({ ...common, entryPoints: [join(ROOT, 'bin', 'hud.js')], outfile: join(OUT, 'hud.mjs') });

// 2. the Electron main process (electron itself stays external — the app provides it)
await build({
  ...common,
  entryPoints: [join(ROOT, 'electron', 'main.ts')],
  outfile: join(ROOT, 'appdir', 'main.mjs'),
  external: ['electron'],
});

console.log('built bundle/hud.mjs (node-mode CLI/server) and main.mjs (electron main)');
