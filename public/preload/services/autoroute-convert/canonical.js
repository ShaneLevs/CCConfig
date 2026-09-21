// 自动网关 · 协议转换层 —— 标准中间格式（canonical）与公共工具
// 星型转换：入站协议(source 适配器) → canonical → 出站协议(target 适配器)，响应原路反向。
// canonical 请求采用 OpenAI Responses 风格：
//   {
//     model,                       // 目标模型 ID（已解析）
//     instructions,                // 系统提示（对应 anthropic system / openai system / responses instructions）
//     input: [{ role, content: [block] }],
//     tools: [{ name, description, inputSchema }],
//     toolChoice,                  // "auto" | "any" | "none" | { name }
//     maxTokens, temperature, topP, stop, stream,
//     reasoning,                   // { effort?, maxTokens? } 透传给支持推理的上游，v1 尽力而为
//   }
// block 类型：
//   { type: "text", text }
//   { type: "tool_use", id, name, arguments }          // arguments 为 JSON 字符串（流式增量天然是字符串）
//   { type: "tool_result", callId, content, isError }  // content 为字符串
//   { type: "reasoning", text?, signature?, encrypted? }
// canonical 响应：
//   { id, model, text, reasoning: [...], toolCalls: [{ id, name, arguments }], stopReason, usage }
// stopReason ∈ "stop" | "length" | "tool"
// 流式以 canonical 事件流为中心：
//   start / text_delta / reasoning_delta / reasoning_signature / tool_start / tool_delta / end / error
// 注意：图片等多模态块不进 canonical，跨协议转换时会丢弃（同协议直通不受影响，不走 canonical）。

const crypto = require("crypto");

const newId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// content 可能是 string 或 block 数组，抽出全部文本
const textFromContent = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b.text === "string") return b.text;
      return "";
    })
    .join("")
    .trim();
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

// 出站请求头：openai 系走 Authorization Bearer；anthropic 走 x-api-key + anthropic-version，
// authHeader=true（默认）时 anthropic 也附加 Authorization Bearer（兼容中转站）；provider.headers 优先级最高
const buildUpstreamHeaders = (provider) => {
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
  return { ...headers, ...(provider.headers || {}) };
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
  cacheReadTokens: Number(u.cacheReadTokens || u.cache_read_input_tokens || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)) || 0,
  cacheWriteTokens: Number(u.cacheWriteTokens || u.cache_creation_input_tokens) || 0,
});

const totalTokens = (usage) => (usage ? usage.inputTokens + usage.outputTokens : 0);

// ==================== 协议化错误体 ====================

// 按入站协议格式生成错误响应体，保证 agent 侧 SDK 能正常解析
const errorBody = (sourceProtocol, status, message) => {
  if (sourceProtocol === "anthropic") {
    const type = status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : "invalid_request_error";
    return { type: "error", error: { type, message } };
  }
  return { error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error", code: status } };
};

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
  textFromContent,
  PROTOCOL_PATHS,
  buildUpstreamUrl,
  buildUpstreamHeaders,
  stopFromFinishReason,
  stopFromAnthropicReason,
  normalizeUsage,
  totalTokens,
  errorBody,
  safeJsonParse,
  extractUpstreamErrorMessage,
};
