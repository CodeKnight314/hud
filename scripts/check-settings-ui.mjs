import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const repo = resolve(import.meta.dirname, '..');
const requestedArtifacts = process.argv[2];
const fixtureRoot = mkdtempSync(join(tmpdir(), 'hud-settings-ui-'));
const artifactDir = requestedArtifacts ? resolve(requestedArtifacts) : mkdtempSync(join(tmpdir(), 'hud-settings-ui-artifacts-'));
const userData = join(fixtureRoot, 'electron-user-data');
const dataDir = join(fixtureRoot, 'hud-data');
const binDir = join(fixtureRoot, 'hud-bin');
const cliEntry = join(fixtureRoot, 'fake-hud-cli.mjs');
const clientHome = join(fixtureRoot, 'client-home');
const fakeClients = join(fixtureRoot, 'client-bin');
const sourceArgv = [join(binDir, process.platform === 'win32' ? 'hud.cmd' : 'hud'), 'mcp'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const windows = new Set();
const consoleFailures = [];
const loadFailures = [];
let settingsController;
let primaryWindow;

function clientExecutable(id) {
  return join(fakeClients, `${id}${process.platform === 'win32' ? '.cmd' : ''}`);
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, bytes);
  return bytes;
}

class CodexMock {
  calls = [];
  registration = null;

  async run(_executable, args, _env) {
    this.calls.push([...args]);
    if (args[0] === 'mcp' && args[1] === 'get' && args[2] === 'hud' && args[3] === '--json') {
      if (!this.registration) return { code: 1, stdout: '', stderr: "No MCP server named 'hud' found." };
      return { code: 0, stdout: JSON.stringify(this.registration), stderr: '' };
    }
    if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === 'hud') {
      this.registration = null;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'mcp' && args[1] === 'add' && args[2] === 'hud' && args[3] === '--') {
      const argv = args.slice(4);
      this.registration = { enabled: true, transport: { type: 'stdio', command: argv[0], args: argv.slice(1) } };
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected mock Codex command: ${args.join(' ')}`);
  }
}

async function waitFor(fn, label, timeout = 15_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) { last = error; }
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function pageEval(window, source) {
  return window.webContents.executeJavaScript(source);
}

async function click(window, selector) {
  await waitFor(() => pageEval(window, `Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`), `${selector} enabled`);
  const clicked = await pageEval(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    if (element.disabled) throw new Error('Control is disabled: ' + ${JSON.stringify(selector)});
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `clicked ${selector}`);
}

async function waitText(window, selector, text, label = `${selector} text ${text}`) {
  return waitFor(async () => {
    const value = await pageEval(window, `document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
    return value.includes(text) ? value : false;
  }, label);
}

async function connectionRows(window) {
  return pageEval(window, `Array.from(document.querySelectorAll('.connection-row'), row => ({
    name: row.querySelector('.client-name')?.textContent,
    symbol: row.querySelector('.cli-symbol')?.textContent,
    status: row.querySelector('.connection-meta span:last-child')?.textContent,
    actions: Array.from(row.querySelectorAll('button[aria-label]'), button => button.getAttribute('aria-label')),
  }))`);
}

async function waitForConnectionStatus(window, label, expected) {
  return waitFor(async () => {
    const rows = await connectionRows(window);
    const row = rows.find((item) => item.name === label);
    return row?.status === expected ? row : false;
  }, `${label} status ${expected}`);
}

async function saveScreenshot(window, name) {
  const image = await window.capturePage();
  const bytes = image.toPNG();
  assert(bytes.length > 100 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${name} is a valid PNG`);
  const path = join(artifactDir, name);
  writeFileSync(path, bytes);
  return path;
}

async function makeSettingsBundle() {
  const entry = join(fixtureRoot, 'settings-entry.mjs');
  const bundle = join(fixtureRoot, 'settings-bundle.mjs');
  const settingsPath = join(repo, 'electron', 'settings.ts');
  const connectionsPath = join(repo, 'src', 'mcpinstall.ts');
  const updatesPath = join(repo, 'src', 'updates.ts');
  writeFileSync(entry, [
    `export { desktopSettings } from ${JSON.stringify(settingsPath)};`,
    `export { ConnectionService } from ${JSON.stringify(connectionsPath)};`,
    `export { UpdateChecker, installerName } from ${JSON.stringify(updatesPath)};`,
    `export { cliInfo, refreshInstalledCli } from ${JSON.stringify(join(repo, 'src', 'cliinstall.ts'))};`,
  ].join('\n'));
  await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node23',
    external: ['electron'], outfile: bundle, sourcemap: false,
  });
  return import(pathToFileURL(bundle).href);
}

async function run() {
  mkdirSync(userData, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(clientHome, { recursive: true });
  mkdirSync(fakeClients, { recursive: true });
  mkdirSync(join(fixtureRoot, 'probes'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'views'), { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(cliEntry, '# inert fixture; the shim is verified, never executed\n');
  for (const id of ['claude', 'codex']) {
    const executable = clientExecutable(id);
    writeFileSync(executable, 'inert fixture executable\n');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
  }

  process.env.HUD_SCRATCH = '1';
  process.env.HUD_DATA = dataDir;
  process.env.HUD_PORT = '17317';
  process.env.HUD_PROBES = join(fixtureRoot, 'probes');
  process.env.HUD_VIEWS = join(fixtureRoot, 'views');
  process.env.HUD_BIN_DIR = binDir;
  process.env.HUD_SHIM = sourceArgv[0];
  process.env.HUD_SOURCE_ROOT = repo;
  process.env.HUD_CLI_ENTRY = cliEntry;
  process.env.HUD_NO_LOGIN_SHELL = '1';

  app.setPath('userData', userData);
  await app.whenReady();
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (event) => {
      const { level, message: text } = event;
      if (level === 'error' || level === 2) consoleFailures.push(String(text));
    });
    contents.on('did-fail-load', (_loadEvent, code, description, url) => loadFailures.push(`${code} ${description} ${url}`));
  });

  const { desktopSettings, ConnectionService, UpdateChecker, installerName, cliInfo, refreshInstalledCli } = await makeSettingsBundle();
  const clientEnv = { PATH: fakeClients };
  const claudeConfig = join(clientHome, '.claude.json');
  const originalClaudeBytes = writeJson(claudeConfig, {
    projects: { keep: ['unrelated', 'settings'] },
    mcpServers: {
      hud: { type: 'stdio', command: '/old/node', args: ['/old/hud.js', 'mcp'] },
      companion: { type: 'stdio', command: 'companion', args: ['server'] },
    },
  });
  const codexConfig = join(clientHome, '.codex', 'config.toml');
  mkdirSync(join(clientHome, '.codex'), { recursive: true });
  writeFileSync(codexConfig, '# isolated Codex config\n');
  const codex = new CodexMock();
  const connections = new ConnectionService({
    home: clientHome, env: clientEnv, platform: process.platform,
    argv: () => [...sourceArgv], run: codex.run.bind(codex),
  });

  let checkOnLaunch = false;
  const externalUrls = [];
  const copied = [];
  let quits = 0;
  const matchingName = installerName('0.1.2', 'darwin', 'arm64');
  assert.equal(matchingName, 'hud-0.1.2-mac-arm64.dmg', 'fixed supported fixture installer name');
  const releaseUrl = `https://github.com/CodeKnight314/hud/releases/tag/v0.1.2`;
  const downloadUrl = `https://github.com/CodeKnight314/hud/releases/download/v0.1.2/${matchingName}`;
  const updateChecker = new UpdateChecker({
    version: '0.1.1', platform: 'darwin', arch: 'arm64',
    fetcher: async () => new Response(JSON.stringify({
      draft: false, prerelease: false, tag_name: 'v0.1.2',
      assets: [{ name: matchingName, browser_download_url: downloadUrl, state: 'uploaded' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  settingsController = desktopSettings({
    version: '0.1.1', packaged: true, dataDir,
    checkOnLaunch: () => checkOnLaunch,
    setCheckOnLaunch: (enabled) => { checkOnLaunch = enabled; },
    connectionService: connections,
    updateChecker,
    openExternal: async (url) => { externalUrls.push(url); },
    copyText: (text) => { copied.push(text); },
    quitForUpdate: async () => { quits++; },
    visible: false,
  });

  primaryWindow = settingsController.show();
  windows.add(primaryWindow);
  await waitFor(async () => await pageEval(primaryWindow, `document.getElementById('load-status')?.textContent === 'Ready'`), 'Settings window readiness');
  assert.equal(await pageEval(primaryWindow, `document.querySelectorAll('.connection-row').length`), 3, 'three client rows render');
  const firstRows = await connectionRows(primaryWindow);
  assert.deepEqual(firstRows.map(({ name, symbol }) => [name, symbol]), [
    ['Claude Code', '*'], ['Codex', '>_'], ['OpenCode', '◧'],
  ], 'client labels and symbols render');
  assert.equal(firstRows.find((row) => row.name === 'Claude Code')?.status, 'Needs repair · registered');
  assert.equal(firstRows.find((row) => row.name === 'Codex')?.status, 'Not registered');
  assert.equal(firstRows.find((row) => row.name === 'OpenCode')?.status, 'Unavailable');

  await click(primaryWindow, '[aria-label="Repair Claude Code"]');
  await waitText(primaryWindow, '#action-status', 'HUD registered with Claude Code.');
  await waitForConnectionStatus(primaryWindow, 'Claude Code', 'Registered');
  const repairedClaude = JSON.parse(readFileSync(claudeConfig, 'utf8'));
  assert.deepEqual(repairedClaude.projects, { keep: ['unrelated', 'settings'] }, 'Claude repair preserves unrelated top-level configuration');
  assert.deepEqual(repairedClaude.mcpServers.companion, { type: 'stdio', command: 'companion', args: ['server'] }, 'Claude repair preserves unrelated MCP entries');
  assert.deepEqual([repairedClaude.mcpServers.hud.command, ...repairedClaude.mcpServers.hud.args], sourceArgv, 'Claude repair points to the fixture shim');
  const installedShim = join(binDir, process.platform === 'win32' ? 'hud.cmd' : 'hud');
  assert.equal(readFileSync(installedShim, 'utf8').includes('generated by the hud app'), true, 'install command writes the managed shim under fixture HUD_BIN_DIR');
  const managedBody = readFileSync(installedShim, 'utf8');
  rmSync(installedShim);
  refreshInstalledCli();
  assert.equal(cliInfo().ready, true, 'a deleted recorded shim is recreated at the same path');
  writeFileSync(installedShim, managedBody.replace(cliEntry, `${cliEntry}.stale`));
  assert.equal(cliInfo().ready, false);
  refreshInstalledCli();
  assert.equal(cliInfo().ready, true, 'an older managed shim is refreshed');
  writeFileSync(installedShim, 'foreign command\n');
  refreshInstalledCli();
  assert.equal(readFileSync(installedShim, 'utf8'), 'foreign command\n', 'automatic refresh leaves foreign files alone');
  writeFileSync(installedShim, managedBody);
  if (process.platform !== 'win32') {
    const unusualEntry = join(fixtureRoot, "hud's $(touch QUOTE_FAILURE).mjs");
    writeFileSync(unusualEntry, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    process.env.HUD_CLI_ENTRY = unusualEntry;
    refreshInstalledCli();
    const args = ['space value', "a'\"$&literal"];
    const output = execFileSync(installedShim, args, { encoding: 'utf8', cwd: fixtureRoot, timeout: 5000 });
    assert.deepEqual(JSON.parse(output), args, 'shim treats entry paths and arguments literally');
    assert.equal(existsSync(join(fixtureRoot, 'QUOTE_FAILURE')), false);
    process.env.HUD_CLI_ENTRY = cliEntry;
    refreshInstalledCli();
  }
  assert.equal(readFileSync(claudeConfig, 'utf8') === originalClaudeBytes, false, 'repair changed only the fixture config');

  await click(primaryWindow, '[aria-label="Disconnect Claude Code"]');
  await waitText(primaryWindow, '#action-status', 'HUD registration removed from Claude Code.');
  await waitForConnectionStatus(primaryWindow, 'Claude Code', 'Not registered');
  let afterDisconnect = JSON.parse(readFileSync(claudeConfig, 'utf8'));
  assert.equal(afterDisconnect.mcpServers.hud, undefined, 'disconnect removes HUD');
  assert.deepEqual(afterDisconnect.mcpServers.companion, { type: 'stdio', command: 'companion', args: ['server'] }, 'disconnect keeps the other MCP entry');
  assert.deepEqual(afterDisconnect.projects, { keep: ['unrelated', 'settings'] });

  await click(primaryWindow, '[aria-label="Connect Claude Code"]');
  await waitText(primaryWindow, '#action-status', 'HUD registered with Claude Code.');
  await waitForConnectionStatus(primaryWindow, 'Claude Code', 'Registered');
  afterDisconnect = JSON.parse(readFileSync(claudeConfig, 'utf8'));
  assert.deepEqual([afterDisconnect.mcpServers.hud.command, ...afterDisconnect.mcpServers.hud.args], sourceArgv, 'reconnect restores the fixture registration');

  await click(primaryWindow, '[aria-label="Connect Codex"]');
  await waitText(primaryWindow, '#action-status', 'HUD registered with Codex.');
  await waitForConnectionStatus(primaryWindow, 'Codex', 'Registered');
  assert.equal(codex.calls.filter((args) => args[1] === 'add').length, 1, 'Codex connect adds one registration');
  assert.equal(codex.calls.filter((args) => args[1] === 'remove').length, 0, 'Codex connect does not remove an absent registration');
  assert.deepEqual([codex.registration.transport.command, ...codex.registration.transport.args], sourceArgv);
  const addCount = codex.calls.filter((args) => args[1] === 'add').length;
  const removeCount = codex.calls.filter((args) => args[1] === 'remove').length;
  await click(primaryWindow, '[aria-label="Repair Codex"]');
  await waitText(primaryWindow, '#action-status', 'HUD registered with Codex.');
  assert.equal(codex.calls.filter((args) => args[1] === 'add').length, addCount, 'repeated Codex connect is idempotent');
  assert.equal(codex.calls.filter((args) => args[1] === 'remove').length, removeCount, 'repeated Codex connect does not remove its entry');

  await click(primaryWindow, '#copy-config');
  await waitText(primaryWindow, '#action-status', 'MCP configuration copied.');
  assert.equal(copied.length, 1, 'copy action uses injected clipboard handler');
  const snippet = JSON.parse(copied[0]);
  assert.equal(snippet.mcpServers.hud.command, installedShim, 'copied MCP config uses the fixture shim');
  assert.deepEqual(snippet.mcpServers.hud.args, ['mcp']);

  await pageEval(primaryWindow, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const connectionShot = await saveScreenshot(primaryWindow, 'settings-connections.png');

  await click(primaryWindow, '#tab-updates');
  await waitFor(async () => await pageEval(primaryWindow, `document.getElementById('panel-updates')?.hidden === false`), 'Updates panel');
  await click(primaryWindow, '#check-updates');
  await waitText(primaryWindow, '#update-status-text', 'Update available');
  await waitFor(async () => await pageEval(primaryWindow, `document.getElementById('download-update')?.disabled === false`), 'matching installer readiness');
  assert.equal(await pageEval(primaryWindow, `document.getElementById('latest-version')?.textContent`), '0.1.2');
  assert.equal(await pageEval(primaryWindow, `document.getElementById('download-name')?.textContent`), matchingName);
  await click(primaryWindow, '#check-on-launch');
  await waitFor(async () => checkOnLaunch && await pageEval(primaryWindow, `document.getElementById('check-on-launch')?.checked === true`), 'saved update preference');
  await click(primaryWindow, '#open-release');
  await waitText(primaryWindow, '#action-status', 'Opened release information in your browser.');
  await click(primaryWindow, '#download-update');
  await waitText(primaryWindow, '#action-status', 'Opened the installer download in your browser.');
  assert.deepEqual(externalUrls, [releaseUrl, downloadUrl], 'release and download open only through the injected external handler');

  await pageEval(primaryWindow, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const updatesShot = await saveScreenshot(primaryWindow, 'settings-updates.png');
  await click(primaryWindow, '#quit-for-update');
  await waitFor(() => quits === 1, 'explicit Quit HUD for update action');

  // A second page with the same URL and preload cannot use the main Settings window's IPC identity.
  const settingsUrl = pathToFileURL(join(repo, 'web', 'settings.html')).href;
  const attacker = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(repo, 'electron', 'settings-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  windows.add(attacker);
  await attacker.loadURL(settingsUrl);
  const identityError = await pageEval(attacker, `window.hudSettings.getState().then(() => 'resolved', error => error.message)`);
  assert.match(identityError, /Settings requests must come from the Settings window/);

  // An ordinary board-like page has no Settings preload bridge.
  const boardPage = join(fixtureRoot, 'board-like.html');
  writeFileSync(boardPage, '<!doctype html><html><body><main id="board">fixture board</main></body></html>');
  const board = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windows.add(board);
  await board.loadFile(boardPage);
  assert.equal(await pageEval(board, `typeof window.hudSettings`), 'undefined', 'ordinary board pages do not get the Settings bridge');

  assert.deepEqual(consoleFailures, [], `renderer console errors: ${consoleFailures.join(' | ')}`);
  assert.deepEqual(loadFailures, [], `renderer load failures: ${loadFailures.join(' | ')}`);
  assert.equal(readFileSync(cliEntry, 'utf8'), '# inert fixture; the shim is verified, never executed\n');
  console.log(`PASS: real Electron Settings connections, Claude repair/disconnect/reconnect, Codex idempotence, fixture command/copy, updates/preferences/external links, IPC identity and no board bridge.`);
  console.log(`Artifacts: ${connectionShot}, ${updatesShot}`);
}

let exitCode = 0;
const deadline = setTimeout(() => { console.error('Settings UI check exceeded 60 seconds'); app.exit(1); }, 60_000);
// Electron emits ready after the entry module has finished evaluating.
void run().catch((error) => {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  console.error(`Artifacts: ${artifactDir}`);
}).finally(() => {
  clearTimeout(deadline);
  try { settingsController?.close(); } catch {}
  for (const window of windows) {
    try { if (!window.isDestroyed()) window.destroy(); } catch {}
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
  app.exit(exitCode);
});
