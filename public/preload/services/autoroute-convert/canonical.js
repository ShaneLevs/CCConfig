// 自动网关 · 协议转换层 —— 标准中间格式（canonical）与公共工具
// 星型转换：入站协议(source 适配器) → canonical → 出站协议(target 适配器)，响应原路反向。
// canonical 请求采用 OpenAI Responses 风格：
//   {
//     model,                       // 目标模型 ID（已解析）
//     instructions,                // 系统提示（对应 anthropic system / openai system / responses instructions）
//     input: [{ role, content: [block] }],
//     tools: [{ name, description, inputSchema }],
//     toolChoice,                  // "auto" | "any" | "none" | { name }
//     maxTokens, fallbackMaxTokens,// 请求的输出上限；fallbackMaxTokens 来自主数据模型的 maxTokens
//     temperature, topP, stop, stream,
//     reasoning,                   // null | { effort?, maxTokens? }（Anthropic 用 budget_tokens，OpenAI 系用档位，两侧互折）
//     format,                      // null | { type: "json_object" | "json_schema", name?, description?, schema?, strict? }
//   }
// block 类型：
//   { type: "text", text }
//   { type: "tool_use", id, name, arguments }          // arguments 为 JSON 字符串（流式增量天然是字符串）
//   { type: "tool_result", callId, content, isError, images? }  // content 为字符串，images 为媒体块数组
//   { type: "reasoning", text?, signature?, encrypted? }
//   { type: "media", kind: "image" | "file", mediaType, data? | url?, name? }
// canonical 响应：
//   { id, model, text, reasoning: [...], toolCalls: [{ id, name, arguments }], stopReason, usage }
// usage：{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }（normalizeUsage 归一名协议字段），
// 三个方向的 usage 必须完整：上游→canonical（target.readStream/parseResponse）、
// canonical→入站响应（source.formatResponse / 各 FrameWriter，含 cache 字段）、网关统计（recordStats）
// 都依赖它；任何一段丢掉 inputTokens / cache* 都会让日志行、「最近请求」与会话统计里的 token 归零。
// stopReason ∈ "stop" | "length" | "tool"
// 流式以 canonical 事件流为中心：
//   start / text_delta / reasoning_delta / reasoning_signature / tool_start / tool_delta / end / error
// 媒体：目标协议载不了时降级成 [attachment …] 文本占位（绝不静默丢弃，模型至少知道有东西被略过）；
// 同协议直通不受影响（不走 canonical，字节级转发）。

const crypto = require("crypto");

const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ==================== 文本 ====================

// Claude Code 的 ToolSearch 用 tool_reference 块回答「加载了哪些工具」。
// 只发了名字，没有结果内容：转成一句话告诉模型这些工具现在可以调，而不是当成空结果吞掉。
const toolLoadedText = (name) => `Tool ${name} is loaded and can be called now.`;

// content 可能是 string 或 block 数组，抽出全部文本（含 tool_reference 的说明）
const textFromContent = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (typeof b === "string") {
      parts.push(b);
      continue;
    }
    if (!b || typeof b !== "object") continue;
    if (typeof b.text === "string") parts.push(b.text);
    else if (b.type === "tool_reference" && typeof b.tool_name === "string" && b.tool_name) {
      if (parts.length) parts.push("\n");
      parts.push(toolLoadedText(b.tool_name));
    }
  }
  return parts.join("").trim();
};

// ==================== 媒体块（图片 / 文档） ====================

// canonical 媒体块：{ type: "media", kind: "image" | "file", mediaType, data? | url?, name? }
const mediaBlock = (kind, mediaType, extra = {}) => {
  const k = kind === "file" ? "file" : "image";
  const block = { type: "media", kind: k, mediaType: String(mediaType || (k === "image" ? "image/png" : "application/octet-stream")) };
  if (extra && extra.data) block.data = String(extra.data);
  else if (extra && extra.url) block.url = String(extra.url);
  if (extra && extra.name) block.name = String(extra.name);
  return block.data || block.url ? block : null;
};

const DATA_URL_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;
const parseDataUrl = (url) => {
  const m = typeof url === "string" ? DATA_URL_RE.exec(url) : null;
  if (!m) return null;
  const mediaType = m[1] || "application/octet-stream";
  if (m[2]) return { mediaType, data: m[3] };
  try {
    return { mediaType, data: Buffer.from(decodeURIComponent(m[3]), "utf8").toString("base64") };
  } catch (e) {
    return { mediaType, data: m[3] };
  }
};

const toDataUrl = (mediaType, data) => `data:${mediaType || "application/octet-stream"};base64,${data || ""}`;

// 目标协议载不了的媒体降级成文本占位
const attachmentText = (block) => {
  const kind = block && block.kind === "file" ? "file" : "image";
  const mediaType = (block && block.mediaType) || "application/octet-stream";
  return block && block.url ? `[attachment ${kind} ${mediaType}: ${block.url}]` : `[attachment ${kind} ${mediaType}]`;
};

// ==================== 推理强度 ⇄ thinking budget ====================

// 各协议表达推理的方式不同：Anthropic 用 thinking.budget_tokens（数值），
// OpenAI 系用 reasoning_effort / reasoning.effort（档位）。canonical.reasoning 统一记
// { effort?, maxTokens? }，两侧互折，避免跨协议时把用户的推理设置悄悄丢掉。
const EFFORT_BUDGET_PAIRS = [
  ["low", 4096],
  ["medium", 10000],
  ["high", 24000],
  ["xhigh", 32000],
];

// 档位归一：minimal / none → low（部分厂商没有"关"），ultra → max
const normalizeEffort = (e) => {
  const s = String(e || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "minimal" || s === "none") return "low";
  if (s === "ultra") return "max";
  if (s === "low" || s === "medium" || s === "high" || s === "xhigh" || s === "max") return s;
  return "";
};

// OpenAI 系只认 minimal/low/medium/high；xhigh 与 max 都按 high 发
const openAiEffort = (e) => {
  const s = normalizeEffort(e);
  if (s === "xhigh" || s === "max") return "high";
  return s;
};

const budgetOfEffort = (e) => {
  const s = normalizeEffort(e);
  if (s === "max") return 32000;
  for (const [name, budget] of EFFORT_BUDGET_PAIRS) if (name === s) return budget;
  return 0;
};

const effortOfBudget = (n) => {
  const v = Number(n) || 0;
  if (v <= 0) return "";
  if (v <= 4096) return "low";
  if (v <= 10000) return "medium";
  if (v <= 24000) return "high";
  return "xhigh";
};

// canonical.reasoning → { effort, budget }，两个来源（档位 / budget）互相补全
const resolveReasoning = (reasoning) => {
  if (!reasoning || typeof reasoning !== "object") return { effort: "", budget: 0 };
  const budget = Number(reasoning.maxTokens) || 0;
  const effort = normalizeEffort(reasoning.effort) || effortOfBudget(budget);
  return { effort, budget: budget || budgetOfEffort(effort) };
};

// ==================== 结构化输出（response_format / text.format / output_config.format） ====================

// 三种入站写法归一成 { type, name, description, schema, strict }：
//   chat        { type: "json_schema", json_schema: { name, schema, strict } } / { type: "json_object" }
//   responses   { type: "json_schema", name, schema, strict }（在 body.text.format 里）
//   anthropic   { type: "json_schema", schema }（在 body.output_config.format 里）
const normalizeFormat = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "json_object") return { type: "json_object" };
  if (raw.type !== "json_schema") return null;
  const src = isPlainObject(raw.json_schema) ? raw.json_schema : raw;
  const schema = src.schema;
  if (!isPlainObject(schema) && !Array.isArray(schema)) return { type: "json_object" };
  return {
    type: "json_schema",
    name: typeof src.name === "string" && src.name ? src.name : "response",
    description: typeof src.description === "string" ? src.description : "",
    schema,
    strict: typeof src.strict === "boolean" ? src.strict : undefined,
  };
};

const formatToChat = (f) => {
  if (!f) return null;
  if (f.type !== "json_schema") return { type: "json_object" };
  const jsonSchema = { name: f.name || "response", schema: f.schema };
  if (f.description) jsonSchema.description = f.description;
  if (typeof f.strict === "boolean") jsonSchema.strict = f.strict;
  return { type: "json_schema", json_schema: jsonSchema };
};

const formatToResponses = (f) => {
  if (!f) return null;
  if (f.type !== "json_schema") return { type: "json_object" };
  const out = { type: "json_schema", name: f.name || "response", schema: f.schema };
  if (f.description) out.description = f.description;
  if (typeof f.strict === "boolean") out.strict = f.strict;
  return out;
};

// 目标协议没法被要求结构化输出时，把要求写进系统提示（Anthropic Messages / 各种中转）
const formatInstruction = (f) => {
  if (!f) return "";
  if (f.type !== "json_schema") return "Respond with a single valid JSON object and nothing else.";
  const desc = f.description ? ` (${f.description})` : "";
  return `Respond with a single valid JSON object${desc} that matches this JSON Schema, and nothing else:\n${JSON.stringify(f.schema)}`;
};

// ==================== 工具定义与 schema 修补 ====================

// 入站 tool 定义归一：四种写法（Chat 嵌套 / Responses 扁平 / Anthropic input_schema / MCP inputSchema）
const normalizeTool = (t) => {
  if (!t || typeof t !== "object") return null;
  const fn = isPlainObject(t.function) ? t.function : t;
  const name = fn.name || t.name;
  if (typeof name !== "string" || !name) return null;
  const schema = fn.parameters || fn.input_schema || fn.inputSchema || t.parameters || t.input_schema || t.inputSchema;
  return {
    name,
    description: typeof (fn.description || t.description) === "string" ? fn.description || t.description : "",
    inputSchema: isPlainObject(schema) ? schema : { type: "object", properties: {} },
  };
};

const inferTypeOf = (values) => {
  const kinds = new Set();
  for (const v of values) {
    if (v === null) kinds.add("null");
    else if (Array.isArray(v)) kinds.add("array");
    else if (typeof v === "number") kinds.add(Number.isInteger(v) ? "integer" : "number");
    else if (typeof v === "boolean") kinds.add("boolean");
    else if (typeof v === "string") kinds.add("string");
    else if (typeof v === "object") kinds.add("object");
  }
  const list = [...kinds];
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  // integer + number → number；其余多种类型用类型数组（JSON Schema 允许）
  if (list.every((k) => k === "integer" || k === "number")) return "number";
  return list;
};

// 厂商挑剔的 JSON Schema 修补（就地深拷贝后改，不改调用方的对象）：
//  1) 只有 enum / const 没有 type —— Moonshot/Kimi 的 "flavored json schema" 直接 400
//  2) oneOf → anyOf —— xgrammar 类语法编译器（OpenRouter 等中转）拒 oneOf 但收 anyOf
// 只作用于工具的入参 schema；两者都不改变模型「该调什么」，只是让请求能被收下。
const sanitizeSchema = (schema) => {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  let cloned;
  try {
    cloned = JSON.parse(JSON.stringify(schema));
  } catch (e) {
    return schema;
  }
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (!node.type) {
      if (Array.isArray(node.enum) && node.enum.length) {
        const t = inferTypeOf(node.enum);
        if (t) node.type = t;
      } else if (node.const !== undefined) {
        const t = inferTypeOf([node.const]);
        if (t) node.type = t;
      }
    }
    if (Array.isArray(node.oneOf)) {
      const branches = node.oneOf;
      delete node.oneOf;
      node.anyOf = Array.isArray(node.anyOf) ? [...branches, ...node.anyOf] : branches;
    }
    for (const key of Object.keys(node)) {
      if (key === "enum" || key === "const" || key === "default" || key === "examples") continue;
      walk(node[key]);
    }
  };
  walk(cloned);
  return cloned;
};

// ==================== 出站 URL 与请求头 ====================

// 各出站协议的标准请求路径
const PROTOCOL_PATHS = {
  "anthropic-messages": "/v1/messages",
  "openai-completions": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
};

// baseUrl 可能自带路径前缀（如 https://api.x.com/v1）；以 /v1 结尾时去掉协议路径里的 /v1 前缀，避免 /v1/v1/
const buildUpstreamUrl = (baseUrl, api) => {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const path = PROTOCOL_PATHS[api];
  if (!base || !path) return null;
  return /\/v1$/i.test(base) ? base + path.slice(3) : base + path;
};

// 客户端 → 上游需要透传的协议头：
//  anthropic-beta   1M 上下文、interleaved thinking、tool search 等 beta 特性由它点名，漏发等于特性失效
//  anthropic-version 客户端认的版本，跟随客户端
//  openai-beta      OpenAI 系的 beta 开关
// 只往同协议的上游发（anthropic-beta 发给 OpenAI 兼容端点无意义）；
// UA 是否透传由供应商的 passUserAgent 决定（部分中转站按 UA 判定 Claude Code）
const CLIENT_BETA_HEADERS = ["anthropic-beta", "anthropic-version", "openai-beta"];

const pickClientHeaders = (clientHeaders, provider) => {
  const out = {};
  const src = clientHeaders || {};
  const api = provider && provider.api;
  const keys = api === "anthropic-messages" ? ["anthropic-beta", "anthropic-version"] : ["openai-beta"];
  for (const key of keys) {
    const raw = src[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    // anthropic-beta 可能是逗号分隔的一串；oauth-* 是登录态专用的，供应商不认识，去掉
    const value = key === "anthropic-beta"
      ? raw.split(",").map((s) => s.trim()).filter((s) => s && !/^oauth-/i.test(s)).join(", ")
      : raw.trim();
    if (value) out[key] = value;
  }
  if (provider && provider.passUserAgent === true && typeof src["user-agent"] === "string" && src["user-agent"]) {
    out["user-agent"] = src["user-agent"];
  }
  return out;
};

// 出站请求头：openai 系走 Authorization Bearer；anthropic 走 x-api-key + anthropic-version，
// authHeader=true（默认）时 anthropic 也附加 Authorization Bearer（兼容中转站）；
// 优先级：内建 < 客户端透传（betas/version/UA） < provider.headers
const buildUpstreamHeaders = (provider, clientHeaders) => {
  const headers = { "content-type": "application/json" };
  const key = provider.apiKey || "";
  if (provider.api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) {
      headers["x-api-key"] = key;
      if (provider.authHeader !== false) headers["authorization"] = `Bearer ${key}`;
    }
  } else if (key && provider.authHeader !== false) {
    headers["authorization"] = `Bearer ${key}`;
  }
  return { ...headers, ...pickClientHeaders(clientHeaders, provider), ...(provider.headers || {}) };
};

// ==================== 停止原因 / usage 归一 ====================

// OpenAI finish_reason → canonical
const stopFromFinishReason = (r) => {
  if (r === "tool_calls" || r === "function_call") return "tool";
  if (r === "length") return "length";
  return "stop";
};

// Anthropic stop_reason → canonical
const stopFromAnthropicReason = (r) => {
  if (r === "tool_use") return "tool";
  if (r === "max_tokens" || r === "stop_sequence") return "length";
  return "stop";
};

const normalizeUsage = (u = {}) => ({
  inputTokens: Number(u.inputTokens || u.input_tokens || u.prompt_tokens) || 0,
  outputTokens: Number(u.outputTokens || u.output_tokens || u.completion_tokens) || 0,
  cacheReadTokens:
    Number(
      u.cacheReadTokens ||
        u.cache_read_input_tokens ||
        (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
        (u.input_tokens_details && u.input_tokens_details.cached_tokens),
    ) || 0,
  cacheWriteTokens: Number(u.cacheWriteTokens || u.cache_creation_input_tokens) || 0,
});

// 从原始响应文本（整段 JSON 或 SSE 流分片）扫描 usage 数值字段，取各字段最大值，返回 normalizeUsage 同形结果。
// 供同协议直通流式路径旁路采集统计用：不解析事件结构，只正则抓已知 usage key；
// key 带引号边界，不会把 cache_read_input_tokens 误配成 input_tokens。
const USAGE_SCAN_KEYS = {
  inputTokens: ["input_tokens", "prompt_tokens"],
  outputTokens: ["output_tokens", "completion_tokens"],
  cacheReadTokens: ["cache_read_input_tokens", "cached_tokens"],
  cacheWriteTokens: ["cache_creation_input_tokens"],
};
const scanUsageFromText = (text) => {
  const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (!text) return out;
  for (const [field, keys] of Object.entries(USAGE_SCAN_KEYS)) {
    for (const k of keys) {
      const re = new RegExp('"' + k + '"\\s*:\\s*(\\d+)', "g");
      let m;
      while ((m = re.exec(text))) {
        const v = Number(m[1]);
        if (v > out[field]) out[field] = v;
      }
    }
  }
  return out;
};

const totalTokens = (usage) => (usage ? usage.inputTokens + usage.outputTokens : 0);

// ==================== 协议化错误体 ====================

// 状态码 → 协议原生错误类型。agent 的 SDK 会按 type 决定是否重试/退避
//（Claude Code 认 rate_limit_error / overloaded_error，一律回 invalid_request_error 会让它不再重试）。
const errorTypeForStatus = (status) => {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
};

// 按入站协议格式生成错误响应体，保证 agent 侧 SDK 能正常解析
const errorBody = (sourceProtocol, status, message) => {
  const type = errorTypeForStatus(status);
  if (sourceProtocol === "anthropic") return { type: "error", error: { type, message } };
  if (sourceProtocol === "responses") {
    return { error: { message, type: status >= 500 ? "server_error" : type, code: status === 429 ? "rate_limit_exceeded" : status, param: null } };
  }
  return {
    error: { message, type: status >= 500 ? "server_error" : type, code: status === 429 ? "rate_limit_exceeded" : status, param: null },
  };
};

// 上游 429/5xx 时的 Retry-After（秒数或 HTTP 日期），没有则 0
const retryAfterMs = (headers) => {
  const raw = headers && (headers["retry-after"] || headers["Retry-After"]);
  if (!raw) return 0;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(Number(s) * 1000, 15000);
  const at = Date.parse(s);
  if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 15000));
  return 0;
};

// 值得原样重试的状态：限流 / 上游抖动 / 过载
const isRetryableStatus = (status) => [408, 425, 429, 500, 502, 503, 504, 529].includes(status);

// ==================== 上游拒收的可选字段 ====================

// 这些字段是"锦上添花"：上游 400/422 且错误信息点名时就该去掉重试，而不是让整轮对话失败。
// （stream_options 收 usage、reasoning_effort 开推理、response_format 求结构化输出等，都是可选增强）
const OPTIONAL_FIELDS = [
  "stream_options",
  "parallel_tool_calls",
  "response_format",
  "reasoning_effort",
  "reasoning",
  "text",
  "store",
  "metadata",
  "service_tier",
  "prompt_cache_key",
  "prompt_cache_retention",
  "safety_identifier",
  "verbosity",
  "include",
  "thinking",
  "enable_thinking",
  "top_p",
  "top_k",
];

// 错误信息里出现「不收某个字段」的说法（英文 + 中文常见译法）
const FIELD_REFUSAL_RE =
  /unknown (?:name|field|parameter|argument|property)|unsupported (?:parameter|field|property|argument)|unrecognized (?:request )?(?:argument|parameter)|not support(?:ed)?[^.]{0,40}\b(?:field|parameter|argument|property)|extra (?:inputs|fields|keys|properties)|invalid (?:request )?argument|unexpected (?:field|parameter|argument)|不被支持|不支持|不允许|无法识别|未知(?:的)?(?:参数|字段|选项|属性)/i;

// 「值不合法」不算「字段不支持」：这种要去掉的是值，不是字段，且必须让客户端看到
const VALUE_INVALID_RE = /invalid[^.]{0,40}(?:value|format|type|enum)|must be (?:one of|a |an )|expected (?:a|an|one of)/i;

// 一次 400/422 里被上游点名拒收的可选字段
const refusedOptionalFields = (status, message) => {
  if (status !== 400 && status !== 422) return [];
  const text = String(message || "");
  if (!text || !FIELD_REFUSAL_RE.test(text)) return [];
  if (VALUE_INVALID_RE.test(text)) return [];
  const out = [];
  for (const field of OPTIONAL_FIELDS) {
    if (new RegExp(`(^|[^a-z0-9_])${escapeRegExp(field)}([^a-z0-9_]|$)`, "i").test(text)) out.push(field);
  }
  return out;
};

// 有些上游（Bedrock 类、严格的网关）会因为不认识的 anthropic-beta 头整单 400：
// 这种时候去掉 beta 头重试，而不是让用户自己去查
const BETA_REFUSAL_RE = /unexpected|unsupported|unknown|invalid|not support|unrecognized|illegal|不被支持|不支持|无法识别|无效/i;
const refusedBetaHeader = (status, message) => {
  if (status !== 400 && status !== 422) return [];
  const text = String(message || "");
  if (!/anthropic[-_ ]?beta|beta header|beta feature/i.test(text)) return [];
  if (!BETA_REFUSAL_RE.test(text)) return [];
  return ["anthropic-beta"];
};

// ==================== 杂项 ====================

const safeJsonParse = (text, fallback = null) => {
  try {
    return JSON.parse(text);
  } catch (e) {
    return fallback;
  }
};

// 从上游错误响应体提取人类可读的原因：JSON 错误体取 error.message / error.type
//（兼容 openai {error:{message}} 与 anthropic {error:{message}}）；
// 非 JSON（纯文本 / HTML 错误页）去掉标签后截取片段；超长截断，兜底「上游返回 <status>」
const extractUpstreamErrorMessage = (bodyText, statusCode) => {
  const truncate = (s) => {
    const t = String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  };
  const parsed = safeJsonParse(bodyText);
  const msg = parsed && parsed.error && (parsed.error.message || parsed.error.type);
  if (typeof msg === "string" && msg) return truncate(msg);
  if (typeof bodyText === "string" && bodyText.trim()) return truncate(bodyText);
  return `上游返回 ${statusCode}`;
};

module.exports = {
  newId,
  isPlainObject,
  toolLoadedText,
  textFromContent,
  mediaBlock,
  parseDataUrl,
  toDataUrl,
  attachmentText,
  normalizeEffort,
  openAiEffort,
  budgetOfEffort,
  effortOfBudget,
  resolveReasoning,
  normalizeFormat,
  formatToChat,
  formatToResponses,
  formatInstruction,
  normalizeTool,
  sanitizeSchema,
  PROTOCOL_PATHS,
  buildUpstreamUrl,
  CLIENT_BETA_HEADERS,
  pickClientHeaders,
  buildUpstreamHeaders,
  stopFromFinishReason,
  stopFromAnthropicReason,
  normalizeUsage,
  scanUsageFromText,
  totalTokens,
  errorTypeForStatus,
  errorBody,
  retryAfterMs,
  isRetryableStatus,
  OPTIONAL_FIELDS,
  refusedOptionalFields,
  refusedBetaHeader,
  safeJsonParse,
  extractUpstreamErrorMessage,
};
