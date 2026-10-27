/**
 * Built-in monitor templates. Listing is static catalog data: the CLI can print it without
 * starting a server. Creating a monitor still goes through the store, which is what applies
 * the defaults. None of these defaults run a shell command or contact a host you did not name.
 */

export class MonitorTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonitorTemplateError';
  }
}

export const MONITOR_TEMPLATE_IDS = ['disk', 'tls', 'http', 'cron-heartbeat'] as const;
export type MonitorTemplateId = (typeof MONITOR_TEMPLATE_IDS)[number];

export interface MonitorTemplateSource {
  kind: 'probe' | 'http' | 'heartbeat' | 'command';
  interval?: number;
  timeout?: number;
  period?: number;
  grace?: number;
  url?: string;
  method?: string;
  expectStatus?: number;
  maxBytes?: number;
  /** Present only so a shell template fails the safety check instead of shipping. */
  command?: string;
  body?: string;
  probe?: string;
  config?: Record<string, unknown>;
}

export interface MonitorTemplateDefaults {
  type: 'monitor';
  title: string;
  display?: string;
  unit?: string;
  max?: number;
  warnAbove?: number;
  errorAbove?: number;
  source: MonitorTemplateSource;
}

export interface MonitorTemplate {
  id: MonitorTemplateId;
  title: string;
  summary: string;
  /** Repo-relative guide anchor, printed as the docs link. */
  docs: string;
  /** Command that creates the monitor with its safe defaults. */
  command: string;
  /** Dotted fields the caller must set. The tls template refuses to connect without a host. */
  required: string[];
  defaults: MonitorTemplateDefaults;
  /** Stable, line-oriented form of `defaults` (without `type`) for the gallery and CLI. */
  defaultsText: string;
}

interface RawTemplate {
  id: MonitorTemplateId;
  title: string;
  summary: string;
  docs: string;
  command: string;
  required?: string[];
  defaults: MonitorTemplateDefaults;
}

const RAW: RawTemplate[] = [
  {
    id: 'disk',
    title: 'Disk /',
    summary: 'Percent of the local filesystem in use. Read-only probe; no shell command.',
    docs: 'GUIDE.md#disk-template',
    command: 'hud add monitor --template disk',
    defaults: {
      type: 'monitor',
      title: 'Disk /',
      display: 'gauge',
      unit: '%',
      max: 100,
      warnAbove: 80,
      errorAbove: 95,
      source: { kind: 'probe', probe: 'disk', interval: 60, timeout: 20, config: { path: '/' } },
    },
  },
  {
    id: 'tls',
    title: 'TLS certificate',
    summary: 'Days until a certificate expires. No host is set, so nothing is contacted until you name one.',
    docs: 'GUIDE.md#tls-template',
    command: 'hud add monitor --template tls --host <host>',
    required: ['source.config.host'],
    defaults: {
      type: 'monitor',
      title: 'TLS certificate',
      display: 'value',
      unit: 'days',
      source: {
        kind: 'probe',
        probe: 'tls',
        interval: 3600,
        timeout: 15,
        config: { port: 443, warnDays: 14, errorDays: 3 },
      },
    },
  },
  {
    id: 'http',
    title: 'HTTP health',
    summary: 'GET a loopback URL and report latency. The default never leaves this machine and sends no body.',
    docs: 'GUIDE.md#http-template',
    command: 'hud add monitor --template http',
    defaults: {
      type: 'monitor',
      title: 'HTTP health',
      display: 'value',
      unit: 'ms',
      warnAbove: 1000,
      errorAbove: 5000,
      source: {
        kind: 'http',
        url: 'http://127.0.0.1/',
        method: 'GET',
        expectStatus: 200,
        interval: 60,
        timeout: 10,
        maxBytes: 65536,
      },
    },
  },
  {
    id: 'cron-heartbeat',
    title: 'Cron heartbeat',
    summary: 'A daily job pings /ping/<id>. hud does not run the job. Silence for 25 hours is an error.',
    docs: 'GUIDE.md#cron-heartbeat-template',
    command: 'hud add monitor --template cron-heartbeat',
    defaults: {
      type: 'monitor',
      title: 'Cron heartbeat',
      display: 'status',
      source: { kind: 'heartbeat', period: 86400, grace: 3600 },
    },
  },
];

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** JSON own keys that rebind a result if assigned. `key in obj` is true for the inherited `__proto__` accessor. */
const BLOCKED_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function flattenDefaults(defaults: MonitorTemplateDefaults): string {
  const lines: string[] = [];
  const walk = (value: unknown, prefix: string) => {
    if (plain(value)) {
      for (const key of Object.keys(value).sort()) walk(value[key], prefix ? `${prefix}.${key}` : key);
      return;
    }
    if (value !== undefined) lines.push(`${prefix}: ${String(value)}`);
  };
  const copy = { ...defaults } as Record<string, unknown>;
  delete copy.type;
  walk(copy, '');
  return lines.join('\n');
}

function publish(raw: RawTemplate): MonitorTemplate {
  return {
    id: raw.id,
    title: raw.title,
    summary: raw.summary,
    docs: raw.docs,
    command: raw.command,
    required: [...(raw.required ?? [])],
    defaults: structuredClone(raw.defaults),
    defaultsText: flattenDefaults(raw.defaults),
  };
}

/** Refuse to publish a template whose defaults run a shell, phone home, or omit its docs link. */
function assertSafe(template: MonitorTemplate): void {
  const source = template.defaults.source;
  if (source.kind === 'command' || source.command) throw new Error(`template ${template.id} must not run a shell command`);
  if (!/^GUIDE\.md#[a-z0-9-]+$/.test(template.docs)) throw new Error(`template ${template.id} docs link is not a GUIDE.md anchor`);
  if (template.id === 'disk') {
    if (source.kind !== 'probe' || source.probe !== 'disk' || source.config?.path !== '/') throw new Error('disk template must probe the local filesystem at /');
    if ((source.interval ?? 0) < 60) throw new Error('disk template interval is too aggressive');
  }
  if (template.id === 'tls') {
    if (source.kind !== 'probe' || source.probe !== 'tls') throw new Error('tls template must use the tls probe');
    if (source.config?.host) throw new Error('tls template must not default a host');
    if ((source.interval ?? 0) < 3600) throw new Error('tls template interval is too aggressive');
  }
  if (template.id === 'http') {
    let url: URL;
    try { url = new URL(String(source.url)); } catch { throw new Error('http template needs a URL'); }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !['127.0.0.1', 'localhost', '::1'].includes(host))
      throw new Error('http template default must stay on loopback');
    if ((source.method ?? 'GET').toUpperCase() !== 'GET' || source.body) throw new Error('http template default must be a GET with no body');
  }
  if (template.id === 'cron-heartbeat') {
    if (source.kind !== 'heartbeat' || (source.period ?? 0) < 3600 || (source.grace ?? 0) < 60)
      throw new Error('cron-heartbeat must be a patient heartbeat');
  }
}

const PUBLISHED = RAW.map(publish);
for (const template of PUBLISHED) assertSafe(template);

export function listMonitorTemplates(): MonitorTemplate[] {
  return PUBLISHED.map((template) => structuredClone(template));
}

export function formatMonitorTemplate(template: MonitorTemplate): string {
  const defaults = template.defaultsText.split('\n').map((line) => `    ${line}`).join('\n');
  const lines = [
    `${template.id} — ${template.title}`,
    `  ${template.summary}`,
    `  defaults:`,
    defaults,
  ];
  if (template.required.length) lines.push(`  required: ${template.required.join(', ')}`);
  lines.push(`  docs: ${template.docs}`);
  lines.push(`  command: ${template.command}`);
  return lines.join('\n');
}

export function formatMonitorTemplateList(templates: readonly MonitorTemplate[]): string {
  return templates.map((template) => formatMonitorTemplate(template)).join('\n\n');
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!plain(over)) return over;
  // Null prototype so an own `__proto__` key cannot be consulted or assigned onto Object.prototype.
  const out: Record<string, unknown> = Object.create(null);
  if (plain(base)) {
    for (const key of Object.keys(base)) {
      if (BLOCKED_MERGE_KEYS.has(key)) continue;
      out[key] = base[key];
    }
  }
  for (const key of Object.keys(over)) {
    if (BLOCKED_MERGE_KEYS.has(key) || over[key] === undefined) continue;
    out[key] = Object.hasOwn(out, key) ? deepMerge(out[key], over[key]) : deepMerge(undefined, over[key]);
  }
  return out;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Kind, probe, command, and HTTP target are fixed by the template. Other fields may still be overridden. */
function assertApplied(template: MonitorTemplate, merged: Record<string, unknown>): void {
  const source = plain(merged.source) ? merged.source : {};
  const expected = template.defaults.source;
  if (source.kind !== expected.kind) throw new MonitorTemplateError(`template ${template.id} keeps source.kind ${expected.kind}`);
  if (source.command != null && source.command !== '') throw new MonitorTemplateError(`template ${template.id} must not run a shell command`);
  if (expected.kind === 'probe' && source.probe !== expected.probe)
    throw new MonitorTemplateError(`template ${template.id} keeps probe ${expected.probe}`);
  if (expected.kind !== 'http') return;
  let url: URL;
  try { url = new URL(String(source.url)); } catch { throw new MonitorTemplateError('http template needs a loopback URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK_HOSTS.has(host))
    throw new MonitorTemplateError('http template URL must stay on loopback');
  const method = source.method == null || source.method === '' ? 'GET' : source.method;
  if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || source.body)
    throw new MonitorTemplateError('http template must stay a GET with no body');
}

function hostname(value: string): string {
  const host = value.trim();
  if (!host || host.length > 253 || host.includes('..') || !/^[A-Za-z0-9._:-]+$/.test(host))
    throw new MonitorTemplateError(`host "${value.trim().slice(0, 80)}" is not a hostname`);
  return host;
}

/** Expand `template` into monitor fields. Caller fields win, including nested `source` keys. Unknown templates throw. */
export function applyMonitorTemplate(input: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(input, 'template') || input.template == null || input.template === '') return input;
  if (input.template === true) throw new MonitorTemplateError(`name a monitor template. Known: ${MONITOR_TEMPLATE_IDS.join(', ')}`);
  const id = String(input.template);
  const template = PUBLISHED.find((item) => item.id === id);
  if (!template) throw new MonitorTemplateError(`unknown monitor template "${id.slice(0, 80)}". Known: ${MONITOR_TEMPLATE_IDS.join(', ')}`);
  if (input.type != null && input.type !== 'monitor') throw new MonitorTemplateError('monitor templates only apply to type monitor');

  const rest: Record<string, unknown> = { ...input };
  delete rest.template;
  const hostFlag = typeof rest.host === 'string' ? rest.host.trim() : '';
  delete rest.host;
  if (typeof rest.title !== 'string' || !rest.title.trim()) delete rest.title;
  const merged = deepMerge(structuredClone(template.defaults), rest) as Record<string, unknown>;
  merged.type = 'monitor';

  const source = plain(merged.source) ? merged.source : {};
  const config = plain(source.config) ? { ...source.config } : {};
  if (!config.host && hostFlag) config.host = hostname(hostFlag);
  if (Object.keys(config).length) source.config = config;
  merged.source = source;

  if (template.id === 'tls') {
    const host = config.host;
    if (typeof host !== 'string' || !host.trim())
      throw new MonitorTemplateError('tls template needs source.config.host (or --host); it does not connect until you name one');
    config.host = hostname(host);
  }
  assertApplied(template, merged);
  return merged;
}
