// 摆件的设置：存在用户配置目录下的 config.json
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// 摆件大小：small | medium | large
    pub size: String,
    pub autostart: bool,
    /// 火堆上的"还能烧几天"是否常显；关着就只在悬停时浮出来
    pub hint_always: bool,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            size: "medium".to_string(),
            autostart: false,
            hint_always: false,
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
