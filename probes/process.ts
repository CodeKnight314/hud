// Is a process running? value = number of matching processes.
// source: { kind: "probe", probe: "process", config: { match: "postgres" }, interval: 10 }
import { execFile } from 'node:child_process';

export const interval = 10;

export default function (ctx: any) {
  const match = String(ctx.config.match ?? '');
  if (!match) throw new Error('config.match is required');
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', match], (_err, stdout) => {
      const n = stdout.split('\n').filter(Boolean).length;
      resolve({ value: n, state: n > 0 ? 'ok' : 'error', message: n ? `${n} running` : `no process matching "${match}"` });
    });
  });
}
