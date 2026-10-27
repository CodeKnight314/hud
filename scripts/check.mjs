import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webFiles = readdirSync(resolve(root, 'web'))
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => resolve(root, 'web', name));
const syntaxFiles = [...webFiles, resolve(root, 'electron', 'render.mjs'), resolve(root, 'electron', 'settings-preload.cjs')];
const suites = [
  'scripts/check-layout.ts',
  'scripts/check-coordination.ts',
  'scripts/check-context-timeline.mjs',
  'scripts/check-claim-widget.mjs',
  'scripts/check-supervision.ts',
  'scripts/check-monitoring.ts',
  'scripts/check-monitor-templates.ts',
  'scripts/check-monitoring-views.mjs',
  'scripts/check-views.ts',
  'scripts/check-markdown.mjs',
  'scripts/check-icons.mjs',
  'scripts/check-docs.mjs',
  'scripts/check-guide.ts',
  'scripts/check-release.mjs',
  'scripts/check-connections.ts',
  'scripts/check-cliinstall.ts',
  'scripts/check-updates.ts',
];

function run(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`FAIL ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`FAIL ${label}: exited with status ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`RUN syntax checks (${syntaxFiles.length} files)`);
for (const file of syntaxFiles) run(['--check', file], file);
console.log(`PASS syntax checks (${syntaxFiles.length} files)`);

for (const suite of suites) {
  console.log(`RUN ${suite}`);
  run([resolve(root, suite)], suite);
  console.log(`PASS ${suite}`);
}

console.log('PASS all HUD checks');
