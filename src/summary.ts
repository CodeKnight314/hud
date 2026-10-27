import { contains } from './store.ts';
import type { Store } from './store.ts';
import type { Board, Item, SearchQuery } from './types.ts';
import { staleAt, metricReading } from './monitoring.ts';

const STATE_GLYPH: Record<string, string> = { ok: '●', warn: '▲', error: '✕', unknown: '○', running: '◐', done: '✓' };
const STATUS_GLYPH: Record<string, string> = { backlog: '[ ]', todo: '[ ]', doing: '[~]', review: '[?]', blocked: '[!]', done: '[x]', canceled: '[-]' };
export { STATUS_GLYPH };
const ORDER: Record<string, number> = { blocked: 0, doing: 1, review: 2, todo: 3, backlog: 4, done: 5, canceled: 6 };

export function ago(t?: number) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function isStale(it: Item) {
  return staleAt(it);
}

/** control characters (newlines, escapes, NUL) in user text would corrupt a terminal listing */
const clean = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');

/** Compact a report for a terminal line; plain messages keep their literal text, while Markdown loses decoration. */
export function plainTextExcerpt(value: unknown, format: 'plain' | 'markdown' = 'plain'): string {
  const raw = String(value ?? '');
  if (format !== 'markdown') return clean(raw.replace(/\s*\r?\n\s*/g, ' ⏎ '));
  const source = raw.replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const out: string[] = [];
  let fence = false;
  for (const sourceLine of lines) {
    if (/^\s*(```|~~~)/.test(sourceLine)) {
      fence = !fence;
      continue;
    }
    if (fence || /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(sourceLine)) continue;
    out.push(
      sourceLine
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-+*]\s+(?:\[[ xX]\]\s*)?/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/`+([^`]*?)`+/g, '$1')
        .replace(/(__|\*\*)([\s\S]*?)\1/g, '$2')
        .replace(/(^|[^\w])(_|\*)(?=\S)([\s\S]*?\S)\2(?!\w)/g, '$1$3')
        .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
        .replace(/<\/?[A-Za-z][^>]*>/g, '')
        .replace(/\\([\\`*_\[\]{}()#+.!-])/g, '$1'),
    );
  }
  return clean(out.join(' ⏎ ')).replace(/(?: ⏎ ){2,}/g, ' ⏎ ').trim();
}

/** `ident` names the item itself; `name` resolves a related ticket's id to its ident */
export interface NameOpts {
  ident?: (it: Item) => string;
  name?: (id: string) => string;
}

export function line(it: Item, opts: NameOpts = {}): string {
  const by = it.createdBy ? ` @${clean(it.createdBy)}` : '';
  const nm = (arr: string[]) => arr.map((x) => opts.name?.(x) ?? x).join(',');
  switch (it.type) {
    case 'ticket': {
      const extra = [it.priority && `!${it.priority}`, it.assignee && `→${clean(it.assignee)}`, it.tags?.length && it.tags.map((t) => `#${clean(t)}`).join(' ')]
        .filter(Boolean)
        .join(' ');
      const c = it.comments?.length ? ` (${it.comments.length} comments)` : '';
      const links = it.monitors?.length ? ` ⇢ ${it.monitors.join(',')}${it.autoStatus ? ' (auto)' : ''}` : '';
      const deps = it.blockedBy?.length ? ` ⊘ waits on ${nm(it.blockedBy)}` : '';
      const refs = it.refs?.length ? ` ⇒ ${nm(it.refs)}` : '';
      const parent = it.parent ? ` ↳ ${opts.name?.(it.parent) ?? it.parent}` : '';
      return `[${it.status ?? 'todo'}] ${opts.ident?.(it) ?? it.id} ${clean(it.title)}${parent}${extra ? ' ' + extra : ''}${c}${links}${deps}${refs}${by}`;
    }
    case 'monitor': {
      const v = it.label ? ` ${clean(it.label)}` : it.value === undefined || it.value === null ? '' : ` ${clean(it.value)}${clean(it.unit)}`;
      const p = it.progress != null ? ` ${Math.round(it.progress)}%` : '';
      const m = it.message ? ` — ${plainTextExcerpt(it.message, it.messageFormat ?? 'plain')}` : '';
      const stale = isStale(it) ? ' STALE' : '';
      const g = it.group ? ` {${clean(it.group)}}` : '';
      const r = metricReading(it);
      return `${STATE_GLYPH[it.state ?? 'unknown'] ?? '○'} ${it.id} ${clean(it.title)}:${v}${p} [${it.state}${stale}]${m} (${r.evidence}, ${clean(r.source)}, ${r.ageSeconds}s ago)${g}${r.definition ? ` — ${clean(r.definition)}` : ''}`;
    }
    case 'note':
      return `≡ ${it.id} ${clean(it.title)}${it.title ? ': ' : ''}${clean(it.text).replace(/\s+/g, ' ').slice(0, 80)}`;
    case 'util': {
      const bits = Object.entries(it.util ?? {})
        .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
        .slice(0, 4)
        .map(([k, v]) => `${clean(k)}=${clean(v)}`);
      return `⚙ ${it.id} ${clean(it.title || it.kind || 'util')} [${it.kind ?? '—'}]${bits.length ? ' ' + bits.join(' ') : ''}`;
    }
    case 'project':
      return `▤ ${it.key ?? '—'} ${clean(it.title)} [${it.status ?? 'backlog'}]${it.target ? ` target ${it.target}` : ''}${it.lead ? ` lead @${clean(it.lead)}` : ''}`;
    case 'frame':
      return `▭ ${it.id} ${clean(it.title)}`;
    default:
      return `? ${it.id} ${clean((it as Item).title)}`;
  }
}

/**
 * Linear-style ticket list: projects first, then status, then tickets — each with its sub-tickets
 * indented and its blockers/refs called out. This is the view agents and the CLI work from; nothing
 * here needs canvas coordinates.
 */
export function ticketsView(store: Store, board = 'main', q?: SearchQuery): string {
  const groups = store.projectsView(board, q);
  const out: string[] = [];
  const anyProject = groups.some((g) => g.project);
  for (const g of groups) {
    if (!g.tickets.length && !g.project) continue;
    const inGroup = new Set(g.tickets.map((t) => t.id));
    const printed = new Set<string>();
    // children print under their parent (when it is in this list); everything else is a root of its status section
    const sub = (t: Item, depth: number): void => {
      if (printed.has(t.id)) return;
      printed.add(t.id);
      const flag = t.blockedBy?.length ? ` ⊘ ${t.blockedBy.map((b) => store.identOf(b)).join(',')}` : '';
      const br = t.branch ? ` ⎇ ${clean(t.branch)}` : '';
      const roll = depth === 0 ? store.rollup(t.id) : { total: 0, done: 0 };
      const kids = roll.total ? ` [${roll.done}/${roll.total} sub]` : '';
      const own = store.ownership(t);
      const who = ` →${own.assignee ? clean(own.assignee) : '—'} ⊕${own.claimer ? clean(own.claimer) : '—'}`;
      out.push(`  ${'  '.repeat(depth)}${STATUS_GLYPH[t.status ?? 'todo'] ?? '[ ]'} ${store.ident(t)} ${clean(t.title)}${who}${flag}${kids}${br}`);
      for (const c of store.childrenOf(t.id)) if (inGroup.has(c.id)) sub(c, depth + 1);
    };
    if (g.project) out.push(`${clean(g.project.key)}  ${clean(g.project.title)}${g.project.target ? ` → ${clean(g.project.target)}` : ''}`);
    else if (anyProject) out.push('(no project)');
    const statuses = [...new Set(g.tickets.map((t) => t.status ?? 'todo'))].sort((a, b) => (ORDER[a] ?? 9) - (ORDER[b] ?? 9));
    const roots = (t: Item) => !t.parent || !inGroup.has(t.parent);
    for (const s of statuses) {
      const atRoot = g.tickets.filter((t) => (t.status ?? 'todo') === s && roots(t));
      if (!atRoot.length) continue; // every ticket in this status hangs off a parent and prints there
      out.push(`  ${s} — ${atRoot.length}`);
      for (const t of atRoot) sub(t, 1);
    }
    // a parent cycle leaves tickets with no root; never drop them silently
    for (const t of g.tickets) if (!printed.has(t.id)) sub(t, 1);
    if (!g.tickets.length) out.push('  (no tickets)');
  }
  if (!out.length) return q && Object.keys(q).length ? `no matching tickets on board ${board}` : `no tickets on board ${board}`;
  return out.join('\n');
}

/** Plain-text overview, frames first with their contents indented. */
export function summarize(boards: Board[], items: Item[], opts: NameOpts = {}): string {
  const out: string[] = [];
  for (const b of boards) {
    const its = items.filter((i) => i.board === b.id);
    out.push(`board ${b.id}${b.name !== b.id ? ` "${clean(b.name)}"` : ''} — ${its.length} items`);
    const frames = its.filter((i) => i.type === 'frame').sort((a, c) => a.y - c.y || a.x - c.x);
    const used = new Set<string>();
    const order = (l: Item[]) => l.sort((a, c) => a.y - c.y || a.x - c.x);
    for (const f of frames) {
      if (frames.some((o) => o !== f && contains(o, f))) continue;
      out.push(`  ${line(f, opts)}`);
      used.add(f.id);
      const key = f.title.trim().toLowerCase();
      for (const c of order(its.filter((i) => i.type !== 'frame' && (key ? i.group?.toLowerCase() === key : !i.group && contains(f, i))))) {
        out.push(`    ${line(c, opts)}`);
        used.add(c.id);
      }
    }
    for (const it of order(its.filter((i) => !used.has(i.id)))) out.push(`  ${line(it, opts)}`);
    if (!its.length) out.push('  (empty canvas)');
  }
  return out.join('\n');
}
