// 实时数据源：把各家客户端"正在生成"的信号统一成一条速率曲线。
//
// 为什么不用 ccswitch 的用量库当主源：它在请求**结束**时才落一行，
// 一轮 Codex 要跑 20 多秒，火势永远慢半拍，看着就像反的。
// 这里改成直接盯客户端自己的流式记录，秒级就能看出"正在吐字"。
pub mod calibrate;
pub mod claude;
pub mod codex;
pub mod gemini;

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use calibrate::Calibration;
use crate::usage;
use crate::usage::Rates;

/// 自己攒的环形桶（每秒一个）。Codex 的日志库只留最近约一千行，
/// 十来秒前的记录随时会被清掉，所以历史不能回头查，只能每次采样后自己记账。
pub const RING_SECONDS: i64 = 90;
/// 算瞬时速率时回看多少秒
const WINDOW_SECONDS: i64 = 25;
/// 指数加权的时间常数：越大越稳，越小越灵敏
pub const TAU_SIGNAL: f64 = 3.5;
/// 会话多久没动静就不算"正在烧"
const THREAD_IDLE_SECONDS: i64 = 45;

pub fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 每秒一个计数桶的环形缓冲
#[derive(Debug, Clone)]
pub struct Ring {
    slots: Vec<(i64, f64)>,
    last: Option<i64>,
}

impl Default for Ring {
    fn default() -> Self {
        Self::new()
    }
}

impl Ring {
    pub fn new() -> Self {
        Self {
            slots: vec![(i64::MIN, 0.0); RING_SECONDS as usize],
            last: None,
        }
    }

    fn slot(&self, sec: i64) -> usize {
        sec.rem_euclid(RING_SECONDS) as usize
    }

    pub fn get(&self, sec: i64) -> f64 {
        let slot = self.slots[self.slot(sec)];
        if slot.0 == sec {
            slot.1
        } else {
            0.0
        }
    }

    pub fn add(&mut self, sec: i64, amount: f64) {
        if amount == 0.0 {
            return;
        }
        let index = self.slot(sec);
        let slot = &mut self.slots[index];
        if slot.0 == sec {
            slot.1 += amount;
        } else {
            *slot = (sec, amount);
        }
        self.last = Some(self.last.map_or(sec, |prev| prev.max(sec)));
    }

    /// 把一笔量摊到以 end 结尾的若干秒里。
    /// Claude Code 那种"整条消息写完才落盘"的记录只能这么处理，
    /// 否则一次几百 token 会在某一秒里炸出一个假尖峰。
    pub fn add_spread(&mut self, end: i64, amount: f64, seconds: i64) {
        let span = seconds.clamp(1, RING_SECONDS / 2);
        let each = amount / span as f64;
        for i in 0..span {
            self.add(end - i, each);
        }
    }

    pub fn total_between(&self, from: i64, to: i64) -> f64 {
        let mut sum = 0.0;
        let mut sec = from;
        while sec <= to {
            sum += self.get(sec);
            sec += 1;
        }
        sum
    }

    /// 指数加权的"每秒多少"。跳过当前这一秒 —— 它还没走完，
    /// 算进去会让读数每秒开头抖一下。
    pub fn rate(&self, now: i64, tau: f64) -> f64 {
        let mut num = 0.0;
        let mut den = 0.0;
        for i in 1..=WINDOW_SECONDS {
            let weight = (-((i - 1) as f64) / tau).exp();
            num += self.get(now - i) * weight;
            den += weight;
        }
        if den > 0.0 {
            num / den
        } else {
            0.0
        }
    }

    pub fn last(&self) -> Option<i64> {
        self.last
    }
}

/// 一个源自己的两块曲线：事件数（一定准）和 token 数（源自带才准）
#[derive(Debug, Clone, Default)]
pub struct Live {
    pub events: Ring,
    pub tokens: Ring,
    threads: HashMap<String, i64>,
}

impl Live {
    pub fn new() -> Self {
        Self {
            events: Ring::new(),
            tokens: Ring::new(),
            threads: HashMap::new(),
        }
    }

    pub fn note_thread(&mut self, id: &str, at: i64) {
        let slot = self.threads.entry(id.to_string()).or_insert(at);
        *slot = (*slot).max(at);
    }

    /// 最近还在动的会话数 —— "所有对话一起烧"就是靠这个数体现的
    pub fn active_threads(&self, now: i64) -> u32 {
        self.threads
            .values()
            .filter(|at| now - **at <= THREAD_IDLE_SECONDS)
            .count() as u32
    }

}

/// 数据源口径
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    Auto,
    Codex,
    Claude,
    Gemini,
    Ccswitch,
}

impl Which {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "codex" => Which::Codex,
            "claude" => Which::Claude,
            "gemini" => Which::Gemini,
            "ccswitch" => Which::Ccswitch,
            _ => Which::Auto,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Which::Auto => "auto",
            Which::Codex => "codex",
            Which::Claude => "claude",
            Which::Gemini => "gemini",
            Which::Ccswitch => "ccswitch",
        }
    }

    /// 这个口径下要不要去收某个源的数据
    pub fn wants(self, id: &str) -> bool {
        match self {
            Which::Auto => true,
            Which::Codex => id == "codex",
            Which::Claude => id == "claude",
            Which::Gemini => id == "gemini",
            Which::Ccswitch => false,
        }
    }
}

/// 一个数据源对外的状态，设置面板和摆件都用它
#[derive(Debug, Clone, Serialize)]
pub struct SourceStatus {
    pub id: String,
    pub name: String,
    /// 摆件上那行小字，一切正常时是空的
    pub short: String,
    /// 面板里那一整句话
    pub detail: String,
    pub path: String,
    /// 是不是实时流（false 表示用量库那种事后统计）
    pub live: bool,
    /// 实验性支持，格式可能随客户端版本变
    pub experimental: bool,
    pub available: bool,
    pub level: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Env {
    pub active: String,
    pub active_name: String,
    pub level: String,
    pub short: String,
    pub message: String,
    pub sources: Vec<SourceStatus>,
}

/// 一次采样结果。rates 沿用老结构，前端不用改判定逻辑
#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    pub rates: Rates,
    /// 实际生效的口径：用量库是 total/fresh/output，实时流固定是 live
    pub metric: String,
    pub source: String,
    pub source_name: String,
    /// 数字是不是估算出来的（实时流里只有 Claude/Gemini 带真实 token 数）
    pub estimated: bool,
    pub events_per_sec: f64,
    pub tokens_per_event: f64,
    pub threads: u32,
    pub requests: u32,
    pub idle_seconds: Option<f64>,
    pub tau_seconds: f64,
    pub error: Option<String>,
}

impl Sample {
    fn failed(message: String, metric: &str, source: &str, tau: f64) -> Self {
        Self {
            rates: Rates::default(),
            metric: metric.to_string(),
            source: source.to_string(),
            source_name: String::new(),
            estimated: true,
            events_per_sec: 0.0,
            tokens_per_event: 0.0,
            threads: 0,
            requests: 0,
            idle_seconds: None,
            tau_seconds: tau,
            error: Some(message),
        }
    }
}

pub struct Engine {
    pub codex: codex::CodexStream,
    pub claude: claude::ClaudeStream,
    pub gemini: gemini::GeminiStream,
    cc_db: PathBuf,
    cc_cursor: Option<i64>,
    pub calibration: Calibration,
    /// 进程启动时刻。比它更早的窗口我们没记过账，不能拿来标定
    run_since: i64,
    errors: HashMap<String, String>,
}

impl Engine {
    pub fn new(cc_db: PathBuf, codex_db: PathBuf) -> Self {
        Self {
            codex: codex::CodexStream::new(codex_db),
            claude: claude::ClaudeStream::new(claude::default_root()),
            gemini: gemini::GeminiStream::new(gemini::default_root()),
            cc_db,
            cc_cursor: None,
            calibration: Calibration::load(),
            run_since: now_seconds(),
            errors: HashMap::new(),
        }
    }

    fn note(&mut self, id: &str, message: Option<String>) {
        match message {
            Some(text) => {
                self.errors.insert(id.to_string(), text);
            }
            None => {
                self.errors.remove(id);
            }
        }
    }

    /// 后台线程每几百毫秒喊一次：把实时源的新数据收进来，顺手标定一下
    pub fn tick(&mut self, which: Which) {
        let now = now_seconds();

        if which.wants("codex") {
            let result = self.codex.poll(now);
            match result {
                Ok(()) => self.note("codex", None),
                Err(err) => {
                    self.codex.mark_unavailable();
                    self.note("codex", Some(err));
                }
            }
        }
        if which.wants("claude") {
            let result = self.claude.poll(now);
            match result {
                Ok(()) => self.note("claude", None),
                Err(err) => {
                    self.claude.mark_unavailable();
                    self.note("claude", Some(err));
                }
            }
        }
        if which.wants("gemini") {
            let result = self.gemini.poll(now);
            match result {
                Ok(()) => self.note("gemini", None),
                Err(err) => {
                    self.gemini.mark_unavailable();
                    self.note("gemini", Some(err));
                }
            }
        }

        self.learn(now);
    }

    /// 自动标定：拿 ccswitch 记下的真实 output_tokens，
    /// 除以同一条请求窗口里我们数到的事件数，反推"一个事件值多少 token"。
    /// 这样实时流的事件/秒就能换算成大约多少 tok/s。
    fn learn(&mut self, now: i64) {
        if !self.codex.available {
            return;
        }
        let since = match self.cc_cursor {
            Some(cursor) => cursor,
            None => now - 10,
        };
        let Ok(rows) = usage::spend_since(&self.cc_db, since) else {
            return;
        };
        let mut newest: Option<i64> = None;
        let mut changed = false;
        for row in rows {
            newest = Some(newest.map_or(row.created_at, |prev| prev.max(row.created_at)));
            if row.app_type != "codex" || (row.output_tokens as f64) < calibrate::MIN_TOKENS {
                continue;
            }
            // first_token 之前模型还没开始吐字，把那段算进来会让事件数偏少
            let generating = (row.latency_ms - row.first_token_ms).max(1000) / 1000;
            let window_start = row.created_at - generating;
            // 窗口必须完整落在我们自己记过账的区间里
            if window_start < self.run_since || now - window_start > RING_SECONDS - 5 {
                continue;
            }
            let events = self
                .codex
                .live
                .events
                .total_between(window_start, row.created_at);
            if self.calibration.observe(row.output_tokens as f64, events) {
                changed = true;
            }
        }
        if let Some(newest) = newest {
            self.cc_cursor = Some(newest);
        }
        if changed {
            self.calibration.save();
        }
    }

    fn live_ids(&self, which: Which) -> Vec<&'static str> {
        let mut ids = Vec::new();
        if which.wants("codex") && self.codex.available {
            ids.push("codex");
        }
        if which.wants("claude") && self.claude.available {
            ids.push("claude");
        }
        if which.wants("gemini") && self.gemini.available {
            ids.push("gemini");
        }
        ids
    }

    pub fn statuses(&self) -> Vec<SourceStatus> {
        vec![
            self.codex.status(self.errors.get("codex").map(String::as_str)),
            self.claude.status(self.errors.get("claude").map(String::as_str)),
            self.gemini.status(self.errors.get("gemini").map(String::as_str)),
            usage::status(&self.cc_db),
        ]
    }

    /// 这会儿真正在用的源。选定的实时流不可用时如实报出来，不偷偷换源
    fn active_id(&self, which: Which) -> String {
        match which {
            Which::Ccswitch => "ccswitch".to_string(),
            Which::Auto => self
                .live_ids(which)
                .first()
                .map(|id| id.to_string())
                .unwrap_or_else(|| "ccswitch".to_string()),
            other => other.id().to_string(),
        }
    }

    pub fn probe(&self, which: Which) -> Env {
        let sources = self.statuses();
        let active = self.active_id(which);
        let current = sources
            .iter()
            .find(|s| s.id == active)
            .or_else(|| sources.first())
            .cloned();
        let Some(current) = current else {
            return Env {
                active,
                active_name: String::new(),
                level: "bad".to_string(),
                short: "没有数据源".to_string(),
                message: "一个数据源都没找到".to_string(),
                sources,
            };
        };
        let (level, short) = match current.level.as_str() {
            "ok" => ("ok", String::new()),
            "warn" => ("warn", short_of(&current)),
            _ => ("bad", short_of(&current)),
        };
        Env {
            active: current.id.clone(),
            active_name: current.name.clone(),
            level: level.to_string(),
            short,
            message: current.detail.clone(),
            sources,
        }
    }

    pub fn sample(&self, which: Which, metric: &str) -> Sample {
        let now = now_seconds();
        let ids = self.live_ids(which);
        if !ids.is_empty() {
            return self.live_sample(&ids, now);
        }
        if which == Which::Ccswitch || which == Which::Auto {
            return self.cc_sample(metric);
        }
        let reason = self
            .errors
            .get(which.id())
            .cloned()
            .unwrap_or_else(|| format!("{} 还没接上", names::of(which.id()).1));
        Sample::failed(reason, metric, which.id(), TAU_SIGNAL)
    }

    fn cc_sample(&self, metric: &str) -> Sample {
        let raw = usage::sample(&self.cc_db, usage::TAU_SECONDS);
        Sample {
            rates: raw.rates,
            metric: metric.to_string(),
            source: "ccswitch".to_string(),
            source_name: names::of("ccswitch").1.to_string(),
            estimated: false,
            events_per_sec: 0.0,
            tokens_per_event: self.calibration.tokens_per_event,
            threads: 0,
            requests: raw.requests,
            idle_seconds: raw.idle_seconds,
            tau_seconds: raw.tau_seconds,
            error: raw.error,
        }
    }

    fn live_sample(&self, ids: &[&'static str], now: i64) -> Sample {
        let tpe = self.calibration.tokens_per_event;
        let mut events_per_sec = 0.0;
        let mut token_rate = 0.0;
        let mut threads = 0;
        let mut estimated = false;
        let mut newest: Option<i64> = None;
        let mut labels: Vec<&'static str> = Vec::new();

        for id in ids {
            let live = match *id {
                "codex" => &self.codex.live,
                "claude" => &self.claude.live,
                _ => &self.gemini.live,
            };
            let events = live.events.rate(now, TAU_SIGNAL);
            let tokens = live.tokens.rate(now, TAU_SIGNAL);
            events_per_sec += events;
            if tokens > 0.0 {
                // 源自带真实 token 数，直接用，不用估
                token_rate += tokens;
            } else {
                token_rate += events * tpe;
                estimated = true;
            }
            threads += live.active_threads(now);
            if let Some(last) = live.events.last() {
                newest = Some(newest.map_or(last, |prev| prev.max(last)));
            }
            labels.push(names::of(id).1);
        }

        Sample {
            rates: Rates {
                total: token_rate,
                fresh: token_rate,
                output: token_rate,
            },
            metric: "live".to_string(),
            source: ids.join("+"),
            source_name: labels.join(" + "),
            estimated,
            events_per_sec,
            tokens_per_event: tpe,
            threads,
            requests: 0,
            idle_seconds: newest.map(|last| (now - last).max(0) as f64),
            tau_seconds: TAU_SIGNAL,
            error: None,
        }
    }
}

/// 源的中文名，面板和摆件都用同一份
pub mod names {
    pub fn of(id: &str) -> (&'static str, &'static str) {
        match id {
            "codex" => ("codex", "Codex 实时流"),
            "claude" => ("claude", "Claude Code 会话"),
            "gemini" => ("gemini", "Gemini CLI 会话"),
            "auto" => ("auto", "自动"),
            _ => ("ccswitch", "cc-switch 用量库"),
        }
    }
}

/// 摆件上放不下长句，出错时挑一句短的
fn short_of(source: &SourceStatus) -> String {
    if source.short.is_empty() {
        source.name.clone()
    } else {
        source.short.clone()
    }
}

