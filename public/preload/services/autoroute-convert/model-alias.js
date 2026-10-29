// 自动网关 · 响应 model 字段改写（仅映射模式）
// 网关只在「请求」方向做映射：入站 model=映射名 → 出站 model=真实模型 ID（autoroute.js 的
// resolveRoute + 重写 body）。响应方向原本原样透传上游，于是 agent 看到的 model 是上游真实模型名，
// 而 agent 会把它记进自己的会话记录（Claude Code 的 assistant.message.model、Grok Build 的
// usage.json modelUsage 键等），各 agent 的使用统计页读的正是这些记录 → 统计里显示真实模型名，
// 与 /v1/models 暴露的映射名对不上。这里把响应的 model 改写成映射名，让客户端/统计口径一致。
//
// 只改这三处结构化位置（正文文本里的 "model" 字样不会被误改）：
//   顶层 model        → OpenAI Chat 响应与 chunk、Anthropic 非流式响应、Responses 非流式响应
//   message.model     → Anthropic SSE message_start
//   response.model    → OpenAI Responses 事件（response.created / in_progress / completed / failed）
//
// 开关：网关配置 rewriteModel（默认开）。关掉即恢复「响应原样透传」，用于某些客户端按响应模型名
// 推断上下文窗口 / 定价（映射名不在其内置表里时会退化成默认值）时自救。

const MODEL_SLOTS = [
  (obj) => obj,
  (obj) => (obj.message && typeof obj.message === "object" ? obj.message : null),
  (obj) => (obj.response && typeof obj.response === "object" ? obj.response : null),
];

// 就地改写单个对象里的 model；返回是否有改动
const rewriteModelInObject = (obj, displayModel) => {
  if (!displayModel || !obj || typeof obj !== "object") return false;
  let changed = false;
  for (const pick of MODEL_SLOTS) {
    const holder = pick(obj);
    if (!holder) continue;
    if (typeof holder.model !== "string" || !holder.model || holder.model === displayModel) continue;
    holder.model = displayModel;
    changed = true;
  }
  return changed;
};

// 非流式响应体（整段 JSON）→ 改写后的文本；解析失败 / 非对象 / 没有 model 位置时原样返回
const rewriteJsonModel = (text, displayModel) => {
  if (!displayModel || typeof text !== "string" || !text) return text;
  const head = text.trimStart()[0];
  if (head !== "{" && head !== "[") return text; // 非 JSON（错误页 / 空体）不碰
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return text;
  }
  let changed = false;
  if (Array.isArray(parsed)) {
    for (const item of parsed) if (rewriteModelInObject(item, displayModel)) changed = true;
  } else {
    changed = rewriteModelInObject(parsed, displayModel);
  }
  return changed ? JSON.stringify(parsed) : text;
};

// SSE 分片改写器：上游 chunk 可能切在行中间，这里按行缓冲，只处理 data: 行，
// 其余行（event: / id: / 注释 / 空行）与行尾的 \r 原样保留。
const createSseModelRewriter = (displayModel) => {
  let pending = "";
  const rewriteLine = (line) => {
    const hasCr = line.endsWith("\r");
    const body = hasCr ? line.slice(0, -1) : line;
    const cr = hasCr ? "\r" : "";
    if (!body.startsWith("data:")) return line;
    const payload = body.slice(5).trim();
    if (!payload || payload === "[DONE]" || payload[0] !== "{") return line;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch (e) {
      return line; // 跨 data 行拼出来的 JSON / 非法帧：不冒险改，原样转发
    }
    if (!rewriteModelInObject(obj, displayModel)) return line;
    return `data: ${JSON.stringify(obj)}${cr}`;
  };
  return {
    // 喂入一个上游文本分片，返回可以写给客户端的完整行（可能为空串）
    push(chunk) {
      if (typeof chunk !== "string" || !chunk) return "";
      pending += chunk;
      const lastBreak = pending.lastIndexOf("\n");
      if (lastBreak < 0) return "";
      const head = pending.slice(0, lastBreak);
      pending = pending.slice(lastBreak + 1);
      return head.split("\n").map(rewriteLine).join("\n") + "\n";
    },
    // 流结束时把没有换行收尾的残行吐出来
    flush() {
      const rest = pending ? rewriteLine(pending) : "";
      pending = "";
      return rest;
    },
  };
};

module.exports = { rewriteModelInObject, rewriteJsonModel, createSseModelRewriter };
