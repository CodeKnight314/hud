// Is a TCP port accepting connections? value = connect time in ms.
// source: { kind: "probe", probe: "tcp", config: { host: "127.0.0.1", port: 5432 } }
import { connect } from 'node:net';

export const interval = 30;

export default function (ctx: any) {
  const host = String(ctx.config.host ?? '');
  const port = Number(ctx.config.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('config.host and config.port (1-65535) are required');
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = connect({ host, port, signal: ctx.signal });
    const fail = (e: Error) => {
      s.destroy();
      const code = (e as any).code;
      resolve({ state: 'error', message: `${host}:${port} ${code ?? e.message}` });
    };
    s.setTimeout(10000, () => fail(new Error('timeout')));
    s.once('error', fail);
    s.once('connect', () => {
      const ms = Math.round(performance.now() - t0);
      s.destroy();
      resolve({ value: ms, unit: 'ms', state: 'ok', message: `${host}:${port} open` });
    });
  });
}
