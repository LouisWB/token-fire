import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCampfireSVG } from "../src/pixel/svg.js";
import { LEVELS } from "../src/pixel/scene.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = resolve(root, "assets");
mkdirSync(assets, { recursive: true });

// 主图：满火状态，可以直接双击在浏览器里看
const main = buildCampfireSVG({ intensity: 1, seed: 1, fps: 14, frameCount: 4 });
writeFileSync(resolve(assets, "campfire.svg"), main, "utf8");
console.log(`campfire.svg  ${(main.length / 1024).toFixed(1)} KB`);

// 预览页：把所有强度档位并排画出来
const cards = LEVELS.map((lv, i) => {
  const svg = buildCampfireSVG({ intensity: lv.intensity, seed: i + 1, fps: 14, frameCount: 4 });
  return `
    <figure class="card">
      ${svg}
      <figcaption>
        <b>${lv.label}</b>
        <span>${lv.rate} tok/s</span>
        <em>intensity ${lv.intensity.toFixed(2)}</em>
      </figcaption>
    </figure>`;
}).join("");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>像素篝火 · 强度档位预览</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 40px 32px 56px;
    background: #0d0d12;
    color: #e6e6ee;
    font: 14px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 650; }
  p.sub { margin: 0 0 32px; color: #7d7d8c; font-size: 13px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 18px;
    max-width: 1200px;
  }
  .card {
    margin: 0;
    padding: 18px 12px 12px;
    border: 1px solid #23232e;
    border-radius: 14px;
    background: radial-gradient(circle at 50% 62%, #1a1410 0%, #101017 70%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .card svg { width: 156px; height: auto; }
  figcaption { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  figcaption b { font-size: 14px; }
  figcaption span { color: #ffb43c; font-variant-numeric: tabular-nums; font-size: 12px; }
  figcaption em { color: #5c5c6b; font-style: normal; font-size: 11px; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <h1>像素篝火 · 强度档位</h1>
  <p class="sub">same SVG, different intensity — 火焰高矮宽窄和火芯温度都跟着走</p>
  <div class="grid">${cards}
  </div>
</body>
</html>
`;
writeFileSync(resolve(assets, "preview.html"), html, "utf8");
console.log("preview.html ok");

