import assert from 'node:assert/strict';
import { backendUpdateAction, compareVersions, installerName, prepareBackendUpdate, releaseInfo, stopBackendForUpdate, UpdateChecker } from '../src/updates.ts';
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
console.log('PASS update selection, release validation, failure states and owned-backend handoff');
