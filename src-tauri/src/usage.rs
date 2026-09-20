// 读取 ccswitch 的本地用量库，算出"每秒烧多少 token"
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

/// 启动时先摸一遍系统里有没有 ccswitch，好让摆件能给出人话提示
#[derive(Debug, Clone, Serialize)]
pub struct Env {
    pub db_path: String,
    pub db_found: bool,
    pub conf_dir: String,
    pub conf_found: bool,
    /// 找到的 ccswitch 可执行文件
    pub app_path: Option<String>,
    /// proxy_request_logs 里的记录数，-1 表示读不到
    pub rows: i64,
    /// ok | warn | bad
    pub level: String,
    /// 摆件上那一行小字，长了放不下
    pub short: String,
    /// 给设置面板看的一整句话
    pub message: String,
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

fn count_rows(db_path: &Path) -> i64 {
    let Ok(conn) = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return -1;
    };
    let _ = conn.busy_timeout(Duration::from_millis(400));
    conn.query_row("SELECT COUNT(*) FROM proxy_request_logs", [], |row| {
        row.get::<_, i64>(0)
    })
    .unwrap_or(-1)
}

pub fn probe_env(db_path: &Path) -> Env {
    let conf_dir = default_conf_dir();
    let db_found = db_path.is_file();
    let conf_found = conf_dir.is_dir();
    let app_path = find_app();
    let rows = if db_found { count_rows(db_path) } else { -1 };

    let db_text = db_path.to_string_lossy().into_owned();
    let dir_text = conf_dir.to_string_lossy().into_owned();

    let (level, short, message) = if db_found && rows > 0 {
        (
            "ok",
            String::new(),
            format!("已连上 ccswitch 用量库，累计 {rows} 条请求记录"),
        )
    } else if db_found && rows == 0 {
        (
            "warn",
            "还没有用量记录".to_string(),
            "找到用量库了，但里面还没有请求记录 —— 用 ccswitch 转发一次 Codex / Claude 请求，火就烧起来了"
                .to_string(),
        )
    } else if db_found {
        (
            "bad",
            "用量库读不出来".to_string(),
            format!("找到了用量库但读不出来，可能 ccswitch 正在写：{db_text}"),
        )
    } else if let Some(app) = &app_path {
        (
            "bad",
            "还没有用量库".to_string(),
            format!(
                "找到 ccswitch（{app}），但还没有用量库。启动 ccswitch 并至少转发一次请求，就会生成 {db_text}"
            ),
        )
    } else if conf_found {
        (
            "bad",
            "缺 cc-switch.db".to_string(),
            format!("有 {dir_text} 目录，但里面没有 cc-switch.db，ccswitch 可能被清理过"),
        )
    } else {
        (
            "bad",
            "没找到 cc-switch".to_string(),
            format!("没在系统里找到 ccswitch：既没有 {dir_text}，也没在常见位置看到 cc-switch.exe"),
        )
    };

    Env {
        db_path: db_text,
        db_found,
        conf_dir: dir_text,
        conf_found,
        app_path,
        rows,
        level: level.to_string(),
        short,
        message,
    }
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

    let conn = match Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => conn,
        Err(err) => return Sample::failed(format!("打不开用量库：{err}")),
    };
    // 库可能正被 ccswitch 写入，短暂拿不到读锁时稍等一会儿再试
    let _ = conn.busy_timeout(Duration::from_millis(400));

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