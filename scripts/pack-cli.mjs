// Builds the curl-install release asset: one tarball holding the bundled CLI beside the files it serves.
// Layout inside hud-<version>.tar.gz is flat, so the installer can extract it straight into app/.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-cli');
const STAGE = join(OUT, 'stage');

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json version is not X.Y.Z');

const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) throw new Error('esbuild bundling failed');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

/** everything the installed CLI reads from its own tree — see assets.ts /docs.ts */
for (const entry of ['bundle/hud.mjs', 'web', 'views', 'probes', 'GUIDE.md', 'QUICKSTART.md', 'STYLE.md', 'PLAYBOOKS.md', 'PRODUCT.md', 'package.json']) {
  const from = join(ROOT, entry);
  if (!existsSync(from)) throw new Error(`missing ${entry}`);
  cpSync(from, join(STAGE, entry === 'bundle/hud.mjs' ? 'hud.mjs' : entry), { recursive: true });
}

const tarball = join(OUT, `hud-${version}.tar.gz`);
const tar = spawnSync('tar', ['-czf', 'bundle.tar.gz', '.'], { cwd: STAGE, encoding: 'utf8' });
if (tar.error) throw new Error(`could not run tar: ${tar.error.message}`);
if (tar.status !== 0) throw new Error(`tar failed: ${(tar.stderr || '').trim()}`);
renameSync(join(STAGE, 'bundle.tar.gz'), tarball);

const name = `hud-${version}.tar.gz`;
const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
writeFileSync(join(OUT, 'SHA256SUMS'), `${digest}  ${name}\n`);

// The installer scripts ride along so a release carries everything curl needs.
for (const script of ['install.sh', 'install.ps1']) {
  const from = join(ROOT, 'scripts', script);
  if (existsSync(from)) writeFileSync(join(OUT, script), readFileSync(join(from), 'utf8'));
}

rmSync(STAGE, { recursive: true, force: true });
console.log(`built dist-cli/${name} (sha256 ${digest})`);
