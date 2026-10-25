const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { parse: parseToml, stringify: stringifyToml } = require('smol-toml')
const { t } = require("./i18n")

// .env 变量名合法格式（与 writeReasonixEnvKey / deleteReasonixEnvKey 共用）
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const REASONIX_HOME = () => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'reasonix')
  }
  return path.join(os.homedir(), '.reasonix')
}
const REASONIX_CONFIG_PATH = () => path.join(REASONIX_HOME(), 'config.toml')
const REASONIX_ENV_PATH = () => path.join(REASONIX_HOME(), '.env')
// 公开 getter（brief 接口要求导出 getReasonixHome / getReasonixConfigPath）
const getReasonixHome = REASONIX_HOME
const getReasonixConfigPath = REASONIX_CONFIG_PATH

// BigInt → Number（smol-toml 整数默认解析为 BigInt，UI 层不消费 BigInt）
const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : v == null ? 0 : Number(v))

// ==================== config.toml 读写 ====================

const readReasonixConfig = () => {
  const p = REASONIX_CONFIG_PATH()
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    return parseToml(raw) || {}
  } catch (e) {
    // 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会用
    // {providers:[...]} 覆盖整个 config.toml，抹掉 [agent]/[ui]/[sandbox]/[[plugins]] 等节
    throw new Error(t('serviceAgent.common.tomlParseFailed', { message: e.message }))
  }
}

const writeReasonixConfig = (doc) => {
  const p = REASONIX_CONFIG_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, stringifyToml(doc || {}), { encoding: 'utf-8' })
  return true
}

// ==================== Providers ====================

// UI 认识并显式管理的字段（其余视为需要原样保留的扩展字段/子表）
const KNOWN_PROVIDER_FIELDS = [
  'name', 'kind', 'base_url', 'chat_url', 'models_url', 'api_key_env',
  'default', 'context_window', 'max_output_tokens', 'models', 'model',
]

// 归一化一个 provider 条目供 UI 消费（models 始终为数组）
// 未知字段（model_overrides / price / extra_body / proxy_bypass 等）原样收进 _extra，
// 写回时由 buildProviderToml 还原，避免编辑一个字段导致整个子表丢失
const normalizeProvider = (p) => {
  const extra = {}
  for (const k of Object.keys(p || {})) {
    if (!KNOWN_PROVIDER_FIELDS.includes(k)) extra[k] = p[k]
  }
  return {
    name: p.name || '',
    kind: p.kind || 'openai',
    baseUrl: p.base_url || '',
    chatUrl: p.chat_url || '',
    modelsUrl: p.models_url || '',
    apiKeyEnv: p.api_key_env || '',
    default: p.default || '',
    contextWindow: toNumber(p.context_window),
    maxOutputTokens: toNumber(p.max_output_tokens),
    models: Array.isArray(p.models) ? p.models : (p.model ? [p.model] : []),
    _extra: extra,
  }
}

// 从 UI 结构构建写入 TOML 的 provider 对象（空字段不输出）
const buildProviderToml = (cfg) => {
  const p = { name: cfg.name, kind: cfg.kind || 'openai' }
  if (cfg.baseUrl) p.base_url = cfg.baseUrl
  if (cfg.chatUrl) p.chat_url = cfg.chatUrl
  if (cfg.modelsUrl) p.models_url = cfg.modelsUrl
  if (Array.isArray(cfg.models) && cfg.models.length) p.models = cfg.models
  if (cfg.default) p.default = cfg.default
  if (cfg.apiKeyEnv) p.api_key_env = cfg.apiKeyEnv
  if (cfg.contextWindow) p.context_window = Number(cfg.contextWindow)
  if (cfg.maxOutputTokens) p.max_output_tokens = Number(cfg.maxOutputTokens)
  // 还原未被 UI 管理的扩展字段/子表
  for (const [k, v] of Object.entries(cfg._extra || {})) {
    if (v !== undefined) p[k] = v
  }
  return p
}

const getReasonixProviderList = () => {
  const doc = readReasonixConfig()
  return (doc.providers || []).map(normalizeProvider)
}

const addReasonixProvider = (cfg) => {
  if (!cfg?.name || typeof cfg.name !== 'string') throw new Error(t('serviceAgent.common.providerNameRequired'))
  // 先校验 key 变量名，避免写了一半才因非法名失败留下部分状态
  if (cfg.apiKey && cfg.apiKeyEnv && !ENV_KEY_RE.test(cfg.apiKeyEnv)) {
    throw new Error(t('serviceAgent.reasonix.invalidEnvKey', { key: cfg.apiKeyEnv }))
  }
  const doc = readReasonixConfig()
  if (!Array.isArray(doc.providers)) doc.providers = []
  if (doc.providers.some(p => p.name === cfg.name)) throw new Error(t('serviceAgent.common.providerExists', { name: cfg.name }))
  doc.providers.push(buildProviderToml(cfg))
  if (cfg.apiKey && cfg.apiKeyEnv) writeReasonixEnvKey(cfg.apiKeyEnv, cfg.apiKey)
  try {
    writeReasonixConfig(doc)
  } catch (e) {
    // config 写入失败 → 回滚刚写入的 key，避免 .env 留下孤儿变量
    if (cfg.apiKey && cfg.apiKeyEnv) { try { deleteReasonixEnvKey(cfg.apiKeyEnv) } catch { /* ignore */ } }
    throw e
  }
  return true
}

const updateReasonixProvider = (name, updates) => {
  const doc = readReasonixConfig()
  if (!Array.isArray(doc.providers)) throw new Error(t('serviceAgent.common.providerNotFound', { name }))
  const idx = doc.providers.findIndex(p => p.name === name)
  if (idx === -1) throw new Error(t('serviceAgent.common.providerNotFound', { name }))
  const oldProvider = doc.providers[idx]
  // 支持重命名：name 是唯一 key，改名需校验冲突并同步 default_model 引用
  const newName = (updates.name === undefined || updates.name === name)
    ? name
    : String(updates.name).trim()
  if (!newName) throw new Error(t('serviceAgent.common.providerNameRequired'))
  if (newName !== name && doc.providers.some(p => p.name === newName)) {
    throw new Error(t('serviceAgent.common.providerExists', { name: newName }))
  }
  const oldEnv = oldProvider.api_key_env || ''
  // 未传 apiKeyEnv 时保留原值；显式传空串才表示清空
  const newEnv = (updates.apiKeyEnv === undefined ? oldEnv : (updates.apiKeyEnv || '').trim())
  const merged = { ...normalizeProvider(oldProvider), ...updates, apiKeyEnv: newEnv, name: newName }
  doc.providers[idx] = buildProviderToml(merged)
  // 重命名后同步 default_model 引用：裸供应商名（解析到其默认模型）或 provider/model
  if (newName !== name && doc.default_model) {
    if (doc.default_model === name) doc.default_model = newName
    else if (doc.default_model.startsWith(name + '/')) doc.default_model = newName + doc.default_model.slice(name.length)
  }
  // key 处理：
  // 1) clearApiKey → 显式删除：同时清理旧/新 env 名的 key（改 env 名 + 删 key 组合场景）
  // 2) 提供了新 key → 写入新 env 名
  // 3) 未提供新 key 但 env 名改了 → 把旧 env 名的 key 迁移到新名（旧名保留，避免误删共享 key）
  if (updates.clearApiKey) {
    if (newEnv) deleteReasonixEnvKey(newEnv)
    if (oldEnv && oldEnv !== newEnv) deleteReasonixEnvKey(oldEnv)
  } else if (updates.apiKey && newEnv) {
    writeReasonixEnvKey(newEnv, updates.apiKey)
  } else if (newEnv && newEnv !== oldEnv && oldEnv) {
    // 新 env 名已被其他供应商引用（共享 key 场景）→ 不迁移，避免覆盖共享 key；
    // 迁移仅发生在指向全新的 env 名时
    const sharedByOthers = (doc.providers || []).some((p, i) => i !== idx && p.api_key_env === newEnv)
    if (sharedByOthers) {
      console.warn(`[Reasonix] api_key_env 改为 ${newEnv}，该变量被其他供应商引用，保留其已有 Key（不从 ${oldEnv} 迁移）`)
    } else {
      const env = readReasonixEnv()
      const oldKey = env[oldEnv]
      if (oldKey) {
        // 目标 env 名已存在不同值（如删除 provider 后遗留的孤儿变量）→ 不覆盖，跳过迁移
        if (env[newEnv] !== undefined && env[newEnv] !== oldKey) {
          console.warn(`[Reasonix] ${newEnv} 已有其他值，跳过迁移（不从 ${oldEnv} 复制），如需迁移请先清空 ${newEnv}`)
        } else {
          writeReasonixEnvKey(newEnv, oldKey)
          console.warn(`[Reasonix] api_key_env ${oldEnv} → ${newEnv}，已迁移已保存的 Key（旧名 ${oldEnv} 保留）`)
        }
      } else {
        console.warn(`[Reasonix] api_key_env 改为 ${newEnv}，但 ${oldEnv} 下无已保存 Key，需手动填写`)
      }
    }
  }
  writeReasonixConfig(doc)
  return true
}

const deleteReasonixProvider = (name) => {
  const doc = readReasonixConfig()
  if (!Array.isArray(doc.providers) || !doc.providers.some(p => p.name === name)) {
    throw new Error(t('serviceAgent.common.providerNotFound', { name }))
  }
  const dm = doc.default_model || ''
  if (dm === name || dm.startsWith(name + '/')) {
    throw new Error(t('serviceAgent.reasonix.providerInUseByDefault', { name, reference: dm }))
  }
  doc.providers = doc.providers.filter(p => p.name !== name)
  writeReasonixConfig(doc)
  return true
}

// ==================== 模型 CRUD（models 为字符串数组） ====================

const addReasonixModel = (providerName, modelId) => {
  if (!providerName) throw new Error(t('serviceAgent.common.providerNameRequired'))
  if (!modelId || typeof modelId !== 'string') throw new Error(t('serviceAgent.common.modelIdRequired'))
  const doc = readReasonixConfig()
  const prov = (doc.providers || []).find(p => p.name === providerName)
  if (!prov) throw new Error(t('serviceAgent.common.providerNotFound', { name: providerName }))
  const list = Array.isArray(prov.models) ? prov.models : (prov.model ? [prov.model] : [])
  if (list.includes(modelId)) throw new Error(t('serviceAgent.common.modelExists', { id: modelId }))
  list.push(modelId)
  prov.models = list
  delete prov.model
  writeReasonixConfig(doc)
  return true
}

const deleteReasonixModel = (providerName, modelId) => {
  const doc = readReasonixConfig()
  const prov = (doc.providers || []).find(p => p.name === providerName)
  if (!prov) throw new Error(t('serviceAgent.common.providerNotFound', { name: providerName }))
  const list = Array.isArray(prov.models) ? prov.models : (prov.model ? [prov.model] : [])
  if (!list.includes(modelId)) return true
  const clearedDefault = prov.default === modelId
  prov.models = list.filter(m => m !== modelId)
  if (prov.model) delete prov.model
  if (clearedDefault) delete prov.default
  // 清理悬挂的 default_model 引用：完整引用（provider/model）或裸供应商名（解析到其默认模型）
  if (doc.default_model === `${providerName}/${modelId}` ||
      (clearedDefault && doc.default_model === providerName)) {
    doc.default_model = ''
  }
  writeReasonixConfig(doc)
  return true
}

// ==================== default_model ====================

const getReasonixDefaultModel = () => readReasonixConfig().default_model || ''

const setReasonixDefaultModel = (ref) => {
  const doc = readReasonixConfig()
  doc.default_model = ref || ''
  writeReasonixConfig(doc)
  return true
}

// ==================== .env 密钥 ====================

const readReasonixEnv = () => {
  const p = REASONIX_ENV_PATH()
  if (!fs.existsSync(p)) return {}
  try {
    const out = {}
    for (const raw of fs.readFileSync(p, { encoding: 'utf-8' }).split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      let val = m[2].trim()
      if (val.startsWith('"') && val.endsWith('"')) {
        // 反转义 dotenv 双引号值：\" → "，\\ → \
        val = val.slice(1, -1).replace(/\\(["\\])/g, '$1')
      } else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
      out[m[1]] = val
    }
    return out
  } catch (e) {
    // 权限不足/被占用时降级为空对象，避免编辑弹窗直接崩溃
    console.error('读取 Reasonix .env 失败:', e)
    return {}
  }
}

const getReasonixApiKey = (envName) => (envName ? readReasonixEnv()[envName] || '' : '')

// 按 Reasonix 官方规则生成 api_key_env 名（docs: CONFIG_PATHS.md "Custom provider api_key_env names"）：
// - 非字母数字字符替换为 _ 并大写，如 local-gateway → LOCAL_GATEWAY_API_KEY
// - 数字开头的名字加 CUSTOM_ 前缀，如 9router → CUSTOM_9ROUTER_API_KEY
// - 全非 ASCII 名字用稳定 hash 后缀，如 中文名 → CUSTOM_<8位hex>_API_KEY
const generateReasonixApiKeyEnv = (name) => {
  const raw = String(name || '')
  // 无任何 ASCII 字母数字（如全中文名）→ 用稳定 hash 后缀，避免生成全下划线的非法/无意义变量名
  if (!/[A-Za-z0-9]/.test(raw)) {
    const hash = crypto.createHash('md5').update(raw).digest('hex').slice(0, 8)
    return `CUSTOM_${hash}_API_KEY`
  }
  const base = raw.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  const prefix = /^[0-9]/.test(base) ? 'CUSTOM_' : ''
  return `${prefix}${base}_API_KEY`
}

const writeReasonixEnvKey = (key, value) => {
  if (!key || !ENV_KEY_RE.test(key)) throw new Error(t('serviceAgent.reasonix.invalidSecretKeyName', { key }))
  // dotenv 兼容：值含 # / 空格 / 引号 / 反斜杠时用双引号包裹并转义，
  // 避免被解析器当作注释截断或意外切分（Reasonix CLI 与 readReasonixEnv 均按此解析）
  let lineValue = String(value)
  if (/[#"'\s\\]/.test(lineValue)) {
    lineValue = `"${lineValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  const p = REASONIX_ENV_PATH()
  const lines = fs.existsSync(p) ? fs.readFileSync(p, { encoding: 'utf-8' }).split(/\r?\n/) : []
  const re = new RegExp(`^(?:export\\s+)?${key}\\s*=`)
  const idx = lines.findIndex(l => { const t = l.trim(); return !t.startsWith('#') && re.test(t) })
  if (idx !== -1) lines[idx] = `${key}=${lineValue}`
  else lines.push(`${key}=${lineValue}`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, lines.join('\n') + '\n', { encoding: 'utf-8' })
  try { fs.chmodSync(p, 0o600) } catch { /* 不支持则忽略 */ }
  return true
}

const deleteReasonixEnvKey = (key) => {
  if (!key || !ENV_KEY_RE.test(key)) throw new Error(t('serviceAgent.reasonix.invalidSecretKeyName', { key }))
  const p = REASONIX_ENV_PATH()
  if (!fs.existsSync(p)) return true
  const re = new RegExp(`^(?:export\\s+)?${key}\\s*=`)
  const next = fs.readFileSync(p, { encoding: 'utf-8' })
    .split(/\r?\n/)
    .filter(l => { const t = l.trim(); return t.startsWith('#') || !re.test(t) })
  // 与 writeReasonixEnvKey 一致：非空内容以单个尾换行结尾
  fs.writeFileSync(p, next.length ? next.join('\n') + '\n' : '', { encoding: 'utf-8' })
  return true
}

// ==================== 目录操作 ====================

const openReasonixDir = () => {
  const dir = REASONIX_HOME()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const isReasonixInstalled = () => fs.existsSync(REASONIX_HOME())

module.exports = {
  getReasonixHome, getReasonixConfigPath,
  readReasonixConfig, writeReasonixConfig,
  getReasonixProviderList, addReasonixProvider, updateReasonixProvider, deleteReasonixProvider,
  addReasonixModel, deleteReasonixModel,
  getReasonixDefaultModel, setReasonixDefaultModel,
  readReasonixEnv, getReasonixApiKey, writeReasonixEnvKey, deleteReasonixEnvKey,
  generateReasonixApiKeyEnv,
  openReasonixDir, isReasonixInstalled,
  // 内部结构函数导出，供测试/复用
  normalizeProvider, buildProviderToml,
}
