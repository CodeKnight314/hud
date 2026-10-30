// Animated radial ticket tree for the Tasks view. A lone root sits in the centre (several roots hang off a hub), parents
// sit on depth rings and every leaf sits on the outer ring, so the tree fits a square however many children a ticket
// has. Parent edges are radial curves, blockedBy edges are chords with an arrowhead. Motion runs on springs in one rAF
// loop rather than CSS transitions, so it can be retargeted mid-flight and survives the list re-rendering the element
// into a new placeholder.

const SVG = 'http://www.w3.org/2000/svg';
const NODE_H = 26;
const CHAR_W = 7.3;
const PAD = 18;
const SLOT = 16; // arc length per leaf on the outer ring
const FAMILY_GAP = 0.8; // extra slots between the centre's subtrees
const RING_STEP = 70; // minimum distance between depth rings
const LEAF_R = 6.5;
const DOT_R = 4;
const LABEL_GAP = 7;
const MIN_SCALE = 0.5; // below this the tree scrolls rather than shrinking into unreadable text
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
const labelWidth = (ident) => LEAF_R + LABEL_GAP + Math.round((ident.length + 2) * CHAR_W);
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

/** drops finished tickets whose whole subtree is finished; a finished parent of live work stays to hold it */
export function withoutFinished(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  for (const n of nodes) if (n.parent && byId.has(n.parent) && n.parent !== n.id) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n);
  const keep = new Set();
  const seen = new Set();
  const live = (n) => {
    if (seen.has(n.id)) return keep.has(n.id);
    seen.add(n.id);
    let any = !FINISHED.has(n.status);
    for (const c of kids.get(n.id) || []) if (live(c)) any = true;
    if (any) keep.add(n.id);
    return any;
  };
  for (const n of nodes) live(n);
  return nodes.filter((n) => keep.has(n.id));
}

/**
 * Siblings are ordered by dependency rank (a ticket after the siblings it waits on), then by number, with finished
 * leaves last so live work stays together. Leaves take evenly spaced slots on the outer ring; a parent sits on its
 * depth ring at the middle of its leaves' arc. Coordinates are relative to the centre.
 * Returns {pos: id -> {x, y, kind}, size, hub}; kind is center, pill, leaf (live) or dot (finished).
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
    const doneLeaf = (n) => (FINISHED.has(n.status) && !kids.has(n.id) ? 1 : 0);
    return [...list].sort((a, b) => doneLeaf(a) - doneLeaf(b) || rankOf(a) - rankOf(b) || identNum(a.ident) - identNum(b.ident) || a.ident.localeCompare(b.ident));
  };
  const pos = new Map();
  if (!nodes.length) return { pos, size: 0, hub: false };
  const hub = roots.length !== 1;
  const info = new Map(); // id -> {d, lo, hi} where lo..hi is the subtree's slot range
  const seen = new Set();
  const leaves = [];
  let slot = 0;
  let maxD = 0;
  const visit = (n, d) => {
    seen.add(n.id);
    const ks = order(kids.get(n.id) || []).filter((c) => !seen.has(c.id));
    const me = { d, lo: slot, hi: slot, n };
    info.set(n.id, me);
    if (!ks.length) {
      leaves.push(me);
      me.slot = slot;
      slot += 1;
      maxD = Math.max(maxD, d);
    } else {
      ks.forEach((c, i) => {
        if (d === 0 && i) slot += FAMILY_GAP;
        visit(c, d + 1);
      });
      me.hi = slot - 1;
    }
    me.lo = me.slot ?? info.get(ks[0]?.id)?.lo ?? me.lo;
  };
  if (hub) order(roots).forEach((r, i) => { if (i) slot += FAMILY_GAP; visit(r, 1); });
  else visit(roots[0], 0);
  // nodes left out by a parent cycle still need a place: hang them off the hub
  for (const n of nodes) if (!seen.has(n.id)) { slot += FAMILY_GAP; visit(n, 1); }

  // each inner ring must clear the one inside it and fit its own pills around its circumference
  const ringNeed = new Map();
  for (const me of info.values()) if (me.slot === undefined && me.d > 0) ringNeed.set(me.d, (ringNeed.get(me.d) || 0) + nodeWidth(me.n.ident) + 14);
  // rings share the outer radius evenly unless a crowded ring needs more room
  let outer = maxD ? Math.max((slot * SLOT) / (2 * Math.PI), RING_STEP * Math.max(1.4, maxD)) : 0;
  const ring = [0];
  for (let d = 1; d < maxD; d++) ring[d] = Math.max(ring[d - 1] + RING_STEP, (ringNeed.get(d) || 0) / (2 * Math.PI), (outer * d) / maxD);
  if (maxD > 1) outer = Math.max(outer, ring[maxD - 1] + RING_STEP);
  const angle = (s) => -Math.PI / 2 + ((s + 0.5) / slot) * 2 * Math.PI;

  let extent = 0;
  for (const me of info.values()) {
    const n = me.n;
    const isLeaf = me.slot !== undefined;
    const a = angle(isLeaf ? me.slot : (me.lo + me.hi) / 2);
    // a parent whose leaves wrap most of the circle drifts toward the centre, so its spokes fan out instead of crossing
    const span = isLeaf ? 0 : ((me.hi - me.lo + 1) / slot) * 2 * Math.PI;
    const r = me.d === 0 ? 0 : isLeaf ? outer : ring[me.d] * Math.min(1, Math.max(0.15, (2 * Math.PI - span) / Math.PI));
    const kind = me.d === 0 ? 'center' : !isLeaf ? 'pill' : FINISHED.has(n.status) ? 'dot' : 'leaf';
    pos.set(n.id, { x: r * Math.cos(a), y: r * Math.sin(a), kind });
    extent = Math.max(extent, r + (kind === 'leaf' ? labelWidth(n.ident) : kind === 'dot' ? DOT_R : nodeWidth(n.ident) / 2));
  }
  return { pos, size: Math.ceil(2 * (extent + PAD)), hub };
}

export function createTicketTree({ onOpen } = {}) {
  const root = document.createElement('div');
  root.className = 'ttree';
  const svg = el('svg', { class: 'ttree-svg', role: 'group', 'aria-label': 'ticket tree' });
  root.appendChild(svg);
  const ringLayer = el('g', { class: 'tt-rings' }, svg);
  const edgeLayer = el('g', { class: 'tt-edges' }, svg);
  const depLayer = el('g', { class: 'tt-deps' }, svg);
  const nodeLayer = el('g', { class: 'tt-nodes' }, svg);
  const fxLayer = el('g', { class: 'tt-fx' }, svg);
  const defs = el('defs', {}, svg);
  const marker = el('marker', { id: `tt-arrow-${Math.random().toString(36).slice(2, 8)}`, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
  el('path', { d: 'M1 1 L7 4 L1 7', class: 'tt-arrowhead' }, marker);
  const hubDot = el('circle', { class: 'tt-hub', r: 4, cx: 0, cy: 0 }, ringLayer);
  const outerRing = el('circle', { class: 'tt-orbit', cx: 0, cy: 0 }, ringLayer);

  const nodes = new Map(); // id -> record
  const view = { size: spring(0), orbit: spring(0), hub: spring(0) };
  let model = [];
  let raf = 0;
  let last = 0;
  let fitW = 0;
  // rescale to the new box rather than scrolling sideways
  const resize = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (root.clientWidth && Math.abs(root.clientWidth - fitW) > 1) { fitW = root.clientWidth; kick(); } })
    : null;
  resize?.observe(root);
  const onWindow = () => kick();
  window.addEventListener('resize', onWindow);

  const kick = () => {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  function makeNode(n) {
    const g = el('g', { class: 'tt-node', tabindex: 0, 'data-open': n.id, role: 'button' }, nodeLayer);
    const title = el('title', {}, g);
    const hit = el('rect', { class: 'tt-hit' }, g);
    const ring = el('rect', { class: 'tt-ring' }, g);
    const box = el('rect', { class: 'tt-box' }, g);
    const glyph = el('text', { class: 'tt-glyph', y: 1 }, g);
    const label = el('text', { class: 'tt-label', y: 1 }, g);
    g.addEventListener('click', (e) => { if (onOpen) { e.stopPropagation(); onOpen(n.id); } });
    g.addEventListener('keydown', (e) => {
      if (onOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(n.id); }
    });
    return { id: n.id, g, title, hit, ring, box, glyph, label, x: spring(0), y: spring(0), s: spring(0.35), o: spring(0), ringO: spring(0), exiting: false, data: n, kind: 'pill' };
  }

  const rect = (node, x, y, w, h, r) => {
    node.setAttribute('x', x);
    node.setAttribute('y', y);
    node.setAttribute('width', w);
    node.setAttribute('height', h);
    node.setAttribute('rx', r);
    node.setAttribute('ry', r);
  };
  const circle = (node, r) => rect(node, -r, -r, 2 * r, 2 * r, r);

  function paintNode(r) {
    const n = r.data;
    const state = n.decision ? 'decision' : n.status || 'todo';
    r.g.setAttribute('class', `tt-node s-${state} k-${r.kind}${n.claimer ? ' claimed' : ''}`);
    const glyph = TREE_GLYPH[state] ?? '○';
    if (r.kind === 'pill' || r.kind === 'center') {
      const w = nodeWidth(n.ident);
      rect(r.box, -w / 2, -NODE_H / 2, w, NODE_H, 13);
      rect(r.ring, -w / 2 - 3, -NODE_H / 2 - 3, w + 6, NODE_H + 6, 15);
      rect(r.hit, -w / 2, -NODE_H / 2, w, NODE_H, 13);
      r.glyph.textContent = glyph;
      r.glyph.setAttribute('x', -w / 2 + 14);
      r.label.textContent = n.ident;
      r.label.setAttribute('x', -w / 2 + 25);
      r.label.setAttribute('text-anchor', 'start');
      r.label.removeAttribute('transform');
    } else {
      const rad = r.kind === 'dot' ? DOT_R : LEAF_R;
      circle(r.box, rad);
      circle(r.ring, rad + 3.5);
      circle(r.hit, 10);
      r.glyph.textContent = '';
      // a live leaf's label carries the glyph too, so its state never rests on colour alone
      r.label.textContent = r.kind === 'leaf' ? `${glyph} ${n.ident}` : '';
    }
    const bits = [`${n.ident} · ${state}`, n.title, n.assignee && `assignee ${n.assignee}`, n.claimer && `claimed by ${n.claimer}`, n.note && `now: ${n.note}`].filter(Boolean);
    r.title.textContent = bits.join('\n');
    r.g.setAttribute('aria-label', `${n.ident}, ${state}${n.claimer ? `, claimed by ${n.claimer}` : ''}`);
  }

  /** a leaf's label points away from the centre and never reads upside down */
  function orientLabel(r) {
    if (r.kind !== 'leaf') return;
    const a = Math.atan2(r.y.v, r.x.v);
    const flip = Math.cos(a) < 0;
    const deg = (a * 180) / Math.PI + (flip ? 180 : 0);
    const off = LEAF_R + LABEL_GAP;
    r.label.setAttribute('transform', `rotate(${deg.toFixed(1)})`);
    r.label.setAttribute('x', flip ? -off : off);
    r.label.setAttribute('text-anchor', flip ? 'end' : 'start');
  }

  function update(next) {
    model = next;
    fitW = root.clientWidth;
    const { pos, size, hub } = layoutTree(next);
    const instant = reduced();
    const seen = new Set();
    let orbit = 0;
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
      r.kind = p.kind;
      if (!fresh && (before.status !== n.status || !!before.decision !== !!n.decision)) r.s.vel += instant ? 0 : 5.5;
      r.x.t = p.x;
      r.y.t = p.y;
      r.s.t = 1;
      r.o.t = n.status === 'canceled' ? 0.6 : 1;
      r.ringO.t = n.claimer ? 1 : 0;
      if (p.kind === 'leaf' || p.kind === 'dot') orbit = Math.max(orbit, Math.hypot(p.x, p.y));
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
    view.size.t = Math.max(size, NODE_H + PAD * 2);
    view.orbit.t = orbit;
    view.hub.t = hub ? 1 : 0;
    if (instant) {
      for (const r of nodes.values()) for (const k of ['x', 'y', 's', 'o', 'ringO']) { r[k].v = r[k].t; r[k].vel = 0; }
      for (const s of Object.values(view)) { s.v = s.t; s.vel = 0; }
    }
    kick();
  }

  /** a context entry or event touched this ticket: a ripple from the node, ✕ for a FAIL */
  function pulse(id, kind = 'FACT') {
    const r = nodes.get(id);
    if (!r || r.exiting) return;
    const g = el('g', { class: `tt-ripple k-${String(kind).toLowerCase()}`, transform: `translate(${r.x.v} ${r.y.v})` }, fxLayer);
    const ring = el('rect', {}, g);
    let right = 0;
    if (r.kind === 'pill' || r.kind === 'center') {
      const w = nodeWidth(r.data.ident);
      rect(ring, -w / 2, -NODE_H / 2, w, NODE_H, 13);
      right = w / 2;
    } else {
      right = r.kind === 'dot' ? DOT_R : LEAF_R;
      circle(ring, right);
    }
    if (kind === 'FAIL') {
      const t = el('text', { class: 'tt-fail', x: right + 4, y: -NODE_H / 2 - 2 }, g);
      t.textContent = '✕';
    }
    const anim = reduced()
      ? ring.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 700, easing: 'ease-out' })
      : ring.animate([{ transform: 'scale(1)', opacity: 0.75 }, { transform: r.kind === 'pill' || r.kind === 'center' ? 'scale(1.55, 2.1)' : 'scale(2.6)', opacity: 0 }], { duration: 900, easing: 'cubic-bezier(.2,.7,.3,1)' });
    const fail = g.querySelector('.tt-fail')?.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none', offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 2400 });
    Promise.all([anim.finished, fail?.finished].filter(Boolean)).catch(() => {}).finally(() => g.remove());
    if (!reduced()) r.s.vel += 3;
    kick();
  }

  /** leaves the parent along its own spoke and arrives along the child's, so edges fan like a radial dendrogram */
  function spoke(px, py, cx, cy) {
    const rp = Math.hypot(px, py);
    const rc = Math.hypot(cx, cy);
    const ac = Math.atan2(cy, cx);
    const ap = rp < 1 ? ac : Math.atan2(py, px);
    const m = (rp + rc) / 2;
    const f = (v) => v.toFixed(1);
    return `M${f(px)},${f(py)} C${f(m * Math.cos(ap))},${f(m * Math.sin(ap))} ${f(m * Math.cos(ac))},${f(m * Math.sin(ac))} ${f(cx)},${f(cy)}`;
  }

  const reach = (r) => (r.kind === 'dot' ? DOT_R + 2 : r.kind === 'leaf' ? LEAF_R + 2 : NODE_H / 2 + 1);

  /** a chord bowed toward the centre, trimmed so the arrowhead lands on the node's edge */
  function chord(a, b) {
    const cx = (a.x.v + b.x.v) * 0.3;
    const cy = (a.y.v + b.y.v) * 0.3;
    const trim = (r, d) => {
      const dx = cx - r.x.v;
      const dy = cy - r.y.v;
      const len = Math.hypot(dx, dy) || 1;
      return [r.x.v + (dx / len) * d, r.y.v + (dy / len) * d];
    };
    const [x1, y1] = trim(a, reach(a));
    const [x2, y2] = trim(b, reach(b) + 1);
    return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }

  /** an ancestor's blocker that is also its descendant adds nothing the tree does not already show */
  function isAncestor(maybe, id) {
    for (let p = nodes.get(id)?.data.parent, i = 0; p && i < 64; p = nodes.get(p)?.data.parent, i++) if (p === maybe) return true;
    return false;
  }

  function draw() {
    const size = Math.max(1, view.size.v);
    const availH = Math.max(360, (typeof innerHeight === 'number' ? innerHeight : 800) - 150);
    const scale = Math.max(MIN_SCALE, Math.min(1, (root.clientWidth || size) / size, availH / size));
    const px = Math.round(size * scale);
    svg.setAttribute('width', px);
    svg.setAttribute('height', px);
    svg.setAttribute('viewBox', `${(-size / 2).toFixed(1)} ${(-size / 2).toFixed(1)} ${size.toFixed(1)} ${size.toFixed(1)}`);
    outerRing.setAttribute('r', Math.max(0, view.orbit.v).toFixed(1));
    outerRing.style.opacity = view.orbit.v > 1 ? '' : '0';
    hubDot.style.opacity = Math.max(0, Math.min(1, view.hub.v)).toFixed(3);

    const edges = [];
    const deps = [];
    const hubOn = view.hub.t > 0;
    for (const r of nodes.values()) {
      const s = r.s.v;
      r.g.setAttribute('transform', `translate(${r.x.v.toFixed(2)} ${r.y.v.toFixed(2)}) scale(${s.toFixed(3)})`);
      r.g.style.opacity = Math.max(0, Math.min(1, r.o.v)).toFixed(3);
      r.ring.style.opacity = Math.max(0, Math.min(1, r.ringO.v)).toFixed(3);
      orientLabel(r);
      const p = r.data.parent && nodes.get(r.data.parent);
      if (p) edges.push([r, p]);
      else if (hubOn) edges.push([r, null]);
      for (const b of r.data.blockedBy || []) {
        const br = nodes.get(b);
        if (br && b !== r.id && !isAncestor(r.id, b)) deps.push([br, r]);
      }
    }
    syncPaths(edgeLayer, edges, 'tt-edge', ([c, p]) => (p ? spoke(p.x.v, p.y.v, c.x.v, c.y.v) : spoke(0, 0, c.x.v, c.y.v)), ([c, p]) => Math.min(c.o.v, p ? p.o.v : view.hub.v) * (c.kind === 'dot' ? 0.7 : 1));
    syncPaths(depLayer, deps, 'tt-dep', ([a, b]) => chord(a, b), ([a, b]) => Math.min(a.o.v, b.o.v) * (FINISHED.has(a.data.status) ? 0.45 : 1), true);
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
    for (const s of Object.values(view)) moving = step(s, dt) || moving;
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
      resize?.disconnect();
      window.removeEventListener('resize', onWindow);
      root.remove();
    },
    get model() { return model; },
  };
}
