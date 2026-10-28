import { execFile } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { SOURCE_ROOT, isElectron } from './assets.ts';
import { cliInfo, installedShim, installCli } from './cliinstall.ts';
import { isBundle } from './assets.ts';
import { launcherPath } from './install.ts';
import { childEnv } from './electron-runtime.ts';

export const CLIENT_IDS = ['claude', 'codex', 'opencode'] as const;
export type ClientId = typeof CLIENT_IDS[number];
export type ConnectionInfo = {
  id: ClientId; label: string; detected: boolean; executable?: string;
  state: 'connected' | 'needs-repair' | 'not-connected' | 'unavailable' | 'error';
  detail: string; configPath: string; registered?: boolean;
};
type ToolResult = { code: number; stdout: string; stderr: string };
type Runner = (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<ToolResult>;
type Options = { home?: string; env?: NodeJS.ProcessEnv; platform?: string; argv?: () => string[]; run?: Runner };
type Registration = { present: boolean; argv?: string[]; enabled?: boolean };
const LABELS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
let writes = 0;

export function mcpArgv(): string[] {
  if (isElectron()) return [installedShim() || 'hud', 'mcp'];
  // a curl install registers its own launcher, so the client never depends on PATH
  if (isBundle()) {
    const launcher = launcherPath();
    return existsSync(launcher) ? [launcher, 'mcp'] : [stableNode(), join(SOURCE_ROOT, 'hud.mjs'), 'mcp'];
  }
  return [stableNode(), join(SOURCE_ROOT, 'bin', 'hud.js'), 'mcp'];
}

function stableNode(): string {
  const real = (p: string) => { try { return realpathSync(p); } catch { return ''; } };
  const self = real(process.execPath);
  const dirs = [...(process.env.PATH || '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    if (real(candidate) === self) return candidate;
  }
  return process.execPath;
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv, platform: string = process.platform): string | undefined {
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const extension of extensions) {
      const file = join(dir.replace(/^"|"$/g, ''), name + extension);
      try { if (statSync(file).isFile()) { accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return file; } } catch {}
    }
  }
  return undefined;
}

/** No arbitrary shell text: cmd wrappers accept only quoted, metacharacter-free arguments. */
export async function runClient(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<ToolResult> {
  let command = executable, argv = args;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    if ([executable, ...args].some((value) => /[\r\n%!"&|<>^]/.test(value))) throw new Error('This Windows CLI path needs manual MCP configuration. Use Copy MCP configuration.');
    command = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    argv = ['/d', '/v:off', '/s', '/c', `"${[executable, ...args].map((value) => `"${value}"`).join(' ')}"`];
  }
  return new Promise((resolve, reject) => {
    execFile(command, argv, { env, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true, windowsVerbatimArguments: command !== executable }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) return reject(new Error(error.killed ? 'The coding CLI timed out. Try again or use Copy MCP configuration.' : `Could not run the coding CLI: ${error.message}`));
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object; left the configuration untouched`);
  return value as Record<string, any>;
}

function readJson(file: string): { value: Record<string, any>; original: string | null } {
  regularConfig(file);
  if (!existsSync(file)) return { value: {}, original: null };
  const original = readFileSync(file, 'utf8');
  return { value: object(original.trim() ? JSON.parse(original) : {}, file), original };
}

function regularConfig(file: string): string {
  try {
    if (!lstatSync(file).isFile()) throw new Error(`The configuration at ${file} is symlinked or not a regular file. Use Copy MCP configuration to edit it manually.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return file;
}

function backup(file: string): void {
  if (!existsSync(file)) return;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${++writes}`;
  const target = `${file}.hud-backup-${stamp}`;
  copyFileSync(file, target);
  chmodSync(target, 0o600);
  const prefix = `${basename(file)}.hud-backup-`;
  const old = readdirSync(dirname(file)).filter((name) => name.startsWith(prefix)).sort();
  for (const name of old.slice(0, -5)) rmSync(join(dirname(file), name), { force: true });
}

function writeConfig(file: string, value: unknown, original: string | null): void {
  regularConfig(file);
  if ((existsSync(file) ? readFileSync(file, 'utf8') : null) !== original) throw new Error('The coding CLI configuration changed during this operation. Refresh and try again.');
  backup(file);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++writes}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(tmp, file); }
  finally { rmSync(tmp, { force: true }); }
}

function registration(value: unknown, id: ClientId): Registration {
  if (value === undefined) return { present: false };
  const entry = object(value, 'hud registration');
  if (id === 'opencode') return { present: true, argv: entry.type === 'local' && Array.isArray(entry.command) && entry.command.every((v: unknown) => typeof v === 'string') ? entry.command : undefined, enabled: entry.enabled !== false };
  return { present: true, argv: typeof entry.command === 'string' && (entry.args === undefined || Array.isArray(entry.args) && entry.args.every((v: unknown) => typeof v === 'string')) ? [entry.command, ...(entry.args ?? [])] : undefined, enabled: entry.enabled !== false && (!entry.type || entry.type === 'stdio') && !entry.env?.HUD_SCRATCH && !entry.env?.HUD_URL };
}

export class ConnectionService {
  private env: NodeJS.ProcessEnv;
  private home: string;
  private platform: string;
  private argv: () => string[];
  private run: Runner;
  private busy = false;
  constructor(options: Options = {}) {
    this.env = options.env ?? childEnv();
    this.home = options.home ?? homedir();
    this.platform = options.platform ?? process.platform;
    this.argv = options.argv ?? mcpArgv;
    this.run = options.run ?? runClient;
  }

  private file(id: ClientId): string {
    if (id === 'claude') return regularConfig(join(this.env.CLAUDE_CONFIG_DIR || this.home, '.claude.json'));
    if (id === 'codex') return regularConfig(join(this.env.CODEX_HOME || join(this.home, '.codex'), 'config.toml'));
    if (this.env.OPENCODE_CONFIG) {
      if (this.env.OPENCODE_CONFIG.endsWith('.jsonc')) throw new Error('Your OpenCode configuration uses JSONC. Use Copy MCP configuration to preserve its comments.');
      return regularConfig(this.env.OPENCODE_CONFIG);
    }
    const dir = join(this.env.XDG_CONFIG_HOME || join(this.home, '.config'), 'opencode');
    const json = join(dir, 'opencode.json'), jsonc = join(dir, 'opencode.jsonc');
    if (existsSync(jsonc)) throw new Error(`OpenCode has a JSONC configuration at ${jsonc}. Use Copy MCP configuration to preserve its comments.`);
    return regularConfig(json);
  }

  private async inspect(id: ClientId, executable?: string): Promise<Registration> {
    if (id === 'codex') {
      if (!executable) return { present: false };
      const result = await this.run(executable, ['mcp', 'get', 'hud', '--json'], this.env);
      if (result.code !== 0) {
        if (/No MCP server named ['"]?hud['"]? found\.?/i.test(result.stderr + result.stdout)) return { present: false };
        throw new Error('Could not read the Codex MCP registration. Check that your Codex CLI supports mcp get --json.');
      }
      const entry = object(JSON.parse(result.stdout), 'Codex MCP registration');
      const transport = object(entry.transport, 'Codex MCP transport');
      return registration({ ...transport, enabled: entry.enabled !== false }, id);
    }
    const { value } = readJson(this.file(id));
    const section = value[id === 'claude' ? 'mcpServers' : 'mcp'];
    return registration(section === undefined ? undefined : object(section, 'MCP settings').hud, id);
  }

  async status(id: ClientId): Promise<ConnectionInfo> {
    this.validate(id);
    const executable = findExecutable(id, this.env, this.platform);
    const base = { id, label: LABELS[id], detected: !!executable, executable, configPath: '' };
    try {
      base.configPath = this.file(id);
      const current = await this.inspect(id, executable);
      if (!executable) return { ...base, state: 'unavailable', registered: current.present, detail: 'CLI not found on your login PATH. Install it, then refresh. You can also copy the MCP configuration.' };
      if (!current.present) return { ...base, state: 'not-connected', registered: false, detail: 'The CLI is installed. Register HUD to make its tools available.' };
      const matches = current.enabled !== false && JSON.stringify(current.argv) === JSON.stringify(this.argv());
      return { ...base, state: matches ? 'connected' : 'needs-repair', registered: true, detail: matches ? 'HUD is registered. Reconnect or restart existing client sessions to load its tools.' : 'The HUD registration is disabled or points to another installation. Repair it to use this app.' };
    } catch (error) { return { ...base, state: 'error', detail: error instanceof Error ? error.message : 'Could not inspect the MCP configuration.' }; }
  }

  list(): Promise<ConnectionInfo[]> { return Promise.all(CLIENT_IDS.map((id) => this.status(id))); }

  private validate(id: string): asserts id is ClientId { if (!CLIENT_IDS.includes(id as ClientId)) throw new Error('Unknown coding CLI'); }

  async change(id: ClientId, connect: boolean): Promise<void> {
    this.validate(id);
    if (this.busy) throw new Error('Another connection change is in progress. Try again when it finishes.');
    this.busy = true;
    try {
      const executable = findExecutable(id, this.env, this.platform);
      if (connect && !executable) throw new Error(`${LABELS[id]} was not found on your login PATH. Install it, then refresh.`);
      const file = this.file(id);
      const current = await this.inspect(id, executable);
      if (!connect && !current.present) return;
      const argv = this.argv();
      if (connect && current.enabled !== false && JSON.stringify(current.argv) === JSON.stringify(argv)) return;
      if (id === 'codex') {
        if (!executable) throw new Error('Install Codex to remove its HUD registration, or remove [mcp_servers.hud] from its config manually.');
        backup(file);
        if (current.present) {
          const removed = await this.run(executable, ['mcp', 'remove', 'hud'], this.env);
          if (removed.code !== 0) throw new Error('Codex could not remove its previous HUD registration. Its configuration backup is beside config.toml.');
        }
        if (connect) {
          const added = await this.run(executable, ['mcp', 'add', 'hud', '--', ...argv], this.env);
          if (added.code !== 0) throw new Error('Codex could not register HUD. Its configuration backup is beside config.toml; retry or use Copy MCP configuration.');
        }
      } else {
        const { value, original } = readJson(file);
        const key = id === 'claude' ? 'mcpServers' : 'mcp';
        const section = value[key] === undefined ? (value[key] = {}) : object(value[key], 'MCP settings');
        if (connect) section.hud = id === 'claude' ? { type: 'stdio', command: argv[0], args: argv.slice(1) } : { type: 'local', command: argv, enabled: true };
        else delete section.hud;
        writeConfig(file, value, original);
      }
      const after = await this.status(id);
      if (connect ? after.state !== 'connected' : after.registered) throw new Error('The registration could not be verified. Refresh and inspect the client configuration.');
    } finally { this.busy = false; }
  }
}

export function configSnippet(argv = mcpArgv()): string {
  return JSON.stringify({ mcpServers: { hud: { command: argv[0], args: argv.slice(1) } } }, null, 2);
}

function resolveClients(names: string[]): ClientId[] {
  const selected = names.length ? names : ['all'];
  const ids = selected.flatMap((name) => name === 'all' ? [...CLIENT_IDS] : [name]);
  for (const id of ids) if (!CLIENT_IDS.includes(id as ClientId)) throw new Error(`unknown client "${id}" (known: ${CLIENT_IDS.join(', ')}, all)`);
  return [...new Set(ids)] as ClientId[];
}

export async function mcpCommand(sub: string, names: string[], flags: Record<string, unknown>): Promise<number> {
  const json = !!flags.json;
  try {
    if (sub === 'print') {
      const id = names[0] ?? 'generic';
      if (!['generic', 'muse', ...CLIENT_IDS].includes(id)) throw new Error(`unknown client "${id}"`);
      const argv = mcpArgv();
      const text = id === 'opencode' ? JSON.stringify({ mcp: { hud: { type: 'local', command: argv, enabled: true } } }, null, 2) : id === 'codex' ? `[mcp_servers.hud]\ncommand = ${JSON.stringify(argv[0])}\nargs = ${JSON.stringify(argv.slice(1))}` : configSnippet(argv);
      process.stdout.write(text + '\n');
      return 0;
    }
    if (!['install', 'repair', 'uninstall', 'remove', 'status'].includes(sub)) throw new Error(`unknown mcp subcommand "${sub}" — try install|uninstall|status|print`);
    const ids = resolveClients(names);
    const dry = !!flags['dry-run'];
    if (['install', 'repair'].includes(sub) && isElectron() && !dry) {
      installCli();
      if (!cliInfo().ready) throw new Error(cliInfo().detail);
    }
    const service = new ConnectionService();
    const output: (ConnectionInfo & { error?: string; dryRun?: boolean })[] = [];
    let failures = 0;
    for (const id of ids) {
      try {
        const before = await service.status(id);
        const skipMissing = (!names.length || names.includes('all')) && !before.detected;
        if (sub !== 'status' && !dry && !skipMissing) await service.change(id, sub === 'install' || sub === 'repair');
        output.push({ ...await service.status(id), ...(dry ? { dryRun: true } : {}) });
      } catch (error) {
        failures++;
        output.push({ ...await service.status(id), error: (error as Error).message });
      }
    }
    if (json) process.stdout.write(JSON.stringify(output) + '\n');
    else for (const row of output) process.stdout.write(`  ${row.label}: ${row.error ? `FAILED — ${row.error}` : `${dry ? 'dry run — ' : ''}${row.state}`}\n    ${row.detail}\n`);
    return failures ? 1 : 0;
  } catch (error) {
    if (json) process.stdout.write(JSON.stringify({ error: (error as Error).message }) + '\n');
    else console.error((error as Error).message);
    return 1;
  }
}
