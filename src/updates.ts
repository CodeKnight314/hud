import { resolve } from 'node:path';
import type { HealthInfo, Hud } from './client.ts';

const REPOSITORY = 'https://github.com/CodeKnight314/hud';
const LATEST_API = 'https://api.github.com/repos/CodeKnight314/hud/releases/latest';
export const RELEASES_URL = `${REPOSITORY}/releases/latest`;

export type UpdateInfo = {
  currentVersion: string;
  latestVersion?: string;
  status: 'unchecked' | 'checking' | 'available' | 'current' | 'error' | 'unsupported';
  checkedAt?: number;
  message?: string;
  releaseUrl: string;
  downloadName?: string;
  downloadUrl?: string;
  checkOnLaunch: boolean;
};

function versionParts(value: string): number[] | null {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new Error('Expected a stable version such as 0.1.1');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function backendUpdateAction(health: HealthInfo | null, dataDir: string, version: string): 'start' | 'reuse' | 'restart' {
  if (!health) return 'start';
  if (health.mode !== 'packaged' || !health.dataDir || resolve(health.dataDir) !== resolve(dataDir)) throw new Error('Another HUD installation owns this port. Quit its server before opening this app.');
  if (!health.version) throw new Error('The running HUD server has no version. Quit its server before opening this app.');
  const difference = compareVersions(version, health.version);
  if (difference < 0) throw new Error(`HUD server v${health.version} is newer than this app (v${version}). Open the newer app to keep your boards compatible.`);
  if (!difference) return 'reuse';
  if (health.saveError) throw new Error('The running HUD server could not save its boards. Resolve its save error before updating.');
  if (!Number.isSafeInteger(health.pid) || Number(health.pid) < 1) throw new Error('The running HUD server has no valid process identity. Quit it before updating.');
  return 'restart';
}

/** Upgrade only our own older packaged backend, after a successful live-state backup. */
export async function prepareBackendUpdate(hud: Pick<Hud, 'healthInfo' | 'backup' | 'request'>, dataDir: string, version: string): Promise<boolean> {
  const health = await hud.healthInfo();
  if (backendUpdateAction(health, dataDir, version) !== 'restart') return false;
  await stopOwnedBackend(hud, health!, dataDir, version);
  return true;
}

export async function stopBackendForUpdate(hud: Pick<Hud, 'healthInfo' | 'backup' | 'request'>, dataDir: string, version: string): Promise<void> {
  const health = await hud.healthInfo();
  backendUpdateAction(health, dataDir, version);
  if (health) await stopOwnedBackend(hud, health, dataDir, version);
}

async function stopOwnedBackend(hud: Pick<Hud, 'healthInfo' | 'backup' | 'request'>, health: HealthInfo, dataDir: string, version: string): Promise<void> {
  if (health.saveError || !Number.isSafeInteger(health.pid) || Number(health.pid) < 1) throw new Error('HUD cannot safely stop while its boards have a save error or its server identity is unknown.');
  await hud.backup(`before-update-${version}`);
  const latest = await hud.healthInfo();
  if (!latest || latest.pid !== health.pid || latest.version !== health.version || latest.saveError) throw new Error('The HUD server changed during update preparation. Reopen the app to try again.');
  backendUpdateAction(latest, dataDir, version);
  await hud.request('POST', '/api/shutdown');
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((done) => setTimeout(done, 100));
    const current = await hud.healthInfo();
    if (!current) return;
    if (current.pid !== health.pid) throw new Error('Another HUD server started during the update. Reopen the app to reconnect.');
  }
  throw new Error('The old HUD server did not stop. Quit it before opening the updated app.');
}

export function installerName(version: string, platform: string, arch: string, appImage = false): string | null {
  if (!versionParts(version)) return null;
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `hud-${version}-mac-${arch}.dmg`;
  if (platform === 'win32' && ['arm64', 'x64'].includes(arch)) return `hud-${version}-win-${arch}.exe`;
  if (platform === 'linux' && arch === 'x64') return `hud-${version}-linux-${appImage ? 'x86_64.AppImage' : 'amd64.deb'}`;
  return null;
}

/** Only published stable releases and exact installer links in our repository are accepted. */
export function releaseInfo(raw: unknown, currentVersion: string, platform: string, arch: string, appImage = false): Omit<UpdateInfo, 'checkOnLaunch'> {
  if (!raw || typeof raw !== 'object') throw new Error('GitHub returned an invalid release');
  const release = raw as Record<string, unknown>;
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('GitHub did not return a published stable release');
  }
  const latestVersion = release.tag_name.slice(1);
  const newer = compareVersions(latestVersion, currentVersion);
  const releaseUrl = `${REPOSITORY}/releases/tag/${release.tag_name}`;
  const base = { currentVersion, latestVersion, checkedAt: Date.now(), releaseUrl };
  if (newer <= 0) return {
    ...base, status: 'current',
    message: newer === 0 ? 'You have the latest stable release.' : `Latest published release: v${latestVersion}. You are running a newer build.`,
  };
  const name = installerName(latestVersion, platform, arch, appImage);
  const asset = Array.isArray(release.assets) && release.assets.find((entry) => entry && entry.name === name);
  const expected = `${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
  if (!name || !asset || asset.browser_download_url !== expected || asset.state !== 'uploaded') {
    return { ...base, status: 'unsupported', message: `v${latestVersion} is available, but no matching installer is published for this app. View the release to choose a download.` };
  }
  return { ...base, status: 'available', downloadName: name, downloadUrl: expected, message: `v${latestVersion} is available.` };
}

export class UpdateChecker {
  private info: Omit<UpdateInfo, 'checkOnLaunch'>;
  private pending: Promise<void> | null = null;
  constructor(
    privateOptions: { version: string; platform?: string; arch?: string; appImage?: boolean; fetcher?: typeof fetch },
  ) {
    this.options = privateOptions;
    this.info = { currentVersion: privateOptions.version, status: 'unchecked', releaseUrl: RELEASES_URL };
  }
  private options: { version: string; platform?: string; arch?: string; appImage?: boolean; fetcher?: typeof fetch };

  state(checkOnLaunch: boolean): UpdateInfo { return { ...this.info, checkOnLaunch }; }

  check(): Promise<void> {
    if (this.pending) return this.pending;
    this.info = { currentVersion: this.options.version, status: 'checking', releaseUrl: RELEASES_URL };
    this.pending = this.perform().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async perform(): Promise<void> {
    try {
      const response = await (this.options.fetcher ?? fetch)(LATEST_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `hud/${this.options.version}`, 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(10_000), redirect: 'error', credentials: 'omit',
      });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub is rate limiting update checks. Try again later.' : `GitHub update check failed (HTTP ${response.status}).`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('GitHub returned an empty response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error('GitHub returned an oversized release response');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      this.info = releaseInfo(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.options.version, this.options.platform ?? process.platform, this.options.arch ?? process.arch, this.options.appImage ?? !!process.env.APPIMAGE);
    } catch (error) {
      this.info = { currentVersion: this.options.version, status: 'error', checkedAt: Date.now(), releaseUrl: RELEASES_URL, message: error instanceof Error ? error.message : 'Could not check for updates. Try again when you are online.' };
    }
  }
}
