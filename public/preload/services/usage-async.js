// 统计异步入口（渲染层调用）：把重统计放到 worker_threads 后台线程执行。
// - worker 文件随 preload 一起 esbuild 打包为 dist/preload/usage-worker.js（见 vite.config.js）；
// - 主线程预读 worker 需要的 DB 文档（各 agent 历史档 / Claude 热力图）作为种子传入，
//   worker 内 db.get 命中种子、db.put 收集写队列，任务结束后主线程重放真实写库；
// - worker 不可用（线程创建失败 / 超时 / 报错）时回退到原同步调用，行为不变只是阻塞。
//
// 注意：主线程侧 window.utools 是真实环境；本模块只处理 agent usage 统计相关入口。

const { Worker } = require("node:worker_threads");
const path = require("node:path");

// 与 usage.js 的 AGENT_USAGE_IDS 对应的种子文档前缀
const AGENT_SEED_PREFIXES = [
  "ccconfig_agent_usage_",
  "ccconfig_heatmap_",
  "ccconfig_usage_cache_",
  "ccconfig_dsh_usage_cache_",
];

// worker 单任务超时：SQLite 子进程回退 + 大 JSONL 全量解析的最坏情况
const TASK_TIMEOUT_MS = 120_000;

let _worker = null;
let _seq = 0;
// taskId -> { resolve, reject, timer }
const _pending = new Map();

const workerPath = () => path.join(__dirname, "usage-worker.js");

const ensureWorker = () => {
  if (_worker && !_worker.__dead) return _worker;
  const w = new Worker(workerPath());
  w.__dead = false;
  w.__busy = false;
  w.on("message", (msg) => {
    const entry = _pending.get(msg.id);
    if (!entry) return;
    _pending.delete(msg.id);
    clearTimeout(entry.timer);
    w.__busy = false;
    _drain();
    if (msg.ok) {
      try {
        replayWrites(msg.pendingWrites || []);
      } catch (e) {
        console.error("[usage-async] 重放统计落库失败:", e);
      }
      entry.resolve(msg.stats);
    } else {
      entry.reject(new Error(msg.error || "worker 统计失败"));
    }
  });
  w.on("error", (e) => {
    w.__dead = true;
    _worker = null;
    // 让挂起任务直接走回退
    for (const [, entry] of _pending) {
      clearTimeout(entry.timer);
      entry.reject(e);
    }
    _pending.clear();
  });
  w.on("exit", (code) => {
    w.__dead = true;
    if (_worker === w) _worker = null;
    if (code !== 0) {
      for (const [, entry] of _pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`worker 异常退出（code=${code}）`));
      }
      _pending.clear();
    }
  });
  _worker = w;
  return w;
};

// 把 worker 写队列重放到真实 uTools DB（保留 _rev 防覆盖冲突）
const replayWrites = (docs) => {
  for (const doc of docs) {
    if (!doc || !doc._id) continue;
    try {
      const existing = window.utools.db.get(doc._id);
      const payload = { ...doc };
      if (existing && existing._rev) payload._rev = existing._rev;
      window.utools.db.put(payload);
    } catch (e) {
      console.error("[usage-async] 落库重放失败:", doc._id, e);
    }
  }
};

// 主线程预读 worker 需要的种子文档（历史档 / 热力图 / 缓存），worker 内 db.get 直接命中
const collectSeedDocs = () => {
  const seeds = {};
  try {
    const all = window.utools.db.allDocs();
    const docs = Array.isArray(all) ? all : all && all.docs ? all.docs : [];
    for (const doc of docs || []) {
      if (!doc || !doc._id) continue;
      if (AGENT_SEED_PREFIXES.some((p) => doc._id.startsWith(p))) {
        seeds[doc._id] = JSON.parse(JSON.stringify(doc));
      }
    }
  } catch (e) {
    console.warn("[usage-async] 预读种子文档失败:", e);
  }
  return seeds;
};

// 队列串行执行（单 worker 复用，避免并发线程叠加内存）
const _queue = [];
const _drain = () => {
  if (!_worker || _worker.__busy) return;
  const next = _queue.shift();
  if (!next) return;
  _worker.__busy = true;
  _worker.postMessage(next.msg);
};

// 返回 Promise<stats>；worker 路径失败时调用方负责回退
const runInWorker = (agent, force) =>
  new Promise((resolve, reject) => {
    let w;
    try {
      w = ensureWorker();
    } catch (e) {
      reject(e);
      return;
    }
    const id = ++_seq;
    const timer = setTimeout(() => {
      _pending.delete(id);
      // 超时：终止当前 worker，下次任务重建
      try { w.terminate(); } catch { /* ignore */ }
      w.__dead = true;
      if (_worker === w) _worker = null;
      reject(new Error("worker 统计超时"));
    }, TASK_TIMEOUT_MS);
    _pending.set(id, { resolve, reject, timer });
    _queue.push({
      msg: {
        id,
        agent,
        force: !!force,
        seed: collectSeedDocs(),
        home: (() => {
          try { return window.utools.getPath("home"); } catch { return "/"; }
        })(),
        nid: (() => {
          try { return window.utools.getNativeId(); } catch { return "main"; }
        })(),
      },
    });
    _drain();
  });

const withFallback = (agent, force, syncFn) =>
  runInWorker(agent, force).catch((e) => {
    console.warn(`[usage-async] ${agent} 后台统计失败，回退同步计算:`, e.message);
    return syncFn();
  });

// 对外：与同步版本同参同返回，只是异步化
const readClaudeUsageAsync = (force) =>
  withFallback("claude", force, () =>
    require("./claude-usage").readClaudeUsage(force),
  );

const readOpencodeUsageAsync = () =>
  withFallback("opencode", false, () =>
    require("./opencode").readOpencodeUsage(),
  );

const readPiUsageAsync = () =>
  withFallback("pi", false, () => require("./pi").readPiUsage());

// Kimi Code：wire.jsonl 解析（只扫 usage.record 行）走后台线程
const readKimiUsageAsync = () =>
  withFallback("kimi", false, () => require("./kimi-usage").readKimiUsage());

// MiniMax Code：会话 JSONL 解析走后台线程（同 Pi），不阻塞渲染层
const readMinimaxUsageAsync = () =>
  withFallback("minimax", false, () => require("./minimax").readMinimaxUsage());

// 快速路径：纯读落库历史重建统计（不解析源文件），供统计页进页面先展示；无历史返回 null
const readAgentUsageFromHistory = (agent) =>
  require("./usage").readAgentUsageFromHistory(agent);

const readZcodeUsageAsync = () =>
  withFallback("zcode", false, () => require("./zcode").readZcodeUsage());

const readDshUsageAsync = (force) =>
  withFallback("dsh", force, () => require("./dsh-usage").readDshUsage(force));

const readGrokUsageAsync = (force) =>
  withFallback("grok", force, () => require("./grok").readGrokUsage(force));

const readClineUsageAsync = (force) =>
  withFallback("cline", force, () => require("./cline").readClineUsage(force));
const readCommandCodeUsageAsync = (force) =>
  withFallback("commandcode", force, () =>
    require("./command-code").readCommandCodeUsage(force),
  );

module.exports = {
  readClaudeUsageAsync,
  readOpencodeUsageAsync,
  readPiUsageAsync,
  readKimiUsageAsync,
  readMinimaxUsageAsync,
  readZcodeUsageAsync,
  readDshUsageAsync,
  readGrokUsageAsync,
  readClineUsageAsync,
  readCommandCodeUsageAsync,
  readAgentUsageFromHistory,
};
