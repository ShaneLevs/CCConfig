// cline.js 冒烟测试：node tests/smoke-cline-test.cjs（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-test-'))
process.env.CLINE_DIR = tmp
process.env.CLINE_DATA_DIR = path.join(tmp, 'data')
delete process.env.CCCONFIG_LOCALE
process.env.CCCONFIG_LOCALE = 'zh-CN'

// 最小 uTools stub：cline.js 只在 shellOpenPath / db（统计落库）上用到
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

const cline = require('../public/preload/services/cline')

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

const providersPath = path.join(tmp, 'data', 'settings', 'providers.json')
const modelsPath = path.join(tmp, 'data', 'settings', 'models.json')
const mcpPath = path.join(tmp, 'data', 'settings', 'cline_mcp_settings.json')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'))

// ==================== 1. 空档与路径 ====================
console.log('1. 空档与路径解析')
eq(cline.getClineDir(), tmp, 'CLINE_DIR 生效')
eq(cline.getClineDataDir(), path.join(tmp, 'data'), 'CLINE_DATA_DIR 生效')
ok(cline.getClineProviderList().length === 0, '缺文件时供应商列表为空')
ok(cline.getClineMcpServers().length === 0, '缺文件时 MCP 列表为空')
ok(cline.getClineSkills().length === 0, '缺目录时 Skill 列表为空')
ok(cline.hasClineConfig() === false, '缺文件时 hasClineConfig=false')
ok(cline.isClineInstalled() === true, '目录存在即视为已安装')

// ==================== 2. 供应商写入：Cline 要求的字段形状 ====================
console.log('2. 供应商写入（providers.json schema）')
const pid = cline.addClineProvider({
  id: 'openai-compatible',
  displayName: 'magpie',
  baseUrl: 'http://127.0.0.1:3425/v1',
  apiKey: 'sk-test-123',
})
eq(pid, 'openai-compatible', '返回供应商 ID')
const pd = readJson(providersPath)
eq(pd.version, 1, 'version 是字面量 1（Cline zod 硬性要求）')
eq(pd.lastUsedProvider, 'openai-compatible', '首个供应商自动设为当前使用')
const entry = pd.providers['openai-compatible']
eq(entry.settings.provider, 'openai-compatible', 'settings.provider 写入')
eq(entry.settings.apiKey, 'sk-test-123', 'settings.apiKey 写入')
eq(entry.tokenSource, 'manual', 'tokenSource 为允许的枚举值 manual')
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entry.updatedAt), 'updatedAt 是 ISO datetime（格式错会被整档丢弃）')
ok(new Date(entry.updatedAt).toISOString() === entry.updatedAt, 'updatedAt 可被 ISO 往返解析')

// models.json 独立 version 信封
const md = readJson(modelsPath)
eq(md.version, 1, 'models.json 独立 version=1')
eq(md.providers['openai-compatible'].provider.name, 'magpie', 'models.json provider.name 写入')
eq(md.providers['openai-compatible'].provider.baseUrl, 'http://127.0.0.1:3425/v1', 'models.json provider.baseUrl 写入')

// 文件权限 0600（Cline 自己也按 0600 写）
if (process.platform !== 'win32') {
  eq((fs.statSync(providersPath).mode & 0o777).toString(8), '600', 'providers.json 权限 0600')
}

// ==================== 3. 模型 CRUD ====================
console.log('3. 模型 CRUD')
cline.addClineModel('openai-compatible', {
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  contextWindow: 1000000,
  maxTokens: 128000,
  capabilities: ['streaming', 'tools'],
})
let models = cline.getClineModelList('openai-compatible')
eq(models.length, 1, '模型已写入')
eq(models[0].contextWindow, 1000000, '上下文窗口读回')
eq(models[0].capabilities, ['streaming', 'tools'], '能力读回')
throws(() => cline.addClineModel('openai-compatible', { id: 'deepseek-v4.1-flash' }), '重复模型 ID 报错')

// 默认模型：同时写 settings.model 与目录 defaultModelId
cline.setClineDefaultModel('openai-compatible', 'deepseek-v4.1-flash')
eq(readJson(providersPath).providers['openai-compatible'].settings.model, 'deepseek-v4.1-flash', '默认模型写入 settings.model')
eq(readJson(modelsPath).providers['openai-compatible'].provider.defaultModelId, 'deepseek-v4.1-flash', '默认模型写入 defaultModelId')

// 未知能力值不写入（只保留 Cline 认识的枚举）
cline.addClineModel('openai-compatible', { id: 'm2', capabilities: ['streaming', 'unknown-cap'] })
eq(cline.getClineModelList('openai-compatible').find((m) => m.id === 'm2').capabilities, ['streaming'], '未知能力被过滤')

// 重命名同步默认模型引用
cline.updateClineModel('openai-compatible', 'deepseek-v4.1-flash', { id: 'ds-flash', name: 'DS Flash' })
eq(readJson(providersPath).providers['openai-compatible'].settings.model, 'ds-flash', '重命名后 settings.model 同步')
eq(readJson(modelsPath).providers['openai-compatible'].provider.defaultModelId, 'ds-flash', '重命名后 defaultModelId 同步')
ok(!readJson(modelsPath).providers['openai-compatible'].models['deepseek-v4.1-flash'], '旧模型键已移除')

// 删除默认模型 → 回退到剩余第一个
cline.deleteClineModel('openai-compatible', 'ds-flash')
eq(readJson(providersPath).providers['openai-compatible'].settings.model, 'm2', '删除默认模型后回退到剩余模型')

// ==================== 4. 切换 / 重名 / 删除 ====================
console.log('4. 切换与删除')
cline.addClineProvider({ id: 'alt', displayName: 'Alt', baseUrl: 'https://alt.example.com/v1', apiKey: 'k2' })
throws(() => cline.addClineProvider({ id: 'alt' }), '重复供应商 ID 报错')
eq(cline.getClineProviderList().length, 2, '两个供应商')
cline.setClineActiveProvider('alt')
eq(readJson(providersPath).lastUsedProvider, 'alt', '切换当前供应商写入 lastUsedProvider')
eq(cline.getClineProviderList().find((p) => p.id === 'alt').isActive, true, 'isActive 标记正确')

// 编辑时 Key 留空 → 保持原值
cline.updateClineProvider('alt', { displayName: 'Alt Renamed', baseUrl: 'https://alt2.example.com/v1' })
const altEntry = cline.getClineProviderList().find((p) => p.id === 'alt')
eq(altEntry.apiKey, 'k2', '未传 apiKey 时保留原 Key')
eq(altEntry.displayName, 'Alt Renamed', '显示名更新')
eq(altEntry.baseUrl, 'https://alt2.example.com/v1', 'baseUrl 更新')

// 删除当前使用的供应商 → 清空 lastUsedProvider 并删掉 models.json 目录
cline.deleteClineProvider('alt')
ok(!readJson(providersPath).providers.alt, '供应商已删除')
ok(!readJson(providersPath).lastUsedProvider, '删除当前供应商后清空 lastUsedProvider')
ok(!readJson(modelsPath).providers.alt, 'models.json 目录一并删除')

// ==================== 5. 损坏文件必须阻断写入 ====================
console.log('5. 损坏 / 不合规文件阻断写回')
const good = fs.readFileSync(providersPath, 'utf-8')
fs.writeFileSync(providersPath, '{ not json')
throws(() => cline.getClineProviderList(), 'JSON 损坏时读操作抛错')
throws(() => cline.addClineProvider({ id: 'x' }), 'JSON 损坏时写操作抛错（阻断覆盖）')
eq(fs.readFileSync(providersPath, 'utf-8'), '{ not json', '坏文件未被覆盖')

fs.writeFileSync(providersPath, JSON.stringify({ version: 2, providers: {} }))
throws(() => cline.getClineProviderList(), 'version !== 1 时抛错（Cline 会整档丢弃）')
eq(JSON.parse(fs.readFileSync(providersPath, 'utf-8')).version, 2, 'version 异常文件未被改写')

fs.writeFileSync(providersPath, good)

// ==================== 6. 未识别字段原样往返 ====================
console.log('6. 未识别字段保留')
const withExtra = JSON.parse(good)
withExtra.providers['openai-compatible'].settings['openrouterProviderSort'] = { sort: 'price' }
withExtra.providers['openai-compatible'].extraTopLevel = 1
fs.writeFileSync(providersPath, JSON.stringify(withExtra, null, 2))
cline.updateClineProvider('openai-compatible', { displayName: 'magpie' })
const after = readJson(providersPath).providers['openai-compatible']
eq(after.settings.openrouterProviderSort, { sort: 'price' }, 'settings 内未识别字段保留')
eq(after.extraTopLevel, 1, '供应商条目顶层未识别字段保留')
eq(readJson(providersPath).modes, {}, 'modes 信封保留')

// ==================== 7. MCP ====================
console.log('7. MCP')
cline.setClineMcpServer('local', { type: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' }, enabled: true })
cline.setClineMcpServer('remote', { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' }, enabled: true })
let mcp = cline.getClineMcpServers()
eq(mcp.length, 2, '两个 MCP 服务器')
const local = mcp.find((s) => s.name === 'local')
eq(local.type, 'stdio', 'stdio 类型识别')
eq(local.enabled, true, '默认启用')
const remote = mcp.find((s) => s.name === 'remote')
eq(remote.type, 'http', 'http 类型识别')
eq(readJson(mcpPath).mcpServers.remote.type, 'streamableHttp', 'http 写为 streamableHttp')

cline.setClineMcpEnabled('local', false)
eq(readJson(mcpPath).mcpServers.local.disabled, true, '关闭写入 disabled:true')
eq(cline.getClineMcpServers().find((s) => s.name === 'local').enabled, false, '关闭状态读回')
cline.setClineMcpEnabled('local', true)
ok(!('disabled' in readJson(mcpPath).mcpServers.local), '开启后移除 disabled 字段')

// autoApprove 等未识别字段保留
const mcpDoc = readJson(mcpPath)
mcpDoc.mcpServers.local.autoApprove = ['read_file']
mcpDoc.topLevelOther = 'keep'
fs.writeFileSync(mcpPath, JSON.stringify(mcpDoc, null, 2))
cline.setClineMcpServer('local', { type: 'stdio', command: 'node', args: ['server2.js'] })
eq(readJson(mcpPath).mcpServers.local.autoApprove, ['read_file'], 'autoApprove 保留')
eq(readJson(mcpPath).topLevelOther, 'keep', 'MCP 文件顶层其他字段保留')

eq(cline.toGenericClineMcp(local), { type: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' } }, '通用 config 映射（stdio）')
throws(() => cline.setClineMcpEnabled('nope', true), '不存在的 MCP 报错')
cline.deleteClineMcpServer('remote')
eq(cline.getClineMcpServers().length, 1, 'MCP 删除')

// ==================== 8. Skill（.disabled 目录机制） ====================
console.log('8. Skill')
const skillsDir = path.join(tmp, 'skills')
const mkSkill = (base, name) => {
  const d = path.join(base, name)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: demo skill\n---\n\nbody\n`)
}
mkSkill(skillsDir, 'alpha')
mkSkill(skillsDir, 'beta')
eq(cline.getClineSkills().map((s) => s.name), ['alpha', 'beta'], '扫描 skills 目录')
ok(cline.getClineSkills()[0].frontmatter.includes('description: demo skill'), 'frontmatter 解析')

cline.setClineSkillEnabled('alpha', false)
ok(fs.existsSync(path.join(tmp, '.disabled', 'alpha')), '停用 = 移入 skills 同级的 .disabled')
eq(cline.getClineSkills().find((s) => s.name === 'alpha').disabled, true, '停用状态读回')
cline.setClineSkillEnabled('alpha', true)
ok(fs.existsSync(path.join(skillsDir, 'alpha')), '启用 = 移回原目录')
ok(cline.setClineSkillEnabled('missing', true).success === false, '不存在的 Skill 返回失败')
ok(cline.setClineSkillEnabled('../evil', true).success === false, '路径穿越被拒绝')
ok(cline.deleteClineSkill('beta', false).success === true, 'Skill 删除')
eq(cline.getClineSkills().length, 1, '删除后剩余 1 个')

// ==================== 9. 使用统计 ====================
console.log('9. 使用统计')
const sessionsDir = path.join(tmp, 'data', 'sessions')
const mkSession = (id, usage, extra = {}) => {
  const d = path.join(sessionsDir, id)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify({
    session_id: id,
    provider: 'openai-compatible',
    model: 'deepseek-v4.1-flash',
    started_at: '2026-03-10T08:00:00.000Z',
    metadata: { usage },
    ...extra,
  }))
}
mkSession('s1', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 5, totalCost: 0 })
mkSession('s2', { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
// 优先使用 aggregateUsage
mkSession('s3', { inputTokens: 1, outputTokens: 1 }, {
  metadata: {
    usage: { inputTokens: 1, outputTokens: 1 },
    aggregateUsage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
  started_at: '2026-03-11T08:00:00.000Z',
})
const usage = cline.readClineUsage()
// s1: 100+20+300+5 = 425；s2: 50+10 = 60；s3: 200+40 = 240 → 合计 725
eq(usage.summary.totalTokens, 725, '总 tokens 含缓存读写')
eq(usage.summary.outputTokens, 70, '输出单列（20+10+40）')
eq(usage.summary.inputTokens, 655, '输入含缓存（425-20 + 60-10 + 240-40）')
eq(usage.summary.sessionCount, 3, '会话数')
eq(usage.summary.messageCount, 3, '记录数')
ok(usage.contributions.length >= 365, '热力图铺满一年')
const day1 = usage.contributions.find((d) => d.date === '2026-03-10')
ok(day1 && day1.tokens === 485, '按本地日期归集（s1+s2）')
ok(day1.models['deepseek-v4.1-flash'].cacheReadTokens === 300, 'day.models 记录缓存读')

// 落库后可从历史回放
const hist = cline.readClineUsageFromHistory()
ok(hist && hist.summary.totalTokens === 725, '历史回放（源文件清理后不归零）')

// 全零会话不计入
mkSession('s4', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
eq(cline.readClineUsage().summary.sessionCount, 3, '全零用量会话被跳过')

// ==================== 10. 下发（通用配置 → Cline） ====================
console.log('10. 通用配置下发')
const key = cline.providerKeyFor('智谱 GLM (Paas)')
ok(/^[\w.:\-/]+$/.test(key), `providerKeyFor 产出合法 ID：${key}`)
eq(cline.providerKeyFor(''), 'cline-provider', '空名兜底')
const dispatchKey = cline.providerKeyFor('router')
cline.upsertClineProvider(dispatchKey, { name: 'router', baseUrl: 'http://127.0.0.1:17877/v1', apiKey: 'gw' })
cline.upsertClineModel(dispatchKey, { id: 'gpt-5', name: 'GPT-5', contextWindow: 400000, maxTokens: 32000 })
const dispProbe = readJson(providersPath).providers[dispatchKey]
eq(dispProbe.settings.provider, dispatchKey, '下发：settings.provider 跟条目键一致（Cline 的「已配置」判据）')
eq(dispProbe.settings.baseUrl, 'http://127.0.0.1:17877/v1', '下发 baseUrl')
const dispModel = readJson(modelsPath).providers[dispatchKey].models['gpt-5']
eq(dispModel.capabilities, ['streaming', 'tools', 'images', 'reasoning'], '下发默认能力')
cline.setClineDefaultModelForProvider(dispatchKey, 'gpt-5')
eq(readJson(providersPath).providers[dispatchKey].settings.model, 'gpt-5', '下发默认模型写 settings.model')
// 再次下发时非空才覆盖、空值不清旧
cline.upsertClineModel(dispatchKey, { id: 'gpt-5' })
eq(readJson(modelsPath).providers[dispatchKey].models['gpt-5'].name, 'GPT-5', '空值不清除已有模型名')

// ==================== 11. 条目校验 / 悬空 lastUsedProvider / 推理档位 ====================
console.log('11. 条目校验与推理档位（Cline zod 语义）')
// Cline 只认 lastUsedProvider 指向的条目；条目被判废时它会静默回落内置 cline 账号
const rawDoc = readJson(providersPath)
rawDoc.lastUsedProvider = dispatchKey
fs.writeFileSync(providersPath, JSON.stringify(rawDoc, null, 2), { mode: 0o600 })
eq(cline.effectiveLastUsedProvider(readJson(providersPath)), dispatchKey, '合法条目 → 当前使用即 lastUsedProvider')
eq(cline.getClineDanglingActiveProvider(), '', '合法条目时没有悬空的 lastUsedProvider')
const okList = cline.getClineProviderList()
ok(okList.every((p) => p.valid === true), '合法条目 valid=true')

// settings.reasoning：effort 只接受 Cline 的档位
ok(cline.normalizeReasoning({ enabled: true, effort: 'high' }) !== null, 'reasoning effort=high 合法')
ok(cline.normalizeReasoning({ enabled: false }) !== null, 'reasoning enabled=false 合法（Cline 关闭思考的形状）')
ok(cline.normalizeReasoning({ effort: 'xhigh' }) !== null, 'reasoning effort=xhigh 合法')
ok(cline.normalizeReasoning({ effort: 'turbo' }) === null, 'reasoning effort=turbo 非法（会被 Cline 丢弃）')
ok(cline.normalizeReasoning({ effort: 'HIGH' }) === null, 'reasoning effort 大小写敏感')
ok(cline.normalizeReasoning({ enabled: 'yes' }) === null, 'reasoning enabled 非布尔非法')
ok(cline.normalizeReasoning({ budgetTokens: 0 }) === null, 'reasoning budgetTokens 非正整数非法')
eq(cline.CLINE_REASONING_EFFORTS, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], '档位清单与 @cline/shared 一致')

cline.setClineReasoning(dispatchKey, 'high')
eq(readJson(providersPath).providers[dispatchKey].settings.reasoning, { enabled: true, effort: 'high' }, 'setClineReasoning 写 { enabled: true, effort }')
eq(cline.getClineProviderList().find((p) => p.id === dispatchKey).reasoningEffort, 'high', '列表回读推理档位')
cline.setClineReasoning(dispatchKey, 'none')
eq(readJson(providersPath).providers[dispatchKey].settings.reasoning, { enabled: false }, 'effort=none 写成 { enabled: false }（Cline 的关闭形状）')
cline.setClineReasoning(dispatchKey, '')
ok(!('reasoning' in readJson(providersPath).providers[dispatchKey].settings), '空档位删除 reasoning 键')
throws(() => cline.setClineReasoning(dispatchKey, 'turbo'), '非法档位直接报错，不写进文件')

// 保存供应商不能抹掉已有的 reasoning / 未识别字段
cline.setClineReasoning(dispatchKey, 'low')
cline.updateClineProvider(dispatchKey, { apiKey: 'gw2' })
const afterUpdate = readJson(providersPath).providers[dispatchKey].settings
eq(afterUpdate.reasoning, { enabled: true, effort: 'low' }, '更新供应商保留 reasoning')
eq(afterUpdate.apiKey, 'gw2', '更新供应商写入 apiKey')

// 被判废的条目：Cline 视为未配置，页面必须能看出来
const brokenDoc = readJson(providersPath)
brokenDoc.providers[dispatchKey].settings.reasoning = { effort: 'turbo' }
brokenDoc.lastUsedProvider = dispatchKey
fs.writeFileSync(providersPath, JSON.stringify(brokenDoc, null, 2), { mode: 0o600 })
const brokenEntry = cline.getClineProviderList().find((p) => p.id === dispatchKey)
eq(brokenEntry.valid, false, '非法 reasoning 的条目被判废')
eq(brokenEntry.invalidReason, 'reasoningInvalid', '判废原因 = reasoningInvalid')
eq(brokenEntry.isActive, false, '判废条目不算「当前使用」')
eq(cline.getClineActiveProvider(), '', '判废条目时实际生效供应商为空（Cline 回落内置账号）')
eq(cline.getClineDanglingActiveProvider(), dispatchKey, '能识别悬空的 lastUsedProvider')
throws(() => cline.setClineActiveProvider(dispatchKey), '判废条目不允许设为当前使用')

// settings.provider 与键不一致 → Cline 视为未配置
brokenDoc.providers[dispatchKey].settings.reasoning = { enabled: true, effort: 'high' }
brokenDoc.providers[dispatchKey].settings.provider = 'openai-compatible'
fs.writeFileSync(providersPath, JSON.stringify(brokenDoc, null, 2), { mode: 0o600 })
eq(cline.getClineProviderList().find((p) => p.id === dispatchKey).invalidReason, 'providerMismatch', 'settings.provider 与键不一致被识别')
// 下发时 settings.provider 跟随条目键，避免与用户自己的 openai-compatible 撞车
cline.upsertClineProvider(dispatchKey, { name: 'router', baseUrl: 'http://127.0.0.1:17877/v1', apiKey: 'gw' })
eq(readJson(providersPath).providers[dispatchKey].settings.provider, dispatchKey, '下发：settings.provider = 条目键')
eq(readJson(providersPath).providers[dispatchKey].settings.baseUrl, 'http://127.0.0.1:17877/v1', '下发：baseUrl 写回')
eq(cline.getClineProviderList().find((p) => p.id === dispatchKey).valid, true, '下发后条目恢复合法')

// updatedAt 不是 ISO datetime → 条目被判废
const timeDoc = readJson(providersPath)
timeDoc.providers[dispatchKey].updatedAt = '2026-10-28 10:00:00'
fs.writeFileSync(providersPath, JSON.stringify(timeDoc, null, 2), { mode: 0o600 })
eq(cline.getClineProviderList().find((p) => p.id === dispatchKey).invalidReason, 'updatedAtInvalid', '非 ISO updatedAt 被识别')

// lastUsedProvider 指向不存在的条目：新增供应商应自动接管，否则永远停在「不生效」
const gapDoc = readJson(providersPath)
gapDoc.lastUsedProvider = 'gone-provider'
fs.writeFileSync(providersPath, JSON.stringify(gapDoc, null, 2), { mode: 0o600 })
eq(cline.getClineDanglingActiveProvider(), 'gone-provider', '条目缺失也算悬空')
cline.addClineProvider({ id: 'fresh', baseUrl: 'https://api.example.com/v1', apiKey: 'k' })
eq(readJson(providersPath).lastUsedProvider, 'fresh', '新增供应商在有悬空当前使用时自动接管')
eq(cline.getClineActiveProvider(), 'fresh', '接管后实际生效')

// ==================== 12. 下发自动接管（空配置时启用下发的 provider + 第一个模型） ====================
console.log('12. 下发自动接管')
// 清空配置，模拟「Cline 里什么都没有」时第一次下发
fs.rmSync(providersPath, { force: true })
fs.rmSync(modelsPath, { force: true })
// 下发顺序：先 provider、再 model，然后由 activateClineIfUnset 接管
const autoKey = cline.providerKeyFor('网关')
cline.upsertClineProvider(autoKey, { name: '网关', baseUrl: 'http://127.0.0.1:17877/v1', apiKey: 'gw' })
cline.upsertClineModel(autoKey, { id: 'gpt-5', name: 'GPT-5' })
cline.upsertClineModel(autoKey, { id: 'claude-5', name: 'Claude 5' })
const auto = cline.activateClineIfUnset(autoKey)
eq(auto.activated, true, '空配置时下发自动接管')
eq(readJson(providersPath).lastUsedProvider, autoKey, '自动写上 lastUsedProvider')
// 目录里第一个模型（按 id 排序：claude-5 < gpt-5）
eq(auto.modelId, 'claude-5', '自动选中目录里第一个模型')
eq(readJson(providersPath).providers[autoKey].settings.model, 'claude-5', '同步写 settings.model')
eq(readJson(modelsPath).providers[autoKey].provider.defaultModelId, 'claude-5', '同步写 defaultModelId')
eq(cline.getClineProviderList().find((p) => p.id === autoKey).isActive, true, '页面显示为当前使用')

// 已有生效配置时不再自动改用户的选择
cline.addClineProvider({ id: 'mine', baseUrl: 'https://api.example.com/v1', apiKey: 'k' })
cline.setClineActiveProvider('mine')
cline.upsertClineProvider(autoKey, { name: '网关', baseUrl: 'http://127.0.0.1:17877/v1', apiKey: 'gw' })
const auto2 = cline.activateClineIfUnset(autoKey)
eq(auto2.activated, false, '已有生效配置时不接管')
eq(readJson(providersPath).lastUsedProvider, 'mine', '不覆盖用户选的当前使用')

// lastUsedProvider 悬空（指向已删条目）时同样接管
const gapDoc2 = readJson(providersPath)
gapDoc2.lastUsedProvider = 'gone'
fs.writeFileSync(providersPath, JSON.stringify(gapDoc2, null, 2), { mode: 0o600 })
eq(cline.activateClineIfUnset(autoKey).activated, true, 'lastUsedProvider 悬空时接管')
eq(cline.getClineActiveProvider(), autoKey, '悬空修好后实际生效')

// 当前条目已被设过默认模型时，接管不再改模型
const pinnedDoc = readJson(providersPath)
pinnedDoc.providers[autoKey].settings.model = 'gpt-5'
fs.writeFileSync(providersPath, JSON.stringify(pinnedDoc, null, 2), { mode: 0o600 })
delete pinnedDoc.lastUsedProvider
fs.writeFileSync(providersPath, JSON.stringify(pinnedDoc, null, 2), { mode: 0o600 })
const auto3 = cline.activateClineIfUnset(autoKey)
eq(auto3.activated, true, '清空 lastUsedProvider 后接管')
eq(auto3.modelId, 'gpt-5', '已有 settings.model 时沿用，不改成第一个模型')

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
