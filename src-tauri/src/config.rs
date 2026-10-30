// 摆件的设置：存在用户配置目录下的 config.json
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

/// 已登录时的同步间隔（秒）：面板里可以改，太短容易触发官方限流
pub const SYNC_SECS_MIN: u64 = 5;
pub const SYNC_SECS_MAX: u64 = 3600;
pub const SYNC_SECS_DEFAULT: u64 = 20;

/// 换算「一次」用的 token 预算：面板里三档可选，超出范围按边界算
pub const TOKENS_PER_CALL_MIN: u32 = 2_000;
pub const TOKENS_PER_CALL_MAX: u32 = 2_000_000;
pub const TOKENS_PER_CALL_DEFAULT: u32 = 32_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// 摆件大小：small | medium | large
    pub size: String,
    pub autostart: bool,
    /// 火堆上的"还能烧多久"是否常显；关着就只在悬停时浮出来
    pub hint_always: bool,
    /// 气泡显示口径：time 剩余时间 / count 剩余 token
    pub hint_mode: String,
    /// 旧的「按一次多少 token 折算」预算，已不参与计算，仅为兼容已有配置文件保留
    pub tokens_per_call: u32,
    /// 已登录后的同步间隔（秒）
    pub sync_interval_secs: u64,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Config {
    pub fn sync_interval(&self) -> Duration {
        Duration::from_secs(self.sync_interval_secs.clamp(SYNC_SECS_MIN, SYNC_SECS_MAX))
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            size: "medium".to_string(),
            autostart: false,
            hint_always: false,
            hint_mode: "time".to_string(),
            tokens_per_call: TOKENS_PER_CALL_DEFAULT,
            sync_interval_secs: SYNC_SECS_DEFAULT,
            x: None,
            y: None,
        }
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
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
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
