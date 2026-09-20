import { createGrid, fillEllipse, put } from "./grid.js";
import { EMBER_RAMP } from "./palette.js";
import { drawFlame, BASE_Y, CENTER_X } from "./flame.js";
import { drawLogs } from "./logs.js";

export const SCENE_W = 44;
export const SCENE_H = 46;

// 桌面上的落地阴影
const GROUND = { cx: 22, cy: 41.2, rx: 20, ry: 3.0 };

// 由外到内堆起来的灰堆
const ASH_LAYERS = [
  { cx: 22, cy: 39.6, rx: 17.0, ry: 3.4, color: "ash0" },
  { cx: 22, cy: 39.2, rx: 14.5, ry: 2.8, color: "ash1" },
  { cx: 22, cy: 39.0, rx: 10.0, ry: 2.0, color: "ash2" },
  { cx: 22, cy: 38.8, rx: 5.5, ry: 1.3, color: "ash3" },
];

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 炭火：离中心越近越亮，强度越高整片越热
function drawEmbers(grid, intensity) {
  const it = clamp01(intensity);
  const cx = CENTER_X;
  const cy = BASE_Y + 1.0;
  const rx = 7.5;
  const ry = 2.4;
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

// 不随火焰抖动的部分：地面、灰堆、木柴、炭火
export function buildStaticLayer(intensity) {
  const grid = createGrid(SCENE_W, SCENE_H);
  fillEllipse(grid, GROUND.cx, GROUND.cy, GROUND.rx, GROUND.ry, "ground");
  for (const layer of ASH_LAYERS) {
    fillEllipse(grid, layer.cx, layer.cy, layer.rx, layer.ry, layer.color);
  }
  drawLogs(grid);
  drawEmbers(grid, intensity);
  return grid;
}

export function buildFlameLayer(intensity, frame, seed) {
  const grid = createGrid(SCENE_W, SCENE_H);
  drawFlame(grid, { intensity, frame, seed });
  return grid;
}

// 强度档位：预览和调试都用这一套
export const LEVELS = [
  { intensity: 0.0, label: "熄火", rate: 0 },
  { intensity: 0.2, label: "微火", rate: 30 },
  { intensity: 0.4, label: "小火", rate: 90 },
  { intensity: 0.6, label: "中火", rate: 200 },
  { intensity: 0.8, label: "旺火", rate: 450 },
  { intensity: 1.0, label: "烈焰", rate: 900 },
];

// 摆件裁切：去掉四周空白，上方多留一段给火星往上飘
export const VIEW_BOX = { x: 2, y: -8, w: 40, h: 50 };

// 图标裁切：只框住火堆本体，正方形，缩小到 16px 也认得出
export const ICON_CROP = { x: 2, y: 3, w: 40, h: 40 };