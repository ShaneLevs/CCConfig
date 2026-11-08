// 统计口径（前端唯一实现）：把一天的 models 明细摊成「含缓存输入 / 输出 / 总量」。
//
// 背景：CCConfig 的统一口径是
//   day.tokens            = 输入（含缓存） + 输出
//   day.inputTokens       = tokens - outputTokens（含缓存输入）
//   day.models[].inputTokens = 该模型的**未缓存**输入（缓存单列在 cacheRead/cacheCreation）
// 但历史落库文档（升级前写入的 Codex 档）里的 models[].inputTokens 是**已含缓存**的协议原生值
// （Codex 的 input_tokens 包含 cached_input_tokens）。此时再叠加 cache 会让模型总量比当天总量
// 大出一个数量级 —— 判据就是「叠加后是否超过当天总量」，超过说明它本来就含缓存。
//
// dayTotal 传当天的 day.tokens；传 0 时不做判定，按未缓存输入处理（与落库口径一致）。
export const modelTokensOf = (modelData, dayTotal) => {
  const raw = (modelData && modelData.inputTokens) || 0;
  const cacheRead = (modelData && modelData.cacheReadTokens) || 0;
  const cacheCreation = (modelData && modelData.cacheCreationTokens) || 0;
  const output = (modelData && modelData.outputTokens) || 0;
  const withCache = raw + cacheRead + cacheCreation;
  // 已经含缓存时，再叠加缓存必然超出当天总量；留一点容差给上游自报不一致的极端情况
  const alreadyIncludesCache = dayTotal > 0 && withCache + output > dayTotal;
  const input = alreadyIncludesCache ? raw : withCache;
  return {
    input,                 // 含缓存输入（页面「输入」列 / 模型维度重算都用它）
    output,
    cacheRead,
    cacheCreation,
    cache: cacheRead + cacheCreation,
    tokens: input + output,
  };
};
