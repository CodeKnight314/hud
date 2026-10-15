// Seconds since a file was last modified (backups, heartbeats, exports).
// source: { kind: "probe", probe: "file-age", config: { path: "/var/backups/db.sql.gz", warnAfter: 90000, errorAfter: 180000 } }
import { stat } from 'node:fs/promises';

export const interval = 60;

export default async function (ctx: any) {
  const path = String(ctx.config.path ?? '');
  if (!path) throw new Error('config.path is required');
  const warnAfter = Number(ctx.config.warnAfter);
  const errorAfter = Number(ctx.config.errorAfter);
  let st;
  try {
    st = await stat(path);
  } catch (e: any) {
    return { state: 'error', message: `${path}: ${e.code ?? e.message}` };
  }
  const age = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
  const h = age >= 86400 ? `${(age / 86400).toFixed(1)}d` : age >= 3600 ? `${(age / 3600).toFixed(1)}h` : age >= 60 ? `${Math.round(age / 60)}m` : `${age}s`;
  const state = Number.isFinite(errorAfter) && age > errorAfter ? 'error' : Number.isFinite(warnAfter) && age > warnAfter ? 'warn' : 'ok';
  return { value: age, unit: 's', state, message: `${path} modified ${h} ago` };
}
