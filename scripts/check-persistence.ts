// Save failures, backup recovery and restoring a named snapshot stay inside the data dir.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HudError, Store } from '../src/store.ts';
import { revealCommand, revealDirectory } from '../src/reveal.ts';

const dir = mkdtempSync(join(tmpdir(), 'hud-persistence-'));
const actor = 'persistence-check';

const blocker = join(dir, 'not-a-directory');
writeFileSync(blocker, 'blocked');
const broken = new Store(join(blocker, 'state.json'));
broken.create({ type: 'note', title: 'unsaved', text: 'only in memory' }, actor);
broken.flush();
const failed = broken.health();
assert.equal(typeof failed.saveError, 'string');
assert.match(failed.saveError ?? '', /\S/);
assert.equal(failed.recoveredFrom, undefined);
clearTimeout((broken as unknown as { saveTimer: ReturnType<typeof setTimeout> | null }).saveTimer);

const file = join(dir, 'state.json');
const live = new Store(file);
const kept = live.create({ type: 'note', title: 'kept', text: 'yes' }, actor);
live.flush();
const snapshot = live.backup('kept');
const later = live.create({ type: 'note', title: 'later', text: 'no' }, actor);
live.flush();
const newest = live.backup('later');
writeFileSync(file, '{');
const recovered = new Store(file);
assert.equal(recovered.health().recoveredFrom, newest);
assert.equal(recovered.get(kept.id).title, 'kept');
assert.equal(recovered.get(later.id).title, 'later');
assert.equal(recovered.health().saveError, undefined);

assert.throws(() => recovered.restoreBackup('../state.json', actor), (error: unknown) => error instanceof HudError && /snapshot/.test(error.message));
assert.throws(() => recovered.restoreBackup('state-missing.json', actor), (error: unknown) => error instanceof HudError && error.status === 404);
assert.throws(() => recovered.restoreBackup('state-../kept.json', actor), (error: unknown) => error instanceof HudError && error.status === 400);

const replaced = recovered.restoreBackup(snapshot, actor);
assert.equal(replaced.name, snapshot);
assert.match(replaced.backup, /^state-.*\.json$/);
assert.equal(recovered.get(kept.id).title, 'kept');
assert.throws(() => recovered.get(later.id), /no item/);
assert.equal(recovered.health().recoveredFrom, newest, 'a restore does not clear the boot-time recovery flag');
rmSync(join(recovered.backupDir, newest));
assert.equal(recovered.health().recoveredFrom, undefined, 'a pruned recovery snapshot is no longer reported');
assert.throws(() => recovered.restoreBackup(newest, actor), (error: unknown) => error instanceof HudError && error.status === 404 && error.message === `backup ${newest} is no longer on disk`);

const calls: string[][] = [];
assert.equal(revealCommand('darwin').command, 'open');
assert.deepEqual(revealCommand('darwin').args('/tmp/hud data'), ['/tmp/hud data']);
assert.equal(revealCommand('win32').command, 'explorer');
assert.deepEqual(revealCommand('win32').args('C:\\hud data'), ['C:\\hud data']);
assert.equal(revealCommand('linux').command, 'xdg-open');
revealDirectory('/tmp/hud data', (command, args) => { calls.push([command, ...args]); });
assert.deepEqual(calls, [[revealCommand().command, '/tmp/hud data']]);
assert.throws(() => revealDirectory(''), /data directory/);

live.flush();
recovered.flush();
console.log('PASS: saveError, recoveredFrom, confined backup restore and data-dir reveal');
