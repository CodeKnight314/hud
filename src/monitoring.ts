import type { Board, Item, MetricSpec, Observation, PipelineSpec, State, TableData, CanvasProgram } from './types.ts';

export const metricKinds = ['scalar', 'capacity', 'rate', 'counter', 'breakdown', 'table', 'grid'];
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fail = (text: string): never => { throw Object.assign(new Error(text), { status: 400 }); };
const short = (v: unknown, name: string, max = 500): string => typeof v === 'string' && v.length <= max ? v : fail(`${name} must be a string of at most ${max} characters`);

export function validateMonitorFields(input: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  if (input.metric !== undefined) {
    if (input.metric === null) out.metric = undefined;
    else {
      const m = input.metric;
      if (!object(m)) fail('metric must be an object');
      const clean: MetricSpec = {};
      if (m.kind !== undefined) {
        if (!metricKinds.includes(m.kind)) fail('unknown metric kind');
        clean.kind = m.kind;
      }
      for (const key of ['key', 'scope', 'unit', 'definition', 'source', 'sourceId'] as const)
        if (m[key] !== undefined) clean[key] = short(m[key], `metric.${key}`, key === 'definition' ? 1000 : 300);
      for (const key of ['windowSeconds', 'target', 'denominator'] as const) if (m[key] !== undefined) {
        if (!finite(m[key]) || (key !== 'target' && m[key] <= 0)) fail(`metric.${key} must be a finite ${key === 'target' ? '' : 'positive '}number`);
        clean[key] = m[key];
      }
      out.metric = clean;
    }
  }
  if (input.observedAt !== undefined) {
    if (!finite(input.observedAt) || input.observedAt < 0 || input.observedAt > Date.now() + 60_000) fail('observedAt must be a Unix millisecond timestamp, no more than 60 seconds in the future');
    out.observedAt = input.observedAt;
  }
  if (input.evidence !== undefined) {
    if (!['reported', 'estimate'].includes(input.evidence)) fail('evidence must be reported or estimate; only collectors can assign measured');
    out.evidence = input.evidence;
  }
  if (input.availability !== undefined) {
    if (!['available', 'partial', 'unavailable'].includes(input.availability)) fail('availability must be available, partial or unavailable');
    out.availability = input.availability;
  }
  if (input.coverage !== undefined) {
    const c = input.coverage;
    if (!object(c) || !Number.isInteger(c.responding) || !Number.isInteger(c.total) || c.responding < 0 || c.total < 1 || c.responding > c.total) fail('coverage requires 0 <= responding <= total and positive total');
    out.coverage = { responding: c.responding, total: c.total };
  }
  if (input.freshness !== undefined) {
    const f = input.freshness;
    if (!object(f) || !['live', 'static'].includes(f.mode)) fail('freshness.mode must be live or static');
    if (f.mode === 'static' && (typeof f.reason !== 'string' || !f.reason.trim())) fail('static freshness requires a reason');
    out.freshness = { mode: f.mode, ...(f.reason === undefined ? {} : { reason: short(f.reason, 'freshness.reason') }) };
  }
  if (input.data !== undefined) {
    const d = input.data;
    if (!object(d) || !Array.isArray(d.columns) || !Array.isArray(d.rows) || d.columns.length > 50 || d.rows.length > 1000) fail('data requires columns (max 50) and rows (max 1000)');
    const keys = new Set<string>();
    const columns: TableData['columns'] = d.columns.map((c: any) => {
      if (!object(c) || typeof c.key !== 'string' || !/^[\w.-]{1,80}$/.test(c.key) || keys.has(c.key) || ['__proto__', 'constructor', 'prototype'].includes(c.key)) fail('data column keys must be unique safe names');
      keys.add(c.key);
      if (c.type !== undefined && !['number', 'string', 'boolean'].includes(c.type)) fail('invalid column type');
      return { key: c.key, ...(c.label === undefined ? {} : { label: short(c.label, 'column.label', 100) }), ...(c.unit === undefined ? {} : { unit: short(c.unit, 'column.unit', 32) }), ...(c.type === undefined ? {} : { type: c.type }) };
    });
    for (const row of d.rows) {
      if (!object(row)) fail('table rows must be objects');
      for (const c of columns) if (row[c.key] != null && c.type && typeof row[c.key] !== c.type) fail(`column ${c.key} requires ${c.type} values or null`);
      if (row.observedAt !== undefined && (!finite(row.observedAt) || row.observedAt < 0 || row.observedAt > Date.now() + 60_000)) fail('row observedAt must be a valid timestamp');
    }
    if (Buffer.byteLength(JSON.stringify(d)) > 256_000) fail('data exceeds 256 KB');
    out.data = structuredClone({ columns, rows: d.rows });
  }
  if (input.pipeline !== undefined) {
    const p = input.pipeline;
    if (!object(p) || !Array.isArray(p.stages) || !p.stages.length || p.stages.length > 30) fail('pipeline requires 1–30 stages');
    const keys = new Set<string>();
    const stages: PipelineSpec['stages'] = p.stages.map((s: any) => {
      if (!object(s)) fail('pipeline stages must be objects');
      const key = short(s.key, 'stage.key', 80);
      if (!key || keys.has(key)) fail('stage keys must be nonempty and unique');
      keys.add(key);
      const stage: PipelineSpec['stages'][number] = { key, label: short(s.label, 'stage.label', 120) };
      for (const k of ['throughput', 'queued', 'inFlight', 'oldestAge', 'retries', 'rejected'] as const) if (s[k] !== undefined) stage[k] = short(s[k], `stage.${k}`, 64);
      return stage;
    });
    out.pipeline = { stages };
  }
  return out;
}

export function expiry(item: Item): number | null {
  if (item.freshness?.mode === 'static' || item.state === 'done') return null;
  const s = item.source;
  if (s?.kind === 'heartbeat') return (s.period ?? 60) + (s.grace ?? 60);
  if (item.staleAfter) return item.staleAfter;
  if (s && ['command', 'http', 'probe'].includes(s.kind)) {
    const interval = s.interval ?? 30;
    return Math.max(60, interval * 3, interval + (s.timeout ?? 30));
  }
  return 300;
}

export function observationTime(item: Item): number {
  return item.observation?.observedAt ?? item.observation?.receivedAt ?? item.lastUpdate ?? item.createdAt;
}

export function staleAt(item: Item, now = Date.now()): boolean {
  const limit = expiry(item);
  return item.type === 'monitor' && limit !== null && now - observationTime(item) > limit * 1000;
}

export function metricReading(item: Item, now = Date.now()) {
  const observation = item.observation;
  const source = item.metric?.source || (item.source?.kind === 'probe' ? item.source.probe : undefined) || (item.source?.kind === 'command' ? 'command collector' : item.source?.kind === 'http' ? 'HTTP collector' : undefined) || `${item.source?.kind ?? 'manual'} by ${observation?.actor ?? item.updatedBy}`;
  return {
    id: item.id, board: item.board, title: item.title, type: item.type,
    value: item.value ?? null, label: item.label, unit: item.metric?.unit ?? item.unit ?? '',
    state: item.state ?? item.status ?? 'unknown', stale: staleAt(item, now),
    ageSeconds: Math.max(0, Math.floor((now - observationTime(item)) / 1000)),
    observedAt: observation?.observedAt ?? null, receivedAt: observation?.receivedAt ?? item.lastUpdate ?? null,
    source, sourceId: item.metric?.sourceId, evidence: observation?.evidence ?? 'unknown',
    definition: item.metric?.definition ?? '', metric: item.metric,
    availability: item.availability ?? observation?.availability ?? 'unavailable', coverage: observation?.coverage,
    expirySeconds: expiry(item), progress: item.progress, max: item.metric?.denominator ?? item.max,
  };
}
export type MetricReading = ReturnType<typeof metricReading>;

export function pipelineView(item: Item, items: Record<string, Item>, now = Date.now()) {
  if (!item.pipeline) return undefined;
  const read = (id?: string) => id && Object.hasOwn(items, id) && items[id].board === item.board ? metricReading(items[id], now) : undefined;
  const stages = item.pipeline.stages.map(s => {
    const result: Record<string, any> = { key: s.key, label: s.label, candidate: false };
    for (const k of ['throughput', 'queued', 'inFlight', 'oldestAge', 'retries', 'rejected'] as const) result[k] = read(s[k]);
    return result;
  });
  for (let i = 1; i < stages.length; i++) {
    const s = stages[i]!, upstream = stages[i - 1]!.throughput as MetricReading | undefined;
    const output = s.throughput as MetricReading | undefined, queue = s.queued as MetricReading | undefined;
    if (!upstream || !output || !queue || [upstream, output, queue].some(r => r.stale || r.availability !== 'available')) continue;
    if (!upstream.metric?.windowSeconds || upstream.metric.windowSeconds !== output.metric?.windowSeconds || upstream.unit !== output.unit || upstream.metric.scope !== output.metric?.scope) continue;
    const queuedItem = items[queue.id]!;
    const history = (queuedItem.history ?? []).filter(h => h.v !== null && h.t >= now - upstream.metric!.windowSeconds! * 1000);
    if (history.length >= 2 && typeof upstream.value === 'number' && typeof output.value === 'number' && typeof queue.value === 'number')
      s.candidate = queue.value > history[0]!.v! && output.value < upstream.value;
  }
  return { stages, message: stages.some(s => s.candidate) ? 'Candidate bottleneck: queue growing while output is below incoming throughput.' : 'Stage observations shown; insufficient evidence to identify a bottleneck.' };
}

export function comparisonResults(board: Board, items: Record<string, Item>, now = Date.now()) {
  return (board.comparisons ?? []).filter(r => !r.deletedAt).map(rule => {
    const left = Object.hasOwn(items, rule.left) && items[rule.left].board === board.id ? metricReading(items[rule.left], now) : undefined;
    const right = Object.hasOwn(items, rule.right) && items[rule.right].board === board.id ? metricReading(items[rule.right], now) : undefined;
    let reason = '';
    if (!left || !right) reason = 'missing input';
    else if (left.stale || right.stale || left.availability !== 'available' || right.availability !== 'available') reason = 'stale or unavailable input';
    else if (typeof left.value !== 'number' || typeof right.value !== 'number') reason = 'nonnumeric input';
    else if (!left.metric?.scope || left.metric.scope !== right.metric?.scope || left.unit !== right.unit || left.metric.windowSeconds !== right.metric?.windowSeconds) reason = 'incompatible scope, unit or window';
    else if (Math.abs(observationTime(items[rule.left]!) - observationTime(items[rule.right]!)) > (rule.maxSkew ?? 60) * 1000) reason = 'observation times differ';
    if (reason) return { id: rule.id, state: 'unknown', reason, left, right };
    const a = left!.value as number, b = right!.value as number, tolerance = rule.tolerance ?? 0;
    const mismatch = rule.relation === 'equal' ? Math.abs(a - b) > tolerance : rule.relation === 'lte' ? a > b + tolerance : a < b - tolerance;
    const elapsed = rule.since ? (now - rule.since) / 1000 : 0;
    return { id: rule.id, state: mismatch ? elapsed >= (rule.holdFor ?? 60) ? 'conflict' : 'pending' : 'ok', mismatch, reason: mismatch ? `${rule.left} ${rule.relation} ${rule.right} differs beyond ${tolerance}` : '', left, right };
  });
}

export function readout(state: State, boardId?: string, now = Date.now()) {
  const items = Object.values(state.items).filter(i => !boardId || i.board === boardId);
  return {
    now,
    boards: state.boards.filter(b => !boardId || b.id === boardId).map(b => ({ id: b.id, name: b.name, revision: b.dashboard?.revision, annotations: (b.annotations ?? []).filter(a => !a.deletedAt), comparisons: comparisonResults(b, state.items, now) })),
    items: items.map(i => ({ ...metricReading(i, now), ...(i.pipeline ? { pipelineView: pipelineView(i, state.items, now) } : {}) })),
  };
}

export function readoutText(result: ReturnType<typeof readout>): string {
  const clean = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return result.items.map(r => `${r.board}/${r.id} ${clean(r.title)}: ${clean(r.label ?? r.value ?? '—')}${clean(r.unit)} [${r.state}${r.stale ? ' STALE' : ''}; ${r.availability}] ${r.evidence}, ${clean(r.source)}, ${r.ageSeconds}s ago${r.definition ? ` — ${clean(r.definition)}` : ''}`).join('\n');
}

export function lintBoard(state: State, board: Board) {
  const findings: { code: string; severity: 'warning' | 'error'; id: string; message: string }[] = [];
  const add = (id: string, code: string, message: string, severity: 'warning' | 'error' = 'warning') => findings.push({ id, code, message, severity });
  const metrics = new Map<string, string>();
  const items = Object.values(state.items).filter(i => i.board === board.id);
  for (const i of items) {
    if (i.type !== 'monitor') continue;
    if (!i.unit && !i.metric?.unit) add(i.id, 'missing-unit', 'Declare a unit, including count or ratio for dimensionless numbers.');
    if (!i.metric?.definition) add(i.id, 'missing-definition', 'Define what counts, scope and measurement window.');
    if (!i.metric?.source) add(i.id, 'missing-source', 'Declare a human-readable instrument/source.');
    if (!i.staleAfter && i.freshness?.mode !== 'static' && i.source?.kind !== 'heartbeat') add(i.id, 'default-expiry', `Using default expiry of ${expiry(i)}s; declare the reporting cadence.`);
    if (i.observation?.evidence === 'unknown' || !i.observation) add(i.id, 'legacy-provenance', 'Observation provenance is unknown.');
    if (i.metric?.key) {
      const identity = JSON.stringify([i.metric.key, i.metric.scope, i.metric.unit ?? i.unit, i.metric.windowSeconds]);
      const other = metrics.get(identity);
      if (other) add(i.id, 'duplicate-metric', `Same metric identity as ${other}; duplicated sources do not corroborate each other.`);
      else metrics.set(identity, i.id);
    }
    if (i.metric?.kind === 'breakdown' && ['line', 'area'].includes(i.display ?? '')) add(i.id, 'unsuitable-chart', 'Use bars for a categorical breakdown.');
    for (const id of i.plot?.metrics ?? []) {
      const other = Object.hasOwn(state.items, id) ? state.items[id] : undefined;
      if (!other || other.board !== board.id) add(i.id, 'missing-binding', `Time series cannot resolve ${id} on this board.`, 'error');
      else if ((other.metric?.unit ?? other.unit) !== (i.metric?.unit ?? i.unit) || other.metric?.windowSeconds !== i.metric?.windowSeconds) add(i.id, 'incompatible-series', `${id} uses a different unit or aggregation window.`);
    }
    for (const s of i.pipeline?.stages ?? []) for (const k of ['throughput', 'queued', 'inFlight', 'oldestAge', 'retries', 'rejected'] as const)
      if (s[k] && (!Object.hasOwn(state.items, s[k]!) || state.items[s[k]!]!.board !== board.id)) add(i.id, 'missing-binding', `Stage ${s.key} cannot resolve ${k}: ${s[k]}.`, 'error');
    if (i.w < 180 || i.h < 110) add(i.id, 'small-card', 'Card may be unreadable at board fit size.');
    if (i.x < 0 || i.y < 0 || i.x + i.w > 1600 || i.y + i.h > 900) add(i.id, 'overflow', 'Card exceeds canvas bounds.', 'error');
  }
  const leaves = items.filter(i => ['monitor', 'note', 'util'].includes(i.type));
  for (let a = 0; a < leaves.length; a++) for (let b = a + 1; b < leaves.length; b++) {
    const i = leaves[a]!, j = leaves[b]!;
    if (i.x < j.x + j.w - 1 && i.x + i.w > j.x + 1 && i.y < j.y + j.h - 1 && i.y + i.h > j.y + 1) add(i.id, 'overlap', `Overlaps ${j.id}.`);
  }
  for (const r of comparisonResults(board, state.items)) if (r.state === 'unknown') add(r.id, 'comparison-unknown', r.reason);
  const programs: [string, CanvasProgram | undefined][] = [[board.id, board.program], ...items.map(i => [i.id, i.program] as [string, CanvasProgram | undefined])];
  for (const [id, program] of programs) if (program && !program.disabled) {
    if (!program.bindings.length) add(String(id), 'unbound-program', 'Custom program has no live bindings; rendered numbers cannot be verified by lint.');
    for (const binding of program.bindings) if (!Object.hasOwn(state.items, binding)) add(String(id), 'missing-binding', `Custom program cannot resolve ${binding}.`, 'error');
  }
  return { board: board.id, findings, errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length };
}
