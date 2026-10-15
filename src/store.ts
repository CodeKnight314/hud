import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Activity, Alert, Board, Comment, DecisionOption, HudEvent, Item, ItemType, MonState, MonitorResult, MonitorSource, SearchQuery, State, TrashEntry } from './types.ts';
import { TICKET_PRIORITIES, TICKET_STATUSES } from './types.ts';

export class HudError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** bump with a migration in the Store constructor whenever the meaning of stored data changes */
export const STATE_VERSION = 5;

const TYPES: ItemType[] = ['ticket', 'monitor', 'note', 'frame', 'util', 'project'];
const PREFIX: Record<ItemType, string> = { ticket: 't', monitor: 'm', note: 'n', frame: 'f', util: 'u', project: 'p' };
const SIZE: Record<ItemType, [number, number]> = {
  ticket: [280, 150],
  monitor: [260, 150],
  note: [260, 160],
  frame: [620, 420],
  util: [300, 190],
  project: [360, 200],
};
const ID_RE = /^[a-zA-Z0-9][\w.-]{0,63}$/;
/** names every plain object inherits (`__proto__`, `constructor`, `toString`, …): never valid ids */
const RESERVED_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const GRID = 20;
const MAX_COORD = 10_000_000;
const MAX_SIZE = 100_000;
const HISTORY_MAX = 240;
const LOG_MAX = 100;
const ACTIVITY_MAX = 5000;
const COMMENTS_MAX = 1000;
const STATES: MonState[] = ['ok', 'warn', 'error', 'unknown', 'running', 'done'];
const SOURCE_KINDS = ['manual', 'push', 'command', 'http', 'probe', 'heartbeat'];
/** fixed chart views (web/views.js); 'auto' adapts, 'view:<name>' loads a module from views/ instead */
const DISPLAYS = [
  'auto', 'value', 'progress', 'status', 'text', 'log', 'spark',
  'line', 'area', 'bars', 'gauge', 'histogram', 'scatter', 'pie', 'donut',
  'heatmap', 'box', 'ridgeline', 'scatter3d', 'surface3d',
] as const;
/** utility kinds the canvas knows how to draw (web/utils.js) */
const UTIL_KINDS = ['timer', 'stopwatch', 'clock', 'counter', 'calculator', 'sheet', 'markdown', 'dice'] as const;
const TREND_MAX = 1440;
const TRASH_MAX = 500;
const TRASH_DAYS = 30;
const BACKUPS_KEEP = 30;
const ALERTS_MAX = 300;
const OPTIONS_MAX = 8;
/** status a decided option moves the ticket to when the option doesn't name one */
const DECIDE_STATUS = 'doing';
/** monitor fields a push may also set (so a monitor created by pushing can be fully configured) */
const PUSH_CONFIG = ['max', 'display', 'plot', 'staleAfter', 'warnAbove', 'errorAbove', 'warnBelow', 'errorBelow', 'notify', 'group'] as const;
/** a PATCH carrying one of these is a monitor reading, even when it re-asserts the current value */
const READING_KEYS = ['value', 'state', 'message', 'progress'];

// field limits (400 when exceeded, except `message` which is truncated)
const LIMIT = { title: 300, body: 200_000, comment: 20_000, message: 2048, value: 10_000, label: 200, unit: 32, person: 80, tags: 50, tag: 50, json: 256_000, depth: 20 };
const FANOUT_MAX = 1000;
const FANOUT_DEPTH = 4;

const COMMON_KEYS = ['title', 'board', 'x', 'y', 'w', 'h', 'meta', 'group'];
const TYPE_KEYS: Record<ItemType, string[]> = {
  ticket: [
    'body', 'status', 'priority', 'assignee', 'tags', 'monitors', 'autoStatus', 'options', 'question', 'decision', 'notify',
    // Linear-style structure
    'project', 'parent', 'blockedBy', 'refs', 'branch', 'target',
  ],
  monitor: [
    'source', 'display', 'plot', 'value', 'unit', 'state', 'message', 'progress', 'max', 'label', 'notify',
    'staleAfter', 'warnAbove', 'errorAbove', 'warnBelow', 'errorBelow',
  ],
  note: ['text'],
  frame: [],
  util: ['kind', 'util', 'text'],
  project: ['key', 'lead', 'body', 'target', 'status', 'tags', 'notify'],
};
/** ticket id arrays: relationships to other items */
const TICKET_REFS = ['blockedBy', 'refs'] as const;
/** prefix for a project's ticket identifiers; uppercase, starts with a letter */
const KEY_RE = /^[A-Z][A-Z0-9]{1,7}$/;
const IDENT_RE = /^([A-Za-z][A-Za-z0-9]{1,7})-(\d+)$/;

const now = () => Date.now();
const snap = (n: number) => Math.round(n / GRID) * GRID;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** a prototype-less id → value map, so user-supplied ids like `__proto__` or `constructor` are plain keys */
export function dict<T>(src?: Record<string, T> | null): Record<string, T> {
  const d = Object.create(null) as Record<string, T>;
  if (src) for (const k of Object.keys(src)) d[k] = src[k];
  return d;
}

// ---------- canonical values ----------
const STATUS_ALIAS: Record<string, string> = {
  cancelled: 'canceled', 'in progress': 'doing', 'in-progress': 'doing', inprogress: 'doing', started: 'doing',
  closed: 'done', complete: 'done', completed: 'done', open: 'todo',
};
const PRIORITY_ALIAS: Record<string, string> = { medium: 'med', p0: 'urgent', p1: 'high', p2: 'med', p3: 'low' };

/** a ticket status in canonical form; anything unknown is a 400 listing the valid values */
export function normStatus(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const c = Object.hasOwn(STATUS_ALIAS, s) ? STATUS_ALIAS[s] : s;
  if (!(TICKET_STATUSES as readonly string[]).includes(c)) throw new HudError(400, `status must be one of ${TICKET_STATUSES.join('|')} (got "${String(v).slice(0, 40)}")`);
  return c;
}

/** a ticket priority in canonical form, or undefined when cleared (none / empty) */
export function normPriority(v: unknown): string | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || s === 'none') return undefined;
  const c = Object.hasOwn(PRIORITY_ALIAS, s) ? PRIORITY_ALIAS[s] : s;
  if (!(TICKET_PRIORITIES as readonly string[]).includes(c)) throw new HudError(400, `priority must be one of ${TICKET_PRIORITIES.join('|')} (got "${String(v).slice(0, 40)}")`);
  return c;
}

// ---------- input validation ----------
function text(k: string, v: unknown, max: number): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') throw new HudError(400, `${k} must be a string`);
  const s = String(v);
  if (s.length > max) throw new HudError(400, `${k} is too long (${s.length} > ${max} characters)`);
  return s;
}

function num(k: string, v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new HudError(400, `${k} must be a finite number`);
  return n;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** readings from automated sources are cut to size rather than rejected */
const cut = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : v);

/** a list of short strings, from an array or a comma string; null clears; blanks and duplicates drop */
function list(k: string, v: unknown, maxItems: number, maxLen: number, ci = false): string[] {
  if (v === null || v === undefined) return [];
  if (isObj(v)) throw new HudError(400, `${k} must be a list`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(v) ? v : String(v).split(',')) {
    if (x !== null && typeof x === 'object') throw new HudError(400, `${k} must be a list of strings`);
    const s = String(x ?? '').trim();
    if (!s) continue;
    if (s.length > maxLen) throw new HudError(400, `${k}: "${s.slice(0, 20)}…" is longer than ${maxLen} characters`);
    const key = ci ? s.toLowerCase() : s;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  if (out.length > maxItems) throw new HudError(400, `${k} has too many entries (${out.length} > ${maxItems})`);
  return out;
}

function depthOk(v: unknown, d = 0): boolean {
  if (v === null || typeof v !== 'object') return true;
  if (d >= LIMIT.depth) return false;
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (!depthOk(x, d + 1)) return false;
  return true;
}

/** free-form JSON owned by clients (meta, util, plot, source): bounded depth and size so it can always be saved */
function json(k: string, v: unknown): void {
  if (!depthOk(v)) throw new HudError(400, `${k} is nested deeper than ${LIMIT.depth} levels`);
  let n: number;
  try {
    n = JSON.stringify(v).length;
  } catch {
    throw new HudError(400, `${k} is not valid JSON data`);
  }
  if (n > LIMIT.json) throw new HudError(400, `${k} is too large (${n} > ${LIMIT.json} bytes)`);
}

/** a monitor value: a short string, a finite number, a boolean or null */
function monitorValue(v: unknown): string | number | boolean | null {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new HudError(400, 'value must be a finite number');
    return v;
  }
  if (typeof v === 'string') return v.length > LIMIT.value ? v.slice(0, LIMIT.value) : v;
  throw new HudError(400, 'value must be a string, number, boolean or null');
}

/** a monitor message: any scalar, truncated to a couple of KB */
function monitorMessage(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'object') throw new HudError(400, 'message must be a string');
  return String(v).slice(0, LIMIT.message);
}

/** git ref-format rules (spaces, `..`, `~^:?*[\`, `@{`, leading/trailing `/` `.`, `.lock`, control chars) */
const BAD_BRANCH = /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/;

/** a display is either a fixed kind or a renderer module reference `view:<name>` */
function isDisplay(v: string): boolean {
  if ((DISPLAYS as readonly string[]).includes(v)) return true;
  return /^view:[\w][\w.-]{0,63}$/.test(v);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'board';
}

/** branch-name slug: accents stripped, non-Latin dropped, trimmed again after the cut */
function branchSlug(s: string): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function contains(frame: Item, it: Item) {
  if (frame.id === it.id || it.w * it.h >= frame.w * frame.h) return false;
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h;
}

/** hashed spatial index over item rects, so placement probes touch only nearby items */
class Grid {
  static CELL = 256;
  cells = new Map<number, Item[]>();
  /** items spanning too many cells to hash; always tested */
  big: Item[] = [];
  private key(cx: number, cy: number) {
    return (cx + 1_048_576) * 2_097_152 + (cy + 1_048_576);
  }
  add(o: Item) {
    const c = Grid.CELL;
    const x0 = Math.floor(o.x / c), x1 = Math.floor((o.x + o.w) / c), y0 = Math.floor(o.y / c), y1 = Math.floor((o.y + o.h) / c);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) return void this.big.push(o);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        const l = this.cells.get(k);
        if (l) l.push(o);
        else this.cells.set(k, [o]);
      }
  }
  /** the overlapping item reaching furthest right, or undefined when the padded rect is free */
  hit(x: number, y: number, w: number, h: number, pad: number): Item | undefined {
    let best: Item | undefined;
    const test = (o: Item) => {
      if (x < o.x + o.w + pad && o.x < x + w + pad && y < o.y + o.h + pad && o.y < y + h + pad && (!best || o.x + o.w > best.x + best.w)) best = o;
    };
    for (const o of this.big) test(o);
    const c = Grid.CELL;
    const x0 = Math.floor((x - pad) / c), x1 = Math.floor((x + w + pad) / c), y0 = Math.floor((y - pad) / c), y1 = Math.floor((y + h + pad) / c);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) for (const o of this.cells.get(this.key(cx, cy)) ?? []) test(o);
    return best;
  }
}

type Rollup = { total: number; done: number };
/** per-snapshot ticket graph, rebuilt lazily after any mutation */
interface TicketIndex {
  children: Map<string, Item[]>;
  blocks: Map<string, Item[]>;
  ident: Map<string, Item[]>;
  rollups: Map<string, Rollup>;
}

export class Store extends EventEmitter {
  file: string;
  state: State;
  /** newest valid backup used because state.json was unreadable (reported in health) */
  recoveredFrom?: string;
  /** last save error, cleared by the next successful save */
  saveError?: string;
  lastSave?: number;
  private dir: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private idx: TicketIndex | null = null;
  private backupTimer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    super();
    this.file = file;
    this.dir = dirname(file);
    this.state = { version: STATE_VERSION, seq: dict(), boards: [], items: dict(), activity: [], alerts: [], trash: [] };
    let fileText: string | undefined;
    let raw: Record<string, any> | undefined;
    this.cleanTmp();
    if (existsSync(file)) {
      try {
        fileText = readFileSync(file, 'utf8');
        raw = this.parseState(fileText);
      } catch (e) {
        const bad = `${file}.corrupt-${now()}`;
        try {
          renameSync(file, bad);
        } catch {}
        console.error(`[hud] could not read ${file} (${(e as Error).message}); moved to ${bad}`);
        fileText = undefined;
        const rec = this.newestBackup();
        if (rec) {
          raw = rec.state;
          this.recoveredFrom = rec.name;
          console.error(`[hud] recovered the board from backup ${rec.name}`);
        }
      }
    }
    const version = raw ? (typeof raw.version === 'number' && Number.isFinite(raw.version) ? Math.floor(raw.version) : 1) : STATE_VERSION;
    if (version > STATE_VERSION)
      throw new HudError(500, `${file} was written by a newer hud (state version ${version}; this build reads up to ${STATE_VERSION}). Refusing to load or rewrite it. Update hud, or restore an older backup.`);
    if (raw && fileText !== undefined) this.backupRaw(fileText, version < STATE_VERSION ? `premigrate-v${version}` : 'start');
    if (raw) this.adopt(raw);
    this.state.version = raw ? version : STATE_VERSION;
    if (!this.state.boards.some((b) => b.id === 'main')) this.state.boards.unshift({ id: 'main', name: 'main', createdAt: now() });
    this.migrate();
    if (this.repair()) this.save();
    this.pruneTrash();
  }

  /** the loaded document, or a throw naming what is wrong with it */
  private parseState(txt: string): Record<string, any> {
    const v = JSON.parse(txt);
    if (!isObj(v)) throw new Error('not a JSON object');
    return v;
  }

  /** take over a parsed state document, tolerating missing or mistyped sections */
  private adopt(raw: Record<string, any>) {
    const s = this.state;
    if (isObj(raw.seq)) for (const [k, v] of Object.entries(raw.seq)) if (typeof v === 'number' && Number.isFinite(v)) s.seq[k] = v;
    if (Array.isArray(raw.boards)) s.boards = raw.boards.filter((b) => isObj(b) && typeof b.id === 'string' && typeof b.name === 'string');
    if (isObj(raw.items)) {
      for (const [id, it] of Object.entries(raw.items)) {
        if (!isObj(it) || !TYPES.includes(it.type)) {
          console.error(`[hud] skipping item "${id}": not a valid item`);
          continue;
        }
        it.id = id;
        s.items[id] = it as Item;
      }
    }
    if (Array.isArray(raw.activity)) s.activity = raw.activity.filter(isObj) as Activity[];
    if (Array.isArray(raw.alerts)) s.alerts = raw.alerts.filter((a) => isObj(a) && Array.isArray(a.notify)) as Alert[];
    if (Array.isArray(raw.trash)) s.trash = raw.trash.filter((e) => isObj(e) && isObj(e.item) && typeof e.item.id === 'string');
  }

  /** v1 → current. Each step is additive or rewrites in place; the file was copied to backups/ first. */
  private migrate() {
    const s = this.state;
    const from = s.version;
    if (s.version < 2) {
      // v1 inferred frame membership from position; store it as `group` so layout changes can't reassign it
      for (const it of Object.values(s.items)) {
        if (it.type === 'frame' || it.group) continue;
        const f = this.frameAt(it);
        if (f?.title.trim()) it.group = f.title.trim();
      }
      s.version = 2;
    }
    // v3 added ticket decision options; additive
    if (s.version < 3) s.version = 3;
    if (s.version < 4) {
      // v4 added projects (KEY-n identifiers, branches, parent/dependency links). Additive, but give the
      // tickets that predate it the branch they would have been created with.
      for (const it of Object.values(s.items)) if (it.type === 'ticket' && !it.branch) it.branch = this.branchName(it);
      s.version = 4;
    }
    if (s.version < 5) {
      // v5: canonical ticket status/priority (unknown values become todo / none, with a comment saying what they were)
      for (const it of Object.values(s.items)) {
        if (it.type !== 'ticket' && it.type !== 'project') continue;
        const fallback = it.type === 'ticket' ? 'todo' : 'backlog';
        const old = it.status;
        try {
          it.status = normStatus(it.status);
        } catch {
          it.status = fallback;
          if (it.type === 'ticket' && old != null && old !== '') this.addComment(it, 'hud', `status "${String(old).slice(0, 40)}" is not a known status; set to ${fallback}`);
        }
        if (it.priority != null) {
          const p = it.priority;
          try {
            const n = normPriority(p);
            if (n) it.priority = n;
            else delete it.priority;
          } catch {
            delete it.priority;
            if (it.type === 'ticket') this.addComment(it, 'hud', `priority "${String(p).slice(0, 40)}" is not a known priority; cleared`);
          }
        }
      }
      s.trash ??= [];
      s.version = 5;
    }
    if (s.version !== from) this.save();
  }

  /**
   * Make whatever was loaded safe to work with: field types, dangling or cross-board links, duplicate
   * project keys and ticket numbers, parent cycles. Never drops an item. Returns how many fixes it made.
   */
  private repair(): number {
    let fixed = 0;
    const items = this.state.items;
    const boards = new Set(this.state.boards.map((b) => b.id));
    const fix = (cond: boolean, f: () => void) => {
      if (cond) {
        f();
        fixed++;
      }
    };
    const str = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
    for (const it of Object.values(items)) {
      fix(typeof it.title !== 'string', () => (it.title = it.title == null ? '' : str(it.title)));
      for (const k of ['x', 'y', 'w', 'h'] as const)
        fix(!Number.isFinite(it[k]), () => (it[k] = k === 'w' ? SIZE[it.type][0] : k === 'h' ? SIZE[it.type][1] : 0));
      fix(typeof it.board !== 'string' || !boards.has(it.board), () => (it.board = 'main'));
      for (const k of ['createdAt', 'updatedAt'] as const) fix(!Number.isFinite(it[k]), () => (it[k] = now()));
      for (const k of ['createdBy', 'updatedBy'] as const) fix(typeof it[k] !== 'string', () => (it[k] = 'hud'));
      for (const k of ['message', 'text', 'body', 'label', 'unit', 'status', 'priority', 'assignee'] as const) {
        const v = it[k] as unknown;
        fix(v != null && typeof v !== 'string', () => ((it as unknown as Record<string, unknown>)[k] = str(v)));
      }
      for (const k of ['tags', 'comments', 'monitors', 'blockedBy', 'refs', 'notify', 'history', 'log'] as const)
        fix(it[k] !== undefined && !Array.isArray(it[k]), () => delete it[k]);
      if (it.comments) fix(it.comments.some((c) => !isObj(c)), () => (it.comments = it.comments!.filter(isObj) as Comment[]));
      for (const k of ['meta', 'util', 'source', 'plot'] as const) fix(it[k] !== undefined && !isObj(it[k]), () => delete it[k]);
    }
    const tickets = Object.values(items).filter((i) => i.type === 'ticket');
    const same = (id: unknown, it: Item) => typeof id === 'string' && items[id]?.type === 'ticket' && items[id].board === it.board && id !== it.id;
    for (const it of tickets) {
      fix(!!it.project && (items[it.project]?.type !== 'project' || items[it.project].board !== it.board), () => this.leaveProject(it, 'project is gone'));
      fix(!!it.parent && !same(it.parent, it), () => delete it.parent);
      for (const k of TICKET_REFS) {
        const ids = it[k];
        fix(!!ids && ids.some((x) => !same(x, it)), () => (it[k] = [...new Set(ids!.filter((x) => same(x, it)))]));
      }
    }
    for (const it of tickets) {
      const seen = new Set([it.id]);
      for (let cur: Item = it; cur.parent; cur = items[cur.parent]) {
        if (seen.has(cur.parent)) {
          fix(true, () => delete cur.parent);
          break;
        }
        seen.add(cur.parent);
      }
    }
    // unique, well-formed project keys per board
    const keys = new Set<string>();
    for (const p of this.projects()) {
      const k = (p.key ?? '').toUpperCase();
      if (KEY_RE.test(k) && !keys.has(`${p.board}:${k}`)) {
        keys.add(`${p.board}:${k}`);
        if (p.key !== k) fix(true, () => (p.key = k));
        continue;
      }
      fix(true, () => this.setKey(p, this.deriveKey(p.title, p.board, p.id), 'hud'));
      keys.add(`${p.board}:${p.key}`);
    }
    // unique ticket numbers within a project (or the loose sequence); counters never trail the numbers in use
    for (const it of tickets) {
      if (typeof it.num !== 'number' || !Number.isFinite(it.num)) continue;
      const k = it.project ? `ticketNum:${it.project}` : 'ticketNum';
      if ((this.state.seq[k] ?? 0) < it.num) this.state.seq[k] = it.num;
    }
    const nums = new Set<string>();
    for (const it of tickets.sort((a, b) => a.createdAt - b.createdAt)) {
      const k = `${it.project ?? ''}:${it.num}`;
      if (typeof it.num === 'number' && Number.isFinite(it.num) && !nums.has(k)) {
        nums.add(k);
        continue;
      }
      fix(true, () => {
        const old = this.ident(it);
        it.num = this.nextNum(it.project);
        nums.add(`${it.project ?? ''}:${it.num}`);
        this.addComment(it, 'hud', `renumbered ${old} → ${this.ident(it)} (duplicate identifier)`);
      });
    }
    return fixed;
  }

  /** item as sent to clients: the 24h trend only goes out with GET /api/items/:id */
  static lite(it: Item): Item {
    if (!it.trend) return it;
    const { trend: _t, ...rest } = it;
    return rest as Item;
  }

  // ---------- persistence ----------
  /** debounced write; a failed write is retried every 2 s until it lands */
  private save() {
    this.idx = null;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  private tmpSeq = 0;
  /** Write the state now. Never throws: a failed save is recorded (health().saveError) and retried. */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    // The tmp name is unique per write: a fixed `state.json.tmp` collides when anything else shares this
    // data dir, and the loser's rename then threw ENOENT and took the whole process — and the board — down.
    const tmp = `${this.file}.${process.pid}.${++this.tmpSeq}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
      this.lastSave = now();
      this.saveError = undefined;
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {}
      const msg = (e as Error).message;
      if (msg !== this.saveError) console.error(`[hud] could not save ${this.file}: ${msg} (retrying every 2s)`);
      this.saveError = msg;
      this.saveTimer = setTimeout(() => this.flush(), 2000);
    }
  }

  /** persistence status for GET /api/health */
  health(): { saveError?: string; lastSave?: number; recoveredFrom?: string; items: number; version: number } {
    return { saveError: this.saveError, lastSave: this.lastSave, recoveredFrom: this.recoveredFrom, items: Object.keys(this.state.items).length, version: this.state.version };
  }

  /** orphaned `state.json.<pid>.<n>.tmp` files from a crash mid-write */
  private cleanTmp() {
    try {
      const prefix = `${basename(this.file)}.`;
      for (const f of readdirSync(this.dir)) if (f.startsWith(prefix) && f.endsWith('.tmp')) rmSync(join(this.dir, f), { force: true });
    } catch {}
  }

  // ---------- backups: the load side (writing them on a schedule lives with backup()) ----------
  get backupDir() {
    return join(this.dir, 'backups');
  }

  /** `state-<YYYYMMDD-HHMMSS>[-reason].json` files, newest first */
  listBackups(): { name: string; t: number; bytes: number }[] {
    try {
      return readdirSync(this.backupDir)
        .filter((n) => /^state-.*\.json$/.test(n))
        .map((name) => {
          const st = statSync(join(this.backupDir, name));
          return { name, t: st.mtimeMs, bytes: st.size };
        })
        .sort((a, b) => b.t - a.t || (a.name < b.name ? 1 : -1));
    } catch {
      return [];
    }
  }

  /** the newest backup that parses as a state document with an items map */
  private newestBackup(): { name: string; state: Record<string, any> } | undefined {
    for (const b of this.listBackups()) {
      try {
        const s = this.parseState(readFileSync(join(this.backupDir, b.name), 'utf8'));
        if (isObj(s.items)) return { name: b.name, state: s };
      } catch {}
    }
    return undefined;
  }

  /** write raw state text into backups/ as state-<ts>[-reason].json; returns the file name */
  protected backupRaw(data: string, reason?: string): string {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const slug = reason ? `-${reason.replace(/[^\w.-]+/g, '-').slice(0, 40)}` : '';
    let name = `state-${ts}${slug}.json`;
    for (let n = 2; existsSync(join(this.backupDir, name)); n++) name = `state-${ts}${slug}-${n}.json`;
    mkdirSync(this.backupDir, { recursive: true });
    writeFileSync(join(this.backupDir, name), data);
    try {
      for (const b of this.listBackups().slice(BACKUPS_KEEP)) rmSync(join(this.backupDir, b.name), { force: true });
    } catch {}
    return name;
  }

  /** snapshot the live state into backups/ (newest 30 kept); returns the file name */
  backup(reason?: string): string {
    return this.backupRaw(JSON.stringify(this.state), reason);
  }

  /** take an hourly backup while the process runs; call once from the server */
  startBackups(everyMs = 3_600_000) {
    if (this.backupTimer) return;
    this.backupTimer = setInterval(() => {
      try {
        this.backup('hourly');
      } catch (e) {
        console.error(`[hud] hourly backup failed: ${(e as Error).message}`);
      }
    }, everyMs);
    this.backupTimer.unref();
  }

  stopBackups() {
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.backupTimer = null;
  }

  private emitEvent(e: HudEvent) {
    this.idx = null;
    this.emit('event', e);
  }

  private log(actor: string, action: string, text: string, item?: Item) {
    const a: Activity = {
      id: (this.state.seq.activity = (this.state.seq.activity ?? 0) + 1),
      t: now(),
      actor,
      action,
      itemId: item?.id,
      board: item?.board,
      text,
    };
    this.state.activity.push(a);
    if (this.state.activity.length > ACTIVITY_MAX) this.state.activity.splice(0, this.state.activity.length - ACTIVITY_MAX);
    this.emitEvent({ kind: 'activity', activity: a });
  }

  // ---------- boards ----------
  boards() {
    return this.state.boards;
  }

  board(idOrName: string) {
    const k = String(idOrName ?? '');
    return this.state.boards.find((b) => b.id === k) ?? this.state.boards.find((b) => b.name === k);
  }

  requireBoard(idOrName: string | undefined): Board {
    const b = this.board(idOrName ?? 'main');
    if (!b) throw new HudError(404, `no board "${String(idOrName).slice(0, 80)}". Create it first (boards: ${this.state.boards.map((b) => b.id).join(', ')})`);
    return b;
  }

  createBoard(name: string, actor: string, id?: string): Board {
    name = text('board name', name, 80).trim();
    if (!name) throw new HudError(400, 'board name required');
    const existing = this.board(id ?? name);
    if (existing) return existing;
    let bid = id && ID_RE.test(id) ? id : slugify(name);
    while (this.board(bid)) bid += '-' + Math.random().toString(36).slice(2, 5);
    const b: Board = { id: bid, name, createdAt: now() };
    this.state.boards.push(b);
    this.emitEvent({ kind: 'board', board: b });
    this.log(actor, 'board.created', `created board "${name}"`);
    this.save();
    return b;
  }

  setBoard(id: string, patch: { name?: string; autoOrganize?: boolean; notify?: string[] | string | null }, actor: string): Board {
    const b = this.requireBoard(id);
    if (patch.notify !== undefined) b.notify = list('notify', patch.notify, 50, LIMIT.person);
    if (patch.name !== undefined && String(patch.name).trim() && patch.name !== b.name) {
      b.name = text('board name', patch.name, 80).trim();
      this.log(actor, 'board.renamed', `renamed board ${b.id} to "${b.name}"`);
    }
    if (patch.autoOrganize !== undefined && !!patch.autoOrganize !== !!b.autoOrganize) {
      b.autoOrganize = !!patch.autoOrganize;
      this.log(actor, 'board.auto', `${b.autoOrganize ? 'enabled' : 'disabled'} auto-organize on ${b.id}`);
      if (b.autoOrganize) this.organize(b.id, actor);
    }
    this.emitEvent({ kind: 'board', board: b });
    this.save();
    return b;
  }

  /** Delete a board: its items go to the trash with a snapshot of the board, after a backup. */
  deleteBoard(id: string, actor: string) {
    const b = this.requireBoard(id);
    if (b.id === 'main') throw new HudError(400, 'the default board "main" cannot be deleted');
    this.backup(`predelete-${b.id}`);
    const t = now();
    const snapshot = JSON.parse(JSON.stringify(b)) as Board;
    for (const it of Object.values(this.state.items)) {
      if (it.board !== b.id) continue;
      this.state.trash.push({ item: it, t, actor, board: snapshot });
      delete this.state.items[it.id];
    }
    this.state.boards = this.state.boards.filter((x) => x.id !== b.id);
    clearTimeout(this.organizeTimers.get(b.id));
    this.organizeTimers.delete(b.id);
    this.pruneTrash();
    this.emitEvent({ kind: 'board.deleted', id: b.id });
    this.log(actor, 'board.deleted', `deleted board "${b.name}" (items are in the trash)`);
    this.save();
  }

  // ---------- items ----------
  items(filter: SearchQuery = {}) {
    return this.search(filter);
  }

  /** items matching every given filter; text matches title/body/ident/comments case-insensitively */
  search(q: SearchQuery = {}): Item[] {
    const board = q.board ? this.requireBoard(q.board).id : undefined;
    const m = this.matcher(q, board);
    let out = Object.values(this.state.items).filter((it) => (!board || it.board === board) && (!q.type || it.type === q.type) && m(it));
    const lim = Math.floor(Number(q.limit));
    if (Number.isFinite(lim) && lim > 0) out = out.slice(0, lim);
    return out;
  }

  /** predicate for the field filters of a SearchQuery (board and type are handled by the caller) */
  private matcher(q: SearchQuery, board?: string): (it: Item) => boolean {
    const want = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
    const statuses = (Array.isArray(q.status) ? q.status : (want(q.status) ?? '').split(','))
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
      .map((s) => {
        try {
          return normStatus(s);
        } catch {
          return s; // monitor states (ok, error, …)
        }
      });
    const prioRaw = want(q.priority);
    const prio = prioRaw === undefined ? undefined : prioRaw.toLowerCase() === 'none' ? null : normPriority(prioRaw);
    const assignee = want(q.assignee)?.toLowerCase();
    const tag = want(q.tag)?.toLowerCase();
    const textQ = want(q.text)?.toLowerCase();
    const projRef = want(q.project);
    const proj = projRef === undefined ? undefined : (this.project(projRef, board)?.id ?? null);
    const parentRef = want(q.parent);
    const parent = parentRef === undefined ? undefined : (this.ticket(parentRef, board)?.id ?? parentRef);
    const od = q.overdue as unknown;
    const overdue = !!od && String(od) !== '0' && String(od) !== 'false';
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return (it) => {
      if (statuses.length && !statuses.some((s) => it.status === s || it.state === s)) return false;
      if (prio !== undefined && (prio === null ? !!it.priority : it.priority !== prio)) return false;
      if (assignee && (it.assignee ?? '').toLowerCase() !== assignee) return false;
      if (tag && !(it.tags ?? []).some((x) => x.toLowerCase() === tag)) return false;
      if (proj !== undefined && (proj === null || it.project !== proj)) return false;
      if (parent !== undefined && it.parent !== parent) return false;
      if (overdue && !(it.type === 'ticket' && it.target && it.target < today && !this.isFinished(it))) return false;
      if (textQ) {
        const hay = [it.id, it.title, it.body, it.text, it.key, it.type === 'ticket' ? this.ident(it) : '', ...(it.comments ?? []).map((c) => c.text)];
        if (!hay.some((h) => typeof h === 'string' && h.toLowerCase().includes(textQ))) return false;
      }
      return true;
    };
  }

  get(id: string): Item {
    const it = typeof id === 'string' ? this.state.items[id] : undefined;
    if (!it) throw new HudError(404, `no item "${String(id).slice(0, 80)}"`);
    return it;
  }

  private nextId(type: ItemType) {
    const p = PREFIX[type];
    let id: string;
    do id = p + (this.state.seq[p] = (this.state.seq[p] ?? 0) + 1);
    while (this.state.items[id]);
    return id;
  }

  /** next ticket number: per-project, or the loose sequence for tickets without a project */
  private nextNum(project?: string): number {
    const k = project ? `ticketNum:${project}` : 'ticketNum';
    return (this.state.seq[k] = (this.state.seq[k] ?? 0) + 1);
  }

  /** a custom id for a new item: letters/digits, not an Object.prototype name, not something that reads as a ticket ident */
  private checkNewId(raw: unknown, type: ItemType): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const id = String(raw);
    if (!ID_RE.test(id)) throw new HudError(400, `invalid id "${id.slice(0, 80)}" (letters, digits, - _ . ; max 64)`);
    if (RESERVED_IDS.has(id)) throw new HudError(400, `"${id}" is a reserved id`);
    if (/^#?\d+$/.test(id)) throw new HudError(400, `id "${id}" reads as a ticket number; use a name with a letter in it`);
    const m = IDENT_RE.exec(id);
    if (m && (type === 'ticket' || this.projects().some((p) => (p.key ?? '').toLowerCase() === m[1].toLowerCase())))
      throw new HudError(400, `id "${id}" reads as a ticket identifier (KEY-n); pick another`);
    if (this.state.items[id]) throw new HudError(409, `item "${id}" already exists`);
    return id;
  }

  /** Find a free spot for a w×h rect, inside `frame` if given, otherwise on the open board. */
  place(board: string, w: number, h: number, frame?: Item, ignore?: string): { x: number; y: number } {
    const grid = new Grid();
    const others: Item[] = [];
    for (const i of Object.values(this.state.items)) {
      if (i.board !== board || i.id === ignore || (frame && i.id === frame.id)) continue;
      others.push(i);
      if (!frame || contains(frame, i) || i.type !== 'frame') grid.add(i);
    }
    const pad = GRID - 1;
    /**
     * Row-major scan over the GRID lattice anchored at (x0,y0), but jumping: past the blocker that stopped a
     * candidate (x), and past the earliest bottom edge among a row's blockers (y), since every candidate in
     * between is blocked by the same items. Visits the same first-free spot as probing every cell.
     */
    const scan = (x0: number, y0: number, xMax: number, yMax: number): { x: number; y: number } | undefined => {
      for (let y = y0; y + h <= yMax; ) {
        let x = x0;
        let nextY = Infinity;
        while (x + w <= xMax) {
          const b = grid.hit(x, y, w, h, pad);
          if (!b) return { x, y };
          nextY = Math.min(nextY, b.y + b.h + pad);
          x = x0 + Math.ceil((b.x + b.w + pad - x0) / GRID) * GRID;
        }
        if (nextY === Infinity) return undefined; // too narrow for any x
        y = y0 + Math.ceil((nextY - y0) / GRID) * GRID;
      }
      return undefined;
    };
    if (frame) {
      const x0 = frame.x + GRID, y0 = frame.y + GRID * 2;
      const spot = scan(x0, y0, frame.x + frame.w - GRID, frame.y + frame.h - GRID);
      if (spot) return spot;
      // no room: grow the frame downward and put it at the bottom
      const bottom = Math.max(y0, ...others.filter((o) => contains(frame, o)).map((o) => o.y + o.h + GRID));
      frame.h = snap(bottom + h + GRID - frame.y);
      frame.updatedAt = now();
      this.emitEvent({ kind: 'item', item: frame, actor: 'hud' });
      return { x: x0, y: bottom };
    }
    return scan(0, 0, Math.max(1600, w), 100000 + h) ?? { x: 0, y: 0 };
  }

  private clean(type: ItemType, input: Record<string, unknown>, partial: boolean): Partial<Item> {
    const out: Record<string, any> = {};
    for (const k of [...COMMON_KEYS, ...TYPE_KEYS[type]]) {
      if (!Object.hasOwn(input, k) || input[k] === undefined) continue;
      out[k] = input[k];
    }
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      if (!(k in out)) continue;
      if (out[k] === null) {
        delete out[k];
        continue;
      }
      const n = Math.round(num(k, out[k]));
      out[k] = k === 'w' || k === 'h' ? clamp(n, GRID * 4, MAX_SIZE) : clamp(n, -MAX_COORD, MAX_COORD);
    }
    if ('title' in out) out.title = text('title', out.title, LIMIT.title);
    if ('question' in out) out.question = text('question', out.question, 100_000).trim().slice(0, 500) || undefined;
    if ('group' in out) {
      if (type === 'frame') delete out.group;
      else out.group = text('group', out.group, 10_000).trim().slice(0, 80) || undefined;
    }
    if ('meta' in out) {
      if (out.meta !== null && !isObj(out.meta)) throw new HudError(400, 'meta must be an object');
      json('meta', out.meta);
      if (out.meta === null) out.meta = undefined;
    }
    for (const k of ['body', 'text'] as const) if (k in out) out[k] = text(k, out[k], LIMIT.body);
    for (const k of ['assignee', 'lead'] as const) if (k in out) out[k] = text(k, out[k], LIMIT.person).trim() || undefined;
    if ('tags' in out) out.tags = list('tags', out.tags, LIMIT.tags, LIMIT.tag, true);
    if ('monitors' in out) out.monitors = list('monitors', out.monitors, 100, 64);
    if ('notify' in out) out.notify = list('notify', out.notify, 50, LIMIT.person);
    if ('status' in out) out.status = normStatus(out.status);
    if ('priority' in out) out.priority = normPriority(out.priority);
    if ('state' in out) {
      if (out.state === null) delete out.state;
      else if (!STATES.includes(out.state)) throw new HudError(400, `state must be one of ${STATES.join('|')}`);
    }
    if ('display' in out) {
      if (out.display === null) out.display = 'auto';
      else if (typeof out.display !== 'string' || !isDisplay(out.display)) throw new HudError(400, `display must be one of ${DISPLAYS.join('|')} or view:<name>`);
    }
    if ('plot' in out) {
      if (out.plot === null) out.plot = undefined;
      else {
        if (!isObj(out.plot)) throw new HudError(400, 'plot must be an object');
        const p = out.plot;
        for (const k of ['yMin', 'yMax', 'bins', 'tilt', 'spin'] as const) if (p[k] != null) p[k] = num(`plot.${k}`, p[k]);
        if (p.yMin != null && p.yMax != null && Number(p.yMin) >= Number(p.yMax)) throw new HudError(400, 'plot.yMin must be below plot.yMax');
        json('plot', p);
      }
    }
    if ('kind' in out && out.kind !== null && !UTIL_KINDS.includes(String(out.kind) as (typeof UTIL_KINDS)[number]))
      throw new HudError(400, `kind must be one of ${UTIL_KINDS.join('|')}`);
    if ('util' in out) {
      if (out.util !== null && !isObj(out.util)) throw new HudError(400, 'util must be an object');
      json('util', out.util);
    }
    if ('options' in out) {
      const raw = out.options;
      const used = new Set<string>();
      out.options = (Array.isArray(raw) ? raw : [])
        .slice(0, OPTIONS_MAX)
        .map((o, i) => {
          const x = isObj(o) ? o : {};
          const label = text('option label', x.label, 1000).trim().slice(0, 120);
          let id = text('option id', x.id, 1000).slice(0, 24) || `o${i + 1}`;
          for (let n = 2; used.has(id); n++) id = `${id.slice(0, 20)}-${n}`;
          used.add(id);
          const opt: DecisionOption = { id, label };
          if (x.detail != null && String(x.detail).trim()) opt.detail = text('option detail', x.detail, 100_000).slice(0, 500);
          if (x.status != null && String(x.status).trim()) opt.status = normStatus(x.status);
          return opt;
        })
        .filter((o) => o.label);
    }
    // a decision is set through decide(); the only thing a plain patch may do is clear it (null) to re-open
    if ('decision' in out && out.decision !== null) delete out.decision;
    if ('progress' in out && out.progress !== null) out.progress = clamp(num('progress', out.progress), 0, 100);
    if ('value' in out) out.value = monitorValue(out.value);
    if ('message' in out) out.message = monitorMessage(out.message);
    if ('label' in out) out.label = out.label === null ? null : text('label', out.label, LIMIT.label) || undefined;
    if ('unit' in out) out.unit = text('unit', out.unit, LIMIT.unit) || undefined;
    for (const k of ['max', 'warnAbove', 'errorAbove', 'warnBelow', 'errorBelow'] as const)
      if (k in out) out[k] = out[k] === null || out[k] === '' ? undefined : num(k, out[k]);
    if ('staleAfter' in out) out.staleAfter = out.staleAfter === null || out.staleAfter === '' || num('staleAfter', out.staleAfter) <= 0 ? undefined : Math.max(1, num('staleAfter', out.staleAfter));
    if ('source' in out) out.source = this.cleanSource(out.source);
    // Linear-style links: id arrays, accepted as arrays or comma strings, empty value clears
    for (const k of TICKET_REFS) if (k in out) out[k] = list(k, out[k], 200, 64);
    for (const k of ['project', 'parent'] as const) {
      if (!(k in out)) continue;
      out[k] = out[k] === null ? null : text(k, out[k], 1000).trim().slice(0, 64) || null;
    }
    if ('branch' in out) {
      const b = out.branch === null ? '' : text('branch', out.branch, 1000).trim();
      if (b !== '' && b !== 'regen' && (b.length > 120 || BAD_BRANCH.test(b))) throw new HudError(400, `branch "${b.slice(0, 40)}" is not a valid git branch name`);
      out.branch = b || 'regen'; // empty or null: regenerate from the ticket
    }
    if ('target' in out) {
      const d = out.target === null ? '' : text('target', out.target, 100).trim();
      if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d)) throw new HudError(400, 'target must be a valid yyyy-mm-dd date');
      out.target = d || undefined;
    }
    if ('key' in out) {
      if (out.key === null) delete out.key;
      else {
        const k = text('key', out.key, 100).trim().toUpperCase();
        if (!KEY_RE.test(k)) throw new HudError(400, `key must be 2-8 characters of A-Z and 0-9, starting with a letter (got "${String(out.key).slice(0, 20)}")`);
        out.key = k;
      }
    }
    if (!partial && 'board' in out) out.board = this.requireBoard(String(out.board)).id;
    return out as Partial<Item>;
  }

  /** a monitor source: known fields validated (numbers clamped), anything else carried as given */
  private cleanSource(raw: unknown): MonitorSource {
    if (!isObj(raw)) throw new HudError(400, 'source must be an object');
    json('source', raw);
    const s: Record<string, any> = { ...raw };
    const kind = String(s.kind);
    if (!SOURCE_KINDS.includes(kind)) throw new HudError(400, `source.kind must be ${SOURCE_KINDS.join('|')}`);
    s.kind = kind;
    const str = (k: string, max: number, required = false) => {
      if (s[k] === undefined || s[k] === null || s[k] === '') {
        if (required) throw new HudError(400, `source.${k} required for kind=${kind}`);
        delete s[k];
        return;
      }
      if (typeof s[k] !== 'string') throw new HudError(400, `source.${k} must be a string`);
      if (s[k].length > max) throw new HudError(400, `source.${k} is too long (max ${max} characters)`);
    };
    str('command', 20_000, kind === 'command');
    str('url', 2048, kind === 'http');
    str('probe', 512, kind === 'probe');
    str('cwd', 1024);
    str('jsonPath', 512);
    str('body', 100_000);
    str('contains', 1000);
    if (s.method !== undefined) {
      str('method', 16);
      if (s.method !== undefined) s.method = String(s.method).toUpperCase();
    }
    for (const [k, lo, hi] of [['interval', 1, 86400], ['timeout', 1, 3600], ['period', 1, 604800], ['grace', 0, 604800], ['maxBytes', 1, 100_000_000]] as const) {
      if (s[k] === undefined || s[k] === null) delete s[k];
      else s[k] = clamp(Math.round(num(`source.${k}`, s[k])), lo, hi);
    }
    if (s.expectStatus === undefined || s.expectStatus === null) delete s.expectStatus;
    else {
      s.expectStatus = Math.round(num('source.expectStatus', s.expectStatus));
      if (s.expectStatus < 100 || s.expectStatus > 599) throw new HudError(400, 'source.expectStatus must be 100-599');
    }
    if (s.headers !== undefined) {
      if (!isObj(s.headers)) throw new HudError(400, 'source.headers must be an object of strings');
      const e = Object.entries(s.headers);
      if (e.length > 50 || e.some(([k, v]) => typeof v !== 'string' || k.length > 100 || v.length > 4096)) throw new HudError(400, 'source.headers must be at most 50 string values');
    }
    if (s.config !== undefined && s.config !== null && !isObj(s.config)) throw new HudError(400, 'source.config must be an object');
    return s as MonitorSource;
  }

  create(input: Record<string, unknown>, actor: string): Item {
    if (!isObj(input)) throw new HudError(400, 'item must be an object');
    const type = input.type as ItemType;
    if (!TYPES.includes(type)) throw new HudError(400, `type must be one of ${TYPES.join('|')}`);
    // ---- validate everything first: a rejected create must change nothing (no frame, no burned counters) ----
    const id = this.checkNewId(input.id, type);
    const frameRef = (input.frame ?? input.in) as string | undefined;
    let frame = frameRef ? this.get(this.resolveId(String(frameRef))) : undefined;
    if (frame && frame.type !== 'frame') throw new HudError(400, `"${String(frameRef).slice(0, 80)}" is not a frame`);
    const fields = this.clean(type, input, false) as Record<string, any>;
    const board = frame?.board ?? this.requireBoard((fields.board as string) ?? 'main').id;
    let project: Item | undefined;
    let parent: Item | undefined;
    const links: Partial<Record<'blockedBy' | 'refs', string[]>> = {};
    if (type === 'ticket') {
      if (fields.project) project = this.requireProject(String(fields.project), board);
      if (fields.parent) parent = this.requireTicket(String(fields.parent), board, 'parent');
      for (const k of TICKET_REFS) if (fields[k]?.length) links[k] = [...new Set((fields[k] as string[]).map((r) => this.requireTicket(r, board, k).id))];
    } else if (type === 'project' && fields.key) {
      this.assertKeyFree(fields.key, board);
    }
    // ---- build ----
    if (type !== 'frame') {
      if (frame && !fields.group && frame.title.trim()) fields.group = frame.title.trim();
      if (!frame && fields.group) frame = this.groupFrame(board, fields.group) ?? this.create({ type: 'frame', board, title: fields.group }, actor);
    }
    const [dw, dh] = SIZE[type];
    const w = fields.w ?? dw;
    const h = fields.h ?? dh;
    const t = now();
    const item = {
      id: id ?? this.nextId(type),
      type,
      board,
      title: '',
      x: 0,
      y: 0,
      w,
      h,
      createdAt: t,
      updatedAt: t,
      createdBy: actor,
      updatedBy: actor,
      ...fields,
    } as Item;
    item.board = board;
    const rec = item as unknown as Record<string, unknown>;
    for (const k of Object.keys(rec)) if (rec[k] === undefined || (rec[k] === null && (k === 'project' || k === 'parent'))) delete rec[k];
    if (fields.x === undefined || fields.y === undefined) {
      const p = this.place(board, w, h, frame, item.id);
      item.x = fields.x ?? p.x;
      item.y = fields.y ?? p.y;
    }
    if (type === 'ticket') {
      // a project gives the ticket its key-relative number (EGO-3); without one it uses the loose sequence
      if (project) item.project = project.id;
      item.num = this.nextNum(project?.id);
      item.status ??= 'todo';
      item.body ??= '';
      item.tags ??= [];
      item.comments = [];
      if (parent) item.parent = parent.id;
      for (const k of TICKET_REFS) if (links[k]) item[k] = links[k];
      if (!item.branch || item.branch === 'regen') item.branch = this.branchName(item);
    } else if (type === 'project') {
      item.key = (fields.key as string | undefined) ?? this.deriveKey(item.title, board);
      item.title ||= item.key;
      item.body ??= '';
      item.status ??= 'backlog';
      item.tags ??= [];
    } else if (type === 'monitor') {
      item.source ??= { kind: 'manual' };
      item.display ??= 'auto';
      item.history = [];
      item.log = [];
      const reading = item.value !== undefined || item.progress != null;
      if (reading || item.state !== undefined) {
        this.settle(item, item.state ?? 'ok', item.progress != null);
        item.lastUpdate = t;
        this.record(item);
      }
      item.state ??= 'unknown';
    } else if (type === 'note') {
      item.text ??= '';
    } else if (type === 'util') {
      item.kind ??= 'timer';
      item.util ??= {};
      item.text ??= '';
    }
    this.state.items[item.id] = item;
    this.emitEvent({ kind: 'item', item, actor, created: true });
    this.log(actor, 'created', `created ${type} ${item.id}${item.title ? ` "${item.title}"` : ''}`, item);
    if (type === 'ticket' && item.blockedBy?.length) this.syncDeps(item, actor);
    this.autoOrganize(board);
    this.save();
    return item;
  }

  /**
   * Put a previously removed item back as it was (trash restore, import merge). Its board must exist.
   * Links that no longer resolve are dropped, and dependency state is re-synced both ways.
   */
  protected reinsert(item: Item, actor: string): Item {
    const items = this.state.items;
    if (items[item.id]) throw new HudError(409, `item "${item.id}" already exists`);
    if (!this.state.boards.some((b) => b.id === item.board)) throw new HudError(404, `board "${item.board}" no longer exists`);
    items[item.id] = item;
    const ok = (id: unknown) => typeof id === 'string' && items[id]?.type === 'ticket' && items[id].board === item.board && id !== item.id;
    if (item.type === 'ticket') {
      if (item.project && (items[item.project]?.type !== 'project' || items[item.project].board !== item.board)) this.leaveProject(item, 'project is gone');
      if (item.parent && !ok(item.parent)) delete item.parent;
      for (const k of TICKET_REFS) if (item[k]) item[k] = item[k]!.filter(ok);
      // its old number may have been reused while it was gone
      const clash = Object.values(items).some((o) => o !== item && o.type === 'ticket' && o.board === item.board && (o.project ?? '') === (item.project ?? '') && o.num === item.num);
      if (clash || item.num == null) {
        const old = this.ident(item);
        item.num = this.nextNum(item.project);
        this.addComment(item, 'hud', `renumbered ${old} → ${this.ident(item)} on restore`);
      }
    } else if (item.type === 'project' && item.key && this.keyTaken(item.key, item.board, item.id)) {
      this.setKey(item, this.deriveKey(item.title, item.board, item.id), actor);
    }
    item.updatedAt = now();
    this.emitEvent({ kind: 'item', item, actor, created: true });
    if (item.type === 'ticket') {
      this.syncDeps(item, actor);
      this.syncDependents(item, actor);
    }
    return item;
  }

  update(id: string, patch: Record<string, unknown>, actor: string, opts: { silent?: boolean } = {}): Item {
    let item = this.get(id);
    if (!isObj(patch)) throw new HudError(400, 'patch must be an object');
    const fields = this.clean(item.type, patch, true) as Record<string, any>;
    if ('board' in fields) {
      fields.board = this.requireBoard(String(fields.board)).id;
      if (fields.board !== item.board) this.assertMovable(item);
    }
    if (item.type === 'project' && fields.key) this.assertKeyFree(fields.key, item.board, item.id);
    // relationships go through link(), which validates refs and cycles before anything else changes
    if (item.type === 'ticket') {
      const links: Record<string, unknown> = {};
      for (const k of ['project', 'parent', 'blockedBy', 'refs'] as const)
        if (k in fields) {
          links[k] = fields[k] ?? null;
          delete fields[k];
        }
      if (Object.keys(links).length) {
        this.link(id, links, actor);
        item = this.get(id);
      }
      if (fields.branch === 'regen') fields.branch = this.branchName(item);
    }
    const reading = item.type === 'monitor' && READING_KEYS.some((k) => k in fields);
    const changed = Object.keys(fields).filter((k) => JSON.stringify((item as any)[k]) !== JSON.stringify(fields[k]));
    if (!changed.length && !reading) return item;
    const prevStatus = item.status;
    const prevState = item.state;
    const prevTitle = item.title;
    const prevBoard = item.board;
    const prevAssignee = item.assignee;
    const wasFinished = this.isFinished(item);
    const newKey = item.type === 'project' && changed.includes('key') ? (fields.key as string) : undefined;
    if (newKey) delete fields.key;
    this.assign(item, fields);
    if (!item.group) delete item.group;
    if (newKey) this.setKey(item, newKey, actor);
    // frame renamed: its members follow the new name
    if (item.type === 'frame' && changed.includes('title') && prevTitle.trim()) {
      for (const m of Object.values(this.state.items))
        if (m.board === item.board && m.group?.toLowerCase() === prevTitle.trim().toLowerCase()) {
          m.group = item.title.trim() || undefined;
          this.emitEvent({ kind: 'item', item: m, actor });
        }
    }
    // regrouped without an explicit position: move into the group's frame (or out of any frame)
    const board = this.state.boards.find((b) => b.id === item.board);
    if (item.type !== 'frame' && changed.includes('group') && !('x' in fields || 'y' in fields) && !board?.autoOrganize) {
      const f = item.group ? (this.groupFrame(item.board, item.group) ?? this.create({ type: 'frame', board: item.board, title: item.group }, actor)) : undefined;
      if (f || this.frameAt(item)) {
        const p = this.place(item.board, item.w, item.h, f, item.id);
        item.x = p.x;
        item.y = p.y;
      }
    }
    item.updatedAt = now();
    item.updatedBy = actor;
    if (reading) {
      // a PATCH that carries a reading counts as one even when it re-asserts the current value
      item.lastUpdate = item.updatedAt;
      const hasValue = 'value' in fields || 'progress' in fields;
      this.settle(item, (fields.state as MonState) ?? (hasValue ? 'ok' : undefined), 'progress' in fields, 'state' in fields);
      if (item.state !== prevState && !('message' in fields)) delete item.message;
      this.record(item);
    }
    if (item.type === 'ticket' && changed.includes('status')) {
      item.autoBlocked = false;
      delete item.resumeStatus;
      // a ticket that moved may free or block the tickets that declare it
      this.statusMoved(item, wasFinished, actor);
    }
    if (item.type === 'monitor') this.afterReading(item, prevState, actor);
    else this.emitEvent({ kind: 'item', item, actor });
    if (item.type === 'ticket' && changed.includes('monitors') && item.autoStatus) {
      const m = item.monitors?.map((id) => this.state.items[id]).find(Boolean);
      if (m) this.syncTickets(m);
    }
    if (item.type === 'ticket') {
      if (changed.includes('status')) this.notifyTicket(item, actor, 'status', prevStatus ?? '', `${prevStatus} → ${item.status}`);
      if (changed.includes('assignee')) this.notifyTicket(item, actor, 'assigned', prevAssignee ?? '', item.assignee ? `assigned to ${item.assignee}` : 'unassigned');
    }
    if (!opts.silent) {
      const geometry = changed.every((k) => ['x', 'y', 'w', 'h'].includes(k));
      if (item.type === 'ticket' && changed.includes('status')) {
        this.log(actor, 'status', `${item.id} ${prevStatus} → ${item.status}`, item);
      } else if (item.type === 'monitor' && prevState !== item.state) {
        // logged by afterReading
      } else if (!geometry && !(item.type === 'monitor' && changed.every((k) => ['value', 'message', 'progress', 'unit'].includes(k)))) {
        this.log(actor, 'updated', `updated ${item.id} (${changed.filter((k) => !['x', 'y', 'w', 'h'].includes(k)).join(', ')})`, item);
      }
    }
    if (changed.some((k) => ['group', 'w', 'h', 'board', 'status', 'priority'].includes(k)) || (item.type === 'frame' && changed.includes('title'))) {
      this.autoOrganize(item.board);
      if (prevBoard !== item.board) this.autoOrganize(prevBoard);
    }
    this.save();
    return item;
  }

  /** copy validated fields onto an item; a field set to undefined is cleared */
  private assign(item: Item, fields: Record<string, any>) {
    Object.assign(item, fields);
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete (item as any)[k];
  }

  /** tickets and projects tied to other items can't hop boards (their links would span boards) */
  private assertMovable(it: Item) {
    const all = Object.values(this.state.items);
    if (it.type === 'project' && all.some((t) => t.type === 'ticket' && t.project === it.id))
      throw new HudError(409, `project ${it.key} still has tickets; move or delete them first`);
    if (
      it.type === 'ticket' &&
      (it.project || it.parent || it.blockedBy?.length || it.refs?.length || all.some((o) => o.type === 'ticket' && (o.parent === it.id || o.blockedBy?.includes(it.id) || o.refs?.includes(it.id))))
    )
      throw new HudError(409, `${this.ident(it)} is linked to other tickets or a project on board ${it.board}; unlink it before moving it to another board`);
  }

  /** Delete an item. Whatever pointed at it is cleaned up first, and anything waiting on it is re-synced. */
  remove(id: string, actor: string) {
    const item = this.get(id);
    const touched = this.detach(item, actor);
    delete this.state.items[id];
    this.state.trash.push({ item, t: now(), actor });
    this.pruneTrash();
    this.emitEvent({ kind: 'item.deleted', id, board: item.board, actor });
    for (const o of touched) this.emitEvent({ kind: 'item', item: o, actor });
    for (const o of touched) if (o.type === 'ticket') this.syncDeps(o, actor);
    this.log(actor, 'deleted', `deleted ${item.type} ${id}${item.title ? ` "${item.title}"` : ''} (in trash)`, item);
    this.autoOrganize(item.board);
    this.save();
    return item;
  }

  /**
   * Cut every reference to `item` before it goes away: children move up to its parent, it leaves other
   * tickets' blockedBy/refs/monitors, a deleted project's tickets are detached and renumbered.
   * Returns the items that changed.
   */
  private detach(item: Item, actor: string): Item[] {
    const touched = new Set<Item>();
    const t = now();
    for (const o of Object.values(this.state.items)) {
      if (o === item || o.type !== 'ticket') continue;
      let hit = false;
      if (item.type === 'ticket') {
        if (o.parent === item.id) {
          if (item.parent) o.parent = item.parent;
          else delete o.parent;
          hit = true;
        }
        for (const k of TICKET_REFS)
          if (o[k]?.includes(item.id)) {
            o[k] = o[k]!.filter((x) => x !== item.id);
            hit = true;
          }
      } else if (item.type === 'monitor' && o.monitors?.includes(item.id)) {
        o.monitors = o.monitors.filter((x) => x !== item.id);
        hit = true;
      } else if (item.type === 'project' && o.project === item.id) {
        this.leaveProject(o, `project ${item.key} deleted`);
        hit = true;
      }
      if (hit) {
        o.updatedAt = t;
        o.updatedBy = actor;
        touched.add(o);
      }
    }
    return [...touched];
  }

  /** take a ticket out of its project: renumber into the loose sequence, keep a hand-set branch */
  private leaveProject(tk: Item, why: string) {
    const old = this.ident(tk);
    const auto = !tk.branch || tk.branch === this.branchName(tk);
    delete tk.project;
    tk.num = this.nextNum();
    if (auto) tk.branch = this.branchName(tk);
    this.addComment(tk, 'hud', `${why}: ${old} → ${this.ident(tk)}`);
  }

  /** change a project's key: its tickets' identifiers change, and so do their generated branches */
  private setKey(p: Item, key: string, actor: string) {
    const tickets = Object.values(this.state.items).filter((t) => t.type === 'ticket' && t.project === p.id);
    const auto = tickets.map((t) => !t.branch || t.branch === this.branchName(t));
    p.key = key;
    tickets.forEach((t, i) => {
      if (auto[i]) t.branch = this.branchName(t);
      this.emitEvent({ kind: 'item', item: t, actor });
    });
  }

  /** append a comment, keeping at most COMMENTS_MAX (automatic `hud` comments are dropped first) */
  private addComment(it: Item, actor: string, body: string): Comment {
    const c: Comment = { id: `c${(this.state.seq.c = (this.state.seq.c ?? 0) + 1)}`, t: now(), actor, text: body };
    const l = (it.comments ??= []);
    l.push(c);
    while (l.length > COMMENTS_MAX) {
      const i = l.findIndex((x) => x.actor === 'hud');
      l.splice(i >= 0 ? i : 0, 1);
    }
    return c;
  }

  comment(id: string, body: string, actor: string) {
    const item = this.get(id);
    if (typeof body !== 'string' && typeof body !== 'number') throw new HudError(400, 'comment text must be a string');
    if (!String(body).trim()) throw new HudError(400, 'comment text required');
    const c = this.addComment(item, actor, text('comment', body, LIMIT.comment));
    item.updatedAt = c.t;
    item.updatedBy = actor;
    this.emitEvent({ kind: 'item', item, actor });
    this.log(actor, 'comment', `${item.id}: ${c.text.slice(0, 120)}`, item);
    this.notifyTicket(item, actor, 'comment', '', c.text.slice(0, 300));
    this.save();
    return c;
  }

  /** a ticket's notify list hears about comments, status and assignee changes made by anyone outside it */
  private notifyTicket(tk: Item, actor: string, to: 'comment' | 'status' | 'assigned', from: string, message: string) {
    if (tk.type !== 'ticket' || !tk.notify?.length || actor === 'hud' || tk.notify.includes(actor)) return;
    this.alert(tk, from, to, message);
  }

  private findComment(id: string, cid: string): { item: Item; c: Comment; i: number } {
    const item = this.get(this.resolveId(String(id)));
    const i = (item.comments ?? []).findIndex((x) => x.id === cid);
    if (i < 0) throw new HudError(404, `no comment "${String(cid).slice(0, 40)}" on ${String(id).slice(0, 80)}`);
    return { item, c: item.comments![i], i };
  }

  editComment(id: string, cid: string, body: string, actor: string): Comment {
    const { item, c } = this.findComment(id, cid);
    if (typeof body !== 'string' && typeof body !== 'number') throw new HudError(400, 'comment text must be a string');
    if (!String(body).trim()) throw new HudError(400, 'comment text required');
    c.text = text('comment', body, LIMIT.comment);
    c.edited = now();
    item.updatedAt = c.edited;
    item.updatedBy = actor;
    this.emitEvent({ kind: 'item', item, actor });
    this.log(actor, 'comment.edited', `${item.id}: edited ${c.id}`, item);
    this.save();
    return c;
  }

  deleteComment(id: string, cid: string, actor: string): void {
    const { item, c, i } = this.findComment(id, cid);
    item.comments!.splice(i, 1);
    item.updatedAt = now();
    item.updatedBy = actor;
    this.emitEvent({ kind: 'item', item, actor });
    this.log(actor, 'comment.deleted', `${item.id}: deleted ${c.id}`, item);
    this.save();
  }

  /** the activity log entries about one item (id or ident), newest last */
  itemActivity(id: string, limit = 100): Activity[] {
    const rid = this.resolveId(String(id));
    const n = Math.floor(Number(limit));
    const out = this.state.activity.filter((a) => a.itemId === rid);
    return out.slice(-(Number.isFinite(n) && n > 0 ? n : 100));
  }

  /** a manual status change: clears the bookkeeping of any automatic block */
  private setStatus(tk: Item, status: string, actor: string) {
    tk.status = status;
    tk.autoBlocked = false;
    delete tk.resumeStatus;
    tk.updatedAt = now();
    tk.updatedBy = actor;
  }

  /** after a ticket's status moved: tickets waiting on it re-check when it crossed the finished line */
  private statusMoved(tk: Item, wasFinished: boolean, actor: string) {
    if (this.isFinished(tk) !== wasFinished) this.syncDependents(tk, actor);
  }

  /** An agent proposes options on a ticket and waits for a human to pick one. */
  ask(id: string, input: { question?: unknown; options: unknown }, actor: string): Item {
    const tk = this.get(id);
    if (tk.type !== 'ticket') throw new HudError(400, `${id} is a ${tk.type}, not a ticket`);
    const opts = this.clean('ticket', { options: input.options }, true).options ?? [];
    if (!opts.length) throw new HudError(400, 'at least one option with a label is required');
    const wasFinished = this.isFinished(tk);
    tk.options = opts;
    if (input.question !== undefined) tk.question = text('question', input.question, 100_000).trim().slice(0, 500) || undefined;
    delete tk.decision;
    this.setStatus(tk, 'blocked', actor);
    // the asker is who needs woken with the answer; keep any sessions already named, add this one
    tk.notify = [...new Set([...(tk.notify ?? []), actor].filter(Boolean))];
    this.emitEvent({ kind: 'item', item: tk, actor });
    this.log(actor, 'ask', `${tk.id} needs a decision: ${opts.map((o) => o.label).join(' | ')}`, tk);
    this.statusMoved(tk, wasFinished, actor);
    this.save();
    return tk;
  }

  /** Pick one of a ticket's options: move it to the option's status and wake whoever asked. */
  decide(id: string, optionId: string, actor: string, note?: string): Item {
    const tk = this.get(id);
    if (tk.type !== 'ticket') throw new HudError(400, `${id} is a ${tk.type}, not a ticket`);
    const opt = tk.options?.find((o) => o.id === optionId);
    if (!opt) throw new HudError(404, `no option "${String(optionId).slice(0, 40)}" on ${id} (have: ${(tk.options ?? []).map((o) => o.id).join(', ') || 'none'})`);
    const from = tk.status ?? 'todo';
    const wasFinished = this.isFinished(tk);
    const t = now();
    tk.decision = { optionId: opt.id, t, actor, ...(note ? { note: text('note', note, 100_000).slice(0, 500) } : {}) };
    let next = DECIDE_STATUS;
    try {
      next = normStatus(opt.status ?? DECIDE_STATUS);
    } catch {}
    this.setStatus(tk, next, actor);
    this.addComment(tk, actor, `decision: ${opt.label}${note ? ` — ${tk.decision.note}` : ''}`);
    this.emitEvent({ kind: 'item', item: tk, actor });
    this.log(actor, 'decide', `${tk.id} ${from} → ${tk.status}: ${opt.label}`, tk);
    this.alert(tk, from, 'answered');
    this.syncDeps(tk, actor); // the answer doesn't lift a dependency block
    this.statusMoved(tk, wasFinished, actor);
    this.save();
    return tk;
  }

  /**
   * An agent signals it is finished. With ids: those items are marked complete. Without: only what this
   * actor created or is assigned — open tickets and push/manual monitors — never tickets awaiting a human
   * decision, canceled tickets or other actors' work. Polled monitors report again on their next run.
   */
  finish(input: { board?: string; ids?: string[]; note?: string; organize?: boolean }, actor: string): { board: string; done: string[] } {
    const ids = Array.isArray(input.ids) ? input.ids : [];
    const first = ids.length ? this.get(this.resolveId(String(ids[0]), input.board)) : undefined;
    const board = this.requireBoard(input.board ?? first?.board).id;
    const note = input.note ? text('note', input.note, 100_000).slice(0, 500) : undefined;
    const mine = (it: Item) => it.createdBy === actor || it.assignee === actor;
    const targets = ids.length
      ? ids.map((id) => this.get(this.resolveId(String(id), board))).filter((it) => it.board === board && it.type !== 'frame')
      : Object.values(this.state.items).filter((it) => {
          if (it.board !== board || !mine(it)) return false;
          if (it.type === 'ticket') return it.status !== 'canceled' && !(it.options?.length && !it.decision);
          return it.type === 'monitor' && (it.source?.kind === 'push' || it.source?.kind === 'manual');
        });
    const done: string[] = [];
    for (const it of targets) {
      if (it.type === 'ticket' ? it.status === 'done' : it.state === 'done') continue;
      if (it.type === 'ticket') {
        const from = it.status ?? 'todo';
        const wasFinished = this.isFinished(it);
        this.setStatus(it, 'done', actor);
        this.addComment(it, actor, `finished${note ? `: ${note}` : ''}`);
        this.emitEvent({ kind: 'item', item: it, actor });
        this.log(actor, 'finish', `${it.id} ${from} → done`, it);
        this.notifyTicket(it, actor, 'status', from, `${from} → done`);
        this.statusMoved(it, wasFinished, actor);
        done.push(it.id);
      } else if (it.type === 'monitor') {
        this.push(it.id, { state: 'done', ...(note ? { message: note } : {}) }, actor);
        done.push(it.id);
      }
    }
    if (input.organize !== false) this.organize(board, actor, true);
    if (!done.length) this.log(actor, 'finish', `finished ${board}: nothing left to complete`);
    this.save();
    return { board, done };
  }

  /** Validate a whole reading tree (and the ids it would create) before anything is applied. */
  private checkReading(id: string, r: Record<string, any>, depth: number, budget: { n: number }) {
    if (!isObj(r)) throw new HudError(400, 'a monitor reading must be an object');
    if (depth > FANOUT_DEPTH) throw new HudError(400, `monitors are nested deeper than ${FANOUT_DEPTH} levels`);
    const existing = typeof id === 'string' ? this.state.items[id] : undefined;
    if (existing) {
      if (existing.type !== 'monitor') throw new HudError(400, `${id} is a ${existing.type}, not a monitor`);
    } else {
      this.checkNewId(id, 'monitor');
      if (r.board != null) this.requireBoard(String(r.board));
      if (r.frame) {
        const f = this.get(this.resolveId(String(r.frame)));
        if (f.type !== 'frame') throw new HudError(400, `"${String(r.frame).slice(0, 80)}" is not a frame`);
      }
    }
    if (r.state !== undefined && !STATES.includes(r.state)) throw new HudError(400, `state must be one of ${STATES.join('|')}`);
    this.clean('monitor', { ...Object.fromEntries(PUSH_CONFIG.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])), ...(r.title !== undefined ? { title: r.title } : {}), value: r.value, progress: r.progress, label: cut(r.label, LIMIT.label), unit: cut(r.unit, LIMIT.unit), message: r.message }, true);
    if (r.monitors !== undefined) {
      if (!isObj(r.monitors)) throw new HudError(400, 'monitors must be an object keyed by monitor id');
      for (const [cid, cr] of Object.entries(r.monitors)) {
        if (++budget.n > FANOUT_MAX) throw new HudError(400, `a reading may carry at most ${FANOUT_MAX} monitors`);
        this.checkReading(cid, cr as Record<string, any>, depth + 1, budget);
      }
    }
  }

  /** Apply a monitor reading. Creates a push monitor if the id doesn't exist yet. */
  push(
    id: string,
    r: MonitorResult & Record<string, any> & { title?: string; board?: string; frame?: string },
    actor: string,
    defaults: { board?: string; group?: string } = {},
  ): Item {
    this.checkReading(String(id), r, 0, { n: 0 });
    return this.applyReading(String(id), r, actor, defaults);
  }

  private applyReading(id: string, r: Record<string, any>, actor: string, defaults: { board?: string; group?: string }): Item {
    let item = this.state.items[id];
    if (!item) {
      item = this.create(
        { type: 'monitor', id, title: r.title ?? id, board: r.board ?? defaults.board, frame: r.frame, group: r.group ?? defaults.group, source: { kind: 'push' } },
        actor,
      );
    }
    // fan-out: one reading carrying many monitors
    const kids = r.monitors ? Object.entries(r.monitors) : [];
    const kidItems = kids.map(([cid, cr]) => this.applyReading(cid, { ...(cr as object) }, actor, { board: item.board, group: item.group }));
    const cfg: Record<string, unknown> = {};
    for (const k of PUSH_CONFIG) if (r[k] !== undefined) cfg[k] = r[k];
    if (r.title !== undefined && r.title !== item.title) cfg.title = r.title;
    if (Object.keys(cfg).length) this.assign(item, this.clean('monitor', cfg, true) as Record<string, any>);
    if (!item.group) delete item.group;
    const prevState = item.state;
    if (kids.length && r.value === undefined && r.state === undefined) {
      const rank = (x?: MonState) => (x === 'error' ? 3 : x === 'warn' ? 2 : x === 'ok' || x === 'done' || x === 'running' ? 1 : 0);
      const worst = kidItems.reduce<MonState>((w, k) => (rank(k.state) > rank(w) ? k.state! : w), 'ok');
      r = { ...r, value: kids.length, state: worst, label: r.label ?? `${kidItems.filter((k) => k.state === 'ok' || k.state === 'done').length}/${kids.length} ok` };
    }
    if (r.value !== undefined) item.value = monitorValue(r.value);
    if (r.label !== undefined) item.label = r.label == null || r.label === '' ? undefined : text('label', cut(r.label, LIMIT.label), LIMIT.label);
    if (r.unit !== undefined) item.unit = text('unit', cut(r.unit, LIMIT.unit), LIMIT.unit) || undefined;
    if (r.progress !== undefined) item.progress = r.progress == null ? null : clamp(num('progress', r.progress), 0, 100);
    const reading = r.value !== undefined || r.progress !== undefined;
    this.settle(item, r.state ?? (reading ? 'ok' : undefined), r.progress !== undefined, r.state !== undefined);
    // a message belongs to the state it was reported with: a state change without one clears the old text
    if (r.message !== undefined) item.message = monitorMessage(r.message);
    else if (item.state !== prevState) delete item.message;
    if (!item.message) delete item.message;
    const t = now();
    item.lastUpdate = t;
    item.updatedAt = t;
    item.updatedBy = actor;
    this.record(item);
    this.afterReading(item, prevState, actor);
    this.save();
    return item;
  }

  /** shared tail of every monitor change: emit, log state changes, raise alerts, drive linked tickets */
  private afterReading(item: Item, prevState: MonState | undefined, actor: string) {
    if (item.stale) item.stale = false;
    this.emitEvent({ kind: 'item', item, actor });
    if (prevState === item.state) return;
    if (prevState !== undefined) this.log(actor, 'state', `${item.id} ${prevState} → ${item.state}${item.message ? `: ${item.message}` : ''}`, item);
    const sev = (x?: MonState) => (x === 'error' ? 3 : x === 'warn' ? 2 : 0);
    if (item.state === 'done' || sev(item.state) > sev(prevState)) this.alert(item, prevState ?? 'unknown', item.state as Alert['to']);
    this.syncTickets(item);
  }

  private alert(item: Item, from: string, to: Alert['to'], message?: string) {
    const board = this.state.boards.find((b) => b.id === item.board);
    const a: Alert = {
      id: (this.state.seq.alert = (this.state.seq.alert ?? 0) + 1),
      t: now(),
      itemId: item.id,
      board: item.board,
      title: item.title || item.id,
      from,
      to,
      message: message ?? item.message,
      value: item.label ?? item.value,
      notify: [...new Set([...(item.notify ?? []), ...(board?.notify ?? [])])],
    };
    const l = this.state.alerts;
    l.push(a);
    // a full ring drops acknowledged alerts first so a flapping monitor can't push out unread ones
    while (l.length > ALERTS_MAX) {
      const i = l.findIndex((x) => x.acked);
      l.splice(i >= 0 ? i : 0, 1);
    }
    this.emitEvent({ kind: 'alert', alert: a });
  }

  alerts(opts: { all?: boolean; since?: number; notify?: string } = {}) {
    return this.state.alerts.filter(
      (a) => (opts.all || !a.acked) && (!opts.since || a.id > opts.since) && (!opts.notify || a.notify.includes(opts.notify) || a.notify.includes('*')),
    );
  }

  ackAlerts(ids: number[] | 'all') {
    let n = 0;
    for (const a of this.state.alerts) if (!a.acked && (ids === 'all' || ids.includes(a.id))) (a.acked = true), n++;
    this.save();
    return n;
  }

  /**
   * Flag monitors that stopped reporting; called periodically by the server. A monitor with `staleAfter`
   * counts from its last reading (or its creation if it never reported). A heartbeat goes to error once
   * period+grace pass without a ping and recovers on the next one.
   */
  checkStale() {
    const t = now();
    for (const it of Object.values(this.state.items)) {
      if (it.type !== 'monitor') continue;
      const hb = it.source?.kind === 'heartbeat';
      const limit = hb ? ((it.source?.period ?? 60) + (it.source?.grace ?? 60)) * 1000 : it.staleAfter ? it.staleAfter * 1000 : 0;
      if (!limit) continue;
      const since = it.lastUpdate ?? it.createdAt;
      const stale = t - since > limit;
      if (stale === !!it.stale) continue;
      it.stale = stale;
      const prev = it.state ?? 'unknown';
      if (stale) {
        const secs = Math.round((t - since) / 1000);
        if (hb) {
          it.state = 'error';
          it.message = `no ping for ${secs}s`;
          this.record(it, t);
        }
        it.updatedAt = t;
        this.emitEvent({ kind: 'item', item: it, actor: 'hud' });
        this.log('hud', 'stale', `${it.id} stale: no update for ${secs}s`, it);
        this.alert(it, prev, 'stale', hb ? it.message : undefined);
        if (hb) this.syncTickets(it);
      } else this.emitEvent({ kind: 'item', item: it, actor: 'hud' });
      this.save();
    }
  }

  /**
   * A heartbeat from a job: ok / start (running) / fail, or an exit code (0 ok, else fail). Creates the
   * heartbeat monitor on first sight.
   */
  ping(id: string, kind: 'ok' | 'start' | 'fail' | number, actor: string, opts: { body?: string; board?: string; group?: string; period?: number; grace?: number; title?: string } = {}): Item {
    id = String(id);
    const existing = Object.hasOwn(this.state.items, id) ? this.state.items[id] : undefined;
    if (existing && (existing.type !== 'monitor' || existing.source?.kind !== 'heartbeat'))
      throw new HudError(400, `${id} is not a heartbeat monitor (source.kind=${existing.source?.kind ?? existing.type})`);
    const body = opts.body === undefined ? undefined : String(opts.body).slice(0, LIMIT.message).trim();
    let state: MonState = 'ok';
    let message = body;
    if (kind === 'start') {
      state = 'running';
      message = body || 'started';
    } else if (kind === 'fail' || (typeof kind === 'number' && kind !== 0)) {
      state = 'error';
      message = body || (typeof kind === 'number' ? `exit code ${kind}` : 'reported failure');
    } else if (kind !== 'ok' && kind !== 0) throw new HudError(400, 'ping kind must be ok, start, fail or an exit code');
    if (!existing) {
      const source: Record<string, unknown> = { kind: 'heartbeat' };
      if (opts.period !== undefined) source.period = opts.period;
      if (opts.grace !== undefined) source.grace = opts.grace;
      this.create({ type: 'monitor', id, title: opts.title ?? id, board: opts.board, group: opts.group, source }, actor);
    } else if (opts.period !== undefined || opts.grace !== undefined) {
      this.update(id, { source: { ...existing.source, ...(opts.period !== undefined ? { period: opts.period } : {}), ...(opts.grace !== undefined ? { grace: opts.grace } : {}) } }, actor, { silent: true });
    }
    return this.applyReading(id, { state, message: message ?? '' }, actor, {});
  }

  /** percent of minutes with data in the last hour / 24 h that were not error; null without data */
  uptime(id: string): { h1: number | null; h24: number | null } {
    const it = this.get(id);
    const tr = it.trend ?? [];
    const t = now();
    const pct = (ms: number) => {
      const w = tr.filter((b) => b.t >= t - ms);
      return w.length ? Math.round((w.filter((b) => b.w !== 2).length / w.length) * 10000) / 100 : null;
    };
    return { h1: pct(3_600_000), h24: pct(86_400_000) };
  }

  // ---------- Linear-style structure: projects, identifiers, links ----------

  /** projects on a board (or every board) */
  projects(board?: string): Item[] {
    return Object.values(this.state.items)
      .filter((i) => i.type === 'project' && (!board || i.board === board))
      .sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '') || a.title.localeCompare(b.title));
  }

  /** find a project by id or by KEY, optionally scoped to a board */
  project(ref: string, board?: string): Item | undefined {
    const k = String(ref).trim().toLowerCase();
    return this.projects(board).find((p) => p.id.toLowerCase() === k || (p.key ?? '').toLowerCase() === k);
  }

  /** the project a ticket belongs to */
  projectOf(it: Item): Item | undefined {
    return it.project ? this.state.items[it.project] : undefined;
  }

  /** EGO-12 when the ticket's project has a key, else #12, else the raw id */
  ident(it: Item): string {
    if (it.type !== 'ticket' || it.num == null) return it.id;
    const key = this.projectOf(it)?.key;
    return key ? `${key}-${it.num}` : `#${it.num}`;
  }

  /**
   * Accept an id or a ticket ident anywhere an item id is expected. Order: exact item id, then KEY-12
   * (key matched case-insensitively, `board` preferred), then #12 / 12 among project-less tickets of `board`
   * (default: main). Anything unresolved is returned as given.
   */
  resolveId(ref: string, board?: string): string {
    const raw = String(ref ?? '');
    if (this.state.items[raw]) return raw;
    return this.ticket(raw.trim(), board)?.id ?? raw;
  }

  identOf(id: string): string {
    const it = this.state.items[id];
    return it ? this.ident(it) : id;
  }

  /** resolve a ticket by id, KEY-12 or #12 (see resolveId for the order) */
  ticket(ref: string, board?: string): Item | undefined {
    const s = String(ref ?? '').trim();
    const own = this.state.items[s];
    if (own?.type === 'ticket') return own;
    const m = IDENT_RE.exec(s);
    if (m) {
      const hits = this.index().ident.get(`${m[1].toLowerCase()}-${Number(m[2])}`);
      return hits?.find((h) => h.board === (board ?? 'main')) ?? hits?.[0];
    }
    const n = /^#?(\d+)$/.exec(s);
    if (!n) return undefined;
    const want = board ?? 'main';
    return Object.values(this.state.items).find((i) => i.type === 'ticket' && !i.project && i.board === want && i.num === Number(n[1]));
  }

  /** the ticket graph for the current snapshot: built once after each mutation, shared by every read */
  private index(): TicketIndex {
    if (this.idx) return this.idx;
    const x: TicketIndex = { children: new Map(), blocks: new Map(), ident: new Map(), rollups: new Map() };
    const push = (m: Map<string, Item[]>, k: string, it: Item) => (m.get(k)?.push(it) ?? m.set(k, [it]));
    for (const it of Object.values(this.state.items)) {
      if (it.type !== 'ticket') continue;
      if (it.parent) push(x.children, it.parent, it);
      for (const b of it.blockedBy ?? []) push(x.blocks, b, it);
      const key = this.projectOf(it)?.key;
      if (key && it.num != null) push(x.ident, `${key.toLowerCase()}-${it.num}`, it);
    }
    for (const l of x.children.values()) l.sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
    return (this.idx = x);
  }

  childrenOf(id: string): Item[] {
    return this.index().children.get(id) ?? [];
  }

  /** from the root down to (not including) this ticket */
  ancestorsOf(id: string): Item[] {
    const out: Item[] = [];
    const seen = new Set<string>([id]);
    let cur = this.state.items[id]?.parent;
    while (cur && !seen.has(cur)) {
      const p = this.state.items[cur];
      if (!p) break;
      out.unshift(p);
      seen.add(cur);
      cur = p.parent;
    }
    return out;
  }

  /** tickets that declare this one in their `blockedBy`, i.e. the work this ticket blocks */
  blocksOf(id: string): Item[] {
    return this.index().blocks.get(id) ?? [];
  }

  /** tickets this one mentions: explicit refs plus any KEY-12 in the title, body or human comments (same board only) */
  refsOf(it: Item): Item[] {
    const byId = new Set(it.refs ?? []);
    const body = [it.title, it.body, ...(it.comments ?? []).filter((c) => c.actor !== 'hud').map((c) => c.text)].join('\n');
    for (const m of body.matchAll(/(?<![\w-])([A-Z][A-Z0-9]{1,7}-\d+)(?![\w-])/g)) {
      const t = this.ticket(m[1], it.board);
      if (t && t.board === it.board) byId.add(t.id);
    }
    byId.delete(it.id);
    // don't repeat what the tree already shows: a blocker or a sub-ticket is not a "related" link
    for (const id of it.blockedBy ?? []) byId.delete(id);
    for (const c of this.childrenOf(it.id)) byId.delete(c.id);
    if (it.parent) byId.delete(it.parent);
    return [...byId].map((id) => this.state.items[id]).filter((x): x is Item => !!x && x.type === 'ticket');
  }

  private keyTaken(key: string, board: string, except?: string): boolean {
    return this.projects(board).some((p) => p.id !== except && (p.key ?? '').toUpperCase() === key);
  }

  /** an explicit project key must be free on its board */
  private assertKeyFree(key: string, board: string, except?: string) {
    if (this.keyTaken(key, board, except)) throw new HudError(409, `project key ${key} is already used on board ${board}`);
  }

  /** a short uppercase key from a project title, unique per board: "Eng org" -> EO, "Release" -> REL, "Release 1.4" -> REL */
  deriveKey(title: string, board: string, except?: string): string {
    // version numbers and dates make poor keys, so derive from the words only
    const words = String(title ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => /[A-Z]/.test(w));
    let base = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3)).replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'PRJ';
    if (!/^[A-Z]/.test(base)) base = `P${base}`.slice(0, 4);
    for (let n = 2; this.keyTaken(base, board, except); n++) base = `${base.slice(0, 3)}${n}`;
    return base;
  }

  /** the git branch for a ticket: key-12-some-title */
  branchName(it: Item): string {
    const num = it.num ?? 0;
    const key = this.projectOf(it)?.key;
    const head = key ? `${key}-${num}` : `t${num}`;
    const slug = branchSlug(it.title);
    return (slug ? `${head}-${slug}` : head).toLowerCase();
  }

  private requireProject(ref: string, board: string): Item {
    const p = this.project(ref, board);
    if (!p) {
      const have = this.projects(board).map((x) => `${x.key}=${x.id}`);
      throw new HudError(404, `no project "${String(ref).slice(0, 80)}" on board ${board} (have: ${have.slice(0, 8).join(', ') || 'none — create one with hud_project'}${have.length > 8 ? ` … ${have.length - 8} more` : ''})`);
    }
    return p;
  }

  private requireTicket(ref: string, board: string, what: string): Item {
    const t = this.ticket(ref, board);
    if (!t) throw new HudError(404, `no ticket "${String(ref).slice(0, 80)}" for ${what} on board ${board}`);
    if (t.board !== board) throw new HudError(400, `${what}: ${this.ident(t)} is on board ${t.board}, not ${board}`);
    return t;
  }

  /** a ticket may not become its own ancestor */
  private assertNoParentCycle(id: string, parentId: string): void {
    const seen = new Set<string>();
    let cur: string | undefined = parentId;
    while (cur) {
      if (cur === id) throw new HudError(400, 'a ticket cannot be its own ancestor');
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = this.state.items[cur]?.parent;
    }
  }

  /** `id` blockedBy `dep` would be circular if dep already waits on id, directly or not */
  private assertNoDepCycle(id: string, depId: string): void {
    const stack = [depId];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === id) throw new HudError(400, 'that dependency would be circular');
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const b of this.state.items[cur]?.blockedBy ?? []) stack.push(b);
    }
  }

  private isFinished(t: Item): boolean {
    return t.status === 'done' || t.status === 'canceled';
  }

  /**
   * Set a ticket's structural links: `project`, `parent`, `blockedBy`, `refs`, `branch`.
   * Relationships are validated (same board, no cycles) before anything changes, so a rejected call leaves
   * the ticket untouched and the graph stays a DAG.
   */
  link(id: string, input: Record<string, unknown>, actor: string): Item {
    const tk = this.get(id);
    if (tk.type !== 'ticket') throw new HudError(400, `${id} is a ${tk.type}, not a ticket`);
    const fields = this.clean('ticket', input, true) as Record<string, any>;
    const board = tk.board;
    // ---- validate ----
    let project: Item | null | undefined; // undefined: untouched, null: cleared
    if ('project' in fields) project = fields.project ? this.requireProject(String(fields.project), board) : null;
    let parent: Item | null | undefined;
    if ('parent' in fields) {
      parent = fields.parent ? this.requireTicket(String(fields.parent), board, 'parent') : null;
      if (parent) {
        if (parent.id === tk.id) throw new HudError(400, 'a ticket cannot be its own parent');
        this.assertNoParentCycle(tk.id, parent.id);
      }
    }
    const lists: Partial<Record<'blockedBy' | 'refs', string[]>> = {};
    for (const k of TICKET_REFS) {
      if (!(k in fields)) continue;
      const ids: string[] = [];
      for (const ref of (fields[k] as string[]) ?? []) {
        const t = this.requireTicket(ref, board, k);
        if (t.id === tk.id) throw new HudError(400, `a ticket cannot ${k} itself`);
        if (k === 'blockedBy') this.assertNoDepCycle(tk.id, t.id);
        ids.push(t.id);
      }
      lists[k] = [...new Set(ids)];
    }
    // ---- apply ----
    const notes: string[] = [];
    const autoBranch = !tk.branch || tk.branch === this.branchName(tk);
    if (project !== undefined && (project?.id ?? undefined) !== tk.project) {
      const old = this.ident(tk);
      if (project) tk.project = project.id;
      else delete tk.project;
      tk.num = this.nextNum(project?.id);
      this.addComment(tk, 'hud', `moved ${old} → ${this.ident(tk)}`);
      notes.push(project ? `project ${project.key}` : 'project cleared');
      if (autoBranch) tk.branch = this.branchName(tk);
    }
    if (parent !== undefined) {
      if (parent) {
        tk.parent = parent.id;
        notes.push(`under ${this.ident(parent)}`);
      } else if (tk.parent) {
        delete tk.parent;
        notes.push('detached from its parent');
      }
    }
    for (const k of TICKET_REFS) {
      const ids = lists[k];
      if (!ids) continue;
      tk[k] = ids;
      if (k === 'refs') notes.push(`${ids.length} refs`);
      if (k === 'blockedBy') notes.push(ids.length ? `blocked by ${ids.map((i) => this.identOf(i)).join(', ')}` : 'unblocked');
    }
    if ('branch' in fields) tk.branch = fields.branch === 'regen' ? this.branchName(tk) : fields.branch;
    tk.updatedAt = now();
    tk.updatedBy = actor;
    this.emitEvent({ kind: 'item', item: tk, actor });
    if (notes.length) this.log(actor, 'link', `${this.ident(tk)}: ${notes.join('; ')}`, tk);
    this.syncDeps(tk, actor);
    this.save();
    return tk;
  }

  private openBlockers(tk: Item): Item[] {
    return (tk.blockedBy ?? []).map((b) => this.state.items[b]).filter((b): b is Item => !!b && !this.isFinished(b));
  }

  /** a linked monitor of an autoStatus ticket is in error */
  private monitorsFailing(tk: Item): boolean {
    return !!tk.autoStatus && (tk.monitors ?? []).some((m) => this.state.items[m]?.state === 'error');
  }

  /**
   * A ticket waiting on unfinished blockers is blocked; once they finish it returns to what it was.
   * Mirrors syncTickets (monitor-driven); both only move a ticket they blocked themselves, and neither
   * releases a block the other still holds.
   */
  private syncDeps(tk: Item, actor: string): void {
    const open = this.openBlockers(tk);
    if (open.length && !['blocked', 'done', 'canceled'].includes(tk.status ?? '')) {
      const prev = tk.status ?? 'todo';
      tk.status = 'blocked';
      tk.autoBlocked = true;
      tk.resumeStatus = prev;
      tk.updatedAt = now();
      tk.updatedBy = actor;
      this.addComment(tk, 'hud', `auto: ${prev} → blocked (waiting on ${open.map((b) => this.ident(b)).join(', ')})`);
      this.emitEvent({ kind: 'item', item: tk, actor: 'hud' });
      this.log('hud', 'status', `${this.ident(tk)} blocked, waiting on ${open.map((b) => this.ident(b)).join(', ')}`, tk);
      return;
    }
    if (!open.length && tk.autoBlocked && tk.status === 'blocked' && !this.monitorsFailing(tk)) {
      const back = tk.resumeStatus && !['blocked', 'done', 'canceled'].includes(tk.resumeStatus) ? tk.resumeStatus : 'todo';
      tk.status = back;
      tk.autoBlocked = false;
      delete tk.resumeStatus;
      tk.updatedAt = now();
      tk.updatedBy = 'hud';
      this.addComment(tk, 'hud', `auto: blocked → ${back} (blockers finished)`);
      this.emitEvent({ kind: 'item', item: tk, actor: 'hud' });
      this.log('hud', 'status', `${this.ident(tk)} unblocked`, tk);
    }
  }

  /** after a ticket moves, re-check everything waiting on it */
  private syncDependents(t: Item, actor: string): void {
    for (const dep of [...this.blocksOf(t.id)]) this.syncDeps(dep, actor);
  }

  /** a compact rollup of a ticket subtree, for cards and list views */
  rollup(id: string): Rollup {
    const memo = this.index().rollups;
    const walk = (cur: string, path: Set<string>): Rollup => {
      const hit = memo.get(cur);
      if (hit) return hit;
      const r = { total: 0, done: 0 };
      if (!path.has(cur)) {
        path.add(cur);
        for (const k of this.childrenOf(cur)) {
          const sub = walk(k.id, path);
          r.total += 1 + sub.total;
          r.done += (this.isFinished(k) ? 1 : 0) + sub.done;
        }
        path.delete(cur);
        memo.set(cur, r);
      }
      return r;
    };
    return walk(id, new Set());
  }

  /**
   * The Linear-style read model: every ticket on a board grouped by project, with per-status counts.
   * A ticket whose project is missing counts as having none.
   */
  projectsView(board = 'main', q?: SearchQuery): {
    project: Item | undefined;
    key: string;
    name: string;
    counts: Record<string, number>;
    total: number;
    tickets: Item[];
  }[] {
    const byProject = new Map<string, Item[]>();
    const m = q ? this.matcher(q, board) : undefined;
    const filtered = !!q && Object.entries(q).some(([k, v]) => v !== undefined && v !== '' && !['board', 'limit', 'type'].includes(k));
    for (const it of Object.values(this.state.items)) {
      if (it.type !== 'ticket' || it.board !== board || (m && !m(it))) continue;
      const pid = it.project && this.state.items[it.project]?.type === 'project' ? it.project : '';
      byProject.get(pid)?.push(it) ?? byProject.set(pid, [it]);
    }
    const bucket = (project: Item | undefined) => {
      const own = (byProject.get(project?.id ?? '') ?? []).sort((a, b) => (a.num ?? 0) - (b.num ?? 0));
      const counts: Record<string, number> = {};
      for (const t of own) counts[t.status ?? 'todo'] = (counts[t.status ?? 'todo'] ?? 0) + 1;
      return { project, key: project?.key ?? '—', name: project?.title ?? 'no project', counts, total: own.length, tickets: own };
    };
    let out = this.projects(board).map((p) => bucket(p));
    if (filtered) out = out.filter((b) => b.total);
    const loose = bucket(undefined);
    if (loose.total) out.push(loose);
    const lim = Math.floor(Number(q?.limit));
    if (Number.isFinite(lim) && lim > 0) {
      let left = lim;
      for (const b of out) {
        b.tickets = b.tickets.slice(0, left);
        left -= b.tickets.length;
      }
      out = out.filter((b) => b.tickets.length);
    }
    return out;
  }

  /** tickets that link this monitor show it live; with autoStatus they also follow it */
  private syncTickets(mon: Item) {
    for (const tk of Object.values(this.state.items)) {
      if (tk.type !== 'ticket' || !tk.monitors?.includes(mon.id)) continue;
      if (!tk.autoStatus) {
        this.emitEvent({ kind: 'item', item: tk, actor: 'hud' });
        continue;
      }
      const mons = tk.monitors.map((m) => this.state.items[m]).filter((m): m is Item => !!m && m.type === 'monitor');
      const isDone = (m: Item) => m.state === 'done' || (m.progress != null && m.progress >= 100 && m.state !== 'error');
      let next: string | undefined;
      let why = '';
      if (mons.length && mons.every(isDone)) {
        if (tk.status !== 'done') (next = 'done'), (why = 'all linked monitors done');
      } else if (mons.some((m) => m.state === 'error')) {
        if (tk.status !== 'blocked' && tk.status !== 'done') (next = 'blocked'), (why = `${mons.filter((m) => m.state === 'error').map((m) => m.id).join(', ')} in error`);
      } else if (tk.autoBlocked && tk.status === 'blocked' && !this.openBlockers(tk).length) {
        (next = tk.resumeStatus && !['blocked', 'done', 'canceled'].includes(tk.resumeStatus) ? tk.resumeStatus : 'doing'), (why = 'linked monitors recovered');
      }
      if (!next) {
        this.emitEvent({ kind: 'item', item: tk, actor: 'hud' });
        continue;
      }
      const prev = tk.status;
      const wasFinished = this.isFinished(tk);
      if (next === 'blocked') tk.resumeStatus = prev;
      else delete tk.resumeStatus;
      tk.status = next;
      tk.autoBlocked = next === 'blocked';
      tk.updatedAt = now();
      tk.updatedBy = 'hud';
      this.addComment(tk, 'hud', `auto: ${prev} → ${next} (${why})`);
      this.emitEvent({ kind: 'item', item: tk, actor: 'hud' });
      this.log('hud', 'status', `${tk.id} ${prev} → ${next} (${why})`, tk);
      this.statusMoved(tk, wasFinished, 'hud');
      this.autoOrganize(tk.board);
    }
  }

  /** Settle a monitor's state after a reading: explicit state (or ok) worsened by any numeric thresholds. */
  private settle(item: Item, base: MonState | undefined, progressGiven: boolean, explicit = false) {
    const v = typeof item.value === 'number' ? item.value : item.value === '' || item.value == null || typeof item.value === 'boolean' ? NaN : Number(item.value);
    if (item.max && Number.isFinite(v) && !progressGiven) item.progress = Math.max(0, Math.min(100, (v / item.max) * 100));
    let s: MonState = base ?? item.state ?? 'unknown';
    // thresholds judge plain readings; an explicitly reported state (error, done, …) stands
    if (Number.isFinite(v) && !explicit) {
      let th: MonState | undefined;
      if ((item.warnAbove != null && v > item.warnAbove) || (item.warnBelow != null && v < item.warnBelow)) th = 'warn';
      if ((item.errorAbove != null && v > item.errorAbove) || (item.errorBelow != null && v < item.errorBelow)) th = 'error';
      const rank = (x: MonState) => (x === 'error' ? 3 : x === 'warn' ? 2 : 0);
      if (th && rank(th) > rank(s)) s = th;
    }
    item.state = s;
  }

  private record(item: Item, at?: number) {
    const t = at ?? item.lastUpdate ?? now();
    const v = typeof item.value === 'number' ? item.value : Number.isFinite(Number(item.value)) && item.value !== '' && item.value !== null && typeof item.value !== 'boolean' ? Number(item.value) : null;
    const p = item.progress ?? null;
    (item.history ??= []).push({ t, v, s: item.state ?? 'unknown', ...(p !== null ? { p } : {}) });
    if (item.history.length > HISTORY_MAX) item.history.splice(0, item.history.length - HISTORY_MAX);
    // every reading lands in its minute's bucket, so `w` (worst severity) and uptime cover state-only monitors too
    const w = item.state === 'error' ? 2 : item.state === 'warn' ? 1 : 0;
    const bucket = Math.floor(t / 60000) * 60000;
    const tr = (item.trend ??= []);
    const last = tr[tr.length - 1];
    const numeric = v !== null || p !== null;
    if (last && last.t === bucket) {
      if (v !== null) last.v = last.v === null ? v : (last.v * last.n + v) / (last.n + 1);
      if (p !== null) last.p = p;
      if (numeric) last.n++;
      last.w = Math.max(last.w ?? 0, w);
    } else {
      tr.push({ t: bucket, v, p, n: numeric ? 1 : 0, w });
      if (tr.length > TREND_MAX) tr.splice(0, tr.length - TREND_MAX);
    }
    const log = (item.log ??= []);
    const prev = log[log.length - 1];
    const m = item.message ?? '';
    if (!prev || prev.m !== m || prev.s !== item.state) {
      log.push({ t, s: item.state ?? 'unknown', m });
      if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    }
  }

  /** Flow-layout items (default: everything top-level on a board, or the contents of a frame). */
  arrange(opts: { board?: string; frame?: string; ids?: string[]; width?: number; gap?: number }, actor: string) {
    const gap = opts.gap == null ? GRID : clamp(num('gap', opts.gap), 0, 1000);
    const frame = opts.frame ? this.get(this.resolveId(String(opts.frame), opts.board)) : undefined;
    if (frame && frame.type !== 'frame') throw new HudError(400, `${frame.id} is not a frame`);
    const board = frame?.board ?? this.requireBoard(opts.board).id;
    const all = Object.values(this.state.items).filter((i) => i.board === board);
    const frames = all.filter((i) => i.type === 'frame');
    let targets: Item[];
    const membersOf = (f: Item) => {
      const key = f.title.trim().toLowerCase();
      return all.filter((i) => i.type !== 'frame' && (key ? i.group?.toLowerCase() === key : !i.group && contains(f, i)));
    };
    const inSomeFrame = new Set(frames.flatMap((f) => membersOf(f).map((m) => m.id)));
    if (opts.ids?.length) targets = opts.ids.map((id) => this.get(this.resolveId(String(id), board))).filter((i) => i.board === board);
    else if (frame) targets = membersOf(frame);
    else targets = all.filter((i) => i.type === 'frame' || (!inSomeFrame.has(i.id) && !(i.group && this.groupFrame(board, i.group))));
    if (!opts.ids?.length) targets.sort((a, b) => a.y - b.y || a.x - b.x);
    const x0 = frame ? frame.x + GRID : Math.min(0, ...targets.map((t) => t.x));
    const y0 = frame ? frame.y + GRID * 2 : Math.min(0, ...targets.map((t) => t.y));
    const maxW = opts.width == null ? (frame ? frame.w - GRID * 2 : 1600) : clamp(num('width', opts.width), GRID * 4, MAX_COORD);
    let x = x0, y = y0, rowH = 0;
    const moved: Item[] = [];
    for (const it of targets) {
      if (x > x0 && x + it.w > x0 + maxW) {
        x = x0;
        y += rowH + gap;
        rowH = 0;
      }
      const dx = x - it.x, dy = y - it.y;
      if (it.type === 'frame' && (dx || dy)) {
        for (const c of membersOf(it)) {
          c.x += dx;
          c.y += dy;
          moved.push(c);
        }
      }
      it.x = x;
      it.y = y;
      moved.push(it);
      x += it.w + gap;
      rowH = Math.max(rowH, it.h);
    }
    if (frame) {
      frame.w = Math.max(frame.w, snap(Math.max(...targets.map((t) => t.x + t.w), 0) - frame.x + GRID));
      frame.h = Math.max(snap(y + rowH + GRID - frame.y), GRID * 6);
      moved.push(frame);
    }
    const t = now();
    for (const it of new Set(moved)) {
      it.updatedAt = t;
      it.updatedBy = actor;
      this.emitEvent({ kind: 'item', item: it, actor });
    }
    this.log(actor, 'arranged', `arranged ${targets.length} items${frame ? ` in ${frame.id}` : ''}`, frame);
    this.save();
    return [...new Set(moved)];
  }

  // ---------- groups & organize ----------
  groupFrame(board: string, name: string): Item | undefined {
    const n = name.trim().toLowerCase();
    return Object.values(this.state.items).find((i) => i.board === board && i.type === 'frame' && i.title.trim().toLowerCase() === n);
  }

  /** smallest frame whose area contains the item's center */
  frameAt(it: Item): Item | undefined {
    return Object.values(this.state.items)
      .filter((f) => f.board === it.board && f.type === 'frame' && contains(f, it))
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  }

  private organizeTimers = new Map<string, NodeJS.Timeout>();
  private autoOrganize(board: string) {
    if (!this.state.boards.find((b) => b.id === board)?.autoOrganize) return;
    clearTimeout(this.organizeTimers.get(board));
    this.organizeTimers.set(
      board,
      setTimeout(() => {
        this.organizeTimers.delete(board);
        if (this.state.boards.find((b) => b.id === board)?.autoOrganize) this.organize(board, 'hud', true);
      }, 250),
    );
  }

  /**
   * Tidy a whole board: every group gets a frame, members are sorted and packed inside it,
   * then frames and ungrouped items are packed into rows. Ungrouped items already sitting
   * inside a frame join that frame's group.
   */
  organize(boardRef: string | undefined, actor: string, quiet = false) {
    const board = this.requireBoard(boardRef).id;
    const gap = GRID;
    const all = () => Object.values(this.state.items).filter((i) => i.board === board);
    const touched = new Set<Item>();
    const set = (it: Item, p: Partial<Item>) => {
      for (const [k, v] of Object.entries(p)) {
        if ((it as any)[k] !== v) {
          (it as any)[k] = v;
          touched.add(it);
        }
      }
    };

    // adopt ungrouped items that sit inside a titled frame
    for (const it of all()) {
      if (it.type === 'frame' || it.group) continue;
      const f = this.frameAt(it);
      if (f?.title.trim()) set(it, { group: f.title.trim() });
    }
    // make sure every group has a frame
    const groups = new Map<string, Item>();
    for (const it of all().sort((a, b) => a.createdAt - b.createdAt)) {
      if (it.type === 'frame' || !it.group) continue;
      const key = it.group.toLowerCase();
      if (groups.has(key)) continue;
      const f = this.groupFrame(board, it.group) ?? this.create({ type: 'frame', board, title: it.group, x: -100000, y: -100000 }, actor);
      groups.set(key, f);
    }

    // pack members inside each frame
    const TYPE_ORDER: Record<string, number> = { monitor: 0, ticket: 1, util: 2, note: 3 };
    const STATUS_ORDER: Record<string, number> = { blocked: 0, doing: 1, review: 2, todo: 3, backlog: 4, done: 5, canceled: 6 };
    const PRIO_ORDER: Record<string, number> = { urgent: 0, high: 1, med: 2, low: 3 };
    const sortMembers = (a: Item, b: Item) =>
      (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
      (a.type === 'ticket'
        ? (STATUS_ORDER[a.status!] ?? 3.5) - (STATUS_ORDER[b.status!] ?? 3.5) || (PRIO_ORDER[a.priority!] ?? 4) - (PRIO_ORDER[b.priority!] ?? 4) || (a.num ?? 0) - (b.num ?? 0)
        : a.type === 'monitor'
          ? (a.title || a.id).localeCompare(b.title || b.id)
          : a.createdAt - b.createdAt);
    const frames = all().filter((i) => i.type === 'frame');
    for (const f of frames) {
      const key = f.title.trim().toLowerCase();
      const members = key ? all().filter((i) => i.type !== 'frame' && i.group?.toLowerCase() === key).sort(sortMembers) : [];
      if (!members.length) continue;
      const cellW = Math.max(...members.map((m) => m.w));
      const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(members.length * 0.9))));
      const innerW = Math.max(cols * cellW + (cols - 1) * gap, ...members.map((m) => m.w));
      const x0 = f.x + GRID, y0 = f.y + GRID * 2;
      let x = x0, y = y0, rowH = 0, prevType = '';
      let right = x0;
      for (const m of members) {
        const newSection = prevType && m.type !== prevType && x > x0;
        if (newSection || (x > x0 && x + m.w > x0 + innerW)) {
          x = x0;
          y += rowH + gap;
          rowH = 0;
        }
        set(m, { x, y });
        x += m.w + gap;
        right = Math.max(right, x - gap);
        rowH = Math.max(rowH, m.h);
        prevType = m.type;
      }
      set(f, { w: snap(Math.max(right - f.x + GRID, GRID * 8)), h: snap(y + rowH + GRID - f.y) });
    }

    // pack frames (carrying their members) and loose items into rows
    const loose = all()
      .filter((i) => i.type !== 'frame' && !i.group && !this.frameAt(i))
      .sort(sortMembers);
    const placed = frames.filter((f) => f.x > -50000).sort((a, b) => a.y - b.y || a.x - b.x);
    const fresh = frames.filter((f) => f.x <= -50000);
    const blocks: Item[] = [...placed, ...fresh, ...loose];
    // what each frame drags along: its group, or (untitled frames) whatever sits inside it
    const carry = new Map<string, Item[]>();
    for (const f of frames) {
      const key = f.title.trim().toLowerCase();
      carry.set(f.id, all().filter((m) => m.type !== 'frame' && (key ? m.group?.toLowerCase() === key : contains(f, m))));
    }
    if (blocks.length) {
      const area = blocks.reduce((s, b) => s + (b.w + gap * 3) * (b.h + gap * 3), 0);
      const maxW = Math.max(...blocks.map((b) => b.w), snap(Math.sqrt(area * 1.8)));
      const frameGap = GRID * 3;
      let x = 0, y = GRID * 2, rowH = 0, inLoose = false;
      for (const b of blocks) {
        const isLoose = b.type !== 'frame';
        const g = isLoose && inLoose ? gap : frameGap;
        if ((isLoose && !inLoose && x > 0) || (x > 0 && x + b.w > maxW)) {
          x = 0;
          y += rowH + frameGap;
          rowH = 0;
        }
        inLoose = isLoose;
        const dx = x - b.x, dy = y - b.y;
        if (b.type === 'frame' && (dx || dy)) for (const m of carry.get(b.id) ?? []) set(m, { x: m.x + dx, y: m.y + dy });
        set(b, { x, y });
        x += b.w + g;
        rowH = Math.max(rowH, b.h);
      }
    }

    const t = now();
    for (const it of touched) {
      it.updatedAt = t;
      this.emitEvent({ kind: 'item', item: it, actor });
    }
    if (!quiet || touched.size) this.log(actor, 'organized', `organized board ${board} (${groups.size || frames.length} groups, ${touched.size} moved)`);
    this.save();
    return { groups: [...groups.values()].map((f) => f.title), moved: touched.size };
  }

  // ---------- trash ----------
  /** drop entries older than 30 days, then the oldest beyond 500 */
  private pruneTrash() {
    const tr = this.state.trash;
    const cut = now() - TRASH_DAYS * 86_400_000;
    let n = 0;
    while (n < tr.length && tr[n].t < cut) n++;
    if (tr.length - n > TRASH_MAX) n = tr.length - TRASH_MAX;
    if (n > 0) tr.splice(0, n);
  }

  /** trashed entries, newest first */
  trash(board?: string): TrashEntry[] {
    this.pruneTrash();
    const b = board ? (this.board(board)?.id ?? board) : undefined;
    return this.state.trash.filter((e) => !b || e.item.board === b).reverse();
  }

  /** Put a trashed item back (newest entry with that id). A deleted board comes back with the items it took with it. */
  restore(id: string, actor: string): Item {
    const k = String(id);
    const e = [...this.state.trash].reverse().find((x) => x.item.id === k);
    if (!e) throw new HudError(404, `nothing in the trash with id "${k.slice(0, 80)}"`);
    if (Object.hasOwn(this.state.items, k)) throw new HudError(409, `item "${k}" already exists; remove or rename it first`);
    const bid = e.board?.id ?? e.item.board;
    const batch: TrashEntry[] = [e];
    if (!this.state.boards.some((b) => b.id === bid)) {
      const b: Board = e.board ? JSON.parse(JSON.stringify(e.board)) : { id: bid, name: bid, createdAt: now() };
      this.state.boards.push(b);
      this.emitEvent({ kind: 'board', board: b });
      this.log(actor, 'board.restored', `restored board "${b.name}"`);
      // the rest of a deleted board comes back with it: projects first so tickets can rejoin them
      if (e.board) {
        const rank = (x: Item) => (x.type === 'project' ? 0 : x.type === 'frame' ? 1 : x.type === 'ticket' ? 3 : 2);
        const rest = this.state.trash.filter((x) => x !== e && x.t === e.t && x.board?.id === bid && !Object.hasOwn(this.state.items, x.item.id));
        batch.push(...rest.sort((a, b) => rank(a.item) - rank(b.item)));
        batch.sort((a, b) => rank(a.item) - rank(b.item));
      }
    }
    for (const x of batch) {
      const it = this.reinsert(x.item, actor);
      this.state.trash.splice(this.state.trash.indexOf(x), 1);
      this.log(actor, 'restored', `restored ${it.type} ${it.id}${it.title ? ` "${it.title}"` : ''}`, it);
    }
    this.autoOrganize(bid);
    this.save();
    return this.get(k);
  }

  /** permanently delete trash entries (one id, or 'all'); returns how many went */
  purge(id: string | 'all', actor: string): number {
    const tr = this.state.trash;
    const before = tr.length;
    this.state.trash = id === 'all' ? [] : tr.filter((x) => x.item.id !== String(id));
    const n = before - this.state.trash.length;
    if (!n && id !== 'all') throw new HudError(404, `nothing in the trash with id "${String(id).slice(0, 80)}"`);
    if (n) {
      this.log(actor, 'purged', id === 'all' ? `emptied the trash (${n} entries)` : `permanently deleted ${id}`);
      this.save();
    }
    return n;
  }

  // ---------- export / import ----------
  /** a detached copy of the whole state (what GET /api/export serves) */
  exportState(): State {
    return JSON.parse(JSON.stringify(this.state)) as State;
  }

  /** run a foreign state document through the same load path as state.json, without touching the live state */
  private normalise(raw: Record<string, any>): State {
    const live = this.state;
    const liveIdx = this.idx;
    try {
      this.state = { version: STATE_VERSION, seq: dict(), boards: [], items: dict(), activity: [], alerts: [], trash: [] };
      this.idx = null;
      const v = typeof raw.version === 'number' && Number.isFinite(raw.version) ? Math.floor(raw.version) : 1;
      this.adopt(raw);
      this.state.version = v;
      if (!this.state.boards.some((b) => b.id === 'main')) this.state.boards.unshift({ id: 'main', name: 'main', createdAt: now() });
      this.migrate();
      this.repair();
      for (const id of Object.keys(this.state.items)) if (RESERVED_IDS.has(id)) delete this.state.items[id];
      return this.state;
    } catch (e) {
      if (e instanceof HudError) throw e;
      throw new HudError(400, `invalid state: ${(e as Error).message}`);
    } finally {
      this.state = live;
      this.idx = liveIdx;
    }
  }

  /**
   * Load a state document. replace: swap the whole board (a backup is taken first). merge: add the boards
   * and items that don't exist yet, skipping any whose id (or project key) is already taken.
   */
  importState(input: unknown, mode: 'replace' | 'merge', actor: string): { items: number; boards: number; backup: string } {
    if (mode !== 'replace' && mode !== 'merge') throw new HudError(400, 'mode must be replace or merge');
    if (!isObj(input)) throw new HudError(400, 'state must be an object');
    if (!isObj(input.items)) throw new HudError(400, 'state.items must be an object keyed by item id');
    if (input.boards !== undefined && !Array.isArray(input.boards)) throw new HudError(400, 'state.boards must be an array');
    const v = typeof input.version === 'number' && Number.isFinite(input.version) ? Math.floor(input.version) : 1;
    if (v > STATE_VERSION) throw new HudError(400, `state version ${v} is newer than this hud understands (${STATE_VERSION})`);
    const norm = this.normalise(input);
    const backup = this.backup(`preimport-${mode}`);
    if (mode === 'replace') {
      const old = this.state;
      this.state = { ...norm, activity: norm.activity, trash: norm.trash };
      this.idx = null;
      for (const t of this.organizeTimers.values()) clearTimeout(t);
      this.organizeTimers.clear();
      for (const it of Object.values(old.items)) if (!Object.hasOwn(this.state.items, it.id)) this.emitEvent({ kind: 'item.deleted', id: it.id, board: it.board, actor });
      for (const b of old.boards) if (!this.state.boards.some((x) => x.id === b.id)) this.emitEvent({ kind: 'board.deleted', id: b.id });
      for (const b of this.state.boards) this.emitEvent({ kind: 'board', board: b });
      for (const it of Object.values(this.state.items)) this.emitEvent({ kind: 'item', item: it, actor });
      this.log(actor, 'import', `replaced the board from an import (${Object.keys(this.state.items).length} items, ${this.state.boards.length} boards)`);
      this.flush();
      return { items: Object.keys(this.state.items).length, boards: this.state.boards.length, backup };
    }
    const items = this.state.items;
    let boards = 0;
    for (const b of norm.boards) {
      if (this.state.boards.some((x) => x.id === b.id)) continue;
      this.state.boards.push(b);
      boards++;
      this.emitEvent({ kind: 'board', board: b });
    }
    const fresh = Object.values(norm.items).filter((it) => !Object.hasOwn(items, it.id) && this.state.boards.some((b) => b.id === it.board));
    const added: Item[] = [];
    for (const it of fresh) {
      if (it.type === 'project' && it.key && this.keyTaken(it.key, it.board, it.id)) continue; // key conflict: skipped
      items[it.id] = it;
      added.push(it);
    }
    this.idx = null;
    for (const it of added) {
      if (it.type !== 'ticket') continue;
      const ok = (id: unknown) => typeof id === 'string' && items[id]?.type === 'ticket' && items[id].board === it.board && id !== it.id;
      if (it.project && (items[it.project]?.type !== 'project' || items[it.project].board !== it.board)) this.leaveProject(it, 'project was not imported');
      if (it.parent && !ok(it.parent)) delete it.parent;
      for (const k of TICKET_REFS) if (it[k]) it[k] = it[k]!.filter(ok);
      const clash = Object.values(items).some((o) => o !== it && o.type === 'ticket' && o.board === it.board && (o.project ?? '') === (it.project ?? '') && o.num === it.num);
      if (clash || it.num == null) {
        const old = this.ident(it);
        it.num = this.nextNum(it.project);
        this.addComment(it, 'hud', `renumbered ${old} → ${this.ident(it)} on import`);
      } else if ((this.state.seq[it.project ? `ticketNum:${it.project}` : 'ticketNum'] ?? 0) < it.num) this.state.seq[it.project ? `ticketNum:${it.project}` : 'ticketNum'] = it.num;
    }
    this.idx = null;
    for (const it of added) {
      this.emitEvent({ kind: 'item', item: it, actor, created: true });
      if (it.type === 'ticket') this.syncDeps(it, actor);
    }
    for (const b of new Set(added.map((i) => i.board))) this.autoOrganize(b);
    this.log(actor, 'import', `merged an import: ${added.length} items added, ${fresh.length - added.length + (Object.keys(norm.items).length - fresh.length)} skipped, ${boards} boards added`);
    this.save();
    return { items: added.length, boards, backup };
  }

  activity(limit = 50, board?: string) {
    const list = board ? this.state.activity.filter((a) => !a.board || a.board === board) : this.state.activity;
    return list.slice(-limit);
  }
}
