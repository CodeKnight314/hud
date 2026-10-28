import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SOURCE_ROOT, asset, isBundle } from './assets.ts';

/** Repository that publishes the CLI tarball this file installs and updates. */
export const REPO = 'CodeKnight314/hud';
export const SUMS = 'SHA256SUMS';
export const bundleName = (version: string): string => `hud-${version}.tar.gz`;

/**
 * Where a curl install lives. `app/` is the immutable bundle (replaced on update) and `bin/hud`
 * is the launcher; board data stays in its own per-user directory.
 */
export function installRoot(): string {
  // installed: the bundle lives at <root>/app, so the running tree is the truth, not the environment
  if (isBundle()) return dirname(SOURCE_ROOT);
  return process.env.HUD_HOME ? resolve(process.env.HUD_HOME) : join(homedir(), '.hud');
}
export function appDir(): string {
  return join(installRoot(), 'app');
}
export function launcherPath(): string {
  return join(installRoot(), 'bin', 'hud');
}

/** Version of the tree this process runs from (checkout, curl install, or packaged app). */
export function installedVersion(): string | null {
  const raw = asset('package.json');
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'version' in parsed && typeof parsed.version === 'string') return parsed.version;
  } catch {
    /* a checkout without a readable manifest has no version to report */
  }
  return null;
}

export type ReleaseAsset = { name: string; url: string };
export type Release = { version: string; assets: ReleaseAsset[]; pageUrl: string };

function assetOf(raw: unknown): ReleaseAsset | null {
  if (!raw || typeof raw !== 'object' || !('name' in raw) || typeof raw.name !== 'string') return null;
  if ('browser_download_url' in raw && typeof raw.browser_download_url === 'string') return { name: raw.name, url: raw.browser_download_url };
  if ('url' in raw && typeof raw.url === 'string') return { name: raw.name, url: raw.url };
  return null;
}

/**
 * A published stable release. Drafts and prereleases are never offered, so `hud update` cannot
 * install something the release page has not announced.
 */
export async function releaseInfo(fetcher: typeof fetch = fetch, version?: string): Promise<Release> {
  const url = version
    ? `https://api.github.com/repos/${REPO}/releases/tags/v${version}`
    : `https://api.github.com/repos/${REPO}/releases/latest`;
  const res = await fetcher(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'hud-cli' } });
  if (!res.ok) throw new Error(`release lookup failed: ${res.status} ${res.statusText}`);
  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') throw new Error('release lookup returned no JSON object');
  const tag = 'tag_name' in body && typeof body.tag_name === 'string' ? body.tag_name : '';
  const stable = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!stable) throw new Error(`release tag ${tag || '(missing)'} is not a stable vX.Y.Z tag`);
  if (('draft' in body && body.draft === true) || ('prerelease' in body && body.prerelease === true)) {
    throw new Error(`release ${tag} is a draft or prerelease`);
  }
  const assets = 'assets' in body && Array.isArray(body.assets) ? body.assets.map(assetOf).filter((a): a is ReleaseAsset => a !== null) : [];
  const pageUrl = 'html_url' in body && typeof body.html_url === 'string' ? body.html_url : `https://github.com/${REPO}/releases/tag/${tag}`;
  return { version: stable[1]!, assets, pageUrl };
}

/** The checksum recorded for one asset in a `sha256  name` file. */
export function checksumFor(sumsText: string, name: string): string | undefined {
  for (const line of sumsText.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match && match[2] === name) return match[1];
  }
  return undefined;
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function download(url: string, fetcher: typeof fetch): Promise<Buffer> {
  const res = await fetcher(url, { headers: { 'user-agent': 'hud-cli' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch the tarball and verify it against the release's SHA256SUMS before using it. */
export async function fetchBundle(release: Release, fetcher: typeof fetch = fetch, into = mkdtempSync(join(tmpdir(), 'hud-download-'))): Promise<{ path: string; sha256: string }> {
  const wanted = bundleName(release.version);
  const bundle = release.assets.find((a) => a.name === wanted);
  const sums = release.assets.find((a) => a.name === SUMS);
  if (!bundle) throw new Error(`release v${release.version} has no ${wanted}`);
  if (!sums) throw new Error(`release v${release.version} has no ${SUMS}`);
  const expected = checksumFor((await download(sums.url, fetcher)).toString('utf8'), wanted);
  if (!expected) throw new Error(`${SUMS} does not list ${wanted}`);
  const bytes = await download(bundle.url, fetcher);
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${wanted} does not match ${SUMS} (expected ${expected}, got ${actual})`);
  mkdirSync(into, { recursive: true });
  const path = join(into, wanted);
  writeFileSync(path, bytes);
  return { path, sha256: actual };
}

/** A bundle directory is one flat folder holding hud.mjs beside web/. */
export function bundleRoot(dir: string): string | null {
  if (existsSync(join(dir, 'hud.mjs')) && existsSync(join(dir, 'web'))) return dir;
  const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  return dirs.length === 1 ? bundleRoot(join(dir, dirs[0]!)) : null;
}

/** Unpack a verified tarball and refuse anything that is not the CLI bundle. */
export function unpackBundle(tarball: string, into: string): string {
  mkdirSync(into, { recursive: true });
  // Windows tar reads an absolute "C:\..." argument as host:path, so copy the archive beside the
  // target and unpack it by a relative name from there.
  const local = join(into, '.hud-bundle.tar.gz');
  copyFileSync(tarball, local);
  const result = spawnSync('tar', ['-xzf', basename(local)], { cwd: into, encoding: 'utf8' });
  rmSync(local, { force: true });
  if (result.error) throw new Error(`could not run tar: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`tar failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  const root = bundleRoot(into);
  if (!root) throw new Error('the download is not a hud CLI bundle (hud.mjs + web/ missing)');
  return root;
}

/** Replace the installed app with a validated tree, keeping the old one until the swap succeeds. */
export function swapApp(newRoot: string, target = appDir()): void {
  const old = `${target}.old-${process.pid}`;
  mkdirSync(dirname(target), { recursive: true });
  rmSync(old, { recursive: true, force: true });
  const hadOld = existsSync(target);
  if (hadOld) renameSync(target, old);
  try {
    renameSync(newRoot, target);
  } catch (error) {
    if (hadOld) renameSync(old, target);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
}
