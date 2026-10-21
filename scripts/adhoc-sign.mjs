// electron-builder afterPack: give an unsigned macOS build a real ad-hoc signature.
// Without one the binaries keep Electron's linker-only signature and macOS reports the
// downloaded app as "damaged" instead of the usual unidentified-developer prompt.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A real Developer ID identity (or electron-builder's own signing) takes precedence.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}
