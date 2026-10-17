#!/usr/bin/env node

import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const minimumBytes = 1_000_000;

function stableVersionFromTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) throw new Error(`tag must be a stable version in vX.Y.Z form without leading zeroes: ${tag}`);
  return match.slice(1).join('.');
}

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
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(`${source} has no package version`);
    }
  }
  const distinct = new Set(versions.map(([, version]) => version));
  if (distinct.size !== 1) {
    throw new Error(`package versions disagree: ${versions.map(([source, version]) => `${source}=${version}`).join(', ')}`);
  }
  return versions[0][1];
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${path}: ${error.message}`);
  }
}

async function checkVersion(tag) {
  const packageVersion = await readPackageVersions();
  if (tag !== undefined) {
    const tagVersion = stableVersionFromTag(tag);
    if (tagVersion !== packageVersion) {
      throw new Error(`tag ${tag} does not match package version ${packageVersion}`);
    }
  }
  console.log(`Package versions agree at ${packageVersion}${tag ? ` (tag ${tag})` : ''}.`);
}

function expectedInstallers(version) {
  return [
    `hud-${version}-mac-arm64.dmg`,
    `hud-${version}-mac-x64.dmg`,
    `hud-${version}-win-x64.exe`,
    `hud-${version}-linux-x86_64.AppImage`,
    `hud-${version}-linux-amd64.deb`,
  ];
}

async function assertExactDirectoryEntries(folder, expected) {
  let entries;
  try {
    entries = await readdir(folder);
  } catch (error) {
    throw new Error(`could not read installer folder ${folder}: ${error.message}`);
  }
  const expectedSet = new Set(expected);
  const actualSet = new Set(entries);
  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = entries.filter((name) => !expectedSet.has(name));
  if (missing.length || unexpected.length) {
    throw new Error(`installer folder must contain exactly the five expected installers; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
  }
}

async function openRegularFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${path} is not a regular file`);
  if (before.size <= minimumBytes) throw new Error(`${path} is too small (${before.size} bytes; must exceed ${minimumBytes})`);

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`${path} changed while it was being validated`);
    }
    if (after.size <= minimumBytes) throw new Error(`${path} is too small (${after.size} bytes; must exceed ${minimumBytes})`);
    return { handle, size: after.size };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function checkMagic(name, handle, size) {
  if (name.endsWith('.dmg')) {
    if (size < 512 || !(await readAt(handle, size - 512, 4)).equals(Buffer.from('koly'))) {
      throw new Error(`${name} is missing the DMG koly trailer at the start of its final 512-byte block`);
    }
    return;
  }

  const signatures = [
    ['.exe', Buffer.from('MZ')],
    ['.AppImage', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ['.deb', Buffer.from('!<arch>\n')],
  ];
  const signature = signatures.find(([extension]) => name.endsWith(extension));
  if (!signature) throw new Error(`unsupported installer type: ${name}`);
  const [extension, expected] = signature;
  if (!(await readAt(handle, 0, expected.length)).equals(expected)) {
    throw new Error(`${name} does not have the expected ${extension} file signature`);
  }
}

async function sha256(handle) {
  const hash = createHash('sha256');
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function prepareReleaseAssets(folderArgument, tag) {
  const version = stableVersionFromTag(tag);
  const packageVersion = await readPackageVersions();
  if (version !== packageVersion) {
    throw new Error(`tag ${tag} does not match package version ${packageVersion}`);
  }

  const folder = resolve(process.cwd(), folderArgument);
  const folderInfo = await lstat(folder);
  if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) {
    throw new Error(`${folder} is not a regular directory`);
  }

  const expected = expectedInstallers(version);
  await assertExactDirectoryEntries(folder, expected);

  const checksums = [];
  for (const name of [...expected].sort(compareNames)) {
    const path = resolve(folder, name);
    const { handle, size } = await openRegularFile(path);
    try {
      await checkMagic(name, handle, size);
      checksums.push(`${await sha256(handle)}  ${name}`);
    } finally {
      await handle.close();
    }
  }

  await writeFile(resolve(folder, 'SHA256SUMS'), `${checksums.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`Validated ${expected.length} installers and wrote SHA256SUMS in ${folder}.`);
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main(args) {
  if (args[0] === '--check-version') {
    if (args.length > 2) throw new Error('usage: release-assets.mjs --check-version [tag]');
    await checkVersion(args[1]);
    return;
  }
  if (args.length !== 2) {
    throw new Error('usage: release-assets.mjs <installer-folder> <tag> | --check-version [tag]');
  }
  await prepareReleaseAssets(args[0], args[1]);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`release-assets: ${error.message}`);
  process.exitCode = 1;
});
