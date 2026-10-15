// Percent of a filesystem in use.
// source: { kind: "probe", probe: "disk", config: { path: "/" } }, then set warnAbove/errorAbove on the monitor
import { statfs } from 'node:fs/promises';

export const interval = 60;

export default async function (ctx: any) {
  const path = String(ctx.config.path ?? '/');
  const s = await statfs(path);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  const used = total - s.bfree * s.bsize;
  const pct = total ? Math.round((used / (used + free)) * 1000) / 10 : 0;
  const gb = (n: number) => (n / 1e9).toFixed(1);
  return { value: pct, unit: '%', progress: pct, message: `${path}: ${gb(free)} GB free of ${gb(total)} GB` };
}
