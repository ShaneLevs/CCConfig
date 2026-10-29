// 通用配置主数据 → 各 Agent 模型配置下发
// 把通用库（uTools DB）中的 provider + model 写入各 agent 的模型配置：
//   claude   → ~/.claude/settings.json  env（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL）
//   opencode → ~/.config/opencode.json(.jsonc)  provider[id]（options.baseURL/apiKey + models[id]）
//   pi       → ~/.pi/agent/models.json  providers[name] + settings.json（可选默认）
//   omp      → ~/.omp/agent/models.yml  providers[name]（无默认模型概念，modelRoles 由用户自行配置）
//   reasonix → ~/.reasonix/config.toml  providers[] + .env（可选 default_model）
//   codex    → ~/.codex/config.toml  [model_providers.<id>] + 顶层 model_provider/model（可选默认）
//   kimi     → ~/.kimi-code/config.toml  [providers.<name>] + [models."<name>/<id>"] + default_model（可选默认）
//   minimax  → ~/.minimax/config.yaml  custom_provider.<key>（API 格式与通用库协议同名）+ models.<id> + defaultModel（可选默认）
//   qoder    → ~/.qoder/settings.json  providers.<key>（anthropic→anthropic，其余→openai）+ models[] + provider.model（可选默认）
//   zcode    → ~/.zcode/v2/provider_config.json  providerRules[providerId]（anthropic-messages/openai-chat-completions/openai-responses）+ providerModelRules + providerOrder/modelOrder（可选首选）
//   hermes   → ~/.hermes/config.yaml  custom_providers[name]（api_mode 三协议映射）+ models 字典 + 顶层 model.provider/model.default（可选默认）
//   dsh      → ~/.dsh/profiles/<profile>/cordis.patch.yml  llm-pi-ai.providers[route]（api 协议同名映射）+ models[] + agent-default-model（可选默认）
//             密钥写入 ~/.dsh/.credentials.yaml 的 refs[<ROUTE>_API_KEY]（patch 只记录凭据引用名）
//   grok     → ~/.grok/config.toml  [model_providers.<key>]（连接信息）+ [model.<id>]（model_provider 引用）+ [models].default（可选默认）
//   cline    → ~/.cline/data/settings/providers.json（供应商连接信息，provider=openai-compatible）
//              + models.json（模型目录）+ lastUsedProvider（可选首选）
//   commandcode → ~/.commandcode/providers.json  provider.<key>（api 三协议同名）+ models 字典 + settings.json model（可选默认）
//             密钥写入 ~/.commandcode/auth.json 的 <key>.apiKey（providers.json 的 apiKey 只接受引用语法）
// 全部为纯文件/DB 写入，不依赖 agent 二进制；每个目标独立 try/catch，单个失败不影响其他目标。
// Claude 特殊：下发写入 uTools DB 保存配置（一个 provider 一份，Claude 配置页可见），不直接改 settings.json
const crypto = require('./crypto')
const claudeConfig = require('./config')
const opencode = require('./opencode')
const pi = require('./pi')
const omp = require('./omp')
const reasonix = require('./reasonix')
const codex = require('./codex')
const kimi = require('./kimi')
const minimax = require('./minimax')
const qoder = require('./qoder')
const zcode = require('./zcode')
const hermes = require('./hermes')
const dsh = require('./dsh')
const grok = require('./grok')
const cline = require('./cline')
const commandCode = require('./command-code')
const autoroute = require('./autoroute')
const { t } = require('./i18n')

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

// 通用模型字段 → 各 Agent 的合法枚举（非法值只过滤，不阻断整次下发）
const INPUT_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf']
const QODER_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const listOf = (value) => (Array.isArray(value) ? value : [])
const filtered = (value, allowed) => listOf(value).filter((v) => allowed.includes(v))
const capabilitiesOf = (model) => new Set(listOf(model && model.capabilities))
const inputModalities = (model) => filtered(model && model.input, INPUT_MODALITIES)

// omp 的 thinking 只接受 mode/minLevel/maxLevel；空对象视为未配置
const normalizeOmpThinking = (thinking) => {
  if (!thinking || typeof thinking !== 'object') return null
  const out = {}
  if (thinking.mode === 'effort' || thinking.mode === 'auto') out.mode = thinking.mode
  for (const key of ['minLevel', 'maxLevel']) {
    if (typeof thinking[key] === 'string' && thinking[key]) out[key] = thinking[key]
  }
  return Object.keys(out).length ? out : null
}

// ==================== 各 Agent 写入实现 ====================

// Pi / omp 模型条目写入（数组按 id 匹配）：新建直接 push；已存在则合并更新——
// 与 OpenCode / MiniMax 下发语义对齐：通用库「非空才覆盖、空值不清旧」，
// 通用库没有的字段（本地手加键、compat 未下发子键等）原样保留。
// 返回 'added' | 'updated' 供结果文案区分。
const upsertDispatchModel = (list, model, extra = {}) => {
  const hasCompat = model.compat && typeof model.compat === 'object' && Object.keys(model.compat).length
  const input = filtered(model.input, ['text', 'image'])
  const idx = list.findIndex(m => m && m.id === model.id)
  if (idx === -1) {
    const cost = normalizeCost(model.cost)
    const entry = {
      id: model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow || undefined,
      maxTokens: model.maxTokens || undefined,
      reasoning: !!model.reasoning,
      input: input.length ? input : ['text'],
    }
    if (cost) entry.cost = cost
    if (hasCompat) entry.compat = model.compat
    if (extra.thinking) entry.thinking = { ...extra.thinking }
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
  if (input.length) next.input = input
  const cost = normalizeCost(model.cost)
  if (cost) next.cost = cost
  if (hasCompat) next.compat = { ...(prev.compat && typeof prev.compat === 'object' ? prev.compat : {}), ...model.compat }
  if (extra.thinking) {
    next.thinking = {
      ...(prev.thinking && typeof prev.thinking === 'object' ? prev.thinking : {}),
      ...extra.thinking,
    }
  }
  list[idx] = next
  return 'updated'
}

// Claude Code：下发 = 在 uTools DB 保存一份「以 provider 命名」的配置（ccconfig_config_dispatch_<provider>），
// 与 Claude 配置页的配置列表互通（切换时由 useConfigSwitch 写入 settings.json）。
// 一个 provider 一份配置；模型自动填入空闲槽位（默认 → Haiku → Sonnet → Opus → Fable → Subagent），
// 已有同模型跳过，6 个槽位全满时报错提示（不覆盖已有模型）。
// 仅接受 anthropic-messages 协议的供应商（激活后写入 ANTHROPIC_* env，其余协议不可用）。
const DB_PREFIX = 'ccconfig_config_'
const DISPATCH_DB_PREFIX = DB_PREFIX + 'dispatch_'
// 槽位与 Claude 配置页 / 激活逻辑（useConfigSwitch）保持同一套顺序：默认 → Haiku → Sonnet → Opus →
// Fable → Subagent（Fable 槽位是后加的，历史上网关下发漏了它，导致最多只能填 5 个模型）
const CLAUDE_SLOT_ENVS = [
  ['model', 'ANTHROPIC_MODEL'],
  ['defaultHaikuModel', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  ['defaultSonnetModel', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ['defaultOpusModel', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
  ['defaultFableModel', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
  ['subagentModel', 'CLAUDE_CODE_SUBAGENT_MODEL'],
]
const CLAUDE_MODEL_SLOTS = CLAUDE_SLOT_ENVS.map(([slot]) => slot)
const CLAUDE_SLOT_LABELS = { model: 'service.dispatch.slotDefault', defaultHaikuModel: 'Haiku', defaultSonnetModel: 'Sonnet', defaultOpusModel: 'Opus', defaultFableModel: 'Fable', subagentModel: 'Subagent' }
const claudeSlotLabel = (slot) =>
  slot === 'model' ? t(CLAUDE_SLOT_LABELS[slot]) : CLAUDE_SLOT_LABELS[slot]

const dispatchToClaude = (provider, model) => {
  if ((provider.api || 'openai-completions') !== 'anthropic-messages') {
    throw new Error(
      t('service.dispatch.claudeProtocolUnsupported', {
        name: provider.name,
        api: provider.api || 'openai-completions',
      }),
    )
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
        defaultFableModel: '',
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
    return t('service.dispatch.claudeModelExists', {
      name: provider.name,
      model: model.id,
    })
  }
  const slot = CLAUDE_MODEL_SLOTS.find(s => !next[s])
  if (!slot) {
    throw new Error(
      t('service.dispatch.claudeSlotsFull', { name: provider.name }),
    )
  }
  next[slot] = model.id
  let res
  try {
    res = window.utools.db.put(next)
  } catch (e) {
    throw new Error(
      t('service.dispatch.claudeSaveFailedReason', {
        message: e.message || e,
      }),
    )
  }
  if (!res || !res.ok) {
    throw new Error(
      res && res.message
        ? t('service.dispatch.claudeSaveFailedReason', { message: res.message })
        : t('service.dispatch.claudeSaveFailed'),
    )
  }
  return t('service.dispatch.claudeDispatched', {
    name: provider.name,
    model: model.id,
    slot: claudeSlotLabel(slot),
  })
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
  // 推理能力与输入/输出模态透传（值为 opencode modalities 子集；有值才写）
  if (model.reasoning) nextModel.reasoning = true
  const input = filtered(model.input, INPUT_MODALITIES)
  const outputModalities = filtered(model.output, INPUT_MODALITIES)
  const modalities = { ...(prevModel.modalities || {}) }
  if (input.length) modalities.input = input
  // 默认 [text] 不写回，避免重下发把 opencode 侧手工加的输出模态清掉
  if (outputModalities.length && !(outputModalities.length === 1 && outputModalities[0] === 'text')) {
    modalities.output = outputModalities
  }
  if (Object.keys(modalities).length) nextModel.modalities = modalities
  // 费用透传（全 0 省略；opencode 配置为扁平 cache_read/cache_write 键）
  if (model.cost && typeof model.cost === 'object') {
    const c = Number(model.cost.input) || 0, o = Number(model.cost.output) || 0
    const cr = Number(model.cost.cacheRead) || 0, cw = Number(model.cost.cacheWrite) || 0
    if (c || o || cr || cw) {
      nextModel.cost = { input: c, output: o, cache_read: cr, cache_write: cw }
    }
  }
  // 模型级 SDK options：合并式写入，保留 opencode 侧已有键
  const prevModelOptions = prevModel.options && typeof prevModel.options === 'object' ? prevModel.options : {}
  const nextModelOptions = {
    ...prevModelOptions,
    ...(model.options && typeof model.options === 'object' ? model.options : {}),
  }
  if (model.defaultEffort) nextModelOptions.effort = model.defaultEffort
  if (typeof model.temperature === 'number') nextModelOptions.temperature = model.temperature
  if (typeof model.topP === 'number') nextModelOptions.topP = model.topP
  const thinking = model.thinking && typeof model.thinking === 'object' ? model.thinking : {}
  if (thinking.type || Number(thinking.budgetTokens) > 0) {
    const prevThinking = prevModelOptions.thinking && typeof prevModelOptions.thinking === 'object'
      ? prevModelOptions.thinking
      : {}
    const nextThinking = { ...prevThinking }
    if (thinking.type) nextThinking.type = thinking.type
    if (thinking.type === 'enabled' && Number(thinking.budgetTokens) > 0) {
      nextThinking.budgetTokens = Number(thinking.budgetTokens)
    } else if (thinking.type && thinking.type !== 'enabled') {
      delete nextThinking.budgetTokens
    }
    nextModelOptions.thinking = nextThinking
  }
  if (Object.keys(nextModelOptions).length) nextModel.options = nextModelOptions
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
  if (!opencode.writeOpencodeConfig(current))
    throw new Error(t('service.dispatch.opencodeWriteFailed'))
  return t('service.dispatch.opencodeDispatched', {
    id,
    npm: nextNpm.replace('@ai-sdk/', ''),
    model: model.id,
  })
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
    suffix = t('service.dispatch.setAsDefault')
  }
  return (
    t(
      act === 'updated'
        ? 'service.dispatch.providerModelMerged'
        : 'service.dispatch.providerModelUpdated',
      { name, model: model.id },
    ) + suffix
  )
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
  const act = upsertDispatchModel(list, model, { thinking: normalizeOmpThinking(model.thinking) })
  omp.writeOmpModels(models)
  return (
    t(
      act === 'updated'
        ? 'service.dispatch.providerModelMerged'
        : 'service.dispatch.providerModelUpdated',
      { name, model: model.id },
    ) + t('service.dispatch.ompModelRolesHint')
  )
}

// Reasonix：config.toml providers[] + .env key + 可选 default_model
// 协议映射按官方 provider kind（internal/contract/config）：
//   openai-completions / openai-responses → openai、anthropic-messages → anthropic、
//   google-generative-ai → gemini（**不是 google**，写成 google 会被配置校验拒绝）
const REASONIX_KIND_BY_API = {
  'openai-completions': 'openai',
  'openai-responses': 'openai',
  'anthropic-messages': 'anthropic',
  'google-generative-ai': 'gemini',
}

const dispatchToReasonix = (provider, model, opts) => {
  const name = opts.providerName || provider.name
  const doc = reasonix.readReasonixConfig()
  if (!Array.isArray(doc.providers)) doc.providers = []
  const prev = doc.providers.find(p => p.name === name)
  const kind = REASONIX_KIND_BY_API[provider.api] || (prev && prev.kind) || 'openai'
  let apiKeyEnv = (prev && prev.api_key_env) || ''
  if (!apiKeyEnv) apiKeyEnv = reasonix.generateReasonixApiKeyEnv(name)
  if (provider.apiKey) reasonix.writeReasonixEnvKey(apiKeyEnv, provider.apiKey)
  // 保留原 provider 的扩展字段（price / extra_body / reasoning_protocol 等）
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
  // 通用库的模型元数据落到 model_overrides.<模型>：Reasonix 的 context_window /
  // max_output_tokens 是 **provider 级兜底**，混合网关按模型区分窗口时必须逐模型覆盖。
  // 只写有值的字段，并保留该模型下其它已有覆盖项（reasoning_protocol / vision 等）。
  const ctx = Number(model.contextWindow) || 0
  const out = Number(model.maxTokens) || 0
  if (ctx || out) {
    const overrides = (entry.model_overrides && typeof entry.model_overrides === 'object' && !Array.isArray(entry.model_overrides))
      ? { ...entry.model_overrides }
      : {}
    const current = (overrides[model.id] && typeof overrides[model.id] === 'object') ? overrides[model.id] : {}
    const next = { ...current }
    if (ctx) next.context_window = ctx
    if (out) next.max_output_tokens = out
    overrides[model.id] = next
    entry.model_overrides = overrides
  }
  doc.providers = doc.providers.filter(p => p.name !== name)
  doc.providers.push(entry)
  let suffix = ''
  if (opts.setDefault) {
    doc.default_model = `${name}/${model.id}`
    suffix = t('service.dispatch.setAsDefault')
  }
  reasonix.writeReasonixConfig(doc)
  return (
    t('service.dispatch.providerModelUpdated', { name, model: model.id }) +
    suffix
  )
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
    throw new Error(
      t('service.dispatch.codexProtocolUnsupported', {
        name: provider.name,
        api: provider.api,
      }),
    )
  }
  // base_url 必须停在版本段（Codex 自己追加 /responses 或 /chat/completions），
  // 主数据库里 …/v1、…/v1/、…/v1/chat/completions、无版本段的根地址都归一到这里
  codex.upsertCodexProvider(id, {
    name: id,
    baseUrl: codex.normalizeCodexBaseUrl(provider.baseUrl),
    wireApi,
    apiKey: provider.apiKey || '',
    // 网关下发：顺手写上模型目录 URL（Codex ≥ 0.161 直接从网关拉 /v1/codex/models），
    // 本地 models.json 仍由「模型目录」开关管，两者不冲突
    ...(opts.codexModelCatalogUrl ? { modelCatalogUrl: opts.codexModelCatalogUrl } : {}),
  })
  codex.upsertCodexModel(id, model.id)
  let suffix = ''
  if (opts.setDefault) {
    codex.setCodexDefaultModel(id, model.id)
    suffix = t('service.dispatch.setAsDefault')
  }
  return (
    t('service.dispatch.providerModelUpdated', { name: id, model: model.id }) +
    suffix
  )
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
  // headers → [providers.<name>.custom_headers]（Kimi 官方的自定义 HTTP 头）
  kimi.upsertKimiProvider(name, {
    type,
    baseUrl: provider.baseUrl || '',
    apiKey: provider.apiKey || '',
    headers: provider.headers,
  })
  // 通用库模型元数据随之下发：显示名 / 上下文 / 最大输出 / 输入模态 / 推理能力 / 推理档位
  const alias = kimi.upsertKimiModel(name, model.id, {
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    maxInputSize: Number(model.maxInputTokens) > 0 ? Number(model.maxInputTokens) : undefined,
    displayName: model.name || model.id,
    reasoning: model.reasoning,
    input: Array.isArray(model.input) ? model.input : undefined,
    capabilities: Array.isArray(model.capabilities) ? model.capabilities : undefined,
    reasoningEfforts: Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : undefined,
    defaultEffort: model.defaultEffort || undefined,
    offEffort: model.offEffort || undefined,
    reasoningKey: model.reasoningKey || undefined,
    adaptiveThinking: typeof model.adaptiveThinking === 'boolean' ? model.adaptiveThinking : undefined,
  })
  let suffix = ''
  if (opts.setDefault) {
    kimi.setKimiDefaultModel(alias)
    suffix = t('service.dispatch.setAsDefault')
  }
  return (
    t('service.dispatch.providerModelAliasUpdated', {
      name,
      alias,
    }) + suffix
  )
}

// MiniMax Code：config.yaml custom_provider.<key>.models.<id> + 可选 defaultModel。
// 三种 API 格式与通用库协议同名（identity 映射），仅 google-generative-ai 不支持需守卫；
// 通用库供应商名可为中文 → providerKeyFor 确定性清洗为 ASCII 键（同名恒同键，upsert 幂等）
const dispatchToMinimax = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  if (!minimax.MINIMAX_API_FORMATS.includes(api)) {
    throw new Error(
      t('service.dispatch.minimaxProtocolUnsupported', {
        name: provider.name,
        api,
      }),
    )
  }
  const name = opts.providerName || provider.name
  const key = minimax.providerKeyFor(name)
  minimax.upsertMinimaxProvider(key, { name, api, baseUrl: provider.baseUrl || '', apiKey: provider.apiKey || '' })
  const ref = minimax.upsertMinimaxModel(key, model.id, {
    name: model.name || model.id,
    contextWindow: model.contextWindow,
    outputWindow: model.maxTokens,
    inputTypes: Array.isArray(model.input) ? model.input : undefined,
    // 推理等级：通用库 model.reasoningEfforts → thinking.effortOptions（不传 = 保留既有）
    effortOptions: Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : undefined,
  })
  let suffix = ''
  if (opts.setDefault) {
    minimax.setMinimaxDefaultModel(ref)
    suffix = t('service.dispatch.setAsDefault')
  }
  const keyNote =
    key === name ? '' : t('service.dispatch.keyNote', { key })
  return (
    t('service.dispatch.providerModelUpdated', {
      name: name + keyNote,
      model: model.id,
    }) + suffix
  )
}

// Qoder：settings.json providers.<key>（openai-compatible）+ models[] + provider.model 默认模型。
// 支持协议同 MiniMax（anthropic/openai identity 映射），仅 google-generative-ai 不支持需守卫；
// 通用库供应商名可为中文 → providerKeyFor 确定性清洗为 ASCII 键（同名恒同键，upsert 幂等）
const dispatchToQoder = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  const protocol = api === 'anthropic-messages' ? 'anthropic' : 'openai'
  if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api)) {
    throw new Error(
      t('service.dispatch.qoderProtocolUnsupported', {
        name: provider.name,
        api,
      }),
    )
  }
  const name = opts.providerName || provider.name
  const key = qoder.providerKeyFor(name)
  qoder.upsertQoderProvider(key, { protocol, baseUrl: provider.baseUrl || '', apiKey: provider.apiKey || '' })
  const input = inputModalities(model)
  const efforts = filtered(model.reasoningEfforts, QODER_EFFORT_LEVELS)
  const modelId = qoder.upsertQoderModel(key, model.id, {
    name: model.name || model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    vision: input.includes('image'),
    thinkingEnabled: !!model.reasoning || efforts.length > 0,
    supportsEffort: efforts.length > 0,
    effortLevels: efforts,
  })
  let suffix = ''
  if (opts.setDefault) {
    qoder.setQoderDefaultModel(key, modelId)
    suffix = t('service.dispatch.setAsDefault')
  }
  const keyNote =
    key === name ? '' : t('service.dispatch.keyNote', { key })
  return (
    t('service.dispatch.providerModelUpdated', {
      name: name + keyNote,
      model: model.id,
    }) + suffix
  )
}

// ZCode：provider_config.json providerRules[providerId] + providerModelRules + 可选首选（providerOrder/modelOrder 置顶）。
// 协议映射：anthropic-messages / openai-responses 同名，openai-completions → openai-chat-completions，
// google-generative-ai 不支持需守卫；通用库供应商名可为中文 → providerIdFor 按 ZCode 规则确定性清洗
const ZCODE_API_TYPE = {
  'openai-completions': 'openai-chat-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
}

const dispatchToZcode = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  const apiType = ZCODE_API_TYPE[api]
  if (!apiType) {
    throw new Error(
      t('service.dispatch.zcodeProtocolUnsupported', {
        name: provider.name,
        api,
      }),
    )
  }
  const name = opts.providerName || provider.name
  const id = zcode.providerIdFor(name)
  zcode.upsertZcodeProvider(id, { name, apiType, baseUrl: provider.baseUrl || '', apiKey: provider.apiKey || '' })
  const input = inputModalities(model)
  const caps = capabilitiesOf(model)
  const modelId = zcode.upsertZcodeModel(id, model.id, {
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    image: input.includes('image'),
    video: input.includes('video'),
    audio: input.includes('audio'),
    pdf: input.includes('pdf'),
    jsonSchema: caps.has('json_schema'),
    webSearch: caps.has('web_search'),
    midSystem: caps.has('mid_system'),
    reasoningLevels: listOf(model.reasoningEfforts).filter((v) => typeof v === 'string' && v),
  })
  let suffix = ''
  if (opts.setDefault) {
    zcode.setZcodeDefaultModel(id, modelId)
    suffix = t('service.dispatch.setAsPrimary')
  }
  const keyNote =
    id === name ? '' : t('service.dispatch.idNote', { id })
  return (
    t('service.dispatch.providerModelUpdated', {
      name: name + keyNote,
      model: modelId,
    }) + suffix
  )
}

// Hermes：config.yaml custom_providers[name] + models 字典 + 可选默认（顶层 model.provider/model.default）。
// 协议映射：openai-completions → chat_completions、anthropic-messages → anthropic_messages、
// openai-responses → codex_responses，google-generative-ai 不支持需守卫；
// 通用库供应商名可为中文 → providerKeyFor 确定性清洗
const HERMES_API_MODE = {
  'openai-completions': 'chat_completions',
  'openai-responses': 'codex_responses',
  'anthropic-messages': 'anthropic_messages',
}

const dispatchToHermes = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  const apiMode = HERMES_API_MODE[api]
  if (!apiMode) {
    throw new Error(
      t('service.dispatch.hermesProtocolUnsupported', {
        name: provider.name,
        api,
      }),
    )
  }
  const name = opts.providerName || provider.name
  const key = hermes.providerKeyFor(name)
  hermes.upsertHermesProvider(key, { name, apiMode, baseUrl: provider.baseUrl || '', apiKey: provider.apiKey || '' })
  const modelId = hermes.upsertHermesModel(key, model.id, {
    contextLength: model.contextWindow,
    name: model.name || model.id,
    maxTokens: model.maxTokens,
  })
  let suffix = ''
  if (opts.setDefault) {
    hermes.setHermesDefaultModel(key, modelId)
    suffix = t('service.dispatch.setAsDefault')
  }
  const keyNote =
    key === name ? '' : t('service.dispatch.nameNote', { key })
  return (
    t('service.dispatch.providerModelUpdated', {
      name: name + keyNote,
      model: modelId,
    }) + suffix
  )
}

// DSH（DeepSeek Harness）：cordis.patch.yml 的 llm-pi-ai.providers[route] + models[] + agent-default-model（可选默认）。
// 四类通用库协议与 pi-ai 协议同名（identity 映射），无需协议守卫；密钥写入
// <DSH_HOME>/.credentials.yaml 的 refs[apiKeyEnv]（patch 只记录凭据引用名）；
// 通用库供应商名可为中文 → providerRouteFor 确定性清洗为小写 ASCII 路由（同名恒同路由，upsert 幂等）
const dispatchToDsh = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  if (!dsh.DSH_PROTOCOLS.includes(api)) {
    throw new Error(
      t('service.dispatch.dshProtocolUnsupported', {
        name: provider.name,
        api,
        protocols: dsh.DSH_PROTOCOLS.join(' / '),
      }),
    )
  }
  const name = opts.providerName || provider.name
  const route = dsh.providerRouteFor(name)
  dsh.upsertDshProvider(route, {
    name,
    api,
    baseURL: provider.baseUrl || '',
    apiKey: provider.apiKey || '',
  })
  const input = inputModalities(model)
  // DSH 的 reasoningEfforts 是 { 等级: 线上拼写 } 或 false；通用库的数组按同名映射写入。
  const dshEfforts = listOf(model.reasoningEfforts).filter((v) => typeof v === 'string' && v)
  const reasoningEfforts = dshEfforts.length
    ? Object.fromEntries(dshEfforts.map((v) => [v, v]))
    : undefined
  const modelId = dsh.upsertDshModel(route, model.id, {
    name: model.name || model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    image: input.includes('image'),
    description: model.description,
    reasoningEfforts,
    compat: model.compat && typeof model.compat === 'object' ? model.compat : undefined,
  })
  let suffix = ''
  if (opts.setDefault) {
    dsh.setDshDefaultModel(route, modelId)
    suffix = t('service.dispatch.setAsDefault')
  }
  const routeNote =
    route === name ? '' : t('service.dispatch.routeNote', { route })
  return (
    t('service.dispatch.providerModelUpdated', {
      name: name + routeNote,
      model: modelId,
    }) + suffix
  )
}

// Grok Build：config.toml [model_providers.<key>]（共享连接信息）+ [model.<id>]（model_provider 引用）
// + 可选 [models].default。协议映射：openai-completions → chat_completions、openai-responses → responses、
// anthropic-messages → messages（Anthropic /v1/messages）；google-generative-ai 无对应后端需守卫；
// 通用库供应商名可为中文 → providerKeyFor 确定性清洗为 TOML 裸键
const GROK_API_BACKEND = {
  'openai-completions': 'chat_completions',
  'openai-responses': 'responses',
  'anthropic-messages': 'messages',
}

const dispatchToGrok = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  const apiBackend = GROK_API_BACKEND[api]
  if (!apiBackend) {
    throw new Error(
      t('service.dispatch.grokProtocolUnsupported', {
        name: provider.name,
        api,
      }),
    )
  }
  const name = opts.providerName || provider.name
  const key = grok.providerKeyFor(name)
  // 供应商只放共享连接信息；上下文窗口等模型级字段写到模型条目上，
  // 否则同一供应商下多个模型下发时会互相覆盖 context_window
  grok.upsertGrokProvider(key, {
    apiBackend,
    baseUrl: provider.baseUrl || '',
    apiKey: provider.apiKey || '',
  })
  const modelId = grok.upsertGrokModel(key, model.id, {
    name: model.name || model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    description: model.description,
    temperature: model.temperature,
    topP: model.topP,
    extraHeaders: model.extraHeaders,
  })
  let suffix = ''
  if (opts.setDefault) {
    grok.setGrokDefaultModel(modelId)
    suffix = t('service.dispatch.setAsDefault')
  }
  const keyNote =
    key === name ? '' : t('service.dispatch.keyNote', { key })
  return (
    t('service.dispatch.providerModelUpdated', {
      name: name + keyNote,
      model: modelId,
    }) + suffix
  )
}

// Cline：providers.json（settings.provider=openai-compatible + baseUrl/apiKey）
// + models.json（provider 目录 + models[id]）+ 可选 lastUsedProvider。
// Cline 侧第三方端点只支持 OpenAI Chat Completions 一种协议，其余三类需先转成网关
//（网关对外提供 /v1/chat/completions，agent 侧统一走 openai-completions）
const CLINE_PROTOCOLS = ['openai-completions']

const dispatchToCline = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  if (!CLINE_PROTOCOLS.includes(api)) {
    throw new Error(
      t('service.dispatch.clineProtocolUnsupported', {
        name: provider.name,
        api,
      }),
    )
  }
  const name = opts.providerName || provider.name
  const key = cline.providerKeyFor(name)
  cline.upsertClineProvider(key, {
    name,
    baseUrl: provider.baseUrl || '',
    apiKey: provider.apiKey || '',
  })
  const input = inputModalities(model)
  const caps = ['streaming', 'tools']
  if (input.includes('image')) caps.push('images')
  if (model.reasoning) caps.push('reasoning')
  const modelId = cline.upsertClineModel(key, {
    id: model.id,
    name: model.name || model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    capabilities: caps,
  })
  let suffix = ''
  if (opts.setDefault) {
    // 设为默认模型：同时把该供应商设为当前使用（Cline 的 lastUsedProvider）
    cline.setClineDefaultModelForProvider(key, modelId)
    cline.setClineActiveProvider(key)
    suffix = t('service.dispatch.setAsDefault')
  } else {
    // 没要求设默认时，只在「Cline 里没有生效的当前供应商」时自动接管（空配置 / lastUsedProvider 悬空 /
    // 条目被判废）。否则 Cline 里等于没配置 —— 会话退回内置 cline 账号，用户看到的就是「下发没生效」。
    const auto = cline.activateClineIfUnset(key)
    if (auto.activated) suffix = t('service.dispatch.clineAutoActivated')
  }
  const keyNote = key === name ? '' : t('service.dispatch.keyNote', { key })
  return (
    t('service.dispatch.providerModelUpdated', {
      name: name + keyNote,
      model: modelId,
    }) + suffix
  )
}

// Command Code：三种 wire 官方原生支持，无需协议转换（openai-completions /
// openai-responses / anthropic-messages 一一对应）
const dispatchToCommandCode = (provider, model, opts) => {
  const api = provider.api || 'openai-completions'
  if (!commandCode.CC_APIS.includes(api)) {
    throw new Error(
      t('service.dispatch.grokProtocolUnsupported', {
        name: provider.name,
        api,
      }),
    )
  }
  const name = opts.providerName || provider.name
  // provider id 同时是 settings.json model 的前缀 → 必须是合法 slug
  const key = commandCode.providerKeyFor(name)
  commandCode.upsertCommandCodeProvider(key, {
    name,
    api,
    baseUrl: provider.baseUrl || '',
  })
  // key 必须写 auth.json：providers.json 的 apiKey 只接受引用语法（明文会被官方拒绝）
  if (provider.apiKey) commandCode.setCommandCodeApiKey(key, provider.apiKey)
  const modelId = commandCode.upsertCommandCodeModel(key, model.id, {
    name: model.name || model.id,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput || model.maxTokens,
    reasoningEfforts: model.reasoningEfforts,
    cost: model.cost,
    api: model.api,
    options: model.options,
    baseURL: model.baseURL,
  })
  let suffix = ''
  if (opts.setDefault) {
    commandCode.setCommandCodeDefaultModel(key, modelId)
    suffix = t('service.dispatch.setAsDefault')
  }
  const keyNote = key === name ? '' : t('service.dispatch.keyNote', { key })
  return (
    t('service.dispatch.providerModelUpdated', {
      name: name + keyNote,
      model: modelId,
    }) + suffix
  )
}

// ==================== 自动网关下发 ====================
// 自动网关（autoroute.js）作为虚拟供应商写入各 agent：Claude 目标用 anthropic-messages
//（对外就是 Anthropic 协议端点，可通过协议守卫），其余目标用 openai-completions；
// baseUrl 指向 http://127.0.0.1:<port>，key 为网关占位符（网关不校验 key，但部分 agent 要求 apiKey / token 非空）。
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
      try { active = window.utools.db.get("ccconfig_active_config_id"); } catch (e) { /* ignore */ }
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
    } else if (app === "commandcode") {
      // providers.json 的键是 slug：旧版中文名从未被本插件写入过（providerKeyFor 恒产出 slug），
      // 这里只处理「历史上某次手工写入的中文 id」的清理，被默认模型引用时跳过
      const providers = commandCode.getCommandCodeProviderList();
      const legacy = providers.find((p) => p.id === LEGACY_AUTOROUTE_NAME || p.name === LEGACY_AUTOROUTE_NAME);
      if (!legacy) return;
      const def = commandCode.getCommandCodeDefaultModel();
      if (def.provider === legacy.id) return;
      commandCode.deleteCommandCodeProvider(legacy.id);
    }
  } catch (e) {
    /* 清理失败不影响本次下发 */
  }
};

// ==================== 网关下发：router 供应商覆盖式重建 ====================
// 网关下发代表「当前全量模型清单」，因此每次下发都把 router 供应商整条重建（连接信息 + 模型列表
// 全部由网关重写），不在 agent 侧做合并——否则历次下发过的模型会沉淀成混合清单（旧模型删不掉、
// 已下线的模型还在选择器里）。重建前后继承三件事（仅网关下发；通用模型下发仍是合并语义）：
//   1. 生效状态：router 原本是当前生效/默认供应商 → 重建后继续生效
//   2. 默认模型：原默认模型仍在新清单里就沿用，否则取新清单第一个
//   3. 停用开关：agent 自己的供应商级 enabled / disabled（MiniMax / Command Code / Cline）保持原样
// 每个 agent 一个 spec：
//   apis   支持的协议。不匹配时不做任何清理（否则协议不兼容会先把 router 删空再报错）
//   before 读状态，返回 null 表示当前没有 router 条目（无需清理）
//   clear  删除 router 条目与其全部模型。**不依赖 delete* 的「在用」守卫**：生效中的供应商
//          本来就删不掉，直接按文件结构清理
//   after  恢复生效状态 / 默认模型 / 停用开关。applied = 本次成功写入的模型 ID（按下发顺序）
const AUTOROUTE_ACTIVE_CLAUDE_DOC = 'ccconfig_active_config_id'
const claudeRouterDocId = () => DISPATCH_DB_PREFIX + AUTOROUTE_PROVIDER_NAME
const pickAppliedModel = (prior, applied) => (prior && applied.includes(prior.model) ? prior.model : applied[0])

// 生效中的 Claude 配置被重建后同步 settings.json：只动托管 env 字段。
// 全局额外字段是激活该配置时写入的，重建不改它们（与 useConfigSwitch 的托管字段清单一致）
const syncClaudeRouterEnv = (doc) => {
  const settings = claudeConfig.readClaudeSettings() || {}
  if (!settings.env || typeof settings.env !== 'object') settings.env = {}
  const authVar = doc.authVar === 'ANTHROPIC_API_KEY' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'
  for (const v of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (v !== authVar) delete settings.env[v]
  }
  settings.env[authVar] = crypto.decrypt(doc.key || '')
  settings.env.ANTHROPIC_BASE_URL = doc.baseUrl || ''
  for (const [slot, env] of CLAUDE_SLOT_ENVS) {
    const value = String(doc[slot] || '').trim()
    if (value) settings.env[env] = value
    else delete settings.env[env]
  }
  claudeConfig.writeClaudeSettings(settings)
}

const AUTOROUTE_REBUILD = {
  // Claude：router 是一份 DB 配置文档（6 个模型槽位），清空槽位后由 dispatchToClaude 按顺序重填
  claude: {
    apis: ['anthropic-messages'],
    before() {
      let doc = null
      try { doc = window.utools.db.get(claudeRouterDocId()) } catch (e) { return null }
      if (!doc) return null
      let activeId = ''
      try {
        const active = window.utools.db.get(AUTOROUTE_ACTIVE_CLAUDE_DOC)
        activeId = (active && active.configId) || ''
      } catch (e) { /* ignore */ }
      return { active: activeId === doc._id, model: String(doc.model || '') }
    },
    clear() {
      let doc = null
      try { doc = window.utools.db.get(claudeRouterDocId()) } catch (e) { return }
      if (!doc) return
      const next = { ...doc, key: '', baseUrl: '', updatedAt: Date.now() }
      for (const slot of CLAUDE_MODEL_SLOTS) next[slot] = ''
      const res = window.utools.db.put(next)
      if (!res || !res.ok)
        throw new Error(
          res && res.message
            ? t('service.dispatch.claudeSaveFailedReason', { message: res.message })
            : t('service.dispatch.claudeSaveFailed'),
        )
    },
    after(prior, applied) {
      if (!applied.length) return
      let doc = null
      try { doc = window.utools.db.get(claudeRouterDocId()) } catch (e) { return }
      if (!doc) return
      // 沿用原默认模型：它还在新槽位里就换回默认槽（两个槽位内容对调，不丢模型）
      if (prior.model && doc.model !== prior.model) {
        const other = CLAUDE_MODEL_SLOTS.find((slot) => slot !== 'model' && doc[slot] === prior.model)
        if (other) {
          const next = { ...doc, model: prior.model, [other]: doc.model, updatedAt: Date.now() }
          const res = window.utools.db.put(next)
          if (res && res.ok) doc = next
        }
      }
      if (prior.active) syncClaudeRouterEnv(doc)
    },
  },

  // OpenCode：provider[id] + 顶层 model（"<id>/<model>" 即当前生效模型）
  opencode: {
    before() {
      const current = opencode.readOpencodeConfig()
      const prev = current.provider && current.provider[AUTOROUTE_PROVIDER_NAME]
      if (!prev) return null
      const prefix = `${AUTOROUTE_PROVIDER_NAME}/`
      const active = typeof current.model === 'string' && current.model.startsWith(prefix)
      return { active, model: active ? current.model.slice(prefix.length) : '' }
    },
    clear() {
      const current = opencode.readOpencodeConfig()
      if (!current.provider || !current.provider[AUTOROUTE_PROVIDER_NAME]) return
      delete current.provider[AUTOROUTE_PROVIDER_NAME]
      opencode.writeOpencodeConfig(current)
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      const current = opencode.readOpencodeConfig()
      current.model = `${AUTOROUTE_PROVIDER_NAME}/${pickAppliedModel(prior, applied)}`
      opencode.writeOpencodeConfig(current)
    },
  },

  // Pi：models.json providers[name] + settings.json defaultProvider/defaultModel
  pi: {
    before() {
      const models = pi.readPiModels()
      if (!models.providers || !models.providers[AUTOROUTE_PROVIDER_NAME]) return null
      const settings = pi.readPiSettings()
      const active = settings.defaultProvider === AUTOROUTE_PROVIDER_NAME
      return { active, model: active ? String(settings.defaultModel || '') : '' }
    },
    clear() {
      const models = pi.readPiModels()
      if (!models.providers || !models.providers[AUTOROUTE_PROVIDER_NAME]) return
      delete models.providers[AUTOROUTE_PROVIDER_NAME]
      pi.writePiModels(models)
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      const settings = pi.readPiSettings()
      settings.defaultProvider = AUTOROUTE_PROVIDER_NAME
      settings.defaultModel = pickAppliedModel(prior, applied)
      pi.writePiSettings(settings)
    },
  },

  // omp：models.yml providers[name]（无默认供应商概念，modelRoles 的 "<provider>/<model>[:level]" 才是生效点）
  omp: {
    before() {
      const models = omp.readOmpModels()
      if (!models.providers || !models.providers[AUTOROUTE_PROVIDER_NAME]) return null
      const refs = omp.getOmpModelRoleRefs().filter(({ ref }) => {
        const parsed = omp.parseOmpModelRef(ref)
        return parsed && parsed.provider === AUTOROUTE_PROVIDER_NAME
      })
      return { active: refs.length > 0, model: '', refs }
    },
    clear() {
      const models = omp.readOmpModels()
      if (!models.providers || !models.providers[AUTOROUTE_PROVIDER_NAME]) return
      delete models.providers[AUTOROUTE_PROVIDER_NAME]
      omp.writeOmpModels(models)
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      // 角色引用的旧模型已不在新清单里 → 改指新清单第一个（保留 :level 后缀）
      const roles = omp.readOmpModelRoles() || {}
      let touched = false
      for (const { role, ref } of prior.refs || []) {
        const parsed = omp.parseOmpModelRef(ref)
        if (!parsed || parsed.provider !== AUTOROUTE_PROVIDER_NAME) continue
        if (applied.includes(parsed.model)) continue
        roles[role] = `${AUTOROUTE_PROVIDER_NAME}/${pickAppliedModel(prior, applied)}${parsed.level ? `:${parsed.level}` : ''}`
        touched = true
      }
      if (touched) omp.writeOmpModelRoles(roles)
    },
  },

  // Reasonix：config.toml providers[] + 顶层 default_model（"<name>/<model>"）
  reasonix: {
    before() {
      const doc = reasonix.readReasonixConfig()
      const list = Array.isArray(doc.providers) ? doc.providers : []
      if (!list.some((p) => p && p.name === AUTOROUTE_PROVIDER_NAME)) return null
      const dm = String(doc.default_model || '')
      const prefix = `${AUTOROUTE_PROVIDER_NAME}/`
      const active = dm === AUTOROUTE_PROVIDER_NAME || dm.startsWith(prefix)
      return { active, model: active && dm.startsWith(prefix) ? dm.slice(prefix.length) : '' }
    },
    clear() {
      const doc = reasonix.readReasonixConfig()
      if (!Array.isArray(doc.providers) || !doc.providers.some((p) => p && p.name === AUTOROUTE_PROVIDER_NAME)) return
      doc.providers = doc.providers.filter((p) => !(p && p.name === AUTOROUTE_PROVIDER_NAME))
      reasonix.writeReasonixConfig(doc)
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      const doc = reasonix.readReasonixConfig()
      doc.default_model = `${AUTOROUTE_PROVIDER_NAME}/${pickAppliedModel(prior, applied)}`
      reasonix.writeReasonixConfig(doc)
    },
  },

  // Codex：[model_providers.<id>] + 顶层 model_provider/model，模型列表另存 uTools DB
  codex: {
    apis: ['openai-completions', 'openai-responses'],
    before() {
      const doc = codex.readCodexConfig()
      const tables = doc.model_providers && typeof doc.model_providers === 'object' ? doc.model_providers : {}
      if (!tables[AUTOROUTE_PROVIDER_NAME]) return null
      const active = doc.model_provider === AUTOROUTE_PROVIDER_NAME
      return { active, model: active ? String(doc.model || '') : '' }
    },
    clear() {
      const doc = codex.readCodexConfig()
      const tables = doc.model_providers && typeof doc.model_providers === 'object' ? doc.model_providers : {}
      if (!tables[AUTOROUTE_PROVIDER_NAME]) return
      delete tables[AUTOROUTE_PROVIDER_NAME]
      if (!Object.keys(tables).length) delete doc.model_providers
      codex.writeCodexConfig(doc)
      // DB 模型列表（Codex 页快捷切换 / models.json 目录的数据源）一并清空，否则旧模型留在选择器里
      for (const id of codex.getCodexProviderModels(AUTOROUTE_PROVIDER_NAME)) {
        codex.deleteCodexModel(AUTOROUTE_PROVIDER_NAME, id)
      }
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      codex.setCodexDefaultModel(AUTOROUTE_PROVIDER_NAME, pickAppliedModel(prior, applied))
    },
  },

  // Kimi Code：[providers.<name>] + [models."<name>/<id>"] + default_model（别名）
  kimi: {
    before() {
      const provs = kimi.getKimiProviderList()
      if (!provs.some((p) => p && p.name === AUTOROUTE_PROVIDER_NAME)) return null
      const prefix = `${AUTOROUTE_PROVIDER_NAME}/`
      const dm = String(kimi.getKimiDefaultModel() || '')
      const active = dm.startsWith(prefix)
      return { active, model: active ? dm.slice(prefix.length) : '' }
    },
    clear() {
      const doc = kimi.readKimiConfig()
      let touched = false
      if (doc.providers && doc.providers[AUTOROUTE_PROVIDER_NAME]) {
        delete doc.providers[AUTOROUTE_PROVIDER_NAME]
        touched = true
      }
      if (doc.models && typeof doc.models === 'object') {
        for (const [alias, entry] of Object.entries(doc.models)) {
          if (entry && entry.provider === AUTOROUTE_PROVIDER_NAME) {
            delete doc.models[alias]
            touched = true
          }
        }
      }
      const prefix = `${AUTOROUTE_PROVIDER_NAME}/`
      if (typeof doc.default_model === 'string' && doc.default_model.startsWith(prefix)) {
        delete doc.default_model
        touched = true
      }
      if (touched) kimi.writeKimiConfig(doc)
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      kimi.setKimiDefaultModel(`${AUTOROUTE_PROVIDER_NAME}/${pickAppliedModel(prior, applied)}`)
    },
  },

  // MiniMax Code：custom_provider.<key>（含 models 字典）+ defaultModel（custom_provider:<key>/<model>）
  minimax: {
    apis: minimax.MINIMAX_API_FORMATS,
    before() {
      const key = minimax.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const prev = minimax.getMinimaxProviderList().find((p) => p.id === key && !p.managed)
      if (!prev) return null
      const prefix = `${minimax.CUSTOM_PREFIX}:${key}/`
      const dm = String(minimax.getMinimaxDefaultModel() || '').split('#')[0]
      const active = dm.startsWith(prefix)
      return { key, active, model: active ? dm.slice(prefix.length) : '', enabled: prev.enabled !== false }
    },
    clear() {
      const key = minimax.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const doc = minimax.readMinimaxConfig()
      let touched = false
      if (doc.custom_provider && doc.custom_provider[key]) {
        delete doc.custom_provider[key]
        touched = true
      }
      const prefix = `${minimax.CUSTOM_PREFIX}:${key}/`
      if (typeof doc.defaultModel === 'string' && doc.defaultModel.startsWith(prefix)) {
        delete doc.defaultModel
        touched = true
      }
      if (touched) minimax.writeMinimaxConfig(doc)
    },
    after(prior, applied) {
      if (!applied.length) return
      const key = prior.key
      const doc = minimax.readMinimaxConfig()
      const entry = doc.custom_provider && doc.custom_provider[key]
      if (!entry) return
      let touched = false
      if (prior.enabled === false && entry.enabled !== false) {
        entry.enabled = false
        touched = true
      }
      if (prior.active) {
        doc.defaultModel = `${minimax.CUSTOM_PREFIX}:${key}/${pickAppliedModel(prior, applied)}`
        touched = true
      }
      if (touched) minimax.writeMinimaxConfig(doc)
    },
  },

  // Qoder：settings.json providers.<key>（默认模型是 provider 顶层的 model 字段）
  qoder: {
    apis: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    before() {
      const key = qoder.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const prev = qoder.getQoderProviderList().find((p) => p.id === key)
      if (!prev) return null
      const model = String(qoder.getQoderDefaultModel(key) || '')
      return { key, active: !!model, model }
    },
    clear() {
      qoder.deleteQoderProvider(qoder.providerKeyFor(AUTOROUTE_PROVIDER_NAME))
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      qoder.setQoderDefaultModel(prior.key, pickAppliedModel(prior, applied))
    },
  },

  // ZCode：providerRules[id] + providerModelRules + providerOrder（首个 = 首选供应商，其 modelOrder 首个 = 首选模型）
  zcode: {
    apis: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    before() {
      const id = zcode.providerIdFor(AUTOROUTE_PROVIDER_NAME)
      const prev = zcode.getZcodeProviderList().find((p) => p.id === id)
      if (!prev) return null
      const def = zcode.getZcodeDefaultModel()
      return {
        id,
        active: !!def && def.providerId === id,
        model: def && def.providerId === id ? String(def.modelId || '') : '',
        order: zcode.getZcodeProviderOrderIndex(id),
      }
    },
    clear() {
      zcode.deleteZcodeProvider(zcode.providerIdFor(AUTOROUTE_PROVIDER_NAME))
    },
    after(prior, applied) {
      if (!applied.length) return
      if (prior.active) {
        zcode.setZcodeDefaultModel(prior.id, pickAppliedModel(prior, applied))
        return
      }
      // 不是首选供应商：把原来的选择器位置还回去（重建时它被挤到了末尾）
      if (prior.order > 0) zcode.reinsertZcodeProviderOrder(prior.id, prior.order)
    },
  },

  // Hermes：custom_providers[]（含 models 字典）+ 顶层 model.provider/model.default
  hermes: {
    apis: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    before() {
      const key = hermes.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const prev = hermes.getHermesProviderList().find((p) => p.name === key && p.source === 'custom')
      if (!prev) return null
      const def = hermes.getHermesDefaultModel()
      const active = def.provider === key
      return { key, active, model: active ? String(def.modelId || '') : '' }
    },
    clear() {
      const key = hermes.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const doc = hermes.readHermesConfig()
      let touched = false
      if (Array.isArray(doc.custom_providers)) {
        const rest = doc.custom_providers.filter((p) => !(p && p.name === key))
        if (rest.length !== doc.custom_providers.length) {
          doc.custom_providers = rest
          touched = true
        }
      }
      // 默认指针指向 router 时先清掉（重建后由 after 写回），避免悬空引用
      if (doc.model && typeof doc.model === 'object' && doc.model.provider === key) {
        delete doc.model.provider
        delete doc.model.default
        touched = true
      }
      if (touched) hermes.writeHermesConfig(doc)
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      hermes.setHermesDefaultModel(prior.key, pickAppliedModel(prior, applied))
    },
  },

  // DSH：cordis.patch.yml 的 llm-pi-ai.providers[route] + 模型数组 + agent-default-model
  dsh: {
    apis: dsh.DSH_PROTOCOLS,
    before() {
      const route = dsh.providerRouteFor(AUTOROUTE_PROVIDER_NAME)
      const prev = dsh.getDshProviderList().find((p) => p.route === route)
      if (!prev) return null
      const def = dsh.getDshDefaultModel()
      const active = !!def && def.provider === route
      return { route, active, model: active ? String(def.modelId || '') : '', reasoningEffort: active ? def.reasoningEffort : '' }
    },
    clear() {
      // 只删 providers 条目：凭据名由路由确定性生成，重建时按同名字写回，默认指针由 after 收尾
      dsh.dropDshProviderEntry(dsh.providerRouteFor(AUTOROUTE_PROVIDER_NAME))
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      dsh.setDshDefaultModel(prior.route, pickAppliedModel(prior, applied), prior.reasoningEffort || '')
    },
  },

  // Grok Build：[model_providers.<key>] + [model.<id>]（model_provider 引用）+ [models].default
  grok: {
    apis: ['openai-completions', 'openai-responses', 'anthropic-messages'],
    before() {
      const key = grok.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const prev = grok.getGrokProviderList().find((p) => p.name === key)
      if (!prev) return null
      // 模型条目的键（= [model.<key>] 与 models.default 的取值）
      const owned = grok.getGrokModelList().filter((m) => m.modelProvider === key).map((m) => m.id)
      const def = grok.getGrokDefaultModel()
      const active = !!def.modelId && owned.includes(def.modelId)
      return { key, owned, active, model: active ? def.modelId : '' }
    },
    clear() {
      const key = grok.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const doc = grok.readGrokConfig()
      const tables = doc.model_providers && typeof doc.model_providers === 'object' ? doc.model_providers : {}
      const models = doc.model && typeof doc.model === 'object' ? doc.model : {}
      let touched = false
      if (tables[key]) {
        delete tables[key]
        if (!Object.keys(tables).length) delete doc.model_providers
        touched = true
      }
      for (const [modelKey, entry] of Object.entries(models)) {
        if (entry && typeof entry === 'object' && entry.model_provider === key) {
          delete models[modelKey]
          touched = true
          if (doc.models && doc.models.default === modelKey) delete doc.models.default
        }
      }
      if (touched) grok.writeGrokConfig(doc)
    },
    after(prior, applied) {
      if (!prior.active || !applied.length) return
      const chosen = pickAppliedModel(prior, applied)
      if (grok.getGrokModelList().some((m) => m.id === chosen)) grok.setGrokDefaultModel(chosen)
    },
  },

  // Cline：providers.json（lastUsedProvider = 当前使用）+ models.json（模型目录）+ 供应商级 enabled
  cline: {
    apis: ['openai-completions'],
    before() {
      const key = cline.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const doc = cline.readProvidersDoc()
      const raw = doc.providers && doc.providers[key]
      if (!raw) return null
      const active = cline.effectiveLastUsedProvider(doc) === key
      const model = raw.settings && typeof raw.settings.model === 'string' ? raw.settings.model : ''
      return { key, active, model: active ? model : '', enabled: raw.enabled !== false }
    },
    clear() {
      const key = cline.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const doc = cline.readProvidersDoc()
      let touched = false
      if (doc.providers && doc.providers[key]) {
        delete doc.providers[key]
        touched = true
      }
      // lastUsedProvider 先清掉：条目已不存在，留着就是悬空引用（after 会写回）
      if (doc.lastUsedProvider === key) {
        delete doc.lastUsedProvider
        touched = true
      }
      const voice = doc.modes && doc.modes.voiceInput
      if (voice && voice.providerId === key) {
        delete doc.modes.voiceInput
        touched = true
      }
      if (touched) cline.writeProvidersDoc(doc)
      const modelsDoc = cline.readModelsDoc()
      if (modelsDoc.providers && modelsDoc.providers[key]) {
        delete modelsDoc.providers[key]
        cline.writeModelsDoc(modelsDoc)
      }
    },
    after(prior, applied) {
      if (!applied.length) return
      const key = prior.key
      // 停用开关原样保留（Cline 自己的启用/停用就是条目顶层的 enabled）
      if (prior.enabled === false) {
        const doc = cline.readProvidersDoc()
        if (doc.providers && doc.providers[key]) {
          doc.providers[key].enabled = false
          cline.writeProvidersDoc(doc)
        }
      }
      if (!prior.active) return
      const chosen = pickAppliedModel(prior, applied)
      cline.setClineDefaultModelForProvider(key, chosen)
      cline.setClineActiveProvider(key)
    },
  },

  // Command Code：providers.json provider.<key>（含 models 字典）+ settings.json model + 供应商级 disabled
  commandcode: {
    apis: commandCode.CC_APIS,
    before() {
      const key = commandCode.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const prev = commandCode.getCommandCodeProviderList().find((p) => p.id === key)
      if (!prev) return null
      const def = commandCode.getCommandCodeDefaultModel()
      const active = def.provider === key
      return { key, active, model: active ? String(def.modelId || '') : '', disabled: prev.disabled === true }
    },
    clear() {
      // 不走 deleteCommandCodeProvider：它会顺带清掉 auth.json 里的 key，重建时 key 为空就会丢
      const key = commandCode.providerKeyFor(AUTOROUTE_PROVIDER_NAME)
      const doc = commandCode.readProvidersDoc()
      if (!doc.provider || !doc.provider[key]) return
      delete doc.provider[key]
      commandCode.writeProvidersDoc(doc)
    },
    after(prior, applied) {
      if (!applied.length) return
      const key = prior.key
      const doc = commandCode.readProvidersDoc()
      const entry = doc.provider && doc.provider[key]
      if (!entry) return
      if (prior.disabled === true && entry.disabled !== true) {
        entry.disabled = true
        commandCode.writeProvidersDoc(doc)
      }
      if (prior.active) commandCode.setCommandCodeDefaultModel(key, pickAppliedModel(prior, applied))
    },
  },
}

const dispatchAutoRoute = (targets) => {
  const config = autoroute.readAutoRouteConfig();
  const enabled = autoroute.resolveAutoRouteModels(config);
  if (!enabled.length)
    throw new Error(
      config.mode === "mapping"
        ? t("service.dispatch.routeMappingRequired")
        : t("service.dispatch.routeModelsRequired"),
    );
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0)
    throw new Error(t("service.dispatch.selectTargetAgent"));
  const baseUrl = `http://127.0.0.1:${config.port}`;
  // 映射模式下发给 agent 的模型 ID 用映射名（agent 侧固定的名字）；
  // 浅拷贝保留 contextWindow / cost 等元数据，仅覆盖 id/name，网关侧把映射名路由到实际模型
  const models = enabled.map(({ model, alias }) =>
    config.mode === "mapping" && alias ? { ...model, id: alias, name: alias } : model
  );
  const results = [];
  for (const target of list) {
    const d = APP_DISPATCHERS[target && target.app];
    if (!d) {
      results.push({ app: (target && target.app) || "unknown", ok: false, message: t("service.dispatch.unknownTargetAgent") });
      continue;
    }
    const isCodex = (target && target.app) === "codex";
    // kimi / zcode 的 openai 类型按 SDK 约定向 baseUrl 追加端点路径，网关路径需带 /v1（同 Codex）
    const isKimi = (target && target.app) === "kimi";
    const isZcode = (target && target.app) === "zcode";
    // grok 自己只把 api_backend 对应的路径（messages / chat/completions / responses）拼在 base_url 后面，
    // 不补 /v1，所以网关路径必须带 /v1（与 Codex / Kimi / ZCode 同理）
    const isGrok = (target && target.app) === "grok";
    // cline 的 openai-compatible 会自行拼 /chat/completions，不补 /v1，网关路径需带 /v1（同 Codex / Kimi / ZCode）
    const isCline = (target && target.app) === "cline";
    // commandcode 同 grok：按 api 把 chat/completions | responses | messages 拼在 baseURL 后，
    // 不补 /v1，因此网关路径必须带 /v1
    const isCommandCode = (target && target.app) === "commandcode";
    const provider = {
      name: AUTOROUTE_PROVIDER_NAME,
      // hermes 同 claude 走网关的 Anthropic Messages 入站（api_mode: anthropic_messages），base_url 不带 /v1；
      // dsh 的 pi-ai anthropic-messages 路由同样填网关根地址（SDK 自行追加 /v1/messages）
      api: (target && target.app) === "claude" || (target && target.app) === "hermes" || (target && target.app) === "dsh" || isGrok ? "anthropic-messages" : isCodex ? "openai-responses" : "openai-completions",
      apiKey: config.key || "",
      baseUrl: isCodex || isKimi || isZcode || isGrok || isCline || isCommandCode ? `${baseUrl}/v1` : baseUrl,
      models,
    };
    // 网关下发 = 覆盖式重建 router 供应商（仅当协议兼容时才清理，否则先删再报错会丢配置）
    const rebuild = AUTOROUTE_REBUILD[target.app];
    const canRebuild = !!rebuild && (!rebuild.apis || rebuild.apis.includes(provider.api));
    let prior = null;
    if (canRebuild) {
      try {
        prior = rebuild.before();
      } catch (e) {
        prior = null;
      }
      if (prior) {
        try {
          rebuild.clear(prior);
        } catch (e) {
          results.push({ app: target.app, ok: false, message: e.message || String(e) });
          continue;
        }
      }
    }
    const targetResults = [];
    const applied = [];
    for (const model of models) {
      try {
        const message = d.run(provider, model, {
          providerName: AUTOROUTE_PROVIDER_NAME,
          // 只有 Codex 认模型目录 URL：指向网关的 /v1/codex/models（与 /v1/models 同一套模型 ID）
          codexModelCatalogUrl: isCodex ? `${baseUrl}/v1/codex/models` : undefined,
        });
        applied.push(model.id);
        targetResults.push({ app: target.app, ok: true, message });
      } catch (e) {
        targetResults.push({ app: target.app, ok: false, message: e.message || String(e) });
      }
    }
    // 重建后恢复「原本生效 / 原本停用」的状态，并沿用原默认模型（已不在新清单则取第一个）
    if (canRebuild && prior) {
      try {
        rebuild.after(prior, applied);
      } catch (e) {
        targetResults.push({ app: target.app, ok: false, message: e.message || String(e) });
      }
    }
    // 该目标全部模型写入成功后，清理历史版本遗留的中文「自动路由」条目
    if (targetResults.length > 0 && targetResults.every((r) => r.ok)) {
      cleanupLegacyAutoRoute(target.app);
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
  qoder: { run: dispatchToQoder },
  zcode: { run: dispatchToZcode },
  hermes: { run: dispatchToHermes },
  dsh: { run: dispatchToDsh },
  grok: { run: dispatchToGrok },
  cline: { run: dispatchToCline },
  commandcode: { run: dispatchToCommandCode },
}

// 主入口：provider/model 来自通用库（apiKey 已解密），targets = [{ app, providerName?, setDefault? }]
// 返回 [{ app, ok, message }]，单个失败不中断其他目标
const dispatchCommonModel = (provider, model, targets) => {
  if (!provider || !provider.name)
    throw new Error(t('service.dispatch.selectProvider'))
  if (!model || !model.id) throw new Error(t('service.dispatch.selectModel'))
  const list = Array.isArray(targets) ? targets : []
  if (list.length === 0)
    throw new Error(t('service.dispatch.selectTargetAgent'))
  const results = []
  for (const target of list) {
    const d = APP_DISPATCHERS[target && target.app]
    if (!d) {
      results.push({ app: (target && target.app) || 'unknown', ok: false, message: t('service.dispatch.unknownTargetAgent') })
      continue
    }
    try {
      const message = d.run(provider, model, {
        providerName: (target.providerName && String(target.providerName).trim()) || provider.name,
        setDefault: !!target.setDefault,
      })
      results.push({ app: target.app, ok: true, message })
    } catch (e) {
      results.push({ app: target.app, ok: false, message: e.message || String(e) })
    }
  }
  return results
}

module.exports = {
  dispatchCommonModel,
  dispatchAutoRoute,
  // 内部实现导出，供测试/复用
  dispatchToClaude, dispatchToOpencode, dispatchToPi, dispatchToOmp, dispatchToReasonix, dispatchToCodex, dispatchToKimi, dispatchToMinimax, dispatchToQoder, dispatchToZcode, dispatchToHermes, dispatchToDsh, dispatchToGrok, dispatchToCline, dispatchToCommandCode,
}
