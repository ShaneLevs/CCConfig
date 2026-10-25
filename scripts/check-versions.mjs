// 构建前的一致性校验：版本号散落在 5 个手写位置，任一处漏改都会出「dmg 文件名 / 应用内关于 /
// tag 各说各话」的问题（v1.0.1 就是这样漏的）。不一致直接 fail，并指出改哪几个文件。
// 用法：npm run version:check（已挂在 npm run build / build:app 前面）
import { readAll } from "./version-files.mjs";

// 中文标签按 2 列宽算，否则表格错位
function displayWidth(text) {
  return [...text].reduce((w, ch) => w + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
}

let rows;
try {
  rows = readAll();
} catch (e) {
  console.error(`✗ 版本号读取失败：${e.message}`);
  process.exit(1);
}

const width = Math.max(...rows.map((r) => displayWidth(r.label)));
for (const row of rows) {
  const pad = " ".repeat(width - displayWidth(row.label));
  console.log(`  ${row.label}${pad}  ${row.version}`);
}

// 两条线：app（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）、utools（plugin.json）。
// 默认要求全部同号 —— 版本号就是产品版本，两条线一起发。
const versions = [...new Set(rows.map((r) => r.version))];
if (versions.length === 1) {
  console.log(`✓ 版本号一致：${versions[0]}`);
  process.exit(0);
}

const byVersion = new Map();
for (const row of rows) {
  if (!byVersion.has(row.version)) byVersion.set(row.version, []);
  byVersion.get(row.version).push(row.file);
}

console.error("\n✗ 版本号不一致：");
for (const [version, files] of byVersion) {
  console.error(`  ${version}  ←  ${files.join("、")}`);
}
console.error(`\n修复：npm run bump -- ${rows.find((r) => r.id === "npm").version}（或 npm run bump -- patch）`);
process.exit(1);
