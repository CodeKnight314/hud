import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Store } from './store.ts';
import type { HudEvent, Item, MonitorResult, MonitorSource } from './types.ts';

/**
 * Runs automatic monitors: command (shell), http (fetch), probe (TS/JS module in probes/).
 *
 * Probe module shape (any of):
 *   export default async function (ctx) { return { value, state, message, progress } }   // polled every `interval`
 *   export async function watch(ctx) { ...; ctx.emit({...}); return () => cleanup() }   // long-lived link to an external process
 *   export const interval = 10   // default poll interval in seconds
 */
export interface ProbeContext {
  config: Record<string, unknown>;
  item: Item;
  signal: AbortSignal;
  emit: (r: MonitorResult) => void;
  log: (...args: unknown[]) => void;
}

interface Running {
  key: string;
  stop: () => void;
  run?: () => Promise<void>;
}

const ACTOR = 'hud';
const MAX_TIMER_S = 86400;

/** finite number clamped to [min, max], else the default */
function clampSec(n: unknown, def: number, min: number, max: number) {
  const v = Number(n);
  return Number.isFinite(v) && n !== '' && n !== null ? Math.min(Math.max(v, min), max) : def;
}

export class Engine {
  store: Store;
  probesDir: string;
  running = new Map<string, Running>();

  constructor(store: Store, probesDir: string) {
    this.store = store;
    this.probesDir = probesDir;
  }

  start() {
    for (const it of this.store.items({ type: 'monitor' })) this.sync(it);
    this.store.on('event', (e: HudEvent) => {
      if (e.kind === 'item' && e.item.type === 'monitor') this.sync(e.item);
      if (e.kind === 'item.deleted') this.stop(e.id);
      if (e.kind === 'board.deleted') for (const id of this.running.keys()) if (!this.store.state.items[id]) this.stop(id);
    });
  }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  private stop(id: string) {
    const r = this.running.get(id);
    this.running.delete(id);
    try {
      r?.stop();
    } catch (e) {
      console.error(`[hud] stopping monitor ${id}:`, errMsg(e));
    }
  }

  async runNow(id: string) {
    const r = this.running.get(id);
    if (!r?.run) throw new Error(`monitor ${id} is not an automatic (command/http/probe) monitor`);
    await r.run();
  }

  private sync(item: Item) {
    const src = item.source ?? { kind: 'manual' };
    const auto = src.kind === 'command' || src.kind === 'http' || src.kind === 'probe';
    const key = auto ? JSON.stringify(src) : '';
    const cur = this.running.get(item.id);
    if (cur?.key === key) return;
    this.stop(item.id);
    if (!auto) return;
    this.running.set(item.id, this.launch(item.id, src, key));
  }

  private emit(id: string, r: MonitorResult) {
    if (!this.store.state.items[id]) return;
    try {
      this.store.push(id, r, ACTOR);
    } catch (e) {
      console.error(`[hud] monitor ${id}:`, errMsg(e));
      // a rejected reading must still be visible on the monitor
      try {
        this.store.push(id, { state: 'error', message: `invalid reading: ${errMsg(e)}`.slice(0, 500) }, ACTOR);
      } catch {}
    }
  }

  private launch(id: string, src: MonitorSource, key: string): Running {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let inflight: Promise<void> | null = null;
    let cleanup: (() => void) | undefined;
    let watching = false;
    let interval = clampSec(src.interval, 30, 1, MAX_TIMER_S);
    const timeoutMs = clampSec(src.timeout, 30, 1, 3600) * 1000;

    const exec1 = async () => {
      const runAc = new AbortController();
      const onAbort = () => runAc.abort();
      ac.signal.addEventListener('abort', onAbort, { once: true });
      try {
        let r: MonitorResult | void;
        if (src.kind === 'probe') {
          const mod = await this.loadProbe(src.probe!);
          if (ac.signal.aborted) return;
          if (typeof mod.interval === 'number' && !src.interval) interval = clampSec(mod.interval, 30, 1, MAX_TIMER_S);
          if (typeof mod.watch === 'function' && !watching) {
            const c = await withTimeout(
              Promise.resolve().then(() => mod.watch(this.ctx(id, src, ac.signal))),
              timeoutMs,
              runAc,
              'watch failed: ',
            ).catch((e) => {
              throw new Error(e?.message?.startsWith('watch failed') ? e.message : `watch failed: ${errMsg(e)}`);
            });
            watching = true;
            if (typeof c === 'function') cleanup = c;
            if (ac.signal.aborted) {
              try {
                cleanup?.();
              } catch {}
              return;
            }
          }
          const fn = mod.default ?? mod.poll;
          if (typeof fn !== 'function') {
            if (typeof mod.watch !== 'function') throw new Error('probe has no default/poll/watch export');
            return; // event-driven only
          }
          r = await withTimeout(Promise.resolve().then(() => fn(this.ctx(id, src, runAc.signal))), timeoutMs, runAc);
        } else if (src.kind === 'command') {
          r = await runCommand(src, timeoutMs, ac.signal);
        } else {
          r = await runHttp(src, timeoutMs, ac.signal);
        }
        if (r && !ac.signal.aborted) this.emit(id, r);
      } catch (e) {
        if (!ac.signal.aborted) this.emit(id, { state: 'error', message: errMsg(e).slice(0, 500) });
      } finally {
        ac.signal.removeEventListener('abort', onAbort);
        const it = this.store.state.items[id];
        if (it && !ac.signal.aborted) it.lastRun = Date.now();
      }
    };

    // concurrent callers (loop + manual run) share one in-flight run
    const run = () => {
      if (ac.signal.aborted) return Promise.resolve();
      if (!inflight) inflight = exec1().finally(() => (inflight = null));
      return inflight;
    };

    const loop = async () => {
      try {
        await run();
      } catch (e) {
        console.error(`[hud] monitor ${id}:`, errMsg(e));
      }
      if (!ac.signal.aborted) timer = setTimeout(loop, interval * 1000);
    };

    timer = setTimeout(loop, 50);

    return {
      key,
      run,
      stop: () => {
        ac.abort();
        if (timer) clearTimeout(timer);
        try {
          const c = cleanup;
          cleanup = undefined;
          Promise.resolve(c?.()).catch(() => {});
        } catch {}
      },
    };
  }

  private ctx(id: string, src: MonitorSource, signal: AbortSignal): ProbeContext {
    return {
      config: src.config ?? {},
      item: structuredClone(this.store.state.items[id]),
      signal,
      emit: (r) => {
        if (!signal.aborted) this.emit(id, r);
      },
      log: (...a) => console.log(`[probe ${id}]`, ...a),
    };
  }

  private resolveProbe(name: string) {
    if (isAbsolute(name)) return name;
    if (name.includes('..')) throw new Error('probe name may not contain ..');
    for (const ext of ['', '.ts', '.js', '.mjs']) {
      const p = join(this.probesDir, name + ext);
      if (existsSync(p) && statSync(p).isFile()) return p;
    }
    throw new Error(`probe "${name}" not found in ${this.probesDir}`);
  }

  private async loadProbe(name: string) {
    const file = this.resolveProbe(name);
    const url = pathToFileURL(file).href + '?v=' + statSync(file).mtimeMs;
    return await import(url);
  }
}

/** a cause-aware message: fetch/network errors keep their code, aborts say so */
function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === 'TimeoutError') return 'timed out';
  const c: any = (e as any).cause;
  if (c && typeof c === 'object') {
    const why = [c.code, c.message].filter(Boolean).join(' ');
    if (why && !e.message.includes(why)) return `${e.message}: ${why}`;
  }
  return e.message;
}

/** rejects after ms and aborts `ac` so the probe's ctx.signal fires */
function withTimeout<T>(p: Promise<T>, ms: number, ac?: AbortController, prefix = ''): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      rej(new Error(`${prefix}timed out after ${ms / 1000}s`));
      ac?.abort();
    }, ms);
    p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)));
  });
}

const RESULT_KEYS = ['value', 'state', 'message', 'progress', 'unit', 'label', 'monitors'];

function asResult(text: string): any | null {
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && !Array.isArray(j) && RESULT_KEYS.some((k) => k in j)) return j;
  } catch {}
  return null;
}

/** stdout may be a JSON MonitorResult (whole output or last line), or plain text whose last line becomes the value. exit≠0 → error. */
export function parseOutput(stdout: string, stderr: string, code: number | null): MonitorResult {
  const out = stdout.trim();
  const lines = out.split('\n').filter((l) => l.trim());
  const why = () => (stderr.trim().split('\n').pop() || `exit ${code}`).slice(0, 500);
  let j = asResult(out);
  if (!j && lines.length > 1) j = asResult(lines[lines.length - 1].trim());
  if (j) {
    if (code && !j.state) j.state = 'error';
    if (code && !j.message) j.message = why();
    if (typeof j.message === 'string') j.message = j.message.slice(0, 2000);
    return j;
  }
  const last = lines[lines.length - 1]?.trim() ?? '';
  const num = Number(last);
  const r: MonitorResult = { value: last === '' ? null : Number.isFinite(num) ? num : last.slice(0, 500) };
  if (code) {
    r.state = 'error';
    r.message = why();
  } else {
    r.message = lines.length > 1 ? lines[lines.length - 2].slice(0, 500) : '';
  }
  return r;
}

const WIN = process.platform === 'win32';
const MAX_OUT = 1 << 20;

/** children must not inherit the server's own launch plumbing */
function childEnv() {
  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'HUD_SHIM', 'HUD_RESOURCES', 'HUD_SOURCE_ROOT', 'HUD_CLI_ENTRY']) delete env[k];
  return env;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (WIN) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } catch {}
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  }, 2000).unref();
}

function runCommand(src: MonitorSource, timeoutMs: number, signal: AbortSignal): Promise<MonitorResult> {
  return new Promise((resolve) => {
    let cwd = src.cwd || undefined;
    if (cwd && (cwd === '~' || cwd.startsWith('~/'))) cwd = join(homedir(), cwd.slice(1));
    if (cwd && !(existsSync(cwd) && statSync(cwd).isDirectory())) return resolve({ state: 'error', message: `cwd not found: ${cwd}` });
    if (signal.aborted) return resolve({});

    let done = false;
    let out = '';
    let err = '';
    let size = 0;
    let why = '';
    let child: ReturnType<typeof spawn>;
    const finish = (r: MonitorResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const kill = (reason: string) => {
      why ||= reason;
      killTree(child?.pid);
    };
    const onAbort = () => {
      kill('aborted');
      finish({});
    };
    const timer = setTimeout(() => {
      kill('timeout');
      finish({ state: 'error', message: `timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    try {
      child = WIN
        ? spawn(src.command!, { cwd, shell: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        : spawn('/bin/sh', ['-c', src.command!], { cwd, detached: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ state: 'error', message: errMsg(e) });
    }
    signal.addEventListener('abort', onAbort, { once: true });
    const take = (which: 'o' | 'e') => (d: Buffer) => {
      size += d.length;
      if (size > MAX_OUT) return kill('output');
      if (which === 'o') out += d.toString();
      else err += d.toString();
    };
    child.stdout?.on('data', take('o'));
    child.stderr?.on('data', take('e'));
    child.on('error', (e) => finish({ state: 'error', message: errMsg(e).slice(0, 500) }));
    child.on('close', (code, sig) => {
      if (why === 'output') return finish({ state: 'error', message: 'output exceeded 1 MiB' });
      if (sig) {
        const m = err.trim().split('\n').pop();
        return finish({ state: 'error', message: `killed by ${sig}${m ? `: ${m}` : ''}`.slice(0, 500) });
      }
      finish(parseOutput(out, err, code ?? 1));
    });
  });
}

export function dig(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const k of path.split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

async function readBody(res: Response, max: number, limitError: boolean): Promise<string> {
  const rd = res.body?.getReader();
  if (!rd) return '';
  const dec = new TextDecoder();
  let n = 0;
  let s = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await rd.cancel().catch(() => {});
      if (limitError) throw new Error(`response larger than ${max} bytes`);
      break;
    }
    s += dec.decode(value, { stream: true });
  }
  return s;
}

async function runHttp(srcIn: MonitorSource, timeoutMs: number, signal: AbortSignal): Promise<MonitorResult> {
  const src = srcIn as MonitorSource & { headers?: Record<string, string>; body?: string; contains?: string; maxBytes?: number };
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  const t0 = performance.now();
  try {
    const method = src.method || 'GET';
    const res = await fetch(src.url!, {
      method,
      headers: src.headers,
      body: src.body !== undefined && method !== 'GET' && method !== 'HEAD' ? src.body : undefined,
      signal: AbortSignal.any([signal, timeoutSig]),
    });
    const maxBytes = clampSec(src.maxBytes, 5 << 20, 1, 1 << 30);
    const needBody = !!(src.jsonPath || src.contains);
    const text = await readBody(res, maxBytes, needBody);
    const ms = Math.round(performance.now() - t0);
    const okStatus = src.expectStatus ? res.status === src.expectStatus : res.ok;
    const message = `${res.status} ${res.statusText}`.trim();
    if (src.contains && !text.includes(src.contains)) return { state: 'error', message: `${message} · body does not contain "${src.contains.slice(0, 80)}"` };
    if (src.jsonPath) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { state: 'error', message: `${message} · response is not JSON (jsonPath "${src.jsonPath}")` };
      }
      let v = dig(body, src.jsonPath);
      if (v === undefined) return { state: 'error', message: `${message} · jsonPath "${src.jsonPath}" not found in response` };
      if (v !== null && typeof v === 'object') v = JSON.stringify(v);
      return { value: v as MonitorResult['value'], state: okStatus ? undefined : 'error', message: `${message} · ${ms}ms` };
    }
    return { value: ms, unit: 'ms', state: okStatus ? undefined : 'error', message };
  } catch (e) {
    if (timeoutSig.aborted && !signal.aborted) throw new Error(`timed out after ${timeoutMs / 1000}s`);
    throw e;
  }
}
