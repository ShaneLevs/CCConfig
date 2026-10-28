// desktop/sidecar/utools-shim.js
//
// 在 Node sidecar 中实现 uTools API 的最小子集，供既有 services.js 原样运行。
//
// 语义依据：.agents/skills/utools-plugin-dev/references/api-reference/db.md
//   - db.put(doc) 无 _rev 时新建、有 _rev 时校验，不一致返回 { error: true, name: 'conflict' }
//   - 单文档上限 1 MB
//   - db.remove 接受 id 字符串或 doc 对象
//   - db.allDocs() 无参返回全部、传字符串按 ID 前缀过滤、传数组按 ID 取
// 存储：~/.ccconfig/db/ 下一个文档一个 JSON 文件（文件名映射见下方 DB 段落）。
// 与文档的唯一有意偏差：新建文档时若携带 _rev（例如从旧导出数据导入）忽略之，不报 not_found，
// 以免迁移数据因残留 _rev 而写入失败。
//
// setFeature / removeFeature / getFeatures 按已确认的决策做成 no-op：桌面版不迁移 uTools 搜索框指令。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

// 数据目录在用户目录下（与 .claude / .dsh / .codex 等 agent 配置同层，便于备份与排查），
// 不再放 ~/Library/Application Support。旧位置在 Rust 启动时只迁移 runtime.json 与日志；
// 数据库已改为 db/ 下每文档一文件，旧 db.json 不再读取。
const APP_SUPPORT = () =>
  process.env.CCCONFIG_DATA_DIR ||
  process.env.CCSWITCH_DATA_DIR || // 兼容旧环境变量名
  path.join(os.homedir(), ".ccconfig");

const DB_DIR = () => path.join(APP_SUPPORT(), "db");
const MAX_DOC_BYTES = 1024 * 1024;
const FLUSH_DEBOUNCE_MS = 200;

// ==================== DB ====================
//
// 存储形态：`~/.ccconfig/db/<slug>-<sha1(id) 前 12 位>.json`，一个文档一个文件。
//
// 不直接拿文档 ID 当文件名：ID 片段可能来自用户配置（`ccconfig_mcp_disabled_<nativeId>_<name>`），
// 含 `/`、`:`、中文、`..` 都合法；而 macOS 默认的大小写不敏感 / Unicode 规范化不敏感的卷会把
// `Foo` 与 `foo`、NFC 与 NFD 落到同一个文件。slug 只负责可读性，哈希负责唯一性，真正的 `_id`
// 以文件内容为准。
//
// 写入沿用 uTools 语义：_rev 冲突校验、单文档 1MB 上限。一次 put 只标脏一条文档，
// 200ms 防抖后只落这一条；flushNow() 供 onPluginEnter/Out、退出与 allDocs 前强制刷盘。

let _cache = new Map(); // id -> doc | null（null = 已确认不存在）
let _dirty = new Map(); // id -> "put" | "delete"
let _flushTimer = null;

function ensureDir() {
  const dir = DB_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function docFile(id) {
  const hash = crypto
    .createHash("sha1")
    .update(String(id), "utf8")
    .digest("hex")
    .slice(0, 12);
  const slug =
    String(id)
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "doc";
  return path.join(DB_DIR(), `${slug}-${hash}.json`);
}

function readDoc(id) {
  if (_cache.has(id)) return _cache.get(id);
  let doc = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(docFile(id), "utf8"));
    if (parsed && parsed._id === id) doc = parsed;
    else if (parsed && typeof parsed._id === "string") {
      console.error(`[shim] 文件名哈希撞车，忽略 ${parsed._id}`);
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`[shim] 读取文档 ${id} 失败: ${e.message}`);
    }
  }
  _cache.set(id, doc);
  return doc;
}

function writeDocFile(file, doc) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file); // 原子替换，避免 kill -9 留下半截文件
    // 库里含 AES 加密后的 API Key 与网关 key，收紧为仅本人可读
    try {
      fs.chmodSync(file, 0o600);
    } catch (e) {
      /* 忽略（非 unix 文件系统） */
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (e2) {
      /* 忽略 */
    }
    throw e;
  }
}

function flushNow() {
  if (_dirty.size === 0) return;
  const pending = _dirty;
  _dirty = new Map();
  try {
    ensureDir();
  } catch (e) {
    console.error(`[shim] 创建文档目录失败: ${e.message}`);
    for (const [id, op] of pending) _dirty.set(id, op);
    return;
  }
  for (const [id, op] of pending) {
    try {
      if (op === "delete") {
        try {
          fs.unlinkSync(docFile(id));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
      } else {
        const doc = _cache.get(id);
        if (doc) writeDocFile(docFile(id), doc);
      }
    } catch (e) {
      console.error(`[shim] 文档落盘失败 ${id}: ${e.message}`);
      _dirty.set(id, op); // 下次 flushNow / 防抖再试
    }
  }
}

function markDirty(id, op) {
  _dirty.set(id, op);
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushNow();
  }, FLUSH_DEBOUNCE_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}

function nextRev(prevRev) {
  const n = prevRev ? parseInt(String(prevRev).split("-")[0], 10) + 1 : 1;
  return `${Number.isFinite(n) ? n : 1}-${crypto.randomBytes(8).toString("hex")}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const db = {
  get(id) {
    const doc = readDoc(String(id));
    return doc ? clone(doc) : null;
  },

  put(doc) {
    if (!doc || typeof doc !== "object" || typeof doc._id !== "string" || !doc._id) {
      return { error: true, name: "bad_request", message: "doc._id 必须是非空字符串" };
    }
    const id = doc._id;
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(doc), "utf8");
    } catch (e) {
      return { error: true, name: "bad_request", message: `文档无法序列化: ${e.message}`, id };
    }
    if (size > MAX_DOC_BYTES) {
      return { error: true, name: "too_large", message: `文档 ${size} 字节，超过 1MB 上限`, id };
    }

    const cur = readDoc(id);
    if (cur && cur._rev && doc._rev !== cur._rev) {
      return {
        error: true,
        name: doc._rev ? "conflict" : "missing_rev",
        message: doc._rev ? "Document update conflict" : "更新已有文档必须提供 _rev",
        id,
      };
    }

    const rev = nextRev(cur && cur._rev);
    const stored = clone(doc);
    stored._rev = rev;
    _cache.set(id, stored);
    markDirty(id, "put");
    return { ok: true, id, rev };
  },

  remove(idOrDoc, maybeRev) {
    const isDoc = idOrDoc && typeof idOrDoc === "object";
    const id = isDoc ? idOrDoc._id : idOrDoc;
    const rev = isDoc ? idOrDoc._rev : maybeRev;
    if (!id) return { error: true, name: "bad_request", message: "缺少 _id" };
    const cur = readDoc(String(id));
    if (!cur) return { error: true, name: "not_found", message: "文档不存在", id: String(id) };
    if (rev && cur._rev && rev !== cur._rev) {
      return { error: true, name: "conflict", message: "Document update conflict", id: String(id) };
    }
    _cache.set(String(id), null);
    markDirty(String(id), "delete");
    return { ok: true, id: String(id) };
  },

  // 对齐 uTools：无参返回全部、字符串按 ID 前缀过滤、数组按 ID 取
  allDocs(arg) {
    flushNow(); // 先把内存里的写入/删除落到磁盘，再以磁盘为准扫描
    if (Array.isArray(arg)) {
      const docs = [];
      for (const id of arg) {
        const doc = readDoc(String(id));
        if (doc) docs.push(clone(doc));
      }
      return docs;
    }
    const prefix = typeof arg === "string" ? arg : "";
    const docs = [];
    const seen = new Set();
    let names = [];
    try {
      names = fs.readdirSync(DB_DIR());
    } catch (e) {
      if (e.code !== "ENOENT") console.error(`[shim] 读取文档目录失败: ${e.message}`);
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // 跳过 .DS_Store、残留 .tmp 等
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(DB_DIR(), name), "utf8"));
      } catch (e) {
        console.error(`[shim] 跳过无法解析的文档文件 ${name}: ${e.message}`);
        continue;
      }
      if (!parsed || typeof parsed._id !== "string") continue;
      if (prefix && !parsed._id.startsWith(prefix)) continue;
      // 磁盘内容可能落后于内存（写盘失败时仍在 _dirty），内存有记录就以内存为准
      const cached = _cache.get(parsed._id);
      const doc = cached === undefined ? parsed : cached;
      if (cached === undefined) _cache.set(parsed._id, parsed);
      if (!doc || seen.has(parsed._id)) continue;
      seen.add(parsed._id);
      docs.push(clone(doc));
    }
    // 写盘失败、只剩内存副本的文档也一并返回
    for (const [id, doc] of _cache) {
      if (!doc || seen.has(id) || !_dirty.has(id)) continue;
      if (prefix && !id.startsWith(prefix)) continue;
      docs.push(clone(doc));
    }
    return docs;
  },
};

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

const NATIVE_ID_DOC = "ccconfig_runtime_id";
// 改名前的同名文档：迁移前若先被读到，必须认旧的，否则会从新种子重新算出一个设备 ID，
// 让所有 `_<nativeId>` 文档（外观 / Agent 启停 / 网关配置 / 统计）全部孤儿化。
const LEGACY_NATIVE_ID_DOC = "ccswitch_runtime_id";
// 设备 ID 的哈希种子。**永远不要改**：一旦改动，没命中缓存的机器会算出不同的 nativeId。
const NATIVE_ID_SEED_SUFFIX = "ccswitch-desktop";

function firstMacAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (!info.internal && info.mac && info.mac !== "00:00:00:00:00:00") {
        return `${name}:${info.mac}`;
      }
    }
  }
  return "no-mac";
}

// 与 uTools 的「按插件独立哈希的设备 ID」语义对齐：稳定、不可逆、不含明文主机信息
function getNativeId() {
  const cached = readDoc(NATIVE_ID_DOC) || readDoc(LEGACY_NATIVE_ID_DOC);
  if (cached && typeof cached.value === "string" && cached.value) return cached.value;

  const seed = `${os.hostname()}|${firstMacAddress()}|${NATIVE_ID_SEED_SUFFIX}`;
  const value = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);

  const doc = { _id: NATIVE_ID_DOC, value, createdAt: Date.now() };
  _cache.set(NATIVE_ID_DOC, doc);
  markDirty(NATIVE_ID_DOC, "put");
  return value;
}

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
