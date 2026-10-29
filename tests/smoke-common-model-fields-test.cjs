// 通用模型字段 → 各 Agent 的下发映射冒烟测试。
// 不读写真实配置：把各 service 的 upsert / 读写函数替换成捕获桩，断言 dispatch 传出的字段。
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

global.window = {
  utools: {
    shellOpenPath() {},
    getPath: () => os.homedir(),
    getNativeId: () => 'test',
    db: { get: () => null, put: () => ({ ok: true }) },
  },
}

require.cache[require.resolve('../public/preload/services/i18n.js')] = {
  id: 'i18n-stub', filename: 'i18n-stub', loaded: true,
  exports: { t: (k, p) => `${k}${p ? ' ' + JSON.stringify(p) : ''}` },
}

const dispatch = require('../public/preload/services/dispatch.js')
const opencode = require('../public/preload/services/opencode.js')
const pi = require('../public/preload/services/pi.js')
const omp = require('../public/preload/services/omp.js')
const reasonix = require('../public/preload/services/reasonix.js')
const codex = require('../public/preload/services/codex.js')
const kimi = require('../public/preload/services/kimi.js')
const minimax = require('../public/preload/services/minimax.js')
const qoder = require('../public/preload/services/qoder.js')
const zcode = require('../public/preload/services/zcode.js')
const hermes = require('../public/preload/services/hermes.js')
const dsh = require('../public/preload/services/dsh.js')
const grok = require('../public/preload/services/grok.js')
const cline = require('../public/preload/services/cline.js')
const commandCode = require('../public/preload/services/command-code.js')

const PROVIDER = {
  name: 'relay',
  api: 'openai-completions',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  headers: { 'X-Trace': '1' },
  authHeader: true,
}

const MODEL = {
  id: 'm1',
  name: 'M1',
  contextWindow: 200000,
  maxTokens: 64000,
  input: ['text', 'image', 'audio', 'video', 'pdf'],
  output: ['text', 'image'],
  reasoning: true,
  reasoningEfforts: ['low', 'high', 'bogus'],
  defaultEffort: 'high',
  capabilities: ['streaming', 'tools', 'always_thinking', 'json_schema', 'web_search', 'mid_system'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  compat: { supportsReasoningEffort: true },
  maxInputTokens: 128000,
  offEffort: 'none',
  reasoningKey: 'reasoning_effort',
  adaptiveThinking: true,
  thinking: { mode: 'effort', minLevel: 'low', maxLevel: 'high', type: 'enabled', budgetTokens: 4096 },
  description: 'M1 description',
  temperature: 0.7,
  topP: 0.9,
  extraHeaders: { 'X-Model': '1' },
  options: { temperature: 0.5, custom: true },
  api: 'openai-responses',
  baseURL: 'https://override.example.com/v1',
}

const calls = {}
const capture = (name, value) => { calls[name] = value }
const noop = () => {}

// ---- OpenCode ----
let opencodeConfig = { provider: {} }
opencode.readOpencodeConfig = () => ({ ...opencodeConfig, provider: { ...(opencodeConfig.provider || {}) } })
opencode.writeOpencodeConfig = (cfg) => { opencodeConfig = cfg; return true }

// ---- Pi / omp ----
let piModels = { providers: {} }
pi.readPiModels = () => ({ ...piModels, providers: { ...(piModels.providers || {}) } })
pi.writePiModels = (cfg) => { piModels = cfg }
pi.readPiSettings = () => ({})
pi.writePiSettings = noop

let ompModels = { providers: {} }
omp.readOmpModels = () => ({ ...ompModels, providers: { ...(ompModels.providers || {}) } })
omp.writeOmpModels = (cfg) => { ompModels = cfg }

// ---- Reasonix / Codex ----
reasonix.readReasonixConfig = () => ({ providers: [] })
reasonix.writeReasonixConfig = noop
reasonix.generateReasonixApiKeyEnv = () => 'RELAY_API_KEY'
reasonix.writeReasonixEnvKey = noop
codex.normalizeCodexBaseUrl = (v) => v
codex.upsertCodexProvider = noop
codex.upsertCodexModel = noop
codex.setCodexDefaultModel = noop

// ---- Kimi / MiniMax ----
kimi.upsertKimiProvider = noop
kimi.upsertKimiModel = (name, id, opts) => { capture('kimi', opts); return `${name}/${id}` }
kimi.setKimiDefaultModel = noop
minimax.MINIMAX_API_FORMATS = ['openai-completions', 'openai-responses', 'anthropic-messages']
minimax.providerKeyFor = (name) => name
minimax.upsertMinimaxProvider = noop
minimax.upsertMinimaxModel = (key, id, opts) => { capture('minimax', opts); return `${key}/${id}` }
minimax.setMinimaxDefaultModel = noop

// ---- Qoder ----
qoder.providerKeyFor = (name) => name
qoder.upsertQoderProvider = noop
qoder.upsertQoderModel = (key, id, opts) => { capture('qoder', opts); return id }
qoder.setQoderDefaultModel = noop

// ---- ZCode ----
zcode.providerIdFor = (name) => name
zcode.upsertZcodeProvider = noop
zcode.upsertZcodeModel = (id, modelId, opts) => { capture('zcode', opts); return modelId }
zcode.setZcodeDefaultModel = noop

// ---- Hermes ----
hermes.providerKeyFor = (name) => name
hermes.upsertHermesProvider = noop
hermes.upsertHermesModel = (key, id, opts) => { capture('hermes', opts); return id }
hermes.setHermesDefaultModel = noop

// ---- DSH ----
dsh.DSH_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
dsh.providerRouteFor = (name) => name.toLowerCase()
dsh.upsertDshProvider = noop
dsh.upsertDshModel = (route, id, opts) => { capture('dsh', opts); return id }
dsh.setDshDefaultModel = noop

// ---- Grok ----
grok.providerKeyFor = (name) => name
grok.upsertGrokProvider = noop
grok.upsertGrokModel = (key, id, opts) => { capture('grok', opts); return id }
grok.setGrokDefaultModel = noop

// ---- Cline ----
cline.providerKeyFor = (name) => name
cline.upsertClineProvider = noop
cline.upsertClineModel = (key, model) => { capture('cline', model); return model.id }
cline.setClineDefaultModelForProvider = noop
cline.setClineActiveProvider = noop
cline.activateClineIfUnset = () => ({ activated: false })

// ---- Command Code ----
commandCode.CC_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
commandCode.providerKeyFor = (name) => name
commandCode.upsertCommandCodeProvider = noop
commandCode.setCommandCodeApiKey = noop
commandCode.upsertCommandCodeModel = (key, id, opts) => { capture('commandcode', opts); return id }
commandCode.setCommandCodeDefaultModel = noop

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

check('OpenCode：输入/输出模态、options、effort、thinking、temperature、compat', () => {
  dispatch.dispatchToOpencode(PROVIDER, MODEL, {})
  const m = opencodeConfig.provider.relay.models.m1
  assert.deepStrictEqual(m.modalities.input, ['text', 'image', 'audio', 'video', 'pdf'])
  assert.deepStrictEqual(m.modalities.output, ['text', 'image'])
  assert.strictEqual(m.reasoning, true)
  assert.strictEqual(m.options.effort, 'high')
  assert.deepStrictEqual(m.options.thinking, { type: 'enabled', budgetTokens: 4096 })
  assert.strictEqual(m.options.temperature, 0.7)
  assert.strictEqual(m.options.topP, 0.9)
  assert.strictEqual(m.options.custom, true)
  assert.strictEqual(m.supportsReasoningEffort, true)
  assert.deepStrictEqual(m.cost, { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 })
})

check('Pi：输入模态过滤为 text/image，cost/compat 保留', () => {
  dispatch.dispatchToPi(PROVIDER, MODEL, {})
  const m = piModels.providers.relay.models[0]
  assert.deepStrictEqual(m.input, ['text', 'image'])
  assert.strictEqual(m.compat.supportsReasoningEffort, true)
  assert.strictEqual(m.cost.input, 3)
})

check('omp：thinking 写入模型条目，输入模态过滤', () => {
  dispatch.dispatchToOmp(PROVIDER, MODEL, {})
  const m = ompModels.providers.relay.models[0]
  assert.deepStrictEqual(m.thinking, { mode: 'effort', minLevel: 'low', maxLevel: 'high' })
  assert.deepStrictEqual(m.input, ['text', 'image'])
})

check('Kimi：capabilities / maxInputSize / defaultEffort / offEffort / reasoningKey / adaptiveThinking', () => {
  dispatch.dispatchToKimi(PROVIDER, MODEL, {})
  assert.deepStrictEqual(calls.kimi.capabilities, MODEL.capabilities)
  assert.strictEqual(calls.kimi.maxInputSize, 128000)
  assert.strictEqual(calls.kimi.defaultEffort, 'high')
  assert.strictEqual(calls.kimi.offEffort, 'none')
  assert.strictEqual(calls.kimi.reasoningKey, 'reasoning_effort')
  assert.strictEqual(calls.kimi.adaptiveThinking, true)
})

check('MiniMax：输入模态与推理档位原样传入', () => {
  dispatch.dispatchToMinimax(PROVIDER, MODEL, {})
  assert.deepStrictEqual(calls.minimax.inputTypes, MODEL.input)
  assert.deepStrictEqual(calls.minimax.effortOptions, MODEL.reasoningEfforts)
})

check('Qoder：vision / thinking / effortLevels', () => {
  dispatch.dispatchToQoder(PROVIDER, MODEL, {})
  assert.strictEqual(calls.qoder.vision, true)
  assert.strictEqual(calls.qoder.thinkingEnabled, true)
  assert.strictEqual(calls.qoder.supportsEffort, true)
  assert.deepStrictEqual(calls.qoder.effortLevels, ['low', 'high'])
})

check('ZCode：四种输入模态 + 能力标记 + 推理等级', () => {
  dispatch.dispatchToZcode(PROVIDER, MODEL, {})
  assert.strictEqual(calls.zcode.image, true)
  assert.strictEqual(calls.zcode.video, true)
  assert.strictEqual(calls.zcode.audio, true)
  assert.strictEqual(calls.zcode.pdf, true)
  assert.strictEqual(calls.zcode.jsonSchema, true)
  assert.strictEqual(calls.zcode.webSearch, true)
  assert.strictEqual(calls.zcode.midSystem, true)
  assert.deepStrictEqual(calls.zcode.reasoningLevels, ['low', 'high', 'bogus'])
})

check('Hermes：name / maxTokens 一并下发', () => {
  dispatch.dispatchToHermes(PROVIDER, MODEL, {})
  assert.strictEqual(calls.hermes.name, 'M1')
  assert.strictEqual(calls.hermes.maxTokens, 64000)
})

check('DSH：description / reasoningEfforts / compat', () => {
  dispatch.dispatchToDsh(PROVIDER, MODEL, {})
  assert.strictEqual(calls.dsh.description, 'M1 description')
  assert.deepStrictEqual(calls.dsh.reasoningEfforts, { low: 'low', high: 'high', bogus: 'bogus' })
  assert.deepStrictEqual(calls.dsh.compat, { supportsReasoningEffort: true })
})

check('Grok：description / temperature / topP / extraHeaders', () => {
  dispatch.dispatchToGrok(PROVIDER, MODEL, {})
  assert.strictEqual(calls.grok.description, 'M1 description')
  assert.strictEqual(calls.grok.temperature, 0.7)
  assert.strictEqual(calls.grok.topP, 0.9)
  assert.deepStrictEqual(calls.grok.extraHeaders, { 'X-Model': '1' })
})

check('Cline：输入/推理能力合并进 capabilities', () => {
  dispatch.dispatchToCline(PROVIDER, MODEL, {})
  assert.deepStrictEqual(calls.cline.capabilities.sort(), ['images', 'reasoning', 'streaming', 'tools'])
})

check('Command Code：options / baseURL / api / efforts / cost', () => {
  dispatch.dispatchToCommandCode(PROVIDER, MODEL, {})
  assert.deepStrictEqual(calls.commandcode.options, MODEL.options)
  assert.strictEqual(calls.commandcode.baseURL, MODEL.baseURL)
  assert.strictEqual(calls.commandcode.api, 'openai-responses')
  assert.deepStrictEqual(calls.commandcode.reasoningEfforts, MODEL.reasoningEfforts)
  assert.deepStrictEqual(calls.commandcode.cost, MODEL.cost)
})

let failed = 0
for (const [status, name] of results) {
  if (status === 'FAIL') failed++
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
