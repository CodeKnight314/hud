// AppImage command integration: the shim execs the stable .AppImage file, and a bootstrap
// outside the mount finds resources/hud/bin/hud.mjs on each launch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'hud-cliinstall-'));
const dataDir = join(root, 'data');
const binDir = join(root, 'bin');
const unix = process.platform !== 'win32';
const saved = {
  APPIMAGE: process.env.APPIMAGE,
  APPDIR: process.env.APPDIR,
  ARGV0: process.env.ARGV0,
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
  HUD_CLI_ENTRY: process.env.HUD_CLI_ENTRY,
  HUD_SHIM: process.env.HUD_SHIM,
};

process.env.HUD_SCRATCH = '1';
process.env.HUD_DATA = dataDir;
process.env.HUD_PORT = '7399';
process.env.HUD_BIN_DIR = binDir;
delete process.env.APPIMAGE;
delete process.env.APPDIR;
delete process.env.HUD_SHIM;

const cli = await import('../src/cliinstall.ts');
const appimage = await import('../src/appimage-cli.ts');
const runtime = await import('../src/electron-runtime.ts');

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeCli(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function mountLayout(dir: string, source: string): string {
  const entry = join(dir, 'resources', 'hud', 'bin', 'hud.mjs');
  writeCli(entry, source);
  return entry;
}

function writeFakeAppImage(path: string, mount: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexport APPDIR=${shQuote(mount)}\nexec ${shQuote(process.execPath)} "$@"\n`);
  chmodSync(path, 0o755);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(command, args, { encoding: 'utf8', env, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
}

try {
  const guide = readFileSync(join(repo, 'GUIDE.md'), 'utf8');
  const readme = readFileSync(join(repo, 'README.md'), 'utf8');
  assert.equal(guide.includes('AppImage command integration is unsupported'), false);
  assert.equal(guide.includes('AppImage builds do not support'), false);
  assert.match(guide, /AppImage shim stores the `\.AppImage` path/);
  assert.match(readme, /Settings → Connections → \*\*Install command\*\*/);
  assert.match(readme, /If you move an\nAppImage, run that action again/);
  assert.equal(readme.split('\n').length <= 100, true);

  const execPath = join('/opt', 'mount', 'hud');
  const resourcesPath = join('/opt', 'mount', 'resources');
  const appDir = join('/opt', 'fresh');
  const fromExec = join(dirname(execPath), 'resources', 'hud', 'bin', 'hud.mjs');
  const fromResources = join(resourcesPath, 'hud', 'bin', 'hud.mjs');
  const fromAppDir = join(appDir, 'resources', 'hud', 'bin', 'hud.mjs');
  assert.equal(appimage.resolveAppImageCliEntry({ execPath, resourcesPath, appDir, exists: (path) => path === fromExec }), fromExec);
  assert.equal(appimage.resolveAppImageCliEntry({ execPath, resourcesPath, appDir, exists: (path) => path === fromResources }), fromResources);
  assert.equal(appimage.resolveAppImageCliEntry({ execPath, appDir, exists: (path) => path === fromAppDir }), fromAppDir);
  assert.equal(appimage.resolveAppImageCliEntry({ execPath, cliEntry: join('/asked', 'hud.mjs'), appDir, exists: (path) => path === fromAppDir }), undefined);
  assert.match(appimage.appImageBootstrapSource(), /HUD_CLI_ENTRY/);
  assert.match(appimage.appImageBootstrapSource(), /join\(dirname\(process\.execPath\), 'resources', 'hud', 'bin', 'hud\.mjs'\)/);
  assert.match(appimage.appImageBootstrapSource(), /join\(process\.resourcesPath, 'hud', 'bin', 'hud\.mjs'\)/);
  assert.match(appimage.appImageBootstrapSource(), /join\(process\.env\.APPDIR, 'resources', 'hud', 'bin', 'hud\.mjs'\)/);

  assert.equal(cli.installCli(), 'not running from the app — from a source checkout just use node bin/hud.js');
  const plainEntry = join(root, 'plain-cli.mjs');
  writeCli(plainEntry, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  process.env.HUD_CLI_ENTRY = plainEntry;
  const foreign = join(binDir, process.platform === 'win32' ? 'hud.cmd' : 'hud');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(foreign, 'foreign command\n');
  assert.match(cli.installManagedCli(), /not installing: .* was not created by hud/);
  assert.equal(readFileSync(foreign, 'utf8'), 'foreign command\n');
  rmSync(foreign);

  const installed = cli.installManagedCli();
  assert.match(installed, new RegExp(`installed ${foreign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const info = cli.managedCommandStatus();
  assert.equal(info.ready, true, info.detail);
  assert.equal(info.appImage, undefined);
  assert.equal(cli.cliInfo().ready, false, 'a source checkout never reports the packaged command as ready');
  const beforeRefresh = readFileSync(foreign, 'utf8');
  writeFileSync(foreign, beforeRefresh.replace(plainEntry, `${plainEntry}.stale`));
  cli.refreshInstalledCli();
  assert.equal(readFileSync(foreign, 'utf8').includes(`${plainEntry}.stale`), true, 'source mode does not refresh a shim');
  assert.match(cli.installManagedCli(), /^installed /);
  assert.equal(cli.managedCommandStatus().ready, true);

  if (unix) {
    const args = ['space value', `a'"$&literal`];
    assert.deepEqual(JSON.parse(run(foreign, args)), args, 'shim treats entry paths and arguments literally');
    assert.equal((lstatSync(foreign).mode & 0o111) !== 0, true);

    const mount = join(root, 'mount with space');
    const entry = mountLayout(mount, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const image = join(root, "images", "hud's app.AppImage");
    writeFakeAppImage(image, mount);
    const link = join(root, 'images', 'hud-link.AppImage');
    symlinkSync(image, link);
    delete process.env.HUD_CLI_ENTRY;
    process.env.APPIMAGE = link;
    process.env.APPDIR = mount;
    process.env.ARGV0 = 'parent-argv0';
    process.env.LD_LIBRARY_PATH = join(mount, 'usr', 'lib');

    const switched = cli.installManagedCli();
    assert.match(switched, /re-run "Install hud command" after moving the AppImage/);
    const shimText = readFileSync(foreign, 'utf8');
    assert.equal(shimText.includes(`hud'\\''s app.AppImage`), true, 'shim stores the real AppImage path, not the symlink or the mount');
    assert.equal(shimText.includes('hud-link.AppImage'), false);
    assert.equal(readFileSync(foreign, 'utf8').includes(entry), false, 'shim does not bake the mount-local CLI path');
    const ready = cli.managedCommandStatus();
    assert.equal(ready.ready, true, ready.detail);
    assert.equal(ready.appImage, true);
    assert.match(cli.cliStatus(), new RegExp(`app: {3}${image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const childEnv = { ...process.env };
    delete childEnv.HUD_CLI_ENTRY;
    delete childEnv.APPDIR;
    assert.deepEqual(JSON.parse(run(foreign, args, childEnv)), args, 'AppImage shim forwards arguments through the fake runtime');

    const launch = appimage.appImageCliInvocation();
    assert.ok(launch);
    assert.equal(launch.cmd, image);
    assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(launch.env.APPDIR, undefined);
    assert.equal(launch.env.ARGV0, undefined);
    assert.equal(launch.env.LD_LIBRARY_PATH, undefined);
    assert.equal(process.env.APPDIR, mount, 'scrubbing the child env leaves the parent mount in place');
    assert.deepEqual(JSON.parse(run(launch.cmd, [...launch.prefix, 'serve'], launch.env)), ['serve']);
    const sourceLaunch = runtime.cliInvocation();
    assert.equal(sourceLaunch.cmd, process.execPath, 'a source process does not re-exec APPIMAGE');

    const gui = runtime.guiLaunchEnv();
    assert.equal(gui.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(gui.APPDIR, undefined);
    assert.equal(gui.LD_LIBRARY_PATH, undefined);
    assert.equal(process.env.LD_LIBRARY_PATH, join(mount, 'usr', 'lib'));

    writeFileSync(appimage.appImageBootstrapPath(), 'stale bootstrap\n');
    assert.equal(cli.managedCommandStatus().ready, false);
    assert.match(cli.installManagedCli(), /^installed /);
    assert.equal(readFileSync(appimage.appImageBootstrapPath(), 'utf8'), appimage.appImageBootstrapSource());
    assert.equal(cli.managedCommandStatus().ready, true);

    const override = join(root, 'override.mjs');
    writeCli(override, 'console.log("override:" + JSON.stringify(process.argv.slice(2)));\n');
    const overrideEnv = { ...childEnv, HUD_CLI_ENTRY: override, APPDIR: mount };
    assert.equal(run(foreign, ['mcp'], overrideEnv), 'override:["mcp"]\n');

    const broken = join(root, 'broken-mount');
    mkdirSync(broken, { recursive: true });
    process.env.APPDIR = broken;
    delete process.env.HUD_CLI_ENTRY;
    const preserved = readFileSync(foreign, 'utf8');
    assert.match(cli.installManagedCli(), /not installing: the packaged CLI was not found/);
    assert.equal(readFileSync(foreign, 'utf8'), preserved, 'a mount without a CLI does not replace the shim');
    assert.equal(cli.managedCommandStatus().ready, false);

    process.env.APPIMAGE = `bad\npath`;
    assert.match(cli.installManagedCli(), /not installing: AppImage path contains a newline/);
    chmodSync(image, 0o644);
    process.env.APPIMAGE = image;
    process.env.APPDIR = mount;
    assert.match(cli.installManagedCli(), /not installing: AppImage is missing or not executable/);
    chmodSync(image, 0o755);

    delete process.env.HUD_CLI_ENTRY;
    delete process.env.APPDIR;
    process.env.APPIMAGE = image;
    try {
      run(process.execPath, [appimage.ensureAppImageBootstrap()], { ...process.env, HUD_CLI_ENTRY: '', APPDIR: '' });
      assert.fail('missing CLI entry should fail');
    } catch (error) {
      const failed = error as NodeJS.ErrnoException & { status?: number; stderr?: string };
      assert.equal(failed.status, 1);
      assert.match(String(failed.stderr), /could not find the CLI inside the AppImage/);
    }
  }

  assert.match(cli.uninstallCli(), /^removed /);
  assert.equal(cli.managedCommandStatus().installed, false);
  console.log('PASS cliinstall');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
