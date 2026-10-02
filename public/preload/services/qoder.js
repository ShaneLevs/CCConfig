const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Qoder（AI IDE）：自定义模型供应商配置在 ~/.qoder/settings.json。
// 本服务只管理 providers 表（第三方 openai-compatible 供应商 CRUD），
// 其余字段（enabledPlugins 等）读改写原样保留（同 kimi / minimax 纪律）：
//   providers.<providerId> — {
//     baseUrl, apiKey, type: "openai-compatible", protocol: "anthropic"|"openai",
//     authType: "api-key", model: "<默认模型ID>", models: [ { model, displayName,
//     contextWindow, maxOutputTokens, capabilities: { vision, thinking: {...} } } ]
//   }
// providerId 为 Qoder 生成的 "qoder-custom-<uuid>" 形态；新建时按同样前缀 + 随机 UUID 生成。
// 默认模型记录在 provider 顶层 model 字段（不是独立 defaultModel），指向其 models[].model。
// 密钥明文写入 apiKey：与 Qoder 自身写同一文件的做法一致。

const QODER_HOME = () => path.join(os.homedir(), '.qoder')
const QODER_CONFIG_PATH = () => path.join(QODER_HOME(), 'settings.json')
const getQoderHome = QODER_HOME
const getQoderConfigPath = QODER_CONFIG_PATH

// 协议取值（实测 settings.json：protocol: "anthropic"；官方支持 openai-compatible 供应商）
const PROTOCOL_VALUES = ['anthropic', 'openai']

// Provider / 模型 ID 格式：Qoder 生成 UUID 形态键，但手输键兼容常见命名
const PROVIDER_ID_RE = /^[\w.:-]+$/
const MODEL_ID_RE = /^[-\w.:\/]+$/
// 下发清洗用：与 PROVIDER_ID_RE 一致（别名导出，语义对齐 minimax.PROVIDER_KEY_RE）
const PROVIDER_KEY_RE = PROVIDER_ID_RE

// ==================== settings.json 读写 ====================

const readQoderConfig = () => {
  const p = QODER_CONFIG_PATH()
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    return JSON.parse(raw) || {}
  } catch (e) {
    // 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会用
    // 空对象覆盖整个 settings.json，抹掉 enabledPlugins 等其他节（同 kimi / minimax 纪律）
    throw new Error(`settings.json 解析失败，已阻止修改（请先修复 JSON 语法）: ${e.message}`)
  }
}

const writeQoderConfig = (doc) => {
  const p = QODER_CONFIG_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(doc || {}, null, 2), { encoding: 'utf-8' })
  return true
}

const getProvidersTable = (doc) => {
  if (!doc.providers || typeof doc.providers !== 'object') doc.providers = {}
  return doc.providers
}

// ==================== 归一化 / 构建 ====================

// UI 认识并显式管理的字段；其余原样收进 _extra 写回，避免编辑时抹掉扩展字段
const KNOWN_PROVIDER_FIELDS = ['baseUrl', 'apiKey', 'type', 'protocol', 'authType', 'model', 'models']

// thinking 支持的档位（实测 settings.json supportedEffortLevels；枚举参考 openai responses 风格）
const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max']

// 归一化一个 model 条目供 UI 消费
const normalizeModel = (m) => {
  const caps = (m && typeof m.capabilities === 'object' && m.capabilities) || {}
  const thinking = (caps.thinking && typeof caps.thinking === 'object' && caps.thinking) || {}
  return {
    model: (m && typeof m.model === 'string' && m.model) || '',
    displayName: (m && typeof m.displayName === 'string' && m.displayName) || '',
    contextWindow: Number(m && m.contextWindow) || 0,
    maxOutputTokens: Number(m && m.maxOutputTokens) || 0,
    vision: caps.vision === true,
    thinkingEnabled: Array.isArray(thinking.modes) && thinking.modes.includes('enabled'),
    effortLevels: Array.isArray(thinking.supportedEffortLevels)
      ? thinking.supportedEffortLevels.filter((x) => EFFORT_VALUES.includes(x))
      : [],
    supportsEffort: thinking.supportsEffort === true,
    // 原始对象整体往返：thinking.modes 其他档位（disabled 等）等扩展字段保留
    _raw: m && typeof m === 'object' ? m : {},
  }
}

// 从 UI 结构构建写入 JSON 的 model 条目（_raw 中非受管字段原样保留）
const buildModelJson = (cfg) => {
  const next = { ...(cfg._raw || {}) }
  next.model = cfg.model
  next.displayName = cfg.displayName || cfg.model
  if (Number(cfg.contextWindow) > 0) next.contextWindow = Number(cfg.contextWindow)
  else delete next.contextWindow
  if (Number(cfg.maxOutputTokens) > 0) next.maxOutputTokens = Number(cfg.maxOutputTokens)
  else delete next.maxOutputTokens
  const caps = { ...((cfg._raw && cfg._raw.capabilities) || {}) }
  if (cfg.vision) caps.vision = true
  else delete caps.vision
  const th = { ...((caps.thinking && typeof caps.thinking === 'object' && caps.thinking) || {}) }
  if (cfg.thinkingEnabled) {
    // modes 保留原值里其他档位，确保包含 enabled；supportsEffort / supportedEffortLevels 随 UI 重建
    const modes = Array.isArray(th.modes) ? th.modes.filter((x) => x !== 'enabled') : []
    modes.push('enabled')
    th.modes = modes
    th.supportsEffort = cfg.supportsEffort === true
    if (cfg.supportsEffort && Array.isArray(cfg.effortLevels) && cfg.effortLevels.length) {
      th.supportedEffortLevels = cfg.effortLevels.filter((x) => EFFORT_VALUES.includes(x))
    } else {
      delete th.supportedEffortLevels
    }
  } else {
    delete th.modes
    delete th.supportsEffort
    delete th.supportedEffortLevels
  }
  if (Object.keys(th).length) caps.thinking = th
  else delete caps.thinking
  if (Object.keys(caps).length) next.capabilities = caps
  else delete next.capabilities
  return next
}

const normalizeProvider = (id, p) => {
  const extra = {}
  for (const k of Object.keys(p || {})) {
    if (!KNOWN_PROVIDER_FIELDS.includes(k)) extra[k] = p[k]
  }
  return {
    id,
    name: id.replace(/^qoder-custom-/, '') || id, // 展示名：去 Qoder 生成前缀
    baseUrl: (p && p.baseUrl) || '',
    apiKey: (p && p.apiKey) || '',
    protocol: (p && p.protocol) || 'openai',
    authType: (p && p.authType) || 'api-key',
    // 顶层 model = 该供应商的默认模型 ID
    model: (p && typeof p.model === 'string' && p.model) || '',
    models: Object.values((p && p.models) || {}).map((m) => normalizeModel(m)),
    _extra: extra,
  }
}

const buildProviderJson = (cfg) => {
  const p = { ...cfg._extra }
  p.baseUrl = cfg.baseUrl || ''
  p.apiKey = cfg.apiKey || ''
  p.type = 'openai-compatible'
  p.protocol = cfg.protocol || 'openai'
  p.authType = cfg.authType || 'api-key'
  // model 字段仅在指向存在的模型时写入；无模型时删除（Qoder 兼容缺省）
  if (cfg.model && (cfg.models || []).some((m) => m.model === cfg.model)) p.model = cfg.model
  else delete p.model
  p.models = (cfg.models || []).map((m) => buildModelJson(m))
  return p
}

// ==================== Providers ====================

const getQoderProviderList = () => {
  const doc = readQoderConfig()
  return Object.entries(getProvidersTable(doc)).map(([id, p]) => normalizeProvider(id, p))
}

// 新建 provider：沿用 Qoder 官方命名 qoder-custom-<uuid>（实测 settings.json 键形态）
const addQoderProvider = (cfg) => {
  const id = String(cfg?.id || '').trim() || `qoder-custom-${crypto.randomUUID()}`
  if (!PROVIDER_ID_RE.test(id)) throw new Error(`Provider ID ${id} 不合法`)
  assertProtocol(cfg.protocol)
  const doc = readQoderConfig()
  const table = getProvidersTable(doc)
  if (table[id]) throw new Error(`Provider ${id} 已存在`)
  table[id] = buildProviderJson({
    baseUrl: String(cfg.baseUrl || '').trim(),
    apiKey: cfg.apiKey || '',
    protocol: cfg.protocol || 'openai',
    authType: 'api-key',
    model: '',
    models: [],
    _extra: {},
  })
  writeQoderConfig(doc)
  return id
}

const assertProtocol = (protocol) => {
  if (protocol && !PROTOCOL_VALUES.includes(protocol)) {
    throw new Error(`不支持的协议 ${protocol}（可选：${PROTOCOL_VALUES.join(' / ')}）`)
  }
}

const updateQoderProvider = (id, updates) => {
  const doc = readQoderConfig()
  const table = getProvidersTable(doc)
  if (!table[id]) throw new Error(`Provider ${id} 不存在`)
  assertProtocol(updates.protocol)
  // 支持改 ID（表键）：改名需校验冲突
  const newId = updates.id === undefined || updates.id === id ? id : String(updates.id).trim()
  if (!PROVIDER_ID_RE.test(newId)) throw new Error(`Provider ID ${newId} 不合法`)
  if (newId !== id && table[newId]) throw new Error(`Provider ${newId} 已存在`)
  const prev = normalizeProvider(id, table[id])
  const merged = { ...prev, ...updates, id: newId }
  if (updates.clearApiKey) merged.apiKey = ''
  delete merged.name // name 为展示推导值，不写回
  const next = buildProviderJson(merged)
  delete table[id]
  table[newId] = next
  writeQoderConfig(doc)
  return true
}

const deleteQoderProvider = (id) => {
  const doc = readQoderConfig()
  const table = getProvidersTable(doc)
  if (!table[id]) throw new Error(`Provider ${id} 不存在`)
  delete table[id]
  writeQoderConfig(doc)
  return true
}

// ==================== Models（providers.<id>.models[]） ====================

const addQoderModel = (providerId, cfg) => {
  const modelId = String(cfg?.model || '').trim()
  if (!modelId) throw new Error('模型 ID 不能为空')
  if (!MODEL_ID_RE.test(modelId)) throw new Error('模型 ID 只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  const doc = readQoderConfig()
  const table = getProvidersTable(doc)
  if (!table[providerId]) throw new Error(`Provider ${providerId} 不存在`)
  const provider = table[providerId]
  if (!Array.isArray(provider.models)) provider.models = []
  if (provider.models.some((m) => m && m.model === modelId)) throw new Error(`模型 ${modelId} 已存在`)
  provider.models.push(buildModelJson({
    model: modelId,
    displayName: String(cfg.displayName || '').trim(),
    contextWindow: Number(cfg.contextWindow) || 0,
    maxOutputTokens: Number(cfg.maxOutputTokens) || 0,
    vision: cfg.vision === true,
    thinkingEnabled: cfg.thinkingEnabled === true,
    supportsEffort: cfg.supportsEffort === true,
    effortLevels: Array.isArray(cfg.effortLevels) ? cfg.effortLevels : [],
    _raw: {},
  }))
  // 供应商尚无默认模型时自动指向首个模型
  if (!provider.model) provider.model = modelId
  writeQoderConfig(doc)
  return true
}

const updateQoderModel = (providerId, modelId, updates) => {
  const doc = readQoderConfig()
  const table = getProvidersTable(doc)
  if (!table[providerId]) throw new Error(`Provider ${providerId} 不存在`)
  const provider = table[providerId]
  if (!Array.isArray(provider.models)) provider.models = []
  const idx = provider.models.findIndex((m) => m && m.model === modelId)
  if (idx === -1) throw new Error(`模型 ${modelId} 不存在`)
  const newId = updates.model === undefined || updates.model === modelId ? modelId : String(updates.model).trim()
  if (!newId) throw new Error('模型 ID 不能为空')
  if (!MODEL_ID_RE.test(newId)) throw new Error('模型 ID 只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  if (newId !== modelId && provider.models.some((m) => m && m.model === newId)) throw new Error(`模型 ${newId} 已存在`)
  const prev = normalizeModel(provider.models[idx])
  const merged = { ...prev, ...updates, model: newId }
  provider.models[idx] = buildModelJson(merged)
  // 改名同步默认模型引用
  if (newId !== modelId && provider.model === modelId) provider.model = newId
  writeQoderConfig(doc)
  return true
}

const deleteQoderModel = (providerId, modelId) => {
  const doc = readQoderConfig()
  const table = getProvidersTable(doc)
  const provider = table[providerId]
  if (!provider || !Array.isArray(provider.models)) return true
  const before = provider.models.length
  provider.models = provider.models.filter((m) => m && m.model !== modelId)
  if (provider.models.length === before) return true
  // 清理悬挂的默认模型引用
  if (provider.model === modelId) {
    provider.model = provider.models.length ? provider.models[0].model : ''
    if (!provider.model) delete provider.model
  }
  writeQoderConfig(doc)
  return true
}

// 默认模型 = provider 顶层 model 字段
const getQoderDefaultModel = (providerId) => {
  const doc = readQoderConfig()
  const provider = getProvidersTable(doc)[providerId]
  return (provider && provider.model) || ''
}

const setQoderDefaultModel = (providerId, modelId) => {
  const doc = readQoderConfig()
  const provider = getProvidersTable(doc)[providerId]
  if (!provider) throw new Error(`Provider ${providerId} 不存在`)
  const models = Array.isArray(provider.models) ? provider.models : []
  if (modelId && !models.some((m) => m && m.model === modelId)) {
    throw new Error(`模型 ${modelId} 不存在，无法设为默认`)
  }
  if (modelId) provider.model = modelId
  else delete provider.model
  writeQoderConfig(doc)
  return true
}

// ==================== 下发用 upsert（dispatch.js 调用，语义同 minimax.upsert*） ====================

// 通用库供应商名可能是中文/任意符号，而 provider 键是 settings.json 的表键，需确定性清洗
//（同一下发名永远得到同一键 → upsert 幂等）：合法名原样用；否则取 ASCII 骨架 + 原名稳定哈希防碰撞
const hashName = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
const providerKeyFor = (name) => {
  const raw = String(name || '').trim()
  if (PROVIDER_KEY_RE.test(raw)) return raw
  const base = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'p'
  return `${base}-${hashName(raw)}`
}

// 存在则合并更新（空值不覆盖既有 baseUrl/apiKey），否则创建
const upsertQoderProvider = (id, cfg) => {
  const pid = String(id || '').trim()
  if (!PROVIDER_ID_RE.test(pid)) throw new Error(`Provider ID ${pid} 不合法`)
  assertProtocol(cfg.protocol)
  const doc = readQoderConfig()
  const table = getProvidersTable(doc)
  const prev = table[pid] ? normalizeProvider(pid, table[pid]) : null
  const merged = {
    baseUrl: cfg.baseUrl || (prev && prev.baseUrl) || '',
    apiKey: cfg.apiKey || (prev && prev.apiKey) || '',
    protocol: cfg.protocol || (prev && prev.protocol) || 'openai',
    model: (prev && prev.model) || '',
    models: prev ? prev.models : [],
    _extra: (prev && prev._extra) || {},
  }
  table[pid] = buildProviderJson(merged)
  writeQoderConfig(doc)
  return true
}

// 模型已存在时只刷新传入的受管字段（displayName/上下文/输出上限，未传的保留既有值），不存在则新建；
// 返回默认模型可引用的模型 ID
const upsertQoderModel = (providerId, modelId, opts = {}) => {
  const id = String(modelId || '').trim()
  if (!MODEL_ID_RE.test(id)) throw new Error(`模型 ID ${id} 含非法字符，无法下发到 Qoder`)
  const doc = readQoderConfig()
  const table = getProvidersTable(doc)
  const provider = table[providerId]
  if (!provider) throw new Error(`Provider ${providerId} 不存在`)
  if (!Array.isArray(provider.models)) provider.models = []
  const prevEntry = provider.models.find((m) => m && m.model === id)
  const merged = prevEntry ? normalizeModel(prevEntry) : { model: id, _raw: {} }
  if (opts.name) merged.displayName = String(opts.name).trim()
  if (Number(opts.contextWindow) > 0) merged.contextWindow = Number(opts.contextWindow)
  if (Number(opts.maxOutputTokens) > 0) merged.maxOutputTokens = Number(opts.maxOutputTokens)
  const entry = buildModelJson(merged)
  if (prevEntry) provider.models[provider.models.indexOf(prevEntry)] = entry
  else provider.models.push(entry)
  // 供应商尚无默认模型时自动指向首个模型（与 addQoderModel 语义一致）
  if (!provider.model) provider.model = id
  writeQoderConfig(doc)
  return id
}

// ==================== 目录操作 ====================

const openQoderDir = () => {
  const dir = QODER_HOME()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const isQoderInstalled = () => fs.existsSync(QODER_CONFIG_PATH())

// crypto.randomUUID 垫片（Electron node18 原生支持，兜底手动实现）
const crypto = {
  randomUUID() {
    try { return require('node:crypto').randomUUID() } catch { /* ignore */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  },
}

module.exports = {
  getQoderHome, getQoderConfigPath,
  readQoderConfig, writeQoderConfig,
  getQoderProviderList, addQoderProvider, updateQoderProvider, deleteQoderProvider,
  upsertQoderProvider, providerKeyFor,
  addQoderModel, updateQoderModel, deleteQoderModel, upsertQoderModel,
  getQoderDefaultModel, setQoderDefaultModel,
  openQoderDir, isQoderInstalled,
  PROTOCOL_VALUES, EFFORT_VALUES, PROVIDER_ID_RE,
}
