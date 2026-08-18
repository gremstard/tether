'use strict';

/**
 * Generates the tray and app icons.
 *
 * Written as a tiny PNG encoder rather than shipping binary assets: the icon is
 * two rings joined by a line (the "tether"), which is simple enough to describe
 * in code, and generating it keeps the repo free of opaque blobs and lets the
 * icon be tweaked by editing numbers.
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixel buffer -> PNG. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha

  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draw the mark: a large ring, a smaller ring above it, and a line joining them.
 * Sampled 3x3 per pixel so the curves are not jagged at 22px.
 */
function drawMark(size, colour) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 22; // design is specified at 22px
  const SAMPLES = 3;

  const ring = (x, y, cx, cy, r, w) => {
    const d = Math.hypot(x - cx, y - cy);
    return Math.abs(d - r) <= w / 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = (x + (sx + 0.5) / SAMPLES) / s;
          const py = (y + (sy + 0.5) / SAMPLES) / s;
          // The two rings must not touch, or the link between them reads as a
          // figure-8 rather than as one thing tethered to another.
          const inLower = ring(px, py, 11, 15, 5, 1.9);
          const inUpper = ring(px, py, 11, 4, 2.4, 1.6);
          const inLink = px > 10.2 && px < 11.8 && py > 6.2 && py < 10.2;
          if (inLower || inUpper || inLink) hits++;
        }
      }
      if (!hits) continue;
      const alpha = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
      const at = (y * size + x) * 4;
      rgba[at] = colour[0];
      rgba[at + 1] = colour[1];
      rgba[at + 2] = colour[2];
      rgba[at + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });

// macOS menu-bar icons must be black-with-alpha "template" images: the OS
// recolours them for light/dark menu bars and for when the item is selected.
fs.writeFileSync(path.join(out, 'trayTemplate.png'), drawMark(22, [0, 0, 0]));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), drawMark(44, [0, 0, 0]));

// Windows tray sits on the taskbar and is not recoloured, so ship it light.
fs.writeFileSync(path.join(out, 'tray-win.png'), drawMark(32, [235, 238, 242]));

// App/window icon.
fs.writeFileSync(path.join(out, 'icon.png'), drawMark(512, [76, 110, 245]));

// Packaging icon. electron-builder derives .icns and .ico from this, and wants
// at least 512x512 — 1024 keeps macOS crisp at every size it renders.
const build = path.join(__dirname, '..', 'build');
fs.mkdirSync(build, { recursive: true });
fs.writeFileSync(path.join(build, 'icon.png'), drawMark(1024, [76, 110, 245]));

console.log('wrote', fs.readdirSync(out).join(', '));
