const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { parse: parseToml, stringify: stringifyToml } = require('smol-toml')
const { t } = require("./i18n")
const { isDirEntry, countEntries, rmEntry } = require('./fs-utils')

// ==================== Grok Build（xAI 官方编码 CLI，命令 `grok`） ====================
// 主配置：~/.grok/config.toml（GROK_HOME 可重定向主目录，插件需跟随，同 Codex/Hermes 先例）。
// 本服务只管理四处，其余配置节（[ui] / [features] / [permissions] / [hooks] / [plugins] …）
// 读改写原样保留：
//   [model.<id>]            — 自定义模型 / 官方模型覆盖。受管字段：
//       model / base_url / name / api_backend / api_key / env_key / context_window /
//       max_completion_tokens / temperature / top_p / extra_headers / model_provider
//     （api_backend = chat_completions | responses | messages，与通用库四协议中的三种对应；
//      messages 走 Anthropic /v1/messages，但鉴权仍是 Bearer，需要 x-api-key 时用 extra_headers）
//   [model_providers.<name>] — 可选的命名供应商连接信息（base_url / api_backend / api_key /
//       env_key / extra_headers …），被 model.<id>.model_provider 引用；UI 不单独管理，只读展示
//   [models]                — 顶层 default（新会话默认模型，存模型目录键 = [model.<id>] 的 id）
//   顶层 disabled_mcp_servers — 关闭的 MCP 服务器名单（grok mcp disable 的落点，与
//       [mcp_servers.<name>].enabled 配合；UI 启停同时写这两处，与官方 CLI 行为一致）
// Skill：~/.grok/skills/<name>/SKILL.md（官方路径，见文档 File locations）。
// 使用统计：~/.grok/sessions/<encoded-cwd>/<session-id>/usage.json
//   { sessionId, updatedAt, session: UsageSummary, turns: [{ turnNumber, endedAt, ...UsageSummary }] }
//   UsageSummary：inputTokens / outputTokens / cachedReadTokens / cacheCreationTokens /
//   reasoningTokens / totalTokens / modelCalls / costUsdTicks / primaryModelId / modelUsage
//   （serde camelCase）。口径与 DSH / Claude 一致：输入含缓存读 + 缓存写，输出单列。
// 已知取舍：整档 smol-toml 重写不保留 TOML 注释（同 codex / kimi / reasonix）。

const GROK_HOME = () => process.env.GROK_HOME || path.join(os.homedir(), '.grok')
const GROK_CONFIG_PATH = () => path.join(GROK_HOME(), 'config.toml')
const GROK_SESSIONS_DIR = () => path.join(GROK_HOME(), 'sessions')
const GROK_SKILLS_PATH = () => path.join(GROK_HOME(), 'skills')
const getGrokHome = GROK_HOME
const getGrokConfigPath = GROK_CONFIG_PATH
const getGrokSessionsDir = GROK_SESSIONS_DIR
const getGrokSkillsPath = GROK_SKILLS_PATH

// 官方支持的三线协议（xai-grok-sampling-types 的 ApiBackend）：
// chat_completions（默认，OpenAI /v1/chat/completions）、responses（OpenAI /v1/responses）、
// messages（Anthropic /v1/messages）。google-generative-ai 无对应实现，写入前拦截。
const GROK_API_BACKENDS = ['chat_completions', 'responses', 'messages']
const DEFAULT_API_BACKEND = 'chat_completions'

// 模型目录键：允许字母数字下划线中划线点冒号斜杠（openrouter 风格 vendor/model 很常见）；
// 加引号由 smol-toml 负责，这里只管合法性
const MODEL_ID_RE = /^[\w.:\-\/]+$/
// 供应商名（TOML 子表键，被 model_provider 引用）
const PROVIDER_NAME_RE = /^[\w.:\-]+$/
// MCP 服务器名：官方只允许字母数字中划线下划线（grok mcp add 校验规则）
const MCP_NAME_RE = /^[A-Za-z_][\w-]*$/

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : v == null ? 0 : Number(v) || 0)

// ==================== config.toml 读写 ====================

const readGrokConfig = () => {
  const p = GROK_CONFIG_PATH()
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    return parseToml(raw) || {}
  } catch (e) {
    // 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会覆盖整个
    // config.toml，抹掉 [mcp_servers] / [features] / [plugins] 等节（同 codex/kimi 纪律）。
    // Grok 自身也遵守这条：无法解析的用户 config.toml 不会被覆盖。
    throw new Error(t('serviceAgent.common.tomlParseFailed', { message: e.message }))
  }
}

const writeGrokConfig = (doc) => {
  const p = GROK_CONFIG_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, stringifyToml(doc || {}), { encoding: 'utf-8' })
  return true
}

// [model.<id>] 子表（模型目录；内置模型也可只用少量字段覆盖）
const getModelTables = (doc) => {
  if (!doc.model || typeof doc.model !== 'object' || Array.isArray(doc.model)) doc.model = {}
  return doc.model
}

// [model_providers.<name>] 子表（可选命名供应商）
const getProviderTables = (doc) => {
  if (!doc.model_providers || typeof doc.model_providers !== 'object' || Array.isArray(doc.model_providers)) {
    doc.model_providers = {}
  }
  return doc.model_providers
}

// [mcp_servers.<name>] 子表
const getMcpTables = (doc) => {
  if (!doc.mcp_servers || typeof doc.mcp_servers !== 'object' || Array.isArray(doc.mcp_servers)) {
    doc.mcp_servers = {}
  }
  return doc.mcp_servers
}

// 顶层 [models] 节（default / web_search / temperature 等全局默认）
const getModelsSection = (doc) => {
  if (!doc.models || typeof doc.models !== 'object' || Array.isArray(doc.models)) doc.models = {}
  return doc.models
}

// ==================== 供应商（[model_providers.<name>]）====================
// Grok 官方的分层写法：供应商表放共享连接信息（base_url / api_backend / api_key /
// env_key / context_window / extra_headers），模型通过 model_provider 引用它并只声明
// 自己不同的字段（model / name / 采样参数 / 上限）。UI 结构对齐 Codex / Qoder：
// 供应商手风琴 + 组内模型列表 + 星标设默认。
// 仍然兼容「内联模型」写法（官方文档里直接给 [model.<id>] 写 base_url 的例子）：
// 这类模型没有 model_provider，归到「未分组模型」区，连接信息写在模型条目自己身上。

// 显式管理的供应商字段；其余（api_base_url / auth / auth_provider / query_params /
// env_http_headers / max_request_bytes / context_windows …）收进 _extra 原样往返
const KNOWN_PROVIDER_FIELDS = [
  'base_url', 'api_key', 'env_key', 'api_backend', 'context_window', 'extra_headers',
]

// 显式管理的模型字段；其余（reasoning_efforts / reasoning_summary / model_family /
// query_params / env_http_headers / notice / hidden / stream_tool_calls …）收进 _extra
const KNOWN_MODEL_FIELDS = [
  'model', 'name', 'description', 'model_provider', 'context_window',
  'max_completion_tokens', 'temperature', 'top_p', 'extra_headers',
  // 内联模型才用到的连接信息（挂在供应商上时留空，由供应商提供）
  'base_url', 'api_backend', 'api_key', 'env_key',
]

// 官方内置模型目录里常见的一批（模型选择器候选 + 「覆盖内置模型」判定的兜底；
// 远端目录可用 /v1/models 覆盖，这里只做离线提示，不写入配置）
const GROK_BUILTIN_MODELS = ['grok-4.6', 'grok-4.5', 'grok-4.5-mini']

const normalizeEnvKey = (raw) =>
  Array.isArray(raw)
    ? raw.filter((x) => typeof x === 'string' && x).join(',')
    : typeof raw === 'string'
      ? raw
      : ''

const splitEnvKey = (envKey) =>
  String(envKey || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const cleanHeaders = (headers) => {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).trim()) out[String(k).trim()] = String(v == null ? '' : v)
  }
  return out
}

const normalizeProvider = (name, p) => {
  const raw = p && typeof p === 'object' ? p : {}
  const extra = {}
  for (const k of Object.keys(raw)) {
    if (!KNOWN_PROVIDER_FIELDS.includes(k)) extra[k] = raw[k]
  }
  return {
    name,
    baseUrl: typeof raw.base_url === 'string' ? raw.base_url : '',
    apiBackend: GROK_API_BACKENDS.includes(raw.api_backend) ? raw.api_backend : DEFAULT_API_BACKEND,
    apiKey: typeof raw.api_key === 'string' ? raw.api_key : '',
    envKey: normalizeEnvKey(raw.env_key),
    contextWindow: toNumber(raw.context_window),
    extraHeaders: raw.extra_headers && typeof raw.extra_headers === 'object' && !Array.isArray(raw.extra_headers)
      ? raw.extra_headers
      : {},
    hasKey: !!(raw.api_key || raw.env_key),
    _extra: extra,
  }
}

// UI 结构 → 写入 TOML 的 [model_providers.<name>] 对象（空值不输出，未知字段原样还原）
const buildProviderToml = (cfg) => {
  const p = { ...(cfg._extra || {}) }
  if (cfg.baseUrl) p.base_url = String(cfg.baseUrl).trim()
  if (cfg.apiBackend && cfg.apiBackend !== DEFAULT_API_BACKEND) p.api_backend = cfg.apiBackend
  if (cfg.apiKey) p.api_key = String(cfg.apiKey)
  const envKeys = splitEnvKey(cfg.envKey)
  if (envKeys.length === 1) p.env_key = envKeys[0]
  else if (envKeys.length > 1) p.env_key = envKeys
  if (Number(cfg.contextWindow) > 0) p.context_window = Number(cfg.contextWindow)
  const headers = cleanHeaders(cfg.extraHeaders)
  if (Object.keys(headers).length) p.extra_headers = headers
  return p
}

// 供应商列表；models 由 [model.<id>].model_provider 反查得出（Grok 没有嵌套模型表）
const getGrokProviderList = () => {
  const doc = readGrokConfig()
  const tables = getProviderTables(doc)
  const modelTables = getModelTables(doc)
  const byProvider = new Map()
  for (const [key, m] of Object.entries(modelTables)) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const ref = typeof m.model_provider === 'string' ? m.model_provider : ''
    if (!ref) continue
    if (!byProvider.has(ref)) byProvider.set(ref, [])
    byProvider.get(ref).push(normalizeModel(key, m))
  }
  return Object.entries(tables)
    .filter(([, p]) => p && typeof p === 'object' && !Array.isArray(p))
    .map(([name, p]) => {
      const provider = normalizeProvider(name, p)
      provider.models = (byProvider.get(name) || []).sort((a, b) => a.key.localeCompare(b.key))
      provider.modelCount = provider.models.length
      return provider
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// 「未分组」模型：没有 model_provider，或引用了不存在的供应商（悬挂引用也在这里露出，
// 避免用户在页面上完全看不到这些条目）
const getGrokUngroupedModels = () => {
  const doc = readGrokConfig()
  const tables = getModelTables(doc)
  const providers = getProviderTables(doc)
  return Object.entries(tables)
    .filter(([, m]) => m && typeof m === 'object' && !Array.isArray(m))
    .map(([key, m]) => normalizeModel(key, m))
    .filter((m) => !m.modelProvider || !providers[m.modelProvider])
    .sort((a, b) => a.key.localeCompare(b.key))
}

const addGrokProvider = (cfg) => {
  const name = assertProviderName(cfg && cfg.name)
  assertApiBackend(cfg && cfg.apiBackend)
  const doc = readGrokConfig()
  const tables = getProviderTables(doc)
  if (tables[name]) throw new Error(t('serviceAgent.common.providerExists', { name }))
  tables[name] = buildProviderToml({ ...cfg, name })
  writeGrokConfig(doc)
  return name
}

const updateGrokProvider = (name, updates) => {
  assertApiBackend(updates && updates.apiBackend)
  const doc = readGrokConfig()
  const tables = getProviderTables(doc)
  if (!tables[name]) throw new Error(t('serviceAgent.common.providerNotFound', { name }))
  const newName = updates.name === undefined || updates.name === name
    ? name
    : assertProviderName(updates.name)
  if (newName !== name && tables[newName]) {
    throw new Error(t('serviceAgent.common.providerExists', { name: newName }))
  }
  const prev = normalizeProvider(name, tables[name])
  const merged = { ...prev, ...updates, name: newName }
  if (updates.clearApiKey) merged.apiKey = ''
  if (updates.clearEnvKey) merged.envKey = ''
  delete merged.models
  delete merged.modelCount
  delete merged.hasKey
  delete tables[name]
  tables[newName] = buildProviderToml(merged)
  // 改名要同步引用它的模型（model_provider 是外键）
  if (newName !== name) {
    const modelTables = getModelTables(doc)
    for (const m of Object.values(modelTables)) {
      if (m && typeof m === 'object' && m.model_provider === name) m.model_provider = newName
    }
  }
  writeGrokConfig(doc)
  return newName
}

const deleteGrokProvider = (name) => {
  const doc = readGrokConfig()
  const tables = getProviderTables(doc)
  if (!tables[name]) throw new Error(t('serviceAgent.common.providerNotFound', { name }))
  // 有模型引用时不清空，避免连接信息凭空消失（同 Codex 的 providerInUse）
  const modelTables = getModelTables(doc)
  const used = Object.entries(modelTables)
    .filter(([, m]) => m && typeof m === 'object' && m.model_provider === name)
    .map(([key]) => key)
  if (used.length) {
    throw new Error(t('serviceAgent.grok.providerInUse', { name, models: used.join(', ') }))
  }
  delete tables[name]
  if (!Object.keys(tables).length) delete doc.model_providers
  writeGrokConfig(doc)
  return true
}

// ==================== 模型（[model.<id>]）====================

const normalizeModel = (key, m) => {
  const raw = m && typeof m === 'object' ? m : {}
  const extra = {}
  for (const k of Object.keys(raw)) {
    if (!KNOWN_MODEL_FIELDS.includes(k)) extra[k] = raw[k]
  }
  const modelProvider = typeof raw.model_provider === 'string' ? raw.model_provider : ''
  return {
    // key = [model.<key>] 的目录键（= models.default / -m 的取值）
    key,
    id: key,
    // model = 发往 API 的模型 ID
    model: typeof raw.model === 'string' && raw.model ? raw.model : key,
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    modelProvider,
    // 连接信息：挂在供应商上的模型留空（渲染时回退到供应商的值）
    baseUrl: typeof raw.base_url === 'string' ? raw.base_url : '',
    apiBackend: GROK_API_BACKENDS.includes(raw.api_backend) ? raw.api_backend : '',
    apiKey: typeof raw.api_key === 'string' ? raw.api_key : '',
    envKey: normalizeEnvKey(raw.env_key),
    contextWindow: toNumber(raw.context_window),
    maxCompletionTokens: toNumber(raw.max_completion_tokens),
    temperature: typeof raw.temperature === 'number' ? raw.temperature : null,
    topP: typeof raw.top_p === 'number' ? raw.top_p : null,
    extraHeaders: raw.extra_headers && typeof raw.extra_headers === 'object' && !Array.isArray(raw.extra_headers)
      ? raw.extra_headers
      : {},
    // 官方内置模型的覆盖（无连接信息、无供应商引用 → 只是在改内置模型的参数）
    isBuiltinOverride: !raw.base_url && !raw.api_key && !raw.env_key && !modelProvider,
    _extra: extra,
  }
}

// UI 结构 → 写入 TOML 的 [model.<key>] 对象；空值不输出（内置模型覆盖只写改过的字段）
const buildModelToml = (cfg) => {
  const m = { ...(cfg._extra || {}) }
  const key = String(cfg.key || cfg.id || '').trim()
  const model = String(cfg.model || '').trim() || key
  if (model) m.model = model
  if (cfg.name) m.name = String(cfg.name).trim()
  if (cfg.description) m.description = String(cfg.description).trim()
  if (cfg.modelProvider) m.model_provider = String(cfg.modelProvider).trim()
  // 内联连接信息（挂在供应商上的模型不写这些字段，交给供应商提供）
  if (cfg.baseUrl) m.base_url = String(cfg.baseUrl).trim()
  if (cfg.apiBackend && cfg.apiBackend !== DEFAULT_API_BACKEND) m.api_backend = cfg.apiBackend
  if (cfg.apiKey) m.api_key = String(cfg.apiKey)
  const envKeys = splitEnvKey(cfg.envKey)
  if (envKeys.length === 1) m.env_key = envKeys[0]
  else if (envKeys.length > 1) m.env_key = envKeys
  if (Number(cfg.contextWindow) > 0) m.context_window = Number(cfg.contextWindow)
  if (Number(cfg.maxCompletionTokens) > 0) m.max_completion_tokens = Number(cfg.maxCompletionTokens)
  if (typeof cfg.temperature === 'number' && cfg.temperature >= 0) m.temperature = cfg.temperature
  if (typeof cfg.topP === 'number' && cfg.topP >= 0) m.top_p = cfg.topP
  const headers = cleanHeaders(cfg.extraHeaders)
  if (Object.keys(headers).length) m.extra_headers = headers
  return m
}

// 平铺模型列表（跨供应商 + 未分组），供统计类或兜底场景使用
const getGrokModelList = () => {
  const doc = readGrokConfig()
  const tables = getModelTables(doc)
  return Object.entries(tables)
    .filter(([, m]) => m && typeof m === 'object' && !Array.isArray(m))
    .map(([key, m]) => normalizeModel(key, m))
    .sort((a, b) => a.key.localeCompare(b.key))
}

const addGrokModel = (providerName, cfg) => {
  const key = assertModelId(cfg && cfg.key)
  assertApiBackend(cfg && cfg.apiBackend)
  const provider = String(providerName || '').trim()
  if (provider) assertProviderName(provider)
  const doc = readGrokConfig()
  const tables = getModelTables(doc)
  if (tables[key]) throw new Error(t('serviceAgent.common.modelExists', { id: key }))
  const providers = getProviderTables(doc)
  if (provider && !providers[provider]) {
    throw new Error(t('serviceAgent.common.providerNotFound', { name: provider }))
  }
  tables[key] = buildModelToml({ ...cfg, key, modelProvider: provider })
  // 还没有默认模型时自动指向它（不覆盖用户已设的默认）
  const models = getModelsSection(doc)
  if (!models.default) models.default = key
  writeGrokConfig(doc)
  return key
}

const updateGrokModel = (key, updates) => {
  assertApiBackend(updates && updates.apiBackend)
  const doc = readGrokConfig()
  const tables = getModelTables(doc)
  if (!tables[key]) throw new Error(t('serviceAgent.common.modelNotFound', { id: key }))
  const newKey = updates.key === undefined || updates.key === key ? key : assertModelId(updates.key)
  if (newKey !== key && tables[newKey]) throw new Error(t('serviceAgent.common.modelExists', { id: newKey }))
  const provider = updates.modelProvider === undefined
    ? (typeof tables[key].model_provider === 'string' ? tables[key].model_provider : '')
    : String(updates.modelProvider || '').trim()
  if (provider) assertProviderName(provider)
  const providers = getProviderTables(doc)
  if (provider && !providers[provider]) {
    throw new Error(t('serviceAgent.common.providerNotFound', { name: provider }))
  }
  const prev = normalizeModel(key, tables[key])
  const merged = { ...prev, ...updates, key: newKey, modelProvider: provider }
  // 挂到供应商上时不保留内联连接信息（否则会盖掉供应商的值，改供应商也不生效）
  if (provider) {
    merged.baseUrl = ''
    merged.apiKey = ''
    merged.envKey = ''
    merged.apiBackend = ''
  }
  if (updates.clearApiKey) merged.apiKey = ''
  if (updates.clearEnvKey) merged.envKey = ''
  if (updates.clearBaseUrl) merged.baseUrl = ''
  delete merged.isBuiltinOverride
  delete merged.hasKey
  delete merged._resolved
  delete tables[key]
  tables[newKey] = buildModelToml(merged)
  // 默认模型跟着目录键改名（models.default 存的是目录键）
  const models = getModelsSection(doc)
  if (newKey !== key && models.default === key) models.default = newKey
  writeGrokConfig(doc)
  return true
}

const deleteGrokModel = (key) => {
  const doc = readGrokConfig()
  const tables = getModelTables(doc)
  if (!tables[key]) return true // 幂等：可能刚在 grok 内被删除
  delete tables[key]
  // 悬挂引用清理：默认模型指向它时回退到目录里任一模型，没有则删键（交回 Grok 内置默认）
  const models = getModelsSection(doc)
  if (models.default === key) {
    const next = Object.keys(getModelTables(doc))[0]
    if (next) models.default = next
    else delete models.default
  }
  writeGrokConfig(doc)
  return true
}

const assertApiBackend = (backend) => {
  if (backend && !GROK_API_BACKENDS.includes(backend)) {
    throw new Error(
      t('serviceAgent.grok.unsupportedApiBackend', {
        backend,
        options: GROK_API_BACKENDS.join(' / '),
      }),
    )
  }
}

const assertModelId = (id, key = 'modelIdInvalidChars') => {
  const s = String(id || '').trim()
  if (!s) throw new Error(t('serviceAgent.common.modelIdRequired'))
  if (!MODEL_ID_RE.test(s)) throw new Error(t(`serviceAgent.grok.${key}`))
  return s
}

const assertProviderName = (name) => {
  const s = String(name || '').trim()
  if (!s) throw new Error(t('serviceAgent.grok.providerNameRequired'))
  if (!PROVIDER_NAME_RE.test(s)) throw new Error(t('serviceAgent.grok.providerNameInvalidChars'))
  return s
}

// ==================== 默认模型（[models].default）====================

const getGrokDefaultModel = () => {
  const doc = readGrokConfig()
  const models = doc.models && typeof doc.models === 'object' ? doc.models : {}
  const webSearch = typeof models.web_search === 'string' ? models.web_search : ''
  return { modelId: typeof models.default === 'string' ? models.default : '', webSearch }
}

// modelId 为空 = 清除默认（回退 Grok 内置默认 grok-4.5）。
// 非空时必须指向已知模型：配置表里的目录键，或官方内置模型 ID。
const setGrokDefaultModel = (modelId) => {
  const id = String(modelId || '').trim()
  const doc = readGrokConfig()
  const models = getModelsSection(doc)
  if (!id) {
    delete models.default
    writeGrokConfig(doc)
    return true
  }
  const tables = getModelTables(doc)
  const known = !!tables[id] || GROK_BUILTIN_MODELS.includes(id)
  if (!known) throw new Error(t('serviceAgent.grok.modelNotFoundForDefault', { model: id }))
  models.default = id
  writeGrokConfig(doc)
  return true
}

// ==================== 下发用 upsert（dispatch.js 调用）====================

// 通用库供应商名可能是中文/任意符号，而 [model_providers.<name>] 与 [model.<key>] 的键
// 都要进 TOML 裸键位置，需确定性清洗（同一下发名永远得到同一键 → upsert 幂等）
const hashName = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
const providerKeyFor = (name) => {
  const raw = String(name || '').trim()
  if (PROVIDER_NAME_RE.test(raw)) return raw
  const base = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'p'
  return `${base}-${hashName(raw)}`
}

// 存在则合并更新（空值不覆盖既有 baseUrl/apiKey，未传的受管字段保留），否则创建。
// 供应商只放共享连接信息；模型条目通过 model_provider 引用它。
const upsertGrokProvider = (key, cfg) => {
  const name = assertProviderName(String(key || '').trim() || 'p')
  assertApiBackend(cfg && cfg.apiBackend)
  const doc = readGrokConfig()
  const providers = getProviderTables(doc)
  const prev = providers[name] && typeof providers[name] === 'object' ? providers[name] : null
  const merged = { ...(prev || {}) }
  const baseUrl = String(cfg.baseUrl || '').trim() || (prev && prev.base_url) || ''
  if (baseUrl) merged.base_url = baseUrl
  if (cfg.apiBackend) merged.api_backend = cfg.apiBackend
  if (cfg.apiKey) merged.api_key = String(cfg.apiKey)
  if (Number(cfg.contextWindow) > 0) merged.context_window = Number(cfg.contextWindow)
  providers[name] = merged
  writeGrokConfig(doc)
  return name
}

// 模型已存在时只刷新传入的受管字段（显示名 / 上下文 / 输出上限，未传的保留），不存在则新建；
// 返回模型目录键（= [model.<id>] 的键）
const upsertGrokModel = (providerKey, modelId, opts = {}) => {
  const id = assertModelId(modelId)
  const doc = readGrokConfig()
  const tables = getModelTables(doc)
  const providers = getProviderTables(doc)
  const prev = tables[id] && typeof tables[id] === 'object' ? tables[id] : {}
  const next = { ...prev }
  next.model = String(opts.model || id).trim() || id
  if (opts.name) next.name = String(opts.name).trim()
  // 连接信息引用命名供应商（供应商条目已由 upsertGrokProvider 建好）
  if (providerKey && providers[providerKey]) {
    next.model_provider = providerKey
    // 内联连接信息与供应商冲突，清掉
    delete next.base_url
    delete next.api_key
    delete next.env_key
    delete next.api_backend
  }
  if (Number(opts.contextWindow) > 0) next.context_window = Number(opts.contextWindow)
  if (Number(opts.maxTokens) > 0) next.max_completion_tokens = Number(opts.maxTokens)
  if (opts.apiBackend) next.api_backend = opts.apiBackend
  // 模型级请求参数（通用库 description / temperature / topP / extraHeaders）
  if (opts.description) next.description = String(opts.description).trim()
  if (typeof opts.temperature === 'number' && opts.temperature >= 0) next.temperature = opts.temperature
  if (typeof opts.topP === 'number' && opts.topP >= 0) next.top_p = opts.topP
  if (opts.extraHeaders && typeof opts.extraHeaders === 'object') {
    const headers = cleanHeaders(opts.extraHeaders)
    if (Object.keys(headers).length) next.extra_headers = headers
  }
  tables[id] = next
  // 尚无默认模型时自动指向刚写入的模型（不覆盖用户已设的默认）
  const models = getModelsSection(doc)
  if (!models.default) models.default = id
  writeGrokConfig(doc)
  return id
}

// ==================== MCP（[mcp_servers.<name>]）====================

// UI 认识并显式管理的字段；其余（oauth / setup / tool_timeouts / bearer_token_file …）
// 收进 _extra 原样往返
const KNOWN_MCP_FIELDS = [
  'command', 'args', 'env', 'cwd', 'url', 'type', 'headers', 'enabled',
  'startup_timeout_sec', 'tool_timeout_sec', 'bearer_token_env_var',
]

const normalizeMcpServer = (name, cfg, disabledList) => {
  const raw = cfg && typeof cfg === 'object' ? cfg : {}
  const extra = {}
  for (const k of Object.keys(raw)) {
    if (!KNOWN_MCP_FIELDS.includes(k)) extra[k] = raw[k]
  }
  const isHttp = typeof raw.url === 'string' && raw.url
  return {
    name,
    // type：url 即 HTTP/SSE（官方用 type = "sse" 区分老 SSE 传输）；没有 url 就是 stdio
    type: isHttp ? (String(raw.type || '').toLowerCase() === 'sse' ? 'sse' : 'http') : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : '',
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
    url: isHttp ? raw.url : '',
    env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : {},
    headers: raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers) ? raw.headers : {},
    startupTimeoutSec: toNumber(raw.startup_timeout_sec),
    toolTimeoutSec: toNumber(raw.tool_timeout_sec),
    bearerTokenEnvVar: typeof raw.bearer_token_env_var === 'string' ? raw.bearer_token_env_var : '',
    // 关闭状态两个来源：条目 enabled = false，或名字进了顶层 disabled_mcp_servers
    enabled: raw.enabled !== false && !disabledList.includes(name),
    _extra: extra,
  }
}

const disabledMcpList = (doc) =>
  Array.isArray(doc.disabled_mcp_servers)
    ? doc.disabled_mcp_servers.filter((x) => typeof x === 'string')
    : []

const buildMcpToml = (cfg) => {
  const m = { ...(cfg._extra || {}) }
  if (cfg.type === 'http' || cfg.type === 'sse') {
    m.url = String(cfg.url || '').trim()
    if (cfg.type === 'sse') m.type = 'sse'
    else delete m.type
    delete m.command
    delete m.args
    delete m.cwd
    const headers = {}
    for (const [k, v] of Object.entries(cfg.headers || {})) {
      if (String(k).trim()) headers[String(k).trim()] = String(v == null ? '' : v)
    }
    if (Object.keys(headers).length) m.headers = headers
    else delete m.headers
    delete m.env
  } else {
    m.command = String(cfg.command || '').trim()
    const args = Array.isArray(cfg.args) ? cfg.args.filter((a) => String(a).trim() !== '') : []
    if (args.length) m.args = args.map((a) => String(a))
    else delete m.args
    const env = {}
    for (const [k, v] of Object.entries(cfg.env || {})) {
      if (String(k).trim()) env[String(k).trim()] = String(v == null ? '' : v)
    }
    if (Object.keys(env).length) m.env = env
    else delete m.env
    delete m.url
    delete m.type
    delete m.headers
  }
  if (Number(cfg.startupTimeoutSec) > 0) m.startup_timeout_sec = Number(cfg.startupTimeoutSec)
  else delete m.startup_timeout_sec
  if (Number(cfg.toolTimeoutSec) > 0) m.tool_timeout_sec = Number(cfg.toolTimeoutSec)
  else delete m.tool_timeout_sec
  if (cfg.bearerTokenEnvVar) m.bearer_token_env_var = String(cfg.bearerTokenEnvVar).trim()
  else delete m.bearer_token_env_var
  // 关闭状态写入 disabled 名单（官方 grok mcp disable 的落点），条目本身不写 enabled
  delete m.enabled
  return m
}

const getGrokMcpServers = () => {
  const doc = readGrokConfig()
  const tables = getMcpTables(doc)
  const disabled = disabledMcpList(doc)
  return Object.entries(tables)
    .filter(([, c]) => c && typeof c === 'object' && !Array.isArray(c))
    .map(([name, c]) => {
      const server = normalizeMcpServer(name, c, disabled)
      return server
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

// 供 MCP 卡片「查看工具」复用：把 Grok 侧字段映射成通用 config 形状
const toGenericMcpConfig = (server) => {
  if (!server) return null
  if (server.type === 'http' || server.type === 'sse') {
    return { type: 'http', url: server.url, headers: server.headers }
  }
  return { type: 'stdio', command: server.command, args: server.args, env: server.env }
}

const assertMcpName = (name) => {
  const s = String(name || '').trim()
  if (!s) throw new Error(t('serviceAgent.grok.mcpNameRequired'))
  if (!MCP_NAME_RE.test(s)) throw new Error(t('serviceAgent.grok.mcpNameInvalidChars'))
  return s
}

// 写入一个 MCP 服务器：存在则原地更新（保留未知字段），否则新增；
// enabled 同时同步 disabled_mcp_servers（官方 CLI 的开关落点）
const setGrokMcpServer = (name, cfg) => {
  const sname = assertMcpName(name)
  const doc = readGrokConfig()
  const tables = getMcpTables(doc)
  const prev = tables[sname] && typeof tables[sname] === 'object' ? tables[sname] : {}
  const prevNormalized = normalizeMcpServer(sname, prev, disabledMcpList(doc))
  const merged = {
    ...prevNormalized,
    ...cfg,
    _extra: prevNormalized._extra,
  }
  if (!merged.command && (merged.type === 'stdio')) {
    throw new Error(t('serviceAgent.grok.mcpCommandRequired'))
  }
  if ((merged.type === 'http' || merged.type === 'sse') && !String(merged.url || '').trim()) {
    throw new Error(t('serviceAgent.grok.mcpUrlRequired'))
  }
  tables[sname] = buildMcpToml(merged)
  const disabled = disabledMcpList(doc)
  const nextDisabled = merged.enabled === false
    ? (disabled.includes(sname) ? disabled : [...disabled, sname])
    : disabled.filter((n) => n !== sname)
  if (nextDisabled.length) doc.disabled_mcp_servers = nextDisabled
  else delete doc.disabled_mcp_servers
  writeGrokConfig(doc)
  return sname
}

const setGrokMcpEnabled = (name, enabled) => {
  const sname = assertMcpName(name)
  const doc = readGrokConfig()
  const tables = getMcpTables(doc)
  if (!tables[sname]) throw new Error(t('serviceAgent.grok.mcpNotFound', { name: sname }))
  const disabled = disabledMcpList(doc)
  const nextDisabled = enabled
    ? disabled.filter((n) => n !== sname)
    : (disabled.includes(sname) ? disabled : [...disabled, sname])
  if (nextDisabled.length) doc.disabled_mcp_servers = nextDisabled
  else delete doc.disabled_mcp_servers
  // 条目上显式的 enabled = false（可能是项目级 sticky 的同名字段）也要清掉，避免开关看起来没生效
  const entry = tables[sname]
  if (enabled) delete entry.enabled
  writeGrokConfig(doc)
  return true
}

const deleteGrokMcpServer = (name) => {
  const sname = String(name || '').trim()
  if (!sname) throw new Error(t('serviceAgent.grok.mcpNameRequired'))
  const doc = readGrokConfig()
  const tables = getMcpTables(doc)
  delete tables[sname]
  const disabled = disabledMcpList(doc).filter((n) => n !== sname)
  if (disabled.length) doc.disabled_mcp_servers = disabled
  else delete doc.disabled_mcp_servers
  writeGrokConfig(doc)
  return true
}

// ==================== Skill（~/.grok/skills）====================

// 官方扫描 ~/.grok/skills/<name>/SKILL.md（也递归子目录，取首个同名），
// 这里只读一层目录 + 根 SKILL.md，与 OpenCode 视图一致；
// 启停沿用 .disabled 目录机制（与 Claude / OpenCode / 通用 Skill 同一套心智）
const SKILL_DISABLED_DIR = '.disabled'

const readSkillEntry = (skillPath, disabled) => {
  const skillMdPath = path.join(skillPath, 'SKILL.md')
  if (!fs.existsSync(skillMdPath)) return null
  const content = fs.readFileSync(skillMdPath, { encoding: 'utf-8' }).replace(/^\uFEFF/, '')
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return {
    name: path.basename(skillPath),
    frontmatter: frontmatterMatch ? frontmatterMatch[1] : '',
    path: skillPath,
    skillMdPath,
    fileCount: countEntries(skillPath),
    disabled,
  }
}

const getGrokSkills = () => {
  const dir = GROK_SKILLS_PATH()
  const skills = []
  const scan = (base, disabled) => {
    if (!fs.existsSync(base)) return
    let entries = []
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch (e) {
      console.error('[grok] 读取 skills 目录失败:', e)
      return
    }
    for (const entry of entries) {
      if (!isDirEntry(base, entry) || entry.name === SKILL_DISABLED_DIR) continue
      try {
        const skill = readSkillEntry(path.join(base, entry.name), disabled)
        if (skill) skills.push(skill)
      } catch (e) {
        console.error('[grok] 读取 skill 失败:', entry.name, e)
      }
    }
  }
  scan(dir, false)
  scan(path.join(dir, SKILL_DISABLED_DIR), true)
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// 启停 = 目录物理移动（同 Claude / OpenCode / 通用 Skill）：enabled 时从 .disabled 移回，反之移入
const setGrokSkillEnabled = (skillName, enabled) => {
  const dir = GROK_SKILLS_PATH()
  const disabledDir = path.join(dir, SKILL_DISABLED_DIR)
  const from = enabled ? path.join(disabledDir, skillName) : path.join(dir, skillName)
  const to = enabled ? path.join(dir, skillName) : path.join(disabledDir, skillName)
  if (!fs.existsSync(from)) return { success: false, error: t('service.skill.notFound') }
  if (fs.existsSync(to)) return { success: false, error: t('service.skill.alreadyExists') }
  if (!fs.existsSync(disabledDir)) fs.mkdirSync(disabledDir, { recursive: true })
  try {
    fs.renameSync(from, to)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

const deleteGrokSkill = (skillName, isDisabled) => {
  const dir = GROK_SKILLS_PATH()
  const skillPath = isDisabled
    ? path.join(dir, SKILL_DISABLED_DIR, skillName)
    : path.join(dir, skillName)
  if (!fs.existsSync(skillPath)) return { success: false, error: t('service.skill.notFound') }
  try {
    // 软链接只删链接本身
    rmEntry(skillPath)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

const getGrokSkillsDir = () => {
  const dir = GROK_SKILLS_PATH()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ==================== 使用统计（~/.grok/sessions）====================
// 每个会话目录一份 usage.json（官方 --json / `grok usage` 的落盘版本）：
//   session.modelUsage = { "<模型ID>": UsageSummary }，turns[] 为逐轮增量。
// 口径（与 Claude / DSH / ZCode 统计页一致，UsagePage 的日期筛选依赖该形状）：
//   输入（含缓存）= inputTokens + cachedReadTokens + cacheCreationTokens；输出 = outputTokens
//   单日 tokens = 输入含缓存 + 输出；day.models[name] 存「未缓存输入 / 输出 / 缓存读 / 缓存写」
// 按 turn 而非 session 汇总：多天会话的用量能落到正确的日期上。turn.endedAt 为 RFC3339 时间。
// 历史落库：ccconfig_agent_usage_grok_<nativeId>（与「通用」统计页同源），源文件被清理后回放历史。

const USAGE_FILE = 'usage.json'
const SUMMARY_FILE = 'summary.json'

// 遍历 sessions/<encoded-cwd>/<session-id>/usage.json（只取带 usage.json 的目录）
const listSessionDirs = () => {
  const root = GROK_SESSIONS_DIR()
  if (!fs.existsSync(root)) return []
  const out = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (e) {
    console.error('[grok] 读取 sessions 目录失败:', e)
    return []
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch (e) {
      continue
    }
    for (const session of sessions) {
      const dir = path.join(projectDir, session.name)
      const usageFile = path.join(dir, USAGE_FILE)
      if (!fs.existsSync(usageFile)) continue
      // 目录名即会话 ID；.cwd 记录真实工作目录（组名被截断时才有，读不到就算了）
      let cwd = ''
      try {
        const cwdFile = path.join(projectDir, '.cwd')
        if (fs.existsSync(cwdFile)) cwd = fs.readFileSync(cwdFile, 'utf-8').trim()
      } catch (e) { /* ignore */ }
      out.push({ sessionId: session.name, dir, usageFile, projectDir, cwd })
    }
  }
  return out
}

const dayKeyOf = (iso) => {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return null
  // 与其它 agent 一致：按本地时区分日（toISOString 是 UTC，会让东八区凌晨算到前一天）
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// usage.json 里 modelUsage 的键是「发往 API 的模型 ID」；没有 modelUsage 时退回 primaryModelId
const modelRowsOf = (usageSummary) => {
  const summary = usageSummary && typeof usageSummary === 'object' ? usageSummary : {}
  const modelUsage = summary.modelUsage && typeof summary.modelUsage === 'object' ? summary.modelUsage : null
  if (modelUsage && Object.keys(modelUsage).length) {
    return Object.entries(modelUsage).map(([name, u]) => ({ name, usage: u || {} }))
  }
  const primary = typeof summary.primaryModelId === 'string' && summary.primaryModelId
    ? summary.primaryModelId
    : 'unknown'
  return [{ name: primary, usage: summary }]
}

const collectUsageRecords = () => {
  const messageRecords = []
  const sessionMap = new Map()
  for (const session of listSessionDirs()) {
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(session.usageFile, { encoding: 'utf-8' }))
    } catch (e) {
      // 正在写入 / 空文件：跳过该会话，下次刷新再读（同 dsh 的断尾帧取舍）
      continue
    }
    if (!doc || typeof doc !== 'object') continue
    const turns = Array.isArray(doc.turns) ? doc.turns : []
    const sess = {
      sessionId: session.sessionId,
      timestamp: '',
      cwd: session.cwd || session.projectDir,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    sessionMap.set(session.sessionId, sess)
    for (const turn of turns) {
      if (!turn || typeof turn !== 'object') continue
      const date = dayKeyOf(turn.endedAt) || dayKeyOf(doc.updatedAt)
      if (!date) continue
      const rows = modelRowsOf(turn)
      for (const row of rows) {
        const u = row.usage
        const input = toNumber(u.inputTokens)
        const output = toNumber(u.outputTokens)
        const cacheRead = toNumber(u.cachedReadTokens)
        const cacheWrite = toNumber(u.cacheCreationTokens)
        const total = input + output + cacheRead + cacheWrite
        if (total === 0) continue
        messageRecords.push({
          sessionId: session.sessionId,
          model: String(row.name || 'unknown').trim() || 'unknown',
          date,
          timestamp: turn.endedAt ? new Date(turn.endedAt).getTime() : 0,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheWrite,
          totalTokens: total,
        })
        sess.inputTokens += input
        sess.outputTokens += output
        sess.cacheReadTokens += cacheRead
        sess.cacheCreationTokens += cacheWrite
        const ts = turn.endedAt ? new Date(turn.endedAt).toISOString() : ''
        if (ts && (!sess.timestamp || ts > sess.timestamp)) sess.timestamp = ts
      }
    }
    // 没有 turns（老版本 / 只有 session 汇总）时退回整会话汇总，日期取 updatedAt
    if (!turns.length) {
      const date = dayKeyOf(doc.updatedAt)
      const rows = modelRowsOf(doc.session)
      for (const row of rows) {
        const u = row.usage
        const input = toNumber(u.inputTokens)
        const output = toNumber(u.outputTokens)
        const cacheRead = toNumber(u.cachedReadTokens)
        const cacheWrite = toNumber(u.cacheCreationTokens)
        const total = input + output + cacheRead + cacheWrite
        if (!date || total === 0) continue
        messageRecords.push({
          sessionId: session.sessionId,
          model: String(row.name || 'unknown').trim() || 'unknown',
          date,
          timestamp: doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheWrite,
          totalTokens: total,
        })
        sess.inputTokens += input
        sess.outputTokens += output
        sess.cacheReadTokens += cacheRead
        sess.cacheCreationTokens += cacheWrite
        if (doc.updatedAt) sess.timestamp = new Date(doc.updatedAt).toISOString()
      }
    }
  }
  return { messageRecords, sessionMap }
}

// 从 contributions 重算 summary / modelStats：口径与 DSH 统计页一致（输入含缓存）。
// 注意两处 inputTokens 语义不同（对齐 UsagePage 的消费方式）：
//   day.inputTokens          = 当天输入（含缓存）——日期区间筛选直接取该字段显示
//   day.models[].inputTokens = 当天该模型的未缓存输入——页面重算会再叠加缓存字段
const aggregate = (contributions, messageCount, sessionCount) => {
  let totalTokens = 0
  let outputTokens = 0
  const modelMap = new Map()
  for (const day of contributions) {
    totalTokens += day.tokens || 0
    outputTokens += day.outputTokens || 0
    day.inputTokens = (day.tokens || 0) - (day.outputTokens || 0)
    for (const [name, m] of Object.entries(day.models || {})) {
      if (!modelMap.has(name)) modelMap.set(name, { name, tokens: 0, inputTokens: 0, outputTokens: 0 })
      const mm = modelMap.get(name)
      const cacheR = m.cacheReadTokens || 0
      const cacheC = m.cacheCreationTokens || 0
      mm.tokens += (m.inputTokens || 0) + (m.outputTokens || 0) + cacheR + cacheC
      mm.inputTokens += (m.inputTokens || 0) + cacheR + cacheC
      mm.outputTokens += m.outputTokens || 0
    }
  }
  return {
    summary: {
      totalTokens,
      inputTokens: totalTokens - outputTokens,
      outputTokens,
      messageCount,
      sessionCount,
    },
    modelStats: Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens),
    contributions,
    sessionCount,
    messageCount,
  }
}

const emptyResult = () => {
  return {
    summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, messageCount: 0, sessionCount: 0 },
    modelStats: [],
    contributions: require('./usage').emptyContributions(),
    sessionCount: 0,
    messageCount: 0,
  }
}

// 源文件被清理后回放落库历史，避免历史归零；无历史返回 null
const statsFromHistory = () => {
  const usage = require('./usage')
  const history = usage.readAgentUsage('grok')
  const dates = Object.keys(history)
  if (dates.length === 0) return null
  const contributions = usage.fillEmptyContributions(
    dates.sort().map((date) => ({ date, ...history[date], models: history[date].models || {} })),
  )
  return aggregate(contributions, 0, 0)
}

const readGrokUsageFromHistory = () => {
  try {
    return statsFromHistory()
  } catch (e) {
    console.error('[Grok Usage] 读历史统计失败:', e)
    return null
  }
}

const readGrokUsage = (forceRefresh = false) => {
  const usage = require('./usage')
  try {
    const dirs = listSessionDirs()
    if (dirs.length === 0) return statsFromHistory() || emptyResult()
    const { messageRecords, sessionMap } = collectUsageRecords()
    const stats = usage.calculateStats(messageRecords, sessionMap)
    const result = aggregate(stats.contributions, messageRecords.length, sessionMap.size)
    // 落库（「通用」统计页数据源 + 本页历史档）：全零由落库层跳过，不会清空历史
    usage.saveAgentUsage('grok', stats.contributions)
    return result
  } catch (e) {
    console.error('[Grok Usage] 统计失败:', e)
    return emptyResult()
  }
}

// ==================== 目录 / 安装检测 ====================

const openGrokDir = () => {
  const dir = GROK_HOME()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch (e) { /* ignore */ }
}

const openGrokConfigFile = () => {
  const p = GROK_CONFIG_PATH()
  if (!fs.existsSync(p)) writeGrokConfig({})
  try { window.utools.shellOpenPath(p) } catch (e) { /* ignore */ }
}

const openGrokSessionsDir = () => {
  const dir = GROK_SESSIONS_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch (e) { /* ignore */ }
}

const isGrokInstalled = () => fs.existsSync(GROK_HOME())

// 任一模型条目 / 命名供应商 / MCP 服务器存在即视为有数据（detectAgentsConfig 用，不创建文件）
const hasGrokConfig = () => {
  try {
    const doc = readGrokConfig()
    return (
      Object.keys(doc.model || {}).length > 0 ||
      Object.keys(doc.model_providers || {}).length > 0 ||
      Object.keys(doc.mcp_servers || {}).length > 0
    )
  } catch (e) {
    return false
  }
}

module.exports = {
  getGrokHome, getGrokConfigPath, getGrokSessionsDir, getGrokSkillsPath,
  readGrokConfig, writeGrokConfig,
  hasGrokConfig,
  // 供应商
  getGrokProviderList, addGrokProvider, updateGrokProvider, deleteGrokProvider,
  // 模型
  getGrokModelList, getGrokUngroupedModels, addGrokModel, updateGrokModel, deleteGrokModel,
  getGrokDefaultModel, setGrokDefaultModel,
  // 下发
  upsertGrokProvider, upsertGrokModel, providerKeyFor,
  // 内部结构函数导出，供测试/复用
  normalizeProvider, buildProviderToml, normalizeModel, buildModelToml, getProviderTables, getModelTables,
  // MCP
  getGrokMcpServers, setGrokMcpServer, setGrokMcpEnabled, deleteGrokMcpServer, toGenericMcpConfig,
  // Skill
  getGrokSkills, setGrokSkillEnabled, deleteGrokSkill, getGrokSkillsDir,
  // 统计
  readGrokUsage, readGrokUsageFromHistory, listSessionDirs,
  // 目录 / 检测
  openGrokDir, openGrokConfigFile, openGrokSessionsDir, isGrokInstalled,
  // 常量
  GROK_API_BACKENDS, DEFAULT_API_BACKEND, GROK_BUILTIN_MODELS, MODEL_ID_RE, PROVIDER_NAME_RE,
}
