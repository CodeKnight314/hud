// electron-builder notarizes the .app during signing. Gatekeeper also checks the
// downloaded DMG, so notarize that outer container once it has been Developer ID signed.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notarizeOptions } from './signing.mjs';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'electron-builder', 'package.json'));

export default async function notarizeDmgs(result) {
  const dmgs = (result?.artifactPaths ?? []).filter((file) => file.endsWith('.dmg'));
  if (dmgs.length === 0) return [];
  const options = notarizeOptions(process.env, dmgs[0]);
  if (!options) {
    if (process.env.HUD_SIGNING_MODE === 'signed') {
      throw new Error('DMG notarization credentials are missing after a signed macOS build');
    }
    console.log('signing: skipping DMG notarization');
    return [];
  }
  const { notarize } = require('@electron/notarize');
  for (const dmg of dmgs) {
    console.log(`signing: notarizing DMG ${dmg}`);
    await notarize(notarizeOptions(process.env, dmg));
  }
  return [];
}
