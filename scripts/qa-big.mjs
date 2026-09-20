import { writeFileSync } from "node:fs";
import { buildCampfireSVG } from "../src/pixel/svg.js";

// 单张大图：检查像素细节
const svg = buildCampfireSVG({ intensity: 0.85, seed: 5, fps: 14 });
const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#0d0d12}
svg{width:528px;height:552px}
</style></head><body>${svg}</body></html>`;
writeFileSync(new URL("../.qa/big.html", import.meta.url), html, "utf8");
console.log("big.html ok");
