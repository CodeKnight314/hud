// hud — canvas client. No build step; plain ES module.
import { createTicketTree, TREE_GLYPH, withoutFinished } from './ticket-tree.js';
import { persistenceBannerHTML, persistenceNotice, restoreTarget } from './persistence-banner.js';
import { autoDisplay, renderChart as renderChartView, hitsOf, dropHits, setHits, helpers, DISPLAY_KINDS, seriesOf, rangeOf, isAnimated } from './views.js';
import { contextCacheable, contextHandoff, loadContextPages, renderContextTimeline } from './context-timeline.js';
import { UTIL_KINDS, UTIL_LABEL, renderCard as renderUtilCard, defaultUtil, isLive, timerRemaining, stopwatchElapsed, evaluate, md } from './utils.js';
import * as RichUtils from './utils.js';
import './table-controls.js';
import { cameraOnBoardOpen, cameraOnPendingOpen, containAxis, letterboxBoard, viewAfterViewportChange } from './board-scale.js';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const GRID = 20;
const ME = 'user';
const SYSTEM = 'hud';
const CAPTURE_TOKEN = new URLSearchParams(location.search).get('capture');
const CAPTURE_READONLY = !!CAPTURE_TOKEN;
const CAPTURE_BOARD = new URLSearchParams(location.search).get('board');
document.body.classList.toggle('capture-readonly', CAPTURE_READONLY);
if (CAPTURE_READONLY) window.__hudCapture = { ready: false, errors: [], customReady: false };
const STATUSES = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done', 'canceled'];
const STATUS_GLYPH = { backlog: '[ ]', todo: '[ ]', doing: '[~]', review: '[?]', blocked: '[!]', done: '[x]', canceled: '[-]' };
const PRIOS = ['', 'low', 'med', 'high', 'urgent'];
const MSTATES = ['ok', 'warn', 'error', 'unknown', 'running', 'done'];
const MGLYPH = { ok: '●', warn: '▲', error: '✕', unknown: '○', running: '◐', done: '✓' };
const KINDS = ['manual', 'push', 'command', 'http', 'probe', 'heartbeat'];
const DISPLAYS = DISPLAY_KINDS;
/** display kinds drawn as an SVG chart (so they get hover readout + y-range controls) */
const CHART_SET = new Set(['composite', 'capacity', 'breakdown', 'table', 'grid', 'pipeline', 'line', 'area', 'bars', 'gauge', 'histogram', 'scatter', 'pie', 'donut', 'heatmap', 'box', 'ridgeline', 'scatter3d', 'surface3d', 'bullet', 'waterfall']);
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

const S = {
  boards: [],
  items: new Map(),
  activity: [],
  board: null,
  mode: 'canvas', // 'canvas' | 'list' — the Linear-style ticket list
  open: new Set(), // ticket ids whose sub-tickets are collapsed in the list view
  view: { x: 60, y: 60, z: 1 },
  fit: null, // centered letterbox of the last real viewport; not the camera
  viewPending: false, // saved camera not judged yet because the canvas had no size
  sel: new Set(),
  drawer: null, // item id
  drawerWide: false,
  drawerWidth: 420,
  detail: new Map(), // full single-item reads; list/SSE payloads stay lite
  drafts: new Map(), // local unsent fields survive live refreshes and tab switches
  drawerDirty: false,
  mouse: { x: 0, y: 0 }, // world coords of last pointer position
  undo: [],
  alerts: [],
  live: false,
  connected: false,
  persistence: null,
  heartbeatAt: 0,
  readoutAt: 0,
  readoutBoards: new Map(),
  captureNow: null,
  captureErrors: [],
  views: [], // renderer modules from GET /api/views, used to cache-bust dynamic imports
  page: 'board', // the workspace is the only page; kept so older checks read the same
  attention: { items: [], now: Date.now() },
  runs: { items: [], showCompleted: false },
  sessions: { items: [], now: Date.now() },
  sessionsOpen: false,
  queue: null,
  claimCache: new Map(),
  claims: new Map(), // ticket id → live claim, for list/tree/board ownership
  claimsNow: 0, // latest applied claimsList snapshot; an older snapshot is dropped
  claimsEpoch: 0, // SSE claim/release while a snapshot is in flight
  claimsReady: false,
  contextCache: new Map(),
  contextKind: 'all',
  contextFor: null,
  lastVisit: 0,
  visitStarted: Date.now(),
  boardQuery: '',
  searchOpen: false,
  searchQuery: '',
};

const canvas = $('#canvas');
const world = $('#world');
const els = new Map(); // id -> element

const READONLY_SAFE_CONTROLS = '#btn-attention, #btn-board, #btn-search, #btn-more, [data-view], [data-needs-open], #btn-source, #btn-fit, #zoom-in, #zoom-out, #btn-help, #btn-activity, #board-list, #btn-new-board, [data-board-pick], [data-search-close], [data-search-open], [data-open], [data-run-open], [data-attention-open], [data-attention-run], [data-run-summary-open], [data-change-open], [data-jump], [data-strip-focus], [data-claim-focus], [data-source-open], [data-source-close], [data-created-board-link], [data-monitor-sort], [data-act="close"], [data-act="focus"], [data-act="expand"], [data-act="copy-handoff"], [data-chips="context-kind"] .chip, [data-drawer], [data-copy-ticket], [data-proj-switch], [data-shape], [data-f-hidedone]';
function applyReadonlyControls(root = document) {
  if (!CAPTURE_READONLY) return;
  for (const control of $$('button, input, select, textarea', root)) {
    if (control.matches(READONLY_SAFE_CONTROLS) || control.matches('#global-search-input, [data-board-query]')) continue;
    control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
  }
}
document.addEventListener('click', (e) => {
  if (!CAPTURE_READONLY || e.target.closest(READONLY_SAFE_CONTROLS)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// ---------------------------------------------------------------- utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const snap = (n) => Math.round(n / GRID) * GRID;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const displayNow = () => CAPTURE_READONLY && Number.isFinite(S.captureNow) ? S.captureNow : Date.now();
function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, Math.round((displayNow() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isOverdue = (t) => !!(t.target && t.type === 'ticket' && t.status !== 'done' && t.status !== 'canceled' && String(t.target).slice(0, 10) < todayISO());
const targetHTML = (t) => (t.target ? `<span class="${isOverdue(t) ? 'od' : 'dim'}" title="${isOverdue(t) ? 'overdue' : 'target date'}">${isOverdue(t) ? '‼ overdue' : '◷'} ${esc(String(t.target).slice(0, 10))}</span>` : '');
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
function monitorReadout(it) { return it?.readout && typeof it.readout === 'object' ? it.readout : {}; }
function monitorState(it) { return monitorReadout(it).state || it?.state || 'unknown'; }
function readingAgeSeconds(it) {
  const readout = monitorReadout(it);
  if (Number.isFinite(readout.ageSeconds)) {
    const advanced = CAPTURE_READONLY ? 0 : Math.max(0, (Date.now() - (S.readoutAt || Date.now())) / 1000);
    return Math.max(0, Number(readout.ageSeconds) + advanced);
  }
  const observation = it?.observation;
  const t = observation?.observedAt ?? observation?.receivedAt ?? it?.lastUpdate;
  return t ? Math.max(0, (displayNow() - t) / 1000) : null;
}
function staleAfterSeconds(it) {
  const source = it?.source || {};
  if (it?.freshness?.mode === 'static' || it?.state === 'done') return null;
  if (it?.staleAfter != null) return Number(it.staleAfter);
  if (source.kind === 'heartbeat') return Number(source.period ?? 60) + Number(source.grace ?? 60);
  if (['command', 'http', 'probe'].includes(source.kind)) {
    const interval = Number(source.interval ?? 30), timeout = Number(source.timeout ?? 30);
    return Math.max(60, 3 * interval, interval + timeout);
  }
  return 300;
}
function isStale(it) {
  const readout = monitorReadout(it);
  if (readout.stale === true || it?.stale) return true;
  const age = readingAgeSeconds(it), limit = staleAfterSeconds(it);
  return age != null && limit != null && age > limit;
}
const localDT = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtVal = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return String(v);
};
function parseVal(v) {
  if (v === '') return null;
  const t = v.trim();
  const n = Number(t);
  if (t !== '' && Number.isFinite(n)) return n;
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}
const numOrNull = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

async function api(method, path, body) {
  if (CAPTURE_READONLY && method !== 'GET') {
    throw Object.assign(new Error('capture snapshots are read-only'), { toasted: true });
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-hud-actor': ME },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    toast('hud server unreachable');
    throw Object.assign(new Error('hud server unreachable'), { toasted: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || `${res.status}`;
    toast(msg);
    throw Object.assign(new Error(msg), { toasted: true, status: res.status });
  }
  return data;
}

/** Optional supervision endpoints are allowed to be absent while an older server is running. */
async function optionalGET(path) {
  try {
    const r = await fetch(path, { headers: { 'x-hud-actor': ME } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}

let readoutLoading = false;
async function loadReadout(boardId = S.board) {
  if (CAPTURE_READONLY || !boardId || readoutLoading) return;
  readoutLoading = true;
  try {
    const data = await optionalGET(`/api/readout?board=${encodeURIComponent(boardId)}`);
    if (!data) return;
    S.readoutAt = Date.now();
    for (const boardReadout of data.boards || []) {
      S.readoutBoards.set(boardReadout.id, boardReadout);
      const board = S.boards.find((b) => b.id === boardReadout.id);
      if (board) {
        if (Array.isArray(boardReadout.annotations)) board.annotations = boardReadout.annotations;
        if (Array.isArray(boardReadout.comparisons)) board.comparisonResults = boardReadout.comparisons;
      }
    }
    for (const reading of data.items || []) {
      const item = S.items.get(reading.id);
      if (!item || item.type !== 'monitor') continue;
      const merged = { ...item, readout: reading };
      if (reading.pipelineView) merged.pipelineView = reading.pipelineView;
      S.items.set(item.id, merged);
      if (merged.board === S.board) renderItem(merged, true);
    }
    if (boardId === S.board) {
      updateChrome();
      queueProgramsMount();
    }
  } finally {
    readoutLoading = false;
  }
}

function reportHTML(text, format = 'plain', options = {}) {
  const value = String(text ?? '');
  const fn = RichUtils.reportHTML;
  if (typeof fn === 'function') return fn(value, format, options);
  if (format === 'markdown') return md(value);
  return esc(value).replace(/\n/g, '<br>');
}
function plainText(text) {
  const fn = RichUtils.plainText;
  if (typeof fn === 'function') return fn(text);
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}
function reportPreview(text, format = 'plain', lines = 4, id = '') {
  const value = String(text ?? '');
  if (!value.trim()) return '';
  const rawLines = value.split(/\r?\n/);
  let short = rawLines.slice(0, lines).join('\n');
  const maxChars = 320;
  const plain = plainText(value);
  const more = rawLines.length > lines || plain.length > maxChars;
  if (more && plainText(short).length > maxChars) short = short.slice(0, maxChars) + '…';
  const key = id ? ` data-report-id="${esc(id)}"` : '';
  return `<div class="report-preview${more ? '' : ' expanded'}"${key}>${reportHTML(short, format, { readonly: true })}</div>${more ? `<button class="report-more" data-report-more${key}>read more · details</button>` : ''}`;
}

// every api() failure already toasted; anything else that escapes a handler is surfaced instead of vanishing
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  if (!e.reason?.toasted) toast(String(e.reason?.message || e.reason));
});

let toastT;
const createdToastIds = new Set();
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('open');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('open'), ms);
}
function toastBoardCreated(it) {
  if (createdToastIds.has(it.id)) return;
  createdToastIds.add(it.id);
  const t = $('#toast');
  t.replaceChildren(document.createTextNode(`created ${it.title || it.id} on `));
  const a = document.createElement('a');
  a.href = `#item=${encodeURIComponent(it.uuid || it.id)}`;
  a.textContent = boardName(it.board);
  a.dataset.createdBoardLink = it.id;
  t.append(a);
  t.classList.add('open');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('open'), 5000);
  setTimeout(() => createdToastIds.delete(it.id), 5000);
}

const boardItems = () => [...S.items.values()].filter((i) => i.board === S.board);
const canvasItems = () => boardItems().filter(i => {
  if (i.type === 'ticket' || i.type === 'project') return false;
  if (i.type !== 'frame') return true;
  const members = membersOf(i);
  return !members.length || members.some(m => m.type !== 'ticket' && m.type !== 'project');
});
function hashState() {
  const raw = location.hash.replace(/^#/, '');
  try {
    if (raw === 'attention' || raw === 'runs') return { page: raw };
    if (raw.startsWith('item=')) return { page: 'item', item: decodeURIComponent(raw.slice(5)) };
    if (raw.startsWith('board=')) return { page: 'board', board: decodeURIComponent(raw.slice(6)) };
    return { page: 'board', board: decodeURIComponent(raw) };
  } catch {
    return { page: 'board', board: '' };
  }
}
const hashId = () => hashState().board || '';
function setNavHash(page, value = '') {
  const h = page === 'attention' || page === 'runs' ? `#${page}` : page === 'item' ? `#item=${encodeURIComponent(value)}` : `#${encodeURIComponent(value)}`;
  history.replaceState(null, '', h);
}
/** parent -> child tickets; rebuilt per synchronous pass (the microtask drops it before the next event) */
let kidIdx = null;
function kidsOf(id) {
  if (!kidIdx) {
    kidIdx = new Map();
    for (const c of S.items.values()) if (c.type === 'ticket' && c.parent) (kidIdx.get(c.parent) || kidIdx.set(c.parent, []).get(c.parent)).push(c);
    queueMicrotask(() => (kidIdx = null));
  }
  return kidIdx.get(id) || [];
}
/** the server lite() strips heavy fields from SSE/state; do the same to PATCH/POST responses before storing them */
const lite = (it) => {
  if (!it || typeof it !== 'object') return it;
  const { trend, graph, reportHistory, uptime, ...rest } = it;
  return rest;
};
const itemFor = (id) => {
  const base = S.items.get(id);
  if (!base) return undefined;
  const heavy = S.detail.get(id);
  return heavy ? { ...base, ...heavy } : base;
};

/** KEY-12 when the ticket's project has a key, else #12 — the name used everywhere tickets are referred to */
function identOf(it) {
  if (!it || it.type !== 'ticket' || it.num == null) return it?.id ?? '';
  const p = it.project ? S.items.get(it.project) : null;
  return p?.key ? `${p.key}-${it.num}` : `#${it.num}`;
}
/** resolve an id or a KEY-12 / #12 back to a ticket on any board */
function ticketBy(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  if (S.items.get(s)) return S.items.get(s);
  const uuid = [...S.items.values()].find(i => i.type === 'ticket' && i.uuid?.toLowerCase() === s.toLowerCase());
  if (uuid) return uuid;
  const m = /^(?:([A-Za-z][A-Za-z0-9]{1,7})-)?#?(\d+)$/.exec(s);
  if (!m) return null;
  for (const it of S.items.values()) if (it.type === 'ticket' && it.num === Number(m[2]) && (!m[1] || (S.items.get(it.project)?.key ?? '').toUpperCase() === m[1].toUpperCase())) return it;
  return null;
}
const nameOf = (ref) => identOf(ticketBy(ref)) || String(ref);
/** the chain from the root ticket down to this one, e.g. "EGO-1 › EGO-4" */
function ancestryOf(it) {
  const out = [];
  const seen = new Set([it.id]);
  let cur = it.parent;
  while (cur && !seen.has(cur)) {
    const p = S.items.get(cur);
    if (!p) break;
    out.unshift(p);
    seen.add(cur);
    cur = p.parent;
  }
  return out;
}
/** show a project by KEY when we know it */
const projectRef = (it) => (it.project ? S.items.get(it.project)?.key || it.project : '');
/** frame membership is the stored group (frame title); untitled frames hold whatever ungrouped item sits inside */
function membersOf(f) {
  const key = (f.title || '').trim().toLowerCase();
  return [...S.items.values()].filter((i) => i.board === f.board && i.type !== 'frame' && (key ? (i.group || '').toLowerCase() === key : !i.group && contains(f, i)));
}
function frameUnder(it, exclude) {
  return canvasItems()
    .filter((f) => f.type === 'frame' && !exclude?.has(f.id) && (f.title || '').trim() && contains(f, it))
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
}
function contains(f, it) {
  if (f.id === it.id || it.w * it.h >= f.w * f.h) return false;
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
}

function copyTicketButton(it) {
  return `<button class="copy-ticket" data-copy-ticket="${esc(it.uuid || it.id)}" title="Copy ticket UUID: ${esc(it.uuid || it.id)}" aria-label="Copy ticket UUID"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/></svg></button>`;
}
document.addEventListener('pointerdown', e => {
  if (e.target.closest('[data-copy-ticket]')) e.stopPropagation();
}, true);
document.addEventListener('dblclick', e => {
  if (e.target.closest('[data-copy-ticket]')) e.stopPropagation();
}, true);
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy-ticket]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const value = b.dataset.copyTicket;
  try {
    await navigator.clipboard.writeText(value);
    toast('Ticket UUID copied');
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    toast(copied ? 'Ticket UUID copied' : `Copy UUID: ${value}`);
  }
}, true);
// Reports are read-only. Keep safe external Markdown links in a separate tab instead of navigating hud away.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('.md a, .report-markdown a, .report-preview a, .drawer-report a, .comment a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (/^(?:https?:|mailto:)/i.test(href)) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}, true);
document.addEventListener('click', (e) => {
  const more = e.target.closest?.('[data-report-more]');
  if (more) {
    e.preventDefault();
    e.stopPropagation();
    const card = more.closest('.item');
    const issue = more.closest('[data-attention-id]');
    const id = card?.dataset.id || S.attention.items.find(a => a.id === issue?.dataset.attentionId)?.itemId;
    if (id) openDrawer(id);
  }
}, true);

// ---------------------------------------------------------------- view
function readSavedView() {
  if (CAPTURE_READONLY) return null;
  try { return JSON.parse(localStorage.getItem('hud.bounded-view.' + S.board)); } catch { return null; }
}
function loadView() {
  const raw = canvas.getBoundingClientRect();
  // List and supervision hide the canvas. Judging the saved camera against that 0×0 box
  // would drop a legal pan; settleCamera applies it once the board is on screen.
  if (raw.width < 1 || raw.height < 1) {
    S.viewPending = true;
    S.fit = null;
    const saved = readSavedView();
    if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite)) return { x: saved.x, y: saved.y, z: saved.z };
    return { x: 0, y: 0, z: 1 };
  }
  S.viewPending = false;
  const b = boardSize(), r = viewport(true);
  const fit = letterboxBoard(b.w, b.h, r.w, r.h);
  if (CAPTURE_READONLY) return fit;
  return cameraOnBoardOpen(readSavedView(), fit, r.w);
}
const saveView = debounce(() => {
  if (CAPTURE_READONLY) return;
  try {
    localStorage.setItem('hud.bounded-view.' + S.board, JSON.stringify(S.view));
  } catch {}
}, 300);

function boardSize() {
  const b = S.boards.find(b => b.id === S.board);
  return { w: b?.width || 1600, h: b?.height || 900 };
}
function drawerPixels() { return S.drawerWide ? Math.min(900, innerWidth) : (S.drawerWidth || 420); }
function viewport(ignoreDrawer = false) {
  const r = canvas.getBoundingClientRect();
  let cover = 0;
  if (S.drawer && !ignoreDrawer) {
    const dr = $('#drawer')?.getBoundingClientRect();
    // The drawer overlays the canvas. Measure the overlap so the letterbox matches the visible area.
    if (dr && dr.width > 0) cover = Math.max(0, Math.min(r.right, dr.right) - Math.max(r.left, dr.left));
    else cover = Math.min(drawerPixels(), r.width);
  }
  return { w: Math.max(1, r.width - Math.min(cover, r.width)), h: Math.max(1, r.height) };
}
function fittedView() {
  const b = boardSize(), r = viewport();
  return letterboxBoard(b.w, b.h, r.w, r.h);
}
function refitIfLetterboxed() {
  const previous = fittedView();
  return () => {
    const next = viewport();
    S.view = viewAfterViewportChange(S.view, previous, fittedView(), next.w);
    applyView();
  };
}

function applyView() {
  const b = boardSize(), r = viewport(), min = fittedView().z;
  S.view.z = clamp(S.view.z, min, Math.max(3, min));
  S.view.x = containAxis(S.view.x, b.w * S.view.z, r.w);
  S.view.y = containAxis(S.view.y, b.h * S.view.z, r.h);
  const raw = canvas.getBoundingClientRect();
  if (raw.width >= 1 && raw.height >= 1) S.fit = fittedView();
  const { x, y, z } = S.view;
  world.style.width = b.w + 'px';
  world.style.height = b.h + 'px';
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  $('#zoom').textContent = `${Math.round(z * 100)}%`;
  $('#zoom-out').disabled = z <= min + 0.001;
  $('#zoom-in').disabled = z >= Math.max(3, min) - 0.001;
  saveView();
}

/** Resize and return-to-board. A centered letterbox follows the viewport; a kept pan or zoom does not. */
function settleCamera() {
  const raw = canvas.getBoundingClientRect();
  if (S.page !== 'board' || S.mode !== 'canvas' || raw.width < 1 || raw.height < 1) return;
  const b = boardSize();
  const full = viewport(true);
  const wide = letterboxBoard(b.w, b.h, full.w, full.h);
  const visible = viewport();
  const beside = letterboxBoard(b.w, b.h, visible.w, visible.h);
  if (S.viewPending || !S.fit) {
    // The canvas was hidden when the camera was saved. Judge it against the full
    // window, then let an already-open inspector take the centered letterbox only.
    S.view = cameraOnPendingOpen(S.view, wide, beside, !!S.drawer, visible.w, full.w);
    S.viewPending = false;
  } else {
    S.view = viewAfterViewportChange(S.view, S.fit, beside, visible.w);
  }
  applyView();
}

function toWorld(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return { x: (cx - r.left - S.view.x) / S.view.z, y: (cy - r.top - S.view.y) / S.view.z };
}

function zoomAt(cx, cy, nz) {
  nz = clamp(nz, fittedView().z, Math.max(3, fittedView().z));
  const r = canvas.getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const wx = (px - S.view.x) / S.view.z, wy = (py - S.view.y) / S.view.z;
  S.view.z = nz;
  S.view.x = px - wx * nz;
  S.view.y = py - wy * nz;
  applyView();
}

function fit(items) {
  if (!items?.length) {
    S.view = fittedView();
    return applyView();
  }
  const v = viewport();
  const minX = Math.min(...items.map((i) => i.x)), minY = Math.min(...items.map((i) => i.y - (i.type === 'frame' ? 24 : 0)));
  const maxX = Math.max(...items.map((i) => i.x + i.w)), maxY = Math.max(...items.map((i) => i.y + i.h));
  const pad = 60;
  const spanW = Math.max(1, maxX - minX), spanH = Math.max(1, maxY - minY);
  const z = clamp(Math.min((Math.max(1, v.w - pad * 2)) / spanW, (Math.max(1, v.h - pad * 2)) / spanH), 0.1, 1);
  S.view = { z, x: (v.w - spanW * z) / 2 - minX * z, y: (v.h - spanH * z) / 2 - minY * z };
  applyView();
}

function focusItem(id) {
  const it = S.items.get(id);
  if (!it) return toast(`no item ${id}`);
  if (it.board !== S.board) switchBoard(it.board);
  if (it.type === 'ticket' || it.type === 'project') {
    setMode('list');
    return openDrawer(id);
  }
  if (S.mode !== 'canvas') setMode('canvas');
  const v = viewport();
  S.view.z = Math.max(S.view.z, 0.6);
  S.view.x = v.w / 2 - (it.x + it.w / 2) * S.view.z;
  S.view.y = v.h / 2 - (it.y + it.h / 2) * S.view.z;
  applyView();
  select([id]);
  flash(id);
}

// ---------------------------------------------------------------- render: cards
function spark(hist, chars) {
  const vals = (hist || []).filter(Boolean).map((h) => h.v).filter((v) => v !== null && v !== undefined).slice(-chars);
  if (vals.length < 2) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const B = '▁▂▃▄▅▆▇█';
  return vals.map((v) => (hi === lo ? B[0] : B[Math.round(((v - lo) / (hi - lo)) * 7)])).join('');
}
function bar(pct, chars) {
  const n = clamp(Math.round((pct / 100) * chars), 0, chars);
  return `<b>${'█'.repeat(n)}</b>${'░'.repeat(chars - n)}`;
}

/** throughput and ETA from recent readings: progress (→100%), value toward max, or plain value growth */
function rateOf(it) {
  const h = (it.history || []).filter(Boolean);
  const useP = it.progress != null && !(it.max && typeof it.value === 'number');
  const key = useP ? 'p' : 'v';
  let pts = h.filter((x) => x[key] != null && x.t > Date.now() - 30 * 60e3);
  if (pts.length < 3) pts = h.filter((x) => x[key] != null).slice(-60);
  if (pts.length < 3 || pts[pts.length - 1].t - pts[0].t < 60e3) return null;
  const n = pts.length, mx = pts.reduce((a, x) => a + x.t, 0) / n, my = pts.reduce((a, x) => a + x[key], 0) / n;
  let num = 0, den = 0;
  for (const x of pts) (num += (x.t - mx) * (x[key] - my)), (den += (x.t - mx) ** 2);
  if (!den) return null;
  const perH = (num / den) * 3600e3;
  if (Math.abs(perH) < 1e-9) return { text: 'flat' };
  const cur = pts[n - 1][key];
  const remaining = useP ? 100 - cur : it.max ? it.max - cur : null;
  const unit = useP ? '%' : '';
  let text = `~${fmtVal(Math.abs(perH) >= 10 ? Math.round(perH) : +perH.toFixed(2))}${unit}/h`;
  if (remaining != null && remaining > 0 && perH > 0) {
    const eta = Date.now() + (remaining / perH) * 3600e3;
    const sameDay = new Date(eta).toDateString() === new Date().toDateString();
    text += ` · ETA ${sameDay ? hhmm(eta) : new Date(eta).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }
  return { text, perH };
}

const by = (it) => (it.createdBy && it.createdBy !== ME ? `<span class="agent">${esc(it.createdBy)}</span>` : '');

/** a ticket is awaiting a decision while it has options and no answer yet */
const needsDecision = (it) => it.type === 'ticket' && (it.options?.length ?? 0) > 0 && !it.decision;

/** an agent-authored command stays pending until the human approves this command and cwd */
const commandPending = (it) => it?.type === 'monitor' && it.source?.kind === 'command' && it.commandApproval?.status === 'pending';

/** the classes that carry the two semantic colours: red = needs attention, green = done */
function stateClass(it) {
  if (it.type === 'ticket') {
    const cls = [`s-${it.status || 'todo'}`];
    if (it.status === 'blocked' || needsDecision(it)) cls.push('needs-decision');
    return cls;
  }
  if (it.type === 'monitor') {
    const cls = [`m-${monitorState(it)}`];
    if (commandPending(it)) cls.push('awaiting-approval');
    return cls;
  }
  return [];
}

function ageLabel(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function pipelineStageReadings(it) {
  const pipeline = it?.pipelineView || monitorReadout(it).pipelineView;
  if (!Array.isArray(pipeline?.stages)) return [];
  return pipeline.stages.flatMap((stage) => Object.values(stage || {}).filter((value) => value && typeof value === 'object' && typeof value.id === 'string' && Number.isFinite(value.ageSeconds)));
}
function monitorSourceLabel(it) {
  const r = monitorReadout(it), m = it.metric || {}, s = it.source || {};
  const stages = pipelineStageReadings(it);
  if (stages.length || it.pipeline || it.display === 'pipeline') {
    const names = [...new Set(stages.map((stage) => stage.source).filter(Boolean))];
    return names.length ? `stage bindings · ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : 'derived from stage bindings';
  }
  if (it.display === 'custom' && it.program?.description) return `${r.source || m.source || `${s.kind || 'manual'} by ${it.observation?.actor || it.updatedBy || 'unknown'}`} · renderer ${it.program.description}`;
  if (r.source) return String(r.source);
  if (m.source) return String(m.source);
  if (m.sourceId) return String(m.sourceId);
  if (s.kind === 'probe' && s.probe) return `probe:${s.probe}`;
  if (s.kind === 'command') return 'command collector';
  if (s.kind === 'http') return 'HTTP collector';
  return `${s.kind || 'manual'} by ${it.observation?.actor || it.updatedBy || 'unknown'}`;
}
function monitorMetadata(it) {
  const readout = monitorReadout(it), observation = it.observation || {};
  const legacy = !it.observation || observation.observedAt == null;
  const stages = pipelineStageReadings(it);
  const stageEvidence = [...new Set(stages.map((stage) => stage.evidence).filter(Boolean))];
  const evidence = stages.length
    ? stageEvidence.length === 1 ? stageEvidence[0] : 'unknown (derived)'
    : legacy ? 'unknown (legacy)' : (observation.evidence || readout.evidence || it.evidence || 'unknown');
  const age = stages.length ? Math.max(...stages.map((stage) => Number(stage.ageSeconds) + (CAPTURE_READONLY ? 0 : Math.max(0, (Date.now() - (S.readoutAt || Date.now())) / 1000)))) : readingAgeSeconds(it);
  const coverage = readout.coverage || observation.coverage || it.coverage;
  const coverageText = stages.length ? 'per stage' : coverage && Number.isFinite(coverage.responding) && Number.isFinite(coverage.total)
    ? `${coverage.responding}/${coverage.total}` : '—';
  const definition = it.metric?.definition || readout.definition || (it.display === 'custom' ? it.program?.description : '') || (stages.length || it.pipeline ? 'derived from declared stage bindings' : 'definition not set');
  return { source: monitorSourceLabel(it), evidence, age: `${stages.length ? 'worst ' : ''}${ageLabel(age)}`, coverage: coverageText, definition };
}
function monitorMetaFooter(it) {
  const readout = monitorReadout(it);
  const hasNumeric = typeof it.value === 'number' || typeof readout.value === 'number' || typeof it.progress === 'number' || typeof readout.progress === 'number';
  const hasStructuredData = !!(it.data || it.pipeline || it.pipelineView || readout.pipelineView || it.display === 'table' || it.display === 'pipeline' || it.display === 'custom');
  if (it.type !== 'monitor' || (!hasNumeric && !hasStructuredData)) return '';
  const meta = monitorMetadata(it);
  return `<span>source ${esc(meta.source)}</span><span>evidence ${esc(meta.evidence)}</span><span>age ${esc(meta.age)}</span><span>coverage ${esc(meta.coverage)}</span><span class="definition" title="${esc(meta.definition)}">${esc(meta.definition)}</span>`;
}
function plotItemWithBoardContext(it) {
  const board = S.boards.find((b) => b.id === it.board);
  const plot = { ...(it.plot || {}) };
  const events = [...(Array.isArray(plot.events) ? plot.events : [])];
  for (const annotation of board?.annotations || []) {
    if (annotation.deletedAt) continue;
    if (!events.some((e) => (e.id && e.id === annotation.id) || (e.time === annotation.time && e.text === annotation.text))) {
      events.push({ id: annotation.id, time: annotation.time, text: annotation.text });
    }
  }
  const metrics = Array.isArray(plot.metrics) ? plot.metrics : [];
  const unit = it.metric?.unit ?? it.unit ?? '';
  const plotSeries = metrics.map((ref) => {
    const name = String(ref);
    const metric = S.items.get(name) || [...S.items.values()].find((candidate) => candidate.board === it.board && candidate.type === 'monitor' && (candidate.metric?.key === name || candidate.metric?.sourceId === name));
    if (!metric || metric.type !== 'monitor' || metric.board !== it.board) return null;
    const metricUnit = metric.metric?.unit ?? metric.unit ?? '';
    if (metricUnit !== unit) return null;
    return { label: name, unit: metricUnit, history: (metric.history || []).filter((point) => typeof point.v === 'number' && Number.isFinite(point.v)).map((point) => ({ t: point.t, v: point.v })) };
  }).filter(Boolean);
  return { ...it, plot: { ...plot, events }, ...(metrics.length ? { plotSeries } : {}) };
}

/** assignee (→) and live claimer (⊕). A dash means that side is unset. */
function ownershipHTML(t) {
  const claim = S.claims.get(t.id);
  const assignee = t.assignee ? esc(t.assignee) : '—';
  const claimer = claim ? esc(claim.actor || claim.session) : (S.claimsReady ? '—' : '…');
  const tip = claim
    ? `assignee ${t.assignee || '—'}; claimed by ${claim.actor} (${claim.session})`
    : `assignee ${t.assignee || '—'}; ${S.claimsReady ? 'unclaimed' : 'claim unknown'}`;
  return `<span class="own" title="${esc(tip)}"><span class="own-a">→${assignee}</span><span class="own-c">⊕${claimer}</span></span>`;
}

function cardHTML(it) {
  const cols = clamp(Math.floor((it.w - 18) / 7.25), 4, 300);
  switch (it.type) {
    case 'ticket': {
      const pr = it.priority ? `<span class="prio-${esc(it.priority)}">!${esc(it.priority)}</span>` : '';
      const tags = (it.tags || []).map((t) => `#${esc(t)}`).join(' ');
      const nc = it.comments?.length ? `${it.comments.length}c` : '';
      const links = (it.monitors || [])
        .map((id) => {
          const m = S.items.get(id);
          if (!m) return `<div class="ln faint">? ${esc(id)}</div>`;
          const val = m.label ?? (m.value != null ? fmtVal(m.value) + (m.unit || '') : m.state);
          const pr = m.progress != null && m.label == null ? ` ${Math.round(m.progress)}%` : '';
          return `<div class="ln s-${esc(m.state)}"><span class="g">${MGLYPH[m.state] || '○'}</span> <span class="lt">${esc(m.title || m.id)}</span> <span class="lv">${esc(val)}${pr}</span></div>`;
        })
        .join('');
      const opts = it.options?.length
        ? `<div class="opts">${it.question ? `<div class="q">${esc(it.question)}</div>` : ''}${it.options
            .map((o) => {
              const chosen = it.decision?.optionId === o.id;
              if (it.decision && !chosen) return '';
              return `<div class="opt${chosen ? ' chosen' : ''}" data-decide="${esc(o.id)}" data-label="${esc(o.label)}" data-decision-version="${esc(it.decisionVersion ?? '')}"><span class="k">${chosen ? '✓' : '▸'}${esc(o.id)}</span> ${esc(o.label)}${o.detail ? ` <span class="d">${esc(o.detail)}</span>` : ''}</div>`;
            })
            .join('')}</div>`
        : '';
      const answer = it.decision
        ? `<div class="answer"><span class="k">decided ${esc(it.decision.actor)}:</span> ${esc(it.options?.find((o) => o.id === it.decision.optionId)?.label ?? it.decision.optionId)}</div>`
        : '';
      const kids = kidsOf(it.id);
      const blockerNames = (it.blockedBy || []).map(nameOf);
      const refNames = (it.refs || []).map(nameOf);
      const lineage = [
        it.parent && `↳ ${esc(nameOf(it.parent))}`,
        blockerNames.length && `⊘ ${esc(blockerNames.join(', '))}`,
        refNames.length && `⇒ ${esc(refNames.join(', '))}`,
        kids.length && `+${kids.length} sub`,
      ]
        .filter(Boolean)
        .join('  ');
      return `<div class="hd"><span class="st">${STATUS_GLYPH[it.status] || '[·]'} ${esc(it.status)}</span><span class="r">${it.autoStatus ? '<span title="status follows linked monitors">⟳</span> ' : ''}${pr} <span class="idt">${esc(identOf(it))}</span> ${copyTicketButton(it)}</span></div>
        <div class="bd"><div class="ttl">${esc(it.title) || '<span class="faint">untitled</span>'}</div>${lineage ? `<div class="lineage">${lineage}</div>` : ''}${opts}${answer}${links ? `<div class="links">${links}</div>` : ''}<div class="body md">${md(it.body)}</div></div>
        <div class="ft">${by(it)}${ownershipHTML(it)}<span>${tags}</span>${targetHTML(it)}<span class="r">${nc} ${ago(it.updatedAt)}</span></div>`;
    }
    case 'monitor': {
      const reading = monitorReadout(it);
      const value = Object.hasOwn(reading, 'value') ? reading.value : it.value;
      const label = Object.hasOwn(reading, 'label') ? reading.label : it.label;
      const readingUnit = reading.unit || it.metric?.unit || it.unit || '';
      const plotted = plotItemWithBoardContext({ ...it, value, label, unit: readingUnit, state: reading.state || it.state, progress: reading.progress ?? it.progress });
      const st = reading.state || it.state || 'unknown';
      const g = st === 'running' ? `<span class="g spin">${SPIN[0]}</span>` : `<span class="g">${MGLYPH[st]}</span>`;
      const waiting = commandPending(it) ? '<span class="tag">awaiting approval</span>' : '';
      const stale = isStale(it) ? '<span class="tag">◌ stale</span>' : '';
      const lbl = label != null && label !== '';
      const v = lbl ? label : fmtVal(value);
      const progress = reading.progress ?? it.progress;
      const hasP = progress !== null && progress !== undefined;
      let disp = it.display || 'auto';
      if (disp === 'auto') disp = autoDisplay(it);
      let body = '';
      const unit = readingUnit && !lbl ? `<span class="u">${esc(readingUnit)}</span>` : '';
      const rate = (disp === 'value' || disp === 'progress') && rateOf(it);
      const rateHTML = rate ? `<div class="rate">${esc(rate.text)}</div>` : '';
      if (disp === 'value') {
        body = `<div class="big ${String(v).length > 9 ? 'txt' : ''}">${esc(v) || '—'}${v ? unit : ''}</div><div class="spark">${spark(it.history, cols)}</div>${rateHTML}`;
      } else if (disp === 'progress') {
        const p = hasP ? progress : 0;
        body = `<div class="big">${Math.round(p)}<span class="u">%</span>${v ? `<span class="u">· ${esc(v)}${lbl ? '' : esc(it.unit || '')}</span>` : ''}</div><div class="bar">${bar(p, cols)}</div>${rateHTML}`;
      } else if (disp === 'text') {
        body = `<div class="big txt">${esc(v) || '—'}${v ? unit : ''}</div>`;
      } else if (disp === 'status') {
        body = `<div class="big">${esc(st.toUpperCase())}</div>`;
      } else if (disp === 'log') {
        const lines = Math.max(1, Math.floor((it.h - 60) / 17));
        body = `<div class="lg">${(it.log || []).slice(-lines).map((l) => `<div>${MGLYPH[l.s] || '·'} ${hhmmss(l.t)} ${esc(l.m)}</div>`).join('') || '<span class="faint">no messages</span>'}</div>`;
      } else if (disp === 'spark') {
        body = `<div class="spark big-spark">${spark(it.history, clamp(Math.floor((it.w - 20) / 9), cols, 400))}</div><div class="big txt">${esc(v) || '—'}${v ? unit : ''}</div>`;
      } else if (disp === 'custom') {
        const p = it.program || {};
        body = p.disabled
          ? `<div class="chart-empty faint">custom program disabled · ${esc(p.description || 'no description')}</div>`
          : `<div class="vwrap hud-program" data-program-item="${esc(it.id)}" data-program-revision="${esc(p.revision || '')}"><div class="chart-empty faint">program ${esc(p.revision || 'unknown')} · ${esc(p.description || 'no description')}</div></div>`;
      } else if (disp.startsWith('view:')) {
        // an agent-authored renderer module; hydrated after mount (see hydrateViews)
        body = `<div class="vwrap" data-viewmod="${esc(disp.slice(5))}"><div class="chart-empty faint">loading ${esc(disp.slice(5))}…</div></div>`;
      } else {
        const chart = renderChartView(disp, plotted, { reserve: 52 });
        body = chart ? `<div class="vwrap" data-chart="1">${chart}</div>` : '';
        if (!chart) {
          // unknown display kind — fall back to the big number so a card is never blank
          body = `<div class="big ${String(v).length > 9 ? 'txt' : ''}">${esc(v) || '—'}${v ? unit : ''}</div>`;
        }
      }
      const msg = disp !== 'log' && it.message ? `<div class="msg report-card">${reportPreview(it.message, it.messageFormat || 'plain', 4, it.id + '-message')}</div>` : '';
      const src = it.source || { kind: 'manual' };
      const srcLabel = ({ manual: 'manual', push: 'push', command: 'cmd', http: 'http', probe: `probe:${src.probe}`, heartbeat: 'heartbeat' }[src.kind] ?? String(src.kind)) + (src.interval && ['command', 'http', 'probe'].includes(src.kind) ? ` /${src.interval}s` : '');
      const bell = it.notify?.length ? `<span title="wakes ${esc(it.notify.join(', '))}">⌁</span>` : '';
      const yhint = disp !== 'auto' && DISPLAYS.includes(disp) && CHART_SET.has(disp) ? `<span class="yhint" title="alt+scroll to stretch the y-range (meters/axes are auto by default)">⇕</span>` : '';
      const metaFooter = monitorMetaFooter(it);
      const observedTime = it.observation?.observedAt ?? it.observation?.receivedAt ?? it.lastUpdate;
      return `<div class="hd">${g}<span class="t">${esc(it.title) || esc(it.id)}</span>${waiting}${stale}${bell}${yhint}<span class="r" title="observation ${esc(localDT(observedTime))}; received ${esc(localDT(it.observation?.receivedAt ?? it.lastUpdate))}">${ago(observedTime)}</span></div>
        <div class="bd">${body}${msg}</div>
        <div class="ft${metaFooter ? ' readout-footer' : ''}"${metaFooter ? ` title="${esc(monitorMetadata(it).definition)}"` : ''}>${by(it)}<span>${esc(srcLabel)}</span>${metaFooter}<span class="r">${esc(it.id)}</span></div>`;
    }
    case 'util': {
      const body = renderUtilCard(it);
      return `<div class="hd"><span class="g">⚙</span><span class="t">${esc(it.title) || UTIL_LABEL[it.kind] || 'utility'}</span><span class="tag">${esc(UTIL_LABEL[it.kind] || it.kind || '')}</span><span class="r"></span></div>
        <div class="bd">${body}</div>
        <div class="ft">${by(it)}<span class="r">${esc(it.id)}</span></div>`;
    }
    case 'note':
      return `${it.title ? `<div class="hd"><span class="t">${esc(it.title)}</span>` : '<div class="hd"><span class="t faint">note</span>'}<span class="r"></span></div><div class="bd md">${md(it.text)}</div>`;
    case 'frame': {
      const n = membersOf(it).filter(i => i.type !== 'ticket' && i.type !== 'project').length;
      return `<div class="flabel">${esc(it.title) || 'frame'}<span class="n">${n}</span></div>`;
    }
    case 'project': {
      const ts = [...S.items.values()].filter((t) => t.type === 'ticket' && t.project === it.id);
      const done = ts.filter((t) => t.status === 'done' || t.status === 'canceled').length;
      const meta = [it.lead && `@${esc(it.lead)}`, it.target && `→ ${esc(it.target)}`].filter(Boolean).join('  ');
      return `<div class="hd"><span class="g">◈</span><span class="t">${esc(it.key || '—')} ${esc(it.title) || '<span class="faint">untitled</span>'}</span><span class="r"></span></div>
        <div class="bd"><div class="big txt">${done}/${ts.length}<span class="u"> done</span></div><div class="bar">${bar(ts.length ? (done / ts.length) * 100 : 0, cols)}</div>${meta ? `<div class="msg">${meta}</div>` : ''}</div>
        <div class="ft">${by(it)}<span class="r">${esc(it.id)}</span></div>`;
    }
  }
  return '';
}

let pressedId = null; // card under the pointer: tickers must not rebuild it between mousedown and mouseup

/** `soft` = called from a ticker; skip a card the user is pressing so a click is not swallowed by a rebuild */
function renderItem(it, soft = false) {
  if (it.board !== S.board) return removeEl(it.id);
  if (it.type === 'ticket' || it.type === 'project' || (it.type === 'frame' && !canvasItems().some(i => i.id === it.id))) return removeEl(it.id);
  let el = els.get(it.id);
  if (!el) {
    el = document.createElement('div');
    el.dataset.id = it.id;
    world.appendChild(el);
    els.set(it.id, el);
  }
  if (soft && pressedId === it.id) return;
  try {
    const cls = ['item', it.type, ...stateClass(it)];
    if (it.type === 'monitor' && isStale(it)) cls.push('stale');
    if (S.sel.has(it.id)) cls.push('sel');
    if (el.classList.contains('drag')) cls.push('drag');
    if (el.classList.contains('flash')) cls.push('flash');
    const className = cls.join(' ');
    // Skip the rebuild when nothing that affects the card has changed (replacing innerHTML tears down chart
    // SVGs and hover state). The signature therefore has to cover everything the card shows.
    const sig = cardSignature(it, className);
    if (el.dataset.sig === sig) return;
    if (it.type === 'monitor' && it.display === 'custom' && !it.program?.disabled && el.querySelector('.hud-program[data-program-item]')) {
      const preview = document.createElement('div');
      preview.innerHTML = cardHTML(it) + '<div class="rz"></div>';
      const nextProgram = preview.querySelector('.hud-program[data-program-item]');
      const currentProgram = el.querySelector('.hud-program[data-program-item]');
      if (nextProgram && currentProgram && nextProgram.dataset.programRevision === currentProgram.dataset.programRevision) {
        el.dataset.sig = sig;
        el.className = className;
        el.style.left = it.x + 'px';
        el.style.top = it.y + 'px';
        el.style.width = it.w + 'px';
        el.style.height = it.h + 'px';
        const currentHead = el.querySelector('.hd'), nextHead = preview.querySelector('.hd');
        const currentFooter = el.querySelector('.ft'), nextFooter = preview.querySelector('.ft');
        if (currentHead && nextHead) currentHead.replaceWith(nextHead);
        if (currentFooter && nextFooter) currentFooter.replaceWith(nextFooter);
        const currentMessage = el.querySelector('.bd .msg'), nextMessage = preview.querySelector('.bd .msg');
        if (currentMessage && nextMessage) currentMessage.replaceWith(nextMessage);
        else if (currentMessage) currentMessage.remove();
        else if (nextMessage) el.querySelector('.bd')?.append(nextMessage);
        const currentMore = el.querySelector('.more'), nextMore = preview.querySelector('.more');
        if (currentMore && nextMore) currentMore.replaceWith(nextMore);
        else if (currentMore) currentMore.remove();
        else if (nextMore) el.querySelector('.rz')?.before(nextMore);
        applyReadonlyControls(el);
        return;
      }
    }
    el.dataset.sig = sig;
    el.className = className;
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.width = it.w + 'px';
    el.style.height = it.h + 'px';
    if (it.type === 'frame') el.style.zIndex = String(Math.max(1, 9 - Math.round(Math.log10(it.w * it.h) || 0)));
    const previousProgram = el.querySelector('.hud-program[data-program-item]');
    el.innerHTML = cardHTML(it) + '<div class="rz"></div>';
    const nextProgram = el.querySelector('.hud-program[data-program-item]');
    if (previousProgram && nextProgram && previousProgram.dataset.programRevision === nextProgram.dataset.programRevision) nextProgram.replaceWith(previousProgram);
    applyReadonlyControls(el);
    hydrateViews(el);
    queueProgramsMount();
  } catch (e) {
    // one malformed item must never take the page down: show it as an error card instead
    console.error('render failed', it?.id, e);
    el.dataset.sig = 'err|' + e.message;
    el.className = 'item render-error';
    el.style.left = (Number(it.x) || 0) + 'px';
    el.style.top = (Number(it.y) || 0) + 'px';
    el.style.width = (Number(it.w) || 260) + 'px';
    el.style.height = (Number(it.h) || 120) + 'px';
    el.innerHTML = `<div class="hd"><span class="g">✕</span><span class="t">render error</span><span class="r"></span></div><div class="bd faint">${esc(it.id)}: ${esc(e.message)}</div><div class="rz"></div>`;
    applyReadonlyControls(el);
  }
}

/** what a rendered card depends on; anything not in here must not change what the card looks like */
function cardSignature(it, className) {
  const now = Date.now();
  const parts = [
    className,
    it.x, it.y, it.w, it.h,
    it.updatedAt, it.lastUpdate,
    it.display, it.plot ? JSON.stringify(it.plot) : '',
    it.status, it.priority, it.assignee, it.state, it.label, it.value, it.progress, it.message, it.unit,
    it.metric ? JSON.stringify(it.metric) : '', it.observation ? JSON.stringify(it.observation) : '',
    it.freshness ? JSON.stringify(it.freshness) : '', it.readout ? JSON.stringify(it.readout) : '',
    it.pipelineView ? JSON.stringify(it.pipelineView) : '', it.program ? JSON.stringify(programSummary(it.program)) : '',
    it.title, it.num, it.kind, it.util ? JSON.stringify(it.util) : '', it.text, it.body, it.key, it.lead, it.target,
    it.messageFormat, it.details,
    it.commandApproval ? `${it.commandApproval.status}:${it.commandApproval.fingerprint || ''}` : '',
    (it.comments || []).length, (it.tags || []).length, (it.monitors || []).join(','),
    (it.options || []).length, it.decision ? it.decision.optionId : '',
    (it.history || []).length, (it.log || []).length,
  ];
  // time-dependent text: only rebuild when the rendered label would actually change
  if (it.type === 'util') parts.push(isLive(it, now) ? renderUtilCard(it, now) : '');
  else if (isAnimated(it)) parts.push(Math.floor(now / 100));
  if (it.type === 'monitor') {
    parts.push(ago(it.lastUpdate), ageLabel(readingAgeSeconds(it)), JSON.stringify(activeBoard()?.annotations || []));
    for (const ref of it.plot?.metrics || []) {
      const linked = S.items.get(String(ref)) || [...S.items.values()].find((candidate) => candidate.board === it.board && candidate.type === 'monitor' && (candidate.metric?.key === String(ref) || candidate.metric?.sourceId === String(ref)));
      const last = linked?.history?.at(-1);
      parts.push(linked ? [linked.id, linked.metric?.unit || linked.unit || '', linked.history?.length || 0, last?.t || 0, last?.v ?? ''].join('~') : `missing:${ref}`);
    }
  }
  if (it.type === 'ticket') parts.push(ago(it.updatedAt));
  // values drawn from other items: frame counts, '+N sub', idents, linked monitors, project rollups
  if (it.type === 'frame') parts.push(membersOf(it).length);
  if (it.type === 'ticket') {
    const claim = S.claims.get(it.id);
    parts.push(claim ? `${claim.actor}|${claim.session}|${claim.expiresAt}` : (S.claimsReady ? 'unclaimed' : 'pending'));
    parts.push(kidsOf(it.id).length, identOf(it), it.parent && nameOf(it.parent), (it.blockedBy || []).map(nameOf).join(','), (it.refs || []).map(nameOf).join(','));
    for (const id of it.monitors || []) {
      const m = S.items.get(id);
      parts.push(m ? [m.state, m.value, m.label, m.progress, m.title, m.unit].join('~') : '?');
    }
  }
  if (it.type === 'project') for (const t of S.items.values()) if (t.type === 'ticket' && t.project === it.id) parts.push(t.status);
  return parts.join('|');
}

/** dependents (frames, tickets, projects) re-check their signature when any item changes */
function refreshDerived() {
  for (const it of boardItems()) if (it.type === 'frame' || it.type === 'ticket' || it.type === 'project') renderItem(it);
}

// ---------------------------------------------------------------- agent-authored renderer modules

const viewMods = new Map(); // name -> { p: Promise<module|{__error}>, at, tries }

/** failures are retried (with a cache-busting URL: browsers cache a failed module fetch) after a short back-off */
function loadViewMod(name) {
  const cur = viewMods.get(name);
  if (cur && !(cur.failed && Date.now() - cur.at > 3000)) return cur.p;
  const tries = (cur?.tries ?? 0) + (cur ? 1 : 0);
  const entry = { at: Date.now(), tries, failed: false };
  entry.p = (async () => {
    if (cur) S.views = await fetch('/api/views').then((r) => r.json()).then((v) => v.views ?? []).catch(() => S.views);
    const stamp = S.views.find((v) => v.name === `${name}.js`)?.mtime ?? 0;
    try {
      return await import(`/views/${encodeURIComponent(name)}.js?v=${stamp}${tries ? '&r=' + tries : ''}`);
    } catch (e) {
      entry.failed = true;
      return { __error: e };
    }
  })();
  viewMods.set(name, entry);
  return entry.p;
}

/**
 * Fill in `display: "view:<name>"` card bodies. Modules execute in this page, so a failure is shown
 * inside the card rather than thrown — one bad renderer must not take the canvas down.
 */
function hydrateViews(el) {
  const hosts = $$('[data-viewmod]', el);
  if (!hosts.length) return;
  const it = S.items.get(el.dataset.id);
  for (const host of hosts) {
    const name = host.dataset.viewmod;
    loadViewMod(name).then((mod) => {
      if (!host.isConnected) return;
      const render = mod.render ?? mod.default;
      if (mod.__error || typeof render !== 'function') {
        host.innerHTML = `<div class="chart-empty faint">view "${esc(name)}" ${mod.__error ? `could not load: ${esc(mod.__error.message)}` : 'has no render() or default export'}</div>`;
        return;
      }
      const collected = [];
      try {
        const out = render({
          item: it,
          w: Math.max(70, it.w - 20),
          h: Math.max(40, it.h - 70),
          helpers,
          hit: (px, py, value, label) => collected.push({ px, py, value, label }),
        });
        host.innerHTML = typeof out === 'string' ? out : '';
        if (out instanceof Node) host.appendChild(out);
        setHits(it.id, collected);
      } catch (e) {
        host.innerHTML = `<div class="chart-empty faint">view "${esc(name)}": ${esc(e.message)}</div>`;
      }
    });
  }
}

let programsPromise;
let mountedProgramRoot = null;
let mountedProgramSignature = '';
let programMountQueued = false;
let programMountFrame = 0;
let programMountGeneration = 0;
const programNodeIds = new WeakMap();
let nextProgramNodeId = 1;
function activeBoard() { return S.boards.find((b) => b.id === S.board) || null; }
function programSummary(program) {
  if (!program) return undefined;
  return { revision: program.revision, description: program.description, disabled: !!program.disabled, bindings: programBindings(program) };
}
function boardProgramActive() {
  const program = activeBoard()?.program;
  return S.page === 'board' && S.mode === 'canvas' && !!program && !program.disabled;
}
function ensureBoardProgramHost() {
  let host = $('#board-program-root');
  if (!boardProgramActive()) {
    host?.remove();
    world.classList.remove('has-board-program');
    return null;
  }
  const board = activeBoard();
  if (!host) {
    host = document.createElement('div');
    host.id = 'board-program-root';
    host.className = 'board-program-root';
    world.prepend(host);
  }
  const revision = board.program.revision || 'unknown';
  const changed = host.dataset.programBoard !== board.id || host.dataset.programRevision !== revision;
  host.dataset.programBoard = board.id;
  host.dataset.programRevision = revision;
  if (changed) host.innerHTML = `<div class="hud-program" data-program-board="${esc(board.id)}" data-program-revision="${esc(revision)}" role="region" aria-label="${esc(board.name)} custom dashboard"><div class="program-loading">program ${esc(revision)} · ${esc(board.program.description || 'no description')}</div></div>`;
  world.classList.add('has-board-program');
  return host;
}
function programRenderRoot() {
  return $('#board-program-root') || world;
}
function programInputSignature(root) {
  const board = activeBoard();
  const nodes = [...(root?.querySelectorAll('.hud-program') || [])];
  const hosts = nodes.map((node) => {
    if (!programNodeIds.has(node)) programNodeIds.set(node, nextProgramNodeId++);
    return [programNodeIds.get(node), node.dataset.programItem || '', node.dataset.programBoard || '', node.dataset.programRevision || ''];
  });
  const items = boardItems().filter((it) => it.display === 'custom' && it.program && !it.program.disabled).map((it) => [it.id, it.program.revision || '', !!it.program.disabled]);
  return JSON.stringify({ board: board?.id, boardProgram: board?.program ? [board.program.revision || '', !!board.program.disabled] : null, items, hosts, readonly: CAPTURE_READONLY });
}
async function getProgramsModule() {
  if (!programsPromise) programsPromise = import('./programs.js').catch((error) => ({ __error: error }));
  return programsPromise;
}
async function mountProgramsNow(force = false) {
  if (programMountQueued) {
    cancelAnimationFrame(programMountFrame);
    programMountQueued = false;
  }
  const root = programRenderRoot();
  const hosts = root ? root.querySelectorAll('.hud-program').length : 0;
  if (!root || !hosts) {
    if (mountedProgramRoot) {
      const old = mountedProgramRoot;
      mountedProgramRoot = null;
      mountedProgramSignature = '';
      const mod = await getProgramsModule();
      try { await mod.disposePrograms?.(old); } catch (error) { S.captureErrors.push(String(error?.message || error)); }
    }
    return { errors: [] };
  }
  const signature = programInputSignature(root);
  if (!force && mountedProgramRoot === root && mountedProgramSignature === signature) return { errors: [] };
  const generation = ++programMountGeneration;
  const mod = await getProgramsModule();
  const errors = [];
  if (mountedProgramRoot) {
    try { await mod.disposePrograms?.(mountedProgramRoot); } catch (error) { errors.push(String(error?.message || error)); }
  }
  mountedProgramRoot = root;
  mountedProgramSignature = signature;
  if (mod.__error || typeof mod.mountPrograms !== 'function') {
    const message = mod.__error?.message || 'program renderer has no mountPrograms()';
    errors.push(message);
    root.querySelectorAll('.hud-program').forEach((host) => {
      host.innerHTML = `<div class="chart-empty faint">program unavailable: ${esc(message)}</div>`;
    });
  } else {
    try {
      const report = await mod.mountPrograms(root, {
        board: { ...activeBoard(), program: programSummary(activeBoard()?.program) },
        items: boardItems().map((item) => ({ ...item, program: programSummary(item.program) })), readonly: CAPTURE_READONLY,
        ...(CAPTURE_TOKEN ? { captureToken: CAPTURE_TOKEN } : {}),
      });
      if (Array.isArray(report?.errors)) errors.push(...report.errors.map(String));
    } catch (error) {
      errors.push(String(error?.message || error));
      root.querySelectorAll('.hud-program').forEach((host) => {
        host.innerHTML = `<div class="chart-empty faint">program failed: ${esc(error?.message || error)}</div>`;
      });
    }
  }
  if (generation === programMountGeneration && CAPTURE_READONLY) S.captureErrors.push(...errors);
  return { errors };
}
function queueProgramsMount() {
  if (programMountQueued) return;
  programMountQueued = true;
  programMountFrame = requestAnimationFrame(() => {
    programMountQueued = false;
    mountProgramsNow().catch((error) => {
      console.error('program mount failed', error);
      if (CAPTURE_READONLY) S.captureErrors.push(String(error?.message || error));
    });
  });
}

function removeEl(id) {
  els.get(id)?.remove();
  els.delete(id);
  dropHits(id);
}

function renderAll() {
  ensureBoardProgramHost();
  for (const [id, el] of els) if (S.items.get(id)?.board !== S.board) removeEl(id);
  for (const it of boardItems()) renderItem(it);
  refreshDerived();
  updateChrome();
  queueProgramsMount();
  applyReadonlyControls();
}

const renderFrames = refreshDerived;

function updateChrome() {
  document.body.classList.toggle('blank', canvasItems().length === 0 && !boardProgramActive());
  renderBoardButtons();
  renderViewToggle();
  renderNeeds();
  renderProgramInspector();
  if (S.mode === 'list') scheduleList();
}



function programBindings(program) {
  return Array.isArray(program?.bindings) ? program.bindings : [];
}
function renderProgramInspector() {
  const host = $('#program-inspector');
  if (!host || host.hidden) return;
  const board = activeBoard();
  const sources = boardItems().filter((it) => it.type === 'monitor');
  const boardProgram = board?.program;
  const programSection = (owner, program) => {
    if (!program) return '';
    const bindings = programBindings(program);
    const rows = bindings.map((id) => {
      const bound = S.items.get(id);
      return `<div class="meta">${bound ? '●' : '○'} ${esc(id)}${bound ? ` · ${esc(bound.title || bound.id)} · ${esc(monitorMetadata(bound).source)}` : ' · missing'}</div>`;
    }).join('') || '<div class="meta">no declared bindings</div>';
    return `<section class="source-item"><div><b>${esc(owner)}</b> · ${esc(program.revision || 'unknown')}${program.disabled ? ' · disabled' : ''}</div><div class="meta">${esc(program.description || '')}</div><div class="meta">bindings</div>${rows}</section>`;
  };
  const itemsHTML = sources.map((it) => {
    const meta = monitorMetadata(it);
    return `<section class="source-item"><button data-source-open="${esc(it.id)}">${esc(it.title || it.id)}</button><div class="meta">${esc(it.metric?.key || it.id)} · ${esc(meta.source)} · ${esc(meta.evidence)} · ${esc(meta.age)}${it.metric?.unit || it.unit ? ` · ${esc(it.metric?.unit || it.unit)}` : ''}</div><div class="meta">${esc(it.metric?.definition || meta.definition)}</div>${it.freshness?.mode === 'static' ? `<div class="meta">static · ${esc(it.freshness.reason || '')}</div>` : ''}</section>`;
  }).join('');
  const html = `<div class="phd"><b>source inspector</b><span class="sp"></span><button data-source-close aria-label="close source inspector">×</button></div><div class="sec"><div class="meta">${esc(board?.name || S.board || '')}</div>${boardProgram ? `<div class="meta">board program ${esc(boardProgram.revision || '')} · ${esc(boardProgram.description || '')}</div>` : ''}</div>${programSection('board program', boardProgram)}${sources.map((it) => programSection(it.title || it.id, it.program)).join('')}${itemsHTML || '<div class="sec faint">no monitor sources on this board</div>'}`;
  if (host.dataset.sig !== html) { host.dataset.sig = html; host.innerHTML = html; }
  applyReadonlyControls(host);
}

function flash(id) {
  const el = els.get(id);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 950);
}

// ---------------------------------------------------------------- hover readout

/**
 * Charts register their points as they draw (views.js), so the card can name the exact value under the
 * cursor. Geometry is in viewBox units, so it is scaled to whatever the card is currently rendered at.
 */
const hoverEl = document.createElement('div');
hoverEl.id = 'hover';
hoverEl.hidden = true;
document.body.appendChild(hoverEl);

function hideHover() {
  hoverEl.hidden = true;
}

function updateHover(e) {
  if (drag) return hideHover();
  const itemEl = e.target?.closest?.('.item');
  if (!itemEl) return hideHover();
  const it = S.items.get(itemEl.dataset.id);
  if (!it) return hideHover();
  const model = hitsOf(it.id);
  if (!model?.hits?.length) return hideHover();
  const wrap = itemEl.querySelector('.vwrap');
  if (!wrap) return hideHover();
  const svgEl = wrap.querySelector('svg');
  const box = (svgEl ?? wrap).getBoundingClientRect();
  const vb = svgEl?.viewBox?.baseVal;
  const sx = vb && vb.width ? box.width / vb.width : 1;
  const sy = vb && vb.height ? box.height / vb.height : 1;
  const px = e.clientX - box.left;
  const py = e.clientY - box.top;
  let best = null;
  let bd = 24 * 24;
  for (const h of model.hits) {
    const dx = h.px * sx - px;
    const dy = h.py * sy - py;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = h;
    }
  }
  if (!best) return hideHover();
  const label = best.label ? `${esc(best.label)}: ` : '';
  const pct = best.pct != null ? ` (${best.pct.toFixed(1)}%)` : '';
  const when = best.t ? ` · ${hhmmss(best.t)}` : '';
  hoverEl.innerHTML = `${label}<b>${esc(fmtVal(best.value))}</b>${esc(it.unit || '')}${pct}${when}`;
  hoverEl.hidden = false;
  const pad = 14;
  const r = hoverEl.getBoundingClientRect();
  hoverEl.style.left = `${Math.min(e.clientX + pad, innerWidth - r.width - 8)}px`;
  hoverEl.style.top = `${Math.max(8, e.clientY - r.height - pad)}px`;
}

function select(ids, add = false) {
  if (!add) S.sel.clear();
  for (const id of ids) S.sel.add(id);
  for (const [id, el] of els) el.classList.toggle('sel', S.sel.has(id));
}


// ---------------------------------------------------------------- rail / boards

function switchBoard(id, opts = {}) {
  if (!id || !S.boards.some((b) => b.id === id)) return toast(`no workspace ${id}`);
  S.board = id;
  S.sel.clear();
  if (!CAPTURE_READONLY) try { localStorage.setItem('hud.board', id); } catch {}
  if (opts.hash !== false) setNavHash('board', id);
  // Close first, without refitting, so the saved camera is judged against the full window.
  // A later z-matching refit would replace a kept pan with the centered letterbox.
  dismissDrawer();
  S.view = loadView();
  if (!S.viewPending) applyView();
  let mode;
  try { mode = localStorage.getItem('hud.mode.' + id); } catch {}
  const hasCanvas = canvasItems().some((i) => i.type !== 'frame');
  const hasTickets = boardItems().some((i) => i.type === 'ticket' || i.type === 'project');
  // a workspace with tickets opens on Tasks unless the person chose Monitors there
  setMode(mode === 'canvas' && !hasCanvas && hasTickets ? 'list' : (mode || (hasTickets ? 'list' : 'canvas')));
  renderAll();
  renderActivity();
  renderTrash();
  if (opts.page !== false) setPage(opts.page || 'board', { hash: false });
  if (!CAPTURE_READONLY) loadReadout(id);
  loadClaims();
}



function upsertBoard(b) {
  const i = S.boards.findIndex((x) => x.id === b.id);
  if (i >= 0) S.boards[i] = b;
  else S.boards.push(b);
  renderBoardButtons();
  if (b.id === S.board) { renderProgramInspector(); queueProgramsMount(); }
  if (!$('#board-menu').hidden && document.activeElement?.dataset?.boardQuery === undefined) renderBoardMenu();
}

// ---------------------------------------------------------------- supervision: attention, runs, global navigation
const localKey = (k) => `hud.${k}`;
function rememberBoard(id) {
  if (CAPTURE_READONLY) return;
  if (!id) return;
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem(localKey('recent-boards')) || '[]') || []; } catch {}
  ids = [id, ...ids.filter((x) => x !== id)].slice(0, 8);
  try { localStorage.setItem(localKey('recent-boards'), JSON.stringify(ids)); } catch {}
}
/** The workspace is the only page. An old #attention link opens "needs you" over it; #runs lands here. */
function setPage(page, opts = {}) {
  S.page = 'board';
  if (opts.hash !== false) setNavHash('board', S.board);
  renderAll();
  if (S.mode === 'list') renderList();
  else requestAnimationFrame(() => settleCamera());
  if (!CAPTURE_READONLY) loadQueue();
  updateChrome();
  if (page === 'attention') toggleNeeds(true);
}
function activeAttention(now = Date.now()) {
  return (S.attention.items || []).filter((a) => !a.snoozedUntil || Number(a.snoozedUntil) <= now);
}
async function loadAttention() {
  if (CAPTURE_READONLY) return;
  const data = await optionalGET('/api/attention');
  if (!data) return;
  S.attention = { items: Array.isArray(data.items) ? data.items : [], now: data.now || Date.now() };
  renderNeeds();
  if (!$('#board-menu').hidden) renderBoardMenu();
}
async function approveDrawerCommand(it) {
  let record = (S.attention.items || []).find((a) => (a.itemId || a.id) === it.id && a.kind === 'command');
  if (!record) {
    await loadAttention();
    record = (S.attention.items || []).find((a) => (a.itemId || a.id) === it.id && a.kind === 'command');
  }
  if (!record) return toast('this command is not waiting for approval', 5000);
  try {
    await api('POST', `/api/monitors/${encodeURIComponent(it.id)}/approve`, { revision: record.revision });
    toast('approved ' + it.id);
  } catch (e) {
    toast(e.status === 409 ? 'this command changed; refresh "needs you"' : e.message, 5000);
    if (e.status === 409) await loadAttention();
  }
}
function runStatus(run) { return String(run.status || 'unknown').toLowerCase(); }
function runDone(run) { return ['done', 'completed', 'canceled', 'cancelled'].includes(runStatus(run)); }
function boardName(id) { return S.boards.find((b) => b.id === id)?.name || id || ''; }
async function loadRuns() {
  if (CAPTURE_READONLY) return;
  const data = await optionalGET('/api/runs');
  if (!data) return;
  S.runs.items = Array.isArray(data.items) ? data.items : [];
  if (S.drawer && runForItem(S.drawer)) renderDrawer();
}

// ---------------------------------------------------------------- presence + queue
async function loadSessions() {
  if (CAPTURE_READONLY) return;
  const data = await optionalGET('/api/sessions');
  if (!data) return;
  S.sessions = { items: Array.isArray(data.items) ? data.items : [], now: data.now || Date.now() };
  renderSessions();
}
function renderSessions() {
  const live = S.sessions.items.filter((s) => s.live);
  const btn = $('#btn-sessions');
  if (btn) btn.textContent = `agents · ${live.length} live`;
  const pop = $('#sessions');
  if (!pop) return;
  if (!S.sessionsOpen) { pop.hidden = true; return; }
  pop.hidden = false;
  const rows = S.sessions.items.map((s) => `<div class="session-row"><span>${s.live ? '●' : '○'}</span><span class="id">${esc(s.id)}</span><span class="dim">${esc(s.kind)} · ${s.live ? `${ago(s.lastSeenAt)} ago` : 'ended'}${(s.claims || []).length ? ` · ${s.claims.map((c) => esc(c.ident)).join(', ')}` : ''}</span></div>`).join('');
  pop.innerHTML = `<div class="phd"><span>agents</span><span class="sp"></span><button data-sessions-close aria-label="close">×</button></div>${rows || '<div class="sup-empty">No sessions. MCP clients register on connect.</div>'}`;
}
async function heartbeatSelf() {
  try { await api('POST', '/api/sessions/user/heartbeat'); } catch {}
}
let queueGen = 0;
async function loadQueue() {
  if (CAPTURE_READONLY || !S.board) return;
  const board = S.board;
  const gen = ++queueGen;
  const data = await optionalGET(`/api/queue?board=${encodeURIComponent(board)}`);
  if (gen !== queueGen || S.board !== board || !data) return;
  S.queue = data;
}
async function claimTicket(id) {
  try {
    await api('POST', `/api/items/${encodeURIComponent(id)}/claim`, { session: 'user', ttl: 300, start: true });
    toast('claimed');
  } catch (e) { toast(e.message || 'claim failed'); }
  await loadQueue();
  await loadSessions();
}
async function releaseTicket(id) {
  try {
    await api('DELETE', `/api/items/${encodeURIComponent(id)}/claim?session=user`);
    toast('released');
  } catch (e) { toast(e.message || 'release failed'); }
  await loadQueue();
  await loadSessions();
}
const refreshAttentionLater = debounce(() => loadAttention(), 350);
const refreshRunsLater = debounce(() => { if (S.page === 'runs' || (S.drawer && runForItem(S.drawer))) loadRuns(); }, 350);
const refreshQueueLater = debounce(() => loadQueue(), 350);
function boardCounts() {
  const out = {};
  for (const it of S.items.values()) out[it.board] = (out[it.board] || 0) + 1;
  return out;
}
function renderBoardMenu() {
  const menu = $('#board-menu');
  const counts = boardCounts();
  const current = S.boards.find((b) => b.id === S.board);
  const currentId = current?.id || '';
  const currentName = current?.name || currentId || 'current board';
  const currentCount = counts[currentId] || 0;
  const mainBoard = currentId === 'main';
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem(localKey('recent-boards')) || '[]') || []; } catch {}
  const order = [...new Set([...recent, ...S.boards.map((b) => b.id)])];
  const q = String(S.boardQuery || '').trim().toLowerCase();
  const attCounts = {};
  for (const a of needsYou()) attCounts[a.board] = (attCounts[a.board] || 0) + 1;
  const rows = order.map((id) => S.boards.find((b) => b.id === id)).filter(Boolean).filter((b) => !q || `${b.name} ${b.id}`.toLowerCase().includes(q)).map((b) => `<div class="board-row ${b.id === S.board ? 'on' : ''}" data-board-pick="${esc(b.id)}"><span class="name">${esc(b.name)}</span><span class="count">${attCounts[b.id] ? `<span class="needs-n" title="${attCounts[b.id]} need you">● ${attCounts[b.id]}</span> ` : ''}${counts[b.id] || 0}</span></div>`).join('');
  menu.innerHTML = `<input class="board-search" data-board-query placeholder="search workspaces" value="${esc(S.boardQuery)}"><div>${rows || '<div class="faint">no matching workspaces</div>'}</div><div class="board-actions"><button class="btn sm" data-board-add>＋ workspace</button><button class="btn sm" data-board-rename>rename</button></div><section class="board-maintenance" aria-label="this workspace"><div class="board-maintenance-title">this workspace · ${esc(currentName)} · ${currentCount} item${currentCount === 1 ? '' : 's'}</div><div class="board-maintenance-action"><button class="btn sm danger" data-board-clear aria-describedby="board-clear-help" title="Move every item in this workspace to Trash">clear</button><div class="board-maintenance-help" id="board-clear-help">Moves every task and monitor to Trash; keeps the workspace and its settings.</div></div><div class="board-maintenance-action"><button class="btn sm danger" data-board-delete aria-describedby="board-delete-help" title="Delete this workspace; its items move to Trash" ${mainBoard ? 'disabled aria-disabled="true"' : ''}>delete</button><div class="board-maintenance-help" id="board-delete-help">Removes the workspace; its items move to Trash.${mainBoard ? ' The main workspace cannot be deleted.' : ''}</div></div></section>`;
  applyReadonlyControls(menu);
}
function toggleBoardMenu(on) {
  const menu = $('#board-menu');
  on = on ?? menu.hidden;
  menu.hidden = !on;
  $('#btn-board').setAttribute('aria-expanded', String(on));
  if (on) { S.boardQuery = ''; renderBoardMenu(); menu.querySelector('[data-board-query]')?.focus(); }
}
// ---------------------------------------------------------------- top bar: view toggle, needs you, more
/** Tasks / Monitors with their counts; the toggle is the one way between the two views (l also works) */
function renderViewToggle() {
  const tickets = boardItems().filter((i) => i.type === 'ticket').length;
  const monitors = canvasItems().filter((i) => i.type !== 'frame').length;
  for (const b of $$('#view-toggle [data-view]')) {
    const on = b.dataset.view === S.mode;
    b.setAttribute('aria-selected', String(on));
    b.classList.toggle('on', on);
    const n = b.querySelector('.n');
    if (n) n.textContent = String(b.dataset.view === 'list' ? tickets : monitors);
  }
}
const NEEDS = {
  decision: { glyph: '?', word: 'question', act: 'answer' },
  command: { glyph: '▸', word: 'approve command', act: 'review' },
  error: { glyph: '✕', word: 'monitor error', act: 'open' },
  blocked: { glyph: '▲', word: 'stuck', act: 'open' },
};
/** what waits on the person: a question, a command to approve, a monitor in error, or a ticket an agent marked
 * blocked with nothing to wait on. A ticket waiting on another ticket is the agents' business. */
function needsYou() {
  return activeAttention().filter((a) => {
    if (!NEEDS[a.kind]) return false;
    if (a.kind !== 'blocked') return true;
    const it = S.items.get(a.itemId);
    if (!it || it.autoBlocked) return false;
    return !(it.blockedBy || []).some((b) => { const x = S.items.get(b); return x && x.status !== 'done' && x.status !== 'canceled'; });
  });
}
function renderNeeds() {
  const list = needsYou();
  const btn = $('#btn-attention');
  if (!btn) return;
  $('#attention-count').textContent = String(list.length);
  btn.classList.toggle('has', list.length > 0);
  btn.title = list.length ? `${list.length} waiting on you (A)` : 'nothing is waiting on you (A)';
  const pop = $('#needs');
  if (pop.hidden) return;
  const rows = list.map((a) => {
    const it = S.items.get(a.itemId);
    const n = NEEDS[a.kind];
    const title = it ? (it.title || it.id) : (a.title || a.itemId);
    const where = [S.boards.find((b) => b.id === (it?.board || a.board))?.name, it?.type === 'ticket' ? identOf(it) : ''].filter(Boolean).join(' · ');
    return `<div class="needs-row" data-needs-open="${esc(a.itemId)}" tabindex="0"><span class="g">${n.glyph}</span><span class="needs-text"><span class="kind">${esc(n.word)}</span><span class="ttl">${esc(title)}</span><span class="ws">${esc(where)}</span></span><button class="btn sm" data-needs-open="${esc(a.itemId)}">${n.act}</button></div>`;
  }).join('');
  const html = `<div class="needs-head">${list.length ? `${list.length} waiting on you` : 'Nothing needs you.'}</div>${rows}`;
  if (pop.dataset.sig !== html) { pop.dataset.sig = html; pop.innerHTML = html; applyReadonlyControls(pop); }
}
function closeMenus(except) {
  if (except !== 'needs' && !$('#needs').hidden) toggleNeeds(false);
  if (except !== 'more' && !$('#more-menu').hidden) toggleMore(false);
  if (except !== 'board' && !$('#board-menu').hidden) toggleBoardMenu(false);
}
function toggleNeeds(on) {
  const pop = $('#needs');
  on = on ?? pop.hidden;
  if (on) closeMenus('needs');
  pop.hidden = !on;
  $('#btn-attention').setAttribute('aria-expanded', String(on));
  if (on) { pop.dataset.sig = ''; renderNeeds(); if (!CAPTURE_READONLY) loadAttention(); }
}
function toggleMore(on) {
  const menu = $('#more-menu');
  on = on ?? menu.hidden;
  if (on) closeMenus('more');
  menu.hidden = !on;
  $('#btn-more').setAttribute('aria-expanded', String(on));
}
$('#view-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setMode(b.dataset.view);
});
$('#needs').addEventListener('click', (e) => {
  const row = e.target.closest('[data-needs-open]');
  if (!row) return;
  toggleNeeds(false);
  openItemDeepLink(row.dataset.needsOpen);
});
$('#needs').addEventListener('keydown', (e) => {
  const row = e.target.closest('.needs-row');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleNeeds(false); openItemDeepLink(row.dataset.needsOpen); }
});
$('#btn-more').addEventListener('click', () => toggleMore());
// a pick from the menu runs its own handler first, then the menu closes
$('#more-menu').addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(() => toggleMore(false), 0); });
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest?.('#board-switcher, #needs-wrap, #more-wrap')) closeMenus();
});
function openSearch() {
  S.searchOpen = true;
  $('#global-search').hidden = false;
  $('#global-search-input').value = S.searchQuery;
  renderSearch();
  $('#global-search-input').focus();
  $('#global-search-input').select();
}
function closeSearch() {
  S.searchOpen = false;
  $('#global-search').hidden = true;
}
function searchResults(q) {
  const words = String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return [...S.items.values()].filter((it) => {
    const hay = [it.id, it.uuid, it.title, it.body, it.text, it.key, it.type === 'ticket' ? identOf(it) : '', it.board, ...(it.tags || [])].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 80);
}
function renderSearch() {
  const host = $('#global-search-results');
  const q = S.searchQuery;
  const found = searchResults(q);
  host.innerHTML = q.trim() ? (found.length ? `<div class="search-section">items</div>${found.map((it) => `<div class="search-result" data-search-open="${esc(it.id)}"><span class="sr-kind">${esc(it.type)}</span><span class="sr-title">${esc(it.title || it.text?.slice(0, 100) || it.id)}</span><span class="sr-board">${esc(S.boards.find((b) => b.id === it.board)?.name || it.board || '')}<br><span class="sr-id">${esc(it.type === 'ticket' ? identOf(it) : it.id)}</span></span></div>`).join('')}` : '<div class="sup-empty">No matching items.</div>') : '<div class="sup-empty">Search titles, ids, UUIDs, ticket idents, bodies and notes.</div>';
}
function openItemDeepLink(id) {
  const it = itemFor(id) || ticketBy(id);
  if (!it) return toast(`no item ${id}`);
  id = it.id;
  rememberBoard(it.board);
  switchBoard(it.board, { page: 'board' });
  setNavHash('item', id);
  if (it.type === 'ticket' || it.type === 'project') setMode('list');
  else if (it.type === 'monitor') setMode('canvas');
  openDrawer(id);
}

$('#btn-attention').addEventListener('click', () => toggleNeeds());
$('#btn-sessions').addEventListener('click', () => { S.sessionsOpen = !S.sessionsOpen; renderSessions(); if (S.sessionsOpen) loadSessions(); });
$('#sessions').addEventListener('click', (e) => { if (e.target.closest('[data-sessions-close]')) { S.sessionsOpen = false; renderSessions(); } });
$('#btn-board').addEventListener('click', () => toggleBoardMenu());
$('#btn-source').addEventListener('click', () => {
  const panel = $('#program-inspector');
  panel.hidden = !panel.hidden;
  $('#btn-source').classList.toggle('on', !panel.hidden);
  if (!panel.hidden) renderProgramInspector();
});
$('#program-inspector').addEventListener('click', (e) => {
  if (e.target.closest('[data-source-close]')) {
    $('#program-inspector').hidden = true;
    $('#btn-source').classList.remove('on');
  }
  const source = e.target.closest('[data-source-open]');
  if (source) openDrawer(source.dataset.sourceOpen);
});
// Record a fold on the click, before its toggle: a re-render queued by a live update can replace the drawer
// first, and the toggle would then fire on the detached copy.
$('#drawer').addEventListener('click', (e) => {
  const fold = e.target.closest?.('details[data-fold] > summary')?.parentElement;
  if (fold) !fold.open ? S.drawerFolds.add(fold.dataset.fold) : S.drawerFolds.delete(fold.dataset.fold);
}, true);
$('#toast').addEventListener('click', (e) => {
  const link = e.target.closest('[data-created-board-link]');
  if (link) { e.preventDefault(); openItemDeepLink(link.dataset.createdBoardLink); }
});
$('#btn-search').addEventListener('click', () => openSearch());
$('#global-search').addEventListener('click', (e) => {
  if (e.target.closest('[data-search-close]')) return closeSearch();
  const open = e.target.closest('[data-search-open]');
  if (open) { closeSearch(); openItemDeepLink(open.dataset.searchOpen); }
});
$('#global-search-input').addEventListener('input', (e) => { S.searchQuery = e.target.value; renderSearch(); });
$('#board-menu').addEventListener('input', (e) => {
  if (e.target.dataset.boardQuery !== undefined) {
    S.boardQuery = e.target.value;
    const q = S.boardQuery.toLowerCase();
    $$('.board-row', $('#board-menu')).forEach((r) => { r.hidden = !r.textContent.toLowerCase().includes(q); });
  }
});
$('#board-menu').addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-board-pick]');
  if (pick) { toggleBoardMenu(false); rememberBoard(pick.dataset.boardPick); return switchBoard(pick.dataset.boardPick); }
  if (e.target.closest('[data-board-add]')) {
    const name = prompt('new workspace name');
    if (!name?.trim()) return;
    const b = await api('POST', '/api/boards', { name: name.trim() });
    upsertBoard(b); rememberBoard(b.id); toggleBoardMenu(false); return switchBoard(b.id);
  }
  if (e.target.closest('[data-board-rename]')) {
    const b = S.boards.find((x) => x.id === S.board);
    const name = prompt('rename workspace', b?.name || '');
    if (!name?.trim() || !b) return;
    await api('PATCH', `/api/boards/${encodeURIComponent(b.id)}`, { name: name.trim() });
    toggleBoardMenu(false);
  }
  if (e.target.closest('[data-board-clear]')) {
    const board = S.boards.find((x) => x.id === S.board);
    if (!board) return;
    const boardItemsBefore = boardItems();
    const boardItemIds = new Set(boardItemsBefore.map((item) => item.id));
    const count = boardItemsBefore.length;
    const confirmed = confirm(`Clear workspace "${board.name}"? ${count} item${count === 1 ? '' : 's'} will move to Trash. The workspace and its settings stay.`);
    if (!confirmed) return;
    toggleBoardMenu(false);
    try {
      const result = await api('POST', `/api/boards/${encodeURIComponent(board.id)}/clear`, {});
      for (const id of boardItemIds) { S.sel.delete(id); S.detail.delete(id); }
      if (S.drawer && boardItemIds.has(S.drawer)) closeDrawer();
      toast(`cleared workspace "${board.name}" · ${Number(result?.cleared ?? count)} item${Number(result?.cleared ?? count) === 1 ? '' : 's'} moved to Trash`, 5000);
    } catch (error) { toast(error.message, 5000); }
    return;
  }
  if (e.target.closest('[data-board-delete]')) {
    const board = S.boards.find((x) => x.id === S.board);
    if (!board) return;
    if (board.id === 'main') return toast('the main workspace cannot be deleted', 5000);
    const count = boardItems().length;
    if (!confirm(`Delete workspace "${board.name}"? Its ${count} item${count === 1 ? '' : 's'} will move to Trash.`)) return;
    const next = S.boards.find((x) => x.id !== board.id) || S.boards.find((x) => x.id === 'main');
    toggleBoardMenu(false);
    try {
      await api('DELETE', `/api/boards/${encodeURIComponent(board.id)}`);
      S.sel.clear();
      if (S.drawer) closeDrawer();
      if (S.board === board.id && next) switchBoard(next.id);
      toast(`deleted workspace "${board.name}" · its items moved to Trash`, 5000);
    } catch (error) { toast(error.message, 5000); }
  }
});

// ---------------------------------------------------------------- data sync
async function load() {
  const statePath = CAPTURE_READONLY ? `/api/captures/${encodeURIComponent(CAPTURE_TOKEN)}` : '/api/state';
  const [st, views] = await Promise.all([api('GET', statePath), fetch('/api/views').then((r) => r.json()).then((v) => v.views ?? []).catch(() => [])]);
  if (CAPTURE_READONLY) S.captureNow = Number(st.now) || Date.now();
  S.readoutAt = Date.now();
  S.views = views;
  viewMods.clear();
  S.boards = st.boards;
  S.readoutBoards.clear();
  for (const board of S.boards) {
    if (Array.isArray(board.comparisonResults)) S.readoutBoards.set(board.id, { id: board.id, annotations: board.annotations || [], comparisons: board.comparisonResults });
  }
  S.items = new Map(st.items.map((i) => [i.id, i]));
  S.detail.clear();
  S.activity = st.activity;
  S.alerts = st.alerts || [];
  const hs = hashState();
  const want = CAPTURE_READONLY ? (CAPTURE_BOARD || hs.board || st.board || st.captureBoard) : hs.board || (() => {
    try {
      return localStorage.getItem('hud.board');
    } catch {}
  })();
  const id = S.boards.some((b) => b.id === want) ? want : S.board && S.boards.some((b) => b.id === S.board) ? S.board : S.boards[0].id;
  const initialPage = !CAPTURE_READONLY && hs.page === 'attention' ? 'attention' : 'board';
  if (id !== S.board) switchBoard(id, { page: initialPage, hash: false });
  else { setPage(initialPage, { hash: false }); renderAll(); loadClaims(); }
  if (S.drawer && !S.items.has(S.drawer)) closeDrawer();
  else if (S.drawer) renderDrawer();
  if (S.drawer) fetchDetail(S.drawer);
  renderActivity();
  if (hs.page === 'item' && S.items.has(hs.item)) openItemDeepLink(hs.item);
}

let es;
const buffered = []; // SSE events that arrive while the first snapshot is still loading
function connect() {
  es = new EventSource('/api/events');
  es.onmessage = (m) => {
    let e;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    if (!S.ready && e.kind !== 'hello') return void buffered.push(e);
    try {
      onEvent(e);
    } catch (err) {
      console.error('event failed', e?.kind, err);
    }
  };
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
}
function setLive(on) {
  S.connected = on;
  renderConnection();
  if (S.drawer) renderDrawer();
}
let persistenceBusy = false;
function syncPersistenceBannerHeight() {
  const el = $('#persistence-banner');
  if (!el || el.hidden) return;
  document.documentElement.style.setProperty('--persistence-banner-height', `${el.offsetHeight}px`);
}
function renderPersistenceBanner(health) {
  const el = $('#persistence-banner');
  if (!el || CAPTURE_READONLY) return;
  // Unreachable health is not a report. Drop the last saveError / recoveredFrom instead of leaving it up.
  const notice = health ? persistenceNotice(health) : null;
  S.persistence = notice;
  if (!notice) {
    el.hidden = true;
    el.replaceChildren();
    delete el.dataset.rendered;
    document.body.classList.remove('persistence-alert');
    return;
  }
  const html = persistenceBannerHTML(notice);
  if (el.dataset.rendered !== html) {
    el.innerHTML = html;
    el.dataset.rendered = html;
  }
  el.hidden = false;
  document.body.classList.add('persistence-alert');
  syncPersistenceBannerHeight();
}
async function refreshPersistenceBanner() {
  if (CAPTURE_READONLY) return;
  const health = await optionalGET('/api/health');
  renderPersistenceBanner(health);
}
async function persistenceAction(action) {
  if (persistenceBusy || !S.persistence) return;
  persistenceBusy = true;
  try {
    if (action === 'open-data-dir') {
      const opened = await api('POST', '/api/data/reveal');
      toast(`opened ${opened.dataDir || 'data dir'}`);
      return;
    }
    if (action !== 'restore') return;
    const backups = await api('GET', '/api/backups');
    const named = S.persistence.recoveredFrom;
    if (named && !backups.some((backup) => backup?.name === named)) {
      toast(`backup ${named} is no longer on disk`);
      return;
    }
    const name = named || restoreTarget(S.persistence, backups);
    if (!name) return toast('no backup to restore');
    if (!confirm(`Restore ${name}? This replaces the live board. The current state is backed up first.`)) return;
    await api('POST', `/api/backups/${encodeURIComponent(name)}/restore`);
    toast(`restored ${name}`);
    await load();
  } finally {
    persistenceBusy = false;
    void refreshPersistenceBanner();
  }
}
function renderConnection() {
  const c = $('#conn');
  if (CAPTURE_READONLY) {
    c.classList.remove('off');
    c.textContent = '◉ snapshot';
    c.title = 'frozen capture · read-only';
    return;
  }
  const age = S.heartbeatAt ? Math.max(0, Math.floor((Date.now() - S.heartbeatAt) / 1000)) : null;
  const fresh = age !== null && age <= 60;
  const online = S.connected && fresh;
  c.classList.toggle('off', !online);
  c.textContent = online ? '● live' : S.connected ? `○ heartbeat ${age == null ? 'waiting' : `${age}s`}` : '○ offline';
  c.title = `event stream ${S.connected ? 'connected' : 'disconnected'} · heartbeat ${age == null ? 'not received' : `${age}s ago`} · watchdog 60s`;
}

function onEvent(e) {
  if (e.kind === 'heartbeat') {
    S.heartbeatAt = Number(e.now) || Date.now();
    renderConnection();
    return;
  }
  if (e.kind === 'hello') {
    // server restarted (possibly with new code): reload the page to pick it up
    if (S.serverPid && S.serverPid !== e.pid) return location.reload();
    S.serverPid = e.pid;
    S.heartbeatAt = Number(e.now) || Date.now();
    renderConnection();
    // the first hello is the boot snapshot's own stream; later ones are reconnects, which may have missed events
    if (S.live && S.ready) load().catch(() => {});
    S.live = true;
    return;
  }
  if (e.kind === 'session') {
    loadSessions();
    return;
  }
  if (e.kind === 'claim') {
    if (!e.claim.board || e.claim.board === S.board) {
      S.claimsEpoch++;
      if (e.action === 'released' || e.action === 'expired') S.claims.delete(e.claim.ticket);
      else S.claims.set(e.claim.ticket, e.claim);
      S.claimsReady = true;
    }
    S.claimCache.delete(e.claim.ticket);
    if (S.drawer === e.claim.ticket) fillClaim(itemFor(S.drawer));
    refreshQueueLater();
    if (S.mode === 'list') scheduleList();
    return;
  }
  if (e.kind === 'context') {
    S.contextCache.delete(e.entry.scope);
    for (const ref of e.entry.refs || []) S.contextCache.delete('ref:' + ref);
    for (const ref of e.entry.refs || []) for (const tree of trees.values()) tree.pulse(ref, e.entry.kind);
    if (S.drawer) { const it = itemFor(S.drawer); if (it && (scopeFor(it) === e.entry.scope || (e.entry.refs || []).includes(it.id))) fillContext(it); }
    return;
  }
  if (e.kind === 'alert') {
    S.alerts.push(e.alert);
    if (S.alerts.length > 300) S.alerts.splice(0, S.alerts.length - 300);
    toast(`${e.alert.to === 'done' ? '✓' : '▲'} ${e.alert.title}: ${e.alert.from} → ${e.alert.to}`, 5000);
    return;
  }
  if (e.kind === 'attention') {
    loadAttention();
    return;
  }
  if (e.kind === 'item') {
    const prev = S.items.get(e.item.id);
    if (drag && drag.ids?.has(e.item.id) && e.actor === ME) return;
    if (drag && drag.ids?.has(e.item.id)) {
      // someone else moved what we're dragging; keep our geometry
      const { x, y, w, h } = prev;
      Object.assign(e.item, { x, y, w, h });
    }
    S.items.set(e.item.id, e.item);
    if (e.item.board === S.board) {
      renderItem(e.item);
      refreshDerived();
      const stateChanged = prev && prev.state !== e.item.state;
      if (e.actor !== ME && (e.actor !== SYSTEM || stateChanged || e.created)) flash(e.item.id);
    } else {
      removeEl(e.item.id);
      if (e.created && e.item.board !== S.board) toastBoardCreated(e.item);
    }
    const approvalChanged = !!prev && (prev.commandApproval?.status !== e.item.commandApproval?.status || prev.commandApproval?.fingerprint !== e.item.commandApproval?.fingerprint);
    if (S.drawer === e.item.id && (e.actor !== ME || approvalChanged)) renderDrawer();
    else if (S.drawer === e.item.id && e.item.type === 'monitor') renderDrawerLive();
    if (S.drawer === e.item.id && e.item.type === 'monitor') refreshDetailLater(e.item.id);
    refreshAttentionLater();
    refreshRunsLater();
    refreshQueueLater();
    updateChrome();
    queueProgramsMount();
  } else if (e.kind === 'item.deleted') {
    S.items.delete(e.id);
    S.detail.delete(e.id);
    S.sel.delete(e.id);
    S.trend.delete(e.id);
    pendingNudge.delete(e.id);
    if (drag?.ids?.has(e.id) || drag?.id === e.id) endDragSilently();
    removeEl(e.id);
    if (S.drawer === e.id) closeDrawer();
    renderTrash();
    renderFrames();
    updateChrome();
    refreshQueueLater();
    queueProgramsMount();
  } else if (e.kind === 'board') {
    upsertBoard(e.board);
    if (e.board.id === S.board) { renderAll(); queueProgramsMount(); }
  } else if (e.kind === 'board.deleted') {
    S.boards = S.boards.filter((b) => b.id !== e.id);
    for (const it of [...S.items.values()]) if (it.board === e.id) {
      S.items.delete(it.id);
      S.detail.delete(it.id);
      S.sel.delete(it.id);
      S.trend.delete(it.id);
      S.uptime.delete(it.id);
      pendingNudge.delete(it.id);
      removeEl(it.id);
    }
    if (drag?.ids && [...drag.ids].some((id) => !S.items.has(id))) endDragSilently();
    if (S.drawer && !S.items.has(S.drawer)) closeDrawer();
    if (S.board === e.id) switchBoard(S.boards[0]?.id);
    renderBoardButtons();
    renderAll();
  } else if (e.kind === 'activity') {
    S.activity.push(e.activity);
    if (S.activity.length > 500) S.activity.shift();
    renderActivity(e.activity.id);
  }
}

// ---------------------------------------------------------------- pointer interaction
let drag = null; // {mode, ...}
let dragPointer = null; // pointer id of the current drag; captured lazily (see capturePointer)
let suppressClick = false; // a drag just ended; the following click is not a tap
let spaceDown = false;

/**
 * Take pointer capture, but only once a drag has actually moved. Capturing on pointerdown makes the
 * browser retarget the follow-up click/dblclick to the canvas, which silently breaks every delegated
 * handler (expand on double-click, option picks, note checkboxes).
 */
function capturePointer() {
  if (dragPointer == null || drag?.captured) return;
  if (drag) drag.captured = true;
  try {
    canvas.setPointerCapture(dragPointer);
  } catch {}
}

function markMoved() {
  if (drag) drag.moved = true;
  capturePointer();
}

canvas.addEventListener('pointerdown', (e) => {
  if (CAPTURE_READONLY) return;
  if (e.button === 2) return;
  closeMenu();
  const t = e.target;
  pressedId = t.closest('.item')?.dataset.id ?? null;
  if (t.closest('input, textarea, button, a, .chk')) return;
  const itemEl = t.closest('.item');
  const w = toWorld(e.clientX, e.clientY);
  dragPointer = e.pointerId;

  if (e.button === 1 || spaceDown || (!itemEl && !e.shiftKey)) {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y, moved: false };
    canvas.classList.add('panning');
    return;
  }
  if (!itemEl) {
    drag = { mode: 'marquee', wx: w.x, wy: w.y, sx: e.clientX, sy: e.clientY, base: new Set(S.sel) };
    return;
  }
  const id = itemEl.dataset.id;
  const it = S.items.get(id);
  if (!it) return;
  if (t.classList.contains('rz')) {
    select([id]);
    drag = { mode: 'resize', id, wx: w.x, wy: w.y, w0: it.w, h0: it.h, ids: new Set([id]), moved: false };
    return;
  }
  if (e.shiftKey) {
    if (S.sel.has(id)) S.sel.delete(id);
    else S.sel.add(id);
    select([...S.sel]);
  } else if (!S.sel.has(id)) select([id]);
  // moving a frame carries everything inside it
  const ids = new Set(S.sel);
  for (const sid of S.sel) {
    const s = S.items.get(sid);
    if (s?.type === 'frame') for (const c of membersOf(s)) if (c.type !== 'ticket' && c.type !== 'project') ids.add(c.id);
  }
  const start = {};
  for (const i of ids) {
    const s = S.items.get(i);
    if (s) start[i] = { x: s.x, y: s.y };
  }
  drag = { mode: 'move', wx: w.x, wy: w.y, sx: e.clientX, sy: e.clientY, ids, start, moved: false, clicked: id };
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) updateHover(e);
  else hideHover();
  const w = toWorld(e.clientX, e.clientY);
  S.mouse = w;
  if (!drag) return;
  if (drag.mode === 'pan') {
    S.view.x = drag.vx + (e.clientX - drag.sx);
    S.view.y = drag.vy + (e.clientY - drag.sy);
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) markMoved();
    applyView();
  } else if (drag.mode === 'move') {
    if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
    if (!drag.moved) for (const id of drag.ids) els.get(id)?.classList.add('drag');
    markMoved();
    const dx = w.x - drag.wx, dy = w.y - drag.wy;
    const lead = drag.start[drag.clicked];
    const b = boardSize();
    const originals = [...drag.ids].map(id => ({ ...drag.start[id], w: S.items.get(id)?.w || 0, h: S.items.get(id)?.h || 0 }));
    const sdx = clamp(e.altKey ? dx : snap(lead.x + dx) - lead.x, -Math.min(...originals.map(i => i.x)), b.w - Math.max(...originals.map(i => i.x + i.w)));
    const sdy = clamp(e.altKey ? dy : snap(lead.y + dy) - lead.y, -Math.min(...originals.map(i => i.y)), b.h - Math.max(...originals.map(i => i.y + i.h)));
    for (const id of drag.ids) {
      const it = S.items.get(id);
      const s = drag.start[id];
      if (!it || !s) continue;
      it.x = Math.round(s.x + sdx);
      it.y = Math.round(s.y + sdy);
      const el = els.get(id);
      if (el) {
        el.style.left = it.x + 'px';
        el.style.top = it.y + 'px';
      }
    }
  } else if (drag.mode === 'resize') {
    const it = S.items.get(drag.id);
    if (!it) return endDragSilently();
    markMoved();
    it.w = Math.max(GRID * 4, e.altKey ? Math.round(drag.w0 + w.x - drag.wx) : snap(drag.w0 + w.x - drag.wx));
    it.h = Math.max(GRID * 3, e.altKey ? Math.round(drag.h0 + w.y - drag.wy) : snap(drag.h0 + w.y - drag.wy));
    it.w = Math.min(it.w, boardSize().w - it.x);
    it.h = Math.min(it.h, boardSize().h - it.y);
    renderItem(it);
  } else if (drag.mode === 'marquee') {
    const m = $('#marquee');
    capturePointer();
    const r = canvas.getBoundingClientRect();
    const x1 = Math.min(e.clientX, drag.sx) - r.left, y1 = Math.min(e.clientY, drag.sy) - r.top;
    Object.assign(m.style, { display: 'block', left: x1 + 'px', top: y1 + 'px', width: Math.abs(e.clientX - drag.sx) + 'px', height: Math.abs(e.clientY - drag.sy) + 'px' });
    const rx = Math.min(w.x, drag.wx), ry = Math.min(w.y, drag.wy), rw = Math.abs(w.x - drag.wx), rh = Math.abs(w.y - drag.wy);
    const hit = canvasItems().filter((i) => i.x < rx + rw && rx < i.x + i.w && i.y < ry + rh && ry < i.y + i.h && (i.type !== 'frame' || (i.x >= rx && i.y >= ry && i.x + i.w <= rx + rw && i.y + i.h <= ry + rh)));
    select([...drag.base, ...hit.map((i) => i.id)]);
  }
});

/** drop an in-flight drag without committing it (its item was deleted under us) */
function endDragSilently() {
  drag = null;
  dragPointer = null;
  canvas.classList.remove('panning');
  $('#marquee').style.display = 'none';
  for (const el of $$('.item.drag')) el.classList.remove('drag');
}

function endDrag(e) {
  pressedId = null;
  if (!drag) return;
  const d = drag;
  drag = null;
  dragPointer = null;
  if (d.moved) {
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
  }
  canvas.classList.remove('panning');
  $('#marquee').style.display = 'none';
  for (const el of $$('.item.drag')) el.classList.remove('drag');
  if (d.mode === 'pan' && !d.moved && e?.type === 'pointerup') {
    select([]);
  } else if (d.mode === 'move' && d.moved) {
    const movingFrames = new Set([...d.ids].filter((id) => S.items.get(id)?.type === 'frame'));
    const carried = new Set([...movingFrames].flatMap((fid) => membersOf(S.items.get(fid)).map((m) => m.id)));
    const patch = [...d.ids].map((id) => S.items.get(id)).filter(Boolean).map((i) => {
      const p = { id: i.id, x: i.x, y: i.y };
      // dropping an item into (or out of) a frame changes its group
      if (i.type !== 'frame' && !carried.has(i.id)) {
        const f = frameUnder(i, movingFrames);
        const g = f ? f.title.trim() : '';
        if ((i.group || '') !== g) {
          p.group = g;
          i.group = g || undefined;
        }
      }
      return p;
    });
    api('PATCH', '/api/items', patch).catch(load);
    renderFrames();
    updateChrome();
  } else if (d.mode === 'resize' && d.moved) {
    const it = S.items.get(d.id);
    if (it) api('PATCH', `/api/items/${encodeURIComponent(it.id)}`, { w: it.w, h: it.h }).catch(load);
    renderFrames();
  }
}
window.addEventListener('pointerup', () => (pressedId = null));
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('dblclick', (e) => {
  const itemEl = e.target.closest('.item');
  if (!itemEl) {
    if (CAPTURE_READONLY) return;
    const w = toWorld(e.clientX, e.clientY);
    return openMenu(e.clientX, e.clientY, w);
  }
  if (suppressClick) return;
  openDrawer(itemEl.dataset.id);
});

/** the monitor under the cursor, if it is currently drawn as one of the value-axis charts */
function chartAt(e) {
  const card = e.target?.closest?.('.item');
  const it = card && S.items.get(card.dataset.id);
  if (!it || it.type !== 'monitor') return null;
  let disp = it.display || 'auto';
  if (disp === 'auto') disp = autoDisplay(it);
  return CHART_SET.has(disp) ? it : null;
}

/**
 * alt+scroll stretches the value axis. The window is stored on the monitor as plot.yMin/yMax, so it
 * persists and every viewer sees the same framing; scrolling back out past the data range clears it.
 */
const savePlotLater = debounce((id) => {
  const it = S.items.get(id);
  if (it) patchItem(id, { plot: it.plot }).catch(() => {});
}, 250);

function stretchRange(it, deltaY) {
  const values = seriesOf(it).pts.map((p) => p.v);
  const base = rangeOf(values.length ? values : [0, 1], {});
  const cur = { lo: it.plot?.yMin ?? base.lo, hi: it.plot?.yMax ?? base.hi };
  const mid = (cur.lo + cur.hi) / 2;
  const halfSpan = ((cur.hi - cur.lo) / 2) * Math.exp(deltaY * 0.0015);
  const lo = mid - halfSpan;
  const hi = mid + halfSpan;
  // once the window fully contains the data again, drop the pin and go back to automatic
  const fits = lo <= base.lo + 1e-9 && hi >= base.hi - 1e-9;
  const plot = { ...(it.plot || {}) };
  if (fits) {
    delete plot.yMin;
    delete plot.yMax;
  } else {
    plot.yMin = Number(lo.toFixed(4));
    plot.yMax = Number(hi.toFixed(4));
    delete plot.auto;
  }
  it.plot = plot; // apply locally per wheel tick, save once the wheel settles
  renderItem(it);
  savePlotLater(it.id);
  toast(`y-range ${fits ? 'auto' : `${fmtVal(plot.yMin)} … ${fmtVal(plot.yMax)}`}`);
}

canvas.addEventListener('click', (e) => {
  if (CAPTURE_READONLY) return;
  const ub = e.target.closest('.ubtn');
  if (ub && !suppressClick) {
    e.stopPropagation();
    return utilAction(ub);
  }
  const opt = e.target.closest('.ticket .opt:not(.chosen)');
  if (opt && !suppressClick) {
    const id = opt.closest('.item').dataset.id;
    decide(id, opt.dataset.decide, opt.dataset.label, opt.dataset.decisionVersion);
    return;
  }
  const chk = e.target.closest('.chk');
  if (!chk) return;
  const id = chk.closest('.item').dataset.id;
  const it = S.items.get(id);
  if (!it) return;
  const field = it.type === 'ticket' ? 'body' : 'text'; // tickets keep markdown in body; notes and utils in text
  const lines = String(it[field] || '').split('\n');
  const i = Number(chk.dataset.line);
  if (lines[i] === undefined) return;
  lines[i] = lines[i].replace(/- \[( |x|X)\]/, (m, c) => (c === ' ' ? '- [x]' : '- [ ]'));
  patchItem(id, { [field]: lines.join('\n') }).catch(() => {});
});

/** on-canvas utility controls (start/pause/lap/roll/…); state lives on the item so it survives reloads */
async function utilAction(el) {
  const card = el.closest('.item');
  const it = S.items.get(card?.dataset.id);
  if (!it || it.type !== 'util') return;
  const u = { ...(it.util || {}) };
  const now = Date.now();
  const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  switch (el.dataset.util) {
    case 'start':
      if (it.kind === 'timer') {
        const left = timerRemaining(it, now) || n(u.seconds, 300);
        u.remaining = left;
        u.endsAt = now + left * 1000;
        u.running = true;
      } else if (it.kind === 'stopwatch') {
        u.running = true;
        u.startedAt = now;
      }
      break;
    case 'pause':
      if (it.kind === 'timer') {
        u.remaining = timerRemaining(it, now);
        u.running = false;
        delete u.endsAt;
      } else if (it.kind === 'stopwatch') {
        u.elapsed = stopwatchElapsed(it, now);
        u.running = false;
        delete u.startedAt;
      }
      break;
    case 'reset':
      if (it.kind === 'timer') {
        u.remaining = n(u.seconds, 300);
        u.running = false;
        delete u.endsAt;
      } else if (it.kind === 'stopwatch') {
        u.elapsed = 0;
        u.running = false;
        u.laps = [];
        delete u.startedAt;
      }
      break;
    case 'plus5':
      if (it.kind === 'timer') {
        const left = timerRemaining(it, now) + 300;
        u.remaining = left;
        u.seconds = Math.max(n(u.seconds, 0), left);
        if (u.running) u.endsAt = now + left * 1000;
      }
      break;
    case 'lap':
      if (it.kind === 'stopwatch') u.laps = [...(u.laps || []), stopwatchElapsed(it, now)].slice(-50);
      break;
    case 'inc':
      if (it.kind === 'counter') u.value = n(u.value) + n(u.step, 1);
      break;
    case 'dec':
      if (it.kind === 'counter') u.value = n(u.value) - n(u.step, 1);
      break;
    case 'zero':
      if (it.kind === 'counter') u.value = 0;
      break;
    case 'roll':
      if (it.kind === 'dice') {
        const sides = Math.max(2, n(u.sides, 6));
        const roll = 1 + Math.floor(Math.random() * sides);
        u.last = roll;
        u.rolls = [...(u.rolls || []), roll].slice(-20);
      }
      break;
    case 'clear':
      if (it.kind === 'dice') {
        u.last = null;
        u.rolls = [];
      }
      break;
    default:
      return;
  }
  patchItem(it.id, { util: u });
}

async function decide(id, optionId, label, renderedVersion) {
  const it = itemFor(id);
  const opt = it?.options?.find((o) => o.id === optionId);
  if (!confirm(`Decide ${id}: ${opt?.label ?? label}?`)) return;
  try {
    const version = renderedVersion === undefined || renderedVersion === '' ? it?.decisionVersion : renderedVersion;
    const updated = lite(await api('POST', `/api/items/${encodeURIComponent(id)}/decide`, { optionId, ...(version != null ? { decisionVersion: version } : {}) }));
    S.items.set(id, updated);
    renderItem(S.items.get(id));
    updateChrome();
    toast(`decided: ${opt?.label ?? label}`);
    if (S.drawer === id) renderDrawer();
  } catch (e) {
    if (e.status === 409) {
      toast('decision changed elsewhere; refreshing');
      await load();
      if (S.drawer === id) openDrawer(id);
    }
  }
}

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.altKey) {
      const it = chartAt(e);
      if (it) return stretchRange(it, e.deltaY);
    }
    if (e.ctrlKey || e.metaKey) {
      // pinch (ctrlKey, small deltas) is fine-grained; a real wheel notch reports ~100, so use a gentler slope
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const slope = e.ctrlKey && !e.metaKey && Math.abs(dy) < 50 ? 0.01 : 0.002;
      zoomAt(e.clientX, e.clientY, S.view.z * clamp(Math.exp(-dy * slope), 0.8, 1.25));
    } else {
      S.view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      S.view.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      applyView();
    }
  },
  { passive: false },
);
// Safari trackpad pinch
canvas.addEventListener('gesturestart', (e) => e.preventDefault());
canvas.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, S.view.z * (1 + (e.scale - 1) * 0.08));
});

// ---------------------------------------------------------------- create menu
const MENU = [
  ['monitor', 'm'],
  ['note', 'n'],
  ['frame', 'f'],
  ['util', 'w'],
];
const TREE_TYPES = new Set(['ticket', 'project']);
/** tasks are tree objects: the canvas hands off to the list instead of placing a card */
function newTicketInList(status = 'todo') {
  if (S.mode !== 'list') setMode('list');
  const head = $('#list .lhead');
  if (!head) return;
  const existing = head.parentElement?.querySelector('.trow.creating');
  if (existing) return existing.querySelector('input').focus();
  newTicketInline(head, '', status);
}

function openMenu(cx, cy, w) {
  const m = $('#menu');
  m.innerHTML = MENU.map(([t, k]) => `<div data-type="${t}"><span class="k">${k}</span>${t}</div>`).join('');
  m.style.left = Math.min(cx, innerWidth - 180) + 'px';
  m.style.top = Math.min(cy, innerHeight - 140) + 'px';
  m.classList.add('open');
  m.dataset.x = w.x;
  m.dataset.y = w.y;
}
function closeMenu() {
  $('#menu').classList.remove('open');
}
$('#menu').addEventListener('click', (e) => {
  const d = e.target.closest('[data-type]');
  if (!d) return;
  const m = $('#menu');
  closeMenu();
  createAt(d.dataset.type, { x: Number(m.dataset.x), y: Number(m.dataset.y) });
});

async function createAt(type, pos, extra = {}) {
  const body = { type, board: S.board, title: '', ...extra };
  if (type === 'util') {
    const kind = UTIL_KINDS.includes(extra.kind) ? extra.kind : 'timer';
    body.kind = kind;
    body.util = extra.util ?? defaultUtil(kind);
    body.title = extra.title ?? UTIL_LABEL[kind];
    body.w = 300;
    body.h = 190;
  }
  if (pos && !TREE_TYPES.has(type)) {
    body.x = snap(pos.x);
    body.y = snap(pos.y);
  }
  const it = lite(await api('POST', '/api/items', body));
  S.items.set(it.id, it);
  if (it.board !== S.board) {
    rememberBoard(it.board);
    switchBoard(it.board);
    toastBoardCreated(it);
  }
  if (it.type === 'ticket' || it.type === 'project') setMode('list');
  renderItem(it);
  renderFrames();
  updateChrome();
  select([it.id]);
  openDrawer(it.id, true);
  return it;
}

// ---------------------------------------------------------------- drawer
/** optimistic: applies the patch locally, and puts the old values back (with the server's error toast) on failure */
let saveStateTimer;
function setSaveState(state) {
  const el = $('#drawer-save-state');
  if (!el) return;
  clearTimeout(saveStateTimer);
  el.className = `drawer-save-state ${state || ''}`;
  el.textContent = state === 'pending' ? 'pending' : state === 'saving' ? 'saving…' : state === 'saved' ? 'saved' : state === 'failed' ? 'failed' : '';
  if (state === 'saved') saveStateTimer = setTimeout(() => setSaveState(''), 1800);
}
function patchItem(id, patch) {
  const it = S.items.get(id);
  const prev = {};
  if (it) {
    for (const k of Object.keys(patch)) prev[k] = it[k];
    Object.assign(it, patch);
    renderItem(it);
  }
  if (S.drawer === id) setSaveState('saving');
  return api('PATCH', `/api/items/${encodeURIComponent(id)}`, patch).then(
    (u) => {
      u = lite(u);
      S.items.set(u.id, u);
      for (const [k, v] of Object.entries(patch)) {
        const selector = `[data-k="${k}"]`;
        if (S.drafts.get(id)?.get(selector) === String(v ?? '')) S.drafts.get(id).delete(selector);
      }
      renderItem(u);
      refreshDerived();
      updateChrome();
      if (S.drawer === id) setSaveState('saved');
      return u;
    },
    (err) => {
      const cur = S.items.get(id);
      if (cur) {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete cur[k];
          else cur[k] = v;
        }
        renderItem(cur);
        if (S.drawer === id) S.drawerDirty = true;
        if (S.drawer === id && !$('#drawer').contains(document.activeElement)) renderDrawer();
        updateChrome();
      }
      if (S.drawer === id) setSaveState('failed');
      throw err;
    },
  );
}

/** v: cycle the display of the selected monitor(s) through every view */
async function cycleDisplay() {
  const mons = [...S.sel].map((id) => S.items.get(id)).filter((it) => it?.type === 'monitor');
  if (!mons.length) return toast('select a monitor, then v to change its view');
  const cur = mons[0].display || 'auto';
  const next = DISPLAYS[(DISPLAYS.indexOf(cur) + 1) % DISPLAYS.length];
  await Promise.all(mons.map((m) => patchItem(m.id, { display: next }).catch(() => {})));
  toast(`view: ${next}`);
}

function openDrawer(id, focusTitle = false) {
  const refit = refitIfLetterboxed();
  const changed = S.drawer !== id;
  S.drawer = id;
  S.pendingKind = null;
  if (itemFor(id)?.type === 'monitor') fetchTrend(id);
  if (itemFor(id)?.type === 'ticket') fetchItemActivity(id);
  fetchDetail(id);
  loadRuns();
  $('#drawer').classList.add('open');
  document.body.classList.add('drawer-open');
  renderDrawer();
  if (changed) $('#drawer').scrollTop = 0;
  refit();
  if (focusTitle) setTimeout(() => { $('#drawer [data-k="title"]')?.focus(); $('#drawer [data-section="settings"]')?.scrollIntoView({ block: 'start' }); }, 0);
}
function dismissDrawer() {
  S.drawer = null;
  S.pendingKind = null;
  S.drawerWide = false;
  $('#drawer').classList.remove('open');
  document.body.classList.remove('drawer-open', 'drawer-wide');
}
function closeDrawer() {
  const refit = refitIfLetterboxed();
  dismissDrawer();
  refit();
}

const DRAWER_MIN = 360;
function setDrawerWidth(width, persist = true, adjustCamera = true) {
  const refit = adjustCamera && S.drawer ? refitIfLetterboxed() : null;
  const max = Math.min(900, innerWidth);
  const min = Math.min(DRAWER_MIN, max);
  S.drawerWidth = clamp(Number(width) || 420, min, max);
  document.documentElement.style.setProperty('--drawer-width', `${S.drawerWidth}px`);
  const grip = $('#drawer-grip');
  if (grip) { grip.setAttribute('aria-valuemin', String(min)); grip.setAttribute('aria-valuemax', String(max)); grip.setAttribute('aria-valuenow', String(Math.round(S.drawerWidth))); }
  if (persist && !CAPTURE_READONLY) try { localStorage.setItem(localKey('drawer-width'), String(S.drawerWidth)); } catch {}
  if (refit) refit();
}
try { setDrawerWidth(Number(localStorage.getItem(localKey('drawer-width'))) || 420, false); } catch { setDrawerWidth(420, false); }
let drawerResize = null;
$('#drawer-grip').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const width = $('#drawer').getBoundingClientRect().width;
  S.drawerWide = false;
  document.body.classList.remove('drawer-wide');
  setDrawerWidth(width);
  drawerResize = { x: e.clientX, width };
  e.currentTarget.setPointerCapture?.(e.pointerId);
  e.preventDefault();
});
$('#drawer-grip').addEventListener('pointermove', (e) => {
  if (!drawerResize) return;
  setDrawerWidth(drawerResize.width + drawerResize.x - e.clientX);
});
$('#drawer-grip').addEventListener('pointerup', () => { drawerResize = null; });
$('#drawer-grip').addEventListener('pointercancel', () => { drawerResize = null; });
$('#drawer-grip').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const width = $('#drawer').getBoundingClientRect().width;
  S.drawerWide = false;
  document.body.classList.remove('drawer-wide');
  setDrawerWidth(width);
  const step = e.shiftKey ? 80 : 20;
  if (e.key === 'ArrowLeft') { e.preventDefault(); setDrawerWidth(S.drawerWidth + step); }
  if (e.key === 'ArrowRight') { e.preventDefault(); setDrawerWidth(S.drawerWidth - step); }
  if (e.key === 'Home') { e.preventDefault(); setDrawerWidth(Math.min(900, innerWidth)); }
  if (e.key === 'End') { e.preventDefault(); setDrawerWidth(Math.min(DRAWER_MIN, innerWidth)); }
});

const chips = (key, opts, cur, labels = {}) =>
  `<div class="chips" data-chips="${key}">${opts.map((o) => `<span class="chip ${o === (cur ?? '') ? 'on' : ''}" data-v="${esc(o)}">${esc(labels[o] ?? (o || '—'))}</span>`).join('')}</div>`;
const row = (label, html) => `<div class="row"><label>${label}</label><div>${html}</div></div>`;
const inp = (k, v, ph = '', extra = '') => `<input data-k="${k}" value="${esc(v ?? '')}" placeholder="${esc(ph)}" ${extra}>`;

function drawerSettingsHTML(it) {
  const head = `<div class="phd"><b>${esc(it.type)}</b><span title="${esc(it.uuid || it.id)}">${esc(identOf(it))}</span>${it.type === 'ticket' ? copyTicketButton(it) : ''}<span class="sp"></span><button data-act="focus" title="center on canvas">◎</button><button data-act="close" title="close (esc)">×</button></div>`;
  const groups = [...new Set(boardItems().filter((f) => f.type === 'frame' && (f.title || '').trim()).map((f) => f.title.trim()))];
  const groupRow = it.type === 'frame' ? '' : row('group', `${inp('group', it.group, 'none — frame title', 'list="grouplist"')}<datalist id="grouplist">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>`);
  const meta = `<div class="sec"><h4>meta</h4><div class="meta">created ${localDT(it.createdAt)} by @${esc(it.createdBy)}<br>updated ${localDT(it.updatedAt)} by @${esc(it.updatedBy)}<br>board ${esc(it.board)} · ${esc(it.x)},${esc(it.y)} · ${esc(it.w)}×${esc(it.h)}${it.meta ? `<br>meta ${esc(JSON.stringify(it.meta))}` : ''}</div>
    <div class="btns"><button class="btn danger" data-act="delete">delete</button></div></div>`;
  if (it.type === 'ticket') {
    const up = ancestryOf(it);
    const kids = [...S.items.values()].filter((c) => c.type === 'ticket' && c.parent === it.id);
    const kidDone = kids.filter((k) => k.status === 'done' || k.status === 'canceled').length;
    const crumb = up.length
      ? `<div class="crumb">${up.map((a) => `<span class="go" data-go="${esc(a.id)}">${esc(identOf(a))} ${esc(a.title)}</span>`).join(' <span class="sep">›</span> ')} <span class="sep">›</span> <b>${esc(identOf(it))}</b></div>`
      : '';
    const subline = kids.length ? `<div class="subline">${kids.length} sub-ticket${kids.length > 1 ? 's' : ''}, ${kidDone} done · ${kids.map((k) => `<span class="go" data-go="${esc(k.id)}">${esc(identOf(k))}</span>`).join(', ')}</div>` : '';
    const runField = (it.tags || []).includes('run') ? row('summary monitor', inp('summaryMonitor', it.summaryMonitor || '', 'linked monitor id', 'list="monlist"')) : '';
    return `${head}<div class="sec">${crumb}
      ${row('title', inp('title', it.title, 'what needs doing', 'class="ttl-in"'))}
      ${row('status', chips('status', STATUSES, it.status))}
      ${row('priority', chips('priority', PRIOS, it.priority || ''))}
      ${row('assignee', inp('assignee', it.assignee, 'anyone'))}
      ${row('target', inp('target', it.target ? String(it.target).slice(0, 10) : '', 'yyyy-mm-dd', 'type="date"') + (isOverdue(it) ? ' <span class="od">‼ overdue</span>' : ''))}
      ${row('tags', inp('tags', (it.tags || []).join(', '), 'comma, separated'))}
      ${groupRow}
      ${row('project', inp('project', projectRef(it), 'project KEY or id — sets the ident and branch', 'list="projlist"') + `<datalist id="projlist">${boardItems().filter((p) => p.type === 'project').map((p) => `<option value="${esc(p.key)}">${esc(p.title)}</option>`).join('')}</datalist>`)}
      ${row('parent', inp('parent', it.parent ? nameOf(it.parent) : '', 'KEY-12 — makes this a sub-ticket', 'list="ticklist"') + `<datalist id="ticklist">${[...S.items.values()].filter((t) => t.type === 'ticket' && t.id !== it.id).map((t) => `<option value="${esc(identOf(t))}">${esc(t.title)}</option>`).join('')}</datalist>`)}
      ${row('blocked by', inp('blockedBy', (it.blockedBy || []).map(nameOf).join(', '), 'KEY-12, comma separated — blocks this ticket until they finish'))}
      ${row('related', inp('refs', (it.refs || []).map(nameOf).join(', '), 'KEY-12, comma separated'))}
      ${row('branch', inp('branch', it.branch || '', 'git branch — type regen to rebuild it'))}
      ${row('monitors', inp('monitors', (it.monitors || []).join(', '), 'linked monitor ids', 'list="monlist"') + `<datalist id="monlist">${boardItems().filter((m) => m.type === 'monitor').map((m) => `<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('')}</datalist>`)}
      ${runField}
      ${it.monitors?.length ? row('auto', chips('autoStatus', ['off', 'on'], it.autoStatus ? 'on' : 'off', { on: 'on: all done → done, error → blocked', off: 'off' })) : ''}
      </div>${subline}<div class="sec"><h4>description</h4><textarea data-k="body" placeholder="markdown">${esc(it.body)}</textarea></div>
      ${meta}`;
  }
  if (it.type === 'monitor') {
    const src = it.source || { kind: 'manual' };
    const k = src.kind;
    const auto = ['command', 'http', 'probe'].includes(k);
    let srcFields = '';
    if (k === 'command') srcFields = row('command', `<textarea data-s="command" style="min-height:60px">${esc(src.command)}</textarea>`) + row('cwd', `<input data-s="cwd" value="${esc(src.cwd ?? '')}" placeholder="(server cwd)">`);
    const hdrs = src.headers && typeof src.headers === 'object' ? JSON.stringify(src.headers, null, 2) : '';
    if (k === 'http') srcFields = row('headers', `<textarea data-s="headers" style="min-height:44px" placeholder='{ "authorization": "…" }'>${esc(hdrs)}</textarea>`) + row('contains', `<input data-s="contains" value="${esc(src.contains ?? '')}" placeholder="body must include this text">`) + row('url', `<input data-s="url" value="${esc(src.url ?? '')}" placeholder="https://…">`) + row('method', `<input data-s="method" value="${esc(src.method ?? '')}" placeholder="GET">`) + row('expect', `<input data-s="expectStatus" value="${esc(src.expectStatus ?? '')}" placeholder="2xx">`) + row('jsonPath', `<input data-s="jsonPath" value="${esc(src.jsonPath ?? '')}" placeholder="(latency) e.g. data.count">`);
    if (k === 'probe') srcFields = row('probe', `<input data-s="probe" value="${esc(src.probe ?? '')}" placeholder="name in probes/">`) + row('config', `<textarea data-s="config" style="min-height:60px" placeholder="{ JSON }">${esc(src.config ? JSON.stringify(src.config, null, 2) : '')}</textarea>`);
    if (k === 'heartbeat') srcFields = `<div class="row2">${row('period s', `<input data-s="period" value="${esc(src.period ?? '')}" placeholder="60">`)}${row('grace s', `<input data-s="grace" value="${esc(src.grace ?? '')}" placeholder="60">`)}</div><div class="hint">no ping within period + grace = error</div>${[['ok', ''], ['fail', '/fail']].map(([l, p]) => { const u = `http://localhost:${location.port || 80}/ping/${it.id}${p}`; return `<div class="copyrow"><span class="dim">${l}</span><code>${esc(u)}</code><button class="btn sm" data-act="copy" data-text="${esc(u)}">copy</button></div>`; }).join('')}`;
    if (auto) srcFields += `<div class="row2">${row('interval', `<input data-s="interval" value="${esc(src.interval ?? '')}" placeholder="30 s">`)}${row('timeout', `<input data-s="timeout" value="${esc(src.timeout ?? '')}" placeholder="30 s">`)}</div>`;
    const pendingCommand = commandPending(it);
    const url = `${location.origin}/api/monitors/${encodeURIComponent(it.id)}/push`;
    const pushHelp = `<pre class="snip">curl -s ${url} -H 'content-type: application/json' -d '{"value": 42, "message": "…"}'</pre><pre class="snip">hud push ${esc(it.id)} 42 --message "…"</pre>`;
    return `${head}<div class="sec">
      ${row('title', inp('title', it.title, 'what is being watched', 'class="ttl-in"'))}
      ${row('display', chips('display', DISPLAYS, it.display || 'auto'))}
      ${groupRow}
      ${row('wake', inp('notify', (it.notify || []).join(', '), 'session names to wake on alerts'))}
      </div>
      <div class="sec"><h4>set reading</h4>
      <div class="row2">${row('value', `<input data-r="value" value="${esc(fmtRaw(it.value))}">`)}${row('unit', inp('unit', it.unit, 'ms, %, …'))}</div>
      ${row('state', chips('r-state', MSTATES, it.state))}
      ${row('label', `<input data-r="label" value="${esc(it.label ?? '')}" placeholder="text shown instead of value">`)}
      ${row('message', `<input data-r="message" value="${esc(it.message ?? '')}">`)}
      ${row('message format', chips('messageFormat', ['plain', 'markdown'], it.messageFormat || 'plain'))}
      ${row('details', `<textarea data-k="details" class="report-details" placeholder="optional Markdown report details (20KB max)">${esc(it.details ?? '')}</textarea>`)}
      ${row('progress', `<input data-r="progress" value="${esc(it.progress ?? '')}" placeholder="0-100">`)}
      <div class="btns"><button class="btn" data-act="push">push reading ⏎</button></div></div>
      <div class="sec"><h4>source</h4>
      ${row('kind', chips('kind', KINDS, k))}
      ${srcFields}
      <div class="btns"><button class="btn" data-act="apply-source">apply source</button>${pendingCommand ? '<button class="btn" data-act="approve-command">approve</button>' : ''}${auto && !pendingCommand ? '<button class="btn" data-act="run">run now</button>' : ''}</div>
      ${k === 'push' || k === 'manual' ? `<div class="hint">push from anywhere:</div>${pushHelp}` : ''}
      ${k === 'probe' ? '<div class="hint">probes/&lt;name&gt;.ts exports default async (ctx) =&gt; ({value, state, message}) or watch(ctx) — see probes/README</div>' : ''}
      ${pendingCommand ? '<div class="hint">awaiting approval — this command does not run until you approve it</div>' : ''}
      ${k === 'command' ? '<div class="hint">stdout JSON {value,state,message,progress} is used directly; otherwise last line = value; exit≠0 = error</div>' : ''}
      </div>
      <div class="sec"><h4>thresholds</h4>
      <div class="row2">${row('warn &gt;', inp('warnAbove', it.warnAbove))}${row('error &gt;', inp('errorAbove', it.errorAbove))}${row('warn &lt;', inp('warnBelow', it.warnBelow))}${row('error &lt;', inp('errorBelow', it.errorBelow))}${row('max', inp('max', it.max, '= 100%'))}${row('stale s', inp('staleAfter', it.staleAfter))}</div></div>
      ${plotSection(it)}
      ${meta}`;
  }
  if (it.type === 'util') {
    const kindChips = chips('kind', UTIL_KINDS, it.kind || 'timer');
    const u = it.util || {};
    const params =
      it.kind === 'timer'
        ? row('minutes', `<input data-u="seconds" value="${esc(Math.round((Number(u.seconds) || 300) / 60))}" placeholder="5">`)
        : it.kind === 'counter'
          ? `<div class="row2">${row('value', `<input data-u="value" value="${esc(u.value ?? 0)}">`)}${row('step', `<input data-u="step" value="${esc(u.step ?? 1)}">`)}</div>${row('target', `<input data-u="target" value="${esc(u.target ?? '')}" placeholder="optional">`)}`
          : it.kind === 'dice'
            ? row('sides', `<input data-u="sides" value="${esc(u.sides ?? 6)}">`)
            : it.kind === 'sheet'
              ? `<div class="row2">${row('rows', `<input data-u="rows" value="${esc(u.rows ?? 8)}">`)}${row('cols', `<input data-u="cols" value="${esc(u.cols ?? 5)}">`)}</div>`
              : it.kind === 'calculator'
                ? row('expression', `<input data-u="expr" value="${esc(u.expr ?? '')}" placeholder="2*(3+4), sqrt(16), SUM-like math">`)
                : '';
    const sheet = it.kind === 'sheet' ? `<div class="sec"><h4>cells (tab-separated)</h4><textarea data-k="text" style="min-height:180px" placeholder="A1⇥B1&#10;=A1*2⇥=SUM(A1:A9)">${esc(it.text)}</textarea><div class="hint">a cell starting with = is a formula: A1+B2, SUM(A1:A9), AVG, MIN, MAX, IF…</div></div>` : '';
    const mdText = it.kind === 'markdown' ? `<div class="sec"><h4>text</h4><textarea data-k="text" style="min-height:220px">${esc(it.text)}</textarea></div>` : '';
    return `${head}<div class="sec">
      ${row('title', inp('title', it.title, 'label on the card', 'class="ttl-in"'))}
      ${row('kind', kindChips)}
      ${params}
      ${groupRow}</div>${sheet}${mdText}
      <div class="sec"><h4>state</h4><div class="meta">${esc(JSON.stringify(u))}</div>${it.kind === 'calculator' && u.result != null ? `<div class="answer">= ${esc(u.result)}</div>` : ''}</div>${meta}`;
  }
  if (it.type === 'note') {
    return `${head}<div class="sec">${row('title', inp('title', it.title, 'optional', 'class="ttl-in"'))}${groupRow}</div>
      <div class="sec"><h4>text</h4><textarea data-k="text" style="min-height:300px" placeholder="markdown: # heading, - list, - [ ] task, | table |, \`code\`">${esc(it.text)}</textarea></div>${meta}`;
  }
  if (it.type === 'project') {
    const ts = [...S.items.values()].filter((t) => t.type === 'ticket' && t.project === it.id);
    const done = ts.filter((t) => t.status === 'done' || t.status === 'canceled').length;
    return `${head}<div class="sec">${row('title', inp('title', it.title, 'project name', 'class="ttl-in"'))}
      ${row('key', inp('key', it.key, 'KEY — prefix of the ticket idents (unique per board)'))}
      ${row('lead', inp('lead', it.lead, 'who owns it'))}
      ${row('status', chips('status', ['', 'backlog', 'todo', 'doing', 'done', 'canceled'], it.status || ''))}
      ${row('target', inp('target', it.target ? String(it.target).slice(0, 10) : '', 'yyyy-mm-dd', 'type="date"'))}
      <div class="hint">${bar(ts.length ? (done / ts.length) * 100 : 0, 30)} ${done}/${ts.length} tickets done${ts.length ? ` · ${Math.round((done / ts.length) * 100)}%` : ''}</div></div>
      <div class="sec"><h4>description</h4><textarea data-k="body" placeholder="markdown">${esc(it.body)}</textarea></div>${meta}`;
  }
  if (it.type === 'frame') {
    const kids = membersOf(it);
    return `${head}<div class="sec">${row('title', inp('title', it.title, 'group name', 'class="ttl-in"'))}
      <div class="hint">items whose group is "${esc(it.title)}" live here; drag items in/out to regroup</div>
      <div class="btns"><button class="btn" data-act="arrange">arrange contents</button><button class="btn" data-act="organize">organize board</button><button class="btn" data-act="fit-frame">zoom to</button></div></div>
      <div class="sec"><h4>contains ${kids.length}</h4>${kids.map((c) => `<div class="act" data-go="${esc(c.id)}"><span class="tm">${esc(c.id)}</span><span>${esc(c.title || c.type)}</span></div>`).join('')}</div>${meta}`;
  }
  return `${head}<div class="sec"><div class="hint">no editor for "${esc(it.type)}" items</div></div>${meta}`;
}

function drawerHeaderHTML(it) {
  const expanded = S.drawerWide;
  return `<div class="phd"><b>${esc(it.type)}</b><span title="${esc(it.uuid || it.id)}">${esc(identOf(it))}</span>${it.type === 'ticket' ? copyTicketButton(it) : ''}<span id="drawer-save-state" class="drawer-save-state" aria-live="polite"></span><span class="sp"></span><button data-act="focus" title="center on canvas">◎</button><button data-act="expand" aria-expanded="${expanded}" title="${expanded ? 'shrink' : 'expand'} details">${expanded ? '⛶' : '⤢'}</button><button data-act="close" title="close (esc)">×</button></div>`;
}
function drawerSettingsBody(it) {
  const html = drawerSettingsHTML(it);
  const marker = '<div class="sec">';
  const at = html.indexOf(marker);
  return at >= 0 ? html.slice(at) : html;
}
function commentsOverviewHTML(it) {
  const comments = (it.comments || []).slice(-30);
  return `<div class="sec"><h4>comments ${comments.length || ''}</h4>${comments.map((c) => `<div class="comment" data-cid="${esc(c.id)}"><div class="who">@${esc(c.actor)} · ${localDT(c.t)}${c.format ? ` · ${esc(c.format)}` : ''}</div><div class="txt">${reportHTML(c.text, c.format || 'plain', { readonly: true })}</div></div>`).join('') || '<div class="faint">no comments</div>'}<div class="format-row"><select data-comment-format><option value="plain">plain</option><option value="markdown">markdown</option></select></div><textarea id="comment-in" data-comment-draft placeholder="write a comment; Enter for newline · Ctrl/Cmd+Enter to send"></textarea><div class="btns"><button class="btn" data-act="comment-send">send comment</button></div><div class="report-preview" id="comment-preview"></div></div>`;
}
function decisionOverviewHTML(it) {
  if (it.type !== 'ticket' || !it.options?.length) return '';
  const chosen = it.options.find((o) => o.id === it.decision?.optionId);
  const question = it.question ? `<div class="decision-question">${reportHTML(it.question, it.questionFormat || 'plain', { readonly: true })}</div>` : '';
  const options = it.decision ? `<div class="decision-option chosen"><span class="option-id">✓ ${esc(it.decision.optionId)}</span><span>${esc(chosen?.label || it.decision.optionId)}</span></div>` : it.options.map((o) => `<button class="decision-option" data-overview-decide="${esc(o.id)}" data-decision-version="${esc(it.decisionVersion ?? '')}" data-label="${esc(o.label)}"><span class="option-id">▸ ${esc(o.id)}</span><span>${esc(o.label)}</span>${o.detail ? `<span class="option-detail">${reportHTML(o.detail, o.format || it.questionFormat || 'plain', { readonly: true })}</span>` : ''}</button>`).join('');
  return `<div class="sec"><h4>decision</h4><div class="decision-panel">${question}${options}${it.decision ? `<div class="meta">decided by @${esc(it.decision.actor || '—')}${it.decision.note ? ` · ${esc(it.decision.note)}` : ''}</div>` : '<div class="hint">choose an option; this records the decision and wakes the asking agent</div>'}</div></div>`;
}
function runForItem(id) {
  return (S.runs.items || []).find((r) => r.id === id || r.uuid === id || (r.tickets || []).some((x) => (typeof x === 'string' ? x : x.id) === id) || (r.monitors || []).some((x) => (typeof x === 'string' ? x : x.id) === id));
}
function runSummaryHTML(it) {
  const run = runForItem(it.id);
  if (!run) return '';
  const progress = run.progress == null ? '' : `${Math.round(run.progress)}%`;
  let related = '';
  if (run.id === it.id) {
    const rows = (items) => items.map((x) => {
      const item = typeof x === 'string' ? itemFor(x) : itemFor(x.id) || x;
      if (!item) return '';
      const value = item.type === 'monitor' ? (item.label || `${fmtVal(item.value)}${item.unit ? ` ${item.unit}` : ''}` || item.state || 'unknown') : item.status;
      return `<button data-run-summary-open="${esc(item.id)}"><span>${esc(item.title || item.id)}</span><span>${esc(value)}</span></button>`;
    }).join('');
    const tickets = run.tickets || [], completed = tickets.filter((t) => runDone(t)), active = tickets.filter((t) => !runDone(t));
    related = `<h4>key readings</h4><div class="run-related">${rows(run.monitors || []) || '<span class="faint">No linked monitors.</span>'}</div><h4>related work</h4><div class="run-related">${rows(active) || '<span class="faint">No open child tickets.</span>'}</div>${completed.length ? `<details><summary class="dim">${completed.length} completed</summary><div class="run-related">${rows(completed)}</div></details>` : ''}`;
  }
  return `<div class="sec"><h4>run</h4><div class="drawer-report"><div><button class="run-summary-link" data-run-summary-open="${esc(run.id || run.uuid)}">${esc(run.title || run.ident || run.id)}</button> <span class="dim">${esc(run.status || '')}</span></div><div class="meta">${progress}${run.eta ? ` · ETA ${esc(localDT(Date.parse(run.eta)))}` : ''}${run.issues ? ` · ${run.issues} issue${run.issues === 1 ? '' : 's'}` : ''}</div>${related}</div></div>`;
}
function followupHTML(it) {
  if (!['ticket', 'monitor'].includes(it.type)) return '';
  return `<div class="sec"><h4>follow up</h4><div class="followup-box"><div class="hint">Create a linked ticket for the next response. This is recorded; agent response pending.</div>${row('title', `<input data-followup="title" placeholder="follow-up title">`)}${row('assignee', `<input data-followup="assignee" placeholder="explicit assignee (optional)">`)}${row('parent', `<input data-followup="parent" placeholder="parent ticket id or ident (optional)">`)}${row('refs', `<input data-followup="refs" placeholder="related ids or idents, comma separated">`)}<div class="btns"><button class="btn" data-act="followup">create ticket</button></div></div></div>`;
}
function monitorCurrentHTML(it) {
  const reading = monitorReadout(it);
  const state = monitorState(it);
  const label = reading.label != null ? reading.label : it.label != null && it.label !== '' ? it.label : fmtVal(Object.hasOwn(reading, 'value') ? reading.value : it.value);
  const value = label || state;
  const fresh = it.lastUpdate ? `${ago(it.lastUpdate)} ago · ${localDT(it.lastUpdate)}` : 'awaiting first report';
  const meta = monitorMetadata(it);
  const stateLabel = !S.connected ? 'hud disconnected — showing last received data' : isStale(it) && it.source?.kind === 'heartbeat' ? 'reporter stale — job outcome unconfirmed' : state === 'error' ? 'reported error' : isStale(it) ? 'reporter stale' : state;
  const hasProgress = it.progress != null && (String(value).includes(`${Math.round(it.progress)}%`) || (!it.label && it.unit === '%' && Number(it.value) === it.progress));
  return `<div class="drawer-report monitor-current"><div class="report-label">current reading</div><div class="monitor-current-value"><span class="g">${MGLYPH[state] || '○'}</span> <b>${esc(value)}</b>${(it.metric?.unit || it.unit) && !it.label ? ` <span class="dim">${esc(it.metric?.unit || it.unit)}</span>` : ''}${it.progress != null && !hasProgress ? ` <span class="dim">· ${Math.round(it.progress)}%</span>` : ''}</div><div class="meta">${esc(stateLabel)} · ${esc(fresh)}${it.updatedBy ? ` · @${esc(it.updatedBy)}` : ''}</div><div class="meta">source ${esc(meta.source)} · evidence ${esc(meta.evidence)} · age ${esc(meta.age)} · coverage ${esc(meta.coverage)}</div><div class="meta">${esc(meta.definition)}${it.freshness?.mode === 'static' ? ` · static: ${esc(it.freshness.reason || '')}` : ''}</div></div>`;
}
function drawerOverviewHTML(it) {
  let report = '';
  if (it.type === 'monitor') {
    report = `<h3 class="detail-title">${esc(it.title || it.id)}</h3>` + monitorCurrentHTML(it);
    if (it.message) report += `<div class="drawer-report"><h4>report</h4>${reportHTML(it.message, it.messageFormat || 'plain')}</div>`;
    if (it.details) report += `<div class="drawer-report"><h4>details</h4>${reportHTML(it.details, 'markdown')}</div>`;
  } else {
    const body = it.type === 'ticket' || it.type === 'project' ? it.body : it.text;
    report = `<h3 class="detail-title">${esc(it.title || it.id)}</h3>${it.type === 'ticket' ? `<div class="meta">${esc(it.status || 'todo')} · ${esc(it.assignee || it.createdBy || 'unassigned')}</div>` : ''}<div class="drawer-report">${body ? reportHTML(body, 'markdown') : '<span class="faint">No description yet.</span>'}</div>`;
  }
  const url = location.origin + location.pathname + '#item=' + encodeURIComponent(it.uuid || it.id);
  const coord = `${it.type === 'ticket' ? '<div class="claim-box" id="claim-box"></div>' : ''}${['ticket', 'project'].includes(it.type) ? '<div class="context-box" id="context-box"></div>' : ''}`;
  return `<div class="sec"><div class="meta">${esc(boardName(it.board))} · updated ${localDT(it.updatedAt)} by @${esc(it.updatedBy || it.createdBy || '—')}</div>${report}</div>${decisionOverviewHTML(it)}${runSummaryHTML(it)}${coord}${commentsOverviewHTML(it)}${followupHTML(it)}<div class="sec"><h4>identity</h4><div class="meta">${esc(it.id)}${it.uuid ? `<br>uuid ${esc(it.uuid)}` : ''}</div><button class="btn" data-act="copy" data-text="${esc(url)}">copy link</button></div>`;
}
function historyHTML(it) {
  if (it.type === 'monitor') {
    const reports = (it.reportHistory || []).slice().reverse().map((r) => `<div class="history-record"><span class="time">${esc(localDT(r.t))}</span><span class="state">@${esc(r.actor || '—')}</span>${r.message ? `<div>${reportHTML(r.message, r.messageFormat || 'plain', { readonly: true })}</div>` : ''}${r.details ? `<div class="meta">${reportHTML(r.details, 'markdown', { readonly: true })}</div>` : ''}</div>`).join('');
    const readings = (it.history || []).filter(Boolean).slice().reverse().map((h) => `<div class="history-record"><span class="time">${esc(localDT(h.t))}</span><span class="state">${MGLYPH[h.s] || '·'} ${esc(fmtVal(h.v ?? ''))}${h.p != null ? ` · ${Math.round(h.p)}%` : ''}</span>${h.m ? `<div>${esc(h.m)}</div>` : ''}</div>`).join('');
    return `<div class="sec"><h4>trend</h4>${chips('range', ['1h', '6h', '24h'], S.chartRange)}<div id="chart"></div><h4>report history</h4>${reports || '<div class="faint">no reports recorded</div>'}<h4>readings</h4>${readings || '<div class="faint">no readings recorded</div>'}<h4>log</h4><div class="hist">${(it.log || []).slice().reverse().map((l) => `${esc(localDT(l.t))}  ${MGLYPH[l.s] || '·'}  ${esc(l.m)}`).join('\n') || '—'}</div></div>`;
  }
  const comments = (it.comments || []).slice().reverse().map((c) => `<div class="history-record"><span class="time">${esc(localDT(c.t))}</span><span class="state">@${esc(c.actor || '—')}</span><div>${reportHTML(c.text, c.format || 'plain', { readonly: true })}</div></div>`).join('');
  const activity = (S.itact.get(it.id) || []).slice().reverse().map((a) => `<div class="history-record"><span class="time">${esc(localDT(a.t))}</span><span class="state">@${esc(a.actor || '—')}</span> ${esc(a.text || '')}</div>`).join('');
  return `<div class="sec"><h4>comments & records</h4>${comments || '<div class="faint">no comments</div>'}${activity ? `<h4>activity</h4>${activity}` : ''}</div>`;
}
/** a ticket's details: what it is, who has it, what it waits on, what was found, then folds for the rest */
function ticketDrawerHTML(it) {
  const state = needsDecision(it) ? 'decision' : it.status || 'todo';
  const word = { decision: 'waiting on you', todo: 'todo', backlog: 'backlog', doing: 'in progress', review: 'in review', blocked: 'blocked', done: 'done', canceled: 'canceled' }[state] || state;
  const chip = (t) => `<button class="tchip s-${esc(needsDecision(t) ? 'decision' : t.status || 'todo')}" data-go="${esc(t.id)}" title="${esc(t.title || '')}"><span class="g">${TREE_GLYPH[needsDecision(t) ? 'decision' : t.status || 'todo'] || '○'}</span>${esc(identOf(t))}</button>`;
  const parent = it.parent && itemFor(it.parent);
  const blockers = (it.blockedBy || []).map((id) => itemFor(id)).filter((b) => b && b.status !== 'done' && b.status !== 'canceled');
  const kids = kidsOf(it.id);
  const done = kids.filter((k) => k.status === 'done').length;
  const rel = [
    parent && `<div class="tk-rel"><span class="dim">part of</span>${chip(parent)}</div>`,
    blockers.length && `<div class="tk-rel"><span class="dim">waits on</span>${blockers.map(chip).join('')}</div>`,
    kids.length && `<div class="tk-rel"><span class="dim">${done}/${kids.length} done</span>${kids.map(chip).join('')}</div>`,
  ].filter(Boolean).join('');
  const url = location.origin + location.pathname + '#item=' + encodeURIComponent(it.uuid || it.id);
  const fold = (key, label, body) => `<details class="tk-fold" data-fold="${key}"${S.drawerFolds.has(key) ? ' open' : ''}><summary>${label}</summary>${body}</details>`;
  const more = `${followupHTML(it)}<div class="sec"><div class="meta">${esc(boardName(it.board))} · created ${localDT(it.createdAt)} by @${esc(it.createdBy || '—')} · updated ${localDT(it.updatedAt)} by @${esc(it.updatedBy || it.createdBy || '—')}<br>uuid ${esc(it.uuid || it.id)}${it.branch ? `<br>branch ${esc(it.branch)}` : ''}</div><button class="btn sm" data-act="copy" data-text="${esc(url)}">copy link</button></div>`;
  return `${drawerHeaderHTML(it)}<div class="inspector-body tk">
    <div class="sec tk-sum"><h3 class="detail-title">${esc(it.title || identOf(it))}</h3>
      <div class="tk-line"><span class="tk-status s-${esc(state)}"><span class="g">${TREE_GLYPH[state] || '○'}</span>${esc(word)}</span><span class="claim-box" id="claim-box"></span>${it.assignee ? `<span class="dim">→ ${esc(it.assignee)}</span>` : ''}</div>
      ${rel}</div>
    ${decisionOverviewHTML(it)}
    ${it.body ? `<div class="sec drawer-report tk-body">${reportHTML(it.body, 'markdown')}</div>` : ''}
    ${runSummaryHTML(it)}
    <div class="context-box" id="context-box"></div>
    ${commentsOverviewHTML(it)}
    ${fold('edit', 'edit', drawerSettingsBody(it))}
    ${fold('history', 'history', `<div class="sec"><div class="hist" id="itact">${itemActHTML(it.id)}</div></div>`)}
    ${fold('more', 'more', more)}
  </div>`;
}
function drawerHTML(it) {
  if (it.type === 'ticket') return ticketDrawerHTML(it);
  const jump = `<nav class="inspector-jump" aria-label="inspector sections"><button data-jump="overview">overview</button><button data-jump="activity">activity</button>${it.type === 'monitor' ? '<button data-jump="monitor">monitor</button>' : ''}<button data-jump="settings">settings</button></nav>`;
  const activity = historyHTML(it);
  return `${drawerHeaderHTML(it)}${jump}<div class="inspector-body"><section class="inspector-section" data-section="overview">${drawerOverviewHTML(it)}</section><section class="inspector-section" data-section="activity">${activity}</section>${it.type === 'monitor' ? `<section class="inspector-section" data-section="monitor">${drawerSettingsBody(it)}</section>` : `<section class="inspector-section" data-section="settings">${drawerSettingsBody(it)}</section>`}</div>`;
}
const fmtRaw = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * Chart options for the monitor. Only the fields the current renderer actually reads are shown, so the
 * panel stays short: a line chart needs a y-window, a pie needs to know where its named values live.
 */
function plotSection(it) {
  let disp = it.display || 'auto';
  if (disp === 'auto') disp = autoDisplay(it);
  const p = it.plot || {};
  if (disp.startsWith('view:')) {
    return `<div class="sec"><h4>chart</h4><div class="hint">drawing via the module <code>views/${esc(disp.slice(5))}.js</code> — see views/README.md for its ctx</div></div>`;
  }
  if (!CHART_SET.has(disp)) return '';
  const parts = [];
  if (['pie', 'donut', 'heatmap', 'scatter', 'scatter3d', 'surface3d', 'ridgeline', 'bars'].includes(disp)) {
    parts.push(row('data path', `<input data-p="series" value="${esc(p.series ?? '')}" placeholder="meta.<key> — categories, points, grid">`));
  }
  if (disp === 'histogram' || disp === 'ridgeline') parts.push(row('bins', `<input data-p="bins" value="${esc(p.bins ?? '')}" placeholder="12">`));
  if (disp === 'donut') parts.push(row('inner %', `<input data-p="bins" value="${esc(p.bins ?? 55)}" placeholder="55">`));
  if (disp === 'scatter3d' || disp === 'surface3d') {
    parts.push(`<div class="row2">${row('azimuth°', `<input data-p="tilt" value="${esc(p.tilt ?? 35)}">`)}${row('elevation°', `<input data-p="spin" value="${esc(p.spin ?? 22)}">`)}</div>`);
  }
  if (['line', 'area', 'bars', 'scatter', 'box'].includes(disp)) {
    parts.push(`<div class="row2">${row('y min', `<input data-p="yMin" value="${esc(p.yMin ?? '')}" placeholder="auto">`)}${row('y max', `<input data-p="yMax" value="${esc(p.yMax ?? '')}" placeholder="auto">`)}</div>`);
    parts.push(`<div class="hint">alt+scroll on the card stretches the axis; scroll back out to return to auto</div>`);
  }
  if (disp === 'line' || disp === 'area') parts.push(row('points', chips('plot-points', ['off', 'on'], p.points ? 'on' : 'off')));
  parts.push(row('animate', chips('plot-animate', ['none', 'replay', 'orbit'], p.animate || 'none')));
  return `<div class="sec"><h4>chart: ${esc(disp)}</h4>${parts.join('')}</div>`;
}

function liveHTML(it) {
  const up = S.uptime.get(it.id);
  const upHTML = up && (up.h1 != null || up.h24 != null) ? `<div class="meta">uptime ${up.h1 != null ? `1h ${up.h1.toFixed(1)}%` : '1h —'} · ${up.h24 != null ? `24h ${up.h24.toFixed(1)}%` : '24h —'}</div>` : '';
  const st = it.state || 'unknown';
  const hist = (it.history || []).filter(Boolean).slice(-30).reverse();
  const nums = (it.history || []).filter((h) => h && typeof h.v === 'number');
  const sp = spark(it.history, 50);
  const stats = nums.length ? `min ${esc(fmtVal(Math.min(...nums.map((h) => h.v))))} · max ${esc(fmtVal(Math.max(...nums.map((h) => h.v))))} · n ${nums.length}` : '';
  const rate = rateOf(it);
  return `<h4>now</h4><div style="font-size:22px;color:var(--hi)">${MGLYPH[st] || '○'} ${esc(it.label ?? fmtVal(it.value)) || esc(st)}${it.unit ? `<span class="dim" style="font-size:13px"> ${esc(it.unit)}</span>` : ''}${it.progress != null ? `<span class="dim" style="font-size:13px"> · ${Math.round(it.progress)}%</span>` : ''}</div>
    <div class="dim">${esc(it.message || '')}</div>
    <div class="meta">${esc(st)}${isStale(it) ? ' · STALE' : ''} · ${localDT(it.lastUpdate)} by @${esc(it.updatedBy)}${it.lastRun ? ` · last run ${ago(it.lastRun)} ago` : ''}${it.label != null && it.value != null ? ` · value ${esc(fmtVal(it.value))}` : ''}</div>
    ${rate ? `<div class="meta">${esc(rate.text)}</div>` : ''}${upHTML}
    <h4>trend</h4>${chips('range', ['1h', '6h', '24h'], S.chartRange)}<div id="chart"></div>
    ${sp ? `<div class="meta">${stats}</div>` : ''}
    <h4>history</h4><div class="hist">${hist.map((h) => `${hhmmss(h.t)}  ${MGLYPH[h.s] || '·'}  ${esc(h.v ?? '')}${h.p != null ? `  ${Math.round(h.p)}%` : ''}`).join('\n') || '<span class="faint">no readings yet</span>'}</div>
    <h4>log</h4><div class="hist">${(it.log || []).filter(Boolean).slice(-15).reverse().map((l) => `${hhmmss(l.t)}  ${MGLYPH[l.s] || '·'}  ${esc(l.m)}`).join('\n') || '<span class="faint">—</span>'}</div>`;
}

S.chartRange = '1h';
S.drawerFolds = new Set();
S.trend = new Map(); // id -> trend points (fetched; not on the live stream)
S.uptime = new Map(); // id -> {h1, h24}
S.itact = new Map(); // ticket id -> Activity[]
function itemActHTML(id) {
  const a = S.itact.get(id);
  if (!a) return '<span class="faint">loading…</span>';
  return a.slice(-40).reverse().map((x) => `${hhmmss(x.t)}  @${esc(x.actor)} ${esc(x.text)}`).join('\n') || '<span class="faint">—</span>';
}
async function fetchItemActivity(id) {
  if (CAPTURE_READONLY) return;
  try {
    S.itact.set(id, await api('GET', `/api/items/${encodeURIComponent(id)}/activity?limit=40`));
    const el = $('#itact');
    if (S.drawer === id && el) el.innerHTML = itemActHTML(id);
  } catch {}
}
async function fetchTrend(id) {
  if (CAPTURE_READONLY) return;
  try {
    const full = await api('GET', `/api/items/${encodeURIComponent(id)}`);
    S.items.set(id, lite(full));
    S.detail.set(id, { reportHistory: full.reportHistory, trend: full.trend, uptime: full.uptime, graph: full.graph });
    S.trend.set(id, full.trend || []);
    if (full.uptime) S.uptime.set(id, full.uptime);
    if (S.drawer === id) {
      renderChart();
      if (full.uptime) renderDrawerLive();
    }
  } catch {}
}
async function fetchDetail(id) {
  if (CAPTURE_READONLY) return;
  try {
    const full = await api('GET', `/api/items/${encodeURIComponent(id)}`);
    S.items.set(id, lite(full));
    S.detail.set(id, { reportHistory: full.reportHistory, trend: full.trend, uptime: full.uptime, graph: full.graph });
    if (S.drawer === id) renderDrawer();
  } catch {}
}
const refreshDetailLater = debounce((id) => fetchDetail(id), 350);
if (!CAPTURE_READONLY) setInterval(() => {
  const it = S.drawer && itemFor(S.drawer);
  if (it?.type === 'monitor') fetchTrend(it.id);
}, 60000);

function renderChart() {
  const el = $('#chart');
  const it = itemFor(S.drawer);
  if (!el || !it) return;
  $$('#drawer [data-chips="range"] .chip').forEach((c) => c.classList.toggle('on', c.dataset.v === S.chartRange));
  const span = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 }[S.chartRange];
  const since = Date.now() - span;
  const raw = (it.history || []).filter((h) => h.t >= since);
  const tr = (S.trend.get(it.id) || []).filter((h) => h.t >= since && h.t + 60e3 <= (raw[0]?.t ?? Infinity));
  let pts = [...tr, ...raw];
  const useP = !pts.some((x) => x.v != null) && pts.some((x) => x.p != null);
  pts = pts.map((x) => ({ t: x.t, y: useP ? x.p : x.v })).filter((x) => x.y != null);
  if (pts.length < 2) {
    el.innerHTML = `<div class="faint">not enough numeric readings in the last ${S.chartRange}${typeof it.value !== 'number' && it.value != null ? ' — push a numeric value (use label for text)' : ''}</div>`;
    return;
  }
  const W = 392, H = 130, L = 44, R = 6, T = 8, B = 18;
  let lo = Math.min(...pts.map((p) => p.y)), hi = Math.max(...pts.map((p) => p.y));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    el.innerHTML = '<div class="faint">values are too large to chart</div>';
    return;
  }
  if (lo === hi) {
    const e = Math.max(1, Math.abs(lo)) * 1e-6; // relative: +1 vanishes above 2^53
    (lo -= e), (hi += e);
  }
  const pad = (hi - lo) * 0.08;
  (lo -= pad), (hi += pad);
  const t0 = Math.max(since, pts[0].t), t1 = Math.max(Date.now(), t0 + 1);
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const Y = (y) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const area = `${path}L${X(pts[pts.length - 1].t).toFixed(1)},${H - B}L${X(pts[0].t).toFixed(1)},${H - B}Z`;
  const fmtY = (y) => fmtVal(Math.abs(hi - lo) > 20 ? Math.round(y) : +y.toFixed(2));
  const thr = [['warnAbove', '4 3'], ['errorAbove', '1 0'], ['warnBelow', '4 3'], ['errorBelow', '1 0']]
    .filter(([k]) => !useP && it[k] != null && it[k] > lo && it[k] < hi)
    .map(([k, dash]) => `<line x1="${L}" x2="${W - R}" y1="${Y(it[k])}" y2="${Y(it[k])}" stroke="var(--dim)" stroke-dasharray="${dash}" stroke-width="1"/>`)
    .join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
    <line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="var(--dim)"/><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="var(--dim)"/>
    <text x="${L - 4}" y="${T + 8}" text-anchor="end">${fmtY(hi)}</text><text x="${L - 4}" y="${H - B}" text-anchor="end">${fmtY(lo)}</text>
    <text x="${L}" y="${H - 4}">${hhmm(t0)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">now</text>
    ${thr}<path d="${area}" fill="rgba(246,248,251,.08)"/><path d="${path}" fill="none" stroke="var(--hi)" stroke-width="1.5"/>
    <circle cx="${X(pts[pts.length - 1].t)}" cy="${Y(pts[pts.length - 1].y)}" r="2.5" fill="var(--hi)"/></svg>
    <div class="meta">${useP ? 'progress %' : esc(it.unit || 'value')} · ${pts.length} points${tr.length ? ` (${tr.length} per-minute)` : ''}</div>`;
}

function renderDrawerLive() {
  const it = itemFor(S.drawer);
  const live = $('#live');
  if (it && live) {
    live.innerHTML = liveHTML(it);
    renderChart();
  }
}

function renderDrawer() {
  const d = $('#drawer');
  const it = itemFor(S.drawer);
  if (!it) return closeDrawer();
  S.pendingKind = null;
  if (d.contains(document.activeElement) && document.activeElement !== d && document.activeElement.tagName !== 'BUTTON') {
    S.drawerDirty = true;
    if (it.type === 'monitor') renderDrawerLive();
    return;
  }
  const scroll = d.scrollTop;
  d.innerHTML = drawerHTML(it);
  applyReadonlyControls(d);
  for (const [selector, value] of S.drafts.get(it.id) || []) {
    const input = d.querySelector(selector);
    if (input) input.value = value;
  }
  d.scrollTop = scroll;
  if (it.type === 'monitor') renderChart();
  if (it.type === 'ticket') fillClaim(it);
  if (S.contextFor !== it.id) {
    S.contextFor = it.id;
    S.contextKind = 'all';
  }
  fillContext(it);
  S.drawerDirty = false;
}

async function fillClaim(it) {
  const box = $('#claim-box');
  if (!box) return;
  let c = S.claimCache.get(it.id);
  if (c === undefined) {
    c = await optionalGET(`/api/items/${encodeURIComponent(it.id)}/claim`);
    S.claimCache.set(it.id, c || null);
  }
  if (!box.isConnected) return;
  const prev = S.claims.get(it.id)?.actor || '';
  if (c) S.claims.set(it.id, c);
  else S.claims.delete(it.id);
  if (prev !== (c?.actor || '') && S.mode === 'list') scheduleList();
  const left = c ? Math.max(0, Math.round((c.expiresAt - Date.now()) / 1000)) : 0;
  box.innerHTML = c
    ? `<span class="claim-state held" title="session ${esc(c.session)} · lease ${c.live ? `${left}s left` : 'expired'}">⊕ ${esc(c.actor)} is on it</span>${c.session === 'user' ? `<button class="btn sm" data-release="${esc(it.id)}">release</button>` : ''}`
    : `<span class="claim-state">⊕ unclaimed</span><button class="btn sm" data-claim="${esc(it.id)}">claim</button>`;
}

function scopeFor(it) {
  if (it.type === 'ticket' && (it.tags || []).some((t) => String(t).toLowerCase() === 'run')) return `run:${it.id}`;
  // agents publish on the board or run scope and ref the ticket; a ticket shows what refs it, from any scope
  if (it.type === 'ticket') return `ref:${it.id}`;
  if (it.type === 'project') return `project:${it.id}`;
  return `board:${it.board}`;
}

function contextWhere(it) {
  if (it.type === 'ticket' && (it.tags || []).some((t) => String(t).toLowerCase() === 'run')) return 'this run';
  if (it.type === 'project') return 'this project';
  if (it.type === 'ticket' && it.project) {
    const project = itemFor(it.project);
    return project ? `project ${project.key || project.title || project.id}` : 'this project';
  }
  return 'this board';
}

function contextName(id) {
  const item = itemFor(id);
  return item ? identOf(item) : id;
}

async function readContextPage(scope, since) {
  const q = new URLSearchParams(scope.startsWith('ref:') ? { ref: scope.slice(4), limit: '1000' } : { scope, limit: '1000' });
  if (since != null) q.set('since', String(since));
  return optionalGET(`/api/context?${q}`);
}

async function fillContext(it) {
  const box = $('#context-box');
  if (!box) return;
  const scope = scopeFor(it);
  let data = S.contextCache.get(scope);
  if (!data) {
    data = await loadContextPages((since) => readContextPage(scope, since));
    if (S.drawer !== it.id) return;
    // Entries from a mid-page miss are not a finished read. Caching them sticks until SSE drops the scope.
    if (contextCacheable(data)) S.contextCache.set(scope, data);
  }
  const host = $('#context-box');
  if (!host || S.drawer !== it.id) return;
  const payload = data || { entries: [], complete: false, newerMissing: true };
  const byRef = scope.startsWith('ref:');
  if (byRef && !(payload.entries || []).length && payload.complete === true) {
    host.innerHTML = '<div class="context-head"><h4>findings</h4></div><div class="faint">No FACT, FAIL or STATUS refers to this ticket yet.</div>';
    return;
  }
  host.innerHTML = renderContextTimeline({
    entries: payload.entries || [],
    filter: S.contextKind || 'all',
    scope: byRef ? 'every scope' : scope,
    where: byRef ? 'about this ticket' : contextWhere(it),
    esc,
    when: (t) => `${ago(t)} · ${localDT(t)}`,
    nameOf: contextName,
    complete: payload.complete === true,
    newerMissing: payload.newerMissing === true,
  });
}

function copyContextHandoff(it) {
  const scope = scopeFor(it);
  const payload = S.contextCache.get(scope);
  if (!contextCacheable(payload)) {
    return toast('newer entries were not loaded — handoff not copied');
  }
  const text = contextHandoff(payload.entries || [], {
    scope,
    title: it.title || identOf(it) || scope,
    now: displayNow(),
    formatTime: (t) => localDT(t),
    nameOf: contextName,
    complete: true,
    newerMissing: false,
  });
  if (!text) return toast('newer entries were not loaded — handoff not copied');
  const preview = text.length > 240 ? `${text.slice(0, 240)}…` : text;
  return (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => toast('handoff copied'), () => toast(preview));
}

const saveText = debounce((id, k, v) => patchItem(id, { [k]: v }).catch(() => {}), 600);

function rememberDraft(e) {
  const t = e.target;
  if (!S.drawer || !t.matches('input,textarea,select')) return;
  let selector = t.id === 'comment-in' ? '#comment-in' : '';
  for (const key of ['k', 'r', 's', 'followup']) if (t.dataset[key] != null) selector = `[data-${key}="${t.dataset[key]}"]`;
  if (t.hasAttribute('data-comment-format')) selector = '[data-comment-format]';
  if (!selector) return;
  if (!S.drafts.has(S.drawer)) S.drafts.set(S.drawer, new Map());
  S.drafts.get(S.drawer).set(selector, t.value);
}
$('#drawer').addEventListener('input', rememberDraft, true);
$('#drawer').addEventListener('change', rememberDraft, true);

const saveUtilLater = debounce((id, key, v) => saveUtil(id, key, v), 350);

$('#drawer').addEventListener('input', (e) => {
  const t = e.target;
  if (!S.drawer) return;
  if (t.id === 'comment-in') {
    const preview = $('#comment-preview');
    if (preview) preview.innerHTML = t.value ? reportHTML(t.value, $('#drawer [data-comment-format]')?.value || 'plain', { readonly: true }) : '';
    return;
  }
  // live-edit a utility's number fields (timer minutes, counter target, sheet size, calculator…)
  if (t.dataset.u) return saveUtilLater(S.drawer, t.dataset.u, t.value);
  const k = t.dataset.k;
  if (k === 'details' && new TextEncoder().encode(t.value).length > 20_000) {
    t.classList.add('invalid');
    setSaveState('failed');
    toast('details must be at most 20KB (UTF-8)');
    return;
  }
  if (k === 'details') t.classList.remove('invalid');
  if (k === 'title' || k === 'body' || k === 'text' || k === 'details') setSaveState('pending');
  if (k === 'title' || k === 'body' || k === 'text' || k === 'details') saveText(S.drawer, k, t.value);
});
$('#drawer').addEventListener('change', (e) => {
  const t = e.target;
  if (!S.drawer) return;
  if (t.dataset.commentFormat !== undefined) {
    const box = $('#comment-in'), preview = $('#comment-preview');
    if (box && preview) preview.innerHTML = box.value ? reportHTML(box.value, t.value, { readonly: true }) : '';
    return;
  }
  if (t.dataset.p) return savePlot(S.drawer, t.dataset.p, t.value)?.catch(() => {});
  if (t.dataset.u) return saveUtil(S.drawer, t.dataset.u, t.value)?.catch(() => {});
  const k = t.dataset.k;
  if (!k) return;
  let v = t.value;
  if (['warnAbove', 'errorAbove', 'warnBelow', 'errorBelow', 'max', 'staleAfter'].includes(k)) v = numOrNull(v);
  if (k === 'target' && !v) v = null;
  if (k === 'tags' || k === 'notify' || k === 'monitors' || k === 'blockedBy' || k === 'refs') v = v.split(',').map((s) => s.trim()).filter(Boolean);
  patchItem(S.drawer, { [k]: v }).catch(() => {});
});

/** plot options are typed loosely (numbers, "on"/"off") — coerce the ones the renderers expect */
function savePlot(id, key, raw) {
  const it = S.items.get(id);
  if (!it) return;
  const plot = { ...(it.plot || {}) };
  const numeric = ['bins', 'tilt', 'spin', 'yMin', 'yMax'];
  const v = raw === '' ? undefined : numeric.includes(key) ? numOrNull(raw) : raw;
  if (v === undefined || v === null) delete plot[key];
  else if (key === 'points') plot.points = v === 'on';
  else if (key === 'animate' && v === 'none') delete plot.animate;
  else plot[key] = v;
  return patchItem(id, { plot });
}

/** switching a utility's kind swaps in that kind's defaults; `text` survives (sheet cells, markdown body) */
function setUtilKind(id, kind) {
  const it = S.items.get(id);
  if (!it || it.type !== 'util' || !UTIL_KINDS.includes(kind)) return;
  if (it.kind === kind) return;
  return patchItem(id, { kind, util: defaultUtil(kind) }).then(() => renderDrawer(), () => {});
}

function saveUtil(id, key, raw) {
  const it = S.items.get(id);
  if (!it) return;
  const util = { ...(it.util || {}) };
  const numeric = ['seconds', 'value', 'step', 'target', 'sides', 'rows', 'cols'];
  let v = raw === '' ? undefined : numeric.includes(key) ? numOrNull(raw) : raw;
  if (v != null && (key === 'rows' || key === 'cols')) v = clamp(Math.floor(v), 1, key === 'rows' ? 500 : 52); // sheets render rows x cols cells
  if (v === undefined || v === null) delete util[key];
  else if (key === 'seconds') {
    util.seconds = Math.max(1, Number(v)) * 60;
    if (!util.running) util.remaining = util.seconds;
  } else util[key] = v;
  // the calculator evaluates as you type; a bad expression is reported, not thrown
  if (it.kind === 'calculator' && key === 'expr') {
    const expr = String(util.expr ?? '').trim();
    if (!expr) {
      delete util.result;
      delete util.note;
    } else {
      try {
        const r = evaluate(expr);
        util.result = typeof r === 'number' ? Number(r.toFixed(8)) : r;
        delete util.note;
        const line = `${expr} = ${util.result}`;
        const hist = (util.history || []).filter((h) => h !== line);
        util.history = [...hist, line].slice(-12);
      } catch (err) {
        delete util.result;
        util.note = err.message;
      }
    }
  }
  return patchItem(id, { util });
}
async function sendComment() {
  const id = S.drawer;
  const box = $('#drawer #comment-in');
  if (!id || !box || !box.value.trim()) return;
  const text = box.value.trim();
  const format = $('#drawer [data-comment-format]')?.value || 'plain';
  box.disabled = true;
  setSaveState('saving');
  try {
    await api('POST', `/api/items/${encodeURIComponent(id)}/comments`, { text, format });
    S.drafts.get(id)?.delete('#comment-in');
    box.value = '';
    box.disabled = false;
    box.blur();
    await fetchDetail(id);
    toast('recorded; agent response pending');
    renderDrawer();
    setSaveState('saved');
  } catch {
    setSaveState('failed');
    box.disabled = false;
  }
}
$('#drawer').addEventListener('focusout', () => {
  setTimeout(() => {
    if (S.drawerDirty && !$('#drawer').contains(document.activeElement)) renderDrawer();
  }, 0);
});
$('#drawer').addEventListener('keydown', (e) => {
  if (e.target.id === 'comment-in' && e.target.tagName === 'INPUT' && e.key === 'Enter' && e.target.value.trim()) {
    e.preventDefault();
    sendComment();
  }
  if (e.target.id === 'comment-in' && e.target.tagName === 'TEXTAREA' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    sendComment();
  }
  if (e.target.dataset.r !== undefined && e.key === 'Enter') pushReading();
  if (e.target.tagName === 'INPUT' && e.target.dataset.k && e.key === 'Enter') e.target.blur();
});

function pushReading(stateOverride) {
  const it = S.items.get(S.drawer);
  const r = {};
  const val = $('#drawer [data-r="value"]').value;
  const msg = $('#drawer [data-r="message"]').value;
  const prog = $('#drawer [data-r="progress"]').value;
  const lab = $('#drawer [data-r="label"]').value;
  if (lab !== (it.label ?? '')) r.label = lab;
  if (val !== fmtRaw(it.value)) r.value = parseVal(val);
  if (msg !== (it.message ?? '')) r.message = msg;
  if (prog !== fmtRaw(it.progress)) r.progress = numOrNull(prog);
  if (stateOverride) r.state = stateOverride;
  if (!Object.keys(r).length) r.value = parseVal(val);
  const drafts = new Map($$('#drawer [data-r]').map((el) => [`[data-r="${el.dataset.r}"]`, el.value]));
  document.activeElement?.blur();
  setSaveState('saving');
  return api('POST', `/api/monitors/${encodeURIComponent(it.id)}/push`, r).then((updated) => {
    S.items.set(updated.id, lite(updated));
    for (const [selector, value] of drafts) if (S.drafts.get(it.id)?.get(selector) === value) S.drafts.get(it.id).delete(selector);
    renderDrawer();
    setSaveState('saved');
  }).catch(() => setSaveState('failed'));
}

/** the chip click only stages a kind (S.pendingKind) until its required fields exist; "apply source" saves it */
function applySource(kind) {
  const it = S.items.get(S.drawer);
  const cur = it.source || { kind: 'manual' };
  if (kind) S.pendingKind = kind;
  const src = { kind: kind || S.pendingKind || cur.kind };
  if (!kind) {
    for (const el of $$('#drawer [data-s]')) {
      const k = el.dataset.s;
      let v = el.value.trim();
      if (!v) continue;
      if (['interval', 'timeout', 'expectStatus', 'period', 'grace'].includes(k)) v = Number(v);
      if (k === 'config' || k === 'headers') {
        try {
          v = JSON.parse(v);
        } catch {
          return toast(`${k} must be JSON`);
        }
      }
      src[k] = v;
    }
  } else {
    for (const k of ['command', 'cwd', 'url', 'method', 'expectStatus', 'jsonPath', 'probe', 'config', 'interval', 'timeout', 'period', 'grace', 'headers', 'contains']) if (cur[k] !== undefined) src[k] = cur[k];
  }
  if (src.kind === 'command' && !src.command) return renderDrawerWith({ ...it, source: src });
  if (src.kind === 'http' && !src.url) return renderDrawerWith({ ...it, source: src });
  if (src.kind === 'probe' && !src.probe) return renderDrawerWith({ ...it, source: src });
  document.activeElement?.blur();
  return patchItem(it.id, { source: src }).then(() => {
    S.pendingKind = null;
    for (const selector of S.drafts.get(it.id)?.keys() || []) if (selector.startsWith('[data-s=')) S.drafts.get(it.id).delete(selector);
    renderDrawer();
    toast(`source → ${src.kind}`);
  }).catch(() => {});
}
function renderDrawerWith(fake) {
  // show fields for a kind that isn't saved yet
  $('#drawer').innerHTML = drawerHTML(fake);
  $('#drawer [data-s]')?.focus();
}

$('#drawer').addEventListener('click', (e) => {
  const it = itemFor(S.drawer);
  if (!it) return;
  const jump = e.target.closest('[data-jump]');
  if (jump) return $('#drawer [data-section="' + jump.dataset.jump + '"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const claimBtn = e.target.closest('[data-claim]');
  if (claimBtn) return claimTicket(claimBtn.dataset.claim).then(() => { S.claimCache.delete(claimBtn.dataset.claim); renderDrawer(); });
  const releaseBtn = e.target.closest('[data-release]');
  if (releaseBtn) return releaseTicket(releaseBtn.dataset.release).then(() => { S.claimCache.delete(releaseBtn.dataset.release); renderDrawer(); });
  if (e.target.closest('[data-report-more]')) {
    e.stopPropagation();
    return e.target.closest('[data-report-more]').previousElementSibling?.classList.toggle('expanded');
  }
  if (e.target.closest('[data-overview-decide]')) {
    const b = e.target.closest('[data-overview-decide]');
    return decide(it.id, b.dataset.overviewDecide, b.dataset.label, b.dataset.decisionVersion);
  }
  if (e.target.closest('[data-run-summary-open]')) {
    return openItemDeepLink(e.target.closest('[data-run-summary-open]').dataset.runSummaryOpen);
  }
  if (e.target.closest('[data-act="followup"]')) return createFollowup(it);
  if (e.target.closest('[data-act="comment-send"]')) return sendComment();
  const chip = e.target.closest('.chip');
  if (chip) {
    const key = chip.parentElement.dataset.chips;
    const v = chip.dataset.v;
    if (key === 'r-state') return pushReading(v);
    // "kind" means two different things: a monitor's source kind, a util's tool kind
    if (key === 'kind') return it.type === 'util' ? setUtilKind(it.id, v) : applySource(v);
    if (key === 'autoStatus') return patchItem(it.id, { autoStatus: v === 'on' }).then(() => renderDrawer(), () => {});
    if (key === 'range') {
      S.chartRange = v;
      return renderChart();
    }
    if (key === 'context-kind') {
      S.contextKind = v || 'all';
      return fillContext(it);
    }
    // plot option chips are namespaced: "plot-points" -> plot.points
    if (key.startsWith('plot-')) return savePlot(it.id, key.slice(5), v).then(() => renderDrawer(), () => {});
    return patchItem(it.id, { [key]: v || null }).then(() => renderDrawer(), () => {});
  }
  const go = e.target.closest('[data-go]');
  if (go) return focusItem(go.dataset.go);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') closeDrawer();
  if (act === 'expand') {
    S.drawerWide = !S.drawerWide;
    document.body.classList.toggle('drawer-wide', S.drawerWide);
    return renderDrawer();
  }
  if (act === 'focus') focusItem(it.id);
  if (act === 'delete') deleteItems([it.id]);
  if (act === 'copy') {
    const txt = e.target.closest('[data-text]').dataset.text;
    return (navigator.clipboard?.writeText(txt) ?? Promise.reject()).then(() => toast('copied'), () => toast(txt));
  }
  if (act === 'copy-handoff') return copyContextHandoff(it);
  if (act === 'cdel' || act === 'cedit' || act === 'csave' || act === 'ccancel') return commentAct(it, act, e.target.closest('.comment'));
  if (act === 'push') pushReading();
  if (act === 'apply-source') applySource();
  if (act === 'approve-command') return approveDrawerCommand(it);
  if (act === 'run') api('POST', `/api/monitors/${encodeURIComponent(it.id)}/run`).then(() => toast('ran ' + it.id), (e) => toast(e.message, 5000));
  if (act === 'arrange') api('POST', '/api/arrange', { frame: it.id }).catch(() => {});
  if (act === 'organize') organize();
  if (act === 'fit-frame') fit([it]);
  if (act === 'decide') { const b = e.target.closest('[data-opt]'); decide(it.id, b.dataset.opt, b.textContent, b.dataset.decisionVersion); }
  if (act === 'clear-options') patchItem(it.id, { options: [] }).then(() => renderDrawer(), () => {});
  if (act === 'reopen') patchItem(it.id, { options: it.options, question: it.question }).then(() => renderDrawer(), () => {});
});

function commentAct(it, act, box) {
  const cid = box?.dataset.cid;
  if (!cid) return;
  const url = `/api/items/${encodeURIComponent(it.id)}/comments/${encodeURIComponent(cid)}`;
  const c = (it.comments || []).find((x) => x.id === cid);
  if (act === 'cdel') {
    if (!confirm('delete this comment?')) return;
    return api('DELETE', url).then(() => {
      const base = S.items.get(it.id);
      if (base) base.comments = (base.comments || []).filter((x) => x.id !== cid);
      renderDrawer();
      renderItem(base || it);
    }, () => {});
  }
  if (act === 'cedit') {
    box.querySelector('.txt').innerHTML = `<textarea>${esc(c?.text ?? '')}</textarea><div class="format-row"><select data-comment-edit-format><option value="plain">plain</option><option value="markdown">markdown</option></select></div><div class="btns"><button class="btn" data-act="csave">save</button><button class="btn" data-act="ccancel">cancel</button></div>`;
    const select = box.querySelector('[data-comment-edit-format]');
    if (select) select.value = c?.format || 'plain';
    return box.querySelector('textarea').focus();
  }
  if (act === 'ccancel') return renderDrawer();
  const text = box.querySelector('textarea').value.trim();
  if (!text) return;
  const format = box.querySelector('[data-comment-edit-format]')?.value || c?.format || 'plain';
  api('PATCH', url, { text, format }).then((u) => {
    if (c) Object.assign(c, u);
    document.activeElement?.blur();
    renderDrawer();
  }, () => {});
}

async function createFollowup(it) {
  const title = $('#drawer [data-followup="title"]')?.value.trim();
  if (!title) return toast('follow-up title is required');
  const assignee = $('#drawer [data-followup="assignee"]')?.value.trim();
  const parent = $('#drawer [data-followup="parent"]')?.value.trim();
  const refs = ($('#drawer [data-followup="refs"]')?.value || '').split(',').map((x) => x.trim()).filter(Boolean);
  const payload = { type: 'ticket', board: it.board, title, status: 'todo', ...(assignee ? { assignee } : {}), ...(parent ? { parent } : {}), ...(refs.length ? { refs } : {}) };
  try {
    const follow = lite(await api('POST', '/api/items', payload));
    S.items.set(follow.id, follow);
    if (follow.board !== S.board) { rememberBoard(follow.board); switchBoard(follow.board); toastBoardCreated(follow); }
    updateChrome();
    toast('recorded; agent response pending');
    openDrawer(follow.id);
  } catch {}
}

// ---------------------------------------------------------------- delete / undo
async function deleteItems(ids) {
  ids = ids.filter((id) => S.items.has(id));
  if (!ids.length) return;
  const snapshot = new Map(ids.map((id) => [id, S.items.get(id)]));
  for (const id of ids) {
    removeEl(id);
    S.items.delete(id);
    if (S.drawer === id) closeDrawer();
  }
  S.sel.clear();
  refreshDerived();
  updateChrome();
  // deletes go to the server trash, so undo (and agents, and a reload) can bring them back
  const res = await Promise.allSettled(ids.map((id) => api('DELETE', `/api/items/${encodeURIComponent(id)}`)));
  const ok = ids.filter((_, i) => res[i].status === 'fulfilled');
  const failed = ids.filter((_, i) => res[i].status === 'rejected');
  for (const id of failed) {
    S.items.set(id, snapshot.get(id)); // the server refused: put it back
    renderItem(snapshot.get(id));
  }
  if (failed.length) {
    refreshDerived();
    updateChrome();
  }
  if (ok.length) {
    S.undo.push(ok);
    if (S.undo.length > 20) S.undo.shift();
    renderTrash();
    toast(`deleted ${ok.length} · u to undo${failed.length ? ` (${failed.length} failed)` : ''}`, 4000);
  }
}
async function undoDelete() {
  const ids = S.undo.pop();
  if (!ids) return toast('nothing to undo');
  setTimeout(renderTrash, 300);
  const left = [];
  let n = 0;
  for (const id of ids) {
    try {
      const it = lite(await api('POST', `/api/trash/${encodeURIComponent(id)}/restore`));
      if (it?.id) S.items.set(it.id, it);
      n++;
    } catch {
      left.push(id); // keep it on the stack so a retry is possible
    }
  }
  if (left.length) S.undo.push(left);
  renderAll();
  toast(left.length ? `restored ${n}, ${left.length} failed` : `restored ${n}`);
}

// ---------------------------------------------------------------- trash
async function renderTrash() {
  const panel = $('#trash');
  if (!panel.classList.contains('open')) return;
  const list = panel.querySelector('.list');
  let rows;
  try {
    rows = await api('GET', `/api/trash?board=${encodeURIComponent(S.board)}`);
  } catch {
    return;
  }
  rows = [...rows].sort((a, b) => b.t - a.t);
  list.innerHTML =
    rows
      .map((r) => {
        const it = r.item;
        const name = it.type === 'ticket' ? `${identOf(it)} ` : '';
        return `<div class="trw" data-tid="${esc(it.id)}"><span class="dim">${esc(it.type)}</span><span class="tt" title="${esc(it.title || it.id)}">${esc(name)}${esc(it.title || it.text?.slice(0, 40) || it.id)}</span><span class="dim">@${esc(r.actor)} ${ago(r.t)}</span><button class="btn sm" data-restore>restore</button><button class="btn sm danger" data-purge>delete</button></div>`;
      })
      .join('') || '<div class="trw"><span class="faint">trash is empty</span></div>';
}
function toggleTrash(on) {
  const p = $('#trash');
  on = on ?? !p.classList.contains('open');
  p.classList.toggle('open', on);
  $('#btn-trash').classList.toggle('on', on);
  renderTrash();
}
$('#btn-trash').addEventListener('click', () => toggleTrash());
$('#trash').addEventListener('click', async (e) => {
  if (e.target.closest('[data-close]')) return toggleTrash(false);
  if (e.target.closest('[data-purge-all]')) {
    if (!confirm('permanently delete everything in the trash?')) return;
    await api('DELETE', '/api/trash').catch(() => {});
    return renderTrash();
  }
  const id = e.target.closest('[data-tid]')?.dataset.tid;
  if (!id) return;
  if (e.target.closest('[data-restore]')) {
    try {
      const it = lite(await api('POST', `/api/trash/${encodeURIComponent(id)}/restore`));
      if (it?.id) S.items.set(it.id, it);
      renderAll();
      toast('restored');
    } catch {}
  } else if (e.target.closest('[data-purge]')) {
    if (!confirm('permanently delete this item? this cannot be undone')) return;
    await api('DELETE', `/api/trash/${encodeURIComponent(id)}`).catch(() => {});
  }
  renderTrash();
});

// ---------------------------------------------------------------- organize / alerts
async function organize() {
  const r = await api('POST', '/api/organize', { board: S.board }).catch(() => null);
  if (r) { fit(); toast(`organized · ${r.groups.length} groups · ${r.moved} moved`); }
}
async function toggleAuto(on) {
  const b = S.boards.find((x) => x.id === S.board);
  on = on ?? !b?.autoOrganize;
  const nb = await api('PATCH', `/api/boards/${encodeURIComponent(S.board)}`, { autoOrganize: on });
  upsertBoard(nb);
  renderBoardButtons();
  toast(`auto-organize ${on ? 'on' : 'off'} for ${S.board}`);
}
function renderBoardButtons() {
  const b = S.boards.find((x) => x.id === S.board);
  $('#btn-auto').classList.toggle('on', !!b?.autoOrganize);
  $('#btn-auto').textContent = `auto layout · ${b?.autoOrganize ? 'on' : 'off'}`;
  const name = $('#board-name');
  if (name) name.textContent = b?.name || S.board || 'workspace';
}
$('#btn-organize').addEventListener('click', () => organize());
$('#btn-auto').addEventListener('click', () => toggleAuto());
$('#btn-fit').addEventListener('click', () => fit());
for (const [id, factor] of [['zoom-in', 1.2], ['zoom-out', 1 / 1.2]]) {
  $('#' + id).addEventListener('click', () => {
    const r = canvas.getBoundingClientRect(), v = viewport();
    zoomAt(r.left + v.w / 2, r.top + v.h / 2, S.view.z * factor);
  });
}

// ---------------------------------------------------------------- activity
function renderActivity(newId) {
  const panel = $('#activity');
  if (!panel.classList.contains('open')) return;
  const list = panel.querySelector('.list');
  const acts = S.activity.filter((a) => !a.board || a.board === S.board).slice(-200).reverse();
  list.innerHTML =
    acts.map((a) => `<div class="act ${a.id === newId ? 'new' : ''}" ${a.itemId ? `data-go="${esc(a.itemId)}"` : ''}><span class="tm">${hhmmss(a.t)}</span><span><span class="a">@${esc(a.actor)}</span> ${esc(a.text)}</span></div>`).join('') ||
    '<div class="act"><span></span><span class="faint">nothing yet</span></div>';
}
$('#activity').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return toggleActivity(false);
  const go = e.target.closest('[data-go]');
  if (go && S.items.has(go.dataset.go)) focusItem(go.dataset.go);
});
function toggleActivity(on) {
  const p = $('#activity');
  on = on ?? !p.classList.contains('open');
  p.classList.toggle('open', on);
  $('#btn-activity').classList.toggle('on', on);
  if (!CAPTURE_READONLY) try { localStorage.setItem('hud.activity', on ? '1' : '0'); } catch {}
  renderActivity();
}
$('#btn-activity').addEventListener('click', () => toggleActivity());


// ---------------------------------------------------------------- help
const HELP = `<b>hud</b> — what your agents are doing, and what needs you

<b>two views</b>  (the toggle in the top bar, or l)
  Tasks       the live ticket tree: gray todo · yellow in progress · green done · red blocked
              a ring is an agent holding the ticket · a ripple is a new finding · click a node for details
  Monitors    charts and readings; drag to pan, ⌘/ctrl + scroll to zoom, . to fit

<b>top bar</b>
  workspace ▾   switch, add, rename, clear       ● need you   questions, approvals, errors (A)
  search        everything (⌘/ctrl + k)          ⋯            agents, activity, sources, trash, help

<b>keys</b>
  l                 Tasks / Monitors           [ ]        previous / next workspace
  t                 new ticket                 m n f w    new monitor / note / frame / widget
  ⏎                 open selected              ⌫          delete selected (to trash)
  u  or  ⌘/ctrl + z undo delete                v          cycle a monitor's chart
  o  /  O           organize monitors / auto   esc        close
  ?                 this help

<b>agents</b>
  MCP     hud mcp install · hud mcp reconnect (/mcp in Claude Code)
  CLI     hud ls · hud queue · hud guide decentralized
  HTTP    GET /api/guide

esc to close`;
function toggleHelp(on) {
  const h = $('#help');
  on = on ?? !h.classList.contains('open');
  h.classList.toggle('open', on);
  if (on) h.innerHTML = `<pre>${HELP}</pre>`;
}
$('#btn-help').addEventListener('click', () => toggleHelp());
$('#help').addEventListener('click', () => toggleHelp(false));


const TYPE_ALIAS = { t: 'ticket', ticket: 'ticket', m: 'monitor', monitor: 'monitor', n: 'note', note: 'note', f: 'frame', frame: 'frame', u: 'util', util: 'util' };

/**
 * Live leases for ownership marks. Same shape as claimsList({ session?, board? }) → { items, now }.
 * Omit session so every lease on the board stays visible. A session filter must not replace that map.
 */
function loadClaims(filter = {}) {
  if (CAPTURE_READONLY) return;
  const board = filter.board || S.board;
  if (!board) return;
  const session = filter.session ? String(filter.session) : '';
  const q = new URLSearchParams({ board });
  if (session) q.set('session', session);
  const epoch = S.claimsEpoch;
  optionalGET(`/api/claims?${q}`).then((data) => {
    if (!data || S.board !== board) return;
    if (session) return;
    // an SSE claim landed after this request left; the body is already stale
    if (S.claimsEpoch !== epoch) return loadClaims({ board });
    const at = Number(data.now);
    if (Number.isFinite(at) && at < S.claimsNow) return;
    if (Number.isFinite(at)) S.claimsNow = at;
    S.claims = new Map((Array.isArray(data.items) ? data.items : []).map((c) => [c.ticket, c]));
    S.claimsReady = true;
    if (S.mode === 'list') scheduleList();
  });
}

// ---------------------------------------------------------------- Linear-style list view
// The canvas is for spatial work; this is for reading and editing tickets the way a tracker does:
// projects → status → tickets, with sub-tickets nested and blockers/branches called out. No coords.
const LIST_ORDER = ['blocked', 'doing', 'review', 'todo', 'backlog', 'done', 'canceled'];

function setMode(m) {
  S.mode = m === 'list' ? 'list' : 'canvas';
  S.sel.clear();
  for (const el of els.values()) el.classList.remove('sel');
  document.body.classList.toggle('list', S.mode === 'list');
  renderViewToggle();
  if (!CAPTURE_READONLY) try { localStorage.setItem('hud.mode.' + S.board, S.mode); } catch {}
  if (S.page === 'board') { ensureBoardProgramHost(); updateChrome(); queueProgramsMount(); }
  if (S.mode === 'list') renderList();
  else setModeCanvas();
}
function setModeCanvas() {
  // the canvas lazily sizes itself; nudge it so a switch back from the list is not blank
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

let listRaf = 0;
/** coalesce bursts of events into one list rebuild per frame */
function scheduleList() {
  if (listRaf) return;
  listRaf = requestAnimationFrame(() => {
    listRaf = 0;
    renderList();
  });
}

const LF_DEFAULT = { q: '', status: '', assignee: '', project: '', priority: '', tag: '', overdue: false, completed: false, hideDone: false, sort: 'status' };
const lfKey = () => `hud.lf.${S.board}`;
function lfGet() {
  if (S.lf?.board === S.board) return S.lf.f;
  let f = {};
  try {
    f = JSON.parse(localStorage.getItem(lfKey()) || '{}') || {};
  } catch {}
  const shape = ['list', 'tree'].includes(f.shape) ? f.shape : 'tree';
  S.lf = { board: S.board, f: { ...LF_DEFAULT, ...f, shape } };
  return S.lf.f;
}
function lfSet(patch) {
  const f = Object.assign(lfGet(), patch);
  if (!CAPTURE_READONLY) try { localStorage.setItem(lfKey(), JSON.stringify(f)); } catch {}
  renderList();
}
const lfActive = (f) => !!(f.q || f.status || f.assignee || f.project || f.priority || f.tag || f.overdue);
const PRIO_RANK = { urgent: 4, high: 3, med: 2, low: 1 };
function lfMatch(t, f, projectsById) {
  if (!f.completed && !f.status && !f.q && ['done', 'canceled'].includes(t.status)) return false;
  if (f.status && (t.status || 'todo') !== f.status) return false;
  if (f.assignee && (t.assignee || '') !== (f.assignee === '-' ? '' : f.assignee)) return false;
  if (f.project && (t.project && projectsById.has(t.project) ? t.project : '-') !== f.project) return false;
  if (f.priority && (t.priority || '') !== (f.priority === '-' ? '' : f.priority)) return false;
  if (f.tag && !(t.tags || []).includes(f.tag)) return false;
  if (f.overdue && !isOverdue(t)) return false;
  if (f.q) {
    const hay = `${t.id} ${t.uuid || ''} ${identOf(t)} ${t.title || ''} ${t.body || ''} ${t.assignee || ''} ${(t.tags || []).join(' ')}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}
function lfSort(list, f) {
  const rank = (t) => LIST_ORDER.indexOf(t.status || 'todo');
  const cmp = {
    status: (a, b) => rank(a) - rank(b),
    priority: (a, b) => (PRIO_RANK[b.priority] || 0) - (PRIO_RANK[a.priority] || 0),
    updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    target: (a, b) => (a.target ? 0 : 1) - (b.target ? 0 : 1) || String(a.target || '').localeCompare(String(b.target || '')),
  }[f.sort] || (() => 0);
  return [...list].sort(cmp);
}
function renderFilterBar(all, projects) {
  const bar = $('#list .lfbar');
  const f = lfGet();
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
  const sel = (k, label, opts) => `<select data-f="${k}"><option value="">${label}</option>${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
  const chips = `<span class="pchips" role="tablist" aria-label="projects">${[['*', 'all'], ...projects.map((p) => [p.id, p.key || p.title])].map(([v, l]) => `<button type="button" class="btn sm pchip" data-proj-switch="${esc(v)}" role="tab">${esc(l)}</button>`).join('')}</span>`;
  const SHAPE_ICON = { tree: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="3.5" rx="1.2"/><rect x="1" y="11" width="5" height="3.5" rx="1.2"/><rect x="10" y="11" width="5" height="3.5" rx="1.2"/><path d="M8 5v3M3.5 11V8h9v3"/></svg>', list: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5h9M5.5 8h9M5.5 12.5h9"/><circle cx="2.2" cy="3.5" r=".9"/><circle cx="2.2" cy="8" r=".9"/><circle cx="2.2" cy="12.5" r=".9"/></svg>' };
  const shapes = `<span class="shapes" role="tablist" aria-label="tasks layout">${['tree', 'list'].map((v) => `<button type="button" class="btn sm" data-shape="${v}" role="tab" title="${v}" aria-label="${v}">${SHAPE_ICON[v]}</button>`).join('')}</span>`;
  const extra = [f.status, f.assignee, f.priority, f.tag, f.overdue, f.completed, f.sort !== 'status'].filter(Boolean).length;
  const html = [
    chips,
    shapes,
    `<button class="btn sm" data-f-hidedone title="hide finished branches of the tree">hide done</button>`,
    `<button class="btn sm" data-f-toggle aria-expanded="${!!S.lfOpen}" title="status, assignee, priority, tag, sort">filter${extra ? ` · ${extra}` : ''}</button>`,
    '<span class="lf-adv">',
    sel('status', 'status', STATUSES.map((s) => [s, s])),
    sel('assignee', 'assignee', [['-', '(none)'], ...uniq(all.map((t) => t.assignee)).map((a) => [a, a])]),
    sel('project', 'project', [['-', '(none)'], ...projects.map((p) => [p.id, p.key || p.title])]),
    sel('priority', 'priority', [['urgent', 'urgent'], ['high', 'high'], ['med', 'med'], ['low', 'low'], ['-', '(none)']]),
    sel('tag', 'tag', uniq(all.flatMap((t) => t.tags || [])).map((a) => [a, '#' + a])),
    `<label data-f-overdue title="only overdue tickets">‼ overdue</label>`,
    `<button class="btn sm" data-f-completed title="include done and canceled tickets">completed ${all.filter(t => ['done', 'canceled'].includes(t.status)).length}</button>`,
    `<select data-f="sort" title="sort"><option value="status">sort: status</option><option value="priority">sort: priority</option><option value="updated">sort: updated</option><option value="target">sort: target</option></select>`,
    `<button class="btn sm" data-f-clear>clear</button>`,
    '</span>',
  ].join('');
  const sig = html;
  if (bar.dataset.sig !== sig) {
    const focus = document.activeElement?.dataset?.f;
    bar.dataset.sig = sig;
    bar.innerHTML = `<input type="search" data-f="q" placeholder="search tickets ( / )" spellcheck="false">${html}`;
    if (focus) bar.querySelector(`[data-f="${focus}"]`)?.focus();
  }
  bar.classList.toggle('lf-open', !!S.lfOpen);
  for (const c of $$('[data-f]', bar)) if (c.value !== (f[c.dataset.f] ?? '')) c.value = f[c.dataset.f] ?? '';
  $('[data-f-overdue]', bar).classList.toggle('on', f.overdue);
  $('[data-f-completed]', bar).classList.toggle('on', f.completed);
  $('[data-f-completed]', bar).setAttribute('aria-pressed', String(f.completed));
  $('[data-f-clear]', bar).style.display = lfActive(f) || f.sort !== 'status' ? '' : 'none';
  const projectOn = f.project || '*';
  const shape = ['list', 'tree'].includes(f.shape) ? f.shape : 'tree';
  for (const c of $$('[data-proj-switch]', bar)) {
    const on = c.dataset.projSwitch === projectOn;
    c.classList.toggle('on', on);
    c.setAttribute('aria-selected', String(on));
  }
  for (const c of $$('[data-shape]', bar)) {
    const on = c.dataset.shape === shape;
    c.classList.toggle('on', on);
    c.setAttribute('aria-selected', String(on));
  }
  const hideDone = $('[data-f-hidedone]', bar);
  hideDone.hidden = shape !== 'tree';
  hideDone.classList.toggle('on', !!f.hideDone);
  hideDone.setAttribute('aria-pressed', String(!!f.hideDone));
}

function renderList() {
  const el = $('#list');
  if (S.mode !== 'list') return;
  // an open inline "new ticket/project" input must survive; the list catches up once it closes
  if (el.querySelector('.creating, .pnew')) return;
  if (!el.querySelector('.lfbar')) el.innerHTML = '<div class="lfbar"></div><div class="lbody"></div>';
  const host = $('.lbody', el);
  const items = boardItems();
  const projects = items.filter((i) => i.type === 'project').sort((a, b) => (a.key || '').localeCompare(b.key || ''));
  const allTickets = items.filter((i) => i.type === 'ticket');
  renderFilterBar(allTickets, projects);
  const f = lfGet();
  const active = lfActive(f);
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const shape = ['list', 'tree'].includes(f.shape) ? f.shape : 'tree';
  // the tree keeps finished work in place: a green branch is progress, not clutter to tuck away
  const tickets = allTickets.filter((t) => lfMatch(t, shape === 'tree' ? { ...f, completed: true } : f, projectsById));
  const ticketIds = new Set(tickets.map((t) => t.id));
  const kidMap = new Map();
  for (const c of tickets) if (c.parent && ticketIds.has(c.parent)) (kidMap.get(c.parent) || kidMap.set(c.parent, []).get(c.parent)).push(c);
  const kidsOf = (id) => kidMap.get(id) || [];
  const isRoot = (t) => !t.parent || !ticketIds.has(t.parent);

  const rowHTML = (t, depth) => {
    const kids = kidsOf(t.id);
    const folded = S.open.has(t.id);
    const bits = [
      t.priority && `<span class="prio-${esc(t.priority)}">!${esc(t.priority)}</span>`,
      t.group && `<span class="tag" title="group">${esc(t.group)}</span>`,
      targetHTML(t),
      t.blockedBy?.length && `<span class="dep">⊘ ${t.blockedBy.map((b) => esc(nameOf(b))).join(', ')}</span>`,
      t.refs?.length && `<span class="dim">⇒ ${t.refs.map((r) => esc(nameOf(r))).join(', ')}</span>`,
      t.monitors?.length && `<span class="dim">⇢ ${t.monitors.map((m) => esc(m)).join(', ')}</span>`,
      t.comments?.length && `<span class="dim">${t.comments.length}c</span>`,
    ].filter(Boolean).join(' ');
    return `<div class="trow s-${esc(t.status || 'todo')}${needsDecision(t) ? ' needs-decision' : ''}" data-open="${esc(t.id)}" tabindex="0" style="--d:${depth}">
      <span class="tg" data-cycle="${esc(t.id)}" title="cycle status">${STATUS_GLYPH[t.status] || '[·]'}</span>
      <span class="tid">${esc(identOf(t))}${copyTicketButton(t)}</span>
      <span class="tcar"${kids.length ? ` data-fold="${esc(t.id)}" title="${folded ? 'expand' : 'collapse'} sub-tickets"` : ''}>${kids.length ? (folded ? '▸' : '▾') : ''}</span>
      <span class="ttt">${esc(t.title) || '<span class="faint">untitled</span>'}</span>
      <span class="town">${ownershipHTML(t)}</span>
      <span class="tbits">${bits}</span>
      <span class="tbr">${esc(t.branch || '')}</span>
    </div>`;
  };
  const tree = (t, depth) => rowHTML(t, depth) + (S.open.has(t.id) ? '' : kidsOf(t.id).map((c) => tree(c, depth + 1)).join(''));
  const statusesOf = (list) => {
    const present = [...new Set(list.map((t) => t.status || 'todo'))];
    return [...LIST_ORDER.filter((x) => present.includes(x)), ...present.filter((x) => !LIST_ORDER.includes(x))];
  };

  const groupHTML = (project, list) => {
    const label = project ? `${esc(project.key || '—')} <span class="pn">${esc(project.title)}</span>` : `<span class="pn">${projects.length ? 'no project' : 'All tickets'}</span>`;
    const meta = project ? [project.target && `→ ${esc(project.target)}`, project.lead && `@${esc(project.lead)}`].filter(Boolean).join(' ') : '';
    const head = `<div class="tproj"${project ? ` data-proj="${esc(project.id)}"` : ''}>
      <span class="pk">${label}</span><span class="pm">${meta}</span>
      <span class="pc">${list.length} ticket${list.length === 1 ? '' : 's'}</span>
      <button class="btn sm" data-new="${esc(project?.id ?? '')}|todo">＋ ticket</button></div>`;
    if (!list.length) return head + `<div class="tnone">${active ? 'no matching tickets' : 'no tickets'}</div>`;
    const out = [head];
    if (shape === 'tree') return head + `<div class="ttree-host" data-tree-key="${esc(project?.id ?? '')}"></div>`;
    if (f.sort !== 'status') {
      // a non-status sort keeps the parent/child nest and skips status buckets
      for (const t of lfSort(list.filter(isRoot), f)) out.push(tree(t, 0));
      return out.join('');
    }
    // canonical statuses first, then anything else a ticket carries, so rows always add up to the totals
    for (const s of statusesOf(list)) {
      const atRoot = lfSort(list.filter((t) => (t.status || 'todo') === s).filter(isRoot), f);
      if (!atRoot.length) continue; // sub-tickets print under their parent, whatever their status
      out.push(`<div class="tstat"><span class="sg">${STATUS_GLYPH[s] || '[·]'}</span> ${esc(s)} <span class="dim">${atRoot.length}</span><button class="btn sm" data-new="${esc(project?.id ?? '')}|${esc(s)}" title="new ${esc(s)} ticket">＋</button></div>`);
      for (const t of atRoot) out.push(tree(t, 0));
    }
    return out.join('');
  };

  const known = new Set(projects.map((p) => p.id));
  const groups = projects.filter((p) => !active || tickets.some((t) => t.project === p.id)).map((p) => ({ project: p, list: tickets.filter((t) => t.project === p.id) }));
  const loose = tickets.filter((t) => !t.project || !known.has(t.project)); // a dangling project id is "no project"

  const html = groups.map((g) => groupHTML(g.project, g.list));
  if (loose.length) html.push(groupHTML(null, loose));
  if (active && !tickets.length) html.push('<div class="tnone">no tickets match — <span class="go" data-f-clear>clear filters</span></div>');
  else if (!projects.length && !loose.length) html.push(`<div class="tnone">${allTickets.length ? 'No active tickets. Use completed above to see finished work.' : 'No tickets yet — add a ticket or project.'}</div>`);
  const out = `<div class="lwrap shape-${shape}">
    <div class="lhead"><span class="dim">${tickets.length === allTickets.length ? `${tickets.length} tickets` : `${tickets.length} of ${allTickets.length} tickets`}</span><button class="btn sm" data-new="|todo">＋ ticket</button><button class="btn sm" data-new-project="1">＋ project</button></div>
    ${html.join('')}
  </div>`;
  if (host.dataset.sig !== out) {
    host.dataset.sig = out;
    host.innerHTML = out;
    applyReadonlyControls(host);
  }
  syncTrees(host, shape === 'tree' ? [...groups.map((g) => [g.project.id, g.list]), ...(loose.length ? [['', loose]] : [])] : [], !!f.hideDone);
}

/** one animated tree per project group, kept across renders so its nodes move instead of being rebuilt */
const trees = new Map();
function syncTrees(host, groups, hideDone = false) {
  const live = new Set();
  for (const [key, list] of groups) {
    const slot = host.querySelector(`.ttree-host[data-tree-key="${CSS.escape(key)}"]`);
    if (!slot) continue;
    live.add(key);
    let tree = trees.get(key);
    if (!tree) trees.set(key, (tree = createTicketTree({ onOpen: (id) => openDrawer(id) })));
    if (tree.el.parentNode !== slot) slot.appendChild(tree.el);
    const notes = new Map((S.queue?.items || []).map((r) => [r.id, r.note]));
    const nodes = list.map((t) => ({
      id: t.id, ident: identOf(t), title: t.title || '', status: t.status || 'todo', parent: t.parent || null,
      blockedBy: t.blockedBy || [], assignee: t.assignee || null, claimer: S.claims.get(t.id)?.actor || null, decision: needsDecision(t), note: notes.get(t.id) || null,
    }));
    tree.update(hideDone ? withoutFinished(nodes) : nodes);
  }
  for (const [key, tree] of trees) if (!live.has(key)) { tree.destroy(); trees.delete(key); }
}

/** inline "new ticket" row — title, ⏎ to create, esc to cancel. No canvas coordinates involved. */
function newTicketInline(anchor, projectId, status) {
  const host = anchor.closest('.tstat') || anchor.closest('.tproj') || $('#list .lhead');
  const existing = host.parentElement.querySelector('.trow.creating');
  if (existing) return existing.querySelector('input').focus();
  const wrap = document.createElement('div');
  wrap.className = 'trow creating';
  wrap.innerHTML = `<span class="tg">${STATUS_GLYPH[status] || '[ ]'}</span><span class="tid">new</span><span class="tcar"></span><input class="tin" placeholder="ticket title — ⏎ create · esc cancel">`;
  const stat = anchor.closest('.tstat');
  if (stat) stat.after(wrap);
  else host.after(wrap);
  const input = wrap.querySelector('input');
  input.focus();
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      wrap.remove();
      return renderList();
    }
    if (e.key !== 'Enter') return;
    const title = input.value.trim();
    if (!title) {
      wrap.remove();
      return renderList();
    }
    input.disabled = true;
    try {
      const it = lite(await api('POST', '/api/items', { type: 'ticket', title, status, board: S.board, ...(projectId ? { project: projectId } : {}) }));
      S.items.set(it.id, it);
      wrap.remove();
      if (it.board !== S.board) { rememberBoard(it.board); switchBoard(it.board); toastBoardCreated(it); return; }
      renderList();
      updateChrome();
    } catch {
      input.disabled = false;
    }
  });
}

function newProjectInline() {
  const host = $('#list .lhead');
  const input = document.createElement('input');
  input.className = 'tin pnew';
  input.placeholder = 'project name — ⏎ create (KEY is derived, e.g. "Eng org" → EGO)';
  host.after(input);
  input.focus();
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      input.remove();
      return renderList();
    }
    if (e.key !== 'Enter') return;
    const title = input.value.trim();
    if (!title) {
      input.remove();
      return renderList();
    }
    input.disabled = true;
    try {
      const p = lite(await api('POST', '/api/items', { type: 'project', title, board: S.board }));
      S.items.set(p.id, p);
      input.remove();
      if (p.board !== S.board) { rememberBoard(p.board); switchBoard(p.board); toastBoardCreated(p); return; }
      renderList();
      updateChrome();
      toast(`project ${p.key} created`);
    } catch {
      input.disabled = false;
    }
  });
}

async function cycleStatus(id) {
  const it = S.items.get(id);
  if (!it) return;
  const next = STATUSES[(STATUSES.indexOf(it.status || 'todo') + 1) % STATUSES.length];
  await patchItem(id, { status: next }).catch(() => {}); // optimistic + rollback live in patchItem
  renderList();
}

$('#list').addEventListener('input', (e) => {
  if (e.target.dataset.f === 'q') lfSet({ q: e.target.value });
});
$('#list').addEventListener('keydown', e => {
  if (e.target.matches('.trow') && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    e.stopPropagation();
    openDrawer(e.target.dataset.open);
  }
});
$('#list').addEventListener('change', (e) => {
  const k = e.target.dataset.f;
  if (k && k !== 'q') lfSet({ [k]: e.target.value });
});
$('#list').addEventListener('click', (e) => {
  const projSwitch = e.target.closest('[data-proj-switch]');
  if (projSwitch) return lfSet({ project: projSwitch.dataset.projSwitch === '*' ? '' : projSwitch.dataset.projSwitch });
  const shapeBtn = e.target.closest('[data-shape]');
  if (shapeBtn) return lfSet({ shape: shapeBtn.dataset.shape });
  if (e.target.closest('[data-f-toggle]')) { S.lfOpen = !S.lfOpen; return renderList(); }
  if (e.target.closest('[data-f-completed]')) return lfSet({ completed: !lfGet().completed });
  if (e.target.closest('[data-f-hidedone]')) return lfSet({ hideDone: !lfGet().hideDone });
  if (e.target.closest('[data-f-overdue]')) return lfSet({ overdue: !lfGet().overdue });
  if (e.target.closest('[data-f-clear]')) return lfSet({ ...LF_DEFAULT });
  const cyc = e.target.closest('[data-cycle]');
  if (cyc) {
    e.stopPropagation();
    return cycleStatus(cyc.dataset.cycle);
  }
  const fold = e.target.closest('[data-fold]');
  if (fold) {
    e.stopPropagation();
    const id = fold.dataset.fold;
    if (S.open.has(id)) S.open.delete(id);
    else S.open.add(id);
    return renderList();
  }
  const nw = e.target.closest('[data-new]');
  if (nw) {
    e.stopPropagation();
    const [pid, st] = nw.dataset.new.split('|');
    return newTicketInline(nw, pid, st);
  }
  if (e.target.closest('[data-new-project]')) return newProjectInline();
  const open = e.target.closest('[data-open]');
  if (open) return openDrawer(open.dataset.open);
});

// ---------------------------------------------------------------- keyboard
const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
};
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return S.searchOpen ? closeSearch() : openSearch();
  }
  if (e.key === 'Escape' && S.searchOpen) {
    e.preventDefault();
    closeSearch();
    return;
  }
  if (CAPTURE_READONLY) {
    if (e.key === 'Escape') {
      if ($('#drawer').classList.contains('open')) closeDrawer();
      else if (!$('#program-inspector').hidden) { $('#program-inspector').hidden = true; $('#btn-source').classList.remove('on'); }
      else if ($('#help').classList.contains('open')) toggleHelp(false);
    }
    return;
  }
  if (e.key === ' ' && !typing()) {
    spaceDown = true;
    canvas.classList.add('space');
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (typing()) return document.activeElement.blur();
    if (S.sessionsOpen) { S.sessionsOpen = false; renderSessions(); return; }
    if ($('#help').classList.contains('open')) return toggleHelp(false);
    if ($('#trash').classList.contains('open')) return toggleTrash(false);
    if ($('#menu').classList.contains('open')) return closeMenu();
    if (S.drawer) return closeDrawer();
    return select([]);
  }
  if (typing()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'a' && S.page === 'board' && S.mode === 'canvas') {
    e.preventDefault();
    return select(canvasItems().map((i) => i.id));
  }
  if (mod && e.key === 'z') {
    e.preventDefault();
    return undoDelete();
  }
  if (mod || e.altKey) return;
  if (e.key === 'A') return toggleNeeds();
  if (e.key === 'l') return setMode(S.mode === 'list' ? 'canvas' : 'list');
  if (S.page !== 'board' && !['?'].includes(e.key)) return;
  const r = canvas.getBoundingClientRect();
  const k = e.key;
  // the canvas shortcuts act on a canvas selection and a canvas cursor, neither of which exists in the list
  if (k === '/' && S.mode === 'list') {
    e.preventDefault();
    return $('#list [data-f="q"]')?.focus();
  }
  if (S.mode === 'list' && !['a', 'u', 't', 'T', '?', '[', ']'].includes(k)) return;
  if (k === '?') return toggleHelp();
  if (k === 't') {
    e.preventDefault();
    if (e.repeat) return;
    return newTicketInList();
  }
  if (['m', 'n', 'f', 'w'].includes(k)) {
    e.preventDefault();
    if (e.repeat) return;
    return createAt(k === 'w' ? 'util' : TYPE_ALIAS[k], S.mouse);
  }
  if (k === 'Backspace' || k === 'Delete') return deleteItems([...S.sel]);
  if (k === 'u') return undoDelete();
  if (k === 'Enter' && S.sel.size === 1) return openDrawer([...S.sel][0]);
  if (k === 'v') return cycleDisplay();
  if (k === 'o' || k === 'O') {
    if (e.repeat) return;
    return k === 'o' ? organize() : toggleAuto();
  }
  if (k === '.') return fit();
  if (k === '0') return zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1);
  if (k === '+' || k === '=') return zoomAt(r.left + r.width / 2, r.top + r.height / 2, S.view.z * 1.2);
  if (k === '-' || k === '_') return zoomAt(r.left + r.width / 2, r.top + r.height / 2, S.view.z / 1.2);
  if (k === '[' || k === ']') {
    const i = S.boards.findIndex((b) => b.id === S.board);
    const n = S.boards[(i + (k === ']' ? 1 : -1) + S.boards.length) % S.boards.length];
    return switchBoard(n.id);
  }
  if (k.startsWith('Arrow') && S.sel.size) {
    e.preventDefault();
    const step = e.shiftKey ? GRID * 5 : GRID;
    const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
    const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
    const ids = new Set(S.sel);
    for (const sid of S.sel) {
      const s = S.items.get(sid);
      if (s?.type === 'frame') for (const c of membersOf(s)) if (c.type !== 'ticket' && c.type !== 'project') ids.add(c.id);
    }
    const patch = [];
    for (const id of ids) {
      const it = S.items.get(id);
      if (!it) continue;
      it.x += dx;
      it.y += dy;
      renderItem(it);
      patch.push({ id, x: it.x, y: it.y });
    }
    renderFrames();
    nudgeSave(patch);
  }
});
const pendingNudge = new Map();
const flushNudge = debounce(() => {
  const p = [...pendingNudge.values()];
  pendingNudge.clear();
  if (p.length) api('PATCH', '/api/items', p).catch(load);
}, 300);
function nudgeSave(patch) {
  for (const p of patch) pendingNudge.set(p.id, p);
  flushNudge();
}
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false;
    canvas.classList.remove('space');
  }
});

// ---------------------------------------------------------------- tickers
if (!CAPTURE_READONLY) setInterval(() => {
  // relative times + staleness
  for (const it of boardItems()) if (!(drag && drag.ids?.has(it.id))) renderItem(it, true);
  renderConnection();
  renderProgramInspector();
  loadReadout();
  loadSessions();
  loadQueue();
}, 5000);
if (!CAPTURE_READONLY) setInterval(heartbeatSelf, 20000);
let spinI = 0;
if (!CAPTURE_READONLY) setInterval(() => {
  spinI = (spinI + 1) % SPIN.length;
  for (const el of $$('.spin')) el.textContent = SPIN[spinI];
  // clocks, running timers and stopwatches need a faster beat than the 5s tick; their signature embeds the
  // rendered text, so a card is only rebuilt when it actually changes (animated charts: every 100 ms)
  for (const id of els.keys()) {
    const it = S.items.get(id);
    if (it && ((it.type === 'util' && isLive(it)) || isAnimated(it))) renderItem(it, true);
  }
}, 100);
window.addEventListener('resize', () => { setDrawerWidth(S.drawerWidth, false, false); settleCamera(); syncPersistenceBannerHeight(); });
$('#persistence-banner').addEventListener('click', (e) => {
  const button = e.target.closest('[data-persistence]');
  if (!button) return;
  persistenceAction(button.dataset.persistence).catch(() => {});
});
if (!CAPTURE_READONLY) {
  void refreshPersistenceBanner();
  setInterval(() => { void refreshPersistenceBanner(); }, 2000);
}

// ---------------------------------------------------------------- boot
if (!CAPTURE_READONLY) try {
  if (localStorage.getItem('hud.activity') === '1') toggleActivity(true);
} catch {}
// the human is a participant too: register presence so agents can see who is live
if (!CAPTURE_READONLY) api('POST', '/api/sessions', { id: 'user', kind: 'human', actor: 'user' }).catch(() => {});

// Keep a checkpoint for the next launch while retaining the immutable "since this visit" baseline.
if (!CAPTURE_READONLY) setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  try { localStorage.setItem(localKey('lastvisit'), String(Date.now())); } catch {}
}, 60e3);

/** open the stream first so nothing emitted during the snapshot fetch is lost, then load and replay */
async function boot() {
  if (!CAPTURE_READONLY) connect();
  else renderConnection();
  for (;;) {
    try {
      await load();
      break;
    } catch (e) {
      // api() already toasted a network/server error; a render bug is isolated per item and cannot land here
      if (CAPTURE_READONLY) {
        S.captureErrors.push(String(e?.message || e));
        window.__hudCapture = { ready: false, errors: [...S.captureErrors], customReady: false };
        return;
      }
      toast(`could not load the board: ${e.message} — retrying`, 3000);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  S.ready = true;
  for (const e of buffered.splice(0)) {
    try {
      onEvent(e);
    } catch (err) {
      console.error('event failed', e?.kind, err);
    }
  }
  if (CAPTURE_READONLY) {
    const report = await mountProgramsNow(true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const errors = [...new Set([...S.captureErrors, ...(report.errors || [])])];
    const hasCustom = !!document.querySelector('.hud-program');
    window.__hudCapture = { ready: true, errors, customReady: !hasCustom || errors.length === 0 };
    applyReadonlyControls();
  } else loadAttention();
}
boot();
window.addEventListener('hashchange', () => {
  const hs = hashState();
  if (hs.page === 'attention' || hs.page === 'runs') return setPage(hs.page, { hash: false });
  if (hs.page === 'item' && hs.item) return openItemDeepLink(hs.item);
  const id = hs.board;
  if (id && S.boards.some((b) => b.id === id)) return id === S.board ? setPage('board', { hash: false }) : switchBoard(id, { hash: false });
});
