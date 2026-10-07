const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const yaml = require('js-yaml')

// Hermes（Nous Research Agent CLI）：模型配置在 <hermes-home>/config.yaml（YAML）。
// 目录解析镜像 Hermes 自身 get_hermes_home()：HERMES_HOME 环境变量优先；
// Windows 用 %LOCALAPPDATA%/hermes，macOS/Linux 用 ~/.hermes。
// 本服务只管理两处，其余节（agent / memory / mcp_servers / env 等）读改写原样保留（同 minimax 纪律）：
//   custom_providers[] — 自定义供应商列表，条目字段：
//     name        供应商名（即 YAML 身份，被顶层 model.provider 引用）
//     base_url    API 端点（写入前去尾斜杠）
//     api_key     密钥（明文，与 Hermes 自身读写同一文件一致）
//     api_mode    协议：chat_completions | anthropic_messages | codex_responses | bedrock_converse
//     models      磁盘为字典 { "<模型ID>": { context_length, ... } }，UI 侧为有序数组
//     model       单数，恒等于首个模型 ID（Hermes 运行时与 /model 选择器读取）
//     rate_limit_delay  请求间隔秒数（可选）
//   model（顶层）     — 切换默认的指针节：provider 指供应商名、default 指模型 ID；
//     其余键（base_url / context_length / max_tokens 等）保留
// Hermes v12+ 的顶层 providers 字典（由 Hermes Web UI 托管）只读展示，禁改禁删。
// 已知取舍：整档 js-yaml 重写不保留 YAML 注释（同 minimax）。

const HERMES_HOME = () => {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'hermes')
  }
  return path.join(os.homedir(), '.hermes')
}
const HERMES_CONFIG_PATH = () => path.join(HERMES_HOME(), 'config.yaml')
const getHermesHome = HERMES_HOME
const getHermesConfigPath = HERMES_CONFIG_PATH

// 官方支持的 API 模式（cc-switch 侧与 Hermes 文档一致）
const HERMES_API_MODES = ['chat_completions', 'anthropic_messages', 'codex_responses', 'bedrock_converse']
const DEFAULT_API_MODE = 'chat_completions'

// 受管字段；其余（key_env / request_timeout_seconds / headers 等未知键）收进 _extra 原样往返
const KNOWN_PROVIDER_FIELDS = ['name', 'base_url', 'api_key', 'api_mode', 'models', 'model', 'rate_limit_delay']
// camelCase 别名归一为 snake_case（老版本 / 手写文件兼容，对齐 cc-switch sanitize）
const SNAKE_ALIASES = {
  baseUrl: 'base_url',
  apiKey: 'api_key',
  apiMode: 'api_mode',
  maxTokens: 'max_tokens',
  contextLength: 'context_length',
}

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0)

// ==================== config.yaml 读写 ====================

const readHermesConfig = () => {
  const p = HERMES_CONFIG_PATH()
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    return yaml.load(raw) || {}
  } catch (e) {
    // 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会覆盖整个
    // config.yaml，抹掉 agent / memory / mcp_servers 等节（同 minimax / kimi / codex）
    throw new Error(`config.yaml 解析失败，已阻止修改（请先在 Hermes 中修复 YAML 语法）: ${e.message}`)
  }
}

const writeHermesConfig = (doc) => {
  const p = HERMES_CONFIG_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, yaml.dump(doc || {}, { lineWidth: -1 }), { encoding: 'utf-8' })
  return true
}

const getCustomProviders = (doc) => {
  if (!Array.isArray(doc.custom_providers)) doc.custom_providers = []
  return doc.custom_providers
}

// 顶层 providers 字典（Hermes Web UI 托管，v12+）：只读，不懒创建
const getProvidersDict = (doc) =>
  doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers) ? doc.providers : {}

// ==================== 归一化 / 构建 ====================

// 键清洗：camelCase 别名归一 snake_case、移除遗留 api 键（被 api_mode 取代）
const sanitizeEntry = (entry) => {
  const out = {}
  for (const [k, v] of Object.entries(entry || {})) {
    if (k === 'api') continue
    out[SNAKE_ALIASES[k] || k] = v
  }
  return out
}

// UI 侧 models 为有序数组 [{ modelId, contextLength, _raw }]；
// 磁盘为字典 { "<id>": { context_length, ... } }（Hermes 形态），兼容数组写法只读回显
const modelsToUi = (models) => {
  if (Array.isArray(models)) {
    return models
      .map((x) => {
        if (typeof x === 'string') return { modelId: x, contextLength: 0, _raw: {} }
        if (x && typeof x === 'object' && String(x.id || x.name || '').trim()) {
          const id = String(x.id || x.name).trim()
          const raw = { ...x }
          delete raw.id
          delete raw.name
          return { modelId: id, contextLength: toNumber(raw.context_length), _raw: raw }
        }
        return null
      })
      .filter(Boolean)
  }
  if (!models || typeof models !== 'object') return []
  return Object.entries(models).map(([modelId, m]) => ({
    modelId,
    contextLength: toNumber(m && typeof m === 'object' ? m.context_length : undefined),
    _raw: m && typeof m === 'object' ? m : {},
  }))
}

// UI 数组 → 磁盘字典：_raw 原样保留（name / max_tokens 等用户自设键），context_length 受管
const modelsToDict = (models) => {
  const dict = {}
  for (const m of models || []) {
    const id = String(m?.modelId || '').trim()
    if (!id) continue
    const raw = m._raw && typeof m._raw === 'object' && !Array.isArray(m._raw) ? { ...m._raw } : {}
    if (Number(m.contextLength) > 0) raw.context_length = Number(m.contextLength)
    else delete raw.context_length
    dict[id] = raw
  }
  return dict
}

const normalizeProvider = (rawEntry) => {
  const e = sanitizeEntry(rawEntry)
  const extra = {}
  for (const [k, v] of Object.entries(e)) {
    if (!KNOWN_PROVIDER_FIELDS.includes(k)) extra[k] = v
  }
  return {
    name: String(e.name || '').trim(),
    baseUrl: String(e.base_url || '').trim(),
    apiKey: String(e.api_key || ''),
    apiMode: HERMES_API_MODES.includes(e.api_mode) ? e.api_mode : DEFAULT_API_MODE,
    models: modelsToUi(e.models),
    rateLimitDelay: toNumber(e.rate_limit_delay),
    _extra: extra,
  }
}

// 由归一化 provider 构建磁盘条目：_extra 非受管键原样保留；base_url 去尾斜杠；
// model（单数）恒为首个模型 ID（无模型时移除）；键序 name → base_url → api_key → api_mode → models → model
const buildProviderYaml = (cfg) => {
  const e = { ...(cfg._extra || {}) }
  e.name = String(cfg.name || '').trim()
  e.base_url = String(cfg.baseUrl || '').trim().replace(/\/+$/, '')
  e.api_key = String(cfg.apiKey || '')
  e.api_mode = HERMES_API_MODES.includes(cfg.apiMode) ? cfg.apiMode : DEFAULT_API_MODE
  const dict = modelsToDict(cfg.models)
  e.models = dict
  const firstModel = Object.keys(dict)[0]
  if (firstModel) e.model = firstModel
  else delete e.model
  if (Number(cfg.rateLimitDelay) > 0) e.rate_limit_delay = Number(cfg.rateLimitDelay)
  else delete e.rate_limit_delay
  return e
}

const assertApiMode = (mode) => {
  if (mode && !HERMES_API_MODES.includes(mode)) {
    throw new Error(`不支持的 API 模式 ${mode}（可选：${HERMES_API_MODES.join(' / ')}）`)
  }
}

// ==================== Providers ====================

// 自定义（custom_providers 列表，可编辑）+ Hermes 托管（providers 字典，只读）合并返回；
// 自定义排前，保持文件内原顺序
const getHermesProviderList = () => {
  const doc = readHermesConfig()
  const list = getCustomProviders(doc)
    .filter((p) => p && typeof p === 'object')
    .map((e) => ({ ...normalizeProvider(e), readonly: false, source: 'custom' }))
  const dict = getProvidersDict(doc)
  for (const [key, entry] of Object.entries(dict)) {
    if (!entry || typeof entry !== 'object') continue
    list.push({
      ...normalizeProvider({ ...entry, name: entry.name || key }),
      readonly: true,
      source: 'providers_dict',
    })
  }
  return list
}

const addHermesProvider = (cfg) => {
  const name = String(cfg?.name || '').trim()
  if (!name) throw new Error('供应商名称不能为空')
  assertApiMode(cfg.apiMode)
  const doc = readHermesConfig()
  const list = getCustomProviders(doc)
  if (list.some((p) => p && p.name === name) || getProvidersDict(doc)[name] !== undefined) {
    throw new Error(`Provider ${name} 已存在`)
  }
  list.push(buildProviderYaml({
    name,
    baseUrl: String(cfg.baseUrl || '').trim(),
    apiKey: String(cfg.apiKey || ''),
    apiMode: cfg.apiMode || DEFAULT_API_MODE,
    models: Array.isArray(cfg.models) ? cfg.models : [],
    rateLimitDelay: cfg.rateLimitDelay,
    _extra: {},
  }))
  writeHermesConfig(doc)
  return true
}

const updateHermesProvider = (name, updates) => {
  const doc = readHermesConfig()
  const list = getCustomProviders(doc)
  const entry = list.find((p) => p && p.name === name)
  if (!entry) throw new Error(`Provider ${name} 不存在`)
  assertApiMode(updates.apiMode)
  const prev = normalizeProvider(entry)
  const merged = {
    name, // 名称即 YAML 身份且被 model.provider 引用，不随编辑变化
    baseUrl: updates.baseUrl !== undefined ? String(updates.baseUrl).trim() : prev.baseUrl,
    apiKey: updates.clearApiKey ? '' : updates.apiKey !== undefined ? String(updates.apiKey) : prev.apiKey,
    apiMode: updates.apiMode !== undefined ? updates.apiMode : prev.apiMode,
    models: Array.isArray(updates.models) ? updates.models : prev.models,
    rateLimitDelay: updates.rateLimitDelay !== undefined ? updates.rateLimitDelay : prev.rateLimitDelay,
    _extra: prev._extra,
  }
  list[list.indexOf(entry)] = buildProviderYaml(merged)
  writeHermesConfig(doc)
  return true
}

const removeHermesProvider = (name) => {
  const doc = readHermesConfig()
  if (getProvidersDict(doc)[name] !== undefined) {
    throw new Error(`Provider ${name} 由 Hermes Web UI 托管（providers 节），不可在此删除`)
  }
  const list = getCustomProviders(doc)
  const idx = list.findIndex((p) => p && p.name === name)
  if (idx === -1) return true // 幂等：可能刚在 Hermes 内被删除
  list.splice(idx, 1)
  // 级联清理：默认模型指针悬空时改指首个剩余供应商（自定义优先，其次 Hermes 托管字典），
  // 无任何剩余则移除指针
  if (doc.model && typeof doc.model === 'object' && doc.model.provider === name) {
    let next = list.find((p) => p && p.name) || null
    if (!next) {
      const dict = getProvidersDict(doc)
      const dictName = Object.keys(dict).find((k) => dict[k] && typeof dict[k] === 'object')
      if (dictName) next = { ...dict[dictName], name: dictName }
    }
    if (next) {
      doc.model.provider = next.name
      const nextFirst = modelsToUi(next.models).map((m) => m.modelId)[0]
      if (nextFirst) doc.model.default = nextFirst
      else delete doc.model.default
    } else {
      delete doc.model.provider
      delete doc.model.default
    }
  }
  writeHermesConfig(doc)
  return true
}

// ==================== 默认模型（顶层 model.provider / model.default） ====================

const getHermesDefaultModel = () => {
  const doc = readHermesConfig()
  const model = doc.model && typeof doc.model === 'object' ? doc.model : {}
  return { provider: String(model.provider || ''), modelId: String(model.default || '') }
}

// 自定义与 Hermes 托管（providers 字典）供应商均可设默认；
// 传 modelId 校验存在后写 model.default，未传则用该供应商首个模型（model: 节其余键保留）
const setHermesDefaultModel = (providerName, modelId) => {
  const doc = readHermesConfig()
  let entry = getCustomProviders(doc).find((p) => p && p.name === providerName)
  if (!entry) entry = getProvidersDict(doc)[providerName]
  if (!entry || typeof entry !== 'object') throw new Error(`Provider ${providerName} 不存在`)
  const ids = modelsToUi(entry.models).map((m) => m.modelId)
  if (modelId) {
    if (!ids.includes(modelId)) throw new Error(`模型 ${modelId} 不存在，无法设为默认`)
  } else if (!ids.length) {
    throw new Error(`Provider ${providerName} 没有模型，请先添加模型`)
  }
  if (!doc.model || typeof doc.model !== 'object' || Array.isArray(doc.model)) doc.model = {}
  doc.model.provider = providerName
  doc.model.default = modelId || ids[0]
  writeHermesConfig(doc)
  return true
}

// ==================== 下发用 upsert（dispatch.js 调用，语义同 zcode.upsert*） ====================

// 通用库供应商名可能是中文/任意符号，而 Hermes name 被顶层 model.provider 引用，
// 需确定性清洗（同一下发名永远得到同一 name → upsert 幂等）：合法名原样用；
// 否则取 ASCII 骨架 + 原名稳定哈希防碰撞（纯中文名直接清洗会互相覆盖）
const PROVIDER_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/
const hashName = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
const providerKeyFor = (name) => {
  const raw = String(name || '').trim()
  if (PROVIDER_NAME_RE.test(raw)) return raw
  const base = raw.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'provider'
  return `${base}-${hashName(raw)}`
}

// 存在则合并更新（空值不覆盖既有 baseUrl/apiKey/apiMode，模型不动），否则创建；
// providers 字典条目（Hermes 托管）拒绝写入
const upsertHermesProvider = (key, cfg) => {
  const name = String(key || '').trim()
  if (!name) throw new Error('Provider name 不能为空')
  assertApiMode(cfg.apiMode)
  const doc = readHermesConfig()
  if (getProvidersDict(doc)[name] !== undefined) {
    throw new Error(`Provider ${name} 由 Hermes Web UI 托管（providers 节），无法下发`)
  }
  const list = getCustomProviders(doc)
  const entry = list.find((p) => p && p.name === name)
  if (entry) {
    const prev = normalizeProvider(entry)
    const merged = {
      name,
      baseUrl: String(cfg.baseUrl || '').trim() || prev.baseUrl,
      apiKey: String(cfg.apiKey || '') || prev.apiKey,
      apiMode: cfg.apiMode || prev.apiMode,
      models: prev.models,
      rateLimitDelay: prev.rateLimitDelay,
      _extra: prev._extra,
    }
    list[list.indexOf(entry)] = buildProviderYaml(merged)
  } else {
    list.push(buildProviderYaml({
      name,
      baseUrl: String(cfg.baseUrl || '').trim(),
      apiKey: String(cfg.apiKey || ''),
      apiMode: cfg.apiMode || DEFAULT_API_MODE,
      models: [],
      rateLimitDelay: 0,
      _extra: {},
    }))
  }
  writeHermesConfig(doc)
  return true
}

// 模型已存在时只刷新传入的受管字段（context_length，未传保留既有值），不存在则新建；
// 条目尚无 model（单数）指针时补为首个写入的模型；返回模型 ID
const upsertHermesModel = (providerName, modelId, opts = {}) => {
  const id = String(modelId || '').trim()
  if (!id) throw new Error('模型 ID 不能为空')
  const doc = readHermesConfig()
  const entry = getCustomProviders(doc).find((p) => p && p.name === providerName)
  if (!entry) throw new Error(`Provider ${providerName} 不存在`)
  const models = entry.models && typeof entry.models === 'object' && !Array.isArray(entry.models)
    ? entry.models
    : {}
  const prev = models[id] && typeof models[id] === 'object' ? models[id] : {}
  const next = { ...prev }
  if (Number(opts.contextLength) > 0) next.context_length = Number(opts.contextLength)
  models[id] = next
  entry.models = models
  if (!String(entry.model || '').trim()) entry.model = id
  writeHermesConfig(doc)
  return id
}

// ==================== 目录 / 安装检测 ====================

const openHermesDir = () => {
  const dir = HERMES_HOME()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const openHermesConfigFile = () => {
  const p = HERMES_CONFIG_PATH()
  if (!fs.existsSync(p)) writeHermesConfig({})
  try { window.utools.shellOpenPath(p) } catch { /* ignore */ }
}

const isHermesInstalled = () => fs.existsSync(HERMES_HOME())

// 有自定义供应商（含 Hermes 托管节）即视为有数据（detectAgentsConfig 用，不创建文件）
const hasHermesProviders = () => {
  try {
    const doc = readHermesConfig()
    if (Array.isArray(doc.custom_providers) && doc.custom_providers.length) return true
    return Object.keys(getProvidersDict(doc)).length > 0
  } catch {
    return false
  }
}

module.exports = {
  getHermesHome, getHermesConfigPath,
  readHermesConfig, writeHermesConfig,
  hasHermesProviders,
  getHermesProviderList, addHermesProvider, updateHermesProvider, removeHermesProvider,
  upsertHermesProvider, providerKeyFor, upsertHermesModel,
  getHermesDefaultModel, setHermesDefaultModel,
  openHermesDir, openHermesConfigFile, isHermesInstalled,
  HERMES_API_MODES, DEFAULT_API_MODE,
}
