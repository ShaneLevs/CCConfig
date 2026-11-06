// 网关实时输出速率：流式协议通常只在最后返回 output_tokens，无法直接据此展示实时 TPS。
// 这里按流中的文本 / 推理 / 工具参数增量估算 token，并用短滑动窗口汇总所有并发流；
// 最终 usage 统计仍使用上游返回的精确值。
// 估算只用于 UI，不能写回 usage 统计，否则会和上游精确值重复计数。

const RATE_WINDOW_MS = 1000;
const MIN_RATE_SPAN_MS = 200;

// ASCII 按约 4 字符 / token，CJK 与其它非 ASCII 字符按 1 token 估算。
const estimateTokenCount = (value) => {
  if (typeof value !== "string" || !value) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of value) {
    if (char.codePointAt(0) <= 0x7f) ascii += 1;
    else wide += 1;
  }
  return wide + ascii / 4;
};

const contentTokenCount = (value) => {
  if (typeof value === "string") return estimateTokenCount(value);
  if (!Array.isArray(value)) return 0;
  return value.reduce((sum, item) => {
    if (typeof item === "string") return sum + estimateTokenCount(item);
    if (!item || typeof item !== "object") return sum;
    if (typeof item.text === "string") return sum + estimateTokenCount(item.text);
    if (typeof item.content === "string") return sum + estimateTokenCount(item.content);
    return sum;
  }, 0);
};

// 跨协议转换路径产出 canonical 事件。
const outputTokenDeltaFromCanonical = (event) => {
  if (!event) return 0;
  if (event.type === "text_delta" || event.type === "reasoning_delta" || event.type === "tool_delta") {
    return estimateTokenCount(event.delta);
  }
  return 0;
};

const chatDeltaTokens = (delta) => {
  if (!delta || typeof delta !== "object") return 0;
  let tokens = contentTokenCount(delta.content) +
    contentTokenCount(delta.reasoning_content) +
    contentTokenCount(delta.reasoning);
  if (delta.function_call && typeof delta.function_call.arguments === "string") {
    tokens += estimateTokenCount(delta.function_call.arguments);
  }
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    if (call && call.function && typeof call.function.arguments === "string") {
      tokens += estimateTokenCount(call.function.arguments);
    }
  }
  return tokens;
};

// SSE data JSON → 本次事件新增输出 token。兼容三种出站协议，只读取增量字段。
const outputTokenDeltaFromSseData = (payload) => {
  if (!payload || typeof payload !== "object") return 0;
  const type = payload.type || "";
  if (type === "content_block_delta") {
    const delta = payload.delta || {};
    if (delta.type === "text_delta") return estimateTokenCount(delta.text);
    if (delta.type === "thinking_delta") return estimateTokenCount(delta.thinking);
    if (delta.type === "input_json_delta") return estimateTokenCount(delta.partial_json);
    return 0;
  }
  if (type === "response.output_text.delta") return estimateTokenCount(payload.delta);
  if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    return estimateTokenCount(payload.delta);
  }
  if (type === "response.function_call_arguments.delta") return estimateTokenCount(payload.delta);

  let tokens = 0;
  for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
    tokens += chatDeltaTokens(choice && choice.delta);
  }
  return tokens;
};

// 原样透传流没有 canonical 事件，按完整 SSE 帧旁路解析 data JSON。
const createSseOutputTokenProbe = (onTokens) => {
  let buffer = "";
  let dataLines = [];
  let flushed = false;
  const emit = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      const tokens = outputTokenDeltaFromSseData(JSON.parse(data));
      if (tokens > 0 && typeof onTokens === "function") onTokens(tokens);
    } catch (e) {
      /* 非 JSON / 异常帧不参与实时估算，转发与 usage 统计不受影响 */
    }
  };
  const consumeLine = (line) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text) {
      emit();
      return;
    }
    if (text.startsWith(":")) return;
    if (text.startsWith("data:")) dataLines.push(text.slice(5).replace(/^ /, ""));
  };
  return {
    push(text) {
      if (!text || flushed) return;
      buffer += text;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        consumeLine(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    },
    flush() {
      if (flushed) return;
      flushed = true;
      if (buffer) consumeLine(buffer);
      buffer = "";
      emit();
    },
  };
};

// 所有并发流共享采样表。按最近一秒内收到的输出量计算 TPS；
// 首个样本滑出后只保留它作下一次分片的时间基准。
const createOutputRateMeter = () => {
  const samples = [];
  let total = 0;
  let lastRate = 0;
  const prune = (now) => {
    const cutoff = now - RATE_WINDOW_MS;
    // 保留一个已滑出窗口的样本作为下一次恢复输出的时间基准。
    while (samples.length > 1 && samples[0].time < cutoff) total -= samples.shift().tokens;
  };
  return {
    record(tokens, now = Date.now()) {
      const value = Number(tokens);
      if (!(value > 0)) return;
      prune(now);
      samples.push({ time: now, tokens: value });
      total += value;
    },
    rate(now = Date.now()) {
      prune(now);
      if (!samples.length) return lastRate;
      const latest = samples[samples.length - 1].time;
      const expired = samples.length > 1 && samples[0].time < now - RATE_WINDOW_MS;
      const oldest = expired ? samples[1] : samples[0];
      if (now - latest >= RATE_WINDOW_MS) return lastRate;
      if (latest - oldest.time > RATE_WINDOW_MS) return total - (expired ? samples[0].tokens : 0);
      const windowTokens = total - (expired ? samples[0].tokens : 0);
      const span = latest - oldest.time;
      lastRate = span < MIN_RATE_SPAN_MS ? (windowTokens * 1000) / MIN_RATE_SPAN_MS : (windowTokens * 1000) / span;
      return lastRate;
    },
    reset() {
      samples.length = 0;
      total = 0;
      lastRate = 0;
    },
  };
};

module.exports = {
  estimateTokenCount,
  outputTokenDeltaFromCanonical,
  outputTokenDeltaFromSseData,
  createSseOutputTokenProbe,
  createOutputRateMeter,
};
