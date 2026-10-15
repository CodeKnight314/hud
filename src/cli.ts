import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asset, isElectron } from './assets.ts';
import { Hud } from './client.ts';
import type { SearchQuery } from './client.ts';
import { config } from './config.ts';
import { line } from './summary.ts';

/** open the canvas: the desktop app when running from it, otherwise the user's browser */
function openApp(url: string): void {
  if (isElectron()) {
    if (process.platform === 'darwin') {
      const i = process.execPath.indexOf('.app/Contents/MacOS/');
      if (i > 0) {
        spawn('open', ['-a', process.execPath.slice(0, i + 4)], { stdio: 'ignore', detached: true }).unref();
        return;
      }
    }
    // a second launch focuses the running app (single-instance lock) or starts it
    spawn(process.env.APPIMAGE || process.execPath, [], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, args, { stdio: 'ignore', detached: true }).unref();
}

/** one-line summary that uses KEY-n idents and resolves related ticket ids where the graph is present */
function brief(it: any): string {
  if (!it?.ident) return line(it);
  const names = new Map<string, string>();
  for (const k of ['blockedBy', 'blocks', 'refs', 'children']) for (const r of it.graph?.[k] ?? []) names.set(r.id, r.ident);
  if (it.graph?.parent) names.set(it.graph.parent.id, it.graph.parent.ident);
  return line(it, { ident: () => it.ident, name: (id: string) => names.get(id) ?? id });
}

const HELP = `hud — live canvas of tickets & monitors for humans and agents

usage:
  hud serve                          run the server in the foreground
  hud start | stop | open            background server / stop it / open the canvas in a browser
  hud status                         server health: pid, port, data dir, mode, last save error (never autostarts)
  hud ls [board]                     text overview (all boards, or one)
  hud ls tickets [board] [--status s,s] [--assignee a] [--project KEY] [--tag t] [--priority p] [--overdue] [--limit n]
                                     Linear-style ticket list, grouped by project and status (filtered)
  hud find <text...> [--board b] [--type t] [filters as above]   search items by text
  hud project [list]                 projects on a board (KEY, name, ticket count)
  hud project new <name> [--key EGO] [--lead @who] [--target 2026-01-31] [--body "…"]
  hud project set <id> --key NEW     rename a project and its tickets' idents
  hud add ticket "title" [--project EGO] [--parent EGO-1] [--blockedBy EGO-2] [--assignee me]
                                     [--priority high] [--status todo] [--target 2026-01-31] [--body "…"]
  hud link <id> [project=EGO] [parent=EGO-1] [blockedBy=EGO-2,EGO-3] [refs=EGO-4] [branch=regen]
                                     set a ticket's structure (validated: same board, no cycles)
  hud unlink <id> [parent blockedBy refs ...]     drop links (default: all of them)
  hud show <id>                      full JSON for an item (tickets include their graph)
  hud add <type> [title] [--k v...]  create ticket|monitor|note|frame|util
                                     (util: --kind timer|stopwatch|clock|counter|calculator|sheet|markdown|dice)
                                     (monitor: --display pie --plot.series gpu --plot.yMin 0)
  hud set <id> --k v [...]           patch fields
  hud push <id> [value] [--label "2/4 busy"] [--state s] [--message m] [--progress p]
           [--unit u] [--max n] [--warnBelow n] [--staleAfter s] [--group g] [--title t]
                                     report a monitor reading (creates/configures the monitor)
  hud watch <name> [ids...] [--board b] [--off]   wake session <name> on alerts from these monitors/board
  hud alerts [--ack] [--all]         list (and acknowledge) monitor alerts
  hud comment <id> <text...>         add a comment to a ticket
  hud comment edit <id> <cid> <text...> | hud comment rm <id> <cid>
  hud log <id> [--limit n]           the item's activity history
  hud ask <id> --option A --option B [--question "…"]
                                     propose choices on a ticket and block it until a human picks one
                                       (--options '[{"label":"A","detail":"…","status":"done"}]' for detail/status)
  hud decide <id> <optionId> [--note "…"]   record the choice
  hud finish [ids...] [--board b] [--note "…"] [--no-organize]
                                     mark items done and tidy the board (how an agent ends a run)
  hud run <id>                       run an automatic monitor now
  hud rm <id...>                     delete items (moved to the trash, recoverable)
  hud trash [--board b]              list deleted items;  hud restore <id>;  hud purge <id> | --all  (permanent)
  hud backup [--list] [--reason r]   snapshot the state (or list snapshots)
  hud export [file]                  full state as JSON (stdout, or a file)
  hud import <file> [--merge]        replace (default; a backup is taken first) or merge the state
  hud ping <id> [start|fail|<code>]  heartbeat for a cron-style monitor
  hud organize [board] [--auto on|off]
                                     group items into frames and tidy the board (--auto keeps it tidy)
  hud arrange [--board b] [--frame f]
  hud board [list|add <name>|rm <id>|rename <id> <name>]
  hud guide                          full guide (for agents)
  hud views [--json]                 chart renderer modules available to display:"view:<name>"
  hud mcp                            run the MCP server on stdio (what agents connect to)
  hud mcp install [clients...] [--dry-run]   wire hud into claude / codex / opencode / all
  hud mcp uninstall [clients...]     remove the hud MCP entry again
  hud mcp status                     show where hud is configured and which command is used
  hud mcp print [client]             print the command / config snippet to paste in by hand
  hud cli [install|uninstall|status] put the 'hud' command on PATH (from the desktop app)

every command takes --help; --json prints machine-readable output; '--' ends flag parsing;
use --flag=value for values that start with '-'. Exit codes: 0 ok, 1 failure, 2 usage error.
flags take dotted keys and JSON values:  --source.kind command --source.command "df -h /" --source.interval 30
                                         --tags a,b  --frame f1  --board infra
set HUD_ACTOR (or --as name) to label who made a change.

examples:
  hud add ticket "Fix flaky login test" --status doing --priority high --group CI --body "seen 3x on CI"
  hud add monitor "disk /" --id disk --source.kind command --source.command "df -P / | awk 'NR==2{print \\$5+0}'" --unit % --warnAbove 80
  hud push deploy --progress 40 --message "migrating db"`;


class UsageError extends Error {}

const BOOL = new Set(['json', 'ack', 'all', 'off', 'merge', 'list', 'overdue', 'dry-run', 'no-organize', 'help']);
const STR_KEYS = new Set(['command', 'title', 'body', 'text', 'message', 'id', 'label', 'group', 'name', 'key', 'lead', 'assignee', 'target', 'branch', 'project', 'parent', 'q', 'reason', 'note', 'question', 'board', 'frame']);
const FILTERS = ['board', 'type', 'status', 'priority', 'assignee', 'project', 'tag', 'overdue', 'limit', 'parent'];

function parseVal(v: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false' || v === 'null') return JSON.parse(v);
  if (/^[[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  return v;
}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') flags.help = true;
    else if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      let v: string | undefined = eq < 0 ? undefined : a.slice(eq + 1);
      if (v === undefined) {
        if (BOOL.has(k)) v = 'true';
        else {
          const n = argv[i + 1];
          v = n !== undefined && (!n.startsWith('-') || /^-\d/.test(n)) ? argv[++i] : 'true';
        }
      }
      const path = k.split('.');
      let o = flags;
      for (const p of path.slice(0, -1)) o = typeof o[p] === 'object' && o[p] ? o[p] : (o[p] = {});
      const key = path[path.length - 1];
      // repeated --option accumulates, so `hud ask t1 --option A --option B` works
      if (key === 'option') (flags.option ??= []).push(v);
      else o[key] = STR_KEYS.has(key) ? v : parseVal(v);
    } else pos.push(a);
  }
  return { pos, flags };
}

/** command table: usage line, positional count bounds, and allowed flags ('*' = free-form dotted fields) */
const CMDS: Record<string, { u: string; min?: number; max?: number; f: string[] | '*' }> = {
  serve: { u: 'hud serve', max: 0, f: [] },
  start: { u: 'hud start', max: 0, f: [] },
  stop: { u: 'hud stop', max: 0, f: [] },
  status: { u: 'hud status [--json]', max: 0, f: ['json'] },
  open: { u: 'hud open', max: 0, f: [] },
  ls: { u: 'hud ls [board] | hud ls tickets [board] [--status s,s] [--assignee a] [--project KEY] [--tag t] [--priority p] [--overdue] [--limit n] [--json]', max: 2, f: ['board', 'json', ...FILTERS] },
  tickets: { u: 'hud tickets [board] [--status s,s] [--assignee a] [--project KEY] [--tag t] [--priority p] [--overdue] [--limit n] [--json]', max: 1, f: ['board', 'json', ...FILTERS] },
  find: { u: 'hud find <text...> [--board b] [--type t] [--status s,s] [--assignee a] [--project KEY] [--tag t] [--priority p] [--overdue] [--limit n] [--json]', min: 1, f: ['json', ...FILTERS] },
  project: { u: 'hud project [list] | hud project new <name> [--key EGO] [--lead @who] [--target date] [--body text] | hud project set <id> --key NEW', f: '*' },
  link: { u: 'hud link <id> [project=EGO] [parent=EGO-1] [blockedBy=EGO-2,EGO-3] [refs=EGO-4] [branch=name]', min: 1, f: ['project', 'parent', 'blockedBy', 'refs', 'branch', 'json'] },
  unlink: { u: 'hud unlink <id> [parent blockedBy refs project ...]', min: 1, f: ['json'] },
  show: { u: 'hud show <id>', min: 1, max: 1, f: ['json'] },
  add: { u: 'hud add <type> [title] [--k v ...]   (types: ticket monitor note frame util project)', min: 1, f: '*' },
  set: { u: 'hud set <id> [status] --k v [...]', min: 1, f: '*' },
  push: { u: 'hud push <id> [value] [--label l] [--state s] [--message m] [--progress p] [--unit u] [--max n] [--warnBelow n] [--staleAfter s] [--group g] [--title t]', min: 1, max: 2, f: '*' },
  watch: { u: 'hud watch <name> [ids...] [--board b] [--off]', min: 1, f: ['board', 'off', 'json'] },
  alerts: { u: 'hud alerts [--ack] [--all] [--json]', max: 0, f: ['ack', 'all', 'json'] },
  comment: { u: 'hud comment <id> <text...> | hud comment edit <id> <cid> <text...> | hud comment rm <id> <cid>', min: 2, f: ['json'] },
  log: { u: 'hud log <id> [--limit n] [--json]', min: 1, max: 1, f: ['limit', 'json'] },
  ask: { u: 'hud ask <id> --option A --option B [--question q] [--options json]', min: 1, max: 1, f: ['option', 'options', 'question', 'json'] },
  decide: { u: 'hud decide <id> <optionId> [--note text]', min: 1, max: 2, f: ['optionId', 'note', 'json'] },
  finish: { u: 'hud finish [ids...] [--board b] [--note text] [--no-organize]', f: ['board', 'note', 'no-organize', 'json'] },
  run: { u: 'hud run <id>', min: 1, max: 1, f: ['json'] },
  rm: { u: 'hud rm <id...>', min: 1, f: ['json'] },
  trash: { u: 'hud trash [--board b] [--json]', max: 0, f: ['board', 'json'] },
  restore: { u: 'hud restore <id>', min: 1, max: 1, f: ['json'] },
  purge: { u: 'hud purge <id> | hud purge --all   (permanent)', max: 1, f: ['all', 'json'] },
  backup: { u: 'hud backup [--list] [--reason text]', max: 0, f: ['list', 'reason', 'json'] },
  export: { u: 'hud export [file]', max: 1, f: [] },
  import: { u: 'hud import <file> [--merge]', min: 1, max: 1, f: ['merge', 'json'] },
  ping: { u: 'hud ping <id> [start|fail|<code>]', min: 1, max: 2, f: ['json'] },
  organize: { u: 'hud organize [board] [--auto on|off]', max: 1, f: ['board', 'auto', 'json'] },
  arrange: { u: 'hud arrange [ids...] [--board b] [--frame f] [--width n]', f: ['board', 'frame', 'width', 'json'] },
  board: { u: 'hud board [list|add <name>|rm <id>|rename <id> <name>]', f: ['json'] },
  guide: { u: 'hud guide', max: 0, f: [] },
  views: { u: 'hud views [--json]', max: 0, f: ['json'] },
  mcp: { u: 'hud mcp | hud mcp install|uninstall|status|print [clients...] [--dry-run]', f: '*' },
  cli: { u: 'hud cli [install|uninstall|status]', max: 1, f: [] },
};
const ALIAS: Record<string, string> = { issues: 'tickets', get: 'show', new: 'add', update: 'set', delete: 'rm', tidy: 'organize', boards: 'board', projects: 'project', comments: 'comment' };

function detectActor() {
  if (process.env.HUD_ACTOR) return process.env.HUD_ACTOR;
  if (process.env.CLAUDECODE) return 'claude';
  if (Object.keys(process.env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  if (Object.keys(process.env).some((k) => k.startsWith('OPENCODE'))) return 'opencode';
  if (Object.keys(process.env).some((k) => k.startsWith('MUSE_'))) return 'muse';
  return 'cli';
}

/** strip control characters (terminal escapes, CR, NUL …) from text that came from item titles etc. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

/** a wrong pid is worse than none: only a process whose command line looks like a hud server counts */
function isHudServerPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === 'win32') return false;
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
    return /\bserve\b/.test(cmd) && /(server\.ts|hud\.mjs|hud\.js|\bhud\b)/.test(cmd);
  } catch {
    return false;
  }
}

async function stopServer(hud: Hud): Promise<string> {
  const info = await hud.healthInfo();
  if (info) {
    if (info.pid) {
      try {
        await hud.request('POST', '/api/shutdown');
      } catch {
        try {
          process.kill(info.pid, 'SIGTERM');
        } catch {}
      }
      return `stopped hud (pid ${info.pid})`;
    }
    await hud.request('POST', '/api/shutdown');
    return 'stopped hud';
  }
  // not answering: the pid file only counts if that pid really is a hud server
  const file = join(config().dataDir, 'hud.pid');
  let pid = NaN;
  try {
    pid = Number(readFileSync(file, 'utf8').trim());
  } catch {}
  if (isHudServerPid(pid)) {
    process.kill(pid, 'SIGTERM');
    return `stopped hud (pid ${pid})`;
  }
  return Number.isNaN(pid) ? 'hud is not running' : `hud is not running (ignored stale pid file: pid ${pid} is not a hud server)`;
}

async function main() {
  const argv = process.argv.slice(2);
  const { pos, flags } = parseArgs(argv);
  const [first, ...rest] = pos;
  const cmd = first === undefined ? undefined : ALIAS[first] ?? first;
  if (cmd === undefined || cmd === 'help') {
    const sub = rest[0] && (ALIAS[rest[0]] ?? rest[0]);
    if (sub && CMDS[sub]) return void console.log(CMDS[sub].u);
    return void console.log(HELP);
  }
  const spec = CMDS[cmd];
  if (!spec) throw new UsageError(`unknown command "${first}" — run: hud help`);
  if (flags.help) return void console.log(`usage: ${spec.u}`);
  const json = !!flags.json;
  const actor = typeof flags.as === 'string' ? flags.as : detectActor();
  delete flags.as;
  delete flags.json;
  if (spec.f !== '*') {
    const bad = Object.keys(flags).filter((k) => !(spec.f as string[]).includes(k));
    if (bad.length) throw new UsageError(`unknown flag${bad.length > 1 ? 's' : ''} ${bad.map((k) => '--' + k).join(', ')} for "hud ${cmd}"; valid: ${(spec.f as string[]).map((k) => '--' + k).join(' ') || '(none)'}`);
  }
  if (rest.length < (spec.min ?? 0) || (spec.max !== undefined && rest.length > spec.max)) throw new UsageError(rest.length < (spec.min ?? 0) ? `missing argument for "hud ${cmd}"` : `too many arguments for "hud ${cmd}"`);

  const hud = new Hud({ actor });
  /** print text (control characters stripped), or the data as JSON under --json */
  const emit = (data: unknown, text?: string) => console.log(json || text === undefined ? (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) : clean(text));
  const raw = (s: string) => console.log(s);
  const filters = () => {
    const q: Record<string, unknown> = {};
    for (const k of FILTERS) if (flags[k] !== undefined) q[k] = flags[k];
    return q as SearchQuery;
  };

  switch (cmd) {
    case 'serve':
      await import('./server.ts');
      return;
    case 'start':
      await hud.ensureServer();
      return emit({ url: hud.url }, `hud running at ${hud.url}`);
    case 'stop': {
      const msg = await stopServer(new Hud({ actor, autostart: false }));
      return emit({ message: msg }, msg);
    }
    case 'status': {
      const info = await new Hud({ actor, autostart: false }).healthInfo();
      if (!info) {
        process.exitCode = 1;
        return emit({ running: false, url: hud.url }, `hud is not running at ${hud.url}`);
      }
      return emit(info, [`hud running at ${hud.url}`, `  pid ${info.pid}  port ${info.port}  mode ${info.mode}  version ${info.version ?? '?'}`, `  data ${info.dataDir ?? '?'}  items ${info.items ?? '?'}`, info.saveError ? `  SAVE ERROR: ${info.saveError}` : '  saves ok'].join('\n'));
    }
    case 'open':
      await hud.ensureServer();
      openApp(hud.url);
      return emit({ url: hud.url }, hud.url);
    case 'ls':
    case 'tickets': {
      // `hud ls tickets` reads the Linear list; plain `hud ls` keeps the canvas overview
      const isT = cmd === 'tickets' || rest[0] === 'tickets' || rest[0] === 'issues';
      if (isT) {
        const board = flags.board ?? (cmd === 'tickets' ? rest[0] : rest[1]) ?? 'main';
        return json ? emit(await hud.tickets(board, filters())) : emit(await hud.ticketTree(board, filters()), await hud.ticketTree(board, filters()));
      }
      if (json) return emit(await hud.items({ board: rest[0] ?? flags.board }));
      const text = await hud.summary(rest[0] ?? flags.board);
      return emit(text, text);
    }
    case 'find': {
      const found = await hud.search({ ...filters(), q: rest.join(' ') });
      return emit(found, found.length ? found.map((i: any) => brief(i)).join('\n') : 'no matches');
    }
    case 'project': {
      if (!rest.length || rest[0] === 'list') {
        const list = await hud.projects(flags.board);
        if (json) return emit(list);
        if (!list.length) return emit(list, `no projects on board ${flags.board ?? 'main'} — create one: hud project new "Eng org"`);
        return emit(list, list.map((g) => `${g.key}  ${g.name}${g.project?.target ? ` → ${g.project.target}` : ''}${g.project?.lead ? ` @${g.project.lead}` : ''}  (${g.total} tickets)  id=${g.project?.id}`).join('\n'));
      }
      const [sub, ...name] = rest;
      if (sub === 'new' || sub === 'add' || sub === 'create') {
        const title = flags.title ?? name.join(' ');
        if (!title) throw new UsageError('missing project name');
        const p = await hud.create({ type: 'project', title, key: flags.key, board: flags.board, body: flags.body, lead: flags.lead, target: flags.target });
        return emit(p, `created project ${p.key} "${p.title}" (${p.id})`);
      }
      if (sub === 'set' || sub === 'update') {
        const id = name[0] ?? flags.id;
        if (!id) throw new UsageError('missing project id');
        const patch = { ...flags };
        delete patch.id;
        const p = await hud.update(id, patch);
        return emit(p, `updated project ${p.key} "${p.title}"`);
      }
      throw new UsageError(`unknown project command "${sub}"`);
    }
    case 'link': {
      const [id, ...pairs] = rest;
      const patch: Record<string, unknown> = { ...flags };
      for (const p of pairs) {
        const i = p.indexOf('=');
        if (i < 0) throw new UsageError(`expected key=value, got "${p}"`);
        const k = p.slice(0, i);
        if (!['project', 'parent', 'blockedBy', 'refs', 'branch'].includes(k)) throw new UsageError(`unknown link key "${k}"; valid: project parent blockedBy refs branch`);
        const v = p.slice(i + 1);
        patch[k] = k === 'project' || k === 'parent' || k === 'branch' ? v : v.split(',').filter(Boolean);
      }
      for (const k of ['blockedBy', 'refs'])
        if (typeof patch[k] === 'string') patch[k] = String(patch[k]).split(',').filter(Boolean);
      const t = (await hud.link(id, patch as any)) as any;
      const waiting = (t.graph?.blockedBy ?? []).map((r: any) => r.ident).join(', ');
      return emit(t, [brief(t), `  ⎇ ${t.branch ?? '—'}`, waiting && `  waiting on ${waiting}`].filter(Boolean).join('\n'));
    }
    case 'unlink': {
      const keys = rest.slice(1);
      const ok = ['project', 'parent', 'blockedBy', 'refs'];
      const bad = keys.filter((k) => !ok.includes(k));
      if (bad.length) throw new UsageError(`unknown link kind ${bad.join(', ')}; valid: ${ok.join(' ')}`);
      const t = await hud.unlink(rest[0], (keys.length ? keys : ['parent', 'blockedBy', 'refs']) as any);
      return emit(t, `unlinked ${brief(t)}`);
    }
    case 'show': {
      const it = await hud.get(rest[0]);
      return raw(JSON.stringify(it, null, 2));
    }
    case 'add': {
      const [type, ...title] = rest;
      const it = await hud.create({ type: type as any, title: flags.title ?? title.join(' '), ...flags });
      return emit(it, `created ${brief(it)}`);
    }
    case 'set': {
      const it = await hud.update(rest[0], { ...flags, ...(rest[1] ? { status: rest[1] } : {}) });
      return emit(it, `updated ${brief(it)}`);
    }
    case 'push': {
      const [id, value] = rest;
      const r: any = { ...flags };
      if (value !== undefined) r.value = parseVal(value);
      const it = await hud.push(id, r);
      return emit(it, brief(it));
    }
    case 'watch': {
      const [name, ...ids] = rest;
      const r = await hud.request('POST', '/api/watch', { name, ids, boards: flags.board ? [flags.board] : [], off: !!flags.off });
      return emit(r, `${r.off ? 'unwatched' : 'watching'} as ${name}: ${[...r.ids, ...r.boards.map((b: string) => 'board ' + b)].join(', ')}`);
    }
    case 'alerts': {
      const list: any[] = await hud.request('GET', `/api/alerts${flags.all ? '?all=1' : ''}`);
      if (flags.ack && list.length) await hud.request('POST', '/api/alerts/ack', { ids: list.map((a) => a.id) });
      const lines = list.map((a) => `[${a.id}] ${new Date(a.t).toLocaleString()} ${a.itemId} ${a.from} → ${a.to}${a.value != null ? ` (${a.value})` : ''}${a.message ? `: ${a.message}` : ''}`);
      return emit(list, list.length ? [...lines, flags.ack ? `acknowledged ${list.length}` : ''].filter(Boolean).join('\n') : 'no alerts');
    }
    case 'comment': {
      const [a, b, c] = rest;
      if (a === 'rm' || a === 'delete') {
        if (!b || !c) throw new UsageError('usage: hud comment rm <id> <cid>');
        return emit(await hud.deleteComment(b, c), `deleted comment ${c} on ${b}`);
      }
      if (a === 'edit') {
        const text = rest.slice(3).join(' ');
        if (!b || !c || !text) throw new UsageError('usage: hud comment edit <id> <cid> <text...>');
        return emit(await hud.editComment(b, c, text), `edited comment ${c} on ${b}`);
      }
      const text = rest.slice(1).join(' ');
      if (!text.trim()) throw new UsageError('usage: hud comment <id> <text...>');
      return emit(await hud.comment(a, text), `commented on ${a}`);
    }
    case 'log': {
      const list = await hud.activityOf(rest[0], flags.limit);
      return emit(list, list.length ? list.map((a: any) => `${new Date(a.t).toLocaleString()}  ${a.actor}  ${a.action}  ${a.text}`).join('\n') : 'no activity');
    }
    case 'ask': {
      const arr = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
      const list = [...arr(flags.option), ...arr(flags.options).flat()].map((o) => (typeof o === 'string' ? { label: o } : (o as { label: string })));
      if (!list.length) throw new UsageError('hud ask needs at least one --option');
      const tk = (await hud.ask(rest[0], list, flags.question)) as { id: string; ident?: string; status?: string; question?: string; options?: { id: string; label: string; status?: string }[] };
      return emit(tk, `${tk.ident ?? tk.id} ${tk.status} — needs a decision${tk.question ? `: ${tk.question}` : ''}\n${(tk.options ?? []).map((o) => `  ${o.id}  ${o.label}${o.status ? ` [→${o.status}]` : ''}`).join('\n')}`);
    }
    case 'decide': {
      const optionId = rest[1] ?? flags.optionId;
      if (optionId === undefined) throw new UsageError('usage: hud decide <id> <optionId>');
      const tk = (await hud.decide(rest[0], String(optionId), flags.note)) as { id: string; ident?: string; status?: string };
      return emit(tk, `decided ${tk.ident ?? tk.id} → ${tk.status}`);
    }
    case 'finish': {
      const r = await hud.finish({ board: flags.board, ids: rest.length ? rest : undefined, note: flags.note, organize: flags['no-organize'] ? false : undefined });
      return emit(r, r.done.length ? `finished ${r.board}: ${r.done.join(', ')}` : `finished ${r.board}: nothing left to complete`);
    }
    case 'run': {
      const it = await hud.run(rest[0]);
      return emit(it, line(it));
    }
    case 'rm': {
      const out = [];
      for (const id of rest) {
        const it = await hud.remove(id);
        out.push(it);
        if (!json) emit(it, `deleted ${line(it)}`);
      }
      return json ? emit(out) : undefined;
    }
    case 'trash': {
      const list = await hud.trash(flags.board);
      return emit(list, list.length ? list.map((e: any) => `${e.item.ident ?? e.item.id}  ${e.item.type}  "${e.item.title ?? ''}"  by ${e.actor}  ${new Date(e.t).toLocaleString()}  id=${e.item.id}`).join('\n') : 'trash is empty');
    }
    case 'restore': {
      const it = await hud.restore(rest[0]);
      return emit(it, `restored ${brief(it)}`);
    }
    case 'purge': {
      if (!rest[0] && !flags.all) throw new UsageError('usage: hud purge <id> | hud purge --all');
      const r = await hud.purge(flags.all ? 'all' : rest[0]);
      return emit(r, `purged ${r.purged} item(s)`);
    }
    case 'backup': {
      if (flags.list) {
        const list = await hud.backups();
        return emit(list, list.length ? list.map((b: any) => (typeof b === 'string' ? b : `${b.name}${b.bytes != null ? `  ${b.bytes}b` : ''}${b.t ? `  ${new Date(b.t).toLocaleString()}` : ''}`)).join('\n') : 'no backups');
      }
      const r = await hud.backup(flags.reason);
      return emit(r, `backup written: ${r.name}`);
    }
    case 'export': {
      const st = await hud.exportState();
      if (rest[0]) {
        writeFileSync(rest[0], JSON.stringify(st, null, 2));
        return emit({ file: rest[0] }, `exported to ${rest[0]}`);
      }
      return raw(JSON.stringify(st, null, 2));
    }
    case 'import': {
      let st: unknown;
      try {
        st = JSON.parse(readFileSync(rest[0], 'utf8'));
      } catch (e) {
        throw new Error(`cannot read ${rest[0]}: ${(e as Error).message}`);
      }
      const r = await hud.importState(st, flags.merge ? 'merge' : 'replace');
      return emit(r, `imported (${flags.merge ? 'merge' : 'replace'}): ${r.items ?? '?'} items, ${r.boards ?? '?'} boards${r.backup ? `; previous state backed up as ${r.backup}` : ''}`);
    }
    case 'ping': {
      const r = await hud.ping(rest[0], rest[1]);
      return emit(r, String(r).trim() || 'ok');
    }
    case 'organize': {
      const a = flags.auto;
      const auto = a === undefined ? undefined : a === true || a === 'on' || a === 'true';
      const r = await hud.organize(rest[0] ?? flags.board, auto);
      return emit(r, `organized: ${r.groups.length} groups (${r.groups.join(', ') || 'none'}), ${r.moved} moved${auto !== undefined ? `; auto ${auto ? 'on' : 'off'}` : ''}`);
    }
    case 'arrange': {
      const r = await hud.arrange({ ...flags, ids: rest.length ? rest : undefined });
      return emit(r, `arranged ${r.length} items`);
    }
    case 'board': {
      const [sub, a, ...b] = rest;
      if (!sub || sub === 'list' || sub === 'ls') {
        const list = await hud.boards();
        return emit(list, list.map((x) => `${x.id}  "${x.name}"`).join('\n'));
      }
      if (sub === 'add' || sub === 'create') {
        if (!a) throw new UsageError('usage: hud board add <name>');
        return emit(await hud.createBoard([a, ...b].join(' ')));
      }
      if (sub === 'rename') {
        if (!a || !b.length) throw new UsageError('usage: hud board rename <id> <name>');
        return emit(await hud.request('PATCH', `/api/boards/${encodeURIComponent(a)}`, { name: b.join(' ') }));
      }
      if (sub === 'rm' || sub === 'delete') {
        if (!a) throw new UsageError('usage: hud board rm <id>');
        return emit(await hud.request('DELETE', `/api/boards/${encodeURIComponent(a)}`));
      }
      throw new UsageError(`unknown board command "${sub}"`);
    }
    case 'guide':
      return raw((asset('GUIDE.md', 'utf8') ?? '').replaceAll('{{PORT}}', String(config().port)));
    case 'views': {
      const { dir, views } = await hud.views();
      if (json) return emit(views);
      if (!views.length) return emit(views, `no renderer modules in ${dir}\nadd an ES module exporting render(ctx), then use display: "view:<name>"`);
      return emit(views, `renderer modules in ${dir}:\n` + views.map((v) => `  ${v.name.replace(/\.js$/, '')}  ${new Date(v.mtime).toLocaleString()}  ${v.bytes}b`).join('\n'));
    }
    case 'mcp': {
      const sub = rest[0];
      if (sub) {
        const { mcpCommand } = await import('./mcpinstall.ts');
        process.exitCode = mcpCommand(sub, rest.slice(1), flags);
        return;
      }
      await import('./mcp.ts');
      return;
    }
    case 'cli': {
      const sub = rest[0] ?? 'status';
      const { installCli, uninstallCli, cliStatus } = await import('./cliinstall.ts');
      if (sub === 'install') return raw(installCli());
      if (sub === 'uninstall') return raw(uninstallCli());
      if (sub === 'status') return raw(cliStatus());
      throw new UsageError(`unknown cli subcommand "${sub}" — try: hud cli install | uninstall | status`);
    }
  }
}

// a closed pipe (`hud ls | head`) is not an error
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(`hud: ${e.message}`);
    process.exit(2);
  }
  console.error(`hud: ${clean(String(e?.message ?? e))}`);
  process.exit(1);
});
