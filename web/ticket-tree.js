// Animated ticket tree for the Tickets view. Nodes are idents; parent edges are elbows, blockedBy edges are arcs
// with an arrowhead. Motion runs on springs in one rAF loop rather than CSS transitions, so it can be retargeted
// mid-flight and survives the list re-rendering the element into a new placeholder.

const SVG = 'http://www.w3.org/2000/svg';
const NODE_H = 26;
const CHAR_W = 7.3;
const H_GAP = 16;
const V_GAP = 62;
const PAD = 22;
const STIFF = 150;
const DAMP = 22;

export const TREE_GLYPH = { backlog: '○', todo: '○', doing: '◐', review: '◑', blocked: '▲', done: '✓', canceled: '–', decision: '?' };
const FINISHED = new Set(['done', 'canceled']);

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
};
const nodeWidth = (ident) => Math.round(34 + ident.length * CHAR_W);
const identNum = (ident) => Number(/(\d+)$/.exec(ident)?.[1] ?? 0);

/** a scalar that eases toward its target; semi-implicit Euler is stable at the clamped frame step */
function spring(v) {
  return { v, t: v, vel: 0 };
}
function step(s, dt) {
  const a = -STIFF * (s.v - s.t) - DAMP * s.vel;
  s.vel += a * dt;
  s.v += s.vel * dt;
  if (Math.abs(s.v - s.t) < 0.05 && Math.abs(s.vel) < 0.05) {
    s.v = s.t;
    s.vel = 0;
    return false;
  }
  return true;
}

/**
 * Siblings are ordered by dependency rank (a ticket after the siblings it waits on), then by number, so a pipeline
 * reads left to right. Returns {pos: id -> {x, y, w}, width, height}.
 */
export function layoutTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  const roots = [];
  for (const n of nodes) {
    if (n.parent && byId.has(n.parent) && n.parent !== n.id) {
      if (!kids.has(n.parent)) kids.set(n.parent, []);
      kids.get(n.parent).push(n);
    } else roots.push(n);
  }
  const order = (list) => {
    const ids = new Set(list.map((n) => n.id));
    const rank = new Map();
    const rankOf = (n, seen = new Set()) => {
      if (rank.has(n.id)) return rank.get(n.id);
      if (seen.has(n.id)) return 0;
      seen.add(n.id);
      let r = 0;
      for (const b of n.blockedBy || []) if (ids.has(b) && b !== n.id) r = Math.max(r, rankOf(byId.get(b), seen) + 1);
      rank.set(n.id, r);
      return r;
    };
    return [...list].sort((a, b) => rankOf(a) - rankOf(b) || identNum(a.ident) - identNum(b.ident) || a.ident.localeCompare(b.ident));
  };
  const pos = new Map();
  const seen = new Set();
  // subtree width first, then place each parent centered over its children
  const widthOf = new Map();
  const measure = (n) => {
    if (seen.has(n.id)) return 0;
    seen.add(n.id);
    const ch = order(kids.get(n.id) || []);
    const own = nodeWidth(n.ident);
    const sum = ch.reduce((s, c, i) => s + measure(c) + (i ? H_GAP : 0), 0);
    const w = Math.max(own, sum);
    widthOf.set(n.id, w);
    return w;
  };
  const place = (n, left, depth) => {
    if (pos.has(n.id)) return;
    const w = widthOf.get(n.id) ?? nodeWidth(n.ident);
    pos.set(n.id, { x: left + w / 2, y: depth * (NODE_H + V_GAP), w: nodeWidth(n.ident) });
    const ch = order(kids.get(n.id) || []).filter((c) => widthOf.has(c.id));
    const sum = ch.reduce((s, c, i) => s + widthOf.get(c.id) + (i ? H_GAP : 0), 0);
    let x = left + (w - sum) / 2;
    for (const c of ch) {
      place(c, x, depth + 1);
      x += widthOf.get(c.id) + H_GAP;
    }
  };
  let left = 0;
  let depthMax = 0;
  for (const r of order(roots)) {
    const w = measure(r);
    if (!w) continue;
    place(r, left, 0);
    left += w + H_GAP * 2;
  }
  for (const p of pos.values()) depthMax = Math.max(depthMax, p.y);
  return { pos, width: Math.max(0, left - H_GAP * 2), height: pos.size ? depthMax + NODE_H : 0 };
}

export function createTicketTree({ onOpen } = {}) {
  const root = document.createElement('div');
  root.className = 'ttree';
  const svg = el('svg', { class: 'ttree-svg', role: 'group', 'aria-label': 'ticket tree' });
  root.appendChild(svg);
  const edgeLayer = el('g', { class: 'tt-edges' }, svg);
  const depLayer = el('g', { class: 'tt-deps' }, svg);
  const nodeLayer = el('g', { class: 'tt-nodes' }, svg);
  const fxLayer = el('g', { class: 'tt-fx' }, svg);
  const defs = el('defs', {}, svg);
  const marker = el('marker', { id: `tt-arrow-${Math.random().toString(36).slice(2, 8)}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
  el('path', { d: 'M1 1 L7 4 L1 7', class: 'tt-arrowhead' }, marker);

  const nodes = new Map(); // id -> record
  const view = { w: spring(0), h: spring(0) };
  let model = [];
  let raf = 0;
  let last = 0;

  const kick = () => {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  function makeNode(n) {
    const g = el('g', { class: 'tt-node', tabindex: 0, 'data-open': n.id, role: 'button' }, nodeLayer);
    const title = el('title', {}, g);
    const ring = el('rect', { class: 'tt-ring', rx: 15, ry: 15 }, g);
    const box = el('rect', { class: 'tt-box', rx: 13, ry: 13, height: NODE_H }, g);
    const glyph = el('text', { class: 'tt-glyph', y: 1 }, g);
    const label = el('text', { class: 'tt-label', y: 1 }, g);
    g.addEventListener('click', (e) => { if (onOpen) { e.stopPropagation(); onOpen(n.id); } });
    g.addEventListener('keydown', (e) => {
      if (onOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(n.id); }
    });
    return { id: n.id, g, title, ring, box, glyph, label, x: spring(0), y: spring(0), s: spring(0.35), o: spring(0), ringO: spring(0), exiting: false, data: n, edge: null };
  }

  function paintNode(r) {
    const n = r.data;
    const w = nodeWidth(n.ident);
    const state = n.decision ? 'decision' : n.status || 'todo';
    r.g.setAttribute('class', `tt-node s-${state}${n.claimer ? ' claimed' : ''}`);
    r.box.setAttribute('x', -w / 2);
    r.box.setAttribute('y', -NODE_H / 2);
    r.box.setAttribute('width', w);
    r.ring.setAttribute('x', -w / 2 - 3);
    r.ring.setAttribute('y', -NODE_H / 2 - 3);
    r.ring.setAttribute('width', w + 6);
    r.ring.setAttribute('height', NODE_H + 6);
    r.glyph.textContent = TREE_GLYPH[state] ?? '○';
    r.glyph.setAttribute('x', -w / 2 + 14);
    r.label.textContent = n.ident;
    r.label.setAttribute('x', -w / 2 + 25);
    const bits = [`${n.ident} · ${state}`, n.title, n.assignee && `assignee ${n.assignee}`, n.claimer && `claimed by ${n.claimer}`, n.note && `now: ${n.note}`].filter(Boolean);
    r.title.textContent = bits.join('\n');
    r.g.setAttribute('aria-label', `${n.ident}, ${state}${n.claimer ? `, claimed by ${n.claimer}` : ''}`);
  }

  function update(next) {
    model = next;
    const { pos, width, height } = layoutTree(next);
    const instant = reduced();
    const seen = new Set();
    for (const n of next) {
      const p = pos.get(n.id);
      if (!p) continue;
      seen.add(n.id);
      let r = nodes.get(n.id);
      const fresh = !r;
      if (fresh) {
        r = makeNode(n);
        nodes.set(n.id, r);
        // grow out of the parent where it currently is, so a split fans out from its source
        const from = n.parent && nodes.get(n.parent);
        r.x.v = from ? from.x.v : p.x;
        r.y.v = from ? from.y.v : p.y;
      } else if (r.exiting) {
        r.exiting = false;
      }
      const before = r.data;
      r.data = n;
      if (!fresh && (before.status !== n.status || !!before.decision !== !!n.decision)) r.s.vel += instant ? 0 : 5.5;
      r.x.t = p.x;
      r.y.t = p.y;
      r.s.t = 1;
      r.o.t = n.status === 'canceled' ? 0.6 : 1;
      r.ringO.t = n.claimer ? 1 : 0;
      paintNode(r);
    }
    for (const r of nodes.values()) {
      if (seen.has(r.id) || r.exiting) continue;
      r.exiting = true;
      const parent = r.data.parent && nodes.get(r.data.parent);
      if (parent && !parent.exiting) { r.x.t = parent.x.t; r.y.t = parent.y.t; }
      r.o.t = 0;
      r.s.t = 0.4;
      r.ringO.t = 0;
    }
    view.w.t = Math.max(width + PAD * 2, 1);
    view.h.t = Math.max(height + PAD * 2, NODE_H + PAD * 2);
    if (instant) {
      for (const r of nodes.values()) for (const k of ['x', 'y', 's', 'o', 'ringO']) { r[k].v = r[k].t; r[k].vel = 0; }
      for (const k of ['w', 'h']) { view[k].v = view[k].t; view[k].vel = 0; }
    }
    kick();
  }

  /** a context entry or event touched this ticket: a ripple from the node, ✕ for a FAIL */
  function pulse(id, kind = 'FACT') {
    const r = nodes.get(id);
    if (!r || r.exiting) return;
    const w = nodeWidth(r.data.ident);
    const g = el('g', { class: `tt-ripple k-${String(kind).toLowerCase()}`, transform: `translate(${r.x.v} ${r.y.v})` }, fxLayer);
    const ring = el('rect', { x: -w / 2, y: -NODE_H / 2, width: w, height: NODE_H, rx: 13, ry: 13 }, g);
    if (kind === 'FAIL') {
      const t = el('text', { class: 'tt-fail', x: w / 2 + 4, y: -NODE_H / 2 - 2 }, g);
      t.textContent = '✕';
    }
    const anim = reduced()
      ? ring.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 700, easing: 'ease-out' })
      : ring.animate([{ transform: 'scale(1)', opacity: 0.75 }, { transform: 'scale(1.55, 2.1)', opacity: 0 }], { duration: 900, easing: 'cubic-bezier(.2,.7,.3,1)' });
    const fail = g.querySelector('.tt-fail')?.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none', offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 2400 });
    Promise.all([anim.finished, fail?.finished].filter(Boolean)).catch(() => {}).finally(() => g.remove());
    if (!reduced()) r.s.vel += 3;
    kick();
  }

  function elbow(px, py, cx, cy) {
    const bus = py + NODE_H / 2 + V_GAP / 2;
    const top = cy - NODE_H / 2;
    const bottom = py + NODE_H / 2;
    const dx = cx - px;
    const r = Math.min(9, Math.abs(dx) / 2, (top - bus) / 1.2, (bus - bottom) / 1.2);
    if (Math.abs(dx) < 1 || r < 1) return `M${px},${bottom} C${px},${bus} ${cx},${bus} ${cx},${top}`;
    const sx = Math.sign(dx);
    return `M${px},${bottom} V${bus - r} Q${px},${bus} ${px + sx * r},${bus} H${cx - sx * r} Q${cx},${bus} ${cx},${bus + r} V${top}`;
  }

  function arc(a, b) {
    // siblings in a row: a shallow arc under the row; anything else: a soft S-curve between the nodes
    const wa = nodeWidth(a.data.ident) / 2;
    const wb = nodeWidth(b.data.ident) / 2;
    if (Math.abs(a.y.v - b.y.v) < 2) {
      const dir = Math.sign(b.x.v - a.x.v) || 1;
      const x1 = a.x.v + dir * wa * 0.45;
      const x2 = b.x.v - dir * wb * 0.45;
      const y = a.y.v + NODE_H / 2;
      const dip = Math.min(24, 9 + Math.abs(x2 - x1) * 0.07);
      return `M${x1},${y} C${x1},${y + dip} ${x2},${y + dip} ${x2},${y + 1}`;
    }
    const down = b.y.v > a.y.v;
    const y1 = a.y.v + (down ? NODE_H / 2 : -NODE_H / 2);
    const y2 = b.y.v + (down ? -NODE_H / 2 : NODE_H / 2);
    const my = (y1 + y2) / 2;
    return `M${a.x.v},${y1} C${a.x.v},${my} ${b.x.v},${my} ${b.x.v},${y2}`;
  }

  /** an ancestor's blocker that is also its descendant adds nothing the tree does not already show */
  function isAncestor(maybe, id) {
    for (let p = nodes.get(id)?.data.parent, i = 0; p && i < 64; p = nodes.get(p)?.data.parent, i++) if (p === maybe) return true;
    return false;
  }

  function draw() {
    const width = Math.max(view.w.v, root.clientWidth || 0);
    const ox = (width - (view.w.v - PAD * 2)) / 2;
    svg.setAttribute('width', Math.round(width));
    svg.setAttribute('height', Math.round(view.h.v));
    svg.setAttribute('viewBox', `${-ox} ${-PAD - NODE_H / 2} ${Math.round(width)} ${Math.round(view.h.v)}`);

    const edges = [];
    const deps = [];
    for (const r of nodes.values()) {
      const s = r.s.v;
      r.g.setAttribute('transform', `translate(${r.x.v.toFixed(2)} ${r.y.v.toFixed(2)}) scale(${s.toFixed(3)})`);
      r.g.style.opacity = Math.max(0, Math.min(1, r.o.v)).toFixed(3);
      r.ring.style.opacity = Math.max(0, Math.min(1, r.ringO.v)).toFixed(3);
      const p = r.data.parent && nodes.get(r.data.parent);
      if (p) edges.push([r, p]);
      for (const b of r.data.blockedBy || []) {
        const br = nodes.get(b);
        if (br && b !== r.id && !isAncestor(r.id, b)) deps.push([br, r]);
      }
    }
    syncPaths(edgeLayer, edges, 'tt-edge', ([c, p]) => elbow(p.x.v, p.y.v, c.x.v, c.y.v), ([c, p]) => Math.min(c.o.v, p.o.v));
    syncPaths(depLayer, deps, 'tt-dep', ([a, b]) => arc(a, b), ([a, b]) => Math.min(a.o.v, b.o.v) * (FINISHED.has(a.data.status) ? 0.45 : 1), true);
  }

  function syncPaths(layer, pairs, cls, d, opacity, arrow = false) {
    const have = layer.children;
    while (have.length < pairs.length) {
      const path = el('path', { class: cls }, layer);
      if (arrow) path.setAttribute('marker-end', `url(#${marker.id})`);
    }
    while (have.length > pairs.length) layer.lastChild.remove();
    pairs.forEach((pair, i) => {
      const path = have[i];
      path.setAttribute('d', d(pair));
      path.style.opacity = Math.max(0, Math.min(1, opacity(pair))).toFixed(3);
    });
  }

  function frame(t) {
    const dt = Math.min(1 / 30, Math.max(1 / 240, (t - last) / 1000));
    last = t;
    let moving = false;
    for (const s of [view.w, view.h]) moving = step(s, dt) || moving;
    for (const r of [...nodes.values()]) {
      for (const k of ['x', 'y', 's', 'o', 'ringO']) moving = step(r[k], dt) || moving;
      if (r.exiting && r.o.v <= 0.02) {
        r.g.remove();
        nodes.delete(r.id);
      }
    }
    draw();
    raf = moving ? requestAnimationFrame(frame) : 0;
  }

  return {
    el: root,
    update,
    pulse,
    has: (id) => nodes.has(id) && !nodes.get(id).exiting,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      root.remove();
    },
    get model() { return model; },
  };
}
