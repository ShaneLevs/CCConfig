// 把 Tauri 嚼完的产物收口到仓库根的 release/，省得每次去
// src-tauri/target/release/bundle/dmg/ 这种深路径里翻。
//
// 路径由 Tauri/Cargo 决定，不是本项目能配的：
//   Cargo target 目录 = src-tauri/target（cargo 以 src-tauri 为 manifest 目录跑）
//   profile           = release（cargo tauri build）
//   bundle 目录       = <target>/release/bundle/<bundle 类型>/   ← tauri.conf.json 的 bundle.targets 决定类型
//   文件名            = <productName>_<version>_<arch>.<ext>     ← tauri.conf.json 的 productName/version + 目标架构
// 想换根目录只能靠 `cargo tauri build --target-dir <path>` 或 CARGO_TARGET_DIR，但结构仍是 <target>/release/bundle/dmg/。
//
// 用法：node scripts/collect-release.mjs   （已串在 npm run tauri:build 末尾）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const productName = conf.productName || "app";
const version = conf.version || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const bundleRoot = path.join(root, "src-tauri/target/release/bundle");
const outDir = path.join(root, "release");

if (!fs.existsSync(bundleRoot)) {
  console.error(`[collect-release] 找不到 ${bundleRoot}，先跑 npm run tauri:build`);
  process.exit(1);
}

// dmg + macos（.app，若本次构建保留了的话）都收；只认当前版本号命名的文件
const copied = [];
for (const kind of ["dmg", "macos"]) {
  const dir = path.join(bundleRoot, kind);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const src = path.join(dir, name);
    if (!name.startsWith(`${productName}_${version}`) && name !== `${productName}.app`) continue;
    if (fs.statSync(src).isDirectory() && !name.endsWith(".app")) continue;
    fs.mkdirSync(outDir, { recursive: true });
    const dest = path.join(outDir, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    copied.push(dest);
  }
}

if (!copied.length) {
  console.error(`[collect-release] ${bundleRoot} 下没有 ${productName}_${version}* 的产物`);
  process.exit(1);
}

for (const p of copied) {
  const size = fs.statSync(p);
  const mb = (size.size / 1024 / 1024).toFixed(2);
  console.log(`[collect-release] ${path.relative(root, p)}  (${mb} MB)`);
}
console.log(`[collect-release] 目录：${outDir}`);
