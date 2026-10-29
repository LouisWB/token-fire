// 设置面板：自己一个窗口，管理 DeepSeek 登录、用量和摆件设置
import { FireView, dailyCostOf, formatBalance, formatTokenCount } from "./fire-view.js";

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
  todayCost: document.getElementById("today-cost"),
  yesterdayCost: document.getElementById("yesterday-cost"),
  monthCost: document.getElementById("month-cost"),
  balance: document.getElementById("balance"),
  usageHint: document.getElementById("usage-hint"),
  costTabs: document.getElementById("cost-tabs"),
  costTotal: document.getElementById("cost-total"),
  costPeak: document.getElementById("cost-peak"),
  costChart: document.getElementById("cost-chart"),
  costAxisStart: document.getElementById("cost-axis-start"),
  costAxisMid: document.getElementById("cost-axis-mid"),
  costAxisEnd: document.getElementById("cost-axis-end"),
  costTip: document.getElementById("cost-tip"),
  costTipTime: document.getElementById("cost-tip-time"),
  costTipTokens: document.getElementById("cost-tip-tokens"),
  costTipCost: document.getElementById("cost-tip-cost"),
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

const COST_RANGES = [
  { key: "today", field: "costToday", trend: "today" },
  { key: "week", field: "costWeek", trend: "week" },
  { key: "month", field: "costMonth", trend: "month" },
  { key: "year", field: "costYear", trend: "year" },
];

let size = "medium";
let refreshing = false;
let lastView = null;
let costRange = "today";
let chartKey = "";
let chartPoints = [];
let chartCoords = [];
let chartCurrency = "CNY";

try {
  const saved = localStorage.getItem("token-fire:cost-range");
  if (COST_RANGES.some((item) => item.key === saved)) costRange = saved;
} catch (err) {
  /* 没有 localStorage 就用默认值 */
}

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

const CHART_W = 270;
const CHART_H = 76;
const CHART_PAD_X = 4;
const CHART_PAD_Y = 9;

function formatAxisLabel(label) {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (date) return Number(date[2]) + "/" + Number(date[3]);
  const month = /^(\d{4})-(\d{2})$/.exec(label);
  if (month) return Number(month[2]) + "月";
  // 兜底：万一接口直接给秒级时间戳
  if (/^\d{9,11}$/.test(label)) {
    const value = new Date(Number(label) * 1000);
    return value.getMonth() + 1 + "/" + value.getDate();
  }
  return label;
}

// 一年的日桶太密，折线会糊成一片，按月份合并一次
function condensePoints(points) {
  if (!Array.isArray(points)) return [];
  const clean = points
    .filter((point) => point && typeof point.label === "string")
    .map((point) => ({
      label: point.label,
      value: Math.max(0, Number(point.value) || 0),
      tokens: Math.max(0, Number(point.tokens) || 0),
    }));
  if (clean.length <= 45) return clean;
  if (!clean.every((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.label))) return clean;
  const months = new Map();
  for (const point of clean) {
    const key = point.label.slice(0, 7);
    const sums = months.get(key) || { value: 0, tokens: 0 };
    sums.value += point.value;
    sums.tokens += point.tokens;
    months.set(key, sums);
  }
  return [...months.entries()].map(([label, sums]) => ({
    label,
    value: sums.value,
    tokens: sums.tokens,
  }));
}

function hideChartTip() {
  els.costTip.hidden = true;
  const hover = els.costChart.querySelector("#cost-hover");
  if (hover) hover.remove();
}

function showChartTip(index) {
  const point = chartPoints[index];
  const coord = chartCoords[index];
  if (!point || !coord) return;

  const NS = "http://www.w3.org/2000/svg";
  const svg = els.costChart;
  const top = CHART_PAD_Y;
  const bottom = CHART_H - CHART_PAD_Y;
  hideChartTip();

  const hover = document.createElementNS(NS, "g");
  hover.setAttribute("id", "cost-hover");
  const guide = document.createElementNS(NS, "line");
  guide.setAttribute("x1", coord[0].toFixed(2));
  guide.setAttribute("x2", coord[0].toFixed(2));
  guide.setAttribute("y1", top);
  guide.setAttribute("y2", bottom);
  guide.setAttribute("stroke", "rgba(255, 200, 106, 0.4)");
  guide.setAttribute("stroke-dasharray", "2 3");
  guide.setAttribute("vector-effect", "non-scaling-stroke");
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", coord[0].toFixed(2));
  dot.setAttribute("cy", coord[1].toFixed(2));
  dot.setAttribute("r", "3.2");
  dot.setAttribute("fill", "#ffe1ae");
  hover.append(guide, dot);
  svg.appendChild(hover);

  els.costTipTime.textContent = formatAxisLabel(point.label);
  els.costTipTokens.textContent = formatTokenCount(point.tokens);
  els.costTipCost.textContent = formatCost(point.value, chartCurrency);
  els.costTip.hidden = false;

  // 内容先上屏再量宽，边缘处才能整个翻进来，不会被面板裁掉
  const wrap = els.costTip.parentElement;
  const width = wrap.clientWidth || CHART_W;
  const tipWidth = els.costTip.offsetWidth;
  const raw = (coord[0] / CHART_W) * width;
  const left = width <= tipWidth + 6
    ? width / 2
    : Math.min(Math.max(raw, tipWidth / 2 + 1), width - tipWidth / 2 - 1);
  els.costTip.style.left = left + "px";
}

function onChartMove(event) {
  if (!chartPoints.length) return;
  const rect = els.costChart.getBoundingClientRect();
  if (!rect.width) return;
  const px = ((event.clientX - rect.left) / rect.width) * CHART_W;
  const span = chartPoints.length > 1 ? chartPoints.length - 1 : 1;
  const step = (CHART_W - CHART_PAD_X * 2) / span;
  const index = Math.max(0, Math.min(chartPoints.length - 1, Math.round((px - CHART_PAD_X) / step)));
  showChartTip(index);
}

function drawCostChart(points, currency) {
  const svg = els.costChart;
  const NS = "http://www.w3.org/2000/svg";
  svg.textContent = "";
  hideChartTip();
  chartPoints = points;
  chartCoords = [];
  chartCurrency = currency || "CNY";
  const node = (name, attrs) => {
    const el = document.createElementNS(NS, name);
    for (const key of Object.keys(attrs)) el.setAttribute(key, String(attrs[key]));
    svg.appendChild(el);
    return el;
  };

  const bottom = CHART_H - CHART_PAD_Y;
  for (let i = 0; i < 3; i += 1) {
    const y = CHART_PAD_Y + ((CHART_H - CHART_PAD_Y * 2) / 2) * i;
    node("line", {
      x1: CHART_PAD_X,
      x2: CHART_W - CHART_PAD_X,
      y1: y,
      y2: y,
      stroke: "rgba(255, 255, 255, 0.06)",
      "stroke-dasharray": "3 5",
    });
  }

  if (!points.length) {
    node("line", {
      x1: CHART_PAD_X,
      x2: CHART_W - CHART_PAD_X,
      y1: bottom,
      y2: bottom,
      stroke: "rgba(255, 255, 255, 0.14)",
    });
    els.costAxisStart.textContent = "";
    els.costAxisMid.textContent = "";
    els.costAxisEnd.textContent = "";
    chartPoints = [];
    return;
  }

  const max = Math.max(...points.map((point) => point.value), 0);
  const scale = max > 0 ? max : 1;
  const span = points.length > 1 ? points.length - 1 : 1;
  const x = (index) => CHART_PAD_X + (index / span) * (CHART_W - CHART_PAD_X * 2);
  const y = (value) => bottom - (value / scale) * (CHART_H - CHART_PAD_Y * 2);

  const defs = node("defs", {});
  const gradient = document.createElementNS(NS, "linearGradient");
  gradient.setAttribute("id", "cost-fill");
  gradient.setAttribute("x1", "0");
  gradient.setAttribute("y1", "0");
  gradient.setAttribute("x2", "0");
  gradient.setAttribute("y2", "1");
  const stopTop = document.createElementNS(NS, "stop");
  stopTop.setAttribute("offset", "0%");
  stopTop.setAttribute("stop-color", "#ffa838");
  stopTop.setAttribute("stop-opacity", "0.32");
  const stopBottom = document.createElementNS(NS, "stop");
  stopBottom.setAttribute("offset", "100%");
  stopBottom.setAttribute("stop-color", "#ffa838");
  stopBottom.setAttribute("stop-opacity", "0");
  gradient.append(stopTop, stopBottom);
  defs.appendChild(gradient);

  const coords = points.map((point, index) => [x(index), y(point.value)]);
  chartCoords = coords;
  const line = coords
    .map(([px, py], index) => (index === 0 ? "M" : "L") + px.toFixed(2) + " " + py.toFixed(2))
    .join(" ");
  const area =
    line +
    " L" + x(points.length - 1).toFixed(2) + " " + bottom +
    " L" + x(0).toFixed(2) + " " + bottom +
    " Z";

  node("path", { d: area, fill: "url(#cost-fill)", stroke: "none" });
  node("path", {
    d: line,
    fill: "none",
    stroke: "#ffc86a",
    "stroke-width": 1.6,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "vector-effect": "non-scaling-stroke",
  });
  const [lastX, lastY] = coords[coords.length - 1];
  node("circle", { cx: lastX.toFixed(2), cy: lastY.toFixed(2), r: 2.6, fill: "#ffd79a" });

  const midIndex = Math.floor((points.length - 1) / 2);
  els.costAxisStart.textContent = formatAxisLabel(points[0].label);
  els.costAxisMid.textContent = points.length > 2 ? formatAxisLabel(points[midIndex].label) : "";
  els.costAxisEnd.textContent = points.length > 1 ? formatAxisLabel(points[points.length - 1].label) : "";
}

function formatCost(value, currency) {
  const amount = Number(value) || 0;
  if (amount > 0 && amount < 0.01) return "<" + formatBalance(0.01, currency);
  return formatBalance(amount, currency);
}

function renderCostTabs() {
  for (const btn of els.costTabs.querySelectorAll("button")) {
    btn.classList.toggle("on", btn.dataset.range === costRange);
  }
}

function renderCost(view) {
  const loggedIn = !!view.loggedIn;
  const range = COST_RANGES.find((item) => item.key === costRange) || COST_RANGES[0];
  const points = loggedIn ? condensePoints(view.trends && view.trends[range.trend]) : [];
  const total = Number(view[range.field]) || 0;

  els.costTotal.textContent = loggedIn && !view.costError ? formatCost(total, view.currency) : "—";

  // 面板每 500ms 轮询一次，数据没变就不要重画折线
  const key = costRange + "|" + (view.updatedAt || 0) + "|" + (view.costError ? 1 : 0) + "|" + points.length;
  if (key !== chartKey) {
    drawCostChart(points, view.currency);
    chartKey = key;
  }

  if (!loggedIn) {
    els.costPeak.textContent = "登录后查看";
  } else if (view.costError) {
    els.costPeak.textContent = "消费数据读取失败";
  } else if (!points.length) {
    els.costPeak.textContent = "暂无消费";
  } else {
    const peak = Math.max(...points.map((point) => point.value));
    els.costPeak.textContent = "峰值 " + formatCost(peak, view.currency);
  }
  renderCostTabs();
}

function renderUsage(view) {
  if (!view) return;
  lastView = view;

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

  const showCost = loggedIn && !view.costError;
  els.todayCost.textContent = showCost ? formatCost(view.costToday, view.currency) : "—";
  els.yesterdayCost.textContent = showCost ? formatCost(view.costYesterday, view.currency) : "—";
  els.monthCost.textContent = showCost ? formatCost(view.costMonth, view.currency) : "—";
  els.balance.textContent = loggedIn
    ? "余额 " + formatBalance(view.balance, view.currency)
    : "余额 --";
  fire.setBalance(loggedIn ? view.balance : null, view.currency, dailyCostOf(view));

  const updated = timeText(view.updatedAt);
  els.usageHint.textContent = updated
    ? "更新于 " + updated + " · 官方数据约延迟 5 分钟"
    : "数据约延迟 5 分钟";

  renderCost(view);

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
els.costChart.addEventListener("pointermove", onChartMove);
els.costChart.addEventListener("pointerleave", hideChartTip);
els.costTabs.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-range]");
  if (!btn) return;
  costRange = btn.dataset.range;
  try {
    localStorage.setItem("token-fire:cost-range", costRange);
  } catch (err) {
    /* 忽略无法保存的偏好 */
  }
  if (lastView) renderCost(lastView);
});
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
