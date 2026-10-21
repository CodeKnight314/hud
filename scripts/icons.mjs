// Generates the app + tray icons with no dependencies: a minimal PNG encoder over node:zlib.
// Run via `npm run icons`; the outputs are committed under build/ and web/.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build');
const WEB = join(ROOT, 'web');

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** pixels: (x, y) -> [r, g, b, a]; filter byte 0 per scanline */
function png(size, pixel) {
  const raw = Buffer.alloc(size.height * (size.width * 4 + 1));
  let o = 0;
  for (let y = 0; y < size.height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size.width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size.width, 0);
  ihdr.writeUInt32BE(size.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The mark is defined on a 16x16 unit grid: a board frame around a tall bar and a block.
// The tray glyph drops the frame so it stays legible at 16 px.
const BAR = { x: 3, y: 3, w: 4, h: 10 };
const BLOCK = { x: 9, y: 3, w: 4, h: 4 };
const FRAME = { x: 0, y: 0, w: 16, h: 16, t: 0.6 };
const inRect = (u, r) => u.x >= r.x && u.x < r.x + r.w && u.y >= r.y && u.y < r.y + r.h;
const inFrame = (u) => inRect(u, FRAME) && !(u.x >= FRAME.x + FRAME.t && u.x < FRAME.x + FRAME.w - FRAME.t
  && u.y >= FRAME.y + FRAME.t && u.y < FRAME.y + FRAME.h - FRAME.t);

/** map a pixel in an s×s image back onto the 16-unit grid */
const unit = (x, y, s) => ({ x: (x * 16) / s, y: (y * 16) / s });

function markAt(x, y, s, { frame = true } = {}) {
  const u = unit(x, y, s);
  if (inRect(u, BAR) || inRect(u, BLOCK)) return true;
  return frame && inFrame(u);
}

/** SVG source, generated from the same geometry as the PNGs */
function svg(size, { frame = true, background = true } = {}) {
  const r = (rect) => `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}"/>`;
  const framePath = frame
    ? `<path fill-rule="evenodd" d="M${FRAME.x} ${FRAME.y}h${FRAME.w}v${FRAME.h}H${FRAME.x}z M${FRAME.x + FRAME.t} ${FRAME.y + FRAME.t}h${FRAME.w - FRAME.t * 2}v${FRAME.h - FRAME.t * 2}H${FRAME.x + FRAME.t}z"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`
    + (background ? `<rect width="${size}" height="${size}" fill="#000"/>` : '')
    + `<g fill="#fff">${framePath}${r(BAR)}${r(BLOCK)}</g></svg>`;
}

mkdirSync(OUT, { recursive: true });

// app icon: white framed mark on black, with padding so macOS/Windows mask it nicely
const S = 1024;
const pad = S * 0.14;
const inner = S - pad * 2;
writeFileSync(
  join(OUT, 'icon.png'),
  png({ width: S, height: S }, (x, y) => {
    const on = x >= pad && x < pad + inner && y >= pad && y < pad + inner && markAt(x - pad, y - pad, inner);
    return on ? [255, 255, 255, 255] : [0, 0, 0, 255];
  }),
);
writeFileSync(join(OUT, 'icon.svg'), svg(16));

// tray: black mark on transparent, no frame — macOS template images invert automatically
writeFileSync(
  join(OUT, 'trayTemplate.png'),
  png({ width: 16, height: 16 }, (x, y) => (markAt(x, y, 16, { frame: false }) ? [0, 0, 0, 255] : [0, 0, 0, 0])),
);
writeFileSync(
  join(OUT, 'trayTemplate@2x.png'),
  png({ width: 32, height: 32 }, (x, y) => (markAt(x, y, 32, { frame: false }) ? [0, 0, 0, 255] : [0, 0, 0, 0])),
);

// web favicons
writeFileSync(join(WEB, 'favicon.svg'), svg(16));
writeFileSync(join(WEB, 'mark.svg'), svg(16, { frame: false, background: false }));
writeFileSync(join(WEB, 'favicon.png'), png({ width: 32, height: 32 }, (x, y) => (markAt(x, y, 32) ? [255, 255, 255, 255] : [0, 0, 0, 255])));
const A = 180;
const apad = A * 0.14;
const ainner = A - apad * 2;
writeFileSync(
  join(WEB, 'apple-touch-icon.png'),
  png({ width: A, height: A }, (x, y) => {
    const on = x >= apad && x < apad + ainner && y >= apad && y < apad + ainner && markAt(x - apad, y - apad, ainner);
    return on ? [255, 255, 255, 255] : [0, 0, 0, 255];
  }),
);

console.log('wrote build/icon.{png,svg}, build/trayTemplate{,@2x}.png, web/favicon.{svg,png}, web/apple-touch-icon.png');
