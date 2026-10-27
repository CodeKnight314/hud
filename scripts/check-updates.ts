import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armReconnectNotice, readReconnectNotice } from '../src/reconnect.ts';
import { backendUpdateAction, compareVersions, installerName, prepareBackendUpdate, releaseInfo, stopBackendForUpdate, UpdateChecker } from '../src/updates.ts';
import { checksumFileUrl, downloadVerifiedAsset, helperLaunchSpec, installApprovedUpdate, parseSha256Sums, planPackagedUpdate, posixUpdateHelper, recordedInstallExe, rejectServerRestartDuringUpdate, releaseDownloadTarget, runVerifiedUpdateHandoff, windowsUpdateHelper } from '../src/update-apply.ts';
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
assert.equal(imagePlan.destination, realpathSync(image));
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
assert.equal(spec.args.at(-2), macPlan.sha256);
assert.equal(spec.args.at(-1), '0');
assert.equal(spec.args.includes(macPlan.assetPath), true);
const winSpec = helperLaunchSpec(winPlan, 42, join(root, 'apply.log'), join(root, 'apply.ps1'), 7);
assert.equal(winSpec.command, 'powershell.exe');
assert.equal(winSpec.args.includes('-File'), true);
assert.equal(winSpec.args.includes('-ExpectedSha256'), true);
assert.equal(winSpec.args.includes(winPlan.sha256), true);
assert.equal(winSpec.args.includes('-ServerPid'), true);
assert.equal(winSpec.args.at(-1), '7');
assert.equal(winSpec.args.includes(winPlan.destination), true);
assert.equal(winSpec.script.includes('/S /D=$Directory'), true);
assert.equal(winSpec.args.join(' ').includes('sh -c'), false);
assert.throws(() => helperLaunchSpec(macPlan, 0, join(root, 'apply.log'), helper));
assert.throws(() => helperLaunchSpec(macPlan, 1, join(root, 'apply.log'), helper, -1));

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
writeFileSync(join(bin, 'open'), `#!/bin/sh\nprintf 'open %s\\n' "$*" >> ${JSON.stringify(record)}\nif [ -x "$1" ]; then exec "$1"; fi\nexit 0\n`, { mode: 0o755 });
for (const name of ['nohup', 'open', 'xattr', 'ditto', 'pkexec', 'hdiutil']) chmodSync(join(bin, name), 0o755);
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
async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const dmgLog = join(root, 'dmg.log');
assert.equal(await runHelper([String(dead.pid), 'dmg', verified.path, appBundle, relaunch, dmgLog, installerSha, '0']), 0);
assert.equal(readFileSync(join(appBundle, 'Contents', 'MacOS', 'hud'), 'utf8'), '#!/bin/sh\nprintf new-app\\n\n');
await waitForFile(marker);
assert.equal(readFileSync(marker, 'utf8').trim(), relaunch);
assert.match(readFileSync(record, 'utf8'), /xattr -dr com\.apple\.quarantine/);
assert.match(readFileSync(dmgLog, 'utf8'), /installed/);
assert.equal(existsSync(verified.path), false, 'helper removes the verified download after install');
assert.equal(await runHelper([String(dead.pid), 'dmg', imageAsset.path, join(root, 'not-hud'), relaunch, join(root, 'bad-dmg.log'), installerSha, '0']), 1);

const nextImage = Buffer.from('new appimage bytes');
const nextImagePath = join(root, 'next-image');
writeFileSync(nextImagePath, nextImage);
rmSync(record);
assert.equal(await runHelper([String(dead.pid), 'appimage', nextImagePath, image, relaunch, join(root, 'image.log'), sha(nextImage), '0']), 0);
assert.equal(readFileSync(image).equals(nextImage), true);
assert.equal((lstatSync(image).mode & 0o111) !== 0, true);
const debPackage = join(root, 'hud.deb');
writeFileSync(debPackage, 'deb-bytes\n');
rmSync(record);
assert.equal(await runHelper([String(dead.pid), 'deb', debPackage, '/opt/hud', '/opt/hud/hud', join(root, 'deb.log'), sha('deb-bytes\n'), '0']), 0);
assert.match(readFileSync(record, 'utf8'), new RegExp(`pkexec dpkg -i -- ${debPackage}`));
assert.match(readFileSync(record, 'utf8'), /\/opt\/hud\/hud/);
assert.equal(await runHelper([String(dead.pid), 'deb', debPackage, '/opt/hud', join(root, 'elsewhere'), join(root, 'deb-bad.log'), sha('deb-bytes\n'), '0']), 1);

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

for (const latest of ['0.1.1', '0.1.0']) {
  await assert.rejects(installApprovedUpdate({
    packaged: true,
    update: { ...update, currentVersion: '0.1.1', latestVersion: latest },
    target, directory: downloads,
    fetcher: (async () => { throw new Error('should not download a downgrade'); }) as typeof fetch,
    confirm: () => { blockedConfirm = true; return true; },
    apply: async () => { applies++; },
  }), /not newer/);
}
await assert.rejects(installApprovedUpdate({
  packaged: true,
  update: { ...update, latestVersion: '0.1.2-beta' },
  target, directory: downloads,
  fetcher: (async () => { throw new Error('should not download'); }) as typeof fetch,
  confirm: () => { blockedConfirm = true; return true; },
  apply: async () => { applies++; },
}), /matching installer/);
assert.equal(blockedConfirm, false);
assert.equal(applies, 1);

let tamperApplies = 0;
await assert.rejects(installApprovedUpdate({
  packaged: true, update, target, directory: downloads, fetcher,
  confirm: (summary) => { writeFileSync(summary.path, 'tampered after confirm'); return true; },
  apply: async () => { tamperApplies++; },
}), /changed after it was checked/);
assert.equal(tamperApplies, 0);

const noticeDir = join(root, 'reconnect-board');
mkdirSync(noticeDir);
const armed = armReconnectNotice(noticeDir, {
  reason: 'quit-for-update', fromVersion: '0.1.1', at: 10,
  clients: [{ id: 'claude', name: 'Claude Code', actor: 'claude', kind: 'agent', version: '0.1.1', live: true }, { id: '', name: 'drop', actor: 'x', kind: 'agent', live: true }],
});
assert.equal(armed.clients.length, 1);
assert.deepEqual(readReconnectNotice(noticeDir), armed);
writeFileSync(join(noticeDir, 'reconnect.json'), JSON.stringify({ reason: 'other', fromVersion: '0.1.1', at: 1, clients: [] }));
assert.equal(readReconnectNotice(noticeDir), null);

rejectServerRestartDuringUpdate(false);
assert.throws(() => rejectServerRestartDuringUpdate(true), /will not restart the old server/);
const handoffChild = spawn('sleep', ['30'], { stdio: 'ignore' });
let handoffQuit = false;
await assert.rejects(runVerifiedUpdateHandoff({
  spawnHelper: async () => handoffChild,
  stopBackend: async () => { throw new Error('server changed'); },
  quit: () => { handoffQuit = true; },
}), /server changed/);
await new Promise((resolve) => handoffChild.once('exit', resolve));
assert.equal(handoffQuit, false);
assert.equal(handoffChild.killed, true);
const keptChild = spawn('sleep', ['30'], { stdio: 'ignore' });
await runVerifiedUpdateHandoff({
  spawnHelper: async () => keptChild,
  stopBackend: async () => {},
  quit: () => { handoffQuit = true; },
});
assert.equal(handoffQuit, true);
assert.equal(keptChild.killed, false);
keptChild.kill();
await new Promise((resolve) => keptChild.once('exit', resolve));

const realImage = join(root, 'Real.AppImage');
writeFileSync(realImage, 'old-image\n');
chmodSync(realImage, 0o755);
const linkImage = join(root, 'Link.AppImage');
symlinkSync(realImage, linkImage);
const otherImage = join(root, 'Other.AppImage');
writeFileSync(otherImage, 'other-image\n');
chmodSync(otherImage, 0o755);
const linkedPlan = planPackagedUpdate({ platform: 'linux', execPath: '/tmp/.mount_hud/hud', appImage: linkImage, commandExe: linkImage }, imageAsset);
assert.equal(linkedPlan.destination, realpathSync(realImage));
assert.equal(linkedPlan.relaunch, linkedPlan.destination);
assert.throws(() => planPackagedUpdate({ platform: 'linux', execPath: '/tmp/.mount_hud/hud', appImage: realImage, commandExe: otherImage }, imageAsset), /different AppImage/);
const board = join(root, 'appimage-board');
mkdirSync(board);
const shim = join(root, 'hud-shim');
writeFileSync(join(board, 'cli.json'), JSON.stringify({ path: shim, entry: join(board, 'appimage-boot.mjs'), exe: realImage }));
assert.equal(recordedInstallExe(board), realImage);
const shimPlan = planPackagedUpdate({ platform: 'linux', execPath: '/tmp/.mount_hud/hud', appImage: linkImage, commandExe: recordedInstallExe(board) }, imageAsset);
assert.equal(shimPlan.destination, realpathSync(realImage), 'in-place replace keeps the shim exe path');
writeFileSync(shim, `#!/bin/sh\n# hud — generated by the hud app.\nunset HUD_CLI_ENTRY\nexec ${JSON.stringify(realImage)} shim-ok\n`, { mode: 0o755 });
chmodSync(shim, 0o755);
const shimMarker = join(root, 'shim-marker');
const replacement = `#!/bin/sh\nprintf '%s\\n' "\${1:-relaunch}" > ${JSON.stringify(shimMarker)}\n`;
const replacementPath = join(root, 'replacement.AppImage');
writeFileSync(replacementPath, replacement, { mode: 0o755 });
const replacementSha = sha(replacement);
writeFileSync(realImage, 'old-image\n');
assert.equal(await runHelper([String(dead.pid), 'appimage', replacementPath, realImage, realImage, join(root, 'bad-sha.log'), 'ab'.repeat(32), '0']), 1);
assert.equal(readFileSync(realImage, 'utf8'), 'old-image\n', 'a failed re-hash does not replace the AppImage');
const keeper = spawn('sleep', ['30'], { stdio: 'ignore' });
let imageDone = false;
const imagePending = runHelper([String(dead.pid), 'appimage', replacementPath, realImage, realImage, join(root, 'keep-server.log'), replacementSha, String(keeper.pid)]).then((code) => { imageDone = true; return code; });
await new Promise((resolve) => setTimeout(resolve, 700));
assert.equal(imageDone, false, 'helper waits until the keep-server child exits');
assert.equal(readFileSync(realImage, 'utf8'), 'old-image\n');
keeper.kill('SIGKILL');
assert.equal(await imagePending, 0);
assert.equal(readFileSync(shim, 'utf8').includes(realImage), true);
assert.equal(readFileSync(shimMarker, 'utf8').trim(), 'relaunch');
execFileSync(shim, [], { timeout: 5000 });
assert.equal(readFileSync(shimMarker, 'utf8').trim(), 'shim-ok');

function powershellHost(): string | null {
  const names = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe', 'pwsh'] : ['pwsh', 'powershell'];
  for (const name of names) {
    const probe = spawnSync(name, ['-NoProfile', '-Command', 'Write-Output ok'], { encoding: 'utf8', timeout: 20000 });
    if (probe.status === 0 && probe.stdout.includes('ok')) return name;
  }
  return null;
}
const pwsh = powershellHost();
if (pwsh) {
  const winDir = join(root, 'win-install');
  mkdirSync(winDir);
  const argFile = join(root, 'nsis-args.txt');
  const relaunchMarker = join(root, 'win-relaunched.txt');
  const assetDir = join(root, 'win-asset');
  mkdirSync(assetDir);
  const installerExe = join(assetDir, 'hud-setup.exe');
  const installerBody = `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argFile)}\nexit 0\n`;
  writeFileSync(installerExe, installerBody, { mode: 0o755 });
  chmodSync(installerExe, 0o755);
  const relaunchExe = join(winDir, 'hud.exe');
  writeFileSync(relaunchExe, `#!/bin/sh\nprintf relaunch > ${JSON.stringify(relaunchMarker)}\n`, { mode: 0o755 });
  chmodSync(relaunchExe, 0o755);
  const winRun = {
    kind: 'nsis' as const,
    assetPath: installerExe,
    destination: winDir,
    relaunch: relaunchExe,
    version: '0.1.2',
    sha256: sha(installerBody),
  };
  const winScript = join(root, 'apply.ps1');
  const winLaunch = helperLaunchSpec(winRun, dead.pid ?? 1, join(root, 'win-apply.log'), winScript, 0);
  writeFileSync(winScript, winLaunch.script);
  const runPwsh = (args: string[]) => spawnSync(pwsh, args, { encoding: 'utf8', timeout: 20000 });
  const mismatch = runPwsh(winLaunch.args.map((arg) => arg === winRun.sha256 ? 'aa'.repeat(32) : arg));
  assert.notEqual(mismatch.status, 0);
  assert.equal(existsSync(argFile), false, 'Windows helper does not run the installer when the hash changed');
  assert.match(winLaunch.script, /\$psi\.Arguments = "\/S \/D=\$Directory"/);
  // The fixture installer is a POSIX script. Windows PowerShell still executes the hash refusal above.
  if (process.platform !== 'win32') {
    const installed = runPwsh(winLaunch.args);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.equal(readFileSync(argFile, 'utf8'), `/S\n/D=${winDir}\n`);
    assert.equal(readFileSync(argFile, 'utf8').includes('"'), false, 'NSIS /D path is not quoted');
    assert.equal(readFileSync(relaunchMarker, 'utf8').trim(), 'relaunch');
    const blocked = spawn('sleep', ['30'], { stdio: 'ignore' });
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(installerExe, installerBody, { mode: 0o755 });
    chmodSync(installerExe, 0o755);
    const waiting = helperLaunchSpec(winRun, dead.pid ?? 1, join(root, 'win-wait.log'), winScript, blocked.pid ?? 1);
    const waitingRun = spawn(pwsh, waiting.args, { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(waitingRun.exitCode, null, 'Windows helper waits for the old server pid');
    blocked.kill('SIGKILL');
    const waitingCode = await new Promise<number>((resolve) => waitingRun.once('exit', (status) => resolve(status ?? 1)));
    assert.equal(waitingCode, 0);
  }
} else {
  console.log('SKIP windows helper execution (PowerShell is not installed)');
}

console.log('PASS update selection, release validation, verified download, approval gate and owned-backend handoff');
