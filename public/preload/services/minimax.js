const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const yaml = require('js-yaml')
const usage = require('./usage')
const { t } = require("./i18n")

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
// 'default' 是官方首档（M3.1-Flash 官方配置 effortOptions 以 default 打头，defaultEffort: default），
// 不可省略：白名单过滤时漏掉它会静默抹掉这一档
const EFFORT_VALUES = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
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
    throw new Error(t('serviceAgent.common.yamlParseFailed', { message: e.message }))
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

// 通用库供应商名可能是中文/任意符号，而 provider 键参与 custom_provider:<key>/ 引用，必须是 ASCII 安全值。
// 确定性清洗（同一下发名永远得到同一键 → upsert 幂等）：合法名原样用；否则取 ASCII 骨架 + 原名稳定哈希防碰撞
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

// 下发用：存在则合并更新（空值不覆盖既有 baseUrl/apiKey，同 kimi.upsertKimiProvider 纪律），否则创建。
// 未知字段经 normalizeProvider._extra / _optionsExtra 原样往返，不会被抹掉。
const upsertMinimaxProvider = (key, cfg) => {
  if (!PROVIDER_KEY_RE.test(String(key))) throw new Error(t('serviceAgent.minimax.invalidProviderKey', { key }))
  assertApiFormat(cfg.api)
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  const prev = tables[key] ? normalizeProvider(key, tables[key], false) : null
  const merged = {
    id: key,
    name: (cfg.name && String(cfg.name).trim()) || (prev && prev.name) || key,
    api: cfg.api || (prev && prev.api) || 'openai-completions',
    baseUrl: cfg.baseUrl || (prev && prev.baseUrl) || '',
    apiKey: cfg.apiKey || (prev && prev.apiKey) || '',
    enabled: prev ? prev.enabled : true,
    models: prev ? prev.models : [],
    _extra: (prev && prev._extra) || {},
    _optionsExtra: (prev && prev._optionsExtra) || {},
  }
  tables[key] = buildProviderYaml(merged)
  writeMinimaxConfig(doc)
  return true
}

// 内置（provider 节，只读）+ 第三方（custom_provider 节，可编辑）合并返回；内置排前
const getMinimaxProviderList = () => {
  const doc = readMinimaxConfig()
  const builtin = Object.entries(getBuiltinProviderTables(doc)).map(([id, p]) => normalizeProvider(id, p, true))
  const custom = Object.entries(getCustomProviderTables(doc)).map(([id, p]) => normalizeProvider(id, p, false))
  return [...builtin, ...custom]
}

const assertApiFormat = (api) => {
  if (api && !MINIMAX_API_FORMATS.includes(api)) {
    throw new Error(t('serviceAgent.minimax.unsupportedApiFormat', { api, options: MINIMAX_API_FORMATS.join(' / ') }))
  }
}

const addMinimaxProvider = (cfg) => {
  const id = String(cfg?.id || '').trim()
  if (!id) throw new Error(t('serviceAgent.common.providerIdRequired'))
  if (!PROVIDER_KEY_RE.test(id)) throw new Error(t('serviceAgent.common.providerIdInvalidChars'))
  assertApiFormat(cfg.api)
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  if (tables[id]) throw new Error(t('serviceAgent.common.providerExistsLabel', { name: id }))
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
  if (!tables[id]) throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: id }))
  const prev = normalizeProvider(id, tables[id], false)
  if (prev.managed) throw new Error(t('serviceAgent.minimax.builtinManagedEdit'))
  assertApiFormat(updates.api)
  // 支持改 ID：ID 是子表键且参与 defaultModel 引用，改名需校验冲突并同步默认模型引用
  const newId = updates.id === undefined || updates.id === id ? id : String(updates.id).trim()
  if (!newId) throw new Error(t('serviceAgent.common.providerIdRequired'))
  if (!PROVIDER_KEY_RE.test(newId)) throw new Error(t('serviceAgent.common.providerIdInvalidChars'))
  if (newId !== id && tables[newId]) throw new Error(t('serviceAgent.common.providerExistsLabel', { name: newId }))
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
  if (!tables[id]) throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: id }))
  const refPrefix = `${CUSTOM_PREFIX}:${id}/`
  if (String(doc.defaultModel || '').startsWith(refPrefix)) {
    throw new Error(t('serviceAgent.minimax.providerIsDefault', { id }))
  }
  delete tables[id]
  writeMinimaxConfig(doc)
  return true
}

// ==================== Models（custom_provider.<id>.models.<modelId>） ====================

const requireCustomProvider = (doc, tables, providerId) => {
  const p = tables[providerId]
  if (!p) throw new Error(t('serviceAgent.common.providerNotFoundLabel', { name: providerId }))
  if (normalizeProvider(providerId, p, false).managed) throw new Error(t('serviceAgent.minimax.builtinManagedModels'))
  return p
}

const addMinimaxModel = (providerId, cfg) => {
  const modelId = String(cfg?.model || '').trim()
  if (!modelId) throw new Error(t('serviceAgent.common.modelIdRequired'))
  if (!MODEL_ID_RE.test(modelId)) throw new Error(t('serviceAgent.common.modelIdInvalidChars'))
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  const provider = requireCustomProvider(doc, tables, providerId)
  const models = (provider.models && typeof provider.models === 'object' && provider.models) || {}
  if (models[modelId]) throw new Error(t('serviceAgent.common.modelExists', { id: modelId }))
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
  if (!models[modelId]) throw new Error(t('serviceAgent.common.modelNotFound', { id: modelId }))
  // 支持改模型 ID（键即引用）：改名需校验冲突并同步 defaultModel 引用
  const newId = updates.model === undefined || updates.model === modelId ? modelId : String(updates.model).trim()
  if (!newId) throw new Error(t('serviceAgent.common.modelIdRequired'))
  if (!MODEL_ID_RE.test(newId)) throw new Error(t('serviceAgent.common.modelIdInvalidChars'))
  if (newId !== modelId && models[newId]) throw new Error(t('serviceAgent.common.modelExists', { id: newId }))
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

// 下发用：模型已存在时只刷新传入的受管字段（limit/附件模态/名称，未传的保留既有值），不存在则新建；
// 返回 defaultModel 可引用的模型 ref（custom_provider:<key>/<modelId>）
const upsertMinimaxModel = (providerId, modelId, opts = {}) => {
  const id = String(modelId || '').trim()
  if (!MODEL_ID_RE.test(id)) throw new Error(t('serviceAgent.minimax.modelIdInvalidForDispatch', { id }))
  const doc = readMinimaxConfig()
  const tables = getCustomProviderTables(doc)
  const provider = requireCustomProvider(doc, tables, providerId)
  const models = (provider.models && typeof provider.models === 'object' && provider.models) || {}
  const prev = models[id] ? normalizeModel(id, models[id]) : null
  const merged = prev || { id, enabled: true, _raw: {} }
  if (opts.name) merged.name = String(opts.name).trim()
  if (Number(opts.contextWindow) > 0) merged.contextWindow = Number(opts.contextWindow)
  if (Number(opts.outputWindow) > 0) merged.outputWindow = Number(opts.outputWindow)
  // 输入模态：通用库 model.input（含 text）过滤为非文本模态后重建 modalities；不传 = 不动
  if (Array.isArray(opts.inputTypes)) merged.inputTypes = opts.inputTypes.filter((x) => INPUT_MODALITY_VALUES.includes(x))
  // 推理等级：通用库 model.reasoningEfforts → thinking.effortOptions；不传 = 不动（保留既有档位）
  if (Array.isArray(opts.effortOptions)) merged.effortOptions = opts.effortOptions.filter((x) => EFFORT_VALUES.includes(x))
  models[id] = buildModelYaml(merged, id)
  provider.models = models
  writeMinimaxConfig(doc)
  return buildModelRef({ id: providerId, managed: false }, id)
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
  if (!parsed) throw new Error(t('serviceAgent.minimax.invalidModelRef', { ref: s }))
  const base = s.split('#')[0]
  let exists = false
  if (parsed.kind === 'custom') {
    exists = !!(getCustomProviderTables(doc)[parsed.providerId]?.models || {})[parsed.modelId]
  } else {
    exists = !!(getBuiltinProviderTables(doc)[parsed.providerId]?.models || {})[parsed.modelId]
  }
  if (!exists) throw new Error(t('serviceAgent.minimax.modelNotFoundForDefault', { model: base }))
  doc.defaultModel = base + s.slice(base.length)
  writeMinimaxConfig(doc)
  return true
}

// ==================== 使用统计 ====================
// MiniMax Code 会话日志：<MINIMAX_HOME>/v2/sessions/<YYYY>/<MM>/<DD>/<会话目录>/messages.jsonl
// 每行 { message_id, turn_id, message }；assistant 消息的 message.usage 形如
//   { input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }
// 与 Pi Agent 的 JSONL 形状一致（usage 字段同名同义），可直接复用 usage.calculateStats。
// 注意两点与 Pi 的差异：
//   1. 时间戳是 epoch 毫秒（message.timestamp），不是 ISO 字符串 → 需转 ISO 再取日期
//   2. 会话日志不记录工作目录（cwd），project 用会话日期目录名兜底（recentSessions 展示用，
//      UsagePage 不消费该字段，不影响统计口径）
const MINIMAX_SESSIONS_DIR = () => path.join(MINIMAX_HOME(), 'v2', 'sessions')
const getMinimaxSessionsDir = MINIMAX_SESSIONS_DIR

// 递归收集会话目录（目录内含 messages.jsonl 即为会话目录）
// 层级：sessions/<YYYY>/<MM>/<DD>/<会话目录> → 深度 6 足够（留余量防布局再变）
const collectSessionDirs = (dir, out, depth = 0) => {
  if (depth > 6) return out
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const p = path.join(dir, entry.name)
    if (fs.existsSync(path.join(p, 'messages.jsonl'))) out.push(p)
    else collectSessionDirs(p, out, depth + 1)
  }
  return out
}

// 会话 id：优先读 manifest.json 的 sessionId；缺失则从目录名尾部 session_<base64> 解码
const readSessionId = (sessionDir) => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(sessionDir, 'manifest.json'), 'utf-8'))
    if (manifest && manifest.sessionId) return String(manifest.sessionId)
  } catch {
    /* manifest 缺失或损坏 → 走目录名回退 */
  }
  const m = path.basename(sessionDir).match(/session_([A-Za-z0-9_-]+)$/)
  if (m) {
    try {
      return Buffer.from(m[1], 'base64').toString('utf-8')
    } catch {
      /* 解码失败 → 用目录名 */
    }
  }
  return path.basename(sessionDir)
}

// epoch 毫秒 → ISO 字符串（无时间戳时返回空串）
const epochToIso = (ts) => {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  try {
    return new Date(n).toISOString()
  } catch {
    return ''
  }
}

const readMinimaxUsage = () => {
  const root = MINIMAX_SESSIONS_DIR()
  if (!fs.existsSync(root)) return emptyUsageResult()

  const messageRecords = []
  const sessionMap = new Map()

  for (const sessionDir of collectSessionDirs(root, [])) {
    const sessionId = readSessionId(sessionDir)
    // 项目名：会话日志无 cwd，用日期目录名（YYYY-MM-DD）兜底
    const project = path.basename(path.dirname(path.dirname(sessionDir)))
    let content = ''
    try {
      content = fs.readFileSync(path.join(sessionDir, 'messages.jsonl'), 'utf-8')
    } catch {
      continue
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      const m = d && d.message
      if (!m || m.role !== 'assistant' || !m.usage) continue
      const u = m.usage
      const input = Number(u.input) || 0
      const output = Number(u.output) || 0
      const cacheRead = Number(u.cacheRead) || 0
      const cacheWrite = Number(u.cacheWrite) || 0
      const total = Number(u.totalTokens) || input + output + cacheRead + cacheWrite
      const iso = epochToIso(m.timestamp)
      if (!iso) continue
      const date = usage.localDayKey(iso)
      const model = m.model || 'unknown'

      messageRecords.push({
        sessionId,
        model,
        project,
        projectPath: sessionDir,
        timestamp: iso,
        date,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        cacheCreationTokens: 0,
        totalTokens: total,
        cost: (u.cost && Number(u.cost.total)) || 0,
      })

      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, {
          sessionId,
          timestamp: iso,
          cwd: sessionDir,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheCreationTokens: 0,
          totalCost: 0,
        })
      }
      const s = sessionMap.get(sessionId)
      s.inputTokens += input
      s.outputTokens += output
      s.cacheReadTokens += cacheRead
      s.cacheWriteTokens += cacheWrite
      s.totalCost += (u.cost && Number(u.cost.total)) || 0
      if (iso > s.timestamp) s.timestamp = iso
    }
  }

  const stats = usage.calculateStats(messageRecords, sessionMap, { includeCost: true })
  // 「通用」统计统一落库
  usage.saveAgentUsage('minimax', stats.contributions)
  return stats
}

// 无会话目录时的空统计（贡献数组补齐 365 天，页面热力图不塌）
const emptyUsageResult = () => {
  return {
    summary: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheCreationTokens: 0,
      totalCost: 0,
      messageCount: 0,
      sessionCount: 0,
    },
    modelStats: [],
    contributions: usage.emptyContributions(),
    avgTokensPerSession: 0,
    recentSessions: [],
  }
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
  upsertMinimaxProvider, providerKeyFor,
  addMinimaxModel, updateMinimaxModel, deleteMinimaxModel, upsertMinimaxModel,
  getMinimaxDefaultModel, setMinimaxDefaultModel, isMinimaxDefaultModel,
  parseMinimaxModelRef, buildModelRef,
  readMinimaxUsage, getMinimaxSessionsDir,
  openMinimaxDir, isMinimaxInstalled,
  MINIMAX_API_FORMATS, CUSTOM_PREFIX, EFFORT_VALUES, INPUT_MODALITY_VALUES,
}
