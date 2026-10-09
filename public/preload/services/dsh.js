const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const yaml = require('js-yaml')

// ==================== DSH（DeepSeek Harness）模型配置 ====================
// 配置文件：<DSH_HOME>/profiles/<profile>/cordis.patch.yml（profile 默认 desktop）
//   DSH_HOME 环境变量优先，macOS/Linux 默认 ~/.dsh；DSH_PROFILE 可指定 profile 名。
// 该文件是顶层 YAML 数组，每项是一条 loader patch 条目 { id, name, config }。
// 本服务只管理其中三条与模型路由相关的条目，其余条目（ui-chat / ui-settings / 用户插件）原样保留：
//   llm-deepseek        @deepseek-ai/dsh-llm-deepseek-api-key   DeepSeek 官方 Messages 路由
//     config.apiKeyEnv            凭据引用名（默认 DEEPSEEK_API_KEY，密钥存 .credentials.yaml）
//     config.baseURL              端点覆盖；缺省用官方 https://api.deepseek.com/anthropic（或 $DEEPSEEK_BASE_URL）
//     config.thinking             enabled | disabled
//     config.reasoningEffort      off | low | high | max（默认 high）
//     config.maxTokens            单次请求输出上限（默认 256000）
//     config.defaultContextWindow 未描述模型的容量回退（默认 1000000）
//     config.models               建议性模型目录；缺省 = 内置 deepseek-flash / deepseek-v4-pro
//   模型条目字段：id / name / description / contextWindow / maxTokens /
//     inputModalities（text|image）/ imagePixelBudget / imageMaxBytes /
//     systemPromptUpdate（仅 in-history）/ toolUpdate（in-history|addition-only）
//   llm-pi-ai           @deepseek-ai/dsh-llm-pi-ai               自定义第三方供应商（pi-ai 多路由）
//     config.providers.<路由名>    每个键即请求用 provider 选择的路由名：
//       displayName / apiKeyEnv / api（openai-completions / openai-responses /
//       anthropic-messages / google-generative-ai）/ baseURL / models（非空，手写路由必需）/
//       compat.thinkingFormat / defaultContextWindow / defaultMaxTokens / headers / retryPolicy 等
//     模型条目字段：id / name / contextWindow / maxTokens / input（text|image）/
//       reasoningEfforts（false 或 { 等级: 线上拼写 }）/ compat
//   agent-default-model @deepseek-ai/dsh-agent-default-model    新会话默认（即「切换」语义）
//     config.provider = 路由名（官方路由固定为 deepseek-official，第三方即 providers 的键）
//     config.model    = 模型 ID；config.reasoningEffort 可选
// 凭据：<DSH_HOME>/.credentials.yaml 顶层 refs 字典（{ 引用名: 密钥 }）。
//   patch 里只出现「凭据引用名」，密钥明文存 refs；本服务只增删受管引用，
//   version / records（OAuth 授权记录）等其余内容原样往返。
// 已知取舍：整档 js-yaml 重写不保留条目间注释（文件头部注释块单独保留，同 minimax / hermes）；
//   含 !!js 表达式等 js-yaml 默认 schema 不认识的标签时解析报错，读写一并阻止（不静默覆盖）。

// ==================== 路径解析 ====================

const DEFAULT_PROFILE = 'desktop'

const getDshHome = () => {
  const env = String(process.env.DSH_HOME || '').trim()
  if (env) return env
  return path.join(os.homedir(), '.dsh')
}

const getDshProfilesDir = () => path.join(getDshHome(), 'profiles')

const listDshProfiles = () => {
  const dir = getDshProfilesDir()
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

// profile 解析：DSH_PROFILE 环境变量优先 → 存在 desktop 用它 → 首个已有 profile → desktop（待创建）
const getDshProfileName = () => {
  const env = String(process.env.DSH_PROFILE || '').trim()
  if (env) return env
  const list = listDshProfiles()
  if (list.includes(DEFAULT_PROFILE)) return DEFAULT_PROFILE
  if (list.length) return list[0]
  return DEFAULT_PROFILE
}

const getDshProfileDir = () => path.join(getDshProfilesDir(), getDshProfileName())
const getDshPatchPath = () => path.join(getDshProfileDir(), 'cordis.patch.yml')
const getDshCredentialsPath = () => path.join(getDshHome(), '.credentials.yaml')

// ==================== 受管条目 / 路由约定 ====================

const OFFICIAL_ENTRY = { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' }
const PIAI_ENTRY = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }
const DEFAULT_MODEL_ENTRY = { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' }

// 官方路由名固定为 deepseek-official（dsh 文档：deepseek-account 为账号登录路由，不在本服务范围）
const OFFICIAL_ROUTE = 'deepseek-official'
const DEFAULT_OFFICIAL_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const OFFICIAL_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'
const DEFAULT_OFFICIAL_CONTEXT_WINDOW = 1000000
const DEFAULT_OFFICIAL_MAX_TOKENS = 256000

// 与 dsh-llm-deepseek 内置目录一致（config.models 缺省时生效，UI 侧作「内置目录」回显）
const DSH_DEFAULT_MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V41-Flash',
    contextWindow: DEFAULT_OFFICIAL_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    systemPromptUpdate: 'in-history',
    toolUpdate: 'addition-only',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    contextWindow: DEFAULT_OFFICIAL_CONTEXT_WINDOW,
  },
]

// pi-ai 支持的协议（与通用库四协议同名，1:1 映射；更多协议可手改配置文件，未知键原样往返）
const DSH_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
// OpenAI Chat 兼容端点的思考参数格式（pi-ai compat.thinkingFormat）
const DSH_THINKING_FORMATS = [
  'openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen',
  'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
]
// 官方 Messages 路由的推理强度
const DSH_EFFORTS = ['off', 'low', 'high', 'max']
// pi-ai 路由的思考等级（agent-default-model.reasoningEffort / 模型 reasoningEfforts 键）
const DSH_PI_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const DSH_THINKING = ['enabled', 'disabled']

const PATCH_HEADER = [
  '# 由 CCConfig（CCSwitch）维护的 dsh profile 补丁层，应用在每个 bundle 层之后：',
  '# 顶层 YAML 数组，元素为 loader patch 条目（id 定向的配置覆盖 / 禁用 / 插入）。',
  '# 未在此文件中出现的 plugin 保持 bundle 默认配置；CCConfig 管理其中的模型路由条目见 README。',
].join('\n')

// ==================== patch 文件读写 ====================

// 保留文件头部注释块（js-yaml 重写不保留注释，这里手工搬回，避免丢掉文件用途说明）
const splitLeadingHeader = (raw) => {
  const lines = String(raw || '').split('\n')
  let lastComment = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*#/.test(lines[i])) lastComment = i + 1
    else if (lines[i].trim() !== '') break
  }
  return lines.slice(0, lastComment).join('\n')
}

const parseFail = (p, e) =>
  new Error(`cordis.patch.yml 解析失败，已阻止修改（请先在 dsh 中修复 YAML 语法）: ${e.message} [${p}]`)

const loadPatch = () => {
  const p = getDshPatchPath()
  if (!fs.existsSync(p)) return { entries: [], header: '', exists: false, path: p }
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  let doc
  try {
    doc = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA })
  } catch (e) {
    throw parseFail(p, e)
  }
  // 顶层必须是数组（空文件 / null 视为空数组，保留原文件不动由写入时补齐）
  if (doc === null || doc === undefined) return { entries: [], header: splitLeadingHeader(raw), exists: true, path: p }
  if (!Array.isArray(doc)) throw new Error(`cordis.patch.yml 顶层不是 YAML 数组，已阻止修改 [${p}]`)
  return { entries: doc, header: splitLeadingHeader(raw), exists: true, path: p }
}

const savePatch = (entries, header) => {
  const p = getDshPatchPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const body = yaml.dump(entries, { lineWidth: -1, noRefs: true })
  fs.writeFileSync(p, `${header || PATCH_HEADER}\n${body}`, { encoding: 'utf-8' })
  return true
}

// 条目匹配：id 优先，其次 name（用户可能手写只有 name 的条目）
const matchesEntry = (entry, spec) =>
  !!entry && typeof entry === 'object' && (entry.id === spec.id || entry.name === spec.name)

const findEntry = (entries, spec) => entries.find((e) => matchesEntry(e, spec)) || null

const readManagedEntry = (spec) => findEntry(loadPatch().entries, spec)

// 写入受管条目：已有条目原地更新（保留其未知顶层键），否则追加到末尾
const writeManagedEntry = (spec, config) => {
  const { entries, header } = loadPatch()
  const idx = entries.findIndex((e) => matchesEntry(e, spec))
  if (idx === -1) {
    entries.push({ id: spec.id, name: spec.name, config })
  } else {
    const prev = entries[idx] && typeof entries[idx] === 'object' ? entries[idx] : {}
    entries[idx] = { ...prev, id: prev.id || spec.id, name: spec.name, config }
  }
  savePatch(entries, header)
  return true
}

const removeManagedEntry = (spec) => {
  const { entries, header, exists } = loadPatch()
  if (!exists) return true
  const idx = entries.findIndex((e) => matchesEntry(e, spec))
  if (idx === -1) return true
  entries.splice(idx, 1)
  savePatch(entries, header)
  return true
}

// ==================== 凭据文件（.credentials.yaml 顶层 refs） ====================

const readDshCredentials = () => {
  const p = getDshCredentialsPath()
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    const doc = yaml.load(raw, { schema: yaml.DEFAULT_SCHEMA })
    if (doc === null || doc === undefined) return {}
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('顶层不是 YAML 映射')
    }
    return doc
  } catch (e) {
    throw new Error(`.credentials.yaml 解析失败，已阻止修改（请先在 dsh 中修复）: ${e.message} [${p}]`)
  }
}

const writeDshCredentials = (doc) => {
  const p = getDshCredentialsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, yaml.dump(doc || {}, { lineWidth: -1, noRefs: true }), { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* 非 POSIX 平台忽略 */ }
  return true
}

const refsOf = (doc) => {
  if (!doc.refs || typeof doc.refs !== 'object' || Array.isArray(doc.refs)) doc.refs = {}
  return doc.refs
}

// 读取某凭据引用的明文密钥（供 UI 回显 / 模型列表拉取鉴权）
const getDshCredential = (name) => {
  const key = String(name || '').trim()
  if (!key) return ''
  try {
    const v = refsOf(readDshCredentials())[key]
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

const setDshCredential = (name, value) => {
  const key = String(name || '').trim()
  if (!key) throw new Error('凭据引用名不能为空')
  const doc = readDshCredentials()
  const refs = refsOf(doc)
  const next = String(value === undefined || value === null ? '' : value)
  if (next) refs[key] = next
  else delete refs[key]
  writeDshCredentials(doc)
  return true
}

const deleteDshCredential = (name) => {
  const key = String(name || '').trim()
  if (!key) return true
  const doc = readDshCredentials()
  const refs = refsOf(doc)
  if (!(key in refs)) return true
  delete refs[key]
  writeDshCredentials(doc)
  return true
}

// patch 中已被引用的凭据名（官方条目 + 全部 pi-ai 供应商）——用于「删除后无引用才清理密钥」
const referencedCredentialNames = (entries) => {
  const names = new Set()
  const official = findEntry(entries, OFFICIAL_ENTRY)
  if (official && official.config && typeof official.config === 'object') {
    names.add(String(official.config.apiKeyEnv || DEFAULT_OFFICIAL_API_KEY_ENV).trim())
  }
  const piai = findEntry(entries, PIAI_ENTRY)
  const providers = piai && piai.config && typeof piai.config === 'object' ? piai.config.providers : null
  if (providers && typeof providers === 'object') {
    for (const profile of Object.values(providers)) {
      if (profile && typeof profile === 'object' && profile.apiKeyEnv) {
        names.add(String(profile.apiKeyEnv).trim())
      }
    }
  }
  return names
}

// ==================== 归一化 / 构建 ====================

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' && isFinite(v) ? v : 0)
const toModalities = (v) => (Array.isArray(v) ? v.filter((m) => typeof m === 'string') : [])

// 受管字段之外的键收进 _extra 原样往返（description / systemPromptUpdate / reasoningEfforts / compat 等）
const splitExtra = (obj, managed) => {
  const extra = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (!managed.includes(k)) extra[k] = v
  }
  return extra
}

// -------- 官方条目（llm-deepseek） --------

const OFFICIAL_MANAGED = ['apiKeyEnv', 'baseURL', 'thinking', 'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'models']
const OFFICIAL_MODEL_MANAGED = ['id', 'name', 'contextWindow', 'maxTokens', 'inputModalities']

const officialModelToUi = (m) => {
  const raw = m && typeof m === 'object' ? m : {}
  return {
    modelId: String(raw.id || '').trim(),
    name: String(raw.name || '').trim(),
    contextWindow: toNumber(raw.contextWindow),
    maxTokens: toNumber(raw.maxTokens),
    image: toModalities(raw.inputModalities).includes('image'),
    _raw: splitExtra(raw, OFFICIAL_MODEL_MANAGED),
  }
}

const officialModelToYaml = (m) => {
  const id = String(m?.modelId || '').trim()
  if (!id) return null
  const out = { ...((m._raw && typeof m._raw === 'object') ? m._raw : {}) }
  out.id = id
  if (String(m.name || '').trim()) out.name = String(m.name).trim()
  else delete out.name
  if (toNumber(m.contextWindow) > 0) out.contextWindow = toNumber(m.contextWindow)
  else delete out.contextWindow
  if (toNumber(m.maxTokens) > 0) out.maxTokens = toNumber(m.maxTokens)
  else delete out.maxTokens
  if (m.image) out.inputModalities = ['text', 'image']
  else delete out.inputModalities
  return out
}

// UI：官方条目；未配置返回 null。models 缺省时回显内置目录并标记 modelsExplicit=false
const normalizeOfficial = (config) => {
  const cfg = config && typeof config === 'object' ? config : {}
  const explicit = Array.isArray(cfg.models) && cfg.models.length > 0
  const models = explicit
    ? cfg.models.map(officialModelToUi).filter((m) => m.modelId)
    : DSH_DEFAULT_MODELS.map(officialModelToUi)
  const apiKeyEnv = String(cfg.apiKeyEnv || DEFAULT_OFFICIAL_API_KEY_ENV).trim() || DEFAULT_OFFICIAL_API_KEY_ENV
  return {
    apiKeyEnv,
    apiKey: getDshCredential(apiKeyEnv),
    baseURL: String(cfg.baseURL || ''),
    thinking: DSH_THINKING.includes(cfg.thinking) ? cfg.thinking : 'enabled',
    reasoningEffort: DSH_EFFORTS.includes(cfg.reasoningEffort) ? cfg.reasoningEffort : 'high',
    maxTokens: toNumber(cfg.maxTokens) || DEFAULT_OFFICIAL_MAX_TOKENS,
    defaultContextWindow: toNumber(cfg.defaultContextWindow) || DEFAULT_OFFICIAL_CONTEXT_WINDOW,
    models,
    modelsExplicit: explicit,
    _extra: splitExtra(cfg, OFFICIAL_MANAGED),
  }
}

const getDshOfficial = () => {
  const entry = readManagedEntry(OFFICIAL_ENTRY)
  return entry ? normalizeOfficial(entry.config) : null
}

// 保存官方条目（enabled=false 时移除条目；密钥写入凭据引用，apiKeyEnv 变更时迁移旧引用）
const saveDshOfficial = (input = {}) => {
  if (input.enabled === false) return removeDshOfficial()
  const prevEntry = readManagedEntry(OFFICIAL_ENTRY)
  const prev = prevEntry ? normalizeOfficial(prevEntry.config) : null
  const apiKeyEnv = String(input.apiKeyEnv || (prev && prev.apiKeyEnv) || DEFAULT_OFFICIAL_API_KEY_ENV).trim()
  if (!apiKeyEnv) throw new Error('凭据引用名（apiKeyEnv）不能为空')
  const baseURL = String(input.baseURL === undefined ? (prev ? prev.baseURL : '') : input.baseURL).trim()
  if (baseURL && !/^https?:\/\//i.test(baseURL)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
  const thinking = DSH_THINKING.includes(input.thinking) ? input.thinking : (prev ? prev.thinking : 'enabled')
  const reasoningEffort = DSH_EFFORTS.includes(input.reasoningEffort)
    ? input.reasoningEffort
    : (prev ? prev.reasoningEffort : 'high')
  const maxTokens = toNumber(input.maxTokens) || (prev ? prev.maxTokens : DEFAULT_OFFICIAL_MAX_TOKENS)
  const defaultContextWindow = toNumber(input.defaultContextWindow) || (prev ? prev.defaultContextWindow : DEFAULT_OFFICIAL_CONTEXT_WINDOW)
  const models = Array.isArray(input.models) ? input.models : (prev ? prev.models : [])
  const extra = (prev && prev._extra) || {}

  // 密钥：clearApiKey → 删除；传了值 → 覆盖；未传 → 保留原值（apiKeyEnv 变更时迁移旧引用）
  const prevApiKeyEnv = prev ? prev.apiKeyEnv : ''
  if (input.clearApiKey) {
    deleteDshCredential(apiKeyEnv)
  } else if (String(input.apiKey || '').trim()) {
    setDshCredential(apiKeyEnv, String(input.apiKey).trim())
  } else if (prevApiKeyEnv && prevApiKeyEnv !== apiKeyEnv) {
    const moving = getDshCredential(prevApiKeyEnv)
    if (moving) setDshCredential(apiKeyEnv, moving)
  }

  const config = { ...extra }
  config.apiKeyEnv = apiKeyEnv
  if (baseURL) config.baseURL = baseURL
  else delete config.baseURL
  config.thinking = thinking
  config.reasoningEffort = reasoningEffort
  config.maxTokens = maxTokens
  config.defaultContextWindow = defaultContextWindow
  const modelList = models.map(officialModelToYaml).filter(Boolean)
  if (modelList.length) config.models = modelList
  else delete config.models
  writeManagedEntry(OFFICIAL_ENTRY, config)
  // 目录变化可能让默认指针悬空（恢复内置目录 / 删除被设为默认的模型）：改指目录内首个模型
  syncDefaultPointerFor(OFFICIAL_ROUTE)
  // 旧引用迁移完成后清理（必须在新条目落盘后判定：仍被其他条目引用则保留）
  if (prevApiKeyEnv && prevApiKeyEnv !== apiKeyEnv) {
    const { entries } = loadPatch()
    if (!referencedCredentialNames(entries).has(prevApiKeyEnv)) deleteDshCredential(prevApiKeyEnv)
  }
  return true
}

// 移除官方路由条目：级联清理默认指针（改指首个剩余第三方供应商，无剩余则移除条目）与无引用密钥
const removeDshOfficial = () => {
  const entry = readManagedEntry(OFFICIAL_ENTRY)
  if (!entry) return true
  const apiKeyEnv = String((entry.config || {}).apiKeyEnv || DEFAULT_OFFICIAL_API_KEY_ENV).trim()
  removeManagedEntry(OFFICIAL_ENTRY)
  // 级联：默认模型指向官方路由时不得留悬空指针
  const def = getDshDefaultModel()
  if (def && def.provider === OFFICIAL_ROUTE) {
    const remaining = getDshProviderList()
    if (remaining.length) setDshDefaultModel(remaining[0].route, remaining[0].models[0]?.modelId || '', '')
    else removeManagedEntry(DEFAULT_MODEL_ENTRY)
  }
  const { entries } = loadPatch()
  if (!referencedCredentialNames(entries).has(apiKeyEnv)) deleteDshCredential(apiKeyEnv)
  return true
}

// -------- 第三方供应商（llm-pi-ai providers） --------

const PIAI_PROVIDER_MANAGED = ['displayName', 'apiKeyEnv', 'api', 'baseURL', 'models']
const PIAI_MODEL_MANAGED = ['id', 'name', 'contextWindow', 'maxTokens', 'input']

const piaiModelToUi = (m) => {
  const raw = m && typeof m === 'object' ? m : {}
  return {
    modelId: String(raw.id || '').trim(),
    name: String(raw.name || '').trim(),
    contextWindow: toNumber(raw.contextWindow),
    maxTokens: toNumber(raw.maxTokens),
    image: toModalities(raw.input).includes('image'),
    _raw: splitExtra(raw, PIAI_MODEL_MANAGED),
  }
}

const piaiModelToYaml = (m) => {
  const id = String(m?.modelId || '').trim()
  if (!id) return null
  const out = { ...((m._raw && typeof m._raw === 'object') ? m._raw : {}) }
  out.id = id
  if (String(m.name || '').trim()) out.name = String(m.name).trim()
  else delete out.name
  if (toNumber(m.contextWindow) > 0) out.contextWindow = toNumber(m.contextWindow)
  else delete out.contextWindow
  if (toNumber(m.maxTokens) > 0) out.maxTokens = toNumber(m.maxTokens)
  else delete out.maxTokens
  if (m.image) out.input = ['text', 'image']
  else delete out.input
  return out
}

// 通用库供应商名可能是中文/任意符号，而路由名要作为 provider 键与凭据引用名使用，
// 需确定性清洗（同一下发名永远得到同一路由 → upsert 幂等）
const ROUTE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const hashName = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
const providerRouteFor = (name) => {
  const raw = String(name || '').trim()
  const lower = raw.toLocaleLowerCase()
  // 合法名只做小写归一（'Kimi' → 'kimi'），避免无谓的哈希后缀
  if (ROUTE_RE.test(lower)) return lower
  const base = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'provider'
  return `${base}-${hashName(raw)}`
}

const apiKeyEnvFor = (route) =>
  `${String(route || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'PROVIDER'}_API_KEY`

const providersOf = (configOfEntry) => {
  const cfg = configOfEntry && typeof configOfEntry === 'object' ? configOfEntry : {}
  if (!cfg.providers || typeof cfg.providers !== 'object' || Array.isArray(cfg.providers)) return {}
  return cfg.providers
}

const normalizeProvider = (route, profile) => {
  const p = profile && typeof profile === 'object' ? profile : {}
  const compat = p.compat && typeof p.compat === 'object' && !Array.isArray(p.compat) ? p.compat : {}
  const apiKeyEnv = String(p.apiKeyEnv || '').trim()
  return {
    route,
    displayName: String(p.displayName || route),
    apiKeyEnv: apiKeyEnv || apiKeyEnvFor(route),
    apiKey: apiKeyEnv ? getDshCredential(apiKeyEnv) : '',
    api: String(p.api || '').trim(),
    baseURL: String(p.baseURL || '').trim(),
    thinkingFormat: String(compat.thinkingFormat || '').trim(),
    models: (Array.isArray(p.models) ? p.models : []).map(piaiModelToUi).filter((m) => m.modelId),
    _extra: splitExtra(p, PIAI_PROVIDER_MANAGED),
    _compatExtra: splitExtra(compat, ['thinkingFormat']),
  }
}

const buildProviderProfile = (ui) => {
  const out = { ...((ui._extra && typeof ui._extra === 'object') ? ui._extra : {}) }
  out.displayName = String(ui.displayName || ui.route || '').trim()
  out.apiKeyEnv = String(ui.apiKeyEnv || '').trim()
  const api = String(ui.api || '').trim()
  if (!DSH_PROTOCOLS.includes(api)) {
    throw new Error(`不支持的协议 ${api || '(空)'}（可选：${DSH_PROTOCOLS.join(' / ')}）`)
  }
  out.api = api
  const baseURL = String(ui.baseURL || '').trim()
  if (!baseURL) throw new Error(`供应商「${out.displayName}」必须配置 Base URL`)
  if (!/^https?:\/\//i.test(baseURL)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
  out.baseURL = baseURL
  // compat：thinkingFormat 受管，其余子键原样保留；全部为空则移除 compat
  const compatExtra = (ui._compatExtra && typeof ui._compatExtra === 'object') ? { ...ui._compatExtra } : {}
  const thinkingFormat = String(ui.thinkingFormat || '').trim()
  if (thinkingFormat) compatExtra.thinkingFormat = thinkingFormat
  else delete compatExtra.thinkingFormat
  if (Object.keys(compatExtra).length) out.compat = compatExtra
  else delete out.compat
  const models = (ui.models || []).map(piaiModelToYaml).filter(Boolean)
  if (models.length) out.models = models
  else delete out.models
  return out
}

// 读取全部第三方供应商（保持文件内顺序）
const getDshProviderList = () => {
  const entry = readManagedEntry(PIAI_ENTRY)
  const providers = providersOf(entry && entry.config)
  return Object.entries(providers).map(([route, profile]) => normalizeProvider(route, profile))
}

// 写入 providers 字典（保留 llm-pi-ai 条目 config 的其他键，如 retryPolicy）
const commitProviders = (mutate) => {
  const { entries, header } = loadPatch()
  const idx = entries.findIndex((e) => matchesEntry(e, PIAI_ENTRY))
  const prevConfig = idx === -1 ? {} : (entries[idx].config && typeof entries[idx].config === 'object' ? entries[idx].config : {})
  const providers = { ...providersOf(prevConfig) }
  mutate(providers)
  const config = { ...prevConfig, providers }
  if (idx === -1) entries.push({ id: PIAI_ENTRY.id, name: PIAI_ENTRY.name, config })
  else entries[idx] = { ...entries[idx], id: entries[idx].id || PIAI_ENTRY.id, name: PIAI_ENTRY.name, config }
  savePatch(entries, header)
  return true
}

const addDshProvider = (input = {}) => {
  const displayName = String(input.displayName || input.name || '').trim()
  if (!displayName) throw new Error('供应商名称不能为空')
  const route = providerRouteFor(input.route || displayName)
  const existing = getDshProviderList()
  if (existing.some((p) => p.route === route)) throw new Error(`供应商路由 ${route} 已存在`)
  const apiKeyEnv = String(input.apiKeyEnv || apiKeyEnvFor(route)).trim()
  const apiKey = String(input.apiKey || '').trim()
  const profile = buildProviderProfile({
    route, displayName, apiKeyEnv, apiKey,
    api: input.api || 'openai-completions',
    baseURL: input.baseURL,
    thinkingFormat: input.thinkingFormat,
    models: input.models || [],
    _extra: {},
    _compatExtra: {},
  })
  // 手写路由必须带非空模型列表（pi-ai 校验），无模型时至少写入一个占位模型由用户随后补全
  if (!profile.models) throw new Error('第三方供应商至少需要一个模型（pi-ai 手写路由要求非空 models）')
  if (apiKey) setDshCredential(apiKeyEnv, apiKey)
  commitProviders((providers) => { providers[route] = profile })
  return route
}

const updateDshProvider = (route, updates = {}) => {
  const key = String(route || '').trim()
  if (!key) throw new Error('供应商路由不能为空')
  const list = getDshProviderList()
  const prev = list.find((p) => p.route === key)
  if (!prev) throw new Error(`供应商 ${key} 不存在`)
  const nextApiKeyEnv = String(updates.apiKeyEnv === undefined ? prev.apiKeyEnv : updates.apiKeyEnv).trim() || apiKeyEnvFor(key)
  const merged = {
    ...prev,
    displayName: updates.displayName !== undefined ? String(updates.displayName).trim() : prev.displayName,
    apiKeyEnv: nextApiKeyEnv,
    api: updates.api !== undefined ? String(updates.api).trim() : prev.api,
    baseURL: updates.baseURL !== undefined ? String(updates.baseURL).trim() : prev.baseURL,
    thinkingFormat: updates.thinkingFormat !== undefined ? String(updates.thinkingFormat).trim() : prev.thinkingFormat,
    models: Array.isArray(updates.models) ? updates.models : prev.models,
  }
  if (!merged.displayName) throw new Error('供应商名称不能为空')
  if (updates.clearApiKey) deleteDshCredential(nextApiKeyEnv)
  else if (String(updates.apiKey || '').trim()) setDshCredential(nextApiKeyEnv, String(updates.apiKey).trim())
  else if (prev.apiKeyEnv && prev.apiKeyEnv !== nextApiKeyEnv) {
    const moving = getDshCredential(prev.apiKeyEnv)
    if (moving) setDshCredential(nextApiKeyEnv, moving)
  }
  const profile = buildProviderProfile(merged)
  // 手写路由（pi-ai 不在已装目录内）必须保留非空 models，否则该路由无法服务
  if (!profile.models) throw new Error(`供应商「${merged.displayName}」至少需要一个模型`)
  commitProviders((providers) => { providers[key] = profile })
  // 模型目录变动可能让默认指针悬空（删除/改名被设为默认的模型）：改指目录内首个模型
  syncDefaultPointerFor(key)
  if (prev.apiKeyEnv && prev.apiKeyEnv !== nextApiKeyEnv) {
    const { entries } = loadPatch()
    if (!referencedCredentialNames(entries).has(prev.apiKeyEnv)) deleteDshCredential(prev.apiKeyEnv)
  }
  return true
}

const deleteDshProvider = (route) => {
  const key = String(route || '').trim()
  if (!key) return true
  const prev = getDshProviderList().find((p) => p.route === key)
  if (!prev) return true // 幂等：可能刚在 dsh 内被删除
  commitProviders((providers) => { delete providers[key] })
  // 级联：默认模型指针悬空时改指官方路由或首个剩余供应商，无剩余则移除条目
  const def = getDshDefaultModel()
  if (def && def.provider === key) {
    const remaining = getDshProviderList()
    if (getDshOfficial()) setDshDefaultModel(OFFICIAL_ROUTE, defaultModelIdOf(OFFICIAL_ROUTE), '')
    else if (remaining.length) setDshDefaultModel(remaining[0].route, remaining[0].models[0]?.modelId || '', '')
    else removeManagedEntry(DEFAULT_MODEL_ENTRY)
  }
  const { entries } = loadPatch()
  if (prev.apiKeyEnv && !referencedCredentialNames(entries).has(prev.apiKeyEnv)) deleteDshCredential(prev.apiKeyEnv)
  return true
}

// -------- 默认模型（agent-default-model） --------

// 供应商可用模型 ID：官方未显式配置时用内置目录；第三方无显式列表时返回空数组（来自已装目录，不校验）
const defaultModelIdOf = (providerRoute) => {
  if (providerRoute === OFFICIAL_ROUTE) {
    const official = getDshOfficial()
    return (official ? official.models : DSH_DEFAULT_MODELS.map(officialModelToUi))[0]?.modelId || ''
  }
  const p = getDshProviderList().find((x) => x.route === providerRoute)
  return p && p.models[0] ? p.models[0].modelId : ''
}

const modelIdsOf = (providerRoute) => {
  if (providerRoute === OFFICIAL_ROUTE) {
    const official = getDshOfficial()
    if (!official) return DSH_DEFAULT_MODELS.map((m) => m.id)
    return official.models.map((m) => m.modelId)
  }
  const p = getDshProviderList().find((x) => x.route === providerRoute)
  return p ? p.models.map((m) => m.modelId) : []
}

const getDshDefaultModel = () => {
  const entry = readManagedEntry(DEFAULT_MODEL_ENTRY)
  if (!entry) return null
  const cfg = entry.config && typeof entry.config === 'object' ? entry.config : {}
  const provider = String(cfg.provider || '').trim()
  const modelId = String(cfg.model || '').trim()
  if (!provider || !modelId) return null
  return { provider, modelId, reasoningEffort: String(cfg.reasoningEffort || '').trim() }
}

// 目录变动后的兜底：默认指针指向的模型已不在目录内 → 改指目录内首个模型（不动则无需写盘）
const syncDefaultPointerFor = (route) => {
  const def = getDshDefaultModel()
  if (!def || def.provider !== route) return false
  const ids = modelIdsOf(route)
  if (!ids.length || ids.includes(def.modelId)) return false
  setDshDefaultModel(route, ids[0], '')
  return true
}

// 设为默认（「切换」语义）：写 agent-default-model 条目的 provider / model（reasoningEffort 可选）
const setDshDefaultModel = (providerRoute, modelId, reasoningEffort) => {
  const provider = String(providerRoute || '').trim()
  const model = String(modelId || '').trim()
  if (!provider) throw new Error('请选择供应商路由')
  if (!model) throw new Error('请选择模型')
  // 存在性校验：官方路由需条目已配置；第三方路由需在 providers 字典中；模型在显式列表内才校验
  if (provider === OFFICIAL_ROUTE) {
    if (!readManagedEntry(OFFICIAL_ENTRY)) throw new Error('DeepSeek 官方路由尚未配置，无法设为默认')
  } else if (!getDshProviderList().some((p) => p.route === provider)) {
    throw new Error(`供应商路由 ${provider} 不存在，无法设为默认`)
  }
  const ids = modelIdsOf(provider)
  if (ids.length && !ids.includes(model)) throw new Error(`模型 ${model} 不在供应商 ${provider} 的目录内`)
  const entry = readManagedEntry(DEFAULT_MODEL_ENTRY)
  const prevConfig = entry && entry.config && typeof entry.config === 'object' ? entry.config : {}
  const config = { ...splitExtra(prevConfig, ['provider', 'model', 'reasoningEffort']), provider, model }
  // reasoningEffort：未显式传入时，同一供应商内切换模型保留原强度（dsh 自己写入的强度不因点星标丢失），
  // 跨供应商切换则清空（各供应商可选强度取值不同）
  const effort = reasoningEffort === undefined
    ? (String(prevConfig.provider || '').trim() === provider ? String(prevConfig.reasoningEffort || '').trim() : '')
    : String(reasoningEffort || '').trim()
  if (effort) config.reasoningEffort = effort
  writeManagedEntry(DEFAULT_MODEL_ENTRY, config)
  return true
}

// ==================== 下发用 upsert（dispatch.js 调用，语义同 hermes.upsert*） ====================

// 存在则合并更新（空值不覆盖既有 displayName/api/baseURL/apiKey），否则创建；
// 密钥写入该路由的凭据引用（apiKeyEnv 缺省 = 路由名大写 + _API_KEY）
const upsertDshProvider = (route, cfg = {}) => {
  const key = providerRouteFor(route)
  if (!key) throw new Error('供应商路由不能为空')
  const api = String(cfg.api || '').trim()
  if (api && !DSH_PROTOCOLS.includes(api)) {
    throw new Error(`供应商「${cfg.name || key}」协议为 ${api}，dsh 仅支持 ${DSH_PROTOCOLS.join(' / ')}`)
  }
  const baseURL = String(cfg.baseURL || cfg.baseUrl || '').trim()
  const apiKey = String(cfg.apiKey || '').trim()
  const existing = getDshProviderList().find((p) => p.route === key)
  if (!existing) {
    if (!baseURL) throw new Error(`供应商 ${cfg.name || key} 缺少 Base URL`)
    if (!api) throw new Error(`供应商 ${cfg.name || key} 缺少协议（api）`)
  }
  const apiKeyEnv = String((existing && existing.apiKeyEnv) || apiKeyEnvFor(key)).trim() || apiKeyEnvFor(key)
  const merged = {
    ...(existing || {}),
    route: key,
    displayName: String(cfg.name || '').trim() || (existing && existing.displayName) || key,
    apiKeyEnv,
    api: api || (existing && existing.api) || '',
    baseURL: baseURL || (existing && existing.baseURL) || '',
    thinkingFormat: (existing && existing.thinkingFormat) || '',
    models: (existing && existing.models) || [],
    _extra: (existing && existing._extra) || {},
    _compatExtra: (existing && existing._compatExtra) || {},
  }
  const profile = buildProviderProfile(merged)
  if (!profile.models) profile.models = []
  if (apiKey) setDshCredential(apiKeyEnv, apiKey)
  commitProviders((providers) => { providers[key] = profile })
  return true
}

// 模型已存在时只刷新传入的受管字段（未传保留既有值），不存在则新建；返回模型 ID
const upsertDshModel = (route, modelId, opts = {}) => {
  const key = providerRouteFor(route)
  const id = String(modelId || '').trim()
  if (!id) throw new Error('模型 ID 不能为空')
  const list = getDshProviderList()
  const prev = list.find((p) => p.route === key)
  if (!prev) throw new Error(`供应商 ${key} 不存在`)
  const models = [...prev.models]
  const idx = models.findIndex((m) => m.modelId === id)
  const base = idx === -1
    ? { modelId: id, name: '', contextWindow: 0, maxTokens: 0, image: false, _raw: {} }
    : { ...models[idx] }
  if (String(opts.name || '').trim()) base.name = String(opts.name).trim()
  if (toNumber(opts.contextWindow) > 0) base.contextWindow = toNumber(opts.contextWindow)
  if (toNumber(opts.maxTokens) > 0) base.maxTokens = toNumber(opts.maxTokens)
  if (opts.image === true) base.image = true
  if (idx === -1) models.push(base)
  else models[idx] = base
  const profile = buildProviderProfile({ ...prev, models })
  commitProviders((providers) => { providers[key] = profile })
  return id
}

// ==================== 汇总 / 目录 / 检测 ====================

const getDshConfig = () => {
  const official = getDshOfficial()
  const providers = getDshProviderList()
  const entry = readManagedEntry(DEFAULT_MODEL_ENTRY)
  const patch = loadPatch()
  return {
    profile: getDshProfileName(),
    profiles: listDshProfiles(),
    patchPath: patch.path,
    credentialsPath: getDshCredentialsPath(),
    patchExists: patch.exists,
    official,
    officialRoute: OFFICIAL_ROUTE,
    providers,
    defaultModelEntry: !!entry,
    defaultModel: getDshDefaultModel(),
    defaults: {
      officialBaseURL: OFFICIAL_DEFAULT_BASE_URL,
      officialApiKeyEnv: DEFAULT_OFFICIAL_API_KEY_ENV,
      officialContextWindow: DEFAULT_OFFICIAL_CONTEXT_WINDOW,
      officialMaxTokens: DEFAULT_OFFICIAL_MAX_TOKENS,
    },
  }
}

const openDshDir = () => {
  const dir = getDshHome()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const openDshConfigFile = () => {
  const p = getDshPatchPath()
  if (!fs.existsSync(p)) savePatch([], PATCH_HEADER)
  try { window.utools.shellOpenPath(p) } catch { /* ignore */ }
}

const openDshCredentialsFile = () => {
  const p = getDshCredentialsPath()
  if (!fs.existsSync(p)) writeDshCredentials({ version: 1, refs: {} })
  try { window.utools.shellOpenPath(p) } catch { /* ignore */ }
}

const isDshInstalled = () => fs.existsSync(getDshHome())

// 有任一受管条目即视为有数据（detectAgentsConfig 用，不创建文件）
const hasDshConfig = () => {
  try {
    const { entries } = loadPatch()
    if (findEntry(entries, OFFICIAL_ENTRY)) return true
    if (findEntry(entries, DEFAULT_MODEL_ENTRY)) return true
    return Object.keys(providersOf((findEntry(entries, PIAI_ENTRY) || {}).config)).length > 0
  } catch {
    return false
  }
}

module.exports = {
  // 路径
  getDshHome, getDshProfilesDir, listDshProfiles, getDshProfileName, getDshProfileDir,
  getDshPatchPath, getDshCredentialsPath,
  // 原始读写（诊断 / 测试用）
  loadPatch, savePatch, readDshCredentials, writeDshCredentials,
  // 凭据引用
  getDshCredential, setDshCredential, deleteDshCredential,
  // 官方路由
  getDshOfficial, saveDshOfficial, removeDshOfficial,
  // 第三方供应商
  getDshProviderList, addDshProvider, updateDshProvider, deleteDshProvider,
  upsertDshProvider, providerRouteFor, apiKeyEnvFor, upsertDshModel,
  // 默认模型
  getDshDefaultModel, setDshDefaultModel,
  // 汇总 / 目录 / 检测
  getDshConfig, openDshDir, openDshConfigFile, openDshCredentialsFile, isDshInstalled, hasDshConfig,
  // 常量
  OFFICIAL_ROUTE, OFFICIAL_DEFAULT_BASE_URL, DEFAULT_OFFICIAL_API_KEY_ENV,
  DSH_PROTOCOLS, DSH_THINKING_FORMATS, DSH_EFFORTS, DSH_PI_EFFORTS, DSH_THINKING, DSH_DEFAULT_MODELS,
}
