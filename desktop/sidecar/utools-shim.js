// desktop/sidecar/utools-shim.js
//
// 在 Node sidecar 中实现 uTools API 的最小子集，供既有 services.js 原样运行。
//
// 语义依据：.agents/skills/utools-plugin-dev/references/api-reference/db.md
//   - db.put(doc) 无 _rev 时新建、有 _rev 时校验，不一致返回 { error: true, name: 'conflict' }
//   - 单文档上限 1 MB
//   - db.remove 接受 id 字符串或 doc 对象
//   - db.allDocs() 无参返回全部、传字符串按 ID 前缀过滤、传数组按 ID 取
// 存储：~/.ccconfig/db/ 下一个文档一个 JSON 文件，由 ./local-db.js 实现
//（与 uTools preload 共用同一份代码）；本文件只保留路径 / 生命周期等 uTools API。
// 与文档的唯一有意偏差：新建文档时若携带 _rev（例如从旧导出数据导入）忽略之，不报 not_found，
// 以免迁移数据因残留 _rev 而写入失败。
//
// setFeature / removeFeature / getFeatures 按已确认的决策做成 no-op：桌面版不迁移 uTools 搜索框指令。

const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const localDb = require("./local-db");

// uTools 与桌面版共用同一份本地文档库（~/.ccconfig/db，一文档一文件）。
// 实现见 public/preload/services/local-db.js：写穿、无进程内缓存，两个应用进程能立即看到彼此的写入。
const db = localDb.db;
const flushNow = localDb.flushNow;

// 数据目录在用户目录下（与 .claude / .dsh / .codex 等 agent 配置同层，便于备份与排查），
// 不再放 ~/Library/Application Support。旧位置在 Rust 启动时只迁移 runtime.json 与日志。
const APP_SUPPORT = () => localDb.dataDir();

// services.js 据此跳过「uTools 宿主 DB → 本地库」的一次性导入（桌面版本来就用本地库）
globalThis.__CCCONFIG_DESKTOP__ = true;

// ==================== 路径 / 设备 ID ====================

const PATH_RESOLVERS = {
  home: () => os.homedir(),
  temp: () => os.tmpdir(),
  desktop: () => path.join(os.homedir(), "Desktop"),
  documents: () => path.join(os.homedir(), "Documents"),
  downloads: () => path.join(os.homedir(), "Downloads"),
  music: () => path.join(os.homedir(), "Music"),
  pictures: () => path.join(os.homedir(), "Pictures"),
  videos: () => path.join(os.homedir(), "Movies"),
  userData: () => APP_SUPPORT(),
  appData: () => APP_SUPPORT(),
  logs: () => {
    // Windows 没有 ~/Library/Logs；与 Rust 侧 sidecar.log 的落点保持一致
    if (process.platform === "win32") return path.join(APP_SUPPORT(), "logs");
    return path.join(os.homedir(), "Library", "Logs", "CCConfig");
  },
};

function getPath(name) {
  const resolver = PATH_RESOLVERS[String(name)];
  if (!resolver) throw new Error(`不支持的路径名称: ${name}`);
  return resolver();
}

// 设备 ID 与 uTools 共用同一套算法，保证 `_<nativeId>` 文档指向同一批数据
const getNativeId = localDb.getNativeId;

// ==================== 系统交互 ====================

const IS_WIN = process.platform === "win32";

function shellOpenPath(fullPath) {
  if (IS_WIN) {
    try {
      // start 的第一个引号参数是窗口标题，传空串避免把路径当标题吞掉
      const r = spawnSync("cmd.exe", ["/c", "start", "", String(fullPath)], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (r.error) throw r.error;
      return "";
    } catch (e) {
      console.error(`[shim] shellOpenPath 失败: ${fullPath}: ${e.message}`);
      return String(e.message || e);
    }
  }
  try {
    execFileSync("open", [String(fullPath)], { stdio: "ignore" });
    return "";
  } catch (e) {
    // 目标不存在时退回「在访达中显示」
    try {
      execFileSync("open", ["-R", String(fullPath)], { stdio: "ignore" });
      return "";
    } catch (e2) {
      console.error(`[shim] shellOpenPath 失败: ${fullPath}: ${e2.message}`);
      return String(e2.message || e);
    }
  }
}

function shellOpenExternal(url) {
  try {
    if (IS_WIN) {
      spawnSync("cmd.exe", ["/c", "start", "", String(url)], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    execFileSync("open", [String(url)], { stdio: "ignore" });
  } catch (e) {
    console.error(`[shim] shellOpenExternal 失败: ${url}: ${e.message}`);
  }
}

function copyText(text) {
  const value = String(text ?? "");
  try {
    if (IS_WIN) {
      // clip.exe 按控制台代码页解码 stdin，中文会乱码；Set-Clipboard 按 UTF-8 读入
      const script =
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t";
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { input: value, windowsHide: true }
      );
      if (r.status !== 0) console.error(`[shim] Set-Clipboard 退出码 ${r.status}`);
      return;
    }
    const r = spawnSync("pbcopy", [], { input: value });
    if (r.status !== 0) console.error(`[shim] pbcopy 退出码 ${r.status}`);
  } catch (e) {
    console.error(`[shim] copyText 失败: ${e.message}`);
  }
}

// 同步返回 string[] | null，对齐 common.js 对返回值的期望
function showOpenDialog(options = {}) {
  if (IS_WIN) return showOpenDialogWindows(options);
  const title = String(options.title || "Select file").replace(/["\\]/g, "");
  // properties 里的 openDirectory 要映射到目录选择器，
  // 否则挑浏览器数据目录时只能挑到文件（订阅功能用它让用户指定 profile 目录）。
  const wantsDir = Array.isArray(options.properties) && options.properties.includes("openDirectory");
  const verb = wantsDir ? "choose folder" : "choose file";
  const script = `set f to ${verb} with prompt "${title}"\nPOSIX path of f`;
  try {
    const out = execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    }).trim();
    return out ? [out] : null;
  } catch (e) {
    // 用户取消时 osascript 退出码 1，不当作错误
    return null;
  }
}

// Windows 没有可同步调用的系统对话框 API，用 PowerShell 的 WinForms 对话框阻塞等待。
function showOpenDialogWindows(options = {}) {
  const title = String(options.title || "Select file")
    .replace(/[\r\n]/g, " ")
    .replace(/'/g, "''");
  const wantsDir =
    Array.isArray(options.properties) && options.properties.includes("openDirectory");
  const dialog = wantsDir
    ? `$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${title}'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }`
    : `$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '${title}'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }`;
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; ${dialog}`;
  try {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
        windowsHide: true,
      }
    );
    if (r.error || r.status !== 0) return null;
    const out = String(r.stdout || "").trim();
    return out ? [out] : null;
  } catch (e) {
    console.error(`[shim] showOpenDialog 失败: ${e.message}`);
    return null;
  }
}

// ==================== 生命周期钩子 ====================

const _enterCallbacks = [];
const _outCallbacks = [];

function fireEnter(action) {
  for (const cb of _enterCallbacks) {
    try {
      cb(action || { code: "", type: "text", payload: "" });
    } catch (e) {
      console.error(`[shim] onPluginEnter 回调异常: ${e.message}`);
    }
  }
  flushNow();
}

function fireOut() {
  for (const cb of _outCallbacks) {
    try {
      cb();
    } catch (e) {
      console.error(`[shim] onPluginOut 回调异常: ${e.message}`);
    }
  }
  flushNow();
}

// ==================== 导出 ====================

function createUtoolsShim() {
  return {
    db,
    getPath,
    getNativeId,
    shellOpenPath,
    shellOpenExternal,
    copyText,
    showOpenDialog,

    onPluginEnter(cb) {
      if (typeof cb === "function") _enterCallbacks.push(cb);
    },
    onPluginOut(cb) {
      if (typeof cb === "function") _outCallbacks.push(cb);
    },

    // 已确认不迁移 uTools 搜索框指令，保持空实现以免 commands.js 抛错
    setFeature() {},
    removeFeature() {},
    getFeatures() {
      return [];
    },
    createBrowserWindow() {
      return null;
    },
    sendToParent() {},
    hideMainWindow: () => false,
    showMainWindow: () => false,
    redirect: () => false,
    redirectHotKeySetting() {},
    getCmdHotKey: () => null,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => null,
    getPrimaryDisplay: () => null,

    isWindows: () => process.platform === "win32",
    isMacOS: () => process.platform === "darwin",
    isLinux: () => process.platform === "linux",
  };
}

module.exports = {
  createUtoolsShim,
  fireEnter,
  fireOut,
  flushNow,
  APP_SUPPORT,
};
