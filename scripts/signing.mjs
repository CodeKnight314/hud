#!/usr/bin/env node
// Release signing plan. Credentials stay in the environment (GitHub Actions secrets
// locally or in CI). Nothing here reads a certificate from the repo.
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const MAC_SIGNING_SECRETS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];
export const WIN_SIGNING_SECRETS = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
export const SIGNING_SECRETS = [...MAC_SIGNING_SECRETS, ...WIN_SIGNING_SECRETS];

const API_KEY = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const APPLE_ID = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const OPTIONAL = ['CSC_NAME', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'];
const ALL_CREDENTIALS = [...SIGNING_SECRETS, ...OPTIONAL];

function configured(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== '';
}

function missing(env, names) {
  return names.filter((name) => !configured(env, name));
}

function blankPlan(platform) {
  return {
    platform,
    mode: null,
    notarization: null,
    unset: [],
    set: {},
    extraArgs: [],
    rewriteAppleApiKey: false,
    error: null,
    summary: '',
  };
}

function unsignedPlan(platform) {
  return {
    ...blankPlan(platform),
    mode: 'unsigned',
    unset: [...ALL_CREDENTIALS],
    set: { CSC_IDENTITY_AUTO_DISCOVERY: 'false', HUD_SIGNING_MODE: 'unsigned' },
    // electron-builder.yml sets mac.notarize: true, which notarizes when Apple
    // credentials are present. An unsigned job must turn that off explicitly.
    extraArgs: platform === 'macos' ? ['--config.mac.notarize=false'] : [],
    summary: `${platform} unsigned`,
  };
}

function signedPlan(platform, notarization, extraArgs, rewriteAppleApiKey) {
  return {
    ...blankPlan(platform),
    mode: 'signed',
    notarization,
    // CSC_IDENTITY_AUTO_DISCOVERY=false makes electron-builder ignore a CSC_LINK
    // identity unless CSC_NAME is also set. Drop it and let the imported keychain match.
    unset: ['CSC_IDENTITY_AUTO_DISCOVERY'],
    set: { HUD_SIGNING_MODE: 'signed' },
    extraArgs,
    rewriteAppleApiKey,
    summary: `${platform} signed${notarization ? ` (${notarization})` : ''}`,
  };
}

function fail(platform, error) {
  return { ...blankPlan(platform), error };
}

/**
 * Decide how a native build should sign. `env` is only inspected for presence;
 * secret values are never copied into `summary` or `error`.
 */
export function planSigning(env, platform) {
  if (platform === 'linux') return unsignedPlan(platform);
  if (platform === 'windows') return planWindows(env);
  if (platform === 'macos') return planMac(env);
  return fail(platform, `unknown signing platform: ${platform}`);
}

function planWindows(env) {
  const any = WIN_SIGNING_SECRETS.some((name) => configured(env, name));
  if (!any) return unsignedPlan('windows');
  const absent = missing(env, WIN_SIGNING_SECRETS);
  if (absent.length) {
    return fail('windows', `Windows Authenticode signing is incomplete. Set ${WIN_SIGNING_SECRETS.join(' and ')}. Missing: ${absent.join(', ')}.`);
  }
  const plan = signedPlan('windows', null, ['--config.win.forceCodeSigning=true'], false);
  plan.unset.push(...MAC_SIGNING_SECRETS, 'CSC_NAME', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE');
  return plan;
}

function planMac(env) {
  const watched = [...MAC_SIGNING_SECRETS, ...OPTIONAL];
  if (!watched.some((name) => configured(env, name))) return unsignedPlan('macos');

  const errors = [];
  const hasLink = configured(env, 'CSC_LINK');
  const hasPassword = configured(env, 'CSC_KEY_PASSWORD');
  const hasName = configured(env, 'CSC_NAME');
  if (hasLink && !hasPassword) errors.push('CSC_LINK is set but CSC_KEY_PASSWORD is missing.');
  if (!hasLink && !hasName) errors.push('Set CSC_LINK and CSC_KEY_PASSWORD (Developer ID Application .p12), or CSC_NAME for a keychain identity.');

  const apiMissing = missing(env, API_KEY);
  const idMissing = missing(env, APPLE_ID);
  const api = apiMissing.length === 0;
  const appleId = idMissing.length === 0;
  const apiPartial = !api && apiMissing.length < API_KEY.length;
  const idPartial = !appleId && idMissing.length < APPLE_ID.length;
  if (apiPartial) errors.push(`App Store Connect API notarization is incomplete. Set ${API_KEY.join(', ')}. Missing: ${apiMissing.join(', ')}.`);
  if (idPartial) errors.push(`Apple ID notarization is incomplete. Set ${APPLE_ID.join(', ')}. Missing: ${idMissing.join(', ')}.`);

  let notarization = null;
  if (api) notarization = 'api-key';
  else if (appleId) notarization = 'apple-id';
  else if (!apiPartial && !idPartial && configured(env, 'APPLE_KEYCHAIN_PROFILE')) notarization = 'keychain-profile';
  else if (!apiPartial && !idPartial) {
    errors.push(`macOS notarization credentials are missing. Set ${API_KEY.join(', ')}, or ${APPLE_ID.join(', ')}.`);
  }
  if (errors.length) return fail('macos', errors.join(' '));

  const plan = signedPlan('macos', notarization, ['--config.mac.forceCodeSigning=true'], notarization === 'api-key');
  plan.unset.push('WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD');
  if (notarization === 'api-key') {
    // electron-builder prefers Apple ID whenever either of those two is set.
    plan.unset.push('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE');
  } else if (notarization === 'apple-id') {
    plan.unset.push(...API_KEY, 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE');
  } else {
    plan.unset.push(...API_KEY, 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD');
  }
  return plan;
}

// Create the file at mode 0600 before any key bytes are written. open(2) masks
// the mode with umask, so fchmod on the still-empty fd removes that race.
function writeRestricted(path, contents) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const data = Buffer.from(contents);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < data.length) {
      const wrote = writeSync(fd, data, offset, data.length - offset);
      if (wrote <= 0) throw new Error('failed to write the Apple API key');
      offset += wrote;
    }
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function resolveAppleApiKey(raw, destination, writeFile = writeRestricted) {
  const value = raw.trim();
  if (value.includes('BEGIN PRIVATE KEY')) {
    writeFile(destination, value.endsWith('\n') ? value : `${value}\n`);
    return destination;
  }
  if (existsSync(value)) return value;
  const compact = value.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]+=*$/.test(compact) && compact.length >= 32) {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    if (decoded.includes('BEGIN PRIVATE KEY')) {
      writeFile(destination, decoded.endsWith('\n') ? decoded : `${decoded}\n`);
      return destination;
    }
  }
  throw new Error('APPLE_API_KEY must be a path to the .p8 file, the PEM text, or base64 of that PEM. electron-builder passes it to notarytool --key, which requires a file path.');
}

export function notarizeOptions(env, appPath) {
  const api = API_KEY.every((name) => configured(env, name));
  const appleIdStarted = configured(env, 'APPLE_ID') || configured(env, 'APPLE_APP_SPECIFIC_PASSWORD');
  if (api && !appleIdStarted) {
    return {
      appPath,
      appleApiKey: env.APPLE_API_KEY.trim(),
      appleApiKeyId: env.APPLE_API_KEY_ID.trim(),
      appleApiIssuer: env.APPLE_API_ISSUER.trim(),
    };
  }
  if (APPLE_ID.every((name) => configured(env, name)) && !API_KEY.some((name) => configured(env, name))) {
    return {
      appPath,
      appleId: env.APPLE_ID.trim(),
      appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD.trim(),
      teamId: env.APPLE_TEAM_ID.trim(),
    };
  }
  if (configured(env, 'APPLE_KEYCHAIN_PROFILE') && !api && !appleIdStarted) {
    const options = { appPath, keychainProfile: env.APPLE_KEYCHAIN_PROFILE.trim() };
    if (configured(env, 'APPLE_KEYCHAIN')) options.keychain = env.APPLE_KEYCHAIN.trim();
    return options;
  }
  return null;
}

export function applySigningPlan(env, plan) {
  if (plan.error) throw new Error(plan.error);
  for (const name of plan.unset) delete env[name];
  Object.assign(env, plan.set);
  if (!plan.rewriteAppleApiKey) return null;
  const raw = env.APPLE_API_KEY;
  const value = raw.trim();
  if (!value.includes('BEGIN PRIVATE KEY') && existsSync(value)) {
    env.APPLE_API_KEY = value;
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), 'hud-apple-api-key-'));
  const keyPath = join(dir, 'AuthKey.p8');
  try {
    chmodSync(dir, 0o700);
    env.APPLE_API_KEY = resolveAppleApiKey(raw, keyPath);
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function discardPrivateKey(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

export function macAppAcceptance(verifyStatus, displayText, mode) {
  if (verifyStatus !== 0) return 'codesign --verify --deep --strict failed for the app';
  const developerId = displayText.includes('Authority=Developer ID Application:');
  const adhoc = /Signature=adhoc/.test(displayText) || /flags=0x2\(adhoc\)/.test(displayText);
  if (mode === 'signed') {
    if (!developerId) return 'app is not signed by a Developer ID Application identity';
    if (adhoc) return 'app is ad-hoc signed';
    return null;
  }
  if (developerId) return 'unsigned macOS build is Developer ID signed';
  if (!adhoc) return 'unsigned macOS app is not ad-hoc signed';
  return null;
}

export function macDmgAcceptance(displayStatus, displayText, mode) {
  const developerId = displayText.includes('Authority=Developer ID Application:');
  if (mode === 'signed') {
    if (displayStatus !== 0 || !developerId) return 'DMG is not signed by a Developer ID Application identity';
    return null;
  }
  if (developerId) return 'unsigned macOS build produced a Developer ID signed DMG';
  return null;
}

export function macStapleAcceptance(status, mode) {
  if (mode !== 'signed') return null;
  if (status !== 0) return 'notarization ticket is not stapled';
  return null;
}

export function windowsAcceptance(status, mode) {
  if (mode === 'signed') return status === 'Valid' ? null : `Authenticode status is ${status || 'missing'}, expected Valid`;
  if (status === 'NotSigned') return null;
  return `unsigned Windows build has Authenticode status ${status || 'missing'}`;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status ?? 1, text: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function collectArtifacts(dir) {
  const found = { apps: [], dmgs: [], exes: [] };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.dmg')) found.dmgs.push(path);
    if (entry.isFile() && entry.name.endsWith('.exe')) found.exes.push(path);
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith('.app')) {
      found.apps.push(path);
      continue;
    }
    for (const child of readdirSync(path, { withFileTypes: true })) {
      if (child.isDirectory() && child.name.endsWith('.app')) found.apps.push(join(path, child.name));
    }
  }
  return found;
}

export function verifySigning(platform, outputDir, mode) {
  if (mode !== 'signed' && mode !== 'unsigned') throw new Error(`signing mode must be signed or unsigned, got ${mode || 'nothing'}`);
  if (platform === 'linux') {
    if (mode !== 'unsigned') throw new Error('linux installers are not signed');
    console.log('signing: linux unsigned');
    return;
  }
  const found = collectArtifacts(resolve(outputDir));
  const problems = [];
  if (platform === 'macos') {
    if (found.apps.length === 0) problems.push('no .app in the macOS output');
    if (found.dmgs.length === 0) problems.push('no .dmg in the macOS output');
    for (const app of found.apps) {
      const verified = capture('codesign', ['--verify', '--deep', '--strict', app]);
      const display = capture('codesign', ['-dv', '--verbose=4', app]);
      const staple = mode === 'signed' ? capture('xcrun', ['stapler', 'validate', app]) : { status: 0 };
      for (const problem of [macAppAcceptance(verified.status, display.text, mode), macStapleAcceptance(staple.status, mode)]) {
        if (problem) problems.push(`${app}: ${problem}`);
      }
    }
    for (const dmg of found.dmgs) {
      const display = capture('codesign', ['-dv', '--verbose=4', dmg]);
      const staple = mode === 'signed' ? capture('xcrun', ['stapler', 'validate', dmg]) : { status: 0 };
      for (const problem of [macDmgAcceptance(display.status, display.text, mode), macStapleAcceptance(staple.status, mode)]) {
        if (problem) problems.push(`${dmg}: ${problem}`);
      }
    }
  } else if (platform === 'windows') {
    if (found.exes.length === 0) problems.push('no .exe installer in the Windows output');
    for (const exe of found.exes) {
      const status = authenticodeStatus(exe);
      const problem = windowsAcceptance(status, mode);
      if (problem) problems.push(`${exe}: ${problem}`);
    }
  } else {
    throw new Error(`unknown signing platform: ${platform}`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`signing: verified ${platform} ${mode}`);
}

function authenticodeStatus(exe) {
  const quoted = `'${exe.replaceAll("'", "''")}'`;
  const command = `$s = Get-AuthenticodeSignature -LiteralPath ${quoted}; Write-Output $s.Status`;
  const result = capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  if (result.status !== 0) throw new Error(`Get-AuthenticodeSignature failed for ${exe}`);
  return result.text.trim().split(/\s+/).pop();
}

function recordMode(mode) {
  const dir = join(root, 'dist');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'signing-mode'), `${mode}\n`);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `HUD_SIGNING_MODE=${mode}\n`);
}

function readMode(outputDir) {
  if (process.env.HUD_SIGNING_MODE === 'signed' || process.env.HUD_SIGNING_MODE === 'unsigned') return process.env.HUD_SIGNING_MODE;
  try {
    return readFileSync(join(dirname(resolve(outputDir)), 'signing-mode'), 'utf8').trim();
  } catch {
    return '';
  }
}

// npm on Windows is npm.cmd, and spawning a batch file requires a shell. Run
// Node's own npm-cli.js instead so passwords in the environment are never parsed.
export function signingExec(command, extraArgs, platformName = process.platform) {
  const argv = [...command, ...extraArgs];
  if (argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('refusing to run a signing build command with a NUL byte');
  }
  const [bin, ...args] = argv;
  if ((bin === 'npm' || bin === 'npm.cmd') && platformName === 'win32') {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return { file: process.execPath, args: [npmCli, ...args], shell: false };
  }
  if (bin === 'npm.cmd') return { file: 'npm', args, shell: false };
  return { file: bin, args, shell: false };
}

function prepare(platform, command) {
  const plan = planSigning(process.env, platform);
  let createdDir = null;
  let exitCode = 0;
  try {
    createdDir = applySigningPlan(process.env, plan);
    recordMode(plan.mode);
    console.log(`signing: ${plan.summary}`);
    if (!command) return;
    const exec = signingExec(command, plan.extraArgs);
    const status = spawnSync(exec.file, exec.args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    if (status.error) throw status.error;
    exitCode = status.status ?? 1;
  } finally {
    discardPrivateKey(createdDir);
  }
  if (exitCode !== 0) process.exit(exitCode);
}

function main(argv) {
  const [action, ...rest] = argv;
  const platformFlag = rest.indexOf('--platform');
  const platform = platformFlag === -1 ? '' : rest[platformFlag + 1];
  if (action === 'prepare') {
    const separator = rest.indexOf('--');
    const exec = rest.includes('--exec');
    const command = exec ? rest.slice(separator + 1) : null;
    if (!platform || (exec && (separator === -1 || command.length === 0))) {
      throw new Error('usage: signing.mjs prepare --platform macos|windows|linux [--exec -- command]');
    }
    prepare(platform, command);
    return;
  }
  if (action === 'verify') {
    const outputDir = rest.find((arg) => !arg.startsWith('--') && arg !== platform);
    if (!platform || !outputDir) throw new Error('usage: signing.mjs verify --platform macos|windows|linux <output-dir>');
    verifySigning(platform, outputDir, readMode(outputDir));
    return;
  }
  throw new Error('usage: signing.mjs prepare|verify ...');
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invoked) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`signing: ${error.message}`);
    process.exit(1);
  }
}
