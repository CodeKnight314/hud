// Compact board widget: session name, lease TTL and ready count, without leaving the canvas.
import assert from 'node:assert/strict';
import { claimWidgetHTML, formatClaimTtl } from '../web/claim-widget.js';

const now = 1_700_000_000_000;

assert.equal(formatClaimTtl(now, now), 'expired');
assert.equal(formatClaimTtl(now - 5_000, now), 'expired');
assert.equal(formatClaimTtl(now + 1, now), '1s');
assert.equal(formatClaimTtl(now + 59_000, now), '59s');
assert.equal(formatClaimTtl(now + 60_000, now), '1m');
assert.equal(formatClaimTtl(now + 61_000, now), '1m 1s');
assert.equal(formatClaimTtl(now + 90_000, now), '1m 30s');
assert.equal(formatClaimTtl(now + 3_600_000, now), '1h');
assert.equal(formatClaimTtl(now + 3_660_000, now), '1h 1m');
assert.equal(formatClaimTtl('nope', now), '—');

assert.equal(claimWidgetHTML({ queue: null, now }), '');
assert.equal(claimWidgetHTML({ queue: { counts: { ready: 0 }, items: [] }, now }), '', 'quiet board stays clear');

const readyOnly = claimWidgetHTML({
  queue: { counts: { ready: 3 }, items: [{ id: 'open', ident: 'EGO-1', claim: null, ready: true }] },
  now,
});
assert.match(readyOnly, /data-ready="3"/);
assert.match(readyOnly, />3 ready</);
assert.doesNotMatch(readyOnly, /data-claim-focus/);

const claimed = claimWidgetHTML({
  queue: {
    now: now - 2_000,
    counts: { ready: 5 },
    items: [
      { id: 'late', ident: 'EGO-4', title: 'later', claim: { session: 'agent-a', expiresAt: now + 90_000, live: true, ident: 'EGO-4' }, session: { id: 'agent-a', name: 'Queue Alice', live: true } },
      { id: 'soon', ident: 'EGO-9', title: 'sooner', claim: { session: 'agent-b', expiresAt: now + 30_000, live: true, ident: 'EGO-9' }, session: { id: 'agent-b', name: 'Bob', live: true } },
      { id: 'open', ident: 'EGO-1', claim: null, ready: true },
    ],
  },
  sessions: { now, items: [{ id: 'agent-a', name: 'Alice', live: true }] },
  now,
});
assert.match(claimed, /data-ready="5"/, 'ready count is the queue total, not the visible rows');
assert.match(claimed, />5 ready</);
assert.match(claimed, /data-claim-session="Alice"/);
assert.match(claimed, /data-claim-session="Bob"/);
assert.match(claimed, /data-claim-ttl="30s"/);
assert.match(claimed, /data-claim-ttl="1m 30s"/);
assert.match(claimed, /data-claim-focus="soon"/);
assert.ok(claimed.indexOf('data-claim-session="Bob"') < claimed.indexOf('data-claim-session="Alice"'), 'soonest lease is first');
assert.match(claimed, /●/);
assert.doesNotMatch(claimed, /Queue Alice/);

const namedFallback = claimWidgetHTML({
  queue: {
    counts: { ready: 0 },
    items: [{ id: 'held', ident: 'EGO-2', claim: { session: 'agent-c', expiresAt: now + 10_000, live: true }, session: { id: 'agent-c', name: 'Cara', live: false } }],
  },
  now,
});
assert.match(namedFallback, /data-ready="0"/);
assert.match(namedFallback, /data-claim-session="Cara"/);
assert.match(namedFallback, /data-claim-ttl="10s"/);
assert.match(namedFallback, /○/);
assert.doesNotMatch(namedFallback, /●/);

const fresherDead = claimWidgetHTML({
  queue: {
    now: now - 2_000,
    counts: { ready: 0 },
    items: [{ id: 'held', ident: 'EGO-8', claim: { session: 'agent-c', expiresAt: now + 20_000, live: true }, session: { id: 'agent-c', name: 'Queue Cara', live: true } }],
  },
  sessions: { now, items: [{ id: 'agent-c', name: 'Cara', live: false }] },
  now,
});
assert.match(fresherDead, /data-claim-session="Cara"/);
assert.match(fresherDead, /data-claim-live="0"/);
assert.match(fresherDead, /○/);
assert.doesNotMatch(fresherDead, /●/);

const fresherLive = claimWidgetHTML({
  queue: {
    now: now - 2_000,
    counts: { ready: 0 },
    items: [{ id: 'held', ident: 'EGO-8', claim: { session: 'agent-d', expiresAt: now + 20_000, live: true }, session: { id: 'agent-d', name: 'Queue Dan', live: false } }],
  },
  sessions: { now, items: [{ id: 'agent-d', name: 'Dan', live: true }] },
  now,
});
assert.match(fresherLive, /data-claim-session="Dan"/);
assert.match(fresherLive, /data-claim-live="1"/);
assert.match(fresherLive, /●/);

const queueNewer = claimWidgetHTML({
  queue: {
    now,
    counts: { ready: 0 },
    items: [{ id: 'held', ident: 'EGO-8', claim: { session: 'agent-d', expiresAt: now + 20_000, live: true }, session: { id: 'agent-d', name: 'Dan', live: true } }],
  },
  sessions: { now: now - 2_000, items: [{ id: 'agent-d', name: 'Stale Dan', live: false }] },
  now,
});
assert.match(queueNewer, /data-claim-session="Dan"/, 'a newer queue snapshot keeps its session name');
assert.match(queueNewer, /data-claim-live="1"/, 'a newer queue snapshot keeps a live holder');
assert.match(queueNewer, /●/);
assert.doesNotMatch(queueNewer, /Stale Dan/);

const sameTime = claimWidgetHTML({
  queue: {
    now,
    counts: { ready: 0 },
    items: [{ id: 'held', ident: 'EGO-8', claim: { session: 'agent-e', expiresAt: now + 20_000, live: true }, session: { id: 'agent-e', name: 'Queue Eve', live: true } }],
  },
  sessions: { now, items: [{ id: 'agent-e', name: 'List Eve', live: false }] },
  now,
});
assert.match(sameTime, /data-claim-session="Queue Eve"/, 'an equal snapshot time does not let the session list override the queue');
assert.match(sameTime, /data-claim-live="1"/);

const hostile = claimWidgetHTML({
  queue: {
    counts: { ready: 1 },
    items: [{ id: 'x', ident: '<b>', title: '"quoted"', claim: { session: 's', expiresAt: now + 1000, live: true }, session: { id: 's', name: '<img alt="x">' } }],
  },
  now,
});
assert.match(hostile, /data-claim-session="&lt;img alt=&quot;x&quot;&gt;"/);
assert.match(hostile, /&lt;b&gt;/);
assert.doesNotMatch(hostile, /<img|<b>|<script|onerror=/);

const many = claimWidgetHTML({
  queue: {
    counts: { ready: 1 },
    items: Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      ident: `K-${i}`,
      claim: { session: `s${i}`, expiresAt: now + (i + 1) * 1000, live: true },
      session: { id: `s${i}`, name: `Session ${i}`, live: true },
    })),
  },
  now,
});
for (let i = 0; i < 6; i++) assert.match(many, new RegExp(`Session ${i}`), `claim ${i} stays on the canvas`);
assert.doesNotMatch(many, /\+\d+ more/);

console.log('PASS claim widget: session name, TTL and ready count');
