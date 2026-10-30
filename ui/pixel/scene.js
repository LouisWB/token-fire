import { createGrid, fillEllipse, put } from "./grid.js";
import { EMBER_RAMP } from "./palette.js";
import { drawFlame, BASE_Y, CENTER_X } from "./flame.js";
import { drawStoneRing } from "./stones.js";

export const SCENE_W = 44;
export const SCENE_H = 46;

// 桌面上的落地阴影
const GROUND = { cx: 22, cy: 36.8, rx: 12, ry: 1.2 };

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 炭火：离中心越近越亮，强度越高整片越热
function drawEmbers(grid, intensity) {
  const it = clamp01(intensity);
  const cx = CENTER_X;
  const cy = BASE_Y + 1.2;
  // 火越小，炉膛里露出的余烬越少，不会在低火时铺成一条亮带
  const rx = 2.5 + 3.9 * it;
  const ry = 0.6 + 1.3 * it;
  const y0 = Math.floor(cy - ry);
  const y1 = Math.ceil(cy + ry);
  const x0 = Math.floor(cx - rx);
  const x1 = Math.ceil(cx + rx);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      if (d > 1) continue;
      const t = 1 - d;
      const level = Math.min(
        EMBER_RAMP.length - 1,
        Math.max(0, Math.round(t * (0.35 + 4.5 * it) + 0.05 + 1.3 * it)),
      );
      put(grid, x, y, EMBER_RAMP[level]);
    }
  }
}

// 不随火焰抖动的部分：地面、余烬床、围炉石带、符文（石带压住炉膛近边）
export function buildStaticLayer(intensity) {
  const grid = createGrid(SCENE_W, SCENE_H);
  fillEllipse(grid, GROUND.cx, GROUND.cy, GROUND.rx, GROUND.ry, "ground");
  drawEmbers(grid, intensity);
  drawStoneRing(grid, intensity);
  return grid;
}

export function buildFlameLayer(intensity, frame, seed, liveliness = 0.5) {
  const grid = createGrid(SCENE_W, SCENE_H);
  drawFlame(grid, { intensity, frame, seed, liveliness });
  return grid;
}

// 强度档位：预览和调试都用这一套，对应默认的 1 - 1000 元线性刻度
export const LEVELS = [
  { intensity: 0.08, label: "将熄", balance: 1 },
  { intensity: 0.088, label: "微火", balance: 10 },
  { intensity: 0.171, label: "小火", balance: 100 },
  { intensity: 0.355, label: "中火", balance: 300 },
  { intensity: 1.0, label: "满焰", balance: 1000 },
];

// 摆件裁切：上方给火星留空间，底部给余额胶囊留位置
export const VIEW_BOX = { x: 2, y: -8, w: 40, h: 50 };

// 图标裁切：只框住火堆本体，正方形，缩小到 16px 也认得出
export const ICON_CROP = { x: 2, y: 0, w: 40, h: 40 };
