const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Qoder（AI IDE）有两个发行版，配置文件结构完全一致、只有家目录不同：
//   国际版 ~/.qoder/settings.json、国内版 ~/.qoder-cn/settings.json
// 本服务把两边当成同一张 providers 表管理：每次读取先合并，发现两边不一致就立刻写回全部目录
//（缺失的目录会创建），保证 provider 设置两边一模一样。
// providers.<providerId> — {
//   baseUrl, apiKey, type: "openai-compatible", protocol: "anthropic"|"openai",
//   authType: "api-key", model: "<默认模型ID>", models: [ { model, displayName,
//   contextWindow, maxOutputTokens, capabilities: { vision, thinking: {...} } } ]
// }
// providerId 为 Qoder 生成的 "qoder-custom-<uuid>" 形态；新建时按同样前缀 + 随机 UUID 生成。
// 默认模型记录在 provider 顶层 model 字段（不是独立 defaultModel），指向其 models[].model。
// 密钥明文写入 apiKey：与 Qoder 自身写同一文件的做法一致。
// 各文件除 providers 外的顶层字段（enabledPlugins 等）读改写原样保留（同 kimi / minimax 纪律）。

const EDITIONS = [
  { id: 'intl', label: '国际版', dirName: '.qoder' },
  { id: 'cn', label: '国内版', dirName: '.qoder-cn' },
]
const ALL_EDITION_IDS = EDITIONS.map((e) => e.id)

const editionHome = (ed) => path.join(os.homedir(), ed.dirName)
const editionConfigPath = (ed) => path.join(editionHome(ed), 'settings.json')
const editionOf = (id) => EDITIONS.find((e) => e.id === id)

// 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会用
// 空对象覆盖整个 settings.json，抹掉其他节，且残缺结果会被同步到另一边
const readEditionDoc = (ed) => {
  const p = editionConfigPath(ed)
  if (!fs.existsSync(p)) return null
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${ed.label} ${p} 解析失败，已阻止修改与同步（请先修复 JSON 语法）: ${e.message}`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${ed.label} ${p} 顶层不是 JSON 对象，已阻止修改与同步`)
  }
  return doc
}

const providersOf = (doc) => {
  if (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) {
    doc.providers = {}
  }
  return doc.providers
}

// ==================== 协议 / ID 约定 ====================

// 协议取值（实测 settings.json：protocol: "anthropic"；官方支持 openai-compatible 供应商）
const PROTOCOL_VALUES = ['anthropic', 'openai']

// Provider / 模型 ID 格式：Qoder 生成 UUID 形态键，但手输键兼容常见命名
const PROVIDER_ID_RE = /^[\w.:-]+$/
const MODEL_ID_RE = /^[-\w.:\/]+$/
// 下发清洗用：与 PROVIDER_ID_RE 一致（别名导出，语义对齐 minimax.PROVIDER_KEY_RE）
const PROVIDER_KEY_RE = PROVIDER_ID_RE

const assertProtocol = (protocol) => {
  if (protocol && !PROTOCOL_VALUES.includes(protocol)) {
    throw new Error(`不支持的协议 ${protocol}（可选：${PROTOCOL_VALUES.join(' / ')}）`)
  }
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

// ==================== 跨版本合并 / 同步写回 ====================

// 本次读取的快照：perEdition = 各版本同步前的 providers 原样，
// sources = 各 provider 同步前存在于哪些版本（UI 版本标记用），
// exists = 同步前各版本家目录是否已存在，preCounts = 同步前各版本的 provider 数，
// syncedIds = 本次写回时被补齐的键
const snapshot = { perEdition: {}, sources: {}, tables: {}, exists: {}, preCounts: {}, syncedIds: [] }

const modelIdOf = (m) => (m && typeof m.model === 'string' ? m.model : '')

// 「最全」判据：模型条数为主，其次已填的受管字段与未识别扩展字段
const providerCompleteness = (p) => {
  let score = (Array.isArray(p.models) ? p.models.length : 0) * 100
  for (const k of ['baseUrl', 'apiKey', 'protocol', 'model']) if (p[k]) score += 1
  for (const k of Object.keys(p)) if (!KNOWN_PROVIDER_FIELDS.includes(k)) score += 1
  return score
}

// 同名 provider 在两边都存在时：以最完整的那条为基准，缺失/空字段用另一条补（含未识别扩展字段），
// 模型取并集（基准侧在前）
const mergeProviderVariants = (variants) => {
  let base = variants[0]
  for (const p of variants) if (providerCompleteness(p) > providerCompleteness(base)) base = p
  const merged = JSON.parse(JSON.stringify(base))
  for (const p of variants) {
    for (const [k, v] of Object.entries(p)) {
      if (merged[k] === undefined || merged[k] === '') {
        if (v !== undefined && v !== '') merged[k] = JSON.parse(JSON.stringify(v))
      }
    }
  }
  const models = Array.isArray(merged.models) ? merged.models : []
  const seen = new Set(models.map(modelIdOf))
  for (const p of variants) {
    for (const m of (Array.isArray(p.models) ? p.models : [])) {
      const id = modelIdOf(m)
      if (id && !seen.has(id)) {
        seen.add(id)
        models.push(JSON.parse(JSON.stringify(m)))
      }
    }
  }
  merged.models = models
  if (merged.model && !models.some((m) => modelIdOf(m) === merged.model)) delete merged.model
  return merged
}

const loadMergedTable = () => {
  const variants = {}
  const sources = {}
  const perEdition = {}
  for (const ed of EDITIONS) {
    snapshot.exists[ed.id] = fs.existsSync(editionHome(ed))
    const doc = readEditionDoc(ed)
    const table = doc ? providersOf(doc) : {}
    perEdition[ed.id] = table
    for (const [id, p] of Object.entries(table)) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      ;(variants[id] ||= []).push(p)
      ;(sources[id] ||= []).push(ed.id)
    }
  }
  const tables = {}
  // 键排序：写回顺序稳定，读取顺序与文件顺序一致（避免列表次序在刷新间跳动）
  for (const id of Object.keys(variants).sort()) tables[id] = mergeProviderVariants(variants[id])
  snapshot.perEdition = perEdition
  snapshot.sources = sources
  snapshot.tables = tables
  snapshot.preCounts = Object.fromEntries(
    EDITIONS.map((ed) => [ed.id, Object.keys(perEdition[ed.id]).length])
  )
  return tables
}

// 两边 providers 是否已与合并结果一致（两侧都按键排序后比较，避免对象键顺序造成假不一致）
const sortedProviders = (table) => {
  const out = {}
  for (const k of Object.keys(table).sort()) out[k] = table[k]
  return out
}

const isEditionsSynced = () => {
  const expected = JSON.stringify(sortedProviders(snapshot.tables))
  return EDITIONS.every(
    (ed) => JSON.stringify(sortedProviders(snapshot.perEdition[ed.id] || {})) === expected
  )
}

// 写回全部版本：文件不存在则创建目录与文件，存在则只替换 providers 字段
const commitTable = (table) => {
  const json = JSON.stringify(sortedProviders(table || {}))
  for (const ed of EDITIONS) {
    const doc = readEditionDoc(ed) || {}
    doc.providers = JSON.parse(json)
    fs.mkdirSync(editionHome(ed), { recursive: true })
    fs.writeFileSync(editionConfigPath(ed), JSON.stringify(doc, null, 2), { encoding: 'utf-8' })
    snapshot.perEdition[ed.id] = doc.providers
  }
  snapshot.tables = table
  return true
}

// 读取即同步：发现两边不一致（含某版本目录缺失）就把合并结果写回全部版本
const loadTableAndSync = () => {
  const table = loadMergedTable()
  if (!isEditionsSynced()) {
    snapshot.syncedIds = ALL_EDITION_IDS.reduce(
      (acc, edId) => {
        for (const [id, eds] of Object.entries(snapshot.sources)) {
          if (!eds.includes(edId) && !acc.includes(id)) acc.push(id)
        }
        return acc
      },
      []
    )
    commitTable(table)
  } else {
    snapshot.syncedIds = []
  }
  return table
}

// ==================== 版本状态（UI 用） ====================

const getQoderEditionStatus = () =>
  EDITIONS.map((ed) => ({
    id: ed.id,
    label: ed.label,
    dir: `~/${ed.dirName}`,
    homePath: editionHome(ed),
    // 同步前该版本目录是否已存在（不存在但本次写了文件 = 新建并同步）
    installed: snapshot.exists[ed.id] === undefined
      ? fs.existsSync(editionHome(ed))
      : snapshot.exists[ed.id],
    // 本次读取（同步前）该版本已有的 provider 数
    providerCount: snapshot.preCounts[ed.id] || 0,
  }))

// 本次读取是否发生了自动同步，以及被补齐到缺失版本的 provider 键
const getQoderSyncState = () => ({ syncedIds: [...snapshot.syncedIds] })

// ==================== Providers ====================

const getQoderProviderList = () => {
  const table = loadTableAndSync()
  return Object.entries(table).map(([id, p]) => ({
    ...normalizeProvider(id, p),
    editions: snapshot.sources[id] || ALL_EDITION_IDS,
  }))
}

// 新建 provider：沿用 Qoder 官方命名 qoder-custom-<uuid>（实测 settings.json 键形态）
const addQoderProvider = (cfg) => {
  const id = String(cfg?.id || '').trim() || `qoder-custom-${crypto.randomUUID()}`
  if (!PROVIDER_ID_RE.test(id)) throw new Error(`Provider ID ${id} 不合法`)
  assertProtocol(cfg.protocol)
  const table = loadMergedTable()
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
  commitTable(table)
  return id
}

const updateQoderProvider = (id, updates) => {
  const table = loadMergedTable()
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
  if (newId !== id) delete table[id]
  table[newId] = buildProviderJson(merged)
  commitTable(table)
  return true
}

const deleteQoderProvider = (id) => {
  const table = loadMergedTable()
  if (!table[id]) throw new Error(`Provider ${id} 不存在`)
  delete table[id]
  commitTable(table)
  return true
}

// ==================== Models（providers.<id>.models[]） ====================

const addQoderModel = (providerId, cfg) => {
  const modelId = String(cfg?.model || '').trim()
  if (!modelId) throw new Error('模型 ID 不能为空')
  if (!MODEL_ID_RE.test(modelId)) throw new Error('模型 ID 只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  const table = loadMergedTable()
  const provider = table[providerId]
  if (!provider) throw new Error(`Provider ${providerId} 不存在`)
  if (!Array.isArray(provider.models)) provider.models = []
  if (provider.models.some((m) => modelIdOf(m) === modelId)) throw new Error(`模型 ${modelId} 已存在`)
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
  commitTable(table)
  return true
}

const updateQoderModel = (providerId, modelId, updates) => {
  const table = loadMergedTable()
  const provider = table[providerId]
  if (!provider) throw new Error(`Provider ${providerId} 不存在`)
  if (!Array.isArray(provider.models)) provider.models = []
  const idx = provider.models.findIndex((m) => modelIdOf(m) === modelId)
  if (idx === -1) throw new Error(`模型 ${modelId} 不存在`)
  const newId = updates.model === undefined || updates.model === modelId ? modelId : String(updates.model).trim()
  if (!newId) throw new Error('模型 ID 不能为空')
  if (!MODEL_ID_RE.test(newId)) throw new Error('模型 ID 只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  if (newId !== modelId && provider.models.some((m) => modelIdOf(m) === newId)) {
    throw new Error(`模型 ${newId} 已存在`)
  }
  const prev = normalizeModel(provider.models[idx])
  provider.models[idx] = buildModelJson({ ...prev, ...updates, model: newId })
  // 改名同步默认模型引用
  if (newId !== modelId && provider.model === modelId) provider.model = newId
  commitTable(table)
  return true
}

const deleteQoderModel = (providerId, modelId) => {
  const table = loadMergedTable()
  const provider = table[providerId]
  if (!provider || !Array.isArray(provider.models)) return true
  const before = provider.models.length
  provider.models = provider.models.filter((m) => modelIdOf(m) !== modelId)
  if (provider.models.length === before) return true
  // 清理悬挂的默认模型引用
  if (provider.model === modelId) {
    provider.model = provider.models.length ? provider.models[0].model : ''
    if (!provider.model) delete provider.model
  }
  commitTable(table)
  return true
}

// 默认模型 = provider 顶层 model 字段
const getQoderDefaultModel = (providerId) => (tableProvider(providerId) || {}).model || ''

const tableProvider = (providerId) => {
  const table = loadMergedTable()
  return table[providerId] || null
}

const setQoderDefaultModel = (providerId, modelId) => {
  const table = loadMergedTable()
  const provider = table[providerId]
  if (!provider) throw new Error(`Provider ${providerId} 不存在`)
  const models = Array.isArray(provider.models) ? provider.models : []
  if (modelId && !models.some((m) => modelIdOf(m) === modelId)) {
    throw new Error(`模型 ${modelId} 不存在，无法设为默认`)
  }
  if (modelId) provider.model = modelId
  else delete provider.model
  commitTable(table)
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
  const table = loadMergedTable()
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
  commitTable(table)
  return true
}

// 模型已存在时只刷新传入的受管字段（displayName/上下文/输出上限，未传的保留既有值），不存在则新建；
// 返回默认模型可引用的模型 ID
const upsertQoderModel = (providerId, modelId, opts = {}) => {
  const id = String(modelId || '').trim()
  if (!MODEL_ID_RE.test(id)) throw new Error(`模型 ID ${id} 含非法字符，无法下发到 Qoder`)
  const table = loadMergedTable()
  const provider = table[providerId]
  if (!provider) throw new Error(`Provider ${providerId} 不存在`)
  if (!Array.isArray(provider.models)) provider.models = []
  const prevEntry = provider.models.find((m) => modelIdOf(m) === id)
  const merged = prevEntry ? normalizeModel(prevEntry) : { model: id, _raw: {} }
  if (opts.name) merged.displayName = String(opts.name).trim()
  if (Number(opts.contextWindow) > 0) merged.contextWindow = Number(opts.contextWindow)
  if (Number(opts.maxOutputTokens) > 0) merged.maxOutputTokens = Number(opts.maxOutputTokens)
  const entry = buildModelJson(merged)
  if (prevEntry) provider.models[provider.models.indexOf(prevEntry)] = entry
  else provider.models.push(entry)
  // 供应商尚无默认模型时自动指向首个模型（与 addQoderModel 语义一致）
  if (!provider.model) provider.model = id
  commitTable(table)
  return id
}

// ==================== 目录操作 ====================

const openQoderDir = (editionId) => {
  const ed = editionOf(editionId) || EDITIONS[0]
  const dir = editionHome(ed)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const isQoderInstalled = () => EDITIONS.some((ed) => fs.existsSync(editionHome(ed)))

// 任一版本配过自定义供应商即视为有数据（detectAgentsConfig 用，不创建目录）
const hasQoderProviders = () =>
  EDITIONS.some((ed) => {
    try {
      const doc = readEditionDoc(ed)
      return !!(doc && Object.keys(doc.providers || {}).length)
    } catch {
      return false
    }
  })

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
  EDITIONS,
  getQoderEditionStatus, getQoderSyncState, hasQoderProviders,
  getQoderProviderList, addQoderProvider, updateQoderProvider, deleteQoderProvider,
  upsertQoderProvider, providerKeyFor,
  addQoderModel, updateQoderModel, deleteQoderModel, upsertQoderModel,
  getQoderDefaultModel, setQoderDefaultModel,
  openQoderDir, isQoderInstalled,
  PROTOCOL_VALUES, EFFORT_VALUES, PROVIDER_ID_RE,
}
