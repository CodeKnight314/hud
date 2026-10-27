import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HudError, STATE_VERSION, Store } from '../src/store.ts';
import { attachmentPath, readAttachmentBytes, sanitizeName, setAttachmentsRoot, writeAttachmentBytes } from '../src/attachments.ts';
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
  assert.equal(STATE_VERSION, 10);
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

function queues() {
  const { store } = fresh('coord-queue');
  const a = ticket(store, 'urgent work', { priority: 'urgent' });
  const b = ticket(store, 'blocked work', { blockedBy: [a.id] });
  const c = ticket(store, 'claimed work');
  ticket(store, 'finished work', { status: 'done' });
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

migration();
sessions();
claims();
releaseHooks();
queues();
contexts();
attachments();
exportImport();
await contextPagesKeepNewest();
console.log('PASS coordination store checks');
