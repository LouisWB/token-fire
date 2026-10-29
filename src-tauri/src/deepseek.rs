// DeepSeek 用量：使用官方登录页完成认证，再在同一个 WebView 里读取官方用量接口。
// 不保存账号密码，也不把登录 Token 写入应用配置。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const LOGIN_URL: &str = "https://platform.deepseek.com/sign_in";
const USAGE_URL: &str = "https://platform.deepseek.com/usage";
const SYNC_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_INTERVAL: Duration = Duration::from_millis(400);
const LOGGED_IN_INTERVAL: Duration = Duration::from_secs(20);
const LOGGED_OUT_INTERVAL: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct View {
    pub logged_in: bool,
    pub syncing: bool,
    pub today_tokens: f64,
    pub yesterday_tokens: f64,
    pub month_tokens: f64,
    pub cost_today: f64,
    pub cost_yesterday: f64,
    pub cost_week: f64,
    pub cost_month: f64,
    pub cost_year: f64,
    pub cost_error: bool,
    pub trends: Trends,
    pub balance: f64,
    pub currency: String,
    pub updated_at: Option<i64>,
    pub account: String,
    pub message: String,
    pub error: Option<String>,
}

impl Default for View {
    fn default() -> Self {
        Self {
            logged_in: false,
            syncing: false,
            today_tokens: 0.0,
            yesterday_tokens: 0.0,
            month_tokens: 0.0,
            cost_today: 0.0,
            cost_yesterday: 0.0,
            cost_week: 0.0,
            cost_month: 0.0,
            cost_year: 0.0,
            cost_error: false,
            trends: Trends::default(),
            balance: 0.0,
            currency: "CNY".to_string(),
            updated_at: None,
            account: String::new(),
            message: "请登录 DeepSeek".to_string(),
            error: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TrendPoint {
    pub label: String,
    pub value: f64,
    pub tokens: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Trends {
    pub today: Vec<TrendPoint>,
    pub week: Vec<TrendPoint>,
    pub month: Vec<TrendPoint>,
    pub year: Vec<TrendPoint>,
}

#[derive(Default)]
pub struct State {
    pub view: View,
    in_flight: bool,
    requested_at: Option<Instant>,
    last_started: Option<Instant>,
    last_probe: Option<Instant>,
}

pub enum Work {
    None,
    Start,
    Probe,
}

impl State {
    pub fn prepare(&mut self) -> Work {
        let now = Instant::now();

        if self.in_flight {
            if self
                .requested_at
                .is_some_and(|at| now.duration_since(at) >= SYNC_TIMEOUT)
            {
                self.in_flight = false;
                self.view.syncing = false;
                self.view.error = Some("同步超时，请检查网络后重试".to_string());
                return Work::None;
            }
            if self
                .last_probe
                .map_or(true, |at| now.duration_since(at) >= PROBE_INTERVAL)
            {
                self.last_probe = Some(now);
                return Work::Probe;
            }
            return Work::None;
        }

        let interval = if self.view.logged_in {
            LOGGED_IN_INTERVAL
        } else {
            LOGGED_OUT_INTERVAL
        };
        if self
            .last_started
            .map_or(true, |at| now.duration_since(at) >= interval)
        {
            self.in_flight = true;
            self.requested_at = Some(now);
            self.last_started = Some(now);
            self.last_probe = None;
            self.view.syncing = true;
            self.view.error = None;
            return Work::Start;
        }

        // 登录页会在客户端直接写入 Token，不一定会触发整页刷新。
        // 未登录时持续读取页面内的同步结果，登录成功即可立刻更新状态。
        if !self.view.logged_in
            && self
                .last_probe
                .map_or(true, |at| now.duration_since(at) >= PROBE_INTERVAL)
        {
            self.last_probe = Some(now);
            return Work::Probe;
        }

        Work::None
    }

    pub fn request_now(&mut self) -> Work {
        let now = Instant::now();
        self.in_flight = true;
        self.requested_at = Some(now);
        self.last_started = Some(now);
        self.last_probe = None;
        self.view.syncing = true;
        self.view.error = None;
        Work::Start
    }

    pub fn apply(&mut self, value: &Value) {
        let syncing = value
            .get("syncing")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.in_flight = syncing;
        self.view.logged_in = value
            .get("loggedIn")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.view.syncing = syncing;
        self.view.today_tokens = number(value, "todayTokens");
        self.view.yesterday_tokens = number(value, "yesterdayTokens");
        self.view.month_tokens = number(value, "monthTokens");
        self.view.cost_today = number(value, "costToday");
        self.view.cost_yesterday = number(value, "costYesterday");
        self.view.cost_week = number(value, "costWeek");
        self.view.cost_month = number(value, "costMonth");
        self.view.cost_year = number(value, "costYear");
        self.view.cost_error = value
            .get("costError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let Some(trends) = value.get("trends") {
            self.view.trends = serde_json::from_value(trends.clone()).unwrap_or_default();
        }
        self.view.balance = number(value, "balance");
        self.view.currency = value
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("CNY")
            .to_string();
        self.view.updated_at = value.get("updatedAt").and_then(Value::as_i64);
        self.view.account = value
            .get("account")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        self.view.message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        self.view.error = value
            .get("error")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
    }

    pub fn fail(&mut self, message: impl Into<String>) {
        self.in_flight = false;
        self.view.syncing = false;
        self.view.error = Some(message.into());
    }
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("deepseek")
        .ok_or_else(|| "找不到 DeepSeek 登录窗口".to_string())
}

pub fn open(app: &AppHandle, logged_in: bool) -> Result<(), String> {
    let target = if logged_in { USAGE_URL } else { LOGIN_URL };
    let window = ensure_window(app)?;
    window
        .show()
        .map_err(|err| format!("显示 DeepSeek 登录页失败：{err}"))?;
    let _ = window.set_focus();

    // WebView2 对直接的外部初始 URL 支持不稳定，先加载应用内跳转页，再做一次导航。
    let url = serde_json::to_string(target).map_err(|err| format!("DeepSeek 地址无效：{err}"))?;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        let _ = window.eval(format!("location.replace({url})"));
    });
    Ok(())
}

pub fn start(app: &AppHandle) {
    start_after(app, Duration::from_millis(500));
}

fn start_after(app: &AppHandle, delay: Duration) {
    if let Err(err) = ensure_window(app) {
        if let Some(state) = app.try_state::<crate::AppState>() {
            state.deepseek.lock().unwrap().fail(err);
        }
        return;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let mut navigated = false;
        if let Some(window) = handle.get_webview_window("deepseek") {
            let needs_navigation = window
                .url()
                .map(|url| {
                    url.scheme() == "tauri"
                        || url.scheme() == "about"
                        || url.as_str() == "about:blank"
                })
                .unwrap_or(true);
            if needs_navigation {
                let _ = window.eval("location.replace('https://platform.deepseek.com/usage')");
                navigated = true;
            }
        }
        // 新窗口需要一点时间完成首次页面加载，再注入官方页面内的同步脚本。
        std::thread::sleep(if navigated {
            Duration::from_millis(900)
        } else {
            Duration::from_millis(50)
        });
        if let Some(window) = handle.get_webview_window("deepseek") {
            if let Err(err) = window.eval(SYNC_SCRIPT) {
                if let Some(state) = handle.try_state::<crate::AppState>() {
                    state
                        .deepseek
                        .lock()
                        .unwrap()
                        .fail(format!("读取 DeepSeek 失败：{err}"));
                }
            }
        }
    });
}

pub fn probe(app: &AppHandle) {
    let Some(window) = app.get_webview_window("deepseek") else {
        return;
    };
    let handle = app.clone();
    let _ = window.eval_with_callback(
        "window.__tokenFireSync ? JSON.stringify(window.__tokenFireSync) : ''",
        move |raw| {
            if let Some(value) = decode_result(&raw) {
                if let Some(state) = handle.try_state::<crate::AppState>() {
                    let view = {
                        let mut ds = state.deepseek.lock().unwrap();
                        ds.apply(&value);
                        ds.view.clone()
                    };
                    let _ = handle.emit("deepseek-changed", view);
                }
            }
        },
    );
}

fn decode_result(raw: &str) -> Option<Value> {
    let outer = serde_json::from_str::<Value>(raw).ok()?;
    match outer {
        Value::String(text) if !text.is_empty() && text != "null" => {
            serde_json::from_str::<Value>(&text).ok()
        }
        Value::Object(_) | Value::Array(_) => Some(outer),
        _ => None,
    }
}

const SYNC_SCRIPT: &str = r#"
(() => {
  window.__tokenFireSync = {
    loggedIn: false,
    todayTokens: 0,
    yesterdayTokens: 0,
    monthTokens: 0,
    costToday: 0,
    costYesterday: 0,
    costWeek: 0,
    costMonth: 0,
    costYear: 0,
    costError: false,
    trends: { today: [], week: [], month: [], year: [] },
    balance: 0,
    currency: "CNY",
    updatedAt: null,
    account: "",
    message: "正在读取 DeepSeek…",
    error: null,
  };

  const storedValue = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : parsed;
    } catch {
      return null;
    }
  };

  const runSync = async () => {
    try {
      const token = storedValue("userToken");
      if (typeof token !== "string" || !token) {
        window.__tokenFireSync = {
          ...window.__tokenFireSync,
          message: "请先登录 DeepSeek",
        };
        return;
      }

      window.__tokenFireSync = {
        ...window.__tokenFireSync,
        loggedIn: true,
        syncing: true,
        updatedAt: Date.now(),
        message: "正在同步 DeepSeek 用量…",
      };

      const now = Math.floor(Date.now() / 1000);
      const tz = -new Date().getTimezoneOffset() * 60;
      const localNow = new Date((now + tz) * 1000);
      const year = localNow.getUTCFullYear();
      const month = localNow.getUTCMonth();
      const day = localNow.getUTCDate();
      const dayStart = Date.UTC(year, month, day) / 1000 - tz;
      const yesterdayStart = dayStart - 86400;
      const monthStart = Date.UTC(year, month, 1) / 1000 - tz;
      const weekStart = dayStart - ((localNow.getUTCDay() + 6) % 7) * 86400;
      const yearStart = Date.UTC(year, 0, 1) / 1000 - tz;
      const tomorrowStart = dayStart + 86400;
      const deviceId = localStorage.getItem("deepseek-device-id:platform") || "";
      const headers = {
        accept: "application/json",
        authorization: "Bearer " + token,
        "x-device-id": deviceId,
        "x-device-model": "",
      };

      // bucket.time 是秒级时间戳；bucket 是桶宽（秒），小于一天按小时展示
      const pad2 = (value) => String(value).padStart(2, "0");
      const timeLabel = (value, hourly) => {
        const ms = Number(value) * 1000;
        if (!Number.isFinite(ms) || ms <= 0) return String(value || "");
        const date = new Date(ms);
        return hourly
          ? pad2(date.getHours()) + ":" + pad2(date.getMinutes())
          : date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
      };

      const amount = async (start, end) => {
        const query = "?start=" + start + "&end=" + end + "&tz=" + tz;
        const response = await fetch("/api/v0/usage/by_api_key/amount" + query, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers,
        });
        const payload = await response.json();
        if (payload && payload.code !== 0) {
          const error = new Error(payload.msg || "DeepSeek 用量读取失败");
          error.code = payload.code;
          throw error;
        }
        const biz = (payload && payload.data && payload.data.biz_data) || {};
        const step = Number(biz.bucket) || 0;
        const hourly = step > 0 && step < 86400;
        const buckets = new Map();
        for (const series of biz.series || []) {
          for (const bucket of series.buckets || []) {
            const usage = bucket.usage || {};
            const tokens =
              (Number(usage.PROMPT_CACHE_HIT_TOKEN) || 0) +
              (Number(usage.PROMPT_CACHE_MISS_TOKEN) || 0) +
              (Number(usage.RESPONSE_TOKEN) || 0);
            const label = timeLabel(bucket.time, hourly);
            buckets.set(label, (buckets.get(label) || 0) + tokens);
          }
        }
        const points = [];
        let total = 0;
        buckets.forEach((value, label) => {
          points.push({ label, value });
          total += value;
        });
        return { total, points };
      };

      const summary = async () => {
        const response = await fetch("/api/v0/users/get_user_summary", {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers,
        });
        const payload = await response.json();
        if (payload && payload.code !== 0) {
          const error = new Error(payload.msg || "DeepSeek 余额读取失败");
          error.code = payload.code;
          throw error;
        }
        const biz = payload && payload.data && payload.data.biz_data;
        const wallets = [...(biz.normal_wallets || []), ...(biz.bonus_wallets || [])];
        const wallet = wallets.find((item) => item.currency === "CNY") || wallets[0];
        if (!wallet) return { balance: 0, currency: "CNY" };
        const currency = wallet.currency || "CNY";
        const balance = wallets
          .filter((item) => (item.currency || "CNY") === currency)
          .reduce((total, item) => total + (Number(item.balance) || 0), 0);
        return { balance, currency };
      };

      // 官方按币种分组返回消费金额，每组内按 API Key / 模型拆成 series。
      const cost = async (start, end) => {
        const query = "?start=" + start + "&end=" + end + "&tz=" + tz;
        const response = await fetch("/api/v0/usage/by_api_key/cost" + query, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers,
        });
        const payload = await response.json();
        if (payload && payload.code !== 0) {
          const error = new Error(payload.msg || "DeepSeek 消费金额读取失败");
          error.code = payload.code;
          throw error;
        }
        const biz = (payload && payload.data && payload.data.biz_data) || {};
        const groups = biz.data || [];
        const step = Number(biz.bucket) || 0;
        const hourly = step > 0 && step < 86400;
        return groups.map((group) => {
          const buckets = new Map();
          for (const series of group.series || []) {
            for (const bucket of series.buckets || []) {
              const label = timeLabel(bucket.time, hourly);
              const value = Number(bucket.cost) || 0;
              buckets.set(label, (buckets.get(label) || 0) + value);
            }
          }
          const points = [];
          let total = 0;
          buckets.forEach((value, label) => {
            points.push({ label, value });
            total += value;
          });
          return { currency: group.currency || "CNY", total, points };
        });
      };

      // 消费接口是官方页面的内部接口，读不到时只降级这一块，别拖垮 Token 和余额
      let costError = false;
      const safeCost = async (start, end) => {
        try {
          return await cost(start, end);
        } catch (error) {
          costError = true;
          return [];
        }
      };

      const pickCost = (groups, currency) => {
        const list = groups || [];
        return list.find((item) => item.currency === currency) || list[0] || { total: 0, points: [] };
      };

      // 金额和 Token 按时间桶对齐，悬停时同一行显示两项
      const mergeTrend = (tokenPoints, costPoints) => {
        const merged = new Map();
        for (const point of tokenPoints || []) {
          merged.set(point.label, { label: point.label, value: 0, tokens: point.value });
        }
        for (const point of costPoints || []) {
          const current = merged.get(point.label);
          if (current) current.value += point.value;
          else merged.set(point.label, { label: point.label, value: point.value, tokens: 0 });
        }
        return [...merged.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
      };

      const [todayAmount, yesterdayAmount, monthAmount, weekAmount, yearAmount, wallet, todayCost, yesterdayCost, weekCost, monthCost, yearCost] = await Promise.all([
        amount(dayStart, tomorrowStart),
        amount(yesterdayStart, dayStart),
        amount(monthStart, tomorrowStart),
        amount(weekStart, tomorrowStart),
        amount(yearStart, tomorrowStart),
        summary(),
        safeCost(dayStart, tomorrowStart),
        safeCost(yesterdayStart, dayStart),
        safeCost(weekStart, tomorrowStart),
        safeCost(monthStart, tomorrowStart),
        safeCost(yearStart, tomorrowStart),
      ]);
      const todayView = pickCost(todayCost, wallet.currency);
      const yesterdayView = pickCost(yesterdayCost, wallet.currency);
      const weekView = pickCost(weekCost, wallet.currency);
      const monthView = pickCost(monthCost, wallet.currency);
      const yearView = pickCost(yearCost, wallet.currency);
      const user = storedValue("__appKit_userInfo");
      const id = user && typeof user === "object" ? user.id : null;
      window.__tokenFireSync = {
        loggedIn: true,
        todayTokens: todayAmount.total,
        yesterdayTokens: yesterdayAmount.total,
        monthTokens: monthAmount.total,
        costToday: todayView.total,
        costYesterday: yesterdayView.total,
        costWeek: weekView.total,
        costMonth: monthView.total,
        costYear: yearView.total,
        costError,
        trends: {
          today: mergeTrend(todayAmount.points, todayView.points),
          week: mergeTrend(weekAmount.points, weekView.points),
          month: mergeTrend(monthAmount.points, monthView.points),
          year: mergeTrend(yearAmount.points, yearView.points),
        },
        balance: wallet.balance,
        currency: wallet.currency,
        updatedAt: Date.now(),
        account: id ? "DeepSeek ID " + id : "已连接 DeepSeek",
        message: "已连接 DeepSeek",
        error: null,
      };
    } catch (error) {
      const expired = error && (error.code === 40002 || error.code === 40003);
      window.__tokenFireSync = {
        ...window.__tokenFireSync,
        loggedIn: expired ? false : !!storedValue("userToken"),
        updatedAt: Date.now(),
        message: expired ? "登录已过期，请重新登录" : "DeepSeek 同步失败",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  runSync();
  if (!window.__tokenFireWatch) {
    let seenToken = storedValue("userToken") || "";
    window.__tokenFireWatch = setInterval(() => {
      const nextToken = storedValue("userToken") || "";
      if (nextToken !== seenToken) {
        seenToken = nextToken;
        runSync();
      }
    }, 300);
  }
})();
"#;
