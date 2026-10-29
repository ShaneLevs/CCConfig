const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { t } = require('./i18n')
const { isDirEntry, countEntries, rmEntry } = require('./fs-utils')

// ==================== Cline（AI 编程 agent，命令 `cline`）====================
// 存储位置（与 CLI / Desktop / SDK 共用；IDE 扩展的供应商配置在编辑器 globalState 里，
// 不在文件系统，本服务只管文件侧）：
//   <CLINE_DATA>/settings/providers.json        供应商连接信息 + 当前使用
//   <CLINE_DATA>/settings/models.json           模型目录（上下文 / 输出上限 / 能力）
//   <CLINE_DATA>/settings/cline_mcp_settings.json MCP 服务器（IDE 扩展与本文件共享）
//   <CLINE_DIR>/skills/<name>/SKILL.md          Skill（.disabled/ 目录做启停）
//   <CLINE_DATA>/sessions/<id>/<id>.json        会话档（metadata.usage 为用量来源）
// 目录解析（与 @cline/shared 的 resolveClineDir / resolveClineDataDir 一致）：
//   CLINE_DIR 覆盖 ~/.cline；CLINE_DATA_DIR 覆盖 ~/.cline/data
//
// ⚠️ 写入纪律（已用 Cline 3.0.74 CLI 实测验证，破坏任一条 Cline 会静默丢弃整条目或整档）：
//   - providers.json 的 version 必须是字面量 1
//   - 每个 provider 的 updatedAt 必须是 ISO datetime（toISOString）
//   - tokenSource 只能是 manual | oauth | migration，不能自造
//   - 文件权限 0600（Cline 自己也按 0600 写）
//   - 解析失败必须抛错中止，绝不「读成空 → 全量写回」（否则用户所有供应商配置一次清零）
//   - settings.reasoning 必须通过 zod 校验，否则**这一个 provider 会被静默丢弃**：
//     effort 只能是 none | minimal | low | medium | high | xhigh | max（`default`、`turbo`、大写都算非法）；
//     enabled 取不到布尔值、budgetTokens 不是正整数同样判废。判废后 lastUsedProvider 指向不存在的条目，
//     Cline 会静默回落内置 cline 账号，表现就是「模型配置不生效」。
//   - settings.protocol / client 来自枚举（openai-chat / openai-responses / openai-r1 / anthropic / gemini / ai-sdk
//     与 ai-sdk / ai-sdk-community / openai / openai-compatible / openai-r1 / gemini / bedrock / custom / fetch / vertex），
//     非法值同样整条目丢弃。
//   - 读入时 resolve：条目缺失 / settings.provider 与键不一致 → 视为未配置（见 effectiveLastUsedProvider）
// 已知取舍：JSON 重写不保留原文件的键顺序与缩进（Cline 自身也是整档序列化）。

const clineDir = () => process.env.CLINE_DIR || path.join(os.homedir(), '.cline')
const clineDataDir = () => process.env.CLINE_DATA_DIR || path.join(clineDir(), 'data')
const settingsDir = () => path.join(clineDataDir(), 'settings')
const providersPath = () => path.join(settingsDir(), 'providers.json')
const modelsPath = () => path.join(settingsDir(), 'models.json')
const globalSettingsPath = () => path.join(settingsDir(), 'global-settings.json')
const mcpSettingsPath = () => path.join(settingsDir(), 'cline_mcp_settings.json')
const skillsPath = () => path.join(clineDir(), 'skills')
const sessionsDir = () => path.join(clineDataDir(), 'sessions')

const getClineDir = clineDir
const getClineDataDir = clineDataDir
const getClineSettingsDir = settingsDir
const getClineProvidersPath = providersPath
const getClineModelsPath = modelsPath
const getClineGlobalSettingsPath = globalSettingsPath
const getClineMcpSettingsPath = mcpSettingsPath
const getClineSkillsPath = skillsPath
const getClineSessionsDir = sessionsDir

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : v == null ? 0 : Number(v) || 0)
const PROVIDER_ID_RE = /^[\w.:\-/]+$/
const MODEL_ID_RE = /^[\w.:\-/@]+$/
// Cline 的 provider 标识（zod: 小写字母数字开头、只含字母数字与中划线）
const PROVIDER_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/i
// zod 的 z.string().datetime()：必须带时间与时区
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
// settings.protocol / settings.client 的合法枚举（@cline/llms）。写错任一个 → Cline 整条目丢弃。
const CLINE_PROTOCOLS = ['anthropic', 'gemini', 'openai-chat', 'openai-responses', 'openai-r1', 'ai-sdk']
const CLINE_CLIENTS = [
  'anthropic', 'ai-sdk', 'ai-sdk-community', 'openai', 'openai-compatible', 'openai-r1',
  'gemini', 'bedrock', 'custom', 'fetch', 'vertex',
]

// ==================== 通用 JSON 读写 ====================

const readJsonFile = (p, errKey) => {
  if (!fs.existsSync(p)) return null
  let raw
  try {
    raw = fs.readFileSync(p, { encoding: 'utf-8' })
  } catch (e) {
    throw new Error(t(errKey, { path: p, message: e.message }))
  }
  if (!raw.trim()) return null
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(t(errKey, { path: p, message: e.message }))
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(t('serviceAgent.cline.notJsonObject', { path: p }))
  }
  return doc
}

// 原子写 + 0600：先写临时文件再 rename，避免 Cline 读到半截 JSON。
// Cline 自己也用同样的 tmp+rename 策略（ProviderSettingsManager.write）。
const writeJsonFile = (p, doc, mode = 0o600) => {
  const dir = path.dirname(p)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${p}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf-8', mode })
    fs.renameSync(tmp, p)
    try { fs.chmodSync(p, mode) } catch (e) { /* Windows 等无 chmod，忽略 */ }
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }) } catch (err) { /* ignore */ }
    throw e
  }
  return true
}

// ==================== providers.json ====================
// { version:1, lastUsedProvider?, modes:{}, repairs?, providers: { <id>: {
//     settings: { provider, apiKey?, model?, baseUrl?, headers?, ... }, updatedAt, tokenSource } } }
// settings 里除本服务管理的字段外全部原样往返（_extra）。

const PROVIDER_SETTINGS_KNOWN = ['provider', 'apiKey', 'model', 'baseUrl', 'headers']

// Cline 的 provider 标识（providerId）。当前 CLI / SDK 侧的第三方端点统一走 openai-compatible；
// 其余为官方内置供应商，只有 baseUrl 为空时才出现，本服务允许识别但不主动创建。
const CLINE_PROVIDER_TYPES = ['openai-compatible']
const DEFAULT_PROVIDER_TYPE = 'openai-compatible'

const emptyProvidersDoc = () => ({ version: 1, modes: {}, providers: {} })

const readProvidersDoc = () => {
  const doc = readJsonFile(providersPath(), 'serviceAgent.cline.providersReadFailed')
  if (!doc) return emptyProvidersDoc()
  if (doc.version !== 1) {
    // version 不是字面量 1 → Cline 的 zod 会整档拒绝，此时写回等于清空用户配置
    throw new Error(t('serviceAgent.cline.providersVersionInvalid', { version: String(doc.version) }))
  }
  if (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) {
    doc.providers = {}
  }
  if (!doc.modes || typeof doc.modes !== 'object' || Array.isArray(doc.modes)) doc.modes = {}
  return doc
}

const writeProvidersDoc = (doc) => {
  // 写前自检：漏掉 version 会让 Cline 整档丢弃
  const out = {
    version: 1,
    ...(doc.lastUsedProvider ? { lastUsedProvider: doc.lastUsedProvider } : {}),
    modes: doc.modes && typeof doc.modes === 'object' ? doc.modes : {},
    ...(doc.repairs && typeof doc.repairs === 'object' ? { repairs: doc.repairs } : {}),
    providers: doc.providers && typeof doc.providers === 'object' ? doc.providers : {},
  }
  return writeJsonFile(providersPath(), out)
}

// settings.reasoning —— Cline 的 { enabled?: boolean, effort?: 档位, budgetTokens?: 正整数 }
// 校验规则与 Cline 的 zod 一致：
//   - effort 必须是 CLINE_REASONING_EFFORTS 之一（否则整条目被判废）
//   - enabled 取不到布尔值、budgetTokens 不是正整数，同样判废
//   - Cline 自己的选择器关掉思考时写 { enabled: false }，此时 effort 会被忽略
// 返回规范化对象，非法时返回 null。
const normalizeReasoning = (raw) => {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return null
  if (raw.enabled !== undefined) out.enabled = raw.enabled
  if (raw.effort !== undefined) {
    if (!CLINE_REASONING_EFFORTS.includes(raw.effort)) return null
    out.effort = raw.effort
  }
  if (raw.budgetTokens !== undefined) {
    if (!Number.isInteger(raw.budgetTokens) || raw.budgetTokens <= 0) return null
    out.budgetTokens = raw.budgetTokens
  }
  // 多余字段 Cline 的 zod 会剥掉；这里只保留上面三个，避免写进无意义的键
  return out
}

const normalizeProviderSettings = (entry) => {
  const raw = entry && typeof entry === 'object' ? entry : {}
  const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? raw.settings
    : {}
  const extra = {}
  for (const k of Object.keys(settings)) {
    if (!PROVIDER_SETTINGS_KNOWN.includes(k)) extra[k] = settings[k]
  }
  return {
    settings: {
      provider: typeof settings.provider === 'string' ? settings.provider : '',
      apiKey: typeof settings.apiKey === 'string' ? settings.apiKey : '',
      model: typeof settings.model === 'string' ? settings.model : '',
      baseUrl: typeof settings.baseUrl === 'string' ? settings.baseUrl : '',
      headers: settings.headers && typeof settings.headers === 'object' && !Array.isArray(settings.headers)
        ? settings.headers
        : {},
    },
    // 只在读到合法对象时给出；非法时返回 null，由调用方决定「保留原样」还是「重置」
    reasoning: normalizeReasoning(settings.reasoning),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    tokenSource: raw.tokenSource === 'oauth' || raw.tokenSource === 'migration' ? raw.tokenSource : 'manual',
    _extra: extra,
  }
}

const buildProviderSettings = (cfg) => {
  const s = { provider: cfg.provider || DEFAULT_PROVIDER_TYPE }
  if (cfg.apiKey) s.apiKey = String(cfg.apiKey)
  if (cfg.model) s.model = String(cfg.model)
  if (cfg.baseUrl) s.baseUrl = String(cfg.baseUrl)
  const headers = {}
  for (const [k, v] of Object.entries(cfg.headers || {})) {
    if (String(k).trim()) headers[String(k).trim()] = String(v == null ? '' : v)
  }
  if (Object.keys(headers).length) s.headers = headers
  // reasoning 不在这里写：它由 setClineReasoning 单独维护，避免每次保存供应商都把它抹掉
  return { ...(cfg._extra || {}), ...s }
}

// Cline 的推理档位（@cline/shared REASONING_LEVELS）。写错一个字母，Cline 的 zod 会把**整个 provider**
// 丢掉——lastUsedProvider 随之悬空，Cline 静默回落到内置 cline 账号，用户看到的就是「配置不生效」。
const CLINE_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// 判断 provider 条目是否会被 Cline 的 zod `StoredProviderSettingsEntrySchema` 接受。
// 只覆盖配置侧（settings + updatedAt + tokenSource）；profile / OAuth 凭据等字段读不动也不改。
// 返回 { ok: true } 或 { ok: false, reason }（reason 为 i18n key 后缀，见 getClineProviderIssues）。
const checkProviderEntry = (pid, entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'notObject' }
  const s = entry.settings
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, reason: 'noSettings' }
  // storage.provider 必须存在且是合法 id（Cline 的 kf = 小写字母数字 + 中划线）
  if (typeof s.provider !== 'string' || !PROVIDER_TYPE_RE.test(s.provider)) {
    return { ok: false, reason: 'providerTypeInvalid', value: String(s.provider) }
  }
  // settings.provider 与条目键不一致时 Cline 会把它当「未配置」
  if (s.provider !== pid) return { ok: false, reason: 'providerMismatch', value: s.provider }
  if (typeof entry.updatedAt !== 'string' || !entry.updatedAt || Number.isNaN(Date.parse(entry.updatedAt)) || !ISO_DATETIME_RE.test(entry.updatedAt)) {
    return { ok: false, reason: 'updatedAtInvalid', value: String(entry.updatedAt) }
  }
  if (entry.tokenSource !== 'manual' && entry.tokenSource !== 'oauth' && entry.tokenSource !== 'migration') {
    return { ok: false, reason: 'tokenSourceInvalid', value: String(entry.tokenSource) }
  }
  if (s.reasoning !== undefined && normalizeReasoning(s.reasoning) === null) {
    return { ok: false, reason: 'reasoningInvalid', value: JSON.stringify(s.reasoning) }
  }
  if (s.protocol !== undefined && !CLINE_PROTOCOLS.includes(s.protocol)) {
    return { ok: false, reason: 'protocolInvalid', value: String(s.protocol) }
  }
  if (s.client !== undefined && !CLINE_CLIENTS.includes(s.client)) {
    return { ok: false, reason: 'clientInvalid', value: String(s.client) }
  }
  if (s.baseUrl !== undefined && typeof s.baseUrl !== 'string') {
    return { ok: false, reason: 'baseUrlInvalid', value: typeof s.baseUrl }
  }
  return { ok: true }
}

// 当前实际生效的 provider（Cline 的 resolveLastUsedProviderId 语义）：
// lastUsedProvider 指向不存在 / 被判废的条目时 Cline 视为「没配置」，静默回落内置 cline，所以这里返回 ''。
const effectiveLastUsedProvider = (doc) => {
  const pid = doc && typeof doc.lastUsedProvider === 'string' ? doc.lastUsedProvider : ''
  if (!pid) return ''
  if (!doc.providers || !doc.providers[pid]) return ''
  return checkProviderEntry(pid, doc.providers[pid]).ok ? pid : ''
}

// ==================== models.json ====================
// { version:1, providers: { <id>: { provider:{ name, baseUrl, defaultModelId? },
//     models: { <modelId>: { id, name?, contextWindow?, maxTokens?, capabilities? } },
//     discoveredModelIds?: [] } } }
// models.json 有独立的 version 信封（与 providers.json 不是同一个）。

const emptyModelsDoc = () => ({ version: 1, providers: {} })

const readModelsDoc = () => {
  const doc = readJsonFile(modelsPath(), 'serviceAgent.cline.modelsReadFailed')
  if (!doc) return emptyModelsDoc()
  if (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) {
    doc.providers = {}
  }
  return doc
}

const writeModelsDoc = (doc) => {
  const out = {
    version: 1,
    providers: doc.providers && typeof doc.providers === 'object' ? doc.providers : {},
  }
  return writeJsonFile(modelsPath(), out)
}

// 能力枚举（Cline 认识的值）。未知值不裁剪，避免抹掉未来字段。
const CLINE_CAPABILITIES = ['streaming', 'tools', 'images', 'reasoning']

const normalizeModelEntry = (id, raw) => {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const known = ['id', 'name', 'contextWindow', 'maxTokens', 'capabilities']
  const extra = {}
  for (const k of Object.keys(m)) if (!known.includes(k)) extra[k] = m[k]
  return {
    id: typeof m.id === 'string' && m.id ? m.id : id,
    name: typeof m.name === 'string' ? m.name : '',
    contextWindow: toNumber(m.contextWindow),
    maxTokens: toNumber(m.maxTokens),
    capabilities: Array.isArray(m.capabilities) ? m.capabilities.map((c) => String(c)) : [],
    _extra: extra,
  }
}

const buildModelEntry = (model) => {
  const m = { ...(model._extra || {}) }
  m.id = String(model.id)
  if (model.name) m.name = String(model.name)
  if (Number(model.contextWindow) > 0) m.contextWindow = Number(model.contextWindow)
  if (Number(model.maxTokens) > 0) m.maxTokens = Number(model.maxTokens)
  const caps = Array.isArray(model.capabilities)
    ? model.capabilities.filter((c) => CLINE_CAPABILITIES.includes(c))
    : []
  if (caps.length) m.capabilities = caps
  return m
}

// ==================== 供应商 / 模型 校验 ====================

const assertProviderId = (id) => {
  const s = String(id || '').trim()
  if (!s) throw new Error(t('serviceAgent.cline.providerIdRequired'))
  if (!PROVIDER_ID_RE.test(s)) throw new Error(t('serviceAgent.cline.providerIdInvalid', { id: s }))
  return s
}

const assertModelId = (id) => {
  const s = String(id || '').trim()
  if (!s) throw new Error(t('serviceAgent.cline.modelIdRequired'))
  if (!MODEL_ID_RE.test(s)) throw new Error(t('serviceAgent.cline.modelIdInvalid', { id: s }))
  return s
}

// 模型目录里某个 provider 的条目（缺失返回 null，不创建文件）
const modelsOfProvider = (modelsDoc, providerId) => {
  const entry = modelsDoc.providers[providerId]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return entry
}

// ==================== 供应商 读取 ====================

const getClineProviderList = () => {
  const doc = readProvidersDoc()
  const modelsDoc = readModelsDoc()
  // isActive 用「Cline 里真正生效的那个」：lastUsedProvider 悬空时 Cline 会静默回落内置 cline 账号
  const activeId = effectiveLastUsedProvider(doc)
  return Object.entries(doc.providers)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([id, raw]) => {
      const n = normalizeProviderSettings(raw)
      const modelsEntry = modelsOfProvider(modelsDoc, id)
      const catalog = modelsEntry && modelsEntry.provider && typeof modelsEntry.provider === 'object'
        ? modelsEntry.provider
        : {}
      const models = modelsEntry && modelsEntry.models && typeof modelsEntry.models === 'object'
        ? Object.entries(modelsEntry.models)
            .map(([mid, m]) => normalizeModelEntry(mid, m))
            .sort((a, b) => a.id.localeCompare(b.id))
        : []
      const check = checkProviderEntry(id, raw)
      return {
        id,
        // settings.provider 是 Cline 的供应商类型；对外叫 providerType，避免与「供应商」概念混淆
        providerType: n.settings.provider || DEFAULT_PROVIDER_TYPE,
        apiKey: n.settings.apiKey,
        hasApiKey: !!n.settings.apiKey,
        model: n.settings.model,
        baseUrl: n.settings.baseUrl,
        headers: n.settings.headers,
        updatedAt: n.updatedAt,
        tokenSource: n.tokenSource,
        isActive: !!activeId && activeId === id,
        // Cline 只会在条目被判废时静默跳过它，页面上必须显式提示，否则用户永远搞不清「为什么不生效」
        valid: check.ok,
        invalidReason: check.ok ? '' : check.reason,
        invalidValue: check.ok ? '' : (check.value || ''),
        // 推理档位（settings.reasoning）：effort 为 '' 表示未设置；enabled=false 表示 Cline 里关掉了思考
        reasoningEffort: n.reasoning && n.reasoning.enabled !== false ? (n.reasoning.effort || '') : '',
        reasoningEnabled: n.reasoning ? n.reasoning.enabled !== false : true,
        // 文件里的 reasoning 存在但不合法（会被 Cline 判废），页面提示用户重选一次
        reasoningInvalid: !!raw.settings && raw.settings.reasoning !== undefined && n.reasoning === null,
        displayName: typeof catalog.name === 'string' ? catalog.name : '',
        defaultModelId: typeof catalog.defaultModelId === 'string' ? catalog.defaultModelId : '',
        models,
        _extra: n._extra,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

// 当前实际生效的供应商（悬空 / 判废时返回 ''，与 Cline 的回落行为一致）
const getClineActiveProvider = () => {
  try {
    return effectiveLastUsedProvider(readProvidersDoc())
  } catch (e) {
    return ''
  }
}

// lastUsedProvider 写着但 Cline 用不上（条目缺失 / 被判废）时，返回那个悬空的 id，否则 ''
const getClineDanglingActiveProvider = () => {
  try {
    const doc = readProvidersDoc()
    const pid = typeof doc.lastUsedProvider === 'string' ? doc.lastUsedProvider : ''
    if (!pid) return ''
    return effectiveLastUsedProvider(doc) ? '' : pid
  } catch (e) {
    return ''
  }
}


// ==================== 供应商 写入 ====================

// 新建或更新供应商：providers.json 与 models.json 两个信封同步维护
const setClineProvider = (id, cfg) => {
  const pid = assertProviderId(id)
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const providersDoc = readProvidersDoc()
  const modelsDoc = readModelsDoc()

  const prevNorm = normalizeProviderSettings(providersDoc.providers[pid])
  // 保留条目顶层的未识别字段（Cline 后续版本可能新增），只覆盖受管的三项
  const prevRaw = providersDoc.providers[pid] && typeof providersDoc.providers[pid] === 'object'
    ? providersDoc.providers[pid]
    : {}
  const topExtra = {}
  for (const k of Object.keys(prevRaw)) {
    if (k !== 'settings' && k !== 'updatedAt' && k !== 'tokenSource') topExtra[k] = prevRaw[k]
  }
  // settings 里的未识别字段：不做任何改写（Cline 的 zod 会剥掉不认识的键，但这里照旧往返，
  // 万一官方新增字段，用户手写的值不会被我们抹掉）
  const settingsExtra = { ...prevNorm._extra }
  // reasoning 属于「已识别但受 zod 严格校验」的字段：能规范化就规范化，不能就原样保留
  // （原样保留时条目仍会被 Cline 判废，页面上用 reasoningInvalid 提示，不静默改用户数据）
  const prevReasoning = prevRaw.settings && typeof prevRaw.settings === 'object'
    && prevRaw.settings.reasoning !== undefined && prevRaw.settings.reasoning !== null
    ? prevRaw.settings.reasoning
    : undefined

  const settings = buildProviderSettings({
    // 默认用条目键当 settings.provider：Cline 用 `providers[key].settings.provider === key` 判断「是否已配置」，
    // 两者不一致时整条配置会被无视（v1.1.x 里新建的 alt / router 条目就是这样永远不生效的）
    provider: c.providerType || (PROVIDER_TYPE_RE.test(pid) ? pid : DEFAULT_PROVIDER_TYPE),
    apiKey: c.apiKey !== undefined ? c.apiKey : prevNorm.settings.apiKey,
    model: c.model !== undefined ? c.model : prevNorm.settings.model,
    baseUrl: c.baseUrl !== undefined ? c.baseUrl : prevNorm.settings.baseUrl,
    headers: c.headers !== undefined ? c.headers : prevNorm.settings.headers,
    _extra: settingsExtra,
  })
  if (prevReasoning !== undefined) settings.reasoning = prevReasoning

  providersDoc.providers[pid] = {
    ...topExtra,
    settings,
    // updatedAt 必须是 ISO datetime，Cline 的 zod 会校验（格式错 → 整条目被丢弃）
    updatedAt: new Date().toISOString(),
    tokenSource: prevNorm.tokenSource,
  }
  writeProvidersDoc(providersDoc)

  // models.json 只补 provider 描述，不动已有 models（模型由 setClineModel 单独维护）
  const prevModels = modelsOfProvider(modelsDoc, pid)
  const next = prevModels ? { ...prevModels } : {}
  const catalog = next.provider && typeof next.provider === 'object' ? { ...next.provider } : {}
  const displayName = c.displayName !== undefined ? String(c.displayName || '') : (catalog.name || '')
  catalog.name = displayName || catalog.name || pid
  catalog.baseUrl = c.baseUrl !== undefined ? String(c.baseUrl || '') : (catalog.baseUrl || '')
  if (c.defaultModelId !== undefined) {
    if (c.defaultModelId) catalog.defaultModelId = String(c.defaultModelId)
    else delete catalog.defaultModelId
  }
  next.provider = catalog
  if (!next.models || typeof next.models !== 'object') next.models = {}
  modelsDoc.providers[pid] = next
  writeModelsDoc(modelsDoc)
  return pid
}

const addClineProvider = (cfg) => {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const pid = assertProviderId(c.id || c.name)
  const providersDoc = readProvidersDoc()
  if (providersDoc.providers[pid]) {
    throw new Error(t('serviceAgent.cline.providerExists', { id: pid }))
  }
  // 当前没有「实际生效」的供应商时（首次添加，或 lastUsedProvider 悬空 / 被判废）自动设为当前使用：
  // 否则新建完成后 Cline 仍停在「无配置 → 回落内置 cline 账号」的状态，看起来就是配置不生效
  const needActivate = !effectiveLastUsedProvider(providersDoc)
  setClineProvider(pid, c)
  if (needActivate) setClineActiveProvider(pid)
  return pid
}

const updateClineProvider = (id, cfg) => {
  const pid = assertProviderId(id)
  const providersDoc = readProvidersDoc()
  if (!providersDoc.providers[pid]) {
    throw new Error(t('serviceAgent.cline.providerNotFound', { id: pid }))
  }
  return setClineProvider(pid, cfg)
}

// 删除供应商：连同 models.json 里的目录一起删；正被使用时清空 lastUsedProvider
//（与 Cline 自身 saveLocalProviderSettings 的 enabled:false 分支行为一致）
const deleteClineProvider = (id) => {
  const pid = assertProviderId(id)
  const providersDoc = readProvidersDoc()
  if (!providersDoc.providers[pid]) {
    throw new Error(t('serviceAgent.cline.providerNotFound', { id: pid }))
  }
  delete providersDoc.providers[pid]
  if (providersDoc.lastUsedProvider === pid) delete providersDoc.lastUsedProvider
  const voice = providersDoc.modes && providersDoc.modes.voiceInput
  if (voice && voice.providerId === pid) delete providersDoc.modes.voiceInput
  writeProvidersDoc(providersDoc)

  const modelsDoc = readModelsDoc()
  if (modelsDoc.providers[pid]) {
    delete modelsDoc.providers[pid]
    writeModelsDoc(modelsDoc)
  }
  return true
}

// 切换当前使用的供应商（Cline 的 lastUsedProvider）。
// 条目能被 Cline 接受才允许切换：否则 lastUsedProvider 悬空，Cline 静默回落内置 cline 账号，
// 用户会以为是本工具没写进去。
const setClineActiveProvider = (id) => {
  const pid = assertProviderId(id)
  const doc = readProvidersDoc()
  if (!doc.providers[pid]) {
    throw new Error(t('serviceAgent.cline.providerNotFound', { id: pid }))
  }
  const check = checkProviderEntry(pid, doc.providers[pid])
  if (!check.ok) {
    throw new Error(t('serviceAgent.cline.providerInvalid', {
      id: pid,
      reason: t(`serviceAgent.cline.entryIssue.${check.reason}`, { value: String(check.value || '') }),
    }))
  }
  doc.lastUsedProvider = pid
  writeProvidersDoc(doc)
  return pid
}

// 下发后自动接管：仅当 Cline 里「没有实际生效的当前供应商」时（配置为空 / lastUsedProvider 悬空 /
// 条目被判废），才把刚下发的这条设为当前使用，并在它还没有默认模型时选上目录里的第一个模型。
// 已有生效配置时绝不改动用户的选择 —— 用户点了 setDefault 才会切换。
// 返回 { activated, modelId }：activated=true 表示这次新建/接管了当前使用。
const activateClineIfUnset = (providerKey) => {
  const pid = assertProviderId(providerKey)
  const doc = readProvidersDoc()
  if (!doc.providers[pid]) return { activated: false, modelId: '' }
  if (effectiveLastUsedProvider(doc)) return { activated: false, modelId: '' }

  // 先补默认模型：settings.model 是 Cline 会话实际使用的模型，缺省时它会退回内置 gpt-4o
  const modelsDoc = readModelsDoc()
  const entry = modelsOfProvider(modelsDoc, pid)
  const modelIds = entry && entry.models && typeof entry.models === 'object' ? Object.keys(entry.models) : []
  let modelId = typeof doc.providers[pid].settings?.model === 'string' ? doc.providers[pid].settings.model : ''
  if (!modelId && modelIds.length > 0) {
    modelId = modelIds.sort((a, b) => a.localeCompare(b))[0]
    setClineDefaultModel(pid, modelId)
  }
  setClineActiveProvider(pid)
  return { activated: true, modelId }
}

// 设置推理档位（settings.reasoning）。effort 传 '' 表示不写（交给 Cline 的默认），
// 传 'none' 写成 Cline 选择器关掉思考时的形状 { enabled: false }：
// 带 effort 的 { enabled: false } 会被 Cline 忽略 effort（实读为「关闭」），写清楚才不会让人误解。
const setClineReasoning = (providerId, effort) => {
  const pid = assertProviderId(providerId)
  const v = String(effort == null ? '' : effort).trim()
  if (v && !CLINE_REASONING_EFFORTS.includes(v)) {
    throw new Error(t('serviceAgent.cline.reasoningEffortInvalid', { value: v, options: CLINE_REASONING_EFFORTS.join(' | ') }))
  }
  const doc = readProvidersDoc()
  const p = doc.providers[pid]
  if (!p) throw new Error(t('serviceAgent.cline.providerNotFound', { id: pid }))
  if (!p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) p.settings = {}
  if (!v) {
    delete p.settings.reasoning
  } else if (v === 'none') {
    p.settings.reasoning = { enabled: false }
  } else {
    p.settings.reasoning = { enabled: true, effort: v }
  }
  p.updatedAt = new Date().toISOString()
  writeProvidersDoc(doc)
  return v
}

// ==================== 模型 写入 / 读取 ====================

const getClineModelList = (providerId) => {
  const pid = assertProviderId(providerId)
  const modelsDoc = readModelsDoc()
  const entry = modelsOfProvider(modelsDoc, pid)
  if (!entry || !entry.models || typeof entry.models !== 'object') return []
  return Object.entries(entry.models)
    .map(([mid, m]) => normalizeModelEntry(mid, m))
    .sort((a, b) => a.id.localeCompare(b.id))
}

const ensureProviderForModel = (modelsDoc, pid) => {
  const prev = modelsOfProvider(modelsDoc, pid)
  const next = prev ? { ...prev } : {}
  if (!next.provider || typeof next.provider !== 'object') {
    next.provider = { name: pid, baseUrl: '' }
  }
  if (!next.models || typeof next.models !== 'object') next.models = {}
  modelsDoc.providers[pid] = next
  return next
}

// 新增 / 更新模型条目；旧 ID 与当前 ID 不同时视为重命名（先删旧键）
const setClineModel = (providerId, oldModelId, model) => {
  const pid = assertProviderId(providerId)
  const m = model && typeof model === 'object' ? model : {}
  const newId = assertModelId(m.id)
  const modelsDoc = readModelsDoc()
  const entry = ensureProviderForModel(modelsDoc, pid)

  let prevExtra = {}
  const oldKey = oldModelId ? String(oldModelId) : ''
  if (oldKey && entry.models[oldKey]) {
    prevExtra = normalizeModelEntry(oldKey, entry.models[oldKey])._extra || {}
    if (oldKey !== newId) delete entry.models[oldKey]
  } else if (entry.models[newId]) {
    prevExtra = normalizeModelEntry(newId, entry.models[newId])._extra || {}
  }

  entry.models[newId] = buildModelEntry({
    id: newId,
    name: m.name !== undefined ? String(m.name || '') : '',
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    capabilities: m.capabilities,
    _extra: prevExtra,
  })

  // 改的是当前默认模型 → 同步 providers.json 的 settings.model 与目录的 defaultModelId
  if (oldKey !== newId) {
    if (entry.provider.defaultModelId === oldKey) entry.provider.defaultModelId = newId
    const providersDoc = readProvidersDoc()
    const p = providersDoc.providers[pid]
    if (p && p.settings && p.settings.model === oldKey) {
      p.settings.model = newId
      p.updatedAt = new Date().toISOString()
      writeProvidersDoc(providersDoc)
    }
  }
  writeModelsDoc(modelsDoc)
  return newId
}

const addClineModel = (providerId, model) => {
  const pid = assertProviderId(providerId)
  const m = model && typeof model === 'object' ? model : {}
  const mid = assertModelId(m.id)
  const modelsDoc = readModelsDoc()
  const entry = ensureProviderForModel(modelsDoc, pid)
  if (entry.models[mid]) {
    throw new Error(t('serviceAgent.cline.modelExists', { id: mid }))
  }
  return setClineModel(pid, '', m)
}

const updateClineModel = (providerId, modelId, model) => {
  const pid = assertProviderId(providerId)
  const mid = String(modelId || '').trim()
  const modelsDoc = readModelsDoc()
  const entry = modelsOfProvider(modelsDoc, pid)
  if (!entry || !entry.models || !entry.models[mid]) {
    throw new Error(t('serviceAgent.cline.modelNotFound', { id: mid }))
  }
  return setClineModel(pid, mid, model)
}

const deleteClineModel = (providerId, modelId) => {
  const pid = assertProviderId(providerId)
  const mid = String(modelId || '').trim()
  const modelsDoc = readModelsDoc()
  const entry = modelsOfProvider(modelsDoc, pid)
  if (!entry || !entry.models || !entry.models[mid]) {
    throw new Error(t('serviceAgent.cline.modelNotFound', { id: mid }))
  }
  delete entry.models[mid]

  // 删掉的是当前默认模型 → 回退到剩余第一个，或直接清空
  const providersDoc = readProvidersDoc()
  const p = providersDoc.providers[pid]
  if (entry.provider && entry.provider.defaultModelId === mid) {
    const rest = Object.keys(entry.models).sort()
    if (rest.length) entry.provider.defaultModelId = rest[0]
    else delete entry.provider.defaultModelId
  }
  if (p && p.settings && p.settings.model === mid) {
    const rest = Object.keys(entry.models).sort()
    if (rest.length) p.settings.model = rest[0]
    else delete p.settings.model
    p.updatedAt = new Date().toISOString()
    writeProvidersDoc(providersDoc)
  }
  writeModelsDoc(modelsDoc)
  return true
}

// 把某个模型设为该供应商的默认模型（同时写 settings.model 与目录 defaultModelId）。
// Cline 里「模型」只有通过 providers.json 的 settings.model 才会被下一次会话读到，
// 所以只改 models.json 的 defaultModelId 是不够的（models.json 只是模型目录/能力声明）。
const setClineDefaultModel = (providerId, modelId) => {
  const pid = assertProviderId(providerId)
  const mid = assertModelId(modelId)
  const modelsDoc = readModelsDoc()
  const entry = ensureProviderForModel(modelsDoc, pid)
  if (!entry.models[mid]) {
    throw new Error(t('serviceAgent.cline.modelNotFound', { id: mid }))
  }
  entry.provider.defaultModelId = mid
  writeModelsDoc(modelsDoc)

  const providersDoc = readProvidersDoc()
  const p = providersDoc.providers[pid]
  if (!p) throw new Error(t('serviceAgent.cline.providerNotFound', { id: pid }))
  if (!p.settings || typeof p.settings !== 'object') p.settings = {}
  p.settings.model = mid
  p.updatedAt = new Date().toISOString()
  // 模型目录里已有条目但 settings.provider 与键不一致 → 顺手改成键本身，否则 Cline 视为未配置
  if (PROVIDER_TYPE_RE.test(pid) && p.settings.provider !== pid) {
    // 只有原本 settings.provider 是「同一类协议」（openai-compatible）时才纠正，
    // 其他值（官方内置供应商）不动，避免把用户的 anthropic / bedrock 配置改成 openai-compatible
    if (!p.settings.provider || p.settings.provider === DEFAULT_PROVIDER_TYPE) p.settings.provider = pid
  }
  writeProvidersDoc(providersDoc)
  return mid
}

// ==================== MCP（cline_mcp_settings.json）====================
// { mcpServers: { <name>: {
//     command, args, env,                          // stdio
//     type: 'streamableHttp'|'sse', url, headers,  // 远程（缺 type 即 stdio）
//     disabled, autoApprove, ... } } }
// IDE 扩展与本文件共用同一份 MCP 配置，所以这里的改动对 CLI 与扩展同时生效。
// 未识别字段原样往返（_extra）。

const CLINE_MCP_KNOWN = ['command', 'args', 'env', 'cwd', 'url', 'type', 'headers', 'disabled', 'autoApprove']
const CLINE_MCP_NAME_RE = /^[A-Za-z0-9_][\w.\-]*$/

const readMcpDoc = () => {
  const doc = readJsonFile(mcpSettingsPath(), 'serviceAgent.cline.mcpReadFailed')
  if (!doc) return { mcpServers: {} }
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object' || Array.isArray(doc.mcpServers)) {
    doc.mcpServers = {}
  }
  return doc
}

const writeMcpDoc = (doc) => {
  const out = { ...doc }
  out.mcpServers = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}
  return writeJsonFile(mcpSettingsPath(), out)
}

const normalizeClineMcp = (name, cfg) => {
  const raw = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {}
  const extra = {}
  for (const k of Object.keys(raw)) if (!CLINE_MCP_KNOWN.includes(k)) extra[k] = raw[k]
  const isHttp = !!raw.url
  return {
    name,
    type: isHttp ? (String(raw.type || '').toLowerCase() === 'sse' ? 'sse' : 'http') : 'stdio',
    command: typeof raw.command === 'string' ? raw.command : '',
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
    url: isHttp ? String(raw.url) : '',
    env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : {},
    headers: raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers) ? raw.headers : {},
    autoApprove: Array.isArray(raw.autoApprove) ? raw.autoApprove.map((a) => String(a)) : [],
    enabled: raw.disabled !== true,
    _extra: extra,
  }
}

const buildClineMcp = (cfg) => {
  const m = { ...(cfg._extra || {}) }
  if (cfg.type === 'http' || cfg.type === 'sse') {
    m.type = cfg.type === 'sse' ? 'sse' : 'streamableHttp'
    m.url = String(cfg.url || '').trim()
    const headers = {}
    for (const [k, v] of Object.entries(cfg.headers || {})) {
      if (String(k).trim()) headers[String(k).trim()] = String(v == null ? '' : v)
    }
    if (Object.keys(headers).length) m.headers = headers
    else delete m.headers
    delete m.command
    delete m.args
    delete m.cwd
    delete m.env
  } else {
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
    delete m.type
    delete m.headers
  }
  if (Array.isArray(cfg.autoApprove) && cfg.autoApprove.length) m.autoApprove = cfg.autoApprove
  else delete m.autoApprove
  // 关闭态用 disabled:true（Cline 字段语义），开启时不留脏字段
  if (cfg.enabled === false) m.disabled = true
  else delete m.disabled
  return m
}

const assertMcpName = (name) => {
  const s = String(name || '').trim()
  if (!s) throw new Error(t('serviceAgent.cline.mcpNameRequired'))
  if (!CLINE_MCP_NAME_RE.test(s)) throw new Error(t('serviceAgent.cline.mcpNameInvalidChars'))
  return s
}

const getClineMcpServers = () => {
  const doc = readMcpDoc()
  return Object.entries(doc.mcpServers)
    .filter(([, c]) => c && typeof c === 'object' && !Array.isArray(c))
    .map(([name, c]) => normalizeClineMcp(name, c))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// 供 MCP 卡片「查看工具」复用：映射成通用 config 形状
const toGenericClineMcp = (server) => {
  if (!server) return null
  if (server.type === 'http' || server.type === 'sse') {
    return { type: 'http', url: server.url, headers: server.headers }
  }
  return { type: 'stdio', command: server.command, args: server.args, env: server.env }
}

// 写入 MCP 服务器：存在则原地更新（保留未识别字段），否则新增
const setClineMcpServer = (name, cfg) => {
  const sname = assertMcpName(name)
  const doc = readMcpDoc()
  const prevRaw = doc.mcpServers[sname] && typeof doc.mcpServers[sname] === 'object'
    ? normalizeClineMcp(sname, doc.mcpServers[sname])
    : null
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const merged = {
    type: c.type !== undefined ? c.type : (prevRaw ? prevRaw.type : 'stdio'),
    command: c.command !== undefined ? c.command : (prevRaw ? prevRaw.command : ''),
    args: c.args !== undefined ? c.args : (prevRaw ? prevRaw.args : []),
    url: c.url !== undefined ? c.url : (prevRaw ? prevRaw.url : ''),
    env: c.env !== undefined ? c.env : (prevRaw ? prevRaw.env : {}),
    headers: c.headers !== undefined ? c.headers : (prevRaw ? prevRaw.headers : {}),
    autoApprove: c.autoApprove !== undefined ? c.autoApprove : (prevRaw ? prevRaw.autoApprove : []),
    enabled: c.enabled !== undefined ? c.enabled : (prevRaw ? prevRaw.enabled : true),
    _extra: prevRaw ? prevRaw._extra : {},
  }
  doc.mcpServers[sname] = buildClineMcp(merged)
  writeMcpDoc(doc)
  return sname
}

const setClineMcpEnabled = (name, enabled) => {
  const sname = assertMcpName(name)
  const doc = readMcpDoc()
  const cur = doc.mcpServers[sname]
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
    throw new Error(t('serviceAgent.cline.mcpNotFound', { name: sname }))
  }
  const n = normalizeClineMcp(sname, cur)
  doc.mcpServers[sname] = buildClineMcp({ ...n, enabled: !!enabled })
  writeMcpDoc(doc)
  return sname
}

const deleteClineMcpServer = (name) => {
  const sname = assertMcpName(name)
  const doc = readMcpDoc()
  if (!doc.mcpServers[sname]) {
    throw new Error(t('serviceAgent.cline.mcpNotFound', { name: sname }))
  }
  delete doc.mcpServers[sname]
  writeMcpDoc(doc)
  return true
}

// ==================== Skill（~/.cline/skills）====================
// 官方路径 <CLINE_DIR>/skills/<name>/SKILL.md；另外也兼容 ~/.agents/skills（Cline 全局共享目录），
// 但本视图只管理 ~/.cline/skills（受管目录），避免与「通用配置 → Skill」重复管理同一批目录。
// 启停沿用 .disabled 目录机制（物理移动，与 Claude / OpenCode / 通用 Skill 同一套心智）。

const SKILL_DISABLED_DIR = '.disabled'

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
    fileCount: countEntries(skillPath),
    disabled,
  }
}

const getClineSkills = () => {
  const dir = skillsPath()
  const skills = []
  const scan = (base, disabled) => {
    if (!fs.existsSync(base)) return
    let entries = []
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch (e) {
      console.error('[cline] 读取 skills 目录失败:', e)
      return
    }
    for (const entry of entries) {
      if (!isDirEntry(base, entry) || entry.name === SKILL_DISABLED_DIR) continue
      try {
        const skill = readSkillEntry(path.join(base, entry.name), disabled)
        if (skill) skills.push(skill)
      } catch (e) {
        console.error('[cline] 读取 skill 失败:', entry.name, e)
      }
    }
  }
  scan(dir, false)
  scan(path.join(dir, SKILL_DISABLED_DIR), true)
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// 启停 = 目录物理移动：enabled 时从 .disabled 移回，反之移入
const setClineSkillEnabled = (skillName, enabled) => {
  const name = String(skillName || '').trim()
  if (!name || name === SKILL_DISABLED_DIR || name.includes(path.sep) || name.includes('/')) {
    return { success: false, error: t('service.skill.notFound') }
  }
  const dir = skillsPath()
  const disabledDir = path.join(dir, SKILL_DISABLED_DIR)
  const from = enabled ? path.join(disabledDir, name) : path.join(dir, name)
  const to = enabled ? path.join(dir, name) : path.join(disabledDir, name)
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

const deleteClineSkill = (skillName, isDisabled) => {
  const name = String(skillName || '').trim()
  if (!name || name === SKILL_DISABLED_DIR || name.includes(path.sep) || name.includes('/')) {
    return { success: false, error: t('service.skill.notFound') }
  }
  const dir = skillsPath()
  const skillPath = isDisabled
    ? path.join(dir, SKILL_DISABLED_DIR, name)
    : path.join(dir, name)
  if (!fs.existsSync(skillPath)) return { success: false, error: t('service.skill.notFound') }
  try {
    // 软链接只删链接本身
    rmEntry(skillPath)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
}

const getClineSkillsDir = () => {
  const dir = skillsPath()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ==================== 使用统计（<CLINE_DATA>/sessions）====================
// 一个会话一份档：sessions/<session_id>/<session_id>.json
//   { session_id, started_at, updated_at?, provider, model, metadata: {
//       usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost },
//       aggregateUsage?: {...} } }
// 口径与 Claude / DSH / Grok 一致：输入（含缓存）= inputTokens + cacheReadTokens + cacheWriteTokens；
// 输出 = outputTokens；单日 tokens = 输入含缓存 + 输出；day.models[name] 存「未缓存输入 / 输出 / 缓存读 / 缓存写」。
// 按会话而非按轮次落日期（Cline 只在会话级汇总用量，没有逐轮增量），日期取 started_at。
// 历史落库：ccconfig_agent_usage_cline_<nativeId>，源会话被清理后回放历史，不归零。

const listClineSessionFiles = () => {
  const root = sessionsDir()
  if (!fs.existsSync(root)) return []
  const out = []
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (e) {
    console.error('[cline] 读取 sessions 目录失败:', e)
    return []
  }
  for (const dir of dirs) {
    const docFile = path.join(root, dir.name, `${dir.name}.json`)
    if (!fs.existsSync(docFile)) continue
    out.push({ sessionId: dir.name, dir: path.join(root, dir.name), docFile })
  }
  return out
}

// 按本地时区分日（toISOString 是 UTC，会让东八区凌晨算到前一天）
const dayKeyOf = (iso) => {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 优先用 metadata.aggregateUsage（多供应商/子 agent 合并后的），否则用 metadata.usage
const usageOfSession = (doc) => {
  const md = doc && doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {}
  const pick = (u) => {
    if (!u || typeof u !== 'object') return null
    const input = toNumber(u.inputTokens)
    const output = toNumber(u.outputTokens)
    const cacheRead = toNumber(u.cacheReadTokens)
    const cacheWrite = toNumber(u.cacheWriteTokens)
    if (input + output + cacheRead + cacheWrite === 0) return null
    return { input, output, cacheRead, cacheWrite }
  }
  return pick(md.aggregateUsage) || pick(md.usage)
}

const collectClineUsageRecords = () => {
  const messageRecords = []
  const sessionMap = new Map()
  for (const session of listClineSessionFiles()) {
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(session.docFile, { encoding: 'utf-8' }))
    } catch (e) {
      // 正在写入 / 空文件：跳过，下次刷新再读
      continue
    }
    if (!doc || typeof doc !== 'object') continue
    const u = usageOfSession(doc)
    if (!u) continue
    const stamp = doc.updated_at || doc.updatedAt || doc.started_at || doc.startedAt
    const date = dayKeyOf(stamp) || dayKeyOf(doc.started_at)
    if (!date) continue
    const model = String(doc.model || 'unknown').trim() || 'unknown'
    const total = u.input + u.output + u.cacheRead + u.cacheWrite
    const ts = stamp ? new Date(stamp).getTime() : 0
    messageRecords.push({
      sessionId: session.sessionId,
      model,
      date,
      timestamp: Number.isNaN(ts) ? 0 : ts,
      inputTokens: u.input,
      outputTokens: u.output,
      cacheReadTokens: u.cacheRead,
      cacheCreationTokens: u.cacheWrite,
      totalTokens: total,
    })
    sessionMap.set(session.sessionId, {
      sessionId: session.sessionId,
      timestamp: stamp ? new Date(stamp).toISOString() : '',
      cwd: doc.cwd || doc.workspace_root || '',
      inputTokens: u.input,
      outputTokens: u.output,
      cacheReadTokens: u.cacheRead,
      cacheCreationTokens: u.cacheWrite,
    })
  }
  return { messageRecords, sessionMap }
}

// 从 contributions 重算 summary / modelStats：口径与 Grok / DSH 统计页一致（输入含缓存）。
//   day.inputTokens          = 当天输入（含缓存）——日期区间筛选直接取该字段显示
//   day.models[].inputTokens = 当天该模型的未缓存输入——页面重算会再叠加缓存字段
const aggregateClineUsage = (contributions, messageCount, sessionCount) => {
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

const emptyClineUsage = () => {
  return {
    summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, messageCount: 0, sessionCount: 0 },
    modelStats: [],
    contributions: require('./usage').emptyContributions(),
    sessionCount: 0,
    messageCount: 0,
  }
}

// 源会话被清理后回放落库历史，避免历史归零；无历史返回 null
const clineStatsFromHistory = () => {
  const usage = require('./usage')
  const history = usage.readAgentUsage('cline')
  const dates = Object.keys(history)
  if (dates.length === 0) return null
  const contributions = usage.fillEmptyContributions(
    dates.sort().map((date) => ({ date, ...history[date], models: history[date].models || {} })),
  )
  return aggregateClineUsage(contributions, 0, 0)
}

const readClineUsageFromHistory = () => {
  try {
    return clineStatsFromHistory()
  } catch (e) {
    console.error('[Cline Usage] 读历史统计失败:', e)
    return null
  }
}

const readClineUsage = (forceRefresh = false) => {
  const usage = require('./usage')
  try {
    const files = listClineSessionFiles()
    if (files.length === 0) return clineStatsFromHistory() || emptyClineUsage()
    const { messageRecords, sessionMap } = collectClineUsageRecords()
    const stats = usage.calculateStats(messageRecords, sessionMap)
    const result = aggregateClineUsage(stats.contributions, messageRecords.length, sessionMap.size)
    // 落库（「通用」统计页数据源 + 本页历史档）：全零由落库层跳过，不会清空历史
    usage.saveAgentUsage('cline', stats.contributions)
    return result
  } catch (e) {
    console.error('[Cline Usage] 统计失败:', e)
    return emptyClineUsage()
  }
}

// ==================== 目录 / 安装检测 ====================

const openClineDir = () => {
  const dir = clineDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch (e) { /* ignore */ }
}

const openClineProvidersFile = () => {
  const p = providersPath()
  if (!fs.existsSync(p)) writeProvidersDoc(emptyProvidersDoc())
  try { window.utools.shellOpenPath(p) } catch (e) { /* ignore */ }
}

const openClineMcpFile = () => {
  const p = mcpSettingsPath()
  if (!fs.existsSync(p)) writeMcpDoc({ mcpServers: {} })
  try { window.utools.shellOpenPath(p) } catch (e) { /* ignore */ }
}

const openClineSessionsDir = () => {
  const dir = sessionsDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch (e) { /* ignore */ }
}

const isClineInstalled = () => fs.existsSync(clineDir())

// 任一供应商 / MCP 服务器存在即视为有数据（detectAgentsConfig 用，不创建文件）
const hasClineConfig = () => {
  try {
    const providers = readProvidersDoc()
    if (Object.keys(providers.providers || {}).length > 0) return true
    const mcp = readMcpDoc()
    return Object.keys(mcp.mcpServers || {}).length > 0
  } catch (e) {
    return false
  }
}

// ==================== 通用配置下发 ====================
// Cline 侧只有 openai-compatible 一种第三方端点协议（OpenAI Chat Completions）。
// 下发的 providerId 用确定性清洗后的名字（同 grok 的 providerKeyFor）：重名时覆盖，不堆冗余条目。
// baseUrl 需由调用方拼好（走网关时要带 /v1）。

const providerKeyFor = (name) => {
  const raw = String(name || '').trim()
  if (!raw) return 'cline-provider'
  // 保留字母数字与 . _ - / :，其余（中文、空格、括号…）折叠成中划线
  const cleaned = raw.replace(/[^\w.:\-/]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return cleaned || 'cline-provider'
}

// 把通用库的 provider + model 合并写入 providers.json 与 models.json。
// 注意 settings.provider 必须与条目键相同（providers.<key>.settings.provider === <key>）：
// Cline 的 resolveProviderSettings 拿它当「是否已配置」的判据，两者不一致时整条配置被无视。
// Cline 只要求 provider 标识合法（字母数字 + 中划线），不要求是内置 id：
// 用 openai-compatible 会与用户自己的同名条目撞车（读改写会连带改坏对方的 model / baseUrl）。
const upsertClineProvider = (key, cfg) => {
  const pid = assertProviderId(key)
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const providerType = PROVIDER_TYPE_RE.test(pid) ? pid : DEFAULT_PROVIDER_TYPE
  setClineProvider(pid, {
    providerType,
    apiKey: c.apiKey,
    baseUrl: c.baseUrl,
    displayName: c.name,
    headers: c.headers,
  })
  return pid
}

const upsertClineModel = (providerKey, model) => {
  const pid = assertProviderId(providerKey)
  const m = model && typeof model === 'object' ? model : {}
  const mid = assertModelId(m.id)
  const modelsDoc = readModelsDoc()
  const entry = ensureProviderForModel(modelsDoc, pid)
  const prev = entry.models[mid] ? normalizeModelEntry(mid, entry.models[mid]) : null
  // 通用库「非空才覆盖、空值不清旧」：与 OpenCode / Pi / Grok 下发语义一致
  entry.models[mid] = buildModelEntry({
    id: mid,
    name: m.name !== undefined && m.name ? String(m.name) : (prev ? prev.name : ''),
    contextWindow: m.contextWindow !== undefined && m.contextWindow ? m.contextWindow : (prev ? prev.contextWindow : 0),
    maxTokens: m.maxTokens !== undefined && m.maxTokens ? m.maxTokens : (prev ? prev.maxTokens : 0),
    capabilities: m.capabilities !== undefined ? m.capabilities : (prev ? prev.capabilities : CLINE_CAPABILITIES),
    _extra: prev ? prev._extra : {},
  })
  writeModelsDoc(modelsDoc)
  return mid
}

// 设为当前供应商的默认模型：同时写 providers.json 的 settings.model 与 models.json 的 defaultModelId
const setClineDefaultModelForProvider = (providerKey, modelId) => {
  const pid = assertProviderId(providerKey)
  const mid = assertModelId(modelId)
  const modelsDoc = readModelsDoc()
  const entry = ensureProviderForModel(modelsDoc, pid)
  if (!entry.models[mid]) throw new Error(t('serviceAgent.cline.modelNotFound', { id: mid }))
  entry.provider.defaultModelId = mid
  writeModelsDoc(modelsDoc)

  const providersDoc = readProvidersDoc()
  const p = providersDoc.providers[pid]
  if (p) {
    if (!p.settings || typeof p.settings !== 'object') p.settings = {}
    p.settings.model = mid
    p.updatedAt = new Date().toISOString()
    writeProvidersDoc(providersDoc)
  }
  return mid
}

module.exports = {
  // 路径
  getClineDir, getClineDataDir, getClineSettingsDir, getClineProvidersPath, getClineModelsPath,
  getClineGlobalSettingsPath, getClineMcpSettingsPath, getClineSkillsPath, getClineSessionsDir,
  // 供应商
  readProvidersDoc, writeProvidersDoc, getClineProviderList, getClineActiveProvider,
  getClineDanglingActiveProvider, checkProviderEntry, effectiveLastUsedProvider,
  addClineProvider, updateClineProvider, deleteClineProvider, setClineActiveProvider, setClineProvider,
  activateClineIfUnset,
  setClineReasoning, normalizeReasoning, CLINE_REASONING_EFFORTS,
  // 模型
  readModelsDoc, writeModelsDoc, getClineModelList,
  addClineModel, updateClineModel, deleteClineModel, setClineDefaultModel,
  // MCP
  getClineMcpServers, setClineMcpServer, setClineMcpEnabled, deleteClineMcpServer, toGenericClineMcp,
  // Skill
  getClineSkills, setClineSkillEnabled, deleteClineSkill, getClineSkillsDir,
  // 统计
  readClineUsage, readClineUsageFromHistory, listClineSessionFiles,
  // 目录 / 检测
  openClineDir, openClineProvidersFile, openClineMcpFile, openClineSessionsDir,
  isClineInstalled, hasClineConfig,
  // 下发
  upsertClineProvider, upsertClineModel, setClineDefaultModelForProvider, providerKeyFor,
  // 常量
  CLINE_PROVIDER_TYPES, DEFAULT_PROVIDER_TYPE, CLINE_CAPABILITIES, PROVIDER_ID_RE, MODEL_ID_RE,
}
