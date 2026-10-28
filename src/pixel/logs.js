// 三角架柴堆：木头往中间靠，上端埋进火里，只露出下半截
// 每行只写左边的木段，右边按中轴镜像出来，保证左右完全对称
const W = 44;
const LOG_W = 6;

// 横截面明暗：两端暗、中间亮，看起来像圆柱
const CROSS_OFFSET = [0, 1, 2, 2, 1, 0];
const RAMP = ["bark", "wood0", "wood1", "wood2", "wood3", "wood4"];

// base 越大这一段木头越靠近火堆、越亮
const LOG_ROWS = [
  { y: 23, base: 1, left: 16 },
  { y: 24, base: 1, left: 15 },
  { y: 25, base: 2, left: 14 },
  { y: 26, base: 2, left: 13 },
  { y: 27, base: 3, left: 12 },
  { y: 28, base: 3, left: 11 },
  { y: 29, base: 2, left: 10 },
  { y: 30, base: 2, left: 9 },
  { y: 31, base: 1, left: 8 },
  { y: 32, base: 1, left: 7 },
  { y: 33, base: 0, left: 6 },
  { y: 34, base: 0, left: 5 },
  { y: 35, base: 0, left: 4 },
  { y: 36, base: 0, left: 4 },
];

// 返回这一行 6 个像素对应的调色板键名，从左到右
function crossSection(base) {
  return CROSS_OFFSET.map((off) => RAMP[Math.min(RAMP.length - 1, Math.max(0, base + off))]);
}

// 柴面上的符文：两侧各一个 3x3 空心菱形，放在余额胶囊上方
const RUNE_GLYPHS = [
  { x: 9, y: 30 },
  { x: 32, y: 30 },
];

function drawRuneGlyph(grid, x, y) {
  const idx = (gx, gy) => gy * grid.w + gx;
  grid.cells[idx(x + 1, y)] = "rune1";
  grid.cells[idx(x, y + 1)] = "rune0";
  grid.cells[idx(x + 2, y + 1)] = "rune0";
  grid.cells[idx(x + 1, y + 2)] = "rune1";
}

export function drawLogs(grid, intensity = 1) {
  for (const { y, base, left } of LOG_ROWS) {
    const keys = crossSection(base);
    const spans = [
      [left, left + LOG_W - 1],
      [W - 1 - (left + LOG_W - 1), W - 1 - left],
    ];
    for (const [x0, x1] of spans) {
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || x >= W || y < 0 || y >= grid.h) {
          throw new Error(`木柴第 ${y} 行越界：x=${x}`);
        }
        grid.cells[y * grid.w + x] = keys[x - x0];
      }
    }
  }
  if (intensity > 0.2) {
    for (const glyph of RUNE_GLYPHS) drawRuneGlyph(grid, glyph.x, glyph.y);
  }
}
