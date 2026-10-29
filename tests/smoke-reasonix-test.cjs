// Reasonix 配置读写冒烟测试（临时 REASONIX_HOME，绝不碰真实 ~/.reasonix）
// 重点锁定：
//   1. 读改写不能抹掉 config.toml 的其它节（[agent] / [tools] / [[plugins]] / [ui] …）
//   2. 未知 provider 字段（price / extra_body / reasoning_protocol …）原样往返
//   3. 新增受管字段 request_url 与 model_overrides 的写入 / 归一化 / 清理
//   4. 模型删除时一并清掉它自己的 model_overrides 条目，别的模型条目不受影响
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-reasonix-'))
process.env.REASONIX_HOME = tmp

global.window = { utools: { getPath: () => os.homedir(), shellOpenPath() {} } }

require.cache[require.resolve('../public/preload/services/i18n.js')] = {
  id: 'i18n-stub', filename: 'i18n-stub', loaded: true,
  exports: { t: (k, p) => `${k}${p ? ' ' + JSON.stringify(p) : ''}` },
}

const reasonix = require('../public/preload/services/reasonix.js')
const { parse: parseToml } = require(path.join(__dirname, '..', 'public', 'preload', 'node_modules', 'smol-toml'))

const CONFIG = path.join(tmp, 'config.toml')

// 模拟一份真实配置：带 [ui] / [agent] / [tools] / [sandbox] / [[plugins]] 等本节
fs.writeFileSync(CONFIG, [
  'config_version = 12',
  'default_model = "relay/m1"',
  '',
  '[ui]',
  'theme = "auto"',
  '',
  '[agent]',
  'temperature = 0',
  '',
  '[tools]',
  'bash_timeout_seconds = 120',
  '',
  '[sandbox]',
  'bash = "enforce"',
  '',
  '[[providers]]',
  'name = "relay"',
  'kind = "openai"',
  'base_url = "https://api.example.com/v1"',
  'request_url = "https://api.example.com/v1/chat/completions"',
  'api_key_env = "RELAY_API_KEY"',
  'models = ["m1", "m2"]',
  'reasoning_protocol = "openai"',
  '',
  '[providers.model_overrides.m1]',
  'context_window = 400000',
  'max_output_tokens = 32000',
  '',
  '[[plugins]]',
  'name = "demo"',
  'command = "node"',
  '',
].join('\n'), 'utf-8')

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

// ==================== 读取 ====================

check('读取归一化：request_url / model_overrides / 未知字段', () => {
  const p = reasonix.getReasonixProviderList().find((x) => x.name === 'relay')
  assert.strictEqual(p.requestUrl, 'https://api.example.com/v1/chat/completions')
  assert.deepStrictEqual(p.modelOverrides.m1, { context_window: 400000, max_output_tokens: 32000 })
  assert.strictEqual(p._extra.reasoning_protocol, 'openai', '未受管字段进 _extra')
})

check('kind 枚举是官方三种（gemini，不是 google）', () => {
  assert.deepStrictEqual([...reasonix.REASONIX_KINDS].sort(), ['anthropic', 'gemini', 'openai'])
})

// ==================== 写入 ====================

check('改字段后其它配置节原样保留', () => {
  const p = reasonix.getReasonixProviderList().find((x) => x.name === 'relay')
  reasonix.updateReasonixProvider('relay', { ...p, baseUrl: 'https://api2.example.com/v1' })
  const doc = parseToml(fs.readFileSync(CONFIG, 'utf-8'))
  assert.strictEqual(String(doc.config_version), '12', 'config_version 不应丢失')
  assert.strictEqual(doc.default_model, 'relay/m1')
  assert.strictEqual(doc.ui.theme, 'auto')
  assert.strictEqual(doc.agent.temperature, 0)
  assert.strictEqual(doc.tools.bash_timeout_seconds, 120)
  assert.strictEqual(doc.sandbox.bash, 'enforce')
  assert.strictEqual(doc.plugins[0].name, 'demo')
  assert.strictEqual(doc.providers[0].base_url, 'https://api2.example.com/v1')
  assert.strictEqual(doc.providers[0].reasoning_protocol, 'openai', '未受管字段必须仍写回')
  assert.strictEqual(doc.providers[0].request_url, 'https://api.example.com/v1/chat/completions')
})

check('setReasonixModelOverride 写入 → 归一化读回', () => {
  reasonix.setReasonixModelOverride('relay', 'm2', { contextWindow: 128000, maxOutputTokens: 16000 })
  const p = reasonix.getReasonixProviderList().find((x) => x.name === 'relay')
  assert.deepStrictEqual(p.modelOverrides.m2, { context_window: 128000, max_output_tokens: 16000 })
  assert.ok(p.modelOverrides.m1, '其它模型条目不受影响')
})

check('setReasonixModelOverride 保留该模型下其它覆盖项', () => {
  // 手工塞一个 reasoning_protocol 覆盖，再用 UI 改窗口 → 不能被抹掉
  const doc = parseToml(fs.readFileSync(CONFIG, 'utf-8'))
  doc.providers[0].model_overrides.m2.reasoning_protocol = 'glm'
  reasonix.writeReasonixConfig(doc)
  reasonix.setReasonixModelOverride('relay', 'm2', { contextWindow: 256000 })
  const p = reasonix.getReasonixProviderList().find((x) => x.name === 'relay')
  assert.strictEqual(p.modelOverrides.m2.reasoning_protocol, 'glm')
  assert.strictEqual(p.modelOverrides.m2.context_window, 256000)
  assert.strictEqual(p.modelOverrides.m2.max_output_tokens, 16000, '未改的字段保持原值')
})

check('setReasonixModelOverride 两个字段都清空 → 删掉该模型条目', () => {
  reasonix.setReasonixModelOverride('relay', 'm2', { contextWindow: 0, maxOutputTokens: 0 })
  const p = reasonix.getReasonixProviderList().find((x) => x.name === 'relay')
  // m2 下还有 reasoning_protocol，条目本身保留
  assert.strictEqual(p.modelOverrides.m2.context_window, undefined)
  assert.strictEqual(p.modelOverrides.m2.max_output_tokens, undefined)
  assert.strictEqual(p.modelOverrides.m2.reasoning_protocol, 'glm')
  // m1 的覆盖完全没有任何字段可留时才会被删；这里它还有两个数值，必须还在
  assert.ok(p.modelOverrides.m1)
})

check('未在 models 里的模型不允许设置覆盖', () => {
  assert.throws(
    () => reasonix.setReasonixModelOverride('relay', 'no-such-model', { contextWindow: 1000 }),
    /modelNotFound|not found/i,
  )
})

check('删除模型时一并清掉它自己的 model_overrides', () => {
  reasonix.deleteReasonixModel('relay', 'm2')
  const p = reasonix.getReasonixProviderList().find((x) => x.name === 'relay')
  assert.deepStrictEqual(p.models, ['m1'])
  assert.strictEqual(p.modelOverrides.m2, undefined, '已删模型不应留下死覆盖条目')
  assert.ok(p.modelOverrides.m1, '其它模型的覆盖不受影响')
})

// ==================== 输出 ====================

let failed = 0
for (const [status, name] of results) {
  if (status === 'FAIL') failed++
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
