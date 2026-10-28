// 把 web/ 前端和 src/pixel 像素引擎拼到 ui/，Tauri 只认这一个静态目录
import { cpSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ui = resolve(root, "ui");

export function buildUi({ clean = true } = {}) {
  if (clean) rmSync(ui, { recursive: true, force: true });
  mkdirSync(resolve(ui, "pixel"), { recursive: true });

  for (const file of readdirSync(resolve(root, "web"))) {
    cpSync(resolve(root, "web", file), resolve(ui, file));
  }
  for (const file of readdirSync(resolve(root, "src", "pixel"))) {
    cpSync(resolve(root, "src", "pixel", file), resolve(ui, "pixel", file));
  }
  const LF = String.fromCharCode(10);
  const CRLF = String.fromCharCode(13) + LF;
  for (const dir of ["", "pixel"]) {
    for (const entry of readdirSync(resolve(ui, dir), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const target = resolve(ui, dir, entry.name);
      writeFileSync(target, readFileSync(target, "utf8").split(CRLF).join(LF), "utf8");
    }
  }
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  buildUi();
  console.log("ui/ 已生成");
}
