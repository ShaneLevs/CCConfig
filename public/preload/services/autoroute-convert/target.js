// 自动网关 · 出站协议适配（target）
// 职责：把 canonical 构建为上游请求体（buildRequest），把上游非流式响应解析回 canonical
// （parseResponse），流式时由 readStream 把上游 SSE 读成 canonical 事件流。
// 支持三种出站协议：anthropic-messages、openai-completions、openai-responses。
//
// 跨协议时会丢信息，这里的原则是「能表达就表达，表达不了就降级成文本，绝不静默丢弃」：
//   推理强度  → anthropic thinking.budget_tokens / openai reasoning_effort / responses reasoning.effort
//   图片文档  → anthropic image·document / chat image_url·input_file / responses input_image·input_file
//               载不了时写成 [attachment …] 文本，模型至少知道有内容被略过
//   结构化输出 → chat response_format / responses text.format / anthropic 写进系统提示
//   工具 schema → 补 enum 的 type、oneOf 改 anyOf（上游的 JSON Schema 编译器挑剔）

const {
  newId,
  textFromContent,
  toDataUrl,
  attachmentText,
  openAiEffort,
  resolveReasoning,
  formatToChat,
  formatToResponses,
  formatInstruction,
  sanitizeSchema,
  stopFromFinishReason,
  stopFromAnthropicReason,
  normalizeUsage,
  safeJsonParse,
} = require("./canonical");
const { safeParseArguments } = require("./source");

// ==================== 上游 SSE 通用解析 ====================

// 把 IncomingMessage 的字节流解析为 SSE 事件（逐行解析：\r\n 跨分片、注释保活、多 data 行都正确）
async function* sseEvents(res) {
  let buffer = "";
  let event = "";
  let dataLines = [];
  const take = () => {
    if (!dataLines.length) {
      event = "";
      return null;
    }
    const out = { event: event || "message", data: dataLines.join("\n") };
    event = "";
    dataLines = [];
    return out;
  };
  const consume = (text) => {
    const events = [];
    let i = 0;
    while (i < text.length) {
      let at = -1;
      let skip = 1;
      for (let k = i; k < text.length; k++) {
        const ch = text[k];
        if (ch === "\n") {
          at = k;
          break;
        }
        if (ch === "\r") {
          if (k + 1 >= text.length) {
            at = -1; // \r 可能是 \r\n 的前半，等下一块
          } else {
            at = k;
            skip = text[k + 1] === "\n" ? 2 : 1;
          }
          break;
        }
      }
      if (at === -1) break;
      const line = text.slice(i, at);
      i = at + skip;
      if (line === "") {
        const ev = take();
        if (ev) events.push(ev);
        continue;
      }
      if (line.startsWith(":")) continue; // 注释行（": keepalive"）
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      // id: / retry: 等字段对转换无意义，忽略
    }
    return { events, rest: text.slice(i) };
  };
  for await (const chunk of res) {
    const { events, rest } = consume(buffer + chunk.toString("utf8"));
    buffer = rest;
    for (const ev of events) yield ev;
  }
  const tail = take();
  if (tail) yield tail;
}

// ==================== 媒体块的出站形态 ====================

// anthropic：base64 走 source.base64，url 走 source.url；image 与 document 同构
const anthropicMediaBlock = (block) => {
  if (!block || block.type !== "media") return null;
  const type = block.kind === "file" ? "document" : "image";
  const mediaType = block.mediaType || (block.kind === "file" ? "application/pdf" : "image/png");
  if (block.data) return { type, source: { type: "base64", media_type: mediaType, data: block.data } };
  if (block.url) return { type, source: { type: "url", url: block.url } };
  return null;
};

// chat：只有图片能进来（image_url），文件降级成文本占位
const chatMediaBlock = (block) => {
  if (!block || block.type !== "media" || block.kind !== "image") return null;
  const url = block.data ? toDataUrl(block.mediaType, block.data) : block.url;
  return url ? { type: "image_url", image_url: { url } } : null;
};

// responses：input_image / input_file 原生支持
const responsesMediaBlock = (block) => {
  if (!block || block.type !== "media") return null;
  if (block.kind === "file") {
    const out = { type: "input_file" };
    if (block.name) out.filename = block.name;
    if (block.data) out.file_data = toDataUrl(block.mediaType, block.data);
    else if (block.url) out.file_url = block.url;
    else return null;
    return out;
  }
  const url = block.data ? toDataUrl(block.mediaType, block.data) : block.url;
  return url ? { type: "input_image", image_url: url } : null;
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
      const mediaParts = [];
      const toolCalls = [];
      const toolResults = [];
      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments || "{}" } });
        else if (block.type === "tool_result") toolResults.push(block);
        else if (block.type === "media") {
          const part = chatMediaBlock(block);
          if (part) mediaParts.push(part);
          else textParts.push(attachmentText(block)); // 载不了的媒体降级成占位文本
        }
        // reasoning 块不回传：OpenAI 系协议没有历史推理的位置，部分厂商（DeepSeek 等）
        // 还会因为 assistant 消息里出现 reasoning_content 直接 400
      }
      const text = textParts.join("");
      if (msg.role === "assistant") {
        const m = { role: "assistant", content: text || (toolCalls.length ? null : "") };
        if (toolCalls.length) m.tool_calls = toolCalls;
        messages.push(m);
        continue;
      }
      if (mediaParts.length) {
        const content = [];
        if (text) content.push({ type: "text", text });
        content.push(...mediaParts);
        messages.push({ role: "user", content });
      } else if (text) {
        messages.push({ role: "user", content: text });
      }
      for (const tr of toolResults) {
        // tool 消息只能带文本：工具返回的图片降级成占位（Anthropic 上游的截图工具结果走这里）
        const images = (tr.images || []).map((b) => attachmentText(b)).join("\n");
        const content = [tr.content || "", images].filter(Boolean).join("\n");
        messages.push({ role: "tool", tool_call_id: tr.callId, content });
      }
    }
    // 兜底：入站内容全被过滤时补一条用户消息，避免上游报「messages is required」类费解错误
    if (!messages.length) messages.push({ role: "user", content: canonical.instructions || " " });
    const body = { model: canonical.model, messages, stream: !!canonical.stream };
    if (canonical.tools.length) {
      body.tools = canonical.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: sanitizeSchema(t.inputSchema) } }));
      body.tool_choice = canonical.toolChoice === "any" ? "required" : canonical.toolChoice === "none" ? "none" : canonical.toolChoice === "auto" ? "auto" : { type: "function", function: { name: canonical.toolChoice.name } };
    }
    if (canonical.maxTokens !== undefined && canonical.maxTokens !== null) body.max_tokens = canonical.maxTokens;
    if (canonical.temperature !== undefined) body.temperature = canonical.temperature;
    if (canonical.topP !== undefined) body.top_p = canonical.topP;
    if (canonical.stop !== undefined) body.stop = canonical.stop;
    // 推理强度：OpenAI 系只认 minimal/low/medium/high，xhigh 与 max 按 high 发
    const { effort } = resolveReasoning(canonical.reasoning);
    const asked = openAiEffort(effort);
    if (asked) body.reasoning_effort = asked;
    // 结构化输出：chat 原生支持，json_object / json_schema 都能直接要求
    const format = formatToChat(canonical.format);
    if (format) body.response_format = format;
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
    let sawTool = false;
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
            sawTool = true;
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
    yield { type: "end", stopReason: finish || (sawTool ? "tool" : "stop"), usage };
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
      if (!blocks.length) return;
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else messages.push({ role, content: blocks });
    };
    // 推理强度：Anthropic 用 thinking.budget_tokens，且要求 1024 <= budget < max_tokens。
    // 预算放不下时缩小预算而不是抬高 max_tokens：抬高很容易撞上游的模型硬上限（"max_tokens too large"）
    const { budget } = resolveReasoning(canonical.reasoning);
    const maxTokens = Number(canonical.maxTokens) || Number(canonical.fallbackMaxTokens) || 16384;
    const thinkingBudget = budget > 0 ? Math.min(Math.max(1024, budget), maxTokens - 1024) : 0;
    const useThinking = thinkingBudget >= 1024;
    for (const msg of canonical.input) {
      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === "text") {
          if (block.text) pushBlocks(msg.role, [{ type: "text", text: block.text }]);
        } else if (block.type === "tool_use") {
          pushBlocks("assistant", [{ type: "tool_use", id: block.id, name: block.name, input: safeParseArguments(block.arguments) }]);
        } else if (block.type === "tool_result") {
          const images = (block.images || []).map(anthropicMediaBlock).filter(Boolean);
          const b = { type: "tool_result", tool_use_id: block.callId, content: images.length ? [{ type: "text", text: block.content || "" }, ...images] : block.content || "" };
          if (block.isError) b.is_error = true;
          pushBlocks("user", [b]);
        } else if (block.type === "reasoning") {
          // thinking 块只在本次请求真的开了 thinking 时回放：Anthropic 会拒收「有 thinking 块但没开 thinking」的请求
          if (!useThinking) continue;
          if (block.encrypted) pushBlocks("assistant", [{ type: "redacted_thinking", data: block.encrypted }]);
          else if (block.text) {
            const b = { type: "thinking", thinking: block.text };
            if (block.signature) b.signature = block.signature;
            pushBlocks("assistant", [b]);
          }
        } else if (block.type === "media") {
          const media = anthropicMediaBlock(block);
          if (media) pushBlocks(msg.role === "assistant" ? "user" : msg.role, [media]);
          else pushBlocks(msg.role, [{ type: "text", text: attachmentText(block) }]);
        }
      }
    }
    // anthropic 要求 messages 至少一条，兜底补空用户消息（system 走顶层 body.system）
    if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: " " }] });
    const body = { model: canonical.model, messages, max_tokens: maxTokens, stream: !!canonical.stream };
    // 结构化输出：Anthropic Messages 没有通用的 response_format，把要求写进系统提示
    const instructions = [canonical.instructions, formatInstruction(canonical.format)].filter(Boolean).join("\n\n");
    if (instructions) body.system = instructions;
    if (thinkingBudget && useThinking) body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
    if (canonical.tools.length) {
      body.tools = canonical.tools.map((t) => ({ name: t.name, description: t.description, input_schema: sanitizeSchema(t.inputSchema) }));
      if (canonical.toolChoice === "any") body.tool_choice = { type: "any" };
      else if (canonical.toolChoice === "auto") body.tool_choice = { type: "auto" };
      else if (canonical.toolChoice && canonical.toolChoice.name) body.tool_choice = { type: "tool", name: canonical.toolChoice.name };
      // "none"：anthropic 无对应值，忽略（不强制工具）
    }
    // 开了 thinking 时 Anthropic 要求 temperature 缺省或为 1，冲突时优先保证请求被接受
    if (canonical.temperature !== undefined && !useThinking) body.temperature = canonical.temperature;
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
    let sawTool = false;
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
          sawTool = true;
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
        // Anthropic 流式：message_start 的 usage 通常全 0（input_tokens 要到 message_delta 才有真实值），
        // 且部分上游（Bedrock 类 / 中转）只在 message_delta 报 input_tokens 与缓存字段。
        // 因此这里所有字段都取「非 0 才覆盖」——只取 output 会让这类上游的输入 token 恒为 0。
        if (evt.usage) {
          if (evt.usage.output_tokens) usage.outputTokens = evt.usage.output_tokens;
          if (evt.usage.input_tokens) usage.inputTokens = evt.usage.input_tokens;
          if (evt.usage.cache_read_input_tokens) usage.cacheReadTokens = evt.usage.cache_read_input_tokens;
          if (evt.usage.cache_creation_input_tokens) usage.cacheWriteTokens = evt.usage.cache_creation_input_tokens;
        }
      } else if (evt.type === "message_stop") {
        yield { type: "end", stopReason: finish || (sawTool ? "tool" : "stop"), usage: normalizeUsage(usage) };
        return;
      } else if (evt.type === "error") {
        yield { type: "error", message: (evt.error && evt.error.message) || "上游返回错误" };
        return;
      }
      // ping / 其它事件忽略
    }
    if (started) yield { type: "end", stopReason: finish || (sawTool ? "tool" : "stop"), usage: normalizeUsage(usage) };
  },
};

// ==================== openai-responses 出站 ====================

const responsesTarget = {
  key: "openai-responses",

  // canonical → /v1/responses 请求体
  buildRequest(canonical) {
    const input = [];
    for (const msg of canonical.input) {
      const textParts = [];
      const mediaParts = [];
      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === "text") {
          if (block.text) textParts.push(block.text);
        } else if (block.type === "tool_use") {
          input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: block.arguments || "{}" });
        } else if (block.type === "tool_result") {
          const output = [block.content || ""].concat((block.images || []).map((b) => attachmentText(b)));
          input.push({ type: "function_call_output", call_id: block.callId, output: output.filter(Boolean).join("\n") });
        } else if (block.type === "media") {
          const part = responsesMediaBlock(block);
          if (part) mediaParts.push(part);
          else textParts.push(attachmentText(block));
        }
        // reasoning 块 v1 不回传（responses 上游自管推理状态）
      }
      if (textParts.length || mediaParts.length) {
        const content = [];
        for (const t of textParts) content.push({ type: msg.role === "assistant" ? "output_text" : "input_text", text: t });
        // 图片/文件只能出现在 user 输入里，assistant 侧的媒体降级成文本
        if (mediaParts.length && msg.role === "assistant") {
          content.push({ type: "output_text", text: mediaParts.map((p) => (p.image_url ? `[attachment image: ${p.image_url}]` : "[attachment]")).join("\n") });
        } else {
          content.push(...mediaParts);
        }
        input.push({ type: "message", role: msg.role, content });
      }
    }
    // 兜底：input 为空时补一条用户消息，responses 端点同样拒绝空 input
    if (!input.length) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: " " }] });
    const body = { model: canonical.model, input, stream: !!canonical.stream };
    if (canonical.instructions) body.instructions = canonical.instructions;
    if (canonical.tools.length) {
      body.tools = canonical.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: sanitizeSchema(t.inputSchema) }));
      body.tool_choice = canonical.toolChoice === "any" ? "required" : canonical.toolChoice === "none" ? "none" : canonical.toolChoice === "auto" ? "auto" : { type: "function", name: canonical.toolChoice.name };
    }
    if (canonical.maxTokens !== undefined && canonical.maxTokens !== null) body.max_output_tokens = canonical.maxTokens;
    if (canonical.temperature !== undefined) body.temperature = canonical.temperature;
    if (canonical.topP !== undefined) body.top_p = canonical.topP;
    // 推理强度：responses 用 reasoning.effort
    const { effort } = resolveReasoning(canonical.reasoning);
    const asked = openAiEffort(effort);
    if (asked) body.reasoning = { effort: asked };
    // 结构化输出：responses 的 text.format
    const format = formatToResponses(canonical.format);
    if (format) body.text = { format };
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
      stopReason: body.status === "incomplete" ? "length" : toolCalls.length ? "tool" : "stop",
      usage: normalizeUsage(body.usage),
    };
  },

  // 上游 SSE → canonical 事件流
  async *readStream(res) {
    let started = false;
    let finished = false;
    let sawTool = false;
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
      } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
        if (payload.delta) yield { type: "reasoning_delta", delta: payload.delta };
      } else if (type === "response.output_item.added") {
        const item = payload.item;
        if (item && item.type === "function_call") {
          const key = item.id || item.call_id;
          ordinalByItem.set(key, nextOrdinal);
          sawTool = true;
          yield { type: "tool_start", index: nextOrdinal, id: item.call_id || item.id, name: item.name };
          nextOrdinal += 1;
        }
      } else if (type === "response.function_call_arguments.delta") {
        if (payload.delta) yield { type: "tool_delta", index: ordinalByItem.get(payload.item_id) || 0, delta: payload.delta };
      } else if (type === "response.completed" || type === "response.incomplete") {
        const resp = payload.response || {};
        yield { type: "end", stopReason: type === "response.incomplete" ? "length" : sawTool ? "tool" : "stop", usage: normalizeUsage(resp.usage) };
        finished = true;
        return;
      } else if (type === "response.failed" || type === "error") {
        const msg = (payload.response && payload.response.error && payload.response.error.message) || payload.message || "上游返回错误";
        yield { type: "error", message: msg };
        return;
      }
    }
    if (!finished) yield { type: "end", stopReason: sawTool ? "tool" : "stop", usage: null };
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
