const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const yaml = require('js-yaml')
const { t } = require("./i18n")

// ==================== 目录解析 ====================
// 与 omp 自身（@oh-my-pi/pi-utils/dirs.ts）逐条对齐，否则插件管理的文件和 CLI 读的
// 不是同一份：
//   configRoot = $HOME/<PI_CONFIG_DIR 或 ".omp">                    （getConfigDirName）
//   有 profile（OMP_PROFILE / PI_PROFILE）→ configRoot/profiles/<profile>
//   agentDir   = configRoot/agent，无 profile 时被 PI_CODING_AGENT_DIR 覆盖
//                （profile 优先：dirs.ts 的 `agentDirOverride = profile ? undefined : ...`）
// 另外 PI_PROFILE、OMP_PROFILE 都可能是空串（omp 自己对空串视为无 profile）。
const configRoot = () => {
  const dirName = (process.env.PI_CONFIG_DIR || '').trim() || '.omp'
  return path.join(os.homedir(), dirName)
}

const activeProfile = () => {
  const raw = (process.env.OMP_PROFILE || process.env.PI_PROFILE || '').trim()
  return raw || ''
}

const OMP_DIR = () => {
  const profile = activeProfile()
  if (profile) return path.join(configRoot(), 'profiles', profile, 'agent')
  const override = (process.env.PI_CODING_AGENT_DIR || '').trim()
  if (override) return path.resolve(override)
  return path.join(configRoot(), 'agent')
}
const OMP_CONFIG_PATH = () => path.join(OMP_DIR(), 'config.yml')
const OMP_MODELS_PATH = () => path.join(OMP_DIR(), 'models.yml')

// ==================== config.yml 读写 ====================

// 解析失败必须抛错：调用方都是「读 → 改 → 整份写回」，静默读成 {} 会把用户
// 手写的 symbolPreset / theme / display 等字段连同 API Key 一起抹掉。
const readYamlFile = (p, parseErrorMessageKey) => {
  if (!fs.existsSync(p)) return null
  let raw
  try {
    raw = fs.readFileSync(p, { encoding: 'utf-8' })
  } catch (e) {
    throw new Error(t(parseErrorMessageKey, { message: e.message }))
  }
  let doc
  try {
    doc = yaml.load(raw)
  } catch (e) {
    throw new Error(t(parseErrorMessageKey, { message: e.message }))
  }
  if (doc === null || doc === undefined) return {}
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(t(parseErrorMessageKey, { message: 'root must be a mapping' }))
  }
  return doc
}

// 写入权限 0600：models.yml 存明文 apiKey，config.yml 也含账号相关配置，
// 与 omp 自己的文件权限保持一致（Mac/Linux；Windows 无 chmod 语义，忽略失败）。
const writeYamlFile = (p, doc) => {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, yaml.dump(doc || {}, { lineWidth: -1 }), { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* 非 POSIX 平台忽略 */ }
}

const readConfigFile = () => readYamlFile(OMP_CONFIG_PATH(), 'serviceAgent.omp.configParseFailed') || {}

const writeConfigFile = (doc) => writeYamlFile(OMP_CONFIG_PATH(), doc)

// ==================== modelRoles（config.yml → modelRoles 键） ====================

const readOmpModelRoles = () => readConfigFile().modelRoles || {}

const writeOmpModelRoles = (roles) => {
  if (!roles || typeof roles !== 'object') throw new Error(t('serviceAgent.omp.invalidModelRoles'))
  const doc = readConfigFile()
  doc.modelRoles = roles
  writeConfigFile(doc)
  return true
}

// 解析模型引用 "provider/model[:level]"，无前缀时 provider 为空
const parseOmpModelRef = (ref) => {
  if (!ref || typeof ref !== 'string') return null
  const parts = ref.split(':')
  const level = parts.length > 1 ? parts.slice(1).join(':') : ''
  const modelRef = parts[0]
  const slash = modelRef.lastIndexOf('/')
  if (slash === -1) return { provider: '', model: modelRef, level }
  return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1), level }
}

const getOmpModelRoleRefs = () => {
  const roles = readOmpModelRoles()
  return Object.entries(roles).map(([role, ref]) => ({ role, ref }))
}

// ==================== models.yml（js-yaml 文件读写） ====================

const readOmpModels = () => {
  const doc = readYamlFile(OMP_MODELS_PATH(), 'serviceAgent.omp.modelsParseFailed')
  if (doc === null) return { providers: {} }
  if (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) {
    // 文件存在但结构不是 { providers: {...} }：不能当成空表写回（会清空用户的全部模型）
    if (doc.providers === undefined) doc.providers = {}
    else throw new Error(t('serviceAgent.omp.modelsParseFailed', { message: 'providers must be a mapping' }))
  }
  return doc
}

const writeOmpModels = (data) => writeYamlFile(OMP_MODELS_PATH(), data || { providers: {} })

// ==================== Providers / Models CRUD ====================

const getOmpProviderList = () => {
  const models = readOmpModels()
  return Object.entries(models.providers || {}).map(([name, cfg]) => ({
    name,
    apiKey: cfg.apiKey || '',
    baseUrl: cfg.baseUrl || '',
    api: cfg.api || 'openai-completions',
    headers: cfg.headers || {},
    authHeader: !!cfg.authHeader,
    models: (cfg.models || []).map(m => ({
      ...m, // 保留所有原始字段（compat 及自定义同级参数）
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.contextWindow || undefined,
      maxTokens: m.maxTokens || undefined,
      reasoning: !!m.reasoning,
      input: m.input || ['text'],
      thinking: m.thinking || undefined,
      cost: (m.cost && m.cost.input != null) ? m.cost : null,
      compat: m.compat || {},
    })),
  }))
}

const addOmpProvider = (providerName, cfg = {}) => {
  if (!providerName || typeof providerName !== 'string') throw new Error(t('serviceAgent.common.providerNameRequired'))
  const models = readOmpModels()
  if (!models.providers) models.providers = {}
  if (models.providers[providerName]) throw new Error(t('serviceAgent.common.providerExists', { name: providerName }))
  models.providers[providerName] = {
    apiKey: cfg.apiKey || '',
    baseUrl: cfg.baseUrl || '',
    api: cfg.api || 'openai-completions',
    headers: cfg.headers || {},
    authHeader: !!cfg.authHeader,
    models: [],
  }
  writeOmpModels(models)
}

const updateOmpProvider = (providerName, updates) => {
  const models = readOmpModels()
  if (!models.providers) models.providers = {}
  if (!models.providers[providerName]) models.providers[providerName] = { models: [] }
  Object.assign(models.providers[providerName], updates)
  writeOmpModels(models)
}

const deleteOmpProvider = (providerName) => {
  const models = readOmpModels()
  if (!models.providers?.[providerName]) throw new Error(t('serviceAgent.common.providerNotFoundNoName'))
  // 保护：modelRoles 引用检查
  const referenced = getOmpModelRoleRefs().filter(({ ref }) => parseOmpModelRef(ref)?.provider === providerName)
  if (referenced.length) {
    throw new Error(t('serviceAgent.omp.providerReferenced', { name: providerName, roles: referenced.map(r => r.role).join(t('serviceAgent.common.listSeparator')) }))
  }
  delete models.providers[providerName]
  writeOmpModels(models)
}

// cost 规范化：全为 0 时省略（与 pi 一致，0 视为未配置）
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

const addOmpModel = (providerName, model) => {
  if (!providerName) throw new Error(t('serviceAgent.common.providerNameRequired'))
  if (!model?.id) throw new Error(t('serviceAgent.common.modelIdRequired'))
  const models = readOmpModels()
  if (!models.providers?.[providerName]) throw new Error(t('serviceAgent.common.providerNotFound', { name: providerName }))
  const prov = models.providers[providerName]
  if (!prov.models) prov.models = []
  if (prov.models.some(m => m.id === model.id)) throw new Error(t('serviceAgent.common.modelExists', { id: model.id }))
  const cost = normalizeCost(model.cost)
  const next = {
    id: model.id,
    name: model.name || model.id,
    contextWindow: model.contextWindow || undefined,
    maxTokens: model.maxTokens || undefined,
    reasoning: !!model.reasoning,
    input: model.input || ['text'],
  }
  if (cost) next.cost = cost
  if (model.thinking) next.thinking = model.thinking
  if (model.compat && Object.keys(model.compat).length) next.compat = model.compat
  // 自定义字段（其他参数里未预定义的）也一并写入
  for (const [k, v] of Object.entries(model)) {
    if (['id', 'name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinking', 'cost', 'compat'].includes(k)) continue
    next[k] = v
  }
  prov.models.push(next)
  writeOmpModels(models)
}

const updateOmpModel = (providerName, modelId, updates) => {
  const models = readOmpModels()
  if (!models.providers?.[providerName]) throw new Error(t('serviceAgent.common.providerNotFound', { name: providerName }))
  const prov = models.providers[providerName]
  if (!prov.models) return
  const idx = prov.models.findIndex(m => m.id === modelId)
  if (idx === -1) throw new Error(t('serviceAgent.common.modelNotFound', { id: modelId }))
  // 不允许通过编辑改 id（id 是唯一标识，改名由 UI 层 删旧+建新）
  const next = { ...prov.models[idx] }
  if (updates.name !== undefined) next.name = updates.name
  if (updates.contextWindow !== undefined) next.contextWindow = updates.contextWindow || undefined
  if (updates.maxTokens !== undefined) next.maxTokens = updates.maxTokens || undefined
  if (updates.reasoning !== undefined) next.reasoning = !!updates.reasoning
  if (updates.input !== undefined) next.input = updates.input
  if (updates.thinking !== undefined) {
    if (updates.thinking && (updates.thinking.minLevel || updates.thinking.maxLevel || updates.thinking.mode)) {
      next.thinking = updates.thinking
    } else {
      delete next.thinking
    }
  }
  if (updates.cost !== undefined) {
    const cost = normalizeCost(updates.cost)
    if (cost) next.cost = cost
    else delete next.cost
  }
  // compat：updates 里没有（用户从 YAML 删掉整个 compat 块）→ 删除；显式空对象 → 删除
  if (updates.compat !== undefined) {
    if (updates.compat && Object.keys(updates.compat).length) next.compat = updates.compat
    else delete next.compat
  } else {
    delete next.compat
  }
  // 自定义字段（其他参数里未预定义的）合并：增 + 改
  for (const [k, v] of Object.entries(updates)) {
    if (['id', 'name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinking', 'cost', 'compat'].includes(k)) continue
    next[k] = v
  }
  // 删除用户在 YAML 文本框里删掉的自定义字段（round-trip 应反映删除）
  for (const k of Object.keys(next)) {
    if (['id', 'name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinking', 'cost', 'compat'].includes(k)) continue
    if (!(k in updates)) delete next[k]
  }
  prov.models[idx] = next
  writeOmpModels(models)
}

const deleteOmpModel = (providerName, modelId) => {
  const models = readOmpModels()
  if (!models.providers?.[providerName]) throw new Error(t('serviceAgent.common.providerNotFound', { name: providerName }))
  const prov = models.providers[providerName]
  if (!prov.models) return
  // 保护：modelRoles 引用检查
  const referenced = getOmpModelRoleRefs().filter(({ ref }) => {
    const parsed = parseOmpModelRef(ref)
    return parsed?.provider === providerName && parsed.model === modelId
  })
  if (referenced.length) {
    throw new Error(t('serviceAgent.omp.modelReferenced', { model: modelId, roles: referenced.map(r => r.role).join(t('serviceAgent.common.listSeparator')) }))
  }
  prov.models = prov.models.filter(m => m.id !== modelId)
  writeOmpModels(models)
}

// 自动获取模型列表（复用 pi.js 的 OpenAI 兼容 /models 实现）
const fetchProviderModels = (...args) => {
  const { fetchProviderModels: fetchPi } = require('./pi')
  return fetchPi(...args)
}

// ==================== 目录操作 ====================

const openOmpDir = () => {
  const dir = OMP_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const isOmpInstalled = () => fs.existsSync(OMP_DIR())

module.exports = {
  getOmpDir: OMP_DIR, getOmpConfigPath: OMP_CONFIG_PATH, getOmpModelsPath: OMP_MODELS_PATH,
  readOmpModelRoles, writeOmpModelRoles, parseOmpModelRef, getOmpModelRoleRefs,
  readOmpModels, writeOmpModels,
  getOmpProviderList, addOmpProvider, updateOmpProvider, deleteOmpProvider,
  addOmpModel, updateOmpModel, deleteOmpModel,
  fetchProviderModels,
  openOmpDir, isOmpInstalled,
}
