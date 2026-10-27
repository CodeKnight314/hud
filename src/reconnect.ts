import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compareVersions } from './updates.ts';

export type ReconnectClient = {
  id: string;
  name: string;
  actor: string;
  kind: string;
  version?: string;
  live: boolean;
};

export type ReconnectStep = {
  id: string;
  name: string;
  actor: string;
  fromVersion: string | null;
  instruction: string;
};

export type ReconnectNotice = {
  reason: 'quit-for-update' | 'update';
  fromVersion: string;
  at: number;
  clients: ReconnectClient[];
};

export type ReconnectChecklist = {
  serverVersion: string;
  pending: boolean;
  skewed: boolean;
  reason: 'quit-for-update' | 'update' | null;
  fromVersion?: string;
  steps: ReconnectStep[];
  text: string;
};

const NOTICE = 'reconnect.json';
const VERSION_FILE = 'server-version';

export function stableVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const version = value.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
  return version.split('.').every((part) => Number.isSafeInteger(Number(part))) ? version : null;
}

export function reconnectInstruction(actor: string, name: string, serverVersion: string): string {
  const label = `${actor} ${name}`.toLowerCase();
  if (label.includes('claude')) return `In Claude Code, run /mcp and reconnect hud. That starts a new MCP process on hud v${serverVersion}.`;
  if (label.includes('codex')) return `Restart the Codex session so it respawns hud v${serverVersion}.`;
  if (label.includes('opencode')) return `Restart OpenCode so it respawns hud v${serverVersion}.`;
  return `Restart ${name || actor} so it respawns the hud MCP process on v${serverVersion}.`;
}

function normalizeClient(raw: unknown): ReconnectClient | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<ReconnectClient>;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (!id || id.length > 64) return null;
  const kind = item.kind === 'agent' || item.kind === 'cli' || item.kind === 'human' || item.kind === 'unknown' ? item.kind : 'unknown';
  const version = stableVersion(item.version);
  return {
    id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : id,
    actor: typeof item.actor === 'string' && item.actor.trim() ? item.actor.trim().slice(0, 80) : id,
    kind,
    ...(version ? { version } : {}),
    live: item.live !== false,
  };
}

/** A reported version that is not this server, or a versionless agent resumed after an update. */
function verdict(client: ReconnectClient, server: string, pending: boolean): 'skew' | 'current' | 'ignore' {
  if (!client.live || client.kind === 'cli' || client.kind === 'human' || !server) return 'ignore';
  if (client.version && client.version === server) return 'current';
  if (client.version && client.version !== server) return 'skew';
  if (pending && (client.kind === 'agent' || client.kind === 'unknown')) return 'skew';
  return 'ignore';
}

const GENERIC: ReconnectClient[] = [
  { id: 'claude', name: 'Claude Code', actor: 'claude', kind: 'agent', live: true },
  { id: 'codex', name: 'Codex', actor: 'codex', kind: 'agent', live: true },
  { id: 'opencode', name: 'OpenCode', actor: 'opencode', kind: 'agent', live: true },
];

function stepFor(client: ReconnectClient, serverVersion: string): ReconnectStep {
  return {
    id: client.id,
    name: client.name,
    actor: client.actor,
    fromVersion: client.version ?? null,
    instruction: reconnectInstruction(client.actor, client.name, serverVersion),
  };
}

function checklistText(serverVersion: string, pending: boolean, fromVersion: string | undefined, steps: ReconnectStep[], generic: boolean): string {
  if (!pending && steps.length === 0) return `No MCP clients are on a different hud version (server v${serverVersion}).`;
  const lines = steps.map((step, index) => `${index + 1}. ${step.name}${step.fromVersion ? ` (v${step.fromVersion})` : ''} — ${step.instruction}`);
  if (!pending) return `Connected MCP clients are on a different hud version than v${serverVersion}:\n${lines.join('\n')}`;
  if (!steps.length) return `hud updated from v${fromVersion} to v${serverVersion}. No connected client reported a different version. Run hud mcp reconnect after a client reconnects if its tools still look old.`;
  const lead = generic
    ? `hud updated from v${fromVersion} to v${serverVersion}. No connected client reported a different version, so reconnect each client you use once:`
    : `hud updated from v${fromVersion} to v${serverVersion}. Reconnect these clients once so they load v${serverVersion}:`;
  return `${lead}\n${lines.join('\n')}\nDismiss this reminder with \`hud mcp reconnect\` or Settings → Updates → Dismiss checklist.`;
}

export function reconnectChecklist(serverVersion: string, live: ReconnectClient[], notice: ReconnectNotice | null): ReconnectChecklist {
  const server = stableVersion(serverVersion) ?? serverVersion;
  const from = notice ? stableVersion(notice.fromVersion) : null;
  const pending = !!(from && compareVersions(server, from) > 0);
  const snapshot = notice?.clients ?? [];
  const byId = new Map<string, ReconnectClient>();
  if (pending) {
    for (const client of snapshot) if (verdict({ ...client, live: true }, server, true) === 'skew') byId.set(client.id, client);
  }
  let sawCurrent = false;
  for (const client of live) {
    const state = verdict(client, server, pending);
    if (state === 'current') {
      sawCurrent = true;
      byId.delete(client.id);
    } else if (state === 'skew') byId.set(client.id, client);
    else byId.delete(client.id);
  }
  let steps = [...byId.values()].map((client) => stepFor(client, server));
  const skewed = steps.some((step) => step.fromVersion !== server);
  const generic = pending && steps.length === 0 && !sawCurrent && snapshot.every((client) => verdict({ ...client, live: true }, server, true) !== 'skew');
  if (generic) steps = GENERIC.map((client) => stepFor(client, server));
  steps.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    serverVersion: server,
    pending,
    skewed,
    reason: pending && notice ? notice.reason : null,
    ...(pending && from ? { fromVersion: from } : {}),
    steps,
    text: checklistText(server, pending, from ?? undefined, steps, generic),
  };
}

function noticePath(dataDir: string): string { return join(dataDir, NOTICE); }

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readReconnectNotice(dataDir: string): ReconnectNotice | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(noticePath(dataDir), 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const notice = raw as Partial<ReconnectNotice>;
  if (notice.reason !== 'quit-for-update' && notice.reason !== 'update') return null;
  if (typeof notice.fromVersion !== 'string') return null;
  const clients = Array.isArray(notice.clients) ? notice.clients.map(normalizeClient).filter((client): client is ReconnectClient => !!client).slice(0, 50) : [];
  return { reason: notice.reason, fromVersion: notice.fromVersion, at: typeof notice.at === 'number' ? notice.at : Date.now(), clients };
}

export function armReconnectNotice(dataDir: string, input: { reason: ReconnectNotice['reason']; fromVersion: string; clients?: ReconnectClient[]; at?: number }): ReconnectNotice {
  const notice: ReconnectNotice = {
    reason: input.reason,
    fromVersion: input.fromVersion,
    at: input.at ?? Date.now(),
    clients: (input.clients ?? []).map(normalizeClient).filter((client): client is ReconnectClient => !!client).slice(0, 50),
  };
  writeJson(noticePath(dataDir), notice);
  return notice;
}

export function acknowledgeReconnect(dataDir: string): void {
  try { rmSync(noticePath(dataDir), { force: true }); } catch { /* already gone */ }
}

function readServerVersion(dataDir: string): string | null {
  try { return stableVersion(readFileSync(join(dataDir, VERSION_FILE), 'utf8')); } catch { return null; }
}

function writeServerVersion(dataDir: string, version: string): void {
  const file = join(dataDir, VERSION_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${version}\n`);
  renameSync(tmp, file);
}

/** Remember this server build. A newer build keeps a quit snapshot, or arms an update reminder. */
export function syncServerVersion(dataDir: string, serverVersion: string): void {
  const server = stableVersion(serverVersion);
  if (!server) return;
  const previous = readServerVersion(dataDir);
  const notice = readReconnectNotice(dataDir);
  if (notice && (!stableVersion(notice.fromVersion) || compareVersions(server, notice.fromVersion) <= 0)) acknowledgeReconnect(dataDir);
  else if (!notice && previous && compareVersions(server, previous) > 0) armReconnectNotice(dataDir, { reason: 'update', fromVersion: previous, clients: [] });
  writeServerVersion(dataDir, server);
}

export function loadReconnectChecklist(dataDir: string, serverVersion: string, live: ReconnectClient[] = []): ReconnectChecklist {
  return reconnectChecklist(serverVersion, live, readReconnectNotice(dataDir));
}

/** Return the checklist the user was shown, then drop the one-shot reminder. */
export function takeReconnectChecklist(dataDir: string, serverVersion: string, live: ReconnectClient[] = []): ReconnectChecklist {
  const shown = loadReconnectChecklist(dataDir, serverVersion, live);
  if (shown.pending) acknowledgeReconnect(dataDir);
  return { ...shown, pending: false };
}

export function clientsFromSessions(items: { id: string; name: string; actor: string; kind: string; clientVersion?: string; live: boolean }[]): ReconnectClient[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    actor: item.actor,
    kind: item.kind,
    ...(item.clientVersion ? { version: item.clientVersion } : {}),
    live: item.live,
  }));
}
