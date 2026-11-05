// 通用配置 · 供应商连接测试
// 对供应商下的每个模型按「模型 API 类型（回退供应商）→ 发送一次最小流式请求」，
// 以首个文本增量作为首字时间；失败时返回可读的错误文本。
// 返回值必须是纯 JSON（桌面版经 sidecar HTTP 往返）。

const http = require("node:http");
const https = require("node:https");
const { t } = require("./i18n");
const { readCommonProviders } = require("./common");

const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_CHARS = 64 * 1024;
const MAX_REDIRECTS = 3;

// 各出站协议的标准请求路径（与 autoroute-convert/canonical.js 保持一致）
const PROTOCOL_PATHS = {
  "openai-completions": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  "anthropic-messages": "/v1/messages",
};

const asText = (value) => (typeof value === "string" ? value : "");

// 兼容历史 / 各 Agent 写入的同义协议名
const normalizeApi = (api) => {
  const value = asText(api).trim();
  if (value === "openai-chat" || value === "openai-chat-completions") return "openai-completions";
  return value || "openai-completions";
};

const isSupportedApi = (api) => api === "google-generative-ai" || !!PROTOCOL_PATHS[api];

const normalizeBaseUrl = (value) => String(value || "").trim().replace(/\/+$/, "");

// baseUrl 可能已带 /v1 或 /v1beta；避免拼出 /v1/v1/...
const buildEndpoint = (baseUrl, api, modelId) => {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return null;
  if (api === "google-generative-ai") {
    const versioned = /\/v\d+(?:(?:beta|alpha)\d*)?$/i.test(base) ? base : `${base}/v1beta`;
    return `${versioned}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
  }
  const path = PROTOCOL_PATHS[api];
  if (!path) return null;
  return /\/v1$/i.test(base) ? base + path.slice(3) : base + path;
};

const buildRequestBody = (api, modelId) => {
  if (api === "anthropic-messages") {
    return {
      model: modelId,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    };
  }
  if (api === "openai-responses") {
    return {
      model: modelId,
      input: "ping",
      max_output_tokens: 16,
      stream: true,
    };
  }
  if (api === "google-generative-ai") {
    return {
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 16 },
    };
  }
  // 不带 max_tokens：o1/o3 等推理模型会拒绝该字段，首字到手后立即断开即可控制输出。
  return {
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    stream: true,
  };
};

const buildHeaders = (provider, model, api) => {
  const key = provider.apiKey || "";
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
    // 不主动接受压缩，避免流式首字被解压缓冲吞掉
    "accept-encoding": "identity",
  };
  if (api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) {
      headers["x-api-key"] = key;
      if (provider.authHeader !== false) headers.authorization = `Bearer ${key}`;
    }
  } else if (api === "google-generative-ai") {
    if (key) headers["x-goog-api-key"] = key;
  } else if (key && provider.authHeader !== false) {
    headers.authorization = `Bearer ${key}`;
  }
  return {
    ...headers,
    ...(provider.headers || {}),
    ...(model.extraHeaders || {}),
  };
};

const contentText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => asText(item && item.text)).join("");
};

// 从单个响应事件里取「首个文本增量」；只用于判断是否已经出字。
const extractDeltaText = (api, payload) => {
  if (!payload || typeof payload !== "object") return "";
  if (api === "anthropic-messages") {
    if (payload.type === "content_block_delta") {
      return asText(payload.delta && payload.delta.text) || asText(payload.delta && payload.delta.thinking);
    }
    if (payload.type === "content_block_start") return asText(payload.content_block && payload.content_block.text);
    return contentText(payload.content);
  }
  if (api === "openai-responses") {
    const type = asText(payload.type);
    if (type === "response.output_text.delta" || type === "response.reasoning_text.delta" || type === "response.refusal.delta") {
      return asText(payload.delta);
    }
    if (type === "response.content_part.delta") return asText(payload.delta && payload.delta.text);
    if (asText(payload.output_text)) return asText(payload.output_text);
    if (Array.isArray(payload.output)) {
      return payload.output
        .map((item) => {
          if (!item || !Array.isArray(item.content)) return "";
          return item.content.map((part) => asText(part && part.text)).join("");
        })
        .join("");
    }
    return "";
  }
  if (api === "google-generative-ai") {
    const parts = payload.candidates && payload.candidates[0] && payload.candidates[0].content
      ? payload.candidates[0].content.parts
      : null;
    return Array.isArray(parts) ? parts.map((part) => asText(part && part.text)).join("") : "";
  }
  const choice = payload.choices && payload.choices[0];
  if (!choice) return "";
  return (
    asText(choice.delta && choice.delta.content) ||
    asText(choice.delta && choice.delta.reasoning_content) ||
    contentText(choice.message && choice.message.content) ||
    asText(choice.text)
  );
};

const extractError = (body) => {
  const text = String(body || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const error = parsed && parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      return asText(error.message) || asText(error.type) || JSON.stringify(error).slice(0, 500);
    }
    const message = parsed && (parsed.message || parsed.msg || parsed.detail);
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch (e) {
    /* 非 JSON（HTML / 纯文本）按原样截断 */
  }
  return text.slice(0, 2000);
};

const formatHttpError = (status, body) => {
  const detail = extractError(body);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
};

const formatNetworkError = (error) => {
  const code = error && error.code ? String(error.code) : "";
  const message = (error && error.message) || t("service.common.unknownError");
  return code && !message.includes(code) ? `${code}: ${message}` : message;
};

const requestModel = (provider, model, api) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const endpoint = buildEndpoint(model.baseURL || provider.baseUrl, api, model.id);
    if (!endpoint) {
      resolve({ ok: false, api, error: t("service.connectionTest.baseUrlMissing") });
      return;
    }
    const body = JSON.stringify(buildRequestBody(api, model.id));
    const headers = {
      ...buildHeaders(provider, model, api),
      "content-length": Buffer.byteLength(body),
    };

    let settled = false;
    let req = null;
    let timer = null;
    let redirects = 0;
    let sawResponseData = false;
    let firstDataAt = 0;
    let firstTokenAt = 0;
    let raw = "";
    let buffer = "";
    let streamError = "";

    const succeed = (latencyMs) =>
      resolve({
        ok: true,
        api,
        latencyMs: Math.max(0, Math.round(latencyMs)),
      });
    const fail = (error) => resolve({ ok: false, api, error });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (req) req.destroy();
      } catch (e) {
        /* ignore */
      }
      if (result.ok) succeed(result.latencyMs);
      else fail(result.error);
    };
    const failWith = (error) => finish({ ok: false, error });
    const succeedWith = (latencyMs) => finish({ ok: true, latencyMs });

    timer = setTimeout(() => {
      failWith(t("service.connectionTest.timeout", { seconds: Math.round(REQUEST_TIMEOUT_MS / 1000) }));
    }, REQUEST_TIMEOUT_MS);

    // 逐行解析 SSE；只关心 data: 行（event: 行不参与判断）
    const consume = (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        index = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch (e) {
          continue;
        }
        if (payload && payload.type === "error") {
          streamError = extractError(JSON.stringify(payload)) || asText(payload.error && payload.error.message);
        }
        if (!firstTokenAt && extractDeltaText(api, payload)) firstTokenAt = Date.now();
      }
    };

    const start = (url, redirectCount) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        failWith(t("service.connectionTest.invalidBaseUrl"));
        return;
      }
      const transport = parsed.protocol === "https:" ? https : parsed.protocol === "http:" ? http : null;
      if (!transport) {
        failWith(t("service.connectionTest.invalidBaseUrl"));
        return;
      }

      req = transport.request(parsed, { method: "POST", headers }, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            failWith(t("service.connectionTest.tooManyRedirects"));
            return;
          }
          start(new URL(location, url).toString(), redirectCount + 1);
          return;
        }

        res.setEncoding("utf8");
        if (status < 200 || status >= 300) {
          let errorBody = "";
          res.on("data", (chunk) => {
            if (errorBody.length < MAX_BODY_CHARS) errorBody += chunk;
          });
          res.on("end", () => failWith(formatHttpError(status, errorBody)));
          res.on("error", (error) => failWith(formatNetworkError(error)));
          return;
        }

        res.on("data", (chunk) => {
          if (settled) return;
          if (!sawResponseData) {
            sawResponseData = true;
            firstDataAt = Date.now();
          }
          if (raw.length < MAX_BODY_CHARS) raw += chunk;
          consume(chunk);
          if (firstTokenAt && !settled) succeedWith(firstTokenAt - startedAt);
        });
        res.on("end", () => {
          if (settled) return;
          if (streamError) {
            failWith(streamError);
            return;
          }
          // 非流式响应：整段 JSON 里找文本；找不到但 HTTP 成功仍视为连通。
          if (firstTokenAt) {
            succeedWith(firstTokenAt - startedAt);
            return;
          }
          let payload = null;
          try {
            payload = JSON.parse(raw);
          } catch (e) {
            /* 不是 JSON（部分中转站会回纯文本） */
          }
          if (payload && extractDeltaText(api, payload)) {
            succeedWith((firstDataAt || Date.now()) - startedAt);
            return;
          }
          // 2xx 也可能是上游的错误信封；只有显式 error 字段才判失败，避免把正常空响应当报错。
          if (payload && (payload.error || payload.type === "error")) {
            failWith(extractError(raw) || t("service.common.unknownError"));
            return;
          }
          if (sawResponseData) {
            succeedWith(firstDataAt - startedAt);
            return;
          }
          failWith(t("service.connectionTest.emptyResponse"));
        });
        res.on("error", (error) => failWith(formatNetworkError(error)));
      });

      req.on("error", (error) => failWith(formatNetworkError(error)));
      req.write(body);
      req.end();
    };

    start(endpoint, redirects);
  });

const testCommonModelConnection = async (providerName, modelId) => {
  const { providers } = readCommonProviders();
  const provider = providers.find((item) => item.name === providerName);
  if (!provider) {
    return { ok: false, error: t("service.connectionTest.providerMissing", { name: providerName }) };
  }
  const model = (provider.models || []).find((item) => item.id === modelId);
  if (!model) {
    return { ok: false, error: t("service.connectionTest.modelMissing", { id: modelId }) };
  }
  const api = normalizeApi(model.api || provider.api);
  if (!isSupportedApi(api)) {
    return { ok: false, api, error: t("service.connectionTest.unsupportedApi", { api }) };
  }
  return requestModel(provider, model, api);
};

module.exports = {
  testCommonModelConnection,
  // 供单测使用
  _internal: { buildEndpoint, buildRequestBody, buildHeaders, extractDeltaText, extractError, normalizeApi },
};
