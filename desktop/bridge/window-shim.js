// desktop/bridge/window-shim.js
//
// 桌面版专用的 window.utools / window.services 垫片，在 Vue 挂载前同步执行。
//
// 设计要点：
//   1. window.services 用 Proxy 兜住全部 327 个方法，新增 service 无需改本文件。
//   2. 同步方法走同步 XHR（Phase 0 已实测 WKWebView 支持，含跨域 preflight），
//      保持现有 275 处同步调用的语义不变，前端零改动。
//   3. 返回 Promise 的方法走「异步任务通道」：/rpc 立即回 taskId（同步 XHR 只等
//      函数调用的同步前缀，毫秒级），本文件再用异步 XHR 长轮询 /rpc-poll 取结果，
//      返回真 Promise —— 主线程不再被外部网络等慢操作卡死，await / .then / .catch
//      语义与 uTools 版一致（fetchPiDevPackages / fetchProviderModels 等受益）。
//   4. 同步 XHR 无法设置 timeout（规范禁止），因此不设 timeout；卡死防护由
//      sidecar 慢调用告警 + Rust watchdog 负责（见方案文档 §10.1）。
//   5. onPluginEnter 只在首帧触发一次，避免窗口重新聚焦时把用户当前视图重置掉。

(function () {
  // 桌面版没有搜索框指令，固定进「通用配置」（plugin.json 的静态入口，不会被 agent 启停影响）
  // 端口/token 每次调用时动态读取，而非闭包常量：托盘「重启网关服务」会更换 sidecar 端口，
  // Rust 侧通过 webview.eval 更新这两个全局，已加载的页面无需重载。
  const DEFAULT_ROUTE = "commonConfig";

  let broken = false;

  function rpcSync(path, body) {
    const port = window.__CCCONFIG_PORT__;
    const token = window.__CCCONFIG_TOKEN__ || "";
    if (!port) {
      throw new Error("CCConfig: sidecar port is not injected (window.__CCCONFIG_PORT__ missing)");
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `http://127.0.0.1:${port}${path}`, false); // 同步，保持既有调用语义
    xhr.setRequestHeader("Content-Type", "application/json");
    if (token) xhr.setRequestHeader("X-CCConfig-Token", token);
    xhr.send(JSON.stringify(body));

    if (xhr.status !== 200) {
      throw new Error(`CCConfig: ${path} HTTP ${xhr.status}`);
    }
    try {
      return JSON.parse(xhr.responseText);
    } catch (e) {
      throw new Error(`CCConfig: ${path} returned invalid JSON: ${xhr.responseText.slice(0, 120)}`);
    }
  }

  function call(method, args) {
    const payload = rpcSync("/rpc", { method, args: Array.isArray(args) ? args : [] });
    if (payload.ok && payload.async) {
      return pollAsyncTask(method, payload.taskId);
    }
    if (!payload.ok) {
      const err = new Error(`CCConfig: ${method} failed: ${payload.error}`);
      err.svcCode = payload.svcCode || "";
      throw err;
    }
    return payload.value;
  }

  // 异步任务通道的结果轮询：全程异步 XHR，不占主线程。
  // 服务端长轮询上限 25s（到点回 pending），客户端收到 pending 立即重连；
  // 35s 网络超时兜底 sidecar 无响应的情况。
  function pollAsyncTask(method, taskId) {
    const port = window.__CCCONFIG_PORT__;
    const token = window.__CCCONFIG_TOKEN__ || "";
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `http://127.0.0.1:${port}/rpc-poll`, true); // 异步
      xhr.timeout = 35000;
      xhr.setRequestHeader("Content-Type", "application/json");
      if (token) xhr.setRequestHeader("X-CCConfig-Token", token);
      xhr.onload = () => {
        if (xhr.status !== 200) {
          reject(new Error(`CCConfig: ${method} poll HTTP ${xhr.status}`));
          return;
        }
        let payload;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch (e) {
          reject(new Error(`CCConfig: ${method} poll returned invalid JSON`));
          return;
        }
        if (payload.status === "done") resolve(payload.value);
        else if (payload.status === "pending") resolve(pollAsyncTask(method, taskId));
        else if (payload.status === "error") {
          const err = new Error(`CCConfig: ${method} failed: ${payload.error}`);
          err.svcCode = payload.svcCode || "";
          reject(err);
        } else reject(new Error(`CCConfig: ${method} task result lost (${payload.status})`));
      };
      xhr.onerror = () => reject(new Error(`CCConfig: ${method} poll network error (sidecar unreachable?)`));
      xhr.ontimeout = () => reject(new Error(`CCConfig: ${method} poll timed out`));
      xhr.send(JSON.stringify({ taskId }));
    });
  }

  // 不让 sidecar 单点故障把整个 UI 打崩：失败时告警并返回 null（现有调用点多数有 `|| {}` 兜底）
  function safeCall(method, args, fallback) {
    try {
      return call(method, args);
    } catch (e) {
      if (!broken) {
        broken = true;
        console.error("[ccconfig-shim] sidecar 调用失败，后续错误不再重复打印:", e);
      }
      return fallback;
    }
  }

  // ==================== 桌面版外观标记 ====================
  // src/main.css 把 html/body 设成 transparent，是为了让 uTools 8 的原生亚克力材质透上来；
  // 桌面版现在同样走透明路线：窗口 transparent + NSVisualEffectView 原生毛玻璃（见 src-tauri/src/main.rs）。
  // 所以这里只打一个 is-desktop 标记（前端据此留出 overlay 标题栏的顶部高度），**不得再注入不透明底色**：
  // WebGL 背景特效的 canvas 是 `position: fixed; z-index: -1`，负 z-index 层绘制在 body 背景之下，
  // 给 body 铺不透明色会把特效整个盖掉（桌面版「特效不生效」的根因）。
  (function markDesktop() {
    const root = document.documentElement;
    root.classList.add("is-desktop");
    // Windows 保留原生标题栏（macOS 才是 overlay 透明标题栏），前端不需要再让出顶部高度。
    if (/Windows/i.test(navigator.userAgent)) root.classList.add("is-windows");
  })();

  // ==================== 诊断上报 ====================
  // 把 WebView 侧的异常与调用失败集中到 sidecar 日志，因为桌面版没有方便可用的 devtools 通道。
  function reportDiag(kind, text) {
    try {
      const port = window.__CCCONFIG_PORT__;
      if (!port) return;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `http://127.0.0.1:${port}/rpc`, false);
      xhr.setRequestHeader("Content-Type", "application/json");
      const token = window.__CCCONFIG_TOKEN__ || "";
      if (token) xhr.setRequestHeader("X-CCConfig-Token", token);
      xhr.send(JSON.stringify({ method: "__utools.diag.log", args: [kind, String(text).slice(0, 2000)] }));
    } catch (e) {
      /* 诊断本身失败只能静默，不能递归 */
    }
  }

  window.addEventListener("error", (e) => {
    reportDiag("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    reportDiag("rejection", r && (r.stack || r.message) ? r.stack || r.message : String(r));
  });
  function fmtArg(a) {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a);
    } catch (err) {
      return String(a);
    }
  }

  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    reportDiag("console", args.map(fmtArg).join(" "));
    originalConsoleError(...args);
  };

  // 启动自检：立即确认能否与 sidecar 通信，结果写入日志
  setTimeout(() => {
    try {
      const home = call("__utools.getPath", ["home"]);
      reportDiag("boot", `bridge ok, getPath(home)=${home}`);
    } catch (e) {
      reportDiag("boot", `bridge FAILED: ${e.message}`);
    }
  }, 0);

  // ==================== window.services ====================
  // services 上混着函数与常量（DSH_PROTOCOLS / DSH_THINKING_FORMATS 等是数组）。
  // 不能无差别包成函数，先在启动时取一次属性清单，常量直接映射、函数包成 RPC 调用。
  let serviceFunctions = new Set();
  let serviceConstants = {};
  try {
    const desc = call("__utools.describeServices", []);
    serviceFunctions = new Set(desc.functions || []);
    serviceConstants = desc.constants || {};
  } catch (e) {
    // sidecar 异常时兵败如山倒，重新抛出便于在日志里直接看到
    console.error("[ccconfig-shim] 拉取 services 属性清单失败:", e);
  }

  window.services = new Proxy(serviceConstants, {
    get(target, name) {
      if (typeof name !== "string") return target[name];
      if (name in target) return target[name];
      if (serviceFunctions.has(name)) {
        return (...args) => call(name, args);
      }
      return undefined;
    },
    has(target, name) {
      return typeof name === "string" && (name in target || serviceFunctions.has(name));
    },
  });

  // ==================== window.utools ====================

  const enterCbs = [];
  const outCbs = [];
  let enterFired = false;

  function fireEnterOnce() {
    if (enterFired) return;
    enterFired = true;
    const action = { code: DEFAULT_ROUTE, type: "text", payload: "" };
    for (const cb of enterCbs) {
      try {
        cb(action);
      } catch (e) {
        console.error("[ccconfig-shim] onPluginEnter 回调异常:", e);
      }
    }
  }

  window.utools = {
    db: {
      get: (id) => safeCall("__utools.db.get", [id], null),
      put: (doc) => safeCall("__utools.db.put", [doc], { error: true, name: "unavailable", message: "sidecar unavailable" }),
      remove: (idOrDoc, rev) =>
        safeCall("__utools.db.remove", [idOrDoc, rev], { error: true, name: "unavailable", message: "sidecar unavailable" }),
      allDocs: () => safeCall("__utools.db.allDocs", [], []),
    },

    getPath: (name) => {
      try {
        return call("__utools.getPath", [name]);
      } catch (e) {
        // 前端只在展示路径时用到，兜底到空串比抛错安全
        return "";
      }
    },
    getNativeId: () => safeCall("__utools.getNativeId", [], ""),

    shellOpenPath: (p) => {
      void safeCall("__utools.shellOpenPath", [p], null);
    },
    shellOpenExternal: (u) => {
      void safeCall("__utools.shellOpenExternal", [u], null);
    },
    copyText: (t) => {
      // 优先 sidecar 的 pbcopy：同步、必定成功，不依赖 secure context
      try {
        call("__utools.copyText", [t]);
      } catch (e) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(String(t ?? "")).catch(() => {});
        }
      }
    },
    showOpenDialog: (opts) => safeCall("__utools.showOpenDialog", [opts], null),

    // 首帧触发一次，之后保持静默：窗口重新聚焦不应该重置用户当前视图
    onPluginEnter: (cb) => {
      if (typeof cb !== "function") return;
      enterCbs.push(cb);
      if (enterFired) {
        cb({ code: DEFAULT_ROUTE, type: "text", payload: "" });
      } else {
        setTimeout(fireEnterOnce, 0);
      }
    },
    // 桌面版关窗口只隐藏，不能清空 route（否则重新显示时白屏）
    onPluginOut: (cb) => {
      if (typeof cb === "function") outCbs.push(cb);
    },

    // 已确认不迁移 uTools 搜索框指令
    setFeature: () => {},
    removeFeature: () => {},
    getFeatures: () => [],

    // 桌面版是 WebView，没有 Node 的 process.platform，按 UA 判断（用于下载目录、
    // shell 命令等按平台分叉的既有代码路径；macOS 仍是默认分支）
    isWindows: () => /Windows/i.test(navigator.userAgent),
    isMacOS: () => !/Windows|Linux/i.test(navigator.userAgent),
    isLinux: () => /Linux/i.test(navigator.userAgent),
  };

  // 供调试：在控制台查看 sidecar 是否可达
  window.__ccconfigDiag = () => {
    try {
      return call("__utools.getPath", ["home"]);
    } catch (e) {
      return String(e.message || e);
    }
  };
})();
