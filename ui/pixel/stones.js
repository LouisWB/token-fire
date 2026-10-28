import { put } from "./grid.js";

// 围炉：一条低矮的卵石带，两端各有一块稍宽高的刻符石
// 石带整体压在 y=31..35，不挡住余额胶囊

// 相邻石块压住 1px 边；宽窄和高低都错开，看起来像堆起来的石头
const STONES = [
  { x: 11, y: 31, w: 6, h: 5 },
  { x: 16, y: 33, w: 4, h: 3 },
  { x: 19, y: 32, w: 6, h: 4 },
  { x: 24, y: 33, w: 4, h: 3 },
  { x: 27, y: 31, w: 6, h: 5 },
];

// 一块石料：顶面受光、顶角磨圆、底部沉入阴影，左右边缘当作石缝
function drawStone(grid, { x, y, w, h }) {
  // 受光面只铺到石块左侧大半，右端留暗，顶面就不会连成一条亮带
  const capEnd = x + Math.floor(w * 0.55) + ((x * 5 + y * 3) % 2);

  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const top = yy === y;
      const bottom = yy === y + h - 1;
      const outer = xx === x || xx === x + w - 1;

      // 顶角磨圆，石块就有了钝圆的轮廓
      if (top && outer) continue;

      let key = "stone2";
      if (top) key = xx <= capEnd ? "stone3" : "stone2";
      else if (bottom) key = "stone1";
      else if (outer) key = "stone1";
      put(grid, xx, yy, key);
    }
  }
  put(grid, x + 1, y, "stone4");
}

// 石面上的符文：单色菱形刻纹，低火时熄灭
function drawDiamondRune(grid, cx, cy) {
  put(grid, cx, cy, "rune2");
  put(grid, cx - 1, cy + 1, "rune0");
  put(grid, cx + 1, cy + 1, "rune0");
  put(grid, cx, cy + 2, "rune0");
}

export function drawStoneRing(grid, intensity = 1) {
  for (const stone of STONES) drawStone(grid, stone);

  if (intensity > 0.2) {
    drawDiamondRune(grid, 13, 31);
    drawDiamondRune(grid, 30, 31);
  }
}