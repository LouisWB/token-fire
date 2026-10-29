// 摆件窗口：只显示篝火和 DeepSeek 账户余额
import { FireView, dailyCostOf, daysLeftOf } from "./fire-view.js";

const POLL_MS = 1200;
const invoke = window.__TAURI__?.core?.invoke ?? null;
const listen = window.__TAURI__?.event?.listen ?? null;

const alertEl = document.getElementById("alert");
const ornament = document.getElementById("ornament");
const hintEl = document.getElementById("hint");

const fire = new FireView({
  scene: document.getElementById("scene"),
  staticLayer: document.getElementById("static"),
  sparks: document.getElementById("sparks"),
  rateEl: document.getElementById("rate"),
  glowEl: document.getElementById("glow"),
});

let polling = false;

function renderAlert(view) {
  let level = "";
  let text = "";
  let detail = "";

  if (view?.error) {
    level = "bad";
    text = "DeepSeek 同步失败";
    detail = view.error;
  } else if (view && !view.loggedIn) {
    level = "warn";
    text = "登录 DeepSeek";
    detail = view.message || "点击这里登录，然后读取官方用量";
  }

  if (!level) {
    alertEl.hidden = true;
    return;
  }
  alertEl.hidden = false;
  alertEl.className = level === "warn" ? "warn" : "";
  alertEl.textContent = text;
  alertEl.title = detail;
}

// 剩余时间写成人能直接读的天/时/分；天数太大就省掉分，别把胶囊撑爆
function formatLeft(ms) {
  const totalMin = Math.max(1, Math.round(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days >= 10) return days + "天" + (hours ? hours + "时" : "");
  if (days > 0) return days + "天" + (hours ? hours + "时" : "") + (mins ? mins + "分" : "");
  if (hours > 0) return hours + "时" + (mins ? mins + "分" : "");
  return mins + "分";
}

// 提示每秒钟走一格；只有余额或日均明显变了才重新对表，不然一直倒数
let hintBase = null;

function paintHint() {
  if (!hintBase) return;
  const left = Math.max(0, hintBase.ms - (Date.now() - hintBase.at));
  const text = left >= 99 * 86400000 ? "余额充足" : "约剩 " + formatLeft(left);
  if (hintEl.textContent !== text) hintEl.textContent = text;
}

// 悬停火堆时浮出来的那行小字：按日均估算还能撑多久
function renderHint(view) {
  const days = !view?.error && view?.loggedIn ? daysLeftOf(view) : null;
  if (days === null) {
    hintEl.hidden = true;
    hintBase = null;
    return;
  }
  hintEl.hidden = false;

  const ms = days * 86400000;
  // 跟上次对表时的估算比，余额或日均真变了才重新对表，否则让它接着倒数
  if (!hintBase || Math.abs(ms - hintBase.ms) > 120000) {
    hintBase = { ms, at: Date.now() };
  }
  paintHint();
}

// 设置里可以选常显；关着就只在悬停火堆时浮出来
function applyConfig(cfg) {
  ornament.classList.toggle("hint-on", !!cfg?.hintAlways);
}

async function poll() {
  if (!invoke || polling) {
    if (!invoke) renderAlert({ loggedIn: false, message: "没有 Tauri 环境" });
    return;
  }
  polling = true;
  try {
    const view = await invoke("deepseek_status");
    fire.setBalance(view?.loggedIn ? view.balance : null, view?.currency, dailyCostOf(view));
    renderAlert(view);
    renderHint(view);
  } catch (err) {
    fire.fade();
    renderAlert({ error: "读取失败：" + err });
  } finally {
    polling = false;
  }
}

// 拖动整个摆件
ornament.addEventListener("mousedown", async (event) => {
  if (event.button !== 0) return;
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    await getCurrentWindow().startDragging();
  } catch (err) {
    /* 不在 Tauri 里就忽略 */
  }
});

// 右键开设置：设置是另一个窗口，篝火本身不动
ornament.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  if (invoke) invoke("open_settings");
});

// 登录提示点一下直接打开 DeepSeek 官方页面
alertEl.addEventListener("mousedown", (event) => {
  event.stopPropagation();
  event.preventDefault();
  if (invoke) invoke("open_deepseek_login");
});

async function boot() {
  fire.mount();
  if (invoke) {
    try {
      applyConfig(await invoke("get_config"));
    } catch (err) {
      /* 读不到配置就按默认走 */
    }
  }
  if (listen) {
    await listen("config-changed", (event) => applyConfig(event.payload));
    await listen("deepseek-changed", (event) => {
      const view = event.payload;
      fire.setBalance(view?.loggedIn ? view.balance : null, view?.currency, dailyCostOf(view));
      renderAlert(view);
      renderHint(view);
    });
  }
  await poll();
  setInterval(poll, POLL_MS);
  setInterval(paintHint, 1000);
  fire.start();
}

boot();
