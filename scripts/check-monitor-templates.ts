// Built-in monitor templates: disk, tls, http, and cron-heartbeat.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { confineFileUrl } from '../src/assets.ts';
import { MonitorTemplateError, applyMonitorTemplate, formatMonitorTemplateList, listMonitorTemplates } from '../src/monitor-templates.ts';
import type { MonitorTemplate } from '../src/monitor-templates.ts';
import { Store } from '../src/store.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const IDS = ['disk', 'tls', 'http', 'cron-heartbeat'] as const;
const roots: string[] = [];

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hud-templates-'));
  roots.push(dir);
  const store = new Store(join(dir, 'state.json'));
  store.setBoard('main', { autoOrganize: false }, 'template-check');
  return store;
}

function byId(id: string): MonitorTemplate {
  const found = listMonitorTemplates().find((template) => template.id === id);
  assert(found, `missing template ${id}`);
  return found;
}

function guideSlugs(): Set<string> {
  const guide = readFileSync(join(root, 'GUIDE.md'), 'utf8');
  const slug = (heading: string) => heading.toLowerCase().trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
  return new Set(guide.split('\n').filter((line) => /^#{2,3} /.test(line)).map((line) => slug(line.replace(/^#+\s+/, ''))));
}

function catalog() {
  const templates = listMonitorTemplates();
  assert.deepEqual(templates.map((template) => template.id), [...IDS], 'gallery order is disk, tls, http, cron-heartbeat');
  const slugs = guideSlugs();
  for (const template of templates) {
    assert.equal(template.defaults.type, 'monitor');
    assert.notEqual(template.defaults.source.kind, 'command', `${template.id} must not run a shell`);
    assert.equal(template.defaults.source.command, undefined, `${template.id} must not set a command`);
    assert.match(template.docs, /^GUIDE\.md#[a-z0-9-]+$/, `${template.id} docs link`);
    assert(slugs.has(template.docs.slice('GUIDE.md#'.length)), `${template.docs} is a GUIDE heading`);
    assert(template.summary.length > 20, `${template.id} summary`);
    assert(template.defaultsText.includes('source.kind:'), `${template.id} prints its source kind`);
    assert(template.command.startsWith('hud add monitor --template '), `${template.id} command`);
  }

  const disk = byId('disk');
  assert.equal(disk.defaults.source.kind, 'probe');
  assert.equal(disk.defaults.source.probe, 'disk');
  assert.equal(disk.defaults.source.config?.path, '/');
  assert.equal(disk.defaults.source.interval, 60);
  assert.equal(disk.defaults.unit, '%');
  assert.equal(disk.defaults.max, 100);
  assert.equal(disk.defaults.warnAbove, 80);
  assert.equal(disk.defaults.errorAbove, 95);
  assert.equal(disk.defaultsText, [
    'display: gauge',
    'errorAbove: 95',
    'max: 100',
    'source.config.path: /',
    'source.interval: 60',
    'source.kind: probe',
    'source.probe: disk',
    'source.timeout: 20',
    'title: Disk /',
    'unit: %',
    'warnAbove: 80',
  ].join('\n'));

  const tls = byId('tls');
  assert.equal(tls.defaults.source.kind, 'probe');
  assert.equal(tls.defaults.source.probe, 'tls');
  assert.equal(tls.defaults.source.config?.host, undefined, 'tls does not contact a host until one is set');
  assert.equal(tls.defaults.source.config?.port, 443);
  assert.equal(tls.defaults.source.config?.warnDays, 14);
  assert.equal(tls.defaults.source.config?.errorDays, 3);
  assert.equal(tls.defaults.source.interval, 3600);
  assert.deepEqual(tls.required, ['source.config.host']);
  assert.match(tls.command, /--host <host>/);

  const http = byId('http');
  const url = new URL(String(http.defaults.source.url));
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1', 'http default stays on loopback');
  assert.equal(url.port, '', 'http default does not assume a hud port');
  assert.equal(http.defaults.source.method, 'GET');
  assert.equal(http.defaults.source.expectStatus, 200);
  assert.equal(http.defaults.source.body, undefined);
  assert.equal(http.defaults.source.interval, 60);
  assert.equal(http.defaults.warnAbove, 1000);
  assert.equal(http.defaults.errorAbove, 5000);

  const cron = byId('cron-heartbeat');
  assert.equal(cron.defaults.source.kind, 'heartbeat');
  assert.equal(cron.defaults.source.period, 86400);
  assert.equal(cron.defaults.source.grace, 3600);
  assert.equal(cron.defaults.source.command, undefined);

  const listed = listMonitorTemplates();
  const cloned = listed[0]!;
  cloned.defaults.source.config = { path: '/tmp' };
  assert.equal(byId('disk').defaults.source.config?.path, '/', 'listing returns a copy');

  const text = formatMonitorTemplateList(listMonitorTemplates());
  for (const id of IDS) assert(text.includes(id), `list text includes ${id}`);
  assert(text.includes('GUIDE.md#disk-template'));
  assert(text.includes('GUIDE.md#tls-template'));
  assert(text.includes('GUIDE.md#http-template'));
  assert(text.includes('GUIDE.md#cron-heartbeat-template'));
  assert(text.includes('source.config.path: /'));
  assert(text.includes('required: source.config.host'));
  assert(text.includes('http://127.0.0.1/'));
  assert(text.includes('source.period: 86400'));
  assert(!text.includes('source.kind: command'));
}

function applyAndCreate() {
  const store = freshStore();
  try {
    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'nope' }), (error: unknown) => {
      assert(error instanceof MonitorTemplateError);
      assert.match((error as Error).message, /disk, tls, http, cron-heartbeat/);
      return true;
    });
    assert.throws(() => applyMonitorTemplate({ type: 'ticket', template: 'disk' }), MonitorTemplateError);
    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'tls' }), /source\.config\.host/);
    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'tls', host: ' ' }), /source\.config\.host/);
    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'tls', host: 'bad host' }), /host/);
    assert.equal(store.items().length, 0, 'a rejected template creates nothing');

    const input = { type: 'monitor', template: 'disk', title: '', source: { config: { path: '/data' } }, warnAbove: 70 };
    const applied = applyMonitorTemplate(input);
    assert.equal(input.template, 'disk', 'apply does not mutate the request');
    assert.equal(applied.template, undefined);
    assert.equal(applied.title, 'Disk /', 'a blank title keeps the template title');
    const source = applied.source as { kind: string; probe: string; interval: number; config: { path: string } };
    assert.equal(source.kind, 'probe');
    assert.equal(source.probe, 'disk');
    assert.equal(source.interval, 60, 'nested overrides keep the other source defaults');
    assert.equal(source.config.path, '/data');
    assert.equal(applied.warnAbove, 70);

    const disk = store.create(applyMonitorTemplate({ type: 'monitor', template: 'disk' }), 'template-check');
    assert.equal(disk.type, 'monitor');
    assert.equal(disk.title, 'Disk /');
    assert.equal(disk.source?.kind, 'probe');
    assert.equal(disk.source?.probe, 'disk');
    assert.equal(disk.warnAbove, 80);
    assert.equal((disk as { template?: string }).template, undefined);

    const tls = store.create(applyMonitorTemplate({ type: 'monitor', template: 'tls', host: 'example.com', title: 'Edge cert' }), 'template-check');
    assert.equal(tls.title, 'Edge cert');
    assert.equal(tls.source?.probe, 'tls');
    assert.equal((tls.source?.config as { host?: string; port?: number }).host, 'example.com');
    assert.equal((tls.source?.config as { port?: number }).port, 443);

    const nested = store.create(applyMonitorTemplate({ type: 'monitor', template: 'tls', source: { config: { host: 'localhost' } } }), 'template-check');
    assert.equal((nested.source?.config as { host?: string; warnDays?: number }).host, 'localhost');
    assert.equal((nested.source?.config as { warnDays?: number }).warnDays, 14);

    const http = store.create(applyMonitorTemplate({ type: 'monitor', template: 'http' }), 'template-check');
    assert.equal(http.source?.kind, 'http');
    assert.equal(http.source?.url, 'http://127.0.0.1/');
    assert.equal(http.source?.method, 'GET');

    const cron = store.create(applyMonitorTemplate({ type: 'monitor', template: 'cron-heartbeat' }), 'template-check');
    assert.equal(cron.source?.kind, 'heartbeat');
    assert.equal(cron.source?.period, 86400);
    assert.equal(cron.source?.grace, 3600);
    assert.equal(cron.value, undefined, 'creating a heartbeat is not itself a reading');

    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'disk', source: { kind: 'command', command: 'true' } }), MonitorTemplateError);
    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'http', source: { url: 'https://example.com/health' } }), MonitorTemplateError);
    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'http', source: { method: 'POST', body: 'x' } }), MonitorTemplateError);
    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'disk', source: { probe: 'tail' } }), MonitorTemplateError);
    assert.throws(() => applyMonitorTemplate({ type: 'monitor', template: 'cron-heartbeat', source: { kind: 'command', command: 'true' } }), MonitorTemplateError);
    const local = applyMonitorTemplate({ type: 'monitor', template: 'http', source: { url: 'http://127.0.0.1:8080/health' } });
    assert.equal((local.source as { url?: string; kind?: string; method?: string }).url, 'http://127.0.0.1:8080/health');
    assert.equal((local.source as { kind?: string }).kind, 'http');
    assert.equal((local.source as { method?: string }).method, 'GET');
    const v6 = applyMonitorTemplate({ type: 'monitor', template: 'http', source: { url: 'https://[::1]/health' } });
    assert.equal((v6.source as { url?: string }).url, 'https://[::1]/health');
    const named = applyMonitorTemplate({ type: 'monitor', template: 'http', source: { url: 'http://localhost/health' } });
    assert.equal((named.source as { url?: string }).url, 'http://localhost/health');

    const protoPayload = JSON.parse('{"__proto__": {"polluted": true}, "config": {"path": "/data"}}') as Record<string, unknown>;
    const protoMerged = applyMonitorTemplate({ type: 'monitor', template: 'disk', source: protoPayload });
    const protoSource = protoMerged.source as Record<string, unknown> & { polluted?: boolean; config?: { path?: string } };
    assert.equal(({} as { polluted?: boolean }).polluted, undefined, 'merge must not change Object.prototype');
    assert.equal(protoSource.polluted, undefined, 'merge must not rebind the result prototype');
    assert.notEqual(Object.getPrototypeOf(protoSource), Object.getPrototypeOf(protoPayload.__proto__ ?? {}));
    assert.ok(Object.getPrototypeOf(protoSource) === Object.prototype || Object.getPrototypeOf(protoSource) === null);
    assert.equal(Object.hasOwn(protoSource, '__proto__'), false);
    assert.equal(protoSource.config?.path, '/data');

    const ctorMerged = applyMonitorTemplate({
      type: 'monitor',
      template: 'disk',
      source: JSON.parse('{"constructor": {"prototype": {"polluted": true}}}') as Record<string, unknown>,
    });
    const ctorSource = ctorMerged.source as Record<string, unknown>;
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    assert.equal(Object.hasOwn(ctorSource, 'constructor'), false);
    assert.equal(Object.hasOwn(ctorSource, 'prototype'), false);
    assert.equal((ctorSource.config as { path?: string } | undefined)?.path ?? (ctorMerged.source as { config?: { path?: string } }).config?.path, '/');
  } finally {
    store.stopBackups();
  }
}

function cliListsWithoutStarting() {
  const data = mkdtempSync(join(tmpdir(), 'hud-template-cli-'));
  roots.push(data);
  const env = {
    ...process.env,
    HUD_SCRATCH: '1',
    HUD_PORT: '7462',
    HUD_DATA: data,
    HUD_PROBES: data,
    HUD_VIEWS: data,
  };
  const listed = spawnSync(process.execPath, [join(root, 'bin/hud.js'), 'add', 'monitor', '--template'], { cwd: root, env, encoding: 'utf8', timeout: 8000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trimEnd(), formatMonitorTemplateList(listMonitorTemplates()));
  assert.equal(existsSync(join(data, 'state.json')), false, 'listing templates does not start a server');
  assert.equal(existsSync(join(data, 'hud.pid')), false, 'listing templates does not write a pid');

  const json = spawnSync(process.execPath, [join(root, 'bin/hud.js'), 'add', 'monitor', '--template', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 8000 });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).map((template: { id: string }) => template.id), [...IDS]);

  const help = spawnSync(process.execPath, [join(root, 'bin/hud.js'), 'add', '--help'], { cwd: root, env, encoding: 'utf8', timeout: 8000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--template/);
  assert.match(help.stdout, /cron-heartbeat/);
}

function wiring() {
  const server = readFileSync(join(root, 'src/server.ts'), 'utf8');
  const client = readFileSync(join(root, 'src/client.ts'), 'utf8');
  const mcp = readFileSync(join(root, 'src/mcp.ts'), 'utf8');
  const settings = readFileSync(join(root, 'electron/settings.ts'), 'utf8');
  const html = readFileSync(join(root, 'web/settings.html'), 'utf8');
  const page = readFileSync(join(root, 'web/settings.js'), 'utf8');
  assert(server.includes("route('GET', '/api/monitor-templates'"), 'HTTP lists templates');
  assert(server.includes('applyMonitorTemplate'), 'HTTP create applies a template');
  assert(client.includes('monitorTemplates('), 'client lists templates');
  assert(mcp.includes("name: 'hud_monitor_templates'"), 'MCP lists templates');
  assert(mcp.includes('hud_monitor_templates'), 'MCP tool is registered');
  assert(settings.includes('listMonitorTemplates'), 'Settings state includes the catalog');
  assert(settings.includes('open-template-docs'), 'Settings can open a template docs link');
  assert(settings.includes('confineFileUrl'), 'Settings confines file: opens to the source root');
  assert(html.includes('id="tab-templates"'), 'Settings has a templates tab');
  assert(html.includes('id="panel-templates"'), 'Settings has a templates panel');
  assert(html.includes('id="template-list"'), 'Settings has a template gallery');
  assert(page.includes('data-template-docs'), 'Settings renders docs links');
}

async function httpRoundTrip() {
  const data = mkdtempSync(join(tmpdir(), 'hud-template-http-'));
  roots.push(data);
  const port = 7463;
  const child = spawn(process.execPath, [join(root, 'bin/hud.js'), 'serve'], {
    cwd: root,
    env: {
      ...process.env,
      HUD_SCRATCH: '1',
      HUD_PORT: String(port),
      HUD_DATA: data,
      HUD_PROBES: join(root, 'probes'),
      HUD_VIEWS: data,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (chunk) => { log += chunk; });
  child.stderr?.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const started = Date.now();
    let healthy = false;
    while (Date.now() - started < 15000) {
      if (child.exitCode != null) break;
      try {
        const health = await fetch(`${base}/api/health`);
        if (health.ok) { healthy = true; break; }
      } catch { /* retry */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(healthy, `scratch server did not start\n${log}`);

    const listed = await fetch(`${base}/api/monitor-templates`);
    assert.equal(listed.status, 200);
    const body = await listed.json() as { id: string; docs: string; defaults: { source?: { command?: string; kind?: string } } }[];
    assert.deepEqual(body.map((template) => template.id), [...IDS]);
    assert(body.every((template) => template.docs.startsWith('GUIDE.md#')));
    assert(body.every((template) => template.defaults.source?.kind !== 'command' && template.defaults.source?.command == null));

    const created = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hud-actor': 'template-check' },
      body: JSON.stringify({ type: 'monitor', template: 'disk', title: 'Root disk' }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    const item = JSON.parse(createdText) as { title?: string; source?: { probe?: string; kind?: string }; template?: string };
    assert.equal(item.title, 'Root disk');
    assert.equal(item.source?.kind, 'probe');
    assert.equal(item.source?.probe, 'disk');
    assert.equal(item.template, undefined);

    const missingHost = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hud-actor': 'template-check' },
      body: JSON.stringify({ type: 'monitor', template: 'tls' }),
    });
    assert.equal(missingHost.status, 400);
    assert.match(await missingHost.text(), /source\.config\.host/);

    const httpRes = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hud-actor': 'template-check' },
      body: JSON.stringify({ type: 'monitor', template: 'http' }),
    });
    const httpText = await httpRes.text();
    assert.equal(httpRes.status, 200, httpText);
    const httpCreated = JSON.parse(httpText) as { id: string };
    const httpFull = await (await fetch(`${base}/api/items/${encodeURIComponent(httpCreated.id)}`)).json() as { source?: { kind?: string; url?: string; method?: string; command?: string } };
    assert.equal(httpFull.source?.kind, 'http');
    assert.equal(httpFull.source?.url, 'http://127.0.0.1/');
    assert.equal(httpFull.source?.method, 'GET');
    assert.equal(httpFull.source?.command, undefined);

    const cron = await fetch(`${base}/api/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hud-actor': 'template-check' },
      body: JSON.stringify({ type: 'monitor', template: 'cron-heartbeat' }),
    });
    const cronText = await cron.text();
    assert.equal(cron.status, 200, cronText);
    const cronItem = JSON.parse(cronText) as { source?: { kind?: string; period?: number; grace?: number } };
    assert.equal(cronItem.source?.kind, 'heartbeat');
    assert.equal(cronItem.source?.period, 86400);
    assert.equal(cronItem.source?.grace, 3600);
  } finally {
    try { await fetch(`${base}/api/shutdown`, { method: 'POST' }); } catch { /* already gone */ }
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function fileOpensStayInsideRoot() {
  const scratch = mkdtempSync(join(tmpdir(), 'hud-template-files-'));
  const outside = mkdtempSync(join(tmpdir(), 'hud-template-outside-'));
  roots.push(scratch, outside);
  writeFileSync(join(scratch, 'GUIDE.md'), 'guide');
  writeFileSync(join(scratch, '..hidden'), 'hidden');
  writeFileSync(join(outside, 'secret'), 'nope');
  symlinkSync(join(outside, 'secret'), join(scratch, 'escape'));

  const guide = confineFileUrl(`${pathToFileURL(join(scratch, 'GUIDE.md')).href}#disk-template`, scratch);
  assert.equal(guide, realpathSync(join(scratch, 'GUIDE.md')));
  assert.equal(confineFileUrl(pathToFileURL(join(scratch, '..hidden')).href, scratch), realpathSync(join(scratch, '..hidden')));
  assert.throws(() => confineFileUrl(pathToFileURL(join(outside, 'secret')).href, scratch));
  assert.throws(() => confineFileUrl(pathToFileURL(join(scratch, 'escape')).href, scratch));
  assert.throws(() => confineFileUrl(pathToFileURL(join(scratch, '..', basename(outside), 'secret')).href, scratch));
  assert.throws(() => confineFileUrl('file:///etc/passwd', scratch));
  assert.throws(() => confineFileUrl(`file://evil.example${pathToFileURL(join(scratch, 'GUIDE.md')).pathname}`, scratch));
  assert.throws(() => confineFileUrl(pathToFileURL(scratch).href, scratch));
  assert.throws(() => confineFileUrl(pathToFileURL(join(scratch, 'missing.md')).href, scratch));
  assert.equal(confineFileUrl(pathToFileURL(join(root, 'GUIDE.md')).href), realpathSync(join(root, 'GUIDE.md')));
}

try {
  catalog();
  applyAndCreate();
  fileOpensStayInsideRoot();
  cliListsWithoutStarting();
  wiring();
  await httpRoundTrip();
  console.log('PASS monitor templates: disk, tls, http, cron-heartbeat defaults, docs links, CLI list, HTTP create');
} finally {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
}
