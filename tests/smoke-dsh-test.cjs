// dsh.js 冒烟测试：node tests/smoke-dsh-test.cjs（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const yaml = require('js-yaml')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'))
process.env.DSH_HOME = tmp
const dsh = require('../public/preload/services/dsh')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)
const throws = (fn, name) => {
  try { fn(); failed++; console.error(`  ✗ ${name}（未抛错）`) }
  catch (e) { passed++; console.log(`  ✓ ${name}（${e.message.slice(0, 70)}…）`) }
}

const patchPath = path.join(tmp, 'profiles', 'desktop', 'cordis.patch.yml')
const credPath = path.join(tmp, '.credentials.yaml')
const readPatchRaw = () => fs.readFileSync(patchPath, 'utf-8')
const readPatch = () => yaml.load(readPatchRaw(), { schema: yaml.DEFAULT_SCHEMA })
const findEntry = (id) => (readPatch() || []).find((e) => e && e.id === id)
const readCreds = () => yaml.load(fs.readFileSync(credPath, 'utf-8'), { schema: yaml.DEFAULT_SCHEMA })

// ==================== 1. 空档 / 缺文件 ====================
console.log('1. 空档与缺文件')
fs.rmSync(tmp, { recursive: true, force: true })
eq(dsh.getDshHome(), tmp, 'DSH_HOME 环境变量生效')
eq(dsh.getDshProfileName(), 'desktop', '无 profile 目录时回退 desktop')
ok(dsh.getDshPatchPath() === patchPath, 'patch 路径 = <DSH_HOME>/profiles/desktop/cordis.patch.yml')
ok(dsh.getDshOfficial() === null, '缺文件时官方未配置')
eq(dsh.getDshProviderList(), [], '缺文件时第三方供应商为空')
ok(dsh.getDshDefaultModel() === null, '缺文件时默认模型为空')
ok(dsh.hasDshConfig() === false, '缺文件时 hasDshConfig=false')
ok(dsh.isDshInstalled() === false, '未安装检测')
fs.mkdirSync(tmp, { recursive: true })
ok(dsh.isDshInstalled() === true, '目录存在即视为已安装')

// ==================== 2. 官方条目写入与读回 ====================
console.log('2. DeepSeek 官方条目')
dsh.saveDshOfficial({
  enabled: true,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  apiKey: 'sk-official-test',
  baseURL: 'https://relay.example.com/v1',
  thinking: 'enabled',
  reasoningEffort: 'max',
  maxTokens: 128000,
  defaultContextWindow: 500000,
  models: [],
})
ok(fs.existsSync(patchPath), 'patch 文件已创建')
const officialEntry = findEntry('llm-deepseek')
eq(officialEntry.name, '@deepseek-ai/dsh-llm-deepseek-api-key', '条目 name')
eq(officialEntry.config.baseURL, 'https://relay.example.com/v1', '自定义 baseURL 写入')
eq(officialEntry.config.apiKeyEnv, 'DEEPSEEK_API_KEY', 'apiKeyEnv 写入')
eq(officialEntry.config.reasoningEffort, 'max', 'reasoningEffort 写入')
ok(officialEntry.config.models === undefined, 'models 为空时不写键（用内置目录）')
ok(!/sk-official-test/.test(readPatchRaw()), 'patch 中不含明文密钥')
eq(readCreds().refs.DEEPSEEK_API_KEY, 'sk-official-test', '密钥写入 .credentials.yaml refs')
let official = dsh.getDshOfficial()
eq(official.apiKey, 'sk-official-test', '读回密钥')
eq(official.modelsExplicit, false, 'modelsExplicit=false 表示内置目录')
eq(official.models.map((m) => m.modelId), ['deepseek-flash', 'deepseek-v4-pro'], '回显内置目录')
eq(official.models[0].image, true, '内置 deepseek-flash 支持图片')
eq(official.models[0]._raw.systemPromptUpdate, 'in-history', '_raw 保留官方扩展字段')
ok(dsh.hasDshConfig() === true, '有官方条目时 hasDshConfig=true')

// 自定义模型目录 + 未知配置键往返
console.log('3. 官方自定义目录与未知字段')
dsh.saveDshOfficial({
  enabled: true,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: '',
  reasoningEffort: 'low',
  models: [{ modelId: 'deepseek-v4-pro', name: 'V4 Pro', contextWindow: 1000000, maxTokens: 64000, image: false, _raw: { description: 'keep me' } }],
})
official = dsh.getDshOfficial()
eq(official.baseURL, '', 'baseURL 留空时移除键（回落官方默认）')
eq(official.modelsExplicit, true, '显式目录标记')
eq(official.models[0]._raw.description, 'keep me', '模型未知键 _raw 保留')
eq(findEntry('llm-deepseek').config.models[0].description, 'keep me', '模型未知键写回磁盘')
const docWithExtra = readPatch()
const officialRaw = docWithExtra.find((e) => e.id === 'llm-deepseek')
officialRaw.config.retryPolicy = { mode: 'normal', maxRetries: 3 } // 模拟用户手加的未知配置键
officialRaw.config.streamIdleTimeoutMs = 120000
fs.writeFileSync(patchPath, yaml.dump(docWithExtra, { lineWidth: -1 }), 'utf-8')
dsh.saveDshOfficial({ enabled: true, apiKeyEnv: 'DEEPSEEK_API_KEY', reasoningEffort: 'high' })
const kept = findEntry('llm-deepseek').config
eq(kept.retryPolicy.maxRetries, 3, '未知配置键 retryPolicy 保留')
eq(kept.streamIdleTimeoutMs, 120000, '未知配置键 streamIdleTimeoutMs 保留')

// ==================== 4. 第三方供应商 ====================
console.log('4. 第三方供应商')
const route = dsh.addDshProvider({
  displayName: '公司中转',
  api: 'anthropic-messages',
  baseURL: 'https://ai-route.example.com/',
  apiKey: 'sk-relay-test',
  models: [
    { modelId: 'glm-5.3-flash', name: 'glm-5.3-flash', contextWindow: 1000000, maxTokens: 128000, image: true, _raw: { reasoningEfforts: { off: null, high: 'high' } } },
    { modelId: 'qwen3.8-max', contextWindow: 1000000 },
  ],
})
ok(/^[a-z0-9-]+$/.test(route), `中文名清洗为 ASCII 路由（${route}）`)
const piaiEntry = findEntry('llm-pi-ai')
eq(piaiEntry.name, '@deepseek-ai/dsh-llm-pi-ai', 'llm-pi-ai 条目 name')
ok(!!piaiEntry.config.providers[route], 'providers 字典按路由写入')
eq(piaiEntry.config.providers[route].api, 'anthropic-messages', '协议写入')
eq(piaiEntry.config.providers[route].displayName, '公司中转', 'displayName 保留原名')
eq(piaiEntry.config.providers[route].apiKeyEnv, dsh.apiKeyEnvFor(route), 'apiKeyEnv 自动生成')
eq(readCreds().refs[dsh.apiKeyEnvFor(route)], 'sk-relay-test', '第三方密钥写入 refs')
let list = dsh.getDshProviderList()
eq(list.length, 1, '供应商列表一条')
eq(list[0].apiKey, 'sk-relay-test', '读回第三方密钥')
eq(list[0].models.map((m) => m.modelId), ['glm-5.3-flash', 'qwen3.8-max'], '模型有序')
eq(list[0].models[0].image, true, 'input 含 image 时 image=true')
eq(list[0].models[0]._raw.reasoningEfforts.high, 'high', 'reasoningEfforts 经 _raw 保留')
throws(() => dsh.addDshProvider({ displayName: '公司中转' }), '重名（同路由）报错')
throws(() => dsh.addDshProvider({ displayName: 'x', api: 'graphql', baseURL: 'https://x.example.com', models: [{ modelId: 'a' }] }), '非法协议报错')
throws(() => dsh.addDshProvider({ displayName: 'x', api: 'openai-completions', baseURL: '', models: [{ modelId: 'a' }] }), '缺 Base URL 报错')
throws(() => dsh.addDshProvider({ displayName: 'x', api: 'openai-completions', baseURL: 'https://x.example.com', models: [] }), '空模型列表报错')

// 编辑：改名 / 协议 / 未知字段 / 模型增删
console.log('5. 供应商编辑')
dsh.updateDshProvider(route, {
  displayName: '公司中转（新）',
  api: 'openai-completions',
  models: [{ modelId: 'glm-5.3-flash', contextWindow: 900000, image: true, _raw: { reasoningEfforts: { high: 'high' } } }],
})
list = dsh.getDshProviderList()
eq(list[0].displayName, '公司中转（新）', '改名')
eq(list[0].api, 'openai-completions', '改协议')
eq(list[0].models.length, 1, '模型删减')
eq(list[0].models[0].contextWindow, 900000, '模型上下文更新')
eq(list[0].models[0]._raw.reasoningEfforts.high, 'high', '模型 _raw 仍保留')
eq(list[0].apiKey, 'sk-relay-test', '未传 apiKey 时保留原密钥')
throws(() => dsh.updateDshProvider(route, { models: [] }), '更新后模型为空报错（手写路由要求非空）')
throws(() => dsh.updateDshProvider('ghost', { displayName: 'x' }), '编辑不存在供应商报错')

// 凭据引用改名迁移
console.log('6. 凭据引用改名迁移')
// 官方条目 apiKeyEnv 改名：密钥迁移且旧引用清理
dsh.saveDshOfficial({ enabled: true, apiKeyEnv: 'DEEPSEEK_KEY_V2' })
eq(readCreds().refs.DEEPSEEK_KEY_V2, 'sk-official-test', '官方密钥迁移到新引用')
ok(readCreds().refs.DEEPSEEK_API_KEY === undefined, '官方旧引用在无其他使用者时清理')
dsh.saveDshOfficial({ enabled: true, apiKeyEnv: 'DEEPSEEK_API_KEY' })
eq(readCreds().refs.DEEPSEEK_API_KEY, 'sk-official-test', '再改回原引用名仍带出密钥')
ok(readCreds().refs.DEEPSEEK_KEY_V2 === undefined, '二次迁移后旧引用同样清理')
// 第三方条目 apiKeyEnv 改名
const oldEnv = list[0].apiKeyEnv
dsh.updateDshProvider(route, { apiKeyEnv: 'RENAMED_KEY' })
eq(readCreds().refs.RENAMED_KEY, 'sk-relay-test', '密钥迁移到新引用')
ok(readCreds().refs[oldEnv] === undefined, '旧引用在无其他使用者时清理')

// ==================== 7. 默认模型 ====================
console.log('7. 默认模型（切换语义）')
dsh.setDshDefaultModel(route, 'glm-5.3-flash', 'high')
eq(dsh.getDshDefaultModel(), { provider: route, modelId: 'glm-5.3-flash', reasoningEffort: 'high' }, '默认模型写入并读回')
const defEntry = findEntry('agent-default-model')
eq(defEntry.name, '@deepseek-ai/dsh-agent-default-model', '默认模型条目 name')
eq(defEntry.config.provider, route, 'config.provider = 路由名')
throws(() => dsh.setDshDefaultModel(route, 'not-exist'), '模型不在目录内报错')
throws(() => dsh.setDshDefaultModel('ghost', 'x'), '不存在的路由报错')
throws(() => dsh.setDshDefaultModel('', 'x'), '空路由报错')
dsh.setDshDefaultModel(dsh.OFFICIAL_ROUTE, 'deepseek-v4-pro')
eq(dsh.getDshDefaultModel().provider, dsh.OFFICIAL_ROUTE, '可切到官方路由（deepseek-official）')
throws(() => dsh.setDshDefaultModel(dsh.OFFICIAL_ROUTE, 'deepseek-flash'), '显式目录外的内置模型被拒（目录以显式列表为准）')
// 推理强度：同供应商内切模型保留原值（dsh 自身写入的强度不因点星标丢失），跨供应商切换清空
dsh.updateDshProvider(route, { models: [{ modelId: 'glm-5.3-flash' }, { modelId: 'glm-5.3-max' }] })
dsh.setDshDefaultModel(route, 'glm-5.3-flash')
ok(!dsh.getDshDefaultModel().reasoningEffort, '跨供应商切换清空推理强度')
dsh.setDshDefaultModel(route, 'glm-5.3-max', 'high')
dsh.setDshDefaultModel(route, 'glm-5.3-flash')
eq(dsh.getDshDefaultModel().reasoningEffort, 'high', '同供应商内切模型保留推理强度（未显式传入）')
dsh.setDshDefaultModel(route, 'glm-5.3-flash', '')
ok(!dsh.getDshDefaultModel().reasoningEffort, '显式传空字符串可清空推理强度')

// ==================== 8. 删除级联 ====================
console.log('8. 删除与级联')
dsh.setDshDefaultModel(route, 'glm-5.3-flash')
const relayEnv = 'RENAMED_KEY'
dsh.deleteDshProvider(route)
eq(dsh.getDshProviderList(), [], '供应商已删除')
eq(dsh.getDshDefaultModel().provider, dsh.OFFICIAL_ROUTE, '默认指针级联改指官方路由')
eq(dsh.getDshDefaultModel().modelId, 'deepseek-v4-pro', '级联默认模型 = 官方路由首个模型')
ok(readCreds().refs[relayEnv] === undefined, '无引用后清理密钥引用')
dsh.deleteDshProvider(route) // 幂等
ok(true, '重复删除幂等')

// ==================== 9. 保序 / 未知条目 / 注释保留 ====================
console.log('9. patch 结构保留')
const doc9 = readPatch()
doc9.unshift({ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: { transcriptView: 'standard' } })
doc9.push({ id: 'agent-default-model-extra', config: { keep: true } })
fs.writeFileSync(patchPath, `# 自定义头部注释\n# 第二行\n${yaml.dump(doc9, { lineWidth: -1 })}`, 'utf-8')
dsh.saveDshOfficial({ enabled: true, apiKeyEnv: 'DEEPSEEK_API_KEY', reasoningEffort: 'low' })
const after9 = readPatch()
ok(after9.some((e) => e.id === 'ui-chat'), '未受管条目 ui-chat 保留')
ok(after9.some((e) => e.id === 'agent-default-model-extra'), '用户自定义条目保留')
ok(readPatchRaw().startsWith('# 自定义头部注释\n# 第二行'), '头部注释块保留')
eq(after9.find((e) => e.id === 'llm-deepseek').config.reasoningEffort, 'low', '受管条目原地更新')

// ==================== 10. 下发 upsert ====================
console.log('10. 下发 upsert 幂等与合并')
dsh.upsertDshProvider('packycode', { name: 'packycode', api: 'anthropic-messages', baseURL: 'https://api.packycode.com', apiKey: 'pk-1' })
dsh.upsertDshModel('packycode', 'claude-opus-4-8', { name: 'Opus', contextWindow: 200000, image: true })
dsh.upsertDshModel('packycode', 'glm-5.3')
dsh.upsertDshProvider('packycode', { baseURL: '', apiKey: '' }) // 空值不覆盖
let pk = dsh.getDshProviderList().find((p) => p.route === 'packycode')
eq(pk.baseURL, 'https://api.packycode.com', 'upsert 空值不覆盖 baseURL')
eq(pk.apiKey, 'pk-1', 'upsert 空值不覆盖 apiKey')
eq(pk.models.map((m) => m.modelId), ['claude-opus-4-8', 'glm-5.3'], '模型按序追加')
eq(pk.models[0].image, true, 'upsert 模型 image 透传')
dsh.upsertDshModel('packycode', 'claude-opus-4-8', { contextWindow: 300000 })
pk = dsh.getDshProviderList().find((p) => p.route === 'packycode')
eq(pk.models[0].contextWindow, 300000, 'upsert 既有模型刷新上下文')
eq(pk.models[0].name, 'Opus', 'upsert 未传字段保留')
throws(() => dsh.upsertDshModel('ghost', 'm'), '向不存在供应商 upsert 模型报错')
throws(() => dsh.upsertDshProvider('zh-cn', { name: '中文名', api: 'bedrock', baseURL: 'https://x.example.com' }), '不支持下发的协议报错')
eq(dsh.providerRouteFor('Kimi'), 'kimi', '合法名小写归一原样')
eq(dsh.providerRouteFor('My Provider'), dsh.providerRouteFor('My Provider'), '同一名恒同一路由')
ok(/^[a-z0-9-]+$/.test(dsh.providerRouteFor('My Provider')), '含空格名清洗为 ASCII 且加哈希')
eq(dsh.providerRouteFor('智谱 AI'), dsh.providerRouteFor('智谱 AI'), '中文名恒同一路由')
ok(/^[a-z0-9-]+$/.test(dsh.providerRouteFor('智谱 AI')), '中文名清洗为 ASCII')
ok(dsh.providerRouteFor('智谱 AI') !== dsh.providerRouteFor('月之暗面'), '不同中文名不互相覆盖')

// ==================== 11. 移除官方 / 解析失败阻断 ====================
console.log('11. 移除官方与解析失败')
// 默认指针指向官方路由时：移除官方应级联到「文件顺序首个剩余供应商」
const remainingBefore = dsh.getDshProviderList()
ok(remainingBefore.length > 0, '存在剩余第三方供应商')
dsh.setDshDefaultModel(dsh.OFFICIAL_ROUTE, 'deepseek-v4-pro')
dsh.removeDshOfficial()
ok(dsh.getDshOfficial() === null, '官方条目已移除')
ok(!readPatch().some((e) => e.id === 'llm-deepseek'), '磁盘上无残留官方条目')
eq(dsh.getDshDefaultModel().provider, remainingBefore[0].route, '默认指针级联到首个剩余第三方供应商')
eq(dsh.getDshDefaultModel().modelId, remainingBefore[0].models[0].modelId, '级联默认模型 = 该供应商首个模型')
ok(readCreds().refs.DEEPSEEK_API_KEY === undefined, '无引用后官方密钥清理')
// 删除全部第三方供应商（官方已移除）→ 默认模型条目一并移除，不留悬空指针
for (const p of dsh.getDshProviderList()) dsh.deleteDshProvider(p.route)
eq(dsh.getDshProviderList(), [], '第三方供应商已清空')
ok(dsh.getDshDefaultModel() === null, '无任何路由时默认模型为空')
ok(!readPatch().some((e) => e.id === 'agent-default-model'), '磁盘上无残留默认模型条目')

// ==================== 12. 模型目录变动后的默认指针兜底 ====================
console.log('12. 模型目录变动后的默认指针兜底')
const guardRoute = dsh.addDshProvider({
  displayName: '兜底中转', route: 'guard', api: 'anthropic-messages',
  baseURL: 'https://guard.example.com', apiKey: 'sk-guard',
  models: [{ modelId: 'm1' }, { modelId: 'm2' }],
})
dsh.setDshDefaultModel(guardRoute, 'm2', 'high')
dsh.updateDshProvider(guardRoute, { models: [{ modelId: 'm1' }] })
eq(dsh.getDshDefaultModel(), { provider: 'guard', modelId: 'm1', reasoningEffort: '' }, '删除被设为默认的模型后指针改指目录首个模型')
// 改名（非首个模型）：服务端兜底先改指目录首个，UI 随后按改名结果纠正回新 ID
dsh.updateDshProvider(guardRoute, { models: [{ modelId: 'm1' }, { modelId: 'm2' }] })
dsh.setDshDefaultModel(guardRoute, 'm2', 'high')
dsh.updateDshProvider(guardRoute, { models: [{ modelId: 'm1' }, { modelId: 'm2-new' }] })
eq(dsh.getDshDefaultModel().modelId, 'm1', '改名后兜底指向目录首个模型')
dsh.setDshDefaultModel(guardRoute, 'm2-new', 'high')
eq(dsh.getDshDefaultModel().modelId, 'm2-new', 'UI 按改名结果把指针纠正到新 ID')
eq(dsh.getDshDefaultModel().reasoningEffort, 'high', '改名后推理强度保留')
// 官方目录：删除被设为默认的自定义模型 → 改指剩余首个；清空 models → 回退内置目录并改指内置首个
dsh.saveDshOfficial({ enabled: true, apiKeyEnv: 'OFFICIAL_GUARD_KEY', models: [{ modelId: 'o1' }, { modelId: 'o2' }] })
dsh.setDshDefaultModel(dsh.OFFICIAL_ROUTE, 'o2')
dsh.saveDshOfficial({ models: [{ modelId: 'o1' }] })
eq(dsh.getDshDefaultModel().modelId, 'o1', '官方删除默认模型后指针改指剩余首个模型')
dsh.saveDshOfficial({ models: [] })
eq(dsh.getDshOfficial().modelsExplicit, false, 'models 清空即回退内置目录')
eq(dsh.getDshDefaultModel().modelId, dsh.DSH_DEFAULT_MODELS[0].id, '恢复内置目录后指针改指内置首个模型')
dsh.removeDshOfficial()
dsh.deleteDshProvider(guardRoute)
ok(dsh.getDshDefaultModel() === null, '清理全部路由后默认模型条目移除')

const before = readPatchRaw()
fs.writeFileSync(patchPath, '- id: llm-deepseek\n  config: [bad\n  yaml :::', 'utf-8')
const bad = fs.readFileSync(patchPath, 'utf-8')
throws(() => dsh.getDshOfficial(), '解析失败读操作抛错')
throws(() => dsh.saveDshOfficial({ enabled: true, apiKeyEnv: 'K' }), '解析失败写操作抛错（阻断写回）')
ok(fs.readFileSync(patchPath, 'utf-8') === bad, '坏文件未被覆盖')

// 凭据文件损坏同样阻断
fs.writeFileSync(patchPath, before, 'utf-8')
fs.writeFileSync(credPath, 'refs:\n  BROKEN: [oops\n', 'utf-8')
throws(() => dsh.saveDshOfficial({ enabled: true, apiKeyEnv: 'K2', apiKey: 'v' }), '凭据文件损坏时写密钥抛错')

// ==================== 13. 通用库下发（dispatch.js → dsh） ====================
console.log('13. 通用库下发到 dsh')
const dispatchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dispatch-'))
fs.mkdirSync(path.join(dispatchHome, 'profiles', 'desktop'), { recursive: true })
fs.writeFileSync(path.join(dispatchHome, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n')
process.env.DSH_HOME = dispatchHome
global.window = {
  utools: {
    shellOpenPath() {},
    getPath: () => os.homedir(),
    db: { get: () => null, put: () => ({ ok: true }), allDocs: () => [] },
  },
}
const dispatch = require('../public/preload/services/dispatch')
const dispatchProvider = { name: '公司中转', api: 'anthropic-messages', baseUrl: 'https://relay.example.com/', apiKey: 'sk-dispatch' }
const dispatchModel = { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 1000000, maxTokens: 128000, input: ['text', 'image'] }
ok(/已写入/.test(dispatch.dispatchToDsh(dispatchProvider, dispatchModel, { providerName: '公司中转', setDefault: true })), '下发返回成功文案')
let dispatched = dsh.getDshProviderList()
eq(dispatched.length, 1, '下发创建一条路由')
ok(/^[a-z0-9-]+$/.test(dispatched[0].route), `中文供应商名清洗为路由（${dispatched[0].route}）`)
eq(dispatched[0].displayName, '公司中转', 'displayName 保留原名')
eq(dispatched[0].api, 'anthropic-messages', '协议透传')
eq(dispatched[0].apiKey, 'sk-dispatch', '密钥写入凭据引用')
eq(dispatched[0].models[0].image, true, '模型图片模态透传')
eq(dispatched[0].models[0].contextWindow, 1000000, '模型上下文透传')
eq(dsh.getDshDefaultModel().modelId, 'glm-5.3-flash', '下发并设为默认模型')
dispatch.dispatchToDsh(dispatchProvider, dispatchModel, { providerName: '公司中转' })
dispatched = dsh.getDshProviderList()
eq(dispatched.length, 1, '重复下发幂等（不新增路由）')
eq(dispatched[0].models.length, 1, '重复下发幂等（不重复模型）')
// 网关下发路径：anthropic-messages + 网关根地址（SDK 自行追加 /v1/messages）
ok(/router/.test(dispatch.dispatchToDsh(
  { name: 'router', api: 'anthropic-messages', baseUrl: 'http://127.0.0.1:17877', apiKey: 'gw-key' },
  { id: 'gw-model', contextWindow: 200000 },
  {},
)), '网关虚拟供应商下发成功')
eq(dsh.getDshProviderList().map((p) => p.route).sort(), [dispatched[0].route, 'router'].sort(), '两条路由并存')
throws(() => dispatch.dispatchToDsh(
  { name: 'x', api: 'bedrock-converse-stream', baseUrl: 'https://x.example.com' },
  { id: 'm' },
  {},
), '协议守卫拒绝四协议之外的供应商')
fs.rmSync(dispatchHome, { recursive: true, force: true })

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
