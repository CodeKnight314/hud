// Scripted run for web/tree-demo.html: the same calls the Tickets view makes, driven by a timeline.
import { createTicketTree } from './ticket-tree.js';

const tree = createTicketTree({ onOpen: (id) => say(`open ${id}`) });
document.getElementById('stage').appendChild(tree.el);
const log = document.getElementById('log');
const say = (text) => { log.textContent = text; };

let tickets;
const t = (n, extra = {}) => ({ id: `GRASP-${n}`, ident: `GRASP-${n}`, title: '', status: 'todo', parent: null, blockedBy: [], claimer: null, ...extra });
const set = (n, patch) => Object.assign(tickets.get(`GRASP-${n}`), patch);
const add = (n, extra) => tickets.set(`GRASP-${n}`, t(n, extra));
const pulse = (n, kind) => () => tree.pulse(`GRASP-${n}`, kind);
const render = () => tree.update([...tickets.values()].map((x) => ({ ...x })));

// [delay ms, note, mutation]; a mutation returning a function runs it after the render (a pulse)
const SCRIPT = [
  [600, 'codex claims GRASP-1', () => set(1, { status: 'doing', claimer: 'codex' })],
  [900, 'codex: STATUS splitting the work', () => pulse(1, 'STATUS')],
  [1100, 'codex splits GRASP-1 into eight children', () => {
    for (const n of [2, 3, 4, 5, 6]) add(n, { parent: 'GRASP-1' });
    add(7, { parent: 'GRASP-1', status: 'blocked', blockedBy: ['GRASP-2', 'GRASP-3', 'GRASP-4', 'GRASP-5', 'GRASP-6'] });
    add(8, { parent: 'GRASP-1', status: 'blocked', blockedBy: ['GRASP-7'] });
    add(9, { parent: 'GRASP-1', status: 'blocked', blockedBy: ['GRASP-7', 'GRASP-8'] });
  }],
  [1300, 'lint: GRASP-7 waits on most of its siblings; it integrates them', () => pulse(7, 'STATUS')],
  [1100, 'GRASP-4, 5 and 6 move under GRASP-7', () => { for (const n of [4, 5, 6]) set(n, { parent: 'GRASP-7' }); }],
  [1200, 'codex releases GRASP-1 and claims GRASP-2; claude claims GRASP-3', () => {
    set(1, { status: 'review', claimer: null });
    set(2, { status: 'doing', claimer: 'codex' });
    set(3, { status: 'doing', claimer: 'claude' });
  }],
  [1000, 'codex: FACT judge labels frozen', () => pulse(2, 'FACT')],
  [1100, 'claude: FAIL job 11443619 artifacts incomplete', () => pulse(3, 'FAIL')],
  [1100, 'claude adds a repair ticket GRASP-10', () => add(10, { parent: 'GRASP-3', status: 'doing', claimer: 'claude' })],
  [1200, 'GRASP-2 done', () => set(2, { status: 'done', claimer: null })],
  [700, 'codex claims GRASP-4', () => set(4, { status: 'doing', claimer: 'codex' })],
  [1200, 'GRASP-10 done; GRASP-3 done', () => { set(10, { status: 'done', claimer: null }); set(3, { status: 'done', claimer: null }); }],
  [700, 'claude claims GRASP-5', () => set(5, { status: 'doing', claimer: 'claude' })],
  [1000, 'codex: FACT track A passes the screen', () => pulse(4, 'FACT')],
  [900, 'GRASP-4 done; codex claims GRASP-6', () => { set(4, { status: 'done', claimer: null }); set(6, { status: 'doing', claimer: 'codex' }); }],
  [1100, 'claude: FAIL track B diverges on thin handles', () => pulse(5, 'FAIL')],
  [1000, 'claude cancels GRASP-5', () => set(5, { status: 'canceled', claimer: null })],
  [1100, 'GRASP-6 done; GRASP-7 unblocks', () => { set(6, { status: 'done', claimer: null }); set(7, { status: 'todo' }); }],
  [800, 'codex claims GRASP-7', () => set(7, { status: 'doing', claimer: 'codex' })],
  [900, 'claude adds GRASP-11 by mistake', () => add(11, { parent: 'GRASP-1' })],
  [900, 'claude deletes GRASP-11', () => tickets.delete('GRASP-11')],
  [1100, 'GRASP-7 done; GRASP-8 unblocks', () => { set(7, { status: 'done', claimer: null }); set(8, { status: 'doing', claimer: 'claude' }); }],
  [1300, 'GRASP-8 done; codex claims GRASP-9', () => { set(8, { status: 'done', claimer: null }); set(9, { status: 'doing', claimer: 'codex' }); }],
  [1300, 'GRASP-9 done; GRASP-1 is ready for the whole-task check', () => { set(9, { status: 'done', claimer: null }); set(1, { status: 'todo' }); }],
  [900, 'claude claims GRASP-1 and checks the whole task', () => set(1, { status: 'doing', claimer: 'claude' })],
  [1300, 'GRASP-1 done', () => set(1, { status: 'done', claimer: null })],
  [2600, 'restarting', () => null],
];

let i = 0;
let timer = 0;
let playing = true;
let speed = 1;
function reset() {
  tickets = new Map([['GRASP-1', t(1)]]);
  i = 0;
  say('GRASP-1 created');
  render();
}
function tick() {
  timer = 0;
  if (!playing) return;
  if (i >= SCRIPT.length) reset();
  const [delay, note, fn] = SCRIPT[i++];
  timer = setTimeout(() => {
    const after = fn();
    say(note);
    render();
    if (typeof after === 'function') after();
    tick();
  }, delay / speed);
}
document.getElementById('play').addEventListener('click', (e) => {
  playing = !playing;
  e.target.textContent = playing ? 'pause' : 'play';
  if (playing && !timer) tick();
  else if (!playing) { clearTimeout(timer); timer = 0; }
});
document.getElementById('restart').addEventListener('click', () => { clearTimeout(timer); timer = 0; reset(); if (playing) tick(); });
document.getElementById('speed').addEventListener('click', (e) => {
  speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
  e.target.textContent = `${speed}×`;
});
reset();
tick();
