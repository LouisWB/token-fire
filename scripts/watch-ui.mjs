// 开发时监听前端源码，改动后原地更新 ui/，由 Tauri 内置 dev server 触发热刷新
import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUi } from "./build-ui.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [resolve(root, "web"), resolve(root, "src", "pixel")];

let timer = null;
let running = false;
let queued = false;

function rebuild(reason) {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  const started = Date.now();
  try {
    buildUi({ clean: false });
    console.log("[ui] " + reason + " → 已更新 (" + (Date.now() - started) + "ms)");
  } catch (err) {
    console.error("[ui] 更新失败：" + err.message);
  } finally {
    running = false;
    if (queued) {
      queued = false;
      schedule("补一次更新");
    }
  }
}

function schedule(reason) {
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(reason), 120);
}

buildUi({ clean: false });
console.log("[ui] 已同步，监听 web/ 和 src/pixel/");

const watchers = targets.map((dir) =>
  watch(dir, { recursive: true }, (_event, file) => {
    if (file) schedule(file);
  }),
);

function stop() {
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
