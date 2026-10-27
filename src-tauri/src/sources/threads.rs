// 会话板：Codex 自己维护的会话级计数器。
//
// `~/.codex/state_5.sqlite` 的 `threads` 表里一行就是一个会话：
//
// - `tokens_used` —— 该会话累计消耗，**真实值**，不用估算、不用标定
// - `updated_at` —— 最后一次更新时刻。实测每轮响应结束更新一次，延迟约一秒
// - `rollout_path` —— 该会话的会话记录文件，里面的 `token_usage_record`
//   带 输入 / 缓存读 / 缓存写 / 思考 / 输出 的拆分明细
//
// 差分 `tokens_used` 就是"这个会话此刻烧多快"。这件事实时流做不到：
// `logs_2.sqlite` 里的流式事件不带 thread_id，分不出是哪个会话在烧；
// 而这个库天生按会话分行，顺带把多会话归属也解决了。

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

/// 面板上最多列几个会话
const MAX_THREADS: usize = 6;
/// 这张表一秒一次就够：它每轮响应才动一次
const POLL_SECONDS: i64 = 1;
/// 多久没更新就算这个会话停了
const IDLE_SECONDS: i64 = 20;
/// 会话记录的末尾读这么多字节，够找到最后一条用量了
const TAIL_BYTES: u64 = 256 * 1024;

pub fn default_db() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".codex")
        .join("state_5.sqlite")
}

/// 一个会话对外长这样，面板照着渲染
#[derive(Debug, Clone, Serialize)]
pub struct ThreadInfo {
    pub id: String,
    /// 面板上显示的名字：Codex 起的会话名 → 目录名 → 标题首行
    pub label: String,
    pub cwd: String,
    pub branch: String,
    pub model: String,
    pub tokens_used: i64,
    /// 差分出来的速度（tok/s），是"本轮平均"，不是瞬时
    pub rate: f64,
    pub idle_seconds: f64,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub cache_write_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
}

/// 本轮明细，来自会话记录里的 token_usage_record
#[derive(Debug, Clone, Copy, Default)]
struct Usage {
    input: i64,
    cached_input: i64,
    cache_write: i64,
    output: i64,
    reasoning: i64,
}

/// 上一个采样点上记下的东西，用来差分
#[derive(Debug, Clone)]
struct Cached {
    tokens_used: i64,
    updated_at: i64,
    rate: f64,
    usage: Usage,
}

pub struct Threads {
    db: PathBuf,
    seen: HashMap<String, Cached>,
    /// 最近一次采样结果，命令直接读它，不再碰数据库
    rows: Vec<ThreadInfo>,
    last_poll: i64,
}

impl Threads {
    pub fn new(db: PathBuf) -> Self {
        Self {
            db,
            seen: HashMap::new(),
            rows: Vec::new(),
            last_poll: 0,
        }
    }

    pub fn rows(&self) -> Vec<ThreadInfo> {
        self.rows.clone()
    }

    pub fn poll(&mut self, now: i64) -> Result<(), String> {
        if now - self.last_poll < POLL_SECONDS {
            return Ok(());
        }
        self.last_poll = now;

        if !self.db.is_file() {
            self.seen.clear();
            self.rows.clear();
            return Err(format!(
                "没找到 Codex 的会话库 {}。装了 Codex 并且至少聊过一次才会有。",
                self.db.display()
            ));
        }

        let conn = Connection::open_with_flags(&self.db, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|err| format!("打不开 Codex 会话库：{err}（{}）", self.db.display()))?;
        // Codex 正在写，短暂拿不到读锁就等一下
        let _ = conn.busy_timeout(Duration::from_millis(300));

        let mut stmt = conn
            .prepare(ROWS_SQL)
            .map_err(|err| format!("准备查询失败：{err}"))?;
        let mapped = stmt
            .query_map([MAX_THREADS as i64], |row| {
                Ok(Row {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    title: row.get(2)?,
                    cwd: row.get(3)?,
                    branch: row.get(4)?,
                    model: row.get(5)?,
                    tokens_used: row.get(6)?,
                    updated_at: row.get(7)?,
                    rollout: row.get(8)?,
                    nickname: row.get(9)?,
                })
            })
            .map_err(|err| format!("查询失败：{err}"))?;

        let mut out = Vec::new();
        let mut alive = HashSet::new();
        for row in mapped.flatten() {
            alive.insert(row.id.clone());
            let usage_of = |path: Option<&str>| {
                path.map(|p| read_usage(Path::new(p))).unwrap_or_default()
            };
            let entry = self.seen.entry(row.id.clone()).or_insert_with(|| Cached {
                tokens_used: row.tokens_used,
                updated_at: row.updated_at,
                rate: 0.0,
                // 第一次见到这个会话，也把上一轮的明细读出来给人看
                usage: usage_of(row.rollout.as_deref()),
            });

            if row.tokens_used != entry.tokens_used || row.updated_at != entry.updated_at {
                let delta = (row.tokens_used - entry.tokens_used).max(0) as f64;
                let span = (row.updated_at - entry.updated_at).max(1) as f64;
                if delta > 0.0 {
                    let instant = delta / span;
                    entry.rate = if entry.rate > 0.0 {
                        entry.rate + (instant - entry.rate) * 0.5
                    } else {
                        instant
                    };
                }
                entry.tokens_used = row.tokens_used;
                entry.updated_at = row.updated_at;
                entry.usage = usage_of(row.rollout.as_deref());
            }

            let idle = (now - row.updated_at).max(0);
            if idle > IDLE_SECONDS {
                entry.rate = 0.0;
            }
            let usage = entry.usage;
            let rate = entry.rate;
            out.push(ThreadInfo {
                id: row.id.clone(),
                label: label_of(&row),
                cwd: short_cwd(&row.cwd),
                branch: row.branch.clone(),
                model: row.model.clone(),
                tokens_used: row.tokens_used,
                rate,
                idle_seconds: idle as f64,
                input_tokens: usage.input,
                cached_input_tokens: usage.cached_input,
                cache_write_input_tokens: usage.cache_write,
                output_tokens: usage.output,
                reasoning_output_tokens: usage.reasoning,
            });
        }
        drop(stmt);
        self.seen.retain(|id, _| alive.contains(id));
        self.rows = out;
        Ok(())
    }
}

/// 只留最近动过的、没归档的
const ROWS_SQL: &str = "
SELECT id,
       COALESCE(name, ''),
       COALESCE(title, ''),
       COALESCE(cwd, ''),
       COALESCE(git_branch, ''),
       COALESCE(model, ''),
       COALESCE(tokens_used, 0),
       COALESCE(updated_at, 0),
       rollout_path,
       COALESCE(agent_nickname, '')
FROM threads
WHERE archived_at IS NULL
ORDER BY updated_at DESC
LIMIT ?1";

struct Row {
    id: String,
    name: String,
    title: String,
    cwd: String,
    branch: String,
    model: String,
    tokens_used: i64,
    updated_at: i64,
    rollout: Option<String>,
    nickname: String,
}

/// 会话记录末尾最后一条 token_usage_record 里的本轮用量
fn read_usage(path: &Path) -> Usage {
    let Ok(mut file) = File::open(path) else {
        return Usage::default();
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return Usage::default();
    };
    let from = size.saturating_sub(TAIL_BYTES);
    if file.seek(SeekFrom::Start(from)).is_err() {
        return Usage::default();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Usage::default();
    }
    // 从中间截的，开头可能是半个 UTF-8 字符，宽松解一下就行
    let text = String::from_utf8_lossy(&bytes);
    for line in text.lines().rev() {
        if !line.contains("\"token_usage_record\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let usage = &value["payload"]["usage"];
        return Usage {
            input: num(usage, "input_tokens"),
            cached_input: num(usage, "cached_input_tokens"),
            cache_write: num(usage, "cache_write_input_tokens"),
            output: num(usage, "output_tokens"),
            reasoning: num(usage, "reasoning_output_tokens"),
        };
    }
    Usage::default()
}

fn num(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// 面板上那行名字：会话名 → 目录名 → 标题首行；子代理会标出来
fn label_of(row: &Row) -> String {
    let base = base_label(row);
    if row.nickname.trim().is_empty() {
        base
    } else {
        format!("子代理 · {base}")
    }
}

fn base_label(row: &Row) -> String {
    let name = row.name.trim();
    if !name.is_empty() {
        return clip(name, 30);
    }
    let dir = short_cwd(&row.cwd);
    if !dir.is_empty() {
        return dir;
    }
    let title = row.title.lines().next().unwrap_or("").trim();
    if title.is_empty() {
        return row.id.chars().take(8).collect();
    }
    clip(title, 30)
}

fn short_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_start_matches("\\\\?\\");
    Path::new(trimmed)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn clip(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let mut out: String = chars[..max].iter().collect();
    out.push('…');
    out
}