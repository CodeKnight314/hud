// Watches a log file (like `tail -F`) and reports its newest line.
// source: { kind: "probe", probe: "tail", config: { file: "/var/log/app.log", errorPattern: "error|fatal", warnPattern: "warn" } }
import { spawn } from 'node:child_process';

export async function watch(ctx: any) {
  const file = String(ctx.config.file ?? '');
  if (!file) throw new Error('config.file is required');
  const err = new RegExp(String(ctx.config.errorPattern ?? 'error|fatal|panic'), 'i');
  const warn = new RegExp(String(ctx.config.warnPattern ?? 'warn'), 'i');
  const p = spawn('tail', ['-n', '1', '-F', file]);
  p.on('error', (e: Error) => ctx.emit({ state: 'error', message: `tail: ${e.message}` }));
  p.on('exit', (code: number | null, sig: string | null) => {
    if (!ctx.signal.aborted) ctx.emit({ state: 'error', message: `tail exited (${sig ?? code}); re-apply the source to restart` });
  });
  let lines = 0;
  let buf = '';
  p.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      lines++;
      ctx.emit({ value: lines, unit: ' lines', message: line.slice(0, 300), state: err.test(line) ? 'error' : warn.test(line) ? 'warn' : 'ok' });
    }
  });
  p.stderr.on('data', (d: Buffer) => ctx.emit({ state: 'warn', message: d.toString().trim().slice(0, 300) }));
  return () => p.kill();
}
