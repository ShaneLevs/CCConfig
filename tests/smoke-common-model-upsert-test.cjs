// 通用模型新增字段 → 各 Agent upsert 写入的冒烟测试（临时 HOME，绝不碰真实配置）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-common-model-'))
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.DSH_HOME = path.join(tmp, '.dsh')
for (const key of ['KIMI_CODE_HOME', 'MINIMAX_DATA_DIR', 'HERMES_HOME', 'ZCODE_HOME', 'GROK_HOME', 'CLINE_HOME', 'PI_HOME', 'OMP_HOME']) {
  delete process.env[key]
}

global.window = {
  utools: {
    shellOpenPath() {},
    getPath: () => tmp,
    getNativeId: () => 'test',
    db: { get: () => null, put: () => ({ ok: true }) },
  },
}

require.cache[require.resolve('../public/preload/services/i18n.js')] = {
  id: 'i18n-stub', filename: 'i18n-stub', loaded: true,
  exports: { t: (k, p) => `${k}${p ? ' ' + JSON.stringify(p) : ''}` },
}

const qoder = require('../public/preload/services/qoder.js')
const zcode = require('../public/preload/services/zcode.js')
const grok = require('../public/preload/services/grok.js')
const commandCode = require('../public/preload/services/command-code.js')
const hermes = require('../public/preload/services/hermes.js')
const dsh = require('../public/preload/services/dsh.js')

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

check('Qoder：vision / thinking / supportsEffort / effortLevels 落盘', () => {
  const id = qoder.addQoderProvider({ id: 'relay', protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' })
  qoder.upsertQoderModel(id, 'm1', {
    name: 'M1',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    vision: true,
    thinkingEnabled: true,
    supportsEffort: true,
    effortLevels: ['low', 'high'],
  })
  const m = qoder.getQoderProviderList().find((p) => p.id === id).models.find((x) => x.model === 'm1')
  assert.strictEqual(m.displayName, 'M1')
  assert.strictEqual(m.vision, true)
  assert.strictEqual(m.thinkingEnabled, true)
  assert.strictEqual(m.supportsEffort, true)
  assert.deepStrictEqual(m.effortLevels, ['low', 'high'])
})

check('ZCode：输入模态 / jsonSchema / webSearch / midSystem / reasoningLevels 落盘', () => {
  zcode.addZcodeProvider({ name: 'Relay', apiType: 'openai-chat-completions', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' })
  const provider = zcode.getZcodeProviderList().find((p) => p.name === 'Relay')
  zcode.upsertZcodeModel(provider.id, 'm1', {
    contextWindow: 200000,
    maxOutputTokens: 64000,
    image: true,
    video: true,
    audio: true,
    pdf: true,
    jsonSchema: true,
    webSearch: true,
    midSystem: true,
    reasoningLevels: ['low', 'high'],
  })
  const m = zcode.getZcodeProviderList().find((p) => p.id === provider.id).models.find((x) => x.modelId === 'm1')
  assert.strictEqual(m.image, true)
  assert.strictEqual(m.video, true)
  assert.strictEqual(m.audio, true)
  assert.strictEqual(m.pdf, true)
  assert.strictEqual(m.jsonSchema, true)
  assert.strictEqual(m.webSearch, true)
  assert.strictEqual(m.midSystem, true)
  assert.deepStrictEqual(m.reasoningLevels, ['low', 'high'])
})

check('Grok：description / temperature / topP / extraHeaders 落盘', () => {
  grok.addGrokProvider({ name: 'relay', apiBackend: 'chat_completions', baseUrl: 'https://api.example.com/v1', apiKey: 'sk' })
  grok.upsertGrokModel('relay', 'm1', {
    name: 'M1',
    contextWindow: 200000,
    maxTokens: 64000,
    description: 'M1 description',
    temperature: 0.7,
    topP: 0.9,
    extraHeaders: { 'X-Model': '1' },
  })
  const m = grok.getGrokModelList().find((x) => x.key === 'm1')
  assert.strictEqual(m.description, 'M1 description')
  assert.strictEqual(m.temperature, 0.7)
  assert.strictEqual(m.topP, 0.9)
  assert.deepStrictEqual(m.extraHeaders, { 'X-Model': '1' })
})

check('Command Code：options / baseURL / api 落盘', () => {
  commandCode.addCommandCodeProvider({ id: 'relay', name: 'Relay', api: 'openai-completions', baseUrl: 'https://api.example.com/v1' })
  commandCode.upsertCommandCodeModel('relay', 'm1', {
    name: 'M1',
    contextWindow: 200000,
    maxOutput: 64000,
    api: 'openai-responses',
    options: { temperature: 0.5, custom: true },
    baseURL: 'https://override.example.com/v1',
  })
  const m = commandCode.getCommandCodeProviderList().find((p) => p.id === 'relay').models.find((x) => x.id === 'm1')
  assert.strictEqual(m.api, 'openai-responses')
  assert.strictEqual(m.baseURL, 'https://override.example.com/v1')
  assert.deepStrictEqual(m.options, { temperature: 0.5, custom: true })
})

check('Hermes：name / max_tokens 写入模型字典', () => {
  hermes.addHermesProvider({ name: 'relay', baseUrl: 'https://api.example.com/v1', apiKey: 'sk', apiMode: 'chat_completions' })
  hermes.upsertHermesModel('relay', 'm1', { contextLength: 200000, name: 'M1', maxTokens: 64000 })
  const m = hermes.getHermesProviderList().find((p) => p.name === 'relay').models.find((x) => x.modelId === 'm1')
  assert.strictEqual(m.contextLength, 200000)
  assert.strictEqual(m._raw.name, 'M1')
  assert.strictEqual(m._raw.max_tokens, 64000)
})

check('DSH：第三方路由的 description / reasoningEfforts / compat 写入 _raw', () => {
  dsh.addDshProvider({
    displayName: 'Relay',
    api: 'openai-completions',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk',
    models: [{ modelId: 'seed' }],
  })
  dsh.upsertDshModel('relay', 'm1', {
    name: 'M1',
    contextWindow: 200000,
    maxTokens: 64000,
    image: true,
    description: 'M1 description',
    reasoningEfforts: { low: 'low', high: 'high' },
    compat: { thinkingFormat: 'openai' },
  })
  const m = dsh.getDshProviderList().find((p) => p.route === 'relay').models.find((x) => x.modelId === 'm1')
  assert.strictEqual(m.contextWindow, 200000)
  assert.strictEqual(m.image, true)
  assert.strictEqual(m._raw.description, 'M1 description')
  assert.deepStrictEqual(m._raw.reasoningEfforts, { low: 'low', high: 'high' })
  assert.deepStrictEqual(m._raw.compat, { thinkingFormat: 'openai' })
})

check('DSH：官方路由的 description 写入模型 _raw', () => {
  dsh.saveDshOfficial({ enabled: true, apiKeyEnv: 'DEEPSEEK_API_KEY', models: [] })
  dsh.upsertDshModel('deepseek-official', 'o1', {
    name: 'O1',
    contextWindow: 100000,
    maxTokens: 8000,
    description: 'O1 description',
  })
  const m = dsh.getDshOfficial().models.find((x) => x.modelId === 'o1')
  assert.strictEqual(m.contextWindow, 100000)
  assert.strictEqual(m._raw.description, 'O1 description')
})

let failed = 0
for (const [status, name] of results) {
  if (status === 'FAIL') failed++
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
