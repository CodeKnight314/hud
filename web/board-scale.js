// Visual fit for the fixed board. Item x/y/w/h stay in board space; only the camera changes.

const finite = (n, fallback) => Number.isFinite(n) ? n : fallback;

/**
 * Uniform contain-fit. `x`/`y` are viewport pixels and `z` is one scale for both axes,
 * so a 1600×900 board letterboxes instead of stretching or reflowing.
 */
export function letterboxBoard(boardW, boardH, viewW, viewH, margin = 12) {
  const bw = Math.max(1, finite(boardW, 1));
  const bh = Math.max(1, finite(boardH, 1));
  const vw = Math.max(1, finite(viewW, 1));
  const vh = Math.max(1, finite(viewH, 1));
  // Drop the margin before it would force the board outside a tiny viewport.
  const pad = Math.max(0, Math.min(margin, Math.floor((Math.min(vw, vh) - 1) / 2)));
  const z = Math.min((vw - pad * 2) / bw, (vh - pad * 2) / bh);
  return { x: (vw - bw * z) / 2, y: (vh - bh * z) / 2, z };
}

/**
 * Camera used when the board opens. A remembered zoom from a larger window sits above
 * this fit and would crop the fixed board, so startup always letterboxes to the current viewport.
 */
export function restingView(saved, fit) {
  if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite) && saved.z > fit.z + 1e-3) return { ...fit };
  return { ...fit };
}

/** True when the camera is still the letterboxed fit, so a viewport change should refit. */
export function shouldRefit(view, fit) {
  return !!view && !!fit && Number.isFinite(view.z) && Number.isFinite(fit.z) && Math.abs(view.z - fit.z) <= 1e-3;
}
