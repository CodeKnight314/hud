import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, STATE_VERSION } from '../src/store.ts';
import { layout, canvasItems, BOARD_WIDTH, BOARD_HEIGHT } from '../src/layout.ts';
import type { Item } from '../src/types.ts';

const appSource = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
assert(!/const MENU = \[[^\]]*'ticket'/.test(appSource), 'the canvas menu does not create tickets');
const dir = mkdtempSync(join(tmpdir(), 'hud-layout-'));
const store = new Store(join(dir, 'state.json'));
const actor = 'layout-check';
const all = (s = store, board = 'main') => Object.values(s.state.items).filter(i => i.board === board);
function verify(items: Item[]) {
  items = canvasItems(items);
  for (const i of items) {
    assert([i.x, i.y, i.w, i.h].every(Number.isFinite));
    assert(i.x >= 0 && i.y >= 0 && i.w > 0 && i.h > 0, i.id);
    assert(i.x + i.w <= BOARD_WIDTH + 1e-7 && i.y + i.h <= BOARD_HEIGHT + 1e-7, i.id);
    if (i.group && i.type !== 'frame') {
      const f = items.find(f => f.type === 'frame' && f.title.toLowerCase() === i.group!.toLowerCase())!;
      assert(f && i.x >= f.x && i.y >= f.y && i.x + i.w <= f.x + f.w + 1e-7 && i.y + i.h <= f.y + f.h + 1e-7, `containment ${i.id}`);
    }
  }
  const leaves = items.filter(i => i.type !== 'frame');
  for (let a = 0; a < leaves.length; a++) for (let b = a + 1; b < leaves.length; b++) {
    const i = leaves[a]!, j = leaves[b]!;
    assert(!(i.x < j.x + j.w - 1e-7 && i.x + i.w > j.x + 1e-7 && i.y < j.y + j.h - 1e-7 && i.y + i.h > j.y + 1e-7), `overlap ${i.id}/${j.id}`);
  }
}
for (const count of [0, 1, 3, 4, 8, 30, 100]) {
  for (const grouped of [false, true]) {
    const board = store.createBoard(`case-${count}-${grouped}`, actor).id;
    for (let i = 0; i < count; i++) store.create({ type: i % 3 ? 'monitor' : 'ticket', title: `run ${i}`, board, ...(grouped && i % 3 ? { group: `run-${i % 4}` } : {}) }, actor);
    store.organize(board, actor);
    verify(all(store, board));
    assert.equal(store.organize(board, actor).moved, 0, 'idempotent');
  }
}
const ticket = store.create({ type: 'ticket', title: 'copy me' }, actor);
assert.match(ticket.id, /^[a-f\d-]{36}$/);
assert.equal(ticket.uuid, ticket.id);
assert.equal(store.resolveId(ticket.uuid!), ticket.id);
const monitor = store.create({ type: 'monitor', title: 'training', source: { kind: 'push' } }, actor);
await new Promise(r => setTimeout(r, 350));
verify(all());
const geometry = () => all().map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
const before = geometry();
store.push(monitor.id, { progress: 25, value: .25, state: 'running' }, actor);
store.update(ticket.id, { status: 'doing' }, actor);
await new Promise(r => setTimeout(r, 350));
assert.deepEqual(geometry(), before, 'readings and status preserve layout');
store.setBoard('main', { autoOrganize: false }, actor);
const note = store.create({ type: 'note', title: 'placed' }, actor);
store.update(note.id, { x: -1000, y: 10000, w: 5000, h: 5000 }, actor);
assert.deepEqual([note.x, note.y, note.w, note.h], [0, 0, 1600, 900], 'canvas objects clamp to the board');
// tasks are tree objects: they take no coordinates and never land on the canvas
assert.deepEqual([ticket.x, ticket.y], [0, 0], 'a ticket has no canvas position');
assert.throws(() => store.update(ticket.id, { x: 20, y: 20 }, actor), /lives in the ticket tree/, 'moving a ticket on the canvas is refused');
assert.throws(() => store.create({ type: 'ticket', title: 'placed', x: 20, y: 20 }, actor), /lives in the ticket tree/);
assert.throws(() => store.create({ type: 'project', title: 'placed', x: 20, y: 20 }, actor), /lives in the ticket tree/);
assert.throws(() => store.create({ type: 'ticket', title: 'sized', w: 300, h: 200 }, actor), /lives in the ticket tree/);
assert(canvasItems(all()).every((i) => i.type !== 'ticket' && i.type !== 'project'), 'the canvas holds no tasks');
const uuid = ticket.uuid;
store.remove(ticket.id, actor);
store.restore(ticket.id, actor);
assert.equal(store.get(ticket.id).uuid, uuid);
const legacy = store.exportState();
legacy.version = 5;
const legacyTicket = Object.values(legacy.items).find(i => i.type === 'ticket')!;
delete legacy.items[legacyTicket.id]; legacyTicket.id = 't-legacy'; delete legacyTicket.uuid;
legacy.items[legacyTicket.id] = legacyTicket;
legacyTicket.x = -100000;
const legacyFile = join(dir, 'legacy.json');
writeFileSync(legacyFile, JSON.stringify(legacy));
const migrated = new Store(legacyFile);
assert.equal(migrated.state.version, STATE_VERSION);
assert.equal(Object.keys(migrated.state.items).length, Object.keys(legacy.items).length);
assert.equal(migrated.resolveId(migrated.get('t-legacy').uuid!), 't-legacy');
for (const board of migrated.state.boards) { assert.equal(board.autoOrganize, true); verify(all(migrated, board.id)); }
assert(readdirSync(join(dir, 'backups')).some(n => n.includes('premigrate-v5')));
const restored = migrated.exportState();
store.importState(restored, 'replace', actor);
assert.equal(store.get('t-legacy').uuid, migrated.get('t-legacy').uuid);
assert.equal(layout([]).size, 0);
const crowded = store.createBoard('ticket-heavy', actor).id;
for (let i = 0; i < 40; i++) store.create({ type: 'ticket', board: crowded, title: `Task ${i}`, group: i < 12 ? 'Done' : 'Work', status: i < 12 ? 'done' : 'doing' }, actor);
const solo = store.create({ type: 'monitor', board: crowded, title: 'Training' }, actor);
const organized = store.organize(crowded, actor);
assert.equal(organized.items, 1);
assert.equal(organized.tickets, 40);
assert.deepEqual(canvasItems(all(store, crowded)).map(i => i.id), [solo.id]);
assert(solo.w >= 280 && solo.h >= 160);
assert.equal(all(store, crowded).filter(i => i.type === 'ticket').length, 40);
store.flush(); migrated.flush();
console.log('PASS: bounded layouts 0–100 cards, grouping, idempotence, structural auto-layout, stable readings/status, manual bounds, UUID/restore/import, v5 migration and backup.');
console.log(`Scratch artifacts: ${dir}`);
