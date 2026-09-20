// 自动标定：实时流只能数"事件"，要变成 tok/s 就得知道一个事件值多少 token。
//
// 做法很直接：ccswitch 会把每条请求的真实 output_tokens 记下来（只是慢），
// 拿它除以我们自己在那条请求窗口里数到的事件数，就是这一次的换算比。
// 攒几笔取中位数，再和上次的值做平滑，免得一两笔异常把火势带跑。
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 还没标定出来时先用这个。实测 Codex 一个流式事件约 1.5~2.0 token，取中间值
pub const DEFAULT_TOKENS_PER_EVENT: f64 = 1.8;
/// 事件太少或 token 太少的窗口不值得信
pub const MIN_EVENTS: f64 = 40.0;
pub const MIN_TOKENS: f64 = 100.0;
/// 换算比的合理范围，超出去说明这窗口对不上，直接丢掉
const MIN_RATIO: f64 = 0.05;
const MAX_RATIO: f64 = 200.0;
/// 留最近几笔
const MAX_SAMPLES: usize = 12;
/// 新值占多大比重
const SMOOTH: f64 = 0.4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Calibration {
    /// 一个流式事件大约等于多少 token
    pub tokens_per_event: f64,
    pub samples: Vec<f64>,
    /// 一共标定成功过多少次
    pub count: u32,
}

impl Default for Calibration {
    fn default() -> Self {
        Self {
            tokens_per_event: DEFAULT_TOKENS_PER_EVENT,
            samples: Vec::new(),
            count: 0,
        }
    }
}

impl Calibration {
    pub fn load() -> Self {
        let Ok(text) = fs::read_to_string(path()) else {
            return Self::default();
        };
        let mut loaded: Self = serde_json::from_str(&text).unwrap_or_default();
        if !(MIN_RATIO..=MAX_RATIO).contains(&loaded.tokens_per_event) {
            loaded.tokens_per_event = DEFAULT_TOKENS_PER_EVENT;
        }
        loaded
    }

    pub fn save(&self) {
        let file = path();
        if let Some(parent) = file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = fs::write(&file, text);
        }
    }

    /// 记一笔观察。真的用上了才返回 true（调用方靠它决定要不要落盘）
    pub fn observe(&mut self, tokens: f64, events: f64) -> bool {
        if events < MIN_EVENTS || tokens < MIN_TOKENS {
            return false;
        }
        let sample = tokens / events;
        if !(MIN_RATIO..=MAX_RATIO).contains(&sample) {
            return false;
        }
        self.samples.push(sample);
        if self.samples.len() > MAX_SAMPLES {
            self.samples.remove(0);
        }
        self.count += 1;
        let middle = median(&self.samples);
        // 头两笔直接采信，之后慢慢收敛
        self.tokens_per_event = if self.count <= 2 {
            middle
        } else {
            self.tokens_per_event * (1.0 - SMOOTH) + middle * SMOOTH
        };
        true
    }
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return DEFAULT_TOKENS_PER_EVENT;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    }
}

fn path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_default()
        .join("token-fire")
        .join("calibration.json")
}