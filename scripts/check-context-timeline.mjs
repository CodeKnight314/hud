// Readable shared-context timeline: kind labels, filters, corrections, and handoff text.
import assert from 'node:assert/strict';
import { contextDataLine, contextHandoff, contextSummaryText, contextTimeline, loadContextPages, renderContextTimeline } from '../web/context-timeline.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => `t${t}`;

const entries = [
  { id: 'fact-1', seq: 1, t: 100, actor: 'claude', session: 'agent-a', kind: 'FACT', text: 'the parser drops trailing commas', refs: ['ticket-2'], data: { input: 'a,', nested: { skip: true } }, attachments: ['att-1'] },
  { id: 'fail-1', seq: 2, t: 200, actor: 'codex', session: 'agent-b', kind: 'FAIL', text: 'retrying the printer path failed on empty input', corrects: 'fact-1' },
  { id: 'sum-1', seq: 3, t: 300, actor: 'claude', kind: 'SUMMARY', text: 'first handoff: parser still open' },
  { id: 'sum-2', seq: 4, t: 400, actor: 'claude', kind: 'SUMMARY', text: 'handoff: parser fix is in, printer path is a dead end', corrects: 'sum-1' },
  { id: 'status-1', seq: 5, t: 500, actor: 'claude', kind: 'STATUS', text: 'writing the regression' },
  { id: 'fact-2', seq: 6, t: 600, actor: 'claude', kind: 'FACT', text: 'the fixture covers a trailing comma' },
];

const all = contextTimeline(entries, { filter: 'all' });
assert.deepEqual(all.map((row) => row.id), ['fact-2', 'status-1', 'sum-2', 'sum-1', 'fail-1', 'fact-1'], 'newest first');
assert.equal(all.find((row) => row.id === 'fact-2').label, 'finding');
assert.equal(all.find((row) => row.id === 'fail-1').label, 'dead end');
assert.equal(all.find((row) => row.id === 'sum-2').label, 'handoff');
assert.equal(all.find((row) => row.id === 'status-1').label, 'progress');
assert.equal(all.find((row) => row.id === 'fact-1').superseded, true, 'a later correction retires the finding');
assert.equal(all.find((row) => row.id === 'sum-1').superseded, true);
assert.equal(all.find((row) => row.id === 'fail-1').correctsText, 'the parser drops trailing commas');
assert.equal(all.find((row) => row.id === 'fact-2').superseded, false);

const facts = contextTimeline(entries, { filter: 'fact' });
assert.deepEqual(facts.map((row) => row.id), ['fact-2', 'fact-1']);
assert.equal(facts.find((row) => row.id === 'fact-1').superseded, true, 'filtering does not hide that a finding was corrected');
assert.deepEqual(contextTimeline(entries, { filter: 'nope' }).map((row) => row.kind), all.map((row) => row.kind));
assert.deepEqual(contextTimeline([], { filter: 'FAIL' }), []);

assert.equal(contextDataLine({ input: 'a,', nested: { skip: true }, blank: '  ' }), 'input=a,');
assert.equal(contextDataLine({ only: { nested: true } }), '');
assert.equal(contextSummaryText(entries), '1 finding · 1 dead end · 1 handoff · 1 progress note · 2 corrected');
assert.equal(contextSummaryText([]), 'nothing published yet');

const handoff = contextHandoff(entries, {
  scope: 'run:run-1',
  title: 'Parser run',
  now: 700,
  formatTime: when,
  nameOf: (id) => (id === 'ticket-2' ? 'ENG-2' : id),
});
assert.match(handoff, /^Handoff · Parser run\n/);
assert.match(handoff, /scope: run:run-1/);
assert.match(handoff, /Current handoff\nSUMMARY t400 @claude — handoff: parser fix is in, printer path is a dead end/);
assert.match(handoff, /Dead ends\n- FAIL t200 @codex \(agent-b\) — retrying the printer path failed on empty input\n  corrects: the parser drops trailing commas/);
assert.match(handoff, /Findings\n- FACT t600 @claude — the fixture covers a trailing comma/);
assert.doesNotMatch(section(handoff, 'Findings'), /trailing commas/, 'a corrected finding is not restated as current');
assert.match(handoff, /Progress\n- STATUS t500 @claude — writing the regression/);
assert.match(section(handoff, 'Corrected'), /FACT t100 @claude \(agent-a\) — the parser drops trailing commas/);
assert.match(section(handoff, 'Corrected'), /refs: ENG-2/);
assert.match(section(handoff, 'Corrected'), /data: input=a,/);
assert.match(section(handoff, 'Corrected'), /attachments: 1/);
assert.doesNotMatch(handoff, /"kind"|"seq"|\{"skip"/, 'handoff is prose, not a raw entry dump');
assert.doesNotMatch(handoff, /Earlier handoffs/, 'a corrected summary is not an earlier standing handoff');
assert.equal(contextHandoff([], { scope: 'run:run-1', title: 'Parser run', formatTime: when }), 'Handoff · Parser run\nscope: run:run-1\n\nNothing published for this scope yet.\n');

const html = renderContextTimeline({
  entries,
  filter: 'FAIL',
  scope: 'run:run-1',
  where: 'this run',
  esc,
  when: () => '2m ago',
  nameOf: (id) => id,
  complete: false,
});
assert.match(html, /copy for handoff/);
assert.match(html, /data-chips="context-kind"/);
assert.match(html, /data-v="FAIL"[^>]*class="chip on"|class="chip on"[^>]*data-v="FAIL"/);
assert.match(html, /dead end/);
assert.match(html, /retrying the printer path failed on empty input/);
assert.match(html, /corrects: the parser drops trailing commas/);
assert.doesNotMatch(html, /writing the regression/, 'the FAIL filter hides other kinds');
assert.match(html, /kind-fail/);
assert.match(html, /newer entries were not loaded/);
assert.doesNotMatch(html, /older entries were not loaded/);
assert.match(html, /1 finding · 1 dead end · 1 handoff · 1 progress note · 2 corrected/);

const hostile = renderContextTimeline({
  entries: [{ id: 'x', seq: 1, t: 1, actor: '<claude>', kind: 'FACT', text: '<script>alert(1)</script>' }],
  filter: 'all',
  scope: 'project:p',
  where: 'this project',
  esc,
  when: () => 'now',
  nameOf: (id) => id,
  complete: true,
});
assert.match(hostile, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(hostile, /@&lt;claude&gt;/);
assert.doesNotMatch(hostile, /<script/);
assert.match(renderContextTimeline({
  entries: [],
  filter: 'all',
  scope: 'project:p',
  where: 'this project',
  esc,
  when: () => '',
  nameOf: (id) => id,
  complete: true,
}), /Nothing published for this scope yet/);
assert.match(renderContextTimeline({
  entries: [{ id: 'f', seq: 1, t: 1, actor: 'a', kind: 'FACT', text: 'only a finding' }],
  filter: 'STATUS',
  scope: 'run:r',
  where: 'this run',
  esc,
  when: () => 'now',
  nameOf: (id) => id,
  complete: true,
}), /No progress notes in this run/);
assert.match(renderContextTimeline({
  entries: [{ id: 'f', seq: 1, t: 1, actor: 'a', kind: 'FACT', text: 'only a finding' }],
  filter: 'FAIL',
  scope: 'run:r',
  where: 'this run',
  esc,
  when: () => 'now',
  nameOf: (id) => id,
  complete: true,
}), /No dead ends in this run/);
assert.match(renderContextTimeline({
  entries,
  filter: 'all',
  scope: 'run:run-1',
  where: 'this run',
  esc,
  when: () => 'now',
  nameOf: (id) => id,
  complete: true,
  truncated: true,
}), /older entries were dropped/);

const paged = [];
for (let i = 1; i <= 5; i++) paged.push({ id: `s${i}`, seq: i, t: i, actor: 'claude', kind: 'STATUS', text: `note ${i}` });
paged.push({ id: 'late-sum', seq: 6, t: 6, actor: 'claude', kind: 'SUMMARY', text: 'latest handoff still stands' });
paged.push({ id: 'late-fix', seq: 7, t: 7, actor: 'codex', kind: 'FAIL', text: 'note 1 was wrong', corrects: 's1' });
function oldestFirst(since, limit) {
  const all = paged.filter((entry) => since == null || entry.seq > since);
  const page = all.slice(0, limit);
  return { entries: page, cursor: page.length ? page[page.length - 1].seq : since, complete: page.length === all.length, truncated: false };
}
const full = await loadContextPages((since) => oldestFirst(since, 3));
assert.equal(full.complete, true);
assert.equal(full.newerMissing, false);
assert.equal(full.entries.at(-1).id, 'late-fix');
const pagedHandoff = contextHandoff(full.entries, { scope: 'run:busy', title: 'Busy run', complete: true, formatTime: when });
assert.match(pagedHandoff, /Current handoff\nSUMMARY t6 @claude — latest handoff still stands/);
assert.match(pagedHandoff, /FAIL t7 @codex — note 1 was wrong/);
const cut = await loadContextPages((since) => oldestFirst(since, 3), { maxPages: 1 });
assert.equal(cut.complete, false);
assert.equal(cut.newerMissing, true);
assert.equal(cut.entries.some((entry) => entry.id === 'late-sum'), false, 'one oldest-first page drops the latest handoff');
assert.equal(contextHandoff(cut.entries, { scope: 'run:busy', title: 'Busy run', complete: false, formatTime: when }), null);
const retained = contextHandoff(full.entries, { scope: 'run:busy', title: 'Busy run', complete: true, truncated: true, formatTime: when });
assert.match(retained, /^▲ Older entries were dropped; this handoff is the context still retained\.\n/);
assert.match(retained, /latest handoff still stands/);

function section(text, name) {
  const match = text.match(new RegExp(`(?:^|\\n)${name}\\n([\\s\\S]*?)(?=\\n(?:Current handoff|Earlier handoffs|Dead ends|Findings|Progress|Corrected)\\n|$)`));
  return match ? match[1].trim() : '';
}

console.log('PASS context timeline: labels, filters, corrections, handoff text, escaped markup');
