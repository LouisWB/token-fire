// DeepSeek 用量：使用官方登录页完成认证，再在同一个 WebView 里读取官方用量接口。
// 不保存账号密码，也不把登录 Token 写入应用配置。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewWindow};

const LOGIN_URL: &str = "https://platform.deepseek.com/sign_in";
const USAGE_URL: &str = "https://platform.deepseek.com/usage";
const SYNC_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_INTERVAL: Duration = Duration::from_millis(900);
const LOGGED_IN_INTERVAL: Duration = Duration::from_secs(60);
const LOGGED_OUT_INTERVAL: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct View {
    pub logged_in: bool,
    pub syncing: bool,
    pub today_tokens: f64,
    pub yesterday_tokens: f64,
    pub month_tokens: f64,
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
            updated_at: None,
            account: String::new(),
            message: "请登录 DeepSeek".to_string(),
            error: None,
        }
    }
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
        self.in_flight = false;
        self.view.logged_in = value
            .get("loggedIn")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.view.syncing = false;
        self.view.today_tokens = number(value, "todayTokens");
        self.view.yesterday_tokens = number(value, "yesterdayTokens");
        self.view.month_tokens = number(value, "monthTokens");
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
    if let Err(err) = ensure_window(app) {
        if let Some(state) = app.try_state::<crate::AppState>() {
            state.deepseek.lock().unwrap().fail(err);
        }
        return;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
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
            }
        }
        // 新窗口需要一点时间完成首次页面加载，再注入官方页面内的同步脚本。
        std::thread::sleep(Duration::from_millis(1200));
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
                    state.deepseek.lock().unwrap().apply(&value);
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

  const sumSeries = (data) => {
    let tokens = 0;
    for (const series of (data && data.series) || []) {
      for (const bucket of series.buckets || []) {
        const usage = bucket.usage || {};
        tokens += Number(usage.PROMPT_CACHE_HIT_TOKEN) || 0;
        tokens += Number(usage.PROMPT_CACHE_MISS_TOKEN) || 0;
        tokens += Number(usage.RESPONSE_TOKEN) || 0;
      }
    }
    return tokens;
  };

  (async () => {
    try {
      const token = storedValue("userToken");
      if (typeof token !== "string" || !token) {
        window.__tokenFireSync = {
          ...window.__tokenFireSync,
          message: "请先登录 DeepSeek",
        };
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const tz = -new Date().getTimezoneOffset() * 60;
      const localNow = new Date((now + tz) * 1000);
      const year = localNow.getUTCFullYear();
      const month = localNow.getUTCMonth();
      const day = localNow.getUTCDate();
      const dayStart = Date.UTC(year, month, day) / 1000 - tz;
      const yesterdayStart = dayStart - 86400;
      const monthStart = Date.UTC(year, month, 1) / 1000 - tz;
      const deviceId = localStorage.getItem("deepseek-device-id:platform") || "";
      const headers = {
        accept: "application/json",
        authorization: "Bearer " + token,
        "x-device-id": deviceId,
        "x-device-model": "",
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
        return sumSeries(payload && payload.data && payload.data.biz_data);
      };

      const [todayTokens, yesterdayTokens, monthTokens] = await Promise.all([
        amount(dayStart, now),
        amount(yesterdayStart, dayStart),
        amount(monthStart, now),
      ]);
      const user = storedValue("__appKit_userInfo");
      const id = user && typeof user === "object" ? user.id : null;
      window.__tokenFireSync = {
        loggedIn: true,
        todayTokens,
        yesterdayTokens,
        monthTokens,
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
  })();
})();
"#;
