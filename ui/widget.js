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
  unitEl: document.getElementById("unit"),
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

// 悬停火堆时浮出来的那行小字：按本周日均估算还能烧多久
function renderHint(view) {
  const days = !view?.error && view?.loggedIn ? daysLeftOf(view) : null;
  if (days === null) {
    hintEl.hidden = true;
    return;
  }
  hintEl.hidden = false;
  hintEl.textContent =
    days >= 99 ? "余额充足" : "还能烧 " + (days < 10 ? days.toFixed(1) : Math.round(days)) + " 天";
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
  if (listen) {
    await listen("deepseek-changed", (event) => {
      const view = event.payload;
      fire.setBalance(view?.loggedIn ? view.balance : null, view?.currency, dailyCostOf(view));
      renderAlert(view);
      renderHint(view);
    });
  }
  await poll();
  setInterval(poll, POLL_MS);
  fire.start();
}

boot();
