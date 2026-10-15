// hud — chart renderers. Plain ES module, monochrome, inline SVG, no dependencies.
//
// Two ways an agent gets a chart on the canvas:
//   1. `display: 'line' | 'pie' | 'scatter3d' | …` plus a `plot` object of options. Fixed renderers, covered here.
//   2. `display: 'view:<name>'` naming a module in views/ that exports render(ctx). Loaded by app.js, not here.
//
// Every builder sizes itself from the card and registers hit-test geometry so the hover readout in app.js
// can show exact values without re-deriving the series.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const fmt = (v) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(Math.abs(n) < 10 ? 2 : 1);
};
// loops, not Math.min(...a): spreading a big array overflows the call stack
const minOf = (a, ...x) => { let m = Infinity; for (const v of a) if (v < m) m = v; for (const v of x) if (v < m) m = v; return m; };
const maxOf = (a, ...x) => { let m = -Infinity; for (const v of a) if (v > m) m = v; for (const v of x) if (v > m) m = v; return m; };
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const DISPLAY_KINDS = [
  'auto', 'value', 'progress', 'status', 'text', 'log', 'spark',
  'line', 'area', 'bars', 'gauge', 'histogram', 'scatter', 'pie', 'donut',
  'heatmap', 'box', 'ridgeline', 'scatter3d', 'surface3d',
];

const EMPTY = '<div class="chart-empty faint">not enough readings yet</div>';

// ---------------------------------------------------------------- data extraction

/** resolve a dot path ("a.b.0.c") against an object; '' / undefined means "the whole thing" */
function dig(obj, path) {
  if (!path) return obj;
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** numeric series a monitor carries: progress if it has one, else its value */
export function seriesOf(it) {
  const useP = it.progress != null && !(it.max && typeof it.value === 'number');
  const key = useP ? 'p' : 'v';
  const pts = (it.history || [])
    .map((h) => ({ t: h.t, v: h[key] }))
    .filter((p) => p.v !== null && p.v !== undefined && Number.isFinite(Number(p.v)))
    .map((p) => ({ t: p.t, v: Number(p.v) }));
  return { pts, key };
}

/**
 * Named values for the categorical kinds (pie/donut/bars/heatmap/ridgeline).
 * Reads `plot.series` as a dot path into `item.meta` (default: `categories`).
 * Accepts {name: number}, [number], [{label, value}] or [[label, value]].
 */
export function categoriesOf(it, plot) {
  const raw = dig(it.meta ?? {}, plot?.series || 'categories');
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((e, i) =>
        Array.isArray(e)
          ? { name: String(e[0]), value: Number(e[1]) }
          : typeof e === 'object' && e !== null
            ? { name: String(e.label ?? e.name ?? i), value: Number(e.value) }
            : { name: String(i), value: Number(e) },
      )
      .filter((e) => Number.isFinite(e.value));
  }
  if (typeof raw === 'object') {
    return Object.entries(raw)
      .map(([name, value]) => ({ name, value: Number(value) }))
      .filter((e) => Number.isFinite(e.value));
  }
  return [];
}

/**
 * Free points for the scatter kinds. Reads `plot.series` as a dot path into `item.meta`
 * (default: `points`). Accepts [n], [[x, y]] or [[x, y, z]].
 */
export function pointsOf(it, plot, dims = 2) {
  const raw = dig(it.meta ?? {}, plot?.series || 'points');
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e, i) => (Array.isArray(e) ? e.map(Number) : [i, Number(e)]))
    .filter((p) => p.length >= dims && p.slice(0, dims).every((n) => Number.isFinite(n)));
}

/** a 2D grid for the heatmap / surface: meta.<series> is an array of equal-length rows */
export function gridOf(it, plot) {
  const raw = dig(it.meta ?? {}, plot?.series || 'grid');
  if (!Array.isArray(raw) || !raw.length) return null;
  const rows = raw.map((r) => (Array.isArray(r) ? r.map(Number) : [Number(r)]));
  if (!rows.every((r) => r.every((n) => Number.isFinite(n)))) return null;
  const width = maxOf(rows.map((r) => r.length));
  return { rows: rows.map((r) => [...r, ...Array(width - r.length).fill(0)]), width, height: rows.length };
}

// ---------------------------------------------------------------- y-range (stretch / squeeze)

/**
 * The visible y-range. `auto` (the default) is the data range padded 8%; setting yMin/yMax pins an edge,
 * and `auto: false` with both set is a hard window. Thresholds still draw when they fall inside.
 */
export function rangeOf(values, plot) {
  let lo = minOf(values);
  let hi = maxOf(values);
  if (!values.length || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    const e = Math.max(1, Math.abs(lo)) * 1e-6; // relative: +1 is a no-op above 2^53
    lo -= e;
    hi += e;
  }
  const pinned = plot?.yMin != null || plot?.yMax != null || plot?.auto === false;
  if (!pinned) {
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
  }
  if (plot?.yMin != null) lo = Number(plot.yMin);
  if (plot?.yMax != null) hi = Number(plot.yMax);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) hi = lo + 1;
  return { lo, hi, pinned };
}

// ---------------------------------------------------------------- hover geometry

/** per-item hit-test data from the last render, consumed by the hover readout in app.js */
const HITS = new Map();
export function hitsOf(id) {
  return HITS.get(id) || null;
}
export function dropHits(id) {
  HITS.delete(id);
}
/** renderer modules register their own hit geometry through this */
export function setHits(id, hits) {
  if (id) HITS.set(id, { hits: hits ?? [], W: 0, H: 0 });
}
function register(id, model) {
  if (id) HITS.set(id, model);
  return model;
}

// ---------------------------------------------------------------- shared svg helpers

const THRESHOLDS = [['warnAbove', '4 3'], ['errorAbove', '1 0'], ['warnBelow', '4 3'], ['errorBelow', '1 0']];

function thresholdLines(it, key, lo, hi, Y, W, L, R) {
  if (key !== 'v') return '';
  return THRESHOLDS.filter(([k]) => it[k] != null && it[k] >= lo && it[k] <= hi)
    .map(([k, dash]) => `<line class="thr" x1="${L}" x2="${W - R}" y1="${Y(it[k]).toFixed(1)}" y2="${Y(it[k]).toFixed(1)}" stroke="#777" stroke-dasharray="${dash}" stroke-width="1"/>`)
    .join('');
}

/** open/close an SVG with the house style; `hits` are screen-space points the hover layer snaps to */
function svg(it, cls, W, H, body, hits) {
  register(it?.id, hits ? { hits, W, H } : null);
  const h = it?.h ?? H;
  return `<svg class="v ${cls}" viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none" data-h="${h}">${body}</svg>`;
}

/** monochrome ramp for categorical fills — no hue, only brightness */
const shade = (i, n) => 0.14 + 0.72 * (1 - (n <= 1 ? 0 : i / (n - 1)));

// ---------------------------------------------------------------- 1D: line / area / bars

export function lineSVG(it, w, h, plot = {}) {
  const { pts, key } = viewed(it, plot);
  const W = Math.max(70, w), H = Math.max(54, h);
  if (pts.length < 2) return EMPTY;
  const vals = pts.map((p) => p.v);
  const { lo, hi } = rangeOf(vals, plot);
  const L = 38, R = 6, T = 8, B = 16, n = pts.length;
  const X = (i) => L + (i / (n - 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const cl = (v) => clamp(Y(v), T - 2, H - B + 2);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${cl(v).toFixed(1)}`).join(' ');
  const area = `${d} L${X(n - 1).toFixed(1)} ${(H - B).toFixed(1)} L${X(0).toFixed(1)} ${(H - B).toFixed(1)} Z`;
  const yl = [hi, (hi + lo) / 2, lo].map((v) => `<text x="4" y="${(cl(v) + 3).toFixed(1)}">${fmt(v)}</text>`).join('');
  const xl = `<text x="${L}" y="${H - 3}">${hhmm(pts[0].t)}</text><text x="${W - R}" y="${H - 3}" text-anchor="end">${hhmm(pts[n - 1].t)}</text>`;
  const dots = plot.points
    ? vals.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${cl(v).toFixed(1)}" r="1.8" fill="#fff"/>`).join('')
    : '';
  const hits = pts.map((p, i) => ({ px: X(i), py: cl(p.v), value: p.v, t: p.t }));
  return svg(it, 'line', W, H, `<path d="${area}" fill="rgba(255,255,255,.06)"/><path d="${d}" fill="none" stroke="#fff" stroke-width="1.2"/>${dots}${thresholdLines(it, key, lo, hi, cl, W, L, R)}${yl}${xl}`, hits);
}

export function areaSVG(it, w, h, plot = {}) {
  return lineSVG(it, w, h, { ...plot, points: plot.points ?? true });
}

export function barsSVG(it, w, h, plot = {}) {
  const cats = categoriesOf(it, plot);
  const W = Math.max(70, w), H = Math.max(44, h);
  const L = 30, R = 4, T = 10, B = 16;
  if (cats.length) return catBars(it, cats, W, H, L, R, T, B, plot);

  const { pts } = viewed(it, plot);
  if (!pts.length) return EMPTY;
  const last = pts.slice(-Math.max(4, Math.floor(W / 8)));
  const { lo, hi } = rangeOf(last.map((p) => p.v).concat(0), { ...plot, auto: plot.auto ?? false });
  const bw = (W - L - R) / last.length;
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const bars = last
    .map((p, i) => {
      const y = clamp(Y(p.v), T, H - B);
      return `<rect x="${(L + i * bw + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(0, H - B - y).toFixed(1)}" fill="#fff"/>`;
    })
    .join('');
  const hits = last.map((p, i) => ({ px: L + i * bw + bw / 2, py: clamp(Y(p.v), T, H - B), value: p.v, t: p.t }));
  const yl = `<text x="2" y="${(T + 8).toFixed(1)}">${fmt(hi)}</text><text x="2" y="${H - B}">${fmt(lo)}</text>`;
  return svg(it, 'bars', W, H, `${bars}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#333"/>${yl}`, hits);
}

function catBars(it, cats, W, H, L, R, T, B, plot) {
  const max = maxOf(cats.map((c) => c.value), 0);
  const bw = (W - L - R) / cats.length;
  const rows = Math.max(1, Math.floor((H - T - B) / 14));
  const step = Math.max(1, Math.ceil(cats.length / rows));
  const bars = cats
    .map((c, i) => {
      const bh = max > 0 ? (Math.max(0, c.value) / max) * (H - T - B) : 0;
      return `<rect x="${(L + i * bw + 0.5).toFixed(1)}" y="${(H - B - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="rgba(255,255,255,${shade(i, cats.length).toFixed(2)})"/>`;
    })
    .join('');
  const lbl = cats
    .filter((_, i) => i % step === 0)
    .map((c, i) => `<text x="${(L + i * step * bw + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${esc(String(c.name).slice(0, 8))}</text>`)
    .join('');
  const hits = cats.map((c, i) => ({ px: L + i * bw + bw / 2, py: H - B, value: c.value, label: c.name }));
  return svg(it, 'bars', W, H, `${bars}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#333"/><text x="2" y="${T + 6}">${fmt(max)}</text>${lbl}`, hits);
}

// ---------------------------------------------------------------- distributions

export function histogramSVG(it, w, h, plot = {}) {
  const { pts } = viewed(it, plot);
  const W = Math.max(70, w), H = Math.max(44, h);
  if (pts.length < 2) return EMPTY;
  const bins = clamp(Math.round(Number(plot.bins) || 12), 2, 60);
  const vals = pts.map((p) => p.v);
  const lo = minOf(vals), hi = maxOf(vals);
  const span = hi - lo || 1;
  const counts = Array(bins).fill(0);
  for (const v of vals) counts[clamp(Math.floor(((v - lo) / span) * bins), 0, bins - 1)]++;
  return barChartCore(it, counts.map((c, i) => ({ name: fmt(lo + (i + 0.5) * (span / bins)), value: c })), W, H, plot, 'histogram');
}

export function boxSVG(it, w, h, plot = {}) {
  const { pts } = viewed(it, plot);
  const W = Math.max(80, w), H = Math.max(60, h);
  if (pts.length < 4) return EMPTY;
  const vals = pts.map((p) => p.v).sort((a, b) => a - b);
  const q = (p) => vals[clamp(Math.floor(p * (vals.length - 1)), 0, vals.length - 1)];
  const lo = vals[0], hi = vals[vals.length - 1], med = q(0.5), q1 = q(0.25), q3 = q(0.75);
  const { lo: rlo, hi: rhi } = rangeOf([lo, hi], plot);
  const L = 34, R = 8, T = 14, B = 18;
  const Y = (v) => T + (1 - (v - rlo) / (rhi - rlo)) * (H - T - B);
  const cx = (L + W - R) / 2;
  const bw = Math.max(10, (W - L - R) * 0.4);
  const bx = cx - bw / 2;
  const sy = clamp(Y(q1), T, H - B), ey = clamp(Y(q3), T, H - B);
  const body = `
    <line x1="${bx + bw / 2}" x2="${bx + bw / 2}" y1="${clamp(Y(lo), T, H - B).toFixed(1)}" y2="${sy.toFixed(1)}" stroke="#777"/>
    <line x1="${bx + bw / 2}" x2="${bx + bw / 2}" y1="${ey.toFixed(1)}" y2="${clamp(Y(hi), T, H - B).toFixed(1)}" stroke="#777"/>
    <line x1="${bx}" x2="${bx + bw}" y1="${clamp(Y(lo), T, H - B).toFixed(1)}" y2="${clamp(Y(lo), T, H - B).toFixed(1)}" stroke="#fff"/>
    <line x1="${bx}" x2="${bx + bw}" y1="${clamp(Y(hi), T, H - B).toFixed(1)}" y2="${clamp(Y(hi), T, H - B).toFixed(1)}" stroke="#fff"/>
    <rect x="${bx.toFixed(1)}" y="${sy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, ey - sy).toFixed(1)}" fill="rgba(255,255,255,.12)" stroke="#fff"/>
    <line x1="${bx.toFixed(1)}" x2="${(bx + bw).toFixed(1)}" y1="${clamp(Y(med), T, H - B).toFixed(1)}" y2="${clamp(Y(med), T, H - B).toFixed(1)}" stroke="#fff" stroke-width="2"/>
    <text x="2" y="${(T + 8).toFixed(1)}">${fmt(rhi)}</text><text x="2" y="${H - B}">${fmt(rlo)}</text>
    <text x="${cx.toFixed(1)}" y="${H - 4}" text-anchor="middle">min ${fmt(lo)} · q1 ${fmt(q1)} · med ${fmt(med)} · q3 ${fmt(q3)} · max ${fmt(hi)}</text>`;
  return svg(it, 'box', W, H, body, [
    { px: cx, py: clamp(Y(med), T, H - B), value: med, label: 'median' },
    { px: cx, py: clamp(Y(q1), T, H - B), value: q1, label: 'q1' },
    { px: cx, py: clamp(Y(q3), T, H - B), value: q3, label: 'q3' },
  ]);
}

export function ridgelineSVG(it, w, h, plot = {}) {
  const W = Math.max(80, w), H = Math.max(60, h);
  // either several named distributions in meta, or the series cut into equal windows
  let groups = [];
  const raw = dig(it.meta ?? {}, plot.series || 'distributions');
  if (Array.isArray(raw) && raw.every((r) => Array.isArray(r))) {
    groups = raw.map((r, i) => ({ name: String(i), values: r.map(Number).filter(Number.isFinite) }));
  } else {
    const { pts } = viewed(it, plot);
    const slices = clamp(Math.round(Number(plot.stacked) || 5), 2, 8);
    const size = Math.ceil(pts.length / slices);
    for (let i = 0; i < slices && i * size < pts.length; i++) {
      groups.push({ name: `${i * size}`, values: pts.slice(i * size, (i + 1) * size).map((p) => p.v) });
    }
  }
  const all = groups.flatMap((g) => g.values);
  if (all.length < 4) return EMPTY;
  const lo = minOf(all), hi = maxOf(all);
  const bins = clamp(Math.round(Number(plot.bins) || 14), 4, 40);
  const span = hi - lo || 1;
  const L = 24, R = 6, T = 8, B = 14;
  const rowH = (H - T - B) / Math.max(1, groups.length);
  const hits = [];
  const body = groups
    .map((g, gi) => {
      const counts = Array(bins).fill(0);
      for (const v of g.values) counts[clamp(Math.floor(((v - lo) / span) * bins), 0, bins - 1)]++;
      const max = maxOf(counts, 1);
      const base = T + rowH * (gi + 1);
      const bw = (W - L - R) / bins;
      const d = counts
        .map((c, i) => `${i ? 'L' : 'M'}${(L + i * bw).toFixed(1)} ${(base - (c / max) * rowH * 0.92).toFixed(1)}`)
        .join(' ');
      hits.push({ px: W - 4, py: base - rowH / 2, value: g.values.length, label: `row ${gi}: ${g.values.length} pts` });
      return `<path d="${d} L${(W - R).toFixed(1)} ${base.toFixed(1)} L${L} ${base.toFixed(1)} Z" fill="rgba(255,255,255,${(0.05 + 0.06 * gi).toFixed(2)})" stroke="#fff" stroke-width="1"/>`;
    })
    .join('');
  return svg(it, 'ridge', W, H, body, hits);
}

export function heatmapSVG(it, w, h, plot = {}) {
  const W = Math.max(80, w), H = Math.max(60, h);
  const g = gridOf(it, plot);
  if (!g) {
    // fall back to a 1-row heat strip of the series
    const { pts } = viewed(it, plot);
    if (pts.length < 2) return EMPTY;
    const vals = pts.slice(-Math.floor(W / 4)).map((p) => p.v);
    const lo = minOf(vals), hi = maxOf(vals);
    const cw = W / vals.length;
    const body = vals
      .map((v, i) => `<rect x="${(i * cw).toFixed(1)}" y="4" width="${Math.max(1, cw).toFixed(1)}" height="${H - 8}" fill="rgba(255,255,255,${(0.08 + 0.84 * ((v - lo) / (hi - lo || 1))).toFixed(2)})"/>`)
      .join('');
    const hits = vals.map((v, i) => ({ px: i * cw + cw / 2, py: H / 2, value: v }));
    return svg(it, 'heat', W, H, body, hits);
  }
  const lo = minOf(g.rows.flat()), hi = maxOf(g.rows.flat());
  const cw = W / g.width, ch = H / g.height;
  const hits = [];
  const body = g.rows
    .map((row, y) =>
      row
        .map((v, x) => {
          hits.push({ px: x * cw + cw / 2, py: y * ch + ch / 2, value: v, label: `${x},${y}` });
          return `<rect x="${(x * cw).toFixed(1)}" y="${(y * ch).toFixed(1)}" width="${Math.max(1, cw).toFixed(1)}" height="${Math.max(1, ch).toFixed(1)}" fill="rgba(255,255,255,${(0.06 + 0.86 * ((v - lo) / (hi - lo || 1))).toFixed(2)})"/>`;
        })
        .join(''),
    )
    .join('');
  return svg(it, 'heat', W, H, body, hits);
}

// ---------------------------------------------------------------- pie / donut

function pieCore(it, w, h, plot, donut) {
  const cats = categoriesOf(it, plot);
  const W = Math.max(80, w), H = Math.max(60, h);
  const vals = cats.filter((c) => c.value > 0);
  const total = vals.reduce((s, c) => s + c.value, 0);
  if (!vals.length || total <= 0) return EMPTY;
  const cx = donut ? W * 0.38 : W / 2;
  const cy = H / 2;
  const r = Math.min(cx, cy) - 6;
  const inner = donut ? r * (clamp(Number(plot?.bins) || 55, 10, 85) / 100) : 0;
  const hits = [];
  let a = -Math.PI / 2;
  const body = vals
    .map((c, i) => {
      const sweep = (c.value / total) * Math.PI * 2;
      const a1 = a + sweep;
      const pt = (ang, rad) => `${(cx + rad * Math.cos(ang)).toFixed(1)} ${(cy + rad * Math.sin(ang)).toFixed(1)}`;
      const large = sweep > Math.PI ? 1 : 0;
      const d =
        inner > 0
          ? `M${pt(a, inner)} L${pt(a, r)} A${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} 1 ${pt(a1, r)} L${pt(a1, inner)} A${inner.toFixed(1)} ${inner.toFixed(1)} 0 ${large} 0 ${pt(a, inner)} Z`
          : `M${cx} ${cy} L${pt(a, r)} A${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} 1 ${pt(a1, r)} Z`;
      const mid = a + sweep / 2;
      hits.push({ px: cx + r * 0.65 * Math.cos(mid), py: cy + r * 0.65 * Math.sin(mid), value: c.value, label: c.name, pct: (c.value / total) * 100 });
      a = a1;
      return `<path d="${d}" fill="rgba(255,255,255,${shade(i, vals.length).toFixed(2)})" stroke="#000" stroke-width="1"/>`;
    })
    .join('');
  // legend down the right (donut) or under the pie
  const ly = H / 2 - (vals.length * 11) / 2;
  const legend = donut
    ? vals
        .map((c, i) => `<g><rect x="${(W - 76).toFixed(1)}" y="${(ly + i * 11 - 6).toFixed(1)}" width="6" height="6" fill="rgba(255,255,255,${shade(i, vals.length).toFixed(2)})"/><text x="${(W - 66).toFixed(1)}" y="${(ly + i * 11).toFixed(1)}">${esc(String(c.name).slice(0, 10))} ${fmt(c.value)}</text></g>`)
        .join('')
    : '';
  const center = donut ? `<text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" class="gv">${fmt(total)}</text>` : '';
  return svg(it, donut ? 'donut' : 'pie', W, H, `${body}${center}${legend}`, hits);
}
export const pieSVG = (it, w, h, plot = {}) => pieCore(it, w, h, plot, false);
export const donutSVG = (it, w, h, plot = {}) => pieCore(it, w, h, plot, true);

// ---------------------------------------------------------------- 3D: scatter / surface

/** normalize to [-1,1], rotate by azimuth+elevation, project with a simple perspective divide */
function makeCamera(points, plot, W, H) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]), zs = points.map((p) => (p[2] ?? 0));
  const mid = (a) => (minOf(a) + maxOf(a)) / 2;
  const half = (a) => (maxOf(a) - minOf(a)) / 2 || 1;
  const cx = mid(xs), cy = mid(ys), cz = mid(zs);
  const hx = half(xs), hy = half(ys), hz = half(zs);
  const az = ((plot.tilt ?? 35) * Math.PI) / 180;
  const el = ((plot.spin ?? 22) * Math.PI) / 180;
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  const scale = Math.min(W, H) * 0.36;
  return (p) => {
    const nx = (p[0] - cx) / hx, ny = (p[1] - cy) / hy, nz = ((p[2] ?? 0) - cz) / hz;
    const x1 = nx * ca - ny * sa;
    const y1 = nx * sa + ny * ca;
    const y2 = y1 * ce - nz * se;
    const z2 = y1 * se + nz * ce;
    const f = 1 / (2.6 + z2); // perspective divide
    return { x: W / 2 + x1 * scale * f * 2.6, y: H / 2 - y2 * scale * f * 2.6, z: z2 };
  };
}

export function scatter3dSVG(it, w, h, plot = {}) {
  const pts = pointsOf(it, plot, 3);
  const W = Math.max(90, w), H = Math.max(70, h);
  if (pts.length < 2) return EMPTY;
  const cam = makeCamera(pts, plot, W, H);
  const projected = pts.map((p) => ({ ...cam(p), v: p }));
  projected.sort((a, b) => b.z - a.z); // far first
  const zs = pts.map((p) => p[2]);
  const zlo = minOf(zs), zhi = maxOf(zs);
  const body = projected
    .map((q) => {
      const a = 0.35 + 0.6 * ((q.v[2] - zlo) / (zhi - zlo || 1));
      const rr = 1.2 + 1.6 * ((q.v[2] - zlo) / (zhi - zlo || 1));
      return `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${rr.toFixed(1)}" fill="rgba(255,255,255,${a.toFixed(2)})"/>`;
    })
    .join('');
  const hits = projected.map((q) => ({ px: q.x, py: q.y, value: q.v[2], label: `(${fmt(q.v[0])}, ${fmt(q.v[1])})` }));
  return svg(it, 'scatter3d', W, H, `${box3d(cam, W, H)}${body}<text x="4" y="${H - 4}">${pts.length} pts · z ${fmt(zlo)}…${fmt(zhi)}</text>`, hits);
}

/** the bounding cube, for orientation */
function box3d(cam, W, H) {
  const c = [-1, 1];
  const seg = (a, b) => {
    const p = cam(a), q = cam(b);
    return `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="#333" stroke-width="1"/>`;
  };
  let out = '';
  for (const y of c) for (const z of c) out += seg([-1, y, z], [1, y, z]);
  for (const x of c) for (const z of c) out += seg([x, -1, z], [x, 1, z]);
  for (const x of c) for (const y of c) out += seg([x, y, -1], [x, y, 1]);
  return out;
}

export function surface3dSVG(it, w, h, plot = {}) {
  const g = gridOf(it, plot);
  const W = Math.max(100, w), H = Math.max(80, h);
  if (!g) return EMPTY;
  const pts = [];
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) pts.push([x / g.width, y / g.height, g.rows[y][x]]);
  const cam = makeCamera(pts, plot, W, H);
  const zs = g.rows.flat();
  const zlo = minOf(zs), zhi = maxOf(zs);
  const quads = [];
  for (let y = 0; y < g.height - 1; y++) {
    for (let x = 0; x < g.width - 1; x++) {
      const corners = [[x / g.width, y / g.height], [(x + 1) / g.width, y / g.height], [(x + 1) / g.width, (y + 1) / g.height], [x / g.width, (y + 1) / g.height]].map(
        ([px, py]) => {
          const v = g.rows[Math.min(g.height - 1, Math.round(py * g.height))][Math.min(g.width - 1, Math.round(px * g.width))];
          return cam([px, py, v]);
        },
      );
      const depth = corners.reduce((s, c) => s + c.z, 0) / 4;
      const v = g.rows[y][x];
      quads.push({ depth, v, d: `M${corners.map((c) => `${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join('L')}Z` });
    }
  }
  quads.sort((a, b) => b.depth - a.depth);
  const body = quads.map((q) => `<path d="${q.d}" fill="rgba(255,255,255,${(0.05 + 0.6 * ((q.v - zlo) / (zhi - zlo || 1))).toFixed(2)})" stroke="#000" stroke-width="0.4"/>`).join('');
  const hits = quads.slice(0, 40).map((q) => ({ px: W / 2, py: H / 2, value: q.v, label: 'cell' }));
  return svg(it, 'surface3d', W, H, `${body}<text x="4" y="${H - 4}">${g.width}×${g.height} · ${fmt(zlo)}…${fmt(zhi)}</text>`, hits);
}

export function scatterSVG(it, w, h, plot = {}) {
  const pts = pointsOf(it, plot, 2);
  const W = Math.max(80, w), H = Math.max(60, h);
  if (pts.length < 2) return EMPTY;
  const L = 32, R = 6, T = 8, B = 16;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const xlo = minOf(xs), xhi = maxOf(xs);
  const { lo, hi } = rangeOf(ys, plot);
  const X = (v) => L + ((v - xlo) / (xhi - xlo || 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const body = pts.map((p) => `<circle cx="${X(p[0]).toFixed(1)}" cy="${clamp(Y(p[1]), T, H - B).toFixed(1)}" r="2" fill="#fff" fill-opacity=".85"/>`).join('');
  const hits = pts.map((p) => ({ px: X(p[0]), py: clamp(Y(p[1]), T, H - B), value: p[1], label: `x ${fmt(p[0])}` }));
  const yl = `<text x="2" y="${(T + 8).toFixed(1)}">${fmt(hi)}</text><text x="2" y="${H - B}">${fmt(lo)}</text>`;
  return svg(it, 'scatter', W, H, `<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#333"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#333"/>${body}${yl}`, hits);
}

// ---------------------------------------------------------------- gauge

export function gaugeSVG(it, w, h, plot = {}) {
  const pct = it.progress != null ? it.progress : it.max && typeof it.value === 'number' ? (it.value / it.max) * 100 : null;
  if (pct == null) return `<div class="big">${esc(fmt(it.value ?? '—'))}</div>`;
  const p = clamp(pct, 0, 100);
  const W = Math.max(90, w), H = Math.max(60, h);
  const cx = W / 2, cy = H * 0.8, r = Math.min(W / 2 - 8, H * 0.68);
  const arc = (from, to, stroke, sw) => {
    const x0 = (cx + r * Math.cos(from)).toFixed(1), y0 = (cy + r * Math.sin(from)).toFixed(1);
    const x1 = (cx + r * Math.cos(to)).toFixed(1), y1 = (cy + r * Math.sin(to)).toFixed(1);
    return `<path d="M${x0} ${y0} A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${x1} ${y1}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
  };
  const body = `${arc(Math.PI, 2 * Math.PI, '#333', 8)}${p > 0 ? arc(Math.PI, Math.PI * (1 + p / 100), '#fff', 8) : ''}<text x="${cx}" y="${(cy - 4).toFixed(1)}" text-anchor="middle" class="gv">${Math.round(p)}%</text>`;
  return svg(it, 'gauge', W, H, body, [{ px: cx + r * Math.cos(Math.PI * (1 + p / 100)), py: cy + r * Math.sin(Math.PI * (1 + p / 100)), value: p, label: 'percent' }]);
}

// ---------------------------------------------------------------- dispatch

/**
 * Which view to show when the monitor is on `auto`. Re-evaluated on every render (and every ticker pass),
 * so a monitor grows from a number into a chart on its own once it has a series, and into a pie once
 * whoever feeds it starts publishing named values in meta.
 */
export function autoDisplay(it) {
  if (it.progress !== null && it.progress !== undefined) return 'progress';
  const numeric = typeof it.value === 'number' && Number.isFinite(it.value);
  const n = (it.history || []).filter((x) => x.v !== null && x.v !== undefined).length;
  if (numeric && n >= 2) return 'line';
  if (numeric) return 'value';
  if (categoriesOf(it, it.plot).length >= 2) return 'pie';
  if (pointsOf(it, it.plot, 3).length >= 2) return 'scatter3d';
  if (it.label != null && it.label !== '') return 'text';
  if (it.value !== null && it.value !== undefined && it.value !== '') return 'text';
  return 'status';
}

/** Render a chart view, or '' for the views the card draws itself (value/progress/text/status/log/spark). */
export function renderChart(disp, it, ctx) {
  const w = Math.max(70, (it.w || 260) - 20);
  const h = Math.max(40, (it.h || 150) - (ctx?.reserve ?? 58));
  const out = drawChart(disp, it, w, h, animated(it.plot));
  // non-finite coordinates (huge/odd values) would make the browser log an error per attribute on every redraw
  return /NaN|Infinity/.test(out) ? EMPTY : out;
}

function drawChart(disp, it, w, h, plot) {
  switch (disp) {
    case 'line': return lineSVG(it, w, h, plot);
    case 'area': return areaSVG(it, w, h, plot);
    case 'bars': return barsSVG(it, w, h, plot);
    case 'gauge': return gaugeSVG(it, w, h, plot);
    case 'histogram': return histogramSVG(it, w, h, plot);
    case 'scatter': return scatterSVG(it, w, h, plot);
    case 'pie': return pieSVG(it, w, h, plot);
    case 'donut': return donutSVG(it, w, h, plot);
    case 'heatmap': return heatmapSVG(it, w, h, plot);
    case 'box': return boxSVG(it, w, h, plot);
    case 'ridgeline': return ridgelineSVG(it, w, h, plot);
    case 'scatter3d': return scatter3dSVG(it, w, h, plot);
    case 'surface3d': return surface3dSVG(it, w, h, plot);
    default: return '';
  }
}

/**
 * `plot.animate`: "orbit" turns a 3-D view slowly, "replay" sweeps a series in from the left. Both are driven
 * by the wall clock here, so a caller only has to re-render — nothing is written back to the item.
 */
export function animated(plot, t = Date.now()) {
  if (!plot?.animate || plot.animate === 'none') return plot || {};
  if (plot.animate === 'orbit') return { ...plot, tilt: plot.tilt ?? 35, spin: (((plot.spin ?? 22) + t / 40) % 360) };
  if (plot.animate === 'replay') return { ...plot, reveal: 0.35 + 0.65 * (((t % 4000) / 4000 + 1) % 1) };
  return plot;
}

/** does this item need re-rendering every tick to keep its animation moving? */
export const isAnimated = (it) => !!it?.plot?.animate && it.plot.animate !== 'none';

/** the series as it should be drawn right now — `plot.reveal` (from animate: "replay") shortens it */
function viewed(it, plot) {
  const { pts, key } = seriesOf(it);
  if (!plot?.reveal) return { pts, key };
  const n = Math.max(2, Math.round(pts.length * clamp(Number(plot.reveal), 0.05, 1)));
  return { pts: pts.slice(-n), key };
}

/** shared by histogram + categorical bars */
function barChartCore(it, cats, W, H, plot, cls) {  const body = catBars(it, cats, W, H, 30, 4, 10, 16, plot);
  return body.replace('class="v bars"', `class="v ${cls}"`);
}

/**
 * The primitives a renderer module should use, so agent-authored charts look like built-in ones.
 * Exporting at the bottom keeps the const bindings above out of their temporal dead zone.
 */
export const helpers = { esc, fmt, clamp, shade, seriesOf, categoriesOf, pointsOf, gridOf, rangeOf, svg };
