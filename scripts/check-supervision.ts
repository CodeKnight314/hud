import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HudError, STATE_VERSION, Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import type { Activity, Item } from '../src/types.ts';

const ACTOR = 'supervision-check';
const HUMAN = 'human-reviewer';
const roots: string[] = [];

function fresh(name: string): { store: Store; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `hud-${name}-`));
  roots.push(dir);
  const file = join(dir, 'state.json');
  const store = new Store(file);
  // Every test owns its timer lifecycle.  The real server keeps auto-organize on;
  // these stores disable it so hundreds of API mutations do not leave timers alive.
  store.setBoard('main', { autoOrganize: false }, ACTOR);
  store.flush();
  return { store, dir, file };
}

function flush(store: Store) {
  store.stopBackups();
  store.flush();
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function expectHudError(fn: () => unknown, status: number, label: string) {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  assert(error instanceof HudError, `${label}: expected HudError ${status}`);
  assert.equal((error as HudError).status, status, `${label}: wrong status`);
}

function item(store: Store, id: string): Item {
  return store.get(id);
}

function attentionOf(store: Store, id: string) {
  return store.attention().items.find((a) => a.itemId === id);
}

function activeAttentionOf(store: Store, id: string) {
  const result = attentionOf(store, id);
  assert(result, `expected active attention for ${id}`);
  return result;
}

function assertNoTimerLeak(store: Store) {
  flush(store);
}

async function migrationAndAttention() {
  const dir = mkdtempSync(join(tmpdir(), 'hud-migration-'));
  roots.push(dir);
  const file = join(dir, 'state.json');
  const fixedParentUuid = '11111111-1111-4111-8111-111111111111';
  const fixedChildUuid = '22222222-2222-4222-8222-222222222222';
  const old = {
    version: 7,
    seq: { ticketNum: 2 },
    boards: [{ id: 'main', name: 'main', createdAt: 1, width: 1600, height: 900, autoOrganize: true }],
    items: {
      project: {
        id: 'project', type: 'project', board: 'main', title: 'Legacy Project', key: 'LEG',
        x: 0, y: 0, w: 360, h: 200, createdAt: 1, updatedAt: 1, createdBy: ACTOR, updatedBy: ACTOR,
        body: '', status: 'backlog', tags: [],
      },
      parent: {
        id: 'parent', uuid: fixedParentUuid, type: 'ticket', board: 'main', title: 'Parent',
        x: 0, y: 0, w: 280, h: 150, createdAt: 2, updatedAt: 2, createdBy: ACTOR, updatedBy: ACTOR,
        num: 1, project: 'project', status: 'doing', priority: 'high', body: '', tags: [], comments: [],
        branch: 'leg-1-parent',
      },
      child: {
        id: 'child', uuid: fixedChildUuid, type: 'ticket', board: 'main', title: 'Child',
        x: 300, y: 0, w: 280, h: 150, createdAt: 3, updatedAt: 3, createdBy: ACTOR, updatedBy: ACTOR,
        num: 2, project: 'project', parent: 'parent', blockedBy: ['parent'], refs: ['parent'], status: 'todo',
        body: '', tags: [], comments: [], branch: 'leg-2-child',
      },
    },
    activity: [],
    alerts: [],
    attention: {
      'bad-id': { id: 'wrong-id', itemId: 'bad-id', kind: 'warn', priority: 3, openedAt: 1, revision: 'r', signature: 'warn' },
      parent: { id: 'parent', itemId: 'parent', kind: 'warn', priority: 99, openedAt: 1, revision: 'r', signature: 'warn' },
      'bad-actor': { id: 'bad-actor', itemId: 'bad-actor', kind: 'warn', priority: 3, openedAt: 1, revision: 'r', signature: 'warn', reviewedBy: 7 },
      orphan: { id: 'orphan', itemId: 'orphan', kind: 'warn', priority: 3, openedAt: 1, revision: 'r', signature: 'warn' },
    },
    trash: [],
  };
  writeFileSync(file, JSON.stringify(old));

  const migrated = new Store(file);
  assert.equal(migrated.state.version, STATE_VERSION);
  assert.equal(STATE_VERSION, 11);
  assert.equal(item(migrated, 'parent').uuid, fixedParentUuid);
  assert.equal(item(migrated, 'child').uuid, fixedChildUuid);
  assert.equal(item(migrated, 'child').project, 'project');
  assert.equal(item(migrated, 'child').parent, 'parent');
  assert.deepEqual(item(migrated, 'child').blockedBy, ['parent']);
  assert.deepEqual(item(migrated, 'child').refs, ['parent']);
  assert(readdirSync(join(dir, 'backups')).some((name) => name.includes('premigrate-v7')), 'v7 source must be backed up before migration');
  assert.equal(migrated.state.attention['bad-id'], undefined, 'attention with mismatched record id must be rejected');
  assert.equal(migrated.state.attention.parent, undefined, 'attention with an invalid priority must be rejected');
  assert.equal(migrated.state.attention['bad-actor'], undefined, 'attention with an invalid reviewer must be rejected');
  assert(migrated.state.attention.orphan?.resolvedAt, 'orphaned attention must be resolved on startup');

  // Persist an active, reviewed attention record and prove a fresh Store reloads it.
  const warning = migrated.push('migration-warning', { title: 'migration warning', state: 'warn', message: 'check me' }, ACTOR);
  migrated.organize('main', ACTOR, true);
  migrated.setBoard('main', { autoOrganize: false }, ACTOR);
  const warningRecord = activeAttentionOf(migrated, warning.id);
  const reviewed = migrated.reviewAttention(warning.id, { action: 'review', revision: warningRecord.revision }, HUMAN);
  migrated.flush();
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { version: number; attention: Record<string, unknown> };
  assert.equal(onDisk.version, STATE_VERSION);
  assert(onDisk.attention[warning.id], 'attention must be persisted');

  const reloaded = new Store(file);
  const reloadedRecord = activeAttentionOf(reloaded, warning.id);
  assert.equal(reloadedRecord.reviewedBy, HUMAN);
  assert.equal(reloadedRecord.reviewedAt, reviewed.reviewedAt);
  assert.equal(reloadedRecord.revision, reviewed.revision);
  flush(reloaded);
  flush(migrated);
}

async function attentionLifecycle() {
  const { store } = fresh('attention');
  const warning = store.push('attention-warning', { title: 'warning', state: 'warn', message: 'warn' }, ACTOR);
  const reviewedWarning = store.push('attention-reviewed', { title: 'reviewed warning', state: 'warn', message: 'review' }, ACTOR);
  const error = store.push('attention-error', { title: 'error', state: 'error', message: 'failed' }, ACTOR);
  const stale = store.create({ type: 'monitor', id: 'attention-stale', title: 'stale', source: { kind: 'push' }, staleAfter: 1 }, ACTOR);
  store.push(stale.id, { state: 'ok', message: 'fresh' }, ACTOR);
  stale.lastUpdate = Date.now() - 10_000;
  stale.observation!.observedAt = stale.lastUpdate;
  store.checkStale();
  const blocked = store.create({ type: 'ticket', id: 'attention-blocked', title: 'blocked', status: 'blocked' }, ACTOR);
  const decisionTicket = store.create({ type: 'ticket', id: 'attention-decision', title: 'choose' }, ACTOR);
  store.ask(decisionTicket.id, { question: 'which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, ACTOR);

  const attention = store.attention().items;
  assert.equal(new Set(attention.map((a) => a.itemId)).size, attention.length, 'attention must have no duplicate records');
  assert.deepEqual(attention.map((a) => a.priority), [...attention].map((a) => a.priority).sort((a, b) => a - b), 'attention must be ordered by priority');
  assert.equal(activeAttentionOf(store, decisionTicket.id).kind, 'decision');
  assert.equal(activeAttentionOf(store, error.id).kind, 'error');
  assert.equal(activeAttentionOf(store, stale.id).kind, 'stale');
  assert.equal(activeAttentionOf(store, warning.id).kind, 'warn');
  assert.equal(activeAttentionOf(store, blocked.id).kind, 'blocked');

  // Reasserting an unchanged warning is not a new episode and does not erase review.
  const reviewedBefore = store.reviewAttention(reviewedWarning.id, { action: 'review', revision: activeAttentionOf(store, reviewedWarning.id).revision }, HUMAN);
  const repeatedBefore = copy(store.state.attention[reviewedWarning.id]);
  store.push(reviewedWarning.id, { state: 'warn', message: 'review' }, ACTOR);
  const repeatedAfter = store.state.attention[reviewedWarning.id];
  assert.equal(repeatedAfter.revision, repeatedBefore.revision);
  assert.equal(repeatedAfter.reviewedBy, HUMAN);
  assert.equal(repeatedAfter.reviewedAt, reviewedBefore.reviewedAt);
  assert.equal(store.attention().items.filter((a) => a.itemId === reviewedWarning.id).length, 1);

  // Attention review is separate from the old alert acknowledgement queue.
  assert(store.alerts({ all: true }).some((a) => !a.acked), 'warning/error readings should raise alerts');
  store.ackAlerts('all');
  assert(store.alerts({ all: true }).every((a) => a.acked), 'ackAlerts should acknowledge alerts');
  assert(activeAttentionOf(store, reviewedWarning.id), 'acknowledging alerts must not resolve attention');

  // Snoozing remains represented with its deadline, then becomes expired without disappearing from the API record.
  const snoozeUntil = Date.now() + 80;
  const snoozed = store.reviewAttention(reviewedWarning.id, { action: 'snooze', revision: repeatedAfter.revision, until: snoozeUntil }, HUMAN);
  assert.equal(snoozed.snoozedUntil, snoozeUntil);
  assert.equal(activeAttentionOf(store, reviewedWarning.id).snoozedUntil, snoozeUntil);
  await sleep(110);
  const afterSnoozeExpiry = store.attention();
  const expired = activeAttentionOf(store, reviewedWarning.id);
  assert(Number(expired.snoozedUntil) <= afterSnoozeExpiry.now, 'expired snooze must be visible as expired');

  // Recovery closes the episode. A subsequent recurrence clears old review/snooze state and gets a new revision.
  const staleRevision = store.state.attention[reviewedWarning.id].revision;
  store.push(reviewedWarning.id, { state: 'ok', message: 'recovered' }, ACTOR);
  assert(store.state.attention[reviewedWarning.id].resolvedAt, 'recovery should resolve attention');
  store.push(reviewedWarning.id, { state: 'warn', message: 'again' }, ACTOR);
  const recurring = activeAttentionOf(store, reviewedWarning.id);
  assert.notEqual(recurring.revision, staleRevision);
  assert.equal(recurring.reviewedAt, undefined);
  assert.equal(recurring.snoozedUntil, undefined);
  expectHudError(() => store.reviewAttention(reviewedWarning.id, { action: 'review', revision: staleRevision }, HUMAN), 409, 'stale recurrence revision');

  // Escalation also starts a clean attention episode, and stale review revisions are rejected.
  const escalating = store.push('attention-escalating', { title: 'escalating', state: 'warn' }, ACTOR);
  const escalationReview = store.reviewAttention(escalating.id, { action: 'review', revision: activeAttentionOf(store, escalating.id).revision }, HUMAN);
  store.reviewAttention(escalating.id, { action: 'snooze', revision: escalationReview.revision, until: Date.now() + 500 }, HUMAN);
  const escalationOldRevision = store.state.attention[escalating.id].revision;
  store.push(escalating.id, { state: 'error', message: 'escalated' }, ACTOR);
  const escalated = activeAttentionOf(store, escalating.id);
  assert.equal(escalated.kind, 'error');
  assert.equal(escalated.reviewedAt, undefined);
  assert.equal(escalated.snoozedUntil, undefined);
  expectHudError(() => store.reviewAttention(escalating.id, { action: 'review', revision: escalationOldRevision }, HUMAN), 409, 'stale escalation revision');

  // Error and stale recovery close their records; deletion closes a remaining active record too.
  store.push(error.id, { state: 'ok', message: 'recovered' }, ACTOR);
  assert(store.state.attention[error.id].resolvedAt, 'error recovery should resolve attention');
  store.push(stale.id, { state: 'ok', message: 'fresh again' }, ACTOR);
  assert(store.state.attention[stale.id].resolvedAt, 'stale recovery should resolve attention');
  const deleted = store.push('attention-deleted', { title: 'deleted', state: 'error' }, ACTOR);
  assert(activeAttentionOf(store, deleted.id));
  store.remove(deleted.id, ACTOR);
  assert(store.state.attention[deleted.id].resolvedAt, 'deleting an item should resolve attention');
  assert.equal(attentionOf(store, deleted.id), undefined);

  // Deleting/restoring a whole board follows the same attention episode boundary as deleting one item.
  const deleteBoard = store.createBoard('attention-delete-board', ACTOR, 'attention-delete-board');
  store.setBoard(deleteBoard.id, { autoOrganize: false }, ACTOR);
  const boardIssue = store.push('attention-board-deleted', { board: deleteBoard.id, state: 'warn' }, ACTOR);
  const boardIssueBefore = activeAttentionOf(store, boardIssue.id);
  store.deleteBoard(deleteBoard.id, ACTOR);
  assert(store.state.attention[boardIssue.id].resolvedAt, 'deleting a board should resolve its attention records');
  assert.equal(attentionOf(store, boardIssue.id), undefined);
  store.restore(boardIssue.id, ACTOR);
  const boardIssueAfter = activeAttentionOf(store, boardIssue.id);
  assert.notEqual(boardIssueAfter.revision, boardIssueBefore.revision, 'restoring a deleted board should open a new attention episode');
  assert.equal(boardIssueAfter.reviewedAt, undefined);
  assert.equal(boardIssueAfter.snoozedUntil, undefined);
  assertNoTimerLeak(store);
}

function decisionRevisions() {
  const { store } = fresh('decisions');
  const ticket = store.create({ type: 'ticket', id: 'decision-revisions', title: 'decision revisions' }, ACTOR);
  const asked = store.ask(ticket.id, {
    question: 'choose a route', questionFormat: 'markdown',
    options: [{ id: 'keep', label: 'Keep', status: 'doing' }, { id: 'drop', label: 'Drop', status: 'canceled' }],
  }, ACTOR);
  assert.equal(asked.questionFormat, 'markdown');
  const firstVersion = asked.decisionVersion!;
  const beforeInvalidNote = copy(item(store, ticket.id));
  expectHudError(() => store.decide(ticket.id, 'keep', HUMAN, { invalid: true } as never, firstVersion), 400, 'invalid decision note');
  assert.deepEqual(item(store, ticket.id), beforeInvalidNote, 'invalid decision note must not mutate the ticket');
  expectHudError(() => store.decide(ticket.id, 'keep', HUMAN, undefined, 'wrong-version'), 409, 'stale decision version');
  expectHudError(() => store.decide(ticket.id, 'keep', HUMAN), 409, 'missing decision version');
  const decided = store.decide(ticket.id, 'keep', HUMAN, 'go ahead', firstVersion);
  assert.equal(decided.decision?.optionId, 'keep');
  assert.equal(decided.status, 'doing');
  expectHudError(() => store.decide(ticket.id, 'keep', HUMAN, undefined, firstVersion), 409, 'duplicate decision');

  const reopened = store.ask(ticket.id, { question: 'choose again', options: [{ id: 'drop', label: 'Drop', status: 'canceled' }] }, ACTOR);
  assert.notEqual(reopened.decisionVersion, firstVersion);
  expectHudError(() => store.decide(ticket.id, 'drop', HUMAN, undefined, firstVersion), 409, 'stale replacement decision');
  const chosen = store.decide(ticket.id, 'drop', HUMAN, undefined, reopened.decisionVersion);
  assert.equal(chosen.status, 'canceled');
  flush(store);
}

function reportsAndComments() {
  const { store } = fresh('reports');
  const monitor = store.create({
    type: 'monitor', id: 'report-monitor', title: 'reports', source: { kind: 'push' }, value: 1,
    message: 'first headline', messageFormat: 'markdown', details: '# First report',
  }, ACTOR);
  assert.equal(monitor.messageFormat, 'markdown');
  assert.equal(monitor.details, '# First report');
  assert.equal(monitor.reportHistory?.length, 1);
  assert.equal(monitor.reportHistory?.[0]?.messageFormat, 'markdown');
  assert.equal(monitor.reportHistory?.[0]?.details, '# First report');

  const detailsOnly = store.create({
    type: 'monitor', id: 'report-details-only', title: 'details only', source: { kind: 'push' },
    message: 'report headline', messageFormat: 'markdown', details: '## No numeric reading',
  }, ACTOR);
  assert.equal(detailsOnly.value, undefined);
  assert.equal(detailsOnly.reportHistory?.length, 1, 'a Markdown report without a numeric value must be recorded');
  assert.equal(detailsOnly.reportHistory?.[0]?.messageFormat, 'markdown');
  assert.equal(detailsOnly.reportHistory?.[0]?.details, '## No numeric reading');

  const plain = store.create({ type: 'monitor', id: 'report-plain', title: 'plain', source: { kind: 'push' }, value: 1, message: 'same plain message' }, ACTOR);
  const plainReportCount = plain.reportHistory?.length ?? 0;
  store.push(plain.id, { value: 1, message: 'same plain message' }, ACTOR);
  assert.equal(item(store, plain.id).reportHistory?.length, plainReportCount, 'repeated plain messages with omitted format must not grow report history');

  const beforeInvalid = copy(item(store, monitor.id));
  expectHudError(() => store.update(monitor.id, { messageFormat: 'html' }, ACTOR), 400, 'invalid update message format');
  assert.deepEqual(item(store, monitor.id), beforeInvalid, 'invalid format update must be atomic');
  expectHudError(() => store.update(monitor.id, { details: 'x'.repeat(20_001) }, ACTOR), 400, 'oversized update details');
  assert.deepEqual(item(store, monitor.id), beforeInvalid, 'oversized details update must be atomic');
  expectHudError(() => store.update(monitor.id, { details: 'é'.repeat(10_001) }, ACTOR), 400, 'multibyte details over 20 KB');
  assert.deepEqual(item(store, monitor.id), beforeInvalid, 'multibyte oversized details update must be atomic');

  store.update(monitor.id, { value: 2, message: 'second headline', messageFormat: 'markdown', details: '## Second report' }, ACTOR);
  const reportCount = item(store, monitor.id).reportHistory?.length ?? 0;
  assert(reportCount >= 2);
  store.push(monitor.id, { value: 2, message: 'second headline', messageFormat: 'markdown', details: '## Second report' }, ACTOR);
  assert.equal(item(store, monitor.id).reportHistory?.length, reportCount, 'unchanged readings must not grow report history');

  const beforeBadPush = copy(item(store, monitor.id));
  expectHudError(() => store.push(monitor.id, { value: 3, messageFormat: 'html' as never }, ACTOR), 400, 'invalid push message format');
  assert.deepEqual(item(store, monitor.id), beforeBadPush, 'invalid push must be atomic');
  expectHudError(() => store.push(monitor.id, { value: 3, details: 'x'.repeat(20_001) }, ACTOR), 400, 'oversized push details');
  assert.deepEqual(item(store, monitor.id), beforeBadPush, 'oversized push must be atomic');

  // Fan-out validation happens for the whole tree before any child or parent reading is applied.
  const beforeFanout = copy(item(store, monitor.id));
  const countBeforeFanout = Object.keys(store.state.items).length;
  expectHudError(() => store.push(monitor.id, {
    value: 4,
    monitors: { 'fanout-invalid-format': { value: 1, messageFormat: 'html' as never } },
  }, ACTOR), 400, 'fanout invalid format');
  assert.equal(Object.keys(store.state.items).length, countBeforeFanout);
  assert.deepEqual(item(store, monitor.id), beforeFanout, 'invalid fan-out format must be atomic');
  expectHudError(() => store.push(monitor.id, {
    value: 4,
    monitors: { 'fanout-invalid-details': { value: 1, details: 'x'.repeat(20_001) } },
  }, ACTOR), 400, 'fanout oversized details');
  assert.equal(Object.keys(store.state.items).length, countBeforeFanout);
  assert.deepEqual(item(store, monitor.id), beforeFanout, 'invalid fan-out details must be atomic');
  store.push(monitor.id, {
    monitors: { 'fanout-valid': { title: 'fanout child', value: 7, message: 'child', messageFormat: 'markdown', details: 'child report' } },
  }, ACTOR);
  assert.equal(item(store, 'fanout-valid').messageFormat, 'markdown');

  const lite = Store.lite(item(store, monitor.id));
  assert(!('trend' in lite), 'lite must omit trend');
  assert(!('reportHistory' in lite), 'lite must omit report history');

  const ticket = store.create({ type: 'ticket', id: 'markdown-comments', title: 'comments' }, ACTOR);
  const comment = store.comment(ticket.id, '**hello**', ACTOR, 'markdown');
  assert.equal(comment.format, 'markdown');
  const edited = store.editComment(ticket.id, comment.id, '*edited*', ACTOR);
  assert.equal(edited.format, 'markdown');
  const beforeBadComment = copy(item(store, ticket.id));
  expectHudError(() => store.comment(ticket.id, 'invalid format', ACTOR, 'html' as never), 400, 'invalid comment format');
  assert.deepEqual(item(store, ticket.id), beforeBadComment, 'invalid comment format must be atomic');
  expectHudError(() => store.editComment(ticket.id, comment.id, 'invalid edit', ACTOR, 'html' as never), 400, 'invalid edit format');
  assert.deepEqual(item(store, ticket.id), beforeBadComment, 'invalid edit format must be atomic');
  flush(store);
}

function runsAndLinks() {
  const { store } = fresh('runs');
  const summary = store.push('run-summary-monitor', { title: 'summary', progress: 40, value: 40, state: 'ok' }, ACTOR);
  const detail = store.push('run-detail-monitor', { title: 'detail', progress: 90, value: 90, state: 'warn' }, ACTOR);
  expectHudError(() => store.create({ type: 'ticket', id: 'bad-summary-link', title: 'bad', summaryMonitor: summary.id }, ACTOR), 400, 'summary monitor requires a linked monitor');
  assert.equal(store.state.items['bad-summary-link'], undefined);

  const run = store.create({
    type: 'ticket', id: 'run-root', title: 'Run root', tags: ['run'], status: 'doing',
    monitors: [summary.id, detail.id], summaryMonitor: summary.id,
  }, ACTOR);
  const child = store.create({ type: 'ticket', id: 'run-child', title: 'Nested child', parent: run.id, monitors: [detail.id], status: 'blocked' }, ACTOR);
  const parentCandidate = store.create({ type: 'ticket', id: 'run-parent-candidate', title: 'Parent candidate' }, ACTOR);
  const runView = store.runs().items.find((r) => r.id === run.id);
  assert(runView, 'run tag should produce a run view');
  assert.equal(runView.progress, 40, 'run progress must come only from summaryMonitor, not an average');
  assert.deepEqual(new Set(runView.monitors.map((m) => m.id)), new Set([summary.id, detail.id]));
  assert.deepEqual(runView.tickets.map((t) => t.id), [child.id]);
  const childAttention = activeAttentionOf(store, child.id);
  assert.equal(childAttention.runId, run.id, 'nested ticket attention should identify its run');
  assert.equal(activeAttentionOf(store, detail.id).runId, run.id, 'linked monitor attention should identify its run');

  const beforeInvalidSummaryAndParent = copy(item(store, run.id));
  expectHudError(() => store.update(run.id, { summaryMonitor: 'missing-summary', parent: parentCandidate.id }, ACTOR), 400, 'invalid summary plus parent update');
  assert.deepEqual(item(store, run.id), beforeInvalidSummaryAndParent, 'invalid summary plus parent update must be atomic');
  expectHudError(() => store.update(run.id, { summaryMonitor: 'missing-summary' }, ACTOR), 400, 'summary monitor update validation');
  assert.equal(item(store, run.id).summaryMonitor, summary.id);
  const other = store.createBoard('other', ACTOR, 'other');
  store.setBoard(other.id, { autoOrganize: false }, ACTOR);
  expectHudError(() => store.update(summary.id, { board: other.id }, ACTOR), 409, 'linked summary monitor cannot move boards');
  assert.equal(item(store, summary.id).board, 'main');
  store.remove(summary.id, ACTOR);
  assert(!item(store, run.id).monitors?.includes(summary.id), 'deleting a linked monitor must remove ticket association');
  assert.equal(item(store, run.id).summaryMonitor, undefined, 'deleting the summary monitor must clear summaryMonitor');
  const afterDelete = store.runs().items.find((r) => r.id === run.id)!;
  assert.equal(afterDelete.progress, null);
  assert.deepEqual(afterDelete.monitors.map((m) => m.id), [detail.id]);
  flush(store);
}

function changesSinceChecks() {
  const { store } = fresh('changes');
  expectHudError(() => store.changesSince(Number.NaN), 400, 'NaN changes cursor');
  expectHudError(() => store.changesSince(-1), 400, 'negative changes cursor');
  expectHudError(() => store.changesSince(Date.now() + 10_000), 400, 'future changes cursor');

  const attentionMonitor = store.push('changes-attention', { state: 'warn' }, ACTOR);
  let attentionRecord = activeAttentionOf(store, attentionMonitor.id);
  store.reviewAttention(attentionMonitor.id, { action: 'review', revision: attentionRecord.revision }, HUMAN);
  attentionRecord = activeAttentionOf(store, attentionMonitor.id);
  store.reviewAttention(attentionMonitor.id, { action: 'snooze', revision: attentionRecord.revision, until: Date.now() + 1_000 }, HUMAN);
  attentionRecord = activeAttentionOf(store, attentionMonitor.id);
  store.reviewAttention(attentionMonitor.id, { action: 'unreview', revision: attentionRecord.revision }, HUMAN);
  store.setBoard('main', { name: 'changes-renamed' }, ACTOR);
  const supervisionActions = new Set(store.changesSince(0).events.map((event) => event.action));
  assert(supervisionActions.has('attention.review'), 'changes must include attention review');
  assert(supervisionActions.has('attention.snooze'), 'changes must include attention snooze');
  assert(supervisionActions.has('attention.unreview'), 'changes must include attention unreview');
  assert(supervisionActions.has('board.renamed'), 'changes must include board rename');

  const base = Date.now() - 20_000;
  const activity = Array.from({ length: 600 }, (_, i): Activity => ({
    id: i + 1, t: base + i, actor: ACTOR, action: 'updated', itemId: `item-${i}`, board: 'main', text: 'updated',
  }));
  store.state.activity = activity;
  const truncated = store.changesSince(base - 1);
  assert.equal(truncated.events.length, 500, 'changesSince must cap the response at 500 events');
  assert.equal(truncated.events[0]?.id, 101);
  assert.equal(truncated.complete, false, 'a truncated response is not complete');

  store.state.activity = activity.slice(0, 2).map((a, i) => ({ ...a, id: 100 + i }));
  const retained = store.changesSince(base - 1);
  assert.equal(retained.events.length, 2);
  assert.equal(retained.complete, false, 'a cursor before retained history is incomplete');

  store.state.activity = activity.slice(0, 2);
  const complete = store.changesSince(base - 1);
  assert.equal(complete.events.length, 2);
  assert.equal(complete.complete, true);
  flush(store);
}

function stressReadModels() {
  const { store } = fresh('stress');
  const monitorIds: string[] = [];
  for (let i = 0; i < 100; i++) {
    const id = `stress-monitor-${i}`;
    monitorIds.push(id);
    store.push(id, { title: `monitor ${i}`, value: i, progress: i % 101, state: 'ok' }, ACTOR);
  }

  const runs: Item[] = [];
  for (let i = 0; i < 20; i++) {
    const linked = monitorIds.slice(i * 5, i * 5 + 5);
    runs.push(store.create({
      type: 'ticket', id: `stress-run-${i}`, title: `Run ${i}`, tags: ['run'], status: 'doing',
      monitors: linked, summaryMonitor: linked[0],
    }, ACTOR));
  }
  const children: Item[] = [];
  for (let i = 0; i < 200; i++) {
    const run = runs[Math.floor(i / 10)]!;
    children.push(store.create({
      type: 'ticket', id: `stress-ticket-${i}`, title: `Ticket ${i}`, parent: run.id,
      monitors: [monitorIds[Math.floor(i / 10) * 5 + (i % 5)]!], status: 'todo',
    }, ACTOR));
  }

  assert.equal(Object.values(store.state.items).filter((i) => i.type === 'monitor').length, 100);
  assert.equal(Object.values(store.state.items).filter((i) => i.type === 'ticket').length, 220);
  const view = store.runs().items;
  assert.equal(view.length, 20);
  for (const run of view) {
    assert.equal(run.tickets.length, 10, `${run.id} must include exactly its ten nested tickets`);
    assert.equal(new Set(run.tickets.map((t) => t.id)).size, run.tickets.length, `${run.id} tickets must be unique`);
    assert.equal(new Set(run.monitors.map((m) => m.id)).size, run.monitors.length, `${run.id} monitors must be unique`);
    assert.equal(run.monitors.length, 5, `${run.id} monitor set must stay bounded`);
    for (const monitor of run.monitors) {
      assert(!('trend' in monitor), 'run monitor read model must omit trend');
      assert(!('reportHistory' in monitor), 'run monitor read model must omit report history');
    }
  }
  const viewAgain = store.runs().items;
  assert.deepEqual(viewAgain.map((r) => r.id), view.map((r) => r.id));
  assert.deepEqual(viewAgain.map((r) => r.tickets.map((t) => t.id)), view.map((r) => r.tickets.map((t) => t.id)));
  assert.equal(store.attention().items.length, 0, 'healthy stress board must not create duplicate attention');
  flush(store);
}

const USER = 'user';

function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out waiting for command approval behavior'));
      setTimeout(tick, 30);
    };
    tick();
  });
}

async function commandApprovalGate() {
  const dir = mkdtempSync(join(tmpdir(), 'hud-command-gate-'));
  roots.push(dir);
  const file = join(dir, 'state.json');
  const marker = join(dir, 'ran.txt');
  const changed = join(dir, 'changed.txt');
  const legacy = {
    version: 10,
    seq: {},
    boards: [{ id: 'main', name: 'main', createdAt: 1, width: 1600, height: 900, autoOrganize: false }],
    items: {
      'legacy-cmd': {
        id: 'legacy-cmd', type: 'monitor', board: 'main', title: 'legacy command',
        x: 0, y: 0, w: 260, h: 150, createdAt: 1, updatedAt: 1, createdBy: ACTOR, updatedBy: ACTOR,
        source: { kind: 'command', command: 'echo legacy', cwd: '/tmp', interval: 30 }, state: 'unknown', display: 'auto', history: [], log: [],
      },
      'legacy-warn': {
        id: 'legacy-warn', type: 'monitor', board: 'main', title: 'legacy warn',
        x: 280, y: 0, w: 260, h: 150, createdAt: 2, updatedAt: 2, createdBy: ACTOR, updatedBy: ACTOR,
        source: { kind: 'manual' }, state: 'warn', message: 'still warning', display: 'auto', history: [], log: [],
      },
    },
    activity: [],
    alerts: [],
    attention: {
      'legacy-warn': {
        id: 'legacy-warn', itemId: 'legacy-warn', kind: 'warn', priority: 3, openedAt: 2,
        revision: 'legacy-rev', signature: 'warn', reviewedAt: 3, reviewedBy: HUMAN,
      },
    },
    trash: [{
      t: Date.now(), actor: ACTOR,
      item: {
        id: 'trashed-cmd', type: 'monitor', board: 'main', title: 'trashed command',
        x: 0, y: 0, w: 260, h: 150, createdAt: 3, updatedAt: 3, createdBy: ACTOR, updatedBy: ACTOR,
        source: { kind: 'command', command: 'echo trashed' }, state: 'unknown',
      },
    }],
  };
  writeFileSync(file, JSON.stringify(legacy));
  const store = new Store(file);
  store.setBoard('main', { autoOrganize: false }, ACTOR);
  assert.equal(store.state.version, 11);
  const kept = item(store, 'legacy-cmd');
  assert.equal(kept.commandApproval?.status, 'approved', 'an existing command monitor keeps running after upgrade');
  assert.equal(kept.commandApproval?.fingerprint, JSON.stringify({ kind: 'command', command: 'echo legacy', cwd: '/tmp' }));
  assert.equal(kept.commandApproval?.approvedBy, 'hud');
  const trashed = store.state.trash.find((entry) => entry.item.id === 'trashed-cmd');
  assert.equal(trashed?.item.commandApproval?.status, 'approved', 'trashed command monitors are grandfathered too');
  const warn = store.state.attention['legacy-warn'];
  assert.equal(warn.kind, 'warn');
  assert.equal(warn.priority, 4, 'warn keeps its place after command is inserted at the front of the attention order');
  assert.equal(warn.reviewedBy, HUMAN, 'migration must keep an existing review');
  assert.equal(warn.revision, 'legacy-rev');

  const engine = new Engine(store, dir);
  engine.start();
  try {
    assert.equal(engine.running.has('legacy-cmd'), true, 'a grandfathered command is eligible to run');

    const forged = store.create({
      type: 'monitor', id: 'forged-cmd', title: 'forged',
      source: { kind: 'command', command: `touch ${JSON.stringify(marker)}`, interval: 3600 },
      commandApproval: { status: 'approved', fingerprint: 'nope', requestedBy: USER, requestedAt: 1, approvedBy: USER, approvedAt: 1 },
    }, ACTOR);
    assert.equal(forged.commandApproval?.status, 'pending', 'a caller cannot store its own approval');
    assert.notEqual(forged.commandApproval?.fingerprint, 'nope');
    assert.equal(engine.running.has(forged.id), false, 'a new agent command must not be scheduled');
    const pending = activeAttentionOf(store, forged.id);
    assert.equal(pending.kind, 'command');
    assert.equal(pending.priority, 0, 'a pending command sorts ahead of other attention');
    assert.match(pending.message || '', /supervision-check wants to run:/);
    assert.match(pending.message || '', /touch /);
    assert.equal(store.attention().items[0]?.itemId, forged.id);
    await sleep(250);
    assert.equal(existsSync(marker), false, 'the engine must not execute an unapproved command');

    store.reviewAttention(forged.id, { action: 'snooze', revision: pending.revision, until: Date.now() + 60_000 }, USER);
    assert.equal(item(store, forged.id).commandApproval?.status, 'pending', 'snooze does not approve');
    assert.equal(engine.running.has(forged.id), false);
    const snoozedRevision = store.state.attention[forged.id].revision;
    expectHudError(() => store.reviewAttention(forged.id, { action: 'review', revision: snoozedRevision }, USER), 400, 'review is not approval');
    expectHudError(() => store.approveCommand(forged.id, snoozedRevision, ACTOR), 403, 'agent approval');
    expectHudError(() => store.approveCommand(forged.id, snoozedRevision, HUMAN), 403, 'non-user approval');
    expectHudError(() => store.approveCommand(forged.id, 'stale-revision', USER), 409, 'stale approval revision');
    await engine.runNow(forged.id).then(() => { throw new Error('runNow should reject a pending command'); }, (error: Error) => {
      assert.match(error.message, /approval/);
    });

    const approved = store.approveCommand(forged.id, snoozedRevision, USER);
    assert.equal(approved.commandApproval?.status, 'approved');
    assert.equal(approved.commandApproval?.approvedBy, USER);
    assert.equal(attentionOf(store, forged.id), undefined, 'approval closes the command attention episode');
    assert.equal(engine.running.has(forged.id), true);
    await waitFor(() => existsSync(marker));
    assert(store.state.activity.some((entry) => entry.action === 'command.approve' && entry.itemId === forged.id));

    const retitled = store.update(forged.id, { title: 'renamed' }, ACTOR);
    assert.equal(retitled.commandApproval?.status, 'approved', 'an unrelated edit keeps the approval');
    const sameCommand = store.update(forged.id, { source: { ...retitled.source, interval: 120 } }, ACTOR);
    assert.equal(sameCommand.commandApproval?.status, 'approved', 'interval changes do not re-arm the gate');
    assert.equal(sameCommand.commandApproval?.fingerprint, forged.commandApproval?.fingerprint);
    assert.equal(engine.running.has(forged.id), true);

    const edited = store.update(forged.id, { source: { kind: 'command', command: `touch ${JSON.stringify(changed)}`, cwd: dir, interval: 3600 } }, ACTOR);
    assert.equal(edited.commandApproval?.status, 'pending', 'a changed command or cwd needs a new approval');
    assert.equal(engine.running.has(forged.id), false, 'the engine stops when the approved command changes');
    const again = activeAttentionOf(store, forged.id);
    assert.equal(again.kind, 'command');
    assert.notEqual(again.revision, pending.revision);
    await sleep(250);
    assert.equal(existsSync(changed), false, 'the replacement command must not run before approval');
    expectHudError(() => store.approveCommand(forged.id, snoozedRevision, USER), 409, 'old revision cannot approve the new command');

    const humanEdit = store.update(forged.id, { source: { kind: 'command', command: 'echo human', interval: 3600 } }, USER);
    assert.equal(humanEdit.commandApproval?.status, 'approved', 'a command the human writes is approved by that edit');
    assert.equal(humanEdit.commandApproval?.approvedBy, USER);
    assert.equal(attentionOf(store, forged.id), undefined);
    assert.equal(engine.running.has(forged.id), true);

    const manual = store.update(forged.id, { source: { kind: 'manual' } }, ACTOR);
    assert.equal(manual.commandApproval, undefined, 'leaving command clears the approval record');
    assert.equal(engine.running.has(forged.id), false);

    const http = store.create({ type: 'monitor', id: 'http-still-runs', title: 'http', source: { kind: 'http', url: 'http://127.0.0.1:9/', interval: 3600 } }, ACTOR);
    assert.equal(http.commandApproval, undefined);
    assert.equal(engine.running.has(http.id), true, 'http monitors are not held for command approval');
    assert.equal(attentionOf(store, http.id), undefined);

    const owned = store.create({ type: 'monitor', id: 'user-cmd', title: 'user command', source: { kind: 'command', command: 'true', interval: 3600 } }, USER);
    assert.equal(owned.commandApproval?.status, 'approved');
    assert.equal(engine.running.has(owned.id), true);
    assert.equal(attentionOf(store, owned.id), undefined);

    store.push(owned.id, { state: 'error', message: 'reported' }, ACTOR);
    assert.equal(activeAttentionOf(store, owned.id).kind, 'error', 'an approved command still raises ordinary attention');
    const blocked = store.update(owned.id, { source: { kind: 'command', command: 'false', interval: 3600 } }, ACTOR);
    assert.equal(blocked.commandApproval?.status, 'pending');
    assert.equal(activeAttentionOf(store, owned.id).kind, 'command', 'pending approval outranks an existing error');
  } finally {
    engine.stopAll();
    flush(store);
  }
}

async function main() {
  await migrationAndAttention();
  await commandApprovalGate();
  await attentionLifecycle();
  decisionRevisions();
  reportsAndComments();
  runsAndLinks();
  changesSinceChecks();
  stressReadModels();
  console.log('PASS: supervision migration, attention lifecycle/revisions, reports/comments/fan-out validation, runs/links, incremental changes, and 20-run/100-monitor/200-ticket read-model stress.');
  console.log(`Scratch directories: ${roots.join(', ')}`);
}

main().catch((error) => {
  console.error('FAIL: supervision regression', error);
  console.error(`Scratch directories: ${roots.join(', ')}`);
  process.exitCode = 1;
});
