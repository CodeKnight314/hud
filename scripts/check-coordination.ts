import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HudError, LEASE_IDLE_MS, STATE_VERSION, Store } from '../src/store.ts';
import { ticketsView } from '../src/summary.ts';
import { attachmentPath, hashBytes, readAttachmentBytes, sanitizeName, setAttachmentsRoot, writeAttachmentBytes } from '../src/attachments.ts';
import { buildZip, listZipEntries, zipEntry, zipSegment } from '../src/context-export.ts';
import { unifiedDiff } from '../src/diff.ts';
import type { Item } from '../src/types.ts';
import { contextHandoff, loadContextPages } from '../web/context-timeline.js';

const ACTOR = 'coordination-check';
const roots: string[] = [];

function fresh(name: string): { store: Store; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `hud-${name}-`));
  roots.push(dir);
  const file = join(dir, 'state.json');
  const store = new Store(file);
  store.setBoard('main', { autoOrganize: false }, ACTOR);
  store.flush();
  return { store, dir, file };
}

function finish(store: Store) {
  store.stopBackups();
  store.flush();
}

function expectError(fn: () => unknown, status: number, code: string | undefined, label: string) {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  assert(error instanceof HudError, `${label}: expected HudError ${status}`);
  assert.equal((error as HudError).status, status, `${label}: wrong status`);
  if (code) assert.equal((error as HudError).details?.code, code, `${label}: wrong code`);
}

function ticket(store: Store, title: string, patch: Record<string, unknown> = {}): Item {
  return store.create({ type: 'ticket', title, ...patch }, ACTOR);
}

function migration() {
  const dir = mkdtempSync(join(tmpdir(), 'hud-coord-migration-'));
  roots.push(dir);
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({
    version: 9,
    seq: { ticketNum: 1 },
    boards: [{ id: 'main', name: 'main', createdAt: 1, width: 1600, height: 900, autoOrganize: true }],
    items: {
      t1: { id: 't1', uuid: '11111111-1111-4111-8111-111111111111', type: 'ticket', board: 'main', title: 'old', num: 1, status: 'todo', x: 0, y: 0, w: 280, h: 150, createdAt: 1, updatedAt: 1, createdBy: 'a', updatedBy: 'a' },
    },
    activity: [], alerts: [], trash: [], attention: {},
  }));
  const store = new Store(file);
  assert.equal(store.state.version, STATE_VERSION);
  assert.equal(STATE_VERSION, 11);
  assert.deepEqual(store.state.context, []);
  assert.deepEqual(Object.keys(store.state.attachments), []);
  assert.equal(store.get('t1').title, 'old');
  const backups = readdirSync(join(dir, 'backups'));
  assert(backups.some((b) => b.includes('premigrate-v9')), 'pre-migration backup missing');
  finish(store);
}

function sessions() {
  const { store } = fresh('coord-sessions');
  const s = store.sessionStart({ id: 'agent-a', kind: 'agent', actor: 'claude' }, 'claude');
  assert.equal(s.live, true);
  assert.equal(store.sessions().items.length, 1);

  const hb = store.sessionHeartbeat('agent-a');
  assert.equal(hb.session.live, true);
  assert.equal(hb.renewed.length, 0);

  // an ended session cannot heartbeat or claim
  const ended = store.sessionEnd('agent-a', 'claude');
  assert.equal(ended.session.live, false);
  expectError(() => store.sessionHeartbeat('agent-a'), 409, 'session-ended', 'heartbeat after end');

  // a silent session expires and its claims are released
  const t = ticket(store, 'expiring');
  store.claim(t.id, { session: 'agent-b' }, 'claude');
  const pruned = store.pruneCoordination(Date.now() + 100_000);
  assert(pruned.ended.includes('agent-b'));
  assert.equal(store.claimOf(t.id), null);
  assert.equal(store.sessions().items.find((x) => x.id === 'agent-b')?.live, false);
  finish(store);
}

function claims() {
  const { store } = fresh('coord-claims');
  const t1 = ticket(store, 'one');
  const t2 = ticket(store, 'two');

  const c = store.claim(t1.id, { session: 'agent-a' }, 'claude');
  assert.equal(c.session, 'agent-a');
  assert.equal(c.live, true);
  assert.equal(store.claimOf(t1.id)?.ident, c.ident);

  expectError(() => store.claim(t1.id, { session: 'agent-b' }, 'codex'), 409, 'claimed', 'second claim');
  expectError(() => store.claim(t2.id, { session: 'agent-a' }, 'claude'), 409, 'one-claim', 'one claim per worker');

  // the holder renews; release and re-claim
  const renewed = store.claim(t1.id, { session: 'agent-a', ttl: 300 }, 'claude');
  assert(renewed.expiresAt > c.expiresAt);
  store.releaseClaim(t1.id, { session: 'agent-a' }, 'claude');
  assert.equal(store.claimOf(t1.id), null);
  const c2 = store.claim(t1.id, { session: 'agent-b' }, 'codex');
  assert.equal(c2.session, 'agent-b');

  // release permission: a third party may not release someone else's claim
  expectError(() => store.releaseClaim(t1.id, { session: 'agent-c' }, 'gemini'), 403, undefined, 'release by stranger');
  store.releaseClaim(t1.id, { session: 'agent-b' }, 'codex');

  // finished work cannot be claimed
  const done = ticket(store, 'done', { status: 'done' });
  expectError(() => store.claim(done.id, { session: 'agent-a' }, 'claude'), 409, 'finished', 'claim done');

  // an assignee is durable ownership
  const assigned = ticket(store, 'assigned', { assignee: 'alice' });
  expectError(() => store.claim(assigned.id, { session: 'agent-a' }, 'claude'), 409, 'assigned', 'claim assigned');

  // start refuses blocked work and moves unblocked work to doing
  const blocker = ticket(store, 'blocker');
  const waiting = ticket(store, 'waiting', { blockedBy: [blocker.id] });
  expectError(() => store.claim(waiting.id, { session: 'agent-c', start: true }, 'gemini'), 409, 'blocked', 'start blocked');
  const ready = ticket(store, 'ready');
  store.claim(ready.id, { session: 'agent-c', start: true }, 'gemini');
  assert.equal(store.get(ready.id).status, 'doing');

  // takeover never steals a live lease
  expectError(() => store.claim(ready.id, { session: 'agent-d', takeover: true }, 'cursor'), 409, 'claimed', 'takeover live');

  finish(store);
}

function releaseHooks() {
  const { store } = fresh('coord-release');
  const a = ticket(store, 'done-hook');
  store.claim(a.id, { session: 'agent-a' }, 'claude');
  store.update(a.id, { status: 'done' }, 'claude');
  assert.equal(store.claimOf(a.id), null, 'claim released on done');

  const b = ticket(store, 'trash-hook');
  store.claim(b.id, { session: 'agent-a' }, 'claude');
  store.remove(b.id, 'claude');
  assert.equal(store.claimOf(b.id), null, 'claim released on trash');

  const c = ticket(store, 'assign-hook');
  store.claim(c.id, { session: 'agent-a' }, 'claude');
  store.update(c.id, { assignee: 'bob' }, 'claude');
  assert.equal(store.claimOf(c.id), null, 'claim released on assignee change');

  const d = ticket(store, 'finish-hook');
  store.claim(d.id, { session: 'agent-a' }, 'claude');
  store.finish({ ids: [d.id] }, 'claude');
  assert.equal(store.claimOf(d.id), null, 'claim released on finish');

  finish(store);
}

function ownershipBoard() {
  const { store } = fresh('coord-ownership');
  const eng = store.create({ type: 'project', title: 'Eng', key: 'ENG' }, ACTOR);
  const hud = store.create({ type: 'project', title: 'Hud', key: 'HUD' }, ACTOR);
  const alpha = ticket(store, 'alpha', { project: eng.id, assignee: 'alice' });
  const child = ticket(store, 'alpha child', { project: eng.id, parent: alpha.id, assignee: 'bob' });
  const beta = ticket(store, 'beta', { project: eng.id });
  store.claim(beta.id, { session: 'agent-a' }, 'claude');
  const gamma = ticket(store, 'gamma', { project: hud.id, assignee: 'alice' });
  const abroad = ticket(store, 'abroad', { project: hud.id, parent: alpha.id, status: 'done' });
  const loose = ticket(store, 'loose');
  store.sessionStart({ id: 'blank-agent', actor: '   ' }, '   ');
  const ghost = ticket(store, 'ghost');
  store.claim(ghost.id, { session: 'blank-agent' }, '   ');
  const spaced = ticket(store, 'spaced', { assignee: '   ' });
  store.create({ type: 'monitor', title: 'cpu' }, ACTOR);

  assert.deepEqual(store.ownership(alpha), { assignee: 'alice', claimer: null, claimSession: null, owner: 'alice' });
  assert.deepEqual(store.ownership(beta), { assignee: null, claimer: 'claude', claimSession: 'agent-a', owner: 'claude' });
  const leases = store.claimsList({ board: 'main' });
  assert.equal(typeof leases.now, 'number');
  assert.deepEqual(leases.items.map((c) => c.ticket).sort(), [beta.id, ghost.id].sort(), 'omit session: every lease on the board');
  for (let i = 1; i < leases.items.length; i++) assert.ok(leases.items[i - 1].expiresAt <= leases.items[i].expiresAt, 'claims sort by expiry');
  assert.deepEqual(store.claimsList({ board: 'main', session: 'agent-a' }).items.map((c) => c.ticket), [beta.id]);
  assert.deepEqual(store.claimsList({ board: 'main', session: 'blank-agent' }).items.map((c) => c.ticket), [ghost.id]);
  assert.deepEqual(store.claimsList({ session: 'nobody' }).items, []);

  const ids = (q: Record<string, unknown>) => store.search({ type: 'ticket', board: 'main', ...q }).map((t) => t.id).sort();
  assert.deepEqual(ids({ project: 'ENG' }), [alpha.id, child.id, beta.id].sort());
  assert.deepEqual(ids({ project: 'eng', owner: 'alice' }), [alpha.id]);
  assert.deepEqual(ids({ owner: 'ALICE' }), [alpha.id, gamma.id].sort());
  assert.deepEqual(ids({ owner: 'claude' }), [beta.id]);
  assert.deepEqual(ids({ owner: 'bob' }), [child.id]);
  const unownedIds = [loose.id, ghost.id, spaced.id, abroad.id].sort();
  assert.deepEqual(ids({ owner: 'none' }), unownedIds);
  assert.deepEqual(ids({ owner: '-' }), unownedIds);
  assert.equal(store.search({ board: 'main', owner: 'alice' }).every((it) => it.type === 'ticket'), true);
  assert.equal(store.search({ board: 'main', type: 'monitor', owner: 'alice' }).length, 0);

  const claimed = store.queue('main', { project: 'ENG', owner: 'claude' });
  assert.deepEqual(claimed.items.map((r) => r.id), [beta.id]);
  assert.equal(claimed.items[0]?.owner, 'claude');
  const unowned = store.queue('main', { owner: 'none', includeDone: true });
  assert.deepEqual(unowned.items.map((r) => r.id).sort(), [loose.id, ghost.id, spaced.id, abroad.id].sort());
  assert.equal(store.queue('main', { includeDone: true }).items.find((r) => r.id === ghost.id)?.owner, null);
  assert.equal(store.ownership(ghost).owner, null);
  assert.equal(store.ownership(spaced).owner, null);
  assert.deepEqual(store.queue('main', { owner: 'alice', includeDone: true }).items.map((r) => r.id).sort(), [alpha.id, gamma.id].sort());

  const text = ticketsView(store, 'main');
  const lines = text.split('\n');
  const alphaLine = lines.find((l) => l.includes('alpha') && !l.includes('alpha child'));
  const childLine = lines.find((l) => l.includes('alpha child'));
  const betaLine = lines.find((l) => l.includes('beta'));
  assert.ok(alphaLine && childLine && betaLine, text);
  assert.match(alphaLine!, /→alice ⊕—/);
  assert.match(alphaLine!, /\[0\/1 sub\]/);
  assert.match(childLine!, /→bob ⊕—/);
  assert.match(betaLine!, /→— ⊕claude/);
  assert.ok(childLine!.search(/\S/) > alphaLine!.search(/\S/), 'child sits deeper in the tree than its parent');
  const filtered = ticketsView(store, 'main', { project: 'HUD', owner: 'alice' });
  assert.match(filtered, /gamma/);
  assert.match(filtered, /→alice ⊕—/);
  assert.doesNotMatch(filtered, /alpha|beta/);
  const engText = ticketsView(store, 'main', { project: 'ENG' });
  const engAlpha = engText.split('\n').find((l) => l.includes('alpha') && !l.includes('alpha child'));
  assert.ok(engAlpha, engText);
  assert.match(engAlpha!, /\[0\/1 sub\]/);
  assert.doesNotMatch(engText, /abroad|\[1\/2 sub\]/);
  assert.ok(engText.includes('alpha child'));
  finish(store);
}

function queues() {
  const { store } = fresh('coord-queue');
  const a = ticket(store, 'urgent work', { priority: 'urgent' });
  const b = ticket(store, 'blocked work', { blockedBy: [a.id] });
  const c = ticket(store, 'claimed work');
  ticket(store, 'finished work', { status: 'done' });
  store.sessionStart({ id: 'agent-a', name: 'Alice', kind: 'agent' }, 'claude');
  store.claim(c.id, { session: 'agent-a' }, 'claude');

  const q = store.queue('main');
  assert.equal(q.counts.open, 2, `open: ${JSON.stringify(q.counts)}`);
  assert.equal(q.counts.claimed, 1);
  assert.equal(q.counts.done, 0);
  assert.equal(q.counts.blocked, 1);
  assert.equal(q.counts.ready, 1);
  assert.equal(q.items[0].id, a.id, 'ready urgent work sorts first');
  assert.equal(q.items.find((r) => r.id === b.id)?.ready, false);
  assert.equal(q.items.find((r) => r.id === c.id)?.owner, 'claude');
  assert.equal(q.items.find((r) => r.id === c.id)?.session?.live, true);
  assert.equal(q.items.find((r) => r.id === c.id)?.session?.name, 'Alice', 'queue names the holding session');

  const all = store.queue('main', { includeDone: true });
  assert.equal(all.counts.done, 1);

  const filtered = store.queue('main', { status: 'blocked' });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].id, b.id);

  finish(store);
}

function exportImport() {
  const { store } = fresh('coord-import');
  const t = ticket(store, 'exported');
  store.claim(t.id, { session: 'agent-a' }, 'claude');
  store.sessionStart({ id: 'agent-a', kind: 'agent' }, 'claude');
  const exported = store.exportState();
  assert.equal((exported as any).sessions, undefined, 'sessions are not exported');
  assert.equal((exported as any).claims, undefined, 'claims are not exported');
  assert(Array.isArray(exported.context));

  const other = fresh('coord-import-target').store;
  other.importState(JSON.parse(JSON.stringify(exported)), 'replace', 'claude');
  assert.equal(other.claimOf(t.id), null, 'imported state has no claims');
  assert.equal(other.get(t.id).title, 'exported');
  finish(store);
  finish(other);
}

function contexts() {
  const { store } = fresh('coord-context');
  const project = store.create({ type: 'project', title: 'Eng', key: 'ENG' }, ACTOR);
  const run = ticket(store, 'run', { tags: ['run'] });
  const other = ticket(store, 'other');

  const a = store.contextPublish({ scope: 'board:main', kind: 'STATUS', text: 'board note' }, 'claude');
  const b = store.contextPublish({ scope: `run:${run.id}`, kind: 'FACT', text: 'the parser drops trailing commas', refs: [other.id], session: 'agent-a' }, 'claude');
  assert.equal(b.seq, a.seq + 1);
  assert.equal(b.scopeType, 'run');
  assert.equal(b.board, 'main');

  // delta reads and cursors
  const first = store.contextRead({ scope: `run:${run.id}` }, { session: 'agent-a', mark: true });
  assert.deepEqual(first.entries.map(e => e.id), [b.id]);
  const again = store.contextRead({ scope: `run:${run.id}` }, { session: 'agent-a', mark: true });
  assert.equal(again.entries.length, 0, 'cursor advanced');
  const c = store.contextPublish({ scope: `run:${run.id}`, kind: 'FAIL', text: 'the printer theory was wrong', corrects: b.id, session: 'agent-b' }, 'codex');
  const delta = store.contextRead({ scope: `run:${run.id}` }, { session: 'agent-a', mark: true });
  assert.deepEqual(delta.entries.map(e => e.id), [c.id]);
  assert.equal(delta.entries[0].corrects, b.id);
  assert.equal(delta.complete, true);

  // kind filter and project scope
  const scoped = store.contextRead({ scope: `project:${project.id}`, kinds: ['FACT'] });
  assert.equal(scoped.entries.length, 0);
  store.contextPublish({ scope: `project:${project.id}`, kind: 'SUMMARY', text: 'halfway' }, 'claude');
  assert.equal(store.contextRead({ scope: `project:${project.id}` }).entries.length, 1);
  assert.equal(store.contextRead({ scope: `project:${project.id}`, kinds: ['FACT'] }).entries.length, 0);
  assert.equal(store.contextRead({ scope: `project:${project.id}`, kinds: ['SUMMARY'] }).entries.length, 1);

  // validation
  expectError(() => store.contextPublish({ scope: 'run:missing', kind: 'FACT', text: 'x' }, 'claude'), 404, undefined, 'missing run scope');
  expectError(() => store.contextPublish({ scope: `run:${other.id}`, kind: 'FACT', text: 'x' }, 'claude'), 400, undefined, 'un-tagged run scope');
  expectError(() => store.contextPublish({ scope: 'board:main', kind: 'NOPE' as any, text: 'x' }, 'claude'), 400, undefined, 'bad kind');
  expectError(() => store.contextPublish({ scope: 'board:main', kind: 'FACT', text: '' }, 'claude'), 400, undefined, 'empty text');
  expectError(() => store.contextPublish({ scope: 'board:main', kind: 'FACT', text: 'x', refs: ['nope'] }, 'claude'), 404, undefined, 'missing ref');
  expectError(() => store.contextPublish({ scope: 'board:main', kind: 'FACT', text: 'x', corrects: 'nope' }, 'claude'), 404, undefined, 'missing correction');

  // scopes aggregate
  const scopes = store.contextScopes('main');
  assert(scopes.some(s => s.scope === `run:${run.id}` && s.count === 2));
  assert(scopes.some(s => s.scope === `project:${project.id}` && s.count === 1));

  // export carries context; a fresh store can read it
  const copy = JSON.parse(JSON.stringify(store.exportState()));
  const target = fresh('coord-context-target').store;
  target.importState(copy, 'replace', 'claude');
  assert.equal(target.contextRead({ scope: `run:${run.id}` }).entries.length, 2);
  finish(store);
  finish(target);
}

function attachments() {
  const { store, dir } = fresh('coord-attach');
  setAttachmentsRoot(join(dir, 'attachments'));

  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('notes.md'), 'notes.md');
  assert.throws(() => sanitizeName('///'), HudError);

  const id = 'att-1';
  const bytes = Buffer.from('alpha\nbeta\ngamma\n');
  const w = writeAttachmentBytes('main', id, 'notes.txt', bytes);
  const rec = store.attachmentAdd({ id, board: 'main', name: 'notes.txt', kind: 'text', scope: 'board:main', bytes: w.bytes, sha256: w.sha256 }, 'claude');
  assert.equal(readAttachmentBytes(rec).toString(), bytes.toString());
  assert(attachmentPath(rec).includes(dir), 'attachment lives under the data dir');

  const id2 = 'att-2';
  const bytes2 = Buffer.from('alpha\nBETA\ngamma\n');
  const w2 = writeAttachmentBytes('main', id2, 'notes.txt', bytes2);
  const rec2 = store.attachmentAdd({ id: id2, board: 'main', name: 'notes.txt', kind: 'text', scope: 'board:main', bytes: w2.bytes, sha256: w2.sha256, baseId: id, baseSha256: w.sha256 }, 'claude');
  assert.equal(store.attachments({ board: 'main' }).length, 2);
  assert.equal(rec2.baseId, id);

  const d = unifiedDiff(readAttachmentBytes(rec).toString(), readAttachmentBytes(rec2).toString());
  assert(d.text.includes('-beta'), 'diff marks the removed line');
  assert(d.text.includes('+BETA'), 'diff marks the added line');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);

  // a referenced attachment cannot be removed without force
  store.contextPublish({ scope: 'board:main', kind: 'FACT', text: 'see notes', attachments: [id] }, 'claude');
  expectError(() => store.attachmentRemove(id, 'claude'), 409, 'referenced', 'remove referenced');
  store.attachmentRemove(id, 'claude', { force: true });
  assert.equal(store.attachments({ board: 'main' }).length, 1);

  // validation
  expectError(() => store.attachmentAdd({ board: 'main', name: '../x', bytes: 1, sha256: 'a'.repeat(64) }, 'claude'), 400, undefined, 'bad name');
  expectError(() => store.attachmentAdd({ board: 'main', name: 'x', bytes: 0, sha256: 'a'.repeat(64) }, 'claude'), 413, undefined, 'empty bytes');
  expectError(() => store.attachmentAdd({ board: 'main', name: 'x', bytes: 1, sha256: 'nope' }, 'claude'), 400, undefined, 'bad hash');

  // metadata survives export; bytes stay out of state
  const exported = store.exportState();
  assert.equal(Object.keys(exported.attachments).length, 1);
  assert(!JSON.stringify(exported).includes(bytes2.toString()), 'attachment bytes are not in state');
  finish(store);
}

async function contextPagesKeepNewest() {
  const { store } = fresh('coord-context-pages');
  const run = ticket(store, 'busy', { tags: ['run'] });
  const scope = `run:${run.id}`;
  let earlyId = '';
  for (let i = 0; i < 205; i++) {
    const entry = store.contextPublish({ scope, kind: 'STATUS', text: `note ${i}` }, 'claude');
    if (i === 0) earlyId = entry.id;
  }
  const summary = store.contextPublish({ scope, kind: 'SUMMARY', text: 'latest handoff still stands' }, 'claude');
  const correction = store.contextPublish({ scope, kind: 'FAIL', text: 'the first note was wrong', corrects: earlyId }, 'claude');
  const limited = store.contextRead({ scope, limit: 200 });
  assert.equal(limited.complete, false);
  assert.equal(limited.truncated, false);
  assert.equal(limited.entries.some(entry => entry.id === summary.id), false, 'oldest-first limit drops the newest summary');
  assert.equal(limited.entries.some(entry => entry.id === correction.id), false, 'oldest-first limit drops the correcting entry');

  const loaded = await loadContextPages((since) => store.contextRead({ scope, since, limit: 200 }));
  assert.equal(loaded.complete, true, 'paging reaches the retained tail');
  assert.equal(loaded.newerMissing, false);
  assert.equal(loaded.entries.at(-1)?.id, correction.id);
  const handoff = contextHandoff(loaded.entries, { scope, title: 'busy', complete: true, formatTime: () => 't' });
  assert.match(String(handoff), /latest handoff still stands/);
  assert.match(String(handoff), /the first note was wrong/);

  const partial = await loadContextPages((since) => store.contextRead({ scope, since, limit: 200 }), { maxPages: 1 });
  assert.equal(partial.newerMissing, true);
  assert.equal(contextHandoff(partial.entries, { scope, title: 'busy', complete: false }), null);
  finish(store);
}

function runContextExport() {
  const { store, dir } = fresh('coord-export');
  setAttachmentsRoot(join(dir, 'attachments'));
  const run = ticket(store, 'export me', { tags: ['run'], status: 'doing' });
  const other = ticket(store, 'other run', { tags: ['run'] });
  const project = store.create({ type: 'project', title: 'Eng', key: 'ENG' }, ACTOR);
  const plain = ticket(store, 'plain');

  const notes = Buffer.from('alpha notes for the run\n');
  const notesId = 'att-export-1';
  const notesWritten = writeAttachmentBytes('main', notesId, 'notes.txt', notes);
  store.attachmentAdd({ id: notesId, board: 'main', name: 'notes.txt', kind: 'text', scope: `run:${run.id}`, bytes: notesWritten.bytes, sha256: notesWritten.sha256 }, 'claude');

  const ref = Buffer.from('referenced from the fact\n');
  const refId = 'att-ref';
  const refWritten = writeAttachmentBytes('main', refId, 'ref.txt', ref);
  store.attachmentAdd({ id: refId, board: 'main', name: 'ref.txt', kind: 'text', scope: 'board:main', bytes: refWritten.bytes, sha256: refWritten.sha256 }, 'claude');

  const stray = Buffer.from('stray-not-in-run\n');
  const strayId = 'att-stray';
  const strayWritten = writeAttachmentBytes('main', strayId, 'stray.txt', stray);
  store.attachmentAdd({ id: strayId, board: 'main', name: 'stray.txt', kind: 'text', scope: 'board:main', bytes: strayWritten.bytes, sha256: strayWritten.sha256 }, 'claude');

  store.contextPublish({
    scope: `run:${run.id}`, kind: 'FACT', text: 'the parser drops trailing commas',
    attachments: [notesId, refId], data: { sample: 1 }, session: 'agent-a',
  }, 'claude');
  store.contextPublish({ scope: `run:${other.id}`, kind: 'FACT', text: 'other-run-secret' }, 'claude');
  store.contextPublish({ scope: `project:${project.id}`, kind: 'SUMMARY', text: 'project-secret' }, 'claude');

  expectError(() => store.exportRunContext(run.id, 'claude'), 409, 'unfinished', 'export unfinished run');
  expectError(() => store.exportRunContext(plain.id, 'claude'), 400, undefined, 'export non-run');
  assert.equal(store.listRunExports().length, 0, 'a refused export writes nothing');

  const skipped = store.finish({ ids: [other.id], organize: false }, 'claude');
  assert.equal(skipped.exports, undefined, 'finish without export does not snapshot');
  assert.equal(store.listRunExports().length, 0);

  const done = store.finish({ ids: [run.id], export: true, organize: false }, 'claude');
  assert.deepEqual(done.done, [run.id]);
  assert.equal(done.exports?.length, 1);
  const exp = done.exports![0]!;
  assert.equal(exp.runId, run.id);
  assert.equal(exp.entries, 1);
  assert.equal(exp.attachments, 2);
  assert.deepEqual(exp.missing, []);
  assert.match(exp.name, new RegExp(`^context-${run.id}-\\d{8}-\\d{6}\\.zip$`));
  const zip = readFileSync(join(store.backupDir, exp.name));
  const entries = listZipEntries(zip);
  const md = entries.find((e) => e.name === 'context.md')?.data.toString('utf8') ?? '';
  assert(md.includes('the parser drops trailing commas'), 'markdown keeps the run fact');
  assert(md.includes('"sample": 1'), 'markdown keeps structured data');
  assert(!md.includes('other-run-secret'), 'markdown stays inside the run');
  assert(!md.includes('project-secret'), 'markdown stays inside the run');
  assert.equal(entries.find((e) => e.name === `attachments/${notesId}/notes.txt`)?.data.toString(), notes.toString());
  assert.equal(entries.find((e) => e.name === `attachments/${refId}/ref.txt`)?.data.toString(), ref.toString());
  assert(!entries.some((e) => e.name.includes(strayId)), 'unreferenced board files stay out');
  assert(entries.every((e) => !e.name.split('/').includes('..') && !e.name.startsWith('/')), 'zip entries stay relative');
  assert(store.get(run.id).comments?.some((c) => c.text.includes(exp.name)), 'the ticket records the export name');
  assert.equal(store.contextRead({ scope: `run:${run.id}` }).entries.length, 1, 'export keeps the live log');
  assert.equal(store.readRunExport(run.id, exp.name).equals(zip), true);

  const again = store.exportRunContext(store.identOf(run.id), 'claude');
  assert.notEqual(again.name, exp.name, 'a second snapshot gets its own file');
  assert.equal(store.listRunExports(run.id).length, 2);
  assert.equal(store.listRunExports(other.id).length, 0);

  const ghost = '../sneak';
  store.attachmentAdd({ id: ghost, board: 'main', name: 'gone.txt', kind: 'file', scope: `run:${run.id}`, bytes: 4, sha256: 'ab'.repeat(32) }, 'claude');
  const partial = store.exportRunContext(run.id, 'claude');
  assert(partial.missing.includes(ghost), 'missing attachment bytes are reported');
  const partialEntries = listZipEntries(readFileSync(join(store.backupDir, partial.name)));
  assert(partialEntries.some((e) => e.name === 'context.md' && e.data.toString('utf8').includes(ghost)));
  assert(partialEntries.every((e) => !e.name.split('/').includes('..') && !e.name.startsWith('/')));

  const staleId = 'att-stale';
  const staleWritten = writeAttachmentBytes('main', staleId, 'stale.txt', Buffer.from('original\n'));
  store.attachmentAdd({ id: staleId, board: 'main', name: 'stale.txt', kind: 'text', scope: `run:${run.id}`, bytes: staleWritten.bytes, sha256: staleWritten.sha256 }, 'claude');
  const changed = Buffer.from('changed bytes\n');
  writeAttachmentBytes('main', staleId, 'stale.txt', changed);
  const stale = store.exportRunContext(run.id, 'claude');
  assert(!stale.missing.includes(staleId), 'a readable file is packed even when its stored hash is stale');
  const changedHash = hashBytes(changed);
  const staleZip = listZipEntries(readFileSync(join(store.backupDir, stale.name)));
  const staleFile = staleZip.find((e) => e.name === `attachments/${staleId}/stale.txt`);
  assert.equal(staleFile?.data.toString(), changed.toString(), 'the bytes on disk are what the zip keeps');
  const staleMd = staleZip.find((e) => e.name === 'context.md')?.data.toString('utf8') ?? '';
  assert(staleMd.includes(`| ${staleId} | stale.txt | ${changed.length} | ${changedHash} |`), 'markdown sha256 and size match the packed bytes');
  assert(staleMd.includes(staleWritten.sha256), 'the note still names the stored hash');

  assert.equal(zipSegment('a/b'), zipSegment('a_b'));
  assert.throws(() => buildZip([
    { name: 'attachments/a_b/same.txt', data: Buffer.from('one') },
    { name: 'attachments/a_b/same.txt', data: Buffer.from('two') },
  ]), /duplicate zip entry/);
  const collideA = 'a/b';
  const collideB = 'a_b';
  const payloadA = Buffer.from('payload-a\n');
  const payloadB = Buffer.from('payload-b\n');
  const writtenA = writeAttachmentBytes('main', collideA, 'same.txt', payloadA);
  const writtenB = writeAttachmentBytes('main', collideB, 'same.txt', payloadB);
  store.attachmentAdd({ id: collideA, board: 'main', name: 'same.txt', kind: 'text', scope: `run:${run.id}`, bytes: writtenA.bytes, sha256: writtenA.sha256 }, 'claude');
  store.attachmentAdd({ id: collideB, board: 'main', name: 'same.txt', kind: 'text', scope: `run:${run.id}`, bytes: writtenB.bytes, sha256: writtenB.sha256 }, 'claude');
  const collided = store.exportRunContext(run.id, 'claude');
  const collidedEntries = listZipEntries(readFileSync(join(store.backupDir, collided.name)));
  assert.equal(new Set(collidedEntries.map((e) => e.name)).size, collidedEntries.length, 'zip entry names are unique');
  assert(collidedEntries.some((e) => e.data.equals(payloadA)), 'first colliding attachment is packed');
  assert(collidedEntries.some((e) => e.data.equals(payloadB)), 'second colliding attachment is packed');
  const collidePaths = collidedEntries.filter((e) => e.data.equals(payloadA) || e.data.equals(payloadB)).map((e) => e.name);
  assert.equal(new Set(collidePaths).size, 2, 'sanitized id collisions get distinct paths');

  const canceled = ticket(store, 'canceled run', { tags: ['run'], status: 'canceled' });
  const canceledExport = store.exportRunContext(canceled.id, 'claude');
  assert.equal(canceledExport.entries, 0);
  assert(listZipEntries(readFileSync(join(store.backupDir, canceledExport.name))).some((e) => e.name === 'context.md' && e.data.toString('utf8').includes('canceled')));

  for (let i = 0; i < 35; i++) store.backup('rotation');
  assert.equal(store.listBackups().length, 30, 'state backups still rotate');
  assert.equal(existsSync(join(store.backupDir, exp.name)), true, 'context exports survive state-backup rotation');
  assert(store.listRunExports(run.id).length >= 2);

  expectError(() => store.readRunExport(run.id, '../state.json'), 400, undefined, 'export path escape');
  expectError(() => store.readRunExport(run.id, exp.name.replace(run.id, other.id)), 404, undefined, 'other run export');

  const retry = ticket(store, 'retry export', { tags: ['run'], status: 'doing' });
  const current = ticket(store, 'current export', { tags: ['run'], status: 'doing' });
  const finishedFirst = store.finish({ ids: [retry.id], organize: false }, ACTOR);
  assert.deepEqual(finishedFirst.done, [retry.id]);
  assert.equal(finishedFirst.exports, undefined);
  assert.equal(store.listRunExports(retry.id).length, 0, 'finish without export writes no snapshot');
  const foreign = store.create({ type: 'ticket', title: 'foreign run', tags: ['run'], status: 'done' }, 'other-agent');
  const canceledStatus = store.get(canceled.id).status;
  const bare = store.finish({ export: true, organize: false }, ACTOR);
  assert(bare.done.includes(current.id), 'a bare finish completes the open run');
  assert.equal(bare.exports?.filter((e) => e.runId === current.id).length, 1, 'a bare export snapshots only the run this call finishes');
  assert(!bare.exports?.some((e) => e.runId === retry.id), 'a bare export does not re-zip an already-done run');
  assert(!bare.exports?.some((e) => e.runId === canceled.id), 'a bare export does not re-zip a canceled run');
  assert(!bare.exports?.some((e) => e.runId === foreign.id), 'another actor\'s finished run is left alone');
  const later = store.finish({ export: true, organize: false }, ACTOR);
  assert(!later.exports?.some((e) => e.runId === current.id), 'a later bare export does not re-zip that run');
  assert.equal(store.listRunExports(current.id).length, 1);
  const named = store.finish({ ids: [retry.id], export: true, organize: false }, ACTOR);
  assert.equal(named.done.includes(retry.id), false, 'naming an already-done run does not finish it again');
  assert.equal(named.exports?.filter((e) => e.runId === retry.id).length, 1, 'an explicit id re-snapshots that finished run');
  assert(!named.exports?.some((e) => e.runId === canceled.id), 'an explicit id does not pull in other finished runs');
  const all = store.finish({ export: true, exportAll: true, organize: false }, ACTOR);
  assert(all.exports?.some((e) => e.runId === canceled.id), '--all snapshots an owned canceled run');
  assert(all.exports?.some((e) => e.runId === retry.id), '--all snapshots an owned done run');
  assert(!all.exports?.some((e) => e.runId === foreign.id), '--all leaves another actor\'s run alone');
  assert.equal(store.get(canceled.id).status, canceledStatus, '--all does not mark a canceled run done');
  assert.equal(store.listRunExports(foreign.id).length, 0);
  expectError(() => store.finish({ exportAll: true, organize: false }, ACTOR), 400, undefined, 'exportAll requires export');

  store.flush();
  const raw = readFileSync(join(dir, 'state.json'), 'utf8');
  assert(!raw.includes(notes.toString()), 'attachment bytes stay out of state');
  assert(!raw.includes(changed.toString()), 'exported bytes stay out of state');

  finish(store);
}

function runContextExportComplete() {
  const { store } = fresh('coord-export-complete');
  const run = ticket(store, 'long run', { tags: ['run'], status: 'done' });
  const n = 1001;
  for (let i = 0; i < n; i++) store.contextPublish({ scope: `run:${run.id}`, kind: 'FACT', text: `entry-${i}-marker` }, ACTOR);
  const page = store.contextRead({ scope: `run:${run.id}`, limit: 1000 });
  assert.equal(page.entries.length, 1000, 'a context read page stops at its limit');
  assert.equal(page.complete, false, 'one page is not the whole run');
  assert(!page.entries.some((e) => e.text === `entry-${n - 1}-marker`), 'the newest entry is past the page');
  const exp = store.exportRunContext(run.id, ACTOR);
  assert.equal(exp.entries, n, 'export counts every retained entry');
  const md = zipEntry(readFileSync(join(store.backupDir, exp.name)), 'context.md').toString('utf8');
  assert(md.includes('entry-0-marker'), 'export keeps the oldest retained entry');
  assert(md.includes(`entry-${n - 1}-marker`), 'export keeps the newest entry');
  assert.equal(md.match(/^### /gm)?.length, n, 'export renders every retained entry');
  finish(store);
}

function forests() {
  const { store } = fresh('coord-forest');
  const project = store.create({ type: 'project', title: 'Forest', key: 'FOR' }, ACTOR);
  const parent = store.create({ type: 'ticket', title: 'Parent', project: project.id }, ACTOR);
  const child = store.create({ type: 'ticket', title: 'Child', project: project.id }, ACTOR);
  store.link(child.id, { parent: parent.id }, ACTOR);
  const forest = store.ticketForest('main', 'FOR');
  assert.equal(forest.project, project.id);
  assert.equal(forest.nodes.length, 1);
  assert.equal(forest.nodes[0].id, parent.id);
  assert.equal(forest.nodes[0].children[0].id, child.id);
  store.update(project.id, { key: 'TRE' }, ACTOR);
  assert.equal(store.ident(store.get(parent.id)), 'TRE-1');
  assert.equal(store.ident(store.get(child.id)), 'TRE-2');
  store.link(child.id, { parent: '' }, ACTOR);
  const flat = store.ticketForest('main', project.id);
  assert.deepEqual(flat.nodes.map((n) => n.id), [parent.id, child.id]);
  assert.equal(flat.nodes.every((n) => n.children.length === 0), true);

  store.sessionStart({ id: 'agent-a', kind: 'agent' }, ACTOR);
  const claim = store.claim(parent.id, { session: 'agent-a', ttl: 30 }, ACTOR);
  assert.equal(claim.live, true);
  assert.equal(claim.sessionLive, true);
  const listed = store.claimsList({ session: 'agent-a', board: 'main' });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].ticket, parent.id);
  assert.equal(listed.items[0].live, true);
  assert.equal(listed.items[0].sessionLive, true);
  assert.ok(listed.items[0].expiresAt > listed.now);
  store.releaseClaim(parent.id, { session: 'agent-a', reason: 'done-here' }, ACTOR);
  assert.equal(store.claimsList({ board: 'main' }).items.length, 0);
  assert.equal(store.claimOf(parent.id), null);
  finish(store);
}

/** 0.4.0 lease, fencing, grace, queue and context-read semantics */
async function leaseFixes() {
  const { store, file } = fresh('lease');
  const priv = store as any;
  // A1: ttl is kept across re-claim and heartbeat
  store.sessionStart({ id: 'w1', actor: 'wa', kind: 'agent' }, 'wa');
  const t1 = ticket(store, 'one');
  store.claim(t1.id, { session: 'w1', ttl: 300 }, 'wa');
  assert.equal(priv.claims.get(t1.id).ttlMs, 300_000);
  store.claim(t1.id, { session: 'w1' }, 'wa');
  assert.equal(priv.claims.get(t1.id).ttlMs, 300_000, 're-claim without ttl keeps ttlMs');
  store.claim(t1.id, { session: 'w1', ttl: 60 }, 'wa');
  assert.equal(priv.claims.get(t1.id).ttlMs, 60_000, 're-claim with ttl updates ttlMs');
  const c = priv.claims.get(t1.id);
  const base = Date.now();
  c.expiresAt = base + 20_000;
  const hb = store.sessionHeartbeat('w1', base);
  assert.equal(hb.started, false);
  assert.equal(hb.renewed.length, 1);
  assert.equal(c.expiresAt, base + 60_000, 'heartbeat renews to ttlMs, not the default');
  c.expiresAt = base + 40_000;
  assert.equal(store.sessionHeartbeat('w1', base).renewed.length, 0, 'not renewed above half the ttl');

  // A2: touch, idle, presence
  store.sessionTouch('ghost');
  store.sessionTouch('!!bad id!!');
  assert.equal(priv.liveSessions.has('ghost'), false, 'touch never creates sessions');
  const s = priv.liveSessions.get('w1');
  s.lastActiveAt = 1;
  s.lastSeenAt = 1;
  store.sessionTouch('w1', 5000);
  assert.equal(s.lastActiveAt, 5000);
  assert.equal(s.lastSeenAt, 5000);
  const later = base + LEASE_IDLE_MS + 60_000;
  s.lastActiveAt = base;
  c.expiresAt = later + 1_000;
  const idleHb = store.sessionHeartbeat('w1', later);
  assert.equal(idleHb.renewed.length, 0, 'idle session does not renew');
  assert.equal(c.expiresAt, later + 1_000);
  s.lastSeenAt = Date.now();
  s.lastActiveAt = Date.now() - LEASE_IDLE_MS - 1000;
  const view = store.sessions().items.find((x) => x.id === 'w1')!;
  assert.equal(view.live, true);
  assert.equal(view.idle, true);
  assert.ok(typeof view.lastActiveAt === 'number');
  assert.equal(store.queue('main').items.find((r) => r.id === t1.id)!.session!.idle, true);
  s.lastActiveAt = Date.now();
  assert.equal(store.sessions().items.find((x) => x.id === 'w1')!.idle, false);
  // expires normally once idle
  c.expiresAt = Date.now() - 1;
  store.pruneCoordination();
  assert.equal(store.claimOf(t1.id), null);

  // A3: started flag
  const r1 = store.sessionHeartbeat('fresh-one');
  assert.equal(r1.started, true);
  assert.equal(store.sessionHeartbeat('fresh-one').started, false);

  // A4: fencing
  store.sessionStart({ id: 'h', actor: 'holder', kind: 'agent' }, 'holder');
  store.sessionStart({ id: 'o', actor: 'other', kind: 'agent' }, 'other');
  const f1 = ticket(store, 'fenced');
  const f2 = ticket(store, 'fenced two');
  store.claim(f1.id, { session: 'h' }, 'holder');
  expectError(() => store.update(f1.id, { status: 'review' }, 'other', { session: 'o' }), 409, 'claimed', 'update by non-holder');
  expectError(() => store.update(f1.id, { status: 'review' }, 'holder', { session: 'o' }), 409, 'claimed', 'same actor, other session');
  expectError(() => store.update(f1.id, { status: 'review' }, 'other'), 409, 'claimed', 'actor fallback');
  expectError(() => store.finish({ ids: [f2.id, f1.id], session: 'o' }, 'other'), 409, 'claimed', 'finish by non-holder');
  assert.equal(store.get(f2.id).status, 'todo', 'finish validates all before changing any');
  expectError(() => store.remove(f1.id, 'other', { session: 'o' }), 409, 'claimed', 'remove by non-holder');
  store.update(f1.id, { priority: 'high' }, 'other', { session: 'o' });
  store.update(f1.id, { status: 'todo' }, 'other', { session: 'o' });
  store.update(f1.id, { status: 'doing' }, 'holder', { session: 'h' });
  store.update(f1.id, { status: 'review' }, 'holder');
  store.update(f1.id, { status: 'doing' }, 'user');
  store.update(f1.id, { status: 'review' }, 'hud');
  // expired claim and dead holder do not fence
  priv.claims.get(f1.id).expiresAt = Date.now() - 1;
  store.update(f1.id, { status: 'doing' }, 'other', { session: 'o' });
  priv.claims.get(f1.id).expiresAt = Date.now() + 60_000;
  priv.liveSessions.get('h').lastSeenAt = 1;
  store.update(f1.id, { status: 'review' }, 'other', { session: 'o' });
  priv.liveSessions.get('h').lastSeenAt = Date.now();
  store.finish({ ids: [f1.id], session: 'h' }, 'holder');
  assert.equal(store.get(f1.id).status, 'done');
  // bare finish skips tickets a peer holds instead of refusing the whole call
  const b1 = store.create({ type: 'ticket', title: 'bare mine' }, 'other');
  const b2 = store.create({ type: 'ticket', title: 'bare peer-held' }, 'other');
  store.claim(b2.id, { session: 'h' }, 'holder');
  const bare = store.finish({ session: 'o' }, 'other');
  assert.ok(bare.done.includes(b1.id) && !bare.done.includes(b2.id), 'bare finish skips peer-held tickets');
  assert.notEqual(store.get(b2.id).status, 'done');
  expectError(() => store.finish({ ids: [b2.id], session: 'o' }, 'other'), 409, 'claimed', 'named finish is still refused');
  store.releaseClaim(b2.id, { session: 'h' }, 'holder');
  const f3 = ticket(store, 'start passes');
  store.claim(f3.id, { session: 'o', start: true }, 'other');
  assert.equal(store.get(f3.id).status, 'doing');
  store.remove(f3.id, 'user');

  // A6: openChildren, notes, leads
  store.sessionStart({ id: 'lead', actor: 'lead', kind: 'agent' }, 'lead');
  const parent = ticket(store, 'parent');
  const kid = ticket(store, 'kid', { parent: parent.id });
  let q = store.queue('main');
  const prow = q.items.find((r) => r.id === parent.id)!;
  assert.equal(prow.openChildren, 1);
  assert.equal(prow.ready, false);
  assert.equal(q.items.find((r) => r.id === kid.id)!.ready, true);
  store.claim(parent.id, { session: 'lead' }, 'lead');
  store.update(kid.id, { status: 'done' }, 'user');
  q = store.queue('main');
  assert.equal(q.items.find((r) => r.id === parent.id)!.openChildren, 0);
  store.releaseClaim(parent.id, { session: 'lead' }, 'lead');
  assert.equal(store.queue('main').items.find((r) => r.id === parent.id)!.ready, true, 'parent ready once children finish');
  const noted = ticket(store, 'noted');
  store.sessionStart({ id: 'n', actor: 'noter', kind: 'agent' }, 'noter');
  store.contextPublish({ scope: 'board:main', kind: 'STATUS', text: 'old status', refs: [noted.id] }, 'noter');
  store.claim(noted.id, { session: 'n' }, 'noter');
  priv.claims.get(noted.id).claimedAt = Date.now() + 5;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.queue('main').items.find((r) => r.id === noted.id)!.note, undefined, 'status before the claim is not a note');
  store.contextPublish({ scope: 'board:main', kind: 'STATUS', text: 'first\nattempt', refs: [noted.id] }, 'noter');
  store.contextPublish({ scope: 'board:main', kind: 'STATUS', text: 'x'.repeat(200), refs: [noted.id] }, 'noter');
  store.contextPublish({ scope: 'board:main', kind: 'STATUS', text: 'unrelated' }, 'noter');
  assert.equal(store.queue('main').items.find((r) => r.id === noted.id)!.note, 'x'.repeat(160));
  const run = ticket(store, 'run ticket', { tags: ['Run'] });
  const idle = ticket(store, 'idle run', { tags: ['run'] });
  assert.equal(store.queue('main').leads.length, 0, 'unclaimed run ticket is not a lead');
  store.claim(run.id, { session: 'lead' }, 'lead');
  q = store.queue('main', { owner: 'nobody' });
  assert.equal(q.leads.length, 1, 'leads ignore filters');
  assert.deepEqual(q.leads[0], { ticket: run.id, ident: store.ident(store.get(run.id)), title: 'run ticket', scope: `run:${run.id}`, session: 'lead', actor: 'lead' });
  priv.liveSessions.get('lead').endedAt = Date.now();
  assert.equal(store.queue('main').leads.length, 0, 'ended holder is not a lead');
  assert.ok(idle);

  // A7: ref and open
  const rb = ticket(store, 'ref target');
  const fail1 = store.contextPublish({ scope: 'board:main', kind: 'FAIL', text: 'bad A', refs: [rb.id] }, 'noter');
  const fail2 = store.contextPublish({ scope: 'board:main', kind: 'FAIL', text: 'bad B' }, 'noter');
  store.contextPublish({ scope: 'board:main', kind: 'FACT', text: 'fact', refs: [rb.id] }, 'noter');
  assert.deepEqual(store.contextRead({ scope: 'board:main', ref: rb.id, since: 0 }, { mark: false }).entries.map((e) => e.kind), ['FAIL', 'FACT']);
  let open = store.contextRead({ scope: 'board:main', open: true, kinds: ['FACT'] }, { session: 'rd' });
  assert.deepEqual(open.entries.map((e) => e.id), [fail1.id, fail2.id], 'open overrides kinds, oldest first');
  assert.equal(open.complete, true);
  store.contextRead({ scope: 'board:main' }, { session: 'rd' });
  const cur = store.contextRead({ scope: 'board:main', since: 0 }, { mark: false }).cursor;
  open = store.contextRead({ scope: 'board:main', open: true, since: cur }, { session: 'rd' });
  assert.equal(open.entries.length, 2, 'open ignores since');
  assert.equal(open.cursor, cur, 'open returns the unchanged cursor');
  assert.equal(store.contextRead({ scope: 'board:main' }, { session: 'rd' }).entries.length, 0, 'open did not move the cursor');
  assert.equal(store.contextRead({ scope: 'board:main', open: true, limit: 1 }, {}).complete, false);
  store.contextPublish({ scope: 'board:main', kind: 'FACT', text: 'fixed', corrects: fail1.id }, 'noter');
  open = store.contextRead({ scope: 'board:main', open: true }, {});
  assert.deepEqual(open.entries.map((e) => e.id), [fail2.id]);
  assert.equal(store.contextRead({ scope: 'board:main', open: true, ref: rb.id }, {}).entries.length, 0);

  // A5: restart grace
  const g = ticket(store, 'in progress', { status: 'doing' });
  const g2 = ticket(store, 'review one', { status: 'review' });
  store.flush();
  finish(store);
  const re = new Store(file);
  assert.ok((re.reclaimUntil ?? 0) > Date.now());
  let rq = re.queue('main');
  assert.ok(rq.reclaimUntil && rq.reclaimUntil > Date.now());
  assert.equal(rq.items.find((r) => r.id === g.id)!.ready, false);
  assert.equal(rq.items.find((r) => r.id === g2.id)!.ready, false);
  re.sessionStart({ id: 'rc', actor: 'rc', kind: 'agent' }, 'rc');
  re.claim(g.id, { session: 'rc' }, 'rc');
  re.releaseClaim(g.id, { session: 'rc' }, 'rc');
  assert.equal(re.queue('main').items.find((r) => r.id === g.id)!.ready, true, 'claiming leaves the grace set');
  assert.equal(re.queue('main').items.find((r) => r.id === g2.id)!.ready, false);
  re.reclaimUntil = 0;
  rq = re.queue('main');
  assert.equal(rq.items.find((r) => r.id === g2.id)!.ready, true);
  assert.equal(rq.reclaimUntil, undefined);
  finish(re);
  finish(store);
}


migration();
sessions();
claims();
releaseHooks();
ownershipBoard();
queues();
contexts();
attachments();
exportImport();
await contextPagesKeepNewest();
runContextExport();
runContextExportComplete();
forests();
await leaseFixes();
console.log('PASS coordination store checks');
