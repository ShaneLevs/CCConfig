// 自动网关 · 本地模型服务
// 把通用配置主数据中勾选的供应商+模型，通过本地 HTTP 服务（默认 http://127.0.0.1:17877）暴露给本机 agent：
//   POST /v1/messages        → Anthropic Messages 入站
//   POST /v1/chat/completions → OpenAI Chat Completions 入站
//   POST /v1/responses       → OpenAI Responses 入站
//   GET  /v1/models          → 启用模型列表
//   GET  /v1/codex/models    → 同一批模型，Codex 自己的 models.json 形状（供 model_catalog_url）
//   GET  /health             → 健康检查
// 两种模式：direct（勾选主数据模型，按模型 ID 直连）/ mapping（模型映射：自定义模型名 alias → 主数据模型，
//   /v1/models 只返回映射名，请求仅接受映射名；换上游模型只需改映射，agent 侧配置不动）
// 入站协议与目标供应商协议一致时原样透传（仅重写 model），否则经 autoroute-convert 自动转换（含流式 SSE）。
// 映射模式下响应里的 model 也改写成映射名（autoroute-convert/model-alias.js，配置 rewriteModel 可关）：
// agent 会把响应 model 记进自己的会话记录，不改的话各 agent 的使用统计里只看到上游真实模型名。
// 随机 key 校验 Authorization Bearer / x-api-key，防止本机其他进程滥用主数据里的真实供应商密钥。
// 生命周期：uTools 运行期间存活（preload 装载 + onPluginEnter 幂等自启动），uTools 退出即停止。

const db = require('./db')
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { StringDecoder } = require("string_decoder");
const { t } = require("./i18n");
const legacy = require("./legacy");
const { readCommonProviders } = require("./common");
const codexCatalog = require("./codex");
const { getSource } = require("./autoroute-convert/source");
const { getTarget } = require("./autoroute-convert/target");
const { pipeStream, collectBody } = require("./autoroute-convert/stream");
const { rewriteJsonModel, createSseModelRewriter } = require("./autoroute-convert/model-alias");
const { buildUpstreamUrl, buildUpstreamHeaders, errorBody, extractUpstreamErrorMessage, scanUsageFromText, retryAfterMs, isRetryableStatus, refusedOptionalFields, refusedBetaHeader } = require("./autoroute-convert/canonical");
const { createSseOutputTokenProbe, createOutputRateMeter } = require("./output-rate");

// 网关配置按「电脑 + 运行形态」隔离：网关是本机服务（开关/端口/key/模型勾选都只对本机有意义），
// 而同一台电脑上桌面版与 uTools 版可以同时运行、各自监听不同端口，所以文档 ID 在设备码之后再
// 追加 desktop / utools。旧版机器档与更早的共用档只作为升级种子：首次读取时继承一次，
// 之后两种运行形态各自独立演进；旧文档保留不删（另一形态可能还没迁移过）。
const LEGACY_DOC_ID = "ccconfig_autoroute_config";
const runtimeKey = () => (globalThis.__CCCONFIG_DESKTOP__ === true ? "desktop" : "utools");
const getDocId = () => `ccconfig_autoroute_config_${db.getNativeId()}_${runtimeKey()}`;
const getLegacyMachineDocId = () => `ccconfig_autoroute_config_${db.getNativeId()}`;

const DEFAULT_CONFIG = { enabled: false, port: 17877, key: "", selection: [], mode: "direct", mappings: [], mappingSeeded: false, rewriteModel: true };
const MAX_MAPPINGS = 10; // 模型映射上限：固定模型名写给 agent，换上游只需在此改映射
const MAX_MODELS_PER_MAPPING = 3; // 一个映射名最多关联 3 个模型：主用 + 最多两个备选/轮换
// 多模型调配策略：first 只用第一个；failover 按顺序失败切换；random 每次随机一个；round-robin 依次轮换
const MAPPING_STRATEGIES = ["first", "failover", "random", "round-robin"];
const DEFAULT_MAPPING_STRATEGY = "first";
// 模型映射预置映射名：首次使用映射模式自动建好这三行（目标留空，由用户在页面上选或删除）
const PRESET_ALIASES = ["flash", "plus", "pro"];
const SOURCE_OF_API = { "anthropic-messages": "anthropic", "openai-completions": "chat", "openai-responses": "responses" };

// 下发给 agent 的占位 key：网关不校验 key，但部分 agent（Codex / Claude）要求 apiKey / auth token 非空，
// 所以仍保留生成逻辑，仅用于 dispatch.js 写配置。
const generateKey = () => "sk-ccr-" + crypto.randomBytes(16).toString("hex");

// ==================== 配置（uTools DB，按电脑隔离） ====================

const sanitizeMappingTarget = (target) => ({
  provider: target && typeof target.provider === "string" ? target.provider : "",
  modelId: target && typeof target.modelId === "string" ? target.modelId : "",
});

// 清洗模式与映射列表：映射行允许不完整（前端空行是草稿，填写过程中实时保存），
// 仅丢弃非对象行；无效行在路由解析时（resolveOne）自动跳过，不影响网关运行。
// 旧版本映射行是顶层 { provider, modelId }（单模型）；读取时迁移成 models 数组，写回新结构。
const sanitizeConfig = (config) => {
  if (config.mode !== "direct" && config.mode !== "mapping") config.mode = "direct";
  if (!Array.isArray(config.mappings)) config.mappings = [];
  config.mappings = config.mappings
    .filter((m) => m && typeof m === "object")
    .slice(0, MAX_MAPPINGS)
    .map((m) => {
      let models = Array.isArray(m.models) ? m.models : [];
      // 旧配置/旧调用方只给顶层 provider + modelId：视为第一个模型
      if (models.length === 0 && (typeof m.provider === "string" || typeof m.modelId === "string")) {
        models = [{ provider: m.provider, modelId: m.modelId }];
      }
      models = models
        .filter((target) => target && typeof target === "object")
        .slice(0, MAX_MODELS_PER_MAPPING)
        .map(sanitizeMappingTarget);
      if (models.length === 0) models = [{ provider: "", modelId: "" }];
      return {
        alias: typeof m.alias === "string" ? m.alias.trim() : "",
        models,
        strategy: MAPPING_STRATEGIES.includes(m.strategy) ? m.strategy : DEFAULT_MAPPING_STRATEGY,
      };
    });
  config.mappingSeeded = config.mappingSeeded === true;
  // 映射模式把响应里的 model 改写成映射名（见 autoroute-convert/model-alias.js），默认开；
  // 只有显式关掉才停用，旧配置缺字段即视为开（用户要的正是「统计显示映射名」这个行为）
  config.rewriteModel = config.rewriteModel !== false;
  return config;
};

const persistConfig = (config) => {
  const docId = getDocId();
  const doc = db.get(docId);
  const payload = { _id: docId, data: config };
  if (doc && doc._rev) payload._rev = doc._rev;
  let res;
  try {
    res = db.put(payload);
  } catch (e) {
    throw new Error(t("serviceAgent.autoroute.saveConfigFailedWithMessage", { message: e.message || e }));
  }
  if (!res || !res.ok) {
    throw new Error(res && res.message
      ? t("serviceAgent.autoroute.saveConfigFailedReason", { message: res.message })
      : t("serviceAgent.autoroute.saveConfigFailed"));
  }
  return config;
};

const readAutoRouteConfig = () => {
  let data = {};
  let needsPersist = false;
  try {
    let doc = db.get(getDocId());
    if (!doc) {
      // 升级迁移：先继承旧机器档，再回退到更早的跨设备共用档；继承后立即写入本运行形态的文档
      doc = db.get(getLegacyMachineDocId()) || db.get(LEGACY_DOC_ID);
      needsPersist = !!doc;
    }
    if (doc && doc.data) data = doc.data;
  } catch (e) {
    /* ignore */
  }
  // 旧映射行（无 models 数组、只有顶层 provider + modelId）迁移一次并落库
  const rawMappings = Array.isArray(data.mappings) ? data.mappings : [];
  if (rawMappings.some((m) => m && typeof m === "object" && !Array.isArray(m.models)
    && (typeof m.provider === "string" || typeof m.modelId === "string"))) {
    needsPersist = true;
  }
  const config = sanitizeConfig({ ...DEFAULT_CONFIG, ...data });
  if (!Array.isArray(config.selection)) config.selection = [];
  if (typeof config.port !== "number" || config.port < 1 || config.port > 65535) config.port = DEFAULT_CONFIG.port;
  if (!config.key) config.key = generateKey(); // 旧配置补占位符，仅用于下发
  // 模型映射首次初始化：用户从未碰过映射（mappingSeeded 未置位）且当前没有任何映射时，
  // 预置 flash / plus / pro 三行（目标留空，由用户在页面选或删），并立刻落库，
  // 保证用户把三行删空后不会被反复回填。
  if (!config.mappingSeeded) {
    config.mappingSeeded = true;
    if (config.mappings.length === 0) {
      config.mappings = PRESET_ALIASES.map((alias) => ({
        alias,
        models: [{ provider: "", modelId: "" }],
        strategy: DEFAULT_MAPPING_STRATEGY,
      }));
    }
    needsPersist = true;
  }
  if (needsPersist) {
    try {
      persistConfig(config);
    } catch (e) {
      /* 读取路径的补种/迁移失败不阻塞：本次返回的 config 已完成清洗，下次读取会再试 */
    }
  }
  return config;
};

const writeAutoRouteConfig = (patch) =>
  persistConfig(sanitizeConfig({ ...readAutoRouteConfig(), ...patch, updatedAt: Date.now() }));

// ==================== 运行状态 ====================

const outputRateMeter = createOutputRateMeter();
const serverState = { server: null, port: 0, startedAt: 0, logs: [], logSeq: 0, activeStreams: 0, stats: emptyStats() };

const beginStreamRate = () => {
  serverState.activeStreams++;
};

const endStreamRate = () => {
  if (serverState.activeStreams > 0) serverState.activeStreams--;
  if (serverState.activeStreams === 0) outputRateMeter.reset();
};

// 本次运行统计（随网关重启清零）：仅统计已路由转发的模型调用（entry.target 非空），
// 模型未启用 / /v1/models 等控制面请求不计入。
function emptyStats() {
  return { requests: 0, successes: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0 };
}

// ==================== 历史统计（按天落库） ====================
// 与 agent 统计落库同思路，但网关是独立口径：经过网关的调用可能同时出现在某个 agent 的
// 本地日志里，不能并进「通用统计」求和。这里只存每日聚合计数，不存请求日志。
// 文档按「电脑 + 运行形态」隔离：桌面版与 uTools 版可以各跑一个网关（不同端口），
// 共用一份历史档会在并发写入时互相覆盖 _rev / 天数，因此再追加 desktop / utools。
// 旧机器档 ccconfig_autoroute_usage_<nativeId> 作为首次读取的种子。
const HISTORY_DOC_PREFIX = "ccconfig_autoroute_usage_";

let historyState = null; // { days, rev }
let historyDirty = false;

const getHistoryDocId = () => `${HISTORY_DOC_PREFIX}${db.getNativeId()}_${runtimeKey()}`;
const getLegacyHistoryDocId = () => `${HISTORY_DOC_PREFIX}${db.getNativeId()}`;

// 本地日期：页面上的「今日」按用户时区理解，不与 agent 统计的 UTC 日期混用
const localDateKey = (time) => {
  const d = new Date(typeof time === "number" ? time : Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const normalizeDay = (raw) => {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    requests: num(raw && raw.requests),
    successes: num(raw && raw.successes),
    promptTokens: num(raw && raw.promptTokens),
    cachedTokens: num(raw && raw.cachedTokens),
    outputTokens: num(raw && raw.outputTokens),
  };
};

const loadHistory = () => {
  if (historyState) return historyState;
  const days = {};
  let rev;
  try {
    const doc = db.get(getHistoryDocId()) || db.get(getLegacyHistoryDocId());
    if (doc && doc.days && typeof doc.days === "object") {
      for (const [date, raw] of Object.entries(doc.days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) days[date] = normalizeDay(raw);
      }
    }
    if (doc && doc._rev) rev = doc._rev;
  } catch (e) {
    console.error("[autoroute] 读取历史统计失败:", e.message || e);
  }
  historyState = { days, rev };
  return historyState;
};

const flushHistory = () => {
  if (!historyDirty) return;
  historyDirty = false;
  const state = loadHistory();
  const nativeId = db.getNativeId();
  const payload = { _id: getHistoryDocId(), nativeId, days: state.days, updatedAt: Date.now() };
  if (state.rev) payload._rev = state.rev;
  try {
    const res = db.put(payload);
    if (res && res.ok) {
      state.rev = res.rev || state.rev;
      return;
    }
    historyDirty = true;
    // 文档被别处改过时刷新 _rev，下一次请求完成时即可继续写；其他错误同样留给下一次
    if (res && res.name === "conflict") {
      try {
        const cur = db.get(getHistoryDocId());
        if (cur && cur._rev) state.rev = cur._rev;
      } catch (e) {
        /* ignore */
      }
    }
    console.error("[autoroute] 保存历史统计失败:", (res && res.message) || "unknown error");
  } catch (e) {
    historyDirty = true;
    console.error("[autoroute] 保存历史统计失败:", e.message || e);
  }
};

const recordHistoryStats = (time, success, promptTokens, cachedTokens, outputTokens) => {
  const state = loadHistory();
  const date = localDateKey(time);
  const day = state.days[date] || (state.days[date] = emptyStats());
  day.requests++;
  if (success) day.successes++;
  day.promptTokens += promptTokens;
  day.cachedTokens += cachedTokens;
  day.outputTokens += outputTokens;
  historyDirty = true;
  // 请求完成就落库：调用频率低（一次 API 调用一行），避免退出/崩溃时丢最后几条；
  // 桌面 sidecar 的 db.put 只改内存、磁盘写入由 shim 自己 debounce
  flushHistory();
};

const getHistorySummary = () => {
  const { days } = loadHistory();
  const todayKey = localDateKey(Date.now());
  const monthKey = todayKey.slice(0, 7);
  const total = emptyStats();
  const month = emptyStats();
  let since = "";
  const addDay = (target, day) => {
    target.requests += day.requests;
    target.successes += day.successes;
    target.promptTokens += day.promptTokens;
    target.cachedTokens += day.cachedTokens;
    target.outputTokens += day.outputTokens;
  };
  for (const [date, day] of Object.entries(days)) {
    addDay(total, day);
    if (date.startsWith(monthKey)) addDay(month, day);
    if (!since || date < since) since = date;
  }
  return {
    today: { ...emptyStats(), ...(days[todayKey] || {}) },
    // 本月同样按本地日期聚合，跨月第一天自然从 0 起
    month,
    total,
    since,
  };
};

// usage 语义归一：canonical / scanUsageFromText 输出的 inputTokens 一律是「未缓存输入」
// （缓存单列在 cacheReadTokens / cacheWriteTokens，与上游协议无关，见 canonical.normalizeUsage），
// 这里统一折成 promptTokens（含缓存）+ cachedTokens 记入网关统计与历史。
// 以前按 entry.target 分支处理，转换路径拿到的已经是归一值，anthropic 分支会再把缓存加一遍。
const recordStats = (entry) => {
  if (!entry || !entry.target || typeof entry.status !== "number") return;
  const u = entry.usage;
  const cached = (u && u.cacheReadTokens) || 0;
  const prompt = u ? (u.inputTokens || 0) + cached + (u.cacheWriteTokens || 0) : 0;
  const output = (u && u.outputTokens) || 0;
  const success = entry.status < 400;

  const s = serverState.stats;
  s.requests++;
  if (success) s.successes++;
  s.promptTokens += prompt;
  s.cachedTokens += cached;
  s.outputTokens += output;

  // 历史统计与会话统计同口径：请求 / 成功 / token 都记，响应没有 usage 时 token 部分记 0
  recordHistoryStats(entry.time, success, prompt, cached, output);
};

// 请求日志存内存，仅保留最近 10 条（新条目插头部；多了渲染/轮询拷贝会卡）。
// 解析出目标模型就插入一条 status=null 的「进行中」行，完成时原地补全状态/耗时/usage，
// 渲染端轮询即可看到「实时出现 → 流式期间 token 边涨 → 收尾」，不用等响应结束才有行。
const MAX_LOGS = 10;

const trimLogs = () => {
  if (serverState.logs.length > MAX_LOGS) serverState.logs.length = MAX_LOGS;
};

const pushLog = (entry) => {
  const log = { seq: ++serverState.logSeq, time: Date.now(), ...entry };
  serverState.logs.unshift(log);
  trimLogs();
  recordStats(log);
  return log;
};

const beginLog = (entry) => {
  const log = { seq: ++serverState.logSeq, time: Date.now(), status: null, ms: 0, ...entry };
  serverState.logs.unshift(log);
  trimLogs();
  return log;
};

const getAutoRouteStatus = () => ({
  running: !!serverState.server,
  port: serverState.server ? serverState.port : readAutoRouteConfig().port,
  baseUrl: serverState.server ? `http://127.0.0.1:${serverState.port}` : "",
  logs: [...serverState.logs],
  // outputTps 是最近一秒所有在途流式请求的聚合输出速率；流结束即归零，不属于历史统计。
  stats: {
    ...serverState.stats,
    outputTps: outputRateMeter.rate(),
    activeStreams: serverState.activeStreams,
  },
  // 历史统计（按本地日期聚合）：today 今日、month 本月、total 累积、since 最早一天。
  // 网关页与托盘共用「本次 / 今日 / 本月 / 累积」四个口径。
  history: getHistorySummary(),
});

// ==================== 模型解析 ====================

// 单个 { provider, modelId } → { provider, model }（过滤掉已被删除的供应商/模型）
const resolveProviderModel = (providers, sel) => {
  if (!sel || !sel.provider || !sel.modelId) return null;
  const provider = providers.find((p) => p.name === sel.provider);
  if (!provider) return null;
  const model = (provider.models || []).find((m) => m.id === sel.modelId);
  return model ? { provider, model } : null;
};

// mapping 模式：按映射行汇总为 [{ alias, strategy, models: [{ provider, model }] }]。
// 同名映射取靠前的完整行；没有任何有效模型的映射行直接跳过。
const resolveAutoRouteMappings = (config, providerList) => {
  const providers = providerList || readCommonProviders().providers;
  const list = [];
  for (const mapping of config.mappings || []) {
    const alias = typeof mapping.alias === "string" ? mapping.alias.trim() : "";
    if (!alias) continue;
    // 兼容未经 sanitizeConfig 的旧调用方：顶层 provider/modelId 视为唯一目标
    const targets = Array.isArray(mapping.models) && mapping.models.length
      ? mapping.models
      : (mapping.provider || mapping.modelId ? [mapping] : []);
    const models = [];
    for (const target of targets) {
      const entry = resolveProviderModel(providers, target);
      if (entry) models.push(entry);
    }
    if (models.length === 0) continue;
    const strategy = MAPPING_STRATEGIES.includes(mapping.strategy) ? mapping.strategy : DEFAULT_MAPPING_STRATEGY;
    list.push({ alias, strategy, models });
  }
  return list;
};

// selection → [{ provider, model, alias? }]（过滤掉已被删除的供应商/模型）
// direct 模式：返回勾选的模型；mapping 模式：展开每个映射的全部模型（供列表展示/下发，同名映射由调用方去重）
const resolveAutoRouteModels = (config, providerList) => {
  const providers = providerList || readCommonProviders().providers;
  const list = [];
  if (config.mode === "mapping") {
    for (const mapping of resolveAutoRouteMappings(config, providers)) {
      for (const entry of mapping.models) {
        list.push({ ...entry, alias: mapping.alias, strategy: mapping.strategy });
      }
    }
    return list;
  }
  for (const sel of config.selection || []) {
    const entry = resolveProviderModel(providers, sel);
    if (entry) list.push(entry);
  }
  return list;
};

// model 字段 → 网关目标。direct 模式：模型 ID 精确匹配（按勾选顺序取第一个），
// 兼容「供应商/模型ID」消歧；mapping 模式：仅匹配映射名（alias），返回整行多模型配置
const resolveRoute = (enabled, requested, config, mappingList) => {
  const name = typeof requested === "string" ? requested.trim() : "";
  if (!name) return null;
  if (config.mode === "mapping") {
    for (const mapping of mappingList || resolveAutoRouteMappings(config)) {
      if (mapping.alias === name) return mapping;
    }
    return null;
  }
  for (const entry of enabled) {
    if (entry.model.id === name) return entry;
  }
  for (const entry of enabled) {
    if (`${entry.provider.name}/${entry.model.id}` === name) return entry;
  }
  return null;
};

// 映射行的多模型调配：first 只用第一个；failover 返回整条顺序（请求时逐个尝试）；
// random 每次随机选一个；round-robin 用进程内游标依次轮换（网关重启后从头开始）。
// 游标按映射名保存，用户重排/增删模型后按新长度取模，不需要额外持久化。
const mappingRoundRobinCursors = new Map();
const selectMappingCandidates = (mapping) => {
  const models = mapping.models || [];
  if (!models.length) return [];
  switch (mapping.strategy) {
    case "failover":
      return models;
    case "random":
      return [models[Math.floor(Math.random() * models.length)]];
    case "round-robin": {
      const cursor = mappingRoundRobinCursors.get(mapping.alias) || 0;
      mappingRoundRobinCursors.set(mapping.alias, (cursor + 1) % models.length);
      return [models[cursor % models.length]];
    }
    default:
      return [models[0]];
  }
};

// 已启用模型 → 对外的模型 ID 列表（/v1/models 与 /v1/codex/models 共用，保证两边 ID 一致）：
// direct 模式仅多供应商重名的模型加「供应商/」前缀供消歧，其余返回裸模型 ID；
// mapping 模式返回映射名（alias），owned_by / description 标注实际指向的供应商
const listGatewayModels = (enabled, config) => {
  const counts = new Map();
  if (config.mode !== "mapping") {
    for (const { model } of enabled) counts.set(model.id, (counts.get(model.id) || 0) + 1);
  }
  const seen = new Set();
  const out = [];
  for (const { provider, model, alias } of enabled) {
    const id = config.mode === "mapping" ? alias : counts.get(model.id) > 1 ? `${provider.name}/${model.id}` : model.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, provider, model });
  }
  return out;
};

// Codex 读模型目录（model_catalog_url / model_catalog_json）最多 1 MiB，超了整份目录加载失败。
// 条目自带 Codex 提示词（十几 KB），所以只留装得下的那些，其余在响应头里报数量
const CODEX_CATALOG_MAX_BYTES = 1024 * 1024;

// ==================== HTTP 细节 ====================

// 客户端断开（agent 取消/超时）后不能再写响应：向已销毁的 socket 写会抛 ERR_STREAM_DESTROYED
const canWrite = (res) => !res.headersSent && !res.writableEnded && !res.destroyed;

const sendJson = (res, status, body) => {
  if (!canWrite(res)) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

// 错误响应：错误体按入站协议归一（type 跟着状态码走，agent SDK 据此决定是否重试），
// 上游给了 Retry-After 就带下去
const sendError = (res, sourceProtocol, status, message, headers) => {
  if (!canWrite(res)) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...(headers || {}) });
  res.end(JSON.stringify(errorBody(sourceProtocol, status, message)));
};

const detectProtocol = (path) => {
  if (path === "/messages" || path.endsWith("/v1/messages")) return "anthropic";
  if (path === "/chat/completions" || path.endsWith("/v1/chat/completions")) return "chat";
  if (path === "/responses" || path.endsWith("/v1/responses")) return "responses";
  return null;
};

// 等上游响应头的上限：兜住「请求已发出、上游卡死 / 连接半开」这种情况。
// 只覆盖响应头到达之前，不影响已开始的流式响应（长流可能长时间没有新分片）。
// 注意两种模式的语义不同：流式的响应头 = 首字节（TTFT）；非流式要等上游整段生成完才发响应头，
// 所以它约束的是整次生成耗时。目前统一 10 分钟，需要放宽非流式时在这里按 stream 拆开。
const UPSTREAM_HEADERS_TIMEOUT_MS = 10 * 60 * 1000;

const clientGoneError = () => {
  const err = new Error(t("serviceAgent.autoroute.clientDisconnected"));
  err.aborted = true;
  return err;
};

// 在途上游请求 / 响应全局登记：停网关时一并销毁。
// server.closeAllConnections() 只管入站连接，出站 socket 不归它管。
const pendingUpstreams = new Set();
let upstreamsStopping = false; // 停网关期间被主动断掉的上游：按「已中止」处理，不再重试

const untrackUpstream = (guard, up) => {
  if (guard) guard.pending.delete(up);
  pendingUpstreams.delete(up);
};

const trackUpstream = (guard, up) => {
  if (guard) guard.pending.add(up);
  pendingUpstreams.add(up);
  up.once("close", () => untrackUpstream(guard, up));
};

// 每个入站请求一个守卫：客户端断开时立刻销毁它名下所有在途上游（含只发出请求、还没收到响应头的）。
// 没有这条链路时，上游卡死 + 客户端取消 = 每条请求漏一个 socket，且网关停止也清不掉。
const createUpstreamGuard = (res) => {
  const guard = { gone: false, pending: new Set() };
  res.once("close", () => {
    if (res.writableFinished) return;
    guard.gone = true;
    for (const up of guard.pending) {
      try {
        up.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    guard.pending.clear();
  });
  return guard;
};

// POST JSON 到上游，返回 IncomingMessage。
// guard：本次入站请求的守卫（客户端断开即中止）；响应头超过 UPSTREAM_HEADERS_TIMEOUT_MS 未到即销毁请求。
const forwardUpstream = (url, headers, bodyObj, guard) =>
  new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error(t("serviceAgent.autoroute.invalidUpstreamUrl", { url })));
      return;
    }
    if (guard && guard.gone) {
      reject(clientGoneError());
      return;
    }
    const mod = u.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj));
    let settled = false;
    let headersTimer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (headersTimer) clearTimeout(headersTimer);
      fn(value);
    };
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "content-length": payload.length },
      },
      (res) => {
        if (settled) {
          // 已被守卫销毁或已超时：迟到的响应直接丢掉
          try {
            res.destroy();
          } catch (e) {
            /* ignore */
          }
          return;
        }
        untrackUpstream(guard, req);
        trackUpstream(guard, res);
        settle(resolve, res);
      }
    );
    trackUpstream(guard, req);
    req.on("error", (e) => settle(reject, e));
    // 没拿到响应就 close：守卫销毁（客户端断开 / 网关停止）只发 close 不发 error，按已中止处理；
    // 其他情况（上游干净地关了连接）当成普通失败，交给 sendUpstream 重试
    req.once("close", () => settle(reject, (guard && guard.gone) || upstreamsStopping
      ? clientGoneError()
      : new Error(t("serviceAgent.autoroute.upstreamRequestFailed"))));
    headersTimer = setTimeout(() => {
      const err = new Error(t("serviceAgent.autoroute.upstreamTimeout", { seconds: Math.round(UPSTREAM_HEADERS_TIMEOUT_MS / 1000) }));
      err.code = "UPSTREAM_TIMEOUT";
      req.destroy(err);
    }, UPSTREAM_HEADERS_TIMEOUT_MS);
    if (headersTimer.unref) headersTimer.unref();
    req.write(payload);
    req.end();
  });

// 上游拒收过的可选字段（「这家不收 stream_options」等）：进程内记住，后续请求直接去掉，
// 不必每次都先撞一次 400。仅内存，网关重启即清空。
const refusedFieldsByProvider = new Map();
const refusedKey = (provider) => `${provider.name}\u0000${provider.api}`;
const knownRefusedFields = (provider) => refusedFieldsByProvider.get(refusedKey(provider)) || null;
const rememberRefusedFields = (provider, fields) => {
  if (!fields || !fields.length) return;
  const key = refusedKey(provider);
  const set = refusedFieldsByProvider.get(key) || new Set();
  for (const f of fields) set.add(f);
  refusedFieldsByProvider.set(key, set);
};
const stripFields = (bodyObj, fields) => {
  if (!fields || !fields.size) return bodyObj;
  let out = null;
  for (const f of fields) {
    if (!(f in bodyObj)) continue;
    if (!out) out = { ...bodyObj };
    delete out[f];
  }
  return out || bodyObj;
};

// anthropic-beta / openai-beta 这类头也可能被上游拒收：同样记忆并去掉
const HEADER_FIELDS = ["anthropic-beta", "openai-beta"];
const stripHeaderFields = (headers, fields) => {
  if (!fields || !fields.size) return headers;
  let out = null;
  for (const f of HEADER_FIELDS) {
    if (!fields.has(f) || !(f in headers)) continue;
    if (!out) out = { ...headers };
    delete out[f];
  }
  return out || headers;
};

const REQUEST_ATTEMPTS = 3; // 首次 + 2 次重试
const RETRY_BASE_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 向上游发请求（带容错）：
//  1) 429 / 5xx / 过载 / 网络抖动 → 按上游 Retry-After（上限 15s）或指数退避重试，共 2 次
//  2) 400/422 且错误信息点名某个可选字段（stream_options / reasoning_effort / response_format …）
//     或点名 beta 头 → 去掉它（并记住这家不收）立即重试，而不是让整轮对话失败
// 成功：{ ok: true, upstreamRes, body }（响应体尚未读取，交给调用方消费）
// 失败：{ ok: false, status, text, error, headers }（错误体已读完，text 为空表示连接层失败）
const sendUpstream = async ({ url, headers, body, provider, guard }) => {
  const known = knownRefusedFields(provider);
  let payload = stripFields(body, known);
  let sendHeaders = stripHeaderFields(headers, known);
  let last = null;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const wait = last && last.immediate ? 0 : (last && last.wait) || RETRY_BASE_MS * 2 ** (attempt - 1);
      if (wait) await sleep(wait);
    }
    let upstreamRes;
    try {
      upstreamRes = await forwardUpstream(url, sendHeaders, payload, guard);
    } catch (e) {
      // 客户端已断开 / 上游响应头超时：重试没有意义（客户端不再等，超时重试只会再堵十分钟）
      if (e && (e.aborted || (guard && guard.gone))) {
        return { ok: false, status: 499, text: "", error: (e && e.message) || t("serviceAgent.autoroute.clientDisconnected"), headers: null };
      }
      if (e && e.code === "UPSTREAM_TIMEOUT") {
        return { ok: false, status: 504, text: "", error: (e && e.message) || t("serviceAgent.autoroute.upstreamRequestFailed"), headers: null };
      }
      last = { error: (e && e.message) || String(e), wait: 0 };
      continue;
    }
    const status = upstreamRes.statusCode || 502;
    if (status < 400) return { ok: true, upstreamRes, body: payload };
    const text = await collectBody(upstreamRes);
    const message = extractUpstreamErrorMessage(text, status);
    const dropped = [...refusedOptionalFields(status, message), ...refusedBetaHeader(status, message)];
    if (dropped.length) {
      const nextBody = stripFields(payload, new Set(dropped));
      const nextHeaders = stripHeaderFields(sendHeaders, new Set(dropped));
      if (nextBody !== payload || nextHeaders !== sendHeaders) {
        payload = nextBody;
        sendHeaders = nextHeaders;
        rememberRefusedFields(provider, dropped);
        last = { error: message, wait: 0, immediate: true };
        continue;
      }
    }
    if (isRetryableStatus(status) && attempt < REQUEST_ATTEMPTS - 1) {
      last = { error: message, wait: retryAfterMs(upstreamRes.headers) };
      continue;
    }
    return { ok: false, status, text, error: message, headers: upstreamRes.headers };
  }
  return { ok: false, status: 502, text: "", error: (last && last.error) || t("serviceAgent.autoroute.upstreamRequestFailed"), headers: null };
};

// ==================== 请求处理 ====================

const handleRequest = async (req, res) => {
  const started = Date.now();
  const guard = createUpstreamGuard(res); // 客户端断开 → 立刻中止这次请求的在途上游
  let logged = false;
  let targetApi = ""; // 出站协议，进入转发阶段才记录（供日志展示转换链路）
  let liveLog = null; // 进行中的日志行：解析出目标模型时创建，finish 原地补全
  const finish = (entry) => {
    if (logged) return;
    logged = true;
    const done = { status: entry.status, ms: Date.now() - started, target: targetApi, ...entry };
    // 客户端已经走了（上游被守卫中止）：对客户端来说这次调用就是 499，不计成功
    if (guard.gone) {
      done.status = 499;
      done.error = t("serviceAgent.autoroute.clientDisconnected");
    }
    if (liveLog) {
      Object.assign(liveLog, done);
      recordStats(liveLog);
    } else {
      pushLog(done);
    }
  };

  // 错误统一走这里：错误响应发给客户端，原因同时记入请求日志（error 字段供「最近请求」展示）
  const fail = (protocol, status, message, model = "", retryAfter) => {
    sendError(res, protocol, status, message, retryAfter ? { "retry-after": retryAfter } : undefined);
    finish({ protocol, model, status, error: message });
  };

  const path = (req.url || "").split("?")[0].replace(/\/+$/, "") || "/";
  const method = (req.method || "GET").toUpperCase();
  try {
    const config = readAutoRouteConfig();
    const sourceProtocol = detectProtocol(path);

    // 健康检查
    if (method === "GET" && (path === "/" || path === "/health")) {
      sendJson(res, 200, { status: "ok", service: "ccconfig-autoroute" });
      return;
    }

    // 不校验 key：网关只监听本机回环地址，供本机 agent 直接调用，任意 Authorization / x-api-key
    // 或完全不传都放行（config.key 仅作为下发给 agent 的占位符，见 dispatch.js）。

    if (method === "GET" && (path === "/v1/models" || path === "/models")) {
      const data = listGatewayModels(resolveAutoRouteModels(config), config).map(({ id, provider }) => ({
        id,
        object: "model",
        created: Math.floor((serverState.startedAt || Date.now()) / 1000),
        owned_by: provider.name,
      }));
      sendJson(res, 200, { object: "list", data });
      finish({ protocol: "models", model: "", status: 200 });
      return;
    }

    // Codex 的模型目录（Codex 自己的 models.json 结构）：配在 [model_providers.<id>] 的
    // model_catalog_url 上，Codex ≥ 0.161 直接拉取——用 API key 的 Codex 不会自己去 GET /v1/models，
    // 没有目录它选不到网关里的模型。与 /v1/models 共用 ID 解析，两边名字一致。
    if (method === "GET" && (path === "/v1/codex/models" || path === "/codex/models")) {
      const entries = listGatewayModels(resolveAutoRouteModels(config), config).map(({ id, provider, model }, i) =>
        codexCatalog.buildCatalogEntry(provider.name, id, i + 1, {
          name: model?.name,
          contextWindow: model?.contextWindow,
          input: model?.input,
        }),
      );
      if (!entries.length) {
        // Codex 会拒绝空目录；与本地目录开关同口径，宁可返回错误也不写入“成功但不可用”的引用。
        sendJson(res, 409, { error: { message: t("serviceAgent.codex.catalogEmpty"), type: "invalid_request_error" } });
        finish({ protocol: "models", model: "", status: 409 });
        return;
      }
      const models = [];
      let bytes = 2; // {"models":[]}
      let leftOut = 0;
      for (const entry of entries) {
        // 同一份系统提示词不必写两遍（model_messages 优先于 base_instructions），省一半体积
        const { base_instructions: _omit, ...entryWithoutBase } = entry;
        const raw = JSON.stringify(entryWithoutBase);
        const size = Buffer.byteLength(raw, "utf8") + 1;
        if (bytes + size > CODEX_CATALOG_MAX_BYTES) {
          leftOut++;
          continue;
        }
        bytes += size;
        models.push(entryWithoutBase);
      }
      if (leftOut) {
        res.setHeader("x-ccconfig-left-out", String(leftOut));
        // 改名前的旧头一并补发，避免外部脚本/日志解析失效
        res.setHeader(legacy.GATEWAY_LEFT_OUT_HEADER, String(leftOut));
      }
      sendJson(res, 200, { models });
      finish({ protocol: "models", model: "", status: 200 });
      return;
    }

    if (method !== "POST" || !sourceProtocol) {
      fail(sourceProtocol, 404, t("serviceAgent.autoroute.unknownEndpoint", { method, path }));
      return;
    }

    let body;
    try {
      body = JSON.parse(await collectBody(req));
    } catch (e) {
      fail(sourceProtocol, 400, t("serviceAgent.autoroute.invalidJsonBody"));
      return;
    }

    const providers = readCommonProviders().providers;
    const mappingList = config.mode === "mapping" ? resolveAutoRouteMappings(config, providers) : null;
    const enabled = resolveAutoRouteModels(config, providers);
    const route = resolveRoute(enabled, body.model, config, mappingList);
    if (!route) {
      const hint = config.mode === "mapping"
        ? t("serviceAgent.autoroute.modelNotMapped", { model: body.model || t("serviceAgent.common.emptyValue") })
        : t("serviceAgent.autoroute.modelNotEnabled", { model: body.model || t("serviceAgent.common.emptyValue") });
      fail(sourceProtocol, 404, hint, body.model || "");
      return;
    }
    // 映射模式下不同映射名可能指向同一底层模型，日志里一并记映射名（alias）才能区分是哪个映射
    const alias = config.mode === "mapping" ? route.alias || "" : "";
    // 响应 model 改写（映射模式默认开）：agent 会把响应里的 model 记进自己的会话记录，
    // 不改的话各 agent 的「使用统计」里永远显示上游真实模型名而不是映射名（见 model-alias.js）
    const displayModel = alias && config.rewriteModel !== false ? alias : "";
    // 映射模式按策略选出本次要尝试的模型序列（failover 为整条顺序，其余只有一个）；
    // 直连模式永远只有一个目标。已确定首个模型时先落一条进行中日志行，页面轮询立刻能看到。
    const candidates = config.mode === "mapping"
      ? selectMappingCandidates(route)
      : [{ provider: route.provider, model: route.model }];
    if (candidates.length === 0) {
      fail(sourceProtocol, 404, t("serviceAgent.autoroute.modelNotMapped", { model: body.model || "" }), body.model || "");
      return;
    }
    liveLog = beginLog({ protocol: sourceProtocol, model: candidates[0].model.id, ...(alias ? { alias } : {}) });

    // 单次上游尝试：成功时自行写响应并 finish；失败且尚未向客户端写任何字节时返回结构化错误，
    // 由下面的候选循环决定是否切换到下一个模型（映射 failover 策略）。
    const forwardAttempt = async ({ provider, model }) => {
      targetApi = provider.api;
      if (!getTarget(provider.api)) {
        return { done: false, status: 400, error: t("serviceAgent.autoroute.providerProtocolUnsupported", { name: provider.name, api: provider.api }), model: model.id };
      }
      const url = buildUpstreamUrl(provider.baseUrl, provider.api);
      if (!url) {
        return { done: false, status: 400, error: t("serviceAgent.autoroute.providerBaseUrlInvalid", { name: provider.name }), model: model.id };
      }

      const wantsStream = body.stream === true;
      const isPassthrough = SOURCE_OF_API[provider.api] === sourceProtocol;
      // 客户端协议头（anthropic-beta / openai-beta / anthropic-version / 可选 UA）透传给上游：
      // 1M 上下文、interleaved thinking 等 beta 特性都靠 anthropic-beta 点名，漏发等于特性失效
      const headers = buildUpstreamHeaders(provider, req.headers);

      if (isPassthrough) {
        // 同协议直通：仅重写 model，原样转发（保留图片、cache_control 等全部字段）
        const up = await sendUpstream({ url, headers, body: { ...body, model: model.id }, provider, guard });
        if (!up.ok) {
          return {
            done: false,
            status: up.status,
            error: up.error,
            model: model.id,
            retryAfter: up.headers && up.headers["retry-after"],
            rawText: up.text,
            rawHeaders: up.headers,
          };
        }
        const upstreamRes = up.upstreamRes;
        if (wantsStream) {
          // 客户端在等待上游的这段时间里已经断开：直接释放上游，别往销毁的 socket 写
          if (!canWrite(res)) {
            try {
              upstreamRes.destroy();
            } catch (e) {
              /* ignore */
            }
            finish({ protocol: sourceProtocol, model: model.id, status: 499, passthrough: true });
            return { done: true };
          }
          res.writeHead(200, { "content-type": upstreamRes.headers["content-type"] || "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
          // 旁路采集：扫原始 SSE 分片里的 usage 数值字段供统计（不影响转发的字节流）；
          // 流结束（end/close/error）才记日志，成功时 usage = 扫描到的各字段最大值
          const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
          const outputProbe = createSseOutputTokenProbe((tokens) => outputRateMeter.record(tokens));
          beginStreamRate();
          if (liveLog) liveLog.usage = usage; // 与旁路扫描共用同一对象 → 流式期间 token 数可见地累加
          let pending = "";
          let clientGone = false;
          // 映射模式：按行改写 SSE 里的 model（其余字节原样），改写器内部缓冲半行
          const sse = displayModel ? createSseModelRewriter(displayModel) : null;
          // 上游分片可能切在多字节字符中间：直接 chunk.toString() 会把中文 / emoji 变成 U+FFFD。
          // 以前这里只是旁路扫描（错一个字符不影响转发），现在改写路径要自己写出去，必须用
          // StringDecoder 把不完整的字节留到下一片拼回去。
          const decoder = new StringDecoder("utf8");
          let waitingDrain = false;
          const writeOut = (out) => {
            if (!out || clientGone || res.destroyed || res.writableEnded) return;
            // 客户端读得慢时回压：暂停上游，drain 后恢复（不这样做会无限堆在内存里）
            if (res.write(out) || waitingDrain) return;
            waitingDrain = true;
            upstreamRes.pause();
            res.once("drain", () => {
              waitingDrain = false;
              if (!upstreamRes.destroyed) upstreamRes.resume();
            });
          };
          const tapText = (text) => {
            if (!text) return;
            try {
              outputProbe.push(text);
              pending += text;
              const found = scanUsageFromText(pending);
              for (const k of Object.keys(usage)) if (found[k] > usage[k]) usage[k] = found[k];
              if (pending.length > 8192) pending = pending.slice(-2048); // 只留尾部，防数字被分片切开漏匹配；不截断长流内存
            } catch (e) {
              /* 统计旁路异常不影响转发 */
            }
            if (sse) writeOut(sse.push(text));
          };
          // 流关闭时只冲刷一次，避免 end + close 双触发同一残帧。
          let outputProbeFlushed = false;
          const flushOutputProbe = () => {
            if (outputProbeFlushed) return;
            outputProbeFlushed = true;
            outputProbe.flush();
          };
          const settle = (error) => {
            flushOutputProbe();
            endStreamRate();
            finish({
              protocol: sourceProtocol,
              model: model.id,
              status: clientGone ? 499 : error ? 502 : 200,
              passthrough: true,
              usage,
              ...(clientGone ? { error: t("serviceAgent.autoroute.clientDisconnected") } : error ? { error } : {}),
            });
          };
          // 客户端断开（Codex/Claude Code 取消）→ 立即中止上游，避免白烧 token
          res.once("close", () => {
            if (res.writableFinished) return;
            clientGone = true;
            try {
              upstreamRes.destroy();
            } catch (e) {
              /* ignore */
            }
            settle();
          });
          upstreamRes.on("data", (chunk) => tapText(decoder.write(chunk)));
          upstreamRes.once("end", () => {
            tapText(decoder.end());
            flushOutputProbe();
            // 改写路径要自己吐残行 + 收尾（原样透传由 pipe 负责 end）
            if (sse) {
              writeOut(sse.flush());
              if (!res.destroyed && !res.writableEnded) res.end();
            }
            settle();
          });
          upstreamRes.once("close", () => {
            // 上游没发 end 就断了（异常中断）：同样把响应收尾，否则客户端会挂到自己的超时
            if (sse && !res.destroyed && !res.writableEnded) {
              writeOut(sse.flush());
              res.end();
            }
            settle();
          });
          upstreamRes.once("error", (e) => {
            flushOutputProbe();
            if (sse && !res.destroyed && !res.writableEnded) {
              writeOut(sse.flush());
              res.end();
            }
            settle((e && e.message) || t("serviceAgent.autoroute.upstreamStreamInterrupted"));
          });
          if (!sse) upstreamRes.pipe(res);
          return { done: true };
        }
        const text = await collectBody(upstreamRes);
        const status = upstreamRes.statusCode || 502;
        // 原样转发上游错误体给客户端，同时把可读原因记入日志；响应体里抓 usage 供统计
        finish({
          protocol: sourceProtocol,
          model: model.id,
          status,
          passthrough: true,
          usage: scanUsageFromText(text),
          ...(status >= 400 ? { error: extractUpstreamErrorMessage(text, status) } : {}),
        });
        if (canWrite(res)) {
          res.writeHead(status, { "content-type": upstreamRes.headers["content-type"] || "application/json; charset=utf-8" });
          // 成功响应把 model 换成映射名（失败体不动：错误体里的模型名是上游的真实信息，方便排查）
          res.end(status < 400 ? rewriteJsonModel(text, displayModel) : text);
        }
        return { done: true };
      }

      // 跨协议转换
      const source = getSource(sourceProtocol);
      const target = getTarget(provider.api);
      const canonical = source.parseRequest(body, model.id);
      // 入站没给输出上限时，用主数据模型自己配的 maxTokens（Anthropic 必须带 max_tokens）
      canonical.fallbackMaxTokens = Number(model.maxTokens) || 0;
      const upstreamBody = target.buildRequest(canonical);
      const up = await sendUpstream({ url, headers, body: upstreamBody, provider, guard });
      if (!up.ok) {
        return {
          done: false,
          status: up.status,
          error: up.error,
          model: model.id,
          retryAfter: up.headers && up.headers["retry-after"],
        };
      }
      const upstreamRes = up.upstreamRes;

      if (wantsStream) {
        let clientGone = false;
        beginStreamRate();
        let usage = null;
        try {
          usage = await pipeStream({
            upstreamRes,
            target,
            source,
            res,
            onClientGone: () => (clientGone = true),
            onOutputTokens: (tokens) => outputRateMeter.record(tokens),
            modelOverride: displayModel,
          });
        } finally {
          endStreamRate();
        }
        finish({
          protocol: sourceProtocol,
          model: model.id,
          status: clientGone ? 499 : 200,
          converted: true,
          usage,
          ...(clientGone ? { error: t("serviceAgent.autoroute.clientDisconnected") } : {}),
        });
        return { done: true };
      }

      const text = await collectBody(upstreamRes);
      let upstreamJson;
      try {
        upstreamJson = JSON.parse(text);
      } catch (e) {
        return { done: false, status: 502, error: t("serviceAgent.autoroute.invalidUpstreamResponse"), model: model.id };
      }
      const canonicalRes = target.parseResponse(upstreamJson);
      const out = source.formatResponse(canonicalRes);
      // 映射模式：响应 model 换成映射名（三个入站协议的 formatResponse 都带顶层 model）
      if (displayModel && out && typeof out === "object") out.model = displayModel;
      sendJson(res, 200, out);
      finish({ protocol: sourceProtocol, model: model.id, status: 200, converted: true, usage: canonicalRes.usage });
      return { done: true };
    };

    let lastFailure = null;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (i > 0 && liveLog) {
        liveLog.model = candidate.model.id;
        liveLog.switches = i;
      }
      const result = await forwardAttempt(candidate);
      if (result.done) return;
      if (result.status === 499 || guard.gone) {
        fail(sourceProtocol, 499, result.error || t("serviceAgent.autoroute.clientDisconnected"), candidate.model.id);
        return;
      }
      lastFailure = result;
    }

    // 所有候选模型都失败：最后一条带原始错误体时按原样转发（agent SDK 认得上游错误格式），
    // 否则按入站协议生成错误响应。
    const failure = lastFailure || {
      status: 502,
      error: t("serviceAgent.autoroute.upstreamRequestFailed"),
      model: candidates[0].model.id,
    };
    if (failure.rawText && canWrite(res)) {
      const h = { "content-type": (failure.rawHeaders && failure.rawHeaders["content-type"]) || "application/json; charset=utf-8" };
      if (failure.retryAfter) h["retry-after"] = failure.retryAfter;
      res.writeHead(failure.status, h);
      res.end(failure.rawText);
      finish({ protocol: sourceProtocol, model: failure.model, status: failure.status, passthrough: true, error: failure.error });
    } else {
      fail(sourceProtocol, failure.status, failure.error, failure.model, failure.retryAfter);
    }
  } catch (e) {
    const message = (e && e.message) || String(e);
    try {
      sendError(res, detectProtocol(path), 500, t("serviceAgent.autoroute.internalError", { message }));
    } catch (e2) {
      /* ignore */
    }
    finish({ protocol: detectProtocol(path), model: "", status: 500, error: message });
  }
};

// ==================== 启停 ====================

// 更新 / 重装后旧进程可能还占着网关端口几秒：桌面 sidecar 靠 3s × 2 次的父进程探活退出，
// 新实例若在旧 sidecar 释放端口前启动，单次 bind 必然 EADDRINUSE。这里给足 9s 左右的重试窗口，
// 旧进程退出后自动接管，不需要用户手动「重启网关」。真正被其他程序长期占用时才会报错。
const BIND_RETRY_DELAYS = [300, 600, 1200, 1800, 2400, 3000];
const CANCELED = "ECANCELED";

let startPromise = null;
let startToken = 0;

const listenGatewayOnce = (config) => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      /* handleRequest 内部已兜底，此处防御未预期异常 */
      try {
        if (!res.headersSent) sendError(res, "anthropic", 500, t("serviceAgent.autoroute.internalErrorShort"));
      } catch (e) {
        /* ignore */
      }
    });
  });
  const onListenError = (e) => reject(e);
  server.once("error", onListenError);
  server.listen(config.port, "127.0.0.1", () => {
    // bind 阶段结束：后续 error 只记日志，不能再 reject（Promise 已结算）
    server.removeListener("error", onListenError);
    server.on("error", (e) => {
      console.error("[autoroute] 网关服务错误:", (e && e.message) || e);
      if (serverState.server === server) serverState.server = null;
    });
    serverState.server = server;
    serverState.port = config.port;
    serverState.startedAt = Date.now();
    upstreamsStopping = false;
    // 新一次运行：请求日志与本次统计从零开始（历史统计不重置）
    serverState.logs = [];
    serverState.stats = emptyStats();
    serverState.activeStreams = 0;
    outputRateMeter.reset();
    resolve(getAutoRouteStatus());
  });
});

const startAutoRoute = () => {
  if (serverState.server) return Promise.resolve(getAutoRouteStatus());
  if (startPromise) return startPromise;
  const config = readAutoRouteConfig();
  const token = ++startToken;
  startPromise = (async () => {
    for (let attempt = 0; ; attempt++) {
      if (token !== startToken) {
        const e = new Error("gateway start canceled");
        e.code = CANCELED;
        throw e;
      }
      try {
        return await listenGatewayOnce(config);
      } catch (e) {
        if (!e || e.code !== "EADDRINUSE") throw e;
        const delay = BIND_RETRY_DELAYS[attempt];
        if (delay === undefined) {
          throw new Error(t("serviceAgent.autoroute.portInUse", { port: config.port }));
        }
        console.error(`[autoroute] 端口 ${config.port} 暂被占用，${delay}ms 后重试（${attempt + 1}/${BIND_RETRY_DELAYS.length}）`);
        await sleep(delay);
      }
    }
  })().finally(() => { startPromise = null; });
  return startPromise;
};

const stopAutoRoute = () => {
  // 取消尚未完成的重试：可能在退避等待，也可能刚 bind 成功
  startToken += 1;
  if (startPromise) {
    const pending = startPromise;
    return pending.catch(() => {}).then(() => stopAutoRoute());
  }
  serverState.activeStreams = 0;
  outputRateMeter.reset();
  // 停止前把尚未落库的历史统计写掉，避免关网关/退出时丢最后几条
  try { flushHistory(); } catch (e) { console.error("[autoroute] 停止时保存历史统计失败:", e.message || e); }
  return new Promise((resolve) => {
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
    // 出站上游 socket 不归 server 管：停网关时一并断掉，避免挂起的请求继续占着连接
    upstreamsStopping = true;
    for (const up of pendingUpstreams) {
      try {
        up.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    pendingUpstreams.clear();
    server.close(() => resolve(getAutoRouteStatus()));
  });
};

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
  resolveAutoRouteModels,
  resolveAutoRouteMappings,
  startAutoRoute,
  stopAutoRoute,
  startAutoRouteIfEnabled,
  setAutoRouteEnabled,
  getAutoRouteStatus,
};
