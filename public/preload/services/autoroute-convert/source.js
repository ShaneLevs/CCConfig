// 自动网关 · 入站协议适配（source）
// 职责：把 agent 发来的请求解析为 canonical（parseRequest），把 canonical 响应格式化回入站协议
// （formatResponse），流式时由 createFrameWriter 把 canonical 事件流重写为入站协议的 SSE 帧。
// 支持三种入站协议：anthropic（/v1/messages）、chat（/v1/chat/completions）、responses（/v1/responses）。

const {
  newId,
  textFromContent,
  mediaBlock,
  parseDataUrl,
  normalizeTool,
  normalizeFormat,
  resolveReasoning,
  stopFromFinishReason,
  stopFromAnthropicReason,
} = require("./canonical");

// ==================== 工具选择 ====================

const mapToolChoiceToCanonical = (tc) => {
  if (!tc) return "auto";
  if (typeof tc === "string") {
    if (tc === "none") return "none";
    if (tc === "required") return "any";
    return "auto";
  }
  if (tc.type === "tool" && tc.name) return { name: tc.name };
  if (tc.type === "function" && tc.name) return { name: tc.name }; // responses 扁平形态 {type,name}
  if (tc.type === "function" && tc.function && tc.function.name) return { name: tc.function.name }; // chat 嵌套形态
  if (tc.type === "any") return "any";
  if (tc.type === "auto") return "auto";
  if (tc.type === "none") return "none";
  return "auto";
};

// ==================== Anthropic Messages 入站 ====================

// anthropic 的 image / document 块（base64 或 url 两种 source）
const anthropicMedia = (b) => {
  const src = b && b.source;
  if (!src) return null;
  const kind = b.type === "document" ? "file" : "image";
  if (src.type === "base64") return mediaBlock(kind, src.media_type, { data: src.data });
  if (src.type === "url") return mediaBlock(kind, src.media_type || (kind === "file" ? "application/pdf" : "image/png"), { url: src.url });
  if (src.type === "text" && typeof src.data === "string") {
    // document 的 text source：内容本身就是文本，交给调用方当文本用
    return { type: "text", text: src.data };
  }
  return null;
};

// tool_result 的 content 既可能是字符串也可能是块数组（数组里能带图片）
const anthropicToolResult = (b) => {
  const images = [];
  if (Array.isArray(b.content)) {
    for (const c of b.content) {
      const media = anthropicMedia(c);
      if (media && media.type === "media") images.push(media);
    }
  }
  return { content: textFromContent(b.content), images };
};

const anthropicSource = {
  key: "anthropic",
  contentType: "application/json",

  // body: Anthropic Messages 请求 → canonical
  parseRequest(body, model) {
    const thinking = body.thinking && typeof body.thinking === "object" ? body.thinking : null;
    const canonical = {
      model,
      instructions: textFromContent(body.system),
      input: [],
      tools: [],
      toolChoice: mapToolChoiceToCanonical(body.tool_choice),
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      stop: Array.isArray(body.stop_sequences) ? body.stop_sequences : undefined,
      stream: !!body.stream,
      // thinking.enabled + budget_tokens → 档位；disabled / 缺省 = 没开推理
      reasoning: thinking && thinking.type !== "disabled" && (thinking.budget_tokens || thinking.type === "enabled")
        ? resolveReasoning({ maxTokens: thinking.budget_tokens || 0 })
        : null,
      // 新版 Anthropic 的结构化输出（output_config.format）
      format: normalizeFormat(body.output_config && body.output_config.format),
    };
    if (Array.isArray(body.tools)) {
      canonical.tools = body.tools.map(normalizeTool).filter(Boolean);
    }
    for (const msg of body.messages || []) {
      if (!msg) continue;
      const role = msg.role === "assistant" ? "assistant" : "user";
      const blocks = [];
      if (typeof msg.content === "string") {
        if (msg.content) blocks.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!b || !b.type) continue;
          if (b.type === "text") blocks.push({ type: "text", text: b.text || "" });
          else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
          else if (b.type === "tool_result") {
            const tr = anthropicToolResult(b);
            blocks.push({ type: "tool_result", callId: b.tool_use_id, content: tr.content, isError: !!b.is_error, ...(tr.images.length ? { images: tr.images } : {}) });
          } else if (b.type === "thinking") blocks.push({ type: "reasoning", text: b.thinking || "", signature: b.signature || undefined });
          else if (b.type === "redacted_thinking") blocks.push({ type: "reasoning", encrypted: b.data || "" });
          else if (b.type === "image" || b.type === "document") {
            const media = anthropicMedia(b);
            if (media && media.type === "media") blocks.push(media);
            else if (media && media.type === "text" && media.text) blocks.push({ type: "text", text: media.text });
          }
          // 其余块（server_tool_use / web_search_tool_result 等）v1 忽略
        }
      }
      if (blocks.length) canonical.input.push({ role, content: blocks });
    }
    return canonical;
  },

  // canonical → Anthropic Messages 响应
  formatResponse(canonical) {
    const content = [];
    for (const r of canonical.reasoning || []) {
      if (r.encrypted) content.push({ type: "redacted_thinking", data: r.encrypted });
      else if (r.text) content.push({ type: "thinking", thinking: r.text, signature: r.signature || "" });
    }
    if (canonical.text) content.push({ type: "text", text: canonical.text });
    for (const tc of canonical.toolCalls || []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: safeParseArguments(tc.arguments) });
    }
    const stopReason = canonical.stopReason === "tool" ? "tool_use" : canonical.stopReason === "length" ? "max_tokens" : "end_turn";
    const usage = { input_tokens: canonical.usage.inputTokens, output_tokens: canonical.usage.outputTokens };
    if (canonical.usage.cacheReadTokens) usage.cache_read_input_tokens = canonical.usage.cacheReadTokens;
    if (canonical.usage.cacheWriteTokens) usage.cache_creation_input_tokens = canonical.usage.cacheWriteTokens;
    return {
      id: canonical.id || newId("msg"),
      type: "message",
      role: "assistant",
      model: canonical.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    };
  },

  createFrameWriter() {
    return new AnthropicFrameWriter();
  },
};

class AnthropicFrameWriter {
  constructor() {
    this.started = false;
    this.blockIndex = -1;
    this.blockType = null; // text | thinking | tool_use
    this.outputTokens = 0;
    this.finished = false;
  }
  frame(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  }
  closeBlock() {
    if (this.blockType) {
      const f = this.frame("content_block_stop", { index: this.blockIndex });
      this.blockType = null;
      return f;
    }
    return "";
  }
  push(event) {
    if (event.type === "start") {
      this.started = true;
      return [this.frame("message_start", { message: { id: newId("msg"), type: "message", role: "assistant", model: event.model || "", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })];
    }
    if (event.type === "text_delta" || event.type === "reasoning_delta" || event.type === "reasoning_signature" || event.type === "tool_start" || event.type === "tool_delta") {
      if (!this.started) return []; // 上游异常时兜底：未 start 直接丢帧
      const frames = [];
      if (event.type === "text_delta" && this.blockType !== "text") {
        frames.push(this.closeBlock());
        this.blockIndex += 1;
        this.blockType = "text";
        frames.push(this.frame("content_block_start", { index: this.blockIndex, content_block: { type: "text", text: "" } }));
      } else if ((event.type === "reasoning_delta" || event.type === "reasoning_signature") && this.blockType !== "thinking") {
        frames.push(this.closeBlock());
        this.blockIndex += 1;
        this.blockType = "thinking";
        frames.push(this.frame("content_block_start", { index: this.blockIndex, content_block: { type: "thinking", thinking: "", signature: "" } }));
      } else if (event.type === "tool_start") {
        frames.push(this.closeBlock());
        this.blockIndex += 1;
        this.blockType = "tool_use";
        frames.push(this.frame("content_block_start", { index: this.blockIndex, content_block: { type: "tool_use", id: event.id, name: event.name, input: {} } }));
      }
      if (event.type === "text_delta") frames.push(this.frame("content_block_delta", { index: this.blockIndex, delta: { type: "text_delta", text: event.delta } }));
      else if (event.type === "reasoning_delta") frames.push(this.frame("content_block_delta", { index: this.blockIndex, delta: { type: "thinking_delta", thinking: event.delta } }));
      else if (event.type === "reasoning_signature") frames.push(this.frame("content_block_delta", { index: this.blockIndex, delta: { type: "signature_delta", signature: event.signature } }));
      else if (event.type === "tool_delta") frames.push(this.frame("content_block_delta", { index: this.blockIndex, delta: { type: "input_json_delta", partial_json: event.delta } }));
      return frames;
    }
    if (event.type === "end") {
      this.finished = true;
      const frames = [this.closeBlock()];
      this.outputTokens = (event.usage && event.usage.outputTokens) || 0;
      const stopReason = event.stopReason === "tool" ? "tool_use" : event.stopReason === "length" ? "max_tokens" : "end_turn";
      frames.push(this.frame("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: this.outputTokens } }));
      frames.push(this.frame("message_stop", {}));
      return frames;
    }
    if (event.type === "error") {
      return [this.frame("error", { error: { type: "upstream_error", message: event.message } })];
    }
    return [];
  }
  finish() {
    if (this.finished || !this.started) return [];
    // 上游未发 end 就断流时补齐结束帧
    this.finished = true;
    return [this.closeBlock(), this.frame("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: this.outputTokens } }), this.frame("message_stop", {})];
  }
}

// ==================== OpenAI Chat Completions 入站 ====================

// chat 的 content 数组块：文本 / 图片（image_url 既可能是字符串也可能是 {url}）
const chatContentBlocks = (content) => {
  const blocks = [];
  if (typeof content === "string") {
    if (content) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const c of content) {
    if (typeof c === "string") {
      if (c) blocks.push({ type: "text", text: c });
      continue;
    }
    if (!c || typeof c !== "object") continue;
    if (c.type === "image_url" || c.type === "input_image") {
      const raw = c.image_url !== undefined ? c.image_url : c.image;
      const url = typeof raw === "string" ? raw : raw && raw.url;
      if (!url) continue;
      const parsed = parseDataUrl(url);
      const media = parsed ? mediaBlock("image", parsed.mediaType, { data: parsed.data }) : mediaBlock("image", "image/*", { url });
      if (media) blocks.push(media);
    } else if (c.type === "file" || c.type === "input_file") {
      const f = c.file || {};
      const media = mediaBlock("file", f.mime_type || "application/octet-stream", { data: f.file_data, url: f.file_url, name: f.filename || c.filename });
      if (media) blocks.push(media);
    } else if (typeof c.text === "string" && c.text) {
      blocks.push({ type: "text", text: c.text });
    }
  }
  return blocks;
};

const chatSource = {
  key: "chat",
  contentType: "application/json",

  parseRequest(body, model) {
    const canonical = {
      model,
      instructions: "",
      input: [],
      tools: [],
      toolChoice: mapToolChoiceToCanonical(body.tool_choice),
      maxTokens: body.max_tokens !== undefined ? body.max_tokens : body.max_completion_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      stop: body.stop,
      stream: !!body.stream,
      reasoning: body.reasoning_effort || body.reasoning ? resolveReasoning({ effort: body.reasoning_effort || (body.reasoning && body.reasoning.effort) }) : null,
      format: normalizeFormat(body.response_format),
    };
    const systemParts = [];
    for (const msg of body.messages || []) {
      if (!msg) continue;
      if (msg.role === "system" || msg.role === "developer") {
        const t = textFromContent(msg.content);
        if (t) systemParts.push(t);
        continue;
      }
      if (msg.role === "tool") {
        canonical.input.push({ role: "user", content: [{ type: "tool_result", callId: msg.tool_call_id, content: textFromContent(msg.content) }] });
        continue;
      }
      const role = msg.role === "assistant" ? "assistant" : "user";
      const blocks = chatContentBlocks(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc && tc.function && tc.function.name) {
            blocks.push({ type: "tool_use", id: tc.id || newId("call"), name: tc.function.name, arguments: tc.function.arguments || "{}" });
          }
        }
      }
      if (blocks.length) canonical.input.push({ role, content: blocks });
    }
    if (systemParts.length) canonical.instructions = systemParts.join("\n\n");
    if (Array.isArray(body.tools)) {
      canonical.tools = body.tools.map(normalizeTool).filter(Boolean);
    }
    return canonical;
  },

  formatResponse(canonical) {
    const message = { role: "assistant", content: canonical.text || null };
    if (canonical.reasoning && canonical.reasoning.some((r) => r.text)) {
      message.reasoning_content = canonical.reasoning.map((r) => r.text || "").join("");
    }
    if (canonical.toolCalls && canonical.toolCalls.length) {
      message.tool_calls = canonical.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }));
    }
    const finishReason = canonical.stopReason === "tool" ? "tool_calls" : canonical.stopReason === "length" ? "length" : "stop";
    return {
      id: canonical.id || newId("chatcmpl"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: canonical.model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: canonical.usage.inputTokens,
        completion_tokens: canonical.usage.outputTokens,
        total_tokens: canonical.usage.inputTokens + canonical.usage.outputTokens,
      },
    };
  },

  createFrameWriter() {
    return new ChatFrameWriter();
  },
};

class ChatFrameWriter {
  constructor() {
    this.id = newId("chatcmpl");
    this.created = Math.floor(Date.now() / 1000);
    this.started = false;
    this.finished = false;
    this.usage = null;
  }
  chunk(delta, finishReason = null) {
    return `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model || "", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  }
  push(event) {
    if (event.type === "start") {
      this.started = true;
      this.model = event.model || "";
      return [this.chunk({ role: "assistant", content: "" })];
    }
    if (event.type === "text_delta") return [this.chunk({ content: event.delta })];
    if (event.type === "reasoning_delta") return [this.chunk({ reasoning_content: event.delta })];
    if (event.type === "tool_start") {
      return [this.chunk({ tool_calls: [{ index: event.index, id: event.id, type: "function", function: { name: event.name, arguments: "" } }] })];
    }
    if (event.type === "tool_delta") {
      return [this.chunk({ tool_calls: [{ index: event.index, function: { arguments: event.delta } }] })];
    }
    if (event.type === "end") {
      this.finished = true;
      const frames = [this.chunk({}, event.stopReason === "tool" ? "tool_calls" : event.stopReason === "length" ? "length" : "stop")];
      const usage = event.usage;
      if (usage) {
        frames.push(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model || "", choices: [], usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens } })}\n\n`);
      }
      frames.push("data: [DONE]\n\n");
      return frames;
    }
    if (event.type === "error") {
      // chat 流内无标准错误事件，降级为终止帧
      this.finished = true;
      return [this.chunk({}, "stop"), "data: [DONE]\n\n"];
    }
    return [];
  }
  finish() {
    if (this.finished || !this.started) return this.started ? [] : [];
    this.finished = true;
    return [this.chunk({}, "stop"), "data: [DONE]\n\n"];
  }
}

// ==================== OpenAI Responses 入站 ====================

// responses 的 content 块：input_text / output_text / input_image / input_file
const responsesContentBlocks = (content) => {
  const blocks = [];
  if (typeof content === "string") {
    if (content) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const c of content) {
    if (typeof c === "string") {
      if (c) blocks.push({ type: "text", text: c });
      continue;
    }
    if (!c || typeof c !== "object") continue;
    if (c.type === "input_image" || c.type === "image_url") {
      const raw = c.image_url !== undefined ? c.image_url : c.image;
      const url = typeof raw === "string" ? raw : raw && raw.url;
      if (!url) continue;
      const parsed = parseDataUrl(url);
      const media = parsed ? mediaBlock("image", parsed.mediaType, { data: parsed.data }) : mediaBlock("image", c.media_type || "image/*", { url });
      if (media) blocks.push(media);
    } else if (c.type === "input_file") {
      const media = mediaBlock("file", c.mime_type || "application/octet-stream", { data: c.file_data, url: c.file_url, name: c.filename });
      if (media) blocks.push(media);
    } else if (typeof c.text === "string" && c.text) {
      blocks.push({ type: "text", text: c.text }); // input_text / output_text / text 等一切文本块
    }
  }
  return blocks;
};

const responsesSource = {
  key: "responses",
  contentType: "application/json",

  parseRequest(body, model) {
    const canonical = {
      model,
      instructions: typeof body.instructions === "string" ? body.instructions : "",
      input: [],
      tools: [],
      toolChoice: mapToolChoiceToCanonical(body.tool_choice),
      maxTokens: body.max_output_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      stop: undefined,
      stream: !!body.stream,
      reasoning: body.reasoning && (body.reasoning.effort || body.reasoning.max_tokens)
        ? resolveReasoning({ effort: body.reasoning.effort, maxTokens: body.reasoning.max_tokens })
        : null,
      format: normalizeFormat(body.text && body.text.format),
    };
    const systemParts = [];
    // input 三种合法形态：字符串、item 数组（easy input message / 上一轮 output 项）、单个对象
    const items = [];
    if (typeof body.input === "string") items.push({ role: "user", content: body.input });
    else if (Array.isArray(body.input)) items.push(...body.input);
    else if (body.input && typeof body.input === "object") items.push(body.input);
    for (const item of items) {
      if (typeof item === "string") {
        if (item.trim()) canonical.input.push({ role: "user", content: [{ type: "text", text: item }] });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      if (item.type === "function_call") {
        if (!item.name) continue;
        canonical.input.push({ role: "assistant", content: [{ type: "tool_use", id: item.call_id || item.id || newId("call"), name: item.name, arguments: item.arguments || "{}" }] });
      } else if (item.type === "function_call_output") {
        if (!item.call_id) continue;
        const outputBlocks = responsesContentBlocks(item.output);
        const content = outputBlocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        const images = outputBlocks.filter((b) => b.type === "media");
        canonical.input.push({
          role: "user",
          content: [{ type: "tool_result", callId: item.call_id, content: typeof item.output === "string" ? item.output : content, ...(images.length ? { images } : {}) }],
        });
      } else if (item.type === "message" || item.role !== undefined || item.content !== undefined) {
        // 标准 message 项或 easy input message（无 type，仅 role+content，Codex 等客户端的标准发法）
        const role = item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? "system" : "user";
        const blocks = responsesContentBlocks(item.content);
        if (role === "system") {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) systemParts.push(t);
        } else if (blocks.length) {
          canonical.input.push({ role, content: blocks });
        }
      } else if ((item.type === "input_text" || item.type === "text" || item.type === "output_text") && typeof item.text === "string" && item.text) {
        // 裸文本块项（无 role/content）：input_text/text 视作用户消息，output_text 视作助手消息
        canonical.input.push({ role: item.type === "output_text" ? "assistant" : "user", content: [{ type: "text", text: item.text }] });
      }
      // reasoning / web_search_call / file_search_call 等项 v1 忽略（推理状态由上游自管）
    }
    if (systemParts.length) canonical.instructions = [canonical.instructions, ...systemParts].filter(Boolean).join("\n\n");
    if (Array.isArray(body.tools)) {
      canonical.tools = body.tools.map(normalizeTool).filter(Boolean);
    }
    return canonical;
  },

  formatResponse(canonical) {
    const output = [];
    if (canonical.reasoning && canonical.reasoning.some((r) => r.text)) {
      output.push({ type: "reasoning", id: newId("rs"), summary: [], content: [{ type: "reasoning_text", text: canonical.reasoning.map((r) => r.text || "").join("") }] });
    }
    if (canonical.text) {
      output.push({ type: "message", id: newId("msg"), status: "completed", role: "assistant", content: [{ type: "output_text", text: canonical.text, annotations: [] }] });
    }
    for (const tc of canonical.toolCalls || []) {
      output.push({ type: "function_call", id: newId("fc"), call_id: tc.id, name: tc.name, arguments: tc.arguments, status: "completed" });
    }
    return {
      id: canonical.id || newId("resp"),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: canonical.stopReason === "length" ? "incomplete" : "completed",
      incomplete_details: canonical.stopReason === "length" ? { reason: "max_output_tokens" } : undefined,
      model: canonical.model,
      output,
      output_text: canonical.text || "",
      usage: {
        input_tokens: canonical.usage.inputTokens,
        output_tokens: canonical.usage.outputTokens,
        total_tokens: canonical.usage.inputTokens + canonical.usage.outputTokens,
      },
    };
  },

  createFrameWriter() {
    return new ResponsesFrameWriter();
  },
};

// Responses 流：以 output_item 为主线，文本走 output_text.delta，函数调用走 function_call_arguments.delta
class ResponsesFrameWriter {
  constructor() {
    this.id = newId("resp");
    this.createdAt = Math.floor(Date.now() / 1000);
    this.started = false;
    this.finished = false;
    this.items = []; // { type, id, callId, name, args, text, open }
    this.model = "";
  }
  ev(name, data) {
    // OpenAI SDK / pi 等客户端按 data.type 分发事件（不只看 SSE event 行），必须带上
    return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  }
  responseBase(status, output) {
    return { id: this.id, object: "response", created_at: this.createdAt, model: this.model, status, output };
  }
  closeTextPart(item, outputIndex) {
    const frames = [];
    frames.push(this.ev("response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text: item.text }));
    frames.push(this.ev("response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: item.text, annotations: [] } }));
    frames.push(this.ev("response.output_item.done", { output_index: outputIndex, item: { type: "message", id: item.id, status: "completed", role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }] } }));
    item.open = false;
    return frames;
  }
  closeFunctionItem(item, outputIndex) {
    item.open = false;
    return [this.ev("response.output_item.done", { output_index: outputIndex, item: { type: "function_call", id: item.id, call_id: item.callId, name: item.name, arguments: item.args, status: "completed" } })];
  }
  push(event) {
    if (event.type === "start") {
      this.started = true;
      this.model = event.model || "";
      return [this.ev("response.created", { response: this.responseBase("in_progress", []) })];
    }
    if (event.type === "text_delta") {
      let item = this.items.find((i) => i.type === "message" && i.open);
      const frames = [];
      if (!item) {
        this.closeOpenItems(frames);
        const outputIndex = this.items.length;
        item = { type: "message", id: newId("msg"), text: "", open: true };
        this.items.push(item);
        frames.push(this.ev("response.output_item.added", { output_index: outputIndex, item: { type: "message", id: item.id, status: "in_progress", role: "assistant", content: [] } }));
        frames.push(this.ev("response.content_part.added", { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
      }
      const outputIndex = this.items.indexOf(item);
      item.text += event.delta;
      frames.push(this.ev("response.output_text.delta", { item_id: item.id, output_index: outputIndex, content_index: 0, delta: event.delta }));
      return frames;
    }
    if (event.type === "tool_start") {
      const frames = [];
      this.closeOpenItems(frames);
      const outputIndex = this.items.length;
      const item = { type: "function_call", id: newId("fc"), callId: event.id, name: event.name, args: "", open: true };
      this.items.push(item);
      frames.push(this.ev("response.output_item.added", { output_index: outputIndex, item: { type: "function_call", id: item.id, call_id: item.callId, name: item.name, arguments: "", status: "in_progress" } }));
      return frames;
    }
    if (event.type === "tool_delta") {
      const item = [...this.items].reverse().find((i) => i.type === "function_call" && i.open);
      if (!item) return [];
      const outputIndex = this.items.indexOf(item);
      item.args += event.delta;
      return [this.ev("response.function_call_arguments.delta", { item_id: item.id, output_index: outputIndex, delta: event.delta })];
    }
    if (event.type === "end" || event.type === "error") {
      return this.complete(event.type === "error" ? "failed" : event.stopReason === "length" ? "incomplete" : "completed", event.usage);
    }
    return [];
  }
  closeOpenItems(frames) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!item.open) continue;
      const outputIndex = this.items.indexOf(item);
      if (item.type === "message") frames.push(...this.closeTextPart(item, outputIndex));
      else frames.push(...this.closeFunctionItem(item, outputIndex));
    }
  }
  complete(status, usage) {
    if (this.finished) return [];
    this.finished = true;
    const frames = [];
    this.closeOpenItems(frames);
    const output = this.items.map((item) => {
      if (item.type === "message") {
        return { type: "message", id: item.id, status: "completed", role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }] };
      }
      return { type: "function_call", id: item.id, call_id: item.callId, name: item.name, arguments: item.args, status: "completed" };
    });
    frames.push(this.ev("response.completed", { response: { ...this.responseBase(status, output), usage: { input_tokens: (usage && usage.inputTokens) || 0, output_tokens: (usage && usage.outputTokens) || 0, total_tokens: ((usage && usage.inputTokens) || 0) + ((usage && usage.outputTokens) || 0) } } }));
    return frames;
  }
  finish() {
    if (this.finished || !this.started) return [];
    return this.complete("completed", null);
  }
}

// ==================== 注册表 ====================

const SOURCES = { anthropic: anthropicSource, chat: chatSource, responses: responsesSource };

const getSource = (key) => SOURCES[key] || null;

// canonical stopReason → 各入站协议的取值（formatResponse 用，这里集中暴露便于复用）
const stopFromCanonical = { anthropic: stopFromAnthropicReason, chat: stopFromFinishReason };

const safeParseArguments = (text) => {
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" ? v : {};
  } catch (e) {
    return {};
  }
};

module.exports = { getSource, SOURCES, mapToolChoiceToCanonical, safeParseArguments };
