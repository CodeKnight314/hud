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
 * Camera used when the board opens. A remembered zoom above the letterbox would crop the
 * fixed board, so that camera is replaced by the centered fit. A camera at or under the
 * letterbox keeps its pan, and its zoom is raised to the fit scale.
 */
export function restingView(saved, fit) {
  if (saved && [saved.x, saved.y, saved.z].every(Number.isFinite) && saved.z <= fit.z + 1e-3) {
    return { x: saved.x, y: saved.y, z: fit.z };
  }
  return { ...fit };
}

/** Keep a pan that still shows the whole board, and clamp a zoomed board to the viewport edges. */
export function containAxis(pos, span, view) {
  const p = finite(pos, 0);
  const s = finite(span, 0);
  const v = Math.max(0, finite(view, 0));
  if (s <= v) return Math.min(Math.max(p, 0), v - s);
  return Math.min(Math.max(p, v - s), 0);
}

const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-3;

/** True when the camera is still the centered letterbox. A matching zoom with another pan is a kept camera. */
export function shouldRefit(view, fit) {
  return !!view && !!fit && near(view.z, fit.z) && near(view.x, fit.x) && near(view.y, fit.y);
}

/** Below this visible width a drawer covers the canvas; refitting would collapse the board. */
export const REFIT_MIN_WIDTH = 48;

/**
 * Drawer, resize, or return to the board. A centered letterbox adopts the next letterbox.
 * A kept pan or a zoomed-in camera stays, so closing the drawer cannot recenter it.
 */
export function viewAfterViewportChange(view, previousFit, nextFit, nextViewportW) {
  if (shouldRefit(view, previousFit) && finite(nextViewportW, 0) >= REFIT_MIN_WIDTH) return { ...nextFit };
  return { x: view.x, y: view.y, z: view.z };
}

/**
 * Camera when a board opens. `wide` is the full-window letterbox, including when the
 * inspector still covers the canvas: a zoom that fits the window must not be judged
 * against that narrower strip. The drawer then closes through the same refit, which
 * leaves a kept pan where it is.
 */
export function cameraOnBoardOpen(saved, wide, viewportW) {
  const opened = restingView(saved, wide);
  return viewAfterViewportChange(opened, wide, wide, viewportW);
}

/**
 * Deferred open, once a hidden canvas (ticket list, deep link) has a size.
 * `wide` ignores the inspector. The saved zoom is judged against that full
 * window. If the inspector is already open, a centered letterbox then adopts
 * the strip beside it; a kept pan stays.
 */
export function cameraOnPendingOpen(saved, wide, beside, drawerOpen, besideW, wideW = besideW) {
  const opened = cameraOnBoardOpen(saved, wide, wideW);
  if (!drawerOpen) return opened;
  return viewAfterViewportChange(opened, wide, beside, besideW);
}
