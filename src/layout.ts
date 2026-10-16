import type { Item } from './types.ts';

export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 900;
export interface Rect { x: number; y: number; w: number; h: number }
const bound = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));

export function bounded(r: Rect): Rect {
  const w = bound(r.w, 1, BOARD_WIDTH), h = bound(r.h, 1, BOARD_HEIGHT);
  return { x: bound(r.x, 0, BOARD_WIDTH - w), y: bound(r.y, 0, BOARD_HEIGHT - h), w, h };
}

/** Tickets and their projects are list objects; ticket-only frames do not consume dashboard space. */
export function canvasItems(items: Item[]): Item[] {
  return items.filter(i => {
    if (i.type === 'ticket' || i.type === 'project') return false;
    if (i.type !== 'frame') return true;
    const key = String(i.title ?? '').trim().toLowerCase();
    const members = items.filter(m => m.type !== 'frame' && (key ? String(m.group ?? '').toLowerCase() === key
      : !m.group && m.x + m.w / 2 >= i.x && m.x + m.w / 2 <= i.x + i.w && m.y + m.h / 2 >= i.y && m.y + m.h / 2 <= i.y + i.h));
    return !members.length || members.some(m => m.type !== 'ticket' && m.type !== 'project');
  });
}

/** Equal rows with full last-row width; choose columns for readable landscape cards. */
function grid(n: number, r: Rect, sparse = false): Rect[] {
  if (!n) return [];
  let cols = 1, score = Infinity;
  const gap = Math.min(20, r.w / (n * 4), r.h / (n * 4));
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const w = (r.w - gap * (c - 1)) / c, h = (r.h - gap * (rows - 1)) / rows;
    const s = Math.abs(Math.log(w / h / 1.7)) + (c * rows - n) / n * 0.3;
    if (s < score) { score = s; cols = c; }
  }
  const rows = Math.ceil(n / cols);
  const h = Math.min((r.h - gap * (rows - 1)) / rows, sparse ? 360 : Infinity);
  const y0 = r.y + (r.h - (h * rows + gap * (rows - 1))) / 2;
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / cols), count = Math.min(cols, n - row * cols);
    const w = Math.min((r.w - gap * (count - 1)) / count, sparse ? 640 : Infinity);
    return { x: r.x + (r.w - (w * count + gap * (count - 1))) / 2 + (i % cols) * (w + gap), y: y0 + row * (h + gap), w, h };
  });
}

export function layout(items: Item[]): Map<string, Rect> {
  const ordered = canvasItems(items).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const frames = ordered.filter(i => i.type === 'frame');
  const assigned = new Set<string>();
  const children = new Map<string, Item[]>();
  for (const f of frames) {
    const key = String(f.title ?? '').trim().toLowerCase();
    const members = ordered.filter(i => i.type !== 'frame' && !assigned.has(i.id) && (key
      ? String(i.group ?? '').toLowerCase() === key
      : !i.group && i.x + i.w / 2 >= f.x && i.x + i.w / 2 <= f.x + f.w && i.y + i.h / 2 >= f.y && i.y + i.h / 2 <= f.y + f.h));
    members.forEach(i => assigned.add(i.id));
    children.set(f.id, members);
  }
  const blocks = ordered.filter(i => i.type === 'frame' || !assigned.has(i.id));
  const out = new Map<string, Rect>();
  const sparse = ordered.filter(i => i.type !== 'frame').length <= 4;
  const weight = (i: Item) => Math.max(1, (children.get(i.id)?.length ?? 0)) + (i.type === 'frame' ? 0.5 : 0);
  function place(list: Item[], r: Rect) {
    if (!list.length) return;
    if (list.every(i => i.type !== 'frame')) {
      grid(list.length, r, sparse).forEach((rect, i) => out.set(list[i]!.id, rect));
      return;
    }
    if (list.length === 1) {
      const it = list[0]!;
      const members = children.get(it.id) ?? [];
      const rect = sparse ? { ...r, w: Math.min(r.w, members.length > 1 ? 1320 : 680), h: Math.min(r.h, members.length > 2 ? 820 : 420) } : r;
      rect.x += (r.w - rect.w) / 2; rect.y += (r.h - rect.h) / 2;
      out.set(it.id, rect);
      const pad = Math.min(20, rect.w / 10, rect.h / 10), top = Math.min(40, rect.h / 5);
      grid(members.length, { x: rect.x + pad, y: rect.y + top, w: rect.w - pad * 2, h: rect.h - top - pad }, sparse)
        .forEach((p, i) => out.set(members[i]!.id, p));
      return;
    }
    const total = list.reduce((s, i) => s + weight(i), 0);
    let split = 1, left = weight(list[0]!);
    while (split < list.length - 1 && Math.abs(left + weight(list[split]!) - total / 2) < Math.abs(left - total / 2)) left += weight(list[split++]!);
    const horizontal = r.w / r.h > 1.5;
    const gap = Math.min(20, (horizontal ? r.w : r.h) / 10);
    const size = ((horizontal ? r.w : r.h) - gap) * left / total;
    place(list.slice(0, split), horizontal ? { ...r, w: size } : { ...r, h: size });
    place(list.slice(split), horizontal ? { ...r, x: r.x + size + gap, w: r.w - size - gap } : { ...r, y: r.y + size + gap, h: r.h - size - gap });
  }
  place(blocks, { x: 20, y: 20, w: BOARD_WIDTH - 40, h: BOARD_HEIGHT - 40 });
  return out;
}
