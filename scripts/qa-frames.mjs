import { writeFileSync } from "node:fs";
import { runsToSvg, UNIT } from "../src/pixel/svg.js";
import { buildStaticLayer, buildFlameLayer, SCENE_W, SCENE_H } from "../src/pixel/scene.js";

// 只看动画帧：把同一强度的 4 帧并排静态画出来，检查抖动是否自然
const intensity = 0.9;
const staticSvg = runsToSvg(buildStaticLayer(intensity));

const cells = [];
for (let f = 0; f < 4; f++) {
  const flame = runsToSvg(buildFlameLayer(intensity, f, 3));
  cells.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SCENE_W * UNIT}" height="${SCENE_H * UNIT}" ` +
      `viewBox="0 0 ${SCENE_W} ${SCENE_H}" shape-rendering="crispEdges">${staticSvg}${flame}</svg>`,
  );
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;padding:20px;background:#0d0d12;display:flex;gap:10px;align-items:flex-start}
figure{margin:0;text-align:center;color:#7d7d8c;font:12px system-ui}
svg{width:150px;height:157px;display:block}
</style></head><body>${cells
  .map((c, i) => `<figure>${c}<figcaption>frame ${i}</figcaption></figure>`)
  .join("")}</body></html>`;

writeFileSync(new URL("../.qa/frames.html", import.meta.url), html, "utf8");
console.log("frames.html ok");
