// 把 web/ 前端和 src/pixel 像素引擎拼到 ui/，Tauri 只认这一个静态目录
import { cpSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ui = resolve(root, "ui");

rmSync(ui, { recursive: true, force: true });
mkdirSync(resolve(ui, "pixel"), { recursive: true });
mkdirSync(resolve(ui, "ccswitch"), { recursive: true });

for (const file of readdirSync(resolve(root, "web"))) {
  cpSync(resolve(root, "web", file), resolve(ui, file));
}
for (const file of readdirSync(resolve(root, "src", "pixel"))) {
  cpSync(resolve(root, "src", "pixel", file), resolve(ui, "pixel", file));
}
cpSync(resolve(root, "src", "ccswitch", "rates.js"), resolve(ui, "ccswitch", "rates.js"));
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
for (const dir of ["", "pixel", "ccswitch"]) {
  for (const entry of readdirSync(resolve(ui, dir), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = resolve(ui, dir, entry.name);
    writeFileSync(target, readFileSync(target, "utf8").split(CRLF).join(LF), "utf8");
  }
}

console.log("ui/ 已生成");