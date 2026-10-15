// Example hud renderer module — a bullet chart: value vs target, with warn/error bands behind it.
//
// Drop a file like this in views/ and set a monitor to  display: "view:bullet".
// Export `render(ctx)` (or a default function). ctx = { item, w, h, helpers, hit }.
// Draw with helpers.svg(...) so it inherits the house style; call hit(px, py, value, label) per point.

function fallbackFmt(v) {
  return v === null || v === undefined ? '—' : String(v);
}

export function render(ctx) {
  const { item, w, h, helpers, hit } = ctx;
  const f = helpers?.fmt ?? fallbackFmt;
  const cl = helpers?.clamp ?? ((n, a, b) => Math.max(a, Math.min(b, n)));
  const es = helpers?.esc ?? ((s) => String(s ?? ''));
  const W = Math.max(80, w);
  const H = Math.max(50, h);
  const L = 8;
  const R = 8;
  const T = H * 0.32;
  const B = 18;

  const value = Number(item.value);
  const max = Number(item.max) || Math.max(Number(item.value) || 0, Number(item.errorAbove) || 0, 1);
  const X = (v) => L + cl(v / max, 0, 1) * (W - L - R);

  // background bands from the monitor's own thresholds
  const band = (a, b, op) =>
    Number.isFinite(a) && Number.isFinite(b) && b > a
      ? `<rect x="${X(a).toFixed(1)}" y="${(T - 8).toFixed(1)}" width="${(X(b) - X(a)).toFixed(1)}" height="16" fill="rgba(255,255,255,${op})"/>`
      : '';
  const bands =
    band(0, Number(item.warnAbove)) +
    band(Number(item.warnAbove), Number(item.errorAbove), 0.16) +
    band(Number(item.warnBelow), Number(item.warnAbove) || max, 0.04);

  const bar = Number.isFinite(value)
    ? `<rect x="${L}" y="${(T - 2).toFixed(1)}" width="${(X(value) - L).toFixed(1)}" height="4" fill="#fff"/>`
    : '';
  const target =
    item.target != null || item.meta?.target != null
      ? `<line x1="${X(Number(item.meta?.target ?? item.target)).toFixed(1)}" x2="${X(Number(item.meta?.target ?? item.target)).toFixed(1)}" y1="${(T - 12).toFixed(1)}" y2="${(T + 8).toFixed(1)}" stroke="#fff" stroke-width="2"/>`
      : '';

  if (Number.isFinite(value)) hit(X(value), T, value, item.label || item.title || 'value');

  const body = `
    ${bands}
    <text x="${L}" y="12" fill="#e8e8e8" font-size="10">${es(item.label ?? item.title ?? '')}</text>
    <text x="${(W - R).toFixed(1)}" y="12" text-anchor="end" fill="#8c8c8c" font-size="10">${es(f(value))}/${es(f(max))}</text>
    ${bar}${target}
    <line x1="${L}" x2="${W - R}" y1="${(B > 0 ? H - B : H - 4).toFixed(1)}" y2="${H - 4}" stroke="#333"/>`;

  return helpers?.svg
    ? helpers.svg({ id: item.id, h: item.h }, 'bullet', W, H, body, null)
    : `<svg class="v bullet" viewBox="0 0 ${W} ${H}" width="100%" height="100%">${body}</svg>`;
}
