// grok.js 冒烟测试：node tests/smoke-grok-test.cjs（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-test-'))
process.env.GROK_HOME = tmp
process.env.CCCONFIG_LOCALE = process.env.CCCONFIG_LOCALE || 'zh-CN'

// 最小 uTools stub：grok.js 只在 shellOpenPath / db（统计落库）上用到
const dbDocs = new Map()
global.window = global.window || {}
window.utools = {
  getPath: () => os.tmpdir(),
  getNativeId: () => 'test-native',
  shellOpenPath: () => {},
  db: {
    get: (id) => dbDocs.get(id) || null,
    put: (doc) => { dbDocs.set(doc._id, doc); return { ok: true, id: doc._id } },
    remove: (id) => { dbDocs.delete(id); return { ok: true } },
    allDocs: () => Array.from(dbDocs.values()),
  },
}

const { parse, stringify } = require('../public/preload/node_modules/smol-toml')
const grok = require('../public/preload/services/grok')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)
const throws = (fn, name) => {
  try { fn(); failed++; console.error(`  ✗ ${name}（未抛错）`) }
  catch (e) { passed++; console.log(`  ✓ ${name}（${e.message.slice(0, 60)}…）`) }
}

const cfgPath = path.join(tmp, 'config.toml')
const rawDoc = () => parse(fs.readFileSync(cfgPath, 'utf-8'))

// ==================== 1. 缺文件 / 空档 ====================
console.log('1. 缺文件与空档')
fs.rmSync(tmp, { recursive: true, force: true })
ok(grok.getGrokProviderList().length === 0, '缺文件时供应商列表为空')
ok(grok.getGrokModelList().length === 0, '缺文件时模型列表为空')
eq(grok.getGrokDefaultModel(), { modelId: '', webSearch: '' }, '缺文件时默认模型为空')
ok(grok.hasGrokConfig() === false, '缺文件时 hasGrokConfig=false')
ok(grok.isGrokInstalled() === false, '未安装检测')
fs.mkdirSync(tmp, { recursive: true })
ok(grok.isGrokInstalled() === true, '目录存在即视为已安装')
fs.writeFileSync(cfgPath, '')
eq(grok.getGrokProviderList(), [], '空文件视为合法空档')

// ==================== 2. 供应商 CRUD ====================
console.log('2. 供应商 CRUD')
grok.addGrokProvider({
  name: 'bigmodel',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiBackend: 'chat_completions',
  apiKey: 'sk-provider-1',
  contextWindow: 200000,
  extraHeaders: { 'X-Tenant': 'acme' },
})
let doc = rawDoc()
eq(doc.model_providers.bigmodel.base_url, 'https://open.bigmodel.cn/api/paas/v4', '[model_providers.<name>] 写入')
eq(doc.model_providers.bigmodel.api_key, 'sk-provider-1', 'api_key 写在供应商上')
ok(doc.model_providers.bigmodel.api_backend === undefined, '默认后端不写入 TOML（chat_completions 为默认值）')
eq(doc.model_providers.bigmodel.context_window, 200000, 'context_window 写在供应商上')
eq(doc.model_providers.bigmodel.extra_headers, { 'X-Tenant': 'acme' }, 'extra_headers 写在供应商上')
let plist = grok.getGrokProviderList()
eq(plist.length, 1, '供应商列表一条')
eq([plist[0].name, plist[0].modelCount], ['bigmodel', 0], '新供应商无模型')
eq(plist[0].apiBackend, 'chat_completions', '未写 api_backend 时读出默认值')

throws(() => grok.addGrokProvider({ name: 'bigmodel' }), '重复供应商名拒绝')
throws(() => grok.addGrokProvider({ name: 'bad name' }), '非法供应商名拒绝')
throws(() => grok.addGrokProvider({ name: 'x', apiBackend: 'google' }), '不支持的 api_backend 拒绝')

// 改 API Key / 清空
grok.updateGrokProvider('bigmodel', { apiKey: 'sk-provider-2' })
eq(rawDoc().model_providers.bigmodel.api_key, 'sk-provider-2', '供应商 key 覆盖')
grok.updateGrokProvider('bigmodel', { clearApiKey: true })
ok(rawDoc().model_providers.bigmodel.api_key === undefined, 'clearApiKey 删除字段')

// ==================== 3. 模型 CRUD（挂在供应商下） ====================
console.log('3. 模型 CRUD')
const key1 = grok.addGrokModel('bigmodel', {
  key: 'glm-5',
  model: 'z-ai/glm-5',
  name: 'GLM-5',
  contextWindow: 200000,
  maxCompletionTokens: 32768,
})
eq(key1, 'glm-5', '模型目录键')
doc = rawDoc()
eq(doc.model['glm-5'].model_provider, 'bigmodel', '模型条目引用供应商')
eq(doc.model['glm-5'].context_window, 200000, '模型级 context_window')
ok(doc.model['glm-5'].base_url === undefined, '挂供应商的模型不内联 base_url')
ok(doc.model['glm-5'].api_key === undefined, '挂供应商的模型不内联 api_key')
eq(doc.models.default, 'glm-5', '无默认时自动指向首个模型')

plist = grok.getGrokProviderList()
eq(plist[0].modelCount, 1, '供应商下模型计数')
eq(plist[0].models[0].key, 'glm-5', '模型 key')
eq(plist[0].models[0].model, 'z-ai/glm-5', 'model = 发往 API 的模型 ID')
ok(plist[0].models[0].isBuiltinOverride === false, '挂供应商的模型不算内置覆盖')

grok.addGrokModel('bigmodel', { key: 'glm-5-air', model: 'z-ai/glm-5-air' })
eq(grok.getGrokProviderList()[0].modelCount, 2, '同一供应商下第二个模型')

throws(() => grok.addGrokModel('bigmodel', { key: 'glm-5', model: 'x' }), '重复模型键拒绝')
throws(() => grok.addGrokModel('bigmodel', { key: 'bad key', model: 'x' }), '非法模型键拒绝')
throws(() => grok.addGrokModel('ghost', { key: 'm1', model: 'x' }), '引用不存在的供应商拒绝')

// 改键名 → 默认模型跟随
grok.updateGrokModel('glm-5', { key: 'glm-5-pro', contextWindow: 128000 })
eq(grok.getGrokModelList().map((m) => m.key).sort(), ['glm-5-air', 'glm-5-pro'], '改模型键生效')
eq(grok.getGrokDefaultModel().modelId, 'glm-5-pro', '改键后默认模型跟随')
eq(rawDoc().model['glm-5-pro'].context_window, 128000, '更新 context_window')

// 内联模型（官方文档里直接写 base_url 的写法）
grok.addGrokModel('', { key: 'ollama-local', model: 'codellama', baseUrl: 'http://localhost:11434/v1' })
const inline = grok.getGrokModelList().find((m) => m.key === 'ollama-local')
eq(inline.modelProvider, '', '内联模型无 model_provider')
eq(inline.baseUrl, 'http://localhost:11434/v1', '内联模型的 base_url')
eq(grok.getGrokUngroupedModels().map((m) => m.key), ['ollama-local'], '未分组模型列表')
ok(grok.getGrokProviderList().every((p) => p.models.every((m) => m.key !== 'ollama-local')), '内联模型不归入任何供应商')

// 内联 → 挂到供应商：内联连接信息被清掉
grok.updateGrokModel('ollama-local', { modelProvider: 'bigmodel' })
doc = rawDoc()
eq(doc.model['ollama-local'].model_provider, 'bigmodel', '改成挂供应商')
ok(doc.model['ollama-local'].base_url === undefined, '挂供应商后清掉内联 base_url')

// 内置模型覆盖
grok.addGrokModel('', { key: 'grok-4.6', model: 'grok-4.6', temperature: 0.3 })
const builtin = grok.getGrokModelList().find((m) => m.key === 'grok-4.6')
ok(builtin.isBuiltinOverride === true, '无 base_url/api_key/model_provider 判定为内置覆盖')
eq(rawDoc().model['grok-4.6'].temperature, 0.3, 'temperature 写入')
ok(rawDoc().model['grok-4.6'].base_url === undefined, '内置覆盖不写 base_url')

// 供应商改名 → 引用同步
grok.updateGrokProvider('bigmodel', { name: 'zhipu' })
doc = rawDoc()
ok(doc.model_providers.bigmodel === undefined, '旧供应商键删除')
eq(doc.model['glm-5-air'].model_provider, 'zhipu', '改名后模型引用同步')

// 供应商仍被引用时不许删
throws(() => grok.deleteGrokProvider('zhipu'), '被引用的供应商拒绝删除')
grok.deleteGrokModel('glm-5-air')
grok.deleteGrokModel('glm-5-pro')
grok.deleteGrokModel('ollama-local')
grok.deleteGrokProvider('zhipu')
eq(grok.getGrokProviderList(), [], '解除引用后可删供应商')
ok(rawDoc().model_providers === undefined, '空供应商表整节删除')

// ==================== 4. 默认模型 ====================
console.log('4. 默认模型')
grok.setGrokDefaultModel('grok-4.6')
eq(rawDoc().models.default, 'grok-4.6', '设置默认模型')
eq(grok.getGrokDefaultModel().modelId, 'grok-4.6', '读回默认模型')
throws(() => grok.setGrokDefaultModel('nope'), '默认模型必须存在')
grok.setGrokDefaultModel('')
ok(rawDoc().models.default === undefined, '空值清除默认（键删除）')
grok.addGrokModel('', { key: 'after-reset', model: 'x' })
eq(grok.getGrokDefaultModel().modelId, 'after-reset', '清空后新增模型重新自动设默认')
grok.deleteGrokModel('after-reset')
ok(grok.getGrokDefaultModel().modelId !== 'after-reset', '删除默认模型后引用不悬挂')

// ==================== 5. 其它配置节保留 ====================
console.log('5. 其它配置节保留')
doc = rawDoc()
doc.ui = { vim_mode: true }
doc.features = { telemetry: false }
doc.mcp_servers = { keep: { command: 'x', args: ['a'] } }
fs.writeFileSync(cfgPath, stringify(doc))
grok.addGrokProvider({ name: 'gw', baseUrl: 'https://gw.example/v1' })
grok.addGrokModel('gw', { key: 'keep-test', model: 'm' })
doc = rawDoc()
eq(doc.ui, { vim_mode: true }, '写入供应商/模型时保留 [ui]')
eq(doc.features, { telemetry: false }, '保留 [features]')
eq(doc.mcp_servers.keep.command, 'x', '保留 [mcp_servers]')

// 未知字段往返
doc.model['keep-test'].reasoning_summary = 'none'
doc.model_providers.gw.max_request_bytes = 25000000
doc.model_providers.gw.auth_provider = 'corp'
doc.model['keep-test'].stream_tool_calls = false
fs.writeFileSync(cfgPath, stringify(doc))
grok.updateGrokModel('keep-test', { name: 'Keep Test' })
grok.updateGrokProvider('gw', { apiKey: 'sk-gw' })
doc = rawDoc()
eq(doc.model['keep-test'].reasoning_summary, 'none', '模型未知字段 reasoning_summary 原样保留')
eq(doc.model['keep-test'].stream_tool_calls, false, '模型未知字段 stream_tool_calls 原样保留')
eq(doc.model_providers.gw.max_request_bytes, 25000000, '供应商未知字段 max_request_bytes 保留')
eq(doc.model_providers.gw.auth_provider, 'corp', '供应商未知字段 auth_provider 保留')

// 解析失败必须抛错（阻止覆盖）
fs.writeFileSync(cfgPath, 'not = valid = toml\n')
throws(() => grok.getGrokModelList(), 'TOML 解析失败抛错（不静默覆盖）')
fs.writeFileSync(cfgPath, '')

// ==================== 6. 下发 upsert ====================
console.log('6. 下发 upsert')
grok.upsertGrokProvider('acme-gateway', { apiBackend: 'responses', baseUrl: 'https://gw.example/v1', apiKey: 'sk-gw' })
doc = rawDoc()
eq(doc.model_providers['acme-gateway'].base_url, 'https://gw.example/v1', '下发写入供应商表')
eq(doc.model_providers['acme-gateway'].api_backend, 'responses', 'api_backend 写供应商')
const mid = grok.upsertGrokModel('acme-gateway', 'acme/opus', { name: 'Acme Opus', contextWindow: 500000, maxTokens: 64000 })
eq(mid, 'acme/opus', '模型目录键含斜杠（smol-toml 自动加引号）')
doc = rawDoc()
eq(doc.model['acme/opus'].model_provider, 'acme-gateway', 'model_provider 引用供应商')
eq(doc.model['acme/opus'].context_window, 500000, 'context_window 下发到模型级')
ok(doc.model_providers['acme-gateway'].context_window === undefined, '下发不再把上下文写到供应商（避免同供应商模型互相覆盖）')
eq(doc.models.default, 'acme/opus', '无默认时自动指向首个下发模型')
grok.setGrokDefaultModel('acme/opus')
grok.upsertGrokModel('acme-gateway', 'acme/sonnet', { contextWindow: 200000 })
eq(grok.getGrokDefaultModel().modelId, 'acme/opus', '已有默认不被覆盖')
// 再下发同一模型：保留既有字段、清掉可能残留的内联连接信息
doc.model['acme/opus'].base_url = 'https://stale.example/v1'
fs.writeFileSync(cfgPath, stringify(doc))
grok.upsertGrokModel('acme-gateway', 'acme/opus', { name: 'Acme Opus' })
ok(rawDoc().model['acme/opus'].base_url === undefined, '再次下发清掉内联 base_url')
// 中文供应商名清洗
eq(grok.providerKeyFor('我的网关'), grok.providerKeyFor('我的网关'), '中文名清洗后确定性')
ok(/^[A-Za-z0-9_:.-]+$/.test(grok.providerKeyFor('我的网关')), '清洗结果只含 ASCII 键字符')
eq(grok.getGrokProviderList().map((p) => p.name), ['acme-gateway'], '供应商列表')

// ==================== 7. MCP ====================
console.log('7. MCP（[mcp_servers] + disabled_mcp_servers）')
grok.setGrokMcpServer('filesystem', { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { FOO: 'bar' }, startupTimeoutSec: 60 })
grok.setGrokMcpServer('sentry', { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer t' } })
let mcps = grok.getGrokMcpServers()
eq(mcps.map((m) => m.name), ['filesystem', 'sentry'], 'MCP 列表')
eq(mcps.find((m) => m.name === 'filesystem').args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], 'stdio args')
eq(mcps.find((m) => m.name === 'sentry').type, 'http', 'http 类型')
eq(mcps.find((m) => m.name === 'sentry').headers, { Authorization: 'Bearer t' }, 'headers')
doc = rawDoc()
eq(doc.mcp_servers.filesystem.command, 'npx', 'TOML [mcp_servers.<name>]')
eq(doc.mcp_servers.filesystem.startup_timeout_sec, 60, 'startup_timeout_sec')
ok(doc.mcp_servers.filesystem.enabled === undefined, '不写 enabled 字段（开关走 disabled 名单）')

// 关闭 → 名单；再开启 → 名单移除
grok.setGrokMcpEnabled('filesystem', false)
eq(rawDoc().disabled_mcp_servers, ['filesystem'], '关闭写入 disabled_mcp_servers')
eq(grok.getGrokMcpServers().find((m) => m.name === 'filesystem').enabled, false, '关闭后 enabled=false')
grok.setGrokMcpEnabled('filesystem', true)
ok(rawDoc().disabled_mcp_servers === undefined, '开启后名单清空（键删除）')
eq(grok.getGrokMcpServers().find((m) => m.name === 'filesystem').enabled, true, '开启后 enabled=true')

// 未知字段往返
doc = rawDoc()
doc.mcp_servers.filesystem.oauth = { client_id: 'cid' }
doc.mcp_servers.filesystem.tool_timeouts = { slow: 120 }
fs.writeFileSync(cfgPath, stringify(doc))
grok.setGrokMcpServer('filesystem', { type: 'stdio', command: 'npx', args: ['-y', 'x'] })
doc = rawDoc()
eq(doc.mcp_servers.filesystem.oauth, { client_id: 'cid' }, '未知字段 oauth 原样保留')
eq(doc.mcp_servers.filesystem.tool_timeouts, { slow: 120 }, '未知字段 tool_timeouts 原样保留')

throws(() => grok.setGrokMcpServer('bad name', { type: 'stdio', command: 'x' }), 'MCP 名非法拒绝')
throws(() => grok.setGrokMcpServer('nourl', { type: 'http' }), 'http 缺 url 拒绝')
throws(() => grok.setGrokMcpServer('nocmd', { type: 'stdio' }), 'stdio 缺 command 拒绝')
grok.deleteGrokMcpServer('sentry')
eq(grok.getGrokMcpServers().map((m) => m.name), ['filesystem'], '删除 MCP')

// ==================== 8. Skill（.disabled 目录机制） ====================
console.log('8. Skill')
const skillsDir = grok.getGrokSkillsDir()
fs.mkdirSync(path.join(skillsDir, 'git-helper'), { recursive: true })
fs.writeFileSync(path.join(skillsDir, 'git-helper', 'SKILL.md'), '---\nname: git-helper\ndescription: help\n---\nbody\n')
let skills = grok.getGrokSkills()
eq(skills.map((s) => s.name), ['git-helper'], '扫描 ~/.grok/skills')
eq(skills[0].disabled, false, '默认启用')
ok(skills[0].frontmatter.includes('name: git-helper'), 'frontmatter 解析')
let res = grok.setGrokSkillEnabled('git-helper', false)
ok(res.success === true, '关闭 skill 成功')
ok(fs.existsSync(path.join(skillsDir, '.disabled', 'git-helper')), '关闭 = 移动到 .disabled')
skills = grok.getGrokSkills()
eq([skills[0].name, skills[0].disabled], ['git-helper', true], '关闭后仍列出且 disabled=true')
res = grok.setGrokSkillEnabled('git-helper', true)
ok(res.success === true && fs.existsSync(path.join(skillsDir, 'git-helper')), '开启 = 移回')
eq(grok.setGrokSkillEnabled('ghost', false).success, false, '不存在的 skill 报错')
ok(grok.deleteGrokSkill('git-helper', false).success === true, '删除 skill')
eq(grok.getGrokSkills().length, 0, '删除后列表为空')

// ==================== 9. 使用统计（sessions/<cwd>/<session>/usage.json） ====================
console.log('9. 使用统计')
const sessionsRoot = grok.getGrokSessionsDir()
const sessDir = path.join(sessionsRoot, '-Users-me-proj', '0192f0aa-1111-7000-8000-000000000001')
fs.mkdirSync(sessDir, { recursive: true })
const iso = (d) => new Date(Date.now() - d * 864e5).toISOString()
fs.writeFileSync(path.join(sessDir, 'usage.json'), JSON.stringify({
  sessionId: '0192f0aa-1111-7000-8000-000000000001',
  updatedAt: iso(0),
  session: {
    inputTokens: 300, outputTokens: 60, cachedReadTokens: 100, cacheCreationTokens: 0,
    totalTokens: 360, modelCalls: 2, primaryModelId: 'acme/opus',
    modelUsage: {
      'acme/opus': { inputTokens: 200, outputTokens: 40, cachedReadTokens: 60, cacheCreationTokens: 0, totalTokens: 240, modelCalls: 1 },
      'grok-4.6': { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, cacheCreationTokens: 0, totalTokens: 120, modelCalls: 1 },
    },
  },
  turns: [
    {
      turnNumber: 1, endedAt: iso(1), inputTokens: 200, outputTokens: 40,
      cachedReadTokens: 60, cacheCreationTokens: 0, totalTokens: 240, modelCalls: 1,
      modelUsage: { 'acme/opus': { inputTokens: 200, outputTokens: 40, cachedReadTokens: 60, cacheCreationTokens: 0, totalTokens: 240, modelCalls: 1 } },
    },
    {
      turnNumber: 2, endedAt: iso(0), inputTokens: 100, outputTokens: 20,
      cachedReadTokens: 40, cacheCreationTokens: 0, totalTokens: 120, modelCalls: 1,
      modelUsage: { 'grok-4.6': { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, cacheCreationTokens: 0, totalTokens: 120, modelCalls: 1 } },
    },
  ],
}))
const usage = grok.readGrokUsage(true)
// 口径：输入含缓存（200+60 + 100+40 = 400）+ 输出 60 = 460
eq(usage.summary.totalTokens, 460, '总数 = 输入含缓存 + 输出')
eq(usage.summary.outputTokens, 60, '输出')
eq(usage.summary.inputTokens, 400, '输入含缓存')
eq(usage.modelStats.map((m) => m.name).sort(), ['acme/opus', 'grok-4.6'], '模型分布按 turn 的 modelUsage 拆分')
eq(usage.modelStats.find((m) => m.name === 'grok-4.6').tokens, 160, 'grok-4.6 = 100 + 40 + 20')
eq(usage.sessionCount, 1, '会话数')
const dayYesterday = usage.contributions.find((d) => d.date === new Date(Date.now() - 864e5).toISOString().split('T')[0])
ok(!!dayYesterday && dayYesterday.tokens === 300, '按 turn 的 endedAt 落到正确日期')
// 落库：通用统计页文档
const saved = JSON.parse(JSON.stringify(dbDocs.get('ccconfig_agent_usage_grok_test-native')))
ok(!!saved && !!saved.days, '落库 ccconfig_agent_usage_grok_<nativeId>')
// session 被清理 → 回放历史
fs.rmSync(sessionsRoot, { recursive: true, force: true })
const replayed = grok.readGrokUsage(true)
eq(replayed.summary.totalTokens, 460, '源文件被清理后回放落库历史')
const quick = grok.readGrokUsageFromHistory()
ok(quick && quick.summary.totalTokens === 460, '快速路径只读历史')

// ==================== 10. 旧结构兼容（模型内联连接信息，无 model_provider） ====================
// 上一版 Grok 视图把一个模型当作一个条目、连接信息全写在 [model.<id>] 上；现在的页面是
// 「供应商 → 模型」两层，但旧档必须能原样读出（归入未分组模型）且编辑不丢字段。
console.log('10. 旧结构兼容')
fs.writeFileSync(cfgPath, [
  '[models]',
  'default = "legacy/one"',
  '',
  '[model."legacy/one"]',
  'model = "legacy/one"',
  'base_url = "https://legacy.example/v1"',
  'api_backend = "messages"',
  'api_key = "sk-legacy"',
  'context_window = 500000',
  'name = "Legacy One"',
  '',
  '[model_providers."legacy-gw"]',
  'base_url = "https://gw.example/v1"',
  'api_key = "sk-gw"',
  '',
].join('\n'))
const legacyProviders = grok.getGrokProviderList()
eq(legacyProviders.map((p) => p.name), ['legacy-gw'], '旧档里的命名供应商照常列出')
eq(legacyProviders[0].models, [], '无模型引用时该供应商下模型为空')
const legacyUngrouped = grok.getGrokUngroupedModels()
eq(legacyUngrouped.map((m) => m.key), ['legacy/one'], '内联模型归入未分组')
eq(legacyUngrouped[0].baseUrl, 'https://legacy.example/v1', '内联模型的 base_url 可读')
eq(legacyUngrouped[0].apiBackend, 'messages', '内联模型的 api_backend 可读')
eq(grok.getGrokDefaultModel().modelId, 'legacy/one', '旧档默认模型可读')
// 编辑不丢字段
grok.updateGrokModel('legacy/one', { name: 'Legacy One Renamed' })
doc = rawDoc()
eq(doc.model['legacy/one'].name, 'Legacy One Renamed', '旧档模型可编辑')
eq(doc.model['legacy/one'].base_url, 'https://legacy.example/v1', '编辑后内联 base_url 保留')
eq(doc.model['legacy/one'].api_key, 'sk-legacy', '编辑后内联 api_key 保留')
// 内联模型挂到供应商：连接信息交给供应商，模型条目清掉自己的
grok.updateGrokModel('legacy/one', { modelProvider: 'legacy-gw' })
doc = rawDoc()
eq(doc.model['legacy/one'].model_provider, 'legacy-gw', '内联模型可改挂供应商')
ok(doc.model['legacy/one'].base_url === undefined, '挂供应商后清掉内联 base_url')
ok(doc.model['legacy/one'].api_key === undefined, '挂供应商后清掉内联 api_key')
eq(doc.model_providers['legacy-gw'].base_url, 'https://gw.example/v1', '供应商连接信息未被模型覆盖')
eq(grok.getGrokProviderList()[0].models.map((m) => m.key), ['legacy/one'], '挂载后出现在供应商模型列表')

// ==================== 11. 安装 / 数据检测 ====================
console.log('11. 安装与数据检测')
ok(grok.hasGrokConfig() === true, 'config.toml 有受管内容 → hasGrokConfig')
fs.rmSync(cfgPath, { force: true })
dbDocs.clear()
ok(grok.readGrokUsage(true).summary.totalTokens === 0, '无源文件无历史 → 空统计不抛错')

console.log(`\n${failed === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} passed, ${failed} failed`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
