#!/usr/bin/env node
// Validates the CLI release folder before a draft release is created: one tarball, its checksum,
// and the two install scripts. The Electron installers are no longer shipped.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function stableVersionFromTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) throw new Error(`tag must be a stable version in vX.Y.Z form without leading zeroes: ${tag}`);
  return match.slice(1).join('.');
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${path}: ${error.message}`);
  }
}

/** package.json, appdir/package.json and both package-lock fields must agree. */
async function readPackageVersions() {
  const [root, appdir, lock] = await Promise.all([
    readJson(resolve(projectRoot, 'package.json')),
    readJson(resolve(projectRoot, 'appdir/package.json')),
    readJson(resolve(projectRoot, 'package-lock.json')),
  ]);
  const versions = [
    ['package.json', root.version],
    ['appdir/package.json', appdir.version],
    ['package-lock.json', lock.version],
    ['package-lock.json packages[""]', lock.packages?.['']?.version],
  ];
  for (const [source, version] of versions) {
    if (typeof version !== 'string' || version.length === 0) throw new Error(`${source} has no package version`);
  }
  const distinct = new Set(versions.map(([, version]) => version));
  if (distinct.size !== 1) throw new Error(`package versions disagree: ${versions.map(([source, version]) => `${source}=${version}`).join(', ')}`);
  return versions[0][1];
}

async function checkVersion(tag) {
  const packageVersion = await readPackageVersions();
  if (tag !== undefined) {
    const tagVersion = stableVersionFromTag(tag);
    if (tagVersion !== packageVersion) throw new Error(`tag ${tag} does not match package version ${packageVersion}`);
  }
  console.log(`Package versions agree at ${packageVersion}${tag ? ` (tag ${tag})` : ''}.`);
}

const bundleName = (version) => `hud-${version}.tar.gz`;

/** Members every CLI tarball must carry: the bundle plus the files it serves. */
const REQUIRED_MEMBERS = ['hud.mjs', 'package.json', 'web/index.html', 'GUIDE.md', 'QUICKSTART.md', 'views/README.md'];

async function prepareReleaseAssets(folderArgument, tag) {
  const version = stableVersionFromTag(tag);
  const packageVersion = await readPackageVersions();
  if (version !== packageVersion) throw new Error(`tag ${tag} does not match package version ${packageVersion}`);

  const folder = resolve(process.cwd(), folderArgument);
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${folder} is not a regular directory`);

  const tarball = bundleName(version);
  const expected = [tarball, 'SHA256SUMS', 'install.sh', 'install.ps1'];
  const found = (await readdir(folder)).filter((name) => !name.startsWith('.'));
  const missing = expected.filter((name) => !found.includes(name));
  const unexpected = found.filter((name) => !expected.includes(name));
  if (missing.length || unexpected.length) {
    throw new Error(`release folder must hold exactly ${expected.join(', ')}; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
  }

  const sums = await readFile(resolve(folder, 'SHA256SUMS'), 'utf8');
  const listed = /^([0-9a-f]{64})[ \t]+\*?(.+?)\s*$/m.exec(sums.replace(/\r\n/g, '\n'));
  if (!listed || listed[2] !== tarball) throw new Error(`SHA256SUMS must list ${tarball} and nothing else`);
  const actual = createHash('sha256').update(await readFile(resolve(folder, tarball))).digest('hex');
  if (actual !== listed[1]) throw new Error(`${tarball} does not match SHA256SUMS (expected ${listed[1]}, got ${actual})`);

  const tar = spawnSync('tar', ['-tzf', resolve(folder, tarball)], { encoding: 'utf8' });
  if (tar.error) throw new Error(`could not run tar: ${tar.error.message}`);
  if (tar.status !== 0) throw new Error(`could not list ${tarball}: ${(tar.stderr || '').trim()}`);
  const members = new Set(tar.stdout.split('\n').map((line) => line.replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean));
  for (const member of REQUIRED_MEMBERS) {
    if (!members.has(member)) throw new Error(`${tarball} is missing ${member}`);
  }

  for (const script of ['install.sh', 'install.ps1']) {
    const text = await readFile(resolve(folder, script), 'utf8');
    if (!text.includes('SHA256SUMS')) throw new Error(`${script} does not verify SHA256SUMS`);
  }

  console.log(`Validated ${tarball} (${members.size} members), SHA256SUMS and both install scripts in ${folder}.`);
}

async function main(args) {
  if (args[0] === '--check-version') {
    if (args.length > 2) throw new Error('usage: release-assets.mjs --check-version [tag]');
    await checkVersion(args[1]);
    return;
  }
  if (args.length !== 2) throw new Error('usage: release-assets.mjs <release-folder> <tag> | --check-version [tag]');
  await prepareReleaseAssets(args[0], args[1]);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`release-assets: ${error.message}`);
  process.exitCode = 1;
});
