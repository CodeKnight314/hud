// The on-screen canvas letterboxes a fixed 1600×900 board. Layout coordinates do not follow the window.
import assert from 'node:assert/strict';
import { layout, BOARD_WIDTH, BOARD_HEIGHT } from '../src/layout.ts';
import { letterboxBoard, restingView, shouldRefit } from '../web/board-scale.js';

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
assert.equal(cropped.z, fit.z);
assert.deepEqual(cropped, fit);
contained(BOARD_WIDTH, BOARD_HEIGHT, 1064, 796, cropped);
assert.deepEqual(restingView(null, fit), fit);
assert.deepEqual(restingView({ x: 1, y: 2, z: Number.NaN }, fit), fit);
assert.deepEqual(restingView({ x: fit.x, y: fit.y, z: fit.z }, fit), fit);

assert.equal(shouldRefit({ z: fit.z }, fit), true);
assert.equal(shouldRefit({ z: fit.z + 0.2 }, fit), false);
assert.equal(shouldRefit(null, fit), false);

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
