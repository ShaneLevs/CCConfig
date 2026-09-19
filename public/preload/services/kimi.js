const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { parse: parseToml, stringify: stringifyToml } = require('smol-toml')

// Kimi Code：模型配置在 ~/.kimi-code/config.toml（官方文档 configuration/config-files.html）。
// 主目录可用 KIMI_CODE_HOME 环境变量重定向（同 Codex 的 CODEX_HOME：客户端读写哪边、插件就改哪边）。
// 本服务只管理模型相关三处，其余配置节（thinking / loop_control / permission / [[hooks]] 等）读改写原样保留：
//   顶层 default_model   — 默认模型别名，必须是 models 表中的 key
//   [providers.<name>]   — 供应商表：type（kimi/anthropic/openai/openai_responses/google-genai/vertexai）
//                          + base_url + api_key（CLI 不从 shell 环境取凭证，key 必须显式写入文件）
//   [models."<alias>"]   — 模型别名表：provider + model + max_context_size（三个必填）
//                          + 官方可选字段（display_name / capabilities / effort 档位等，见 MODEL_*_FIELDS）
// 别名/供应商名可含 . 和 :（如 gpt-4.1、managed:kimi-code），smol-toml 序列化时自动加引号。
const KIMI_HOME = () => process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')
const KIMI_CONFIG_PATH = () => path.join(KIMI_HOME(), 'config.toml')
const getKimiHome = KIMI_HOME
const getKimiConfigPath = KIMI_CONFIG_PATH

// 官方支持的供应商协议类型
const KIMI_PROVIDER_TYPES = ['kimi', 'anthropic', 'openai', 'openai_responses', 'google-genai', 'vertexai']
// 供应商名 / 模型别名：字母数字、下划线、中划线、点、冒号、斜杠
// （官方示例别名含斜杠：kimi-code/k3；managed:kimi-code 含冒号；gpt-4.1 含点）
const KEY_RE = /^[\w.:\-/]+$/
// max_context_size 缺省值（下发等未提供上下文的场景；文档要求 ≥1）
const DEFAULT_CONTEXT_SIZE = 131072

// [models."<别名>"] 官方扩展字段（文档 configuration/config-files.html models 节）。
// UI 管理的已知可选字段统一 snake_case → camelCase；未知/刷新类字段（overrides、base_url、
// protocol、beta_api 等 CLI 自动写入的）一律走 _extra 原样往返，UI 不暴露编辑入口。
const MODEL_STR_FIELDS = { displayName: 'display_name', defaultEffort: 'default_effort', offEffort: 'off_effort', reasoningKey: 'reasoning_key' }
const MODEL_INT_FIELDS = { maxInputSize: 'max_input_size', maxOutputSize: 'max_output_size' }
const MODEL_BOOL_FIELDS = { adaptiveThinking: 'adaptive_thinking' }
const MODEL_ARR_FIELDS = { capabilities: 'capabilities', supportEfforts: 'support_efforts' }
// anthropic 专属（文档：max_output_size 目前仅 anthropic 读取；adaptive_thinking 仅 anthropic）
const ANTHROPIC_ONLY = ['maxOutputSize', 'adaptiveThinking']
// openai 协议族（文档：reasoning_key 仅 openai 供应商；openai_responses 同属 OpenAI Chat/Responses 协议族，放行）
const OPENAI_FAMILY = ['openai', 'openai_responses']
// effort 档位合法取值（文档 thinking 节：low/medium/high/xhigh/max；xai 等网关 off_effort 可为 none）
const EFFORT_RE = /^(low|medium|high|xhigh|max|none)$/
// capabilities / support_efforts 的合法枚举（文档 models 节字段表）
const KIMI_CAPABILITIES = ['thinking', 'always_thinking', 'image_in', 'video_in', 'audio_in', 'tool_use']
const KIMI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// 扩展字段中文名（报错提示用）
const MODEL_FIELD_NAMES = {
  displayName: '显示名', maxInputSize: '最大输入', maxOutputSize: '最大输出',
  capabilities: '能力标签', supportEfforts: 'Thinking 档位', defaultEffort: '默认档位',
  offEffort: '关闭时档位', reasoningKey: '推理字段名', adaptiveThinking: 'Adaptive Thinking',
}

// BigInt → Number（smol-toml 部分环境整数解析为 BigInt，UI 层不消费 BigInt）
const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : v == null ? 0 : Number(v))

// "未设置"判定：''/null/undefined/0/[] 均视为空（false 不算——布尔字段显式 false 有意义）
const isEmptyVal = (v) => v === '' || v === null || v === undefined || v === 0
  || (Array.isArray(v) && !v.length)

// ==================== config.toml 读写 ====================

const readKimiConfig = () => {
  const p = KIMI_CONFIG_PATH()
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    return parseToml(raw) || {}
  } catch (e) {
    // 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会覆盖整个
    // config.toml，抹掉 thinking / loop_control / permission / hooks 等节（同 reasonix/codex）
    throw new Error(`config.toml 解析失败，已阻止修改（请先修复 TOML 语法）: ${e.message}`)
  }
}

const writeKimiConfig = (doc) => {
  const p = KIMI_CONFIG_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, stringifyToml(doc || {}), { encoding: 'utf-8' })
  return true
}

const getProviderTables = (doc) => {
  if (!doc.providers || typeof doc.providers !== 'object') doc.providers = {}
  return doc.providers
}

const getModelTables = (doc) => {
  if (!doc.models || typeof doc.models !== 'object') doc.models = {}
  return doc.models
}

// ==================== Providers（[providers.<name>] 命名表） ====================

// UI 认识并显式管理的字段；其余（env 子表 / custom_headers / oauth 等）收进 _extra 原样写回
const KNOWN_PROVIDER_FIELDS = ['type', 'base_url', 'api_key']

const normalizeProvider = (name, p) => {
  const extra = {}
  for (const k of Object.keys(p || {})) {
    if (!KNOWN_PROVIDER_FIELDS.includes(k)) extra[k] = p[k]
  }
  return {
    name,
    type: p.type || 'openai',
    baseUrl: p.base_url || '',
    apiKey: p.api_key || '',
    // /login 托管供应商（含 oauth 凭据引用）：UI 只读展示，禁止编辑/删除，避免破坏登录态
    managed: !!(p.oauth && typeof p.oauth === 'object'),
    _extra: extra,
  }
}

// 从 UI 结构构建写入 TOML 的 provider 对象（空字段不输出；未知字段原样还原）
const buildProviderToml = (cfg) => {
  const p = { type: cfg.type || 'openai' }
  if (cfg.baseUrl) p.base_url = cfg.baseUrl
  if (cfg.apiKey) p.api_key = cfg.apiKey
  for (const [k, v] of Object.entries(cfg._extra || {})) {
    if (v !== undefined) p[k] = v
  }
  return p
}

const getKimiProviderList = () => {
  const doc = readKimiConfig()
  return Object.entries(getProviderTables(doc)).map(([name, p]) => normalizeProvider(name, p))
}

const addKimiProvider = (cfg) => {
  const name = String(cfg?.name || '').trim()
  if (!name) throw new Error('供应商名不能为空')
  if (!KEY_RE.test(name)) throw new Error('供应商名只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  if (cfg.type && !KIMI_PROVIDER_TYPES.includes(cfg.type)) {
    throw new Error(`不支持的供应商类型 ${cfg.type}`)
  }
  const doc = readKimiConfig()
  const tables = getProviderTables(doc)
  if (tables[name]) throw new Error(`供应商 ${name} 已存在`)
  tables[name] = buildProviderToml({ ...cfg, name, type: cfg.type || 'openai' })
  writeKimiConfig(doc)
  return true
}

const updateKimiProvider = (name, updates) => {
  const doc = readKimiConfig()
  const tables = getProviderTables(doc)
  if (!tables[name]) throw new Error(`供应商 ${name} 不存在`)
  if (normalizeProvider(name, tables[name]).managed) {
    throw new Error(`供应商 ${name} 由 /login 托管（含 OAuth 凭据），不可编辑`)
  }
  // 支持重命名：name 是子表键，改名需校验冲突并同步 models 表的 provider 引用
  const newName = updates.name === undefined || updates.name === name ? name : String(updates.name).trim()
  if (!newName) throw new Error('供应商名不能为空')
  if (!KEY_RE.test(newName)) throw new Error('供应商名只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  if (newName !== name && tables[newName]) throw new Error(`供应商 ${newName} 已存在`)
  if (updates.type && !KIMI_PROVIDER_TYPES.includes(updates.type)) {
    throw new Error(`不支持的供应商类型 ${updates.type}`)
  }
  const merged = { ...normalizeProvider(name, tables[name]), ...updates, name: newName }
  // clearApiKey → 删除已保存的 key；否则 key 有值才覆盖
  if (updates.clearApiKey) merged.apiKey = ''
  const next = buildProviderToml(merged)
  delete tables[name]
  tables[newName] = next
  if (newName !== name) {
    // models 表里 provider 字段跟随改名（default_model 引用的是别名，不受影响）
    const models = getModelTables(doc)
    for (const entry of Object.values(models)) {
      if (entry && entry.provider === name) entry.provider = newName
    }
  }
  writeKimiConfig(doc)
  return true
}

const deleteKimiProvider = (name) => {
  const doc = readKimiConfig()
  const tables = getProviderTables(doc)
  if (!tables[name]) throw new Error(`供应商 ${name} 不存在`)
  if (normalizeProvider(name, tables[name]).managed) {
    throw new Error(`供应商 ${name} 由 /login 托管（含 OAuth 凭据），请使用 kimi /logout 管理`)
  }
  const usedBy = Object.keys(getModelTables(doc)).filter(a => (doc.models[a] || {}).provider === name)
  if (usedBy.length) {
    throw new Error(`供应商 ${name} 被模型别名引用（${usedBy.slice(0, 3).join('、')}${usedBy.length > 3 ? ' 等' : ''}），请先删除相关模型`)
  }
  delete tables[name]
  writeKimiConfig(doc)
  return true
}

// 下发用：存在则合并更新（保留既有扩展字段与已存 key，空值不覆盖），不存在则创建。
// 托管供应商（oauth）不动其凭证与端点，仅允许刷新 type 之外的常规更新会被跳过。
const upsertKimiProvider = (name, cfg) => {
  const doc = readKimiConfig()
  const tables = getProviderTables(doc)
  const prev = tables[name]
    ? normalizeProvider(name, tables[name])
    : { name, type: '', baseUrl: '', apiKey: '', managed: false, _extra: {} }
  if (prev.managed) return true
  const merged = { ...prev }
  for (const [k, v] of Object.entries(cfg)) {
    if (v !== undefined && v !== '') merged[k] = v
  }
  if (!merged.type) merged.type = 'openai'
  tables[name] = buildProviderToml(merged)
  writeKimiConfig(doc)
  return true
}

// ==================== Models（[models."<alias>"] 别名表） ====================

// UI 管理的字段：provider / model + 上表所列官方可选字段；
// 其余（overrides / base_url / protocol / beta_api 等 CLI 自动写入或文档未展开的）进 _extra 原样写回
const KNOWN_MODEL_FIELDS = [
  'provider', 'model', 'max_context_size',
  ...Object.values(MODEL_STR_FIELDS), ...Object.values(MODEL_INT_FIELDS),
  ...Object.values(MODEL_BOOL_FIELDS), ...Object.values(MODEL_ARR_FIELDS),
]

const normalizeModel = (alias, m) => {
  const extra = {}
  for (const k of Object.keys(m || {})) {
    if (!KNOWN_MODEL_FIELDS.includes(k)) extra[k] = m[k]
  }
  const entry = {
    alias,
    provider: m.provider || '',
    model: m.model || '',
    maxContextSize: toNumber(m.max_context_size),
    _extra: extra,
  }
  // 未设置的字段输出"空值形态"：字符串 ''、数字 0、数组 []、三态布尔 null
  for (const [camel, snake] of Object.entries(MODEL_STR_FIELDS)) entry[camel] = typeof m[snake] === 'string' ? m[snake] : ''
  for (const [camel, snake] of Object.entries(MODEL_INT_FIELDS)) entry[camel] = toNumber(m[snake]) > 0 ? toNumber(m[snake]) : 0
  for (const [camel, snake] of Object.entries(MODEL_BOOL_FIELDS)) entry[camel] = typeof m[snake] === 'boolean' ? m[snake] : null
  for (const [camel, snake] of Object.entries(MODEL_ARR_FIELDS)) entry[camel] = Array.isArray(m[snake]) ? m[snake] : []
  return entry
}

// 按供应商协议类型拦截专属字段误用（下发路径 type 未知时传 '' → 不校验）
const assertModelFieldProtocol = (cfg, providerType) => {
  if (!providerType) return
  const isAnthropic = providerType === 'anthropic'
  const isOpenaiFamily = OPENAI_FAMILY.includes(providerType)
  for (const f of ANTHROPIC_ONLY) {
    const v = cfg[f]
    const set = typeof v === 'boolean' ? v !== null : !!v
    if (set && !isAnthropic) throw new Error(`${MODEL_FIELD_NAMES[f]} 仅 anthropic 供应商支持（当前 ${providerType}）`)
  }
  const rk = cfg.reasoningKey
  if (rk && !isOpenaiFamily) throw new Error(`${MODEL_FIELD_NAMES.reasoningKey} 仅 openai 协议供应商支持（当前 ${providerType}）`)
}

const buildModelToml = (cfg) => {
  const m = {
    provider: cfg.provider,
    model: cfg.model,
    max_context_size: Number(cfg.maxContextSize) > 0 ? Number(cfg.maxContextSize) : DEFAULT_CONTEXT_SIZE,
  }
  for (const [camel, snake] of Object.entries(MODEL_STR_FIELDS)) {
    const v = String(cfg[camel] || '').trim()
    if (v) m[snake] = v
  }
  for (const [camel, snake] of Object.entries(MODEL_INT_FIELDS)) {
    const v = Number(cfg[camel])
    if (v > 0) m[snake] = v
  }
  for (const [camel, snake] of Object.entries(MODEL_BOOL_FIELDS)) {
    if (typeof cfg[camel] === 'boolean') m[snake] = cfg[camel]
  }
  for (const [camel, snake] of Object.entries(MODEL_ARR_FIELDS)) {
    if (Array.isArray(cfg[camel]) && cfg[camel].length) m[snake] = cfg[camel]
  }
  for (const [k, v] of Object.entries(cfg._extra || {})) {
    if (v !== undefined) m[k] = v
  }
  return m
}

// 从 UI 入参里挑出全部官方扩展字段（camelCase；含 null/''/[] = 清除语义，undefined = 不传不写）
const MODEL_EXTRA_KEYS = [
  ...Object.keys(MODEL_STR_FIELDS), ...Object.keys(MODEL_INT_FIELDS),
  ...Object.keys(MODEL_BOOL_FIELDS), ...Object.keys(MODEL_ARR_FIELDS),
]
const pickModelExtras = (cfg) => {
  const out = {}
  for (const k of MODEL_EXTRA_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k]
  }
  return out
}

// UI/下发入参的扩展字段统一校验（camelCase；undefined = 不改动，跳过）
const validateModelExtras = (cfg, providerType) => {
  assertModelFieldProtocol(cfg, providerType)
  for (const [camel, list] of Object.entries({ capabilities: KIMI_CAPABILITIES, supportEfforts: KIMI_EFFORTS })) {
    const v = cfg[camel]
    if (v === undefined) continue
    if (!Array.isArray(v)) throw new Error(`${MODEL_FIELD_NAMES[camel]} 需为数组`)
    for (const item of v) {
      if (!list.includes(item)) throw new Error(`${MODEL_FIELD_NAMES[camel]} 含不支持的值 ${item}（可选：${list.join('/')}）`)
    }
  }
  for (const camel of ['defaultEffort', 'offEffort']) {
    const v = cfg[camel]
    if (v === undefined || v === '' || v === null) continue
    if (!EFFORT_RE.test(String(v))) throw new Error(`${MODEL_FIELD_NAMES[camel]} 需为 low/medium/high/xhigh/max/none`)
  }
  for (const camel of ['maxInputSize', 'maxOutputSize']) {
    const v = cfg[camel]
    if (v === undefined || isEmptyVal(v)) continue
    if (!Number.isInteger(Number(v)) || Number(v) < 1) throw new Error(`${MODEL_FIELD_NAMES[camel]} 需为 ≥1 的整数`)
  }
  // displayName 无协议限制，但非 ASCII（中文）在部分终端 UI 显示异常，拦截提示
  if (cfg.displayName && !/^[\x20-\x7E]+$/.test(String(cfg.displayName))) {
    throw new Error('显示名仅允许 ASCII 字符')
  }
}

const getKimiModelList = () => {
  const doc = readKimiConfig()
  return Object.entries(getModelTables(doc)).map(([alias, m]) => normalizeModel(alias, m))
}

const addKimiModel = (cfg) => {
  const alias = String(cfg?.alias || '').trim()
  const model = String(cfg?.model || '').trim()
  const provider = String(cfg?.provider || '').trim()
  if (!alias) throw new Error('模型别名不能为空')
  if (!KEY_RE.test(alias)) throw new Error('模型别名只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  if (!provider) throw new Error('请选择供应商')
  if (!model) throw new Error('模型 ID 不能为空')
  const doc = readKimiConfig()
  const provTable = getProviderTables(doc)
  const prov = provTable[provider]
  if (!prov) throw new Error(`供应商 ${provider} 不存在`)
  validateModelExtras(cfg, prov.type || '')
  const models = getModelTables(doc)
  if (models[alias]) throw new Error(`模型别名 ${alias} 已存在`)
  models[alias] = buildModelToml({ alias, provider, model, maxContextSize: cfg.maxContextSize, ...pickModelExtras(cfg) })
  writeKimiConfig(doc)
  return true
}

const updateKimiModel = (alias, updates) => {
  const doc = readKimiConfig()
  const models = getModelTables(doc)
  if (!models[alias]) throw new Error(`模型别名 ${alias} 不存在`)
  // 支持改别名：别名是子表键，改名需校验冲突并同步 default_model 引用
  const newAlias = updates.alias === undefined || updates.alias === alias ? alias : String(updates.alias).trim()
  if (!newAlias) throw new Error('模型别名不能为空')
  if (!KEY_RE.test(newAlias)) throw new Error('模型别名只能包含字母、数字、下划线、中划线、点、冒号、斜杠')
  if (newAlias !== alias && models[newAlias]) throw new Error(`模型别名 ${newAlias} 已存在`)
  const provider = String(updates.provider === undefined ? models[alias].provider : updates.provider).trim()
  if (!provider || !getProviderTables(doc)[provider]) throw new Error(`供应商 ${provider || '(空)'} 不存在`)
  validateModelExtras(updates, (getProviderTables(doc)[provider] || {}).type || '')
  const merged = { ...normalizeModel(alias, models[alias]), ...updates }
  // updates 里显式传空值（''/null/0/[]）表示清除该扩展字段；未传的字段保持 normalize 读出的旧值
  for (const k of MODEL_EXTRA_KEYS) {
    if (k in updates && isEmptyVal(updates[k])) delete merged[k]
  }
  merged.alias = newAlias
  merged.provider = provider
  if (!merged.model) throw new Error('模型 ID 不能为空')
  const next = buildModelToml(merged)
  delete models[alias]
  models[newAlias] = next
  if (newAlias !== alias && doc.default_model === alias) doc.default_model = newAlias
  writeKimiConfig(doc)
  return true
}

const deleteKimiModel = (alias) => {
  const doc = readKimiConfig()
  const models = getModelTables(doc)
  if (!models[alias]) return true
  delete models[alias]
  // 清理悬挂的默认模型引用
  if (doc.default_model === alias) delete doc.default_model
  writeKimiConfig(doc)
  return true
}

// 下发用：别名约定 <provider>/<model>（与官方 managed:kimi-code 的 kimi-code/k3 风格一致）。
// 已存在则更新 provider/model，上下文只增不减（避免下发把用户手工调大的值改小）
const upsertKimiModel = (providerName, modelId, opts) => {
  const alias = `${providerName}/${modelId}`
  const doc = readKimiConfig()
  const models = getModelTables(doc)
  const prev = models[alias] ? normalizeModel(alias, models[alias]) : null
  const ctx = Number(opts && opts.contextWindow) > 0 ? Number(opts.contextWindow) : 0
  const merged = {
    ...(prev || { alias, provider: providerName, model: modelId, maxContextSize: 0, _extra: {} }),
    provider: providerName,
    model: modelId,
    maxContextSize: Math.max(prev ? prev.maxContextSize : 0, ctx),
  }
  // 仅当新值非空才覆盖，避免重下发清掉用户手工设置的显示名
  if (opts && opts.displayName) merged.displayName = String(opts.displayName)
  models[alias] = buildModelToml(merged)
  writeKimiConfig(doc)
  return alias
}

// ==================== default_model ====================

const getKimiDefaultModel = () => readKimiConfig().default_model || ''

const setKimiDefaultModel = (alias) => {
  const doc = readKimiConfig()
  const ref = String(alias || '').trim()
  if (!ref) {
    delete doc.default_model
    writeKimiConfig(doc)
    return true
  }
  if (!getModelTables(doc)[ref]) throw new Error(`模型别名 ${ref} 不存在`)
  doc.default_model = ref
  writeKimiConfig(doc)
  return true
}

// ==================== 目录操作 ====================

const openKimiDir = () => {
  const dir = KIMI_HOME()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const isKimiInstalled = () => fs.existsSync(KIMI_HOME())

module.exports = {
  getKimiHome, getKimiConfigPath,
  readKimiConfig, writeKimiConfig,
  getKimiProviderList, addKimiProvider, updateKimiProvider, deleteKimiProvider, upsertKimiProvider,
  getKimiModelList, addKimiModel, updateKimiModel, deleteKimiModel, upsertKimiModel,
  getKimiDefaultModel, setKimiDefaultModel,
  openKimiDir, isKimiInstalled,
  KIMI_PROVIDER_TYPES, KIMI_CAPABILITIES, KIMI_EFFORTS, MODEL_EXTRA_KEYS,
  // 内部结构函数导出，供测试/复用
  normalizeProvider, buildProviderToml, normalizeModel, buildModelToml,
}
