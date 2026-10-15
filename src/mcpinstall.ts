import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SOURCE_ROOT, isElectron } from './assets.ts';
import { installedShim, installCli } from './cliinstall.ts';

/**
 * Wire hud into other agents' MCP configs, and take it back out again.
 *
 * Each client is described once: whether it has its own CLI we can drive, where its config file
 * lives, and how it shapes a stdio-server entry. Config files are parsed and backed up before any
 * write, and only the `hud` entry is ever touched.
 */

/**
 * The argv that runs hud's MCP server, correct from source, from the desktop app and from a
 * packaged binary. The app registers its installed `hud` command, so the entry is a short, stable
 * path that survives app updates (and needs no env block in the client's config).
 */
export function mcpArgv(): string[] {
  if (isElectron()) return [process.env.HUD_SHIM || installedShim() || 'hud', 'mcp'];
  return [stableNode(), join(SOURCE_ROOT, 'bin', 'hud.js'), 'mcp'];
}

/** A node path that survives `brew upgrade`: the plain `node` on PATH when it is this binary, else a known symlink. */
function stableNode(): string {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return '';
    }
  };
  const self = real(process.execPath);
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const cands = [...dirs, '/opt/homebrew/bin', '/usr/local/bin'].map((d) => join(d, process.platform === 'win32' ? 'node.exe' : 'node'));
  for (const c of cands) if (existsSync(c) && real(c) === self) return c;
  return process.execPath;
}

type Client = {
  label: string;
  /** config file to edit when there is no CLI to drive (may be null for print-only clients) */
  config?: () => string;
  /** child-process args that add / remove the entry, with the mcp argv appended after `--` */
  cli?: { bin: string; add: string[]; remove: string[] };
  /** client-specific config entry */
  entry?: (argv: string[]) => unknown;
  /** where in the config JSON the entry lives */
  path?: string[];
  note?: string;
};

const opencodeConfig = () => {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'opencode', 'opencode.json');
};

const CLIENTS: Record<string, Client> = {
  claude: {
    label: 'Claude Code',
    config: () => join(homedir(), '.claude.json'),
    cli: { bin: 'claude', add: ['mcp', 'add', '-s', 'user', 'hud', '--'], remove: ['mcp', 'remove', '-s', 'user', 'hud'] },
  },
  codex: {
    label: 'Codex',
    config: () => join(homedir(), '.codex', 'config.toml'),
    cli: { bin: 'codex', add: ['mcp', 'add', 'hud', '--'], remove: ['mcp', 'remove', 'hud'] },
  },
  opencode: {
    label: 'opencode',
    config: opencodeConfig,
    path: ['mcp', 'hud'],
    entry: (argv) => ({ type: 'local', command: argv, enabled: true }),
  },
  muse: {
    label: 'muse',
    note: 'muse has no documented MCP config format yet — run `hud mcp print` and paste the command into muse’s MCP settings',
  },
  generic: {
    label: 'any MCP client',
    note: 'paste one of the snippets below into your client’s MCP settings',
  },
};

const NAMES = Object.keys(CLIENTS);

function have(bin: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
  return r.status === 0;
}

function jsonSnippet(argv: string[]): string {
  return JSON.stringify({ mcpServers: { hud: { command: argv[0], args: argv.slice(1) } } }, null, 2);
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const txt = readFileSync(file, 'utf8').trim();
  if (!txt) return {};
  return JSON.parse(txt) as Record<string, any>;
}

function backup(file: string): void {
  if (!existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(file, `${file}.hud-backup-${stamp}`);
  try {
    const base = `${file.split('/').pop()}.hud-backup-`;
    const old = readdirSync(dirname(file)).filter((f) => f.startsWith(base)).sort();
    for (const f of old.slice(0, -5)) rmSync(join(dirname(file), f), { force: true });
  } catch {}
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

/** dig a nested entry out of a config object */
function dig(obj: Record<string, any>, path: string[]): unknown {
  let cur: any = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(obj: Record<string, any>, path: string[], value: unknown): void {
  let cur: any = obj;
  for (const k of path.slice(0, -1)) cur = cur[k] ??= {};
  const last = path[path.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

export type Resolved = { name: string; client: Client; file?: string };

export function resolveClients(names: string[]): Resolved[] {
  const list = names.length ? names : ['claude', 'codex', 'opencode'];
  const out: Resolved[] = [];
  for (const n of list) {
    const key = NAMES.find((k) => k === n) ?? (n === 'all' ? 'all' : undefined);
    if (key === 'all') {
      for (const k of ['claude', 'codex', 'opencode']) out.push({ name: k, client: CLIENTS[k], file: CLIENTS[k].config?.() });
      continue;
    }
    if (!key) throw new Error(`unknown client "${n}" (known: ${NAMES.join(', ')}, all)`);
    out.push({ name: key, client: CLIENTS[key], file: CLIENTS[key].config?.() });
  }
  return out;
}

function installOne(r: Resolved, argv: string[], dry: boolean, log: (s: string) => void): void {
  const { client, file } = r;
  if (client.cli && have(client.cli.bin)) {
    const args = [...client.cli.add, ...argv];
    log(`  ${client.label}: ${client.cli.bin} ${args.join(' ')}`);
    if (!dry) {
      const res = spawnSync(client.cli.bin, args, { stdio: 'inherit' });
      if (res.status !== 0) throw new Error(`${client.cli.bin} exited ${res.status}`);
    }
    return;
  }
  if (client.path && !client.cli && file && !existsSync(dirname(file))) {
    log(`  ${client.label}: not installed, skipped`);
    return;
  }
  if (!client.config || !client.path || !client.entry) {
    log(`  ${client.label}: nothing to write — ${client.note ?? 'use `hud mcp print`'}`);
    return;
  }
  const filePath = file!;
  let cfg: Record<string, any>;
  try {
    cfg = readJson(filePath);
  } catch (e) {
    throw new Error(`could not parse ${filePath} (${(e as Error).message}); leaving it untouched`);
  }
  const desired = client.entry(argv);
  const current = dig(cfg, client.path);
  if (JSON.stringify(current) === JSON.stringify(desired)) return log(`  ${client.label}: already configured (${filePath})`);
  log(`  ${client.label}: ${current ? 'update' : 'add'} ${filePath}`);
  if (dry) return;
  backup(filePath);
  setPath(cfg, client.path, desired);
  writeJson(filePath, cfg);
}

function uninstallOne(r: Resolved, dry: boolean, log: (s: string) => void): void {
  const { client, file } = r;
  if (client.cli && have(client.cli.bin)) {
    log(`  ${client.label}: ${client.cli.bin} ${client.cli.remove.join(' ')}`);
    if (!dry) spawnSync(client.cli.bin, client.cli.remove, { stdio: 'inherit' });
    return;
  }
  if (!client.config || !client.path) return log(`  ${client.label}: nothing to remove`);
  const filePath = file!;
  if (!existsSync(filePath)) return log(`  ${client.label}: no config at ${filePath}`);
  let cfg: Record<string, any>;
  try {
    cfg = readJson(filePath);
  } catch (e) {
    throw new Error(`could not parse ${filePath} (${(e as Error).message}); leaving it untouched`);
  }
  if (dig(cfg, client.path) === undefined) return log(`  ${client.label}: no hud entry in ${filePath}`);
  log(`  ${client.label}: remove hud from ${filePath}`);
  if (dry) return;
  backup(filePath);
  setPath(cfg, client.path, undefined);
  writeJson(filePath, cfg);
}

function statusOne(r: Resolved, log: (s: string) => void): void {
  const { client, file } = r;
  let state = 'not configured';
  const viaCli = cliHasHud(client);
  if (viaCli === true) state = `configured (${client.cli!.bin})`;
  else if (viaCli === false) state = `not configured (${client.cli!.bin} has no hud entry)`;
  if (client.path && file && existsSync(file)) {
    try {
      if (dig(readJson(file), client.path) !== undefined) state = `configured in ${file}`;
    } catch {
      state = `unreadable config ${file}`;
    }
  } else if (!client.path && client.note) {
    state = client.note;
  }
  log(`  ${client.label.padEnd(14)} ${state}`);
}

export function mcpCommand(sub: string, names: string[], flags: Record<string, unknown>): number {
  const dry = !!flags['dry-run'];
  const argv = mcpArgv();
  const log = (s: string) => process.stdout.write(s + '\n');
  try {
    if (sub === 'print') {
      const who = (names[0] as string) ?? 'generic';
      const r = resolveClients([who])[0];
      log(`${r.client.label} — stdio server`);
      log('');
      if (r.client.cli) log(`  ${r.client.cli.bin} ${[...r.client.cli.add, ...argv].join(' ')}`);
      if (r.client.path && r.client.entry) {
        log(`  add this to ${r.file}:`);
        log(indent(JSON.stringify(nestPath(r.client.path, r.client.entry(argv)), null, 2), 4));
      } else if (!r.client.cli) {
        log(indent(jsonSnippet(argv), 2));
      }
      return 0;
    }
    if (sub === 'install') {
      // chicken-and-egg: from the app, the `hud` command may not exist yet, so make it first
      if (isElectron() && !installedShim() && !dry) {
        log(installCli());
      }
      const argvNow = isElectron() ? mcpArgv() : argv; // pick up a shim installed just above
      log(dry ? 'would install the hud MCP server:' : 'installing the hud MCP server:');
      let failed = 0;
      for (const r of resolveClients(names)) {
        try {
          installOne(r, argvNow, dry, log);
        } catch (e) {
          failed++;
          log(`  ${r.client.label}: FAILED — ${(e as Error).message}`);
        }
      }
      return failed ? 1 : 0;
    }
    if (sub === 'uninstall' || sub === 'remove') {
      log(dry ? 'would remove the hud MCP server:' : 'removing the hud MCP server:');
      let failed = 0;
      for (const r of resolveClients(names)) {
        try {
          uninstallOne(r, dry, log);
        } catch (e) {
          failed++;
          log(`  ${r.client.label}: FAILED — ${(e as Error).message}`);
        }
      }
      return failed ? 1 : 0;
    }
    if (sub === 'status') {
      log('hud MCP server:');
      log(`  command        ${argv.join(' ')}`);
      log(`  mode           ${isElectron() ? 'desktop app' : 'from source'}`);
      for (const r of resolveClients(names.length ? names : Object.keys(CLIENTS))) statusOne(r, log);
      return 0;
    }
    log(`unknown mcp subcommand "${sub}" — try: hud mcp install|uninstall|status|print`);
    return 1;
  } catch (e) {
    process.stderr.write(`hud: ${(e as Error).message}\n`);
    return 1;
  }
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s.split('\n').map((l) => pad + l).join('\n');
}

/** wrap a value at a config path, e.g. ['mcp','hud'] + entry -> { mcp: { hud: entry } } */
function nestPath(path: string[], value: unknown): unknown {
  return path.slice().reverse().reduce<unknown>((acc, k) => ({ [k]: acc }), value);
}

/** ask a client's own CLI whether it knows about hud */
function cliHasHud(client: Client): boolean | undefined {
  if (!client.cli || !have(client.cli.bin)) return undefined;
  const r = spawnSync(client.cli.bin, ['mcp', 'list'], { encoding: 'utf8' });
  if (r.status !== 0 && !r.stdout) return undefined;
  return /\bhud\b/.test(r.stdout ?? '');
}
