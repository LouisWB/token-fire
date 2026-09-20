// 启动编译好的摆件，方便 npm run 里直接用
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = resolve(root, "src-tauri", "target", "debug", "token-fire.exe");

if (!existsSync(exe)) {
  console.error("还没编译：" + exe);
  console.error("先跑 npm run build:app");
  process.exit(1);
}

const child = spawn(exe, [], { detached: true, stdio: "ignore" });
child.unref();
console.log("摆件已启动：" + exe);
