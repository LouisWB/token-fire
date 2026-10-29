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

// 日均花费：costWeek 是本周累计，按本周已经过的天数折算，
// 周一就把一周的钱除以 7 会严重高估余额能烧多久。没有消耗记录时返回 0
export function dailyCostOf(view) {
  const week = Number(view?.costWeek);
  if (!Number.isFinite(week) || week <= 0) return 0;
  const points = Array.isArray(view?.trends?.week) ? view.trends.week.length : 0;
  const days = points > 0 && points <= 7 ? points : 7;
  return week / days;
}

// 余额还能烧几天；没有消耗数据时返回 null
export function daysLeftOf(view) {
  const balance = Number(view?.balance);
  const cost = dailyCostOf(view);
  if (!Number.isFinite(balance) || cost <= 0) return null;
  return Math.max(0, balance / cost);
}

// 还能烧几天 → 火势。对数插值：1 天内将熄，两周以上烈焰，中间连续过渡不跳档
function daysToIntensity(days) {
  const value = Math.max(0, Number(days) || 0);
  if (value <= DAYS_LOW) return MIN_INTENSITY;
  if (value >= DAYS_HIGH) return 1;
  const t = Math.log(value / DAYS_LOW) / Math.log(DAYS_HIGH / DAYS_LOW);
  return MIN_INTENSITY + t * (1 - MIN_INTENSITY);
}

// 有消耗数据就用"还能烧几天"，新用户还没花过钱时退回余额刻度，别一上来就熄着
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
