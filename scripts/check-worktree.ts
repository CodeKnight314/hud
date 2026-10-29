// Ticket worktrees: `hud claim <id> --worktree` / `hud_claim {worktree:true}` run git in the client, after the claim.
// Boots a scratch server unless --url names an existing loopback scratch server.
//   node scripts/check-worktree.ts
//   node scripts/check-worktree.ts --url http://127.0.0.1:7419
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTicketWorktree, Hud, worktreeText } from '../src/client.ts';
import type { TicketWorktree } from '../src/client.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const urlArg = process.argv.indexOf('--url');
const external = urlArg >= 0 ? (process.argv[urlArg + 1] ?? '').replace(/\/$/, '') : '';
if (external) {
  const u = new URL(external);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname) || [7317, 7417, 7418].includes(Number(u.port))) {
    throw new Error('use an explicit scratch loopback URL (not 7317, 7417 or 7418)');
  }
}

// The repo under test is the temp one: an inherited GIT_DIR would point every git call elsewhere.
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete process.env[k];
// .native expands Windows 8.3 short names (RUNNER~1), so paths match what git prints.
const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'hud-worktree-')));
// The cd line quotes a path the shell would split or escape (every Windows path, for its backslashes).
const cdLine = (p: string) => `cd ${/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`}`;
// git must not find a repo above the temp dir, or the non-git case would pass through it
process.env.GIT_CEILING_DIRECTORIES = tmp;
const git = (args: string[], cwd: string) => execFileSync('git', ['-c', 'user.name=hud-check', '-c', 'user.email=hud-check@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = join(tmp, 'repo');
const plain = join(tmp, 'plain');
mkdirSync(join(repo, 'sub'), { recursive: true });
mkdirSync(plain);
git(['init', '-q'], repo);
git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

const dataDir = external ? '' : join(tmp, 'data');
const port = external ? new URL(external).port : String(await freePort());
const base = external || `http://127.0.0.1:${port}`;
const scratchEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HUD_SCRATCH: '1',
  HUD_PORT: port,
  HUD_URL: base,
  ...(dataDir ? { HUD_DATA: dataDir, HUD_PROBES: join(dataDir, 'probes'), HUD_VIEWS: join(dataDir, 'views') } : {}),
};
let server: ReturnType<typeof spawn> | undefined;
let serverLog = '';
if (!external) {
  mkdirSync(join(dataDir, 'probes'), { recursive: true });
  mkdirSync(join(dataDir, 'views'), { recursive: true });
  server = spawn(process.execPath, [join(root, 'src/server.ts')], { cwd: root, env: scratchEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', (d) => (serverLog += d));
  server.stderr!.on('data', (d) => (serverLog += d));
}

function cli(args: string[], cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin/hud.js'), ...args], { cwd, env: { ...scratchEnv, HUD_ACTOR: 'worktree-check' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** initialize, then the given calls; resolves with each reply by id */
function mcp(cwd: string, calls: { id: number; method: string; params: unknown }[]): Promise<Map<number, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'src/mcp.ts')], { cwd, env: { ...scratchEnv, HUD_ACTOR: 'worktree-check' } });
    const replies = new Map<number, any>();
    let buf = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP timed out\n${err}`)); }, 20000);
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) replies.set(msg.id, msg);
      }
      if (calls.every((c) => replies.has(c.id))) {
        clearTimeout(timer);
        child.kill();
        resolve(replies);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'worktree-check' } } }) + '\n');
    for (const c of calls) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...c }) + '\n');
  });
}

const okTree = (w: TicketWorktree) => {
  assert.ok(w.ok, `worktree failed: ${w.ok ? '' : w.error}`);
  return w;
};
const head = (dir: string) => git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
const tag = Math.random().toString(36).slice(2, 6);

try {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const h = await (await fetch(`${base}/api/health`)).json();
      if (h?.name === 'hud') break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`scratch server did not come up at ${base}\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const admin = new Hud({ url: base, actor: 'worktree-check', autostart: false });
  const key = `WT${tag.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`.slice(0, 6);
  await admin.createProject({ name: `Worktree check ${tag}`, key });
  const ticket = async (title: string) => (await admin.create({ type: 'ticket', title, project: key } as any)) as any;
  const pathFor = (ident: string) => join(tmp, `repo-${ident.toLowerCase()}`);

  // 1. New branch: the path is <parent of root>/<root name>-<ident>, on the ticket's generated branch.
  const a = new Hud({ url: base, actor: 'worktree-check', session: `wt-a-${tag}`, autostart: false });
  const t1 = await ticket('Parse trailing commas');
  const c1 = await a.claim(t1.ident ?? `${key}-1`, { start: true });
  const full1 = (await a.get(c1.ticket)) as any;
  assert.ok(full1.branch, 'a ticket gets a generated branch');
  const w1 = okTree(await ensureTicketWorktree(a, c1.ident, repo));
  assert.equal(w1.path, pathFor(c1.ident));
  assert.equal(w1.branch, full1.branch);
  assert.equal(w1.reused, false);
  assert.equal(w1.newBranch, true);
  assert.equal(head(w1.path), full1.branch, 'the worktree is on the ticket branch');
  const text1 = worktreeText(w1);
  assert.ok(text1.includes(`worktree ${w1.path} created on new branch ${full1.branch}`), text1);
  assert.equal(text1.split('\n').at(-1), cdLine(w1.path));

  // 2. Reuse: a second call, from a subdirectory and by uuid, finds the same worktree and says so.
  const again = okTree(await ensureTicketWorktree(a, c1.ticket, join(repo, 'sub')));
  assert.equal(again.path, w1.path);
  assert.equal(again.reused, true);
  assert.match(worktreeText(again), /reused: already a worktree of .* on branch /);
  assert.equal(worktreeText(again).split('\n').at(-1), cdLine(w1.path));

  // 3. An existing local branch is checked out, not recreated.
  const b = new Hud({ url: base, actor: 'worktree-check', session: `wt-b-${tag}`, autostart: false });
  const t2 = await ticket('Reuse an existing branch');
  const existing = `wt-existing-${tag}`;
  git(['branch', existing], repo);
  await admin.link(t2.id, { branch: existing });
  const c2 = await b.claim(t2.id);
  const w2 = okTree(await ensureTicketWorktree(b, c2.ident, repo));
  assert.equal(w2.branch, existing);
  assert.equal(w2.newBranch, false);
  assert.equal(head(w2.path), existing);
  assert.match(worktreeText(w2), /created on existing branch /);

  // 4. A path that is a worktree on another branch is refused, not reused.
  await admin.link(t2.id, { branch: `wt-other-${tag}` });
  const wrong = await ensureTicketWorktree(b, c2.ident, repo);
  assert.equal(wrong.ok, false);
  assert.match(wrong.ok ? '' : wrong.error, new RegExp(`on branch ${existing}, not wt-other-${tag}`));

  // 5. A non-git cwd and a non-worktree path report an error; the claim stays held.
  const c = new Hud({ url: base, actor: 'worktree-check', session: `wt-c-${tag}`, autostart: false });
  const t3 = await ticket('Not in a repository');
  const c3 = await c.claim(t3.id, { start: true });
  const nogit = await ensureTicketWorktree(c, c3.ident, plain);
  assert.equal(nogit.ok, false);
  assert.match(nogit.ok ? '' : nogit.error, /is not in a git repository/);
  assert.match(worktreeText(nogit), /^worktree not created: .*\nThe claim on .* stands; it was not released\.$/);
  mkdirSync(pathFor(c3.ident));
  const taken = await ensureTicketWorktree(c, c3.ident, repo);
  assert.match(taken.ok ? '' : taken.error, /already exists and is not a worktree of /);
  const held3 = await admin.claimOf(t3.id);
  assert.equal(held3?.session, `wt-c-${tag}`, 'the claim survives a worktree failure');
  assert.equal(held3?.live, true);

  // 6. No branch on the ticket: the lowercased ident; a project-less #12 becomes t12.
  const stub = (ident: string) => ({ get: async () => ({ id: `stub-${ident}`, type: 'ticket', ident }) }) as unknown as Hud;
  const bare = okTree(await ensureTicketWorktree(stub(`${key}-99`), `${key}-99`, repo));
  assert.equal(bare.branch, `${key}-99`.toLowerCase());
  assert.equal(bare.path, pathFor(`${key}-99`));
  const loose = okTree(await ensureTicketWorktree(stub('#12'), '#12', repo));
  assert.equal(loose.branch, 't12');
  assert.equal(loose.path, join(tmp, 'repo-t12'));

  // 7. CLI: --worktree prints the claim, the path and branch, then cd; outside git it still exits 0 holding the claim.
  const t4 = await ticket('Claim from the CLI');
  const run4 = await cli(['claim', t4.ident ?? t4.id, '--start', '--worktree', '--session', `wt-cli-${tag}`], repo);
  assert.equal(run4.code, 0, run4.err || run4.out);
  const full4 = (await admin.get(t4.id)) as any;
  const p4 = pathFor(full4.ident);
  assert.ok(run4.out.includes(`claimed by wt-cli-${tag}`), run4.out);
  assert.ok(run4.out.includes(`worktree ${p4} created on new branch ${full4.branch}`), run4.out);
  assert.equal(run4.out.trimEnd().split('\n').at(-1), cdLine(p4));
  assert.equal(head(p4), full4.branch);
  const t6 = await ticket('CLI outside git');
  const run6 = await cli(['claim', t6.id, '--worktree', '--session', `wt-cli2-${tag}`, '--json'], plain);
  assert.equal(run6.code, 0, run6.err || run6.out);
  const j6 = JSON.parse(run6.out);
  assert.equal(j6.worktree.ok, false);
  assert.match(j6.worktree.error, /is not in a git repository/);
  assert.equal((await admin.claimOf(t6.id))?.session, `wt-cli2-${tag}`);
  const bad = await cli(['claim', 'status', t6.id, '--worktree'], repo);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--worktree goes with hud claim <id>/);

  // 8. MCP: the schema advertises worktree, and the call runs git in the MCP process's cwd.
  const t5 = await ticket('Claim from MCP');
  const replies = await mcp(repo, [
    { id: 1, method: 'tools/list', params: {} },
    { id: 2, method: 'tools/call', params: { name: 'hud_claim', arguments: { ticket: t5.id, start: true, worktree: true } } },
  ]);
  const claimTool = replies.get(1).result.tools.find((t: { name: string }) => t.name === 'hud_claim');
  assert.equal(claimTool.inputSchema.properties.worktree.type, 'boolean');
  assert.match(claimTool.description, /worktree:true/);
  const r5 = replies.get(2).result;
  assert.notEqual(r5.isError, true, r5.content?.[0]?.text);
  const full5 = (await admin.get(t5.id)) as any;
  const p5 = pathFor(full5.ident);
  const out5: string = r5.content[0].text;
  assert.ok(out5.includes(`${full5.ident} "Claim from MCP" claimed by `), out5);
  assert.ok(out5.includes(`worktree ${p5} created on new branch ${full5.branch}`), out5);
  assert.ok(out5.trimEnd().split('\n').includes(cdLine(p5)), out5);
  assert.equal(head(p5), full5.branch);
  assert.ok(existsSync(join(p5, '.git')));

  // leave an external server's board without leases from this run
  for (const [h, id] of [[a, t1.id], [b, t2.id], [c, t3.id]] as const) await h.releaseClaim(id).catch(() => {});
} finally {
  if (server) {
    await fetch(`${base}/api/shutdown`, { method: 'POST' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    if (server.exitCode === null) server.kill('SIGTERM');
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log('PASS ticket worktrees: path and branch, reuse, existing branch, wrong branch, non-git cwd keeps the claim, CLI and MCP');
