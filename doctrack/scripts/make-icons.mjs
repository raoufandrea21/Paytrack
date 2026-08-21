/**
 * Generates the PWA icons as PNGs with no image dependencies — the shapes are
 * all rounded rectangles and circles, rasterised with 4x supersampling and
 * written out through zlib. Run with `node scripts/make-icons.mjs`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SS = 4; // supersample factor

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BG_TOP = hex('#1e293b');
const BG_BOTTOM = hex('#0f172a');
const CARD = hex('#f8fafc');
const ACCENT = hex('#6366f1');
const GOOD = hex('#10b981');
const LINE = hex('#94a3b8');

const inRoundRect = (x, y, rx, ry, rw, rh, r) => {
  if (x < rx || y < ry || x >= rx + rw || y >= ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Colour of one supersample point, or null for transparent. */
function sample(x, y, size, { maskable }) {
  const u = x / size;
  const v = y / size;
  const pad = maskable ? size * 0.12 : 0;
  const bgRadius = maskable ? size : size * 0.22;

  if (!maskable && !inRoundRect(x, y, 0, 0, size, size, bgRadius)) return null;

  // Card body: a document with a clipped top-right corner.
  const cw = size * 0.46;
  const ch = size * 0.56;
  const cx0 = (size - cw) / 2;
  const cy0 = size * 0.17 + pad * 0.2;
  const fold = size * 0.13;

  const onCard =
    inRoundRect(x, y, cx0, cy0, cw, ch, size * 0.045) &&
    !(x - (cx0 + cw - fold) > y - cy0); // 45° cut at the top-right

  if (onCard) {
    // Three text lines and a status pill on the card.
    const lx = cx0 + size * 0.07;
    const lw = cw - size * 0.14;
    for (let i = 0; i < 3; i += 1) {
      const ly = cy0 + size * 0.235 + i * size * 0.075;
      const w = i === 2 ? lw * 0.55 : lw;
      if (inRoundRect(x, y, lx, ly, w, size * 0.028, size * 0.014)) return LINE;
    }
    if (inCircle(x, y, cx0 + cw - size * 0.1, cy0 + ch - size * 0.1, size * 0.055)) return GOOD;
    return CARD;
  }

  // Folded corner sits slightly darker than the card.
  if (
    inRoundRect(x, y, cx0, cy0, cw, ch, size * 0.045) &&
    x - (cx0 + cw - fold) > y - cy0
  ) {
    return ACCENT;
  }

  // Vertical gradient background.
  const t = Math.min(1, Math.max(0, (u * 0.35 + v * 0.65)));
  return [
    Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
  ];
}

function render(size, options) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size, options);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a === 0) continue;
      px[i] = Math.round(r / (a / 255));
      px[i + 1] = Math.round(g / (a / 255));
      px[i + 2] = Math.round(b / (a / 255));
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

// ------------------------------------------------------------ PNG encoding

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const rows = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (stride + 1)] = 0; // filter: none
    pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });

const targets = [
  ['public/icons/icon-192.png', 192, {}],
  ['public/icons/icon-512.png', 512, {}],
  ['public/icons/maskable-512.png', 512, { maskable: true }],
  ['public/icons/apple-touch-icon.png', 180, { maskable: true }],
  ['public/icons/badge-72.png', 72, {}],
];

for (const [path, size, options] of targets) {
  writeFileSync(path, encodePng(size, render(size, options)));
  console.log(`wrote ${path} (${size}x${size})`);
}
