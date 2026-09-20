// 发布版隐藏控制台窗口，Windows 上只留摆件本身
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    token_fire_lib::run()
}
