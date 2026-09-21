// 通用配置主数据 → 各 Agent 模型配置下发
// 把通用库（uTools DB）中的 provider + model 写入 8 个 agent 的模型配置：
//   claude   → ~/.claude/settings.json  env（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL）
//   opencode → ~/.config/opencode.json(.jsonc)  provider[id]（options.baseURL/apiKey + models[id]）
//   pi       → ~/.pi/agent/models.json  providers[name] + settings.json（可选默认）
//   omp      → ~/.omp/agent/models.yml  providers[name]（无默认模型概念，modelRoles 由用户自行配置）
//   reasonix → ~/.reasonix/config.toml  providers[] + .env（可选 default_model）
//   codex    → ~/.codex/config.toml  [model_providers.<id>] + 顶层 model_provider/model（可选默认）
//   kimi     → ~/.kimi-code/config.toml  [providers.<name>] + [models."<name>/<id>"] + default_model（可选默认）
//   minimax  → ~/.minimax/config.yaml  custom_provider.<key>（API 格式与通用库协议同名）+ models.<id> + defaultModel（可选默认）
// 全部为纯文件/DB 写入，不依赖 agent 二进制；每个目标独立 try/catch，单个失败不影响其他目标。
// Claude 特殊：下发写入 uTools DB 保存配置（一个 provider 一份，Claude 配置页可见），不直接改 settings.json
const crypto = require('./crypto')
const opencode = require('./opencode')
const pi = require('./pi')
const omp = require('./omp')
const reasonix = require('./reasonix')
const codex = require('./codex')
const kimi = require('./kimi')
const minimax = require('./minimax')
const autoroute = require('./autoroute')

// cost 规范化（与 pi/omp 一致：全 0 省略，Pi schema 约定 0 无效）
const normalizeCost = (cost) => {
  if (!cost || typeof cost !== 'object') return undefined
  const c = {
    input: Number(cost.input) || 0,
    output: Number(cost.output) || 0,
    cacheRead: Number(cost.cacheRead) || 0,
    cacheWrite: Number(cost.cacheWrite) || 0,
  }
  if (!c.input && !c.output && !c.cacheRead && !c.cacheWrite) return undefined
  return c
}

// ==================== 各 Agent 写入实现 ====================

// Pi / omp 模型条目写入（数组按 id 匹配）：新建直接 push；已存在则合并更新——
// 与 OpenCode / MiniMax 下发语义对齐：通用库「非空才覆盖、空值不清旧」，
// 通用库没有的字段（本地手加键、compat 未下发子键等）原样保留。
// 返回 'added' | 'updated' 供结果文案区分。
const upsertDispatchModel = (list, model) => {
  const hasCompat = model.compat && typeof model.compat === 'object' && Object.keys(model.compat).length
  const idx = list.findIndex(m => m && m.id === model.id)
  if (idx === -1) {
    const cost = normalizeCost(model.cost)
    const entry = {
      id: model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow || undefined,
      maxTokens: model.maxTokens || undefined,
      reasoning: !!model.reasoning,
      input: model.input || ['text'],
    }
    if (cost) entry.cost = cost
    if (hasCompat) entry.compat = model.compat
    list.push(entry)
    return 'added'
  }
  const prev = list[idx]
  const next = { ...prev }
  if (model.name) next.name = model.name
  const context = Number(model.contextWindow) || 0
  const output = Number(model.maxTokens) || 0
  if (context) next.contextWindow = context
  if (output) next.maxTokens = output
  if (model.reasoning) next.reasoning = true
  if (Array.isArray(model.input) && model.input.length) next.input = [...model.input]
  const cost = normalizeCost(model.cost)
  if (cost) next.cost = cost
  if (hasCompat) next.compat = { ...(prev.compat && typeof prev.compat === 'object' ? prev.compat : {}), ...model.compat }
  list[idx] = next
  return 'updated'
}

// Claude Code：下发 = 在 uTools DB 保存一份「以 provider 命名」的配置（ccswitch_config_dispatch_<provider>），
// 与 Claude 配置页的配置列表互通（切换时由 useConfigSwitch 写入 settings.json）。
// 一个 provider 一份配置；模型自动填入空闲槽位（默认 → Haiku → Sonnet → Opus → Subagent），
// 已有同模型跳过，5 个槽位全满时报错提示（不覆盖已有模型）。
// 仅接受 anthropic-messages 协议的供应商（激活后写入 ANTHROPIC_* env，其余协议不可用）。
const DB_PREFIX = 'ccswitch_config_'
const DISPATCH_DB_PREFIX = DB_PREFIX + 'dispatch_'
const CLAUDE_MODEL_SLOTS = ['model', 'defaultHaikuModel', 'defaultSonnetModel', 'defaultOpusModel', 'subagentModel']
const CLAUDE_SLOT_LABELS = { model: '默认模型', defaultHaikuModel: 'Haiku', defaultSonnetModel: 'Sonnet', defaultOpusModel: 'Opus', subagentModel: 'Subagent' }

const dispatchToClaude = (provider, model) => {
  if ((provider.api || 'openai-completions') !== 'anthropic-messages') {
    throw new Error(`供应商「${provider.name}」协议为 ${provider.api || 'openai-completions'}，仅 Anthropic Messages 协议供应商可下发 Claude Code`)
  }
  const docId = DISPATCH_DB_PREFIX + provider.name
  let doc = null
  try { doc = window.utools.db.get(docId) } catch (e) { /* ignore */ }
  const now = Date.now()
  const next = doc
    ? { ...doc }
    : {
        _id: docId,
        name: provider.name,
        key: '',
        authVar: 'ANTHROPIC_AUTH_TOKEN',
        baseUrl: '',
        model: '',
        defaultHaikuModel: '',
        defaultSonnetModel: '',
        defaultOpusModel: '',
        subagentModel: '',
        extraFields: [],
        updatedAt: now,
      }
  // provider 信息：非空才覆盖，避免清空已有配置
  if (provider.apiKey) next.key = crypto.encrypt(provider.apiKey)
  if (provider.baseUrl) next.baseUrl = provider.baseUrl
  next.authVar = 'ANTHROPIC_AUTH_TOKEN'
  next.updatedAt = now
  // 模型槽位：已有同模型跳过；否则填第一个空槽位；全满报错
  if (CLAUDE_MODEL_SLOTS.some(s => next[s] === model.id)) {
    return `Claude 配置「${provider.name}」中已有模型 ${model.id}`
  }
  const slot = CLAUDE_MODEL_SLOTS.find(s => !next[s])
  if (!slot) {
    throw new Error(`Claude 配置「${provider.name}」5 个模型槽位已满，请先在 Claude 配置页清理后再下发`)
  }
  next[slot] = model.id
  let res
  try {
    res = window.utools.db.put(next)
  } catch (e) {
    throw new Error(`保存 Claude 配置失败: ${e.message || e}`)
  }
  if (!res || !res.ok) {
    throw new Error('保存 Claude 配置失败' + (res && res.message ? `：${res.message}` : ''))
  }
  return `已写入 Claude 配置「${provider.name}」：${model.id} → ${CLAUDE_SLOT_LABELS[slot]}`
}

// OpenCode：provider[id]（options.baseURL/apiKey）+ models[id]；通用库协议 → opencode npm 包
//（opencode 文档：chat/completions 用 openai-compatible，responses 用 @ai-sdk/openai；Anthropic/Google 用各自 SDK）
const OPENCODE_NPM_BY_API = {
  'openai-completions': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  'anthropic-messages': '@ai-sdk/anthropic',
  'google-generative-ai': '@ai-sdk/google',
}

const dispatchToOpencode = (provider, model, opts) => {
  const id = opts.providerName || provider.name
  const current = opencode.readOpencodeConfig()
  if (!current.provider) current.provider = {}
  const prev = current.provider[id] || {}
  const nextOptions = { ...(prev.options || {}) }
  if (provider.baseUrl) nextOptions.baseURL = provider.baseUrl
  if (provider.apiKey) nextOptions.apiKey = provider.apiKey
  // 接口类型复用：按通用库协议映射 npm；未知协议保留已有值，兜底 openai-compatible
  const nextNpm = OPENCODE_NPM_BY_API[provider.api || 'openai-completions'] || prev.npm || '@ai-sdk/openai-compatible'
  // 模型条目合并写入：保留 opencode 侧已有字段（cost/tool_call 等），透传上下文/最大输出
  const nextModels = { ...(prev.models || {}) }
  const prevModel = nextModels[model.id] || {}
  const nextModel = { ...prevModel, name: model.name || prevModel.name || model.id }
  const context = Number(model.contextWindow) || 0
  const output = Number(model.maxTokens) || 0
  if (context || output) {
    nextModel.limit = { ...(prevModel.limit || {}) }
    if (context) nextModel.limit.context = context
    if (output) nextModel.limit.output = output
  }
  // 推理能力与输入模态透传（通用库 model.reasoning / model.input，值为 opencode modalities 子集；有值才写，不清 opencode 侧已有声明）
  if (model.reasoning) nextModel.reasoning = true
  if (Array.isArray(model.input) && model.input.length) {
    nextModel.modalities = { ...(prevModel.modalities || {}), input: [...model.input] }
  }
  // 费用透传（全 0 省略；opencode 配置为扁平 cache_read/cache_write 键）
  if (model.cost && typeof model.cost === 'object') {
    const c = Number(model.cost.input) || 0, o = Number(model.cost.output) || 0
    const cr = Number(model.cost.cacheRead) || 0, cw = Number(model.cost.cacheWrite) || 0
    if (c || o || cr || cw) {
      nextModel.cost = { input: c, output: o, cache_read: cr, cache_write: cw }
    }
  }
  // 兼容性字段（compat）平铺进模型条目，与 opencode 配置模型可携带自定义字段一致
  if (model.compat && typeof model.compat === 'object') {
    for (const [k, v] of Object.entries(model.compat)) nextModel[k] = v
  }
  nextModels[model.id] = nextModel
  current.provider[id] = {
    ...prev,
    npm: nextNpm,
    name: prev.name || provider.name,
    options: nextOptions,
    models: nextModels,
  }
  if (!opencode.writeOpencodeConfig(current)) throw new Error('写入 opencode 配置失败')
  return `provider[${id}]（${nextNpm.replace('@ai-sdk/', '')}）已更新，模型 ${model.id} 已写入`
}

// Pi Agent：models.json providers[name] + settings.json（可选默认）
const dispatchToPi = (provider, model, opts) => {
  const name = opts.providerName || provider.name
  const models = pi.readPiModels()
  if (!models.providers) models.providers = {}
  const prev = models.providers[name] || {}
  models.providers[name] = {
    ...prev,
    apiKey: provider.apiKey || prev.apiKey || '',
    baseUrl: provider.baseUrl || prev.baseUrl || '',
    api: provider.api || prev.api || 'openai-completions',
    headers: { ...(prev.headers || {}), ...(provider.headers || {}) },
    authHeader: provider.authHeader !== undefined ? !!provider.authHeader : !!prev.authHeader,
    models: Array.isArray(prev.models) ? prev.models : [],
  }
  const list = models.providers[name].models
  const act = upsertDispatchModel(list, model)
  pi.writePiModels(models)
  let suffix = ''
  if (opts.setDefault) {
    const settings = pi.readPiSettings()
    settings.defaultProvider = name
    settings.defaultModel = model.id
    pi.writePiSettings(settings)
    suffix = '，已设为默认模型'
  }
  return `供应商 ${name} 已更新，模型 ${model.id} ${act === 'updated' ? '已合并更新' : '已写入'}${suffix}`
}

// omp：models.yml providers[name]（无默认模型概念，modelRoles 需用户自行配置）
const dispatchToOmp = (provider, model, opts) => {
  const name = opts.providerName || provider.name
  const models = omp.readOmpModels()
  if (!models.providers) models.providers = {}
  const prev = models.providers[name] || {}
  models.providers[name] = {
    ...prev,
    apiKey: provider.apiKey || prev.apiKey || '',
    baseUrl: provider.baseUrl || prev.baseUrl || '',
    api: provider.api || prev.api || 'openai-completions',
    headers: { ...(prev.headers || {}), ...(provider.headers || {}) },
    authHeader: provider.authHeader !== undefined ? !!provider.authHeader : !!prev.authHeader,
    models: Array.isArray(prev.models) ? prev.models : [],
  }
  const list = models.providers[name].models
  const act = upsertDispatchModel(list, model)
  omp.writeOmpModels(models)
  return `供应商 ${name} 已更新，模型 ${model.id} ${act === 'updated' ? '已合并更新' : '已写入'}（默认模型请到 omp 配置页配置 modelRoles）`
}

// Reasonix：config.toml providers[] + .env key + 可选 default_model
const dispatchToReasonix = (provider, model, opts) => {
  const name = opts.providerName || provider.name
  const doc = reasonix.readReasonixConfig()
  if (!Array.isArray(doc.providers)) doc.providers = []
  const prev = doc.providers.find(p => p.name === name)
  const kindMap = {
    'openai-completions': 'openai',
    'openai-responses': 'openai',
    'anthropic-messages': 'anthropic',
    'google-generative-ai': 'google',
  }
  const kind = kindMap[provider.api] || (prev && prev.kind) || 'openai'
  let apiKeyEnv = (prev && prev.api_key_env) || ''
  if (!apiKeyEnv) apiKeyEnv = reasonix.generateReasonixApiKeyEnv(name)
  if (provider.apiKey) reasonix.writeReasonixEnvKey(apiKeyEnv, provider.apiKey)
  // 保留原 provider 的扩展字段（model_overrides / price / extra_body 等）
  const entry = {
    ...(prev || {}),
    name,
    kind,
    ...(provider.baseUrl ? { base_url: provider.baseUrl } : {}),
    api_key_env: apiKeyEnv,
    models: [...(Array.isArray(prev && prev.models) ? prev.models : (prev && prev.model ? [prev.model] : []))],
  }
  delete entry.model // 统一为 models 数组
  if (!entry.models.includes(model.id)) entry.models.push(model.id)
  doc.providers = doc.providers.filter(p => p.name !== name)
  doc.providers.push(entry)
  let suffix = ''
  if (opts.setDefault) {
    doc.default_model = `${name}/${model.id}`
    suffix = '，已设为默认模型'
  }
  reasonix.writeReasonixConfig(doc)
  return `供应商 ${name} 已更新，模型 ${model.id} 已写入${suffix}`
}

// Codex Desktop/CLI：config.toml [model_providers.<id>] + 顶层 model_provider/model。
// 仅支持 OpenAI 系协议（wire_api responses/chat），Anthropic / Google 协议供应商不适用；
// 模型同时进 DB 模型列表（Codex 页快捷切换 / models.json 目录生成的数据源）
const CODEX_WIRE_API = {
  'openai-completions': 'chat',
  'openai-responses': 'responses',
}

const dispatchToCodex = (provider, model, opts) => {
  const id = opts.providerName || provider.name
  const wireApi = CODEX_WIRE_API[provider.api || 'openai-completions']
  if (!wireApi) {
    throw new Error(`供应商「${provider.name}」协议为 ${provider.api}，Codex 仅支持 OpenAI Chat / Responses 协议供应商`)
  }
  codex.upsertCodexProvider(id, {
    name: id,
    baseUrl: provider.baseUrl || '',
    wireApi,
    apiKey: provider.apiKey || '',
  })
  codex.upsertCodexModel(id, model.id)
  let suffix = ''
  if (opts.setDefault) {
    codex.setCodexDefaultModel(id, model.id)
    suffix = '，已设为默认模型'
  }
  return `供应商 ${id} 已更新，模型 ${model.id} 已写入${suffix}`
}

// Kimi Code：config.toml [providers.<name>] + [models."<name>/<id>"] + 可选 default_model。
// 通用库四种协议全部有对应供应商类型，无协议守卫
const KIMI_PROVIDER_TYPE = {
  'openai-completions': 'openai',
  'openai-responses': 'openai_responses',
  'anthropic-messages': 'anthropic',
  'google-generative-ai': 'google-genai',
}

const dispatchToKimi = (provider, model, opts) => {
  const name = opts.providerName || provider.name
  const type = KIMI_PROVIDER_TYPE[provider.api || 'openai-completions'] || 'openai'
  kimi.upsertKimiProvider(name, { type, baseUrl: provider.baseUrl || '', apiKey: provider.apiKey || '' })
  const alias = kimi.upsertKimiModel(name, model.id, { contextWindow: model.contextWindow })
  let suffix = ''
  if (opts.setDefault) {
    kimi.setKimiDefaultModel(alias)
    suffix = '，已设为默认模型'
  }
  return `供应商 ${name} 已更新，模型别名 ${alias} 已写入${suffix}`
}

// MiniMax Code：config.yaml custom_provider.<key>.models.<id> + 可选 defaultModel。
// 三种 API 格式与通用库协议同名（identity 映射），仅 google-generative-ai 不支持需守卫；
// 通用库供应商名可为中文 → providerKeyFor 确定性清洗为 ASCII 键（同名恒同键，upsert 幂等）
const dispatchToMinimax = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  if (!minimax.MINIMAX_API_FORMATS.includes(api)) {
    throw new Error(`供应商「${provider.name}」协议为 ${api}，MiniMax Code 仅支持 OpenAI Chat / Responses / Anthropic Messages 协议`)
  }
  const name = opts.providerName || provider.name
  const key = minimax.providerKeyFor(name)
  minimax.upsertMinimaxProvider(key, { name, api, baseUrl: provider.baseUrl || '', apiKey: provider.apiKey || '' })
  const ref = minimax.upsertMinimaxModel(key, model.id, {
    name: model.name || model.id,
    contextWindow: model.contextWindow,
    outputWindow: model.maxTokens,
    inputTypes: Array.isArray(model.input) ? model.input : undefined,
  })
  let suffix = ''
  if (opts.setDefault) {
    minimax.setMinimaxDefaultModel(ref)
    suffix = '，已设为默认模型'
  }
  const keyNote = key === name ? '' : `（键 ${key}）`
  return `供应商 ${name}${keyNote} 已更新，模型 ${model.id} 已写入${suffix}`
}

// ==================== 自动网关下发 ====================

// 自动网关（autoroute.js）作为虚拟供应商写入各 agent：Claude 目标用 anthropic-messages
//（对外就是 Anthropic 协议端点，可通过协议守卫），其余目标用 openai-completions；
// baseUrl 指向 http://127.0.0.1:<port>，key 为网关随机 key（agent 侧是占位符，网关侧用于鉴权）。
// 供应商名用英文 router：该名字同时用作 Codex 的 model_providers.<id>（TOML ID 仅支持英文，
// 中文名会导致 Codex 侧无法识别）。
const AUTOROUTE_PROVIDER_NAME = "router";
// 历史版本曾以「自动路由」为名下发（中文 ID 不被 Codex 支持），下发成功后顺手清理遗留条目
const LEGACY_AUTOROUTE_NAME = "自动路由";

// 清理某 agent 内遗留的旧「自动路由」供应商条目；被引用为当前/默认供应商时跳过（避免引用悬空）
const cleanupLegacyAutoRoute = (app) => {
  try {
    if (app === "claude") {
      const docId = DISPATCH_DB_PREFIX + LEGACY_AUTOROUTE_NAME;
      const doc = window.utools.db.get(docId);
      if (!doc) return;
      let active = null;
      try { active = window.utools.db.get("ccswitch_active_config_id"); } catch (e) { /* ignore */ }
      if (active && active.configId === docId) return; // 是当前启用的 Claude 配置，不清理
      window.utools.db.remove(docId);
    } else if (app === "opencode") {
      const current = opencode.readOpencodeConfig();
      if (!current.provider || !current.provider[LEGACY_AUTOROUTE_NAME]) return;
      if (typeof current.model === "string" && current.model.startsWith(`${LEGACY_AUTOROUTE_NAME}/`)) return;
      delete current.provider[LEGACY_AUTOROUTE_NAME];
      opencode.writeOpencodeConfig(current);
    } else if (app === "pi") {
      const models = pi.readPiModels();
      if (!models.providers || !models.providers[LEGACY_AUTOROUTE_NAME]) return;
      const settings = pi.readPiSettings();
      if (settings.defaultProvider === LEGACY_AUTOROUTE_NAME) return;
      delete models.providers[LEGACY_AUTOROUTE_NAME];
      pi.writePiModels(models);
    } else if (app === "omp") {
      const models = omp.readOmpModels();
      if (!models.providers || !models.providers[LEGACY_AUTOROUTE_NAME]) return;
      const roles = omp.readOmpModelRoles() || {};
      const referenced = Object.values(roles).some(
        (ref) => typeof ref === "string" && (ref === LEGACY_AUTOROUTE_NAME || ref.startsWith(`${LEGACY_AUTOROUTE_NAME}/`))
      );
      if (referenced) return;
      delete models.providers[LEGACY_AUTOROUTE_NAME];
      omp.writeOmpModels(models);
    } else if (app === "reasonix") {
      const doc = reasonix.readReasonixConfig();
      if (!Array.isArray(doc.providers) || !doc.providers.some((p) => p.name === LEGACY_AUTOROUTE_NAME)) return;
      if (
        doc.default_model === LEGACY_AUTOROUTE_NAME ||
        (typeof doc.default_model === "string" && doc.default_model.startsWith(`${LEGACY_AUTOROUTE_NAME}/`))
      ) return;
      doc.providers = doc.providers.filter((p) => p.name !== LEGACY_AUTOROUTE_NAME);
      reasonix.writeReasonixConfig(doc);
    } else if (app === "codex") {
      // deleteCodexProvider 在条目不存在或它是当前使用供应商时抛错 → 跳过即可
      codex.deleteCodexProvider(LEGACY_AUTOROUTE_NAME);
    } else if (app === "kimi") {
      // 清理旧版本可能下发的中文「自动路由」：其全部模型别名 + 供应商条目；被默认模型引用时跳过
      const kProvs = kimi.getKimiProviderList();
      if (!kProvs.some((p) => p.name === LEGACY_AUTOROUTE_NAME)) return;
      const kAliases = kimi
        .getKimiModelList()
        .filter((m) => m.provider === LEGACY_AUTOROUTE_NAME)
        .map((m) => m.alias);
      if (kAliases.includes(kimi.getKimiDefaultModel())) return;
      kAliases.forEach((a) => kimi.deleteKimiModel(a));
      kimi.deleteKimiProvider(LEGACY_AUTOROUTE_NAME);
    }
  } catch (e) {
    /* 清理失败不影响本次下发 */
  }
};

const dispatchAutoRoute = (targets) => {
  const config = autoroute.readAutoRouteConfig();
  const enabled = autoroute.resolveAutoRouteModels(config);
  if (!enabled.length) throw new Error("请先在通用配置 · 自动网关中勾选要接入网关的模型");
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) throw new Error("请选择目标 agent");
  const models = enabled.map(({ model }) => model);
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const results = [];
  for (const t of list) {
    const d = APP_DISPATCHERS[t && t.app];
    if (!d) {
      results.push({ app: (t && t.app) || "unknown", ok: false, message: "未知目标 agent" });
      continue;
    }
    const isCodex = (t && t.app) === "codex";
    // kimi openai 类型按 SDK 约定向 base_url 追加 /chat/completions，网关路径需带 /v1（同 Codex）
    const isKimi = (t && t.app) === "kimi";
    const provider = {
      name: AUTOROUTE_PROVIDER_NAME,
      // codex 走网关的 /v1/responses 入站（Responses 是 Codex 原生 wire_api），base_url 需带 /v1
      api: (t && t.app) === "claude" ? "anthropic-messages" : isCodex ? "openai-responses" : "openai-completions",
      apiKey: config.key || "",
      baseUrl: isCodex || isKimi ? `${baseUrl}/v1` : baseUrl,
      models,
    };
    const targetResults = [];
    for (const model of models) {
      try {
        const message = d.run(provider, model, { providerName: AUTOROUTE_PROVIDER_NAME });
        targetResults.push({ app: t.app, ok: true, message });
      } catch (e) {
        targetResults.push({ app: t.app, ok: false, message: e.message || String(e) });
      }
    }
    // 该目标全部模型写入成功后，清理历史版本遗留的中文「自动路由」条目
    if (targetResults.length > 0 && targetResults.every((r) => r.ok)) {
      cleanupLegacyAutoRoute(t.app);
    }
    results.push(...targetResults);
  }
  return results;
};

const APP_DISPATCHERS = {
  claude: { run: dispatchToClaude },
  opencode: { run: dispatchToOpencode },
  pi: { run: dispatchToPi },
  omp: { run: dispatchToOmp },
  reasonix: { run: dispatchToReasonix },
  codex: { run: dispatchToCodex },
  kimi: { run: dispatchToKimi },
  minimax: { run: dispatchToMinimax },
}

// 主入口：provider/model 来自通用库（apiKey 已解密），targets = [{ app, providerName?, setDefault? }]
// 返回 [{ app, ok, message }]，单个失败不中断其他目标
const dispatchCommonModel = (provider, model, targets) => {
  if (!provider || !provider.name) throw new Error('请选择供应商')
  if (!model || !model.id) throw new Error('请选择模型')
  const list = Array.isArray(targets) ? targets : []
  if (list.length === 0) throw new Error('请选择目标 agent')
  const results = []
  for (const t of list) {
    const d = APP_DISPATCHERS[t && t.app]
    if (!d) {
      results.push({ app: (t && t.app) || 'unknown', ok: false, message: '未知目标 agent' })
      continue
    }
    try {
      const message = d.run(provider, model, {
        providerName: (t.providerName && String(t.providerName).trim()) || provider.name,
        setDefault: !!t.setDefault,
      })
      results.push({ app: t.app, ok: true, message })
    } catch (e) {
      results.push({ app: t.app, ok: false, message: e.message || String(e) })
    }
  }
  return results
}

module.exports = {
  dispatchCommonModel,
  dispatchAutoRoute,
  // 内部实现导出，供测试/复用
  dispatchToClaude, dispatchToOpencode, dispatchToPi, dispatchToOmp, dispatchToReasonix, dispatchToCodex, dispatchToKimi, dispatchToMinimax,
}
