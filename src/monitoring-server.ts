import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Engine } from './engine.ts';
import { Store, HudError } from './store.ts';
import type { State, ProgramSpec, Item } from './types.ts';
import { metricReading, pipelineView, comparisonResults, readout, readoutText } from './monitoring.ts';
import { cleanProgram, programDocument, PROGRAM_CSP } from './programs.ts';
import { capturePage } from './render.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, matches: string[], query: URLSearchParams) => unknown;
interface Context {
  route(method: string, path: string, handler: Handler): void;
  store: Store;
  engine: Engine;
  port: number;
  readObj(req: IncomingMessage, max?: number): Promise<Record<string, any>>;
  actorOf(req: IncomingMessage, body?: unknown): string;
  send(res: ServerResponse, status: number, body: unknown, type?: string): void;
  shutdown(): void;
}
interface Session { id: string; scope: 'item' | 'board'; target: string; board: string; program: ProgramSpec; revision: string; readonly: boolean; actor: string; expires: number; frozen?: State; captureNow?: number; running: number }

export function publicState(store: Store, board?: string, at = Date.now()) {
  return {
    now: at,
    boards: store.boards().map(b => ({ ...Store.boardLite(b), comparisonResults: comparisonResults(b, store.state.items, at) })),
    items: store.items({ board }).map(i => ({ ...Store.lite(i), readout: metricReading(i, at), pipelineView: pipelineView(i, store.state.items, at) })),
    activity: store.activity(150, board), alerts: store.alerts().slice(-50), readout: readout(store.state, board, at),
  };
}

export function registerMonitoring(ctx: Context) {
  const { route, store, engine, readObj, actorOf, send } = ctx;
  const captures = new Map<string, { expires: number; state: State; public: ReturnType<typeof publicState> }>();
  const sessions = new Map<string, Session>();
  const previews = new Map<string, string>();
  const base = `http://127.0.0.1:${ctx.port}`;
  const decode = (s: string) => decodeURIComponent(s);
  const prune = () => {
    const now = Date.now();
    for (const [id, value] of captures) if (value.expires < now) captures.delete(id);
    for (const [id, value] of sessions) if (value.expires < now) sessions.delete(id);
    for (const [id, session] of previews) if (!sessions.has(session)) previews.delete(id);
  };
  const checkedProgram = (value: unknown) => {
    try { return cleanProgram(value); } catch (error) { throw new HudError(400, (error as Error).message); }
  };
  const getSession = (id: string) => {
    prune();
    const session = sessions.get(id);
    if (!session) throw new HudError(404, 'program session expired');
    if (!session.readonly) {
      const target = session.scope === 'board' ? store.requireBoard(session.target) : store.get(session.target);
      if (target.program?.disabled || target.program?.revision !== session.revision) throw new HudError(409, 'program disabled or revision changed');
      session.expires = Date.now() + 10 * 60_000;
    }
    return session;
  };
  const sessionData = (session: Session) => {
    const state = session.frozen ?? store.state;
    const now = session.captureNow ?? Date.now();
    const bound = Object.fromEntries(session.program.bindings.filter(id => Object.hasOwn(state.items, id)).map(id => [id, state.items[id]!])) as Record<string, Item>;
    const items = Object.values(bound)
      .map(i => ({ ...metricReading(i, now), data: i.data, history: i.history, pipelineView: pipelineView(i, bound, now) }));
    return { now, items, byId: Object.fromEntries(items.map(i => [i.id, i])), annotations: (state.boards.find(b => b.id === session.board)?.annotations ?? []).filter(a => !a.deletedAt) };
  };
  const makeSession = (scope: 'board' | 'item', id: string, program: ProgramSpec, revision: string, actor: string, readonly: boolean, frozen?: State, at?: number) => {
    prune();
    if (sessions.size >= 100) throw new HudError(429, 'too many active custom program sessions');
    const state = frozen ?? store.state;
    const target = scope === 'board' ? state.boards.find(b => b.id === id) : state.items[id];
    if (!target) throw new HudError(404, 'program target not found');
    const board = scope === 'board' ? id : (target as Item).board;
    const session: Session = { id: randomUUID(), scope, target: id, board, program, revision, readonly, actor, expires: Date.now() + 10 * 60_000, frozen, running: 0 };
    if (at) session.captureNow = at;
    sessions.set(session.id, session);
    return session;
  };
  const sessionReply = (session: Session) => ({ sessionId: session.id, frameUrl: `/api/program-frame/${session.id}`, readonly: session.readonly, description: session.program.description, revision: session.revision });

  route('GET', '/api/readout', (_req, _res, _m, q) => { const result = store.readout(q.get('board') || undefined); return { ...result, text: readoutText(result) }; });
  route('GET', '/api/boards/:id/lint', (_req, _res, [id]) => store.lint(decode(id!)));
  route('GET', '/api/boards/:id/dashboard', (_req, _res, [id]) => store.requireBoard(decode(id!)).dashboard ?? null);
  route('PUT', '/api/boards/:id/dashboard', async (req, _res, [id]) => {
    const body = await readObj(req);
    return store.applyDashboard(decode(id!), body.spec, actorOf(req, body), { dryRun: body.dryRun, expectedRevision: body.expectedRevision });
  });
  for (const kind of ['annotations', 'comparisons'] as const) {
    route('GET', `/api/boards/:id/${kind}`, (_req, _res, [id]) => {
      const board = store.requireBoard(decode(id!));
      const results = comparisonResults(board, store.state.items);
      return kind === 'annotations' ? (board.annotations ?? []).filter(a => !a.deletedAt) : (board.comparisons ?? []).filter(r => !r.deletedAt).map(rule => { const result = results.find(r => r.id === rule.id); return { ...rule, state: result?.state, reason: result?.reason, result }; });
    });
    route('POST', `/api/boards/:id/${kind}`, async (req, _res, [id]) => {
      const body = await readObj(req), actor = actorOf(req, body);
      return kind === 'annotations' ? store.annotate(decode(id!), body as any, actor) : store.compare(decode(id!), body as any, actor);
    });
    route('DELETE', `/api/boards/:id/${kind}`, async (req, _res, [id]) => {
      const body = await readObj(req);
      return store.deleteBoardRecord(decode(id!), kind, String(body.id), actorOf(req, body));
    });
  }

  route('POST', '/api/snapshot', async req => {
    const body = await readObj(req), board = store.requireBoard(body.board ?? 'main').id;
    const format = body.format ?? 'auto';
    if (!['auto', 'png', 'text'].includes(format)) throw new HudError(400, 'snapshot format must be auto|png|text');
    const now = Date.now(), frozen = structuredClone(store.state), projection = structuredClone(publicState(store, board, now));
    const lines = projection.items.map(i => `${i.id} (${i.x},${i.y}) ${i.w}×${i.h} ${i.display ?? i.type}`);
    const custom = frozen.boards.find(b => b.id === board)?.program;
    const text = `${board} — captured ${new Date(now).toISOString()}\n${readoutText(readout(frozen, board, now))}\n\nLayout:\n${lines.join('\n')}${custom && !custom.disabled ? `\nCustom canvas: ${custom.description}. Text describes bindings; custom pixels are not represented here.` : ''}`;
    const response = { board, capturedAt: now, text, warnings: [] as string[], imageUnavailable: undefined as string | undefined, image: undefined as { mimeType: 'image/png'; data: string } | undefined };
    if (format === 'text') return response;
    prune();
    if (captures.size >= 32) throw new HudError(429, 'too many captures queued');
    const token = randomUUID();
    captures.set(token, { state: frozen, public: projection, expires: now + 120_000 });
    try {
      const result = await capturePage(`${base}/?board=${encodeURIComponent(board)}&capture=${token}`);
      response.image = result.image;
      response.warnings.push(...result.errors);
    } catch (error) {
      if (format === 'png') throw new HudError(503, (error as Error).message);
      response.imageUnavailable = (error as Error).message;
      response.warnings.push('Image unavailable; only text/layout data was inspected.');
    } finally {
      captures.delete(token);
      for (const [id, session] of sessions) if (session.frozen === frozen) sessions.delete(id);
    }
    return response;
  });
  route('GET', '/api/captures/:id', (_req, _res, [id]) => {
    prune(); const capture = captures.get(decode(id!));
    if (!capture) throw new HudError(404, 'capture expired');
    return capture.public;
  });

  for (const scope of ['board', 'item'] as const) {
    const path = scope === 'board' ? '/api/boards/:id/program' : '/api/items/:id/program';
    route('GET', path, (_req, _res, [id]) => {
      const target = scope === 'board' ? store.requireBoard(decode(id!)) : store.get(store.resolveId(decode(id!)));
      return { program: target.program ?? null, draft: target.programDraft ?? null };
    });
    route('DELETE', path, async (req, _res, [id]) => { const body = await readObj(req); return store.setProgram(scope, decode(id!), null, actorOf(req, body), body.expectedRevision); });
    route('POST', path, async (req, _res, [rawId]) => {
      const id = scope === 'board' ? decode(rawId!) : store.resolveId(decode(rawId!));
      const target = scope === 'board' ? store.requireBoard(id) : store.get(id);
      if (scope === 'item' && (target as Item).type !== 'monitor') throw new HudError(400, 'custom graph cards must be monitors');
      const originalRevision = target.program?.revision;
      const body = await readObj(req), actor = actorOf(req, body);
      if (body.expectedRevision !== undefined && body.expectedRevision !== target.program?.revision) throw new HudError(409, 'program revision changed');
      if (body.action === 'disable') return store.setProgram(scope, id, null, actor, body.expectedRevision);
      if (!['preview', 'apply'].includes(body.action)) throw new HudError(400, 'program action must be preview|apply|disable');
      const program = checkedProgram(body.program);
      for (const binding of program.bindings) store.get(binding);
      const assertRevision = () => {
        const current = scope === 'board' ? store.requireBoard(id) : store.get(id);
        if (current.program?.revision !== originalRevision) throw new HudError(409, 'program changed during validation');
      };
      const frozen = structuredClone(store.state), token = randomUUID();
      const session = makeSession(scope, id, program, token, actor, true, frozen, Date.now());
      previews.set(token, session.id);
      let result;
      try { result = await capturePage(`${base}/api/program-preview/${token}`, 'program'); }
      catch (error) { if (body.action === 'apply') { assertRevision(); store.saveProgramDraft(scope, id, program, [(error as Error).message], actor); } throw new HudError(503, `program remains unpublished: ${(error as Error).message}`); }
      finally { previews.delete(token); sessions.delete(session.id); }
      if (body.action === 'preview') return { valid: !result.errors.length, image: result.image, errors: result.errors, warnings: ['Rendering validates execution, not the correctness of custom calculations.'] };
      assertRevision();
      if (result.errors.length) { store.saveProgramDraft(scope, id, program, result.errors, actor); throw new HudError(400, `program did not validate: ${result.errors.join('; ')}`); }
      return store.setProgram(scope, id, program, actor, body.expectedRevision);
    });
  }
  route('GET', '/api/program-preview/:id', (_req, res, [id]) => {
    if (!previews.has(decode(id!))) throw new HudError(404, 'preview expired');
    send(res, 200, '<!doctype html><html><head><meta charset="utf-8"><style>html,body,#program{margin:0;width:100%;height:100%;background:#080808;color:#eee}</style></head><body><div id="program"></div><script type="module" src="/program-preview.js"></script></body></html>', 'text/html; charset=utf-8');
  });
  route('GET', '/api/program-previews/:id', (_req, _res, [id]) => {
    const session = previews.get(decode(id!)); if (!session) throw new HudError(404, 'preview expired');
    return sessionReply(getSession(session));
  });
  route('POST', '/api/program-sessions', async req => {
    const body = await readObj(req);
    if (!['board', 'item'].includes(body.scope) || typeof body.id !== 'string') throw new HudError(400, 'program scope and id are required');
    prune();
    const frozen = body.captureToken ? captures.get(body.captureToken) : undefined;
    if (body.captureToken && !frozen) throw new HudError(404, 'capture expired');
    const state = frozen?.state ?? store.state;
    const target = body.scope === 'board' ? state.boards.find(b => b.id === body.id) : Object.hasOwn(state.items, body.id) ? state.items[body.id] : undefined;
    const program = target?.program;
    if (!program || program.disabled) throw new HudError(404, 'custom program is disabled or missing');
    return sessionReply(makeSession(body.scope, body.id, program, program.revision, actorOf(req, body), !!body.readonly || !!frozen, frozen?.state, frozen?.public.now));
  });
  route('GET', '/api/program-frame/:id', (_req, res, [id]) => {
    const session = getSession(decode(id!));
    res.removeHeader('x-frame-options');
    res.setHeader('content-security-policy', PROGRAM_CSP);
    send(res, 200, programDocument(session.program, session.id, sessionData(session)), 'text/html; charset=utf-8');
  });
  route('GET', '/api/program-sessions/:id/data', (_req, _res, [id]) => sessionData(getSession(decode(id!))));
  route('DELETE', '/api/program-sessions/:id', (_req, _res, [id]) => ({ deleted: sessions.delete(decode(id!)) }));
  route('POST', '/api/program-sessions/:id/action', async (req, _res, [id]) => {
    const session = getSession(decode(id!));
    if (session.readonly) throw new HudError(403, 'actions are disabled in preview and capture');
    const body = await readObj(req);
    if (typeof body.operation !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw new HudError(400, 'action requires an operation and argument object');
    const grants = session.program.capabilities.filter(c => c.operation === body.operation);
    if (!grants.length) throw new HudError(403, 'operation is not granted');
    if (session.running >= 4) throw new HudError(429, 'too many concurrent program actions');
    session.running++;
    const actor = `${session.actor} via ${session.program.description}`.slice(0, 40);
    const allow = (board: string) => { if (!grants.some(g => g.scope === '*' || g.scope === board)) throw new HudError(403, 'action is outside the granted board scope'); };
    const global = () => { if (!grants.some(g => g.scope === '*')) throw new HudError(403, 'operation requires an explicit global grant'); };
    const a = body.args;
    const itemId = () => { const item = store.get(store.resolveId(String(a.id))); allow(item.board); return item.id; };
    const boardId = () => { const board = store.requireBoard(a.board ?? session.board); allow(board.id); return board.id; };
    try {
      let result: unknown;
      switch (body.operation) {
        case 'create': {
          const board = a.item?.board ?? session.board; allow(board);
          const frame = a.item?.frame ?? a.item?.in;
          if (frame) allow(store.get(store.resolveId(String(frame))).board);
          result = store.create({ ...a.item, board }, actor); break;
        }
        case 'update': { const id = itemId(); if (a.patch?.board) allow(a.patch.board); result = store.update(id, a.patch, actor); break; }
        case 'push': {
          const validateScope = (id: string, reading: Record<string, any>, fallback: string, depth = 0): string => {
            if (depth > 4 || !reading || typeof reading !== 'object' || Array.isArray(reading)) throw new HudError(400, 'invalid fan-out reading');
            const board = Object.hasOwn(store.state.items, id) ? store.state.items[id]!.board : reading.board ?? fallback;
            allow(board);
            const frame = reading.frame ?? reading.in;
            if (frame) allow(store.get(store.resolveId(String(frame))).board);
            if (reading.monitors && typeof reading.monitors === 'object') for (const [child, result] of Object.entries(reading.monitors)) validateScope(child, result as Record<string, any>, board, depth + 1);
            return board;
          };
          const id = String(a.id), board = validateScope(id, a.reading, session.board);
          result = store.push(id, { ...a.reading, board }, actor); break;
        }
        case 'remove': result = store.remove(itemId(), actor); break;
        case 'restore': case 'purge': {
          if (a.id === 'all') global(); else {
            const entries = store.trash().filter(e => e.item.id === a.id);
            if (!entries.length) throw new HudError(404, 'trash entry not found');
            if (body.operation === 'purge') for (const entry of entries) allow(entry.item.board);
            else allow(entries[0]!.item.board);
          }
          result = body.operation === 'restore' ? store.restore(String(a.id), actor) : store.purge(String(a.id), actor); break;
        }
        case 'createBoard': global(); result = store.createBoard(a.name, actor); break;
        case 'setBoard': result = store.setBoard(boardId(), a.patch, actor); break;
        case 'clearBoard': result = store.clearBoard(boardId(), actor); break;
        case 'deleteBoard': result = store.deleteBoard(boardId(), actor); break;
        case 'organize': result = store.organize(boardId(), actor); break;
        case 'annotate': result = store.annotate(boardId(), a, actor); break;
        case 'compare': result = store.compare(boardId(), a.rule ?? a, actor); break;
        case 'ackAlerts': {
          const ids = a.ids === 'all' ? store.alerts({ all: true }).filter(alert => grants.some(g => g.scope === '*' || g.scope === alert.board)).map(alert => alert.id) : a.ids;
          if (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== 'number')) throw new HudError(400, 'ids must be an array or all');
          for (const alert of store.alerts({ all: true }).filter(alert => ids.includes(alert.id))) allow(alert.board);
          result = store.ackAlerts(ids); break;
        }
        case 'reviewAttention': result = store.reviewAttention(itemId(), a, actor); break;
        case 'link': result = store.link(itemId(), a.patch, actor); break;
        case 'unlink': {
          if (!Array.isArray(a.keys) || a.keys.some((k: unknown) => !['project', 'parent', 'blockedBy', 'refs'].includes(String(k)))) throw new HudError(400, 'keys must name ticket relationships');
          result = store.link(itemId(), Object.fromEntries(a.keys.map((k: string) => [k, null])), actor); break;
        }
        case 'comment': result = store.comment(itemId(), a.text, actor, a.format); break;
        case 'ask': result = store.ask(itemId(), a, actor); break;
        case 'decide': result = store.decide(itemId(), a.optionId, actor, a.note, a.decisionVersion); break;
        case 'finish': result = store.finish({ ...a, board: boardId() }, actor); break;
        case 'run': { const id = itemId(); await engine.runNow(id); result = Store.lite(store.get(id)); break; }
        case 'importState': global(); if (!['replace', 'merge'].includes(a.mode)) throw new HudError(400, 'import mode must be replace|merge'); result = store.importState(a.state, a.mode, actor); break;
        case 'exportState': global(); result = store.exportState(); break;
        case 'backup': global(); result = store.backup(a.reason); break;
        case 'watch': { const board = boardId(); result = store.setBoard(board, { notify: a.notify }, actor); break; }
        case 'shutdown': global(); setTimeout(ctx.shutdown, 50); result = { stopping: true }; break;
        default: throw new HudError(400, 'unknown management operation');
      }
      store.recordProgramAction(session.board, session.revision, body.operation, actor);
      if (result && typeof result === 'object' && 'type' in result && 'board' in result && 'id' in result) result = Store.lite(result as Item);
      else if (result && typeof result === 'object' && 'width' in result && 'height' in result && 'id' in result) result = Store.boardLite(result as any);
      return { result, revision: session.revision };
    } finally { session.running--; }
  });
}
