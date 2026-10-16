import { spawn } from 'node:child_process';
import { renderInvocation } from './electron-runtime.ts';

export interface RenderResult { image: { mimeType: 'image/png'; data: string }; errors: string[]; diagnostics?: Record<string, unknown> }
let busy = false;
const queue: { run: () => void }[] = [];
const active = new Set<() => void>();
process.once('exit', () => { for (const stop of active) stop(); });

export function capturePage(url: string, mode: 'page' | 'program' = 'page'): Promise<RenderResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.port || parsed.username || parsed.password) return Promise.reject(new Error('capture requires an explicit loopback URL'));
  if (queue.length >= 4) return Promise.reject(new Error('render queue is full'));
  return new Promise((resolve, reject) => {
    const run = () => {
      busy = true;
      const invocation = renderInvocation();
      const finish = (error?: Error, result?: RenderResult) => {
        busy = false;
        if (error) reject(error); else resolve(result!);
        queue.shift()?.run();
      };
      if (!invocation) { finish(new Error('Electron rendering runtime is unavailable')); return; }
      const env = { ...invocation.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.HUD_ALERT_CMD;
      const child = spawn(invocation.cmd, invocation.prefix, { env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const stop = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); } };
      active.add(stop);
      const chunks: Buffer[] = []; let bytes = 0, stderr = '', settled = false;
      const done = (error?: Error, result?: RenderResult) => { if (settled) return; settled = true; active.delete(stop); clearTimeout(timer); finish(error, result); };
      const timer = setTimeout(() => { stop(); done(new Error('render timed out after 15 seconds')); }, 15_000);
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { stop(); done(new Error('render response exceeds 16 MiB')); } else chunks.push(chunk); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
      child.on('error', error => done(error));
      child.stdin.on('error', () => {});
      child.on('close', code => {
        if (settled) return;
        if (code) { done(new Error(`render helper failed (${code}): ${stderr.slice(-1000)}`)); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8').trim()) as RenderResult;
          if (!result.image?.data || result.image.mimeType !== 'image/png' || !Array.isArray(result.errors)) throw new Error('invalid render response');
          done(undefined, result);
        } catch (error) { done(new Error(`invalid capture: ${(error as Error).message}`)); }
      });
      child.stdin.end(JSON.stringify({ url, mode, width: 1600, height: 1040 }));
    };
    if (busy) queue.push({ run }); else run();
  });
}
