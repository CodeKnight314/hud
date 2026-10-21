// Asset checks for the generated brand mark. No dependencies: reads the PNG chunks directly.
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, msg) => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${msg}`);
};

function readPng(path) {
  const buf = readFileSync(path);
  ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${path}: not a PNG`);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString('ascii');
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      ok(data[8] === 8 && data[9] === 6, `${path}: expected 8-bit RGBA`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  ok(raw.length === stride * height, `${path}: unexpected pixel data length`);
  const alpha = (x, y) => {
    const row = y * stride;
    ok(raw[row] === 0, `${path}: unsupported PNG filter`);
    return raw[row + 1 + x * 4 + 3];
  };
  return { width, height, alpha };
}

const icon = readPng(join(root, 'build/icon.png'));
ok(icon.width === 1024 && icon.height === 1024, 'build/icon.png: expected 1024x1024');
ok(icon.alpha(0, 0) === 255, 'build/icon.png: tile must be opaque');
ok(icon.alpha(291, 291) === 255, 'build/icon.png: mark missing');

for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
  const t = readPng(join(root, 'build', name));
  ok(t.width === size && t.height === size, `build/${name}: expected ${size}x${size}`);
  ok(t.alpha(0, 0) === 0, `build/${name}: outside the glyph must be transparent`);
  ok(t.alpha(Math.round(size * 0.3), Math.round(size * 0.4)) === 255, `build/${name}: glyph missing`);
}

const fav = readPng(join(root, 'web/favicon.png'));
ok(fav.width === 32 && fav.height === 32, 'web/favicon.png: expected 32x32');
ok(fav.alpha(0, 0) === 255, 'web/favicon.png: tile must be opaque');
const touch = readPng(join(root, 'web/apple-touch-icon.png'));
ok(touch.width === 180 && touch.height === 180, 'web/apple-touch-icon.png: expected 180x180');

for (const path of ['build/icon.svg', 'web/favicon.svg']) {
  const p = join(root, path);
  ok(existsSync(p), `${path}: missing`);
  if (existsSync(p)) ok(readFileSync(p, 'utf8').includes('<svg'), `${path}: not an SVG`);
}

if (failures) {
  console.error(`FAIL ${failures} icon asset check(s)`);
  process.exit(1);
}
console.log('PASS icon assets');
