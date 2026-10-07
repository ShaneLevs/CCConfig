// hermes.js 冒烟测试：node tests/smoke-hermes-test.js（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-test-'))
process.env.HERMES_HOME = tmp
const hermes = require('../public/preload/services/hermes')

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

const cfgPath = path.join(tmp, 'config.yaml')
const readRaw = () => fs.readFileSync(cfgPath, 'utf-8')

// ==================== 1. 空档/缺文件 ====================
console.log('1. 空档与缺文件')
fs.rmSync(tmp, { recursive: true, force: true })
ok(hermes.getHermesProviderList().length === 0, '缺文件时列表为空')
eq(hermes.getHermesDefaultModel(), { provider: '', modelId: '' }, '缺文件时默认模型为空')
ok(hermes.hasHermesProviders() === false, '缺文件时 hasHermesProviders=false')
ok(hermes.isHermesInstalled() === false, '未安装检测')
fs.mkdirSync(tmp, { recursive: true })
ok(hermes.isHermesInstalled() === true, '目录存在即视为已安装')

fs.writeFileSync(cfgPath, '{}\n')
ok(hermes.getHermesProviderList().length === 0, '{} 视为合法空档')

// ==================== 2. 真实结构写入与读回 ====================
console.log('2. 添加供应商（含模型）')
hermes.addHermesProvider({
  name: 'openrouter',
  apiMode: 'chat_completions',
  baseUrl: 'https://openrouter.ai/api/v1/',
  apiKey: 'sk-or-test',
  models: [
    { modelId: 'anthropic/claude-opus-4-8', contextLength: 200000 },
    { modelId: 'z-ai/glm-5.3' },
  ],
})
let list = hermes.getHermesProviderList()
ok(list.length === 1, '列表有一条')
eq(list[0].name, 'openrouter', '名称')
eq(list[0].baseUrl, 'https://openrouter.ai/api/v1', 'base_url 去尾斜杠')
eq(list[0].models.map((m) => m.modelId), ['anthropic/claude-opus-4-8', 'z-ai/glm-5.3'], '模型有序')
eq(list[0].models[0].contextLength, 200000, '上下文长度')
eq(list[0].apiMode, 'chat_completions', 'api_mode')
ok(list[0].readonly === false, '非只读')
const yaml1 = readRaw()
ok(/model: anthropic\/claude-opus-4-8/.test(yaml1), '条目 model（单数）= 首个模型 ID')
ok(yaml1.includes('context_length: 200000'), 'models 字典 context_length')

// ==================== 3. 默认模型（切换语义） ====================
console.log('3. 默认模型')
hermes.setHermesDefaultModel('openrouter')
eq(hermes.getHermesDefaultModel(), { provider: 'openrouter', modelId: 'anthropic/claude-opus-4-8' }, '未传 modelId 用首个模型')
// model 节其他键保留
const doc = hermes.readHermesConfig()
doc.model.base_url = 'https://openrouter.ai/api/v1'
doc.model.context_length = 200000
hermes.writeHermesConfig(doc)
hermes.setHermesDefaultModel('openrouter', 'z-ai/glm-5.3')
const after = hermes.readHermesConfig()
eq(after.model.provider, 'openrouter', 'model.provider')
eq(after.model.default, 'z-ai/glm-5.3', 'model.default 指定模型')
eq(after.model.base_url, 'https://openrouter.ai/api/v1', 'model 节其余键保留')
eq(after.model.context_length, 200000, 'model 节 context_length 保留')
throws(() => hermes.setHermesDefaultModel('openrouter', 'not-exist'), '设不存在的模型报错')
throws(() => hermes.setHermesDefaultModel('ghost'), '设不存在的供应商报错')

// ==================== 4. 未知字段往返 + camelCase 清洗 ====================
console.log('4. 未知字段往返')
hermes.updateHermesProvider('openrouter', { rateLimitDelay: 2 })
const yamlRaw = hermes.readHermesConfig()
// 手工塞入未知键模拟磁盘上用户自设字段 + camelCase 别名
yamlRaw.custom_providers[0].key_env = 'MY_KEY'
yamlRaw.custom_providers[0].request_timeout_seconds = 30
yamlRaw.custom_providers[0].headers = { 'X-Custom': 'v' }
yamlRaw.custom_providers[0].baseUrl = 'https://legacy.example.com' // camelCase 别名
hermes.writeHermesConfig(yamlRaw)
let p = hermes.getHermesProviderList()[0]
eq(p.baseUrl, 'https://legacy.example.com', 'camelCase baseUrl 读回归一')
hermes.updateHermesProvider('openrouter', { baseUrl: 'https://new.example.com' })
p = hermes.getHermesProviderList()[0]
eq(p.baseUrl, 'https://new.example.com', '更新 baseUrl')
const saved = hermes.readHermesConfig().custom_providers[0]
eq(saved.key_env, 'MY_KEY', '未知键 key_env 保留')
eq(saved.request_timeout_seconds, 30, '未知键 request_timeout_seconds 保留')
eq(saved.headers['X-Custom'], 'v', '未知键 headers 保留')
ok(saved.baseUrl === undefined, 'camelCase 别名写入时归一为 base_url')
eq(saved.rate_limit_delay, 2, 'rate_limit_delay')

// ==================== 5. providers 字典只读 ====================
console.log('5. Hermes 托管（providers 字典）只读')
const d2 = hermes.readHermesConfig()
d2.providers = {
  managed: {
    base_url: 'https://managed.example.com',
    api_key: 'mk',
    api_mode: 'anthropic_messages',
    models: { 'managed/model-1': { context_length: 128000 } },
  },
}
hermes.writeHermesConfig(d2)
list = hermes.getHermesProviderList()
ok(list.length === 2, '字典条目并入列表')
const managed = list.find((x) => x.name === 'managed')
ok(managed.readonly === true, '标记只读')
eq(managed.source, 'providers_dict', 'source 标记')
eq(managed.apiMode, 'anthropic_messages', '字典条目 api_mode')
throws(() => hermes.updateHermesProvider('managed', { baseUrl: 'x' }), '编辑托管条目被拒（列表无此条目走 update 不存在分支）')
throws(() => hermes.removeHermesProvider('managed'), '删除托管条目被拒')
throws(() => hermes.addHermesProvider({ name: 'managed' }), '新增重名被拒')
hermes.setHermesDefaultModel('managed', 'managed/model-1')
eq(hermes.getHermesDefaultModel().provider, 'managed', '托管条目可设默认')
throws(() => hermes.upsertHermesProvider('managed', { baseUrl: 'x' }), '下发到托管条目被拒')

// ==================== 6. 删除与级联 ====================
console.log('6. 删除与级联')
hermes.setHermesDefaultModel('openrouter', 'z-ai/glm-5.3')
hermes.removeHermesProvider('openrouter')
const d3 = hermes.readHermesConfig()
ok(!Array.isArray(d3.custom_providers) || d3.custom_providers.length === 0, '条目已删')
eq(d3.model.provider, 'managed', '默认指针级联改指剩余供应商')
eq(d3.model.default, 'managed/model-1', '级联默认模型=剩余供应商首个模型')
hermes.removeHermesProvider('openrouter') // 幂等
ok(true, '重复删除幂等')

// ==================== 7. upsert（下发路径） ====================
console.log('7. upsert 幂等与合并')
hermes.upsertHermesProvider('packycode', { name: 'packycode', apiMode: 'anthropic_messages', baseUrl: 'https://api.packycode.com', apiKey: 'pk-1' })
hermes.upsertHermesModel('packycode', 'claude-opus-4-8', { contextLength: 200000 })
hermes.upsertHermesModel('packycode', 'glm-5.3')
// 再 upsert 空值不覆盖
hermes.upsertHermesProvider('packycode', { baseUrl: '', apiKey: '' })
p = hermes.getHermesProviderList().find((x) => x.name === 'packycode')
eq(p.baseUrl, 'https://api.packycode.com', 'upsert 空值不覆盖 baseUrl')
eq(p.apiKey, 'pk-1', 'upsert 空值不覆盖 apiKey')
eq(p.models.map((m) => m.modelId), ['claude-opus-4-8', 'glm-5.3'], 'upsert 供应商不动模型')
// upsertModel 已存在只刷新 context_length
hermes.upsertHermesModel('packycode', 'claude-opus-4-8', { contextLength: 300000 })
p = hermes.getHermesProviderList().find((x) => x.name === 'packycode')
eq(p.models.find((m) => m.modelId === 'claude-opus-4-8').contextLength, 300000, 'upsertModel 刷新 context_length')
ok(hermes.readHermesConfig().custom_providers.find((x) => x.name === 'packycode').model === 'claude-opus-4-8', 'upsertModel 补条目 model 指针')
// providerKeyFor 确定性
eq(hermes.providerKeyFor('Kimi'), 'Kimi', '合法名原样')
eq(hermes.providerKeyFor('Kimi'), hermes.providerKeyFor('Kimi'), '同一名恒同一键')
ok(/^[a-z0-9-]+$/.test(hermes.providerKeyFor('智谱 AI')), '中文名清洗为 ASCII 且含哈希')

// ==================== 8. API 模式守卫 ====================
console.log('8. 守卫')
throws(() => hermes.addHermesProvider({ name: 'x', apiMode: 'graphql' }), '非法 api_mode 报错')
throws(() => hermes.addHermesProvider({ name: '' }), '空名称报错')
throws(() => hermes.addHermesProvider({ name: 'packycode' }), '重名报错')

// ==================== 9. 解析失败阻断写回 ====================
console.log('9. 解析失败阻断')
fs.writeFileSync(cfgPath, 'custom_providers: [ { name: oops\n  bad yaml :::')
throws(() => hermes.getHermesProviderList(), '解析失败读操作抛错')
throws(() => hermes.addHermesProvider({ name: 'y' }), '解析失败写操作抛错（阻断写回）')
ok(fs.readFileSync(cfgPath, 'utf-8').includes('oops'), '坏文件未被覆盖')

// ==================== 10. CRLF 兼容 ====================
console.log('10. CRLF')
fs.writeFileSync(cfgPath, "custom_providers:\r\n  - name: crlf-p\r\n    base_url: https://c.example.com\r\n    api_key: k\r\n    api_mode: chat_completions\r\n    models:\r\n      m-1:\r\n        context_length: 4096\r\n")
p = hermes.getHermesProviderList().find((x) => x.name === 'crlf-p')
ok(p && p.models[0].modelId === 'm-1', 'CRLF 文件正常解析')
hermes.updateHermesProvider('crlf-p', { models: [{ modelId: 'm-1', contextLength: 8192 }] })
ok(hermes.getHermesProviderList().find((x) => x.name === 'crlf-p').models[0].contextLength === 8192, 'CRLF 文件更新成功')

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
