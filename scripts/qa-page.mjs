// 用无头 Chrome 截图某个页面：比在桌面上点来点去可靠得多
// 做法是把 web/ + src/ 的 ES 模块拼成一个 classic script，绕开 file:// 的模块 CORS 限制
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".qa");
const tmp = resolve(outDir, "page");
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

// headless Chrome 不理 --window-size，视口固定成 500x373，
// 所以页面得自己钉成目标尺寸，量出来的才是窗口里的真实布局
const PAGE = process.env.QA_PAGE || "panel";
const LOCK_W = Number(process.env.QA_W || 300);
const LOCK_H = Number(process.env.QA_H || 585);
const SHOT = process.env.QA_SHOT || PAGE + ".png";
const ENV_LEVEL = process.env.QA_ENV || "ok";
const SCRIPT = PAGE === "index" ? "widget.js" : PAGE + ".js";

const MODULES = [
  "src/pixel/palette.js",
  "src/pixel/grid.js",
  "src/pixel/flame.js",
  "src/pixel/logs.js",
  "src/pixel/scene.js",
  "src/pixel/svg.js",
  "src/ccswitch/rates.js",
  "web/fire-view.js",
];

function flatten(files) {
  const chunks = [];
  for (const file of files) {
    const lines = readFileSync(resolve(root, file), "utf8").split(CRLF).join(LF).split(LF);
    const kept = [];
    for (const line of lines) {
      if (/^\s*import\s/.test(line)) continue;
      if (/^\s*export\s*\{/.test(line)) continue;
      kept.push(line.replace(/^export\s+(const|function|class|let)\b/, "$1"));
    }
    chunks.push("/* " + file + " */" + LF + kept.join(LF));
  }
  return chunks.join(LF + LF);
}

// 三种环境检测结果的假数据，摆件上那条提示和面板里的说明都靠它
const ENV_OBJECTS = {
  ok: {
    db_path: "C:/Users/louis/.cc-switch/cc-switch.db",
    db_found: true,
    conf_dir: "C:/Users/louis/.cc-switch",
    conf_found: true,
    app_path: "C:/simp/cc-switch.exe",
    rows: 8643,
    level: "ok",
    short: "",
    message: "已连上 ccswitch 用量库，累计 8643 条请求记录",
  },
  warn: {
    db_path: "C:/Users/louis/.cc-switch/cc-switch.db",
    db_found: true,
    conf_dir: "C:/Users/louis/.cc-switch",
    conf_found: true,
    app_path: "C:/simp/cc-switch.exe",
    rows: 0,
    level: "warn",
    short: "还没有用量记录",
    message:
      "找到用量库了，但里面还没有请求记录 —— 用 ccswitch 转发一次 Codex / Claude 请求，火就烧起来了",
  },
  bad: {
    db_path: "C:/Users/louis/.cc-switch/cc-switch.db",
    db_found: false,
    conf_dir: "C:/Users/louis/.cc-switch",
    conf_found: false,
    app_path: null,
    rows: -1,
    level: "bad",
    short: "没找到 cc-switch",
    message:
      "没在系统里找到 ccswitch：既没有 C:/Users/louis/.cc-switch，也没在常见位置看到 cc-switch.exe",
  },
};

const CONFIG = { metric: "total", size: "medium", autostart: true, x: null, y: null };
const SAMPLE = {
  rates: { total: 12345.6, fresh: 1180.4, output: 342.9 },
  requests: 6,
  idle_seconds: 0.8,
  tau_seconds: 12,
  error: null,
};

const STUB = [
  "window.__TAURI__ = {",
  "  core: {",
  "    invoke: async (cmd, args) => {",
  "      if (cmd === 'get_config') return CONFIG;",
  "      if (cmd === 'sample_rate') return SAMPLE;",
  "      if (cmd === 'check_env') return ENV;",
  "      return {};",
  "    },",
  "  },",
  "  event: { listen: async () => () => {} },",
  "  window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },",
  "};",
]
  .join(LF)
  .replace("CONFIG", JSON.stringify(CONFIG))
  .replace("SAMPLE", JSON.stringify(SAMPLE))
  .replace("ENV", JSON.stringify(ENV_OBJECTS[ENV_LEVEL] || ENV_OBJECTS.ok));

const LOCK = [
  "<style>",
  "html, body { width: " + LOCK_W + "px !important; height: " + LOCK_H + "px !important; }",
  "html { background: rgba(70, 74, 92, 0.55); }",
  "</style>",
].join(LF);

const source = readFileSync(resolve(root, "web/" + PAGE + ".html"), "utf8").split(CRLF).join(LF);
const html = source
  .replace("<head>", "<head>" + LF + LOCK)
  .replace(
    '<script type="module" src="' + SCRIPT + '"></script>',
    "<script>" + LF + STUB + LF + "</script>" + LF +
      "<script>" + LF + flatten(MODULES) + LF + flatten(["web/" + SCRIPT]) + LF + "</script>",
  );

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
for (const file of ["base.css", "style.css", "panel.css", "pixel", "ccswitch"]) {
  const from = resolve(root, "web", file);
  if (existsSync(from)) {
    writeFileSync(resolve(tmp, file), readFileSync(from, "utf8"), "utf8");
  }
}
writeFileSync(resolve(tmp, PAGE + ".html"), html, "utf8");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((path) => existsSync(path));
if (!CHROME) throw new Error("找不到 Chrome");

const shots = [
  { name: SHOT, w: LOCK_W, h: LOCK_H },
  { name: SHOT.replace(/\.png$/, "-2x.png"), w: LOCK_W * 2, h: LOCK_H * 2, scale: 2 },
];

for (const shot of shots) {
  const profile = resolve(outDir, "chrome-profile-page");
  rmSync(profile, { recursive: true, force: true });
  const target = resolve(outDir, shot.name);
  rmSync(target, { force: true });
  execFileSync(CHROME, [
    "--headless=old",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-device-scale-factor=" + (shot.scale || 1),
    "--user-data-dir=" + profile,
    "--virtual-time-budget=2500",
    "--screenshot=" + target,
    "--window-size=" + shot.w + "," + shot.h,
    "file:///" + resolve(tmp, PAGE + ".html").replace(/\\/g, "/"),
  ], { stdio: "pipe" });
  console.log("已截图 " + shot.name + " (" + shot.w + "x" + shot.h + ")");
}