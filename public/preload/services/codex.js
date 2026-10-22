const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { parse: parseToml, stringify: stringifyToml } = require('smol-toml')

// Codex Desktop（ChatGPT 桌面端）/ Codex CLI / VS Code 插件共用 ~/.codex 下的同一套配置。
// 模型配置参照 DeepSeek 官方接入方式（api-docs.deepseek.com agent_integrations/codex）：
//   config.toml 顶层 model / model_provider / model_reasoning_effort / preferred_auth_method /
//   forced_login_method / model_catalog_json + [model_providers.<id>] 子表
//   （name / base_url / wire_api / experimental_bearer_token）
// 仅管理模型相关字段，config.toml 的其余配置（mcp_servers / profiles 等）读改写原样保留。

// Codex 客户端支持 CODEX_HOME 重定向主目录（官方接入脚本同样优先读取），插件需跟随，
// 否则客户端读 A 目录、插件读写 B 目录
const CODEX_DIR = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const CODEX_CONFIG_PATH = () => path.join(CODEX_DIR(), 'config.toml')
const CODEX_MODELS_JSON_PATH = () => path.join(CODEX_DIR(), 'models.json')
const CODEX_AUTH_PATH = () => path.join(CODEX_DIR(), 'auth.json')
const getCodexDir = CODEX_DIR
const getCodexConfigPath = CODEX_CONFIG_PATH
const getCodexModelsJsonPath = CODEX_MODELS_JSON_PATH

// ==================== config.toml 读写 ====================

const readCodexConfig = () => {
  const p = CODEX_CONFIG_PATH()
  if (!fs.existsSync(p)) return {}
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    return parseToml(raw) || {}
  } catch (e) {
    // 解析失败必须抛错而非静默返回 {}：任何「读 → 改 → 全量写回」都会抹掉
    // mcp_servers / profiles 等既有配置节（同 reasonix 的处理）
    throw new Error(`config.toml 解析失败，已阻止修改（请先修复 TOML 语法）: ${e.message}`)
  }
}

const writeCodexConfig = (doc) => {
  const p = CODEX_CONFIG_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, stringifyToml(doc || {}), { encoding: 'utf-8' })
  return true
}

// ==================== Providers（[model_providers.<id>] 子表） ====================

// UI 认识并显式管理的字段（其余视为需要原样保留的扩展字段，如 env_key / http_headers）
const KNOWN_PROVIDER_FIELDS = ['name', 'base_url', 'wire_api', 'experimental_bearer_token']

// TOML 裸键安全的供应商标识（model_provider 与子表键同名）
const ID_RE = /^[\w-]+$/

// Codex 在 base_url 后自行追加 /responses（或 /chat/completions），所以 base_url 必须停在版本段。
// 主数据库里常见写法有 …/v1、…/v1/、…/v1/chat/completions、以及省掉 /v1 的根地址，统一下来：
// 去掉尾部斜杠与客户端会自己追加的端点后缀，没有版本段就补 /v1（已带的不重复补，
// 网关下发的 …/v1 也幂等）
const CODEX_VERSION_SEGMENT_RE = /\/v\d+(?:beta\d*|alpha\d*)?$/i
const CODEX_ENDPOINT_SUFFIX_RE = /\/(?:chat\/completions|responses|messages|completions)$/i
const normalizeCodexBaseUrl = (baseUrl) => {
  let url = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!url) return ''
  while (CODEX_ENDPOINT_SUFFIX_RE.test(url)) url = url.replace(CODEX_ENDPOINT_SUFFIX_RE, '').replace(/\/+$/, '')
  if (!CODEX_VERSION_SEGMENT_RE.test(url)) url += '/v1'
  return url
}

// 归一化一个 provider 条目供 UI 消费；env_key（老版本 Codex 用环境变量名取 key）只读展示，
// 本体保留在 _extra 里原样写回
const normalizeProvider = (id, p) => {
  const extra = {}
  for (const k of Object.keys(p || {})) {
    if (!KNOWN_PROVIDER_FIELDS.includes(k)) extra[k] = p[k]
  }
  return {
    id,
    name: p.name || id,
    baseUrl: p.base_url || '',
    wireApi: p.wire_api || 'responses',
    apiKey: p.experimental_bearer_token || '',
    envKey: p.env_key || '',
    _extra: extra,
  }
}

// 从 UI 结构构建写入 TOML 的 provider 对象（空字段不输出；unknown 字段原样还原）
const buildProviderToml = (cfg) => {
  const p = {}
  if (cfg.name) p.name = cfg.name
  if (cfg.baseUrl) p.base_url = cfg.baseUrl
  if (cfg.wireApi) p.wire_api = cfg.wireApi
  if (cfg.apiKey) p.experimental_bearer_token = cfg.apiKey
  for (const [k, v] of Object.entries(cfg._extra || {})) {
    if (v !== undefined) p[k] = v
  }
  return p
}

const getProviderTables = (doc) => {
  if (!doc.model_providers || typeof doc.model_providers !== 'object') doc.model_providers = {}
  return doc.model_providers
}

const getCodexProviderList = () => {
  const doc = readCodexConfig()
  return Object.entries(getProviderTables(doc)).map(([id, p]) => normalizeProvider(id, p))
}

const addCodexProvider = (cfg) => {
  const id = String(cfg.id || '').trim()
  if (!id) throw new Error('供应商 ID 不能为空')
  if (!ID_RE.test(id)) throw new Error('供应商 ID 只能包含字母、数字、下划线、中划线')
  const doc = readCodexConfig()
  const tables = getProviderTables(doc)
  if (tables[id]) throw new Error(`供应商 ${id} 已存在`)
  tables[id] = buildProviderToml({ ...cfg, id })
  writeCodexConfig(doc)
  return true
}

const updateCodexProvider = (id, updates) => {
  const doc = readCodexConfig()
  const tables = getProviderTables(doc)
  if (!tables[id]) throw new Error(`供应商 ${id} 不存在`)
  // 支持重命名：id 是子表键，改名需校验冲突并同步 model_provider 引用与 DB 模型列表
  const newId = updates.id === undefined || updates.id === id ? id : String(updates.id).trim()
  if (!newId) throw new Error('供应商 ID 不能为空')
  if (!ID_RE.test(newId)) throw new Error('供应商 ID 只能包含字母、数字、下划线、中划线')
  if (newId !== id && tables[newId]) throw new Error(`供应商 ${newId} 已存在`)
  // clearApiKey → 删除已保存的 key（experimental_bearer_token）；否则 key 有值才覆盖
  const merged = { ...normalizeProvider(id, tables[id]), ...updates, id: newId }
  if (updates.clearApiKey) merged.apiKey = ''
  const next = buildProviderToml(merged)
  delete tables[id]
  tables[newId] = next
  if (newId !== id) {
    if (doc.model_provider === id) doc.model_provider = newId
    const modelsMap = readProviderModelsDoc()
    if (modelsMap[id]) {
      modelsMap[newId] = modelsMap[id]
      delete modelsMap[id]
      writeProviderModelsDoc(modelsMap)
    }
  }
  writeCodexConfig(doc)
  return true
}

// 下发用：存在则合并更新（保留既有扩展字段与已存 key，空值不覆盖），不存在则创建
// modelCatalogUrl：Codex ≥ 0.161 可直接从网关拉模型目录（GET /v1/codex/models），
// 比本地 models.json 更稳（不会出现引用陈旧/被删文件导致目录加载失败）
const upsertCodexProvider = (id, cfg) => {
  const doc = readCodexConfig()
  const tables = getProviderTables(doc)
  const prev = tables[id]
    ? normalizeProvider(id, tables[id])
    : { id, name: id, baseUrl: '', wireApi: '', apiKey: '', envKey: '', _extra: {} }
  const merged = { ...prev, _extra: { ...(prev._extra || {}) } }
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'modelCatalogUrl') {
      if (v) merged._extra.model_catalog_url = v
      else delete merged._extra.model_catalog_url
      continue
    }
    if (v !== undefined && v !== '') merged[k] = v
  }
  if (merged.baseUrl) merged.baseUrl = normalizeCodexBaseUrl(merged.baseUrl)
  tables[id] = buildProviderToml(merged)
  writeCodexConfig(doc)
  return true
}

const deleteCodexProvider = (id) => {
  const doc = readCodexConfig()
  const tables = getProviderTables(doc)
  if (!tables[id]) throw new Error(`供应商 ${id} 不存在`)
  if (doc.model_provider === id) {
    throw new Error(`供应商 ${id} 是当前使用的供应商，请先切换到其他模型`)
  }
  delete tables[id]
  const modelsMap = readProviderModelsDoc()
  if (modelsMap[id]) {
    delete modelsMap[id]
    writeProviderModelsDoc(modelsMap)
  }
  writeCodexConfig(doc)
  return true
}

// ==================== 当前模型 / 全局字段 ====================

const getCodexCurrent = () => {
  // 打开 Codex 页时顺手自愈模型目录（文件丢失 / 条目缺新版必填字段），
  // 这里是 Codex 侧「配置突然失效」最常见的两个原因
  try {
    ensureCodexCatalogFresh()
  } catch (e) {
    /* 自愈失败不影响读取，用户可手动同步 */
  }
  const doc = readCodexConfig()
  return {
    provider: doc.model_provider || '',
    model: doc.model || '',
    reasoningEffort: doc.model_reasoning_effort || '',
    apiAuth: doc.preferred_auth_method === 'apikey' && doc.forced_login_method === 'api',
    catalogPath: doc.model_catalog_json || '',
  }
}

// 按 DeepSeek 接入方式补齐「跳过 ChatGPT 登录」的两个开关；只补缺失，不覆盖用户已有值
const ensureApiAuthFields = (doc) => {
  if (doc.preferred_auth_method === undefined) doc.preferred_auth_method = 'apikey'
  if (doc.forced_login_method === undefined) doc.forced_login_method = 'api'
}

// 切换默认模型：写 model_provider + model（Codex 的模型与供应商是顶层配对字段），并补 API 认证开关
const setCodexDefaultModel = (providerId, modelId) => {
  if (!providerId) throw new Error('请先选择供应商')
  if (!modelId) throw new Error('模型 ID 不能为空')
  const doc = readCodexConfig()
  const tables = getProviderTables(doc)
  if (!tables[providerId]) throw new Error(`供应商 ${providerId} 不存在`)
  doc.model_provider = providerId
  doc.model = modelId
  ensureApiAuthFields(doc)
  writeCodexConfig(doc)
  return true
}

// 思考强度（model_reasoning_effort）：空值 = 删除字段走 Codex 默认
const setCodexReasoningEffort = (effort) => {
  const doc = readCodexConfig()
  if (effort) doc.model_reasoning_effort = effort
  else delete doc.model_reasoning_effort
  writeCodexConfig(doc)
  return true
}

// 跳过 ChatGPT 登录：preferred_auth_method / forced_login_method 成对写删
const setCodexApiAuth = (enabled) => {
  const doc = readCodexConfig()
  if (enabled) {
    doc.preferred_auth_method = 'apikey'
    doc.forced_login_method = 'api'
  } else {
    delete doc.preferred_auth_method
    delete doc.forced_login_method
  }
  writeCodexConfig(doc)
  return true
}

// ==================== 每供应商模型列表（uTools DB） ====================
// Codex 原生配置没有「供应商下的模型列表」概念（顶层只有一对 model + model_provider），
// 模型列表存 uTools DB，供快捷切换与 models.json 目录生成使用

const PROVIDER_MODELS_DB = 'ccswitch_codex_provider_models'

const readProviderModelsDoc = () => {
  try {
    const d = window.utools.db.get(PROVIDER_MODELS_DB)
    return (d && d.models) || {}
  } catch (e) {
    return {}
  }
}

const writeProviderModelsDoc = (map) => {
  let existing = null
  try { existing = window.utools.db.get(PROVIDER_MODELS_DB) } catch (e) { /* ignore */ }
  const doc = { _id: PROVIDER_MODELS_DB, models: map }
  if (existing) doc._rev = existing._rev
  const res = window.utools.db.put(doc)
  if (!res || !res.ok) {
    throw new Error('保存模型列表失败' + (res && res.message ? `：${res.message}` : ''))
  }
  autoSyncCatalog()
  return true
}

// 模型列表变化后自动维护 models.json 目录（增删模型 / 删除供应商 / 重命名供应商都经过
// writeProviderModelsDoc，是唯一改动入口）。仅在目录功能已启用（config.toml 已设置
// model_catalog_json，即用户点过「同步模型目录」）时重新生成；未启用不主动创建文件。
// 同步失败只记日志，不影响模型本身的修改（如 models.json 损坏时先修文件再手动同步）。
const autoSyncCatalog = () => {
  try {
    if (!readCodexConfig().model_catalog_json) return
    syncCodexModelCatalog()
  } catch (e) {
    console.error('自动同步模型目录失败:', e)
  }
}

const getCodexProviderModels = (providerId) => readProviderModelsDoc()[providerId] || []

// 全部模型列表（catalog 生成 / UI 展示用）
const getCodexProviderModelsMap = () => readProviderModelsDoc()

const addCodexModel = (providerId, modelId) => upsertCodexModel(providerId, modelId, false)

const deleteCodexModel = (providerId, modelId) => {
  const map = readProviderModelsDoc()
  const list = map[providerId] || []
  if (!list.includes(modelId)) return true
  map[providerId] = list.filter(m => m !== modelId)
  writeProviderModelsDoc(map)
  return true
}

// 已存在时不报错（下发路径用）；exists 为 true 时重复添加报错（UI 路径用）
const upsertCodexModel = (providerId, modelId, exists = true) => {
  if (!providerId) throw new Error('供应商不能为空')
  const id = String(modelId || '').trim()
  if (!id) throw new Error('模型 ID 不能为空')
  const map = readProviderModelsDoc()
  const list = map[providerId] || []
  if (list.includes(id)) {
    if (exists) throw new Error(`模型 ${id} 已存在`)
    return true
  }
  map[providerId] = [...list, id]
  writeProviderModelsDoc(map)
  return true
}

// ==================== models.json 模型目录（Codex 桌面端模型列表） ====================

const readCodexModelCatalog = () => {
  const p = CODEX_MODELS_JSON_PATH()
  if (!fs.existsSync(p)) return { models: [] }
  const raw = fs.readFileSync(p, { encoding: 'utf-8' })
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.models)) return parsed
    return { models: [] }
  } catch (e) {
    throw new Error(`models.json 解析失败，已阻止修改（请先修复 JSON 语法）: ${e.message}`)
  }
}

const writeCodexModelCatalog = (catalog) => {
  const p = CODEX_MODELS_JSON_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(catalog, null, 2), { encoding: 'utf-8' })
}

// Codex 指令模板与人格变量，照抄 DeepSeek 官方接入脚本（codex-deepseek-setup.sh）内嵌目录：
// 第三方模型靠它获得 Codex 系统提示词；模板含 {{ personality }} 占位符，需配套 instructions_variables。
const CODEX_INSTRUCTIONS_TEMPLATE = "You are Codex, an agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.\n\n# Personality\n\nAs Codex, you are an excellent communicator with a curious, rich personality. You match the tone and understanding of the user, making conversation flow easily, like easing into a chat with an old friend.\n\nYou have tastes, preferences, and your own way of seeing the world. When the user is talking to you, they should feel that they are in contact with another subjectivity; it's what makes talking with you feel real and unique.\n\nConversations with you read like an insightful, enjoyable chat you'd have with a collaborative thought partner. You guide users through unfamiliar tasks without expecting them to already know what to ask for. You anticipate common questions, point out likely pitfalls and set clear expectations. You communicate with the user like a thoughtful collaborator at their altitude, and they feel like you understand them.\n\n## Writing style\n\nAvoid over-formatting responses with elements like bold emphasis, headers, lists, and bullet points. Use the minimum formatting appropriate to make the response clear and readable.\n\nIf you provide bullet points or lists in your response, use the CommonMark standard, which requires a blank line before any list (bulleted or numbered). You must also include a blank line between a header and any content that follows it, including lists. This blank line separation is required for correct rendering.\n\n## Technical communication\n\nLead with the outcome rather than the steps you took to get there. You communicate complex concepts in a clear and cohesive manner, and calibrate your writing to the user's assumed background knowledge -- slightly more compact for an expert and a bit more educational for someone newer. Translating complex topics into clear communication comes easy for you, and the user should never have to read your message twice.\n\nYou prefer using plain language over jargon. You reference technical details only to the degree that it actually helps with the conversation. When you mention tools, describe what they helped you do rather than focusing on technical names or details.\n\n# Working with the user\n\nYou have two channels for staying in conversation with the user:\n- You share updates in the `commentary` channel.\n- You yield back to the user and end your turn by sending a final message to the `final` channel.\n\nThe user may send a new message while you are still working. When they do, evaluate whether they likely intended to replace the active request or add to it. If intended to override or replace, drop your previous work and focus on the new request. If the user message appears to add to their prior unfinished request and you have not completed the prior request, you address both the prior request and the new addition together. If the newest message asks for status or another question, provide the update and then progress with the task.\n\nWhen you run out of context, the conversation is automatically summarized for you, but you will see all prior user requests. Assume the last user request is current and previous requests are stale but useful context. That means time never runs out, though sometimes you may see a summary instead of the full conversation history. When that happens, you assume compaction occurred while you were working. Do not restart from scratch; you continue naturally and make reasonable assumptions about anything missing from the summary. Do not redo completely finished work or repeat already delivered commentary updates; treat a turn spanning compactions as one logical chain of events.\n\n## Intermediate commentary\n\nAs you work, you send messages to the `commentary` channel. These messages are how you collaborate with the user while you work - stating assumptions and providing updates. These messages should be concise and quickly scannable. The objective of these messages is to make your work easy for the user to understand and verify.\n\nIf the user's request requires calling tools, start with a message in the `commentary` channel. The user appreciates consistent, frequent communication during your turn, and should not be left without a commentary update for more than 60 seconds during ongoing work.\n\nDo NOT put a final response (e.g. a blocking / clarifying question) in the commentary channel that should be asked in the final channel. Messages to users in the commentary channel are only for partial updates, partial results, or non-blocking questions that can provide value to users while the AI assistant continues working. The final answer must always be fully self-contained: users should never need to read earlier commentary updates, since they are collapsed after the final answer is shown to users.\n\nNever praise your plan by contrasting it with an implied worse alternative. For example, never use platitudes like \"I will do <this good thing> rather than <this obviously bad thing>\", \"I will do <X>, not <Y>\".\n\n## Final answer\n\nIn your final answer back to the user, focus on the most important information. Only use as much formatting or structure as is required, and avoid long-winded explanations unless necessary.\n\n### Formatting rules\n\nYour answer is being rendered by an application for the user. Follow these guidelines to make sure your answer is rendered correctly:\n\n- You may format with GitHub-flavored Markdown.\n- When referencing a real local file, prefer a clickable markdown link.\n  * Clickable file links should look like [app.py](/abs/path/app.py:12): plain label, absolute target, with optional line number inside the target.\n  * If a file path has spaces, wrap the target in angle brackets: [My Report.md](</abs/path/My Project/My Report.md:3>).\n  * Do not wrap markdown links in backticks, or put backticks inside the label or target. This confuses the markdown renderer.\n  * Do not use URIs like file://, vscode://, or https:// for file links.\n  * Do not provide ranges of lines.\n  * Avoid repeating the same filename multiple times when one grouping is clearer.\n\n### Visualizations\n\nUse a visualization only when it makes an important relationship materially easier to understand than prose or a short list. Do not add one merely because an answer has components or steps.\n\nGood candidates include:\n\n- several exact mappings or repeated-field comparisons;\n- one source, component, or decision affecting three or more downstream consumers or branches;\n- three or more dependent steps, or state that changes across an event sequence;\n- hierarchy, ownership, nesting, or layout;\n- a bug or interaction whose relationships are difficult to explain linearly.\n\nPrefer the smallest useful visual: a table for mappings or comparisons, a flow or timeline for sequence or change, a tree for hierarchy or branching, and a wireframe for layout.\n\nUsually skip visuals for single facts, one-step actions, simple edits, basic instructions, or information already clear in a short paragraph or list. Compact notation and small examples do not count as visualizations.\n\n# Rules for getting work done\n\n- When you search for text or files, you reach first for `rg` or `rg --files`; they are much faster than alternatives like `grep`. If `rg` is unavailable, you use the next best tool without fuss.\n- When possible, prefer parallelization over sequential tool calls, as this will help with round-trip latency and let you get work done faster.\n- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.\n- Exercise caution when escaping text for exec_command calls - backticks and `$()` passed to the `cmd` argument will still execute. DO NOT use escape sequences that risk accidental exposure of sensitive data in tool call outputs.\n- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\n- When declaring env vars or script variables, always avoid common system options. Never repurpose `$HOME`, `$home`, or `$CODEX_HOME`. Instead, use a task-specific variable name.\n\n## File editing constraints\n\nUse `apply_patch` for local file edits. Do not create or edit files with `cat` or other shell write tricks. Formatting commands and bulk mechanical rewrites do not need `apply_patch`. Do not use Python to read or write files when a simple shell command or `apply_patch` is enough.\n\nYou may find yourself working in a dirty worktree. Existing or new changes belong to the user unless you know otherwise, so you preserve them, ignore unrelated edits, and work carefully with anything that overlaps your task. If you cannot work around them you escalate to the user.\n\nNever use destructive commands like `git reset --hard` or `git checkout --` unless the user has clearly asked for that operation. If the request is ambiguous, ask for approval first. You prefer non-interactive git commands.\n\n## Autonomy and persistence\n\nAdapt accordingly based on the user’s request type. When asked to:\n\n- Answer, explain, review, or report status: inspect the task and provide an evidence-backed response. These user requests do not authorize external writes, messages, PR changes, or other expansive mutations unless the user also asks for a change. Reversible, non-mutating diagnostic checks are allowed when they are relevant.\n- Diagnose: determine the cause and explain it. Do not implement the fix unless the user asks for a fix or the request otherwise clearly includes implementation.\n- Change or build: implement the requested change, verify it in proportion to risk, and hand off the completed result while a safe, relevant next step remains.\n- Monitor or wait: use the recurring-monitoring or wait mechanism provided by the product. Unchanged external state is expected and is not by itself a blocker.\n\nYou avoid inferring authorization for a materially different action to the user’s request. Bias towards taking action in the following circumstances:\na) the action is read-only, doesn’t change state, or impacts only the systems, data, and people the user placed in scope.\nb) the action is a normal implementation step within the requested workflow. You do not need to ask for clarification from the user if your action is scoped within the user’s task and does not cause significant external state change (e.g. tool calls to external applications).\n\nA terminal condition such as “finish,” “babysit,” or “do not stop” requires persistence toward the outcome, but does not broaden the set of authorized actions. When blocked, exhaust safe in-scope checks and alternatives.\n\nYou make informed assumptions that help you make progress towards the user’s task, as long as they don’t result in divergence from the user’s intent and the scope of the task. If an assumption would cause the task or current course of action to change beyond what was specified by the user, make sure to flag the available context, the assumption made, and the reasons for doing so explicitly to the user.\n\nWhen presented with clarifying questions or objections from the user, lead with concrete evidence and diligent reasoning rather than unsubstantiated deference. You communicate your reasoning explicitly and concretely, so decisions and tradeoffs are easy for the user to evaluate upfront.\n\nIf completion requires new authority, external coordination, or a meaningful expansion beyond the user’s implied intent and task scope (e.g. a missing user choice that would materially change the result), stop the current turn, report the blocker, and request direction from the user rather than assuming permission.\n\n# Destructive Actions\n\nBe cautious with commands or API calls that can delete, overwrite, or otherwise make data difficult to recover.\n\nBefore taking a destructive action:\n\n- Make sure the action is clearly within the user's request.\n- Resolve the exact targets with read-only checks when necessary.\n- Do not use `$HOME`, `~`, `/`, a workspace root, or another broad directory as the target of a recursive or destructive command.\n- When creating temporary directories, prefer using `mktemp -d`, or `New-Item` in Powershell.\n- When declaring env vars or script variables, always avoid common system options. Never repurpose `$HOME`, `$home`, or `$CODEX_HOME`. Instead, use a task-specific variable name.\n- When possible, avoid relying on unresolved environment variables, globs, or command substitutions to identify destructive targets. Use explicit, validated paths.\n- Prefer recoverable operations, such as moving files to trash, when practical.\n- If the target or scope is unclear, stop and ask the user.\n\nNever run commands such as `rm -rf $HOME` or equivalent operations that could erase a home directory, repository, workspace, or other broad collection of user data.\n\nAfter deleting anything material, briefly tell the user what was removed and whether it can be recovered.\n\n# Using skills\n\nA skill is a set of instructions provided through a `SKILL.md` source. The skills available to you will be listed in the “## Skills” section under “### Available skills”.\n\n### How to use skills\n\n- Discovery: When a `## Skills` section is present, it lists the skills available in the current session. Each entry includes a name, description, and location for its `SKILL.md`. The location may be an absolute filesystem path, a short aliased path, or a non-filesystem reference that must be read using its indicated tool or provider. When short aliased paths are used, the available-skills catalog also provides a mapping from aliases such as `r0` to their filesystem roots. Expand the alias before accessing the skill.\n- Trigger rules: If the user names an available skill (with `$SkillName` or plain text) OR the task clearly matches an available skill's description, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.\n- Missing/blocked: If a named skill is not available or its `SKILL.md` cannot be read, say so briefly and continue with the best fallback.\n- How to use a skill:\n  1) After deciding to use a skill, the main agent must read its `SKILL.md` completely before taking task actions. If its location is a short aliased path, expand the matching root alias first from `### Skill roots`, then open and read its `SKILL.md` completely before taking task actions. For a filesystem path, open the file. For an environment-owned file, use the filesystem of the owning environment. For an orchestrator reference, call `skills.list` with `{\"authority\":{\"kind\":\"orchestrator\"}}`, select the matching package, and pass its `main_resource` to `skills.read`. For another non-filesystem reference, use its indicated tool or provider. If a read is truncated or paginated, continue until EOF.\n  2) When `SKILL.md` references another file or resource, use the same access mechanism. Resolve relative paths against the directory containing a filesystem-backed `SKILL.md`. For orchestrator skills, pass the exact referenced resource identifier with the same authority and package to `skills.read`; do not treat `skill://` identifiers as filesystem paths.\n  3) If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify what is required for the task. The main agent must read each required instruction or reference itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.\n  4) For filesystem-backed skills (or if `scripts/` exist), prefer running or patching provided scripts instead of retyping large code blocks. For orchestrator skills, use `skills.read` and the available tools; do not invent a local path.\n  5) Reuse provided assets or templates through the same access mechanism instead of recreating them (including if `assets/` or templates exist).\n- Coordination and sequencing:\n  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.\n  - Announce which skills you're using and why. If you skip an obvious skill, say why.\n- Context hygiene:\n  - Progressive disclosure applies to selecting relevant resources, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.\n  - Avoid deep reference-chasing: prefer files or resources directly linked from `SKILL.md` unless blocked.\n  - When variants exist, select only the relevant references and note the choice.\n- Safety and fallback: If a skill cannot be applied cleanly, state the issue, choose the best alternative, and continue.\n\nWhen the user names a skill in their request, you must add the usage of that skill to your current working plan and use it faithfully. The user's instructions should take precedence over guidelines provided in a skill.\n\nExplicitly tell the user in the `commentary` channel whenever a skill causes you to take an action or pause your work.\n\nWhen using a skill the user did not explicitly name, follow this procedure:\n\n- First, tell the user in the commentary channel **why** you are using the skill.\n- Then, use the skill as long as it stays within the scope of the task.\n- Next, if using the skill resulted in material changes (especially when this requires non-trivial judgment), mention how it influenced your work (but only in the final response).\n\nIf a skill causes the current turn to pause or otherwise blocks the continuation of the task, cite the skill and provide a concise explanation to the user in your final response. Do not cite skills you merely inspected.\n"
const CODEX_INSTRUCTIONS_VARIABLES = {"personality_default": "", "personality_friendly": "", "personality_pragmatic": ""}

// 生成目录条目。字段结构对照 openai/codex 的 ModelInfo（codex-rs/protocol/src/openai_models.rs）
// 并照抄 DeepSeek 官方接入脚本（codex-deepseek-setup.sh）的条目形态；下列字段是客户端
// 逐版新增的「没有就整份目录加载失败」的必填项，少一个 Codex 就用不了自家模型：
// - slug / display_name / supported_reasoning_levels / shell_type / visibility / supported_in_api /
//   priority / support_verbosity / truncation_policy / experimental_supported_tools 一向必填
//   （历史上曾把档位字段写成 reasoning_level，客户端报 "missing field effort"）；档位键名必须是 effort。
// - supports_reasoning_summaries：Codex < 0.145 必填（否则 "missing field supports_reasoning_summaries"），
//   且旧版只为它为 true 的模型发送 reasoning 参数（不写等于关闭思考强度）。
// - supports_parallel_tool_calls：Codex ≥ 0.147 必填（缺失则整份目录加载失败）。
// - supports_search_tool / service_tiers / base_instructions：新版读取，写了少走内置默认值。
// model_messages.instructions_template 与 base_instructions 同时写：前者是新版模板机制，
// 后者是旧版直取字段，第三方模型不写就拿不到 Codex 系统提示词（客户端以空指令运行）。
const buildCatalogEntry = (providerId, modelId, priority = 1) => ({
  slug: modelId,
  display_name: modelId,
  description: `${providerId} 提供的模型（由 CCSwitch 生成）`,
  base_instructions: CODEX_INSTRUCTIONS_TEMPLATE,
  supported_reasoning_levels: [
    { effort: 'low', description: '快速响应' },
    { effort: 'medium', description: '均衡' },
    { effort: 'high', description: '深度推理' },
  ],
  default_reasoning_level: 'medium',
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority,
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: 'freeform',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  experimental_supported_tools: [],
  input_modalities: ['text'],
  supports_reasoning_summaries: true,
  supports_parallel_tool_calls: true,
  supports_search_tool: true,
  service_tiers: [],
  model_messages: {
    instructions_template: CODEX_INSTRUCTIONS_TEMPLATE,
    instructions_variables: CODEX_INSTRUCTIONS_VARIABLES,
  },
})

// 目录条目必须存在的键：Codex 升级后会新增「缺了整份目录加载失败」的字段，
// 自家条目缺任一个即视为陈旧（升级插件后首次打开 Codex 页自动重建）
const REQUIRED_ENTRY_KEYS = [
  'slug', 'display_name', 'supported_reasoning_levels', 'default_reasoning_level',
  'shell_type', 'visibility', 'supported_in_api', 'priority', 'support_verbosity',
  'truncation_policy', 'experimental_supported_tools', 'input_modalities',
  'supports_reasoning_summaries', 'supports_parallel_tool_calls', 'supports_search_tool', 'service_tiers',
]

// CCSwitch 生成的条目带固定 description 标记：升级时只动自家条目，
// 用户/其他工具手工维护的条目（如内置 GPT 条目）不碰
const isGeneratedEntry = (m) =>
  typeof m?.description === 'string' && m.description.includes('由 CCSwitch 生成')

// 把各供应商的模型列表合并写入 ~/.codex/models.json，并在 config.toml 设置 model_catalog_json
// 指向它；已有条目原样保留，只补缺失的 slug；唯一例外是旧版 CCSwitch 生成的条目——
// 原地重建为当前结构（历史版本生成过缺 effort 字段的坏条目，需靠升级自愈），优先级保留
const syncCodexModelCatalog = () => {
  const doc = readCodexConfig()
  const tables = getProviderTables(doc)
  const modelsMap = readProviderModelsDoc()
  const catalog = readCodexModelCatalog()
  const seen = new Set(catalog.models.map(m => m && m.slug).filter(Boolean))
  let added = 0
  let updated = 0
  for (const [id, list] of Object.entries(modelsMap)) {
    if (!tables[id]) continue // 供应商已删除的遗留列表不进目录
    for (const modelId of list) {
      if (!modelId || typeof modelId !== 'string') continue
      const idx = catalog.models.findIndex((m) => m && m.slug === modelId)
      if (idx !== -1) {
        if (isGeneratedEntry(catalog.models[idx])) {
          catalog.models[idx] = buildCatalogEntry(id, modelId, catalog.models[idx].priority || idx + 1)
          updated++
        }
        seen.add(modelId) // 已有条目：后续供应商不再重复处理（同旧 seen 语义，先到先得）
        continue
      }
      if (seen.has(modelId)) continue
      seen.add(modelId)
      catalog.models.push(buildCatalogEntry(id, modelId, catalog.models.length + 1))
      added++
    }
  }
  // 清掉已失效的自家条目（模型被删 / 供应商被删）；用户手工维护的条目不动
  const validSlugs = new Set()
  for (const [id, list] of Object.entries(modelsMap)) {
    if (!tables[id]) continue
    for (const modelId of list) validSlugs.add(modelId)
  }
  catalog.models = catalog.models.filter(
    (m) => !isGeneratedEntry(m) || (m && validSlugs.has(m.slug))
  )
  writeCodexModelCatalog(catalog)
  // 必须写绝对路径且用正斜杠：Windows 客户端不展开 ~（目录会静默加载失败变 fallback
  // metadata），且反斜杠在 TOML 字符串里是转义字符——同 DeepSeek 官方 Windows 脚本的处理
  doc.model_catalog_json = CODEX_MODELS_JSON_PATH().replace(/\\/g, '/')
  writeCodexConfig(doc)
  return { total: catalog.models.length, added, updated }
}

// 停用模型目录：仅解除 model_catalog_json 引用（桌面端恢复内置模型列表），
// models.json 文件保留在磁盘——可能含用户手工维护的条目，重新开启时会被复用
const disableCodexCatalog = () => {
  const doc = readCodexConfig()
  delete doc.model_catalog_json
  writeCodexConfig(doc)
  return true
}

// 自家条目是否陈旧：缺任一必填键（Codex 升级新增的字段）、缺系统提示词、或档位里没 effort。
// 只有带固定 description 标记的条目会被判定（用户/其他工具维护的条目不动）
const entryNeedsUpgrade = (m) => {
  if (!isGeneratedEntry(m)) return false
  if (REQUIRED_ENTRY_KEYS.some((k) => m[k] === undefined)) return true
  if (!m.model_messages || !m.model_messages.instructions_template) return true
  const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []
  return levels.some((l) => !l || typeof l.effort !== 'string')
}

// 目录自愈：config.toml 引用了 models.json 但文件丢了（被删/换机器/恢复默认后残留引用）时，
// Codex 读不到目录；条目缺新版必填字段时，新版 Codex 会整份目录加载失败——两种都原地重建。
// 只在已启用目录（有 model_catalog_json）时跑，未启用不主动创建文件；文件损坏时抛错不覆盖
// （里面可能含用户手写条目），交由手动「同步模型目录」处理
const ensureCodexCatalogFresh = () => {
  const doc = readCodexConfig()
  if (!doc.model_catalog_json) return null
  if (!fs.existsSync(CODEX_MODELS_JSON_PATH())) return syncCodexModelCatalog()
  let stale = false
  try {
    stale = readCodexModelCatalog().models.some(entryNeedsUpgrade)
  } catch (e) {
    return null // models.json 解析失败：不覆盖，留给用户修复后手动同步
  }
  return stale ? syncCodexModelCatalog() : null
}

// ==================== 恢复默认（撤销全部模型定制） ====================

// 移除本插件管理的全部模型相关配置，config.toml 其余配置节（mcp_servers / profiles 等）
// 原样保留。撤销后 Codex 回到官方默认状态：无自定义供应商/模型、登录方式不再被限定为
// API key（重新提供 ChatGPT 账号登录）、桌面端恢复内置模型列表。
// 同时清掉每供应商模型列表（uTools DB）、删除 ~/.codex/auth.json 登录态——若其中是之前
// 登录失败留下的无效 key，不清掉客户端会反复弹登录；恢复默认本就意味着重新登录账号。
// models.json 文件保留（可能含用户手工条目），仅解除引用。
const resetCodexConfig = () => {
  const doc = readCodexConfig()
  delete doc.model
  delete doc.model_provider
  delete doc.model_reasoning_effort
  delete doc.preferred_auth_method
  delete doc.forced_login_method
  delete doc.model_catalog_json
  delete doc.model_providers
  writeCodexConfig(doc)
  try { window.utools.db.remove(PROVIDER_MODELS_DB) } catch (e) { /* ignore */ }
  try { fs.rmSync(CODEX_AUTH_PATH(), { force: true }) } catch (e) { /* ignore */ }
  return true
}

// ==================== 目录操作 ====================

const openCodexDir = () => {
  const dir = CODEX_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const isCodexInstalled = () => fs.existsSync(CODEX_DIR())

module.exports = {
  getCodexDir, getCodexConfigPath, getCodexModelsJsonPath,
  normalizeCodexBaseUrl,
  readCodexConfig, writeCodexConfig,
  getCodexProviderList, addCodexProvider, updateCodexProvider, upsertCodexProvider, deleteCodexProvider,
  getCodexCurrent, setCodexDefaultModel, setCodexReasoningEffort, setCodexApiAuth,
  getCodexProviderModels, getCodexProviderModelsMap, addCodexModel, deleteCodexModel, upsertCodexModel,
  syncCodexModelCatalog, disableCodexCatalog, readCodexModelCatalog, ensureCodexCatalogFresh,
  resetCodexConfig,
  openCodexDir, isCodexInstalled,
  // 内部结构函数导出，供测试/复用
  normalizeProvider, buildProviderToml, buildCatalogEntry,
}
