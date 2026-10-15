// Generates the app + tray icons with no dependencies: a minimal PNG encoder over node:zlib.
// Run via `npm run icons`; the outputs are committed under build/.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'build');

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

/** the hud mark: a tall bar and a square, on a 16x16 grid, scaled up */
const mark = (x, y, s) => {
  const u = s / 16;
  const inBar = x >= 3 * u && x < 7 * u && y >= 3 * u && y < 13 * u;
  const inBox = x >= 9 * u && x < 13 * u && y >= 3 * u && y < 7 * u;
  return inBar || inBox;
};

mkdirSync(OUT, { recursive: true });

// app icon: white mark on black, with padding so macOS/Windows mask it nicely
const S = 1024;
writeFileSync(
  join(OUT, 'icon.png'),
  png({ width: S, height: S }, (x, y) => {
    const pad = S * 0.14;
    const inner = S - pad * 2;
    const on = x >= pad && x < pad + inner && y >= pad && y < pad + inner && mark(x - pad, y - pad, inner);
    return on ? [255, 255, 255, 255] : [0, 0, 0, 255];
  }),
);

// tray: black mark on transparent — macOS template images invert automatically
writeFileSync(
  join(OUT, 'trayTemplate.png'),
  png({ width: 16, height: 16 }, (x, y) => (mark(x, y, 16) ? [0, 0, 0, 255] : [0, 0, 0, 0])),
);
writeFileSync(
  join(OUT, 'trayTemplate@2x.png'),
  png({ width: 32, height: 32 }, (x, y) => (mark(x, y, 32) ? [0, 0, 0, 255] : [0, 0, 0, 0])),
);

console.log('wrote build/icon.png, build/trayTemplate.png, build/trayTemplate@2x.png');
