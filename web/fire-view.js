// 摆件和设置面板共用的"火焰视图"：负责把火势画出来、把读数写出来
import { flameFrameRects, staticLayerRects, sparksToSvg } from "./pixel/svg.js";
import { VIEW_BOX } from "./pixel/scene.js";

const FRAME_COUNT = 4;
const FRAME_FPS = 14;
const QUANT = 30;        // 火势量化成多少档
const STATIC_QUANT = 8;  // 炭火变化很慢，单独粗量化，省点重绘
const RENDER_MIN_MS = 55;
const GLIDE_MS = 170;    // 火势趋近的时间常数
const BALANCE_MIN = 10;
const BALANCE_MAX = 50;
const MIN_INTENSITY = 0.04;

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

// 与帧率无关的指数趋近，火势变化才顺滑
function approach(current, target, factor) {
  return current + (target - current) * Math.max(0, Math.min(1, factor));
}

export class FireView {
  constructor({ scene, staticLayer, sparks, rateEl, unitEl, glowEl, seed = 7 }) {
    this.scene = scene;
    this.staticLayer = staticLayer;
    this.sparks = sparks;
    this.rateEl = rateEl;
    this.unitEl = unitEl;
    this.glowEl = glowEl;
    this.seed = seed;
    this.frames = [...scene.querySelectorAll("g.frame")];
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

  /* 余额低于 10 元保持最小火，达到 50 元时为满火 */
  setBalance(balance, currency = "CNY") {
    const available = balance !== null && balance !== undefined && Number.isFinite(Number(balance));
    this.target = available ? balanceToIntensity(balance) : 0;
    if (this.rateEl) this.rateEl.textContent = formatBalance(balance, currency);
    if (this.unitEl) this.unitEl.textContent = currency;
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
}
