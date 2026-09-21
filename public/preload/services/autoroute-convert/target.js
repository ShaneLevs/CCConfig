// 自动网关 · 出站协议适配（target）
// 职责：把 canonical 构建为上游请求体（buildRequest），把上游非流式响应解析回 canonical
// （parseResponse），流式时由 readStream 把上游 SSE 读成 canonical 事件流。
// 支持三种出站协议：anthropic-messages、openai-completions、openai-responses。

const {
  newId,
  textFromContent,
  stopFromFinishReason,
  stopFromAnthropicReason,
  normalizeUsage,
  safeJsonParse,
} = require("./canonical");
const { safeParseArguments } = require("./source");

// ==================== 上游 SSE 通用解析 ====================

// 把 IncomingMessage 的字节流解析为 SSE 事件（兼容 \r\n）
async function* sseEvents(res) {
  let buffer = "";
  for await (const chunk of res) {
    buffer += chunk.toString("utf8").replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseBlock(raw);
      if (parsed) yield parsed;
    }
  }
  const tail = parseSseBlock(buffer);
  if (tail) yield tail;
}

const parseSseBlock = (raw) => {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
};

// ==================== openai-completions 出站 ====================

const chatTarget = {
  key: "openai-completions",

  // canonical → chat/completions 请求体
  buildRequest(canonical) {
    const messages = [];
    if (canonical.instructions) messages.push({ role: "system", content: canonical.instructions });
    for (const msg of canonical.input) {
      const textParts = [];
      const toolCalls = [];
      const toolResults = [];
      let reasoningText = "";
      for (const block of msg.content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments || "{}" } });
        else if (block.type === "tool_result") toolResults.push(block);
        else if (block.type === "reasoning" && block.text) reasoningText += (reasoningText ? "\n" : "") + block.text;
      }
      if (msg.role === "assistant") {
        const m = { role: "assistant", content: textParts.join("") || (toolCalls.length ? null : "") };
        if (reasoningText) m.reasoning_content = reasoningText;
        if (toolCalls.length) m.tool_calls = toolCalls;
        messages.push(m);
      } else {
        if (textParts.length) messages.push({ role: "user", content: textParts.join("") });
        for (const tr of toolResults) {
          messages.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
        }
      }
    }
    // 兜底：入站内容全被过滤时补一条用户消息，避免上游报「messages is required」类费解错误
    if (!messages.length) messages.push({ role: "user", content: canonical.instructions || " " });
    const body = { model: canonical.model, messages, stream: !!canonical.stream };
    if (canonical.tools.length) {
      body.tools = canonical.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      body.tool_choice = canonical.toolChoice === "any" ? "required" : canonical.toolChoice === "none" ? "none" : canonical.toolChoice === "auto" ? "auto" : { type: "function", function: { name: canonical.toolChoice.name } };
    }
    if (canonical.maxTokens !== undefined && canonical.maxTokens !== null) body.max_tokens = canonical.maxTokens;
    if (canonical.temperature !== undefined) body.temperature = canonical.temperature;
    if (canonical.topP !== undefined) body.top_p = canonical.topP;
    if (canonical.stop !== undefined) body.stop = canonical.stop;
    if (body.stream) body.stream_options = { include_usage: true };
    return body;
  },

  // chat/completions 响应 → canonical
  parseResponse(body) {
    const choice = (body.choices && body.choices[0]) || {};
    const message = choice.message || {};
    const reasoning = [];
    if (typeof message.reasoning_content === "string" && message.reasoning_content) {
      reasoning.push({ text: message.reasoning_content });
    }
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .filter((tc) => tc && tc.function && tc.function.name)
          .map((tc) => ({ id: tc.id || newId("call"), name: tc.function.name, arguments: tc.function.arguments || "{}" }))
      : [];
    return {
      id: body.id,
      model: body.model,
      text: typeof message.content === "string" ? message.content : textFromContent(message.content),
      reasoning,
      toolCalls,
      stopReason: stopFromFinishReason(choice.finish_reason),
      usage: normalizeUsage(body.usage),
    };
  },

  // 上游 SSE → canonical 事件流
  async *readStream(res) {
    let started = false;
    let finish = null;
    let usage = null;
    const ordinalByRaw = new Map();
    let nextOrdinal = 0;
    for await (const { data } of sseEvents(res)) {
      if (data === "[DONE]") break;
      const chunk = safeJsonParse(data);
      if (!chunk) continue;
      if (!started) {
        started = true;
        yield { type: "start", model: chunk.model || "" };
      }
      if (chunk.usage && (!chunk.choices || !chunk.choices.length)) {
        usage = normalizeUsage(chunk.usage);
        continue;
      }
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) yield { type: "text_delta", delta: delta.content };
      if (delta.reasoning_content) yield { type: "reasoning_delta", delta: delta.reasoning_content };
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const raw = tc && tc.index !== undefined ? tc.index : 0;
          if (!ordinalByRaw.has(raw)) {
            ordinalByRaw.set(raw, nextOrdinal);
            yield { type: "tool_start", index: nextOrdinal, id: (tc && tc.id) || newId("call"), name: (tc && tc.function && tc.function.name) || "" };
            nextOrdinal += 1;
          }
          const args = tc && tc.function && tc.function.arguments;
          if (args) yield { type: "tool_delta", index: ordinalByRaw.get(raw), delta: args };
        }
      }
      if (choice.finish_reason) finish = stopFromFinishReason(choice.finish_reason);
      if (chunk.usage) usage = normalizeUsage(chunk.usage);
    }
    yield { type: "end", stopReason: finish || "stop", usage };
  },
};

// ==================== anthropic-messages 出站 ====================

const anthropicTarget = {
  key: "anthropic-messages",

  // canonical → /v1/messages 请求体
  // Anthropic 要求 user/assistant 严格交替，这里合并相邻同角色消息
  buildRequest(canonical) {
    const messages = [];
    const pushBlocks = (role, blocks) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else messages.push({ role, content: blocks });
    };
    if (canonical.instructions) {
      // anthropic 无独立 system 消息，作为首条 user 前置的 system 顶层字段处理（见下 body.system）
    }
    for (const msg of canonical.input) {
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text) pushBlocks(msg.role, [{ type: "text", text: block.text }]);
        } else if (block.type === "tool_use") {
          pushBlocks("assistant", [{ type: "tool_use", id: block.id, name: block.name, input: safeParseArguments(block.arguments) }]);
        } else if (block.type === "tool_result") {
          const b = { type: "tool_result", tool_use_id: block.callId, content: block.content || "" };
          if (block.isError) b.is_error = true;
          pushBlocks("user", [b]);
        } else if (block.type === "reasoning") {
          if (block.encrypted) pushBlocks("assistant", [{ type: "redacted_thinking", data: block.encrypted }]);
          else if (block.text) {
            const b = { type: "thinking", thinking: block.text };
            if (block.signature) b.signature = block.signature;
            pushBlocks("assistant", [b]);
          }
        }
      }
    }
    // anthropic 要求 messages 至少一条，兜底补空用户消息（system 走顶层 body.system）
    if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: " " }] });
    const body = { model: canonical.model, messages, max_tokens: canonical.maxTokens || 8192, stream: !!canonical.stream };
    if (canonical.instructions) body.system = canonical.instructions;
    if (canonical.tools.length) {
      body.tools = canonical.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      if (canonical.toolChoice === "any") body.tool_choice = { type: "any" };
      else if (canonical.toolChoice === "auto") body.tool_choice = { type: "auto" };
      else if (canonical.toolChoice && canonical.toolChoice.name) body.tool_choice = { type: "tool", name: canonical.toolChoice.name };
      // "none"：anthropic 无对应值，忽略（不强制工具）
    }
    if (canonical.temperature !== undefined) body.temperature = canonical.temperature;
    if (canonical.topP !== undefined) body.top_p = canonical.topP;
    if (canonical.stop !== undefined) body.stop_sequences = Array.isArray(canonical.stop) ? canonical.stop : [canonical.stop];
    return body;
  },

  // /v1/messages 响应 → canonical
  parseResponse(body) {
    const textParts = [];
    const reasoning = [];
    const toolCalls = [];
    for (const block of body.content || []) {
      if (!block || !block.type) continue;
      if (block.type === "text") textParts.push(block.text || "");
      else if (block.type === "thinking") reasoning.push({ text: block.thinking || "", signature: block.signature || undefined });
      else if (block.type === "redacted_thinking") reasoning.push({ encrypted: block.data || "" });
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
    return {
      id: body.id,
      model: body.model,
      text: textParts.join(""),
      reasoning,
      toolCalls,
      stopReason: stopFromAnthropicReason(body.stop_reason),
      usage: normalizeUsage(body.usage),
    };
  },

  // 上游 SSE → canonical 事件流
  async *readStream(res) {
    let started = false;
    let finish = null;
    const usage = {};
    const ordinalByBlock = new Map();
    let nextOrdinal = 0;
    for await (const { data } of sseEvents(res)) {
      const evt = safeJsonParse(data);
      if (!evt || !evt.type) continue;
      if (evt.type === "message_start") {
        started = true;
        const u = (evt.message && evt.message.usage) || {};
        usage.inputTokens = u.input_tokens || 0;
        usage.cacheReadTokens = u.cache_read_input_tokens || 0;
        usage.cacheWriteTokens = u.cache_creation_input_tokens || 0;
        yield { type: "start", model: (evt.message && evt.message.model) || "" };
      } else if (evt.type === "content_block_start") {
        const cb = evt.content_block;
        if (cb && cb.type === "tool_use") {
          ordinalByBlock.set(evt.index, nextOrdinal);
          yield { type: "tool_start", index: nextOrdinal, id: cb.id, name: cb.name };
          nextOrdinal += 1;
        }
      } else if (evt.type === "content_block_delta") {
        const d = evt.delta || {};
        if (d.type === "text_delta") yield { type: "text_delta", delta: d.text || "" };
        else if (d.type === "thinking_delta") yield { type: "reasoning_delta", delta: d.thinking || "" };
        else if (d.type === "signature_delta") yield { type: "reasoning_signature", signature: d.signature || "" };
        else if (d.type === "input_json_delta") yield { type: "tool_delta", index: ordinalByBlock.get(evt.index) || 0, delta: d.partial_json || "" };
      } else if (evt.type === "message_delta") {
        if (evt.delta && evt.delta.stop_reason) finish = stopFromAnthropicReason(evt.delta.stop_reason);
        if (evt.usage && evt.usage.output_tokens) usage.outputTokens = evt.usage.output_tokens;
      } else if (evt.type === "message_stop") {
        yield { type: "end", stopReason: finish || "stop", usage: normalizeUsage(usage) };
        return;
      } else if (evt.type === "error") {
        yield { type: "error", message: (evt.error && evt.error.message) || "上游返回错误" };
        return;
      }
    }
    if (started) yield { type: "end", stopReason: finish || "stop", usage: normalizeUsage(usage) };
  },
};

// ==================== openai-responses 出站 ====================

const responsesTarget = {
  key: "openai-responses",

  // canonical → /v1/responses 请求体
  buildRequest(canonical) {
    const input = [];
    for (const msg of canonical.input) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          input.push({ type: "message", role: msg.role, content: [{ type: msg.role === "assistant" ? "output_text" : "input_text", text: block.text }] });
        } else if (block.type === "tool_use") {
          input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments || "{}" });
        } else if (block.type === "tool_result") {
          input.push({ type: "function_call_output", call_id: block.callId, output: block.content || "" });
        }
        // reasoning 块 v1 不回传（responses 上游自管推理状态）
      }
    }
    // 兜底：input 为空时补一条用户消息，responses 端点同样拒绝空 input
    if (!input.length) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: " " }] });
    const body = { model: canonical.model, input, stream: !!canonical.stream };
    if (canonical.instructions) body.instructions = canonical.instructions;
    if (canonical.tools.length) {
      body.tools = canonical.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }));
      body.tool_choice = canonical.toolChoice === "any" ? "required" : canonical.toolChoice === "none" ? "none" : canonical.toolChoice === "auto" ? "auto" : { type: "function", name: canonical.toolChoice.name };
    }
    if (canonical.maxTokens !== undefined && canonical.maxTokens !== null) body.max_output_tokens = canonical.maxTokens;
    if (canonical.temperature !== undefined) body.temperature = canonical.temperature;
    if (canonical.topP !== undefined) body.top_p = canonical.topP;
    return body;
  },

  // /v1/responses 响应 → canonical
  parseResponse(body) {
    const textParts = [];
    const reasoning = [];
    const toolCalls = [];
    for (const item of body.output || []) {
      if (!item || !item.type) continue;
      if (item.type === "message") {
        for (const c of Array.isArray(item.content) ? item.content : []) {
          if (c && c.type === "output_text" && c.text) textParts.push(c.text);
        }
      } else if (item.type === "function_call") {
        toolCalls.push({ id: item.call_id || item.id, name: item.name, arguments: item.arguments || "{}" });
      } else if (item.type === "reasoning") {
        const text = (Array.isArray(item.summary) ? item.summary : []).map((s) => s && s.text).filter(Boolean).join("");
        if (text) reasoning.push({ text });
      }
    }
    return {
      id: body.id,
      model: body.model,
      text: textParts.join(""),
      reasoning,
      toolCalls,
      stopReason: body.status === "incomplete" ? "length" : "stop",
      usage: normalizeUsage(body.usage),
    };
  },

  // 上游 SSE → canonical 事件流
  async *readStream(res) {
    let started = false;
    let finished = false;
    const ordinalByItem = new Map();
    let nextOrdinal = 0;
    for await (const { event, data } of sseEvents(res)) {
      const payload = safeJsonParse(data);
      const type = payload && payload.type ? payload.type : event;
      if (!type) continue;
      if (type === "response.created" || type === "response.in_progress") {
        if (!started) {
          started = true;
          yield { type: "start", model: (payload.response && payload.response.model) || "" };
        }
      } else if (type === "response.output_text.delta") {
        if (payload.delta) yield { type: "text_delta", delta: payload.delta };
      } else if (type === "response.output_item.added") {
        const item = payload.item;
        if (item && item.type === "function_call") {
          const key = item.id || item.call_id;
          ordinalByItem.set(key, nextOrdinal);
          yield { type: "tool_start", index: nextOrdinal, id: item.call_id || item.id, name: item.name };
          nextOrdinal += 1;
        }
      } else if (type === "response.function_call_arguments.delta") {
        if (payload.delta) yield { type: "tool_delta", index: ordinalByItem.get(payload.item_id) || 0, delta: payload.delta };
      } else if (type === "response.completed" || type === "response.incomplete") {
        const resp = payload.response || {};
        yield { type: "end", stopReason: type === "response.incomplete" ? "length" : "stop", usage: normalizeUsage(resp.usage) };
        finished = true;
        return;
      } else if (type === "response.failed" || type === "error") {
        const msg = (payload.response && payload.response.error && payload.response.error.message) || payload.message || "上游返回错误";
        yield { type: "error", message: msg };
        return;
      }
    }
    if (!finished) yield { type: "end", stopReason: "stop", usage: null };
  },
};

// ==================== 注册表 ====================

const TARGETS = {
  "openai-completions": chatTarget,
  "anthropic-messages": anthropicTarget,
  "openai-responses": responsesTarget,
};

const getTarget = (api) => TARGETS[api] || null;

module.exports = { getTarget, TARGETS, sseEvents };
