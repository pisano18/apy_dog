#!/usr/bin/env node
'use strict';

/**
 * Generates build/icon.png — the application icon electron-builder packages.
 *
 * Written by hand rather than pulled from a dependency because it is a few
 * shapes, and an app about not paying for things you do not need should not
 * add an image toolchain to draw a circle.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;

/** Minimal RGBA PNG encoder. */
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;                       // filter type 0 (None)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const px = Buffer.alloc(SIZE * SIZE * 4);
const set = (x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const src = a / 255;
  const dst = px[i + 3] / 255;
  const out = src + dst * (1 - src);
  if (out <= 0) return;
  px[i] = Math.round((r * src + px[i] * dst * (1 - src)) / out);
  px[i + 1] = Math.round((g * src + px[i + 1] * dst * (1 - src)) / out);
  px[i + 2] = Math.round((b * src + px[i + 2] * dst * (1 - src)) / out);
  px[i + 3] = Math.round(out * 255);
};

const BG_TOP = [22, 28, 38];
const BG_BOT = [12, 16, 22];
const GOLD = [255, 179, 64];
const GREEN = [61, 220, 151];

// Rounded-rect background with a vertical gradient.
const R = SIZE * 0.22;
for (let y = 0; y < SIZE; y += 1) {
  const t = y / SIZE;
  const col = BG_TOP.map((v, i) => Math.round(v + (BG_BOT[i] - v) * t));
  for (let x = 0; x < SIZE; x += 1) {
    const cx = Math.min(x, SIZE - 1 - x);
    const cy = Math.min(y, SIZE - 1 - y);
    let a = 255;
    if (cx < R && cy < R) {
      const d = Math.hypot(R - cx, R - cy);
      if (d > R) a = 0;
      else if (d > R - 1.5) a = Math.round(255 * (R - d) / 1.5);
    }
    if (a) set(x, y, col, a);
  }
}

// A rising yield curve: the whole point of the app in one shape.
const points = [];
const N = 220;
for (let i = 0; i <= N; i += 1) {
  const t = i / N;
  const x = SIZE * 0.14 + t * SIZE * 0.72;
  // Steep early, flattening out — the shape of a real yield curve.
  const y = SIZE * 0.76 - Math.pow(t, 0.42) * SIZE * 0.44;
  points.push([x, y]);
}

// Area fill under the curve. Iterate pixel columns, not curve samples, or the
// fill comes out striped wherever two samples land on the same x.
const curveY = (x) => {
  const t = Math.max(0, Math.min(1, (x - SIZE * 0.14) / (SIZE * 0.72)));
  return SIZE * 0.76 - Math.pow(t, 0.42) * SIZE * 0.44;
};
for (let x = Math.round(SIZE * 0.14); x <= Math.round(SIZE * 0.86); x += 1) {
  const y = curveY(x);
  const floor = SIZE * 0.78;
  for (let yy = Math.round(y); yy < floor; yy += 1) {
    const depth = (yy - y) / (floor - y);
    set(x, yy, GOLD, Math.round(58 * (1 - depth) + 8));
  }
}

// The curve itself, drawn thick with soft edges.
const LW = SIZE * 0.035;
for (const [x, y] of points) {
  for (let dy = -LW; dy <= LW; dy += 0.5) {
    for (let dx = -LW; dx <= LW; dx += 0.5) {
      const d = Math.hypot(dx, dy);
      if (d > LW) continue;
      const a = d > LW - 1.2 ? Math.round(255 * (LW - d) / 1.2) : 255;
      set(Math.round(x + dx), Math.round(y + dy), GOLD, a);
    }
  }
}

// A marker at the high end, in the "this is good" colour.
const [hx, hy] = points[points.length - 1];
for (let dy = -SIZE * 0.055; dy <= SIZE * 0.055; dy += 0.5) {
  for (let dx = -SIZE * 0.055; dx <= SIZE * 0.055; dx += 0.5) {
    const d = Math.hypot(dx, dy);
    if (d > SIZE * 0.055) continue;
    const a = d > SIZE * 0.055 - 1.5 ? Math.round(255 * (SIZE * 0.055 - d) / 1.5) : 255;
    set(Math.round(hx + dx), Math.round(hy + dy), GREEN, a);
  }
}

// Baseline.
for (let x = Math.round(SIZE * 0.13); x < SIZE * 0.88; x += 1) {
  for (let dy = 0; dy < 3; dy += 1) set(x, Math.round(SIZE * 0.79) + dy, [90, 102, 120], 150);
}


// Guarded so that importing this file does nothing. The scripts test requires
// every script in order to catch missing identifiers, and a script that does
// its work at module scope turns that check into a live run.

function main() {
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.png'), encodePNG(SIZE, SIZE, px));
  console.log(`wrote ${path.join(out, 'icon.png')} (${SIZE}x${SIZE})`);
}

if (require.main === module) main();
