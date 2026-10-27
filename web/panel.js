// 设置面板：自己一个窗口，改设置不会碰到篝火
import { FireView } from "./fire-view.js";
import { METRICS, PICKABLE_METRICS, DEFAULT_METRIC, LIVE_METRIC, rateOf } from "./ccswitch/rates.js";

const POLL_MS = 250;
const ENV_RETRY_MS = 20000;

const invoke = window.__TAURI__?.core?.invoke ?? null;

const els = {
  source: document.getElementById("source"),
  metrics: document.getElementById("metrics"),
  metricHint: document.getElementById("metric-hint"),
  sizes: document.getElementById("sizes"),
  autostart: document.getElementById("autostart"),
  env: document.getElementById("env"),
  status: document.getElementById("status"),
  sessions: document.getElementById("sessions"),
  head: document.getElementById("panel-head"),
  collapse: document.getElementById("collapse"),
  quit: document.getElementById("quit"),
};

const SIZE_PRESETS = [
  { key: "small", label: "小" },
  { key: "medium", label: "中" },
  { key: "large", label: "大" },
];

// 下拉框的顺序，自动排第一
const SOURCE_ORDER = ["auto", "codex", "claude", "gemini", "ccswitch"];
const SOURCE_LABEL = {
  auto: "自动：谁在烧就用谁",
  codex: "Codex 实时流（跟手）",
  claude: "Claude Code 会话（实验）",
  gemini: "Gemini CLI 会话（实验）",
  ccswitch: "cc-switch 用量库（准但慢）",
};

let metric = DEFAULT_METRIC;
let source = "auto";
let size = "medium";
let sources = [];
/// 上一次环境检测认定的"在用的源"。面板窗口是应用启动时就加载的，
/// 那会儿后台还没采到样，所以要等采样回来再把环境说明补正
let envActive = "";
let refreshing = false;
/// 后端实际生效的口径。选实时流时它会是 live，跟用户点的那个不一样
let activeMetric = DEFAULT_METRIC;

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

function markOf(id, info) {
  if (id === "auto" || !info) return "";
  if (info.available) return " · 可用";
  return info.level === "warn" ? " · 还没数据" : " · 没找到";
}

function renderSources() {
  const info = new Map(sources.map((item) => [item.id, item]));
  els.source.innerHTML = "";
  for (const id of SOURCE_ORDER) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = SOURCE_LABEL[id] + markOf(id, info.get(id));
    els.source.appendChild(option);
  }
  els.source.value = source;
}

function renderOptions() {
  const live = activeMetric === LIVE_METRIC;

  els.metrics.innerHTML = "";
  for (const key of PICKABLE_METRICS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = METRICS[key].label;
    btn.classList.toggle("on", live ? key === "output" : key === metric);
    btn.addEventListener("click", () => {
      metric = key;
      renderOptions();
      saveConfig();
    });
    els.metrics.appendChild(btn);
  }
  els.metricHint.textContent = live
    ? "实时流只有「生成」这一个口径 —— 它测的是此刻吐字多快。想要总吞吐 / 新增，把数据源换成 cc-switch 用量库。"
    : METRICS[metric].hint;

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
  source = SOURCE_LABEL[cfg.source] ? cfg.source : "auto";
  size = SIZE_PRESETS.some((p) => p.key === cfg.size) ? cfg.size : "medium";
  els.autostart.checked = !!cfg.autostart;
  renderSources();
  renderOptions();
}

async function saveConfig() {
  if (!invoke) return;
  try {
    await invoke("set_config", {
      metric: metric,
      size: size,
      source: source,
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
  if (!invoke || refreshing) {
    if (!invoke) setStatus("env", "warn", "没有 Tauri 环境，看到的只是界面");
    return;
  }
  refreshing = true;
  try {
    const env = await invoke("check_env");
    sources = env.sources || [];
    envActive = env.active || "";
    renderSources();
    setStatus("env", env.level, env.message);
  } catch (err) {
    setStatus("env", "bad", "环境检测失败：" + err);
  } finally {
    refreshing = false;
  }
}

/// 把这一笔采样说成人话：实时流就把标定过程摊开给人看
function describe(sample) {
  const live = sample.metric === LIVE_METRIC;
  const parts = [sample.source_name || sample.source];
  if (live) {
    parts.push(Math.round(sample.events_per_sec) + " 事件/秒");
    if (sample.estimated) {
      const estimate = Math.round(rateOf(sample));
      parts.push("× " + sample.tokens_per_event.toFixed(1) + " ≈ " + estimate.toLocaleString("zh-CN") + " tok/s");
    }
    if (sample.threads > 0) parts.push(sample.threads + " 个会话在烧");
  }
  const idle = sample.idle_seconds;
  if (idle === null || idle === undefined) parts.push("还没收到数据");
  else if (rateOf(sample) <= 0) parts.push("已熄灭（" + Math.round(idle) + " 秒前有过生成）");
  else if (idle > 4) parts.push("刚停下来，" + Math.round(idle) + " 秒前还在生成");
  else if (!live || sample.threads === 0) parts.push("正在烧");
  return parts.join(" · ");
}

/* ---------- 会话板 ---------- */

/// 速度：一千以内给整数，再大就走 k / M
function fmtRate(n) {
  return n < 1000 ? String(Math.round(n)) : fmt(Math.round(n));
}

/// 大数字压成 k / M，面板一行放得下
function fmt(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) {
    const v = n / 1000;
    return (v < 100 ? v.toFixed(1) : Math.round(v)) + "k";
  }
  return (n / 1000000).toFixed(2) + "M";
}

/// 后端要等 20 秒才认定会话停了，面板上 4 秒没动静就先按停了的显示；
/// 中间这几秒走指数衰减 —— 看着是火慢慢小下去，而不是啪一下没了
const IDLE_STOP = 4;
function liveRate(info) {
  const idle = info.idle_seconds;
  if (info.rate <= 0 || idle > IDLE_STOP) return 0;
  if (idle <= 1.2) return info.rate;
  return info.rate * Math.exp(-(idle - 1.2) / 1.6);
}

/// 停了多久：一分钟以内说秒，再久就说分钟
function agoText(idle) {
  if (idle < 90) return Math.round(idle) + " 秒前停";
  if (idle < 5400) return Math.round(idle / 60) + " 分钟前停";
  return Math.round(idle / 3600) + " 小时前停";
}

/// 明细行的分栏：标记 → 字段 → 颜色类。顺序就是显示顺序
const SUB_CELLS = [
  ["input", "k-in", "↑"],
  ["cached", "k-cache", "⇢"],
  ["output", "k-out", "↓"],
  ["think", "k-think", "✦"],
];

const sessRows = new Map();
let sessOrder = "";

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/// 一行：上面是名字 + 速度，下面是本轮的 输入 / 缓存 / 输出 / 思考 / 累计
function sessRow(id) {
  const found = sessRows.get(id);
  if (found) return found;
  const el = document.createElement("div");
  el.className = "sess";
  const top = document.createElement("div");
  top.className = "sess-top";
  const name = document.createElement("span");
  name.className = "sess-name";
  const rate = document.createElement("span");
  rate.className = "sess-rate";
  top.append(name, rate);
  const sub = document.createElement("div");
  sub.className = "sess-sub";
  const cells = {};
  for (const [key, cls, mark] of SUB_CELLS) {
    const cell = document.createElement("span");
    cell.className = cls;
    cell.textContent = mark;
    const value = document.createElement("b");
    cell.appendChild(value);
    cells[key] = value;
    sub.appendChild(cell);
  }
  // 累计单独靠右，跟上一行的速度对齐
  const totalCell = document.createElement("span");
  totalCell.className = "k-total";
  totalCell.textContent = "累计 ";
  const totalValue = document.createElement("b");
  totalCell.appendChild(totalValue);
  cells.total = totalValue;
  sub.appendChild(totalCell);
  el.append(top, sub);
  const row = { el, name, rate, sub, cells };
  sessRows.set(id, row);
  return row;
}

function renderSessions(board) {
  if (!board) return;
  const rows = board.rows || [];

  if (rows.length === 0) {
    sessRows.clear();
    sessOrder = "";
    els.sessions.innerHTML = "";
    const hint = document.createElement("p");
    hint.className = "hint" + (board.error ? " warn" : "");
    hint.textContent = board.error
      ? board.error
      : "还没读到会话。开一个 Codex 任务，这里就会一行一个列出来。";
    els.sessions.appendChild(hint);
    return;
  }

  // 顺序变了才动 DOM，平时只改文字，免得 250ms 一次的轮询把布局抖起来
  const order = rows.map((info) => info.id).join("|");
  if (order !== sessOrder) {
    sessOrder = order;
    const ids = new Set(rows.map((info) => info.id));
    for (const [id, row] of [...sessRows]) {
      if (ids.has(id)) continue;
      row.el.remove();
      sessRows.delete(id);
    }
    for (const child of [...els.sessions.children]) {
      if (!child.classList.contains("sess")) child.remove();
    }
    for (const info of rows) els.sessions.appendChild(sessRow(info.id).el);
  }

  for (const info of rows) {
    const row = sessRow(info.id);
    const speed = liveRate(info);
    const alive = speed > 0.5;
    const head = info.branch ? info.label + " · " + info.branch : info.label;
    setText(row.name, head);
    setText(
      row.rate,
      alive ? "≈" + fmtRate(speed) + " tok/s" : agoText(info.idle_seconds)
    );
    // input 是总 prompt，里面已经含了缓存读（实测 cached 从没超过 input），
    // 所以单独标出来 —— 不然一轮几十万的数字看着跟假的似的
    setText(row.cells.input, fmt(info.input_tokens));
    setText(row.cells.cached, fmt(info.cached_input_tokens));
    setText(row.cells.output, fmt(info.output_tokens));
    setText(row.cells.think, fmt(info.reasoning_output_tokens));
    setText(row.cells.total, fmt(info.tokens_used));
    row.el.classList.toggle("live", alive);
    row.el.title =
      (info.cwd || "") +
      "\n模型 " + (info.model || "?") +
      "\n本轮 输入 " + info.input_tokens.toLocaleString("zh-CN") +
      "（缓存读 " + info.cached_input_tokens.toLocaleString("zh-CN") +
      " · 缓存写 " + info.cache_write_input_tokens.toLocaleString("zh-CN") + "）" +
      "\n本轮 输出 " + info.output_tokens.toLocaleString("zh-CN") +
      " · 思考 " + info.reasoning_output_tokens.toLocaleString("zh-CN") +
      "\n≈N tok/s 是这个会话累计消耗的增长速度（含缓存重读）" +
      "\n累计 " + info.tokens_used.toLocaleString("zh-CN");
  }
}

async function poll() {
  if (!invoke) {
    fire.fade();
    return;
  }
  try {
    // 会话板跟数据源无关，读的是 Codex 自己的会话库，顺手一起取
    const [sample, board] = await Promise.all([
      invoke("sample_rate"),
      invoke("session_board").catch(() => null),
    ]);
    renderSessions(board);
    const next = (sample && sample.metric) || metric;
    if (next !== activeMetric) {
      activeMetric = next;
      renderOptions();
    }
    fire.setRate(rateOf(sample, activeMetric), activeMetric);
    // 采样说在用的源跟环境说明对不上，说明环境说明是启动那会儿的旧账，重查一次
    if (sample.source && !sample.source.split("+").includes(envActive)) refreshEnv();
    if (sample.error) {
      setStatus("status", "bad", sample.error);
      return;
    }
    setStatus("status", "ok", describe(sample));
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

els.source.addEventListener("change", () => {
  source = els.source.value;
  saveConfig();
  refreshEnv();
});

els.collapse.addEventListener("click", close);
els.autostart.addEventListener("change", saveConfig);
els.quit.addEventListener("click", () => {
  if (invoke) invoke("quit_app");
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") close();
});

// 面板平时是藏起来的，每次亮出来都顺手重新看一眼环境
window.addEventListener("focus", refreshEnv);

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