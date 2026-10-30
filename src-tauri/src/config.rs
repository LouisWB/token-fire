// 摆件的设置：存在用户配置目录下的 config.json
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

/// 已登录时的同步间隔（秒）：面板里可以改，太短容易触发官方限流
pub const SYNC_SECS_MIN: u64 = 5;
pub const SYNC_SECS_MAX: u64 = 3600;
pub const SYNC_SECS_DEFAULT: u64 = 20;

/// 火势区间的默认值：余额 ≤ 1 元最小火，≥ 1000 元满焰，中间按对数插值
pub const FIRE_MIN_DEFAULT: f64 = 1.0;
pub const FIRE_MAX_DEFAULT: f64 = 1000.0;
pub const FIRE_MIN_FLOOR: f64 = 0.01;
pub const FIRE_MAX_CEIL: f64 = 1_000_000_000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// 摆件大小：small | medium | large
    pub size: String,
    pub autostart: bool,
    /// 火堆上的剩余 token 气泡是否常显；关着就只在悬停时浮出来
    pub hint_always: bool,
    /// 火势区间下限：余额低于它时最小火
    pub fire_min: f64,
    /// 火势区间上限：余额高于它时满焰
    pub fire_max: f64,
    /// 已登录后的同步间隔（秒）
    pub sync_interval_secs: u64,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Config {
    pub fn sync_interval(&self) -> Duration {
        Duration::from_secs(self.sync_interval_secs.clamp(SYNC_SECS_MIN, SYNC_SECS_MAX))
    }

    /// 配置文件可能被手改过；读进来先收一遍，别让怪值把火势或同步弄哑
    pub fn sanitize(&mut self) {
        if !matches!(self.size.as_str(), "small" | "medium" | "large") {
            self.size = "medium".to_string();
        }
        let (min, max) = sanitize_fire_range(self.fire_min, self.fire_max);
        self.fire_min = min;
        self.fire_max = max;
        self.sync_interval_secs = self.sync_interval_secs.clamp(SYNC_SECS_MIN, SYNC_SECS_MAX);
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            size: "medium".to_string(),
            autostart: false,
            hint_always: false,
            fire_min: FIRE_MIN_DEFAULT,
            fire_max: FIRE_MAX_DEFAULT,
            sync_interval_secs: SYNC_SECS_DEFAULT,
            x: None,
            y: None,
        }
    }
}

/// 区间必须是一个正的、上界大于下界的区间；不合法就退回默认的 1 - 1000
pub fn sanitize_fire_range(min: f64, max: f64) -> (f64, f64) {
    let min = if min.is_finite() && min > 0.0 {
        min.clamp(FIRE_MIN_FLOOR, FIRE_MAX_CEIL)
    } else {
        FIRE_MIN_DEFAULT
    };
    let max = if max.is_finite() && max > 0.0 {
        max.clamp(FIRE_MIN_FLOOR, FIRE_MAX_CEIL)
    } else {
        FIRE_MAX_DEFAULT
    };
    if max <= min {
        (FIRE_MIN_DEFAULT, FIRE_MAX_DEFAULT)
    } else {
        (min, max)
    }
}

pub fn path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_default()
        .join("token-fire")
        .join("config.json")
}

/// 有没有配置文件 = 是不是第一次跑
pub fn exists() -> bool {
    path().is_file()
}

pub fn load() -> Config {
    let file = path();
    match fs::read_to_string(&file) {
        Ok(text) => {
            let mut config: Config = serde_json::from_str(&text).unwrap_or_default();
            config.sanitize();
            config
        }
        Err(_) => Config::default(),
    }
}

pub fn save(config: &Config) -> Result<(), String> {
    let file = path();
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("建目录失败：{err}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|err| format!("序列化失败：{err}"))?;
    fs::write(&file, text).map_err(|err| format!("写配置失败：{err}"))
}