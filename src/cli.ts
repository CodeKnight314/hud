import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isBundle, isElectron } from './assets.ts';
import { guideText, quickstartText } from './docs.ts';
import { coordinationDoc, GuideError, renderGuide } from './guide.ts';
import { guiLaunchEnv } from './electron-runtime.ts';
import { Hud } from './client.ts';
import { applyAttachment } from './apply.ts';
import type { ProgramAction, SearchQuery } from './client.ts';
import { config } from './config.ts';
import { appDir, fetchBundle, installedVersion, installRoot, releaseInfo as cliRelease, swapApp, unpackBundle } from './install.ts';
import { compareVersions } from './updates.ts';
import { formatMonitorTemplateList, listMonitorTemplates } from './monitor-templates.ts';
import { line } from './summary.ts';
import { formatViewReview } from './views.ts';

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
    spawn(process.env.APPIMAGE || process.execPath, [], { stdio: 'ignore', detached: true, env: guiLaunchEnv() }).unref();
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
  hud                                start the server if needed and open the canvas in your browser
  hud serve                          run the server in the foreground
  hud start | stop | open            background server / stop it / open the canvas in a browser
  hud update [--check]               replace this curl install with the latest release (verified)
  hud status                         server health: pid, port, data dir, mode, save error, recovered backup (never autostarts)
  hud reveal                         open the data directory in the file manager
  hud ls [board]                     text overview (all boards, or one)
  hud ls tickets [board] [--status s,s] [--assignee a] [--owner o] [--project KEY] [--tag t] [--priority p] [--overdue] [--limit n]
                                     Linear-style ticket list, grouped by project and status (filtered). Each row shows assignee and claimer.
  hud find <text...> [--board b] [--type t] [filters as above]   search items by text
  hud project [list]                 projects on a board (KEY, name, ticket count)
  hud project new <name> [--key EGO] [--lead @who] [--target 2026-01-31] [--body "…"]
  hud project set <id> --key NEW     rename a project and its tickets' idents
  hud tree [board] [--project KEY]   nested ticket tree
  hud tree move <id> [--parent EGO-1] [--project KEY]   reparent a ticket and/or move it into a project
  hud tree detach <id>               clear a ticket's parent
  hud add ticket "title" [--project EGO] [--parent EGO-1] [--blockedBy EGO-2] [--assignee me]
                                     [--priority high] [--status todo] [--target 2026-01-31] [--body "…"]
  hud link <id> [project=EGO] [parent=EGO-1] [blockedBy=EGO-2,EGO-3] [refs=EGO-4] [branch=regen]
                                     set a ticket's structure (validated: same board, no cycles)
  hud unlink <id> [parent blockedBy refs ...]     drop links (default: all of them)
  hud show <id>                      full JSON for an item (tickets include their graph)
  hud add <type> [title] [--k v...]  create ticket|monitor|note|frame|util
                                     (util: --kind timer|stopwatch|clock|counter|calculator|sheet|markdown|dice)
                                     (monitor: --display pie --plot.series gpu --plot.yMin 0)
  hud add monitor --template         list built-in monitor templates (disk, tls, http, cron-heartbeat)
  hud add monitor --template <id> [--host name]
                                     create one from a template (safe defaults; docs links in the list)
  hud set <id> --k v [...]           patch fields
  hud push <id> [value] [--label "2/4 busy"] [--state s] [--message m] [--messageFormat plain|markdown] [--details md] [--progress p]
           [--unit u] [--max n] [--warnBelow n] [--staleAfter s] [--group g] [--title t]
                                     report a monitor reading (creates/configures the monitor)
  hud watch <name> [ids...] [--board b] [--off]   wake session <name> on alerts from these monitors/board
  hud alerts [--ack] [--all]         list (and acknowledge) monitor alerts
  hud attention [review|unreview|snooze <id>] [--revision v] [--until ms|--minutes n]
                                     list or review human-attention items (separate from agent alert ack)
  hud runs                           list run summaries and linked monitors/tickets
  hud queue [board] [--status s,s] [--project KEY] [--assignee a] [--owner o] [--all] [--limit n]
                                     work queue: open, claimed and done tickets with owner and session state
  hud session [start|heartbeat|end|list] [name] [--kind agent|cli|human] [--run EGO-1]
                                     register presence for coordination (default: list)
  hud claim <id> [--session s] [--ttl sec] [--start] [--takeover]
                                     take an exclusive lease on a ticket; --start also moves it to doing
  hud claim status <id>              the lease on one ticket (holder, expiry, live)
  hud claim list [--session s] [--board b] [--all]   this session's leases; --all lists every lease
  hud claim renew <id> [--ttl sec]   extend the lease this session already holds
  hud release <id> [--session s] [--reason text]   release a claim
  hud context read [--scope run:<uuid>] [--since n] [--kind FACT,FAIL] [--limit n] [--peek] [--session s]
  hud context publish --scope run:<uuid> --kind FACT --text "…" [--data JSON] [--refs EGO-2] [--attach ID] [--corrects ID]
                                     append a typed finding to the shared context (never edit; publish a correction)
  hud context scopes [--board b]     list scopes with entries and last activity
  hud context export <run>           snapshot a finished run's context and attachments to backups/
  hud context exports [run]          list those snapshots
  hud attach list [--scope s] [--board b] | hud attach add <file> [--scope s] [--target path] [--base id]
  hud attach get|content|expand <id> | hud attach apply <id> --target path [--expected sha] [--create]
  hud attach rm <id> [--force]        share files by reference; apply writes a local file with conflict checks
  hud wait [--scope run:<uuid>] [--ticket EGO-3] [--sessions peer] [--kinds context,claim,session]
           [--since n] [--timeout 20] [--include-self]   block until a peer publishes, claims or ends
  hud changes --since ms             list changes after a timestamp (for incremental sync)
  hud readout [board]                text and metric readout for one board or all boards
  hud snapshot [board] [--format auto|png|text] [--out path]
                                     capture a board; PNG is saved to snapshot.png when available
  hud dashboard [board] [--file path] [--dry-run] [--expected-revision rev]
                                     read or replace the declarative dashboard spec (JSON may come from stdin)
  hud annotate <board> <time> <text...> | hud annotate list <board> | hud annotate delete <board> <id>
                                     add, list, or remove a time annotation
  hud compare <board> [left relation right] [--tolerance n] [--holdFor s] [--maxSkew s]
                                     list or add a metric comparison; use compare delete <board> <id> to remove
  hud lint [board]                   lint a board and its dashboard spec
  hud graph <item> [--action get|preview|apply|disable] [--file JSON] [--code-file path]
                                     inspect or program an item renderer; preview before apply
  hud canvas [board] [--action get|preview|apply|disable] [--file JSON] [--code-file path]
                                     inspect or program a board canvas renderer; preview before apply
  hud comment <id> <text...> [--format plain|markdown]
                                     add a comment to a ticket
  hud comment edit <id> <cid> <text...> [--format plain|markdown] | hud comment rm <id> <cid>
  hud log <id> [--limit n]           the item's activity history
  hud ask <id> --option A --option B [--question "…"] [--questionFormat plain|markdown]
                                     propose choices on a ticket and block it until a human picks one
                                       (--options '[{"label":"A","detail":"…","status":"done"}]' for detail/status)
  hud decide <id> <optionId> --version UUID [--note "…"]
                                     record the choice using the current decision version (prevents stale answers)
  hud finish [ids...] [--board b] [--note "…"] [--no-organize] [--export] [--all]
                                     mark items done and tidy the board (how an agent ends a run);
                                     --export snapshots runs this call finishes; pass ids to include an already
                                     finished run; --all with --export snapshots every owned done or canceled run
  hud run <id>                       run an automatic monitor now
  hud approve <id> --revision v      approve a command monitor waiting in Attention
                                     (only actor user; an agent calling this is refused)
  hud rm <id...>                     delete items (moved to the trash, recoverable)
  hud trash [--board b]              list deleted items;  hud restore <id>;  hud purge <id> | --all  (permanent)
  hud backup [--list] [--reason r] | hud backup restore <name>
                                     snapshot the state, list snapshots, or replace the board from one
  hud export [file]                  full state as JSON (stdout, or a file)
  hud import <file> [--merge]        replace (default; a backup is taken first) or merge the state
  hud ping <id> [start|fail|<code>]  heartbeat for a cron-style monitor
  hud organize [board] [--auto on|off]
                                     fit the fixed 1600×900 board (--auto on|off; default on)
  hud arrange [--board b] [--frame f]
  hud board [list|add <name>|rename <id> <name>|clear <id>|rm <id>]
                                     clear keeps the board/settings; rm deletes the board
  hud guide [decentralized|lead] [--section a] [--json]
                                     full guide, one TOC section, or one playbook
  hud quickstart                     human quickstart (install, Settings, Attention, Tickets)
  hud views [--json]                 chart renderer modules available to display:"view:<name>"
  hud view list | show <name> | generate <name> --spec '<json>' [--write] [--display monitor]
           | set <name> --code-file path [--overwrite] | approve <name> --proposal id --sha sha256
           | validate <name> | rm <name>
                                     chart modules. set stages a review diff; approve installs that exact module
  hud mcp                            run the MCP server on stdio (what agents connect to)
  hud mcp install [clients...] [--dry-run]   wire hud into claude / codex / opencode / all
  hud mcp uninstall [clients...]     remove the hud MCP entry again
  hud mcp status                     show where hud is configured and which command is used
  hud mcp reconnect [--dry-run]      print the one-shot post-update client reconnect checklist
  hud mcp print [client]             print the command / config snippet to paste in by hand
  hud cli [install|uninstall|status] put the 'hud' command on PATH (desktop app, .deb, or AppImage)

every command takes --help; --json prints machine-readable output; '--' ends flag parsing;
use --flag=value for values that start with '-'. Exit codes: 0 ok, 1 failure, 2 usage error.
flags take dotted keys and JSON values:  --source.kind command --source.command "df -h /" --source.interval 30
                                         --tags a,b  --frame f1  --board infra
set HUD_ACTOR (or --as name) to label who made a change.

examples:
  hud add ticket "Fix flaky login test" --status doing --priority high --group CI --body "seen 3x on CI"
  hud add monitor --template disk
  hud add monitor --template tls --host example.com
  hud add monitor "disk /" --id disk --source.kind command --source.command "df -P / | awk 'NR==2{print \\$5+0}'" --unit % --warnAbove 80
  hud push deploy --progress 40 --message "migrating db"`;


class UsageError extends Error {}

const BOOL = new Set(['json', 'ack', 'all', 'off', 'merge', 'list', 'overdue', 'dry-run', 'no-organize', 'help', 'start', 'takeover', 'peek', 'create', 'force', 'include-self', 'write', 'overwrite', 'export']);
const STR_KEYS = new Set(['command', 'title', 'body', 'text', 'message', 'details', 'id', 'label', 'group', 'name', 'key', 'lead', 'assignee', 'target', 'branch', 'project', 'parent', 'q', 'reason', 'note', 'question', 'board', 'frame', 'format', 'messageFormat', 'questionFormat', 'summaryMonitor', 'version', 'revision', 'file', 'out', 'code-file', 'action', 'language', 'description', 'left', 'right', 'relation', 'expected-revision', 'session', 'kind', 'run', 'ttl', 'scope', 'data', 'corrects', 'attach', 'refs', 'since', 'limit', 'base', 'expected', 'mime', 'ticket', 'sessions', 'kinds', 'timeout', 'spec', 'sha', 'section', 'playbook']);
const FILTERS = ['board', 'type', 'status', 'priority', 'assignee', 'owner', 'project', 'tag', 'overdue', 'limit', 'parent'];

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
      if (key === 'option' || key === 'binding' || key === 'capability') (flags[key] ??= []).push(v);
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
  reveal: { u: 'hud reveal', max: 0, f: ['json'] },
  open: { u: 'hud [open]', max: 0, f: [] },
  version: { u: 'hud version [--json]', max: 0, f: ['json'] },
  update: { u: 'hud update [--check] [--json]', max: 0, f: ['check', 'json'] },
  ls: { u: 'hud ls [board] | hud ls tickets [board] [--status s,s] [--assignee a] [--owner o] [--project KEY] [--tag t] [--priority p] [--overdue] [--limit n] [--json]', max: 2, f: ['board', 'json', ...FILTERS] },
  tickets: { u: 'hud tickets [board] [--status s,s] [--assignee a] [--owner o] [--project KEY] [--tag t] [--priority p] [--overdue] [--limit n] [--json]', max: 1, f: ['board', 'json', ...FILTERS] },
  find: { u: 'hud find <text...> [--board b] [--type t] [--status s,s] [--assignee a] [--owner o] [--project KEY] [--tag t] [--priority p] [--overdue] [--limit n] [--json]', min: 1, f: ['json', ...FILTERS] },
  project: { u: 'hud project [list] | hud project new <name> [--key EGO] [--lead @who] [--target date] [--body text] | hud project set <id> --key NEW [--title t] [--lead @who] [--target date] [--body text]', f: '*' },
  tree: { u: 'hud tree [board] [--project KEY] | hud tree move <id> [--parent EGO-1] [--project KEY] | hud tree detach <id>', max: 2, f: ['board', 'project', 'parent', 'json'] },
  link: { u: 'hud link <id> [project=EGO] [parent=EGO-1] [blockedBy=EGO-2,EGO-3] [refs=EGO-4] [branch=name]', min: 1, f: ['project', 'parent', 'blockedBy', 'refs', 'branch', 'json'] },
  unlink: { u: 'hud unlink <id> [parent blockedBy refs project ...]', min: 1, f: ['json'] },
  show: { u: 'hud show <id>', min: 1, max: 1, f: ['json'] },
  add: { u: 'hud add <type> [title] [--k v ...] | hud add monitor --template [disk|tls|http|cron-heartbeat]', min: 1, f: '*' },
  set: { u: 'hud set <id> [status] --k v [...]', min: 1, f: '*' },
  push: { u: 'hud push <id> [value] [--label l] [--state s] [--message m] [--progress p] [--unit u] [--max n] [--warnBelow n] [--staleAfter s] [--group g] [--title t]', min: 1, max: 2, f: '*' },
  watch: { u: 'hud watch <name> [ids...] [--board b] [--off]', min: 1, f: ['board', 'off', 'json'] },
  alerts: { u: 'hud alerts [--ack] [--all] [--json]', max: 0, f: ['ack', 'all', 'json'] },
  attention: { u: 'hud attention [review|unreview|snooze <id>] [--revision v] [--until ms|--minutes n] [--json]', max: 2, f: ['revision', 'until', 'minutes', 'json'] },
  runs: { u: 'hud runs [--json]', max: 0, f: ['json'] },
  queue: { u: 'hud queue [board] [--status s,s] [--project KEY] [--assignee a] [--owner o] [--all] [--limit n] [--json]', max: 1, f: ['status', 'project', 'assignee', 'owner', 'all', 'limit', 'board', 'json'] },
  session: { u: 'hud session [start|heartbeat|end|list] [name] [--kind agent|cli|human] [--run EGO-1] [--json]', max: 2, f: ['kind', 'run', 'json'] },
  claim: { u: 'hud claim <id> [--session s] [--ttl sec] [--start] [--takeover] | hud claim status <id> | hud claim list [--session s] [--board b] [--all] | hud claim renew <id> [--ttl sec]', min: 1, max: 2, f: ['session', 'ttl', 'start', 'takeover', 'board', 'all', 'json'] },
  release: { u: 'hud release <id> [--session s] [--reason text] [--json]', min: 1, max: 1, f: ['session', 'reason', 'json'] },
  context: { u: 'hud context read [--scope s] [--since n] [--kind FACT,FAIL] [--limit n] [--peek] | hud context publish --scope s --kind FACT --text t [--data JSON] [--refs ids] [--attach id] [--corrects id] | hud context scopes [--board b] | hud context export <run> | hud context exports [run]', max: 2, f: '*' },
  attach: { u: 'hud attach list [--scope s] [--board b] | hud attach add <file> [--scope s] [--target path] [--base id] | hud attach get|content|expand <id> | hud attach apply <id> --target path [--expected sha] [--create] | hud attach rm <id> [--force]', max: 2, f: '*' },
  wait: { u: 'hud wait [--scope s] [--ticket id] [--sessions a,b] [--kinds context,claim,session] [--since n] [--timeout sec] [--include-self] [--json]', max: 0, f: ['scope', 'ticket', 'sessions', 'kinds', 'since', 'timeout', 'include-self', 'session', 'json'] },
  changes: { u: 'hud changes --since ms [--json]', max: 0, f: ['since', 'json'] },
  readout: { u: 'hud readout [board] [--json]', max: 1, f: ['board', 'json'] },
  snapshot: { u: 'hud snapshot [board] [--format auto|png|text] [--out path] [--json]', max: 1, f: ['board', 'format', 'out', 'json'] },
  dashboard: { u: 'hud dashboard [board] [--file path] [--dry-run] [--expected-revision rev] [--json]', max: 1, f: ['board', 'file', 'dry-run', 'expected-revision', 'json'] },
  annotate: { u: 'hud annotate <board> <time> <text...> | hud annotate list <board> | hud annotate delete <board> <id>', f: ['json'] },
  compare: { u: 'hud compare <board> [left relation right] [--tolerance n] [--holdFor s] [--maxSkew s] | hud compare delete <board> <id>', f: ['id', 'left', 'right', 'relation', 'tolerance', 'holdFor', 'maxSkew', 'json'] },
  lint: { u: 'hud lint [board] [--json]', max: 1, f: ['board', 'json'] },
  graph: { u: 'hud graph <item> [--action get|preview|apply|disable|delete] [--file JSON] [--code-file path] [--language html|javascript|svg] [--expected-revision rev]', min: 1, max: 1, f: ['action', 'file', 'code-file', 'language', 'description', 'binding', 'bindings', 'capability', 'capabilities', 'expected-revision', 'json'] },
  canvas: { u: 'hud canvas [board] [--action get|preview|apply|disable|delete] [--file JSON] [--code-file path] [--language html|javascript|svg] [--expected-revision rev]', max: 1, f: ['action', 'file', 'code-file', 'language', 'description', 'binding', 'bindings', 'capability', 'capabilities', 'expected-revision', 'json'] },
  comment: { u: 'hud comment <id> <text...> | hud comment edit <id> <cid> <text...> | hud comment rm <id> <cid>', min: 2, f: ['format', 'json'] },
  log: { u: 'hud log <id> [--limit n] [--json]', min: 1, max: 1, f: ['limit', 'json'] },
  ask: { u: 'hud ask <id> --option A --option B [--question q] [--questionFormat plain|markdown] [--options json]', min: 1, max: 1, f: ['option', 'options', 'question', 'questionFormat', 'json'] },
  decide: { u: 'hud decide <id> <optionId> --version UUID [--note text]', min: 1, max: 2, f: ['optionId', 'note', 'version', 'json'] },
  finish: { u: 'hud finish [ids...] [--board b] [--note text] [--no-organize] [--export] [--all]', f: ['board', 'note', 'no-organize', 'export', 'all', 'json'] },
  run: { u: 'hud run <id>', min: 1, max: 1, f: ['json'] },
  approve: { u: 'hud approve <id> --revision v', min: 1, max: 1, f: ['revision', 'json'] },
  rm: { u: 'hud rm <id...>', min: 1, f: ['json'] },
  trash: { u: 'hud trash [--board b] [--json]', max: 0, f: ['board', 'json'] },
  restore: { u: 'hud restore <id>', min: 1, max: 1, f: ['json'] },
  purge: { u: 'hud purge <id> | hud purge --all   (permanent)', max: 1, f: ['all', 'json'] },
  backup: { u: 'hud backup [--list] [--reason text] | hud backup restore <name>', max: 2, f: ['list', 'reason', 'json'] },
  export: { u: 'hud export [file]', max: 1, f: [] },
  import: { u: 'hud import <file> [--merge]', min: 1, max: 1, f: ['merge', 'json'] },
  ping: { u: 'hud ping <id> [start|fail|<code>]', min: 1, max: 2, f: ['json'] },
  organize: { u: 'hud organize [board] [--auto on|off]', max: 1, f: ['board', 'auto', 'json'] },
  arrange: { u: 'hud arrange [ids...] [--board b] [--frame f] [--width n]', f: ['board', 'frame', 'width', 'json'] },
  board: { u: 'hud board [list|add <name>|rename <id> <name>|clear <id>|rm <id>]', f: ['json'] },
  guide: { u: 'hud guide [decentralized|lead|playbooks] [--section anchor] [--playbook name] [--json]', max: 1, f: ['section', 'playbook'] },
  quickstart: { u: 'hud quickstart', max: 0, f: [] },
  views: { u: 'hud views [--json]', max: 0, f: ['json'] },
  view: { u: 'hud view list | show <name> | generate <name> --spec \'<json>\' [--write] [--display monitor] | set <name> --code-file path [--overwrite] | approve <name> --proposal id --sha sha256 | validate <name> | rm <name>', max: 2, f: '*' },
  mcp: { u: 'hud mcp | hud mcp install|uninstall|status|print|reconnect [clients...] [--dry-run]', f: '*' },
  cli: { u: 'hud cli [install|uninstall|status]', max: 1, f: [] },
};
// `update` is the release updater now; editing an item is `hud set`
const ALIAS: Record<string, string> = { issues: 'tickets', get: 'show', new: 'add', delete: 'rm', tidy: 'organize', boards: 'board', projects: 'project', comments: 'comment', trees: 'tree' };

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
    } else {
      await hud.request('POST', '/api/shutdown');
    }
    // The server answers the shutdown request before it exits; wait for the port so an immediate
    // restart (hud update) cannot mistake the dying process for a live one.
    for (let i = 0; i < 50; i++) {
      if (!(await hud.healthInfo().catch(() => null))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return info.pid ? `stopped hud (pid ${info.pid})` : 'stopped hud';
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
  // bare `hud` is the everyday entry point: server up, canvas open in the browser
  if (first === undefined && flags.help) return void console.log(HELP);
  const cmd = first === undefined ? 'open' : ALIAS[first] ?? first;
  if (cmd === 'help') {
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

  const hud = new Hud({ actor, session: typeof flags.session === 'string' ? flags.session : undefined });
  const session = (typeof flags.session === 'string' ? flags.session : undefined) ?? process.env.HUD_SESSION ?? `${actor}-cli`;
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
      const client = new Hud({ actor, autostart: false });
      const info = await client.healthInfo();
      if (!info) {
        process.exitCode = 1;
        return emit({ running: false, url: hud.url }, `hud is not running at ${hud.url}`);
      }
      const offer = await client.reconnect().catch(() => null);
      const lines = [`hud running at ${hud.url}`, `  pid ${info.pid}  port ${info.port}  mode ${info.mode}  version ${info.version ?? '?'}`, `  data ${info.dataDir ?? '?'}  items ${info.items ?? '?'}`, info.recoveredFrom ? `  RECOVERED FROM: ${info.recoveredFrom}` : '', info.saveError ? `  SAVE ERROR: ${info.saveError}` : '  saves ok'].filter(Boolean);
      if (offer?.pending || offer?.skewed) lines.push('', offer.text);
      return emit(offer ? { ...info, reconnect: offer } : info, lines.join('\n'));
    }
    case 'open':
      await hud.ensureServer();
      openApp(hud.url);
      return emit({ url: hud.url }, hud.url);
    case 'version': {
      const installed = installedVersion();
      const info = await new Hud({ actor, autostart: false }).healthInfo().catch(() => null);
      const lines = [`hud ${installed ?? 'unknown'}${isBundle() ? ' (curl install)' : ''}`, info ? `  server ${info.version ?? '?'} at ${hud.url} (pid ${info.pid})` : '  server not running'];
      return emit({ version: installed, install: isBundle() ? installRoot() : null, server: info?.version ?? null, running: !!info }, lines.join('\n'));
    }
    case 'update': {
      const release = await cliRelease();
      const installed = installedVersion();
      const newer = installed ? compareVersions(release.version, installed) > 0 : true;
      if (!newer) {
        const text = installed && compareVersions(release.version, installed) < 0
          ? `hud ${installed} is newer than the latest release (${release.version})`
          : `hud ${installed} is up to date (latest ${release.version})`;
        return emit({ installed, latest: release.version, updated: false }, text);
      }
      if (flags.check === true) {
        return emit({ installed, latest: release.version, available: true, page: release.pageUrl },
          `hud ${installed ?? '?'} → ${release.version} is available; run \`hud update\` to install it`);
      }
      if (!isBundle()) throw new UsageError('this hud runs from a checkout; install the curl build before using hud update');
      const debounce = mkdtempSync(join(tmpdir(), 'hud-update-'));
      const { path } = await fetchBundle(release);
      const root = unpackBundle(path, join(debounce, 'unpacked'));
      const wasRunning = !!(await new Hud({ actor, autostart: false }).healthInfo().catch(() => null));
      if (wasRunning) await stopServer(new Hud({ actor, autostart: false }));
      swapApp(root);
      if (wasRunning) await new Hud({ actor }).ensureServer();
      const text = `hud ${installed ?? '?'} → ${release.version} installed at ${appDir()}${wasRunning ? '; server restarted' : ''}`;
      return emit({ installed, latest: release.version, updated: true, restarted: wasRunning, appDir: appDir() }, text);
    }
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
        const p = await hud.createProject({ title, key: flags.key, board: flags.board, body: flags.body, lead: flags.lead, target: flags.target });
        return emit(p, `created project ${p.key} "${p.title}" (${p.id})`);
      }
      if (sub === 'set' || sub === 'update') {
        const id = name[0] ?? flags.id;
        if (!id) throw new UsageError('missing project id');
        const patch = { ...flags };
        delete patch.id;
        delete patch.session;
        const p = await hud.updateProject(id, patch);
        return emit(p, `updated project ${p.key} "${p.title}"`);
      }
      throw new UsageError(`unknown project command "${sub}"`);
    }
    case 'tree': {
      const sub = rest[0];
      if (sub === 'move' || sub === 'detach') {
        const id = rest[1];
        if (!id) throw new UsageError(`usage: hud tree ${sub} <id>`);
        if (sub === 'detach') {
          const t = await hud.treeDetach(id);
          return emit(t, `detached ${brief(t)}`);
        }
        const patch: { parent?: string; project?: string } = {};
        if (flags.parent !== undefined) patch.parent = String(flags.parent);
        if (flags.project !== undefined) patch.project = String(flags.project);
        if (!('parent' in patch) && !('project' in patch)) throw new UsageError('hud tree move needs --parent and/or --project');
        const t = await hud.treeMove(id, patch);
        return emit(t, `moved ${brief(t)}`);
      }
      const board = sub && sub !== 'get' ? sub : (flags.board ?? 'main');
      const forest = await hud.tree(board, flags.project);
      const lines: string[] = [];
      const walk = (n: { ident: string; status: string; title: string; children?: { ident: string; status: string; title: string; children?: any[] }[] }, depth: number) => {
        lines.push(`${'  '.repeat(depth)}${n.ident} [${n.status}] ${n.title}`);
        for (const c of n.children ?? []) walk(c, depth + 1);
      };
      for (const n of forest.nodes) walk(n, 0);
      return emit(forest, lines.length ? lines.join('\n') : `no tickets on board ${forest.board}`);
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
      // The catalog is static. Listing it must not autostart a server or touch the live board.
      if (type === 'monitor' && (flags.template === true || flags.template === '')) {
        const templates = listMonitorTemplates();
        return emit(templates, formatMonitorTemplateList(templates));
      }
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
    case 'attention': {
      const action = rest[0] ?? 'list';
      if (action === 'list') {
        if (rest.length > 1) throw new UsageError('usage: hud attention [review|unreview|snooze <id>]');
        const r = await hud.attention();
        const lines = r.items.map((a) => `[${a.kind}] ${a.itemId} ${a.title} priority=${a.priority} revision=${a.revision}${a.message ? ` — ${a.message}` : ''}`);
        return emit(r, lines.length ? lines.join('\n') : 'no human-attention items');
      }
      if (action !== 'review' && action !== 'unreview' && action !== 'snooze') throw new UsageError('attention action must be list|review|unreview|snooze');
      const id = rest[1];
      if (!id) throw new UsageError(`usage: hud attention ${action} <id> --revision UUID${action === 'snooze' ? ' [--until ms|--minutes n]' : ''}`);
      if (typeof flags.revision !== 'string' || !flags.revision) throw new UsageError('--revision is required (use hud attention to read the current revision)');
      let until = flags.until;
      if (flags.minutes !== undefined) {
        const minutes = Number(flags.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) throw new UsageError('--minutes must be a positive number');
        if (until !== undefined) throw new UsageError('use only one of --until and --minutes');
        until = Date.now() + minutes * 60_000;
      }
      if (action === 'snooze' && until === undefined) throw new UsageError('snooze requires --until timestamp or --minutes n');
      const r = await hud.reviewAttention(id, { action, revision: flags.revision, ...(until === undefined ? {} : { until: Number(until) }) });
      return emit(r, `${action} ${r.itemId} [${r.kind}] revision=${r.revision}${r.reviewedAt ? ' reviewed' : ''}${r.snoozedUntil ? ` snoozed-until=${r.snoozedUntil}` : ''}`);
    }
    case 'runs': {
      const r = await hud.runs();
      const lines = r.items.map((run) => {
        const progress = run.progress == null ? '—' : `${run.progress}%`;
        return `${run.id}  ${run.title}  [${run.status}]  progress=${progress}  issues=${run.issues}  monitors=${run.monitors.length}  tickets=${run.tickets.length}`;
      });
      return emit(r, lines.length ? lines.join('\n') : 'no runs');
    }
    case 'queue': {
      const r = await hud.queue({ board: rest[0] ?? flags.board, status: flags.status, project: flags.project, assignee: flags.assignee, owner: flags.owner, includeDone: !!flags.all, limit: flags.limit === undefined ? undefined : Number(flags.limit) });
      const { counts } = r;
      const lines = r.items.map((t) => {
        const marks = [t.ready ? 'ready' : '', t.blocked ? 'blocked' : '', t.claim ? 'claimed' : ''].filter(Boolean).join(',');
        return `${t.ident.padEnd(8)} ${t.status.padEnd(9)} ${(t.owner ?? '—').padEnd(12)} ${marks.padEnd(18)} ${t.title}`;
      });
      return emit(r, `${r.board}: ${counts.ready} ready · ${counts.open} open · ${counts.claimed} claimed · ${counts.blocked} blocked · ${counts.done} done\n${lines.join('\n')}`.trimEnd());
    }
    case 'session': {
      const sub = rest[0] ?? 'list';
      if (sub === 'list') {
        const r = await hud.sessions();
        return emit(r, r.items.length
          ? r.items.map((s) => `${s.id}  ${s.kind}  ${s.live ? 'live' : 'ended'}  age=${Math.round((r.now - s.lastSeenAt) / 1000)}s  claims=${s.claims.map((c) => c.ident).join(',') || '—'}`).join('\n')
          : 'no sessions; start one with: hud session start <name>');
      }
      const name = rest[1] ?? session;
      if (sub === 'start') {
        const s = await hud.sessionStart(name, { kind: flags.kind as 'agent' | 'cli' | 'human' | 'unknown' | undefined, run: flags.run as string | undefined });
        return emit(s, `session ${s.id} started (${s.kind})${s.run ? ` for ${s.run}` : ''}`);
      }
      if (sub === 'heartbeat') {
        const r = await hud.sessionHeartbeat(name);
        return emit(r, `session ${r.session.id} live; ${r.renewed.length} claims renewed`);
      }
      if (sub === 'end') {
        const r = await hud.sessionEnd(name);
        return emit(r, `session ${r.session.id} ended; released ${r.released.length} claims`);
      }
      throw new UsageError(`unknown session command "${sub}" — try: hud session start|heartbeat|end|list`);
    }
    case 'claim': {
      const sub = rest[0];
      if (sub === 'list') {
        if (flags.all && flags.session) throw new UsageError('hud claim list takes --session or --all, not both');
        const whose = flags.all ? undefined : (typeof flags.session === 'string' ? flags.session : session);
        const r = await hud.claims({ session: whose, board: flags.board });
        const lines = r.items.map((c) => `${c.ident} claimed by ${c.session} until ${new Date(c.expiresAt).toLocaleString()} live=${c.live} sessionLive=${c.sessionLive}`);
        return emit(r, lines.length ? lines.join('\n') : (flags.all ? 'no active claims' : `no active claim for ${whose}`));
      }
      if (sub === 'status') {
        const id = rest[1];
        if (!id) throw new UsageError('usage: hud claim status <id>');
        const c = await hud.claimOf(id);
        return emit(c, c ? `${c.ident} claimed by ${c.session} until ${new Date(c.expiresAt).toLocaleString()} live=${c.live} sessionLive=${c.sessionLive} expiresAt=${c.expiresAt}` : `${id} is not claimed`);
      }
      if (sub === 'renew') {
        const id = rest[1];
        if (!id) throw new UsageError('usage: hud claim renew <id>');
        const c = await hud.claim(id, { session, ttl: flags.ttl === undefined ? undefined : Number(flags.ttl) });
        return emit(c, `${c.ident} renewed until ${new Date(c.expiresAt).toLocaleTimeString()} live=${c.live} sessionLive=${c.sessionLive}`);
      }
      const c = await hud.claim(sub!, { session, ttl: flags.ttl === undefined ? undefined : Number(flags.ttl), start: !!flags.start, takeover: !!flags.takeover });
      return emit(c, `${c.ident} "${c.title}" claimed by ${c.session} until ${new Date(c.expiresAt).toLocaleTimeString()}${flags.start ? '; ticket moved to doing' : ''}`);
    }
    case 'release': {
      const c = await hud.releaseClaim(rest[0]!, { session, reason: flags.reason });
      return emit(c, `released ${c.ident}${flags.reason ? ` (${flags.reason})` : ''}`);
    }
    case 'attach': {
      const sub = rest[0] ?? 'list';
      if (sub === 'list') {
        const rows = await hud.attachments({ board: flags.board as string | undefined, scope: flags.scope as string | undefined });
        return emit(rows, rows.length
          ? rows.map((a) => `${a.id}  ${a.name}  ${a.bytes}b  ${a.scope ?? '—'}  ${a.appliedTo ? `applied→${a.appliedTo}` : ''}`).join('\n')
          : 'no attachments');
      }
      const id = rest[1];
      if (sub === 'add') {
        if (!id) throw new UsageError('attach add requires a file path');
        const name = (flags.name as string | undefined) ?? basename(id);
        const a = await hud.attachmentAdd({ board: flags.board as string | undefined, scope: flags.scope as string | undefined, name, kind: flags.kind as 'file' | 'text' | 'diff' | undefined, mime: flags.mime as string | undefined, target: flags.target as string | undefined, baseId: flags.base as string | undefined, content: readFileSync(id) });
        return emit(a, `attachment ${a.id} ${a.name} (${a.bytes}b, sha256 ${a.sha256})`);
      }
      if (!id) throw new UsageError(`attach ${sub} requires an attachment id`);
      if (sub === 'get') {
        const a = await hud.attachment(id);
        return emit(a, JSON.stringify(a, null, 2));
      }
      if (sub === 'content') {
        const text = await hud.attachmentText(id);
        return emit(text, text);
      }
      if (sub === 'expand') {
        const d = await hud.expandAttachment(id);
        return emit(d, `+${d.added ?? '?'} -${d.removed ?? '?'}${d.truncated ? ' (truncated)' : ''}\n${d.text}`);
      }
      if (sub === 'apply') {
        if (!flags.target) throw new UsageError('attach apply requires --target <absolute path>');
        const r = await applyAttachment(hud, id, { target: String(flags.target), expectedSha256: flags.expected as string | undefined, mode: flags.create ? 'create' : 'overwrite' });
        return emit(r, `applied to ${r.path}${r.backup ? ` (backup ${r.backup})` : ''}`);
      }
      if (sub === 'rm' || sub === 'delete') {
        const a = await hud.deleteAttachment(id, !!flags.force);
        return emit(a, `deleted attachment ${a.id}`);
      }
      throw new UsageError(`unknown attach command "${sub}" — try: hud attach list|add|get|content|expand|apply|rm`);
    }
    case 'wait': {
      const r = await hud.wait({
        scope: flags.scope as string | undefined,
        ticket: flags.ticket as string | undefined,
        sessions: flags.sessions === undefined ? undefined : String(flags.sessions).split(',').map(s => s.trim()).filter(Boolean),
        kinds: flags.kinds === undefined ? undefined : String(flags.kinds).split(',').map(s => s.trim()).filter(Boolean),
        since: flags.since === undefined ? undefined : Number(flags.since),
        timeoutSeconds: flags.timeout === undefined ? undefined : Number(flags.timeout),
        includeSelf: !!flags['include-self'],
        session,
      });
      return emit(r, r.woke ? `woke: ${r.reason}\n${JSON.stringify(r.event, null, 2)}` : `no matching event within ${flags.timeout ?? 20}s`);
    }
    case 'context': {
      const sub = rest[0] ?? 'read';
      if (sub === 'scopes') {
        const rows = await hud.contextScopes(flags.board);
        return emit(rows, rows.length ? rows.map((s) => `${s.scope}  board=${s.board}  entries=${s.count}  last=${new Date(s.lastAt).toLocaleString()}`).join('\n') : 'no shared context yet');
      }
      if (sub === 'publish') {
        if (!flags.scope || !flags.kind || !flags.text) throw new UsageError('publish requires --scope, --kind and --text');
        const data = flags.data === undefined ? undefined : JSON.parse(String(flags.data));
        const refs = flags.refs === undefined ? undefined : String(flags.refs).split(',').map(s => s.trim()).filter(Boolean);
        const attachments = flags.attach === undefined ? undefined : String(flags.attach).split(',').map(s => s.trim()).filter(Boolean);
        const e = await hud.contextPublish({ scope: String(flags.scope), kind: String(flags.kind), text: String(flags.text), data, refs, attachments, corrects: flags.corrects as string | undefined, session });
        return emit(e, `published ${e.kind} #${e.seq} ${e.scope} id=${e.id}`);
      }
      if (sub === 'export') {
        const id = rest[1];
        if (!id) throw new UsageError('usage: hud context export <run>');
        const exported = await hud.exportRun(id);
        const missing = exported.missing.length ? `\nmissing: ${exported.missing.join(', ')}` : '';
        return emit(exported, `exported ${exported.ident} → backups/${exported.name} (${exported.entries} entries, ${exported.attachments} files, ${exported.bytes}b)${missing}`);
      }
      if (sub === 'exports') {
        const rows = await hud.runExports(rest[1]);
        return emit(rows, rows.length ? rows.map((row) => `${row.name}  ${row.runId}  ${row.bytes}b  ${new Date(row.t).toLocaleString()}`).join('\n') : 'no context exports');
      }
      if (sub !== 'read') throw new UsageError(`unknown context command "${sub}" — try: hud context read|publish|scopes|export|exports`);
      const r = await hud.contextRead({ scope: flags.scope as string | undefined, since: flags.since === undefined ? undefined : Number(flags.since), kinds: flags.kind === undefined ? undefined : String(flags.kind).split(','), limit: flags.limit === undefined ? undefined : Number(flags.limit), session, mark: !flags.peek });
      const lines = r.entries.map((e) => `#${e.seq} ${e.kind.padEnd(7)} ${e.actor.padEnd(10)} ${e.text}${e.corrects ? `  (corrects ${e.corrects})` : ''}`);
      return emit(r, `cursor=${r.cursor}${r.truncated ? ' (older entries pruned)' : ''}${r.complete ? '' : ' (more remain)'}\n${lines.join('\n')}`.trimEnd());
    }
    case 'changes': {
      if (flags.since === undefined) throw new UsageError('usage: hud changes --since timestamp');
      const since = Number(flags.since);
      if (!Number.isFinite(since) || since < 0) throw new UsageError('--since must be a non-negative timestamp');
      const r = await hud.changes(since);
      const lines = r.events.map((e: any) => {
        if (e.action !== undefined) return `${new Date(e.t).toLocaleString()} ${e.action}${e.itemId ? ` ${e.itemId}` : ''}${e.actor ? ` @${e.actor}` : ''}${e.text ? ` — ${e.text}` : ''}`;
        const it = e.item;
        const value = it?.value !== undefined && it?.value !== null ? ` value=${it.value}` : '';
        const progress = it?.progress !== undefined && it?.progress !== null ? ` progress=${it.progress}%` : '';
        return `${e.kind}${e.actor ? ` @${e.actor}` : ''}${e.item?.id ? ` ${e.item.id}` : e.itemId ? ` ${e.itemId}` : ''}${value}${progress}`;
      });
      return emit(r, [`since=${r.since} now=${r.now} complete=${r.complete}`, ...lines].join('\n'));
    }
    case 'readout': {
      const board = rest[0] ?? flags.board;
      const r = await hud.readout(board);
      const text = typeof r.text === 'string' ? r.text : JSON.stringify(r, null, 2);
      return emit(r, text);
    }
    case 'snapshot': {
      const format = flags.format ?? 'auto';
      if (!['auto', 'png', 'text'].includes(format)) throw new UsageError('--format must be auto|png|text');
      const r = await hud.snapshot({ board: rest[0] ?? flags.board, format });
      if (json) return emit(r);
      if (r.image && format !== 'text') {
        const path = flags.out ?? 'snapshot.png';
        writeFileSync(path, Buffer.from(r.image.data, 'base64'));
        const warnings = [...(r.warnings ?? []), ...(r.imageUnavailable ? [r.imageUnavailable] : [])];
        return emit({ board: r.board, capturedAt: r.capturedAt, out: path, warnings }, `saved ${path} (${r.board}, ${new Date(r.capturedAt).toISOString()})${warnings.length ? `\n${warnings.join('\n')}` : ''}`);
      }
      const warnings = [...(r.warnings ?? []), ...(r.imageUnavailable ? [r.imageUnavailable] : [])];
      return emit(r, `${r.text}${warnings.length ? `\n\n${warnings.join('\n')}` : ''}`);
    }
    case 'dashboard': {
      const board = rest[0] ?? flags.board ?? 'main';
      const input = flags.file !== undefined
        ? readFileSync(String(flags.file), 'utf8')
        : !process.stdin.isTTY ? readFileSync(0, 'utf8') : '';
      if (!input.trim()) {
        if (flags['dry-run']) throw new UsageError('--dry-run needs a dashboard JSON document from --file or stdin');
        const current = await hud.dashboard(board);
        return emit(current, current ? JSON.stringify(current, null, 2) : `no dashboard spec on ${board}`);
      }
      let document: any;
      try {
        document = JSON.parse(input);
      } catch (e) {
        throw new UsageError(`invalid dashboard JSON: ${(e as Error).message}`);
      }
      const supplied = document && typeof document === 'object' && !Array.isArray(document) && 'spec' in document ? document : { spec: document };
      if (!supplied.spec || typeof supplied.spec !== 'object' || Array.isArray(supplied.spec)) throw new UsageError('dashboard JSON must be a spec object or {spec: ...}');
      const body = {
        spec: supplied.spec,
        ...(flags['dry-run'] || supplied.dryRun ? { dryRun: true } : {}),
        ...((flags['expected-revision'] ?? supplied.expectedRevision) !== undefined ? { expectedRevision: String(flags['expected-revision'] ?? supplied.expectedRevision) } : {}),
      };
      const result = await hud.updateDashboard(board, body);
      return emit(result, JSON.stringify(result, null, 2));
    }
    case 'annotate': {
      const sub = rest[0];
      const board = sub === 'list' || sub === 'delete' ? rest[1] ?? flags.board ?? 'main' : rest[0] ?? flags.board ?? 'main';
      if (sub === 'delete') {
        const id = rest[2] ?? flags.id;
        if (!id) throw new UsageError('usage: hud annotate delete <board> <id>');
        const result = await hud.deleteAnnotation(board, id);
        return emit(result, `deleted annotation ${id} on ${board}`);
      }
      const adding = sub !== 'list' && rest.length >= 3 && Number.isFinite(Number(rest[1]));
      if (adding) {
        const time = Number(rest[1]);
        const text = rest.slice(2).join(' ');
        const result = await hud.addAnnotation(board, { time, text });
        return emit(result, `added annotation on ${board} at ${new Date(time).toISOString()}: ${text}`);
      }
      if (sub !== undefined && sub !== 'list' && rest.length > 1) throw new UsageError('usage: hud annotate <board> <time> <text...> | hud annotate list <board> | hud annotate delete <board> <id>');
      const annotations = await hud.annotations(board);
      return emit(annotations, annotations.length ? annotations.map((a) => `${a.id}  ${new Date(a.time).toISOString()}  ${a.text}`).join('\n') : `no annotations on ${board}`);
    }
    case 'compare': {
      const [firstArg, secondArg, thirdArg, fourthArg] = rest;
      if (firstArg === 'delete') {
        const board = secondArg ?? flags.board ?? 'main';
        const id = thirdArg ?? flags.id;
        if (!id) throw new UsageError('usage: hud compare delete <board> <id>');
        const result = await hud.deleteComparison(board, id);
        return emit(result, `deleted comparison ${id} on ${board}`);
      }
      const board = firstArg ?? flags.board ?? 'main';
      const left = flags.left ?? secondArg;
      const relation = flags.relation ?? thirdArg;
      const right = flags.right ?? fourthArg;
      if (left === undefined && right === undefined) {
        const rules = await hud.comparisons(board);
        return emit(rules, rules.length ? rules.map((r) => `${r.id}  ${r.left} ${r.relation} ${r.right}${r.tolerance === undefined ? '' : ` ±${r.tolerance}`}${r.holdFor === undefined ? '' : ` hold=${r.holdFor}s`}${r.maxSkew === undefined ? '' : ` maxSkew=${r.maxSkew}s`}`).join('\n') : `no comparisons on ${board}`);
      }
      if (typeof left !== 'string' || typeof right !== 'string' || !['equal', 'lte', 'gte'].includes(String(relation))) throw new UsageError('compare needs <board> <left> <equal|lte|gte> <right>');
      const rule = {
        left,
        right,
        relation: relation as 'equal' | 'lte' | 'gte',
        ...(flags.tolerance !== undefined ? { tolerance: Number(flags.tolerance) } : {}),
        ...(flags.holdFor !== undefined ? { holdFor: Number(flags.holdFor) } : {}),
        ...(flags.maxSkew !== undefined ? { maxSkew: Number(flags.maxSkew) } : {}),
      };
      const result = await hud.addComparison(board, rule);
      return emit(result, `added comparison ${result.id}: ${result.left} ${result.relation} ${result.right}`);
    }
    case 'lint': {
      const board = rest[0] ?? flags.board ?? 'main';
      const result = await hud.lint(board);
      const text = typeof (result as any).text === 'string' ? (result as any).text : JSON.stringify(result, null, 2);
      return emit(result, text);
    }
    case 'graph':
    case 'canvas': {
      const isCanvas = cmd === 'canvas';
      const target = rest[0] ?? flags.board ?? 'main';
      let action = flags.action;
      let program: any;
      if (flags.file !== undefined) {
        try {
          const fileDoc = JSON.parse(readFileSync(String(flags.file), 'utf8'));
          program = fileDoc?.program ?? fileDoc;
        } catch (e) {
          throw new UsageError(`invalid program JSON in --file: ${(e as Error).message}`);
        }
      }
      if (flags['code-file'] !== undefined) {
        const code = readFileSync(String(flags['code-file']), 'utf8');
        const language = flags.language ?? 'html';
        if (!['html', 'javascript', 'svg'].includes(language)) throw new UsageError('--language must be html|javascript|svg');
        const bindings = flags.bindings ?? flags.binding ?? [];
        const capabilities = flags.capabilities ?? flags.capability ?? [];
        const capabilityList = Array.isArray(capabilities) ? capabilities : [capabilities];
        program = {
          code,
          language,
          description: flags.description ?? 'agent-authored renderer',
          bindings: (Array.isArray(bindings) ? bindings : [bindings]).flatMap((v: unknown) => String(v).split(',')).filter(Boolean),
          capabilities: capabilityList.flatMap((v: unknown) => Array.isArray(v) ? v : String(v).split(',')).filter(Boolean).map((v: unknown) => {
            if (typeof v === 'object' && v !== null) return v;
            const [operation, ...scope] = String(v).split(':');
            if (!operation || !scope.length) throw new UsageError('--capability uses operation:scope');
            return { operation, scope: scope.join(':') };
          }),
        };
      }
      if (program && (!program.code || !program.description)) throw new UsageError('program JSON requires code and description');
      if (!action) action = program ? 'preview' : 'get';
      if (!['get', 'preview', 'apply', 'disable', 'delete'].includes(action)) throw new UsageError('--action must be get|preview|apply|disable|delete');
      const expectedRevision = flags['expected-revision'] === undefined ? undefined : String(flags['expected-revision']);
      if (action === 'get') {
        if (program) throw new UsageError('use --action preview or apply when providing program code');
        const result = isCanvas ? await hud.boardProgram(target) : await hud.itemProgram(target);
        return emit(result, result.program ? JSON.stringify(result.program, null, 2) : `no ${isCanvas ? 'canvas' : 'item'} program on ${target}`);
      }
      if (action === 'delete') {
        const result = isCanvas ? await hud.deleteBoardProgram(target, expectedRevision) : await hud.deleteItemProgram(target, expectedRevision);
        return emit(result, `deleted ${isCanvas ? 'canvas' : 'item'} program on ${target}`);
      }
      const request = { action, ...(program ? { program } : {}), ...(expectedRevision ? { expectedRevision } : {}) } as ProgramAction;
      const result = isCanvas ? await hud.boardProgramAction(target, request) : await hud.itemProgramAction(target, request);
      return emit(result, JSON.stringify(result, null, 2));
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
        return emit(await hud.editComment(b, c, text, flags.format), `edited comment ${c} on ${b}`);
      }
      const text = rest.slice(1).join(' ');
      if (!text.trim()) throw new UsageError('usage: hud comment <id> <text...>');
      return emit(await hud.comment(a, text, flags.format), `commented on ${a}`);
    }
    case 'log': {
      const list = await hud.activityOf(rest[0], flags.limit);
      return emit(list, list.length ? list.map((a: any) => `${new Date(a.t).toLocaleString()}  ${a.actor}  ${a.action}  ${a.text}`).join('\n') : 'no activity');
    }
    case 'ask': {
      const arr = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
      const list = [...arr(flags.option), ...arr(flags.options).flat()].map((o) => (typeof o === 'string' ? { label: o } : (o as { label: string })));
      if (!list.length) throw new UsageError('hud ask needs at least one --option');
      const tk = (await hud.ask(rest[0], list, flags.question, flags.questionFormat)) as { id: string; ident?: string; status?: string; question?: string; decisionVersion?: string; options?: { id: string; label: string; status?: string }[] };
      return emit(tk, `${tk.ident ?? tk.id} ${tk.status} — needs a decision${tk.question ? `: ${tk.question}` : ''}\n${(tk.options ?? []).map((o) => `  ${o.id}  ${o.label}${o.status ? ` [→${o.status}]` : ''}`).join('\n')}\nrevision: ${tk.decisionVersion ?? '—'}`);
    }
    case 'decide': {
      const optionId = rest[1] ?? flags.optionId;
      if (optionId === undefined) throw new UsageError('usage: hud decide <id> <optionId>');
      if (typeof flags.version !== 'string' || !flags.version) throw new UsageError('--version is required (use hud show <id> to read decisionVersion)');
      const tk = (await hud.decide(rest[0], String(optionId), flags.note, flags.version)) as { id: string; ident?: string; status?: string };
      return emit(tk, `decided ${tk.ident ?? tk.id} → ${tk.status}`);
    }
    case 'finish': {
      if (flags.all && !flags.export) throw new UsageError('--all requires --export');
      const r = await hud.finish({ board: flags.board, ids: rest.length ? rest : undefined, note: flags.note, organize: flags['no-organize'] ? false : undefined, export: flags.export ? true : undefined, exportAll: flags.all ? true : undefined });
      const exported = r.exports?.length ? `\n${r.exports.map((e) => `exported ${e.ident} → backups/${e.name} (${e.entries} entries, ${e.attachments} files)`).join('\n')}` : '';
      return emit(r, (r.done.length ? `finished ${r.board}: ${r.done.join(', ')}` : `finished ${r.board}: nothing left to complete`) + exported);
    }
    case 'run': {
      const it = await hud.run(rest[0]);
      return emit(it, line(it));
    }
    case 'approve': {
      if (typeof flags.revision !== 'string' || !flags.revision) throw new UsageError('--revision is required (read it from hud attention)');
      const it = await hud.approveCommand(rest[0], flags.revision);
      return emit(it, `approved ${line(it)}`);
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
    case 'reveal': {
      const r = await hud.revealData();
      return emit(r, `opened ${r.dataDir}`);
    }
    case 'backup': {
      if (rest[0] === 'restore') {
        if (!rest[1]) throw new UsageError('usage: hud backup restore <name>');
        const r = await hud.restoreBackup(rest[1]);
        return emit(r, `restored ${r.name}: ${r.items} items, ${r.boards} boards; previous state backed up as ${r.backup}`);
      }
      if (rest.length) throw new UsageError('usage: hud backup [--list] [--reason text] | hud backup restore <name>');
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
      if (sub === 'clear') {
        if (!a) throw new UsageError('usage: hud board clear <id>');
        const result = await hud.clearBoard(a);
        return emit(result, `cleared canvas ${a}: ${result.cleared} items moved to trash; board settings retained`);
      }
      if (sub === 'rm' || sub === 'delete') {
        if (!a) throw new UsageError('usage: hud board rm <id>');
        return emit(await hud.request('DELETE', `/api/boards/${encodeURIComponent(a)}`));
      }
      throw new UsageError(`unknown board command "${sub}"`);
    }
    case 'guide': {
      const section = typeof flags.section === 'string' ? flags.section : undefined;
      const flagged = typeof flags.playbook === 'string' ? flags.playbook : undefined;
      if (rest[0] && flagged && rest[0] !== flagged) throw new UsageError('pass one playbook');
      const out = renderGuide(config().port, { section, playbook: flagged ?? rest[0], format: json ? 'json' : undefined });
      if (out.status !== 200) {
        const body = out.body as { error?: string; sections?: string[] };
        const list = body.sections?.length ? `; sections: ${body.sections.join(', ')}` : '';
        const message = `${body.error ?? 'bad guide request'}${list}`;
        if (out.status === 400) throw new UsageError(message);
        throw new Error(message);
      }
      return raw(typeof out.body === 'string' ? out.body : JSON.stringify(out.body, null, 2));
    }
    case 'quickstart':
      return raw(quickstartText(config().port));
    case 'views': {
      const { dir, views } = await hud.views();
      if (json) return emit(views);
      if (!views.length) return emit(views, `no renderer modules in ${dir}\nadd an ES module exporting render(ctx), then use display: "view:<name>"`);
      return emit(views, `renderer modules in ${dir}:\n` + views.map((v) => `  ${v.name.replace(/\.js$/, '')}  ${new Date(v.mtime).toLocaleString()}  ${v.bytes}b`).join('\n'));
    }
    case 'view': {
      const sub = rest[0] ?? 'list';
      const name = rest[1];
      if (sub === 'list') {
        const { dir, views } = await hud.views();
        return emit(views, views.length ? views.map((v) => `${v.name}  ${v.bytes}b  ${v.valid === false ? `invalid: ${(v.errors || []).join('; ')}` : 'valid'}`).join('\n') + `\n${dir}` : `no renderer modules in ${dir}`);
      }
      if (!name) throw new UsageError(`view ${sub} requires a name`);
      if (sub === 'show') {
        const v = await hud.viewGet(name);
        return emit(v, `// ${v.name} sha256=${v.sha256}\n${v.code}`);
      }
      if (sub === 'generate') {
        if (!flags.spec) throw new UsageError('generate requires --spec JSON');
        const r = await hud.viewGenerate(name, JSON.parse(String(flags.spec)), { write: !!flags.write, overwrite: !!flags.overwrite });
        if (flags.display && r.written) await hud.update(String(flags.display), { display: `view:${name}` });
        return emit(r, `${r.written ? 'wrote' : 'generated (not written)'} ${name}${r.written ? ` at ${r.path}` : ''}\nvalidation: ${r.validation.ok ? 'ok' : r.validation.errors.join('; ')}\nTrust: this module runs unsandboxed in the board page. Only install code you trust.`);
      }
      if (sub === 'set') {
        if (!flags['code-file']) throw new UsageError('set requires --code-file path');
        const r = await hud.viewWrite(name, { code: readFileSync(String(flags['code-file']), 'utf8'), overwrite: !!flags.overwrite, expectedSha256: flags['expected-sha'] as string | undefined });
        return emit(r, `${formatViewReview(r)}\nhud view approve ${name} --proposal ${r.id} --sha ${r.sha256}`);
      }
      if (sub === 'approve') {
        if (!flags.proposal || !flags.sha) throw new UsageError('approve requires --proposal <id> --sha <sha256>');
        const r = await hud.viewApprove(name, { proposalId: String(flags.proposal), sha256: String(flags.sha) });
        return emit(r, `installed ${name} (${r.sha256})\nTrust: this module runs unsandboxed in the board page. The installed bytes are the reviewed module.`);
      }
      if (sub === 'validate') {
        const code = flags['code-file'] ? readFileSync(String(flags['code-file']), 'utf8') : undefined;
        const r = await hud.viewValidate(name, code);
        return emit(r, `${r.ok ? 'valid' : 'invalid'}${r.rendered ? ' · rendered' : ''}${r.errors.length ? `\n${r.errors.join('\n')}` : ''}${r.renderErrors?.length ? `\nrender: ${r.renderErrors.join(' | ')}` : ''}`);
      }
      if (sub === 'rm' || sub === 'delete') {
        const r = await hud.viewDelete(name, flags['expected-sha'] as string | undefined);
        return emit(r, `deleted ${name}`);
      }
      throw new UsageError(`unknown view command "${sub}" — try: hud view list|show|generate|set|approve|validate|rm`);
    }
    case 'mcp': {
      const sub = rest[0];
      if (sub === 'reconnect') {
        if (rest.length > 1) throw new UsageError('too many arguments for "hud mcp reconnect"');
        const before = await hud.reconnect();
        const offer = flags['dry-run'] ? before : await hud.reconnectAck();
        const note = !before.pending ? '' : flags['dry-run'] ? '\n(dry run — reminder kept)' : '\nReminder cleared.';
        return emit(offer, `${offer.text}${note}`);
      }
      if (sub) {
        const { mcpCommand } = await import('./mcpinstall.ts');
        process.exitCode = await mcpCommand(sub, rest.slice(1), flags);
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
