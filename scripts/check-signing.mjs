// Signing plan: complete credentials sign, partial credentials fail, and no credentials stay unsigned.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldAdhocSign } from './adhoc-sign.mjs';
import notarizeDmgs from './notarize-dmg.mjs';
import {
  MAC_SIGNING_SECRETS,
  SIGNING_SECRETS,
  WIN_SIGNING_SECRETS,
  applySigningPlan,
  macAppAcceptance,
  macDmgAcceptance,
  macStapleAcceptance,
  notarizeOptions,
  planSigning,
  resolveAppleApiKey,
  windowsAcceptance,
} from './signing.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${msg}`);
};

const pem = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n';
const secret = 'super-secret-value';
const apiEnv = {
  CSC_LINK: 'Y2VydA==',
  CSC_KEY_PASSWORD: secret,
  APPLE_API_KEY: Buffer.from(pem).toString('base64'),
  APPLE_API_KEY_ID: 'KEYID12345',
  APPLE_API_ISSUER: 'issuer-id',
};
const appleIdEnv = {
  CSC_NAME: 'Example Developer (TEAMID1234)',
  APPLE_ID: 'release@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: secret,
  APPLE_TEAM_ID: 'TEAMID1234',
};

function plan(env, platform) {
  return planSigning(env, platform);
}

const unsignedMac = plan({}, 'macos');
ok(unsignedMac.mode === 'unsigned' && !unsignedMac.error, 'macOS without credentials stays unsigned');
ok(unsignedMac.set.CSC_IDENTITY_AUTO_DISCOVERY === 'false', 'unsigned macOS disables identity auto-discovery');
ok(unsignedMac.extraArgs.length === 0, 'unsigned macOS does not force signing');

const planted = plan({ CSC_KEY_PASSWORD: secret, APPLE_API_KEY_ID: 'KEYID12345' }, 'macos');
ok(planted.error && !planted.error.includes(secret), 'partial macOS credentials fail without echoing secrets');
ok(planted.error.includes('CSC_LINK') && planted.error.includes('APPLE_API_KEY'), 'partial macOS error names the missing variables');

const api = plan({ ...apiEnv, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, 'macos');
ok(api.mode === 'signed' && api.notarization === 'api-key' && !api.error, 'complete API-key credentials sign and notarize');
ok(api.unset.includes('CSC_IDENTITY_AUTO_DISCOVERY'), 'CSC_LINK signing does not keep auto-discovery disabled');
ok(api.unset.includes('APPLE_ID') && api.extraArgs.includes('--config.mac.forceCodeSigning=true'), 'API-key plan forces Developer ID signing');
ok(!api.summary.includes(secret) && !api.summary.includes(apiEnv.APPLE_API_KEY), 'signing summary does not include credential values');

const both = plan({ ...apiEnv, ...appleIdEnv }, 'macos');
ok(both.notarization === 'api-key' && both.unset.includes('APPLE_APP_SPECIFIC_PASSWORD'), 'API key wins when both notarization methods are complete');

const appleId = plan(appleIdEnv, 'macos');
ok(appleId.mode === 'signed' && appleId.notarization === 'apple-id', 'Apple ID credentials are the alternate notarization path');
ok(appleId.unset.includes('APPLE_API_KEY'), 'Apple ID plan drops API key variables');

const keychain = plan({ CSC_LINK: 'cert', CSC_KEY_PASSWORD: secret, APPLE_KEYCHAIN_PROFILE: 'notary' }, 'macos');
ok(keychain.notarization === 'keychain-profile', 'keychain profile is accepted when no other notarization secret is set');

const win = plan({ WIN_CSC_LINK: 'cert', WIN_CSC_KEY_PASSWORD: secret, CSC_LINK: 'mac-cert' }, 'windows');
ok(win.mode === 'signed' && win.unset.includes('CSC_LINK') && win.extraArgs.includes('--config.win.forceCodeSigning=true'), 'Windows uses WIN_CSC_LINK and ignores the macOS certificate');
const partialWin = plan({ WIN_CSC_LINK: secret }, 'windows');
ok(partialWin.error && !partialWin.error.includes(secret) && partialWin.error.includes('WIN_CSC_KEY_PASSWORD'), 'partial Windows credentials fail without echoing the certificate');
ok(plan({}, 'windows').mode === 'unsigned', 'Windows without credentials stays unsigned');

const linux = plan({ ...apiEnv, WIN_CSC_LINK: 'cert', WIN_CSC_KEY_PASSWORD: secret }, 'linux');
ok(linux.mode === 'unsigned' && linux.unset.includes('CSC_LINK') && linux.unset.includes('WIN_CSC_LINK'), 'Linux stays unsigned and drops signing credentials');
ok(plan({}, 'freebsd').error, 'unknown platforms are rejected');

const dir = mkdtempSync(join(tmpdir(), 'hud-signing-'));
try {
  const keyPath = join(dir, 'AuthKey.p8');
  const applied = { ...apiEnv };
  applySigningPlan(applied, api, keyPath);
  ok(applied.APPLE_API_KEY === keyPath, 'API key materializes to a file path for notarytool');
  ok(readFileSync(keyPath, 'utf8').includes('BEGIN PRIVATE KEY'), 'materialized API key is the PEM');
  ok((statSync(keyPath).mode & 0o777) === 0o600, 'materialized API key is readable only by the owner');
  ok(!('CSC_IDENTITY_AUTO_DISCOVERY' in applied) && applied.HUD_SIGNING_MODE === 'signed', 'applied macOS plan enables discovery and records signed mode');

  const existing = join(dir, 'existing.p8');
  writeFileSync(existing, pem);
  ok(resolveAppleApiKey(existing, keyPath) === existing, 'an existing .p8 path is kept');
  ok(resolveAppleApiKey(pem, keyPath) === keyPath, 'PEM text is written to the destination');
  let rejected = false;
  try { resolveAppleApiKey('not-a-key', join(dir, 'nope.p8')); } catch { rejected = true; }
  ok(rejected, 'a value that is not a path, PEM or base64 PEM is rejected');

  const options = notarizeOptions(applied, '/tmp/hud.dmg');
  ok(options?.appleApiKey === keyPath && options.appleApiKeyId === 'KEYID12345' && !options.appleId, 'notarize options use the API key file');
  ok(notarizeOptions({ APPLE_API_KEY_ID: 'only-one' }, '/tmp/hud.dmg') === null, 'incomplete notarize options are not sent');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

ok(macAppAcceptance(0, 'Authority=Developer ID Application: Example (TEAM)\n', 'signed') === null, 'Developer ID app signature is accepted');
ok(macAppAcceptance(0, 'Signature=adhoc\nflags=0x2(adhoc)\n', 'signed'), 'ad-hoc signature is rejected for a signed build');
ok(macAppAcceptance(0, 'Signature=adhoc\n', 'unsigned') === null, 'ad-hoc signature is accepted for an unsigned build');
ok(macAppAcceptance(0, 'Authority=Developer ID Application: Example\n', 'unsigned'), 'Developer ID is rejected for an unsigned build');
ok(macDmgAcceptance(0, 'Authority=Developer ID Application: Example\n', 'signed') === null, 'Developer ID DMG is accepted');
ok(macDmgAcceptance(1, 'code object is not signed at all', 'unsigned') === null, 'unsigned DMG may be unsigned');
ok(macStapleAcceptance(1, 'signed') && macStapleAcceptance(0, 'unsigned') === null, 'stapling is required only for signed macOS builds');
ok(windowsAcceptance('Valid', 'signed') === null && windowsAcceptance('NotSigned', 'unsigned') === null, 'Authenticode Valid and NotSigned match their modes');
ok(windowsAcceptance('NotSigned', 'signed') && windowsAcceptance('Valid', 'unsigned'), 'Authenticode mismatches fail');

ok(shouldAdhocSign({}, 'darwin') === true, 'unsigned macOS builds are ad-hoc signed');
ok(shouldAdhocSign({ CSC_LINK: 'cert' }, 'darwin') === false, 'CSC_LINK skips ad-hoc signing');
ok(shouldAdhocSign({ CSC_LINK: '   ' }, 'darwin') === true, 'blank CSC_LINK still ad-hoc signs');
ok(shouldAdhocSign({ HUD_SIGNING_MODE: 'signed' }, 'darwin') === false, 'a signed plan skips ad-hoc signing');
ok(shouldAdhocSign({}, 'win32') === false, 'Windows builds are not ad-hoc signed');

const savedMode = process.env.HUD_SIGNING_MODE;
delete process.env.HUD_SIGNING_MODE;
const skipped = await notarizeDmgs({ artifactPaths: ['/tmp/hud.dmg', '/tmp/hud.AppImage'] });
ok(Array.isArray(skipped) && skipped.length === 0, 'DMG notarization is skipped without credentials');
process.env.HUD_SIGNING_MODE = 'signed';
let missingTicket = false;
try { await notarizeDmgs({ artifactPaths: ['/tmp/hud.dmg'] }); } catch { missingTicket = true; }
ok(missingTicket, 'a signed macOS build fails when the DMG cannot be notarized');
if (savedMode === undefined) delete process.env.HUD_SIGNING_MODE;
else process.env.HUD_SIGNING_MODE = savedMode;

const workflow = readFileSync(join(root, '.github/workflows/build.yml'), 'utf8');
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
const entitlements = readFileSync(join(root, 'build/entitlements.mac.plist'), 'utf8');
for (const name of SIGNING_SECRETS) {
  ok(workflow.includes(`secrets.${name}`), `build workflow passes secrets.${name}`);
  ok(agents.includes(name), `AGENTS.md documents ${name}`);
}
ok(workflow.includes('scripts/signing.mjs prepare'), 'build workflow prepares signing before electron-builder');
ok(workflow.includes('scripts/signing.mjs verify'), 'build workflow verifies the signature');
ok(!workflow.includes('CSC_IDENTITY_AUTO_DISCOVERY'), 'auto-discovery is decided by the signing plan');
ok(builder.includes('hardenedRuntime: true') && builder.includes('notarize: true'), 'macOS signing enables hardened runtime and notarization');
ok(builder.includes('build/entitlements.mac.plist') && builder.includes('build/entitlements.mac.inherit.plist'), 'macOS signing points at the entitlements');
ok(builder.includes('sign: true') && builder.includes('scripts/notarize-dmg.mjs'), 'DMGs are signed and notarized');
ok(builder.includes('sha256') && builder.includes('rfc3161TimeStampServer'), 'Windows signing is SHA-256 with an RFC3161 timestamp');
ok(entitlements.includes('com.apple.security.cs.allow-jit'), 'entitlements allow Electron JIT');
ok(MAC_SIGNING_SECRETS.length === 8 && WIN_SIGNING_SECRETS.length === 2, 'secret lists stay the documented sets');

if (failures) {
  console.error(`FAIL ${failures} signing check(s)`);
  process.exit(1);
}
console.log('PASS signing: credential plan, notarization, ad-hoc skip and workflow wiring');
