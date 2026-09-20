// 纯计算部分：浏览器和 Node 都能用，不依赖任何运行时

// 三种火势口径的标定。quiet 以下算熄火，full 以上算满格
export const METRICS = {
  total: { label: "总吞吐", hint: "输入 + 输出，含缓存命中", quiet: 200, full: 40000 },
  fresh: { label: "新增", hint: "扣掉缓存命中后的真实消耗", quiet: 20, full: 4000 },
  output: { label: "生成", hint: "纯输出速度，最像打字速度", quiet: 2, full: 400 },
};

export const DEFAULT_METRIC = "total";

// 对数映射，低速区间才不会一片死平
export function rateToIntensity(rate, metric = DEFAULT_METRIC) {
  const cfg = METRICS[metric] || METRICS[DEFAULT_METRIC];
  if (!(rate > cfg.quiet)) return 0;
  const t = Math.log(1 + rate / cfg.quiet) / Math.log(1 + cfg.full / cfg.quiet);
  return Math.max(0, Math.min(1, t));
}

// 与帧率无关的指数趋近，火势变化才顺滑
export function approach(current, target, factor) {
  return current + (target - current) * Math.max(0, Math.min(1, factor));
}

export const DEFAULT_TAU_SECONDS = 12;
