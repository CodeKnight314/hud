// Shared-context timeline for the inspector. Pure data in, readable model and handoff text out.
// Corrections stay in the log; a later entry with `corrects` retires the earlier one from the handoff.

export const CONTEXT_FILTERS = ['all', 'FACT', 'FAIL', 'SUMMARY', 'STATUS'];

export const CONTEXT_KIND_META = {
  FACT: { label: 'finding', glyph: '●' },
  FAIL: { label: 'dead end', glyph: '✕' },
  SUMMARY: { label: 'handoff', glyph: '✓' },
  STATUS: { label: 'progress', glyph: '○' },
};

function normalizeFilter(filter) {
  const value = String(filter ?? 'all').trim().toUpperCase();
  if (!value || value === 'ALL') return 'ALL';
  return CONTEXT_KIND_META[value] ? value : 'ALL';
}

function asList(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && entry.kind) : [];
}

function decorate(entry, byId, corrected) {
  const kind = String(entry.kind).toUpperCase();
  const meta = CONTEXT_KIND_META[kind] || { label: kind.toLowerCase(), glyph: '·' };
  const prior = entry.corrects ? byId.get(entry.corrects) : undefined;
  return {
    id: entry.id,
    seq: entry.seq || 0,
    t: entry.t || 0,
    actor: entry.actor || '—',
    session: entry.session || '',
    kind,
    label: meta.label,
    glyph: meta.glyph,
    text: entry.text || '',
    refs: Array.isArray(entry.refs) ? entry.refs : [],
    attachments: Array.isArray(entry.attachments) ? entry.attachments : [],
    data: entry.data,
    corrects: entry.corrects || '',
    correctsText: prior?.text || '',
    superseded: corrected.has(entry.id),
  };
}

/** Newest first. `superseded` is decided from the whole scope, so a filter cannot hide a correction. */
export function contextTimeline(entries, options = {}) {
  const list = asList(entries);
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const corrected = new Set(list.map((entry) => entry.corrects).filter(Boolean));
  const filter = normalizeFilter(options.filter);
  return list
    .filter((entry) => filter === 'ALL' || String(entry.kind).toUpperCase() === filter)
    .map((entry) => decorate(entry, byId, corrected))
    .sort((a, b) => (b.t || 0) - (a.t || 0) || (b.seq || 0) - (a.seq || 0) || String(b.id).localeCompare(String(a.id)));
}

/** Scalar fields only. Nested objects stay out of the handoff so it does not become a JSON dump. */
export function contextDataLine(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(data)) {
    if (value == null || typeof value === 'object') continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    parts.push(`${key}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ');
}

function countPhrase(n, one, many) {
  return n ? `${n} ${n === 1 ? one : many}` : '';
}

export function contextSummary(entries) {
  const rows = contextTimeline(entries, { filter: 'all' });
  const standing = rows.filter((row) => !row.superseded);
  const count = (kind) => standing.filter((row) => row.kind === kind).length;
  return {
    total: rows.length,
    standing: standing.length,
    corrected: rows.length - standing.length,
    fact: count('FACT'),
    fail: count('FAIL'),
    summary: count('SUMMARY'),
    status: count('STATUS'),
  };
}

export function contextSummaryText(entries) {
  const summary = contextSummary(entries);
  if (!summary.total) return 'nothing published yet';
  return [
    countPhrase(summary.fact, 'finding', 'findings'),
    countPhrase(summary.fail, 'dead end', 'dead ends'),
    countPhrase(summary.summary, 'handoff', 'handoffs'),
    countPhrase(summary.status, 'progress note', 'progress notes'),
    countPhrase(summary.corrected, 'corrected', 'corrected'),
  ].filter(Boolean).join(' · ');
}

function defaultTime(t) {
  if (!t) return '—';
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function who(row) {
  return row.session && row.session !== row.actor ? `@${row.actor} (${row.session})` : `@${row.actor}`;
}

function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function extraLines(row, nameOf) {
  const lines = [];
  if (row.corrects) lines.push(`  corrects: ${row.correctsText ? clip(row.correctsText, 160) : 'an earlier entry'}`);
  if (row.refs.length) lines.push(`  refs: ${row.refs.map((id) => nameOf(id) || id).join(', ')}`);
  const data = contextDataLine(row.data);
  if (data) lines.push(`  data: ${data}`);
  if (row.attachments.length) lines.push(`  attachments: ${row.attachments.length}`);
  return lines;
}

function entryLine(row, formatTime) {
  return `${row.kind} ${formatTime(row.t)} ${who(row)} — ${row.text}`;
}

function writeEntry(row, formatTime, nameOf, bullet) {
  const extra = extraLines(row, nameOf);
  const head = `${bullet ? '- ' : ''}${entryLine(row, formatTime)}`;
  return extra.length ? `${head}\n${extra.join('\n')}` : head;
}

function chronological(rows) {
  return [...rows].sort((a, b) => (a.t || 0) - (b.t || 0) || (a.seq || 0) - (b.seq || 0));
}

function byKind(rows, kind) {
  return chronological(rows.filter((row) => row.kind === kind));
}

/** Standing findings, dead ends and the latest handoff. Corrected entries are listed apart so they are not current. */
export function contextHandoff(entries, options = {}) {
  const scope = options.scope || '';
  const title = options.title || scope || 'shared context';
  const formatTime = typeof options.formatTime === 'function' ? options.formatTime : defaultTime;
  const nameOf = typeof options.nameOf === 'function' ? options.nameOf : (id) => id;
  const header = [`Handoff · ${title}`, `scope: ${scope || '—'}`];
  if (options.now != null) header.push(`as of: ${formatTime(options.now)}`);
  const list = asList(entries);
  if (!list.length) return `${header.join('\n')}\n\nNothing published for this scope yet.\n`;

  const rows = contextTimeline(list, { filter: 'all' });
  const standing = rows.filter((row) => !row.superseded);
  const summaries = byKind(standing, 'SUMMARY');
  const current = summaries.length ? summaries[summaries.length - 1] : null;
  const earlier = summaries.slice(0, -1);
  const fails = byKind(standing, 'FAIL');
  const facts = byKind(standing, 'FACT');
  const notes = byKind(standing, 'STATUS');
  const corrected = chronological(rows.filter((row) => row.superseded));
  const parts = [
    `Current handoff\n${current ? writeEntry(current, formatTime, nameOf, false) : 'None yet.'}`,
  ];
  if (earlier.length) parts.push(`Earlier handoffs\n${earlier.map((row) => writeEntry(row, formatTime, nameOf, true)).join('\n')}`);
  parts.push(
    `Dead ends\n${fails.length ? fails.map((row) => writeEntry(row, formatTime, nameOf, true)).join('\n') : 'None.'}`,
    `Findings\n${facts.length ? facts.map((row) => writeEntry(row, formatTime, nameOf, true)).join('\n') : 'None that still stand.'}`,
    `Progress\n${notes.length ? notes.map((row) => writeEntry(row, formatTime, nameOf, true)).join('\n') : 'None.'}`,
  );
  if (corrected.length) parts.push(`Corrected\n${corrected.map((row) => writeEntry(row, formatTime, nameOf, true)).join('\n')}`);
  return `${header.join('\n')}\n\n${parts.join('\n\n')}\n`;
}

const KIND_PLURAL = { finding: 'findings', 'dead end': 'dead ends', handoff: 'handoffs', progress: 'progress notes' };

function emptyFilterMessage(filter, where) {
  const place = where || 'this scope';
  if (filter === 'all') return `Nothing published for ${place} yet.`;
  const label = CONTEXT_KIND_META[filter]?.label || filter.toLowerCase();
  return `No ${KIND_PLURAL[label] || `${label}s`} in ${place}.`;
}

function rowHTML(row, esc, when, nameOf) {
  const person = row.session && row.session !== row.actor ? `@${row.actor} · ${row.session}` : `@${row.actor}`;
  const notes = [];
  if (row.superseded) notes.push('corrected by a later entry');
  if (row.corrects) notes.push(`corrects: ${row.correctsText || 'an earlier entry'}`);
  if (row.refs.length) notes.push(`refs ${row.refs.map((id) => nameOf(id) || id).join(', ')}`);
  const data = contextDataLine(row.data);
  if (data) notes.push(data);
  if (row.attachments.length) notes.push(`${row.attachments.length} attachment${row.attachments.length === 1 ? '' : 's'}`);
  const noteHTML = notes.length ? `<div class="context-note">${notes.map((note) => `<div>${esc(note)}</div>`).join('')}</div>` : '';
  return `<article class="context-entry kind-${esc(row.kind.toLowerCase())}${row.superseded ? ' is-corrected' : ''}" role="listitem" title="${esc(row.id)}"><div class="context-when"><span class="ck">${esc(row.glyph)} ${esc(row.kind)}</span><span class="cl">${esc(row.label)}</span><span class="ca">${esc(when(row.t))} · ${esc(person)}</span></div><p class="ct">${esc(row.text)}</p>${noteHTML}</article>`;
}

/** Inspector markup for one scope. `esc` is required so entry text cannot become HTML. */
export function renderContextTimeline({ entries, filter = 'all', scope = '', where = '', esc, when, nameOf, complete = true }) {
  if (typeof esc !== 'function') throw new Error('esc is required');
  const showWhen = typeof when === 'function' ? when : () => '';
  const labelOf = typeof nameOf === 'function' ? nameOf : (id) => id;
  const selected = normalizeFilter(filter);
  const selectedKey = selected === 'ALL' ? 'all' : selected;
  const rows = contextTimeline(entries, { filter: selectedKey });
  const chips = CONTEXT_FILTERS.map((key) => `<span class="chip${key === selectedKey ? ' on' : ''}" data-v="${esc(key)}">${esc(key)}</span>`).join('');
  const published = asList(entries).length;
  const body = rows.length
    ? rows.map((row) => rowHTML(row, esc, showWhen, labelOf)).join('')
    : `<div class="faint">${esc(published ? emptyFilterMessage(selectedKey, where) : 'Nothing published for this scope yet.')}</div>`;
  const older = complete === false ? '<div class="faint">older entries were not loaded</div>' : '';
  return `<div class="context-head"><h4>shared context</h4><button class="btn" type="button" data-act="copy-handoff" title="copy findings, dead ends and the latest handoff">copy for handoff</button></div><div class="meta">${esc(where)} · ${esc(scope)} · ${esc(contextSummaryText(entries))}</div><div class="chips" data-chips="context-kind">${chips}</div><div class="context-timeline" role="list">${body}</div>${older}`;
}
