// 摆件和设置面板共用的"火焰视图"：负责把火势画出来、把读数写出来
import { flameBounds, flameFrameRects, staticLayerRects, sparksToSvg } from "./pixel/svg.js";
import { VIEW_BOX } from "./pixel/scene.js";

const FRAME_COUNT = 4;
const FRAME_FPS = 14;
const QUANT = 30;        // 火势量化成多少档
const STATIC_QUANT = 8;  // 炭火变化很慢，单独粗量化，省点重绘
const ACTIVITY_QUANT = 6; // 今日用量的活跃度也量化，避免每次轮询都重绘
const RENDER_MIN_MS = 55;
const GLIDE_MS = 170;    // 火势趋近的时间常数
const MIN_INTENSITY = 0.08;
const FIRE_MIN_DEFAULT = 1;     // 余额低于它：最小火
const FIRE_MAX_DEFAULT = 1000;  // 余额高于它：满焰
const ACTIVITY_HALF_TOKENS = 500000; // 今日 50 万 token 时活跃度约一半
const MAX_SPARKS = 18;

export function formatTokenCount(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) {
    const value = n / 1000;
    return (value < 100 ? value.toFixed(1) : Math.round(value)) + "k";
  }
  if (n < 1000000000) {
    const value = n / 1000000;
    return (value < 100 ? value.toFixed(1) : Math.round(value)) + "M";
  }
  const value = n / 1000000000;
  return (value < 100 ? value.toFixed(1) : Math.round(value)) + "B";
}

export function formatBalance(balance, currency = "CNY") {
  if (balance === null || balance === undefined) return "--";
  const value = Number(balance);
  if (!Number.isFinite(value)) return "--";
  return (currency === "USD" ? "$" : "¥") + value.toFixed(2);
}

// 火势区间必须是一个正的、上界大于下界的区间；怪值就退回默认的 1 - 1000
function fireRangeOf(min, max) {
  const low = Number(min);
  const high = Number(max);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= low) {
    return { min: FIRE_MIN_DEFAULT, max: FIRE_MAX_DEFAULT };
  }
  return { min: low, max: high };
}

// 余额 → 火势：对数刻度，默认 1 元到 1000 元跨三个数量级，小额和大额都分得清
function balanceToIntensity(balance, range) {
  const value = Math.max(0, Number(balance) || 0);
  if (!(value > 0)) return 0;
  if (value <= range.min) return MIN_INTENSITY;
  if (value >= range.max) return 1;
  const t = Math.log(value / range.min) / Math.log(range.max / range.min);
  return MIN_INTENSITY + t * (1 - MIN_INTENSITY);
}

// 今天烧掉的 token 决定火苗有多"活"：50 万 token 约一半活跃度，再多趋近满值。
// 只影响火星密度和火苗抖动，不改变火的大小。
export function activityOf(view) {
  const today = Math.max(0, Number(view?.todayTokens) || 0);
  if (today <= 0) return 0;
  return 1 - Math.pow(0.5, today / ACTIVITY_HALF_TOKENS);
}

// 每个 token 的均价：把今天各时段的真实花费和 tokens 先汇总再相除（加权，不是平均各时段的单价）。
function unitCostOf(points) {
  let cost = 0;
  let tokens = 0;
  for (const point of Array.isArray(points) ? points : []) {
    const value = Math.max(0, Number(point?.value) || 0);
    const count = Math.max(0, Number(point?.tokens) || 0);
    if (value > 0 && count > 0) {
      cost += value;
      tokens += count;
    }
  }
  return tokens > 0 ? cost / tokens : 0;
}

// 余额还能买多少 token：余额 ÷ 每 token 均价。
// 今天有数据就用今天，没有退回本周；两边都没有时 tokens 为 null。
export function tokenEstimateOf(view) {
  const balance = Number(view?.balance);
  if (!Number.isFinite(balance)) return { tokens: null, unit: null, source: null };

  const todayUnit = unitCostOf(view?.trends?.today);
  if (todayUnit > 0) {
    return { tokens: Math.max(0, balance / todayUnit), unit: todayUnit, source: "today" };
  }
  const weekUnit = unitCostOf(view?.trends?.week);
  if (weekUnit > 0) {
    return { tokens: Math.max(0, balance / weekUnit), unit: weekUnit, source: "week" };
  }
  return { tokens: null, unit: null, source: null };
}

// 与帧率无关的指数趋近，火势变化才顺滑
function approach(current, target, factor) {
  return current + (target - current) * Math.max(0, Math.min(1, factor));
}

export class FireView {
  constructor({ scene, staticLayer, sparks, rateEl, glowEl, seed = 7 }) {
    this.scene = scene;
    this.staticLayer = staticLayer;
    this.sparks = sparks;
    this.rateEl = rateEl;
    this.glowEl = glowEl;
    this.seed = seed;
    this.frames = [...scene.querySelectorAll("g.frame")];
    this.hitRect = scene.querySelector(".flame-hit");
    this.target = 0;
    this.shown = 0;
    this.lastRender = 0;
    this.lastKey = "";
    this.lastStaticQuant = -1;
    this.lastTime = 0;
    this.range = { min: FIRE_MIN_DEFAULT, max: FIRE_MAX_DEFAULT };
    this.balance = null;
    this.currency = "CNY";
    this.activity = 0;
  }

  /* 画骨架：viewBox、帧周期、静态层、火星 */
  mount() {
    this.scene.setAttribute("viewBox", [VIEW_BOX.x, VIEW_BOX.y, VIEW_BOX.w, VIEW_BOX.h].join(" "));
    document.documentElement.style.setProperty(
      "--frame-dur",
      (FRAME_COUNT / FRAME_FPS).toFixed(4) + "s",
    );
    this.staticLayer.innerHTML = staticLayerRects(0.4);
    // 多生成一些火星，靠显示 / 隐藏控制密度；这样活跃度变化时不会重启动画
    this.sparks.innerHTML = sparksToSvg({ intensity: 1, seed: this.seed, count: MAX_SPARKS });
    this.paint(0, true);
  }

  /* 火势刻度：余额 ≤ min 最小火，≥ max 满焰，中间按对数插值 */
  setScale(min, max) {
    this.range = fireRangeOf(min, max);
    this.applyBalance();
  }

  /* 火势只看余额；今天的成交量只影响动效 */
  setBalance(balance, currency = "CNY", activity = 0) {
    this.balance = balance;
    this.currency = currency;
    this.activity = Math.max(0, Math.min(1, Number(activity) || 0));
    this.applyBalance();
    if (this.rateEl) this.rateEl.textContent = formatBalance(balance, currency);
  }

  applyBalance() {
    const available =
      this.balance !== null &&
      this.balance !== undefined &&
      Number.isFinite(Number(this.balance));
    this.target = available ? balanceToIntensity(this.balance, this.range) : 0;
  }

  /* 读不到数据时让火慢慢熄掉，别一直烧着假火 */
  fade() {
    this.target = 0;
    this.activity = 0;
  }

  start() {
    const step = (now) => {
      this.step(now);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  step(now) {
    const dt = this.lastTime ? Math.min(200, now - this.lastTime) : 16;
    this.lastTime = now;

    this.shown = approach(this.shown, this.target, 1 - Math.exp(-dt / GLIDE_MS));
    if (this.glowEl) this.glowEl.style.setProperty("--glow", (this.shown * 0.9).toFixed(3));

    if (now - this.lastRender >= RENDER_MIN_MS) {
      const before = this.lastKey;
      this.paint(this.shown);
      if (this.lastKey !== before) this.lastRender = now;
    }
  }

  paint(intensity, force = false) {
    const quant = Math.round(intensity * QUANT);
    const activityQuant = Math.round(
      Math.max(0, Math.min(1, this.activity)) * ACTIVITY_QUANT,
    );
    const key = quant + ":" + activityQuant;
    if (force || key !== this.lastKey) {
      this.lastKey = key;
      const it = quant / QUANT;
      const live = activityQuant / ACTIVITY_QUANT;
      for (let f = 0; f < FRAME_COUNT; f++) {
        this.frames[f].innerHTML = flameFrameRects(it, f, this.seed, live);
      }
      this.fitHit(it, live);

      // 火星密度 = 火势 × 活跃度：火大且今天用得多时最密，安静时只留几粒
      const sparks = this.sparks.children;
      const energy = Math.min(1, it * (0.55 + 0.45 * live));
      const visible = Math.round(energy * sparks.length);
      for (let i = 0; i < sparks.length; i++) {
        sparks[i].classList.toggle("off", i >= visible);
      }
    }

    const bucket = Math.round(intensity * STATIC_QUANT);
    if (force || bucket !== this.lastStaticQuant) {
      this.lastStaticQuant = bucket;
      this.staticLayer.innerHTML = staticLayerRects(bucket / STATIC_QUANT);
    }
  }

  /* 拖拽热区贴着火焰本身：火势一变，热区就重新框一次 */
  fitHit(intensity, liveliness) {
    const rect = this.hitRect;
    if (!rect) return;

    const box = flameBounds(intensity, this.seed, FRAME_COUNT, liveliness);
    if (!box) {
      rect.setAttribute("width", "0");
      rect.setAttribute("height", "0");
      return;
    }

    const pad = 1;
    const top = box.y - pad;
    // 底边一直铺到画面底部，和下面的火盆接上，石头带也不会漏
    const bottom = VIEW_BOX.y + VIEW_BOX.h;
    rect.setAttribute("x", String(box.x - pad));
    rect.setAttribute("y", String(top));
    rect.setAttribute("width", String(box.w + pad * 2));
    rect.setAttribute("height", String(bottom - top));

    // 顺手把火焰实心部分的顶端换算成像素交给提示气泡，火小了气泡跟着往下走。
    // 少数环境下 getScreenCTM 还没准备好，退回按 viewBox 比例换算
    const parent = this.scene.parentElement;
    if (!parent) return;
    const sceneRect = this.scene.getBoundingClientRect();
    const ctm = this.scene.getScreenCTM?.();
    let px = null;
    if (ctm) {
      px = new DOMPoint(0, box.body).matrixTransform(ctm).y - sceneRect.top;
    } else if (sceneRect.height > 0) {
      px = ((box.body - VIEW_BOX.y) / VIEW_BOX.h) * sceneRect.height;
    }
    if (px !== null && Number.isFinite(px)) {
      parent.style.setProperty("--flame-top", Math.max(0, px).toFixed(1) + "px");
    }
  }
}
