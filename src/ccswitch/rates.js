// 纯计算部分：浏览器和 Node 都能用，不依赖任何运行时

// 三种火势口径的标定。quiet 以下算熄火，full 以上算满格
export const METRICS = {
  total: { label: "总吞吐", hint: "输入 + 输出，含缓存命中", quiet: 200, full: 40000 },
  fresh: { label: "新增", hint: "扣掉缓存命中后的真实消耗", quiet: 20, full: 4000 },
  output: { label: "生成", hint: "纯输出速度，最像打字速度", quiet: 2, full: 400 },
};

// 实时流专用口径：先把客户端的流式事件换算成估算 tok/s，再按这套阈值定火势。
// 阈值比上面的 output 高一大截，因为这儿算的是"此刻这一瞬间"的速度，
// 峰值本来就比整轮平均高不少，用 output 那套会一直顶格。
export const LIVE_METRIC = "live";
METRICS[LIVE_METRIC] = {
  label: "生成",
  hint: "实时流估算：对话此刻吐字多快",
  quiet: 24,
  full: 640,
  live: true,
};

// 面板上让用户点的那三个。live 是系统自动切的，不给点
export const PICKABLE_METRICS = ["total", "fresh", "output"];

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

// 后端给的 rates 只有 total/fresh/output 三个键。
// 实时流的 live 口径是个"说法"，数字落在 output 上，别直接拿 live 去索引。
export function rateOf(sample, metric = DEFAULT_METRIC) {
  if (!sample || !sample.rates) return 0;
  const key = sample.metric === LIVE_METRIC ? "output" : metric;
  return sample.rates[key] || 0;
}

export function unitOf(metric) {
  const cfg = METRICS[metric] || METRICS[DEFAULT_METRIC];
  return cfg.live ? cfg.label + " ≈tok/s" : cfg.label + " tok/s";
}

export const DEFAULT_TAU_SECONDS = 12;