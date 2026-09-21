// 自动网关 · 本地模型服务
// 把通用配置主数据中勾选的供应商+模型，通过本地 HTTP 服务（默认 http://127.0.0.1:17877）暴露给本机 agent：
//   POST /v1/messages        → Anthropic Messages 入站
//   POST /v1/chat/completions → OpenAI Chat Completions 入站
//   POST /v1/responses       → OpenAI Responses 入站
//   GET  /v1/models          → 启用模型列表
//   GET  /health             → 健康检查
// 入站协议与目标供应商协议一致时原样透传（仅重写 model），否则经 autoroute-convert 自动转换（含流式 SSE）。
// 随机 key 校验 Authorization Bearer / x-api-key，防止本机其他进程滥用主数据里的真实供应商密钥。
// 生命周期：uTools 运行期间存活（preload 装载 + onPluginEnter 幂等自启动），uTools 退出即停止。

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { readCommonProviders } = require("./common");
const { getSource } = require("./autoroute-convert/source");
const { getTarget } = require("./autoroute-convert/target");
const { pipeStream, collectBody } = require("./autoroute-convert/stream");
const { buildUpstreamUrl, buildUpstreamHeaders, errorBody, extractUpstreamErrorMessage } = require("./autoroute-convert/canonical");

// 网关配置按电脑隔离：uTools DB 跟随账号跨设备同步，而网关是本机服务（开关/端口/key/模型勾选
// 都只对本机有意义），文档 ID 追加设备码区分（同「Env 额外字段」ccswitch_overridden_env_<nativeId> 先例）。
// 旧版共用文档 ccswitch_autoroute_config 作为升级回退：机器首次读取尚无本机文档时继承旧配置作为起点，
// 之后各自独立演进；旧文档保留不删（其他机器可能还没迁移过）。
const LEGACY_DOC_ID = "ccswitch_autoroute_config";
const getDocId = () => `ccswitch_autoroute_config_${window.utools.getNativeId()}`;

const DEFAULT_CONFIG = { enabled: false, port: 17877, key: "", selection: [] };
const SOURCE_OF_API = { "anthropic-messages": "anthropic", "openai-completions": "chat", "openai-responses": "responses" };

const generateKey = () => "sk-ccr-" + crypto.randomBytes(16).toString("hex");

// ==================== 配置（uTools DB，按电脑隔离） ====================

const readAutoRouteConfig = () => {
  let data = {};
  try {
    const doc = window.utools.db.get(getDocId()) || window.utools.db.get(LEGACY_DOC_ID);
    if (doc && doc.data) data = doc.data;
  } catch (e) {
    /* ignore */
  }
  const config = { ...DEFAULT_CONFIG, ...data };
  if (!Array.isArray(config.selection)) config.selection = [];
  if (typeof config.port !== "number" || config.port < 1 || config.port > 65535) config.port = DEFAULT_CONFIG.port;
  if (!config.key) config.key = generateKey();
  return config;
};

const writeAutoRouteConfig = (patch) => {
  const config = { ...readAutoRouteConfig(), ...patch, updatedAt: Date.now() };
  const docId = getDocId();
  const doc = window.utools.db.get(docId);
  const payload = { _id: docId, data: config };
  if (doc && doc._rev) payload._rev = doc._rev;
  let res;
  try {
    res = window.utools.db.put(payload);
  } catch (e) {
    throw new Error("保存自动网关配置失败: " + (e.message || e));
  }
  if (!res || !res.ok) throw new Error("保存自动网关配置失败" + (res && res.message ? `：${res.message}` : ""));
  return config;
};

const regenerateAutoRouteKey = () => writeAutoRouteConfig({ key: generateKey() }).key;

// ==================== 运行状态 ====================

const serverState = { server: null, port: 0, startedAt: 0, logs: [] };

const pushLog = (entry) => {
  serverState.logs.unshift({ time: Date.now(), ...entry });
  if (serverState.logs.length > 50) serverState.logs.length = 50;
};

const getAutoRouteStatus = () => ({
  running: !!serverState.server,
  port: serverState.server ? serverState.port : readAutoRouteConfig().port,
  baseUrl: serverState.server ? `http://127.0.0.1:${serverState.port}` : "",
  logs: [...serverState.logs],
});

// ==================== 模型解析 ====================

// selection → [{ provider, model }]（过滤掉已被删除的供应商/模型）
const resolveAutoRouteModels = (config) => {
  const providers = readCommonProviders().providers;
  const list = [];
  for (const sel of config.selection || []) {
    if (!sel || !sel.provider || !sel.modelId) continue;
    const provider = providers.find((p) => p.name === sel.provider);
    if (!provider) continue;
    const model = (provider.models || []).find((m) => m.id === sel.modelId);
    if (model) list.push({ provider, model });
  }
  return list;
};

// model 字段 → 网关目标：模型 ID 精确匹配（按勾选顺序取第一个），兼容「供应商/模型ID」消歧
const resolveRoute = (enabled, requested) => {
  const name = typeof requested === "string" ? requested.trim() : "";
  if (!name) return null;
  for (const entry of enabled) {
    if (entry.model.id === name) return entry;
  }
  for (const entry of enabled) {
    if (`${entry.provider.name}/${entry.model.id}` === name) return entry;
  }
  return null;
};

// ==================== HTTP 细节 ====================

const sendJson = (res, status, body) => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const sendError = (res, sourceProtocol, status, message) => sendJson(res, status, errorBody(sourceProtocol, status, message));

const extractKey = (req) => {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  return "";
};

const detectProtocol = (path) => {
  if (path === "/messages" || path.endsWith("/v1/messages")) return "anthropic";
  if (path === "/chat/completions" || path.endsWith("/v1/chat/completions")) return "chat";
  if (path === "/responses" || path.endsWith("/v1/responses")) return "responses";
  return null;
};

// POST JSON 到上游，返回 IncomingMessage
const forwardUpstream = (url, headers, bodyObj) =>
  new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error(`无效的上游地址: ${url}`));
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "content-length": payload.length },
      },
      (res) => resolve(res)
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

// ==================== 请求处理 ====================

const handleRequest = async (req, res) => {
  const started = Date.now();
  let logged = false;
  let targetApi = ""; // 出站协议，进入转发阶段才记录（供日志展示转换链路）
  const finish = (entry) => {
    if (logged) return;
    logged = true;
    pushLog({ status: entry.status, ms: Date.now() - started, target: targetApi, ...entry });
  };

  // 错误统一走这里：错误响应发给客户端，原因同时记入请求日志（error 字段供「最近请求」展示）
  const fail = (protocol, status, message, model = "") => {
    sendError(res, protocol, status, message);
    finish({ protocol, model, status, error: message });
  };

  const path = (req.url || "").split("?")[0].replace(/\/+$/, "") || "/";
  const method = (req.method || "GET").toUpperCase();
  try {
    const config = readAutoRouteConfig();
    const sourceProtocol = detectProtocol(path);

    // 健康检查无需鉴权
    if (method === "GET" && (path === "/" || path === "/health")) {
      sendJson(res, 200, { status: "ok", service: "ccswitch-autoroute" });
      return;
    }

    const key = extractKey(req);
    if (!config.key || key !== config.key) {
      fail(sourceProtocol, 401, "无效的 API Key（请在 CCConfig 自动网关页复制正确的 key）");
      return;
    }

    if (method === "GET" && (path === "/v1/models" || path === "/models")) {
      const enabled = resolveAutoRouteModels(config);
      // 仅多供应商重名的模型加「provider/」前缀供消歧，其余返回裸模型 ID
      const counts = new Map();
      for (const { model } of enabled) counts.set(model.id, (counts.get(model.id) || 0) + 1);
      const seen = new Set();
      const data = [];
      for (const { provider, model } of enabled) {
        const id = counts.get(model.id) > 1 ? `${provider.name}/${model.id}` : model.id;
        if (seen.has(id)) continue;
        seen.add(id);
        data.push({ id, object: "model", created: Math.floor((serverState.startedAt || Date.now()) / 1000), owned_by: provider.name });
      }
      sendJson(res, 200, { object: "list", data });
      finish({ protocol: "models", model: "", status: 200 });
      return;
    }

    if (method !== "POST" || !sourceProtocol) {
      fail(sourceProtocol, 404, `未知端点: ${method} ${path}`);
      return;
    }

    let body;
    try {
      body = JSON.parse(await collectBody(req));
    } catch (e) {
      fail(sourceProtocol, 400, "请求体不是有效的 JSON");
      return;
    }

    const enabled = resolveAutoRouteModels(config);
    const route = resolveRoute(enabled, body.model);
    if (!route) {
      fail(sourceProtocol, 404, `模型 ${body.model || "(空)"} 未在自动网关中启用，请到 CCConfig 通用配置勾选或用「供应商/模型ID」消歧`, body.model || "");
      return;
    }
    const { provider, model } = route;

    if (!getTarget(provider.api)) {
      fail(sourceProtocol, 400, `供应商「${provider.name}」的协议 ${provider.api} 暂不支持自动网关`, model.id);
      return;
    }
    const url = buildUpstreamUrl(provider.baseUrl, provider.api);
    if (!url) {
      fail(sourceProtocol, 400, `供应商「${provider.name}」的 baseUrl 无效`, model.id);
      return;
    }

    const wantsStream = body.stream === true;
    const isPassthrough = SOURCE_OF_API[provider.api] === sourceProtocol;
    const headers = buildUpstreamHeaders(provider);
    targetApi = provider.api;

    if (isPassthrough) {
      // 同协议直通：仅重写 model，原样转发（保留图片、cache_control 等全部字段）
      const upstreamRes = await forwardUpstream(url, headers, { ...body, model: model.id });
      if (wantsStream) {
        // 流式直通时上游非 200，错误体不是事件流，转成源协议错误响应（此前会误按 200 原样转发）
        if (upstreamRes.statusCode !== 200) {
          const text = await collectBody(upstreamRes);
          fail(sourceProtocol, upstreamRes.statusCode || 502, extractUpstreamErrorMessage(text, upstreamRes.statusCode), model.id);
          return;
        }
        finish({ protocol: sourceProtocol, model: model.id, status: 200, passthrough: true });
        res.writeHead(200, { "content-type": upstreamRes.headers["content-type"] || "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
        upstreamRes.pipe(res);
        return;
      }
      const text = await collectBody(upstreamRes);
      const status = upstreamRes.statusCode || 502;
      // 原样转发上游错误体给客户端，同时把可读原因记入日志
      finish({
        protocol: sourceProtocol,
        model: model.id,
        status,
        passthrough: true,
        ...(status >= 400 ? { error: extractUpstreamErrorMessage(text, status) } : {}),
      });
      res.writeHead(status, { "content-type": upstreamRes.headers["content-type"] || "application/json; charset=utf-8" });
      res.end(text);
      return;
    }

    // 跨协议转换
    const source = getSource(sourceProtocol);
    const target = getTarget(provider.api);
    const canonical = source.parseRequest(body, model.id);
    const upstreamBody = target.buildRequest(canonical);
    const upstreamRes = await forwardUpstream(url, headers, upstreamBody);

    if (wantsStream) {
      if (upstreamRes.statusCode !== 200) {
        const text = await collectBody(upstreamRes);
        fail(sourceProtocol, upstreamRes.statusCode || 502, extractUpstreamErrorMessage(text, upstreamRes.statusCode), model.id);
        return;
      }
      finish({ protocol: sourceProtocol, model: model.id, status: 200, converted: true });
      await pipeStream({ upstreamRes, target, source, res });
      return;
    }

    const text = await collectBody(upstreamRes);
    if (upstreamRes.statusCode !== 200) {
      fail(sourceProtocol, upstreamRes.statusCode || 502, extractUpstreamErrorMessage(text, upstreamRes.statusCode), model.id);
      return;
    }
    let upstreamJson;
    try {
      upstreamJson = JSON.parse(text);
    } catch (e) {
      fail(sourceProtocol, 502, "上游返回了无法解析的响应", model.id);
      return;
    }
    const out = source.formatResponse(target.parseResponse(upstreamJson));
    sendJson(res, 200, out);
    finish({ protocol: sourceProtocol, model: model.id, status: 200, converted: true });
  } catch (e) {
    const message = (e && e.message) || String(e);
    try {
      sendError(res, detectProtocol(path), 500, `网关内部错误: ${message}`);
    } catch (e2) {
      /* ignore */
    }
    finish({ protocol: detectProtocol(path), model: "", status: 500, error: message });
  }
};

// ==================== 启停 ====================

const startAutoRoute = () => {
  if (serverState.server) return Promise.resolve(getAutoRouteStatus());
  const config = readAutoRouteConfig();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch(() => {
        /* handleRequest 内部已兜底，此处防御未预期异常 */
        try {
          if (!res.headersSent) sendError(res, "anthropic", 500, "网关内部错误");
        } catch (e) {
          /* ignore */
        }
      });
    });
    server.once("error", (e) => {
      serverState.server = null;
      reject(new Error(e && e.code === "EADDRINUSE" ? `端口 ${config.port} 已被占用，请更换端口` : (e && e.message) || String(e)));
    });
    server.listen(config.port, "127.0.0.1", () => {
      serverState.server = server;
      serverState.port = config.port;
      serverState.startedAt = Date.now();
      resolve(getAutoRouteStatus());
    });
  });
};

const stopAutoRoute = () =>
  new Promise((resolve) => {
    const server = serverState.server;
    if (!server) {
      resolve(getAutoRouteStatus());
      return;
    }
    serverState.server = null;
    try {
      server.closeAllConnections();
    } catch (e) {
      /* node 版本兜底 */
    }
    server.close(() => resolve(getAutoRouteStatus()));
  });

// 生命周期自愈：装载/进入插件时 enabled=true 则幂等拉起
const startAutoRouteIfEnabled = () => {
  try {
    if (readAutoRouteConfig().enabled) {
      startAutoRoute().catch((e) => console.error("[autoroute] 自启动失败:", e.message || e));
    }
  } catch (e) {
    console.error("[autoroute] 读取配置失败:", e.message || e);
  }
};

// 切换开关：enabled=true 拉起服务，false 停止；失败时回写 enabled=false
const setAutoRouteEnabled = async (enabled) => {
  writeAutoRouteConfig({ enabled });
  if (enabled) {
    try {
      await startAutoRoute();
    } catch (e) {
      writeAutoRouteConfig({ enabled: false });
      throw e;
    }
  } else {
    await stopAutoRoute();
  }
  return getAutoRouteStatus();
};

module.exports = {
  readAutoRouteConfig,
  writeAutoRouteConfig,
  regenerateAutoRouteKey,
  resolveAutoRouteModels,
  startAutoRoute,
  stopAutoRoute,
  startAutoRouteIfEnabled,
  setAutoRouteEnabled,
  getAutoRouteStatus,
};
