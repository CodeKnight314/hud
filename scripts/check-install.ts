// The curl install: release parsing, checksum verification, safe unpack and swap.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleName, checksumFor, fetchBundle, installRoot, installedVersion, launcherPath, releaseInfo, sha256, swapApp, unpackBundle } from '../src/install.ts';

const root = mkdtempSync(join(tmpdir(), 'hud-install-check-'));

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// ---- checksums -------------------------------------------------------------------------------
const sums = [`${'a'.repeat(64)}  hud-0.3.0.tar.gz`, `${'b'.repeat(64)} *hud-0.3.0-mac-arm64.dmg`, `${'c'.repeat(64)}  other.tgz`].join('\r\n');
assert.equal(checksumFor(sums, 'hud-0.3.0.tar.gz'), 'a'.repeat(64), 'plain sha256sum line');
assert.equal(checksumFor(sums, 'hud-0.3.0-mac-arm64.dmg'), 'b'.repeat(64), 'binary-mode line with an asterisk');
assert.equal(checksumFor(sums, 'other.tgz'), 'c'.repeat(64), 'CRLF input still parses');
assert.equal(checksumFor(sums, 'missing.tgz'), undefined, 'an unlisted file has no checksum');

// ---- release parsing -------------------------------------------------------------------------
const releaseBody = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/CodeKnight314/hud/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  assets: [
    { name: bundleName('0.3.0'), browser_download_url: 'https://example.test/hud-0.3.0.tar.gz' },
    { name: 'SHA256SUMS', browser_download_url: 'https://example.test/SHA256SUMS' },
    { name: 42 },
    null,
  ],
  ...extra,
});

const release = await releaseInfo((async () => response(releaseBody('v0.3.0'))) as typeof fetch);
assert.equal(release.version, '0.3.0');
assert.deepEqual(release.assets.map((a) => a.name), [bundleName('0.3.0'), 'SHA256SUMS'], 'unknown asset shapes are dropped');
assert.equal(release.pageUrl.endsWith('/tag/v0.3.0'), true);

for (const [label, body] of [
  ['draft', releaseBody('v0.3.0', { draft: true })],
  ['prerelease', releaseBody('v0.3.0', { prerelease: true })],
  ['unstable tag', releaseBody('v0.3.0-rc.1')],
  ['no tag', releaseBody('')],
] as const) {
  await assert.rejects(releaseInfo((async () => response(body)) as typeof fetch), /draft|prerelease|stable vX\.Y\.Z/, label);
}
await assert.rejects(releaseInfo((async () => response({}, 404)) as typeof fetch), /release lookup failed: 404/);

// ---- verified download -----------------------------------------------------------------------
const bundleBytes = Buffer.from('tarball bytes');
const bundleSum = sha256(bundleBytes);
const fetcherFor = (tarballBytes: Buffer, sumsText: string) => (async (url: string) => {
  if (url.endsWith('SHA256SUMS')) return new Response(sumsText, { status: 200 });
  if (url.endsWith('.tar.gz')) return new Response(new Uint8Array(tarballBytes), { status: 200 });
  return new Response('missing', { status: 404 });
}) as typeof fetch;

const good = await fetchBundle(release, fetcherFor(bundleBytes, `${bundleSum}  ${bundleName('0.3.0')}\n`), join(root, 'dl-good'));
assert.equal(good.sha256, bundleSum);
assert.equal(readFileSync(good.path).toString(), 'tarball bytes');

await assert.rejects(fetchBundle(release, fetcherFor(bundleBytes, `${'0'.repeat(64)}  ${bundleName('0.3.0')}\n`), join(root, 'dl-bad')), /does not match SHA256SUMS/);
await assert.rejects(fetchBundle(release, fetcherFor(bundleBytes, `${bundleSum}  other.tgz\n`), join(root, 'dl-unlisted')), /does not list/);
await assert.rejects(
  fetchBundle({ ...release, assets: release.assets.filter((a) => a.name !== 'SHA256SUMS') }, fetcherFor(bundleBytes, ''), join(root, 'dl-nosums')),
  /no SHA256SUMS/,
);

// ---- unpack and swap -------------------------------------------------------------------------
function makeBundle(dir: string, marker: string): string {
  const tree = join(dir, 'tree');
  mkdirSync(join(tree, 'web'), { recursive: true });
  writeFileSync(join(tree, 'hud.mjs'), `// ${marker}\n`);
  writeFileSync(join(tree, 'web', 'index.html'), marker);
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ version: '0.3.0' }));
  const tarball = join(dir, 'bundle.tar.gz');
  const tar = spawnSync('tar', ['-czf', 'bundle.tar.gz', '.'], { cwd: tree, encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  renameSync(join(tree, 'bundle.tar.gz'), tarball);
  return tarball;
}

const unpackDir = join(root, 'unpack');
const unpacked = unpackBundle(makeBundle(join(root, 'a'), 'new-build'), unpackDir);
assert.equal(readFileSync(join(unpacked, 'web', 'index.html'), 'utf8'), 'new-build');
assert.equal(sha256(Buffer.from('x')).length, 64);

// a single top-level folder inside the archive is tolerated
const nestedTarball = join(root, 'nested.tar.gz');
const nestedTree = join(root, 'nested', 'hud-0.3.0');
mkdirSync(join(nestedTree, 'web'), { recursive: true });
writeFileSync(join(nestedTree, 'hud.mjs'), '// nested\n');
writeFileSync(join(nestedTree, 'web', 'index.html'), 'nested');
spawnSync('tar', ['-czf', 'nested.tar.gz', 'hud-0.3.0'], { cwd: join(root, 'nested'), encoding: 'utf8' });
renameSync(join(root, 'nested', 'nested.tar.gz'), nestedTarball);
assert.match(unpackBundle(nestedTarball, join(root, 'nested-out')), /hud-0\.3\.0$/);

const target = join(root, 'install', 'app');
mkdirSync(join(target, 'web'), { recursive: true });
writeFileSync(join(target, 'hud.mjs'), '// old-build\n');
swapApp(unpacked, target);
assert.equal(readFileSync(join(target, 'web', 'index.html'), 'utf8'), 'new-build', 'swap replaced the old tree');
assert.equal(existsSync(`${target}.old-${process.pid}`), false, 'the backup directory is cleaned up');
assert.equal(existsSync(unpacked), false, 'the unpacked tree moved instead of being copied');

const junk = join(root, 'junk');
mkdirSync(join(junk, 'nested'), { recursive: true });
writeFileSync(join(junk, 'nested', 'README.md'), 'hi');
const junkTarball = join(root, 'junk.tar.gz');
spawnSync('tar', ['-czf', 'junk.tar.gz', 'nested'], { cwd: junk, encoding: 'utf8' });
renameSync(join(junk, 'junk.tar.gz'), junkTarball);
assert.throws(() => unpackBundle(junkTarball, join(root, 'junk-out2')), /not a hud CLI bundle/);

// ---- paths -----------------------------------------------------------------------------------
assert.equal(installedVersion(), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'a checkout reports its own version');
const savedHome = process.env.HUD_HOME;
process.env.HUD_HOME = join(root, 'custom-home');
assert.equal(installRoot(), join(root, 'custom-home'), 'HUD_HOME wins outside an install');
assert.equal(launcherPath(), join(root, 'custom-home', 'bin', 'hud'));
if (savedHome === undefined) delete process.env.HUD_HOME;
else process.env.HUD_HOME = savedHome;

rmSync(root, { recursive: true, force: true });
console.log('PASS install: release parsing, checksum verification, unpack, swap and launcher paths');
