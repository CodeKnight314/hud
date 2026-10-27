import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, readFileSync, realpathSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { compareVersions } from './updates.ts';

/** Installers larger than this are rejected before they can fill the disk. */
export const MAX_RELEASE_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 64 * 1024;
const REDIRECT_LIMIT = 5;
const CDN_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

export type ReleaseFile = { tag: string; version: string; name: string };
export type VerifiedAsset = { path: string; directory: string; sha256: string; name: string; version: string };
export type UpdatePlan = {
  kind: 'dmg' | 'nsis' | 'appimage' | 'deb';
  assetPath: string;
  destination: string;
  relaunch: string;
  version: string;
  sha256: string;
};
export type PackagedTarget = { platform: string; execPath: string; appImage?: string; commandExe?: string };
export type ApprovedUpdate = {
  status: string;
  currentVersion: string;
  latestVersion?: string;
  downloadName?: string;
  downloadUrl?: string;
};

const POSIX_UPDATE_HELPER = `#!/bin/sh
# Replaces a verified HUD install after the owning process exits. Every path is a separate argument.
set -eu
if [ "$#" -ne 8 ]; then
  echo "usage: update-helper.sh pid kind asset dest relaunch log sha256 serverpid" >&2
  exit 2
fi
pid=$1
kind=$2
asset=$3
dest=$4
relaunch=$5
log=$6
sha=$7
server=$8
case "$pid" in
  ''|*[!0-9]*) printf '%s\\n' "bad pid" >> "$log"; exit 2 ;;
esac
if [ "$pid" -lt 1 ]; then printf '%s\\n' "bad pid" >> "$log"; exit 2; fi
log_fail() { printf '%s\\n' "$1" >> "$log"; }
mount=""
cleanup() {
  if [ -n "$mount" ]; then
    hdiutil detach "$mount" >/dev/null 2>&1 || hdiutil detach -force "$mount" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    log_fail "timed out waiting for HUD to quit"
    exit 1
  fi
  sleep 0.2
done
sleep 0.2
case "$server" in
  ''|*[!0-9]*) log_fail "bad server pid"; exit 2 ;;
esac
if [ "$server" -gt 0 ]; then
  i=0
  while kill -0 "$server" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 600 ]; then
      log_fail "timed out waiting for the old server"
      exit 1
    fi
    sleep 0.2
  done
fi
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$' || { log_fail "bad sha256"; exit 2; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum -- "$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 -- "$asset" | awk '{print $1}')
else
  log_fail "sha256 tool missing"
  exit 1
fi
if [ "$actual" != "$sha" ]; then
  log_fail "installer sha256 changed"
  exit 1
fi
if [ "$asset" = "$dest" ]; then
  log_fail "refusing to use the installed app as the downloaded asset"
  exit 1
fi
case "$kind" in
  appimage)
    case "$dest" in
      *.AppImage) ;;
      *) log_fail "refusing to replace a file that is not an AppImage"; exit 1 ;;
    esac
    staged="$dest.hud-new"
    rm -f "$staged"
    cp -f "$asset" "$staged"
    chmod 755 "$staged"
    mv -f "$staged" "$dest"
    ;;
  dmg)
    case "$dest" in
      */hud.app) ;;
      *) log_fail "refusing to replace a bundle that is not hud.app"; exit 1 ;;
    esac
    plist=$(hdiutil attach -nobrowse -readonly -plist "$asset")
    mount=$(printf '%s\\n' "$plist" | tr '\\n' ' ' | sed -n 's/.*<key>mount-point<\\/key>[[:space:]]*<string>\\([^<]*\\)<\\/string>.*/\\1/p')
    mount=$(printf '%s' "$mount" | sed 's/&amp;/\\&/g; s/&lt;/</g; s/&gt;/>/g; s/&quot;/"/g')
    if [ -z "$mount" ] || [ ! -d "$mount" ]; then
      log_fail "could not mount the disk image"
      exit 1
    fi
    src="$mount/hud.app"
    if [ ! -d "$src" ] || [ ! -x "$src/Contents/MacOS/hud" ]; then
      log_fail "disk image does not contain hud.app"
      exit 1
    fi
    src_real=$(cd "$src" && pwd -P)
    mount_real=$(cd "$mount" && pwd -P)
    case "$src_real" in
      "$mount_real"/*) ;;
      *) log_fail "hud.app is outside the mounted disk"; exit 1 ;;
    esac
    staged="$dest.hud-new"
    backup="$dest.hud-old"
    rm -rf "$staged"
    ditto "$src" "$staged"
    if [ -e "$dest" ]; then
      rm -rf "$backup"
      mv "$dest" "$backup"
    fi
    if ! mv "$staged" "$dest"; then
      if [ -e "$backup" ]; then mv "$backup" "$dest"; fi
      log_fail "could not move the new app into place"
      exit 1
    fi
    rm -rf "$backup"
    # The copy inherits the download's quarantine attribute, which blocks relaunch.
    # Clearing it is not a notarization or developer-signature check.
    xattr -dr com.apple.quarantine "$dest" || true
    hdiutil detach "$mount"
    mount=""
    ;;
  deb)
    if [ "$relaunch" != "/opt/hud/hud" ]; then
      log_fail "refusing a deb relaunch outside /opt/hud/hud"
      exit 1
    fi
    pkexec dpkg -i -- "$asset"
    ;;
  *)
    log_fail "unsupported update kind"
    exit 1
    ;;
esac
if [ "$(uname)" = "Darwin" ]; then
  open "$relaunch"
else
  nohup "$relaunch" >/dev/null 2>&1 &
fi
rm -f "$asset"
rmdir "$(dirname "$asset")" 2>/dev/null || true
printf '%s\\n' "installed" >> "$log"
`;

const WINDOWS_UPDATE_HELPER = `# Replaces a verified per-user HUD install after the owning process exits.
param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$Asset,
  [Parameter(Mandatory = $true)][string]$Directory,
  [Parameter(Mandatory = $true)][string]$Relaunch,
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [int]$ServerPid = 0
)
$ErrorActionPreference = 'Stop'
function Write-Log([string]$message) { Add-Content -LiteralPath $Log -Value $message }
if ($ParentPid -lt 1) { Write-Log 'bad pid'; exit 2 }
if ($Directory.Contains('"') -or $Directory.Contains([string][char]10) -or $Relaunch.Contains('"') -or $Asset.Contains('"')) {
  Write-Log 'refusing an install path that contains quotes or newlines'
  exit 2
}
$expected = Join-Path $Directory 'hud.exe'
if ($Relaunch -ne $expected) { Write-Log 'relaunch is not hud.exe in the install directory'; exit 2 }
$deadline = (Get-Date).AddMinutes(2)
while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
  if ((Get-Date) -gt $deadline) { Write-Log 'timed out waiting for HUD to quit'; exit 1 }
  Start-Sleep -Milliseconds 200
}
Start-Sleep -Milliseconds 200
if ($ServerPid -gt 0) {
  $serverDeadline = (Get-Date).AddMinutes(2)
  while (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $serverDeadline) { Write-Log 'timed out waiting for the old server'; exit 1 }
    Start-Sleep -Milliseconds 200
  }
}
if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { Write-Log 'bad sha256'; exit 2 }
$hash = (Get-FileHash -LiteralPath $Asset -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $ExpectedSha256) { Write-Log 'installer sha256 changed'; exit 1 }
# Windows marks downloaded files. Other hosts have no quarantine stream; a failure here must not block install.
if ($env:OS -eq 'Windows_NT') {
  try { Unblock-File -LiteralPath $Asset -ErrorAction SilentlyContinue } catch {}
}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Asset
$psi.Arguments = "/S /D=$Directory"
$psi.UseShellExecute = $false
$process = [System.Diagnostics.Process]::Start($psi)
$process.WaitForExit()
if ($process.ExitCode -ne 0) { Write-Log "installer exited $($process.ExitCode)"; exit $process.ExitCode }
Start-Process -FilePath $Relaunch
Remove-Item -LiteralPath $Asset -Force
$dir = Split-Path -Parent $Asset
# The download directory is empty after the installer is removed. A leftover file must not fail an install that already finished.
if ($dir) { try { Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue } catch {} }
Write-Log 'installed'
`;

export function posixUpdateHelper(): string { return POSIX_UPDATE_HELPER; }
export function windowsUpdateHelper(): string { return WINDOWS_UPDATE_HELPER; }

function stableVersion(value: string): string | null {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value) ? value : null;
}

export function installerKind(name: string, version: string): UpdatePlan['kind'] | null {
  const kinds: Record<string, UpdatePlan['kind']> = {
    [`hud-${version}-mac-arm64.dmg`]: 'dmg',
    [`hud-${version}-mac-x64.dmg`]: 'dmg',
    [`hud-${version}-win-arm64.exe`]: 'nsis',
    [`hud-${version}-win-x64.exe`]: 'nsis',
    [`hud-${version}-linux-x86_64.AppImage`]: 'appimage',
    [`hud-${version}-linux-amd64.deb`]: 'deb',
  };
  return kinds[name] ?? null;
}

/** Exact GitHub release-asset URL for one published installer. Query strings and other hosts are rejected. */
export function releaseDownloadTarget(url: string): ReleaseFile | null {
  return githubReleaseFile(url, false);
}

export function checksumFileUrl(tag: string): string {
  const version = tag.startsWith('v') ? stableVersion(tag.slice(1)) : null;
  if (!version || tag !== `v${version}`) throw new Error('Expected a stable release tag such as v0.1.2.');
  return `https://github.com/CodeKnight314/hud/releases/download/${tag}/SHA256SUMS`;
}

function checksumTarget(url: string): ReleaseFile | null {
  return githubReleaseFile(url, true);
}

function githubReleaseFile(url: string, checksum: boolean): ReleaseFile | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
  if (parsed.pathname.includes('\\') || parsed.pathname.includes('%')) return null;
  const parts = parsed.pathname.split('/');
  if (parts.length !== 7 || parts[1] !== 'CodeKnight314' || parts[2] !== 'hud' || parts[3] !== 'releases' || parts[4] !== 'download') return null;
  const tag = parts[5];
  const name = parts[6];
  const version = tag.startsWith('v') ? stableVersion(tag.slice(1)) : null;
  if (!version || tag !== `v${version}`) return null;
  if (checksum) return name === 'SHA256SUMS' ? { tag, version, name } : null;
  if (!installerKind(name, version) || name.includes('..')) return null;
  return { tag, version, name };
}

export function parseSha256Sums(text: string): Map<string, string> {
  if (text.length > MAX_CHECKSUM_BYTES) throw new Error('SHA256SUMS is too large.');
  if (text.includes('\r')) throw new Error('SHA256SUMS has an unexpected line.');
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  if (!lines.length) throw new Error('SHA256SUMS is empty.');
  const sums = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || match[2].includes('..') || match[2].startsWith('.')) throw new Error('SHA256SUMS has an unexpected line.');
    if (sums.has(match[2])) throw new Error('SHA256SUMS repeats a file.');
    sums.set(match[2], match[1]);
  }
  return sums;
}

function hashesEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function allowedRedirect(tag: string, current: string, location: string): string {
  let next: URL;
  try { next = new URL(location, current); } catch { throw new Error('Refusing a download redirect to an unexpected host.'); }
  if (next.protocol !== 'https:' || next.username || next.password || (next.port && next.port !== '443')) {
    throw new Error('Refusing a download redirect to an unexpected host.');
  }
  if (next.hostname === 'github.com') {
    const file = githubReleaseFile(next.href, false) ?? githubReleaseFile(next.href, true);
    if (!file || file.tag !== tag) throw new Error('Refusing a download redirect to an unexpected host.');
    return next.href;
  }
  if (!CDN_HOSTS.has(next.hostname)) throw new Error('Refusing a download redirect to an unexpected host.');
  return next.href;
}

/** Follows only GitHub release redirects onto GitHub or its release CDN. The response body is left open. */
export async function fetchRelease(url: string, fetcher: typeof fetch = fetch, timeoutMs = 20_000, userAgent = 'hud'): Promise<Response> {
  const start = releaseDownloadTarget(url) ?? checksumTarget(url);
  if (!start) throw new Error('Refusing a download that is not a published HUD release file.');
  let current = url;
  for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect++) {
    const response = await fetcher(current, {
      headers: { accept: 'application/octet-stream', 'user-agent': userAgent, 'accept-encoding': 'identity' },
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (redirect === REDIRECT_LIMIT) throw new Error('Too many download redirects.');
    if (!location) throw new Error('GitHub redirect had no location.');
    current = allowedRedirect(start.tag, current, location);
  }
  throw new Error('Too many download redirects.');
}

async function readBounded(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const declared = contentLength(response, maxBytes, label);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} response was empty.`);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) throw new Error(label === 'Installer' ? 'The installer is larger than HUD will download.' : 'SHA256SUMS is too large.');
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (declared !== null && declared !== size) throw new Error(`${label} size did not match Content-Length.`);
  if (!size) throw new Error(`${label} response was empty.`);
  return Buffer.concat(chunks);
}

function contentLength(response: Response, maxBytes: number, label: string): number | null {
  const declared = response.headers.get('content-length');
  if (declared === null) return null;
  if (!/^\d+$/.test(declared)) throw new Error(`${label} Content-Length was not a size.`);
  const size = Number(declared);
  if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error(label === 'Installer' ? 'The installer is larger than HUD will download.' : 'SHA256SUMS is too large.');
  if (size < 1) throw new Error(`${label} response was empty.`);
  return size;
}

async function hashFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Downloaded installer is not a regular file.');
    if (info.size > maxBytes) throw new Error('The installer is larger than HUD will download.');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (size !== info.size) throw new Error('The installer changed while it was being checked.');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function downloadVerifiedAsset(options: {
  downloadUrl: string;
  downloadName: string;
  version: string;
  directory: string;
  currentVersion?: string;
  fetcher?: typeof fetch;
  maxBytes?: number;
}): Promise<VerifiedAsset> {
  const target = releaseDownloadTarget(options.downloadUrl);
  if (!target || target.name !== options.downloadName || target.version !== options.version) {
    throw new Error('The update link does not match the checked release.');
  }
  const maxBytes = options.maxBytes ?? MAX_RELEASE_ASSET_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('The installer is larger than HUD will download.');
  const fetcher = options.fetcher ?? fetch;
  const userAgent = `hud/${options.currentVersion || options.version}`;
  const checksumResponse = await fetchRelease(checksumFileUrl(target.tag), fetcher, 20_000, userAgent);
  if (!checksumResponse.ok) throw new Error(checksumResponse.status === 404 ? 'The release does not publish SHA256SUMS.' : `Could not download SHA256SUMS (HTTP ${checksumResponse.status}).`);
  const sums = parseSha256Sums((await readBounded(checksumResponse, MAX_CHECKSUM_BYTES, 'SHA256SUMS')).toString('utf8'));
  const expected = sums.get(target.name);
  if (!expected) throw new Error('The release does not publish a SHA256 for this installer.');

  await mkdir(options.directory, { recursive: true });
  const directory = await mkdtemp(join(options.directory, 'hud-update-'));
  const path = join(directory, target.name);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let response: Response | null = null;
  try {
    response = await fetchRelease(options.downloadUrl, fetcher, 10 * 60_000, userAgent);
    if (!response.ok) throw new Error(`Could not download the installer (HTTP ${response.status}).`);
    const declared = contentLength(response, maxBytes, 'Installer');
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Installer response was empty.');
    const streaming = createHash('sha256');
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes) throw new Error('The installer is larger than HUD will download.');
        streaming.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new Error('Could not write the installer to disk.');
          offset += bytesWritten;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!size || (declared !== null && declared !== size)) throw new Error(size ? 'Installer size did not match Content-Length.' : 'Installer response was empty.');
    await handle.sync();
    await handle.close();
    handle = null;
    const sha256 = await hashFile(path, maxBytes);
    if (sha256 !== streaming.digest('hex') || !hashesEqual(sha256, expected)) {
      throw new Error(`The downloaded installer does not match the published SHA256. It was deleted and will not be installed.`);
    }
    return { path, directory, sha256, name: target.name, version: target.version };
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    await handle?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function rejectControl(value: string, label: string): void {
  if (!value || /[\0\r\n"]/.test(value)) throw new Error(`Refusing ${label} with unsupported characters.`);
}

export function planPackagedUpdate(target: PackagedTarget, asset: { name: string; path: string; version: string; sha256: string }): UpdatePlan {
  const version = stableVersion(asset.version);
  const kind = version ? installerKind(asset.name, version) : null;
  if (!version || !kind || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('The verified installer is not a published HUD release asset.');
  rejectControl(asset.path, 'an installer path');
  if (!isAbsolute(asset.path) || basename(asset.path) !== asset.name) throw new Error('The verified installer path does not match the release asset.');
  const plan = { kind, assetPath: asset.path, version, sha256: asset.sha256, destination: '', relaunch: '' };
  if (kind === 'dmg') {
    if (target.platform !== 'darwin') throw new Error('A macOS disk image can only update the macOS app.');
    plan.destination = macBundle(target.execPath);
    plan.relaunch = plan.destination;
    return plan;
  }
  if (kind === 'nsis') {
    if (target.platform !== 'win32') throw new Error('A Windows installer can only update the Windows app.');
    const installed = winInstall(target.execPath);
    plan.destination = installed.dir;
    plan.relaunch = installed.exe;
    return plan;
  }
  if (kind === 'appimage') {
    if (target.platform !== 'linux') throw new Error('An AppImage can only update the running AppImage.');
    plan.destination = appImagePath(target.appImage);
    assertAppImageCommand(plan.destination, target.commandExe);
    plan.relaunch = plan.destination;
    return plan;
  }
  if (target.platform !== 'linux' || target.execPath !== '/opt/hud/hud' || target.appImage) {
    throw new Error('In-app deb update only replaces /opt/hud/hud. Download the package to upgrade a copy installed somewhere else.');
  }
  rejectControl(target.execPath, 'an install path');
  plan.destination = '/opt/hud';
  plan.relaunch = '/opt/hud/hud';
  return plan;
}

function macBundle(execPath: string): string {
  rejectControl(execPath, 'an application path');
  if (!posix.isAbsolute(execPath) || execPath.split('/').includes('..')) throw new Error('In-app update only replaces the packaged hud.app.');
  const suffix = '/Contents/MacOS/hud';
  if (!execPath.endsWith(suffix)) throw new Error('In-app update only replaces the packaged hud.app.');
  const bundle = execPath.slice(0, -suffix.length);
  if (posix.basename(bundle) !== 'hud.app') throw new Error('In-app update only replaces the packaged hud.app.');
  return bundle;
}

function winInstall(execPath: string): { dir: string; exe: string } {
  rejectControl(execPath, 'an application path');
  if (!win32.isAbsolute(execPath) || execPath.split(/[\\/]/).includes('..')) throw new Error('In-app update only replaces hud.exe.');
  if (win32.basename(execPath).toLowerCase() !== 'hud.exe') throw new Error('In-app update only replaces hud.exe.');
  return { dir: win32.dirname(execPath), exe: execPath };
}

function appImagePath(value: string | undefined): string {
  if (!value) throw new Error('In-app update only replaces the running AppImage.');
  rejectControl(value, 'an AppImage path');
  if (!posix.isAbsolute(value) || value.split('/').includes('..') || !value.endsWith('.AppImage')) throw new Error('In-app update only replaces the running AppImage.');
  let resolved: string;
  try { resolved = realpathSync(value); } catch { throw new Error('In-app update only replaces the running AppImage.'); }
  if (!posix.isAbsolute(resolved) || resolved.split('/').includes('..') || !resolved.endsWith('.AppImage')) throw new Error('In-app update only replaces the running AppImage.');
  return resolved;
}

/** The #17 shim execs the `.AppImage` path recorded in cli.json. Replacing a different file would leave that command on the old bytes. */
function assertAppImageCommand(destination: string, commandExe: string | undefined): void {
  if (!commandExe || !commandExe.endsWith('.AppImage')) return;
  rejectControl(commandExe, 'an AppImage path');
  let recorded: string;
  try { recorded = realpathSync(commandExe); } catch { throw new Error('Refusing to update because the hud command points at a different AppImage.'); }
  if (recorded !== destination) throw new Error('Refusing to update because the hud command points at a different AppImage.');
}

/** `exe` from `<data>/cli.json`, when a command shim has been recorded. */
export function recordedInstallExe(dataDir: string): string | undefined {
  try {
    const exe = JSON.parse(readFileSync(join(dataDir, 'cli.json'), 'utf8')).exe;
    return typeof exe === 'string' && exe ? exe : undefined;
  } catch {
    return undefined;
  }
}

async function assertRegular(path: string, kind: 'file' | 'dir', label: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch { throw new Error(`HUD cannot see ${label} it would replace.`); }
  const matches = kind === 'file' ? info.isFile() : info.isDirectory();
  if (!matches || info.isSymbolicLink()) throw new Error(`Refusing to update because ${label} is not the installed program.`);
}

/** The installed copy must be a real file or bundle we can replace, never a symlink. */
export async function assertInstalledTarget(plan: UpdatePlan): Promise<void> {
  if (plan.kind === 'deb') {
    await assertRegular('/opt/hud/hud', 'file', '/opt/hud/hud');
    return;
  }
  if (plan.kind === 'appimage') {
    await assertRegular(plan.destination, 'file', 'the AppImage');
    await access(dirname(plan.destination), constants.W_OK).catch(() => { throw new Error('HUD cannot replace this copy of the app in place. Download the installer and replace it yourself.'); });
    return;
  }
  if (plan.kind === 'dmg') {
    await assertRegular(plan.destination, 'dir', 'hud.app');
    await assertRegular(join(plan.destination, 'Contents', 'MacOS', 'hud'), 'file', 'hud.app');
    await access(dirname(plan.destination), constants.W_OK).catch(() => { throw new Error('HUD cannot replace this copy of the app in place. Download the installer and replace it yourself.'); });
    return;
  }
  await assertRegular(plan.destination, 'dir', 'the install folder');
  await assertRegular(plan.relaunch, 'file', 'hud.exe');
  if (win32.normalize(plan.relaunch).toLowerCase() !== win32.normalize(win32.join(plan.destination, 'hud.exe')).toLowerCase()) {
    throw new Error('Refusing to update because hud.exe is not in the install folder.');
  }
  await access(plan.destination, constants.W_OK).catch(() => { throw new Error('HUD cannot replace this copy of the app in place. Download the installer and replace it yourself.'); });
}

export function helperLaunchSpec(plan: UpdatePlan, parentPid: number, logPath: string, scriptPath: string, serverPid = 0): { command: string; args: string[]; script: string } {
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) throw new Error('Refusing to update without the running app process.');
  if (!Number.isSafeInteger(serverPid) || serverPid < 0) throw new Error('Refusing to update without a valid server process id.');
  for (const path of [plan.assetPath, plan.destination, plan.relaunch, logPath, scriptPath]) rejectControl(path, 'an update path');
  if (![plan.assetPath, plan.destination, plan.relaunch, logPath, scriptPath].every((path) => isAbsolute(path) || (plan.kind === 'nsis' && win32.isAbsolute(path)))) {
    throw new Error('Refusing a relative update path.');
  }
  if (!/^[a-f0-9]{64}$/.test(plan.sha256)) throw new Error('Refusing to update without a SHA256 to re-check.');
  if (plan.kind === 'nsis') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ParentPid', String(parentPid), '-Asset', plan.assetPath, '-Directory', plan.destination, '-Relaunch', plan.relaunch, '-Log', logPath, '-ExpectedSha256', plan.sha256, '-ServerPid', String(serverPid)],
      script: WINDOWS_UPDATE_HELPER,
    };
  }
  if (!['dmg', 'appimage', 'deb'].includes(plan.kind)) throw new Error('Unsupported update kind.');
  return {
    command: '/bin/sh',
    args: [scriptPath, String(parentPid), plan.kind, plan.assetPath, plan.destination, plan.relaunch, logPath, plan.sha256, String(serverPid)],
    script: POSIX_UPDATE_HELPER,
  };
}

export async function spawnUpdateHelper(plan: UpdatePlan, parentPid: number, logPath: string, serverPid = 0): Promise<ChildProcess> {
  await mkdir(dirname(logPath), { recursive: true });
  const workDir = await mkdtemp(join(tmpdir(), 'hud-update-helper-'));
  const scriptPath = join(workDir, plan.kind === 'nsis' ? 'apply.ps1' : 'apply.sh');
  const spec = helperLaunchSpec(plan, parentPid, logPath, scriptPath, serverPid);
  await writeFile(scriptPath, spec.script, { mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => { void rm(workDir, { recursive: true, force: true }); reject(error); });
    child.once('spawn', () => { child.unref(); resolve(child); });
  });
}

async function discard(asset: VerifiedAsset | null): Promise<void> {
  if (!asset || !basename(asset.directory).startsWith('hud-update-')) return;
  await rm(asset.directory, { recursive: true, force: true }).catch(() => {});
}

function assertUpgrade(current: string, latest: string): void {
  let order: number;
  try { order = compareVersions(latest, current); } catch {
    throw new Error('Check for a newer release with a matching installer first.');
  }
  if (order <= 0) throw new Error('Refusing to install a release that is not newer than this app.');
}

/** While this is true, heal and connect must not start the old server. */
export function rejectServerRestartDuringUpdate(updating: boolean): void {
  if (updating) throw new Error('HUD is installing an update and will not restart the old server.');
}

/**
 * Spawn the helper, stop the backend, then quit. A failed stop kills the helper
 * so it cannot replace the app under a server that is still running.
 */
export async function runVerifiedUpdateHandoff(options: {
  spawnHelper: () => Promise<ChildProcess>;
  stopBackend: () => Promise<void>;
  quit: () => void;
}): Promise<void> {
  const child = await options.spawnHelper();
  try {
    await options.stopBackend();
  } catch (error) {
    try { if (!child.killed) child.kill(); } catch { /* the helper already exited */ }
    throw error;
  }
  options.quit();
}

/**
 * Download and verify, then apply only when confirm returns true.
 * Checking for updates never calls this. A declined prompt deletes the download.
 */
export async function installApprovedUpdate(options: {
  packaged: boolean;
  update: ApprovedUpdate;
  target: PackagedTarget;
  directory: string;
  confirm: (summary: { version: string; name: string; sha256: string; path: string }) => Promise<boolean> | boolean;
  apply: (plan: UpdatePlan) => Promise<void>;
  fetcher?: typeof fetch;
  maxBytes?: number;
}): Promise<'started' | 'cancelled'> {
  if (!options.packaged) throw new Error('In-app update is only available in the packaged app.');
  if (options.update.status !== 'available' || !options.update.downloadUrl || !options.update.downloadName || !options.update.latestVersion) {
    throw new Error('Check for a newer release with a matching installer first.');
  }
  assertUpgrade(options.update.currentVersion, options.update.latestVersion);
  // Refuse an unpackaged or unwritable install before downloading anything.
  await assertInstalledTarget(planPackagedUpdate(options.target, {
    name: options.update.downloadName,
    path: join(options.directory, options.update.downloadName),
    version: options.update.latestVersion,
    sha256: '0'.repeat(64),
  }));
  let asset: VerifiedAsset | null = null;
  let started = false;
  try {
    asset = await downloadVerifiedAsset({
      downloadUrl: options.update.downloadUrl,
      downloadName: options.update.downloadName,
      version: options.update.latestVersion,
      currentVersion: options.update.currentVersion,
      directory: options.directory,
      fetcher: options.fetcher,
      maxBytes: options.maxBytes,
    });
    const plan = planPackagedUpdate(options.target, asset);
    await assertInstalledTarget(plan);
    if (await options.confirm({ version: asset.version, name: asset.name, sha256: asset.sha256, path: asset.path }) !== true) return 'cancelled';
    const maxBytes = options.maxBytes ?? MAX_RELEASE_ASSET_BYTES;
    const again = await hashFile(asset.path, maxBytes);
    if (!hashesEqual(again, asset.sha256) || !hashesEqual(again, plan.sha256)) {
      throw new Error('The installer changed after it was checked. It was deleted and will not be installed.');
    }
    await options.apply(plan);
    started = true;
    return 'started';
  } finally {
    if (!started) await discard(asset);
  }
}
