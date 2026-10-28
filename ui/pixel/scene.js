import { createGrid, fillEllipse, put } from "./grid.js";
import { EMBER_RAMP } from "./palette.js";
import { drawFlame, BASE_Y, CENTER_X } from "./flame.js";
import { drawLogs } from "./logs.js";

export const SCENE_W = 44;
export const SCENE_H = 46;

// 桌面上的落地阴影
const GROUND = { cx: 22, cy: 37.4, rx: 14.5, ry: 1.4 };

// 围炉石：只留前排四块小整石，块头统一、顶面受光
const RING_STONES = [
  { x: 4, y: 32, w: 4, h: 4, inner: "right" },
  { x: 10, y: 33, w: 4, h: 4, inner: "right" },
  { x: 30, y: 33, w: 4, h: 4, inner: "left" },
  { x: 36, y: 32, w: 4, h: 4, inner: "left" },
];

// 一块敦实的石头：圆角顶、暗底、朝火的一侧提亮
function drawBoulder(grid, stone) {
  const { x, y, w, h, inner } = stone;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const top = yy === y;
      const bottom = yy === y + h - 1;
      const left = xx === x;
      const right = xx === x + w - 1;
      if ((top || bottom) && (left || right)) continue;
      let key = "stone2";
      if (top) key = "stone3";
      else if (bottom) key = "stone1";
      else if (inner === "right" && right) key = "stone3";
      else if (inner === "left" && left) key = "stone3";
      else if (left || right) key = "stone1";
      put(grid, xx, yy, key);
    }
  }
  put(grid, x + 1, y, "stone4");
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// 炭火：离中心越近越亮，强度越高整片越热
function drawEmbers(grid, intensity) {
  const it = clamp01(intensity);
  const cx = CENTER_X;
  const cy = BASE_Y + 1.6;
  const rx = 6.8;
  const ry = 2.1;
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

// 不随火焰抖动的部分：地面、余烬床、木柴、围炉石、符文
export function buildStaticLayer(intensity) {
  const grid = createGrid(SCENE_W, SCENE_H);
  fillEllipse(grid, GROUND.cx, GROUND.cy, GROUND.rx, GROUND.ry, "ground");
  fillEllipse(grid, 22, 35.2, 6.8, 1.7, "ash0");
  drawLogs(grid, intensity);
  drawEmbers(grid, intensity);
  for (const stone of RING_STONES) drawBoulder(grid, stone);
  return grid;
}

export function buildFlameLayer(intensity, frame, seed) {
  const grid = createGrid(SCENE_W, SCENE_H);
  drawFlame(grid, { intensity, frame, seed });
  return grid;
}

// 强度档位：预览和调试都用这一套
export const LEVELS = [
  { intensity: 0.08, label: "微光", balance: 10 },
  { intensity: 0.28, label: "小火", balance: 20 },
  { intensity: 0.52, label: "中火", balance: 30 },
  { intensity: 0.76, label: "旺火", balance: 40 },
  { intensity: 1.0, label: "烈焰", balance: 50 },
];

// 摆件裁切：上方给火星留空间，底部给余额胶囊留位置
export const VIEW_BOX = { x: 2, y: -8, w: 40, h: 50 };

// 图标裁切：只框住火堆本体，正方形，缩小到 16px 也认得出
export const ICON_CROP = { x: 2, y: 0, w: 40, h: 40 };
