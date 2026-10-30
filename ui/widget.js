// 摆件窗口：只显示篝火、DeepSeek 账户余额和剩余 token 提示
import {
  FireView,
  activityOf,
  tokenEstimateOf,
  formatBalance,
  formatTokenCount,
} from "./fire-view.js";

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
let lastView = null;
let estimate = null;

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

// 气泡只显示剩余 token；算不出时显示 --，不猜
function paintHint() {
  const tokens = estimate?.tokens ?? null;
  let text = null;
  if (estimate) {
    if (tokens === null) text = "剩余 -- tok";
    else if (tokens < 1) text = "剩余不足 1 tok";
    else text = "剩余 ≈ " + formatTokenCount(tokens) + " tok";
  }

  hintEl.hidden = text === null;
  if (text !== null && hintEl.textContent !== text) hintEl.textContent = text;

  // 数字是折算出来的，口径必须写在 title 里，不然这个结论没有出处
  const title =
    tokens === null
      ? "今天和本周都还没有可用的消费数据，暂时算不出剩余 token"
      : "按" +
        (estimate.source === "today" ? "今天" : "本周") +
        "各时段的真实花费与 token 汇总折算：每百万 token 约 " +
        formatBalance(estimate.unit * 1000000, lastView?.currency) +
        "；余额 " +
        formatBalance(lastView?.balance, lastView?.currency) +
        " ≈ " +
        formatTokenCount(tokens) +
        " tok";
  if (hintEl.title !== title) hintEl.title = title;
}

function renderHint(view) {
  lastView = view;
  const usable = !view?.error && view?.loggedIn;
  estimate = usable ? tokenEstimateOf(view) : null;
  paintHint();
}

// 设置里可以选常显；关着就只在悬停火堆时浮出来
function applyConfig(cfg) {
  ornament.classList.toggle("hint-on", !!cfg?.hintAlways);
  fire.setScale(cfg?.fireMin, cfg?.fireMax);
  if (lastView) {
    fire.setBalance(
      lastView?.loggedIn ? lastView.balance : null,
      lastView?.currency,
      activityOf(lastView),
    );
  }
  paintHint();
}

async function poll() {
  if (!invoke || polling) {
    if (!invoke) renderAlert({ loggedIn: false, message: "没有 Tauri 环境" });
    return;
  }
  polling = true;
  try {
    const view = await invoke("deepseek_status");
    fire.setBalance(
      view?.loggedIn ? view.balance : null,
      view?.currency,
      activityOf(view),
    );
    renderAlert(view);
    renderHint(view);
  } catch (err) {
    fire.fade();
    lastView = null;
    estimate = null;
    paintHint();
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
      fire.setBalance(
        view?.loggedIn ? view.balance : null,
        view?.currency,
        activityOf(view),
      );
      renderAlert(view);
      renderHint(view);
    });
  }
  await poll();
  setInterval(poll, POLL_MS);
  fire.start();
}

boot();