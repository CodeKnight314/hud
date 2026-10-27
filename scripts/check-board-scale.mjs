// The on-screen canvas letterboxes a fixed 1600×900 board. Layout coordinates do not follow the window.
import assert from 'node:assert/strict';
import { layout, BOARD_WIDTH, BOARD_HEIGHT } from '../src/layout.ts';
import { cameraOnBoardOpen, cameraOnPendingOpen, containAxis, letterboxBoard, restingView, shouldRefit, viewAfterViewportChange } from '../web/board-scale.js';

function contained(boardW, boardH, viewW, viewH, view = letterboxBoard(boardW, boardH, viewW, viewH)) {
  assert(view.z > 0 && Number.isFinite(view.x) && Number.isFinite(view.y), view);
  const right = view.x + boardW * view.z;
  const bottom = view.y + boardH * view.z;
  assert(view.x >= -1e-6 && view.y >= -1e-6, `origin ${view.x},${view.y}`);
  assert(right <= viewW + 1e-6 && bottom <= viewH + 1e-6, `overflow ${right},${bottom} in ${viewW}×${viewH}`);
  const slackX = viewW - boardW * view.z;
  const slackY = viewH - boardH * view.z;
  assert(Math.abs(view.x * 2 - slackX) < 1e-6, 'horizontal letterbox is centered');
  assert(Math.abs(view.y * 2 - slackY) < 1e-6, 'vertical letterbox is centered');
  assert(Math.abs((boardW * view.z) / (boardH * view.z) - boardW / boardH) < 1e-9, 'one scale, no stretch');
  return view;
}

const laptop = contained(BOARD_WIDTH, BOARD_HEIGHT, 1064, 796);
assert.equal(laptop.z, 1040 / 1600);
assert.equal(laptop.x, 12);
assert.equal(laptop.y, (796 - 900 * laptop.z) / 2);

const wide = contained(BOARD_WIDTH, BOARD_HEIGHT, 2000, 500);
assert(wide.y < wide.x, 'a short window letterboxes on the sides');
assert(Math.abs(wide.y - 12) < 1e-9);

const tall = contained(BOARD_WIDTH, BOARD_HEIGHT, 700, 1600);
assert(tall.x < tall.y, 'a narrow window letterboxes above and below');
assert(Math.abs(tall.x - 12) < 1e-9);

const desktop = contained(BOARD_WIDTH, BOARD_HEIGHT, 2400, 1400);
assert(desktop.z > 1, 'a larger window scales the board up to fit');

contained(BOARD_WIDTH, BOARD_HEIGHT, 10, 10);
contained(BOARD_WIDTH, BOARD_HEIGHT, 1, 400);
// A missing viewport is treated as 1×1 so the scale stays finite and still contained.
contained(BOARD_WIDTH, BOARD_HEIGHT, 1, 1, letterboxBoard(BOARD_WIDTH, BOARD_HEIGHT, 0, 0));

const fit = letterboxBoard(BOARD_WIDTH, BOARD_HEIGHT, 1064, 796);
const cropped = restingView({ x: -400, y: 0, z: 2 }, fit);
assert.deepEqual(cropped, fit, 'a zoom above the letterbox is discarded');
contained(BOARD_WIDTH, BOARD_HEIGHT, 1064, 796, cropped);
assert.deepEqual(restingView(null, fit), fit);
assert.deepEqual(restingView({ x: 1, y: 2, z: Number.NaN }, fit), fit);
assert.deepEqual(restingView({ x: fit.x, y: fit.y, z: fit.z }, fit), fit);
const kept = restingView({ x: 4, y: 18, z: fit.z - 0.05 }, fit);
assert.deepEqual(kept, { x: 4, y: 18, z: fit.z }, 'a camera under the letterbox keeps its pan and clamps up to fit');
assert.notDeepEqual(kept, cropped);

const centered = (1064 - 1600 * fit.z) / 2;
assert.equal(containAxis(centered, 1600 * fit.z, 1064), centered);
assert.equal(containAxis(4, 1600 * fit.z, 1064), 4, 'pan inside the letterbox bars is kept');
assert.equal(containAxis(-40, 1600 * fit.z, 1064), 0, 'pan that would crop is clamped');
assert.equal(containAxis(80, 1600 * 1.2, 1064), 0, 'zoomed board cannot pan past the near edge');
assert.equal(containAxis(-2000, 1600 * 1.2, 1064), 1064 - 1600 * 1.2, 'zoomed board cannot pan past the far edge');

assert.equal(shouldRefit(fit, fit), true);
assert.equal(shouldRefit({ x: fit.x, y: fit.y, z: fit.z + 0.2 }, fit), false);
assert.equal(shouldRefit({ z: fit.z }, fit), false, 'zoom alone is not the letterbox');
assert.equal(shouldRefit({ x: 4, y: 18, z: fit.z }, fit), false, 'a kept pan is not the letterbox');
assert.equal(shouldRefit(null, fit), false);

const beside = letterboxBoard(BOARD_WIDTH, BOARD_HEIGHT, 1064 - 420, 796);
let camera = { ...fit };
camera = viewAfterViewportChange(camera, fit, beside, 1064 - 420);
assert.deepEqual(camera, beside, 'opening the drawer refits a letterboxed board');
camera = viewAfterViewportChange(camera, beside, fit, 1064);
assert.deepEqual(camera, fit, 'closing the drawer restores the wide letterbox');

const zoomed = { x: -80, y: 20, z: fit.z + 0.35 };
const zoomedOpen = viewAfterViewportChange(zoomed, fit, beside, 1064 - 420);
assert.deepEqual(zoomedOpen, zoomed, 'a zoomed-in camera survives the drawer opening');
const zoomedClose = viewAfterViewportChange(zoomedOpen, beside, fit, 1064);
assert.deepEqual(zoomedClose, zoomed, 'closing the drawer keeps that zoom');

const tiny = letterboxBoard(BOARD_WIDTH, BOARD_HEIGHT, 1, 796);
assert.deepEqual(viewAfterViewportChange(fit, fit, tiny, 1), fit, 'a full-width drawer does not collapse the board');

// Board open keeps a pan, then the drawer closes. A z-only refit would swap in the centered letterbox.
const keptPan = { x: 4, y: 18, z: fit.z - 0.05 };
const opened = cameraOnBoardOpen(keptPan, fit, 1064);
assert.deepEqual(opened, { x: 4, y: 18, z: fit.z }, 'board open keeps a pan and raises zoom to the full window');
assert.deepEqual(viewAfterViewportChange(opened, fit, fit, 1064), opened, 'drawer close after board open keeps that pan');
assert.deepEqual(viewAfterViewportChange(opened, beside, fit, 1064), opened, 'closing a drawer that was open during the switch keeps that pan');

// A zoom between the drawer strip and the full window is legal once the inspector closes.
const midZoom = { x: 30, y: 8, z: (beside.z + fit.z) / 2 };
assert(midZoom.z > beside.z && midZoom.z <= fit.z, 'fixture sits between the covered fit and the wide fit');
assert.deepEqual(restingView(midZoom, beside), beside, 'judging that zoom against the open drawer would drop it');
assert.deepEqual(cameraOnBoardOpen(midZoom, fit, 1064), { x: 30, y: 8, z: fit.z }, 'board open judges the saved camera against the full window');

// List → canvas, or a deep link, settles after the inspector is already open.
// Judging that pending camera against the strip would drop a full-window fit zoom.
const pending = { x: 4, y: 18, z: fit.z };
const besideW = 1064 - 420;
assert.deepEqual(cameraOnBoardOpen(pending, beside, besideW), beside, 'the drawer strip would discard this full-window zoom');
assert.deepEqual(
  cameraOnPendingOpen(pending, fit, beside, true, besideW, 1064),
  { x: 4, y: 18, z: fit.z },
  'pending open with the drawer keeps a full-window pan',
);
assert.deepEqual(
  cameraOnPendingOpen({ ...fit }, fit, beside, true, besideW, 1064),
  beside,
  'a pending centered letterbox refits beside the open drawer',
);
assert.deepEqual(
  cameraOnPendingOpen(midZoom, fit, beside, true, besideW, 1064),
  { x: 30, y: 8, z: fit.z },
  'pending open does not discard a zoom that fits the full window',
);
assert.deepEqual(
  cameraOnPendingOpen(pending, fit, beside, false, besideW, 1064),
  { x: 4, y: 18, z: fit.z },
  'pending open with the drawer closed keeps the pan',
);

const grown = letterboxBoard(BOARD_WIDTH, BOARD_HEIGHT, 1600, 1000);
assert.deepEqual(viewAfterViewportChange(fit, fit, grown, 1600), grown, 'resize refits a centered letterbox');
assert.deepEqual(viewAfterViewportChange(opened, fit, grown, 1600), opened, 'resize keeps a pan at the fit zoom');
assert.deepEqual(viewAfterViewportChange(zoomed, fit, grown, 1600), zoomed, 'resize keeps an in-session zoom');

const items = [
  { id: 'a', type: 'monitor', title: 'a', createdAt: 1, x: 0, y: 0, w: 10, h: 10 },
  { id: 'b', type: 'monitor', title: 'b', createdAt: 2, x: 0, y: 0, w: 10, h: 10, group: 'run' },
  { id: 'f', type: 'frame', title: 'run', createdAt: 3, x: 0, y: 0, w: 10, h: 10 },
];
const placed = layout(items);
letterboxBoard(BOARD_WIDTH, BOARD_HEIGHT, 800, 600);
letterboxBoard(BOARD_WIDTH, BOARD_HEIGHT, 2560, 1440);
assert.deepEqual(layout(items), placed, 'window size does not reflow layout');
for (const rect of placed.values()) {
  assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= BOARD_WIDTH + 1e-7 && rect.y + rect.h <= BOARD_HEIGHT + 1e-7, rect);
}

console.log('PASS board scale: letterbox keeps the 1600×900 layout');
