// 模型预设匹配：不依赖 Vue / 网络，供各模型弹窗和测试复用。
// 输入是用户填写的模型 ID，输出是预设表中最匹配的一条记录。
const CONTEXT_HINT_RE = /\[\s*(\d+(?:\.\d+)?)\s*(k|m)\s*\]/gi;

// 允许出现在预设 ID 后面的“版本/日期/渠道”类 token。
// 不在这里的后缀（例如 gpt-5.4-turbo 的 turbo）不参与匹配，避免把未知变体误判成基础模型。
const ALLOWED_SUFFIX_TOKENS = new Set([
  "latest",
  "preview",
  "beta",
  "exp",
  "experimental",
  "thinking",
  "nonthinking",
  "free",
  "online",
  "instruct",
  "chat",
  "v",
  "1m",
  "200k",
  "400k",
  "600k",
  "1k",
]);

// 拆成纯字母 / 纯数字 token：claude-sonnet-4.5、claude_sonnet_4_5、claude-sonnet-4-5
// 都会得到 [claude, sonnet, 4, 5]；qwen3.5-plus 会得到 [qwen, 3, 5, plus]。
export const tokenizeModelId = (value) =>
  String(value || "").toLowerCase().match(/[a-z]+|\d+/g) || [];

const stripContextHints = (value) => String(value || "").replace(CONTEXT_HINT_RE, " ");

export const extractContextHint = (value) => {
  const matches = [...String(value || "").matchAll(CONTEXT_HINT_RE)];
  if (matches.length === 0) return null;
  let result = null;
  for (const match of matches) {
    const size = Number(match[1]) * (match[2].toLowerCase() === "m" ? 1_000_000 : 1_000);
    if (Number.isFinite(size) && (!result || size > result)) result = size;
  }
  return result;
};

const suffixIsAllowed = (tokens, from) => {
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^\d+$/.test(token)) continue;
    if (/^v\d*$/.test(token)) continue;
    if (ALLOWED_SUFFIX_TOKENS.has(token)) continue;
    return false;
  }
  return true;
};

const makeResult = (entry, confidence, matchedInput, contextHint) => ({
  preset: entry.model,
  confidence,
  matchedKey: entry.key,
  matchedInput,
  contextWindowOverride: contextHint,
});

// models 为 modelPresets.json 的 models 数组；返回 findModelPreset(modelId)。
export const createModelPresetMatcher = (models) => {
  const entries = [];
  const exact = new Map();

  for (const model of models || []) {
    if (!model || !model.id) continue;
    const keys = [model.id, ...(Array.isArray(model.aliases) ? model.aliases : [])];
    for (const key of keys) {
      if (!key) continue;
      const entry = { model, key, tokens: tokenizeModelId(key) };
      entries.push(entry);
      const lower = String(key).toLowerCase();
      if (!exact.has(lower)) exact.set(lower, entry);
    }
  }

  // 长 ID 优先，确保 gpt-5.4-mini 不会被 gpt-5.4 抢先匹配。
  entries.sort(
    (a, b) => b.tokens.length - a.tokens.length || String(a.key).length - String(b.key).length,
  );

  return (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return null;

    const exactEntry = exact.get(raw);
    if (exactEntry) {
      const isId = String(exactEntry.key).toLowerCase() === String(exactEntry.model.id).toLowerCase();
      return makeResult(exactEntry, isId ? "exact" : "alias", raw, extractContextHint(raw));
    }

    const contextHint = extractContextHint(raw);
    const cleaned = stripContextHints(raw);
    const tokens = tokenizeModelId(cleaned);
    if (tokens.length === 0) return null;

    let bestLength = 0;
    let bestEntries = [];
    for (const entry of entries) {
      const length = entry.tokens.length;
      if (length === 0 || length < bestLength) continue;
      for (let start = 0; start + length <= tokens.length; start += 1) {
        let matched = true;
        for (let offset = 0; offset < length; offset += 1) {
          if (tokens[start + offset] !== entry.tokens[offset]) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        if (!suffixIsAllowed(tokens, start + length)) continue;
        if (length > bestLength) {
          bestLength = length;
          bestEntries = [entry];
        } else if (length === bestLength) {
          bestEntries.push(entry);
        }
      }
    }

    const unique = [];
    const seen = new Set();
    for (const entry of bestEntries) {
      if (!entry || seen.has(entry.model.id)) continue;
      seen.add(entry.model.id);
      unique.push(entry);
    }
    if (unique.length === 0) return null;
    if (unique.length > 1) {
      return {
        ambiguous: true,
        candidates: unique.map((entry) => entry.model),
        contextWindowOverride: contextHint,
      };
    }

    const entry = unique[0];
    const normalizedExact =
      tokens.length === entry.tokens.length &&
      tokens.every((token, index) => token === entry.tokens[index]);
    return makeResult(
      entry,
      normalizedExact ? "normalized" : "token",
      raw,
      contextHint,
    );
  };
};

export const getPresetValues = (preset, contextWindowOverride = null) => ({
  name: preset.name || "",
  contextWindow: contextWindowOverride || Number(preset.contextWindow) || 0,
  maxInputTokens: Number(preset.maxInputTokens) || 0,
  maxTokens: Number(preset.maxTokens) || 0,
  input: Array.isArray(preset.input) ? [...preset.input] : ["text"],
  output: Array.isArray(preset.output) ? [...preset.output] : ["text"],
  reasoning: !!preset.reasoning,
  reasoningEfforts: Array.isArray(preset.reasoningEfforts) ? [...preset.reasoningEfforts] : [],
  reasoningBudget: preset.reasoningBudget ? { ...preset.reasoningBudget } : null,
  reasoningToggle: !!preset.reasoningToggle,
  capabilities: Array.isArray(preset.capabilities) ? [...preset.capabilities] : [],
  cost: preset.cost
    ? {
        input: Number(preset.cost.input) || 0,
        output: Number(preset.cost.output) || 0,
        cacheRead: Number(preset.cost.cacheRead) || 0,
        cacheWrite: Number(preset.cost.cacheWrite) || 0,
      }
    : null,
  free: !!preset.free,
});
