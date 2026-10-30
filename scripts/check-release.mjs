// The release is a terminal install: one CLI tarball, its checksum and the two install scripts.
// A vX.Y.Z tag is still the only trigger, and the release stays a draft until a person publishes it.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = '0.5.1';
const tag = `v${release}`;
const tarball = `hud-${release}.tar.gz`;
const members = ['hud.mjs', 'package.json', 'web/index.html', 'GUIDE.md', 'QUICKSTART.md', 'views/README.md', 'PLAYBOOKS.md', 'STYLE.md', 'PRODUCT.md'];

let failures = 0;
const ok = (cond, msg) => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${msg}`);
};

const read = (path) => readFileSync(join(root, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));
const tempDir = () => mkdtempSync(join(tmpdir(), 'hud-release-'));

function runRelease(args) {
  return spawnSync(process.execPath, [join(root, 'scripts/release-assets.mjs'), ...args], { cwd: root, encoding: 'utf8' });
}

/** A release folder shaped like the one the cli job uploads. */
function writeRelease(dir, { omit = [], tamper = false, weakScript = null } = {}) {
  const tree = join(dir, 'tree');
  for (const member of members) {
    const path = join(tree, member);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, member === 'package.json' ? JSON.stringify({ version: release }) : `${member}\n`);
  }
  const built = join(dir, tarball);
  // archive from the parent: the output must not land inside the tree being read, and Windows tar
  // rejects an absolute C:\ output path
  const tar = spawnSync('tar', ['-czf', 'bundle.tar.gz', '-C', 'tree', '.'], { cwd: dir, encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(tar.stderr);
  renameSync(join(dir, 'bundle.tar.gz'), built);
  rmSync(tree, { recursive: true, force: true });
  const digest = createHash('sha256').update(readFileSync(built)).digest('hex');
  writeFileSync(join(dir, 'SHA256SUMS'), `${tamper ? 'f'.repeat(64) : digest}  ${tarball}\n`);
  for (const script of ['install.sh', 'install.ps1']) {
    writeFileSync(join(dir, script), weakScript === script ? '#!/bin/sh\necho install\n' : `# verify\nSHA256SUMS\n`);
  }
  for (const name of omit) rmSync(join(dir, name), { force: true });
}

// ---- versions ---------------------------------------------------------------------------------
const lock = readJson('package-lock.json');
for (const [source, version] of [
  ['package.json', readJson('package.json').version],
  ['appdir/package.json', readJson('appdir/package.json').version],
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""]', lock.packages?.['']?.version],
]) {
  ok(version === release, `${source} is ${version}; expected ${release}`);
}

const agreed = runRelease(['--check-version', tag]);
ok(agreed.status === 0, `version check for ${tag} failed: ${agreed.stderr || agreed.stdout}`);
const mismatched = runRelease(['--check-version', 'v0.5.2']);
ok(mismatched.status !== 0 && /does not match package version 0\.5\.1/.test(mismatched.stderr), 'a newer tag is rejected');
const bare = runRelease(['--check-version']);
ok(bare.status === 0 && bare.stdout.includes(release), 'package versions agree without a tag');

// ---- release folder ---------------------------------------------------------------------------
const valid = tempDir();
try {
  writeRelease(valid);
  const wrongTag = runRelease([valid, 'v0.2.0']);
  ok(wrongTag.status !== 0 && /does not match package version/.test(wrongTag.stderr), 'an older tag does not match the prepared version');
  const prepared = runRelease([valid, tag]);
  ok(prepared.status === 0, `release validation failed: ${prepared.stderr || prepared.stdout}`);
  ok(prepared.stdout.includes(`Validated ${tarball}`), 'the validator names the tarball it checked');
} finally {
  rmSync(valid, { recursive: true, force: true });
}

const tampered = tempDir();
try {
  writeRelease(tampered, { tamper: true });
  const bad = runRelease([tampered, tag]);
  ok(bad.status !== 0 && /does not match SHA256SUMS/.test(bad.stderr), 'a tarball that does not match its checksum is rejected');
} finally {
  rmSync(tampered, { recursive: true, force: true });
}

const missing = tempDir();
try {
  writeRelease(missing, { omit: ['install.ps1'] });
  const bad = runRelease([missing, tag]);
  ok(bad.status !== 0 && /missing: install\.ps1/.test(bad.stderr), 'both install scripts must be present');
} finally {
  rmSync(missing, { recursive: true, force: true });
}

const weak = tempDir();
try {
  writeRelease(weak, { weakScript: 'install.sh' });
  const bad = runRelease([weak, tag]);
  ok(bad.status !== 0 && /install\.sh does not verify SHA256SUMS/.test(bad.stderr), 'an installer that skips the checksum is rejected');
} finally {
  rmSync(weak, { recursive: true, force: true });
}

// ---- workflow ---------------------------------------------------------------------------------
function pushBranchEntries(text) {
  const match = text.match(/^on:\n {2}push:\n {4}branches:\n((?: {6}- .+\n)*)/m);
  if (!match) return null;
  return [...match[1].matchAll(/^ {6}- (.+)$/gm)].map((item) => item[1]);
}

const workflow = read('.github/workflows/build.yml');
const branches = pushBranchEntries(workflow);
ok(Array.isArray(branches), 'on.push.branches is a list');
ok(branches?.length === 1 && branches[0] === "'release/**'", `release branches are only release/** (found ${(branches || []).join(', ')})`);
ok(workflow.includes("tags:\n      - 'v*'"), 'version tags start the release build');
ok(workflow.includes('workflow_dispatch:'), 'manual dispatch can build artifacts');
ok(workflow.includes('node scripts/pack-cli.mjs'), 'the workflow builds the CLI tarball');
ok(workflow.includes('dist-cli/install.sh'), 'the workflow smoke-tests the installer');
ok(!/electron-builder|scripts\/signing\.mjs|--mac dmg|--win nsis/.test(workflow), 'the release workflow no longer builds or signs app installers');

const draftAt = workflow.indexOf('\n  draft-release:');
ok(draftAt > 0, 'draft-release job exists');
const draft = draftAt > 0 ? workflow.slice(draftAt) : '';
ok(draft.includes("if: startsWith(github.ref, 'refs/tags/v')"), 'the draft job runs only for a version tag');
ok(draft.includes('node scripts/release-assets.mjs release-assets "$GITHUB_REF_NAME"'), 'the draft job validates the tarball, checksums and scripts');
ok(draft.includes('gh release create') && draft.includes('--draft') && draft.includes('--verify-tag'), 'the workflow creates a verified draft release');
ok(!/gh release edit/.test(draft) && !/--draft=false/.test(draft), 'the workflow does not publish the draft');

// ---- docs -------------------------------------------------------------------------------------
const readme = read('README.md');
const guide = read('GUIDE.md');
const agents = read('AGENTS.md');
const quickstart = read('QUICKSTART.md');
ok(readme.includes('install.sh'), 'README installs from the terminal');
ok(readme.includes('hud update'), 'README documents hud update');
ok(!/\.dmg|SmartScreen|Open Anyway/.test(readme), 'README no longer describes app installers or Gatekeeper');
ok(quickstart.includes('install.sh') && quickstart.includes('hud update'), 'QUICKSTART covers install and update');
ok(guide.includes("This tree's version is 0.5.1"), 'GUIDE states the version');
ok(guide.includes('hud update'), 'GUIDE documents updates');
ok(guide.includes('tag `v0.5.1`'), 'GUIDE names the manual tag');
ok(guide.includes('leave every published stable release unchanged'), 'GUIDE keeps the shared release phrase');
ok(agents.includes('package version is 0.5.1'), 'AGENTS states the package version');
ok(agents.includes('published stable releases unchanged'), 'AGENTS keeps the shared release phrase');
ok(agents.includes('Do not create the tag, publish the release, or run a release on merge'), 'AGENTS forbids automatic publication');
ok(!/v0\.1\.0/.test(agents), 'AGENTS does not treat v0.1.0 as the standing release');

// ---- version surfaces -------------------------------------------------------------------------
const settingsJs = read('web/settings.js');
const main = read('electron/main.ts');
const server = read('src/server.ts');
ok(settingsJs.includes("app-version').textContent = state.version"), 'Settings sidebar shows the app version');
ok(!/\b0\.1\.\d+\b/.test(settingsJs), 'Settings has no hard-coded 0.1.x version');
ok(main.includes("asset('package.json')") && /desktopSettings\(\{\s*version,/.test(main), 'Settings receives the package.json version');
ok(server.includes("asset('package.json'") && server.includes('version: VERSION'), 'health reports the package.json version');

if (failures) {
  console.error(`FAIL ${failures} release check(s)`);
  process.exit(1);
}
console.log(`PASS release: ${release} versions, CLI tarball + checksums + install scripts, and a manual draft`);
