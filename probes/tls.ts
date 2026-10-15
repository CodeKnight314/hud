// Days until a host's TLS certificate expires.
// source: { kind: "probe", probe: "tls", config: { host: "example.com", port: 443, warnDays: 14, errorDays: 3 } }
import { connect } from 'node:tls';

export const interval = 3600;

export default function (ctx: any) {
  const host = String(ctx.config.host ?? '');
  const port = Number(ctx.config.port ?? 443);
  const warnDays = Number(ctx.config.warnDays ?? 14);
  const errorDays = Number(ctx.config.errorDays ?? 3);
  if (!host) throw new Error('config.host is required');
  return new Promise((resolve) => {
    const s = connect({ host, port, servername: host, rejectUnauthorized: false, });
    ctx.signal?.addEventListener('abort', () => s.destroy(), { once: true });
    const fail = (e: Error) => {
      s.destroy();
      resolve({ state: 'error', message: `${host}:${port} ${(e as any).code ?? e.message}` });
    };
    s.setTimeout(10000, () => fail(new Error('timeout')));
    s.once('error', fail);
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate();
      const bad = s.authorizationError ? String(s.authorizationError) : '';
      s.destroy();
      if (!c?.valid_to) return resolve({ state: 'error', message: `${host}:${port} no certificate` });
      const days = Math.floor((Date.parse(c.valid_to) - Date.now()) / 86400000);
      const state = bad || days < errorDays ? 'error' : days < warnDays ? 'warn' : 'ok';
      const message = bad ? `${bad}; expires ${c.valid_to}` : days < 0 ? `expired ${-days}d ago` : `expires in ${days}d (${c.valid_to})`;
      resolve({ value: days, unit: ' days', state, message });
    });
  });
}
