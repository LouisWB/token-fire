// 读取 ccswitch 的本地用量库，算出"每秒烧多少 token"
//
// 注意它的先天短板：proxy_request_logs 是请求**结束**时才落一行，
// 一轮 Codex 要跑 20 多秒，所以拿它当火势主源看着就像反的。
// 现在它主要干两件事：兜底，以及给实时流当"真实 token 数"的标定基准。
use crate::sources::SourceStatus;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 指数衰减的时间常数：越大火越"钝"，回落越慢
pub const TAU_SECONDS: f64 = 12.0;

pub fn default_conf_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".cc-switch")
}

pub fn default_db_path() -> PathBuf {
    default_conf_dir().join("cc-switch.db")
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Rates {
    pub total: f64,
    pub fresh: f64,
    pub output: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    pub rates: Rates,
    pub requests: u32,
    pub idle_seconds: Option<f64>,
    pub tau_seconds: f64,
    pub error: Option<String>,
}

impl Sample {
    fn failed(message: String) -> Self {
        Self {
            rates: Rates::default(),
            requests: 0,
            idle_seconds: None,
            tau_seconds: TAU_SECONDS,
            error: Some(message),
        }
    }
}

/// 标定要用的那一小撮字段：一条请求什么时候结束、真实吐了多少 token
#[derive(Debug, Clone)]
pub struct Spend {
    pub created_at: i64,
    pub latency_ms: i64,
    pub first_token_ms: i64,
    pub output_tokens: i64,
    pub app_type: String,
}

/// ccswitch 常见安装位置，找不到再让 where 兜底
const APP_CANDIDATES: [&str; 6] = [
    r"C:\simp\cc-switch.exe",
    r"%LOCALAPPDATA%\Programs\cc-switch\cc-switch.exe",
    r"%LOCALAPPDATA%\cc-switch\cc-switch.exe",
    r"%ProgramFiles%\cc-switch\cc-switch.exe",
    r"%ProgramFiles(x86)%\cc-switch\cc-switch.exe",
    r"%USERPROFILE%\scoop\apps\cc-switch\current\cc-switch.exe",
];

fn expand(raw: &str) -> PathBuf {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        match tail.find('%') {
            Some(end) => {
                let key = &tail[..end];
                match std::env::var(key) {
                    Ok(value) => out.push_str(&value),
                    Err(_) => {
                        out.push('%');
                        out.push_str(key);
                        out.push('%');
                    }
                }
                rest = &tail[end + 1..];
            }
            None => {
                out.push('%');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    PathBuf::from(out)
}

fn find_app() -> Option<String> {
    for candidate in APP_CANDIDATES {
        let path = expand(candidate);
        if path.is_file() {
            return Some(path.to_string_lossy().into_owned());
        }
    }

    // PATH 里装的也能认出来；顺带别弹出黑框
    #[cfg(windows)]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("where")
            .arg("cc-switch")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };
    #[cfg(not(windows))]
    let output = std::process::Command::new("which").arg("cc-switch").output();

    if let Ok(output) = output {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = text.lines().map(str::trim).find(|l| !l.is_empty()) {
                return Some(line.to_string());
            }
        }
    }
    None
}

fn open(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| format!("打不开用量库：{err}"))?;
    // 库可能正被 ccswitch 写入，短暂拿不到读锁时稍等一会儿再试
    let _ = conn.busy_timeout(Duration::from_millis(400));
    Ok(conn)
}

fn count_rows(db_path: &Path) -> i64 {
    let Ok(conn) = open(db_path) else {
        return -1;
    };
    conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
        row.get::<_, i64>(0)
    })
    .unwrap_or(-1)
}

const SPEND_SQL: &str = "
    SELECT created_at,
           COALESCE(latency_ms, 0),
           COALESCE(first_token_ms, 0),
           COALESCE(output_tokens, 0),
           COALESCE(app_type, '')
    FROM proxy_request_logs
    WHERE created_at > ?1
    ORDER BY created_at
    LIMIT 200
";

/// 拉一小批刚结束的请求，给实时流当标定基准。
/// 用 > 而不是 >=：cursor 记的是上次见过的最大 created_at，
/// 用 >= 会让同一秒那几笔请求每次都被重新标定一遍。
pub fn spend_since(db_path: &Path, since: i64) -> Result<Vec<Spend>, String> {
    let conn = open(db_path)?;
    let mut stmt = conn.prepare(SPEND_SQL).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([since], |row| {
            Ok(Spend {
                created_at: row.get(0)?,
                latency_ms: row.get(1)?,
                first_token_ms: row.get(2)?,
                output_tokens: row.get(3)?,
                app_type: row.get(4)?,
            })
        })
        .map_err(|err| err.to_string())?;
    Ok(rows.flatten().collect())
}

/// 摆件/面板展示用的状态。找不到 ccswitch 时把该去哪儿找也说清楚
pub fn status(db_path: &Path) -> SourceStatus {
    let conf_dir = default_conf_dir();
    let db_found = db_path.is_file();
    let conf_found = conf_dir.is_dir();
    let rows = if db_found { count_rows(db_path) } else { -1 };
    // 找 cc-switch.exe 要 spawn 一次 where，只在真需要给提示的时候才找
    let app_path = if db_found && rows > 0 { None } else { find_app() };

    let db_text = db_path.to_string_lossy().into_owned();
    let dir_text = conf_dir.to_string_lossy().into_owned();

    let mut status = SourceStatus {
        id: "ccswitch".to_string(),
        name: "cc-switch 用量库".to_string(),
        short: String::new(),
        detail: String::new(),
        path: db_text.clone(),
        live: false,
        experimental: false,
        available: db_found && rows > 0,
        level: "ok".to_string(),
    };

    if db_found && rows > 0 {
        status.detail = format!(
            "已连上 ccswitch 用量库，累计 {rows} 条请求记录。数字最准，但请求结束才落库，比实时流慢半拍。"
        );
    } else if db_found && rows == 0 {
        status.level = "warn".to_string();
        status.short = "还没有用量记录".to_string();
        status.detail = format!(
            "找到用量库了，但里面还没有请求记录 —— 用 ccswitch 转发一次 Codex / Claude 请求，火就烧起来了（{db_text}）"
        );
    } else if db_found {
        status.level = "bad".to_string();
        status.short = "用量库读不出来".to_string();
        status.detail = format!("找到了用量库但读不出来，可能 ccswitch 正在写：{db_text}");
    } else if let Some(app) = &app_path {
        status.level = "bad".to_string();
        status.short = "还没有用量库".to_string();
        status.detail =
            format!("找到 ccswitch（{app}），但还没有用量库。启动 ccswitch 并至少转发一次请求，就会生成 {db_text}");
    } else if conf_found {
        status.level = "bad".to_string();
        status.short = "缺 cc-switch.db".to_string();
        status.detail = format!("有 {dir_text} 目录，但里面没有 cc-switch.db，ccswitch 可能被清理过");
    } else {
        status.level = "bad".to_string();
        status.short = "没找到 cc-switch".to_string();
        status.detail =
            format!("没在系统里找到 ccswitch：既没有 {dir_text}，也没在常见位置看到 cc-switch.exe");
    }
    status
}

// created_at 是 Unix 秒，不是毫秒
const ROWS_SQL: &str = "
    SELECT created_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
    FROM proxy_request_logs
    WHERE created_at >= ?1
    ORDER BY created_at DESC
";

// 实测 cache_read_tokens 永远不大于 input_tokens，
// 说明 input_tokens 是"总 prompt"，已包含缓存命中，算总量不能再加一次
fn total_tokens(input: i64, output: i64, cache_creation: i64) -> f64 {
    (input + output + cache_creation) as f64
}

// 真正新算的 token（不含缓存命中）
fn fresh_tokens(input: i64, output: i64, cache_read: i64, cache_creation: i64) -> f64 {
    (input - cache_read).max(0) as f64 + output as f64 + cache_creation as f64
}

/// 瞬时速率：每条请求的 token 按"距今多久"衰减后再除以时间常数。
/// 刚跑完一大轮火会很旺，然后自然慢慢熄灭，而不是到点突然归零。
pub fn sample(db_path: &Path, tau: f64) -> Sample {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let conn = match open(db_path) {
        Ok(conn) => conn,
        Err(err) => return Sample::failed(err),
    };

    let since = now - (tau * 5.0).ceil() as i64;
    let mut stmt = match conn.prepare(ROWS_SQL) {
        Ok(stmt) => stmt,
        Err(err) => return Sample::failed(format!("查询失败：{err}")),
    };

    let rows = stmt.query_map([since], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    });

    let rows = match rows {
        Ok(rows) => rows,
        Err(err) => return Sample::failed(format!("读取失败：{err}")),
    };

    let mut total_weight = 0.0f64;
    let mut fresh_weight = 0.0f64;
    let mut output_weight = 0.0f64;
    let mut requests = 0u32;
    let mut last_activity: Option<i64> = None;

    for row in rows.flatten() {
        let (created_at, input, output, cache_read, cache_creation) = row;
        let age = (now - created_at).max(0) as f64;
        last_activity = Some(last_activity.map_or(created_at, |prev| prev.max(created_at)));

        let weight = (-age / tau).exp();
        total_weight += total_tokens(input, output, cache_creation) * weight;
        fresh_weight += fresh_tokens(input, output, cache_read, cache_creation) * weight;
        output_weight += output as f64 * weight;
        requests += 1;
    }

    let idle_seconds = last_activity.map(|at| (now - at).max(0) as f64);
    Sample {
        rates: Rates {
            total: total_weight / tau,
            fresh: fresh_weight / tau,
            output: output_weight / tau,
        },
        requests,
        idle_seconds,
        tau_seconds: tau,
        error: None,
    }
}