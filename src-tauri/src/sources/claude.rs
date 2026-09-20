// Claude Code 的实时流。
//
// 会话记录在 ~/.claude/projects/<项目>/<会话>.jsonl，每完成一条 assistant
// 消息就追加一行，行里带真实的 output_tokens —— 所以这里的数字不用估算。
// 代价是粒度只有"一条消息"，不是逐字。
//
// 一条消息几百 token 一次性落盘，直接记会炸出一个假尖峰，
// 所以按一个假设速度反推它大概吐了多久，再把 token 摊回那几秒。
use super::{Live, SourceStatus};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// 只盯最近这段时间动过的会话文件
const FRESH_SECONDS: u64 = 6 * 3600;
/// 多久扫一次目录
const SCAN_EVERY: i64 = 3;
/// 一个文件最多盯这么多个，先挑最新的
const MAX_FILES: usize = 40;
/// 刚认识一个文件时，最多回头读这么多字节来找当前这条消息
const WARMUP_BYTES: u64 = 256 * 1024;
/// 刚认识一个文件时，只认最近这么多秒的消息，免得把历史一次性倒进来
const WARMUP_SECONDS: i64 = 60;
/// Claude 没告诉我们每条消息吐了多久，按这个速度反推
const ASSUMED_TOKENS_PER_SECOND: f64 = 60.0;
const MAX_SPREAD_SECONDS: i64 = 20;

pub fn default_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("projects")
}

pub struct ClaudeStream {
    pub root: PathBuf,
    pub live: Live,
    pub available: bool,
    offsets: HashMap<PathBuf, u64>,
    last_scan: i64,
    scanned: bool,
    seen_events: bool,
}

impl ClaudeStream {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            live: Live::new(),
            available: false,
            offsets: HashMap::new(),
            last_scan: 0,
            scanned: false,
            seen_events: false,
        }
    }

    pub fn mark_unavailable(&mut self) {
        self.available = false;
    }

    pub fn poll(&mut self, now: i64) -> Result<(), String> {
        if !self.root.is_dir() {
            self.available = false;
            return Err(format!(
                "没找到 Claude Code 的会话目录 {}。以前没用过 Claude Code 的话不会有这个目录。",
                self.root.display()
            ));
        }
        if !self.scanned || now - self.last_scan >= SCAN_EVERY {
            self.scanned = true;
            self.last_scan = now;
            let files = self.fresh_files();
            self.available = !files.is_empty();
            for path in files {
                let warm = !self.offsets.contains_key(&path);
                if warm {
                    // 先跳到文件尾附近，只找"正在写的那一条"
                    let start = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    self.offsets.insert(path.clone(), start.saturating_sub(WARMUP_BYTES));
                }
                let _ = self.read_tail(&path, now, warm);
            }
        }
        Ok(())
    }

    /// 最近动过的会话文件，最新的排前面
    fn fresh_files(&self) -> Vec<PathBuf> {
        let mut found: Vec<(u64, PathBuf)> = Vec::new();
        let Ok(projects) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        for project in projects.flatten() {
            if !project.file_type().map(|k| k.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(inner) = fs::read_dir(project.path()) else {
                continue;
            };
            for file in inner.flatten() {
                let path = file.path();
                if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                    continue;
                }
                let Ok(meta) = file.metadata() else { continue };
                let Ok(modified) = meta.modified() else {
                    continue;
                };
                let age = SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or(Duration::ZERO)
                    .as_secs();
                if age <= FRESH_SECONDS {
                    found.push((age, path));
                }
            }
        }
        found.sort_by_key(|(age, _)| *age);
        found.truncate(MAX_FILES);
        found.into_iter().map(|(_, path)| path).collect()
    }

    fn read_tail(&mut self, path: &Path, now: i64, warm: bool) -> Result<(), String> {
        let offset = self.offsets.get(path).copied().unwrap_or(0);
        let mut file = File::open(path).map_err(|err| format!("打不开会话文件：{err}"))?;
        let len = file
            .metadata()
            .map_err(|err| format!("读不到会话文件大小：{err}"))?
            .len();
        if len <= offset {
            if len < offset {
                // 文件被重写过，从头再来
                self.offsets.insert(path.to_path_buf(), 0);
            }
            return Ok(());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|err| format!("定位会话文件失败：{err}"))?;
        let mut buffer = Vec::new();
        file.take(len - offset)
            .read_to_end(&mut buffer)
            .map_err(|err| format!("读会话文件失败：{err}"))?;

        // 最后一行可能只写了一半，留着下次再读
        let Some(cut) = buffer.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(());
        };
        let text = String::from_utf8_lossy(&buffer[..cut]).into_owned();
        let mut last = offset;
        for line in text.lines() {
            self.absorb(line, now, warm);
        }
        last += cut as u64 + 1;
        self.offsets.insert(path.to_path_buf(), last);
        Ok(())
    }

    fn absorb(&mut self, line: &str, now: i64, warm: bool) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            return;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let output = value
            .pointer("/message/usage/output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if output == 0 {
            return;
        }
        let at = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_seconds)
            .unwrap_or(now);
        // 刚认识一个文件时只挑最近的消息，不然会把整段历史一口气倒进火里
        if warm && at < now - WARMUP_SECONDS {
            return;
        }
        let span = (output as f64 / ASSUMED_TOKENS_PER_SECOND)
            .ceil()
            .clamp(1.0, MAX_SPREAD_SECONDS as f64) as i64;
        self.live.tokens.add_spread(at, output as f64, span);
        self.live.events.add(at, 1.0);
        if let Some(thread) = value.get("sessionId").and_then(Value::as_str) {
            self.live.note_thread(thread, at);
        }
        self.seen_events = true;
    }

    pub fn status(&self, error: Option<&str>) -> SourceStatus {
        let path = self.root.display().to_string();
        let mut status = SourceStatus {
            id: "claude".to_string(),
            name: "Claude Code 会话".to_string(),
            short: String::new(),
            detail: String::new(),
            path: path.clone(),
            live: true,
            experimental: true,
            available: self.available,
            level: "ok".to_string(),
        };
        if let Some(err) = error {
            status.level = "bad".to_string();
            status.short = "没找到 Claude".to_string();
            status.detail = err.to_string();
        } else if self.available && self.seen_events {
            status.detail = format!(
                "Claude Code 会话记录 · {path} · 每条消息落盘一次，粒度比 Codex 实时流粗"
            );
        } else if self.available {
            status.level = "warn".to_string();
            status.short = "还没动静".to_string();
            status.detail =
                format!("盯上了 Claude Code 的会话目录（{path}），但最近没有新的 assistant 消息。");
        } else {
            status.level = "warn".to_string();
            status.short = "还没有会话".to_string();
            status.detail =
                format!("有 Claude Code 的目录（{path}），但最近 6 小时没有会话记录。");
        }
        status
    }
}

/// 解析 Claude 写的 ISO 时间：2026-09-20T03:55:29.506Z（UTC）
pub fn parse_iso_seconds(text: &str) -> Option<i64> {
    if text.len() < 19 {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;
    Some(days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second)
}

/// 公历日期转天数（Howard Hinnant 的算法），省得为这一件事拉一个时间库
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted = (month + 9) % 12;
    let day_of_year = (153 * shifted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}