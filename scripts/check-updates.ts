import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendUpdateAction, compareVersions, installerName, prepareBackendUpdate, releaseInfo, stopBackendForUpdate, UpdateChecker } from '../src/updates.ts';
import { checksumFileUrl, downloadVerifiedAsset, helperLaunchSpec, installApprovedUpdate, parseSha256Sums, planPackagedUpdate, posixUpdateHelper, releaseDownloadTarget, windowsUpdateHelper } from '../src/update-apply.ts';
import type { HealthInfo } from '../src/client.ts';

const release = (version = '0.1.2', platform = 'darwin', arch = 'arm64', appImage = false) => {
  const name = installerName(version, platform, arch, appImage);
  return { draft: false, prerelease: false, tag_name: `v${version}`, assets: [{ name, state: 'uploaded', browser_download_url: `https://github.com/CodeKnight314/hud/releases/download/v${version}/${name}` }] };
};
assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
for (const value of ['0.1', 'v0.1.0', '0.1.2-beta', '01.2.3', '0.01.0', 'NaN.0.0', '9007199254740992.0.0']) assert.throws(() => compareVersions(value, '0.1.0'));
for (const [platform, arch, format] of [['darwin', 'arm64', false], ['darwin', 'x64', false], ['win32', 'x64', false], ['linux', 'x64', false], ['linux', 'x64', true]] as const) {
  const info = releaseInfo(release('0.1.2', platform, arch, format), '0.1.1', platform, arch, format);
  assert.equal(info.status, 'available');
  assert.equal(info.downloadName, installerName('0.1.2', platform, arch, format));
}
assert.equal(releaseInfo(release('0.1.1'), '0.1.1', 'darwin', 'arm64').status, 'current');
assert.match(releaseInfo(release('0.1.0'), '0.1.1', 'darwin', 'arm64').message!, /newer build/);
assert.equal(releaseInfo(release(), '0.1.1', 'linux', 'arm64').status, 'unsupported');
assert.equal(releaseInfo({ ...release(), assets: [] }, '0.1.1', 'darwin', 'arm64').status, 'unsupported');
for (const link of ['https://evil.test/hud.dmg', 'file:///tmp/hud', 'https://github.com.evil.test/download', 'https://github.com/SomeoneElse/hud/releases/download/v0.1.2/hud-0.1.2-mac-arm64.dmg']) {
  const raw = release(); raw.assets[0].browser_download_url = link;
  assert.equal(releaseInfo(raw, '0.1.1', 'darwin', 'arm64').downloadUrl, undefined);
}
for (const raw of [{}, { ...release(), draft: true }, { ...release(), prerelease: true }, { ...release(), tag_name: 'v0.1.2-beta' }, { ...release(), tag_name: 'v0.1.2/../../x' }]) assert.throws(() => releaseInfo(raw, '0.1.1', 'darwin', 'arm64'));

let fetches = 0, respond: (() => void) | undefined;
const checker = new UpdateChecker({ version: '0.1.1', platform: 'darwin', arch: 'arm64', fetcher: (async (url, options) => {
  fetches++;
  assert.equal(url, 'https://api.github.com/repos/CodeKnight314/hud/releases/latest');
  assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'error');
  await new Promise<void>((done) => { respond = done; });
  return new Response(JSON.stringify(release()));
}) as typeof fetch });
const first = checker.check(), second = checker.check();
assert.equal(first, second); assert.equal(checker.state(true).status, 'checking'); assert.equal(fetches, 1);
respond!(); await first;
assert.equal(checker.state(true).status, 'available'); assert.equal(checker.state(false).checkOnLaunch, false);
for (const fetcher of [
  async () => { throw new Error('offline'); },
  async () => new Response('rate limited', { status: 403 }),
  async () => new Response('not JSON'),
  async () => new Response('x'.repeat(1024 * 1024 + 1)),
] as typeof fetch[]) {
  const failing = new UpdateChecker({ version: '0.1.1', fetcher });
  await failing.check(); assert.equal(failing.state(false).status, 'error'); assert.equal(failing.state(false).downloadUrl, undefined);
}

const own: HealthInfo = { name: 'hud', mode: 'packaged', dataDir: '/tmp/hud-update-fixture', pid: 12345, version: '0.1.0' };
assert.equal(backendUpdateAction(null, own.dataDir!, '0.1.1'), 'start');
assert.equal(backendUpdateAction(own, own.dataDir!, '0.1.1'), 'restart');
assert.equal(backendUpdateAction(own, own.dataDir!, '0.1.0'), 'reuse');
for (const health of [{ ...own, mode: 'source' }, { ...own, dataDir: '/tmp/another-hud' }, { ...own, version: '0.2.0' }, { ...own, saveError: 'disk full' }, { ...own, pid: undefined }, { ...own, version: undefined }]) assert.throws(() => backendUpdateAction(health, own.dataDir!, '0.1.1'));

let active: HealthInfo | null = own;
const calls: string[] = [];
const client = {
  async healthInfo() { calls.push('health'); return active; },
  async backup(reason?: string) { calls.push('backup'); assert.equal(reason, 'before-update-0.1.1'); return { name: 'fixture-backup.json' }; },
  async request<T>(method: string, path: string): Promise<T> { calls.push('shutdown'); assert.equal(method, 'POST'); assert.equal(path, '/api/shutdown'); active = null; return {} as T; },
};
assert.equal(await prepareBackendUpdate(client, own.dataDir!, '0.1.1'), true);
assert.deepEqual(calls, ['health', 'backup', 'health', 'shutdown', 'health']);
active = own; calls.length = 0;
await assert.rejects(prepareBackendUpdate({ ...client, async backup() { throw new Error('backup failed'); } }, own.dataDir!, '0.1.1'), /backup failed/);
assert.deepEqual(calls, ['health']);
active = own; calls.length = 0;
await assert.rejects(prepareBackendUpdate({ ...client, async backup() { active = { ...own, pid: 54321 }; return { name: 'backup' }; } }, own.dataDir!, '0.1.1'), /server changed/);
assert.deepEqual(calls, ['health', 'health']);
active = { ...own, version: '0.1.1' }; calls.length = 0;
await stopBackendForUpdate(client, own.dataDir!, '0.1.1');
assert.equal(active, null);
assert.deepEqual(calls, ['health', 'backup', 'health', 'shutdown', 'health']);
active = { ...own, version: '0.1.1', saveError: 'disk full' }; calls.length = 0;
await assert.rejects(stopBackendForUpdate(client, own.dataDir!, '0.1.1'), /save error/);
assert.deepEqual(calls, ['health']);
const sha = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const assetName = 'hud-0.1.2-mac-arm64.dmg';
const assetUrl = `https://github.com/CodeKnight314/hud/releases/download/v0.1.2/${assetName}`;
const sumsUrl = checksumFileUrl('v0.1.2');
assert.equal(sumsUrl, 'https://github.com/CodeKnight314/hud/releases/download/v0.1.2/SHA256SUMS');
assert.deepEqual(releaseDownloadTarget(assetUrl), { tag: 'v0.1.2', version: '0.1.2', name: assetName });
for (const link of [`${assetUrl}?token=1`, assetUrl.replace('https:', 'http:'), assetUrl.replace('hud-0.1.2', 'hud-0.1.3'), 'https://github.com/SomeoneElse/hud/releases/download/v0.1.2/hud-0.1.2-mac-arm64.dmg', 'https://evil.test/hud.dmg', sumsUrl]) {
  assert.equal(releaseDownloadTarget(link), null);
}
assert.equal(parseSha256Sums(`${sha('a')}  ${assetName}\n${sha('b')}  hud-0.1.2-linux-amd64.deb\n`).get(assetName), sha('a'));
for (const text of ['', `${sha('a')} ${assetName}\n`, `${sha('a')}  ../${assetName}\n`, `${sha('a')}  ${assetName}\n${sha('b')}  ${assetName}\n`, `${sha('a').toUpperCase()}  ${assetName}\n`, `${sha('a')}  ${assetName}\r\n`]) {
  assert.throws(() => parseSha256Sums(text));
}

const root = mkdtempSync(join(tmpdir(), 'hud-update-apply-'));
const downloads = join(root, 'downloads');
const installer = Buffer.from('fixture installer bytes');
const installerSha = sha(installer);
const sums = `${installerSha}  ${assetName}\n${sha('other')}  hud-0.1.2-win-x64.exe\n`;
const requests: string[] = [];
const fetcher = (async (url: string, options?: RequestInit) => {
  requests.push(String(url));
  assert.equal(options?.redirect, 'manual');
  assert.equal(options?.credentials, 'omit');
  const headers = new Headers(options?.headers);
  assert.equal(headers.get('accept-encoding'), 'identity');
  assert.equal(headers.get('user-agent'), 'hud/0.1.1');
  if (url === sumsUrl) return new Response(sums, { status: 200 });
  if (url === assetUrl) return new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/hud-release?token=1' } });
  if (url === 'https://objects.githubusercontent.com/hud-release?token=1') return new Response(installer, { status: 200, headers: { 'content-length': String(installer.length) } });
  throw new Error(`unexpected ${url}`);
}) as typeof fetch;
const verified = await downloadVerifiedAsset({ downloadUrl: assetUrl, downloadName: assetName, version: '0.1.2', currentVersion: '0.1.1', directory: downloads, fetcher });
assert.equal(verified.sha256, installerSha);
assert.equal(readFileSync(verified.path).equals(installer), true);
assert.deepEqual(requests, [sumsUrl, assetUrl, 'https://objects.githubusercontent.com/hud-release?token=1']);

const mismatch = (async (url: string) => new Response(url === sumsUrl ? sums : Buffer.from('tampered installer'), { status: 200 })) as typeof fetch;
await assert.rejects(downloadVerifiedAsset({ downloadUrl: assetUrl, downloadName: assetName, version: '0.1.2', directory: downloads, fetcher: mismatch }), /does not match the published SHA256/);
assert.equal(existsSync(verified.path), true, 'a failed download does not delete an earlier verified file');
const evil = (async (url: string) => url === sumsUrl ? new Response(sums, { status: 200 }) : new Response(null, { status: 302, headers: { location: 'https://evil.test/hud.dmg' } })) as typeof fetch;
await assert.rejects(downloadVerifiedAsset({ downloadUrl: assetUrl, downloadName: assetName, version: '0.1.2', directory: downloads, fetcher: evil }), /unexpected host/);
const loop = (async () => new Response(null, { status: 302, headers: { location: assetUrl } })) as typeof fetch;
await assert.rejects(downloadVerifiedAsset({ downloadUrl: assetUrl, downloadName: assetName, version: '0.1.2', directory: downloads, fetcher: loop }), /too many download redirects/i);
let sawBody = false;
const oversized = (async (url: string) => {
  if (url === sumsUrl) return new Response(sums, { status: 200 });
  return new Response(Buffer.from('0123456789abcdef'), { status: 200, headers: { 'content-length': '16' } });
}) as typeof fetch;
await assert.rejects(downloadVerifiedAsset({ downloadUrl: assetUrl, downloadName: assetName, version: '0.1.2', directory: downloads, fetcher: oversized, maxBytes: 8 }), /larger than HUD will download/);
const declaredHuge = (async (url: string) => {
  if (url === sumsUrl) return new Response(sums, { status: 200 });
  sawBody = true;
  return new Response(installer, { status: 200, headers: { 'content-length': '999999999' } });
}) as typeof fetch;
await assert.rejects(downloadVerifiedAsset({ downloadUrl: assetUrl, downloadName: assetName, version: '0.1.2', directory: downloads, fetcher: declaredHuge, maxBytes: 32 }), /larger than HUD will download/);
assert.equal(sawBody, true, 'content-length is checked before the body is hashed');
const missingSum = (async () => new Response(`${sha('x')}  hud-0.1.2-win-x64.exe\n`, { status: 200 })) as typeof fetch;
await assert.rejects(downloadVerifiedAsset({ downloadUrl: assetUrl, downloadName: assetName, version: '0.1.2', directory: downloads, fetcher: missingSum }), /does not publish a SHA256/);
await assert.rejects(downloadVerifiedAsset({ downloadUrl: assetUrl, downloadName: 'hud-0.1.2-win-x64.exe', version: '0.1.2', directory: downloads, fetcher }), /does not match the checked release/);

const appBundle = join(root, 'hud.app');
mkdirSync(join(appBundle, 'Contents', 'MacOS'), { recursive: true });
writeFileSync(join(appBundle, 'Contents', 'MacOS', 'hud'), 'old-binary\n');
chmodSync(join(appBundle, 'Contents', 'MacOS', 'hud'), 0o755);
const macPlan = planPackagedUpdate(
  { platform: 'darwin', execPath: join(appBundle, 'Contents', 'MacOS', 'hud') },
  verified,
);
assert.equal(macPlan.kind, 'dmg');
assert.equal(macPlan.destination, appBundle);
assert.equal(macPlan.relaunch, appBundle);
assert.throws(() => planPackagedUpdate({ platform: 'darwin', execPath: '/Applications/Other.app/Contents/MacOS/hud' }, verified), /hud\.app/);
assert.throws(() => planPackagedUpdate({ platform: 'linux', execPath: '/opt/hud/hud' }, verified), /macOS/);
const winAsset = { name: 'hud-0.1.2-win-x64.exe', path: join(root, 'hud-0.1.2-win-x64.exe'), version: '0.1.2', sha256: installerSha };
writeFileSync(winAsset.path, installer);
const winPlan = planPackagedUpdate({ platform: 'win32', execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\hud\\hud.exe' }, winAsset);
assert.equal(winPlan.kind, 'nsis');
assert.equal(winPlan.destination, 'C:\\Users\\me\\AppData\\Local\\Programs\\hud');
assert.throws(() => planPackagedUpdate({ platform: 'win32', execPath: 'C:\\Windows\\notepad.exe' }, winAsset), /hud\.exe/);
const image = join(root, 'HUD.AppImage');
writeFileSync(image, 'old-image\n');
chmodSync(image, 0o755);
const imageAsset = { name: 'hud-0.1.2-linux-x86_64.AppImage', path: join(root, 'hud-0.1.2-linux-x86_64.AppImage'), version: '0.1.2', sha256: installerSha };
writeFileSync(imageAsset.path, installer);
const imagePlan = planPackagedUpdate({ platform: 'linux', execPath: '/tmp/.mount_hud/hud', appImage: image }, imageAsset);
assert.equal(imagePlan.destination, image);
assert.throws(() => planPackagedUpdate({ platform: 'linux', execPath: '/opt/hud/hud' }, imageAsset), /AppImage/);
const debAsset = { name: 'hud-0.1.2-linux-amd64.deb', path: join(root, 'hud-0.1.2-linux-amd64.deb'), version: '0.1.2', sha256: installerSha };
writeFileSync(debAsset.path, installer);
const debPlan = planPackagedUpdate({ platform: 'linux', execPath: '/opt/hud/hud' }, debAsset);
assert.deepEqual([debPlan.kind, debPlan.destination, debPlan.relaunch], ['deb', '/opt/hud', '/opt/hud/hud']);
assert.throws(() => planPackagedUpdate({ platform: 'linux', execPath: '/usr/local/hud', appImage: image }, debAsset), /\/opt\/hud\/hud/);
symlinkSync(appBundle, join(root, 'linked.app'));
assert.throws(() => planPackagedUpdate({ platform: 'darwin', execPath: join(root, 'linked.app', 'Contents', 'MacOS', 'hud') }, verified), /hud\.app/);

const helper = join(root, 'apply.sh');
writeFileSync(helper, posixUpdateHelper(), { mode: 0o700 });
assert.equal(posixUpdateHelper().includes('eval '), false);
assert.equal(posixUpdateHelper().includes('sh -c'), false);
assert.equal(windowsUpdateHelper().includes('Invoke-Expression'), false);
const spec = helperLaunchSpec(macPlan, 1, join(root, 'apply.log'), helper);
assert.equal(spec.command, '/bin/sh');
assert.deepEqual(spec.args.slice(0, 3), [helper, '1', 'dmg']);
assert.equal(spec.args.includes(macPlan.assetPath), true);
const winSpec = helperLaunchSpec(winPlan, 42, join(root, 'apply.log'), join(root, 'apply.ps1'));
assert.equal(winSpec.command, 'powershell.exe');
assert.equal(winSpec.args.includes('-File'), true);
assert.equal(winSpec.args.includes(winPlan.destination), true);
assert.equal(winSpec.args.join(' ').includes('sh -c'), false);
assert.throws(() => helperLaunchSpec(macPlan, 0, join(root, 'apply.log'), helper));

const bin = join(root, 'bin');
mkdirSync(bin);
const record = join(root, 'commands.txt');
const marker = join(root, 'relaunched');
const relaunch = join(root, 'relaunch.sh');
writeFileSync(relaunch, `#!/bin/sh\nprintf '%s\\n' "$0" > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
writeFileSync(join(bin, 'nohup'), `#!/bin/sh\ntrap '' HUP\nprintf '%s\\n' "$@" >> ${JSON.stringify(record)}\nif [ -x "$1" ]; then exec "$1"; fi\nexit 0\n`, { mode: 0o755 });
writeFileSync(join(bin, 'xattr'), `#!/bin/sh\nprintf 'xattr %s\\n' "$*" >> ${JSON.stringify(record)}\nexit 0\n`, { mode: 0o755 });
writeFileSync(join(bin, 'ditto'), `#!/bin/sh\nmkdir -p "$2"\ncp -R "$1"/. "$2"/\n`, { mode: 0o755 });
writeFileSync(join(bin, 'pkexec'), `#!/bin/sh\nprintf 'pkexec %s\\n' "$*" >> ${JSON.stringify(record)}\nexit 0\n`, { mode: 0o755 });
const mount = join(root, 'vol&x');
mkdirSync(join(mount, 'hud.app', 'Contents', 'MacOS'), { recursive: true });
writeFileSync(join(mount, 'hud.app', 'Contents', 'MacOS', 'hud'), '#!/bin/sh\nprintf new-app\\n\n', { mode: 0o755 });
const plist = `<?xml version="1.0"?><plist><dict><key>mount-point</key><string>${mount.replace('&', '&amp;')}</string></dict></plist>`;
writeFileSync(join(bin, 'hdiutil'), `#!/bin/sh\nif [ "$1" = attach ]; then printf '%s\\n' ${JSON.stringify(plist)}; exit 0; fi\nif [ "$1" = detach ]; then printf 'detach %s\\n' "$2" >> ${JSON.stringify(record)}; exit 0; fi\nexit 1\n`, { mode: 0o755 });
for (const name of ['nohup', 'xattr', 'ditto', 'pkexec', 'hdiutil']) chmodSync(join(bin, name), 0o755);
chmodSync(relaunch, 0o755);
chmodSync(helper, 0o755);

async function runHelper(args: string[], timeoutMs = 8000): Promise<number> {
  const child = spawn('/bin/sh', [helper, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  clearTimeout(timer);
  return code;
}
const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
await new Promise((resolve) => dead.once('exit', resolve));
const dmgLog = join(root, 'dmg.log');
assert.equal(await runHelper([String(dead.pid), 'dmg', verified.path, appBundle, relaunch, dmgLog]), 0);
assert.equal(readFileSync(join(appBundle, 'Contents', 'MacOS', 'hud'), 'utf8'), '#!/bin/sh\nprintf new-app\\n\n');
assert.equal(readFileSync(marker, 'utf8').trim(), relaunch);
assert.match(readFileSync(record, 'utf8'), /xattr -dr com\.apple\.quarantine/);
assert.match(readFileSync(dmgLog, 'utf8'), /installed/);
assert.equal(existsSync(verified.path), false, 'helper removes the verified download after install');
assert.equal(await runHelper([String(dead.pid), 'dmg', imageAsset.path, join(root, 'not-hud'), relaunch, join(root, 'bad-dmg.log')]), 1);

const nextImage = Buffer.from('new appimage bytes');
const nextImagePath = join(root, 'next-image');
writeFileSync(nextImagePath, nextImage);
rmSync(record);
assert.equal(await runHelper([String(dead.pid), 'appimage', nextImagePath, image, relaunch, join(root, 'image.log')]), 0);
assert.equal(readFileSync(image).equals(nextImage), true);
assert.equal((lstatSync(image).mode & 0o111) !== 0, true);
const debPackage = join(root, 'hud.deb');
writeFileSync(debPackage, 'deb-bytes\n');
rmSync(record);
assert.equal(await runHelper([String(dead.pid), 'deb', debPackage, '/opt/hud', '/opt/hud/hud', join(root, 'deb.log')]), 0);
assert.match(readFileSync(record, 'utf8'), new RegExp(`pkexec dpkg -i -- ${debPackage}`));
assert.match(readFileSync(record, 'utf8'), /\/opt\/hud\/hud/);
assert.equal(await runHelper([String(dead.pid), 'deb', debPackage, '/opt/hud', join(root, 'elsewhere'), join(root, 'deb-bad.log')]), 1);

const update = { status: 'available', currentVersion: '0.1.1', latestVersion: '0.1.2', downloadName: assetName, downloadUrl: assetUrl };
const target = { platform: 'darwin' as const, execPath: join(appBundle, 'Contents', 'MacOS', 'hud') };
let confirms = 0;
let applies = 0;
const outcome = await installApprovedUpdate({
  packaged: true, update, target, directory: downloads, fetcher,
  confirm: (summary) => { confirms++; assert.equal(summary.sha256, installerSha); assert.equal(summary.version, '0.1.2'); return false; },
  apply: async () => { applies++; },
});
assert.equal(outcome, 'cancelled');
assert.equal(applies, 0);
const kept = await installApprovedUpdate({
  packaged: true, update, target, directory: downloads, fetcher,
  confirm: () => true,
  apply: async (plan) => { applies++; assert.equal(plan.destination, appBundle); assert.equal(existsSync(plan.assetPath), true); },
});
assert.equal(kept, 'started');
assert.equal(applies, 1);
await assert.rejects(installApprovedUpdate({
  packaged: true, update, target, directory: downloads, fetcher,
  confirm: () => true,
  apply: async () => { throw new Error('server changed'); },
}), /server changed/);
let blockedConfirm = false;
await assert.rejects(installApprovedUpdate({
  packaged: false, update, target, directory: downloads,
  fetcher: (async () => { throw new Error('should not download'); }) as typeof fetch,
  confirm: () => { blockedConfirm = true; return true; },
  apply: async () => { applies++; },
}), /packaged app/);
assert.equal(blockedConfirm, false);
await assert.rejects(installApprovedUpdate({
  packaged: true, update: { ...update, status: 'current' }, target, directory: downloads,
  fetcher: (async () => { throw new Error('should not download'); }) as typeof fetch,
  confirm: () => { blockedConfirm = true; return true; },
  apply: async () => { applies++; },
}), /matching installer/);
assert.equal(blockedConfirm, false);
assert.equal(confirms, 1);
const locked = join(root, 'locked');
mkdirSync(locked);
const lockedImage = join(locked, 'HUD.AppImage');
writeFileSync(lockedImage, 'image');
chmodSync(locked, 0o500);
try {
  await assert.rejects(installApprovedUpdate({
    packaged: true,
    update: { ...update, downloadName: imageAsset.name, downloadUrl: assetUrl.replace(assetName, imageAsset.name) },
    target: { platform: 'linux', execPath: '/tmp/.mount_hud/hud', appImage: lockedImage },
    directory: downloads,
    fetcher: (async () => { throw new Error('should not download before the installed copy is checked'); }) as typeof fetch,
    confirm: () => { blockedConfirm = true; return true; },
    apply: async () => { applies++; },
  }), /replace this copy/);
} finally { chmodSync(locked, 0o700); }
assert.equal(blockedConfirm, false);
assert.equal(applies, 1);

console.log('PASS update selection, release validation, verified download, approval gate and owned-backend handoff');
