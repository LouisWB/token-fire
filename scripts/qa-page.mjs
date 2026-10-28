// 用无头 Chrome 截图设置面板，调布局时不用反复启动桌面应用
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".qa");
const tmp = resolve(outDir, "page");
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

const PAGE = process.env.QA_PAGE || "panel";
const LOCK_W = Number(process.env.QA_W || 300);
const LOCK_H = Number(process.env.QA_H || 580);
const SHOT = process.env.QA_SHOT || PAGE + ".png";
const MEASURE = !!process.env.QA_MEASURE;
const SCRIPT = PAGE === "index" ? "widget.js" : PAGE + ".js";

const MODULES = [
  "src/pixel/palette.js",
  "src/pixel/grid.js",
  "src/pixel/flame.js",
  "src/pixel/stones.js",
  "src/pixel/scene.js",
  "src/pixel/svg.js",
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

const CONFIG = { size: "medium", autostart: true, x: null, y: null };
const DEEPSEEK = {
  loggedIn: true,
  syncing: false,
  todayTokens: 128430,
  yesterdayTokens: 96210,
  monthTokens: 2749300,
  balance: Number(process.env.QA_BALANCE || 14),
  currency: "CNY",
  updatedAt: Date.now(),
  account: "DeepSeek ID 10001",
  message: "已连接 DeepSeek",
  error: null,
};

const STUB = [
  "window.__TAURI__ = {",
  "  core: {",
  "    invoke: async (cmd) => {",
  "      if (cmd === 'get_config') return CONFIG;",
  "      if (cmd === 'deepseek_status' || cmd === 'refresh_deepseek') return DEEPSEEK;",
  "      return {};",
  "    },",
  "  },",
  "  window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },",
  "};",
]
  .join(LF)
  .replace("CONFIG", JSON.stringify(CONFIG))
  .replace("DEEPSEEK", JSON.stringify(DEEPSEEK));

const LOCK = [
  "<style>",
  "html, body { width: " + LOCK_W + "px !important; height: " + LOCK_H + "px !important; }",
  MEASURE ? "#panel { height: auto !important; }" : "",
  "html { background: rgba(70, 74, 92, 0.55); }",
  "</style>",
].join(LF);

const source = readFileSync(resolve(root, "web/" + PAGE + ".html"), "utf8").split(CRLF).join(LF);
const html = source
  .replace("<head>", "<head>" + LF + LOCK)
  .replace(
    '<script type="module" src="' + SCRIPT + '"></script>',
    "<script>" + LF + STUB + LF + "</script>" + LF +
      "<script>" + LF + flatten(MODULES) + LF + flatten(["web/" + SCRIPT]) + LF + "</script>" +
      (MEASURE
        ? LF +
          "<script>setTimeout(function () {" +
          "document.title = 'MEASURE=' + document.getElementById('panel').scrollHeight;" +
          "}, 1500);</script>"
        : ""),
  );

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
for (const file of ["base.css", "style.css", "panel.css", "pixel"]) {
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

if (MEASURE) {
  const profile = resolve(outDir, "chrome-profile-measure");
  rmSync(profile, { recursive: true, force: true });
  const dom = execFileSync(CHROME, [
    "--headless=old",
    "--disable-gpu",
    "--no-sandbox",
    "--user-data-dir=" + profile,
    "--virtual-time-budget=2500",
    "--dump-dom",
    "file:///" + resolve(tmp, PAGE + ".html").replace(/\\/g, "/"),
  ], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }).toString();
  const found = dom.match(/MEASURE=(\d+)/);
  console.log(found ? PAGE + " 内容自然高度 " + found[1] + "px" : "没量到高度");
  process.exit(0);
}

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
