const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// ZCode（Z.ai 桌面客户端）自定义模型配置：~/.zcode/v2/provider_config.json
// {
//   "schemaVersion": 1,
//   "config": {
//     "providerOrder": ["<providerId>", ...],                       // 选择器里的供应商顺序
//     "providerConfigRules": {
//       "providerRules": [ {
//         "providerId": "...", "providerName": "...",
//         "config": {
//           "group": "standard-personal",
//           "access": { "type": "api-key", "apiKey": "..." },       // type 另有 zhipu-coding-plan-api-key
//           "api": { "type": "anthropic-messages", "baseUrl": "..." }, // 另有 openai-chat-completions / openai-responses
//           "personalModelIds": ["..."], "modelOrder": ["..."]
//         } } ]
//     },
//     "modelConfigRules": {
//       "providerModelRules": [ {
//         "providerId": "...", "modelId": "...",
//         "config": {
//           "enabled": true,
//           "properties": {                                         // 全部可选（partial，strict 校验）
//             "contextWindow": 1000000,
//             "inputFormat": { "supportsImage": true, "supportsVideo": true, "supportsPdf": true },
//             "supportsJsonSchemaOutput": true,
//             "supportsNativeWebSearch": true,
//             "supportsMidConversationSystem": true
//           },
//           "optionSpecs": {                                        // 思考等级 + 最大输出
//             "reasoningLevel": { "values": ["low", "high", "max", "xhigh"] },
//             "maxOutputTokens": { "max": 12800 }
//           }
//         } } ],
//       "manualProviderModelRules": []
//     }
//   }
// }
// 字段名与 ZCode 客户端 zod schema 一致（properties/optionSpecs 为 strict partial，未知键会校验失败，
// 因此受管键之外的原有键按层级收进 _extra 原样往返，且绝不新增未知键）。
// ZCode 对该文件有变更监听，写后即生效无需重启。
// 首选模型语义：providerOrder 首个供应商 + 其 modelOrder 首个模型（ZCode 选择器的排序基准）。
// providerId 生成沿用 ZCode 规则：名称 trim → 小写 → 非 [a-z0-9] 转 - → 去首尾 -（兜底 new-provider），冲突加 -2/-3。

const CONFIG_PATH = () => path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json')
const CONFIG_DIR = () => path.join(os.homedir(), '.zcode')

// 使用统计库（ZCode CLI 会话数据，WAL 模式，只读打开不阻塞其写入）
const ZCODE_USAGE_DB_PATH = () => path.join(CONFIG_DIR(), 'cli', 'db', 'db.sqlite')
// 单条模型请求 = 一行；LEFT JOIN session 补项目目录（统计页不展示目录，仅会话 map 兜底）
const ZCODE_USAGE_SQL = `
  SELECT mu.session_id, mu.started_at, mu.model_id,
         mu.input_tokens, mu.output_tokens,
         mu.cache_read_input_tokens, mu.cache_creation_input_tokens,
         s.directory, s.title
  FROM model_usage mu
  LEFT JOIN session s ON s.id = mu.session_id
  WHERE mu.status = 'completed'
  ORDER BY mu.started_at ASC`

// 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会用
// 空对象覆盖整个文件，抹掉全部供应商与模型配置（同 qoder/kimi/minimax 纪律）
const readDoc = () => {
  const p = CONFIG_PATH()
  if (!fs.existsSync(p)) return null
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${p} 解析失败，已阻止修改（请先在 ZCode 中修复 JSON 语法）: ${e.message}`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${p} 顶层不是 JSON 对象，已阻止修改`)
  }
  return doc
}

const writeDoc = (doc) => {
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true })
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(doc, null, 2), { encoding: 'utf-8' })
  return true
}

const emptyDoc = () => ({
  schemaVersion: 1,
  config: {
    providerOrder: [],
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
})

const readOrCreate = () => readDoc() || emptyDoc()

// 取（或补齐）config 节：providerOrder / providerRules / providerModelRules 数组懒创建；
// config 及其下未知键原地保留，实现整档未知字段往返
const configOf = (doc) => {
  if (!doc.config || typeof doc.config !== 'object' || Array.isArray(doc.config)) doc.config = {}
  const cfg = doc.config
  if (!cfg.providerConfigRules || typeof cfg.providerConfigRules !== 'object' || Array.isArray(cfg.providerConfigRules)) {
    cfg.providerConfigRules = {}
  }
  if (!Array.isArray(cfg.providerConfigRules.providerRules)) cfg.providerConfigRules.providerRules = []
  if (!cfg.modelConfigRules || typeof cfg.modelConfigRules !== 'object' || Array.isArray(cfg.modelConfigRules)) {
    cfg.modelConfigRules = {}
  }
  if (!Array.isArray(cfg.modelConfigRules.providerModelRules)) cfg.modelConfigRules.providerModelRules = []
  if (!Array.isArray(cfg.providerOrder)) cfg.providerOrder = []
  return cfg
}

// ==================== 枚举约定 ====================

// api.type / access.type（与 ZCode zod enum 一致）
const ZCODE_API_TYPES = ['anthropic-messages', 'openai-chat-completions', 'openai-responses']
const ZCODE_ACCESS_TYPES = ['api-key', 'zhipu-coding-plan-api-key']

const assertApiType = (t) => {
  if (t && !ZCODE_API_TYPES.includes(t)) {
    throw new Error(`不支持的 API 协议 ${t}（可选：${ZCODE_API_TYPES.join(' / ')}）`)
  }
}

// ==================== 归一化 / 构建 ====================

// 受管字段之外的键按层级收进 _extra 原样往返（group/logo/apiKeyManagementUrl/builtinModelIds 等）
const splitExtra = (obj, managed) => {
  const extra = {}
  for (const k of Object.keys(obj || {})) {
    if (!managed.includes(k)) extra[k] = obj[k]
  }
  return extra
}

const findModelRule = (modelRules, providerId, modelId) =>
  (modelRules || []).find((r) => r && r.providerId === providerId && r.modelId === modelId) || null

// 归一化单个模型的 UI 结构：默认值随 ZCode（enabled 默认开，未声明的属性视为关）
const normalizeModel = (modelRules, providerId, modelId, orderIdx) => {
  const rule = findModelRule(modelRules, providerId, modelId)
  const cfg = (rule && typeof rule.config === 'object' && rule.config) || {}
  const props = (cfg.properties && typeof cfg.properties === 'object' && cfg.properties) || {}
  const specs = (cfg.optionSpecs && typeof cfg.optionSpecs === 'object' && cfg.optionSpecs) || {}
  const inputFormat = (props.inputFormat && typeof props.inputFormat === 'object' && props.inputFormat) || {}
  const reasoning = (specs.reasoningLevel && typeof specs.reasoningLevel === 'object' && specs.reasoningLevel) || {}
  const maxOut = (specs.maxOutputTokens && typeof specs.maxOutputTokens === 'object' && specs.maxOutputTokens) || {}
  return {
    modelId,
    enabled: cfg.enabled !== false,
    contextWindow: Number(props.contextWindow) || 0,
    maxOutputTokens: Number(maxOut.max) || 0,
    image: inputFormat.supportsImage === true,
    video: inputFormat.supportsVideo === true,
    audio: inputFormat.supportsAudio === true,
    pdf: inputFormat.supportsPdf === true,
    jsonSchema: props.supportsJsonSchemaOutput === true,
    webSearch: props.supportsNativeWebSearch === true,
    midSystem: props.supportsMidConversationSystem === true,
    reasoningLevels: Array.isArray(reasoning.values)
      ? reasoning.values.filter((v) => typeof v === 'string' && v.trim())
      : [],
    orderIdx,
    _extra: {
      propsExtra: splitExtra(props, ['contextWindow', 'inputFormat', 'supportsJsonSchemaOutput', 'supportsNativeWebSearch', 'supportsMidConversationSystem']),
      inputExtra: splitExtra(inputFormat, ['supportsImage', 'supportsVideo', 'supportsAudio', 'supportsPdf']),
      specsExtra: splitExtra(specs, ['reasoningLevel', 'maxOutputTokens']),
      ruleExtra: splitExtra(rule, ['providerId', 'modelId', 'config']),
    },
  }
}

// 归一化一条 providerRules 条目供 UI 消费；展示顺序 = modelOrder 优先（选择器顺序），
// personalModelIds 中未入序的追加在后
const normalizeProvider = (rule, modelRules, orderIdx) => {
  const cfg = (rule && typeof rule.config === 'object' && rule.config) || {}
  const access = (cfg.access && typeof cfg.access === 'object' && cfg.access) || {}
  const api = (cfg.api && typeof cfg.api === 'object' && cfg.api) || {}
  const personalIds = Array.isArray(cfg.personalModelIds) ? cfg.personalModelIds : []
  const order = Array.isArray(cfg.modelOrder) ? cfg.modelOrder : []
  const ids = [...order, ...personalIds.filter((id) => !order.includes(id))]
  return {
    id: (rule && rule.providerId) || '',
    name: (rule && rule.providerName) || '',
    accessType: access.type || 'api-key',
    apiKey: access.apiKey || '',
    apiType: api.type || 'anthropic-messages',
    baseUrl: api.baseUrl || '',
    models: ids.map((mid, idx) => normalizeModel(modelRules, rule.providerId, mid, idx)),
    orderIdx,
    _extra: {
      cfgExtra: splitExtra(cfg, ['access', 'api', 'personalModelIds', 'modelOrder']),
      accessExtra: splitExtra(access, ['type', 'apiKey']),
      apiExtra: splitExtra(api, ['type', 'baseUrl']),
      ruleExtra: splitExtra(rule, ['providerId', 'providerName', 'config']),
    },
  }
}

// 由 UI 结构构建 modelConfigRules.providerModelRules[].config（_extra 非受管键原样保留）
const buildModelRuleConfig = (m) => {
  const cfg = { enabled: m.enabled !== false }
  const props = { ...((m._extra && m._extra.propsExtra) || {}) }
  if (Number(m.contextWindow) > 0) props.contextWindow = Number(m.contextWindow)
  else delete props.contextWindow
  const input = { ...((m._extra && m._extra.inputExtra) || {}) }
  if (m.image) input.supportsImage = true
  else delete input.supportsImage
  if (m.video) input.supportsVideo = true
  else delete input.supportsVideo
  if (m.audio) input.supportsAudio = true
  else delete input.supportsAudio
  if (m.pdf) input.supportsPdf = true
  else delete input.supportsPdf
  if (Object.keys(input).length) props.inputFormat = input
  else delete props.inputFormat
  if (m.jsonSchema) props.supportsJsonSchemaOutput = true
  else delete props.supportsJsonSchemaOutput
  if (m.webSearch) props.supportsNativeWebSearch = true
  else delete props.supportsNativeWebSearch
  if (m.midSystem) props.supportsMidConversationSystem = true
  else delete props.supportsMidConversationSystem
  if (Object.keys(props).length) cfg.properties = props
  const specs = { ...((m._extra && m._extra.specsExtra) || {}) }
  const levels = [...new Set((m.reasoningLevels || []).map((v) => String(v).trim()).filter(Boolean))]
  if (levels.length) specs.reasoningLevel = { values: levels }
  else delete specs.reasoningLevel
  if (Number(m.maxOutputTokens) > 0) specs.maxOutputTokens = { max: Number(m.maxOutputTokens) }
  else delete specs.maxOutputTokens
  if (Object.keys(specs).length) cfg.optionSpecs = specs
  return cfg
}

// 由归一化 provider 构建整条 providerRules 条目（personalModelIds 与 modelOrder 同步为同一顺序）
const buildProviderRule = (p) => {
  const cfg = { ...((p._extra && p._extra.cfgExtra) || {}) }
  cfg.access = { ...((p._extra && p._extra.accessExtra) || {}), type: p.accessType || 'api-key' }
  if (p.apiKey) cfg.access.apiKey = p.apiKey
  else delete cfg.access.apiKey
  cfg.api = { ...((p._extra && p._extra.apiExtra) || {}), type: p.apiType || 'anthropic-messages', baseUrl: p.baseUrl || '' }
  const ids = (p.models || []).map((m) => m.modelId)
  cfg.personalModelIds = ids
  cfg.modelOrder = ids
  return {
    ...((p._extra && p._extra.ruleExtra) || {}),
    providerId: p.id,
    providerName: p.name || '',
    config: cfg,
  }
}

// ==================== 读表 / 写表 ====================

const loadTable = () => {
  const doc = readDoc()
  if (!doc) return { cfg: null, providers: [] }
  const cfg = configOf(doc)
  const rules = cfg.providerConfigRules.providerRules
  const modelRules = cfg.modelConfigRules.providerModelRules
  // providerOrder 为准排序，未入序的规则按文件顺序排在其后
  const order = cfg.providerOrder
  const sorted = [...rules].sort((a, b) => {
    const pos = (r) => {
      const i = order.indexOf(r && r.providerId)
      return i === -1 ? rules.length : i
    }
    return pos(a) - pos(b)
  })
  const providers = sorted.map((rule, idx) => normalizeProvider(rule, modelRules, idx))
  return { cfg, doc, providers }
}

const findProviderRule = (cfg, id) =>
  cfg.providerConfigRules.providerRules.find((r) => r && r.providerId === id) || null

const commit = (doc) => writeDoc(doc)

// ==================== Providers ====================

const getZcodeProviderList = () => loadTable().providers

// 沿用 ZCode 的 providerId 生成规则（名称清洗 + 冲突加序号）
const slugifyProviderName = (name) =>
  String(name || '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new-provider'

const generateProviderId = (name, existingIds) => {
  const base = slugifyProviderName(name)
  if (!existingIds.has(base)) return base
  for (let i = 2; ; i += 1) {
    const s = `${base}-${i}`
    if (!existingIds.has(s)) return s
  }
}

const addZcodeProvider = (p) => {
  const name = String(p?.name || '').trim()
  if (!name) throw new Error('供应商名称不能为空')
  assertApiType(p.apiType)
  const doc = readOrCreate()
  const cfg = configOf(doc)
  const rules = cfg.providerConfigRules.providerRules
  const id = generateProviderId(name, new Set(rules.map((r) => r && r.providerId)))
  rules.push(buildProviderRule({
    id,
    name,
    accessType: p.accessType || 'api-key',
    apiKey: String(p.apiKey || '').trim(),
    apiType: p.apiType || 'anthropic-messages',
    baseUrl: String(p.baseUrl || '').trim(),
    models: [],
    _extra: { cfgExtra: { group: 'standard-personal' } },
  }))
  if (!cfg.providerOrder.includes(id)) cfg.providerOrder.push(id)
  commit(doc)
  return id
}

const updateZcodeProvider = (id, updates) => {
  const doc = readOrCreate()
  const cfg = configOf(doc)
  const rule = findProviderRule(cfg, id)
  if (!rule) throw new Error(`Provider ${id} 不存在`)
  assertApiType(updates.apiType)
  if (updates.name !== undefined && !String(updates.name).trim()) throw new Error('供应商名称不能为空')
  const norm = normalizeProvider(rule, cfg.modelConfigRules.providerModelRules, 0)
  const merged = {
    ...norm,
    ...updates,
    apiKey: updates.clearApiKey ? '' : String(updates.apiKey !== undefined ? updates.apiKey : norm.apiKey).trim(),
    id, // ID 不随编辑变化（ZCode 中改名也保留原 ID）
    models: norm.models, // 供应商编辑不动模型
  }
  const next = buildProviderRule(merged)
  cfg.providerConfigRules.providerRules[cfg.providerConfigRules.providerRules.indexOf(rule)] = next
  commit(doc)
  return true
}

const deleteZcodeProvider = (id) => {
  const doc = readDoc()
  if (!doc) return true
  const cfg = configOf(doc)
  const rules = cfg.providerConfigRules.providerRules
  const idx = rules.findIndex((r) => r && r.providerId === id)
  if (idx === -1) return true // 幂等：可能刚在 ZCode 内被删除
  rules.splice(idx, 1)
  // 级联清理：模型规则、选择器顺序
  cfg.modelConfigRules.providerModelRules = cfg.modelConfigRules.providerModelRules.filter(
    (r) => !(r && r.providerId === id),
  )
  cfg.providerOrder = cfg.providerOrder.filter((pid) => pid !== id)
  commit(doc)
  return true
}

// ==================== Models ====================

const orderArraysOf = (rule) => {
  const c = rule.config || {}
  if (!Array.isArray(c.personalModelIds)) c.personalModelIds = []
  if (!Array.isArray(c.modelOrder)) c.modelOrder = []
  return { personalIds: c.personalModelIds, order: c.modelOrder }
}

const addZcodeModel = (providerId, m) => {
  const modelId = String(m?.modelId || '').trim()
  if (!modelId) throw new Error('模型 ID 不能为空')
  const doc = readOrCreate()
  const cfg = configOf(doc)
  const rule = findProviderRule(cfg, providerId)
  if (!rule) throw new Error(`Provider ${providerId} 不存在`)
  const { personalIds, order } = orderArraysOf(rule)
  if (personalIds.includes(modelId) || order.includes(modelId)) {
    throw new Error(`模型 ${modelId} 已存在`)
  }
  personalIds.push(modelId)
  order.push(modelId)
  cfg.modelConfigRules.providerModelRules.push({
    providerId,
    modelId,
    config: buildModelRuleConfig(m),
  })
  commit(doc)
  return true
}

const updateZcodeModel = (providerId, modelId, updates) => {
  const doc = readOrCreate()
  const cfg = configOf(doc)
  const rule = findProviderRule(cfg, providerId)
  if (!rule) throw new Error(`Provider ${providerId} 不存在`)
  const { personalIds, order } = orderArraysOf(rule)
  if (!personalIds.includes(modelId) && !order.includes(modelId)) {
    throw new Error(`模型 ${modelId} 不存在`)
  }
  const newId = updates.modelId === undefined || updates.modelId === modelId
    ? modelId
    : String(updates.modelId).trim()
  if (!newId) throw new Error('模型 ID 不能为空')
  if (newId !== modelId && (personalIds.includes(newId) || order.includes(newId))) {
    throw new Error(`模型 ${newId} 已存在`)
  }
  const modelRule = findModelRule(cfg.modelConfigRules.providerModelRules, providerId, modelId)
  const norm = normalizeModel(cfg.modelConfigRules.providerModelRules, providerId, modelId)
  const merged = { ...norm, ...updates, modelId: newId }
  const nextConfig = buildModelRuleConfig(merged)
  if (modelRule) modelRule.config = nextConfig
  else cfg.modelConfigRules.providerModelRules.push({ providerId, modelId: newId, config: nextConfig })
  // 规则键与两个顺序表同步改名
  if (newId !== modelId) {
    if (modelRule) modelRule.modelId = newId
    const rename = (arr) => {
      const i = arr.indexOf(modelId)
      if (i !== -1) arr[i] = newId
    }
    rename(personalIds)
    rename(order)
  }
  commit(doc)
  return true
}

const deleteZcodeModel = (providerId, modelId) => {
  const doc = readDoc()
  if (!doc) return true
  const cfg = configOf(doc)
  const rule = findProviderRule(cfg, providerId)
  if (!rule) return true // 幂等
  const { personalIds, order } = orderArraysOf(rule)
  let changed = false
  const prune = (arr) => {
    const next = arr.filter((x) => x !== modelId)
    if (next.length !== arr.length) { arr.length = 0; arr.push(...next); changed = true }
  }
  prune(personalIds)
  prune(order)
  const mRules = cfg.modelConfigRules.providerModelRules
  const mIdx = mRules.findIndex((r) => r && r.providerId === providerId && r.modelId === modelId)
  if (mIdx !== -1) { mRules.splice(mIdx, 1); changed = true }
  if (changed) commit(doc)
  return true
}

// ==================== 首选模型（providerOrder / modelOrder 置顶） ====================

const getZcodeDefaultModel = () => {
  const { cfg } = loadTable()
  if (!cfg) return null
  const pid = cfg.providerOrder[0]
  if (!pid) return null
  const rule = findProviderRule(cfg, pid)
  const order = rule && Array.isArray(rule.config && rule.config.modelOrder) ? rule.config.modelOrder : []
  return { providerId: pid, modelId: order[0] || null }
}

const setZcodeDefaultModel = (providerId, modelId) => {
  const doc = readOrCreate()
  const cfg = configOf(doc)
  const rule = findProviderRule(cfg, providerId)
  if (!rule) throw new Error(`Provider ${providerId} 不存在`)
  const { personalIds, order } = orderArraysOf(rule)
  if (modelId && !personalIds.includes(modelId) && !order.includes(modelId)) {
    throw new Error(`模型 ${modelId} 不存在，无法设为首选`)
  }
  // 供应商提到 providerOrder 最前，模型提到该供应商 modelOrder 最前（选择器排序基准）
  cfg.providerOrder = [providerId, ...cfg.providerOrder.filter((x) => x !== providerId)]
  if (modelId) {
    const next = order.filter((x) => x !== modelId)
    next.unshift(modelId)
    rule.config.modelOrder = next
  }
  commit(doc)
  return true
}

// ==================== 下发用 upsert（dispatch.js 调用，语义同 qoder.upsert*） ====================

// 通用库供应商名可能是中文/任意符号，而 ZCode providerId 只由小写字母/数字/中划线构成，
// 需确定性清洗（同一下发名永远得到同一 ID → upsert 幂等）：合法名原样用；
// 否则取 ASCII 骨架 + 原名稳定哈希防碰撞（纯中文名直接 slugify 会都落到 new-provider 互相覆盖）
const PROVIDER_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const hashName = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
const providerIdFor = (name) => {
  const raw = String(name || '').trim()
  if (PROVIDER_ID_RE.test(raw)) return raw
  const base = raw.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'provider'
  return `${base}-${hashName(raw)}`
}

// 存在则合并更新（空值不覆盖既有 name/apiType/baseUrl/apiKey），否则创建
//（group 与 ZCode 原生个人供应商一致 standard-personal，并追加进 providerOrder 尾部）
const upsertZcodeProvider = (id, cfg) => {
  const pid = String(id || '').trim()
  if (!pid) throw new Error('Provider ID 不能为空')
  assertApiType(cfg.apiType)
  const doc = readOrCreate()
  const cfgNode = configOf(doc)
  const rules = cfgNode.providerConfigRules.providerRules
  const rule = findProviderRule(cfgNode, pid)
  if (rule) {
    const norm = normalizeProvider(rule, cfgNode.modelConfigRules.providerModelRules, 0)
    const merged = {
      ...norm,
      name: String(cfg.name || '').trim() || norm.name,
      apiType: cfg.apiType || norm.apiType,
      baseUrl: String(cfg.baseUrl || '').trim() || norm.baseUrl,
      apiKey: String(cfg.apiKey || '').trim() || norm.apiKey,
      id: pid,
      models: norm.models, // 供应商 upsert 不动模型
    }
    rules[rules.indexOf(rule)] = buildProviderRule(merged)
  } else {
    rules.push(buildProviderRule({
      id: pid,
      name: String(cfg.name || '').trim(),
      accessType: 'api-key',
      apiKey: String(cfg.apiKey || '').trim(),
      apiType: cfg.apiType || 'anthropic-messages',
      baseUrl: String(cfg.baseUrl || '').trim(),
      models: [],
      _extra: { cfgExtra: { group: 'standard-personal' } },
    }))
    if (!cfgNode.providerOrder.includes(pid)) cfgNode.providerOrder.push(pid)
  }
  commit(doc)
  return true
}

// 模型已存在时只刷新传入的受管字段（上下文/最大输出/输入模态，未传或为假保留既有值），不存在则新建；
// 追加进 personalModelIds 与 modelOrder 尾部（不打乱既有顺序）；返回模型 ID
const upsertZcodeModel = (providerId, modelId, opts = {}) => {
  const id = String(modelId || '').trim()
  if (!id) throw new Error('模型 ID 不能为空')
  const doc = readOrCreate()
  const cfg = configOf(doc)
  const rule = findProviderRule(cfg, providerId)
  if (!rule) throw new Error(`Provider ${providerId} 不存在`)
  const { personalIds, order } = orderArraysOf(rule)
  const modelRule = findModelRule(cfg.modelConfigRules.providerModelRules, providerId, id)
  const merged = modelRule
    ? normalizeModel(cfg.modelConfigRules.providerModelRules, providerId, id)
    : {
        modelId: id, enabled: true, contextWindow: 0, maxOutputTokens: 0,
        image: false, video: false, audio: false, pdf: false,
        jsonSchema: false, webSearch: false, midSystem: false,
        reasoningLevels: [], _extra: {},
      }
  if (Number(opts.contextWindow) > 0) merged.contextWindow = Number(opts.contextWindow)
  if (Number(opts.maxOutputTokens) > 0) merged.maxOutputTokens = Number(opts.maxOutputTokens)
  if (opts.image === true) merged.image = true
  if (opts.video === true) merged.video = true
  if (opts.audio === true) merged.audio = true
  if (opts.pdf === true) merged.pdf = true
  const nextConfig = buildModelRuleConfig(merged)
  if (modelRule) modelRule.config = nextConfig
  else cfg.modelConfigRules.providerModelRules.push({ providerId, modelId: id, config: nextConfig })
  if (!personalIds.includes(id)) personalIds.push(id)
  if (!order.includes(id)) order.push(id)
  commit(doc)
  return id
}

// ==================== 使用统计 ====================
// 数据源：~/.zcode/cli/db/db.sqlite（SQLite，WAL 模式）的 model_usage 表 —— ZCode 设置页
// 「使用统计」同源。每次模型请求一行（completed / error / cancelled），字段即 token 口径：
//   input_tokens 已含缓存（>= cache_read + cache_creation），computed_total_tokens = input + output
// 口径与 Claude / OpenCode / Pi / DSH 统计页一致：输入（含缓存）= input_tokens，输出 = output_tokens，
// total = input + output（即 computed_total_tokens；reasoning 已含在 output 内）。
// 未缓存输入 = input - cache_read - cache_creation，写进 day.models[].inputTokens（UsagePage 重算会再叠加缓存）。
// 模型名只取 model_id（不带 provider 前缀，同 ZCode 设置页口径）。
// 只读打开（readOnly + WAL 快照），ZCode 持续写入互不阻塞；库不存在 / 表不存在返回空统计。
// 模型名只取 model_id（不带 provider 前缀，同 ZCode 设置页口径）。
// 历史落库：每日聚合落 ccswitch_agent_usage_zcode_<nativeId>（usage.js），同一天取较大值合并——
// db 被清理或换机后历史不缩水，库整个没了就直接回放历史档。

// status='completed' 才计用量（cancelled 行全 0，error 行无完成用量）
const readZcodeUsageRaw = () => {
  const usage = require('./usage')
  const dbPath = ZCODE_USAGE_DB_PATH()
  if (!fs.existsSync(dbPath)) return usage.calculateStats([], new Map())

  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch {
    DatabaseSync = null
  }
  if (!DatabaseSync) {
    // uTools 8（Electron 34 / Node 20）无 node:sqlite，回退子进程（同 opencode.js 先例）
    try {
      return readZcodeUsageViaChildProcess(dbPath)
    } catch (e) {
      console.warn('[zcode] 子进程读取也失败:', e.message)
      return usage.calculateStats([], new Map())
    }
  }

  try {
    return readZcodeUsageNative(dbPath, DatabaseSync)
  } catch (e) {
    console.warn('[zcode] node:sqlite 读取失败，回退子进程方式:', e.message)
    try {
      return readZcodeUsageViaChildProcess(dbPath)
    } catch (e2) {
      console.warn('[zcode] 子进程读取也失败:', e2.message)
      return usage.calculateStats([], new Map())
    }
  }
}

const readZcodeUsageNative = (dbPath, DatabaseSync) => {
  const usage = require('./usage')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    if (!tables.includes('model_usage')) return usage.calculateStats([], new Map())
    return buildZcodeStats(db.prepare(ZCODE_USAGE_SQL).all())
  } finally {
    db.close()
  }
}

// 供子进程回退使用的 node 二进制：uTools 是 GUI 应用，macOS launchd 默认 PATH 只有
// /usr/bin:/bin:/usr/sbin:/sbin，不含 /usr/local/bin 与 /opt/homebrew/bin ——
// execFileSync('node') 会 ENOENT（且 preload 的 console.warn 渲染层看不到，静默变空统计）。
// 逐个探测常见安装位置（macOS + Windows），命中且版本达标即缓存。
const CHILD_NODE_CANDIDATES = [
  'node', // PATH 里有（开发终端启动 uTools 的场景；Windows GUI 进程通常能拿到完整 PATH）
  '/usr/local/bin/node', // macOS 官方 pkg 安装 / Intel Homebrew
  '/opt/homebrew/bin/node', // Apple Silicon Homebrew
  '/usr/local/opt/node/bin/node', // Intel Homebrew 别名
  'C:\\Program Files\\nodejs\\node.exe', // Windows 官方安装包（nvm-windows 符号链接默认也指向这里）
]

// node:sqlite 需 >= 22.5：低版本即使探测到，--experimental-sqlite 也会 bad option，直接当未找到
const nodeSupportsSqlite = (version) => {
  const m = /^v(\d+)\.(\d+)\./.exec(String(version).trim())
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 22 || (major === 22 && minor >= 5)
}

let childNodeBin
const findChildNode = () => {
  if (childNodeBin !== undefined) return childNodeBin
  const { execFileSync } = require('node:child_process')
  for (const bin of CHILD_NODE_CANDIDATES) {
    try {
      const v = execFileSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5_000 }).trim()
      if (nodeSupportsSqlite(v)) {
        childNodeBin = bin
        console.log(`[zcode] 子进程回退使用 node: ${bin} (${v})`)
        return childNodeBin
      }
      console.warn(`[zcode] 跳过 ${bin}: ${v} 无 node:sqlite（需 >= 22.5）`)
    } catch {
      /* 试下一个 */
    }
  }
  childNodeBin = null
  return childNodeBin
}

const readZcodeUsageViaChildProcess = (dbPath) => {
  const usage = require('./usage')
  const nodeBin = findChildNode()
  if (!nodeBin) {
    throw new Error('未找到可用的 node（>= 22.5）子进程：常见安装位置与 PATH 均探测失败（无 node 或版本过低）')
  }
  const { execFileSync } = require('node:child_process')
  const tmpScript = path.join(os.tmpdir(), 'zcode_usage_reader.js')
  fs.writeFileSync(tmpScript, `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    if (!tables.includes('model_usage')) { process.stdout.write('[]'); process.exit(0); }
    const rows = db.prepare(${JSON.stringify(ZCODE_USAGE_SQL)}).all();
    db.close();
    process.stdout.write(JSON.stringify(rows));
  `)
  // 必须用系统 node 子进程：uTools preload 里 process.execPath 是 uTools 的 Electron 二进制，
  // Electron 拒绝 --experimental-sqlite（bad option）且其 Node 20 无 node:sqlite
  try {
    const stdout = execFileSync(nodeBin, ['--experimental-sqlite', tmpScript], {
      encoding: 'utf-8',
      timeout: 15_000,
    })
    let rows = []
    try { rows = JSON.parse(stdout) } catch { rows = [] }
    return buildZcodeStats(rows)
  } finally {
    try { fs.unlinkSync(tmpScript) } catch { /* ignore */ }
  }
}

const buildZcodeStats = (rows) => {
  const usage = require('./usage')
  const sessionMap = new Map()
  const messageRecords = []
  for (const r of rows) {
    if (!r.started_at || r.started_at <= 0) continue
    const ts = new Date(r.started_at).toISOString()
    const input = r.input_tokens || 0
    const output = r.output_tokens || 0
    const total = input + output
    if (total === 0) continue
    // 模型只保留模型名（同 ZCode 设置页口径）；provider_id 形如 provider-xxx / account:yyy，
    // 同名模型跨供应商的用量会合并展示
    const model = String(r.model_id || 'unknown').trim() || 'unknown'
    if (!sessionMap.has(r.session_id)) {
      sessionMap.set(r.session_id, {
        sessionId: r.session_id,
        timestamp: ts,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        project: r.directory || 'unknown',
        projectPath: r.directory || 'unknown',
        title: r.title || '',
        model,
      })
    }
    messageRecords.push({
      sessionId: r.session_id,
      model,
      project: r.directory || 'unknown',
      projectPath: r.directory || 'unknown',
      timestamp: ts,
      date: ts.split('T')[0],
      // calculateStats 的 modelStats/inputTokens 走未缓存输入，含缓存口径在 aggregate 阶段重算（同 dsh-usage）
      inputTokens: input - (r.cache_read_input_tokens || 0) - (r.cache_creation_input_tokens || 0),
      outputTokens: output,
      cacheReadTokens: r.cache_read_input_tokens || 0,
      cacheCreationTokens: r.cache_creation_input_tokens || 0,
      totalTokens: total,
    })
    const sess = sessionMap.get(r.session_id)
    sess.inputTokens += input
    sess.outputTokens += output
    sess.cacheReadTokens += r.cache_read_input_tokens || 0
    sess.cacheCreationTokens += r.cache_creation_input_tokens || 0
    if (ts > sess.timestamp) sess.timestamp = ts
  }
  return usage.calculateStats(messageRecords, sessionMap)
}

// calculateStats 写入的 day.inputTokens 是未缓存输入，这里改写成含缓存输入
// （day.inputTokens = tokens - outputTokens，UsagePage 日期筛选直接取该字段；同 dsh-usage.aggregate）。
// summary/modelStats 的含缓存口径也随之重算。messageCount 用于「请求次数」，会话数取 sessionMap。
const aggregateZcode = (stats) => {
  const usage = require('./usage')
  const contributions = stats.contributions || []
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
      const cacheRead = m.cacheReadTokens || 0
      const cacheWrite = m.cacheCreationTokens || 0
      const input = m.inputTokens || 0
      const output = m.outputTokens || 0
      mm.tokens += input + output + cacheRead + cacheWrite
      mm.inputTokens += input + cacheRead + cacheWrite
      mm.outputTokens += output
    }
  }
  const modelStats = Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens)
  return {
    summary: {
      ...stats.summary,
      totalTokens,
      inputTokens: totalTokens - outputTokens,
      outputTokens,
    },
    modelStats,
    contributions,
    avgTokensPerSession: stats.avgTokensPerSession,
    recentSessions: stats.recentSessions,
    messageRecords: stats.messageRecords,
  }
}

// 从落库历史重建统计（db 被清理 / 换机后避免历史归零）；无历史返回 null
const statsFromHistory = () => {
  const usage = require('./usage')
  const history = usage.readAgentUsage('zcode')
  const dates = Object.keys(history)
  if (dates.length === 0) return null
  const contributions = usage.fillEmptyContributions(
    dates.sort().map((date) => ({ date, ...history[date], models: stripProviderPrefix(history[date].models) })),
  )
  // messageCount=0：会话明细已不可考，仅回放每日聚合
  return aggregateZcode({ ...usage.calculateStats([], new Map()), contributions })
}

// 快速路径（统计页进页面先用）：纯读落库历史重建统计，不读 SQLite；无历史返回 null
const readZcodeUsageFromHistory = () => {
  try {
    return statsFromHistory()
  } catch (e) {
    console.error('[zcode] 读历史统计失败:', e)
    return null
  }
}

// 旧版落库的 models 键带 provider 前缀（provider-x/model），改成只存模型名后
// 历史合并会把旧名整天带回来且永不清理 —— 读历史时统一剥前缀（幂等，无 / 的键原样）
const stripProviderPrefix = (models) => {
  if (!models || typeof models !== 'object') return models
  const next = {}
  for (const [name, m] of Object.entries(models)) {
    const bare = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
    const merged = next[bare] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    for (const k of Object.keys(merged)) merged[k] += (m && m[k]) || 0
    next[bare] = merged
  }
  return next
}

// 同一天取较大值合并历史：db 被清理后，历史档里更完整的数字不被缩水覆盖（同 dsh-usage）
const mergeHistory = (contributions) => {
  const history = require('./usage').readAgentUsage('zcode')
  if (Object.keys(history).length === 0) return
  for (const day of contributions) {
    const hist = history[day.date]
    if (!hist || (hist.tokens || 0) <= (day.tokens || 0)) continue
    day.tokens = hist.tokens || 0
    day.outputTokens = hist.outputTokens || 0
    day.models = stripProviderPrefix(hist.models)
  }
}

const readZcodeUsage = () => {
  try {
    const stats = aggregateZcode(readZcodeUsageRaw())
    const contributions = stats.contributions || []
    mergeHistory(contributions)
    // 落库（「通用」统计页数据源 + 本页历史档）：全零结果由落库层跳过，不会清空历史
    try {
      require('./usage').saveAgentUsage('zcode', contributions)
    } catch (e) {
      console.error('[zcode] usage 落库失败:', e)
    }
    return { ...stats, contributions }
  } catch (e) {
    console.error('[zcode] 使用统计失败:', e)
    return require('./usage').calculateStats([], new Map())
  }
}

// ==================== 目录 / 安装检测 ====================

const openZcodeDir = () => {
  const dir = CONFIG_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const openZcodeConfigFile = () => {
  const p = CONFIG_PATH()
  if (!fs.existsSync(p)) writeDoc(emptyDoc())
  try { window.utools.shellOpenPath(p) } catch { /* ignore */ }
}

const isZcodeInstalled = () => fs.existsSync(CONFIG_DIR())

// 有自定义供应商即视为有数据（detectAgentsConfig 用，不创建文件）
const hasZcodeProviders = () => {
  try {
    const doc = readDoc()
    if (!doc) return false
    return configOf(doc).providerConfigRules.providerRules.length > 0
  } catch {
    return false
  }
}

module.exports = {
  hasZcodeProviders,
  getZcodeProviderList,
  addZcodeProvider, updateZcodeProvider, deleteZcodeProvider,
  upsertZcodeProvider, providerIdFor,
  addZcodeModel, updateZcodeModel, deleteZcodeModel, upsertZcodeModel,
  getZcodeDefaultModel, setZcodeDefaultModel,
  openZcodeDir, openZcodeConfigFile, isZcodeInstalled,
  readZcodeUsage, readZcodeUsageFromHistory, getZcodeUsageDbPath: ZCODE_USAGE_DB_PATH,
  ZCODE_API_TYPES, ZCODE_ACCESS_TYPES,
}
