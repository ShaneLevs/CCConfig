// 根据 Release 里已上传的更新包签名生成 Tauri 更新清单 latest.json。
//
// Tauri 的 updater 只认签名文件；各平台的安装包由 CI 分开构建，所以清单在
// macos-dmg / windows-exe 两个 job 都完成后统一生成，避免两个 job 互相覆盖。
// 用法：node scripts/generate-updater-manifest.mjs --dir updater
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const dir = path.resolve(arg("--dir", path.join(root, "updater")));
const baseUrl = arg(
  "--base-url",
  "https://github.com/ShaneLevs/CCConfig/releases/latest/download",
).replace(/\/+$/, "");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = arg("--version", pkg.version);
const notes = process.env.RELEASE_NOTES || `CCConfig v${version}`;

if (!fs.existsSync(dir)) {
  console.error(`[updater-manifest] 找不到目录 ${dir}`);
  process.exit(1);
}

const files = fs.readdirSync(dir);

// macOS 的更新包名固定为 <productName>.app.tar.gz，不带架构；从同一次构建上传的
// dmg 文件名（CCConfig_<version>_<arch>.dmg）反推，避免以后增加 x64 runner 时标错。
const dmgName = files.find((name) => name.endsWith(".dmg")) || "";
const macArch = /(x64|x86_64)/i.test(dmgName) ? "x86_64" : "aarch64";
const platformFor = (file) => {
  if (file.endsWith(".app.tar.gz")) return `darwin-${macArch}`;
  if (file.endsWith("-setup.exe")) {
    if (/arm64/i.test(file)) return "windows-aarch64";
    if (/ia32|x86(?!_64)/i.test(file)) return "windows-i686";
    return "windows-x86_64";
  }
  return "";
};

const platforms = {};
for (const name of files) {
  if (!name.endsWith(".sig")) continue;
  const artifact = name.slice(0, -4);
  const platform = platformFor(artifact);
  if (!platform) continue;
  const signature = fs.readFileSync(path.join(dir, name), "utf8").trim();
  if (!signature) {
    console.warn(`[updater-manifest] 跳过空签名 ${name}`);
    continue;
  }
  platforms[platform] = {
    signature,
    url: `${baseUrl}/${encodeURIComponent(artifact)}`,
  };
}

if (!Object.keys(platforms).length) {
  console.log("[updater-manifest] 没有找到已签名的更新包，跳过 latest.json");
  process.exit(0);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
const outFile = path.join(dir, "latest.json");
fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[updater-manifest] 已生成 ${outFile}`);
console.log(`[updater-manifest] 平台：${Object.keys(platforms).join(", ")}`);
