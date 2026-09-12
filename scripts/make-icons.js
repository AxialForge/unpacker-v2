// Generate assets/icon-<size>.png, assets/icon.ico and assets/tray.png from
// scratch with no native dependencies: a tiny PNG encoder over zlib and a
// rasteriser for the logo (rounded dark tile, blue box with lid, white arrow).
//
//   node scripts/make-icons.js
//
// The ICO embeds PNG-compressed images (valid since Vista), which is what
// electron-builder and Windows both accept.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = path.join(__dirname, "..", "assets");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const BG = [0x1b, 0x1f, 0x26];
const BOX = [0x4f, 0x8c, 0xff];
const LID = [0x3b, 0x6f, 0xd6];
const ARROW = [0xff, 0xff, 0xff];

// ── shapes (all in unit coordinates 0..1, y down) ─────────────────
const roundedRect = (x, y, w, h, r) => (px, py) => {
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return Math.hypot(px - cx, py - cy) - r; // signed distance
};
const segment = (ax, ay, bx, by, width) => (px, py) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - width / 2;
};
const LAYERS = [
  { sdf: roundedRect(0, 0, 1, 1, 0.19), color: BG },
  { sdf: roundedRect(0.22, 0.34, 0.56, 0.44, 0.06), color: BOX },
  { sdf: roundedRect(0.22, 0.25, 0.56, 0.14, 0.05), color: LID },
  { sdf: segment(0.5, 0.44, 0.5, 0.66, 0.065), color: ARROW },
  { sdf: segment(0.5, 0.67, 0.4, 0.57, 0.065), color: ARROW },
  { sdf: segment(0.5, 0.67, 0.6, 0.57, 0.065), color: ARROW },
];

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const aa = 1 / size; // one-pixel anti-alias band
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const L of LAYERS) {
        const d = L.sdf(u, v);
        const cov = Math.max(0, Math.min(1, 0.5 - d / aa));
        if (cov <= 0) continue;
        r = L.color[0] * cov + r * (1 - cov);
        g = L.color[1] * cov + g * (1 - cov);
        b = L.color[2] * cov + b * (1 - cov);
        a = cov + a * (1 - cov);
      }
      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

// ── PNG encoder ──────────────────────────────────────────────────
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ── ICO container (PNG entries) ──────────────────────────────────
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size === 256 ? 0 : size;
    dir[o + 1] = size === 256 ? 0 : size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
const entries = SIZES.map((size) => {
  const data = png(size, render(size));
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), data);
  return { size, data };
});
fs.writeFileSync(path.join(OUT, "icon.png"), entries.find((e) => e.size === 256).data);
fs.writeFileSync(path.join(OUT, "tray.png"), entries.find((e) => e.size === 32).data);
fs.writeFileSync(path.join(OUT, "icon.ico"), ico(entries));
console.log(`wrote ${SIZES.length} PNGs, icon.png, tray.png and icon.ico to ${OUT}`);
