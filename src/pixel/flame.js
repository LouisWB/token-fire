import { createGrid, put } from "./grid.js";
import { FLAME_RAMP } from "./palette.js";

// 火焰根部所在行：火从这一行往上长
export const BASE_Y = 33;
// 画面水平中心线
export const CENTER_X = 22;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 火舌轮廓：t=0 是尖端，t=1 是根部。先快速张开、再缓慢收口，像一片叶子
function tongueProfile(t) {
  const x = Math.pow(clamp01(t), 0.85);
  return Math.pow(Math.sin((Math.PI * 0.5) * x), 1.1);
}

function tongueCells(spec) {
  const { cx, tipY, baseY, baseW } = spec;
  const cells = [];
  const span = Math.max(1, baseY - tipY);
  for (let y = Math.max(0, Math.ceil(tipY)); y <= baseY; y++) {
    const t = (y - tipY) / span;
    const w = Math.max(1, Math.round(baseW * tongueProfile(t)));
    const x0 = Math.round(cx - w / 2);
    for (let i = 0; i < w; i++) cells.push([x0 + i, y]);
  }
  return cells;
}

// 按强度决定长几根火舌、各多高。行号一律取整，否则写不进像素掩码
// rand 每帧换一次，所以这里所有随机量都是"火苗在跳"的来源
function tongueSpecs(intensity, rand) {
  const it = intensity;
  const jitter = (amp) => (rand() - 0.5) * amp;

  // 高矮差拉大：快灭的时候只剩一小撮，烧旺了能顶到画面顶部
  const height = (6.5 + 25 * it) * (0.86 + 0.28 * rand());
  const specs = [];

  // 主火舌：火苗主体，每帧高度和左右位置都飘一点
  specs.push({
    cx: CENTER_X + jitter(2.4),
    tipY: BASE_Y - Math.round(height),
    baseY: BASE_Y,
    baseW: (6.5 + 12 * it) * (0.9 + 0.2 * rand()),
  });

  // 两根副火舌，只长到主火舌一半高，贴着主体形成锯齿顶
  const side = 3 + 2.6 * it;
  specs.push({
    cx: CENTER_X - side + jitter(3),
    tipY: BASE_Y - Math.round(height * (0.30 + 0.26 * rand())),
    baseY: BASE_Y,
    baseW: 2.2 + 3.6 * it,
  });
  specs.push({
    cx: CENTER_X + side + jitter(3),
    tipY: BASE_Y - Math.round(height * (0.26 + 0.26 * rand())),
    baseY: BASE_Y,
    baseW: 2.2 + 3.6 * it,
  });

  // 更外侧的小火苗，只有烧旺了才冒头
  if (it > 0.5) {
    const k = clamp01((it - 0.5) / 0.5);
    specs.push({
      cx: CENTER_X - (7 + 3.5 * it) + jitter(2.4),
      tipY: BASE_Y - Math.round(height * (0.12 + 0.24 * rand())),
      baseY: BASE_Y,
      baseW: 1.8 + 3 * k,
    });
    specs.push({
      cx: CENTER_X + (7 + 3.5 * it) + jitter(2.4),
      tipY: BASE_Y - Math.round(height * (0.10 + 0.24 * rand())),
      baseY: BASE_Y,
      baseW: 1.8 + 3 * k,
    });
  }

  return specs;
}

// 把火焰画进网格。intensity 0..1，frame 用来抖出不同的动画帧
export function drawFlame(grid, { intensity, frame = 0, seed = 1 }) {
  const it = clamp01(intensity);
  if (it <= 0.001) return;

  const { w } = grid;
  const rand = mulberry32(seed * 7919 + frame * 104729);

  const mask = new Uint8Array(w * grid.h);
  let topY = BASE_Y;

  for (const spec of tongueSpecs(it, rand)) {
    if (spec.tipY < topY) topY = spec.tipY;
    for (const [x, y] of tongueCells(spec)) {
      if (y > BASE_Y || x < 0 || x >= w || y < 0) continue;
      mask[y * w + x] = 1;
    }
  }
  if (topY >= BASE_Y) return;

  // 热度 = 横向离中轴多近 x 纵向烧了多深
  // 尖端偏暗、根部中轴最白，火芯才有往上窜的感觉
  // 火芯温度也拉开：快灭时只有暗红的芯，烧旺了才是白亮的心
  const heatCeiling = 0.7 + 5.6 * it;
  const span = Math.max(1, BASE_Y - topY);

  for (let y = topY; y <= BASE_Y; y++) {
    let xmin = -1;
    let xmax = -1;
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (xmin < 0) xmin = x;
      xmax = x;
    }
    if (xmin < 0) continue;

    const halfWidth = (xmax - xmin + 1) / 2;
    const rowCenter = xmin + halfWidth;
    const verticalHot = 0.32 + 0.68 * smoothstep(0.08, 0.8, (y - topY) / span);

    for (let x = xmin; x <= xmax; x++) {
      if (!mask[y * w + x]) continue;
      const lateral = Math.max(0, 1 - Math.abs(x + 0.5 - rowCenter) / halfWidth);
      const heat = Math.pow(lateral, 0.95) * verticalHot;
      const level = Math.min(FLAME_RAMP.length - 1, Math.round(heat * heatCeiling));
      put(grid, x, y, FLAME_RAMP[level]);
    }
  }
}


