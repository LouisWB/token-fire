// 摆件和设置面板共用的"火焰视图"：负责把火势画出来、把读数写出来
import { flameBounds, flameFrameRects, staticLayerRects, sparksToSvg } from "./pixel/svg.js";
import { VIEW_BOX } from "./pixel/scene.js";

const FRAME_COUNT = 4;
const FRAME_FPS = 14;
const QUANT = 30;        // 火势量化成多少档
const STATIC_QUANT = 8;  // 炭火变化很慢，单独粗量化，省点重绘
const RENDER_MIN_MS = 55;
const GLIDE_MS = 170;    // 火势趋近的时间常数
const DAYS_LOW = 1;      // 只够烧 1 天：将熄
const DAYS_HIGH = 14;    // 够烧两周：烈焰
const BALANCE_MIN = 10;
const BALANCE_MAX = 50;
const MIN_INTENSITY = 0.08;

export function formatTokenCount(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) {
    const value = n / 1000;
    return (value < 100 ? value.toFixed(1) : Math.round(value)) + "k";
  }
  const value = n / 1000000;
  return (value < 100 ? value.toFixed(1) : Math.round(value)) + "M";
}

export function formatBalance(balance, currency = "CNY") {
  if (balance === null || balance === undefined) return "--";
  const value = Number(balance);
  if (!Number.isFinite(value)) return "--";
  return (currency === "USD" ? "$" : "¥") + value.toFixed(2);
}

function balanceToIntensity(balance) {
  const value = Math.max(0, Number(balance) || 0);
  if (value <= BALANCE_MIN) return MIN_INTENSITY;
  if (value >= BALANCE_MAX) return 1;
  return MIN_INTENSITY + ((value - BALANCE_MIN) / (BALANCE_MAX - BALANCE_MIN)) * (1 - MIN_INTENSITY);
}

function dateKey(date) {
  return (
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0")
  );
}

// 日均花费：今天的实际消费和最近三个完整天的均值取大的那个。
// 今天已经花掉的钱最能反映当前的燃烧速度；今天还没怎么花时仍参考前几天，免得每天一早火势虚高。
// 周初不足三天时退回本周累计 ÷ 已过天数；没有消耗记录时返回 0。
export function dailyCostOf(view) {
  const todayCost = Math.max(0, Number(view?.costToday) || 0);
  const trends = Array.isArray(view?.trends?.week) ? view.trends.week : [];
  const today = dateKey(new Date());
  const recent = trends
    .filter((point) => point && point.label && point.label < today)
    .slice(-3);

  let average = 0;
  if (recent.length) {
    const costs = recent.map((point) => Math.max(0, Number(point.value) || 0));
    const tokens = recent.map((point) => Math.max(0, Number(point.tokens) || 0));
    const costTotal = costs.reduce((sum, value) => sum + value, 0);
    const tokenTotal = tokens.reduce((sum, value) => sum + value, 0);
    if (tokenTotal > 0 && costTotal > 0) {
      const unit = costs[recent.length - 1] / tokens[recent.length - 1];
      if (Number.isFinite(unit) && unit > 0) average = (tokenTotal / recent.length) * unit;
    }
    if (!average && costTotal > 0) average = costTotal / recent.length;
  }

  if (!average) {
    const week = Number(view?.costWeek);
    if (Number.isFinite(week) && week > 0) {
      const days = trends.length > 0 && trends.length <= 7 ? trends.length : 7;
      average = week / days;
    }
  }

  return Math.max(todayCost, average);
}

// 今天已经走完的活跃小时：个数、总花费、平均每小时花费（共多少花多少，可加、可核对）。
// 当前这一小时还在累计，算进去会把均价压低、把剩余时间算长，所以排除；
// 今天还没有走完的活跃小时时，退回 日均 ÷ 3（一天大约三个用量时段）。
export function periodStatsOf(view) {
  const buckets = Array.isArray(view?.trends?.today) ? view.trends.today : [];
  const currentHour = String(new Date().getHours()).padStart(2, "0") + ":00";
  let hours = 0;
  let total = 0;
  for (const point of buckets) {
    if (!point) continue;
    const value = Math.max(0, Number(point.value) || 0);
    if (value <= 0 || point.label === currentHour) continue;
    hours += 1;
    total += value;
  }
  if (hours > 0) return { hours, total, perPeriod: total / hours, fallback: false };

  const daily = dailyCostOf(view);
  return { hours: 0, total: 0, perPeriod: daily > 0 ? daily / 3 : 0, fallback: true };
}

export function costPerPeriodOf(view) {
  return periodStatsOf(view).perPeriod;
}

// 每个 token 的均价：把今天各时段的真实花费和 tokens 先汇总再相除（加权，不是平均各时段的单价）。
// 今天还没数据时退回本周口径，再没有就返回 null。
export function unitCostOf(view) {
  const unitOf = (points) => {
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
  };

  const todayUnit = unitOf(view?.trends?.today);
  if (todayUnit > 0) return todayUnit;
  const weekUnit = unitOf(view?.trends?.week);
  return weekUnit > 0 ? weekUnit : null;
}

// 余额还能烧多少 token：余额 ÷ 每 token 均价。
// 这是官方数据里唯一能直接算出的「剩余量」，不依赖任何外部数据源，
// 和「剩余时间」不同维度：一个是绝对量，一个是按当前速度外推的时长。
export function tokensLeftOf(view) {
  const balance = Number(view?.balance);
  const unit = unitCostOf(view);
  if (!Number.isFinite(balance) || !(unit > 0)) return null;
  return Math.max(0, balance / unit);
}

// 余额还能烧多久；没有消耗数据时返回 null
export function daysLeftOf(view) {
  const balance = Number(view?.balance);
  const cost = dailyCostOf(view);
  if (!Number.isFinite(balance) || cost <= 0) return null;
  return Math.max(0, balance / cost);
}

// 还能烧多久 → 火势。对数插值：1 天内将熄，两周以上烈焰，中间连续过渡不跳档
function daysToIntensity(days) {
  const value = Math.max(0, Number(days) || 0);
  if (value <= DAYS_LOW) return MIN_INTENSITY;
  if (value >= DAYS_HIGH) return 1;
  const t = Math.log(value / DAYS_LOW) / Math.log(DAYS_HIGH / DAYS_LOW);
  return MIN_INTENSITY + t * (1 - MIN_INTENSITY);
}

// 有消耗数据就用"还能烧多久"，新用户还没花过钱时退回余额刻度，别一上来就熄着
function fireIntensity(balance, dailyCost) {
  const cost = Number(dailyCost) || 0;
  if (cost > 0.01) return daysToIntensity(Number(balance) / cost);
  return balanceToIntensity(balance);
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
    this.lastQuant = -1;
    this.lastStaticQuant = -1;
    this.lastTime = 0;
  }

  /* 画骨架：viewBox、帧周期、静态层、火星 */
  mount() {
    this.scene.setAttribute("viewBox", [VIEW_BOX.x, VIEW_BOX.y, VIEW_BOX.w, VIEW_BOX.h].join(" "));
    document.documentElement.style.setProperty(
      "--frame-dur",
      (FRAME_COUNT / FRAME_FPS).toFixed(4) + "s",
    );
    this.staticLayer.innerHTML = staticLayerRects(0.4);
    this.sparks.innerHTML = sparksToSvg({ intensity: 1, seed: this.seed });
    this.paint(0, true);
  }

  /* 火势 = 余额 ÷ 近 7 天日均消耗：够烧 1 天是将熄，两周以上是烈焰 */
  setBalance(balance, currency = "CNY", dailyCost = 0) {
    const available = balance !== null && balance !== undefined && Number.isFinite(Number(balance));
    this.target = available ? fireIntensity(balance, dailyCost) : 0;
    if (this.rateEl) this.rateEl.textContent = formatBalance(balance, currency);
  }

  /* 读不到数据时让火慢慢熄掉，别一直烧着假火 */
  fade() {
    this.target = 0;
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
      const before = this.lastQuant;
      this.paint(this.shown);
      if (this.lastQuant !== before) this.lastRender = now;
    }
  }

  paint(intensity, force = false) {
    const quant = Math.round(intensity * QUANT);
    if (force || quant !== this.lastQuant) {
      this.lastQuant = quant;
      const it = quant / QUANT;
      for (let f = 0; f < FRAME_COUNT; f++) {
        this.frames[f].innerHTML = flameFrameRects(it, f, this.seed);
      }
      this.fitHit(it);
    }

    const bucket = Math.round(intensity * STATIC_QUANT);
    if (force || bucket !== this.lastStaticQuant) {
      this.lastStaticQuant = bucket;
      this.staticLayer.innerHTML = staticLayerRects(bucket / STATIC_QUANT);
    }

    const sparks = this.sparks.children;
    const visible = Math.round(intensity * sparks.length);
    for (let i = 0; i < sparks.length; i++) {
      sparks[i].classList.toggle("off", i >= visible);
    }
  }

  /* 拖拽热区贴着火焰本身：火势一变，热区就重新框一次 */
  fitHit(intensity) {
    const rect = this.hitRect;
    if (!rect) return;

    const box = flameBounds(intensity, this.seed, FRAME_COUNT);
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

    // 顺手把火焰实心部分的顶端换算成像素交给提示气泡，火小了气泡跟着往下走
    const ctm = this.scene.getScreenCTM?.();
    const parent = this.scene.parentElement;
    if (ctm && parent) {
      const px = new DOMPoint(0, box.body).matrixTransform(ctm).y -
        this.scene.getBoundingClientRect().top;
      parent.style.setProperty("--flame-top", Math.max(0, px).toFixed(1) + "px");
    }
  }
}
