# token-fire

像素篝火桌面摆件：把 ccswitch 里 token 的消耗速度实时映射成火焰大小 —— 烧得越快，火越旺。

用 Tauri 打包，无边框 + 透明 + 置顶 + 不占任务栏，就摆在桌面上当个小摆件。

## 跑起来

```
npm run dev        # 生成资源 + 编译 + 启动摆件
npm run build:app  # 打包：exe + NSIS 安装包
```

| 命令 | 作用 |
| --- | --- |
| `npm run art` | 重新生成 `assets/campfire.svg` 和六档火势预览页 |
| `npm run icons` | 重新生成应用图标（纯 JS 手写的 PNG/ICO 编码器，无依赖） |
| `npm run ui` | 把 `web/` + `src/pixel/` + `src/ccswitch/rates.js` 拼进 `ui/`（Tauri 只认这个目录） |
| `npm run probe` | 命令行看一眼当前火势，不用开界面 |
| `npm run qa:page` | 用无头 Chrome 把界面截图到 `.qa/`，调界面时用 |
| `npm run build:exe` | 只出单文件 exe，不打包安装程序 |

改了 `web/`、`src/pixel/`、`src/ccswitch/rates.js` 之后要跑一次 `npm run ui`，否则摆件还是旧的。

### 打包产物

`npm run build:app` 之后：

| 文件 | 说明 |
| --- | --- |
| `src-tauri/target/release/token-fire.exe` | 绿色版，前端资源已经嵌进 exe 里，双击就能跑，约 6.8 MB |
| `src-tauri/target/release/bundle/nsis/token-fire_0.1.0_x64-setup.exe` | 安装包，约 2 MB |

两个都只依赖系统自带的 WebView2（Win10/11 一般都有，没有的话装一次运行时会自己提示）。

## 怎么用

- **左键拖动**：把摆件挪到喜欢的位置，松手就记住（下次启动回原位）
- **右键**：弹出设置面板；面板是**独立的窗口**，开开关关都不会碰到篝火，位置和大小一点不变
- 面板里按 Esc 或点 × 收起，标题栏可以拖动
- 第一次运行会自动贴到主屏右下角，并把设置面板亮出来

设置项：

| 设置 | 说明 |
| --- | --- |
| 火势口径 | 决定火苗跟着哪个数字走，**默认「总吞吐」** |
| 摆件大小 | 小 112x140 / 中 152x190 / 大 200x250 |
| 开机自启 | 写注册表 `HKCU\...\Run`，幂等 |
| 数据源 | ccswitch 检测结果 + 当前连接状态 |
| 退出摆件 | 真退出（摆件不占任务栏，也不留托盘图标） |

设置存在 `%APPDATA%\token-fire\config.json`。

## 启动时会先找 ccswitch

摆件一起来就查一遍系统里有没有 ccswitch 相关内容（用量库、配置目录、可执行文件），
把结果直接写在面板的「数据源」里，出问题时摆件底部还会顶一条红色小提示，点一下就打开面板：

| 情况 | 提示 |
| --- | --- |
| 都找到了 | 绿色：已连上用量库，累计 N 条请求记录 |
| 有库但没记录 | 黄色：用 ccswitch 转发一次请求，火就烧起来了 |
| 有 ccswitch 但没库 | 红色：告诉你库会生成在哪 |
| 什么都没有 | 红色：既没找到 `~/.cc-switch`，也没在常见位置看到 `cc-switch.exe` |

没找到的时候每隔 60 秒会再查一次，找到就自动把提示收掉。

## 三种火势口径

| 口径 | 含义 | 标定 quiet / full |
| --- | --- | --- |
| `total` | input + output + cache_creation，含缓存命中 | 200 / 40000 |
| `fresh` | 扣掉缓存命中后的真实消耗 | 20 / 4000 |
| `output` | 纯生成速度，最像打字速度 | 2 / 400 |

火势是连续量 `0..1`，不是几档固定图：读数按 `rateToIntensity()` 做对数映射（低速区间才不会一片死平），
再按 `approach()` 做指数趋近，所以火苗变化是"烧起来 / 慢慢熄"的感觉，不会一格一格跳。

熄火和烈焰之间拉得很开：

- 高度 `6.5 → 31.5` 像素，宽度 `6.5 → 18.5` 像素
- 火芯温度 `0.7 → 6.3` 档，快灭时只有暗红的芯，烧旺了才见白亮的火心
- 炭火亮度、火星数量、背后的暖光都跟着一起走
- 熄火就是真没有火苗，只剩一堆冷灰和几点暗红余烬

## ccswitch 数据源

读 `%USERPROFILE%\.cc-switch\cc-switch.db`（SQLite，只读打开 + 400ms busy_timeout），
Rust 侧用 `rusqlite`，命令行探针用 Node 自带的 `node:sqlite`，两边算法一致。

读完确认的事实：

- 用量表是 `proxy_request_logs`，另有 `usage_daily_rollups` 做日汇总
- **`created_at` 是 Unix 秒，不是毫秒**
- `input_tokens` 是总 prompt，**已包含** `cache_read_tokens`（实测没有一行 cache_read 大于 input），
  所以算总量不能再加一次 cache，否则翻倍
- `data_source` 有 `proxy`（实时）和 `codex_session`（历史回填）两种

速率用**指数衰减**算瞬时值：

```
rate = Σ tokens × e^(-Δt/τ) / τ        τ = 12 秒，查询窗口 5τ
```

而不是固定时间窗 —— 固定窗口会「整段亮着 → 到点突然归零」，指数衰减才是一堆柴慢慢熄掉的感觉。

实测本机一轮 Codex 请求约 14 万 total token、输出 300~1500、缓存命中率约 0.92，
所以 `total` 的满格定在 4 万/秒。

## 篝火是怎么画出来的

不用外部依赖，先把画面画成 44 x 46 的像素网格，再合并同色横向像素导出成 `<rect>`，
所以整个火堆就是一张纯 SVG，`shape-rendering="crispEdges"` 保证放大后不糊。

| 文件 | 作用 |
| --- | --- |
| `src/pixel/palette.js` | 全部颜色，换色只改这里 |
| `src/pixel/flame.js` | 火焰：按强度长出若干根火舌，再算热度着色 |
| `src/pixel/logs.js` | 三角架柴堆，只写左半边，右半边按中轴镜像 |
| `src/pixel/scene.js` | 把地面、灰堆、木柴、炭火、火焰叠成完整场景 |
| `src/pixel/svg.js` | 像素网格导出 SVG，并生成跳动的火星 |

两个关键点：

- **火舌轮廓**用「叶子形」曲线（`sin` 收口），不是直线三角，所以腰身是鼓的、尖端是收的
- **热度** = 横向离中轴多近 × 纵向烧了多深，尖端自然偏暗、根部中轴最白，火芯才像在往上窜

`assets/campfire.svg` 可以直接双击打开，自带 4 帧火苗跳动 + 火星飘散动画；
`assets/preview.html` 是六档火势并排预览。

## 目录

```
web/                前端源码：index.html + widget.js（摆件）、panel.html + panel.js（设置）、fire-view.js（两边共用的火焰视图）
src/pixel/          像素篝火引擎（纯计算，浏览器和 Node 都能跑）
src/ccswitch/       rates.js 速率换算（两边共用）；reader.js 是 Node 探针用的读库
ui/                 构建产物，Tauri 的 frontendDist
src-tauri/          Rust 侧：两个窗口 / 设置 / 读 SQLite / 检测 ccswitch / 开机自启
scripts/            构建、图标、探针、截图等小工具
.qa/                调试截图，不进版本库
```

## 前端性能上的几个小心思

摆件是常驻的，别一直烧 CPU：

- 火势量化成 1/30 档，变了才重画；重画最短间隔 55ms
- 炭火变化慢，单独粗量化成 1/8 档
- 4 帧火苗用 CSS 交叉淡入淡出，不是每帧重画 SVG
- 火星用 `display: none` 开关（SMIL 动画会盖掉 CSS opacity，只能这么藏）
- 轮询间隔 620ms

## 已知的坑

- `tauri.conf.json` 里的窗口尺寸只是占位，真实尺寸每次都由 `setup()` 里的 `set_size()` 定
- 无头 Chrome 不认 `--window-size`（视口固定 500x373），所以 `qa:page` 会把页面自己钉成目标尺寸再截图
- `ui-test.ps1` 里的进程不是 DPI 感知的，缩放不是 100% 的机器上直接拿 `GetWindowRect` 会算错坐标
- 摆件和设置面板是同一个进程的两个窗口，按标题找窗口时类名参数要传真正的 NULL