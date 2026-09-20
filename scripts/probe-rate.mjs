import { UsageReader, rateToIntensity } from "../src/ccswitch/reader.js";

// 实时打印火势，用来验证数据链路和标定刻度
const reader = new UsageReader({ tauSeconds: 12 });
const total = Number(process.argv[2] || 12);

let smooth = 0;
let tick = 0;

const timer = setInterval(() => {
  const s = reader.sample();
  const target = rateToIntensity(s.rates.total, "total");
  smooth = tick === 0 ? target : smooth + (target - smooth) * 0.45;
  tick++;

  const bar = "█".repeat(Math.round(smooth * 36)).padEnd(36, "·");
  const idle = s.idleSeconds === null ? "  --" : s.idleSeconds.toFixed(0).padStart(4);
  console.log(
    `${bar} 火势 ${(smooth * 100).toFixed(0).padStart(3)}%` +
      `  总 ${Math.round(s.rates.total).toString().padStart(6)}/s` +
      `  新增 ${Math.round(s.rates.fresh).toString().padStart(5)}/s` +
      `  生成 ${Math.round(s.rates.output).toString().padStart(4)}/s` +
      `  空闲 ${idle}s`,
  );

  if (tick >= total) {
    clearInterval(timer);
    reader.close();
  }
}, 1000);
