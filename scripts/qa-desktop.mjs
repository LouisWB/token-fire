import { writeFileSync } from "node:fs";
import { buildCampfireSVG } from "../src/pixel/svg.js";

// 桌面摆件效果预演：透明底 + 壁纸感背景 + 三种火势
const levels = [
  { it: 0.1, label: "空闲" },
  { it: 0.45, label: "跑着" },
  { it: 0.9, label: "狂烧" },
];
const cards = levels
  .map(
    (lv, i) =>
      `<figure><div class="pad">${buildCampfireSVG({ intensity: lv.it, seed: i + 2, fps: 14 })}</div><figcaption>${lv.label}</figcaption></figure>`,
  )
  .join("");

writeFileSync(
  new URL("../.qa/desktop.html", import.meta.url),
  `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;padding:28px;background:
  radial-gradient(circle at 22% 18%, #24304a 0%, transparent 55%),
  radial-gradient(circle at 78% 72%, #3a2438 0%, transparent 55%),
  #101018;
  display:flex;gap:26px;align-items:flex-end}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
.pad{padding:6px;border-radius:14px;background:rgba(255,255,255,0.03)}
svg{width:170px;height:178px;display:block}
figcaption{color:#8a8a99;font:12px system-ui}
</style></head><body>${cards}</body></html>`,
  "utf8",
);
console.log("desktop.html ok");
