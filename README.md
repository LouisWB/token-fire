# token-fire

像素篝火桌面摆件：把 AI 编程助手"正在生成"的速度实时映射成火焰大小 —— 烧得越快，火越旺。

用 Tauri 打包，无边框 + 透明 + 置顶 + 不占任务栏，就摆在桌面上当个小摆件。

## 跑起来

```
npm run dev        # 生成资源 + 编译 + 启动摆件
npm run build:exe  # 只出单文件 exe，不打包安装程序
npm run build:app  # 打包：exe + NSIS 安装包
```

| 命令 | 作用 |
| --- | --- |
| `npm run art` | 重新生成 `assets/campfire.svg` 和六档火势预览页 |
| `npm run icons` | 重新生成应用图标（纯 JS 手写的 PNG/ICO 编码器，无依赖） |
| `npm run ui` | 把 `web/` + `src/pixel/` + `src/ccswitch/rates.js` 拼进 `ui/`（Tauri 只认这个目录） |
| `npm run probe` | 命令行看一眼当前火势，不用开界面 |
| `npm run qa:page` | 用无头 Chrome 把界面截图到 `.qa/`，调界面时用；`QA_MEASURE=1` 只量面板内容高度 |
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
| 数据源 | 决定火苗跟着谁走，**默认「自动」** |
| 火势口径 | 决定火苗跟着哪个数字走，**默认「总吞吐」**；选实时流时自动切成「生成」 |
| 摆件大小 | 小 112x140 / 中 152x190 / 大 200x250 |
| 开机自启 | 写注册表 `HKCU\...\Run`，幂等 |
| 状态 | 当前读到的原始信号 + 换算过程，出问题时错误也写在这儿 |
| 退出摆件 | 真退出（摆件不占任务栏，也不留托盘图标） |

设置存在 `%APPDATA%\token-fire\config.json`，自动标定的结果存在同目录的 `calibration.json`。

## 数据源

摆件一起来就查一遍系统里有什么，结果直接标在下拉框每一项后面（`· 可用` / `· 还没数据` / `· 没找到`），
当前在用的源那行说明写在下面，出问题时摆件底部还会顶一条小提示，点一下就打开面板。

| 数据源 | 读什么 | 粒度 | 说明 |
| --- | --- | --- | --- |
| **自动**（默认） | 所有可用的实时流一起算 | — | 谁在烧就跟着谁，一个都没有才退回用量库 |
| Codex 实时流 | `~/.codex/logs_2.sqlite` 的流式事件 | 毫秒级 | 最跟手，主推 |
| Claude Code 会话 | `~/.claude/projects/**/*.jsonl` | 每条消息一次 | 带真实 token 数，但要等整条消息写完才落盘 |
| Gemini CLI 会话 | `~/.gemini/tmp/**/chats/*.json` | 每回合一次 | 实验性，字段随版本可能变 |
| cc-switch 用量库 | `~/.cc-switch/cc-switch.db` | 每条请求一次 | 数字最准，但**请求结束才落库**，慢半拍 |

多个实时流可以同时生效：自动模式下 Codex、Claude、Gemini 的事件率是加在一起的，
所以"一边用 Codex 一边开着 Claude"也会一起体现到火势里，面板还会写"N 个会话在烧"。

## 为什么要做实时流

cc-switch 的 `proxy_request_logs` 是**请求结束时**才写一行，而一轮 Codex 请求实测要跑 20~26 秒。
用它当火势源，就成了"你打字的时候火是灭的、你停了火才旺"——看着完全是反的。

于是改成直接盯客户端自己的流式记录。Codex 会把 app-server 的每个事件都写进 `logs_2.sqlite`：

```
target = 'codex_app_server::outgoing_message'
body   = 'app-server event: item/reasoning/textDelta targeted_connections=1'
```

`item/reasoning/textDelta`（思维链）和 `item/agentMessage/delta`（正文）就是"模型正在吐字"，
实测峰值能到 200+ 条/秒，秒级就能看出快慢。
`item/commandExecution/outputDelta` 是命令输出，不是模型生成，**故意不算**，否则"跑个命令火就旺"。

三个必须知道的实测结论：

- **这张表只留最近约一千行**，生成快的时候也就十来秒，随时会被清掉。
  所以不能回头查历史，只能高频增量读（后端每 300ms 收一次）并**自己记在内存里**（90 秒的每秒环形桶）。
- 日志库是 WAL 模式，冷拷贝 `.sqlite` 会丢最新数据，必须直连只读打开；实测数据延迟 5~7 秒。
- 事件数 ≠ token 数，所以换算比是**自动标定**出来的，见下一节。

## 自动标定

实时流只知道"每秒多少个事件"，要变成 tok/s 得知道一个事件值多少 token。
做法是拿 cc-switch 那条慢但准的记录当基准：

```
一个事件值多少 token = 该请求的真实 output_tokens ÷ 该请求窗口内我们数到的事件数
窗口 = [created_at - (latency_ms - first_token_ms)/1000, created_at]   # 只取真正在生成的那段
```

攒最近 12 笔取中位数，再和上次的值做平滑（新值占 40%），结果写进 `calibration.json` 下次接着用。
还没标出来之前先用默认值 1.8（实测 Codex 一个流式事件约 1.5~2.0 token），所以第一次跑起来就是能看的。
标定只在"进程启动之后完整观察过"的窗口上做，半路启动的那一轮不算，免得事件数偏少把换算比带高。

面板的「状态」会把过程直接写出来，比如：

```
Codex 实时流 · 206 事件/秒 · × 1.6 ≈ 330 tok/s · 2 个会话在烧
```

## 火势口径

| 口径 | 含义 | 标定 quiet / full |
| --- | --- | --- |
| `total` | input + output + cache_creation，含缓存命中 | 200 / 40000 |
| `fresh` | 扣掉缓存命中后的真实消耗 | 20 / 4000 |
| `output` | 纯生成速度，最像打字速度 | 2 / 400 |
| `live` | 实时流估算的生成速度（系统自动切，不给点） | 24 / 640 |

`live` 的阈值比 `output` 高一大截：估算出来的是"此刻这一瞬间"的速度，峰值本来就比整轮平均高不少，
用 `output` 那套会一直顶格。

其它三个口径只有用量库算得出来 —— 实时流只能测"吐字多快"，
输入 token 是请求开头一次性发出去的，摊不进生成速度里。所以选实时流时口径固定是「生成」，面板里会写明。

火势是连续量 `0..1`，不是几档固定图：读数按 `rateToIntensity()` 做对数映射（低速区间才不会一片死平），
再按 `approach()` 做指数趋近，所以火苗变化是"烧起来 / 慢慢熄"的感觉，不会一格一格跳。

熄火和烈焰之间拉得很开：

- 高度 `6.5 → 31.5` 像素，宽度 `6.5 → 18.5` 像素
- 火芯温度 `0.7 → 6.3` 档，快灭时只有暗红的芯，烧旺了才见白亮的火心
- 炭火亮度、火星数量、背后的暖光都跟着一起走
- 熄火就是真没有火苗，只剩一堆冷灰和几点暗红余烬

## cc-switch 用量库那边确认过的事实

读 `%USERPROFILE%\.cc-switch\cc-switch.db`（SQLite，只读打开 + 400ms busy_timeout），
Rust 侧用 `rusqlite`，命令行探针用 Node 自带的 `node:sqlite`，两边算法一致。

- 用量表是 `proxy_request_logs`，另有 `usage_daily_rollups` 做日汇总
- **`created_at` 是 Unix 秒，不是毫秒**，而且记的是请求结束时刻
- `input_tokens` 是总 prompt，**已包含** `cache_read_tokens`（实测没有一行 cache_read 大于 input），
  所以算总量不能再加一次 cache，否则翻倍
- `data_source` 有 `proxy`（实时）和 `codex_session`（历史回填）两种
- 用量库的速率用**指数衰减**算瞬时值（τ = 12 秒，查询窗口 5τ），
  而不是固定时间窗 —— 固定窗口会「整段亮着 → 到点突然归零」，指数衰减才是一堆柴慢慢熄掉的感觉

排查时踩过的坑：Codex 的会话文件 `~/.codex/sessions/**/rollout-*.jsonl` 里虽然也有
`token_usage_record`，但同样是整轮结束才写，拿它当火势源一样慢。

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
src-tauri/src/sources/  实时数据源：mod.rs 引擎与环形桶、codex.rs / claude.rs / gemini.rs、calibrate.rs 自动标定
src-tauri/src/usage.rs  cc-switch 用量库（兜底 + 标定基准）
scripts/            构建、图标、探针、截图等小工具
.qa/                调试截图，不进版本库
```

## 前端性能上的几个小心思

摆件是常驻的，别一直烧 CPU：

- 火势量化成 1/30 档，变了才重画；重画最短间隔 55ms
- 炭火变化慢，单独粗量化成 1/8 档
- 4 帧火苗用 CSS 交叉淡入淡出，不是每帧重画 SVG
- 火星用 `display: none` 开关（SMIL 动画会盖掉 CSS opacity，只能这么藏）
- 面板/摆件轮询间隔 620ms；**后端自己每 300ms 采一次**，跟界面快慢无关
  （Codex 那张表只留十来秒，靠前端催就会漏事件）

## 已知的坑

- `tauri.conf.json` 里的窗口尺寸只是占位，真实尺寸每次都由 `setup()` 里的 `set_size()` 定
- 面板内容高度一变就要同步改 `PANEL_H`（现在 624），窗口是透明的、固定尺寸，差几像素就把内容切掉；
  改完面板跑 `QA_MEASURE=1 node scripts/qa-page.mjs` 量一下
- 无头 Chrome 不认 `--window-size`（视口固定 500x373），所以 `qa:page` 会把页面自己钉成目标尺寸再截图
- `ui-test.ps1` 里的进程不是 DPI 感知的，缩放不是 100% 的机器上直接拿 `GetWindowRect` 会算错坐标
- 摆件和设置面板是同一个进程的两个窗口，按标题找窗口时类名参数要传真正的 NULL
- 实时流读的都是客户端的**内部诊断日志**，不是公开 API，字段和清理策略随版本可能变；
  解析写得很宽容，读不到就安静待着，并且随时可以切回 cc-switch 用量库兜底