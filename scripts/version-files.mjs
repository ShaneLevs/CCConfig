// 版本号在仓库里有 5 个手写落点，分两条发行线：
//   app     —— npm 包 + macOS 桌面版（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）
//   utools  —— uTools 插件（public/plugin.json，打包进 dist/ 时会被 uTools 开发者工具读取）
// 两条线默认同号（版本号即产品版本），需要时可以单独 bump 其中一条。
// 读写都走正则就地替换，保留各文件原有排版，diff 里只有版本号那一行。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION_TARGETS = [
  { line: "app", id: "npm", file: "package.json", mode: "json", label: "npm 包（package.json）" },
  { line: "app", id: "tauri", file: "src-tauri/tauri.conf.json", mode: "json", label: "桌面版 dmg / Info.plist（tauri.conf.json）" },
  { line: "app", id: "cargo", file: "src-tauri/Cargo.toml", mode: "cargo", label: "Rust 包（Cargo.toml）" },
  { line: "app", id: "cargo-lock", file: "src-tauri/Cargo.lock", mode: "cargo-lock", label: "cargo 锁文件（Cargo.lock）" },
  { line: "utools", id: "plugin", file: "public/plugin.json", mode: "json", label: "uTools 插件（plugin.json）" },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function assertSemver(value, what = "版本号") {
  if (!SEMVER.test(String(value))) {
    throw new Error(`${what}「${value}」不是合法 semver（期望 1.2.3 或 1.2.3-beta.1）`);
  }
  return value;
}

/** patch / minor / major → 从 fromVersion 推导目标版本 */
export function nextVersion(fromVersion, kind) {
  const [core] = String(fromVersion).split(/[-+]/);
  const [major, minor, patch] = core.split(".").map(Number);
  if (![major, minor, patch].every(Number.isInteger)) {
    throw new Error(`无法从「${fromVersion}」推导 ${kind} 版本`);
  }
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`未知的版本类型「${kind}」（只支持 patch / minor / major）`);
}

function readTarget(target) {
  const abs = join(ROOT, target.file);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch (e) {
    throw new Error(`读不到 ${target.file}：${e.message}`);
  }
  return { abs, text };
}

/**
 * 取版本号。json / cargo 取第一个版本字段（都是文件里唯一表达「本项目版本」的那个），
 * Cargo.lock 只认 name = "ccconfig" 那一块（否则会命中任意依赖的 version）。
 */
export function readVersion(target) {
  const { text } = readTarget(target);

  if (target.mode === "cargo-lock") {
    const m = text.match(/\[\[package\]\]\nname = "ccconfig"\nversion = "([^"]+)"/);
    if (!m) throw new Error(`在 ${target.file} 里找不到 name = "ccconfig" 的 package 块`);
    return m[1];
  }
  if (target.mode === "cargo") {
    const m = text.match(/^version = "([^"]+)"/m);
    if (!m) throw new Error(`在 ${target.file} 里找不到顶层 version = "..."`);
    return m[1];
  }
  const m = text.match(/"version"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error(`在 ${target.file} 里找不到 "version": "..."`);
  return m[1];
}

export function writeVersion(target, version) {
  const { abs, text } = readTarget(target);
  let next;

  if (target.mode === "cargo-lock") {
    const re = /(\[\[package\]\]\nname = "ccconfig"\nversion = ")[^"]+(")/;
    if (!re.test(text)) throw new Error(`在 ${target.file} 里找不到 name = "ccconfig" 的 package 块`);
    next = text.replace(re, `$1${version}$2`);
  } else if (target.mode === "cargo") {
    next = text.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  } else {
    next = text.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${version}"`);
  }

  if (next === text) return false;
  writeFileSync(abs, next);
  return true;
}

export function readAll() {
  return VERSION_TARGETS.map((target) => ({ ...target, version: readVersion(target) }));
}
