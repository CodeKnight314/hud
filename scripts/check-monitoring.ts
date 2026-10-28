import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HudError, STATE_VERSION, Store } from '../src/store.ts';
import { validateMonitorFields } from '../src/monitoring.ts';

const ACTOR = 'monitoring-check';
const roots: string[] = [];
const stores: Store[] = [];

function fresh(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `hud-${name}-`));
  roots.push(dir);
  const file = join(dir, 'state.json');
  const store = new Store(file);
  stores.push(store);
  store.setBoard('main', { autoOrganize: false }, ACTOR);
  store.flush();
  return { store, dir, file };
}

function close(store: Store) {
  store.stopBackups();
  store.flush();
}

function expectHudError(fn: () => unknown, status: number, label: string) {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof HudError, `${label}: expected HudError ${status}`);
  assert.equal(error.status, status, `${label}: wrong status`);
}

function byId<T extends { id: string }>(items: T[], id: string): T {
  const found = items.find((item) => item.id === id);
  assert(found, `expected item ${id}`);
  return found;
}

async function migrationAndStalePersistence() {
  assert.equal(STATE_VERSION, 11);
  const dir = mkdtempSync(join(tmpdir(), 'hud-monitoring-v8-'));
  roots.push(dir);
  const file = join(dir, 'state.json');
  const oldAt = Date.now() - 10 * 60_000;
  const id = 'legacy-monitor';
  const oldState = {
    version: 8,
    seq: {},
    boards: [{ id: 'main', name: 'main', createdAt: oldAt, width: 1600, height: 900, autoOrganize: false }],
    items: {
      [id]: {
        id, type: 'monitor', board: 'main', title: 'Legacy', x: 20, y: 20, w: 260, h: 150,
        createdAt: oldAt, updatedAt: oldAt, lastUpdate: oldAt, createdBy: 'old-agent', updatedBy: 'old-agent',
        source: { kind: 'push' }, state: 'ok', value: 0, stale: false,
        history: [{ t: oldAt, v: 0, s: 'ok' }], log: [],
      },
    },
    activity: [], alerts: [], trash: [], attention: {},
  };
  writeFileSync(file, JSON.stringify(oldState));

  const store = new Store(file);
  stores.push(store);
  const migrated = store.get(id);
  assert.equal(store.exportState().version, STATE_VERSION);
  assert.equal(migrated.id, id, 'migration preserves item id');
  assert.deepEqual(migrated.history, oldState.items[id].history, 'migration preserves history');
  assert.equal(migrated.observation?.observedAt, null, 'legacy observation time stays unknown');
  assert.equal(migrated.observation?.receivedAt, oldAt, 'legacy receipt time falls back to lastUpdate');
  assert.equal(migrated.observation?.actor, 'old-agent');
  assert.equal(migrated.observation?.evidence, 'unknown');
  assert.deepEqual(migrated.freshness, { mode: 'live' });
  const initialReadout = byId(store.readout('main').items, id);
  assert.equal(initialReadout.expirySeconds, 300, 'legacy push monitor gets five-minute default expiry');
  assert.equal(initialReadout.stale, true, 'ten-minute-old observation is stale');
  assert.equal(initialReadout.evidence, 'unknown');
  assert(readdirSync(join(dir, 'backups')).some((name) => name.includes('premigrate-v8')), 'v8 input is backed up before migration');

  const since = Date.now() - 1000;
  store.checkStale();
  const staleChange = store.changesSince(since).events.find((event) => event.action === 'stale' && event.itemId === id);
  assert(staleChange, 'checkStale logs a meaningful change after the cursor');
  store.flush();

  const reloaded = new Store(file);
  stores.push(reloaded);
  assert.equal(reloaded.get(id).stale, true, 'stale flag persists');
  assert(reloaded.changesSince(since).events.some((event) => event.action === 'stale' && event.itemId === id), 'stale activity persists across reload');
  assert.equal(byId(reloaded.readout('main').items, id).observedAt, null, 'readout retains unknown observed time after reload');
}

async function observationSemantics() {
  const { store } = fresh('observation');
  const oldAt = Date.now() - 10 * 60_000;
  const old = store.push('old-reading', { title: 'old reading', value: 7, observedAt: oldAt }, ACTOR);
  assert.equal(old.value, 7);
  assert.equal(old.observation?.observedAt, oldAt);
  assert.equal(old.history?.at(-1)?.t, oldAt, 'charts use source observation time rather than delivery time');
  assert.equal(old.stale, true, 'an actually old observation is stale on receipt');
  const beforeError = store.get(old.id);
  const oldObservedAt = beforeError.observation?.observedAt;
  store.push(old.id, { state: 'error', message: 'collector failed' }, 'collector');
  const afterError = store.get(old.id);
  assert.equal(afterError.value, 7, 'error-only push preserves last value');
  assert.equal(afterError.observation?.observedAt, oldObservedAt, 'error-only push preserves observation time');
  assert.equal(afterError.history?.at(-1)?.v, null, 'error-only push appends an unavailable history gap');
  assert.equal(afterError.history?.at(-1)?.s, 'error');
  assert.equal(afterError.availability, 'unavailable');

  const configured = store.push('configured-reading', {
    value: 4, observedAt: oldAt, staleAfter: 30, details: 'old detail',
  }, ACTOR);
  const receivedAt = configured.observation?.receivedAt;
  store.update(configured.id, { details: 'diagnostic update' }, 'editor');
  let current = store.get(configured.id);
  assert.equal(current.observation?.observedAt, oldAt, 'details update does not freshen observation');
  assert.equal(current.observation?.receivedAt, receivedAt);
  assert.equal(current.lastUpdate, receivedAt);
  assert.equal(current.stale, true);
  store.update(configured.id, { source: { kind: 'manual' } }, 'editor');
  current = store.get(configured.id);
  assert.equal(current.observation?.observedAt, oldAt, 'source configuration update does not freshen observation');
  assert.equal(current.observation?.receivedAt, receivedAt);
  assert.equal(current.stale, true);

  const freshReading = store.push('same-value', { value: 5 }, 'first-reporter');
  const count = freshReading.history?.length ?? 0;
  const firstObservedAt = freshReading.observation?.observedAt;
  await new Promise((resolve) => setTimeout(resolve, 3));
  const repeated = store.push(freshReading.id, { value: 5 }, 'second-reporter');
  assert.equal(repeated.history?.length, count + 1, 'unchanged fresh value is still recorded');
  assert((repeated.observation?.observedAt ?? 0) > (firstObservedAt ?? 0), 'unchanged value receives a fresh observation time');

  const newestAt = repeated.observation!.observedAt!;
  const historyLength = repeated.history!.length;
  store.push(freshReading.id, { value: 99, state: 'error', observedAt: newestAt - 1 }, 'late-reporter');
  current = store.get(freshReading.id);
  assert.equal(current.value, 5, 'older push cannot replace current value');
  assert.equal(current.history?.length, historyLength, 'older push is not recorded as a new value');
  assert.equal(current.observation?.observedAt, newestAt);
  const beforeFuture = store.exportState();
  expectHudError(() => store.push(freshReading.id, { value: 8, observedAt: Date.now() + 120_000 }, 'future-reporter'), 400, 'future observedAt');
  assert.deepEqual(store.exportState(), beforeFuture, 'rejected future observation is atomic');

  const estimate = store.push('estimated', { value: 9, evidence: 'estimate' }, 'external-agent');
  assert.equal(estimate.observation?.evidence, 'estimate');
  const collected = store.collect('collected', { value: 9 });
  assert.equal(collected.observation?.actor, 'hud');
  assert.equal(collected.observation?.evidence, 'measured', 'collector path can attest measured evidence');
  const externalHud = store.push('external-hud', { value: 9 }, 'hud');
  assert.equal(externalHud.observation?.actor, 'hud');
  assert.equal(externalHud.observation?.evidence, 'reported', 'actor name alone cannot attest a measurement');
  const evidence = store.readout('main').items;
  assert.equal(byId(evidence, 'estimated').evidence, 'estimate');
  assert.equal(byId(evidence, 'collected').evidence, 'measured');
  assert.equal(byId(evidence, 'external-hud').evidence, 'reported');

  const threshold = store.push('explicit-state', { value: 100, errorAbove: 50, state: 'ok' }, ACTOR);
  assert.equal(threshold.state, 'ok', 'explicit state is not replaced by a threshold');
  const explicitError = store.push(threshold.id, { value: 1, warnBelow: 5, errorBelow: 0, state: 'error' }, ACTOR);
  assert.equal(explicitError.state, 'error', 'explicit error remains intact below thresholds');

  const zeros = store.push('zero-null-partial', { value: 0 }, ACTOR);
  assert.equal(zeros.value, 0, 'zero is a real reading');
  assert.equal(zeros.history?.at(-1)?.v, 0);
  const nullReading = store.push(zeros.id, { value: null }, ACTOR);
  assert.equal(nullReading.value, null);
  assert.equal(nullReading.history?.at(-1)?.v, null, 'null is recorded as missing, not zero');
  assert.equal(nullReading.availability, 'unavailable');
  assert.equal(nullReading.state, 'unknown');
  const partial = store.push(zeros.id, { value: 0, coverage: { responding: 1, total: 3 } }, ACTOR);
  assert.equal(partial.availability, 'partial', 'coverage infers partial availability');
  assert.deepEqual(partial.coverage, { responding: 1, total: 3 });
  assert.equal(partial.observation?.availability, 'partial');
  const otherBoard = store.createBoard('other-source', ACTOR).id;
  const foreign = store.push('foreign-source', { board: otherBoard, value: 17 }, ACTOR);
  expectHudError(() => store.collect(zeros.id, { value: 8, monitors: { [foreign.id]: { value: 18 } } }), 400, 'collector fan-out stays on its parent board');
  assert.equal(store.get(foreign.id).value, 17);
  assert.equal(store.get(zeros.id).value, 0, 'invalid collector fan-out is rejected atomically');
}

function tableSchema() {
  const valid = {
    columns: [
      { key: 'count', type: 'number' as const },
      { key: 'name', type: 'string' as const },
      { key: 'ready', type: 'boolean' as const },
    ],
    rows: [{ count: 0, name: 'worker', ready: false }, { count: null, name: 'missing', ready: true }],
  };
  assert.deepEqual(validateMonitorFields({ data: valid }).data, valid, 'typed table schema accepts zero and nullable cells');
  const { store } = fresh('table-schema');
  const item = store.push('typed-table', { data: valid, metric: { kind: 'table' } }, ACTOR);
  assert.deepEqual(item.data, valid);
  const before = store.exportState();
  expectHudError(() => store.push(item.id, {
    data: { columns: [{ key: 'count', type: 'number' }], rows: [{ count: '0' }] },
  }, ACTOR), 400, 'typed table rejects string in number column');
  assert.deepEqual(store.exportState(), before, 'invalid table schema leaves monitor state unchanged');
}

function dashboardTransactions() {
  const { store, file } = fresh('dashboard');
  const unrelated = store.create({
    type: 'monitor', id: 'unrelated', board: 'main', title: 'Unmanaged', x: 1280, y: 700,
    source: { kind: 'manual' }, value: 3, metric: { unit: 'count' },
  }, ACTOR);
  const unrelatedBefore = structuredClone(unrelated);
  const invalid = {
    rows: [{ key: 'row', cards: [{ key: 'pipeline', item: {
      type: 'monitor' as const, title: 'Bad pipeline', pipeline: { stages: [{ key: 'missing-stage', label: 'Missing', queued: 'missing-key' }] },
    } }] }],
  };
  const dryRunSpec = {
    rows: [{ key: 'row', cards: [{ key: 'draft', item: { type: 'monitor' as const, title: 'Draft', metric: { kind: 'scalar' as const, unit: 'items' } } }] }],
  };

  let eventCount = 0;
  store.on('event', () => eventCount++);
  const diskBefore = readFileSync(file, 'utf8');
  const diskMtime = statSync(file).mtimeMs;
  const before = store.exportState();
  const dry = store.applyDashboard('main', dryRunSpec, 'dashboard-agent', { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.created.length, 1);
  assert.deepEqual(store.exportState(), before, 'dry run restores all state');
  assert.equal(eventCount, 0, 'dry run emits no events');
  assert.equal(readFileSync(file, 'utf8'), diskBefore, 'dry run writes no state file');
  assert.equal(statSync(file).mtimeMs, diskMtime, 'dry run does not touch the state file');
  expectHudError(() => store.get(dry.created[0]!), 404, 'dry-run item is absent');

  expectHudError(() => store.applyDashboard('main', invalid, 'dashboard-agent'), 400, 'invalid pipeline binding');
  assert.deepEqual(store.exportState(), before, 'invalid binding rolls the transaction back');
  assert.equal(eventCount, 0, 'failed transaction emits no events');
  assert.equal(readFileSync(file, 'utf8'), diskBefore, 'failed transaction writes no state file');

  const spec = (withSpare: boolean) => ({
    rows: [{ key: 'workers', cards: [
      { key: 'input', item: { type: 'monitor' as const, title: 'Input', value: 20, metric: { kind: 'rate' as const, key: 'jobs', scope: 'cluster', unit: 'jobs/s', windowSeconds: 60 } } },
      { key: 'output', item: { type: 'monitor' as const, title: 'Output', value: 10, metric: { kind: 'rate' as const, key: 'jobs', scope: 'cluster', unit: 'jobs/s', windowSeconds: 60 } } },
      { key: 'queue', item: { type: 'monitor' as const, title: 'Queue', value: 2, metric: { kind: 'counter' as const, unit: 'items' } } },
      { key: 'pipeline', item: { type: 'monitor' as const, title: 'Pipeline', pipeline: { stages: [
        { key: 'ingest', label: 'Ingest', throughput: 'input' },
        { key: 'write', label: 'Write', throughput: 'output', queued: 'queue' },
      ] } } },
      ...(withSpare ? [{ key: 'spare', item: { type: 'monitor' as const, title: 'Spare', value: 1 } }] : []),
    ] }],
  });

  const first = store.applyDashboard('main', spec(true), 'dashboard-agent');
  assert.equal(first.created.length, 5, 'first dashboard application creates its managed cards');
  const firstState = store.exportState();
  const keys = firstState.boards.find((board) => board.id === 'main')!.dashboard!.keys;
  const source = store.get(keys.input);
  store.push(source.id, { value: 21 }, 'reading-agent');
  const sourceAfterReading = store.get(source.id);
  const beforeReapply = {
    id: sourceAfterReading.id,
    rect: [sourceAfterReading.x, sourceAfterReading.y, sourceAfterReading.w, sourceAfterReading.h],
    history: structuredClone(sourceAfterReading.history),
  };
  const reapply = store.applyDashboard('main', spec(true), 'dashboard-agent');
  assert.equal(reapply.created.length, 0, 'reapplication creates no duplicate ids');
  const afterReapply = store.get(source.id);
  assert.equal(afterReapply.id, beforeReapply.id);
  assert.deepEqual([afterReapply.x, afterReapply.y, afterReapply.w, afterReapply.h], beforeReapply.rect, 'reapplication preserves positions');
  assert.deepEqual(afterReapply.history, beforeReapply.history, 'reapplication preserves reading history');
  assert.deepEqual(store.get('unrelated'), unrelatedBefore, 'unmanaged item remains untouched');

  const pipelineId = store.exportState().boards.find((board) => board.id === 'main')!.dashboard!.keys.pipeline!;
  const pipeline = store.get(pipelineId);
  const resolvedKeys = store.exportState().boards.find((board) => board.id === 'main')!.dashboard!.keys;
  assert.equal(pipeline.pipeline?.stages[0]?.throughput, resolvedKeys.input, 'pipeline input key resolves to a managed item id');
  assert.equal(pipeline.pipeline?.stages[1]?.throughput, resolvedKeys.output);
  assert.equal(pipeline.pipeline?.stages[1]?.queued, resolvedKeys.queue);
  const pipelineReadout = byId(store.readout('main').items, pipelineId) as typeof store.readout extends (...args: any[]) => infer R ? R extends { items: (infer I)[] } ? I : never : never;
  assert.equal(pipelineReadout.pipelineView?.stages[0]?.throughput?.id, resolvedKeys.input, 'pipeline readout resolves the referenced monitor');
  assert.equal(pipelineReadout.pipelineView?.stages[1]?.queued?.id, resolvedKeys.queue);

  const spareId = resolvedKeys.spare!;
  const removeSpare = store.applyDashboard('main', spec(false), 'dashboard-agent');
  assert.deepEqual(removeSpare.removed, [spareId], 'dashboard removal reports the managed item');
  expectHudError(() => store.get(spareId), 404, 'removed dashboard item is absent');
  assert(store.trash().some((entry) => entry.item.id === spareId), 'removed managed item moves to trash');
  assert.deepEqual(store.get('unrelated'), unrelatedBefore, 'unmanaged item remains untouched after removal');
}

function annotationsAndComparisonsPersist() {
  const { store, file } = fresh('annotations-comparisons');
  const t = Date.now();
  const left = store.push('compat-left', { value: 2, observedAt: t, metric: { key: 'requests', scope: 'host-a', unit: 'req/s', windowSeconds: 60 } }, ACTOR);
  const right = store.push('compat-right', { value: 2, observedAt: t, metric: { key: 'requests', scope: 'host-b', unit: 'req/s', windowSeconds: 60 } }, ACTOR);
  const annotation = store.annotate('main', { time: t, text: 'deploy completed' }, ACTOR);
  const comparison = store.compare('main', { id: 'scope-check', left: left.id, right: right.id, relation: 'equal' }, ACTOR);
  const initial = store.readout('main').boards[0]!;
  assert.equal(initial.annotations?.find((entry) => entry.id === annotation.id)?.text, 'deploy completed');
  const result = initial.comparisons?.find((entry) => entry.id === comparison.id);
  assert.equal(result?.state, 'unknown', 'different scopes are incompatible');
  assert.match(result?.reason ?? '', /incompatible scope/);
  store.flush();

  const reloaded = new Store(file);
  stores.push(reloaded);
  const persisted = reloaded.readout('main').boards[0]!;
  assert.equal(persisted.annotations?.find((entry) => entry.id === annotation.id)?.text, 'deploy completed');
  const persistedComparison = persisted.comparisons?.find((entry) => entry.id === comparison.id);
  assert.equal(persistedComparison?.state, 'unknown');
  assert.match(persistedComparison?.reason ?? '', /incompatible scope/);
}

function clearCanvasAndDeleteBoard() {
  const { store, dir, file } = fresh('clear-canvas');
  const other = store.createBoard('Keep this board', ACTOR);
  const untouched = store.push('other-canvas-reading', { board: other.id, value: 7 }, ACTOR);
  const beforeOther = structuredClone(untouched);
  store.push('clear-left', { value: 1 }, ACTOR);
  store.push('clear-right', { value: 2 }, ACTOR);
  const ticket = store.create({ type: 'ticket', title: 'Recoverable ticket', board: 'main' }, ACTOR);
  store.annotate('main', { time: Date.now(), text: 'retained tombstone' }, ACTOR);
  store.compare('main', { left: 'clear-left', right: 'clear-right', relation: 'equal' }, ACTOR);
  store.applyDashboard('main', { rows: [{ key: 'headline', cards: [{ key: 'metric', item: { type: 'monitor', title: 'Managed metric' } }] }] }, ACTOR);
  const original = store.setProgram('board', 'main', { code: '<b>custom</b>', language: 'html', description: 'clear fixture', bindings: ['clear-left'], capabilities: [] }, ACTOR);
  store.saveProgramDraft('board', 'main', { code: 'bad', language: 'javascript', description: 'draft', bindings: [], capabilities: [] }, ['fixture'], ACTOR);
  const boardBefore = structuredClone(store.requireBoard('main'));
  const result = store.clearBoard('main', ACTOR);
  assert.equal(result.board, 'main');
  assert.equal(result.cleared, 4);
  assert.equal(store.items({ board: 'main' }).length, 0, 'clear empties the canvas');
  const board = store.requireBoard('main');
  assert.equal(board.createdAt, boardBefore.createdAt, 'clear preserves board identity');
  assert.equal(board.autoOrganize, boardBefore.autoOrganize, 'clear preserves board settings');
  assert.equal(board.dashboard, undefined);
  assert.equal(board.programDraft, undefined);
  assert.equal(board.program?.disabled, true);
  assert.notEqual(board.program?.revision, original.revision, 'clear revokes existing program sessions');
  assert(board.annotations?.every(record => record.deletedAt));
  assert(board.comparisons?.every(record => record.deletedAt));
  assert.deepEqual(store.get(untouched.id), beforeOther, 'clear leaves the other canvas untouched');
  assert.equal(store.trash().filter(entry => entry.item.board === 'main').length, 4);
  assert(readdirSync(join(dir, 'backups')).some(name => name.includes('preclear-main')));
  store.flush();
  const reloaded = new Store(file); stores.push(reloaded);
  assert.equal(reloaded.items({ board: 'main' }).length, 0, 'clear survives restart');
  assert.equal(reloaded.restore(ticket.id, ACTOR).uuid, ticket.uuid, 'cleared items remain recoverable');
  expectHudError(() => reloaded.deleteBoard('main', ACTOR), 400, 'main cannot be deleted');
  reloaded.deleteBoard(other.id, ACTOR);
  assert.equal(reloaded.board(other.id), undefined, 'delete removes the board itself');
}

function ticketStructureLint() {
  const { store } = fresh('ticket-lint');
  const ticket = (project: string, title: string, patch: Record<string, unknown> = {}) => store.create({ type: 'ticket', board: 'main', project, title, ...patch }, ACTOR);
  const found = (code: string) => store.lint('main').findings.filter((f) => f.code === code);

  // The live-board shape: GRASP-1 has 8 children, and GRASP-7 waits on 5 of its 7 siblings.
  const grasp = store.create({ type: 'project', title: 'Grasp', key: 'GRASP' }, ACTOR).id;
  const root = ticket(grasp, 'grasp');
  const kids = [2, 3, 4, 5, 6].map((n) => ticket(grasp, `track ${n}`, { parent: root.id }));
  const integrate = ticket(grasp, 'integrate', { parent: root.id, blockedBy: kids.map((k) => k.id) });
  const late = [ticket(grasp, 'track 8', { parent: root.id }), ticket(grasp, 'track 9', { parent: root.id })];
  assert.equal(store.ident(integrate), 'GRASP-7');
  let wide = found('wide-parent');
  assert.equal(wide.length, 1, 'eight open children make one wide parent');
  assert.equal(wide[0]!.id, root.id);
  assert.equal(wide[0]!.severity, 'warning');
  assert.equal(wide[0]!.message, 'GRASP-1 has 8 open children; group them under tickets whose check is a real decision, at most 7 per parent.');
  let sibling = found('integration-sibling');
  assert.equal(sibling.length, 1, 'only the ticket waiting on most siblings is flagged');
  assert.equal(sibling[0]!.id, integrate.id);
  assert.equal(sibling[0]!.severity, 'warning');
  assert.equal(sibling[0]!.message, 'GRASP-7 waits on 5 of its 7 siblings (GRASP-2, GRASP-3, GRASP-4, GRASP-5, GRASP-6), so it integrates them: make it their parent with hud_link {id: "<blocker>", parent: "GRASP-7"} for each.');

  // Finished tickets do not count: a done child narrows the parent and leaves the sibling denominator.
  store.update(late[1]!.id, { status: 'done' }, ACTOR);
  assert.equal(found('wide-parent').length, 0, 'seven open children are within range');
  sibling = found('integration-sibling');
  assert.equal(sibling.length, 1);
  assert.match(sibling[0]!.message, /waits on 5 of its 6 siblings/);
  for (const k of kids.slice(0, 3)) store.update(k.id, { status: 'canceled' }, ACTOR);
  assert.equal(found('integration-sibling').length, 0, 'two open blockers are below the three-sibling floor');

  // Five siblings with no blockers: nothing. Three blockers out of seven siblings is under half: still no sibling finding.
  const neg = store.create({ type: 'project', title: 'Negative', key: 'NEG' }, ACTOR).id;
  const negRoot = ticket(neg, 'flat');
  const flat = [1, 2, 3, 4, 5].map((n) => ticket(neg, `part ${n}`, { parent: negRoot.id }));
  const mine = (f: { id: string }) => [negRoot.id, ...flat.map((t) => t.id)].includes(f.id);
  assert.equal(store.lint('main').findings.filter(mine).length, 0, 'five unblocked siblings raise no finding');
  ticket(neg, 'part 6', { parent: negRoot.id });
  ticket(neg, 'part 7', { parent: negRoot.id });
  const partial = ticket(neg, 'part 8', { parent: negRoot.id, blockedBy: flat.slice(0, 3).map((t) => t.id) });
  wide = found('wide-parent');
  assert.deepEqual(wide.map((f) => f.id), [negRoot.id]);
  assert(!found('integration-sibling').some((f) => f.id === partial.id), '3 of 7 siblings is under half');
}

async function main() {
  try {
    await migrationAndStalePersistence();
    await observationSemantics();
    tableSchema();
    dashboardTransactions();
    annotationsAndComparisonsPersist();
    clearCanvasAndDeleteBoard();
    ticketStructureLint();
    console.log('PASS: v8 migration/provenance, observation freshness and gaps, collector evidence, thresholds, null/zero/partial readings, typed table schema, dashboard transactions and bindings, annotations, comparisons, stale-change persistence, and ticket-structure lint');
  } finally {
    for (const store of stores) close(store);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

await main();
