#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as deadline } from 'node:timers/promises';

const USAGE = 'usage: node scripts/check-packaged.mjs <output-dir> [arch]';
const STATE_VERSION = 10;
const LIVE_PORT = 7317;
const SERVER_START_TIMEOUT = 30_000;
const COMMAND_TIMEOUT = 30_000;
const PROCESS_STOP_TIMEOUT = 10_000;
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const SERVER_LOG_LIMIT = 32 * 1024;

function normalizeArch(value) {
  const arch = String(value ?? '').toLowerCase();
  if (['arm64', 'aarch64'].includes(arch)) return 'arm64';
  if (['x64', 'x86_64', 'amd64'].includes(arch)) return 'x64';
  if (['x86', 'ia32'].includes(arch)) return 'ia32';
  throw new Error(`unsupported architecture "${value}"; use arm64, x64, or ia32`);
}

function inferredArch(label, platform) {
  const name = String(label).toLowerCase();
  if (/arm64|aarch64/.test(name)) return 'arm64';
  if (/x64|x86_64|amd64/.test(name)) return 'x64';
  if (platform !== 'darwin' && /(?:^|[-_])(?:win|linux)-unpacked(?:$|[-_])/.test(name)) return 'x64';
  return null;
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function listDirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function locatePackagedApp(outputDir, requestedArch) {
  const root = path.resolve(outputDir);
  const platform = process.platform;
  const candidates = [];
  const seen = new Set();

  const add = (appRoot, label = '') => {
    const resolvedRoot = path.resolve(appRoot);
    if (seen.has(resolvedRoot)) return;
    seen.add(resolvedRoot);

    let binary;
    let entry;
    if (platform === 'darwin') {
      binary = path.join(resolvedRoot, 'Contents', 'MacOS', 'hud');
      entry = path.join(resolvedRoot, 'Contents', 'Resources', 'hud', 'bin', 'hud.mjs');
    } else {
      binary = path.join(resolvedRoot, platform === 'win32' ? 'hud.exe' : 'hud');
      entry = path.join(resolvedRoot, 'resources', 'hud', 'bin', 'hud.mjs');
    }
    if (isFile(binary) && isFile(entry)) {
      candidates.push({ appRoot: resolvedRoot, binary, entry, arch: inferredArch(label || resolvedRoot, platform) });
    }
  };

  if (platform === 'darwin') {
    if (root.toLowerCase().endsWith('.app')) add(root, path.basename(path.dirname(root)));
    add(path.join(root, 'hud.app'), path.basename(root));
    for (const name of listDirectories(root)) {
      const child = path.join(root, name);
      if (name.toLowerCase().endsWith('.app')) add(child, path.basename(root));
      else if (/^mac(?:-|$)/i.test(name)) add(path.join(child, 'hud.app'), name);
    }
  } else {
    add(root, path.basename(root));
    const prefix = platform === 'win32' ? 'win' : 'linux';
    const unpacked = new RegExp(`^${prefix}(?:-[a-z0-9]+)?-unpacked$`, 'i');
    for (const name of listDirectories(root)) if (unpacked.test(name)) add(path.join(root, name), name);
  }

  if (!candidates.length) {
    const expected = platform === 'darwin'
      ? 'mac[-arm64|-x64]/hud.app'
      : platform === 'win32'
        ? 'win[-arm64]-unpacked/hud.exe'
        : 'linux[-arm64]-unpacked/hud';
    throw new Error(`no packaged ${platform} app with its bundled hud.mjs found in ${root} (expected ${expected})`);
  }

  const preferredArch = requestedArch ?? normalizeArch(process.arch);
  const exact = candidates.filter((candidate) => candidate.arch === preferredArch);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`multiple ${preferredArch} packaged apps found in ${root}; pass a narrower output directory`);

  const generic = candidates.filter((candidate) => candidate.arch === null);
  if (generic.length === 1) return generic[0];
  if (!requestedArch && candidates.length === 1) return candidates[0];

  const found = candidates.map((candidate) => `${candidate.appRoot} (${candidate.arch ?? 'unspecified arch'})`).join(', ');
  throw new Error(`could not select ${preferredArch} packaged app from ${root}; found: ${found}`);
}

async function reserveLoopbackPort() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = reservation.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    if (port > 0 && port !== LIVE_PORT) return port;
  }
  throw new Error('could not allocate an unused loopback port away from 7317');
}

function scratchEnvironment(dataDir, probesDir, viewsDir, port) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^HUD_/i.test(key) || /^ELECTRON_RUN_AS_NODE$/i.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HUD_SCRATCH: '1',
    HUD_PORT: String(port),
    HUD_DATA: dataDir,
    HUD_PROBES: probesDir,
    HUD_VIEWS: viewsDir,
    HUD_URL: `http://127.0.0.1:${port}`,
  });
  return env;
}

function appendText(current, decoder, chunk, limit) {
  const next = current + decoder.write(chunk);
  return next.length > limit ? next.slice(-limit) : next;
}

function startChild(binary, args, env, { stdin = false, outputLimit = Infinity } = {}) {
  const child = spawn(binary, args, {
    env,
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handle = {
    child,
    args,
    closed: false,
    spawnError: null,
    exit: null,
    stdout: '',
    stderr: '',
    outputBytes: 0,
    outputTooLarge: false,
    closePromise: null,
  };
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  const stdoutLimit = Number.isFinite(outputLimit) ? outputLimit : SERVER_LOG_LIMIT;
  const stderrLimit = Number.isFinite(outputLimit) ? outputLimit : SERVER_LOG_LIMIT;
  child.stdout.on('data', (chunk) => {
    handle.outputBytes += chunk.length;
    handle.stdout = appendText(handle.stdout, stdoutDecoder, chunk, stdoutLimit);
    if (handle.outputBytes > outputLimit && !handle.outputTooLarge) {
      handle.outputTooLarge = true;
      try { child.kill(); } catch {}
    }
  });
  child.stderr.on('data', (chunk) => {
    handle.stderr = appendText(handle.stderr, stderrDecoder, chunk, stderrLimit);
  });
  child.once('error', (error) => { handle.spawnError = error; });
  handle.closePromise = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      handle.stdout += stdoutDecoder.end();
      handle.stderr += stderrDecoder.end();
      handle.closed = true;
      handle.exit = { code, signal };
      resolve(handle.exit);
    });
  });
  return handle;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function terminate(handle) {
  if (!handle || handle.closed) return;
  try { handle.child.kill(); } catch {}
  await Promise.race([handle.closePromise, delay(1500)]);
  if (!handle.closed) {
    try { handle.child.kill('SIGKILL'); } catch {}
    await Promise.race([handle.closePromise, delay(1500)]);
  }
  if (!handle.closed) throw new Error(`packaged process ${handle.child.pid} did not exit; its temporary data was retained`);
}

async function runCommand(binary, entry, args, env, { input = '', timeoutMs = COMMAND_TIMEOUT } = {}) {
  const handle = startChild(binary, [entry, ...args], env, { stdin: true, outputLimit: MAX_COMMAND_OUTPUT });
  handle.child.stdin.on('error', () => {});
  handle.child.stdin.end(input);
  const timedOut = Symbol('timeout');
  const result = await Promise.race([
    handle.closePromise,
    deadline(timeoutMs, timedOut, { ref: false }),
  ]);
  if (result === timedOut) {
    await terminate(handle);
    throw new Error(`timed out after ${timeoutMs}ms: ${path.basename(binary)} ${args.join(' ')}\n${handle.stderr.trim()}`);
  }
  if (handle.spawnError) throw new Error(`could not launch ${binary}: ${handle.spawnError.message}`);
  if (handle.outputTooLarge) throw new Error(`command exceeded ${MAX_COMMAND_OUTPUT} bytes of output: ${args.join(' ')}`);
  if (result.code !== 0) {
    throw new Error(`command exited ${result.code ?? result.signal}: ${path.basename(binary)} ${args.join(' ')}\n${handle.stderr.trim()}`);
  }
  return handle.stdout;
}

async function requestJson(url, { method = 'GET', body, timeoutMs = 5000, actor = 'hud-packaged-smoke' } = {}) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-hud-actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : undefined; } catch { value = text; }
  if (!response.ok) throw new Error(`${method} ${url} returned ${response.status}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return value;
}

async function optionalHealth(baseUrl) {
  try {
    const health = await requestJson(`${baseUrl}/api/health`, { timeoutMs: 1000 });
    return health?.name === 'hud' ? health : null;
  } catch {
    return null;
  }
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertOwnedHealth(health, dataDir, port, expectedPid) {
  assert.equal(health.name, 'hud', 'health endpoint must identify hud');
  assert.equal(health.mode, 'packaged', 'server must be running from the packaged Electron binary');
  assert.equal(canonicalPath(health.dataDir), canonicalPath(dataDir), 'server must use the fresh smoke-test data directory');
  assert.equal(health.port, port, 'server must use the allocated loopback port');
  if (expectedPid !== undefined) assert.equal(health.pid, expectedPid, 'CLI/MCP must reuse the server process without starting a second server');
  assert.equal(health.stateVersion, STATE_VERSION, `packaged server must use state version ${STATE_VERSION}`);
}

async function waitForHealth(baseUrl, handle, dataDir, port) {
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  let lastError = '';
  while (Date.now() < deadline) {
    if (handle.spawnError) throw new Error(`could not start packaged server: ${handle.spawnError.message}`);
    if (handle.closed) throw new Error(`packaged server exited ${handle.exit?.code ?? handle.exit?.signal}\n${handle.stderr.trim()}`);
    try {
      const health = await requestJson(`${baseUrl}/api/health`, { timeoutMs: 1500 });
      assertOwnedHealth(health, dataDir, port, handle.child.pid);
      return health;
    } catch (error) {
      lastError = error.message;
      if (/must be running from the packaged|fresh smoke-test|allocated loopback|second server|state version/.test(lastError)) throw error;
    }
    await delay(150);
  }
  throw new Error(`packaged server did not become healthy within ${SERVER_START_TIMEOUT}ms${lastError ? `: ${lastError}` : ''}\n${handle.stderr.trim()}`);
}

async function assertSameServer(baseUrl, handle, dataDir, port) {
  const health = await requestJson(`${baseUrl}/api/health`);
  assertOwnedHealth(health, dataDir, port, handle.child.pid);
  return health;
}

async function stateDigest(file) {
  try {
    const bytes = await readFile(file);
    return createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function responseById(messages, id) {
  const response = messages.find((message) => message.id === id);
  assert.ok(response, `MCP response id ${id} is missing`);
  assert.equal(response.error, undefined, `MCP request ${id} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}

function parseMcpOutput(output) {
  return output.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line); } catch (error) {
      throw new Error(`MCP emitted non-JSON stdout: ${line.slice(0, 300)} (${error.message})`);
    }
  });
}

async function stopOwnedServer(handle, baseUrl, dataDir, port) {
  const health = await optionalHealth(baseUrl);
  if (handle && health?.pid === handle.child.pid && health.mode === 'packaged' && canonicalPath(health.dataDir) === canonicalPath(dataDir) && health.port === port) {
    try {
      await requestJson(`${baseUrl}/api/shutdown`, { method: 'POST', timeoutMs: 3000 });
    } catch {}
  }
  if (handle && !handle.closed) {
    const stopped = await Promise.race([handle.closePromise, deadline(PROCESS_STOP_TIMEOUT, null, { ref: false })]);
    if (!stopped) await terminate(handle);
  }
}

async function cleanup({ tempRoot, serverHandle, baseUrl, dataDir, port, children }) {
  const errors = [];
  if (baseUrl && dataDir) try { await stopOwnedServer(serverHandle, baseUrl, dataDir, port); } catch (error) { errors.push(error); }
  for (const handle of children) if (!handle.closed) try { await terminate(handle); } catch (error) { errors.push(error); }
  if (children.some(handle => !handle.closed)) throw new AggregateError(errors, `packaged processes remain alive; retaining ${tempRoot}`);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, 'packaged process cleanup failed');
}

async function allocateWorkspace() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'hud-packaged-smoke-'));
  const dirs = {
    tempRoot,
    dataDir: path.join(tempRoot, 'data'),
    probesDir: path.join(tempRoot, 'probes'),
    viewsDir: path.join(tempRoot, 'views'),
  };
  try {
    await Promise.all([mkdir(dirs.dataDir), mkdir(dirs.probesDir), mkdir(dirs.viewsDir)]);
    return dirs;
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function shutdownGracefully(handle, baseUrl, dataDir, port) {
  const health = await requestJson(`${baseUrl}/api/health`);
  assertOwnedHealth(health, dataDir, port, handle.child.pid);
  const shutdown = await requestJson(`${baseUrl}/api/shutdown`, { method: 'POST' });
  assert.equal(shutdown.ok, true, 'server must acknowledge graceful shutdown');
  const exit = await Promise.race([handle.closePromise, deadline(PROCESS_STOP_TIMEOUT, null, { ref: false })]);
  if (!exit) {
    await terminate(handle);
    throw new Error('packaged server did not exit after the explicit URL shutdown request');
  }
  assert.equal(exit.code, 0, `packaged server should exit cleanly after shutdown (stderr: ${handle.stderr.trim()})`);
}

async function runSmoke(outputDir, requestedArch) {
  const packaged = locatePackagedApp(outputDir, requestedArch);
  const port = await reserveLoopbackPort();
  const workspace = await allocateWorkspace();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = scratchEnvironment(workspace.dataDir, workspace.probesDir, workspace.viewsDir, port);
  const children = [];
  let serverHandle;

  try {
    const assetsRoot = path.dirname(path.dirname(packaged.entry));
    for (const name of ['web/settings.html', 'web/settings.js', 'web/settings.css', 'electron/settings-preload.cjs']) {
      assert.ok((await readFile(path.join(assetsRoot, name), 'utf8')).length > 0, `packaged Settings asset missing: ${name}`);
    }
    const startServer = () => {
      const handle = startChild(packaged.binary, [packaged.entry, 'serve'], { ...env, ELECTRON_RUN_AS_NODE: '1' });
      children.push(handle);
      return handle;
    };

    serverHandle = startServer();
    await waitForHealth(baseUrl, serverHandle, workspace.dataDir, port);

    const stateFile = path.join(workspace.dataDir, 'state.json');
    const beforeReadOnly = await stateDigest(stateFile);
    const cliStdout = await runCommand(packaged.binary, packaged.entry, ['readout', 'main', '--json'], { ...env, ELECTRON_RUN_AS_NODE: '1' });
    const cliReadout = JSON.parse(cliStdout);
    assert.deepEqual(cliReadout.boards.map((board) => board.id), ['main'], 'bundled CLI --json readout should return only the main board');
    assert.ok(Array.isArray(cliReadout.items), 'bundled CLI readout should include metric items');
    await assertSameServer(baseUrl, serverHandle, workspace.dataDir, port);

    const rpcInput = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'hud-packaged-smoke', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hud_readout', arguments: {} } },
    ].map((request) => JSON.stringify(request)).join('\n') + '\n';
    const mcpStdout = await runCommand(packaged.binary, packaged.entry, ['mcp'], { ...env, ELECTRON_RUN_AS_NODE: '1' }, { input: rpcInput });
    const messages = parseMcpOutput(mcpStdout);
    const initialized = responseById(messages, 1);
    assert.equal(initialized.serverInfo?.name, 'hud', 'bundled MCP initialize should identify hud');
    const listed = responseById(messages, 2);
    const readoutTool = listed.tools?.find((tool) => tool.name === 'hud_readout');
    assert.ok(readoutTool, 'bundled MCP tools/list should include hud_readout');
    assert.equal(readoutTool.annotations?.readOnlyHint, true, 'hud_readout should be marked read-only');
    const readoutResult = responseById(messages, 3);
    assert.notEqual(readoutResult.isError, true, 'bundled MCP hud_readout should succeed');
    assert.deepEqual(readoutResult.structuredContent?.boards?.map((board) => board.id), ['main'], 'hud_readout without a board filter should return all boards');
    await assertSameServer(baseUrl, serverHandle, workspace.dataDir, port);
    assert.equal(await stateDigest(stateFile), beforeReadOnly, 'CLI and MCP readout must not modify persisted state');

    const noteTitle = `packaged smoke ${Date.now()}`;
    const note = await requestJson(`${baseUrl}/api/items`, {
      method: 'POST',
      body: { type: 'note', title: noteTitle, text: 'packaged Electron persistence smoke check', board: 'main' },
    });
    assert.equal(note.type, 'note', 'HTTP should create the one harmless note');
    assert.equal(note.title, noteTitle);
    const noteId = note.id;

    await shutdownGracefully(serverHandle, baseUrl, workspace.dataDir, port);
    serverHandle = null;

    serverHandle = startServer();
    await waitForHealth(baseUrl, serverHandle, workspace.dataDir, port);
    const persisted = await requestJson(`${baseUrl}/api/items/${encodeURIComponent(noteId)}`);
    assert.equal(persisted.id, noteId, 'the note should survive a packaged server restart');
    assert.equal(persisted.title, noteTitle);
    assert.equal(persisted.text, 'packaged Electron persistence smoke check');
    const items = await requestJson(`${baseUrl}/api/items?board=main`);
    assert.deepEqual(items.map((item) => item.id), [noteId], 'the restarted fresh board should contain only the persisted smoke note');
    await shutdownGracefully(serverHandle, baseUrl, workspace.dataDir, port);
    serverHandle = null;
  } finally {
    await cleanup({ tempRoot: workspace.tempRoot, serverHandle, baseUrl, dataDir: workspace.dataDir, port, children });
  }

  return packaged;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (args.length < 1 || args.length > 2) throw new Error(USAGE);
  const [outputDir, archArg] = args;
  const requestedArch = archArg === undefined ? undefined : normalizeArch(archArg);
  const packaged = await runSmoke(outputDir, requestedArch);
  console.log(`PASS packaged smoke check: ${process.platform}/${packaged.arch ?? requestedArch ?? process.arch} (${packaged.appRoot})`);
}

main().catch((error) => {
  console.error(`packaged smoke check failed: ${error?.stack ?? error?.message ?? error}`);
  process.exitCode = 1;
});
