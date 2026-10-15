// Does a name resolve? value = lookup time in ms.
// source: { kind: "probe", probe: "dns", config: { name: "example.com", type: "A" } }
import { Resolver } from 'node:dns/promises';

export const interval = 60;

export default async function (ctx: any) {
  const name = String(ctx.config.name ?? '');
  const type = String(ctx.config.type ?? 'A').toUpperCase();
  if (!name) throw new Error('config.name is required');
  const t0 = performance.now();
  try {
    const r: any = await new Resolver({ timeout: 5000, tries: 1 }).resolve(name, type as any);
    const ms = Math.round(performance.now() - t0);
    const list = (Array.isArray(r) ? r : [r]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    if (!list.length) return { state: 'error', message: `${name} ${type}: no records` };
    return { value: ms, unit: 'ms', state: 'ok', message: `${name} ${type} → ${list.slice(0, 3).join(', ')}${list.length > 3 ? ` +${list.length - 3}` : ''}` };
  } catch (e: any) {
    return { state: 'error', message: `${name} ${type}: ${e.code ?? e.message}` };
  }
}
