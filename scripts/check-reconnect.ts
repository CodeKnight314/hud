import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import {
  RECONNECT_DIALOG,
  acknowledgeReconnect,
  armReconnectNotice,
  clientsFromSessions,
  loadReconnectChecklist,
  reconnectChecklist,
  stableVersion,
  syncServerVersion,
  takeReconnectChecklist,
} from '../src/reconnect.ts';
import type { ReconnectClient } from '../src/reconnect.ts';

const roots: string[] = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'hud-reconnect-'));
  roots.push(path);
  return path;
};
const client = (patch: Partial<ReconnectClient> = {}): ReconnectClient => ({
  id: 'claude-9', name: 'claude-9', actor: 'claude', kind: 'agent', version: '0.1.2', live: true, ...patch,
});

assert.equal(stableVersion('0.2.0'), '0.2.0');
assert.equal(stableVersion(' 0.1.3 '), '0.1.3');
for (const value of ['0.0.0', '0.1', 'v0.1.0', '0.1.2-beta', '01.2.3', 'newer', '', null, 1]) assert.equal(stableVersion(value), null);

const matched = reconnectChecklist('0.1.3', [client({ version: '0.1.3' })], null);
assert.equal(matched.pending, false);
assert.equal(matched.skewed, false);
assert.equal(matched.steps.length, 0);
assert.match(matched.text, /No MCP clients/);

const skew = reconnectChecklist('0.1.3', [
  client(),
  client({ id: 'codex-2', name: 'codex-2', actor: 'codex', version: '0.1.4' }),
  client({ id: 'old-cli', name: 'old-cli', actor: 'cli', kind: 'cli', version: '0.1.0' }),
  client({ id: 'gone', name: 'gone', actor: 'opencode', version: '0.1.0', live: false }),
  client({ id: 'mystery', name: 'mystery', actor: 'cursor', kind: 'unknown', version: undefined }),
], null);
assert.equal(skew.pending, false);
assert.equal(skew.skewed, true);
assert.deepEqual(skew.steps.map((step) => step.id), ['claude-9', 'codex-2']);
assert.match(skew.steps[0].instruction, /\/mcp/);
assert.match(skew.steps.find((step) => step.actor === 'codex')!.instruction, /Restart the Codex session/);
assert.doesNotMatch(skew.text, /opencode/i);

const notice = { reason: 'quit-for-update' as const, fromVersion: '0.1.2', at: 10, clients: [client({ version: '0.1.2' })] };
const offered = reconnectChecklist('0.1.3', [], notice);
assert.equal(offered.pending, true);
assert.equal(offered.reason, 'quit-for-update');
assert.equal(offered.skewed, true);
assert.equal(offered.steps[0].id, 'claude-9');
assert.match(offered.text, /v0\.1\.2/);
assert.match(offered.text, /v0\.1\.3/);
assert.match(offered.text, /\/mcp/);
assert.match(offered.text, /hud mcp reconnect/);

const reconnected = reconnectChecklist('0.1.3', [client({ version: '0.1.3' })], notice);
assert.equal(reconnected.pending, true);
assert.equal(reconnected.steps.length, 0, 'a live client already on the server version is not listed again');
assert.match(reconnected.text, /No connected client reported a different version/);

const quiet = reconnectChecklist('0.1.2', [], notice);
assert.equal(quiet.pending, false, 'the same build does not offer the post-update checklist');

const generic = reconnectChecklist('0.2.0', [], { reason: 'update', fromVersion: '0.1.3', at: 11, clients: [] });
assert.equal(generic.pending, true);
assert.equal(generic.skewed, false);
assert.deepEqual(generic.steps.map((step) => step.actor), ['claude', 'codex', 'opencode']);
assert.match(generic.steps[0].instruction, /\/mcp/);

const resumed = reconnectChecklist('0.1.3', [
  client({ id: 'claude-4', name: 'claude-4', actor: 'claude-4', kind: 'unknown', version: undefined }),
  client({ id: 'zero', name: 'zero', actor: 'claude', version: '0.0.0' }),
], notice);
assert.equal(resumed.steps.some((step) => step.id === 'claude-4' || step.id === 'zero'), false, 'a missing or 0.0.0 client version is not skew');
const placeholder = reconnectChecklist('0.1.3', [client({ id: 'zero', name: 'zero', actor: 'claude', version: '0.0.0' })], null);
assert.equal(placeholder.skewed, false);
assert.equal(placeholder.steps.length, 0);
const ended = reconnectChecklist('0.1.3', [], { reason: 'quit-for-update', fromVersion: '0.1.0', at: 2, clients: [client({ id: 'ended', name: 'ended', actor: 'claude', version: '0.1.0', live: false })] });
assert.equal(ended.steps.some((step) => step.id === 'ended'), false, 'an ended quit snapshot is not resurrected');
assert.equal(RECONNECT_DIALOG.buttons[RECONNECT_DIALOG.defaultId], 'Later');
assert.equal(RECONNECT_DIALOG.buttons[RECONNECT_DIALOG.cancelId], 'Later');
assert.equal(RECONNECT_DIALOG.buttons[RECONNECT_DIALOG.dismissResponse], 'Dismiss');

const data = dir();
assert.equal(loadReconnectChecklist(data, '0.1.3').pending, false);
syncServerVersion(data, '0.1.2');
assert.equal(existsSync(join(data, 'server-version')), true);
assert.equal(loadReconnectChecklist(data, '0.1.2').pending, false, 'recording the first server version does not arm a checklist');
syncServerVersion(data, '0.1.3');
const armed = loadReconnectChecklist(data, '0.1.3');
assert.equal(armed.pending, true);
assert.equal(armed.reason, 'update');
assert.equal(armed.steps.length, 3);

const armedClients = armReconnectNotice(data, {
  reason: 'quit-for-update', fromVersion: '0.1.3',
  clients: [client({ id: 'live-one', name: 'live-one', version: '0.1.3' }), client({ id: 'ended-one', name: 'ended-one', version: '0.1.0', live: false })],
});
assert.deepEqual(armedClients.clients.map((item) => item.id), ['live-one'], 'quit snapshots keep only sessions that were live');
syncServerVersion(data, '0.1.4');
const kept = loadReconnectChecklist(data, '0.1.4');
assert.equal(kept.reason, 'quit-for-update');
assert.equal(kept.steps[0].id, 'live-one', 'a quit snapshot is kept when the server version changes');

const shown = takeReconnectChecklist(data, '0.1.4');
assert.equal(shown.pending, false);
assert.equal(shown.steps[0].id, 'live-one', 'dismissing still returns the checklist that was shown');
assert.equal(loadReconnectChecklist(data, '0.1.4').pending, false);
assert.equal(existsSync(join(data, 'reconnect.json')), false);
takeReconnectChecklist(data, '0.1.4');

const same = dir();
armReconnectNotice(same, { reason: 'quit-for-update', fromVersion: '0.1.3', clients: [client()] });
syncServerVersion(same, '0.1.3');
assert.equal(existsSync(join(same, 'reconnect.json')), false, 'reopening the same build drops the quit reminder');

writeFileSync(join(data, 'reconnect.json'), '{');
assert.equal(loadReconnectChecklist(data, '0.1.4').pending, false);
armReconnectNotice(data, { reason: 'update', fromVersion: 'not-a-version', clients: [client({ id: '', version: 'soon' })] });
const ignored = JSON.parse(readFileSync(join(data, 'reconnect.json'), 'utf8'));
assert.equal(ignored.clients.length, 0);
assert.equal(loadReconnectChecklist(data, '0.1.4').pending, false);
acknowledgeReconnect(data);
assert.equal(existsSync(join(data, 'reconnect.json')), false);
acknowledgeReconnect(data);

const storeDir = dir();
const store = new Store(join(storeDir, 'state.json'));
const started = store.sessionStart({ id: 'claude-9', kind: 'agent', actor: 'claude', clientVersion: '0.1.2' }, 'claude');
assert.equal(started.clientVersion, '0.1.2');
store.noteClientVersion('claude-9', '0.1.3');
assert.equal(store.sessions().items[0].clientVersion, '0.1.3');
store.noteClientVersion('claude-9', 'beta');
store.noteClientVersion('claude-9', '0.0.0');
assert.equal(store.sessions().items[0].clientVersion, '0.1.3');
const placeholderSession = store.sessionStart({ id: 'placeholder', kind: 'agent', clientVersion: '0.0.0' }, 'claude');
assert.equal(placeholderSession.clientVersion, undefined);
store.noteClientVersion('missing session', '0.1.0');
store.sessionEnd('claude-9', 'claude');
store.noteClientVersion('claude-9', '0.2.0');
assert.equal(store.sessions().items.find((item) => item.id === 'claude-9')?.clientVersion, '0.1.3');
store.stopBackups();
store.flush();

const keepDir = dir();
const keepStore = new Store(join(keepDir, 'state.json'));
keepStore.sessionStart({ id: 'claude-keep', name: 'claude-keep', kind: 'agent', actor: 'claude', clientVersion: '0.1.2' }, 'claude');
const armedKeep = armReconnectNotice(keepDir, {
  reason: 'quit-for-update', fromVersion: '0.1.2',
  clients: clientsFromSessions(keepStore.sessions().items),
});
assert.deepEqual(armedKeep.clients.map((item) => item.id), ['claude-keep']);
keepStore.sessionEnd('claude-keep', 'claude');
const keptRows = keepStore.sessions().items;
assert.equal(keptRows.some((item) => item.id === 'claude-keep' && item.live === false), true, 'an ended session stays listed through SESSION_KEEP_MS');
const duringKeep = loadReconnectChecklist(keepDir, '0.1.3', clientsFromSessions(keptRows));
assert.equal(duringKeep.steps[0]?.id, 'claude-keep', 'an ended row still inside SESSION_KEEP_MS does not erase its quit-snapshot step');
const shownKeep = takeReconnectChecklist(keepDir, '0.1.3', clientsFromSessions(keptRows));
assert.equal(shownKeep.pending, false);
assert.equal(shownKeep.steps[0]?.id, 'claude-keep', 'ack uses the same live-only sessions and still returns the quit-snapshot step');
keepStore.stopBackups();
keepStore.flush();

for (const path of roots) rmSync(path, { recursive: true, force: true });
console.log('PASS reconnect checklist, version skew, one-shot notice and session client versions');
