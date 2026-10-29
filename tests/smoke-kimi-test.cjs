// Kimi Code 服务层冒烟测试（临时 KIMI_CODE_HOME，绝不碰真实 ~/.kimi-code）
// 重点锁定通用库下发：模型元数据（显示名 / 上下文 / 最大输出 / 输入模态 / 推理档位）
// 与供应商自定义头必须带进 config.toml；重下发只增不减，且不动用户手工字段与其余配置节。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-kimi-'))
process.env.KIMI_CODE_HOME = tmp

// dispatch 会间接 require opencode / autoroute 等模块，这些在调用时才碰 utools
global.window = {
  utools: {
    shellOpenPath() {},
    getPath: () => os.homedir(),
    getNativeId: () => 'test',
    db: { get: () => null, put: () => ({ ok: true }) },
  },
}

// i18n stub：本测试只关心逻辑，不校验文案
require.cache[require.resolve('../public/preload/services/i18n.js')] = {
  id: 'i18n-stub', filename: 'i18n-stub', loaded: true,
  exports: { t: (k, p) => `${k}${p ? ' ' + JSON.stringify(p) : ''}` },
}

const kimi = require('../public/preload/services/kimi.js')
const dispatch = require('../public/preload/services/dispatch.js')

const CONFIG_PATH = path.join(tmp, 'config.toml')
const read = () => kimi.readKimiConfig()

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

const PROVIDER = {
  name: 'relay',
  api: 'anthropic-messages',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  headers: { 'X-Trace': '1' },
}
const MODEL = {
  id: 'k3',
  name: 'K3 Flagship',
  contextWindow: 1048576,
  maxTokens: 64000,
  reasoning: true,
  input: ['text', 'image'],
  reasoningEfforts: ['low', 'high', 'bogus'],
}

// ==================== 下发：参数必须带过来 ====================

check('下发把模型参数写进 config.toml', () => {
  dispatch.dispatchToKimi(PROVIDER, MODEL, { setDefault: true })
  const doc = read()
  assert.strictEqual(doc.default_model, 'relay/k3')
  assert.strictEqual(doc.providers.relay.type, 'anthropic')
  assert.deepStrictEqual(doc.providers.relay.custom_headers, { 'X-Trace': '1' }, 'headers → custom_headers')
  const m = doc.models['relay/k3']
  assert.strictEqual(m.max_context_size, 1048576)
  assert.strictEqual(m.max_output_size, 64000, 'maxTokens → max_output_size（anthropic）')
  assert.strictEqual(m.display_name, 'K3 Flagship')
  assert.deepStrictEqual([...m.capabilities].sort(), ['image_in', 'thinking'], 'input/reasoning → capabilities')
  assert.deepStrictEqual(m.support_efforts, ['low', 'high'], '非法档位应被过滤')
})

check('重下发只增不减：更大的上下文与手工字段不被覆盖', () => {
  kimi.updateKimiModel('relay/k3', { maxInputSize: 900000, offEffort: 'none' })
  dispatch.dispatchToKimi(
    PROVIDER,
    { id: 'k3', name: 'K3', contextWindow: 262144, maxTokens: 32000, reasoning: false, input: ['text'] },
    {},
  )
  const m = read().models['relay/k3']
  assert.strictEqual(m.max_context_size, 1048576, '上下文只增不减')
  assert.strictEqual(m.max_input_size, 900000, '手工 max_input_size 保留')
  assert.strictEqual(m.off_effort, 'none', '手工 off_effort 保留')
  assert.deepStrictEqual([...m.capabilities].sort(), ['image_in', 'thinking'], 'capabilities 只能追加')
})

check('非 anthropic 供应商不写 max_output_size（官方仅 anthropic 读取）', () => {
  dispatch.dispatchToKimi(
    { name: 'oa', api: 'openai-completions', baseUrl: 'https://oa.example.com/v1', apiKey: 'sk' },
    { id: 'm1', name: 'M1', contextWindow: 131072, maxTokens: 32000 },
    {},
  )
  const m = read().models['oa/m1']
  assert.strictEqual(m.max_output_size, undefined)
  assert.strictEqual(m.max_context_size, 131072)
  assert.strictEqual(m.display_name, 'M1')
})

check('自定义头与既有头合并，provider 未知字段原样保留', () => {
  const doc = read()
  doc.providers.relay.custom_headers = { 'X-Keep': 'yes' }
  doc.providers.relay.env = { KIMI_API_KEY: 'sk-env' }
  kimi.writeKimiConfig(doc)
  dispatch.dispatchToKimi({ ...PROVIDER, headers: { 'X-New': '2' } }, MODEL, {})
  const p = read().providers.relay
  assert.deepStrictEqual(p.custom_headers, { 'X-Keep': 'yes', 'X-New': '2' })
  assert.deepStrictEqual(p.env, { KIMI_API_KEY: 'sk-env' })
})

check('下发不动其余配置节（thinking / secondary_model / 顶层未知键）', () => {
  fs.appendFileSync(
    CONFIG_PATH,
    '\n[secondary_model]\ndefault_model = "relay/k3"\n\n[thinking]\nenabled = true\neffort = "high"\n',
  )
  dispatch.dispatchToKimi(PROVIDER, MODEL, {})
  const doc = read()
  assert.deepStrictEqual(doc.secondary_model, { default_model: 'relay/k3' })
  assert.deepStrictEqual(doc.thinking, { enabled: true, effort: 'high' })
})

// ==================== 读侧 / 编辑侧 ====================

check('读侧完整暴露模型扩展字段', () => {
  const m = kimi.getKimiModelList().find((x) => x.alias === 'relay/k3')
  assert.strictEqual(m.displayName, 'K3 Flagship')
  assert.strictEqual(m.maxOutputSize, 64000)
  assert.strictEqual(m.maxInputSize, 900000)
  assert.strictEqual(m.offEffort, 'none')
  assert.deepStrictEqual(m.capabilities, ['thinking', 'image_in'])
})

check('编辑保存不清掉未提交的扩展字段', () => {
  kimi.updateKimiModel('relay/k3', { maxContextSize: 2000000 })
  const m = read().models['relay/k3']
  assert.strictEqual(m.max_context_size, 2000000)
  assert.strictEqual(m.display_name, 'K3 Flagship')
  assert.strictEqual(m.max_output_size, 64000)
  assert.strictEqual(m.off_effort, 'none')
})

check('改名同步 provider 引用与 default_model（别名跟随）', () => {
  kimi.updateKimiProvider('relay', { name: 'relay2' })
  let doc = read()
  assert.strictEqual(doc.models['relay/k3'].provider, 'relay2', '供应商改名同步模型 provider 引用')
  assert.strictEqual(doc.default_model, 'relay/k3', '别名未改，default_model 不动')
  kimi.updateKimiModel('relay/k3', { alias: 'relay2/k3-max' })
  doc = read()
  assert.ok(doc.models['relay2/k3-max'])
  assert.strictEqual(doc.default_model, 'relay2/k3-max', '别名改名后 default_model 跟随')
})

check('默认模型引用不存在时拒绝写入', () => {
  assert.throws(() => kimi.setKimiDefaultModel('no/such-model'), /aliasNotFound/)
})

check('toml 解析失败必须抛错（不得读成空对象后全量覆盖）', () => {
  const backup = fs.readFileSync(CONFIG_PATH, 'utf-8')
  fs.writeFileSync(CONFIG_PATH, 'default_model = [\n', 'utf-8')
  assert.throws(() => kimi.getKimiProviderList(), /tomlParseFailed/)
  fs.writeFileSync(CONFIG_PATH, backup, 'utf-8')
})

check('托管供应商（oauth）拒绝编辑与删除', () => {
  const doc = read()
  doc.providers.managed = { type: 'kimi', base_url: 'https://api.kimi.com/coding/v1', oauth: { storage: 'file', key: 'k' } }
  kimi.writeKimiConfig(doc)
  assert.strictEqual(kimi.getKimiProviderList().find((p) => p.name === 'managed').managed, true)
  assert.throws(() => kimi.updateKimiProvider('managed', { baseUrl: 'https://x' }), /managedByLogin/)
  assert.throws(() => kimi.deleteKimiProvider('managed'), /managedByLogin/)
})

// ==================== 输出 ====================

let failed = 0
for (const [status, name] of results) {
  if (status === 'FAIL') failed++
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
