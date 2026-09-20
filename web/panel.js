// 设置面板：自己一个窗口，改设置不会碰到篝火
import { FireView } from "./fire-view.js";
import { METRICS, DEFAULT_METRIC } from "./ccswitch/rates.js";

const POLL_MS = 620;
const ENV_RETRY_MS = 60000;

const invoke = window.__TAURI__?.core?.invoke ?? null;

const els = {
  metrics: document.getElementById("metrics"),
  metricHint: document.getElementById("metric-hint"),
  sizes: document.getElementById("sizes"),
  autostart: document.getElementById("autostart"),
  env: document.getElementById("env"),
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

let metric = DEFAULT_METRIC;
let size = "medium";

const fire = new FireView({
  scene: document.getElementById("preview-scene"),
  staticLayer: document.getElementById("preview-static"),
  sparks: document.getElementById("preview-sparks"),
  rateEl: document.getElementById("rate"),
  unitEl: document.getElementById("unit"),
  glowEl: document.getElementById("preview-glow"),
  seed: 11,
});

/* ---------- 设置项 ---------- */

function renderOptions() {
  els.metrics.innerHTML = "";
  for (const key of Object.keys(METRICS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = METRICS[key].label;
    btn.classList.toggle("on", key === metric);
    btn.addEventListener("click", () => {
      metric = key;
      renderOptions();
      saveConfig();
    });
    els.metrics.appendChild(btn);
  }
  els.metricHint.textContent = METRICS[metric].hint;

  els.sizes.innerHTML = "";
  for (const preset of SIZE_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = preset.label;
    btn.classList.toggle("on", preset.key === size);
    btn.addEventListener("click", () => {
      size = preset.key;
      renderOptions();
      saveConfig();
    });
    els.sizes.appendChild(btn);
  }
}

function applyConfig(cfg) {
  if (!cfg) return;
  metric = METRICS[cfg.metric] ? cfg.metric : DEFAULT_METRIC;
  size = SIZE_PRESETS.some((p) => p.key === cfg.size) ? cfg.size : "medium";
  els.autostart.checked = !!cfg.autostart;
  renderOptions();
}

async function saveConfig() {
  if (!invoke) return;
  try {
    await invoke("set_config", {
      metric: metric,
      size: size,
      autostart: els.autostart.checked,
    });
    setStatus("status", "", "已保存");
  } catch (err) {
    setStatus("status", "bad", "保存设置失败：" + err);
  }
}

/* ---------- 状态文字 ---------- */

function setStatus(which, level, text) {
  const el = els[which];
  el.textContent = text;
  el.className = "hint" + (level ? " " + level : "");
}

async function refreshEnv() {
  if (!invoke) {
    setStatus("env", "warn", "没有 Tauri 环境，看到的只是界面");
    return;
  }
  try {
    const env = await invoke("check_env");
    setStatus("env", env.level, env.message);
  } catch (err) {
    setStatus("env", "bad", "环境检测失败：" + err);
  }
}

async function poll() {
  if (!invoke) {
    fire.fade();
    return;
  }
  try {
    const sample = await invoke("sample_rate");
    const rate = (sample && sample.rates && sample.rates[metric]) || 0;
    fire.setRate(rate, metric);
    if (sample.error) {
      setStatus("status", "bad", sample.error);
      return;
    }
    const idle = sample.idle_seconds;
    const idleText =
      idle === null
        ? "还没收到请求"
        : idle < 3
          ? "正在烧"
          : Math.round(idle) + " 秒前有请求";
    setStatus("status", "ok", "已连上 ccswitch 用量库 · " + idleText);
  } catch (err) {
    fire.fade();
    setStatus("status", "bad", "读取失败：" + err);
  }
}

/* ---------- 交互 ---------- */

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

els.collapse.addEventListener("click", close);
els.autostart.addEventListener("change", saveConfig);
els.quit.addEventListener("click", () => {
  if (invoke) invoke("quit_app");
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
});

/* ---------- 启动 ---------- */

async function boot() {
  fire.mount();

  if (invoke) {
    try {
      applyConfig(await invoke("get_config"));
    } catch (err) {
      renderOptions();
    }
  } else {
    renderOptions();
  }

  await refreshEnv();
  await poll();
  setInterval(poll, POLL_MS);
  setInterval(refreshEnv, ENV_RETRY_MS);
  fire.start();
}

boot();