// 摆件的设置：存在用户配置目录下的 config.json
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// 火势口径：total | fresh | output（实时流固定按 live 口径走）
    pub metric: String,
    /// 数据源：auto | codex | claude | gemini | ccswitch
    pub source: String,
    /// 摆件大小：small | medium | large
    pub size: String,
    pub autostart: bool,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            metric: "total".to_string(),
            source: "auto".to_string(),
            size: "medium".to_string(),
            autostart: false,
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
