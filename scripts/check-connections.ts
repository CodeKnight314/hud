import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ConnectionService, type ClientId } from '../src/mcpinstall.ts';

type ToolResult = { code: number; stdout: string; stderr: string };
type CodexRegistration = {
  enabled?: boolean;
  transport: { type: string; command: string; args: string[] };
};

class CodexMock {
  calls: string[][] = [];
  registration: CodexRegistration | null = null;
  getFailure: ToolResult | Error | null = null;
  addFailure: ToolResult | null = null;

  async run(_executable: string, args: string[], _env: NodeJS.ProcessEnv): Promise<ToolResult> {
    this.calls.push([...args]);
    if (args[0] === 'mcp' && args[1] === 'get' && args[2] === 'hud' && args[3] === '--json') {
      if (this.getFailure instanceof Error) throw this.getFailure;
      if (this.getFailure) return this.getFailure;
      if (!this.registration) return { code: 1, stdout: '', stderr: "No MCP server named 'hud' found." };
      return { code: 0, stdout: JSON.stringify(this.registration), stderr: '' };
    }
    if (args[0] === 'mcp' && args[1] === 'remove' && args[2] === 'hud') {
      this.registration = null;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'mcp' && args[1] === 'add' && args[2] === 'hud' && args[3] === '--') {
      if (this.addFailure) return this.addFailure;
      const argv = args.slice(4);
      this.registration = {
        enabled: true,
        transport: { type: 'stdio', command: argv[0]!, args: argv.slice(1) },
      };
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected mock Codex command: ${args.join(' ')}`);
  }
}

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `hud-connections-${name}-`));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const windows = process.platform === 'win32';
  const extension = windows ? '.cmd' : '';
  for (const id of ['claude', 'codex', 'opencode']) {
    const path = join(bin, `${id}${extension}`);
    writeFileSync(path, 'fixture executable\n');
    if (!windows) chmodSync(path, 0o755);
  }
  const env: NodeJS.ProcessEnv = { PATH: bin };
  const argv = () => ['/fixture/node', '/fixture/hud/bin/hud.js', 'mcp'];
  const codex = new CodexMock();
  const service = (overrides: { env?: NodeJS.ProcessEnv; argv?: () => string[]; run?: typeof codex.run } = {}) => new ConnectionService({
    home,
    env: overrides.env ?? env,
    platform: process.platform,
    argv: overrides.argv ?? argv,
    run: overrides.run ?? codex.run.bind(codex),
  });
  return { root, home, bin, env, argv, codex, service };
}

function putJson(path: string, value: unknown): string {
  mkdirSync(join(path, '..'), { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, bytes);
  return bytes;
}

function backups(file: string): string[] {
  return readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}.hud-backup-`));
}

function codexConfig(home: string): string {
  const path = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(path, '# isolated Codex fixture\n');
  return path;
}

async function main() {
  {
    // Listing is read-only for JSON-backed clients and only asks Codex's injected runner.
    {
      const f = fixture('list');
      try {
        const claudePath = join(f.home, '.claude.json');
        const openCodePath = join(f.home, '.config', 'opencode', 'opencode.json');
        const claudeBytes = putJson(claudePath, { projects: { retained: true }, mcpServers: { hud: { type: 'stdio', command: 'old-node', args: ['old.js', 'mcp'] } } });
        const openCodeBytes = putJson(openCodePath, { theme: 'dark', mcp: { hud: { type: 'local', command: ['old'], enabled: true } } });
        const argv = f.argv();
        f.codex.registration = { enabled: true, transport: { type: 'stdio', command: argv[0]!, args: argv.slice(1) } };
        codexConfig(f.home);
        const rows = await f.service().list();
        assert.deepEqual(rows.map((row) => row.id), ['claude', 'codex', 'opencode']);
        assert(rows.every((row) => row.detected));
        assert.equal(readFileSync(claudePath, 'utf8'), claudeBytes);
        assert.equal(readFileSync(openCodePath, 'utf8'), openCodeBytes);
        assert.deepEqual(f.codex.calls, [['mcp', 'get', 'hud', '--json']], 'only Codex is launched, through the mock runner');
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    // Missing client executable remains unavailable even with an isolated empty PATH.
    {
      const f = fixture('missing');
      try {
        const status = await f.service({ env: { PATH: '' } }).status('claude');
        assert.equal(status.state, 'unavailable');
        assert.equal(status.detected, false);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    // Repair a stale Claude command, retain unrelated JSON, and keep a second connect idempotent.
    {
      const f = fixture('claude-repair');
      try {
        const path = join(f.home, '.claude.json');
        putJson(path, {
          projects: { retained: true },
          mcpServers: {
            hud: { type: 'stdio', command: 'old-node', args: ['old.js', 'mcp'] },
            other: { type: 'stdio', command: 'other', args: ['server'] },
          },
        });
        const service = f.service();
        assert.equal((await service.status('claude')).state, 'needs-repair');
        await service.change('claude', true);
        const repairedBytes = readFileSync(path, 'utf8');
        const repaired = JSON.parse(repairedBytes);
        assert.deepEqual(repaired.projects, { retained: true });
        assert.deepEqual(repaired.mcpServers.other, { type: 'stdio', command: 'other', args: ['server'] });
        assert.deepEqual([repaired.mcpServers.hud.command, ...repaired.mcpServers.hud.args], f.argv());
        assert.equal((await service.status('claude')).state, 'connected');
        const beforeRepeat = readFileSync(path, 'utf8');
        const backupCount = backups(path).length;
        await service.change('claude', true);
        assert.equal(readFileSync(path, 'utf8'), beforeRepeat, 'repeated connect does not rewrite configuration');
        assert.equal(backups(path).length, backupCount, 'repeated connect does not create another backup');
        const createdBackups = backups(path);
        assert(createdBackups.length >= 1, 'repair backs up an existing configuration');
        if (process.platform !== 'win32') {
          const mode = statSync(join(path, '..', createdBackups.at(-1)!)).mode & 0o777;
          assert.equal(mode, 0o600, 'backup permissions are private on POSIX');
        }
        await service.change('claude', false);
        const disconnected = JSON.parse(readFileSync(path, 'utf8'));
        assert.deepEqual(disconnected.mcpServers, { other: { type: 'stdio', command: 'other', args: ['server'] } }, 'disconnect removes only HUD');
        assert.deepEqual(disconnected.projects, { retained: true });
        assert.equal((await service.status('claude')).state, 'not-connected');
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    // Malformed JSON and non-object MCP settings fail closed without touching original bytes.
    for (const [name, bytes] of [
      ['malformed', '{"mcpServers": {\n'],
      ['nonobject', '{"mcpServers": []}\n'],
    ] as const) {
      const f = fixture(`claude-${name}`);
      try {
        const path = join(f.home, '.claude.json');
        mkdirSync(f.home, { recursive: true });
        writeFileSync(path, bytes);
        await assert.rejects(() => f.service().change('claude', true));
        assert.equal(readFileSync(path, 'utf8'), bytes);
        assert.equal((await f.service().status('claude')).state, 'error');
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    // OpenCode JSONC is surfaced as a repair error and is never rewritten.
    {
      const f = fixture('opencode-jsonc');
      try {
        const dir = join(f.home, '.config', 'opencode');
        mkdirSync(dir, { recursive: true });
        const jsonc = join(dir, 'opencode.jsonc');
        const bytes = '{\n  // keep this comment\n  "mcp": {}\n}\n';
        writeFileSync(jsonc, bytes);
        await assert.rejects(() => f.service().change('opencode', true), /JSONC/);
        assert.equal(readFileSync(jsonc, 'utf8'), bytes);
        assert.equal((await f.service().status('opencode')).state, 'error');
        assert.deepEqual(f.codex.calls, [], 'OpenCode inspection never launches a client process');
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    // Codex repairs a disabled registration with remove then one add, then verifies it.
    {
      const f = fixture('codex-disabled');
      try {
        const oldArgv = ['/previous/node', '/previous/hud.js', 'mcp'];
        f.codex.registration = { enabled: false, transport: { type: 'stdio', command: oldArgv[0]!, args: oldArgv.slice(1) } };
        const path = codexConfig(f.home);
        const service = f.service();
        assert.equal((await service.status('codex')).state, 'needs-repair');
        f.codex.calls = [];
        await service.change('codex', true);
        assert.deepEqual(f.codex.calls.map((args) => args.slice(0, 3)), [
          ['mcp', 'get', 'hud'],
          ['mcp', 'remove', 'hud'],
          ['mcp', 'add', 'hud'],
          ['mcp', 'get', 'hud'],
        ]);
        assert.deepEqual(f.codex.calls[2]!.slice(4), f.argv());
        assert.equal((await service.status('codex')).state, 'connected');
        assert(backups(path).length >= 1, 'Codex change backs up the existing config.toml');
        const callCount = f.codex.calls.length;
        await service.change('codex', true);
        assert.equal(f.codex.calls.length, callCount + 1, 'idempotent Codex connect only inspects current state');
        assert.equal(f.codex.calls.filter((args) => args[1] === 'remove').length, 1);
        assert.equal(f.codex.calls.filter((args) => args[1] === 'add').length, 1);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    // Known missing-server response means disconnected; other Codex CLI errors and timeouts surface as errors.
    {
      const f = fixture('codex-errors');
      try {
        codexConfig(f.home);
        const service = f.service();
        assert.equal((await service.status('codex')).state, 'not-connected');
        f.codex.getFailure = { code: 2, stdout: '', stderr: 'unexpected CLI failure' };
        assert.equal((await service.status('codex')).state, 'error');
        f.codex.getFailure = new Error('The coding CLI timed out');
        assert.equal((await service.status('codex')).state, 'error');
        f.codex.getFailure = null;
        f.codex.addFailure = { code: 1, stdout: '', stderr: 'refused' };
        await assert.rejects(() => service.change('codex', true), /could not register HUD/i);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    // Empty configs initialize normally; symlinked configs and targets remain untouched.
    {
      const f = fixture('empty-and-link');
      try {
        const path = join(f.home, '.claude.json');
        writeFileSync(path, '  \n');
        await f.service().change('claude', true);
        assert.equal((await f.service().status('claude')).state, 'connected');
        if (process.platform !== 'win32') {
          rmSync(path);
          const target = join(f.home, 'managed-by-dotfiles.json');
          const bytes = putJson(target, { mcpServers: {} });
          symlinkSync(target, path);
          await assert.rejects(f.service().change('claude', true), /symlinked/);
          assert.equal(lstatSync(path).isSymbolicLink(), true);
          assert.equal(readFileSync(target, 'utf8'), bytes);
          assert.equal((await f.service().status('claude')).state, 'error');
        }
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    // Runtime validation rejects IDs outside the fixed client set.
    {
      const f = fixture('invalid-id');
      try {
        const service = f.service();
        const invalid = 'other' as unknown as ClientId;
        await assert.rejects(() => service.status(invalid), /Unknown coding CLI/);
        await assert.rejects(() => service.change(invalid, true), /Unknown coding CLI/);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }

    console.log('PASS: isolated MCP connection listing, repair, idempotence, backup, disconnect, JSONC refusal, Codex CLI verification/errors, and ID validation.');
  }
}

await main();
