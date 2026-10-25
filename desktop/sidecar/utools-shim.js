// desktop/sidecar/utools-shim.js
//
// 在 Node sidecar 中实现 uTools API 的最小子集，供既有 services.js 原样运行。
//
// 语义依据：.agents/skills/utools-plugin-dev/references/api-reference/db.md
//   - db.put(doc) 无 _rev 时新建、有 _rev 时校验，不一致返回 { error: true, name: 'conflict' }
//   - 单文档上限 1 MB
//   - db.remove 接受 id 字符串或 doc 对象
//   - db.allDocs() 无参返回全部文档数组
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
// 不再放 ~/Library/Application Support。旧位置在 Rust 启动时一次性迁移。
const APP_SUPPORT = () =>
  process.env.CCCONFIG_DATA_DIR ||
  process.env.CCSWITCH_DATA_DIR || // 兼容旧环境变量名
  path.join(os.homedir(), ".ccconfig");

const DB_FILE = () => path.join(APP_SUPPORT(), "db.json");
const MAX_DOC_BYTES = 1024 * 1024;
const FLUSH_DEBOUNCE_MS = 200;

// ==================== DB ====================

let _docs = null; // Map<string, doc>
let _flushTimer = null;
let _flushPending = false;

function ensureDir() {
  const dir = APP_SUPPORT();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function loadDb() {
  if (_docs) return;
  _docs = new Map();
  try {
    const raw = fs.readFileSync(DB_FILE(), "utf8");
    const obj = JSON.parse(raw);
    for (const [id, doc] of Object.entries(obj)) {
      if (doc && typeof doc === "object") _docs.set(id, doc);
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`[shim] db 读取失败，按空库继续: ${e.message}`);
    }
  }
}

function flushNow() {
  if (!_docs || !_flushPending) return;
  _flushPending = false;
  try {
    ensureDir();
    const obj = Object.create(null);
    for (const [id, doc] of _docs) obj[id] = doc;
    const target = DB_FILE();
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target); // 原子替换，避免 kill -9 留下半截文件
    // 库里含 AES 加密后的 API Key 与网关 key，收紧为仅本人可读
    try {
      fs.chmodSync(target, 0o600);
    } catch (e) {
      /* 忽略（非 unix 文件系统） */
    }
  } catch (e) {
    console.error(`[shim] db 落盘失败: ${e.message}`);
  }
}

function markDirty() {
  _flushPending = true;
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
    loadDb();
    const doc = _docs.get(String(id));
    return doc ? clone(doc) : null;
  },

  put(doc) {
    loadDb();
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

    const cur = _docs.get(id);
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
    _docs.set(id, stored);
    markDirty();
    return { ok: true, id, rev };
  },

  remove(idOrDoc, maybeRev) {
    loadDb();
    const isDoc = idOrDoc && typeof idOrDoc === "object";
    const id = isDoc ? idOrDoc._id : idOrDoc;
    const rev = isDoc ? idOrDoc._rev : maybeRev;
    if (!id) return { error: true, name: "bad_request", message: "缺少 _id" };
    const cur = _docs.get(String(id));
    if (!cur) return { error: true, name: "not_found", message: "文档不存在", id: String(id) };
    if (rev && cur._rev && rev !== cur._rev) {
      return { error: true, name: "conflict", message: "Document update conflict", id: String(id) };
    }
    _docs.delete(String(id));
    markDirty();
    return { ok: true, id: String(id) };
  },

  allDocs() {
    loadDb();
    return Array.from(_docs.values()).map(clone);
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
  logs: () => path.join(os.homedir(), "Library", "Logs", "CCSwitch"),
};

function getPath(name) {
  const resolver = PATH_RESOLVERS[String(name)];
  if (!resolver) throw new Error(`不支持的路径名称: ${name}`);
  return resolver();
}

const NATIVE_ID_DOC = "ccswitch_runtime_id";

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
  loadDb();
  const cached = _docs.get(NATIVE_ID_DOC);
  if (cached && typeof cached.value === "string" && cached.value) return cached.value;

  const seed = `${os.hostname()}|${firstMacAddress()}|ccswitch-desktop`;
  const value = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);

  const doc = { _id: NATIVE_ID_DOC, value, createdAt: Date.now() };
  _docs.set(NATIVE_ID_DOC, doc);
  markDirty();
  return value;
}

// ==================== 系统交互 ====================

function shellOpenPath(fullPath) {
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
    execFileSync("open", [String(url)], { stdio: "ignore" });
  } catch (e) {
    console.error(`[shim] shellOpenExternal 失败: ${url}: ${e.message}`);
  }
}

function copyText(text) {
  try {
    const r = spawnSync("pbcopy", [], { input: String(text ?? "") });
    if (r.status !== 0) console.error(`[shim] pbcopy 退出码 ${r.status}`);
  } catch (e) {
    console.error(`[shim] copyText 失败: ${e.message}`);
  }
}

// 同步返回 string[] | null，对齐 common.js 对返回值的期望
function showOpenDialog(options = {}) {
  const title = String(options.title || "Select file").replace(/["\\]/g, "");
  const script = `set f to choose file with prompt "${title}"\nPOSIX path of f`;
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

    isWindows: false,
    isMacOS: true,
    isLinux: false,
  };
}

module.exports = {
  createUtoolsShim,
  fireEnter,
  fireOut,
  flushNow,
  APP_SUPPORT,
};
