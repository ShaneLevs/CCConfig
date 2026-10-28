const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { t } = require('./i18n')

// Command Code（cmd）：BYOK 供应商 + 模型配置在 ~/.commandcode/providers.json（JSON）。
// 目录解析：COMMANDCODE_HOME 环境变量优先，否则 ~/.commandcode（官方唯一位置，无平台分叉）。
//
// 本服务管理四处：
//   providers.json — { provider: { "<id>": { name, api, baseURL, apiKey, headers, models{}, disabled } } }
//     apiKey 只接受引用语法（"$ENV" / "{env:VAR}" / "!command" / false），明文会被官方拒绝；
//     所以 key 由本服务写入 auth.json（见下），这里恒写 false。
//     models 为字典 { "<模型ID>": { name, contextWindow, maxOutput, reasoning, reasoningEfforts,
//     cost, options, api, baseURL } }，条目可为 {}。
//   settings.json — { modelProvider, model: "<providerId>/<modelId>", hooks, skills, ... }
//     其余键（hooks / skills / disabledSkills / additionalDirectories 等）读改写原样保留。
//   auth.json — { "<providerId>": { apiKey }, ... } + 顶层账号字段（apiKey / userId / userName /
//     keyName / authenticatedAt）。**顶层 apiKey 是账号 key，与供应商 key 不同层**，
//     写入必须 read-modify-write 单项，绝不整体替换，写完保持 0600。
//   mcp.json — { mcpServers: { "<name>": { transport: "stdio"|"http", enabled, command, args, env,
//     url, headers } } }，仅 user scope（local scope 在 projects/<slug>/mcp.json，
//     project scope 在 <project>/.mcp.json，本服务都不碰）。
// Skill 目录 ~/.commandcode/skills，启停沿用 .disabled 目录机制（与其它 agent 同一套心智）。
// 使用统计解析 ~/.commandcode/projects/<slug>/<session-id>.jsonl 的逐轮 usage。
//
// 官方还支持 settings.json 的 disabledSkills 数组停用 Skill；本插件统一用 .disabled 目录，
// 不写 disabledSkills，避免两套状态打架

const CC_HOME = () => process.env.COMMANDCODE_HOME || path.join(os.homedir(), '.commandcode')
const CC_PROVIDERS_PATH = () => path.join(CC_HOME(), 'providers.json')
const CC_SETTINGS_PATH = () => path.join(CC_HOME(), 'settings.json')
const CC_AUTH_PATH = () => path.join(CC_HOME(), 'auth.json')
const CC_MCP_PATH = () => path.join(CC_HOME(), 'mcp.json')
const CC_SKILLS_PATH = () => path.join(CC_HOME(), 'skills')
const CC_PROJECTS_PATH = () => path.join(CC_HOME(), 'projects')
const CC_TASTE_GLOBAL_PATH = () => path.join(CC_HOME(), 'taste')

const getCommandCodeHome = CC_HOME
const getCommandCodeProvidersPath = CC_PROVIDERS_PATH

// 官方认的三种 wire；磁盘上省略 = openai-completions
const CC_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const DEFAULT_API = 'openai-completions'
// reasoningEfforts 的合法档位（其余档位官方会丢弃并告警）
const CC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const SKILL_DISABLED_DIR = '.disabled'
const TASTE_MAX_INLINE = 5

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0)
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// ==================== 通用读写 ====================

// 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会用空对象
// 覆盖整个文件，抹掉其它键（同 hermes / qoder / minimax 纪律）
const readJsonDoc = (p, label) => {
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  if (!raw.trim()) return {}
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(t('serviceAgent.commandcode.parseFailed', { file: label, message: e.message }))
  }
  if (!isPlainObject(doc)) {
    throw new Error(t('serviceAgent.commandcode.notJsonObject', { file: label }))
  }
  return doc
}

const writeJsonDoc = (p, doc) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf-8' })
  return true
}

const pretty = (p) => String(p || '').replace(os.homedir(), '~')

// auth.json 单独一套：文件含账号登录态，权限必须 0600
const readAuthDoc = () => {
  const p = CC_AUTH_PATH()
  if (!fs.existsSync(p)) return {}
  const doc = readJsonDoc(p, pretty(p))
  return doc
}

const writeAuthDoc = (doc) => {
  const p = CC_AUTH_PATH()
  writeJsonDoc(p, doc)
  try { fs.chmodSync(p, 0o600) } catch (e) { /* Windows 上可能不支持，忽略 */ }
  return true
}

const readProvidersDoc = () => {
  const doc = readJsonDoc(CC_PROVIDERS_PATH(), pretty(CC_PROVIDERS_PATH()))
  if (!isPlainObject(doc.provider)) doc.provider = {}
  return doc
}

const writeProvidersDoc = (doc) => writeJsonDoc(CC_PROVIDERS_PATH(), doc)
const readSettingsDoc = () => readJsonDoc(CC_SETTINGS_PATH(), pretty(CC_SETTINGS_PATH()))
const writeSettingsDoc = (doc) => writeJsonDoc(CC_SETTINGS_PATH(), doc)

// ==================== 协议 / ID 约定 ====================

// provider id 是 providers.json 的表键，同时是 settings.json model 的前缀 → 必须是合法 slug
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const MODEL_ID_RE = /^[^\s/]+(\/[^\s/]+)*$/

const assertApi = (api) => {
  if (api && !CC_APIS.includes(api)) {
    throw new Error(t('serviceAgent.commandcode.unsupportedApi', { api, options: CC_APIS.join(' / ') }))
  }
}

const assertProviderId = (id) => {
  const v = String(id || '').trim()
  if (!v) throw new Error(t('serviceAgent.commandcode.providerIdRequired'))
  if (!PROVIDER_ID_RE.test(v)) throw new Error(t('serviceAgent.commandcode.providerIdInvalid', { id: v }))
  return v
}

// 通用库供应商名可能是中文/任意符号 → 确定性清洗为 slug（同名恒同 id → upsert 幂等）
const hashName = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
const providerKeyFor = (name) => {
  const raw = String(name || '').trim()
  if (PROVIDER_ID_RE.test(raw)) return raw
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'provider'
  return `${base}-${hashName(raw)}`
}

// ==================== 模型归一化 ====================

// UI 显式管理的字段；其余（未知键）原样往返，避免编辑时抹掉扩展字段
const KNOWN_MODEL_FIELDS = [
  'name', 'contextWindow', 'maxOutput', 'reasoning', 'reasoningEfforts',
  'cost', 'options', 'api', 'baseURL',
]

const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']
// 官方接受的 snake_case 别名
const COST_ALIASES = { cache_read: 'cacheRead', cache_write: 'cacheWrite' }

const normalizeCost = (raw) => {
  const out = {}
  if (!isPlainObject(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    const key = COST_ALIASES[k] || k
    if (!COST_FIELDS.includes(key)) continue
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) out[key] = n
  }
  return out
}

const normalizeModel = (id, raw) => {
  const m = isPlainObject(raw) ? raw : {}
  const extra = {}
  for (const k of Object.keys(m)) {
    if (!KNOWN_MODEL_FIELDS.includes(k) && k !== 'limit') extra[k] = m[k]
  }
  const limit = isPlainObject(m.limit) ? m.limit : {}
  // 兼容别名：limit.context / limit.output（contextWindow 优先）
  const ctx = Number(m.contextWindow) > 0 ? Number(m.contextWindow) : Number(limit.context) || 0
  const maxOut = Number(m.maxOutput) > 0 ? Number(m.maxOutput) : Number(limit.output) || 0
  return {
    id,
    name: typeof m.name === 'string' ? m.name : '',
    contextWindow: ctx,
    maxOutput: maxOut,
    reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : null,
    reasoningEfforts: Array.isArray(m.reasoningEfforts)
      ? m.reasoningEfforts.filter((x) => CC_EFFORTS.includes(x))
      : [],
    cost: normalizeCost(m.cost),
    options: isPlainObject(m.options) ? { ...m.options } : {},
    api: CC_APIS.includes(m.api) ? m.api : '',
    baseURL: typeof m.baseURL === 'string' ? m.baseURL : '',
    _extra: extra,
  }
}

// UI → providers.json 的模型条目：_extra 保留未知键；受管字段空值不写入
const buildModelJson = (cfg) => {
  const m = { ...(cfg._extra || {}) }
  if (String(cfg.name || '').trim()) m.name = String(cfg.name).trim()
  else delete m.name
  if (Number(cfg.contextWindow) > 0) m.contextWindow = Number(cfg.contextWindow)
  else delete m.contextWindow
  if (Number(cfg.maxOutput) > 0) m.maxOutput = Number(cfg.maxOutput)
  else delete m.maxOutput
  if (cfg.reasoning === true || cfg.reasoning === false) m.reasoning = cfg.reasoning
  else delete m.reasoning
  const efforts = Array.isArray(cfg.reasoningEfforts)
    ? cfg.reasoningEfforts.filter((x) => CC_EFFORTS.includes(x))
    : []
  if (efforts.length) m.reasoningEfforts = efforts
  else delete m.reasoningEfforts
  const cost = normalizeCost(cfg.cost)
  if (Object.keys(cost).length) m.cost = cost
  else delete m.cost
  const options = isPlainObject(cfg.options) ? cfg.options : {}
  if (Object.keys(options).length) m.options = options
  else delete m.options
  if (CC_APIS.includes(cfg.api)) m.api = cfg.api
  else delete m.api
  if (String(cfg.baseURL || '').trim()) m.baseURL = String(cfg.baseURL).trim()
  else delete m.baseURL
  delete m.limit
  return m
}

// ==================== Provider 归一化 ====================

const KNOWN_PROVIDER_FIELDS = ['name', 'api', 'baseURL', 'apiKey', 'headers', 'models', 'disabled']

const normalizeProvider = (id, raw, authDoc) => {
  const p = isPlainObject(raw) ? raw : {}
  const extra = {}
  for (const k of Object.keys(p)) {
    if (!KNOWN_PROVIDER_FIELDS.includes(k)) extra[k] = p[k]
  }
  const headers = {}
  if (isPlainObject(p.headers)) {
    for (const [k, v] of Object.entries(p.headers)) {
      if (String(k).trim()) headers[String(k).trim()] = String(v == null ? '' : v)
    }
  }
  const models = {}
  if (isPlainObject(p.models)) {
    for (const [mid, mv] of Object.entries(p.models)) {
      const key = String(mid || '').trim()
      if (key) models[key] = normalizeModel(key, mv)
    }
  }
  const storedKey = authDoc && isPlainObject(authDoc[id]) ? authDoc[id].apiKey : null
  return {
    id,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id,
    api: CC_APIS.includes(p.api) ? p.api : DEFAULT_API,
    // 磁盘省略 = 默认协议，回显时明确给默认值
    apiExplicit: CC_APIS.includes(p.api),
    baseUrl: typeof p.baseURL === 'string' ? p.baseURL : '',
    // providers.json 里的引用串（"$ENV" / "{env:VAR}" / "!cmd"），false 表示无引用
    apiKeyRef: typeof p.apiKey === 'string' ? p.apiKey : '',
    apiKeyDisabled: p.apiKey === false,
    // key 存在 auth.json 里：只回布尔，不向前端暴露明文
    hasStoredKey: typeof storedKey === 'string' && storedKey.length > 0,
    keyMasked: typeof storedKey === 'string' && storedKey.length > 0 ? maskKey(storedKey) : '',
    headers,
    models: Object.values(models),
    disabled: p.disabled === true || p.enabled === false,
    _extra: extra,
  }
}

const maskKey = (key) => {
  const s = String(key || '')
  if (s.length <= 8) return `${s.slice(0, 2)}…`
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

// UI → providers.json 条目。apiKey 恒写 false（真实 key 在 auth.json），
// 除非用户给的是引用串（保留引用）
const buildProviderJson = (cfg) => {
  const p = { ...(cfg._extra || {}) }
  if (String(cfg.name || '').trim()) p.name = String(cfg.name).trim()
  else delete p.name
  if (CC_APIS.includes(cfg.api) && cfg.api !== DEFAULT_API) p.api = cfg.api
  else delete p.api
  p.baseURL = String(cfg.baseUrl || '').trim()
  const ref = String(cfg.apiKeyRef || '').trim()
  p.apiKey = ref || false
  const headers = {}
  for (const [k, v] of Object.entries(cfg.headers || {})) {
    if (String(k).trim()) headers[String(k).trim()] = String(v == null ? '' : v)
  }
  if (Object.keys(headers).length) p.headers = headers
  else delete p.headers
  const models = {}
  for (const m of cfg.models || []) {
    const id = String(m?.id || '').trim()
    if (!id) continue
    models[id] = buildModelJson(m)
  }
  p.models = models
  if (cfg.disabled === true) p.disabled = true
  else delete p.disabled
  return p
}

// ==================== Providers ====================

const getCommandCodeProviderList = () => {
  const doc = readProvidersDoc()
  const authDoc = readAuthDoc()
  return Object.entries(doc.provider)
    .filter(([, p]) => isPlainObject(p))
    .map(([id, p]) => normalizeProvider(id, p, authDoc))
    .sort((a, b) => a.id.localeCompare(b.id))
}

const providerExists = (doc, id) => Object.prototype.hasOwnProperty.call(doc.provider, id)

const addCommandCodeProvider = (cfg) => {
  const id = assertProviderId(cfg?.id)
  assertApi(cfg.api)
  const doc = readProvidersDoc()
  if (providerExists(doc, id)) {
    throw new Error(t('serviceAgent.common.providerExistsLabel', { name: id }))
  }
  doc.provider[id] = buildProviderJson({
    name: String(cfg.name || '').trim() || id,
    api: cfg.api || DEFAULT_API,
    baseUrl: String(cfg.baseUrl || '').trim(),
    apiKeyRef: cfg.apiKeyRef || '',
    headers: cfg.headers || {},
    models: [],
    disabled: false,
    _extra: {},
  })
  writeProvidersDoc(doc)
  // 用户直接填了明文 key → 写 auth.json（模拟 /connect 行为）
  if (cfg.apiKey) writeProviderKey(id, cfg.apiKey)
  return id
}

const updateCommandCodeProvider = (id, updates = {}) => {
  const pid = assertProviderId(id)
  assertApi(updates.api)
  const doc = readProvidersDoc()
  if (!providerExists(doc, pid)) {
    throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: pid }))
  }
  const newId = updates.id === undefined || updates.id === pid ? pid : assertProviderId(updates.id)
  if (newId !== pid && providerExists(doc, newId)) {
    throw new Error(t('serviceAgent.common.providerExistsLabel', { name: newId }))
  }
  const authDoc = readAuthDoc()
  const prev = normalizeProvider(pid, doc.provider[pid], authDoc)
  const merged = {
    ...prev,
    id: newId,
    name: updates.name !== undefined ? String(updates.name).trim() || newId : prev.name,
    api: updates.api !== undefined ? updates.api : prev.api,
    baseUrl: updates.baseUrl !== undefined ? String(updates.baseUrl).trim() : prev.baseUrl,
    apiKeyRef: updates.apiKeyRef !== undefined ? String(updates.apiKeyRef).trim() : prev.apiKeyRef,
    headers: updates.headers !== undefined ? updates.headers : prev.headers,
    models: prev.models,
    disabled: updates.disabled !== undefined ? updates.disabled === true : prev.disabled,
  }
  if (newId !== pid) delete doc.provider[pid]
  doc.provider[newId] = buildProviderJson(merged)
  writeProvidersDoc(doc)

  // key 处理：clearApiKey → 删；apiKey 有值 → 覆盖
  if (updates.clearApiKey) clearProviderKey(pid, newId)
  else if (updates.apiKey) writeProviderKey(newId, updates.apiKey)

  // 改名：settings.json 的 modelProvider / model 前缀同步（否则默认模型悬空）
  if (newId !== pid) renameProviderInSettings(pid, newId)
  if (merged.disabled) clearDefaultIfProvider(newId)
  return true
}

const deleteCommandCodeProvider = (id) => {
  const pid = assertProviderId(id)
  const doc = readProvidersDoc()
  // 幂等：可能刚在 cmd 内被删除
  if (!providerExists(doc, pid)) return true
  delete doc.provider[pid]
  writeProvidersDoc(doc)
  clearProviderKey(pid, null)
  clearDefaultIfProvider(pid)
  return true
}

// ==================== API Key（auth.json，局部写）====================

// 只改 auth.json 里该 provider 的 apiKey；顶层账号字段与其它 provider 原样保留
const writeProviderKey = (providerId, key) => {
  const plain = String(key || '')
  if (!plain) return false
  const authDoc = readAuthDoc()
  const prev = isPlainObject(authDoc[providerId]) ? authDoc[providerId] : {}
  authDoc[providerId] = { ...prev, apiKey: plain }
  writeAuthDoc(authDoc)
  return true
}

// 删 key：只删该 provider 的 apiKey 键，auth.json 里该项空了才删整个 entry，
// 其它 provider 与顶层账号字段一律不动
const clearProviderKey = (providerId, renamedTo) => {
  const authDoc = readAuthDoc()
  let touched = false
  const targets = renamedTo && renamedTo !== providerId ? [providerId, renamedTo] : [providerId]
  for (const id of targets) {
    if (!isPlainObject(authDoc[id])) continue
    if (!Object.prototype.hasOwnProperty.call(authDoc[id], 'apiKey')) continue
    delete authDoc[id].apiKey
    if (Object.keys(authDoc[id]).length === 0) delete authDoc[id]
    touched = true
  }
  if (touched) writeAuthDoc(authDoc)
  return touched
}

const setCommandCodeApiKey = (providerId, key) => {
  const pid = assertProviderId(providerId)
  const doc = readProvidersDoc()
  if (!providerExists(doc, pid)) {
    throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: pid }))
  }
  const plain = String(key || '').trim()
  if (!plain) throw new Error(t('serviceAgent.commandcode.apiKeyRequired'))
  writeProviderKey(pid, plain)
  // providers.json 侧必须是引用或 false，绝不写明文
  if (doc.provider[pid].apiKey !== false && !doc.provider[pid].apiKey) {
    doc.provider[pid].apiKey = false
    writeProvidersDoc(doc)
  }
  return true
}

const clearCommandCodeApiKey = (providerId) => {
  const pid = assertProviderId(providerId)
  clearProviderKey(pid, null)
  return true
}

// ==================== Models ====================

const addCommandCodeModel = (providerId, cfg) => {
  const pid = assertProviderId(providerId)
  const modelId = String(cfg?.id || '').trim()
  if (!modelId) throw new Error(t('serviceAgent.common.modelIdRequired'))
  if (!MODEL_ID_RE.test(modelId)) throw new Error(t('serviceAgent.common.modelIdInvalidChars'))
  assertApi(cfg.api)
  const doc = readProvidersDoc()
  const p = doc.provider[pid]
  if (!isPlainObject(p)) throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: pid }))
  if (!isPlainObject(p.models)) p.models = {}
  if (Object.prototype.hasOwnProperty.call(p.models, modelId)) {
    throw new Error(t('serviceAgent.common.modelExists', { id: modelId }))
  }
  p.models[modelId] = buildModelJson({ ...cfg, id: modelId, _extra: {} })
  writeProvidersDoc(doc)
  return modelId
}

const updateCommandCodeModel = (providerId, modelId, updates = {}) => {
  const pid = assertProviderId(providerId)
  const doc = readProvidersDoc()
  const p = doc.provider[pid]
  if (!isPlainObject(p)) throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: pid }))
  if (!isPlainObject(p.models) || !Object.prototype.hasOwnProperty.call(p.models, modelId)) {
    throw new Error(t('serviceAgent.common.modelNotFound', { id: modelId }))
  }
  assertApi(updates.api)
  const newId = updates.id === undefined || updates.id === modelId ? modelId : String(updates.id).trim()
  if (!newId) throw new Error(t('serviceAgent.common.modelIdRequired'))
  if (!MODEL_ID_RE.test(newId)) throw new Error(t('serviceAgent.common.modelIdInvalidChars'))
  if (newId !== modelId && Object.prototype.hasOwnProperty.call(p.models, newId)) {
    throw new Error(t('serviceAgent.common.modelExists', { id: newId }))
  }
  const prev = normalizeModel(modelId, p.models[modelId])
  const merged = { ...prev, ...updates, id: newId }
  if (newId !== modelId) delete p.models[modelId]
  p.models[newId] = buildModelJson(merged)
  writeProvidersDoc(doc)
  // 默认模型指向被改名的模型时同步
  if (newId !== modelId) renameModelInSettings(pid, modelId, newId)
  return true
}

const deleteCommandCodeModel = (providerId, modelId) => {
  const pid = assertProviderId(providerId)
  const doc = readProvidersDoc()
  const p = doc.provider[pid]
  if (!isPlainObject(p) || !isPlainObject(p.models)) return true
  if (!Object.prototype.hasOwnProperty.call(p.models, modelId)) return true
  delete p.models[modelId]
  writeProvidersDoc(doc)
  clearDefaultIfModel(pid, modelId)
  return true
}

// ==================== 默认模型（settings.json）====================

const getCommandCodeDefaultModel = () => {
  const doc = readSettingsDoc()
  const provider = typeof doc.modelProvider === 'string' ? doc.modelProvider : ''
  const qualified = typeof doc.model === 'string' ? doc.model : ''
  // model = "<providerId>/<modelId>"；模型 ID 本身可含 /，所以只剥首个前缀
  let modelId = ''
  if (qualified) {
    const idx = qualified.indexOf('/')
    if (idx > 0 && (!provider || qualified.slice(0, idx) === provider)) {
      modelId = qualified.slice(idx + 1)
    } else {
      modelId = qualified
    }
  }
  return { provider, modelId, qualified }
}

const qualifyModel = (providerId, modelId) => `${providerId}/${modelId}`

const setCommandCodeDefaultModel = (providerId, modelId) => {
  const pid = assertProviderId(providerId)
  const doc = readProvidersDoc()
  const p = doc.provider[pid]
  if (!isPlainObject(p)) throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: pid }))
  const models = isPlainObject(p.models) ? Object.keys(p.models) : []
  let mid = String(modelId || '').trim()
  if (mid) {
    if (!models.includes(mid)) throw new Error(t('serviceAgent.commandcode.modelNotFoundForDefault', { model: mid }))
  } else {
    if (!models.length) throw new Error(t('serviceAgent.commandcode.providerHasNoModels', { name: pid }))
    mid = models[0]
  }
  const settings = readSettingsDoc()
  settings.modelProvider = pid
  settings.model = qualifyModel(pid, mid)
  writeSettingsDoc(settings)
  return true
}

// 供应商改名 → settings 引用同步
const renameProviderInSettings = (oldId, newId) => {
  const settings = readSettingsDoc()
  let touched = false
  if (settings.modelProvider === oldId) {
    settings.modelProvider = newId
    touched = true
  }
  if (typeof settings.model === 'string' && settings.model.startsWith(`${oldId}/`)) {
    settings.model = `${newId}/${settings.model.slice(oldId.length + 1)}`
    touched = true
  }
  if (touched) writeSettingsDoc(settings)
}

// 模型改名 → settings.model 同步
const renameModelInSettings = (providerId, oldModelId, newModelId) => {
  const settings = readSettingsDoc()
  if (settings.model !== qualifyModel(providerId, oldModelId)) return
  settings.model = qualifyModel(providerId, newModelId)
  writeSettingsDoc(settings)
}

// 供应商被删除/停用 → 默认模型悬空清理（改指首个可用供应商的首个模型，否则清空）
const clearDefaultIfProvider = (providerId) => {
  const settings = readSettingsDoc()
  if (settings.modelProvider !== providerId) return
  const doc = readProvidersDoc()
  const fallbackId = Object.keys(doc.provider)
    .filter((id) => isPlainObject(doc.provider[id]) && doc.provider[id].disabled !== true)
    .sort()[0]
  delete settings.modelProvider
  delete settings.model
  if (fallbackId) {
    const models = isPlainObject(doc.provider[fallbackId].models) ? Object.keys(doc.provider[fallbackId].models) : []
    if (models.length) {
      settings.modelProvider = fallbackId
      settings.model = qualifyModel(fallbackId, models[0])
    }
  }
  writeSettingsDoc(settings)
}

const clearDefaultIfModel = (providerId, modelId) => {
  const settings = readSettingsDoc()
  if (settings.model !== qualifyModel(providerId, modelId)) return
  const doc = readProvidersDoc()
  const p = doc.provider[providerId]
  const models = isPlainObject(p?.models) ? Object.keys(p.models) : []
  if (models.length) {
    settings.model = qualifyModel(providerId, models[0])
  } else {
    delete settings.model
    if (settings.modelProvider === providerId) delete settings.modelProvider
  }
  writeSettingsDoc(settings)
}

// ==================== 下发用 upsert（dispatch.js 调用）====================

const upsertCommandCodeProvider = (id, cfg = {}) => {
  const pid = assertProviderId(id)
  assertApi(cfg.api)
  const doc = readProvidersDoc()
  const prev = isPlainObject(doc.provider[pid]) ? normalizeProvider(pid, doc.provider[pid], {}) : null
  const merged = {
    name: String(cfg.name || '').trim() || (prev && prev.name) || pid,
    api: cfg.api || (prev && prev.api) || DEFAULT_API,
    // 空值不覆盖既有值（下发时可能只带部分字段）
    baseUrl: String(cfg.baseUrl || '').trim() || (prev && prev.baseUrl) || '',
    apiKeyRef: (prev && prev.apiKeyRef) || '',
    headers: (prev && prev.headers) || {},
    models: prev ? prev.models : [],
    disabled: false,
    _extra: (prev && prev._extra) || {},
  }
  doc.provider[pid] = buildProviderJson(merged)
  writeProvidersDoc(doc)
  if (cfg.apiKey) writeProviderKey(pid, cfg.apiKey)
  return pid
}

// 模型已存在时只刷新传入的受管字段，不存在则新建
const upsertCommandCodeModel = (providerId, modelId, opts = {}) => {
  const pid = assertProviderId(providerId)
  const mid = String(modelId || '').trim()
  if (!mid) throw new Error(t('serviceAgent.common.modelIdRequired'))
  if (!MODEL_ID_RE.test(mid)) throw new Error(t('serviceAgent.common.modelIdInvalidChars'))
  const doc = readProvidersDoc()
  const p = doc.provider[pid]
  if (!isPlainObject(p)) throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: pid }))
  if (!isPlainObject(p.models)) p.models = {}
  const prevEntry = Object.prototype.hasOwnProperty.call(p.models, mid) ? p.models[mid] : null
  const prev = prevEntry ? normalizeModel(mid, prevEntry) : { id: mid, _extra: {} }
  const merged = { ...prev, id: mid }
  if (opts.name) merged.name = String(opts.name).trim()
  if (Number(opts.contextWindow) > 0) merged.contextWindow = Number(opts.contextWindow)
  if (Number(opts.maxOutput) > 0) merged.maxOutput = Number(opts.maxOutput)
  if (Array.isArray(opts.reasoningEfforts)) merged.reasoningEfforts = opts.reasoningEfforts
  if (isPlainObject(opts.cost)) merged.cost = opts.cost
  if (CC_APIS.includes(opts.api)) merged.api = opts.api
  p.models[mid] = buildModelJson(merged)
  writeProvidersDoc(doc)
  return mid
}

// ==================== MCP（~/.commandcode/mcp.json，仅 user scope）====================

// 官方字段：transport（stdio|http）/ enabled / command / args / env / url / headers / oauth
// 其余（oauth 等）收进 _extra 原样往返
const KNOWN_MCP_FIELDS = ['transport', 'type', 'enabled', 'command', 'args', 'env', 'url', 'headers']

const readMcpDoc = () => {
  const doc = readJsonDoc(CC_MCP_PATH(), pretty(CC_MCP_PATH()))
  if (!isPlainObject(doc.mcpServers)) doc.mcpServers = {}
  return doc
}

const writeMcpDoc = (doc) => writeJsonDoc(CC_MCP_PATH(), doc)

const normalizeMcpServer = (name, cfg) => {
  const raw = isPlainObject(cfg) ? cfg : {}
  const extra = {}
  for (const k of Object.keys(raw)) {
    if (!KNOWN_MCP_FIELDS.includes(k)) extra[k] = raw[k]
  }
  const transportRaw = String(raw.transport || raw.type || '').toLowerCase()
  const isHttp = transportRaw === 'http' || transportRaw === 'sse' || (!!raw.url && transportRaw !== 'stdio')
  return {
    name,
    type: isHttp ? 'http' : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : '',
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
    url: isHttp && typeof raw.url === 'string' ? raw.url : '',
    env: isPlainObject(raw.env) ? { ...raw.env } : {},
    headers: isPlainObject(raw.headers) ? { ...raw.headers } : {},
    enabled: raw.enabled !== false,
    _extra: extra,
  }
}

const buildMcpJson = (cfg) => {
  const m = { ...(cfg._extra || {}) }
  if (cfg.type === 'http') {
    m.transport = 'http'
    m.url = String(cfg.url || '').trim()
    const headers = {}
    for (const [k, v] of Object.entries(cfg.headers || {})) {
      if (String(k).trim()) headers[String(k).trim()] = String(v == null ? '' : v)
    }
    if (Object.keys(headers).length) m.headers = headers
    else delete m.headers
    delete m.command
    delete m.args
    delete m.env
  } else {
    m.transport = 'stdio'
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
    delete m.headers
  }
  if (cfg.enabled === false) m.enabled = false
  else delete m.enabled
  delete m.type
  return m
}

const getCommandCodeMcpServers = () => {
  const doc = readMcpDoc()
  return Object.entries(doc.mcpServers)
    .filter(([, c]) => isPlainObject(c))
    .map(([name, c]) => normalizeMcpServer(name, c))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// 供 MCP 卡片「查看工具」复用：映射成通用 config 形状（type: http | stdio）
const getCommandCodeMcpConfigFor = (server) => {
  if (!server) return null
  if (server.type === 'http') {
    return { type: 'http', url: server.url, headers: server.headers }
  }
  return { type: 'stdio', command: server.command, args: server.args, env: server.env }
}

const assertMcpName = (name) => {
  const s = String(name || '').trim()
  if (!s) throw new Error(t('serviceAgent.commandcode.mcpNameRequired'))
  return s
}

// 存在则原地更新（保留未知字段），否则新增
const setCommandCodeMcpServer = (name, cfg) => {
  const sname = assertMcpName(name)
  const doc = readMcpDoc()
  const prev = isPlainObject(doc.mcpServers[sname]) ? doc.mcpServers[sname] : null
  const prevNorm = prev ? normalizeMcpServer(sname, prev) : null
  const merged = {
    type: cfg.type === 'http' ? 'http' : 'stdio',
    command: cfg.command !== undefined ? cfg.command : prevNorm?.command || '',
    args: Array.isArray(cfg.args) ? cfg.args : prevNorm?.args || [],
    url: cfg.url !== undefined ? cfg.url : prevNorm?.url || '',
    env: isPlainObject(cfg.env) ? cfg.env : prevNorm?.env || {},
    headers: isPlainObject(cfg.headers) ? cfg.headers : prevNorm?.headers || {},
    enabled: cfg.enabled !== undefined ? cfg.enabled !== false : prevNorm ? prevNorm.enabled : true,
    _extra: prevNorm?._extra || {},
  }
  doc.mcpServers[sname] = buildMcpJson(merged)
  writeMcpDoc(doc)
  return true
}

const setCommandCodeMcpEnabled = (name, enabled) => {
  const sname = assertMcpName(name)
  const doc = readMcpDoc()
  const entry = doc.mcpServers[sname]
  if (!isPlainObject(entry)) throw new Error(t('serviceAgent.commandcode.mcpNotFound', { name: sname }))
  if (enabled === false) entry.enabled = false
  else delete entry.enabled
  writeMcpDoc(doc)
  return true
}

const deleteCommandCodeMcpServer = (name) => {
  const sname = assertMcpName(name)
  const doc = readMcpDoc()
  // 幂等：可能刚在 cmd 内被删除
  if (!isPlainObject(doc.mcpServers[sname])) return true
  delete doc.mcpServers[sname]
  writeMcpDoc(doc)
  return true
}

// ==================== Skill（~/.commandcode/skills）====================

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
    fileCount: fs.readdirSync(skillPath).length,
    disabled,
  }
}

const getCommandCodeSkills = () => {
  const dir = CC_SKILLS_PATH()
  const skills = []
  const scan = (base, disabled) => {
    if (!fs.existsSync(base)) return
    let entries = []
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch (e) {
      console.error('[commandcode] 读取 skills 目录失败:', e)
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === SKILL_DISABLED_DIR) continue
      try {
        const skill = readSkillEntry(path.join(base, entry.name), disabled)
        if (skill) skills.push(skill)
      } catch (e) {
        console.error('[commandcode] 读取 skill 失败:', entry.name, e)
      }
    }
  }
  scan(dir, false)
  scan(path.join(dir, SKILL_DISABLED_DIR), true)
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// 启停 = 目录物理移动（与其它 agent 同一套心智）
const setCommandCodeSkillEnabled = (skillName, enabled) => {
  const dir = CC_SKILLS_PATH()
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

const deleteCommandCodeSkill = (skillName, isDisabled) => {
  const dir = CC_SKILLS_PATH()
  const skillPath = isDisabled
    ? path.join(dir, SKILL_DISABLED_DIR, skillName)
    : path.join(dir, skillName)
  if (!fs.existsSync(skillPath)) return { success: false, error: t('service.skill.notFound') }
  try {
    fs.rmSync(skillPath, { recursive: true, force: true })
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

const getCommandCodeSkillsDir = () => {
  const dir = CC_SKILLS_PATH()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ==================== Taste（taste 包读写）====================
// 目录结构（官方）：
//   <scope>/taste.md            主档，# 分类 分节
//   <scope>/<category>/taste.md 分类超过 N 条时拆出，主档留 See [<category>/taste.md](./<category>/taste.md)
// 条目形如：- Use const instead of let. Confidence: 0.90
// 拆分规则以官方 TASTE_MAX_INLINE 为准：<=5 条内联主档，>5 条落子文件。
// scope：project = 当前项目 .commandcode/taste（由渲染层传入 rootDir）；
//        global  = ~/.commandcode/taste

const TASTE_ENTRY_RE = /^\s*[-*]\s+(.*?)\s*(?:\.\s*Confidence:\s*([0-9]*\.?[0-9]+))?\s*$/i
const TASTE_CONFIDENCE_RE = /^(.*?)\s*\.?\s*Confidence:\s*([0-9]*\.?[0-9]+)\s*$/i
const TASTE_REF_RE = /^\s*See\s+\[([^\]]+)\]\(([^)]+)\)\s*$/i
const TASTE_CATEGORY_RE = /^#{1,2}\s+(.+?)\s*$/

const tasteRoot = (scope, projectRoot) => {
  if (scope === 'global') return CC_TASTE_GLOBAL_PATH()
  const root = String(projectRoot || '').trim()
  if (!root) throw new Error(t('serviceAgent.commandcode.tasteProjectRootRequired'))
  return path.join(root, '.commandcode', 'taste')
}

const parseTasteEntries = (text) => {
  const entries = []
  const lines = String(text || '').split(/\r?\n/)
  lines.forEach((line, idx) => {
    if (!line.trim()) return
    if (TASTE_CATEGORY_RE.test(line) || TASTE_REF_RE.test(line)) return
    const m = line.match(TASTE_ENTRY_RE)
    if (!m) return
    const body = String(m[1] || '').trim()
    if (!body) return
    // 兼容 Confidence 写在句中（"- xxx. Confidence: 0.9"）
    const cm = body.match(TASTE_CONFIDENCE_RE)
    const textPart = cm ? String(cm[1] || '').trim() : body
    const conf = cm ? Number(cm[2]) : m[2] !== undefined ? Number(m[2]) : null
    if (!textPart) return
    entries.push({
      text: textPart,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
      raw: line,
      line: idx,
    })
  })
  return entries
}

// 解析一个 taste.md：# 分类 分节 → 内联条目 / See 引用
const parseTasteFile = (absPath) => {
  if (!fs.existsSync(absPath)) return { categories: [], raw: '' }
  const raw = fs.readFileSync(absPath, { encoding: 'utf-8' }).replace(/^\uFEFF/, '')
  const categories = []
  let current = null
  for (const line of raw.split(/\r?\n/)) {
    const head = line.match(TASTE_CATEGORY_RE)
    if (head) {
      current = {
        name: head[1].trim(),
        inline: true,
        refPath: '',
        entries: [],
        lines: [],
      }
      categories.push(current)
      continue
    }
    if (!current) continue
    current.lines.push(line)
    const ref = line.match(TASTE_REF_RE)
    if (ref) {
      current.inline = false
      current.refPath = String(ref[2] || '').trim()
      continue
    }
    if (!line.trim()) continue
    const m = line.match(TASTE_ENTRY_RE)
    if (!m) continue
    const body = String(m[1] || '').trim()
    const cm = body.match(TASTE_CONFIDENCE_RE)
    const textPart = cm ? String(cm[1] || '').trim() : body
    const conf = cm ? Number(cm[2]) : m[2] !== undefined ? Number(m[2]) : null
    if (!textPart) continue
    current.entries.push({
      text: textPart,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
      raw: line,
    })
  }
  return { categories, raw }
}

const formatTasteEntry = (entry) => {
  const text = String(entry?.text || '').trim().replace(/\.\s*$/, '')
  const conf = Number(entry?.confidence)
  if (Number.isFinite(conf)) {
    return `- ${text}. Confidence: ${conf.toFixed(2)}`
  }
  return `- ${text}`
}

const categoryFileOf = (root, name) => path.join(root, name, 'taste.md')

// 读一个 scope 的全部分类（内联 + 引用子文件），返回扁平的 [{ name, inline, entries, filePath }]
// 读路径宽容：项目作用域还没选目录时返回空包（页面首次进入 / 切到全局都会顺手读一次项目包），
// 只有写路径（persistTaste / init / open）才允许抛错，避免无意义的红色提示
const readTasteCategories = (scope, projectRoot) => {
  if (scope !== 'global' && !String(projectRoot || '').trim()) {
    return { root: '', mainPath: '', categories: [] }
  }
  const root = tasteRoot(scope, projectRoot)
  const mainPath = path.join(root, 'taste.md')
  const parsed = parseTasteFile(mainPath)
  const out = []
  for (const cat of parsed.categories) {
    if (cat.inline) {
      out.push({ name: cat.name, inline: true, entries: cat.entries, filePath: mainPath })
    } else {
      // 引用子文件：正文在子文件里（官方布局 <category>/taste.md）
      const rel = cat.refPath.replace(/^\.\//, '')
      const subPath = path.resolve(root, rel)
      const sub = parseTasteFile(subPath)
      // 子文件自身可能没有 # 分类标题，条目直接平铺
      const subEntries = sub.categories.length
        ? sub.categories.flatMap((c) => c.entries)
        : []
      const flatEntries = subEntries.length ? subEntries : collectLooseEntries(sub.raw)
      out.push({
        name: cat.name,
        inline: false,
        entries: flatEntries,
        filePath: subPath,
        refPath: cat.refPath,
      })
    }
  }
  // 子目录里存在但主档没引用的分类也补进来（手工编辑/学习生成）
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (e) { /* ignore */ }
  for (const d of dirs) {
    if (out.some((c) => c.name === d.name)) continue
    const subPath = categoryFileOf(root, d.name)
    if (!fs.existsSync(subPath)) continue
    const sub = parseTasteFile(subPath)
    out.push({
      name: d.name,
      inline: false,
      entries: collectLooseEntries(sub.raw),
      filePath: subPath,
      refPath: `./${d.name}/taste.md`,
      orphan: true,
    })
  }
  return { root, mainPath, categories: out }
}

// 子文件里没有 # 标题时，逐行收集条目
const collectLooseEntries = (raw) => parseTasteEntries(raw)

const getCommandCodeTastePackages = (projectRoot) => {
  const project = readTasteCategories('project', projectRoot)
  const globalPkg = readTasteCategories('global', null)
  return {
    project: {
      root: project.root,
      exists: fs.existsSync(project.mainPath),
      categories: project.categories,
    },
    global: {
      root: globalPkg.root,
      exists: fs.existsSync(globalPkg.mainPath),
      categories: globalPkg.categories,
    },
  }
}

// 汇总：分类数 / 条目数 / 置信度分布 / 跨包重复偏好
const getCommandCodeTasteSummary = (projectRoot) => {
  const pkgs = getCommandCodeTastePackages(projectRoot)
  const buckets = { low: 0, mid: 0, high: 0, unknown: 0 }
  const textCount = new Map()
  const perScope = {}
  for (const scope of ['project', 'global']) {
    const cats = pkgs[scope].categories
    let entries = 0
    for (const cat of cats) {
      entries += cat.entries.length
      for (const e of cat.entries) {
        const c = e.confidence
        if (c === null || !Number.isFinite(c)) buckets.unknown++
        else if (c < 0.6) buckets.low++
        else if (c <= 0.85) buckets.mid++
        else buckets.high++
        const key = e.text.toLowerCase().replace(/\s+/g, ' ').trim()
        if (key) {
          if (!textCount.has(key)) textCount.set(key, { text: e.text, scopes: new Set(), count: 0 })
          const item = textCount.get(key)
          item.count++
          item.scopes.add(scope)
        }
      }
    }
    perScope[scope] = { categories: cats.length, entries }
  }
  const duplicates = Array.from(textCount.values())
    .filter((i) => i.count > 1)
    .map((i) => ({ text: i.text, count: i.count, scopes: Array.from(i.scopes) }))
  return { scopes: perScope, buckets, duplicates }
}

// 写回一个 scope：受影响的分类按 TASTE_MAX_INLINE 决定内联还是拆分
// categories: [{ name, entries }]，其余未变分类原样保留；
// 不在 categories 里的分类子目录（被删除的分类）一并清理
const persistTaste = (root, mainPath, categories) => {
  const kept = new Set(categories.map((c) => String(c.name || '').trim()))
  const removeCategoryDir = (name) => {
    const dir = path.join(root, name)
    const sub = path.join(dir, 'taste.md')
    if (fs.existsSync(sub)) {
      try { fs.unlinkSync(sub) } catch (e) { /* ignore */ }
    }
    try { fs.rmdirSync(dir) } catch (e) { /* 非空目录不动，避免误删用户文件 */ }
  }
  const lines = []
  for (const cat of categories) {
    const entries = Array.isArray(cat.entries) ? cat.entries : []
    lines.push(`# ${cat.name}`)
    if (entries.length === 0) {
      // 空分类：只留标题，同时清掉可能的旧子文件
      lines.push('')
      removeCategoryDir(cat.name)
      continue
    }
    if (entries.length <= TASTE_MAX_INLINE) {
      for (const e of entries) lines.push(formatTasteEntry(e))
      lines.push('')
      // 并回主档时删除子文件
      removeCategoryDir(cat.name)
    } else {
      // 超过内联上限：写子文件，主档留引用
      const subDir = path.join(root, cat.name)
      fs.mkdirSync(subDir, { recursive: true })
      const subPath = path.join(subDir, 'taste.md')
      const body = entries.map(formatTasteEntry).join('\n') + '\n'
      fs.writeFileSync(subPath, body, { encoding: 'utf-8' })
      lines.push(`See [${cat.name}/taste.md](./${cat.name}/taste.md)`)
      lines.push('')
    }
  }
  // 清理已删除分类遗留的子目录
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (e) { /* ignore */ }
  for (const d of dirs) {
    if (!kept.has(d.name)) removeCategoryDir(d.name)
  }
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(mainPath, lines.join('\n').replace(/\n+$/, '\n'), { encoding: 'utf-8' })
  return true
}

// 读 → 改 → 写。回调收到可变的 categories 数组（[{ name, entries }]）
const mutateTaste = (scope, projectRoot, fn) => {
  const root = tasteRoot(scope, projectRoot)
  const mainPath = path.join(root, 'taste.md')
  const { categories } = readTasteCategories(scope, projectRoot)
  const plain = categories.map((c) => ({
    name: c.name,
    entries: c.entries.map((e) => ({ text: e.text, confidence: e.confidence })),
  }))
  const result = fn(plain)
  validateTaste(plain)
  persistTaste(root, mainPath, plain)
  return result
}

const validateTaste = (categories) => {
  const seen = new Set()
  for (const cat of categories) {
    const name = String(cat.name || '').trim()
    if (!name) throw new Error(t('serviceAgent.commandcode.tasteCategoryRequired'))
    if (/[\\/]/.test(name)) throw new Error(t('serviceAgent.commandcode.tasteCategoryInvalid', { name }))
    if (seen.has(name)) throw new Error(t('serviceAgent.commandcode.tasteCategoryDuplicate', { name }))
    seen.add(name)
    for (const e of cat.entries) {
      if (!String(e.text || '').trim()) throw new Error(t('serviceAgent.commandcode.tasteEntryTextRequired'))
      if (e.confidence !== null && e.confidence !== undefined) {
        const c = Number(e.confidence)
        if (!Number.isFinite(c) || c < 0 || c > 1) {
          throw new Error(t('serviceAgent.commandcode.tasteConfidenceInvalid'))
        }
      }
    }
  }
}

// 越界不是夹紧而是报错：静默改写用户数据比报错更难排查
const clampConfidence = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(t('serviceAgent.commandcode.tasteConfidenceInvalid'))
  }
  return n
}

const addCommandCodeTasteCategory = (scope, projectRoot, name) => {
  const catName = String(name || '').trim()
  return mutateTaste(scope, projectRoot, (cats) => {
    if (cats.some((c) => c.name === catName)) {
      throw new Error(t('serviceAgent.commandcode.tasteCategoryDuplicate', { name: catName }))
    }
    cats.push({ name: catName, entries: [] })
    return true
  })
}

const deleteCommandCodeTasteCategory = (scope, projectRoot, name) =>
  mutateTaste(scope, projectRoot, (cats) => {
    const idx = cats.findIndex((c) => c.name === name)
    if (idx === -1) return true
    cats.splice(idx, 1)
    return true
  })

const addCommandCodeTasteEntry = (scope, projectRoot, category, text, confidence) => {
  const body = String(text || '').trim()
  if (!body) throw new Error(t('serviceAgent.commandcode.tasteEntryTextRequired'))
  return mutateTaste(scope, projectRoot, (cats) => {
    let cat = cats.find((c) => c.name === category)
    if (!cat) {
      cat = { name: category, entries: [] }
      cats.push(cat)
    }
    cat.entries.push({ text: body, confidence: clampConfidence(confidence) })
    return true
  })
}

const updateCommandCodeTasteEntry = (scope, projectRoot, category, index, updates = {}) =>
  mutateTaste(scope, projectRoot, (cats) => {
    const cat = cats.find((c) => c.name === category)
    if (!cat) throw new Error(t('serviceAgent.commandcode.tasteCategoryNotFound', { name: category }))
    const entry = cat.entries[index]
    if (!entry) throw new Error(t('serviceAgent.commandcode.tasteEntryNotFound'))
    if (updates.text !== undefined) {
      const body = String(updates.text || '').trim()
      if (!body) throw new Error(t('serviceAgent.commandcode.tasteEntryTextRequired'))
      entry.text = body
    }
    if (updates.confidence !== undefined) entry.confidence = clampConfidence(updates.confidence)
    return true
  })

const deleteCommandCodeTasteEntry = (scope, projectRoot, category, index) =>
  mutateTaste(scope, projectRoot, (cats) => {
    const cat = cats.find((c) => c.name === category)
    if (!cat) return true
    cat.entries.splice(index, 1)
    return true
  })

const initCommandCodeTaste = (scope, projectRoot) => {
  const root = tasteRoot(scope, projectRoot)
  const mainPath = path.join(root, 'taste.md')
  fs.mkdirSync(root, { recursive: true })
  if (!fs.existsSync(mainPath)) fs.writeFileSync(mainPath, '', { encoding: 'utf-8' })
  return mainPath
}

const openCommandCodeTasteDir = (scope, projectRoot) => {
  const root = tasteRoot(scope, projectRoot)
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })
  try { window.utools.shellOpenPath(root) } catch (e) { /* ignore */ }
}

// ==================== 使用统计（~/.commandcode/projects/<slug>/<session>.jsonl）====================
// 会话日志逐行 JSON：{ type: "message", timestamp, model, usage: { inputTokens, outputTokens,
//   cacheReadTokens, cacheWriteTokens }, message: { role } }
//   只取带 usage 的行（同一 message 可能拆多条：正文 / 工具调用各一行，各自带增量 usage）
//   口径与其它 agent 一致（UsagePage 的日期筛选依赖该形状）：
//     输入（含缓存）= inputTokens + cacheReadTokens + cacheWriteTokens；输出 = outputTokens

const LIST_META_FILE = 'config.json'
const dayKeyOf = (msOrIso) => {
  if (!msOrIso) return null
  const d = typeof msOrIso === 'number' ? new Date(msOrIso) : new Date(msOrIso)
  if (!d || Number.isNaN(d.getTime())) return null
  // 与其它 agent 一致：按本地时区分日
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const listSessionFiles = () => {
  const root = CC_PROJECTS_PATH()
  if (!fs.existsSync(root)) return []
  const out = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (e) {
    console.error('[commandcode] 读取 projects 目录失败:', e)
    return []
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name)
    let files = []
    try {
      files = fs.readdirSync(projectDir, { withFileTypes: true })
    } catch (e) {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      // checkpoints.jsonl 是回滚点记录，不含 usage
      if (f.name.endsWith('.checkpoints.jsonl')) continue
      out.push({
        sessionId: f.name.replace(/\.jsonl$/, ''),
        file: path.join(projectDir, f.name),
        project: project.name,
      })
    }
  }
  return out
}

// ==================== 项目发现（Taste 用）====================
// ~/.commandcode/projects/<slug>/ 的 slug 是官方对 cwd 的**有损**编码
// （/Users/shane/Documents/GitHub/CCConfig → users-shane-documents-git-hub-cc-config，
//  大小写与连字符全部拉平），无法反解。真实路径只存在于会话日志首行的 cwd 字段：
//   {"type":"session","version":3,"id":"…","timestamp":"…","cwd":"/Users/…"}
// 所以这里从每个项目目录里读一个会话文件的首行拿 cwd，拿不到就退化为 slug 本身。
// 读出后只保留目录仍存在的项目（项目被移动/删除时 Taste 目录也没意义了）。

const CWD_LINE_MAX = 4096

const readCwdFromSession = (file) => {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(CWD_LINE_MAX)
    const n = fs.readSync(fd, buf, 0, CWD_LINE_MAX, 0)
    const firstLine = buf.subarray(0, n).toString('utf-8').split(/\r?\n/)[0]
    if (!firstLine) return ''
    const obj = JSON.parse(firstLine)
    // 首行才是 session 头；个别文件可能以消息行开头，此时不猜
    if (!isPlainObject(obj) || obj.type !== 'session') return ''
    return typeof obj.cwd === 'string' ? obj.cwd.trim() : ''
  } catch (e) {
    return ''
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (e) { /* ignore */ }
    }
  }
}

// 项目目录内最近一条会话的时间（用于按活跃度排序）；无会话返回 0
const projectLastActive = (projectDir) => {
  try {
    let latest = 0
    for (const f of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue
      if (f.name.endsWith('.checkpoints.jsonl')) continue
      const st = fs.statSync(path.join(projectDir, f.name))
      if (st.mtimeMs > latest) latest = st.mtimeMs
    }
    return latest
  } catch (e) {
    return 0
  }
}

// 列出所有「本机曾用 Command Code 打开过」的项目
// extraRoots：用户手动选过 / 上次选中的目录（可能不在 projects 里，如未用 cmd 打开过的仓库），
//   存在就一并并入结果，避免页面切走后再也找不到它。
// 返回 [{ slug, root, name, lastActive, hasTaste, manual? }]，按最近活跃倒序
const listCommandCodeProjects = (extraRoots = []) => {
  const root = CC_PROJECTS_PATH()
  const out = []
  const seen = new Set()
  let dirs = []
  if (fs.existsSync(root)) {
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch (e) {
      console.error('[commandcode] 读取 projects 目录失败:', e)
      dirs = []
    }
  }
  for (const d of dirs) {
    const projectDir = path.join(root, d.name)
    let cwd = ''
    try {
      const sessions = fs.readdirSync(projectDir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.jsonl') && !f.name.endsWith('.checkpoints.jsonl'))
        .map((f) => path.join(projectDir, f.name))
      // 优先读最新的会话（首行都带 cwd，新的更可能是当前有效路径）
      sessions.sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs } catch (e) { return 0 }
      })
      for (const file of sessions) {
        cwd = readCwdFromSession(file)
        if (cwd) break
      }
    } catch (e) {
      /* 单个项目读失败不影响其它项目 */
    }
    const projectRoot = cwd || path.join(root, d.name)
    // 项目被移动/删除后 cwd 已失效：跳过，避免列出一个写不进去的项目
    if (cwd && !fs.existsSync(cwd)) continue
    if (seen.has(projectRoot)) continue
    seen.add(projectRoot)
    out.push({
      slug: d.name,
      // 会话日志里带 cwd 时用它；退化时给 slug 路径（仍可作为选择项）
      root: projectRoot,
      name: path.basename(projectRoot) || d.name,
      lastActive: projectLastActive(projectDir),
      // 项目级 Taste 是否已存在，UI 用来标记「已初始化」
      hasTaste: fs.existsSync(path.join(projectRoot, '.commandcode', 'taste', 'taste.md')),
    })
  }
  for (const raw of extraRoots) {
    const extra = String(raw || '').trim()
    if (!extra || seen.has(extra)) continue
    if (!fs.existsSync(extra)) continue
    let stat
    try { stat = fs.statSync(extra) } catch (e) { continue }
    if (!stat.isDirectory()) continue
    seen.add(extra)
    out.push({
      slug: '',
      root: extra,
      name: path.basename(extra) || extra,
      lastActive: 0,
      hasTaste: fs.existsSync(path.join(extra, '.commandcode', 'taste', 'taste.md')),
      manual: true,
    })
  }
  return out.sort((a, b) => b.lastActive - a.lastActive)
}

const collectUsageRecords = () => {
  const messageRecords = []
  const sessionMap = new Map()
  for (const session of listSessionFiles()) {
    let raw
    try {
      raw = fs.readFileSync(session.file, { encoding: 'utf-8' })
    } catch (e) {
      continue
    }
    const sess = {
      sessionId: session.sessionId,
      timestamp: '',
      cwd: session.project,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    let hasUsage = false
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.indexOf('"usage"') === -1) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch (e) {
        // 正在写入 / 断尾行：跳过，下次刷新再读
        continue
      }
      const u = obj && obj.usage
      if (!isPlainObject(u)) continue
      const input = toNumber(u.inputTokens)
      const output = toNumber(u.outputTokens)
      const cacheRead = toNumber(u.cacheReadTokens)
      const cacheWrite = toNumber(u.cacheWriteTokens)
      const total = input + output + cacheRead + cacheWrite
      if (total === 0) continue
      const date = dayKeyOf(obj.timestamp)
      if (!date) continue
      const model = String(obj.model || 'unknown').trim() || 'unknown'
      messageRecords.push({
        sessionId: session.sessionId,
        model,
        date,
        timestamp: new Date(obj.timestamp).getTime() || 0,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        totalTokens: total,
      })
      hasUsage = true
      sess.inputTokens += input
      sess.outputTokens += output
      sess.cacheReadTokens += cacheRead
      sess.cacheCreationTokens += cacheWrite
      const ts = String(obj.timestamp || '')
      if (ts && (!sess.timestamp || ts > sess.timestamp)) sess.timestamp = ts
    }
    if (hasUsage) sessionMap.set(session.sessionId, sess)
  }
  return { messageRecords, sessionMap }
}

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
  const contributions = []
  const now = new Date()
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    contributions.push({
      date: d.toISOString().split('T')[0],
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      models: {},
    })
  }
  return {
    summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, messageCount: 0, sessionCount: 0 },
    modelStats: [],
    contributions,
    sessionCount: 0,
    messageCount: 0,
  }
}

// 源文件被清理后回放落库历史，避免历史归零；无历史返回 null
const statsFromHistory = () => {
  const usage = require('./usage')
  const history = usage.readAgentUsage('commandcode')
  const dates = Object.keys(history)
  if (dates.length === 0) return null
  const contributions = usage.fillEmptyContributions(
    dates.sort().map((date) => ({ date, ...history[date], models: history[date].models || {} })),
  )
  return aggregate(contributions, 0, 0)
}

const readCommandCodeUsageFromHistory = () => {
  try {
    return statsFromHistory()
  } catch (e) {
    console.error('[Command Code Usage] 读历史统计失败:', e)
    return null
  }
}

const readCommandCodeUsage = (forceRefresh = false) => {
  const usage = require('./usage')
  try {
    const files = listSessionFiles()
    if (files.length === 0) return statsFromHistory() || emptyResult()
    const { messageRecords, sessionMap } = collectUsageRecords()
    if (messageRecords.length === 0) return statsFromHistory() || emptyResult()
    const stats = usage.calculateStats(messageRecords, sessionMap)
    const result = aggregate(stats.contributions, messageRecords.length, sessionMap.size)
    usage.saveAgentUsage('commandcode', stats.contributions)
    return result
  } catch (e) {
    console.error('[Command Code Usage] 统计失败:', e)
    return emptyResult()
  }
}

const getCommandCodeProjectsDir = () => {
  const dir = CC_PROJECTS_PATH()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ==================== 目录 / 安装检测 ====================

const openCommandCodeDir = () => {
  const dir = CC_HOME()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch (e) { /* ignore */ }
}

const openCommandCodeConfigFile = () => {
  const p = CC_PROVIDERS_PATH()
  if (!fs.existsSync(p)) writeProvidersDoc({ provider: {} })
  try { window.utools.shellOpenPath(p) } catch (e) { /* ignore */ }
}

const isCommandCodeInstalled = () => fs.existsSync(CC_HOME())

// 有自定义供应商或任何模型即视为有数据（detectAgentsConfig 用，不创建文件）
const hasCommandCodeConfig = () => {
  try {
    const doc = readProvidersDoc()
    const entries = Object.values(doc.provider).filter((p) => isPlainObject(p))
    if (entries.length === 0) return false
    return entries.some((p) => isPlainObject(p.models) && Object.keys(p.models).length > 0) || entries.length > 0
  } catch (e) {
    return false
  }
}

module.exports = {
  getCommandCodeHome,
  getCommandCodeProvidersPath,
  getCommandCodeProjectsDir,
  CC_APIS, DEFAULT_API, CC_EFFORTS, TASTE_MAX_INLINE,
  readProvidersDoc, writeProvidersDoc, readSettingsDoc, writeSettingsDoc,
  readAuthDoc, readJsonDoc, writeJsonDoc,
  providerKeyFor,
  getCommandCodeProviderList,
  addCommandCodeProvider, updateCommandCodeProvider, deleteCommandCodeProvider,
  setCommandCodeApiKey, clearCommandCodeApiKey, maskKey,
  addCommandCodeModel, updateCommandCodeModel, deleteCommandCodeModel,
  getCommandCodeDefaultModel, setCommandCodeDefaultModel,
  upsertCommandCodeProvider, upsertCommandCodeModel,
  // MCP
  getCommandCodeMcpServers, setCommandCodeMcpServer, setCommandCodeMcpEnabled,
  deleteCommandCodeMcpServer, getCommandCodeMcpConfigFor,
  // Skill
  getCommandCodeSkills, setCommandCodeSkillEnabled, deleteCommandCodeSkill, getCommandCodeSkillsDir,
  // Taste
  getCommandCodeTastePackages, getCommandCodeTasteSummary,
  addCommandCodeTasteCategory, deleteCommandCodeTasteCategory,
  addCommandCodeTasteEntry, updateCommandCodeTasteEntry, deleteCommandCodeTasteEntry,
  initCommandCodeTaste, openCommandCodeTasteDir,
  // 项目发现（Taste 项目作用域下拉）
  listCommandCodeProjects,
  // Usage
  readCommandCodeUsage, readCommandCodeUsageFromHistory,
  // 目录 / 检测
  openCommandCodeDir, openCommandCodeConfigFile, isCommandCodeInstalled, hasCommandCodeConfig,
}
