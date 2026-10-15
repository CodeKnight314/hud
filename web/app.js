// hud — canvas client. No build step; plain ES module.
import { autoDisplay, renderChart as renderChartView, hitsOf, dropHits, setHits, helpers, DISPLAY_KINDS, seriesOf, rangeOf, isAnimated } from './views.js';
import { UTIL_KINDS, UTIL_LABEL, renderCard as renderUtilCard, defaultUtil, isLive, timerRemaining, stopwatchElapsed, evaluate, md } from './utils.js';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const GRID = 20;
const ME = 'user';
const SYSTEM = 'hud';
const STATUSES = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done', 'canceled'];
const STATUS_GLYPH = { backlog: '[ ]', todo: '[ ]', doing: '[~]', review: '[?]', blocked: '[!]', done: '[x]', canceled: '[-]' };
const PRIOS = ['', 'low', 'med', 'high', 'urgent'];
const MSTATES = ['ok', 'warn', 'error', 'unknown', 'running', 'done'];
const MGLYPH = { ok: '●', warn: '▲', error: '✕', unknown: '○', running: '◐', done: '✓' };
const KINDS = ['manual', 'push', 'command', 'http', 'probe', 'heartbeat'];
const DISPLAYS = DISPLAY_KINDS;
/** display kinds drawn as an SVG chart (so they get hover readout + y-range controls) */
const CHART_SET = new Set(['line', 'area', 'bars', 'gauge', 'histogram', 'scatter', 'pie', 'donut', 'heatmap', 'box', 'ridgeline', 'scatter3d', 'surface3d']);
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

const S = {
  boards: [],
  items: new Map(),
  activity: [],
  board: null,
  mode: 'canvas', // 'canvas' | 'list' — the Linear-style ticket list
  open: new Set(), // ticket ids whose sub-tickets are collapsed in the list view
  view: { x: 60, y: 60, z: 1 },
  sel: new Set(),
  expanded: new Set(), // item ids whose card is expanded in place (client-only; never persisted)
  drawer: null, // item id
  drawerDirty: false,
  mouse: { x: 0, y: 0 }, // world coords of last pointer position
  undo: [],
  alerts: [],
  live: false,
  views: [], // renderer modules from GET /api/views, used to cache-bust dynamic imports
};

const canvas = $('#canvas');
const world = $('#world');
const els = new Map(); // id -> element

// ---------------------------------------------------------------- utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const snap = (n) => Math.round(n / GRID) * GRID;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isOverdue = (t) => !!(t.target && t.type === 'ticket' && t.status !== 'done' && t.status !== 'canceled' && String(t.target).slice(0, 10) < todayISO());
const targetHTML = (t) => (t.target ? `<span class="${isOverdue(t) ? 'od' : 'dim'}" title="${isOverdue(t) ? 'overdue' : 'target date'}">${isOverdue(t) ? '‼ overdue' : '◷'} ${esc(String(t.target).slice(0, 10))}</span>` : '');
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
const isStale = (it) => !!(it.stale || (it.staleAfter && it.lastUpdate && Date.now() - it.lastUpdate > it.staleAfter * 1000));
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

// every api() failure already toasted; anything else that escapes a handler is surfaced instead of vanishing
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  if (!e.reason?.toasted) toast(String(e.reason?.message || e.reason));
});

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('open');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('open'), ms);
}

const boardItems = () => [...S.items.values()].filter((i) => i.board === S.board);
const hashId = () => {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return '';
  }
};
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
  const { trend, graph, ...rest } = it;
  return rest;
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
  return boardItems()
    .filter((f) => f.type === 'frame' && !exclude?.has(f.id) && (f.title || '').trim() && contains(f, it))
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
}
function contains(f, it) {
  if (f.id === it.id || it.w * it.h >= f.w * f.h) return false;
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
}

// ---------------------------------------------------------------- view
function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem('hud.view.' + S.board));
    if (v && Number.isFinite(v.x)) return v;
  } catch {}
  return { x: 60, y: 60, z: 1 };
}
const saveView = debounce(() => {
  try {
    localStorage.setItem('hud.view.' + S.board, JSON.stringify(S.view));
  } catch {}
}, 300);

function applyView() {
  const { x, y, z } = S.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  const g = GRID * z;
  canvas.style.backgroundSize = `${g}px ${g}px`;
  canvas.style.backgroundPosition = `${x - g / 2}px ${y - g / 2}px`;
  canvas.style.backgroundImage = z < 0.35 ? 'none' : '';
  $('#zoom').textContent = `${Math.round(z * 100)}%`;
  saveView();
}

function toWorld(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return { x: (cx - r.left - S.view.x) / S.view.z, y: (cy - r.top - S.view.y) / S.view.z };
}

function zoomAt(cx, cy, nz) {
  nz = clamp(nz, 0.1, 3);
  const r = canvas.getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const wx = (px - S.view.x) / S.view.z, wy = (py - S.view.y) / S.view.z;
  S.view.z = nz;
  S.view.x = px - wx * nz;
  S.view.y = py - wy * nz;
  applyView();
}

function fit(items = boardItems()) {
  const r = canvas.getBoundingClientRect();
  if (!items.length) {
    S.view = { x: 60, y: 60, z: 1 };
    return applyView();
  }
  const minX = Math.min(...items.map((i) => i.x)), minY = Math.min(...items.map((i) => i.y - (i.type === 'frame' ? 24 : 0)));
  const maxX = Math.max(...items.map((i) => i.x + i.w)), maxY = Math.max(...items.map((i) => i.y + i.h));
  const pad = 60;
  const drawerW = S.drawer ? 420 : 0;
  const z = clamp(Math.min((r.width - drawerW - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY)), 0.1, 1);
  S.view = { z, x: (r.width - drawerW - (maxX - minX) * z) / 2 - minX * z, y: (r.height - (maxY - minY) * z) / 2 - minY * z };
  applyView();
}

function focusItem(id) {
  const it = S.items.get(id);
  if (!it) return toast(`no item ${id}`);
  if (it.board !== S.board) switchBoard(it.board);
  const r = canvas.getBoundingClientRect();
  const drawerW = S.drawer ? 420 : 0;
  S.view.z = Math.max(S.view.z, 0.6);
  S.view.x = (r.width - drawerW) / 2 - (it.x + it.w / 2) * S.view.z;
  S.view.y = r.height / 2 - (it.y + it.h / 2) * S.view.z;
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

/** the classes that carry the two semantic colours: red = needs attention, green = done */
function stateClass(it) {
  if (it.type === 'ticket') {
    const cls = [`s-${it.status || 'todo'}`];
    if (it.status === 'blocked' || needsDecision(it)) cls.push('needs-decision');
    return cls;
  }
  if (it.type === 'monitor') return [`m-${it.state || 'unknown'}`];
  return [];
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
              return `<div class="opt${chosen ? ' chosen' : ''}" data-decide="${esc(o.id)}" data-label="${esc(o.label)}"><span class="k">${chosen ? '✓' : '▸'}${esc(o.id)}</span> ${esc(o.label)}${o.detail ? ` <span class="d">${esc(o.detail)}</span>` : ''}</div>`;
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
      return `<div class="hd"><span class="st">${STATUS_GLYPH[it.status] || '[·]'} ${esc(it.status)}</span><span class="r">${it.autoStatus ? '<span title="status follows linked monitors">⟳</span> ' : ''}${pr} <span class="idt">${esc(identOf(it))}</span> <span class="expand-btn" data-drawer="1" title="details (Enter)">⤢</span></span></div>
        <div class="bd"><div class="ttl">${esc(it.title) || '<span class="faint">untitled</span>'}</div>${lineage ? `<div class="lineage">${lineage}</div>` : ''}${opts}${answer}${links ? `<div class="links">${links}</div>` : ''}<div class="body md">${md(it.body)}</div></div>
        <div class="ft">${by(it)}${it.assignee ? `<span>→${esc(it.assignee)}</span>` : ''}<span>${tags}</span>${targetHTML(it)}<span class="r">${nc} ${ago(it.updatedAt)}</span></div>`;
    }
    case 'monitor': {
      const st = it.state || 'unknown';
      const g = st === 'running' ? `<span class="g spin">${SPIN[0]}</span>` : `<span class="g">${MGLYPH[st]}</span>`;
      const stale = isStale(it) ? '<span class="tag">stale</span>' : '';
      const lbl = it.label != null && it.label !== '';
      const v = lbl ? it.label : fmtVal(it.value);
      const hasP = it.progress !== null && it.progress !== undefined;
      let disp = it.display || 'auto';
      if (disp === 'auto') disp = autoDisplay(it);
      let body = '';
      const unit = it.unit && !lbl ? `<span class="u">${esc(it.unit)}</span>` : '';
      const rate = (disp === 'value' || disp === 'progress') && rateOf(it);
      const rateHTML = rate ? `<div class="rate">${esc(rate.text)}</div>` : '';
      if (disp === 'value') {
        body = `<div class="big ${String(v).length > 9 ? 'txt' : ''}">${esc(v) || '—'}${v ? unit : ''}</div><div class="spark">${spark(it.history, cols)}</div>${rateHTML}`;
      } else if (disp === 'progress') {
        const p = hasP ? it.progress : 0;
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
      } else if (disp.startsWith('view:')) {
        // an agent-authored renderer module; hydrated after mount (see hydrateViews)
        body = `<div class="vwrap" data-viewmod="${esc(disp.slice(5))}"><div class="chart-empty faint">loading ${esc(disp.slice(5))}…</div></div>`;
      } else {
        const chart = renderChartView(disp, it, { reserve: 52 });
        body = chart ? `<div class="vwrap" data-chart="1">${chart}</div>` : '';
        if (!chart) {
          // unknown display kind — fall back to the big number so a card is never blank
          body = `<div class="big ${String(v).length > 9 ? 'txt' : ''}">${esc(v) || '—'}${v ? unit : ''}</div>`;
        }
      }
      const msg = disp !== 'log' && it.message ? `<div class="msg">${esc(it.message)}</div>` : '';
      const src = it.source || { kind: 'manual' };
      const srcLabel = ({ manual: 'manual', push: 'push', command: 'cmd', http: 'http', probe: `probe:${src.probe}`, heartbeat: 'heartbeat' }[src.kind] ?? String(src.kind)) + (src.interval && ['command', 'http', 'probe'].includes(src.kind) ? ` /${src.interval}s` : '');
      const bell = it.notify?.length ? `<span title="wakes ${esc(it.notify.join(', '))}">⌁</span>` : '';
      const yhint = disp !== 'auto' && DISPLAYS.includes(disp) && CHART_SET.has(disp) ? `<span class="yhint" title="alt+scroll to stretch the y-range (meters/axes are auto by default)">⇕</span>` : '';
      return `<div class="hd">${g}<span class="t">${esc(it.title) || esc(it.id)}</span>${stale}${bell}${yhint}<span class="r" title="${esc(localDT(it.lastUpdate))}">${ago(it.lastUpdate)} <span class="expand-btn" data-drawer="1" title="details (Enter)">⤢</span></span></div>
        <div class="bd">${body}${msg}</div>
        <div class="ft">${by(it)}<span>${esc(srcLabel)}</span><span class="r">${esc(it.id)}</span></div>`;
    }
    case 'util': {
      const body = renderUtilCard(it);
      return `<div class="hd"><span class="g">⚙</span><span class="t">${esc(it.title) || UTIL_LABEL[it.kind] || 'utility'}</span><span class="tag">${esc(UTIL_LABEL[it.kind] || it.kind || '')}</span><span class="r"><span class="expand-btn" data-drawer="1" title="details (Enter)">⤢</span></span></div>
        <div class="bd">${body}</div>
        <div class="ft">${by(it)}<span class="r">${esc(it.id)}</span></div>`;
    }
    case 'note':
      return `${it.title ? `<div class="hd"><span class="t">${esc(it.title)}</span>` : '<div class="hd"><span class="t faint">note</span>'}<span class="r"><span class="expand-btn" data-drawer="1" title="details (Enter)">⤢</span></span></div><div class="bd md">${md(it.text)}</div>`;
    case 'frame': {
      const n = membersOf(it).length;
      return `<div class="flabel">${esc(it.title) || 'frame'}<span class="n">${n}</span></div>`;
    }
    case 'project': {
      const ts = [...S.items.values()].filter((t) => t.type === 'ticket' && t.project === it.id);
      const done = ts.filter((t) => t.status === 'done' || t.status === 'canceled').length;
      const meta = [it.lead && `@${esc(it.lead)}`, it.target && `→ ${esc(it.target)}`].filter(Boolean).join('  ');
      return `<div class="hd"><span class="g">◈</span><span class="t">${esc(it.key || '—')} ${esc(it.title) || '<span class="faint">untitled</span>'}</span><span class="r"><span class="expand-btn" data-drawer="1" title="details (Enter)">⤢</span></span></div>
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
    if (S.expanded.has(it.id)) cls.push('expanded');
    if (S.sel.has(it.id)) cls.push('sel');
    if (el.classList.contains('drag')) cls.push('drag');
    if (el.classList.contains('flash')) cls.push('flash');
    const className = cls.join(' ');
    // Skip the rebuild when nothing that affects the card has changed (replacing innerHTML tears down chart
    // SVGs and hover state). The signature therefore has to cover everything the card shows.
    const sig = cardSignature(it, className);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.className = className;
    el.style.left = it.x + 'px';
    el.style.top = it.y + 'px';
    el.style.width = it.w + 'px';
    el.style.height = it.h + 'px';
    if (it.type === 'frame') el.style.zIndex = String(Math.max(1, 9 - Math.round(Math.log10(it.w * it.h) || 0)));
    el.innerHTML = cardHTML(it) + (S.expanded.has(it.id) ? expandedHTML(it) : '') + '<div class="rz"></div>';
    hydrateViews(el);
  } catch (e) {
    // one malformed item must never take the page down: show it as an error card instead
    console.error('render failed', it?.id, e);
    el.dataset.sig = 'err|' + e.message;
    el.className = 'item render-error';
    el.style.left = (Number(it.x) || 0) + 'px';
    el.style.top = (Number(it.y) || 0) + 'px';
    el.style.width = (Number(it.w) || 260) + 'px';
    el.style.height = (Number(it.h) || 120) + 'px';
    el.innerHTML = `<div class="hd"><span class="g">✕</span><span class="t">render error</span><span class="r"><span class="expand-btn" data-drawer="1" title="details (Enter)">⤢</span></span></div><div class="bd faint">${esc(it.id)}: ${esc(e.message)}</div><div class="rz"></div>`;
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
    it.title, it.num, it.kind, it.util ? JSON.stringify(it.util) : '', it.text, it.body, it.key, it.lead, it.target,
    (it.comments || []).length, (it.tags || []).length, (it.monitors || []).join(','),
    (it.options || []).length, it.decision ? it.decision.optionId : '',
    (it.history || []).length, (it.log || []).length,
  ];
  // time-dependent text: only rebuild when the rendered label would actually change
  if (it.type === 'util') parts.push(isLive(it, now) ? renderUtilCard(it, now) : '');
  else if (isAnimated(it)) parts.push(Math.floor(now / 100));
  if (it.type === 'monitor') parts.push(ago(it.lastUpdate));
  if (it.type === 'ticket') parts.push(ago(it.updatedAt));
  // values drawn from other items: frame counts, '+N sub', idents, linked monitors, project rollups
  if (it.type === 'frame') parts.push(membersOf(it).length);
  if (it.type === 'ticket') {
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

/** the detail a double-click reveals: comments, history, source, thresholds, meta */
function expandedHTML(it) {
  if (it.type === 'ticket') {
    const comments =
      (it.comments || [])
        .map((c) => `<div class="comment"><span class="who">${esc(c.actor)} ${localDT(c.t)}</span><div class="txt">${esc(c.text)}</div></div>`)
        .join('') || '<div class="faint">no comments</div>';
    const mons =
      (it.monitors || [])
        .map((id) => {
          const m = S.items.get(id);
          if (!m) return `<div class="ln faint">? ${esc(id)}</div>`;
          const val = m.label ?? (m.value != null ? fmtVal(m.value) + (m.unit || '') : m.state);
          return `<div class="ln s-${esc(m.state)}"><span class="g">${MGLYPH[m.state] || '○'}</span> ${esc(m.title || m.id)} <span class="lv">${esc(val)}${m.progress != null && m.label == null ? ` ${Math.round(m.progress)}%` : ''}</span></div>`;
        })
        .join('') || '<div class="faint">none linked</div>';
    const meta = it.meta && Object.keys(it.meta).length ? `<div class="meta">meta ${esc(JSON.stringify(it.meta))}</div>` : '';
    return `<div class="more"><div class="sec-h">comments (${(it.comments || []).length})</div>${comments}<div class="sec-h">monitors</div>${mons}${meta}<div class="meta">${esc(it.id)} · by ${esc(it.createdBy || '—')} ${localDT(it.createdAt)}</div></div>`;
  }
  if (it.type === 'monitor') {
    const hist =
      (it.history || [])
        .filter(Boolean)
        .slice(-12)
        .map((x) => `<div>${MGLYPH[x.s] || '·'} ${hhmmss(x.t)}  ${esc(x.v ?? '')}${x.p != null ? `  ${Math.round(x.p)}%` : ''}</div>`)
        .join('') || '<div class="faint">no history</div>';
    const lg =
      (it.log || [])
        .slice(-8)
        .map((l) => `<div>${MGLYPH[l.s] || '·'} ${hhmmss(l.t)} ${esc(l.m)}</div>`)
        .join('') || '<div class="faint">no messages</div>';
    const thr =
      [['warnAbove', it.warnAbove], ['errorAbove', it.errorAbove], ['warnBelow', it.warnBelow], ['errorBelow', it.errorBelow]]
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || 'none';
    return `<div class="more"><div class="sec-h">history</div><div class="hist">${hist}</div><div class="sec-h">log</div><div class="hist">${lg}</div><div class="sec-h">config</div><div class="meta">thresholds ${esc(thr)} · max ${esc(it.max ?? '—')} · stale ${esc(it.staleAfter ?? '—')}s · notify ${esc((it.notify || []).join(', ') || '—')}</div><div class="meta">${esc(JSON.stringify(it.source ?? { kind: 'manual' }))}</div></div>`;
  }
  if (it.type === 'util') {
    const detail =
      it.kind === 'calculator'
        ? `<div class="sec-h">history</div><div class="hist">${(it.util?.history || []).slice(-8).map((h) => `<div>${esc(h)}</div>`).join('') || '<div class="faint">nothing yet</div>'}</div>`
        : it.kind === 'stopwatch'
          ? `<div class="sec-h">laps</div><div class="hist">${(it.util?.laps || []).slice(-8).map((l, i) => `<div>${i + 1}  ${esc(String(l.toFixed ? l.toFixed(2) : l))}s</div>`).join('') || '<div class="faint">no laps</div>'}</div>`
          : it.kind === 'dice'
            ? `<div class="sec-h">rolls</div><div class="hist">${(it.util?.rolls || []).slice(-16).map((r) => `<div>${esc(String(r))}</div>`).join('') || '<div class="faint">no rolls</div>'}</div>`
            : '';
    return `<div class="more">${detail}<div class="meta">${esc(JSON.stringify(it.util ?? {}))}</div></div>`;
  }
  return '';
}

function removeEl(id) {
  els.get(id)?.remove();
  els.delete(id);
  dropHits(id);
}

function renderAll() {
  for (const [id, el] of els) if (S.items.get(id)?.board !== S.board) removeEl(id);
  for (const it of boardItems()) renderItem(it);
  refreshDerived();
  updateChrome();
}

const renderFrames = refreshDerived;

function updateChrome() {
  const n = boardItems().length;
  document.body.classList.toggle('blank', n === 0);
  renderTabs();
  const counts = { ticket: 0, monitor: 0, note: 0, frame: 0, util: 0, project: 0 };
  let open = 0, bad = 0;
  for (const it of boardItems()) {
    counts[it.type] = (counts[it.type] || 0) + 1;
    if (it.type === 'ticket' && it.status !== 'done') open++;
    if (it.type === 'monitor' && (it.state === 'error' || it.state === 'warn')) bad++;
  }
  const utilPart = counts.util ? ` · ${counts.util} tools` : '';
  $('#pos').textContent = `${counts.ticket} tickets (${open} open) · ${counts.monitor} monitors${bad ? ` (${bad} ▲✕)` : ''} · ${counts.note} notes${utilPart}`;
  setModeHint();
  if (S.mode === 'list') scheduleList();
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
  setModeHint();
}

function setModeHint() {
  const n = S.sel.size;
  $('#mode').textContent = document.body.classList.contains('cmd') ? 'COMMAND' : n ? `SEL ${n}` : 'NORMAL';
  $('#hint').textContent = n
    ? 'drag move · ⏎ open · ⌫ delete · arrows nudge · esc clear'
    : 'dbl-click add · drag pan · ⌘/ctrl+scroll zoom · shift+drag select · : command · ? help';
}

// ---------------------------------------------------------------- tabs / boards
function renderTabs() {
  const tabs = $('#tabs');
  renderBoardButtons();
  if (tabs.querySelector('input')) return;
  const counts = {};
  for (const it of S.items.values()) counts[it.board] = (counts[it.board] || 0) + 1;
  const html =
    S.boards.map((b) => `<span class="tab ${b.id === S.board ? 'on' : ''}" data-board="${esc(b.id)}" title="double-click to rename">${esc(b.name)}<span class="n">${counts[b.id] || 0}</span></span>`).join('') +
    `<span class="tab add" data-add title="new board">+</span>`;
  // rewriting identical markup would drop a click whose mousedown and mouseup straddle an SSE-driven rebuild
  if (tabs.dataset.sig === html) return;
  tabs.dataset.sig = html;
  tabs.innerHTML = html;
  tabs.querySelector('.tab.on')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
}

function switchBoard(id) {
  if (!id || !S.boards.some((b) => b.id === id)) return toast(`no board ${id}`);
  S.board = id;
  S.sel.clear();
  try {
    localStorage.setItem('hud.board', id);
  } catch {}
  history.replaceState(null, '', '#' + encodeURIComponent(id));
  S.view = loadView();
  applyView();
  closeDrawer();
  renderAll();
  renderActivity();
  renderTrash();
}

function tabInput(initial, onDone) {
  const tabs = $('#tabs');
  const inp = document.createElement('input');
  inp.value = initial;
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    inp.remove();
    $('#tabs').dataset.sig = '';
    renderTabs();
    if (ok && inp.value.trim()) onDone(inp.value.trim());
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
  return { inp, tabs };
}

$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  if (t.dataset.add !== undefined) {
    const { inp } = tabInput('', async (name) => {
      const b = await api('POST', '/api/boards', { name });
      upsertBoard(b);
      switchBoard(b.id);
    });
    t.replaceWith(inp);
    inp.focus();
    return;
  }
  switchBoard(t.dataset.board);
});
$('#tabs').addEventListener('dblclick', (e) => {
  const t = e.target.closest('.tab[data-board]');
  if (!t) return;
  const b = S.boards.find((x) => x.id === t.dataset.board);
  const { inp } = tabInput(b.name, (name) => api('PATCH', `/api/boards/${encodeURIComponent(b.id)}`, { name }));
  t.replaceWith(inp);
  inp.focus();
  inp.select();
});

function upsertBoard(b) {
  const i = S.boards.findIndex((x) => x.id === b.id);
  if (i >= 0) S.boards[i] = b;
  else S.boards.push(b);
  renderTabs();
}

// ---------------------------------------------------------------- data sync
async function load() {
  const [st, views] = await Promise.all([api('GET', '/api/state'), fetch('/api/views').then((r) => r.json()).then((v) => v.views ?? []).catch(() => [])]);
  S.views = views;
  viewMods.clear();
  S.boards = st.boards;
  S.items = new Map(st.items.map((i) => [i.id, i]));
  S.activity = st.activity;
  S.alerts = st.alerts || [];
  renderAlerts();
  const want = hashId() || (() => {
    try {
      return localStorage.getItem('hud.board');
    } catch {}
  })();
  const id = S.boards.some((b) => b.id === want) ? want : S.board && S.boards.some((b) => b.id === S.board) ? S.board : S.boards[0].id;
  if (id !== S.board) switchBoard(id);
  else renderAll();
  if (S.drawer && !S.items.has(S.drawer)) closeDrawer();
  else if (S.drawer) renderDrawer();
  renderActivity();
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
  const c = $('#conn');
  c.classList.toggle('off', !on);
  c.textContent = on ? '● live' : '○ offline';
}

function onEvent(e) {
  if (e.kind === 'hello') {
    // server restarted (possibly with new code): reload the page to pick it up
    if (S.serverPid && S.serverPid !== e.pid) return location.reload();
    S.serverPid = e.pid;
    // the first hello is the boot snapshot's own stream; later ones are reconnects, which may have missed events
    if (S.live && S.ready) load().catch(() => {});
    S.live = true;
    return;
  }
  if (e.kind === 'alert') {
    S.alerts.push(e.alert);
    if (S.alerts.length > 300) S.alerts.splice(0, S.alerts.length - 300);
    renderAlerts();
    toast(`${e.alert.to === 'done' ? '✓' : '▲'} ${e.alert.title}: ${e.alert.from} → ${e.alert.to}`, 5000);
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
    } else removeEl(e.item.id);
    if (S.drawer === e.item.id && e.actor !== ME) renderDrawer();
    else if (S.drawer === e.item.id && e.item.type === 'monitor') renderDrawerLive();
    updateChrome();
  } else if (e.kind === 'item.deleted') {
    S.items.delete(e.id);
    S.sel.delete(e.id);
    S.expanded.delete(e.id);
    S.trend.delete(e.id);
    pendingNudge.delete(e.id);
    if (drag?.ids?.has(e.id) || drag?.id === e.id) endDragSilently();
    removeEl(e.id);
    if (S.drawer === e.id) closeDrawer();
    renderTrash();
    renderFrames();
    updateChrome();
  } else if (e.kind === 'board') {
    upsertBoard(e.board);
  } else if (e.kind === 'board.deleted') {
    S.boards = S.boards.filter((b) => b.id !== e.id);
    for (const it of [...S.items.values()]) if (it.board === e.id) S.items.delete(it.id);
    if (S.board === e.id) switchBoard(S.boards[0]?.id);
    renderTabs();
    renderAll();
  } else if (e.kind === 'activity') {
    S.activity.push(e.activity);
    if (S.activity.length > 500) S.activity.shift();
    renderActivity(e.activity.id);
    renderWho();
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
    if (s?.type === 'frame') for (const c of membersOf(s)) ids.add(c.id);
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
    const sdx = e.altKey ? dx : snap(lead.x + dx) - lead.x;
    const sdy = e.altKey ? dy : snap(lead.y + dy) - lead.y;
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
    renderItem(it);
  } else if (drag.mode === 'marquee') {
    const m = $('#marquee');
    capturePointer();
    const r = canvas.getBoundingClientRect();
    const x1 = Math.min(e.clientX, drag.sx) - r.left, y1 = Math.min(e.clientY, drag.sy) - r.top;
    Object.assign(m.style, { display: 'block', left: x1 + 'px', top: y1 + 'px', width: Math.abs(e.clientX - drag.sx) + 'px', height: Math.abs(e.clientY - drag.sy) + 'px' });
    const rx = Math.min(w.x, drag.wx), ry = Math.min(w.y, drag.wy), rw = Math.abs(w.x - drag.wx), rh = Math.abs(w.y - drag.wy);
    const hit = boardItems().filter((i) => i.x < rx + rw && rx < i.x + i.w && i.y < ry + rh && ry < i.y + i.h && (i.type !== 'frame' || (i.x >= rx && i.y >= ry && i.x + i.w <= rx + rw && i.y + i.h <= ry + rh)));
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
    const w = toWorld(e.clientX, e.clientY);
    return openMenu(e.clientX, e.clientY, w);
  }
  if (suppressClick) return;
  toggleExpand(itemEl.dataset.id);
});

/** expand/collapse a card in place to reveal the detail we normally hide */
function toggleExpand(id) {
  if (S.expanded.has(id)) S.expanded.delete(id);
  else S.expanded.add(id);
  const it = S.items.get(id);
  if (it) renderItem(it);
}

function collapseAll() {
  for (const id of S.expanded) {
    const it = S.items.get(id);
    if (it) renderItem(it);
  }
  S.expanded.clear();
}

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
  const dr = e.target.closest('.expand-btn');
  if (dr && !suppressClick) {
    e.stopPropagation();
    return openDrawer(dr.closest('.item').dataset.id);
  }
  const ub = e.target.closest('.ubtn');
  if (ub && !suppressClick) {
    e.stopPropagation();
    return utilAction(ub);
  }
  const opt = e.target.closest('.ticket .opt:not(.chosen)');
  if (opt && !suppressClick) {
    const id = opt.closest('.item').dataset.id;
    decide(id, opt.dataset.decide, opt.dataset.label);
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

async function decide(id, optionId, label) {
  const it = S.items.get(id);
  const opt = it?.options?.find((o) => o.id === optionId);
  if (!confirm(`Decide ${id}: ${opt?.label ?? label}?`)) return;
  try {
    S.items.set(id, lite(await api('POST', `/api/items/${encodeURIComponent(id)}/decide`, { optionId })));
    renderItem(S.items.get(id));
    updateChrome();
    toast(`decided: ${opt?.label ?? label}`);
  } catch {
    load();
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
  ['ticket', 't'],
  ['monitor', 'm'],
  ['note', 'n'],
  ['frame', 'f'],
  ['util', 'w'],
];
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
  if (pos) {
    body.x = snap(pos.x);
    body.y = snap(pos.y);
  }
  const it = lite(await api('POST', '/api/items', body));
  S.items.set(it.id, it);
  renderItem(it);
  renderFrames();
  updateChrome();
  select([it.id]);
  openDrawer(it.id, true);
  return it;
}

// ---------------------------------------------------------------- drawer
/** optimistic: applies the patch locally, and puts the old values back (with the server's error toast) on failure */
function patchItem(id, patch) {
  const it = S.items.get(id);
  const prev = {};
  if (it) {
    for (const k of Object.keys(patch)) prev[k] = it[k];
    Object.assign(it, patch);
    renderItem(it);
  }
  return api('PATCH', `/api/items/${encodeURIComponent(id)}`, patch).then(
    (u) => {
      u = lite(u);
      S.items.set(u.id, u);
      renderItem(u);
      refreshDerived();
      updateChrome();
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
  S.drawer = id;
  S.pendingKind = null;
  if (S.items.get(id)?.type === 'monitor') fetchTrend(id);
  if (S.items.get(id)?.type === 'ticket') fetchItemActivity(id);
  $('#drawer').classList.add('open');
  document.body.classList.add('drawer-open');
  renderDrawer();
  if (focusTitle) setTimeout(() => $('#drawer [data-k="title"]')?.focus(), 0);
}
function closeDrawer() {
  S.drawer = null;
  S.pendingKind = null;
  $('#drawer').classList.remove('open');
  document.body.classList.remove('drawer-open');
}

const chips = (key, opts, cur, labels = {}) =>
  `<div class="chips" data-chips="${key}">${opts.map((o) => `<span class="chip ${o === (cur ?? '') ? 'on' : ''}" data-v="${esc(o)}">${esc(labels[o] ?? (o || '—'))}</span>`).join('')}</div>`;
const row = (label, html) => `<div class="row"><label>${label}</label><div>${html}</div></div>`;
const inp = (k, v, ph = '', extra = '') => `<input data-k="${k}" value="${esc(v ?? '')}" placeholder="${esc(ph)}" ${extra}>`;

function drawerHTML(it) {
  const head = `<div class="phd"><b>${esc(it.type)}</b><span>${esc(it.id)}</span><span class="sp"></span><button data-act="focus" title="center on canvas">◎</button><button data-act="close" title="close (esc)">×</button></div>`;
  const groups = [...new Set(boardItems().filter((f) => f.type === 'frame' && (f.title || '').trim()).map((f) => f.title.trim()))];
  const groupRow = it.type === 'frame' ? '' : row('group', `${inp('group', it.group, 'none — frame title', 'list="grouplist"')}<datalist id="grouplist">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>`);
  const meta = `<div class="sec"><h4>meta</h4><div class="meta">created ${localDT(it.createdAt)} by @${esc(it.createdBy)}<br>updated ${localDT(it.updatedAt)} by @${esc(it.updatedBy)}<br>board ${esc(it.board)} · ${esc(it.x)},${esc(it.y)} · ${esc(it.w)}×${esc(it.h)}${it.meta ? `<br>meta ${esc(JSON.stringify(it.meta))}` : ''}</div>
    <div class="btns"><button class="btn danger" data-act="delete">delete</button></div></div>`;
  if (it.type === 'ticket') {
    const comments = (it.comments || [])
      .map((c) => `<div class="comment" data-cid="${esc(c.id)}"><div class="who"><span class="cact"><span data-act="cedit" title="edit">✎</span><span data-act="cdel" title="delete">×</span></span>@${esc(c.actor)} · ${localDT(c.t)}${c.edited ? ' · edited' : ''}</div><div class="txt">${esc(c.text)}</div></div>`)
      .join('');
    const chosen = it.options?.find((o) => o.id === it.decision?.optionId);
    const decision = it.options?.length
      ? `<div class="sec"><h4>decision</h4>
      ${row('question', inp('question', it.question || '', 'what the agent asked'))}
      ${
        it.decision
          ? `<div class="answer">✓ @${esc(it.decision.actor)} chose ${esc(chosen?.label ?? it.decision.optionId)}${it.decision.note ? ` — ${esc(it.decision.note)}` : ''}</div><div class="btns"><button class="btn" data-act="reopen">re-open</button><button class="btn danger" data-act="clear-options">clear options</button></div>`
          : `<div class="hint">choose one — the ticket moves to that option's status and the asking agent is woken</div>${it.options
              .map(
                (o) =>
                  `<div class="row"><label>${esc(o.id)}</label><div>${esc(o.label)}${o.detail ? ` <span class="dim">${esc(o.detail)}</span>` : ''} <button class="btn" data-act="decide" data-opt="${esc(o.id)}">choose${o.status ? ` →${esc(o.status)}` : ''}</button></div></div>`,
              )
              .join('')}<div class="btns"><button class="btn danger" data-act="clear-options">clear options</button></div>`
      }</div>`
      : '';
    const up = ancestryOf(it);
    const kids = [...S.items.values()].filter((c) => c.type === 'ticket' && c.parent === it.id);
    const kidDone = kids.filter((k) => k.status === 'done' || k.status === 'canceled').length;
    const crumb = up.length
      ? `<div class="crumb">${up.map((a) => `<span class="go" data-go="${esc(a.id)}">${esc(identOf(a))} ${esc(a.title)}</span>`).join(' <span class="sep">›</span> ')} <span class="sep">›</span> <b>${esc(identOf(it))}</b></div>`
      : '';
    const subline = kids.length ? `<div class="subline">${kids.length} sub-ticket${kids.length > 1 ? 's' : ''}, ${kidDone} done · ${kids.map((k) => `<span class="go" data-go="${esc(k.id)}">${esc(identOf(k))}</span>`).join(', ')}</div>` : '';
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
      ${it.monitors?.length ? row('auto', chips('autoStatus', ['off', 'on'], it.autoStatus ? 'on' : 'off', { on: 'on: all done → done, error → blocked', off: 'off' })) : ''}
      </div>${subline}${decision}<div class="sec"><h4>description</h4><textarea data-k="body" placeholder="markdown">${esc(it.body)}</textarea></div>
      <div class="sec"><h4>comments ${it.comments?.length || ''}</h4>${comments}
      <div class="row"><label>&gt;</label><input id="comment-in" placeholder="add a comment, ⏎ to send"></div></div>
      <div class="sec"><h4>activity</h4><div id="itact" class="hist">${itemActHTML(it.id)}</div></div>${meta}`;
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
    const url = `${location.origin}/api/monitors/${encodeURIComponent(it.id)}/push`;
    const pushHelp = `<pre class="snip">curl -s ${url} -H 'content-type: application/json' -d '{"value": 42, "message": "…"}'</pre><pre class="snip">hud push ${esc(it.id)} 42 --message "…"</pre>`;
    return `${head}<div class="sec">
      ${row('title', inp('title', it.title, 'what is being watched', 'class="ttl-in"'))}
      ${row('display', chips('display', DISPLAYS, it.display || 'auto'))}
      ${groupRow}
      ${row('wake', inp('notify', (it.notify || []).join(', '), 'session names to wake on alerts'))}
      </div>
      <div class="sec" id="live">${liveHTML(it)}</div>
      <div class="sec"><h4>set reading</h4>
      <div class="row2">${row('value', `<input data-r="value" value="${esc(fmtRaw(it.value))}">`)}${row('unit', inp('unit', it.unit, 'ms, %, …'))}</div>
      ${row('state', chips('r-state', MSTATES, it.state))}
      ${row('label', `<input data-r="label" value="${esc(it.label ?? '')}" placeholder="text shown instead of value">`)}
      ${row('message', `<input data-r="message" value="${esc(it.message ?? '')}">`)}
      ${row('progress', `<input data-r="progress" value="${esc(it.progress ?? '')}" placeholder="0-100">`)}
      <div class="btns"><button class="btn" data-act="push">push reading ⏎</button></div></div>
      <div class="sec"><h4>source</h4>
      ${row('kind', chips('kind', KINDS, k))}
      ${srcFields}
      <div class="btns"><button class="btn" data-act="apply-source">apply source</button>${auto ? '<button class="btn" data-act="run">run now</button>' : ''}</div>
      ${k === 'push' || k === 'manual' ? `<div class="hint">push from anywhere:</div>${pushHelp}` : ''}
      ${k === 'probe' ? '<div class="hint">probes/&lt;name&gt;.ts exports default async (ctx) =&gt; ({value, state, message}) or watch(ctx) — see probes/README</div>' : ''}
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
S.trend = new Map(); // id -> trend points (fetched; not on the live stream)
S.uptime = new Map(); // id -> {h1, h24}
S.itact = new Map(); // ticket id -> Activity[]
function itemActHTML(id) {
  const a = S.itact.get(id);
  if (!a) return '<span class="faint">loading…</span>';
  return a.slice(-40).reverse().map((x) => `${hhmmss(x.t)}  @${esc(x.actor)} ${esc(x.text)}`).join('\n') || '<span class="faint">—</span>';
}
async function fetchItemActivity(id) {
  try {
    S.itact.set(id, await api('GET', `/api/items/${encodeURIComponent(id)}/activity?limit=40`));
    const el = $('#itact');
    if (S.drawer === id && el) el.innerHTML = itemActHTML(id);
  } catch {}
}
async function fetchTrend(id) {
  try {
    const full = await api('GET', `/api/items/${encodeURIComponent(id)}`);
    S.trend.set(id, full.trend || []);
    if (full.uptime) S.uptime.set(id, full.uptime);
    if (S.drawer === id) {
      renderChart();
      if (full.uptime) renderDrawerLive();
    }
  } catch {}
}
setInterval(() => {
  const it = S.drawer && S.items.get(S.drawer);
  if (it?.type === 'monitor') fetchTrend(it.id);
}, 60000);

function renderChart() {
  const el = $('#chart');
  const it = S.items.get(S.drawer);
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
    .map(([k, dash]) => `<line x1="${L}" x2="${W - R}" y1="${Y(it[k])}" y2="${Y(it[k])}" stroke="#777" stroke-dasharray="${dash}" stroke-width="1"/>`)
    .join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
    <line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#333"/><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#333"/>
    <text x="${L - 4}" y="${T + 8}" text-anchor="end">${fmtY(hi)}</text><text x="${L - 4}" y="${H - B}" text-anchor="end">${fmtY(lo)}</text>
    <text x="${L}" y="${H - 4}">${hhmm(t0)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">now</text>
    ${thr}<path d="${area}" fill="rgba(255,255,255,.06)"/><path d="${path}" fill="none" stroke="#fff" stroke-width="1.3"/>
    <circle cx="${X(pts[pts.length - 1].t)}" cy="${Y(pts[pts.length - 1].y)}" r="2.5" fill="#fff"/></svg>
    <div class="meta">${useP ? 'progress %' : esc(it.unit || 'value')} · ${pts.length} points${tr.length ? ` (${tr.length} per-minute)` : ''}</div>`;
}

function renderDrawerLive() {
  const it = S.items.get(S.drawer);
  const live = $('#live');
  if (it && live) {
    live.innerHTML = liveHTML(it);
    renderChart();
  }
}

function renderDrawer() {
  const d = $('#drawer');
  const it = S.items.get(S.drawer);
  if (!it) return closeDrawer();
  S.pendingKind = null;
  if (d.contains(document.activeElement) && document.activeElement !== d && document.activeElement.tagName !== 'BUTTON') {
    S.drawerDirty = true;
    if (it.type === 'monitor') renderDrawerLive();
    return;
  }
  const scroll = d.scrollTop;
  d.innerHTML = drawerHTML(it);
  d.scrollTop = scroll;
  if (it.type === 'monitor') renderChart();
  S.drawerDirty = false;
}

const saveText = debounce((id, k, v) => patchItem(id, { [k]: v }).catch(() => {}), 600);

const saveUtilLater = debounce((id, key, v) => saveUtil(id, key, v), 350);

$('#drawer').addEventListener('input', (e) => {
  const t = e.target;
  if (!S.drawer) return;
  // live-edit a utility's number fields (timer minutes, counter target, sheet size, calculator…)
  if (t.dataset.u) return saveUtilLater(S.drawer, t.dataset.u, t.value);
  const k = t.dataset.k;
  if (k === 'title' || k === 'body' || k === 'text') saveText(S.drawer, k, t.value);
});
$('#drawer').addEventListener('change', (e) => {
  const t = e.target;
  if (!S.drawer) return;
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
$('#drawer').addEventListener('focusout', () => {
  setTimeout(() => {
    if (S.drawerDirty && !$('#drawer').contains(document.activeElement)) renderDrawer();
  }, 0);
});
$('#drawer').addEventListener('keydown', (e) => {
  if (e.target.id === 'comment-in' && e.key === 'Enter' && e.target.value.trim()) {
    const text = e.target.value.trim();
    const box = e.target;
    box.value = '';
    api('POST', `/api/items/${encodeURIComponent(S.drawer)}/comments`, { text }).then(
      () => box.focus(),
      () => (box.value = text), // keep what was typed when the send failed
    );
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
  document.activeElement?.blur();
  return api('POST', `/api/monitors/${encodeURIComponent(it.id)}/push`, r).then(() => renderDrawer()).catch(() => {});
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
  const it = S.items.get(S.drawer);
  if (!it) return;
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
    // plot option chips are namespaced: "plot-points" -> plot.points
    if (key.startsWith('plot-')) return savePlot(it.id, key.slice(5), v).then(() => renderDrawer(), () => {});
    return patchItem(it.id, { [key]: v || null }).then(() => renderDrawer(), () => {});
  }
  const go = e.target.closest('[data-go]');
  if (go) return focusItem(go.dataset.go);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') closeDrawer();
  if (act === 'focus') focusItem(it.id);
  if (act === 'delete') deleteItems([it.id]);
  if (act === 'copy') {
    const txt = e.target.closest('[data-text]').dataset.text;
    return (navigator.clipboard?.writeText(txt) ?? Promise.reject()).then(() => toast('copied'), () => toast(txt));
  }
  if (act === 'cdel' || act === 'cedit' || act === 'csave' || act === 'ccancel') return commentAct(it, act, e.target.closest('.comment'));
  if (act === 'push') pushReading();
  if (act === 'apply-source') applySource();
  if (act === 'run') api('POST', `/api/monitors/${encodeURIComponent(it.id)}/run`).then(() => toast('ran ' + it.id), () => {});
  if (act === 'arrange') api('POST', '/api/arrange', { frame: it.id }).catch(() => {});
  if (act === 'organize') organize();
  if (act === 'fit-frame') fit([it]);
  if (act === 'decide') decide(it.id, e.target.closest('[data-opt]').dataset.opt);
  if (act === 'clear-options') patchItem(it.id, { options: [] }).then(() => renderDrawer(), () => {});
  if (act === 'reopen') patchItem(it.id, { decision: null }).then(() => renderDrawer(), () => {});
});

function commentAct(it, act, box) {
  const cid = box?.dataset.cid;
  if (!cid) return;
  const url = `/api/items/${encodeURIComponent(it.id)}/comments/${encodeURIComponent(cid)}`;
  const c = (it.comments || []).find((x) => x.id === cid);
  if (act === 'cdel') {
    if (!confirm('delete this comment?')) return;
    return api('DELETE', url).then(() => {
      it.comments = (it.comments || []).filter((x) => x.id !== cid);
      renderDrawer();
      renderItem(it);
    }, () => {});
  }
  if (act === 'cedit') {
    box.querySelector('.txt').innerHTML = `<textarea>${esc(c?.text ?? '')}</textarea><div class="btns"><button class="btn" data-act="csave">save</button><button class="btn" data-act="ccancel">cancel</button></div>`;
    return box.querySelector('textarea').focus();
  }
  if (act === 'ccancel') return renderDrawer();
  const text = box.querySelector('textarea').value.trim();
  if (!text) return;
  api('PATCH', url, { text }).then((u) => {
    if (c) Object.assign(c, u);
    document.activeElement?.blur();
    renderDrawer();
  }, () => {});
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
  if (r) toast(`organized · ${r.groups.length} groups · ${r.moved} moved`);
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
}
$('#btn-organize').addEventListener('click', () => organize());
$('#btn-auto').addEventListener('click', () => toggleAuto());
function renderAlerts() {
  const open = S.alerts.filter((a) => !a.acked);
  const el = $('#btn-alerts');
  el.style.display = open.length ? '' : 'none';
  el.textContent = `▲ ${open.length}`;
  el.title = open.slice(-8).map((a) => `${a.itemId}: ${a.from} → ${a.to}${a.message ? ' — ' + a.message : ''}`).join('\n') + '\n\nclick to acknowledge all';
}
$('#btn-alerts').addEventListener('click', async () => {
  await api('POST', '/api/alerts/ack', {}).catch(() => null);
  S.alerts.forEach((a) => (a.acked = true));
  renderAlerts();
});

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
  try {
    localStorage.setItem('hud.activity', on ? '1' : '0');
  } catch {}
  renderActivity();
}
$('#btn-activity').addEventListener('click', () => toggleActivity());

function renderWho() {
  const since = Date.now() - 10 * 60 * 1000;
  const who = [...new Set(S.activity.filter((a) => a.t > since && a.actor !== ME && a.actor !== SYSTEM).map((a) => a.actor))];
  $('#who').textContent = who.length ? who.map((w) => '◆ ' + w).join('  ') : '';
}

// ---------------------------------------------------------------- help
const HELP = `<b>hud</b> — live canvas of tickets, monitors, notes and frames

<b>canvas</b>
  drag empty space        pan          scroll / two-finger    pan
  ⌘/ctrl + scroll, pinch  zoom         + / - / 0              zoom in / out / 100%
  .                       fit all      shift + drag           select box
  double-click empty      add here     double-click item      expand in place
  drag item               move (frames carry their contents; alt = no snap)
  corner handle           resize       space + drag           pan

<b>keys</b>
  t  m  n  f  w           new ticket / monitor / note / frame / widget (util) at cursor
  ⏎                       open selected        ⌫ / del    delete selected (to trash)
  u  or  ⌘/ctrl + z       undo delete          arrows     nudge selected
  T                       trash panel (restore / delete forever)
  l                       list view (search, filters, sort; remembered per board)
  v                       cycle monitor view
  a                       activity feed        [ ]        prev / next board
  o                       organize board       O          toggle auto-organize
  ⌘a                      select all           esc        close / clear
  :                       command line         ?          this help

<b>commands</b>  (press :)
  new &lt;type&gt; [title]      t|m|n|f|u &lt;title&gt;   board &lt;name&gt;   (switch or create)
  rename &lt;name&gt;          board rm &lt;id&gt;       go &lt;id&gt;        fit    zoom &lt;pct&gt;
  organize                group into frames + tidy    auto [on|off]   keep board organized
  group &lt;name&gt;            set group of selected       arrange   simple flow layout
  rm                      delete selected
  push &lt;id&gt; &lt;value&gt;       status &lt;s&gt;  (selected tickets)

<b>agents</b>
  MCP     hud mcp install
  CLI     hud ls · hud add ticket "…" · hud push &lt;id&gt; 42 · hud guide
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

// ---------------------------------------------------------------- command line
const cmdInput = $('#cmd');
const cmdHistory = [];
let cmdIdx = 0;
function openCmd(prefill = '') {
  document.body.classList.add('cmd');
  cmdInput.value = prefill;
  cmdInput.focus();
  cmdIdx = cmdHistory.length;
  setModeHint();
}
function closeCmd() {
  document.body.classList.remove('cmd');
  cmdInput.blur();
  setModeHint();
}
cmdInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') return closeCmd();
  if (e.key === 'ArrowUp') {
    cmdIdx = Math.max(0, cmdIdx - 1);
    cmdInput.value = cmdHistory[cmdIdx] ?? '';
    e.preventDefault();
  }
  if (e.key === 'ArrowDown') {
    cmdIdx = Math.min(cmdHistory.length, cmdIdx + 1);
    cmdInput.value = cmdHistory[cmdIdx] ?? '';
    e.preventDefault();
  }
  if (e.key === 'Enter') {
    const v = cmdInput.value.trim();
    closeCmd();
    if (v) {
      cmdHistory.push(v);
      runCmd(v).catch((err) => toast(err.message));
    }
  }
});
cmdInput.addEventListener('blur', () => setTimeout(() => document.body.classList.contains('cmd') && closeCmd(), 100));

const TYPE_ALIAS = { t: 'ticket', ticket: 'ticket', m: 'monitor', monitor: 'monitor', n: 'note', note: 'note', f: 'frame', frame: 'frame', u: 'util', util: 'util' };
async function runCmd(line) {
  const [c, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');
  const center = () => {
    const r = canvas.getBoundingClientRect();
    return toWorld(r.left + r.width / 2 - 120, r.top + r.height / 2 - 70);
  };
  if (c === 'new' || TYPE_ALIAS[c]) {
    const type = c === 'new' ? TYPE_ALIAS[rest[0]] : TYPE_ALIAS[c];
    if (!type) throw new Error(`usage: new ticket|monitor|note|frame|util [${UTIL_KINDS.join('|')}] [title]`);
    const tail = c === 'new' ? rest.slice(1) : rest;
    const kind = type === 'util' && UTIL_KINDS.includes(tail[0]) ? tail.shift() : undefined;
    const title = tail.join(' ');
    const frame = [...S.sel].map((id) => S.items.get(id)).find((i) => i?.type === 'frame');
    return createAt(type, frame ? null : center(), { title, kind, ...(frame ? { frame: frame.id } : {}) });
  }
  if (c === 'board' || c === 'b') {
    if (rest[0] === 'rm' || rest[0] === 'delete') {
      const id = rest[1];
      if (!id) throw new Error('usage: board rm <id>  (name the board explicitly)');
      const n = [...S.items.values()].filter((i) => i.board === id).length;
      if (!confirm(`Delete board "${id}" and its ${n} item${n === 1 ? '' : 's'}? (it goes to the trash)`)) return;
      await api('DELETE', `/api/boards/${encodeURIComponent(id)}`);
      return toast(`deleted board ${id}`);
    }
    if (!arg) return toast(S.boards.map((b) => b.id).join('  '));
    const b = S.boards.find((x) => x.id === arg || x.name === arg) || (await api('POST', '/api/boards', { name: arg }));
    upsertBoard(b);
    return switchBoard(b.id);
  }
  if (c === 'rename') return api('PATCH', `/api/boards/${encodeURIComponent(S.board)}`, { name: arg });
  if (c === 'fit') return fit();
  if (c === 'zoom' || c === 'z') {
    const r = canvas.getBoundingClientRect();
    return zoomAt(r.left + r.width / 2, r.top + r.height / 2, (Number(arg) || 100) / 100);
  }
  if (c === 'go') return focusItem(arg);
  if (c === 'arrange') {
    const frame = [...S.sel].map((id) => S.items.get(id)).find((i) => i?.type === 'frame');
    return api('POST', '/api/arrange', frame ? { frame: frame.id } : { board: S.board });
  }
  if (c === 'rm' || c === 'delete') return deleteItems(arg ? rest : [...S.sel]);
  if (c === 'organize' || c === 'tidy' || c === 'o') return organize();
  if (c === 'auto') return toggleAuto(arg ? arg === 'on' : undefined);
  if (c === 'group' || c === 'g') {
    const ids = [...S.sel].filter((id) => S.items.get(id)?.type !== 'frame');
    return Promise.all(ids.map((id) => patchItem(id, { group: arg })));
  }
  if (c === 'push') return api('POST', `/api/monitors/${encodeURIComponent(rest[0])}/push`, { value: parseVal(rest.slice(1).join(' ')), board: S.board });
  if (c === 'status' || c === 's') {
    const ids = [...S.sel].filter((id) => S.items.get(id)?.type === 'ticket');
    return Promise.all(ids.map((id) => patchItem(id, { status: arg })));
  }
  if (c === 'help' || c === 'h') return toggleHelp(true);
  throw new Error(`unknown command: ${c}  (? for help)`);
}

// ---------------------------------------------------------------- Linear-style list view
// The canvas is for spatial work; this is for reading and editing tickets the way a tracker does:
// projects → status → tickets, with sub-tickets nested and blockers/branches called out. No coords.
const LIST_ORDER = ['blocked', 'doing', 'review', 'todo', 'backlog', 'done', 'canceled'];

function setMode(m) {
  S.mode = m === 'list' ? 'list' : 'canvas';
  S.sel.clear();
  for (const el of els.values()) el.classList.remove('sel');
  setModeHint();
  document.body.classList.toggle('list', S.mode === 'list');
  const b = $('#btn-view');
  b.textContent = S.mode === 'list' ? 'canvas' : 'list';
  b.classList.toggle('on', S.mode === 'list');
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

const LF_DEFAULT = { q: '', status: '', assignee: '', project: '', priority: '', tag: '', overdue: false, sort: 'status' };
const lfKey = () => `hud.lf.${S.board}`;
function lfGet() {
  if (S.lf?.board === S.board) return S.lf.f;
  let f = {};
  try {
    f = JSON.parse(localStorage.getItem(lfKey()) || '{}') || {};
  } catch {}
  S.lf = { board: S.board, f: { ...LF_DEFAULT, ...f } };
  return S.lf.f;
}
function lfSet(patch) {
  const f = Object.assign(lfGet(), patch);
  try {
    localStorage.setItem(lfKey(), JSON.stringify(f));
  } catch {}
  renderList();
}
const lfActive = (f) => !!(f.q || f.status || f.assignee || f.project || f.priority || f.tag || f.overdue);
const PRIO_RANK = { urgent: 4, high: 3, med: 2, low: 1 };
function lfMatch(t, f, projectsById) {
  if (f.status && (t.status || 'todo') !== f.status) return false;
  if (f.assignee && (t.assignee || '') !== (f.assignee === '-' ? '' : f.assignee)) return false;
  if (f.project && (t.project && projectsById.has(t.project) ? t.project : '-') !== f.project) return false;
  if (f.priority && (t.priority || '') !== (f.priority === '-' ? '' : f.priority)) return false;
  if (f.tag && !(t.tags || []).includes(f.tag)) return false;
  if (f.overdue && !isOverdue(t)) return false;
  if (f.q) {
    const hay = `${identOf(t)} ${t.title || ''} ${t.body || ''} ${t.assignee || ''} ${(t.tags || []).join(' ')}`.toLowerCase();
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
  const html = [
    sel('status', 'status', STATUSES.map((s) => [s, s])),
    sel('assignee', 'assignee', [['-', '(none)'], ...uniq(all.map((t) => t.assignee)).map((a) => [a, a])]),
    sel('project', 'project', [['-', '(none)'], ...projects.map((p) => [p.id, p.key || p.title])]),
    sel('priority', 'priority', [['urgent', 'urgent'], ['high', 'high'], ['med', 'med'], ['low', 'low'], ['-', '(none)']]),
    sel('tag', 'tag', uniq(all.flatMap((t) => t.tags || [])).map((a) => [a, '#' + a])),
    `<label data-f-overdue title="only overdue tickets">‼ overdue</label>`,
    `<select data-f="sort" title="sort"><option value="status">sort: status</option><option value="priority">sort: priority</option><option value="updated">sort: updated</option><option value="target">sort: target</option></select>`,
    `<button class="btn sm" data-f-clear>clear</button>`,
  ].join('');
  const sig = html;
  if (bar.dataset.sig !== sig) {
    const focus = document.activeElement?.dataset?.f;
    bar.dataset.sig = sig;
    bar.innerHTML = `<input type="search" data-f="q" placeholder="search tickets ( / )" spellcheck="false">${html}`;
    if (focus) bar.querySelector(`[data-f="${focus}"]`)?.focus();
  }
  for (const c of $$('[data-f]', bar)) if (c.value !== (f[c.dataset.f] ?? '')) c.value = f[c.dataset.f] ?? '';
  $('[data-f-overdue]', bar).classList.toggle('on', f.overdue);
  $('[data-f-clear]', bar).style.display = lfActive(f) || f.sort !== 'status' ? '' : 'none';
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
  const tickets = allTickets.filter((t) => lfMatch(t, f, projectsById));
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
      t.assignee && `<span class="dim">→${esc(t.assignee)}</span>`,
      targetHTML(t),
      t.blockedBy?.length && `<span class="dep">⊘ ${t.blockedBy.map((b) => esc(nameOf(b))).join(', ')}</span>`,
      t.refs?.length && `<span class="dim">⇒ ${t.refs.map((r) => esc(nameOf(r))).join(', ')}</span>`,
      t.monitors?.length && `<span class="dim">⇢ ${t.monitors.map((m) => esc(m)).join(', ')}</span>`,
      t.comments?.length && `<span class="dim">${t.comments.length}c</span>`,
    ].filter(Boolean).join(' ');
    return `<div class="trow s-${esc(t.status || 'todo')}${needsDecision(t) ? ' needs-decision' : ''}" data-open="${esc(t.id)}" style="--d:${depth}">
      <span class="tg" data-cycle="${esc(t.id)}" title="cycle status">${STATUS_GLYPH[t.status] || '[·]'}</span>
      <span class="tid">${esc(identOf(t))}</span>
      <span class="tcar"${kids.length ? ` data-fold="${esc(t.id)}" title="${folded ? 'expand' : 'collapse'} sub-tickets"` : ''}>${kids.length ? (folded ? '▸' : '▾') : ''}</span>
      <span class="ttt">${esc(t.title) || '<span class="faint">untitled</span>'}</span>
      <span class="tbits">${bits}</span>
      <span class="tbr">${esc(t.branch || '')}</span>
    </div>`;
  };
  const tree = (t, depth) => rowHTML(t, depth) + (S.open.has(t.id) ? '' : kidsOf(t.id).map((c) => tree(c, depth + 1)).join(''));

  const groupHTML = (project, list) => {
    const label = project ? `${esc(project.key || '—')} <span class="pn">${esc(project.title)}</span>` : '<span class="pn">no project</span>';
    const meta = project ? [project.target && `→ ${esc(project.target)}`, project.lead && `@${esc(project.lead)}`].filter(Boolean).join(' ') : '';
    const head = `<div class="tproj"${project ? ` data-proj="${esc(project.id)}"` : ''}>
      <span class="pk">${label}</span><span class="pm">${meta}</span>
      <span class="pc">${list.length} ticket${list.length === 1 ? '' : 's'}</span>
      <button class="btn sm" data-new="${esc(project?.id ?? '')}|todo">＋ ticket</button></div>`;
    if (!list.length) return head + `<div class="tnone">${active ? 'no matching tickets' : 'no tickets'}</div>`;
    const out = [head];
    if (f.sort !== 'status') {
      // a non-status sort flattens the status groups
      for (const t of lfSort(list.filter(isRoot), f)) out.push(tree(t, 0));
      return out.join('');
    }
    // canonical statuses first, then anything else a ticket carries, so rows always add up to the totals
    const present = [...new Set(list.map((t) => t.status || 'todo'))];
    for (const s of [...LIST_ORDER.filter((x) => present.includes(x)), ...present.filter((x) => !LIST_ORDER.includes(x))]) {
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
  else if (!projects.length && !loose.length) html.push('<div class="tnone">no tickets yet — add a project, or press <b>t</b> on the canvas</div>');
  const out = `<div class="lwrap">
    <div class="lhead"><span>tickets</span><span class="dim">${active ? `${tickets.length} of ${allTickets.length}` : `${tickets.length} total`}</span><button class="btn sm" data-new-project="1">＋ project</button></div>
    ${html.join('')}
  </div>`;
  if (host.dataset.sig === out) return;
  host.dataset.sig = out;
  host.innerHTML = out;
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
$('#list').addEventListener('change', (e) => {
  const k = e.target.dataset.f;
  if (k && k !== 'q') lfSet({ [k]: e.target.value });
});
$('#list').addEventListener('click', (e) => {
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
$('#btn-view').addEventListener('click', () => setMode(S.mode === 'list' ? 'canvas' : 'list'));

// ---------------------------------------------------------------- keyboard
const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
};
window.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !typing()) {
    spaceDown = true;
    canvas.classList.add('space');
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (typing()) return document.activeElement.blur();
    if ($('#help').classList.contains('open')) return toggleHelp(false);
    if ($('#trash').classList.contains('open')) return toggleTrash(false);
    if ($('#menu').classList.contains('open')) return closeMenu();
    if (S.drawer) return closeDrawer();
    if (S.expanded.size) return collapseAll();
    return select([]);
  }
  if (typing()) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'a' && S.mode === 'canvas') {
    e.preventDefault();
    return select(boardItems().map((i) => i.id));
  }
  if (mod && e.key === 'z') {
    e.preventDefault();
    return undoDelete();
  }
  if (mod || e.altKey) return;
  if (e.key === 'l') return setMode(S.mode === 'list' ? 'canvas' : 'list');
  const r = canvas.getBoundingClientRect();
  const k = e.key;
  // the canvas shortcuts act on a canvas selection and a canvas cursor, neither of which exists in the list
  if (k === '/' && S.mode === 'list') {
    e.preventDefault();
    return $('#list [data-f="q"]')?.focus();
  }
  if (S.mode === 'list' && !['a', 'u', 'T', '?', ':', ';', '[', ']'].includes(k)) return;
  if (k === ':' || k === ';') {
    e.preventDefault();
    return openCmd();
  }
  if (k === '?') return toggleHelp();
  if (['t', 'm', 'n', 'f', 'w'].includes(k)) {
    e.preventDefault();
    if (e.repeat) return;
    return createAt(k === 'w' ? 'util' : TYPE_ALIAS[k], S.mouse);
  }
  if (k === 'Backspace' || k === 'Delete') return deleteItems([...S.sel]);
  if (k === 'u') return undoDelete();
  if (k === 'Enter' && S.sel.size === 1) return openDrawer([...S.sel][0]);
  if (k === 'v') return cycleDisplay();
  if (k === 'a') return toggleActivity();
  if (k === 'T') return toggleTrash();
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
      if (s?.type === 'frame') for (const c of membersOf(s)) ids.add(c.id);
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
setInterval(() => {
  // relative times + staleness
  for (const it of boardItems()) if (!(drag && drag.ids?.has(it.id))) renderItem(it, true);
  renderWho();
}, 5000);
let spinI = 0;
setInterval(() => {
  spinI = (spinI + 1) % SPIN.length;
  for (const el of $$('.spin')) el.textContent = SPIN[spinI];
  // clocks, running timers and stopwatches need a faster beat than the 5s tick; their signature embeds the
  // rendered text, so a card is only rebuilt when it actually changes (animated charts: every 100 ms)
  for (const id of els.keys()) {
    const it = S.items.get(id);
    if (it && ((it.type === 'util' && isLive(it)) || isAnimated(it))) renderItem(it, true);
  }
}, 100);
window.addEventListener('resize', applyView);

// ---------------------------------------------------------------- boot
try {
  if (localStorage.getItem('hud.activity') === '1') toggleActivity(true);
} catch {}

/** open the stream first so nothing emitted during the snapshot fetch is lost, then load and replay */
async function boot() {
  connect();
  for (;;) {
    try {
      await load();
      break;
    } catch (e) {
      // api() already toasted a network/server error; a render bug is isolated per item and cannot land here
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
  renderWho();
}
boot();
window.addEventListener('hashchange', () => {
  const id = hashId();
  if (id && id !== S.board && S.boards.some((b) => b.id === id)) switchBoard(id);
});
