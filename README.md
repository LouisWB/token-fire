# token-fire

像素篝火桌面摆件：火焰跟随 DeepSeek 账户余额变化，并展示今日、昨日、本月 Token 用量。

用 Tauri 打包，无边框、透明、置顶、不占任务栏。

## 使用

```powershell
npm run dev
npm run build:exe
npm run build:app
```

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 生成资源、编译并启动桌面摆件 |
| `npm run art` | 生成篝火 SVG 和强度预览页 |
| `npm run icons` | 生成应用图标 |
| `npm run ui` | 把 `web/` 和像素引擎拼进 `ui/` |
| `npm run qa:page` | 用无头 Chrome 截图设置面板 |
| `npm run build:exe` | 只生成单文件 exe |
| `npm run build:app` | 生成 exe 和 NSIS 安装包 |

## DeepSeek 登录与用量

- 首次运行会打开 DeepSeek 官方登录页，也可以点面板里的“登录 DeepSeek”再次打开。
- 登录在官方页面内完成，应用不接管账号密码，也不把登录 Token 写进配置文件。
- 登录状态保存在应用自己的 WebView 会话中，日常同步不会显示登录窗口。
- 用量读取自 [DeepSeek 官方用量页](https://platform.deepseek.com/usage) 使用的同源接口。
- 余额读取自账户摘要；今日、昨日、本月按完整自然日范围汇总 Token，和官方用量页保持一致。
- 官方数据可能延迟约 5 分钟。

设置面板包括：

| 设置 | 说明 |
| --- | --- |
| DeepSeek 账户 | 登录、打开官方页面、手动刷新 |
| 账户与用量 | 当前余额、今日 / 昨日 / 本月 Token |
| 摆件大小 | 小 112x140 / 中 152x190 / 大 200x250 |
| 开机自启 | 写当前用户启动项，幂等 |
| 同步状态 | 登录、同步和错误信息 |
| 退出摆件 | 真正退出进程 |

设置存在 `%APPDATA%\token-fire\config.json`。

## 火焰映射

火焰表示 DeepSeek 当前可用余额：

| 账户余额 | 火势 |
| --- | --- |
| 低于 10 元 | 最小火 |
| 10 元 | 最小火 |
| 30 元 | 约一半火势 |
| 50 元及以上 | 满焰 |

摆件底部显示余额，例如 `¥14.00 CNY`。右键摆件打开设置，拖动摆件可移动位置。

## 目录

```text
web/                  前端源码：摆件、设置面板、火焰视图
src/pixel/            像素篝火引擎
ui/                   Tauri 使用的前端构建产物
src-tauri/src/deepseek.rs  官方登录窗口与用量同步
src-tauri/src/lib.rs       窗口、命令和应用生命周期
scripts/              构建、图标和截图工具
```

`src-tauri/src/deepseek.rs` 依赖 DeepSeek 网页当前使用的同源接口，若官方页面改版，需要同步调整该文件。
