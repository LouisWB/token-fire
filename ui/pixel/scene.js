import { createGrid, fillEllipse, put } from "./grid.js";
import { EMBER_RAMP } from "./palette.js";
import { drawFlame, BASE_Y, CENTER_X } from "./flame.js";
import { drawLogs } from "./logs.js";

export const SCENE_W = 44;
export const SCENE_H = 46;

// 桌面上的落地阴影
const GROUND = { cx: 22, cy: 41.2, rx: 20, ry: 3.0 };

// 立石：火堆两侧的古老石碑，顶面有月光，根部爬着苔藓
function drawStandingStones(grid) {
  const stones = [
    { x: 6, y: 28, w: 5, h: 10 },
    { x: 32, y: 27, w: 5, h: 11 },
  ];
  for (const stone of stones) {
    for (let y = stone.y; y < stone.y + stone.h; y++) {
      // 上窄下宽，像一块被风化过的立石
      const taper = y < stone.y + 2 ? 1 : 0;
      for (let x = stone.x + taper; x < stone.x + stone.w - taper; x++) {
        const edge = x === stone.x + taper || x === stone.x + stone.w - taper - 1;
        put(grid, x, y, edge ? "stone0" : "stone1");
      }
    }
    // 顶面只留一点月光
    put(grid, stone.x + 1, stone.y, "stone3");
    put(grid, stone.x + 2, stone.y, "stone2");
    // 根部长苔
    put(grid, stone.x, stone.y + stone.h - 1, "moss0");
    put(grid, stone.x + 1, stone.y + stone.h - 1, "moss1");
    put(grid, stone.x + stone.w - 2, stone.y + stone.h - 2, "moss0");
  }
}

// 围炉的符文石阵：一圈碎石围出祭坛，圈里刻着会发光的符文
function drawRuneCircle(grid, intensity) {
  fillEllipse(grid, 22, 39.4, 15.5, 3.4, "ash0");

  const stones = 12;
  for (let i = 0; i < stones; i++) {
    const angle = (i / stones) * Math.PI * 2;
    const sx = Math.round(22 + Math.cos(angle) * 17.5);
    const sy = Math.round(39.2 + Math.sin(angle) * 3.6);
    if (sy < 36) continue; // 上半圈被木柴和火挡住，画了也看不见
    put(grid, sx - 1, sy, "stone3");
    put(grid, sx, sy, "stone2");
    put(grid, sx + 1, sy, "stone1");
    put(grid, sx, sy + 1, "stone0");
  }

  const lit = intensity > 0.2;
  const runes = 9;
  for (let i = 0; i < runes; i++) {
    const angle = (i / runes) * Math.PI * 2 + 0.35;
    const rx = Math.round(22 + Math.cos(angle) * 12.5);
    const ry = Math.round(39.0 + Math.sin(angle) * 3.0);
    if (ry < 37) continue;
    put(grid, rx, ry, lit ? "rune0" : "stone3");
    if (i % 2 === 0) put(grid, rx + 1, ry, lit ? "rune1" : "stone2");
  }
}

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

// 不随火焰抖动的部分：地面、立石、符文石阵、木柴、炭火
export function buildStaticLayer(intensity) {
  const grid = createGrid(SCENE_W, SCENE_H);
  fillEllipse(grid, GROUND.cx, GROUND.cy, GROUND.rx, GROUND.ry, "ground");
  drawStandingStones(grid);
  drawRuneCircle(grid, intensity);
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
  { intensity: 0.08, label: "微光", balance: 10 },
  { intensity: 0.28, label: "小火", balance: 20 },
  { intensity: 0.52, label: "中火", balance: 30 },
  { intensity: 0.76, label: "旺火", balance: 40 },
  { intensity: 1.0, label: "烈焰", balance: 50 },
];

// 摆件裁切：去掉四周空白，上方多留一段给火星往上飘
export const VIEW_BOX = { x: 2, y: -8, w: 40, h: 50 };

// 图标裁切：只框住火堆本体，正方形，缩小到 16px 也认得出
export const ICON_CROP = { x: 2, y: 3, w: 40, h: 40 };
