// 摆件窗口：只显示篝火和 DeepSeek 账户余额
import {
  FireView,
  periodStatsOf,
  dailyCostOf,
  tokensLeftOf,
  unitCostOf,
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

// 提示不跟现实时间倒数：没在用 Token 的时候余额也不会自己变少。
// 按今天已经走完的活跃小时的平均花费估还能用多久，数据刷新时才重算。
let hintMs = null;
let hintTokens = null;
let hintUnitText = "";
let hintDetail = "";
let hintMode = "time";
let lastView = null;

// 口径由设置决定：剩余时间按小时折天，剩余 token 按每 token 均价折算成还能买多少量
function paintHint() {
  let text = null;
  if (hintMode === "count") {
    if (hintTokens !== null) {
      if (hintTokens >= 1e9) text = "余额充足";
      else if (hintTokens < 1) text = "不足 1 tok";
      else text = "约能烧 " + formatTokenCount(hintTokens) + " tok";
    }
  } else if (hintMs !== null) {
    text = hintMs >= 99 * 86400000 ? "余额充足" : "约能烧 " + formatLeft(hintMs);
  }

  hintEl.hidden = text === null;
  if (text !== null && hintEl.textContent !== text) hintEl.textContent = text;

  // 数字是折算出来的，口径必须写在 title 里，不然这个结论没有出处
  const title =
    hintMode === "count"
      ? "按今天各时段的真实花费与 token 折算，每百万 token 约 " +
        hintUnitText +
        "，余额还能烧约 " +
        formatTokenCount(hintTokens) +
        " tok"
      : hintDetail;
  if (hintEl.title !== title) hintEl.title = title;
}

// 悬停火堆时浮出来的那行小字：两种口径每次都一起算好，切换时不用等下一次同步
function renderHint(view) {
  lastView = view;
  const usable = !view?.error && view?.loggedIn;
  const stats = usable
    ? periodStatsOf(view)
    : { hours: 0, total: 0, perPeriod: 0, fallback: true };
  const perPeriod = stats.perPeriod;
  const balance = usable ? Number(view?.balance) : NaN;
  hintMs =
    Number.isFinite(balance) && perPeriod > 0
      ? Math.max(0, balance / perPeriod) * 3600000
      : null;
  const unit = usable ? unitCostOf(view) : null;
  hintTokens = usable ? tokensLeftOf(view) : null;
  hintUnitText = unit > 0 ? formatBalance(unit * 1000000, view?.currency) : "";
  hintDetail = describePeriods(stats, balance, view?.currency);
  paintHint();
}

// 把算式摊开写：用了几个活跃小时、平均每小时多少、余额多少，方便直接核对
function describePeriods(stats, balance, currency) {
  if (!(stats.perPeriod > 0)) return "今天还没有用量，先按余额和日均估算";
  const left = hintMs === null ? "" : " → 约 " + formatLeft(hintMs);
  if (stats.fallback) {
    return (
      "今天还没有走完的用量时段，先按 日均 ÷ 3 估算；只在使用时消耗" + left
    );
  }
  return (
    "今天 " +
    stats.hours +
    " 个活跃小时共 " +
    formatBalance(stats.total, currency) +
    "，平均 " +
    formatBalance(stats.perPeriod, currency) +
    "/时；余额 " +
    formatBalance(balance, currency) +
    left +
    "（只在使用时消耗，当前这一小时不计入）"
  );
}

// 设置里可以选常显和显示口径；关着就只在悬停火堆时浮出来
function applyConfig(cfg) {
  ornament.classList.toggle("hint-on", !!cfg?.hintAlways);
  hintMode = cfg?.hintMode === "count" ? "count" : "time";
  if (lastView) renderHint(lastView);
  else paintHint();
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
  fire.start();
}

boot();
