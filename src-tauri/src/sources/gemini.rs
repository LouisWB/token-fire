// Gemini CLI 的实时流（实验性）。
//
// 会话落在 ~/.gemini/tmp/<项目>/chats/session-*.json，整份 JSON 每回合被重写，
// 里面每条 gemini 消息带 tokens.output，所以能拿到真实 token 数。
// 这份格式没找到官方文档，是按文件本身推的，字段换版本可能变，
// 所以这里解析写得很宽容：读不到就安安静静待着，绝不报错刷屏。
use super::claude::parse_iso_seconds;
use super::{Live, SourceStatus};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const FRESH_SECONDS: u64 = 6 * 3600;
const SCAN_EVERY: i64 = 3;
const MAX_FILES: usize = 40;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 刚认识一个文件时只认最近这么多秒的消息
const WARMUP_SECONDS: i64 = 60;
const ASSUMED_TOKENS_PER_SECOND: f64 = 60.0;
const MAX_SPREAD_SECONDS: i64 = 20;
/// 没有 tokens 字段时，按这个比例把正文长度折成 token
const CHARS_PER_TOKEN: f64 = 4.0;

pub fn default_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".gemini")
        .join("tmp")
}

pub struct GeminiStream {
    pub root: PathBuf,
    pub live: Live,
    pub available: bool,
    /// 每个文件已经消化到第几条消息
    seen: HashMap<PathBuf, usize>,
    last_scan: i64,
    scanned: bool,
    seen_events: bool,
}

impl GeminiStream {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            live: Live::new(),
            available: false,
            seen: HashMap::new(),
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
                "没找到 Gemini CLI 的会话目录 {}。没装 Gemini CLI 的话不会有这个目录。",
                self.root.display()
            ));
        }
        if !self.scanned || now - self.last_scan >= SCAN_EVERY {
            self.scanned = true;
            self.last_scan = now;
            let files = self.fresh_files();
            self.available = !files.is_empty();
            for path in files {
                let warm = !self.seen.contains_key(&path);
                let _ = self.read_session(&path, now, warm);
            }
        }
        Ok(())
    }

    fn fresh_files(&self) -> Vec<PathBuf> {
        let mut found: Vec<(u64, PathBuf)> = Vec::new();
        let Ok(projects) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        for project in projects.flatten() {
            if !project.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(inner) = fs::read_dir(project.path().join("chats")) else {
                continue;
            };
            for file in inner.flatten() {
                let path = file.path();
                if path.extension().map(|e| e != "json").unwrap_or(true) {
                    continue;
                }
                let Ok(meta) = file.metadata() else { continue };
                if meta.len() > MAX_BYTES {
                    continue;
                }
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

    fn read_session(&mut self, path: &Path, now: i64, warm: bool) -> Result<(), String> {
        let text =
            fs::read_to_string(path).map_err(|err| format!("读 Gemini 会话失败：{err}"))?;
        let Ok(root) = serde_json::from_str::<Value>(&text) else {
            return Ok(());
        };
        // 有的版本把消息放在 messages，有的直接是数组
        let messages = match root.get("messages").and_then(Value::as_array) {
            Some(list) => list.clone(),
            None => match root.as_array() {
                Some(list) => list.clone(),
                None => return Ok(()),
            },
        };
        let mut cursor = self.seen.get(path).copied().unwrap_or(0);
        // 文件被重写过（消息变少了），从头重新数
        if cursor > messages.len() {
            cursor = 0;
        }
        let session = root
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("gemini")
            .to_string();
        for message in messages.iter().skip(cursor) {
            self.absorb(message, &session, now, warm);
        }
        self.seen.insert(path.to_path_buf(), messages.len());
        Ok(())
    }

    fn absorb(&mut self, message: &Value, session: &str, now: i64, warm: bool) {
        let kind = message
            .get("type")
            .or_else(|| message.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind != "gemini" && kind != "model" && kind != "assistant" {
            return;
        }
        let output = message
            .pointer("/tokens/output")
            .and_then(Value::as_u64)
            .map(|value| value as f64)
            // 没有 token 统计就按正文字数折一个，总比什么都没有强
            .unwrap_or_else(|| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|text| text.chars().count() as f64 / CHARS_PER_TOKEN)
                    .unwrap_or(0.0)
            });
        if output < 1.0 {
            return;
        }
        let at = message
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_seconds)
            .unwrap_or(now);
        if warm && at < now - WARMUP_SECONDS {
            return;
        }
        let span = (output / ASSUMED_TOKENS_PER_SECOND)
            .ceil()
            .clamp(1.0, MAX_SPREAD_SECONDS as f64) as i64;
        self.live.tokens.add_spread(at, output, span);
        self.live.events.add(at, 1.0);
        self.live.note_thread(session, at);
        self.seen_events = true;
    }

    pub fn status(&self, error: Option<&str>) -> SourceStatus {
        let path = self.root.display().to_string();
        let mut status = SourceStatus {
            id: "gemini".to_string(),
            name: "Gemini CLI 会话".to_string(),
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
            status.short = "没找到 Gemini".to_string();
            status.detail = err.to_string();
        } else if self.available && self.seen_events {
            status.detail =
                format!("Gemini CLI 会话记录 · {path} · 实验性支持，字段随版本可能变");
        } else if self.available {
            status.level = "warn".to_string();
            status.short = "还没动静".to_string();
            status.detail =
                format!("盯上了 Gemini CLI 的会话目录（{path}），但最近没有新回复。");
        } else {
            status.level = "warn".to_string();
            status.short = "还没有会话".to_string();
            status.detail =
                format!("有 Gemini CLI 的目录（{path}），但最近 6 小时没有会话记录。");
        }
        status
    }
}