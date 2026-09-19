const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const yaml = require('js-yaml')

// MiniMax Code（CLI `mcode` / Desktop）：模型配置在 <data-dir>/config.yaml，默认数据目录 ~/.minimax。
// 目录重定向环境变量（官方文档 cli/configuration）：MINIMAX_DATA_DIR 优先，MAVIS_DATA_DIR 为兼容回退。
// 本服务只管理模型相关两处，其余字段（logLevel / permissionMode / minimaxModelSource / 内置 provider 凭证等）
// 读改写原样保留（同 kimi / codex 的纪律）：
//   顶层 defaultModel   — "provider-id/model-id"。内置为 minimax/<modelId>，第三方为
//                         custom_provider:<key>/<modelId>（CLI 0.4.12 实测：该写法激活后
//                         provider list --json 对应 provider active、模型 selected 均正确）
//   custom_provider.<key> — 第三方 Provider：name + kind:custom + enabled + api（协议）+
//                         options { baseURL, authMode, apiKey } + models.<id> { name, limit{context,output}, ... }
//   provider.minimax    — 内置 MiniMax（mcode login / Token Plan 托管）：只读展示，可设默认模型，禁改禁删
// 密钥明文写入 options.apiKey：与桌面版自身写同一文件的做法一致（实测 newapi 条目），
// CLI 的 --api-key-env 环境变量引用模式暂不纳入 UI 管理。

const MINIMAX_HOME = () =>
  process.env.MINIMAX_DATA_DIR || process.env.MAVIS_DATA_DIR || path.join(os.homedir(), '.minimax')
const MINIMAX_CONFIG_PATH = () => path.join(MINIMAX_HOME(), 'config.yaml')
const getMinimaxHome = MINIMAX_HOME
const getMinimaxConfigPath = MINIMAX_CONFIG_PATH

// 官方支持的 API 格式（docs/cli/configuration · 自定义 Provider --api-format）
const MINIMAX_API_FORMATS = ['anthropic-messages', 'openai-completions', 'openai-responses']
// defaultModel 引用 custom provider 时的前缀：custom_provider:<key>/<modelId>
const CUSTOM_PREFIX = 'custom_provider'

// Provider 键参与 custom_provider:<key>/ 前缀解析，禁止冒号与斜杠
const PROVIDER_KEY_RE = /^[A-Za-z0-9_-]+$/
// 模型 ID：官方命名含点/中划线（MiniMax-M2.7-highspeed），兼容 org/model 风格
const MODEL_ID_RE = /^[\w.:\-/]+$/
// 推理等级选项（thinking.effortOptions，桌面 UI「推理等级」；枚举取自 CLI 包常量）
const EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// 文本之外的输入模态（modalities.input + attachment，桌面 UI「支持的附件」图片/PDF/视频/音频；
// 桌面实测写入字面量 image/pdf/video，CLI 枚举含 audio）
const INPUT_MODALITY_VALUES = ['image', 'pdf', 'video', 'audio']

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : 0)

// ==================== config.yaml 读写 ====================

const readMinimaxConfig = () => {
  const p = MINIMAX_CONFIG_PATH()
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    return yaml.load(raw) || {}
  } catch (e) {
    // 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会覆盖整个
    // config.yaml，抹掉 runtime / provider / 其他节（同 kimi / reasonix / codex）
    throw new Error(`config.yaml 解析失败，已阻止修改（请先修复 YAML 语法）: ${e.message}`)
  }
}

const writeMinimaxConfig = (doc) => {
  const p = MINIMAX_CONFIG_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, yaml.dump(doc || {}, { lineWidth: -1 }), { encoding: 'utf-8' })
  return true
}

const getCustomProviderTables = (doc) => {
  if (!doc.custom_provider || typeof doc.custom_provider !== 'object') doc.custom_provider = {}
  return doc.custom_provider
}

const getBuiltinProviderTables = (doc) =>
  (doc.provider && typeof doc.provider === 'object' ? doc.provider : {})

// ==================== 归一化 / 构建 ====================

// UI 认识并显式管理的字段；其余（configuration_source / whitelist / model_order / oauth / headers 等）收进 _extra 原样写回
const KNOWN_PROVIDER_FIELDS = ['name', 'kind', 'enabled', 'api', 'options', 'models']
const KNOWN_OPTIONS_FIELDS = ['baseURL', 'apiKey', 'authMode']

// 内置 provider 的协议是推导值（npm SDK 包名暗示），仅用于展示
const guessBuiltinApi = (p) => {
  const npm = String((p && p.npm) || '')
  if (npm.includes('anthropic')) return 'anthropic-messages'
  if (npm.includes('openai') && !npm.includes('compatible') && !npm.includes('completions')) return 'openai-responses'
  return 'openai-completions'
}

const normalizeModel = (modelId, m) => {
  const entry = {
    id: modelId,
    name: (m && typeof m.name === 'string' && m.name) || modelId,
    contextWindow: toNumber(m && m.limit && m.limit.context),
    outputWindow: toNumber(m && m.limit && m.limit.output),
    // 推理等级（thinking.effortOptions）与非文本输入模态（modalities.input，text 隐含）
    effortOptions: Array.isArray(m && m.thinking && m.thinking.effortOptions)
      ? m.thinking.effortOptions.filter((x) => typeof x === 'string')
      : [],
    inputTypes: Array.isArray(m && m.modalities && m.modalities.input)
      ? m.modalities.input.filter((x) => INPUT_MODALITY_VALUES.includes(x))
      : [],
    attachment: !!(m && m.attachment === true),
    enabled: !m || m.enabled !== false,
    // 原始对象整体往返：reasoning / thinking 子键（mode 等）/ variants / capabilities 等
    // 官方丰富字段与 discovered 来源信息一律保留，UI 只显式管理上表几项
    _raw: m && typeof m === 'object' ? m : {},
  }
  return entry
}

const buildModelYaml = (cfg, modelId) => {
  const next = { ...(cfg._raw || {}) }
  const id = modelId || cfg.id
  next.name = cfg.name && String(cfg.name).trim() ? String(cfg.name).trim() : id
  if (cfg.enabled === false) next.enabled = false
  else if (next.enabled === false) delete next.enabled
  const limit = { ...((cfg._raw && cfg._raw.limit) || {}) }
  if (Number(cfg.contextWindow) > 0) limit.context = Number(cfg.contextWindow)
  else delete limit.context
  if (Number(cfg.outputWindow) > 0) limit.output = Number(cfg.outputWindow)
  else delete limit.output
  if (Object.keys(limit).length) next.limit = limit
  else delete next.limit
  // 推理等级：并入 thinking 子表（mode / default_value 等其他键原样保留）；
  // 传数组才重建，清空数组 = 删除 effortOptions；不传（undefined）= 不动
  if (Array.isArray(cfg.effortOptions)) {
    const th = { ...((cfg._raw && cfg._raw.thinking) || {}) }
    const valid = cfg.effortOptions.filter((x) => EFFORT_VALUES.includes(x))
    if (valid.length) th.effortOptions = valid
    else delete th.effortOptions
    if (Object.keys(th).length) next.thinking = th
    else delete next.thinking
  }
  // 支持的附件：modalities.input 以 text 领头 + 选中模态（桌面写入形态一致），
  // output 缺省补 [text]；attachment 随有无附件联动 true/false
  if (Array.isArray(cfg.inputTypes)) {
    const types = cfg.inputTypes.filter((x) => INPUT_MODALITY_VALUES.includes(x))
    const mo = { ...((cfg._raw && cfg._raw.modalities) || {}) }
    mo.input = ['text', ...types]
    if (!Array.isArray(mo.output) || !mo.output.length) mo.output = ['text']
    next.modalities = mo
    next.attachment = types.length > 0
  }
  if (!next.configuration_source) next.configuration_source = 'manual'
  return next
}

const normalizeProvider = (id, p, managed) => {
  const extra = {}
  for (const k of Object.keys(p || {})) {
    if (!KNOWN_PROVIDER_FIELDS.includes(k)) extra[k] = p[k]
  }
  const options = (p && typeof p.options === 'object' && p.options) || {}
  const optionsExtra = {}
  for (const k of Object.keys(options)) {
    if (!KNOWN_OPTIONS_FIELDS.includes(k)) optionsExtra[k] = options[k]
  }
  return {
    id,
    managed: !!managed,
    name: (p && typeof p.name === 'string' && p.name) || id,
    api: (p && p.api) || (managed ? guessBuiltinApi(p) : 'openai-completions'),
    enabled: !p || p.enabled !== false,
    baseUrl: options.baseURL || '',
    // 内置托管供应商不下发密钥到 UI（同 kimi managed 处理），custom 回显供编辑
    apiKey: managed ? '' : options.apiKey || '',
    hasKey: !!String(options.apiKey || '').trim(),
    models: Object.entries((p && p.models) || {}).map(([modelId, m]) => normalizeModel(modelId, m)),
    _extra: extra,
    _optionsExtra: optionsExtra,
  }
}

const buildProviderYaml = (cfg) => {
  const p = { ...cfg._extra }
  p.name = cfg.name || cfg.id
  p.kind = 'custom'
  p.enabled = cfg.enabled !== false
  p.api = cfg.api || 'openai-completions'
  const options = { ...cfg._optionsExtra }
  if (cfg.baseUrl) options.baseURL = cfg.baseUrl
  else delete options.baseURL
  if (cfg.apiKey) options.apiKey = cfg.apiKey
  else delete options.apiKey
  if (cfg.apiKey && !options.authMode) options.authMode = 'api-key'
  p.options = options
  const models = {}
  for (const m of cfg.models || []) models[m.id] = buildModelYaml(m, m.id)
  p.models = models
  return p
}

// ==================== Providers ====================

// 内置（provider 节，只读）+ 第三方（custom_provider 节，可编辑）合并返回；内置排前
const getMinimaxProviderList = () => {
  const doc = readMinimaxConfig()
  const builtin = Object.entries(getBuiltinProviderTables(doc)).map(([id, p]) => normalizeProvider(id, p, true))
  const custom = Object.entries(getCustomProviderTables(doc)).map(([id, p]) => normalizeProvider(id, p, false))
  return [...builtin, ...custom]
}

const assertApiFormat = (api) => {
  if (api && !MINIMAX_API_FORMATS.includes(api)) {
    throw new Error(`不支持的 API 格式 ${api}（可选：${MINIMAX_API_FORMATS.join(' / ')}）`)
  }
}

const addMinimaxProvider = (cfg) => {
  const id = String(cfg?.id || '').trim()
  if (!id) throw new Error('Provider ID 不能为空')
  if (!PROVIDER_KEY_RE.test(id)) throw new Error('Provider ID 只能包含字母、数字、下划线、中划线')
  assertApiFormat(cfg.api)
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  if (tables[id]) throw new Error(`Provider ${id} 已存在`)
  tables[id] = buildProviderYaml({
    id,
    name: String(cfg.name || '').trim() || id,
    api: cfg.api || 'openai-completions',
    baseUrl: String(cfg.baseUrl || '').trim(),
    apiKey: cfg.apiKey || '',
    enabled: true,
    models: [],
    _extra: {},
    _optionsExtra: {},
  })
  writeMinimaxConfig(doc)
  return true
}

const updateMinimaxProvider = (id, updates) => {
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  if (!tables[id]) throw new Error(`Provider ${id} 不存在`)
  const prev = normalizeProvider(id, tables[id], false)
  if (prev.managed) throw new Error('内置供应商由 mcode login 托管，不可编辑')
  assertApiFormat(updates.api)
  // 支持改 ID：ID 是子表键且参与 defaultModel 引用，改名需校验冲突并同步默认模型引用
  const newId = updates.id === undefined || updates.id === id ? id : String(updates.id).trim()
  if (!newId) throw new Error('Provider ID 不能为空')
  if (!PROVIDER_KEY_RE.test(newId)) throw new Error('Provider ID 只能包含字母、数字、下划线、中划线')
  if (newId !== id && tables[newId]) throw new Error(`Provider ${newId} 已存在`)
  const merged = { ...prev, ...updates, id: newId }
  if (updates.clearApiKey) merged.apiKey = ''
  const next = buildProviderYaml(merged)
  delete tables[id]
  tables[newId] = next
  if (newId !== id) {
    const oldRef = `${CUSTOM_PREFIX}:${id}/`
    const dm = String(doc.defaultModel || '')
    if (dm === oldRef || dm.startsWith(oldRef)) {
      doc.defaultModel = `${CUSTOM_PREFIX}:${newId}/${dm.slice(oldRef.length)}`
    }
  }
  writeMinimaxConfig(doc)
  return true
}

const deleteMinimaxProvider = (id) => {
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  if (!tables[id]) throw new Error(`Provider ${id} 不存在`)
  const refPrefix = `${CUSTOM_PREFIX}:${id}/`
  if (String(doc.defaultModel || '').startsWith(refPrefix)) {
    throw new Error(`Provider ${id} 是当前默认模型所属供应商，请先切换默认模型`)
  }
  delete tables[id]
  writeMinimaxConfig(doc)
  return true
}

// ==================== Models（custom_provider.<id>.models.<modelId>） ====================

const requireCustomProvider = (doc, tables, providerId) => {
  const p = tables[providerId]
  if (!p) throw new Error(`Provider ${providerId} 不存在`)
  if (normalizeProvider(providerId, p, false).managed) throw new Error('内置供应商不可增删改模型')
  return p
}

const addMinimaxModel = (providerId, cfg) => {
  const modelId = String(cfg?.model || '').trim()
  if (!modelId) throw new Error('模型 ID 不能为空')
  if (!MODEL_ID_RE.test(modelId)) throw new Error('模型 ID 只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  const provider = requireCustomProvider(doc, tables, providerId)
  const models = (provider.models && typeof provider.models === 'object' && provider.models) || {}
  if (models[modelId]) throw new Error(`模型 ${modelId} 已存在`)
  models[modelId] = buildModelYaml({ id: modelId, ...cfg }, modelId)
  provider.models = models
  writeMinimaxConfig(doc)
  return true
}

const updateMinimaxModel = (providerId, modelId, updates) => {
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  const provider = requireCustomProvider(doc, tables, providerId)
  const models = (provider.models && typeof provider.models === 'object' && provider.models) || {}
  if (!models[modelId]) throw new Error(`模型 ${modelId} 不存在`)
  // 支持改模型 ID（键即引用）：改名需校验冲突并同步 defaultModel 引用
  const newId = updates.model === undefined || updates.model === modelId ? modelId : String(updates.model).trim()
  if (!newId) throw new Error('模型 ID 不能为空')
  if (!MODEL_ID_RE.test(newId)) throw new Error('模型 ID 只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  if (newId !== modelId && models[newId]) throw new Error(`模型 ${newId} 已存在`)
  const prev = normalizeModel(modelId, models[modelId])
  const merged = { ...prev, ...updates }
  models[newId] = buildModelYaml(merged, newId)
  if (newId !== modelId) {
    delete models[modelId]
    // 改名前的引用用的是旧模型 ID（此处 providerId 即当前键，不会变）
    const dm = String(doc.defaultModel || '')
    if (dm === `${CUSTOM_PREFIX}:${providerId}/${modelId}`) {
      doc.defaultModel = `${CUSTOM_PREFIX}:${providerId}/${newId}`
    }
  }
  provider.models = models
  writeMinimaxConfig(doc)
  return true
}

const deleteMinimaxModel = (providerId, modelId) => {
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  const provider = tables[providerId]
  if (!provider || !provider.models || !provider.models[modelId]) return true
  delete provider.models[modelId]
  // 清理悬挂的默认模型引用（去 #variant 后比较）
  if (String(doc.defaultModel || '').split('#')[0] === `${CUSTOM_PREFIX}:${providerId}/${modelId}`) {
    delete doc.defaultModel
  }
  writeMinimaxConfig(doc)
  return true
}

// ==================== defaultModel ====================

// "minimax/MiniMax-M3" → builtin；"custom_provider:probe/test-model" → custom；兼容 #variant 后缀
const parseMinimaxModelRef = (ref) => {
  const s = String(ref || '').trim()
  if (!s) return null
  const base = s.split('#')[0]
  if (base.startsWith(`${CUSTOM_PREFIX}:`)) {
    const rest = base.slice(CUSTOM_PREFIX.length + 1)
    const i = rest.indexOf('/')
    if (i <= 0) return null
    return { kind: 'custom', providerId: rest.slice(0, i), modelId: rest.slice(i + 1) }
  }
  const i = base.indexOf('/')
  if (i <= 0) return null
  return { kind: 'builtin', providerId: base.slice(0, i), modelId: base.slice(i + 1) }
}

const buildModelRef = (provider, modelId) =>
  provider.managed ? `${provider.id}/${modelId}` : `${CUSTOM_PREFIX}:${provider.id}/${modelId}`

// UI 判定「默认」标签用：当前 defaultModel（去 #variant）与目标引用是否一致
const isMinimaxDefaultModel = (provider, modelId) => {
  const dm = String(getMinimaxDefaultModel() || '').split('#')[0]
  return !!dm && dm === buildModelRef(provider, modelId)
}

const getMinimaxDefaultModel = () => readMinimaxConfig().defaultModel || ''

const setMinimaxDefaultModel = (ref) => {
  const doc = readMinimaxConfig()
  const s = String(ref || '').trim()
  if (!s) {
    delete doc.defaultModel
    writeMinimaxConfig(doc)
    return true
  }
  const parsed = parseMinimaxModelRef(s)
  if (!parsed) throw new Error(`模型引用格式无效：${s}`)
  const base = s.split('#')[0]
  let exists = false
  if (parsed.kind === 'custom') {
    exists = !!(getCustomProviderTables(doc)[parsed.providerId]?.models || {})[parsed.modelId]
  } else {
    exists = !!(getBuiltinProviderTables(doc)[parsed.providerId]?.models || {})[parsed.modelId]
  }
  if (!exists) throw new Error(`模型 ${base} 不存在，无法设为默认`)
  doc.defaultModel = base + s.slice(base.length)
  writeMinimaxConfig(doc)
  return true
}

// ==================== 目录操作 ====================

const openMinimaxDir = () => {
  const dir = MINIMAX_HOME()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const isMinimaxInstalled = () => fs.existsSync(MINIMAX_HOME())

module.exports = {
  getMinimaxHome, getMinimaxConfigPath,
  readMinimaxConfig, writeMinimaxConfig,
  getMinimaxProviderList, addMinimaxProvider, updateMinimaxProvider, deleteMinimaxProvider,
  addMinimaxModel, updateMinimaxModel, deleteMinimaxModel,
  getMinimaxDefaultModel, setMinimaxDefaultModel, isMinimaxDefaultModel,
  parseMinimaxModelRef, buildModelRef,
  openMinimaxDir, isMinimaxInstalled,
  MINIMAX_API_FORMATS, CUSTOM_PREFIX, EFFORT_VALUES, INPUT_MODALITY_VALUES,
}
