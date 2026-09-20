import { PALETTE } from "./palette.js";
import { mergeRuns } from "./grid.js";
import { mulberry32 } from "./flame.js";
import { buildStaticLayer, buildFlameLayer, SCENE_W, SCENE_H, VIEW_BOX } from "./scene.js";

// 每个像素放大成 UNIT x UNIT 的实际尺寸
export const UNIT = 4;

export function runsToSvg(grid) {
  const parts = [];
  for (const run of mergeRuns(grid)) {
    const fill = PALETTE[run.color];
    if (!fill) throw new Error(`调色板里没有 ${run.color}`);
    parts.push(`<rect x="${run.x}" y="${run.y}" width="${run.w}" height="1" fill="${fill}"/>`);
  }
  return parts.join("");
}

// 往上飘的火星，数量和高低都跟着强度走
export function sparksToSvg({ intensity, seed = 1, originX = 22, originY = 28 }) {
  const it = Math.max(0, Math.min(1, intensity));
  const count = Math.round(it * 12);
  if (count <= 0) return "";

  const rand = mulberry32(seed * 31337 + 11);
  const parts = [];

  for (let i = 0; i < count; i++) {
    const life = 1.8 + rand() * 1.6;
    const begin = -(rand() * life).toFixed(2);
    const sx = originX + (rand() - 0.5) * (7 + 8 * it);
    const sy = originY + (rand() - 0.5) * 4;
    // 上升高度压在裁切范围内，飘到顶时正好淡出
    const rise = 10 + 20 * it + rand() * 6;
    const drift = (rand() - 0.5) * 14;
    const hot = rand();
    const color = hot > 0.65 ? PALETTE.flame5 : hot > 0.3 ? PALETTE.flame4 : PALETTE.flame3;

    parts.push(
      `<g transform="translate(${sx.toFixed(2)} ${sy.toFixed(2)})">` +
        `<rect width="1" height="1" fill="${color}">` +
        `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.55;1" dur="${life.toFixed(2)}s" begin="${begin}s" repeatCount="indefinite"/>` +
        `<animateTransform attributeName="transform" type="translate" values="0 0; ${(drift * 0.4).toFixed(1)} ${(-rise * 0.5).toFixed(1)}; ${drift.toFixed(1)} ${(-rise).toFixed(1)}" keyTimes="0;0.5;1" dur="${life.toFixed(2)}s" begin="${begin}s" repeatCount="indefinite"/>` +
        `</rect></g>`,
    );
  }
  return parts.join("");
}

// 生成一整个篝火 SVG：静态层只画一遍，火焰按帧循环播放
export function buildCampfireSVG({
  intensity = 1,
  frameCount = 4,
  seed = 1,
  fps = 14,
  background = null,
  withSparks = true,
  sparks = true,
  viewBox = VIEW_BOX,
} = {}) {
  const dur = (frameCount / fps).toFixed(3);

  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const values = Array.from({ length: frameCount }, (_, i) => (i === f ? 1 : 0)).join(";");
    frames.push(
      `<g><animate attributeName="opacity" calcMode="discrete" values="${values}" dur="${dur}s" repeatCount="indefinite"/>` +
        runsToSvg(buildFlameLayer(intensity, f, seed)) +
        `</g>`,
    );
  }

  const bg = background
    ? `<rect x="${viewBox.x}" y="${viewBox.y}" width="${viewBox.w}" height="${viewBox.h}" fill="${background}"/>`
    : "";
  const showSparks = withSparks && sparks && intensity > 0.05;
  const sparkSvg = showSparks ? sparksToSvg({ intensity, seed }) : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}" ` +
    `shape-rendering="crispEdges">` +
    `<title>像素篝火</title>` +
    bg +
    runsToSvg(buildStaticLayer(intensity)) +
    frames.join("") +
    sparkSvg +
    `</svg>`
  );
}

// 只要火焰那几帧，摆件每帧热替换用
export function flameFrameRects(intensity, frame, seed = 1) {
  return runsToSvg(buildFlameLayer(intensity, frame, seed));
}

export function staticLayerRects(intensity) {
  return runsToSvg(buildStaticLayer(intensity));
}

export { SCENE_W, SCENE_H };
