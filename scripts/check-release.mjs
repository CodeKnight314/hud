// v0.2.0 is the release prepared for a later manual tag. Publication stays a draft until a person publishes it.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = '0.2.0';
const tag = `v${release}`;
const installers = [
  `hud-${release}-linux-amd64.deb`,
  `hud-${release}-linux-x86_64.AppImage`,
  `hud-${release}-mac-arm64.dmg`,
  `hud-${release}-mac-x64.dmg`,
  `hud-${release}-win-x64.exe`,
];

let failures = 0;
const ok = (cond, msg) => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${msg}`);
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runRelease(args) {
  return spawnSync(process.execPath, [join(root, 'scripts/release-assets.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function installerBytes(name, { magic = true } = {}) {
  const size = 1_000_001;
  const buf = Buffer.alloc(size);
  if (!magic) {
    buf.write('????');
    return buf;
  }
  if (name.endsWith('.dmg')) buf.write('koly', size - 512);
  else if (name.endsWith('.exe')) buf.write('MZ');
  else if (name.endsWith('.AppImage')) buf.set([0x7f, 0x45, 0x4c, 0x46]);
  else if (name.endsWith('.deb')) buf.write('!<arch>\n');
  else throw new Error(`unexpected installer name ${name}`);
  return buf;
}

function writeInstallers(dir, names, options) {
  const bytes = new Map();
  for (const name of names) {
    const buf = installerBytes(name, options);
    bytes.set(name, buf);
    writeFileSync(join(dir, name), buf);
  }
  return bytes;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'hud-release-'));
}

const lock = readJson(join(root, 'package-lock.json'));
const versions = [
  ['package.json', readJson(join(root, 'package.json')).version],
  ['appdir/package.json', readJson(join(root, 'appdir/package.json')).version],
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""]', lock.packages?.['']?.version],
];
for (const [source, version] of versions) ok(version === release, `${source} is ${version}; expected ${release}`);

const agreed = runRelease(['--check-version', tag]);
ok(agreed.status === 0, `version check for ${tag} failed: ${agreed.stderr || agreed.stdout}`);
const mismatched = runRelease(['--check-version', 'v0.2.1']);
ok(mismatched.status !== 0 && /does not match package version 0\.2\.0/.test(mismatched.stderr), 'a newer tag is rejected');
const bare = runRelease(['--check-version']);
ok(bare.status === 0 && bare.stdout.includes('0.2.0'), 'package versions agree without a tag');

const validDir = tempDir();
try {
  const bytes = writeInstallers(validDir, installers);
  const wrongTag = runRelease([validDir, 'v0.1.3']);
  ok(wrongTag.status !== 0 && /does not match package version/.test(wrongTag.stderr), 'v0.1.3 does not match the prepared version');
  const prepared = runRelease([validDir, tag]);
  ok(prepared.status === 0, `installer validation failed: ${prepared.stderr || prepared.stdout}`);
  const sums = readFileSync(join(validDir, 'SHA256SUMS'), 'utf8');
  const expectedSums = `${installers.map((name) => `${createHash('sha256').update(bytes.get(name)).digest('hex')}  ${name}`).join('\n')}\n`;
  ok(sums === expectedSums, 'SHA256SUMS lists the five installers with two-space checksums');
  const again = runRelease([validDir, tag]);
  ok(again.status !== 0 && /unexpected: SHA256SUMS/.test(again.stderr), 'checksum file is not treated as an installer');
} finally {
  rmSync(validDir, { recursive: true, force: true });
}

const brokenDir = tempDir();
try {
  writeInstallers(brokenDir, installers, { magic: false });
  const broken = runRelease([brokenDir, tag]);
  ok(broken.status !== 0 && /file signature|koly trailer/.test(broken.stderr), 'installers with the wrong signature are rejected');
} finally {
  rmSync(brokenDir, { recursive: true, force: true });
}

const partialDir = tempDir();
try {
  writeInstallers(partialDir, installers.slice(0, 4));
  writeFileSync(join(partialDir, 'notes.txt'), 'not an installer\n');
  const partial = runRelease([partialDir, tag]);
  ok(partial.status !== 0 && /missing:/.test(partial.stderr) && /unexpected: notes\.txt/.test(partial.stderr), 'the release folder must be exactly the five installers');
} finally {
  rmSync(partialDir, { recursive: true, force: true });
}

const workflow = readFileSync(join(root, '.github/workflows/build.yml'), 'utf8');
ok(workflow.includes("branches:\n      - 'release/**'"), 'release-branch pushes build without publishing');
ok(workflow.includes("tags:\n      - 'v*'"), 'version tags start native builds');
ok(workflow.includes('workflow_dispatch:'), 'manual dispatch can build artifacts');
ok(!/(^|\n)\s+-\s+['"]main['"]/.test(workflow), 'native builds do not run on main');
ok(!workflow.includes('0.2.0'), 'native builds do not publish when the 0.2.0 branch moves');
const draftAt = workflow.indexOf('\n  draft-release:');
ok(draftAt > 0, 'draft-release job exists');
const draft = draftAt > 0 ? workflow.slice(draftAt) : '';
ok(draft.includes("if: startsWith(github.ref, 'refs/tags/v')"), 'the draft job runs only for a version tag');
ok(draft.includes('node scripts/release-assets.mjs release-assets "$GITHUB_REF_NAME"'), 'the draft job validates installers and writes checksums');
ok(draft.includes('gh release create') && draft.includes('--draft') && draft.includes('--verify-tag'), 'the workflow creates a verified draft release');
ok(!/gh release edit/.test(draft) && !/--draft=false/.test(draft), 'the workflow does not publish the draft');

const guide = readFileSync(join(root, 'GUIDE.md'), 'utf8');
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
ok(guide.includes("This tree's app version is 0.2.0"), 'GUIDE states the app version is 0.2.0');
ok(guide.includes('`v0.2.0`'), 'GUIDE names the manual tag');
ok(guide.includes('Merging does not create a tag or a GitHub release.'), 'GUIDE keeps publication manual');
ok(agents.includes('The package version is 0.2.0'), 'AGENTS states the package version');
ok(agents.includes('tag `v0.2.0`'), 'AGENTS names the manual tag');
ok(agents.includes('Do not create the tag, publish the release, or run a release on merge'), 'AGENTS forbids automatic publication');

const settingsJs = readFileSync(join(root, 'web/settings.js'), 'utf8');
const main = readFileSync(join(root, 'electron/main.ts'), 'utf8');
const server = readFileSync(join(root, 'src/server.ts'), 'utf8');
ok(settingsJs.includes("app-version').textContent = state.version"), 'Settings sidebar shows the app version');
ok(settingsJs.includes("current-version').textContent = u.currentVersion || appState?.version"), 'Settings updates page shows the app version');
ok(!/\b0\.1\.\d+\b/.test(settingsJs), 'Settings has no hard-coded 0.1.x version');
ok(main.includes("asset('package.json')") && /desktopSettings\(\{\s*version,/.test(main), 'Settings receives the package.json version');
ok(server.includes("asset('package.json'") && server.includes('version: VERSION'), 'health reports the package.json version');

if (failures) {
  console.error(`FAIL ${failures} release check(s)`);
  process.exit(1);
}
console.log('PASS release: v0.2.0 versions, installer checksums, and a manual draft');
