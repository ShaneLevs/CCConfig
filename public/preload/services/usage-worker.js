// 用量统计后台线程（worker_threads）：把 JSONL / SQLite / zstd 的重解析挪出渲染进程，
// 避免 preload 同步计算阻塞 UI。经 usage-async.js 的 readUsageAsync 调用。
//
// 工作方式：
//   主线程 postMessage({ agent, force, nativeId, home, seedDocs })；
//   worker 侧先装一个最小 window.utools stub（现有统计模块顶层就依赖它），
//   再 require 对应统计模块执行同步函数：
//     - db.get(seedDocs) 返回主线程预读的真实文档（历史档/缓存命中判断依赖它）；
//     - db.put 收进写队列（热力图历史 / usage 缓存 / agent usage 落库），随结果带回主线程重放；
//     - db.get 其它键返回 null（= 缓存未命中，走全量解析，符合后台重算预期）；
//   完成后 postMessage({ ok, stats, pendingWrites })。
//   失败时 postMessage({ ok: false, error })，主线程回退同步路径。
//
// 注意：worker 里没有 uTools，window.utools.db 只有 stub；除了写队列重放外，
// worker 不做任何真实 IO 之外的副作用（shellOpenPath 等函数统计路径不会调用）。

const { parentPort } = require("node:worker_threads");

// 每次任务独立的 stub 环境（worker 生命周期内可能连续处理多个任务）
let installed = false;
let pendingWrites = [];
let seedDocs = {};
let nativeId = "worker";

const installUtoolsStub = () => {
  if (installed) return;
  installed = true;

  const docIdOf = (doc) => (doc && doc._id) || null;

  // worker 里没有 window 全局：先显式挂到 globalThis 再赋属性
  // （window 未声明时直接写 window.utools 会 ReferenceError）
  globalThis.window = globalThis.window || {};
  window.utools = {
    getPath: (name) => {
      // 统计路径只用 'home'；stub 直接返回主线程传来的 HOME
      if (name === "home") return global.__CCCONFIG_HOME__ || "/";
      return "/";
    },
    getNativeId: () => nativeId,
    shellOpenPath: () => {},
    copyText: () => {},
    showNotification: () => {},
    db: {
      get: (id) => {
        if (id in seedDocs) return seedDocs[id];
        return null; // 其余读取一律视为缓存未命中
      },
      put: (doc) => {
        const id = docIdOf(doc);
        if (id) pendingWrites.push(doc);
        return { ok: true, id };
      },
      remove: () => ({ ok: true }),
      allDocs: () => ({ docs: Object.values(seedDocs) }),
    },
  };
};

const RUNNERS = {
  claude: (force) => require("./claude-usage").readClaudeUsage(force),
  opencode: () => require("./opencode").readOpencodeUsage(),
  pi: () => require("./pi").readPiUsage(),
  omp: () => require("./omp-usage").readOmpUsage(),
  kimi: () => require("./kimi-usage").readKimiUsage(),
  minimax: () => require("./minimax").readMinimaxUsage(),
  zcode: () => require("./zcode").readZcodeUsage(),
  dsh: (force) => require("./dsh-usage").readDshUsage(force),
  grok: (force) => require("./grok").readGrokUsage(force),
  cline: (force) => require("./cline").readClineUsage(force),
  commandcode: (force) => require("./command-code").readCommandCodeUsage(force),
  reasonix: () => require("./reasonix-usage").readReasonixUsage(),
};

parentPort.on("message", (msg) => {
  const { id, agent, force, seed, home, nid } = msg || {};
  pendingWrites = [];
  seedDocs = seed || {};
  nativeId = nid || "worker";
  global.__CCCONFIG_HOME__ = home;

  try {
    installUtoolsStub();
    const run = RUNNERS[agent];
    if (!run) throw new Error(`未知统计 agent: ${agent}`);
    const stats = run(!!force);
    // 结构化克隆前剥掉不可克隆的内容（函数 / Set / Map 等）
    const clean = JSON.parse(
      JSON.stringify({
        summary: stats?.summary,
        modelStats: stats?.modelStats,
        contributions: stats?.contributions,
      }),
    );
    parentPort.postMessage({ id, ok: true, agent, stats: clean, pendingWrites });
  } catch (e) {
    parentPort.postMessage({
      id,
      ok: false,
      agent,
      error: (e && e.message) || String(e),
      pendingWrites,
    });
  }
});
