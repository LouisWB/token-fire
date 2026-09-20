// 从像素艺术直接渲染出 PNG / ICO，不依赖任何图形库
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PALETTE } from "../src/pixel/palette.js";
import { at } from "../src/pixel/grid.js";
import { buildStaticLayer, buildFlameLayer, ICON_CROP } from "../src/pixel/scene.js";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const b = i * 16;
    dir[b] = img.size >= 256 ? 0 : img.size;
    dir[b + 1] = img.size >= 256 ? 0 : img.size;
    dir[b + 2] = 0;
    dir[b + 3] = 0;
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(img.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

// 把 "#rrggbb" 或 "rgba(r,g,b,a)" 解析成 [r,g,b,a]
function parseColor(value) {
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      255,
    ];
  }
  const nums = value
    .slice(value.indexOf("(") + 1, value.indexOf(")"))
    .split(",")
    .map((n) => parseFloat(n));
  return [nums[0], nums[1], nums[2], Math.round((nums[3] ?? 1) * 255)];
}

// 把像素网格按最近邻放大到目标尺寸，带 alpha
function rasterize(grid, crop, size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = crop.x + Math.floor((x * crop.w) / size);
      const sy = crop.y + Math.floor((y * crop.h) / size);
      const key = at(grid, sx, sy);
      if (!key) continue;
      const [r, g, b, a] = parseColor(PALETTE[key]);
      const offset = (y * size + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = a;
    }
  }
  return rgba;
}

// 图标用的画面：旺火状态的第 0 帧，火焰画在柴堆上面
function iconGrid() {
  const staticLayer = buildStaticLayer(0.85);
  const flame = buildFlameLayer(0.85, 0, 3);
  for (let i = 0; i < flame.cells.length; i++) {
    if (flame.cells[i]) staticLayer.cells[i] = flame.cells[i];
  }
  return staticLayer;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

const grid = iconGrid();
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const rendered = SIZES.map((size) => ({
  size,
  png: encodePng(size, size, rasterize(grid, ICON_CROP, size)),
}));

// Tauri 认这几个固定名字
const named = { 32: "32x32.png", 128: "128x128.png", 256: "128x128@2x.png" };
for (const img of rendered) {
  const name = named[img.size] || img.size + "x" + img.size + ".png";
  writeFileSync(resolve(outDir, name), img.png);
}
writeFileSync(resolve(outDir, "icon.png"), rendered.find((i) => i.size === 256).png);
writeFileSync(resolve(outDir, "icon.ico"), encodeIco(rendered.filter((i) => i.size <= 256)));
writeFileSync(resolve(outDir, "icon-256.png"), rendered.find((i) => i.size === 256).png);

console.log("图标已生成：" + rendered.map((i) => i.size).join(" / "));