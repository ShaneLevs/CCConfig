// desktop/sidecar/server.js
//
// 把既有 preload（dist/preload/services.js）包装成本机 HTTP 服务，供 Tauri 的 WebView 通过同步 XHR 调用。
//
// 关键设计：
//   1. globalThis.window = globalThis —— services.js 以 window.xxx 访问全局，Node 下可直接映射。
//   2. 先注入 window.utools（utools-shim.js），再 require services.js，保证其在装载期访问 utools 时不炸。
//   3. 只监听 127.0.0.1，用启动参数传入的随机 token 校验，防止同机其他进程调用。
//   4. sidecar 启动后立即 fireEnter 一次，等价 uTools 的「插件进入」，
//      以便 autoroute 按用户配置自启动（桌面版网关需常驻）。
//   5. 异步任务通道：services 方法返回 Promise 时（外部网络请求等慢操作），
//      /rpc 立即回 {ok:true, async:true, taskId}，结果就绪后经 /rpc-poll 长轮询取回。
//      WebView 的同步 XHR 只等「函数调用 + 判定 thenable」这一小段，主线程不再被慢网络卡死；
//      bridge 侧对这类调用返回真 Promise，await / .then 语义与 uTools 版一致。
//      注意：这只覆盖「返回 Promise」的方法；函数体内的同步慢操作（execSync 等）
//      仍会同时阻塞 WebView 与 sidecar 事件循环，禁止新增。
//
// 参数：--port <n>（0 = 由系统分配） --token <str> --parent-pid <n> --data-dir <path>

const http = require("node:http");
const path = require("node:path");
const shim = require("./utools-shim");

// ==================== 参数 ====================

function readArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

const PORT = Number(readArg("port", "0")) || 0;
const TOKEN = readArg("token", "");
const PARENT_PID = Number(readArg("parent-pid", "0")) || 0;
const DATA_DIR = readArg("data-dir", "");
if (DATA_DIR) process.env.CCCONFIG_DATA_DIR = DATA_DIR;

const MAX_BODY_BYTES = 32 * 1024 * 1024; // exportConfigs 等可能携带大 payload
const SLOW_CALL_WARN_MS = 10000;
// --verbose 时把每个 RPC 方法名写入日志，用于排查前端到底调了什么
const VERBOSE = process.argv.includes("--verbose");

// ==================== 装载 preload ====================

globalThis.window = globalThis;
globalThis.window.utools = shim.createUtoolsShim();

let services = null;
let bootError = null;
try {
  require("./services.js");
  services = globalThis.services;
  if (!services || typeof services !== "object") {
    throw new Error("services.js finished without attaching window.services");
  }
  console.error(`[sidecar] services 已装载，方法数 ${Object.keys(services).length}`);
} catch (e) {
  bootError = e;
  console.error(`[sidecar] services 装载失败: ${e && e.stack ? e.stack : e}`);
}

// ==================== utools 命名空间的 RPC 入口 ====================

const utoolsHandlers = {
  "db.get": (id) => shim.createUtoolsShim().db.get(id),
  "db.put": (doc) => shim.createUtoolsShim().db.put(doc),
  "db.remove": (idOrDoc, rev) => shim.createUtoolsShim().db.remove(idOrDoc, rev),
  "db.allDocs": () => shim.createUtoolsShim().db.allDocs(),
  getPath: (name) => shim.createUtoolsShim().getPath(name),
  getNativeId: () => shim.createUtoolsShim().getNativeId(),
  shellOpenPath: (p) => shim.createUtoolsShim().shellOpenPath(p),
  shellOpenExternal: (u) => shim.createUtoolsShim().shellOpenExternal(u),
  copyText: (t) => shim.createUtoolsShim().copyText(t),
  showOpenDialog: (opts) => shim.createUtoolsShim().showOpenDialog(opts),
  // WebView 侧异常上报（桌面版没有常驻 devtools，这是唯一的排障入口）
  "diag.log": (kind, text) => {
    console.error(`[webview:${kind}] ${text}`);
    return null;
  },
  // services 的属性分为函数与常量两类（如 DSH_THINKING_FORMATS 是数组），
  // 前端用 Proxy 统一当函数包装会让 .map 之类报错，所以启动时先取一次清单。
  describeServices: () => {
    const functions = [];
    const constants = {};
    for (const [key, value] of Object.entries(services || {})) {
      if (typeof value === "function") functions.push(key);
      else constants[key] = value;
    }
    return { functions, constants };
  },
};

// ==================== 异步任务通道 ====================

const asyncTasks = new Map(); // taskId -> task；插入序即 id 序，淘汰从最旧开始
let asyncTaskSeq = 0;
const ASYNC_TASK_KEEP = 256; // 已注册任务上限（含未完成），防止内存无限增长
const RPC_POLL_MAX_WAIT = 25_000; // 长轮询等待上限，到点回 pending 让客户端重连

function registerAsyncTask(method, promise) {
  const taskId = `task-${++asyncTaskSeq}`;
  const task = {
    method,
    createdAt: Date.now(),
    settled: false,
    ok: false,
    value: null,
    error: "",
    svcCode: "",
    waiters: [],
  };
  asyncTasks.set(taskId, task);
  while (asyncTasks.size > ASYNC_TASK_KEEP) {
    const oldest = asyncTasks.keys().next().value;
    asyncTasks.delete(oldest); // 未完成任务被淘汰时，轮询方会收到 gone
  }
  Promise.resolve(promise).then(
    (v) => settleAsyncTask(task, true, v),
    (e) => settleAsyncTask(task, false, e),
  );
  return taskId;
}

function settleAsyncTask(task, ok, payload) {
  if (task.settled) return;
  task.settled = true;
  task.ok = ok;
  if (ok) {
    const value = payload === undefined ? null : payload;
    try {
      // 提前校验可序列化性：坏值按失败落库，避免 /rpc-poll 序列化时挂死响应
      JSON.stringify(value);
      task.value = value;
    } catch (e) {
      task.ok = false;
      task.error = `return value is not JSON-serializable: ${e.message}`;
    }
  } else {
    task.error = String((payload && payload.message) || payload);
    task.svcCode = String((payload && payload.svcCode) || "");
  }
  const cost = Date.now() - task.createdAt;
  if (!task.ok) console.error(`[sidecar] ${task.method} (异步) 失败: ${task.error}`);
  else if (cost > 300) console.error(`[sidecar] ${task.method} (异步) 耗时 ${cost}ms`);
  for (const wake of task.waiters.splice(0)) wake();
}

function sendPollResult(res, task) {
  if (!task.settled) return sendJson(res, 200, { status: "pending" });
  if (task.ok) return sendJson(res, 200, { status: "done", value: task.value });
  return sendJson(res, 200, {
    status: "error",
    error: task.error,
    svcCode: task.svcCode || undefined,
  });
}

// ==================== HTTP ====================

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CCConfig-Token");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function dispatch(method, args) {
  if (method.startsWith("__utools.")) {
    const key = method.slice("__utools.".length);
    const handler = utoolsHandlers[key];
    if (!handler) throw new Error(`unknown utools method: ${key}`);
    return handler(...args);
  }
  if (bootError) throw new Error(`services not ready: ${bootError.message}`);
  const fn = services[method];
  if (typeof fn !== "function") throw new Error(`unknown services method: ${method}`);
  // 故意不 await：thenable 交给异步任务通道，由 /rpc-poll 取结果
  return fn(...args);
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = (req.url || "/").split("?")[0];

  if (url === "/health") {
    sendJson(res, bootError ? 503 : 200, {
      ok: !bootError,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      services: services ? Object.keys(services).length : 0,
      error: bootError ? bootError.message : null,
    });
    return;
  }

  // 除 /health 外一律校验 token
  if (TOKEN && req.headers["x-ccconfig-token"] !== TOKEN) {
    sendJson(res, 403, { ok: false, error: "token validation failed" });
    return;
  }

  if (url === "/shutdown") {
    shim.flushNow();
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 50);
    return;
  }

  if (url === "/event") {
    try {
      const raw = await readBody(req);
      const evt = raw ? JSON.parse(raw) : {};
      if (evt.type === "enter") shim.fireEnter(evt.action);
      else if (evt.type === "out") shim.fireOut();
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  if (url === "/rpc" && req.method === "POST") {
    const startedAt = Date.now();
    const warnTimer = setTimeout(() => {
      console.error(
        `[sidecar] 慢调用告警：同步段已执行 ${SLOW_CALL_WARN_MS}ms 仍未返回` +
          `（函数体内的同步慢操作会同时阻塞 WebView 与 sidecar）`,
      );
    }, SLOW_CALL_WARN_MS);

    let method = "?";
    try {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      method = String(payload.method || "");
      const args = Array.isArray(payload.args) ? payload.args : [];
      if (VERBOSE) console.error(`[rpc] ${method}`);
      const value = dispatch(method, args);
      if (value && typeof value.then === "function") {
        // 异步任务通道：先回 taskId 解除 WebView 阻塞，结果经 /rpc-poll 取回
        const taskId = registerAsyncTask(method, value);
        clearTimeout(warnTimer);
        sendJson(res, 200, { ok: true, async: true, taskId });
        return;
      }
      clearTimeout(warnTimer);
      const cost = Date.now() - startedAt;
      if (cost > 300) console.error(`[sidecar] ${method} 耗时 ${cost}ms`);
      sendJson(res, 200, { ok: true, value: value === undefined ? null : value });
    } catch (e) {
      clearTimeout(warnTimer);
      const message = String((e && e.message) || e);
      console.error(`[sidecar] ${method} 失败: ${message}`);
      sendJson(res, 200, { ok: false, error: message, svcCode: (e && e.svcCode) || undefined });
    }
    return;
  }

  if (url === "/rpc-poll" && req.method === "POST") {
    let taskId = "";
    try {
      const raw = await readBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      taskId = String(payload.taskId || "");
    } catch (e) {
      sendJson(res, 400, { ok: false, error: "invalid JSON body" });
      return;
    }
    const task = asyncTasks.get(taskId);
    if (!task) {
      sendJson(res, 200, { status: "gone" });
      return;
    }
    if (!task.settled) {
      // 长轮询：结果就绪即回复；RPC_POLL_MAX_WAIT 内仍未就绪则回 pending，客户端无缝重连
      let replied = false;
      const reply = () => {
        if (replied) return;
        replied = true;
        sendPollResult(res, task);
      };
      task.waiters.push(reply);
      setTimeout(reply, RPC_POLL_MAX_WAIT);
      return;
    }
    sendPollResult(res, task);
    return;
  }

  sendJson(res, 404, { ok: false, error: `unimplemented route: ${req.method} ${url}` });
});

// ==================== 生命周期 ====================

server.listen(PORT, "127.0.0.1", () => {
  const actual = server.address().port;
  // 端口经 stdout 回传给 Rust（--port 0 时由系统分配）
  console.log(`CCCONFIG_SIDECAR_PORT=${actual}`);
  console.error(`[sidecar] 监听 127.0.0.1:${actual} (pid ${process.pid})`);

  // 等价「插件进入」：让 autoroute 按配置自启动
  if (services) {
    setTimeout(() => shim.fireEnter({ code: "", type: "text", payload: "" }), 0);
  }
});

// 父进程（Tauri）消失时自杀，避免孤儿进程占端口。
// 常见的一次失败不能算死：启动阶段（尤其 macOS 刚 CHECKIN 时）偶尔会拿到 ESRCH，
// 直接退会让应用误弹「需要 Node.js」引导页，所以要求连续 2 次探测失败才退出。
if (PARENT_PID > 0) {
  let missCount = 0;
  const guard = setInterval(() => {
    let alive = false;
    try {
      process.kill(PARENT_PID, 0);
      alive = true;
    } catch (e) {
      // EPERM = 进程还在，只是没权限发信号
      alive = e && e.code === "EPERM";
    }
    if (alive) {
      missCount = 0;
      return;
    }
    missCount += 1;
    if (missCount < 2) return;
    console.error("[sidecar] 父进程已退出，sidecar 自行结束");
    shim.flushNow();
    process.exit(0);
  }, 3000);
  if (guard.unref) guard.unref();
}

function gracefulExit(signal) {
  console.error(`[sidecar] 收到 ${signal}，落盘后退出`);
  try {
    shim.fireOut();
  } catch (e) {
    /* ignore */
  }
  shim.flushNow();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulExit("SIGTERM"));
process.on("SIGINT", () => gracefulExit("SIGINT"));
process.on("uncaughtException", (e) => {
  console.error(`[sidecar] uncaughtException: ${e && e.stack ? e.stack : e}`);
  shim.flushNow();
});
process.on("unhandledRejection", (e) => {
  console.error(`[sidecar] unhandledRejection: ${e && e.stack ? e.stack : e}`);
});
