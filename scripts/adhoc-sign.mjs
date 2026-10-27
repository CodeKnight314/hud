// electron-builder afterPack: give an unsigned macOS build a real ad-hoc signature.
// Without one the binaries keep Electron's linker-only signature and macOS reports the
// downloaded app as "damaged" instead of the usual unidentified-developer prompt.
// A Developer ID build skips this; electron-builder signs after afterPack.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

function configured(env, name) {
  return typeof env[name] === 'string' && env[name].trim() !== '';
}

export function shouldAdhocSign(env, platformName) {
  if (platformName !== 'darwin') return false;
  if (env.HUD_SIGNING_MODE === 'signed') return false;
  if (configured(env, 'CSC_LINK') || configured(env, 'CSC_NAME')) return false;
  return true;
}

export default async function adhocSign(context) {
  if (!shouldAdhocSign(process.env, context.electronPlatformName)) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}
