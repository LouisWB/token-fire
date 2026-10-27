// 设置面板：自己一个窗口，管理 DeepSeek 登录、用量和摆件设置
import { FireView, formatBalance, formatTokenCount } from "./fire-view.js";

const POLL_MS = 500;
const invoke = window.__TAURI__?.core?.invoke ?? null;
const listen = window.__TAURI__?.event?.listen ?? null;

const els = {
  accountState: document.getElementById("account-state"),
  accountDetail: document.getElementById("account-detail"),
  login: document.getElementById("login"),
  sync: document.getElementById("sync"),
  today: document.getElementById("today"),
  yesterday: document.getElementById("yesterday"),
  month: document.getElementById("month"),
  balance: document.getElementById("balance"),
  usageHint: document.getElementById("usage-hint"),
  sizes: document.getElementById("sizes"),
  autostart: document.getElementById("autostart"),
  status: document.getElementById("status"),
  head: document.getElementById("panel-head"),
  collapse: document.getElementById("collapse"),
  quit: document.getElementById("quit"),
};

const SIZE_PRESETS = [
  { key: "small", label: "小" },
  { key: "medium", label: "中" },
  { key: "large", label: "大" },
];

let size = "medium";
let refreshing = false;

const fire = new FireView({
  scene: document.getElementById("preview-scene"),
  staticLayer: document.getElementById("preview-static"),
  sparks: document.getElementById("preview-sparks"),
  rateEl: document.getElementById("rate"),
  unitEl: document.getElementById("unit"),
  glowEl: document.getElementById("preview-glow"),
  seed: 11,
});

function renderSizes() {
  els.sizes.innerHTML = "";
  for (const preset of SIZE_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = preset.label;
    btn.classList.toggle("on", preset.key === size);
    btn.addEventListener("click", () => {
      size = preset.key;
      renderSizes();
      saveConfig();
    });
    els.sizes.appendChild(btn);
  }
}

function applyConfig(cfg) {
  if (!cfg) return;
  size = SIZE_PRESETS.some((preset) => preset.key === cfg.size) ? cfg.size : "medium";
  els.autostart.checked = !!cfg.autostart;
  renderSizes();
}

async function saveConfig() {
  if (!invoke) return;
  try {
    await invoke("set_config", {
      size,
      autostart: els.autostart.checked,
    });
    setStatus("ok", "设置已保存");
  } catch (err) {
    setStatus("bad", "保存设置失败：" + err);
  }
}

function setStatus(level, text) {
  els.status.textContent = text;
  els.status.className = "hint" + (level ? " " + level : "");
}

function timeText(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function renderUsage(view) {
  if (!view) return;

  const loggedIn = !!view.loggedIn;
  els.accountState.textContent = loggedIn ? "已连接" : "未登录";
  els.accountState.classList.toggle("on", loggedIn);
  els.accountDetail.textContent = loggedIn
    ? view.account || "已登录 DeepSeek"
    : "登录后读取官方用量数据";
  els.login.textContent = loggedIn ? "打开 DeepSeek" : "登录 DeepSeek";

  els.today.textContent = loggedIn ? formatTokenCount(view.todayTokens) : "—";
  els.yesterday.textContent = loggedIn ? formatTokenCount(view.yesterdayTokens) : "—";
  els.month.textContent = loggedIn ? formatTokenCount(view.monthTokens) : "—";
  els.balance.textContent = loggedIn
    ? "余额 " + formatBalance(view.balance, view.currency)
    : "余额 --";
  fire.setBalance(loggedIn ? view.balance : null, view.currency);

  const updated = timeText(view.updatedAt);
  els.usageHint.textContent = updated
    ? "更新于 " + updated + " · 官方数据约延迟 5 分钟"
    : "数据约延迟 5 分钟";

  if (view.error) {
    setStatus("bad", view.error);
  } else if (!loggedIn) {
    setStatus("warn", view.message || "请登录 DeepSeek");
  } else if (view.syncing) {
    setStatus("warn", "正在同步 DeepSeek 用量…");
  } else {
    setStatus("ok", view.message || "已连接 DeepSeek");
  }
}

async function poll() {
  if (!invoke || refreshing) return;
  refreshing = true;
  try {
    renderUsage(await invoke("deepseek_status"));
  } catch (err) {
    fire.fade();
    setStatus("bad", "读取失败：" + err);
  } finally {
    refreshing = false;
  }
}

async function openDeepSeek() {
  if (!invoke) return;
  try {
    await invoke("open_deepseek_login");
  } catch (err) {
    setStatus("bad", "打开 DeepSeek 失败：" + err);
  }
}

async function refreshNow() {
  if (!invoke) return;
  try {
    renderUsage(await invoke("refresh_deepseek"));
  } catch (err) {
    setStatus("bad", "刷新失败：" + err);
  }
}

async function close() {
  if (invoke) await invoke("close_settings");
}

els.head.addEventListener("mousedown", async (event) => {
  if (event.button !== 0 || event.target === els.collapse) return;
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    await getCurrentWindow().startDragging();
  } catch (err) {
    /* 不在 Tauri 里就忽略 */
  }
});

els.login.addEventListener("click", openDeepSeek);
els.sync.addEventListener("click", refreshNow);
els.collapse.addEventListener("click", close);
els.autostart.addEventListener("change", saveConfig);
els.quit.addEventListener("click", () => {
  if (invoke) invoke("quit_app");
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
});

window.addEventListener("focus", poll);

async function boot() {
  fire.mount();
  if (listen) {
    await listen("deepseek-changed", (event) => renderUsage(event.payload));
  }

  if (invoke) {
    try {
      applyConfig(await invoke("get_config"));
    } catch (err) {
      renderSizes();
    }
  } else {
    renderSizes();
    setStatus("warn", "没有 Tauri 环境，看到的只是界面");
  }

  await poll();
  setInterval(poll, POLL_MS);
  fire.start();
}

boot();
