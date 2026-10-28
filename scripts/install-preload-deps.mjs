// 安装 public/preload 自己的运行时依赖（json5 / smol-toml / fzstd / js-yaml）。
//
// 根目录 `npm install` / `npm ci` 的 postinstall 会调用它。preload 的依赖不能并进
// 根 package.json：uTools 开发模式直接 require 源码时需要 public/preload/node_modules，
// 而 esbuild 打包 preload 时也按该目录解析。
//
// npm 12 会把全局的 npm_config_allow_scripts 透传给子进程，而 --allow-scripts 不允许
// 用于项目安装（会报 EALLOWSCRIPTS），这里清掉再跑；CI 的 npm 10 不受影响。

import { spawnSync } from "node:child_process";

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const res = spawnSync(npm, ["ci", "--prefix", "public/preload", "--no-audit", "--no-fund"], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

if (res.error) {
  console.error(`[preload-deps] 安装失败: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
