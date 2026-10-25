// 一条命令写完所有版本号落点。
//
//   npm run bump -- 1.0.2          # 显式版本（app + uTools 两条线一起）
//   npm run bump -- patch          # 相对当前 app 版本自增（patch / minor / major）
//   npm run bump -- 1.0.2 --app    # 只改桌面版 / npm 那条线
//   npm run bump -- 1.0.2 --utools # 只改 public/plugin.json
//   npm run bump -- --check        # 只校验，不改文件（等同 npm run version:check）
//
// 为什么需要它：版本号手写在 package.json、src-tauri/tauri.conf.json、src-tauri/Cargo.toml、
// src-tauri/Cargo.lock（cargo 不会替你 bump）、public/plugin.json 五处，漏一处就会出
// 「dmg 文件名 / 应用内关于 / git tag 各说各话」。bump 完记得一起提交。
import { readAll, VERSION_TARGETS, assertSemver, nextVersion, readVersion, writeVersion } from "./version-files.mjs";

const USAGE = `用法：
  npm run bump -- <版本号|patch|minor|major> [--app | --utools]
  npm run bump -- --check            只校验各处是否一致

  不加 --app / --utools 时两条线一起改（app = npm + 桌面版，utools = public/plugin.json）。`;

const KNOWN_FLAGS = new Set(["app", "utools", "check", "help"]);

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("-")).map((a) => a.replace(/^--?/, "")));
  const positional = argv.filter((a) => !a.startsWith("-"));
  for (const flag of flags) {
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`未知参数 --${flag}（可用：--app / --utools / --check）`);
  }
  return { flags, positional };
}

function compare(a, b) {
  const pa = a.split(/[-+]/)[0].split(".").map(Number);
  const pb = b.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.has("help")) {
    console.log(USAGE);
    return 0;
  }

  const rows = readAll();
  const appVersion = rows.find((r) => r.id === "npm").version;

  if (flags.has("check")) {
    const unique = [...new Set(rows.map((r) => r.version))];
    if (unique.length === 1) {
      console.log(`✓ 版本号一致：${unique[0]}`);
      return 0;
    }
    console.error(`✗ 版本号不一致：${rows.map((r) => `${r.file}=${r.version}`).join("、")}`);
    return 1;
  }

  if (!positional.length) {
    console.error(USAGE);
    return 1;
  }

  const requested = positional[0];
  const targetVersion = ["patch", "minor", "major"].includes(requested)
    ? nextVersion(appVersion, requested)
    : assertSemver(requested, "目标版本号");

  const scope = flags.has("app") ? ["app"] : flags.has("utools") ? ["utools"] : ["app", "utools"];
  const selected = VERSION_TARGETS.filter((t) => scope.includes(t.line));

  // 降版本通常是手滑，除非确实要回滚发布 —— 只警告不阻止
  if (compare(targetVersion, appVersion) < 0) {
    console.warn(`⚠ 目标版本 ${targetVersion} 低于当前 app 版本 ${appVersion}（确认是回滚？）`);
  }

  const changed = selected.filter((t) => readVersion(t) !== targetVersion);
  if (!changed.length) {
    console.log(`✓ 无需修改：选中的 ${selected.length} 处已经是 ${targetVersion}`);
    return 0;
  }

  for (const target of changed) {
    const from = readVersion(target);
    writeVersion(target, targetVersion);
    console.log(`  ${target.file}  ${from} → ${targetVersion}`);
  }

  const untouched = rows.filter((r) => !scope.includes(r.line) && r.version !== targetVersion);
  if (untouched.length) {
    console.warn(
      `⚠ 未纳入本次范围、且与目标版本不同：${untouched.map((r) => `${r.file}=${r.version}`).join("、")}` +
        `\n  两条线不同号时 npm run version:check 会失败（构建前会拦下）。`
    );
  }

  console.log(`\n✓ 版本号已更新为 ${targetVersion}`);
  console.log(`  下一步：git add -A && git commit && git tag v${targetVersion} && npm run tauri:build`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
