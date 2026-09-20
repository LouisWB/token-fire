// 摆件窗口：只有一堆篝火，负责烧给用户看
import { FireView } from "./fire-view.js";
import { METRICS, DEFAULT_METRIC } from "./ccswitch/rates.js";

const POLL_MS = 620;
const ENV_RETRY_MS = 60000; // 没找到 ccswitch 时偶尔回头再看看，找到了就不用再查

const invoke = window.__TAURI__?.core?.invoke ?? null;

const alertEl = document.getElementById("alert");
const ornament = document.getElementById("ornament");

const fire = new FireView({
  scene: document.getElementById("scene"),
  staticLayer: document.getElementById("static"),
  sparks: document.getElementById("sparks"),
  rateEl: document.getElementById("rate"),
  unitEl: document.getElementById("unit"),
  glowEl: document.getElementById("glow"),
});

let metric = DEFAULT_METRIC;
let env = null;
let lastError = null;

/* ---------- 顶部那条提示 ---------- */

function renderAlert() {
  let level = "";
  let text = "";
  let detail = "";

  // 环境检测的结论更具体（哪一步缺了、该去干什么），优先显示它
  if (env && env.level !== "ok") {
    level = env.level;
    text = env.short;
    detail = env.message;
  } else if (lastError) {
    level = "bad";
    text = "读不到用量库";
    detail = lastError;
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

async function refreshEnv() {
  if (!invoke) return;
  try {
    env = await invoke("check_env");
    renderAlert();
  } catch (err) {
    /* 检测失败就当没检测过 */
  }
}

/* ---------- 数据 ---------- */

function applyConfig(cfg) {
  if (cfg && METRICS[cfg.metric]) metric = cfg.metric;
}

async function poll() {
  if (!invoke) {
    lastError = "没有 Tauri 环境";
    fire.fade();
    renderAlert();
    return;
  }
  try {
    const sample = await invoke("sample_rate");
    const rate = (sample && sample.rates && sample.rates[metric]) || 0;
    fire.setRate(rate, metric);
    lastError = (sample && sample.error) || null;
    renderAlert();
  } catch (err) {
    lastError = "读取失败：" + err;
    fire.fade();
    renderAlert();
  }
}

/* ---------- 交互 ---------- */

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

// 出问题的那条提示点一下就去看详情
alertEl.addEventListener("mousedown", (event) => {
  event.stopPropagation();
  event.preventDefault();
  if (invoke) invoke("open_settings");
});

/* ---------- 启动 ---------- */

async function boot() {
  fire.mount();

  if (invoke) {
    try {
      applyConfig(await invoke("get_config"));
    } catch (err) {
      /* 读不到就用默认值 */
    }
    // 设置面板在另一个窗口里改，改完会广播过来
    window.__TAURI__.event?.listen?.("config-changed", (event) => applyConfig(event.payload));
  }

  await refreshEnv();
  await poll();
  setInterval(poll, POLL_MS);
  setInterval(() => {
    if (!env || env.level !== "ok") refreshEnv();
  }, ENV_RETRY_MS);
  fire.start();
}

boot();