// MiniMax Code 服务层冒烟测试（临时 MINIMAX_DATA_DIR，绝不碰真实 ~/.minimax）
// 重点锁定两处历史缺口：
//   1. 'default' 档位（官方 effortOptions 首档）保存时不得被白名单过滤掉
//   2. 通用库下发（dispatchToMinimax）必须把推理档位写进 thinking.effortOptions
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-minimax-'))
process.env.MINIMAX_DATA_DIR = tmp

// stub uTools（service 里 openMinimaxDir 会调；dispatch 会间接 require opencode.js 取 getPath）
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

const yaml = require('../public/preload/node_modules/js-yaml')
const mm = require('../public/preload/services/minimax.js')

const CONFIG_PATH = path.join(tmp, 'config.yaml')

// 官方内置配置形状（provider.minimax 只读托管 + 顶层未知键）
const OFFICIAL_DOC = {
  logLevel: 'info',
  defaultModel: 'minimax/MiniMax-M3.1-Flash',
  defaultModelContextWindow: 512000,
  defaultModelThinking: { effort: 'default' },
  defaultModelVariant: 'thinking',
  beta: { ptc: true },
  provider: {
    minimax: {
      name: 'MiniMax',
      npm: '@ai-sdk/anthropic',
      models: {
        'MiniMax-M3': {
          name: 'M3',
          attachment: true,
          reasoning: true,
          limit: { context: 512000, output: 128000 },
          modalities: { input: ['text', 'image', 'video'], output: ['text'] },
          variants: { 'none-thinking': { thinking: { type: 'disabled' } } },
          thinking_config: { mode: 'switchable', default_value: 'true' },
        },
        'MiniMax-M3.1-Flash': {
          name: 'M3.1-Flash',
          attachment: true,
          reasoning: true,
          limit: { context: 512000, output: 128000 },
          modalities: { input: ['text', 'image', 'video'], output: ['text'] },
          thinking: {
            effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort: 'default',
          },
        },
      },
      model_order: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
      whitelist: ['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3.1-Flash'],
      options: { apiKey: 'sk-official', baseURL: 'https://agent.minimaxi.com/mavis/api/v1/llm/v1' },
    },
  },
}

const writeDoc = (doc) => fs.writeFileSync(CONFIG_PATH, yaml.dump(doc), 'utf-8')
const readDoc = () => yaml.load(fs.readFileSync(CONFIG_PATH, 'utf-8'))

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

// ==================== 读侧 ====================

writeDoc(OFFICIAL_DOC)

check('内置 provider 只读托管，密钥不下发', () => {
  const list = mm.getMinimaxProviderList()
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].id, 'minimax')
  assert.strictEqual(list[0].managed, true)
  assert.strictEqual(list[0].apiKey, '', '托管 provider 不应把密钥下发给 UI')
  assert.strictEqual(list[0].hasKey, true)
})

check('协议由 npm 包名推导（anthropic-messages）', () => {
  assert.strictEqual(mm.getMinimaxProviderList()[0].api, 'anthropic-messages')
})

check('官方未知字段收进 _extra 原样往返', () => {
  const p = mm.getMinimaxProviderList()[0]
  assert.ok('_extra' in p)
  assert.strictEqual(p._extra.npm, '@ai-sdk/anthropic')
  assert.deepStrictEqual(p._extra.model_order, ['MiniMax-M3.1-Flash', 'MiniMax-M3'])
  assert.deepStrictEqual(p._extra.whitelist, ['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3.1-Flash'])
})

check('模型读取：上下文/输出/输入模态/推理档位', () => {
  const models = mm.getMinimaxProviderList()[0].models
  const flash = models.find((m) => m.id === 'MiniMax-M3.1-Flash')
  assert.strictEqual(flash.contextWindow, 512000)
  assert.strictEqual(flash.outputWindow, 128000)
  assert.deepStrictEqual(flash.inputTypes, ['image', 'video'], 'text 隐含，只留非文本模态')
  assert.deepStrictEqual(
    flash.effortOptions,
    ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    "官方首档 'default' 必须读得到"
  )
  const m3 = models.find((m) => m.id === 'MiniMax-M3')
  assert.deepStrictEqual(m3.effortOptions, [], '无 effortOptions 时为空数组')
  assert.ok(m3._raw.thinking_config, 'thinking_config 经 _raw 保留')
})

check('默认模型引用解析为内置', () => {
  assert.strictEqual(mm.getMinimaxDefaultModel(), 'minimax/MiniMax-M3.1-Flash')
  const parsed = mm.parseMinimaxModelRef('minimax/MiniMax-M3.1-Flash')
  assert.strictEqual(parsed.kind, 'builtin')
  assert.strictEqual(parsed.providerId, 'minimax')
})

check('yaml 解析失败必须抛错（不得读成空对象）', () => {
  fs.writeFileSync(CONFIG_PATH, 'provider: [未闭合\n', 'utf-8')
  assert.throws(() => mm.readMinimaxConfig(), /yamlParseFailed/)
  writeDoc(OFFICIAL_DOC)
})

// ==================== 写侧：缺口二（default 档位） ====================

check('缺口二：保存模型时 default 档位不被过滤掉', () => {
  mm.upsertMinimaxProvider('probe', {
    name: 'probe', api: 'anthropic-messages', baseUrl: 'https://api.example.com', apiKey: 'sk-test',
  })
  const src = mm.getMinimaxProviderList().find((p) => p.id === 'minimax')
  const flash = src.models.find((m) => m.id === 'MiniMax-M3.1-Flash')
  mm.upsertMinimaxModel('probe', 'MiniMax-M3.1-Flash', {
    name: flash.name, contextWindow: flash.contextWindow, outputWindow: flash.outputWindow,
    inputTypes: flash.inputTypes, effortOptions: flash.effortOptions,
  })
  const saved = readDoc().custom_provider.probe.models['MiniMax-M3.1-Flash']
  assert.deepStrictEqual(
    saved.thinking.effortOptions,
    ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    "下发后 'default' 档位必须还在"
  )
})

check('缺口二：UI 编辑保存路径同样保住 default', () => {
  const src = mm.getMinimaxProviderList().find((p) => p.id === 'minimax')
  const flash = src.models.find((m) => m.id === 'MiniMax-M3.1-Flash')
  mm.updateMinimaxModel('probe', 'MiniMax-M3.1-Flash', {
    name: flash.name, effortOptions: flash.effortOptions,
  })
  const saved = readDoc().custom_provider.probe.models['MiniMax-M3.1-Flash']
  assert.ok(saved.thinking.effortOptions.includes('default'), "编辑保存后 'default' 档位必须还在")
})

check('非法档位被丢弃，合法档位保留', () => {
  mm.updateMinimaxModel('probe', 'MiniMax-M3.1-Flash', { effortOptions: ['low', 'bogus', 'max'] })
  const saved = readDoc().custom_provider.probe.models['MiniMax-M3.1-Flash']
  assert.deepStrictEqual(saved.thinking.effortOptions, ['low', 'max'])
})

// ==================== 写侧：往返纪律 ====================

check('写回不动内置 provider.minimax 整段', () => {
  const after = readDoc()
  assert.deepStrictEqual(after.provider, OFFICIAL_DOC.provider)
})

check('写回不动顶层未知键', () => {
  const after = readDoc()
  assert.strictEqual(after.logLevel, 'info')
  assert.deepStrictEqual(after.beta, { ptc: true })
  assert.deepStrictEqual(after.defaultModelThinking, { effort: 'default' })
  assert.strictEqual(after.defaultModelVariant, 'thinking')
  assert.strictEqual(after.defaultModelContextWindow, 512000)
  assert.strictEqual(after.defaultModel, 'minimax/MiniMax-M3.1-Flash')
})

check('模型删除清理悬挂默认引用', () => {
  mm.upsertMinimaxProvider('tmp', { name: 'tmp', api: 'openai-completions', baseUrl: 'https://x.example.com' })
  mm.upsertMinimaxModel('tmp', 'm1', { name: 'm1', contextWindow: 1000 })
  mm.setMinimaxDefaultModel('custom_provider:tmp/m1')
  assert.strictEqual(mm.getMinimaxDefaultModel(), 'custom_provider:tmp/m1')
  mm.deleteMinimaxModel('tmp', 'm1')
  assert.strictEqual(mm.getMinimaxDefaultModel(), '', '模型删除后默认引用应被清理')
})

check('非法 provider 键 / 模型 id 被拒绝', () => {
  assert.throws(() => mm.upsertMinimaxProvider('bad/key', { api: 'openai-completions' }))
  assert.throws(() => mm.upsertMinimaxModel('probe', 'bad id!', {}))
})

check('非法协议被拒绝', () => {
  assert.throws(() => mm.upsertMinimaxProvider('probe2', { api: 'graphql' }))
})

// ==================== 通用库下发（dispatch） ====================

check('通用库下发把推理档位写进 thinking.effortOptions', () => {
  const dispatch = require('../public/preload/services/dispatch.js')
  dispatch.dispatchToMinimax(
    { name: 'MyRelay', api: 'anthropic-messages', baseUrl: 'https://api.example.com', apiKey: 'sk-test' },
    {
      id: 'MiniMax-M3.1-Flash', name: 'M3.1-Flash', contextWindow: 512000, maxTokens: 128000,
      input: ['text', 'image', 'video'],
      reasoningEfforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
    { providerName: 'MyRelay' }
  )
  // providerKeyFor('MyRelay') → 'MyRelay'（ASCII 合法名原样用）
  const saved = readDoc().custom_provider.MyRelay.models['MiniMax-M3.1-Flash']
  assert.deepStrictEqual(
    saved.thinking.effortOptions,
    ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    '下发必须带上推理档位'
  )
  assert.deepStrictEqual(saved.modalities.input, ['text', 'image', 'video'])
  assert.strictEqual(saved.limit.context, 512000)
})

check('下发后内置 provider 与顶层键仍原样', () => {
  const after = readDoc()
  assert.deepStrictEqual(after.provider, OFFICIAL_DOC.provider)
  assert.strictEqual(after.logLevel, 'info')
})

// ==================== 使用统计 ====================

// 造一个 MiniMax Code 会话目录：<tmp>/v2/sessions/2026/10/29/<会话目录>/messages.jsonl
const SESSION_DIR_NAME = '08-02-30-207-session_bXZzX2MxYzk5MzM0Zjk3NDQ2OTA4ZjUyNWNiYzNkZDkzZGFk'
const SESSION_ID = 'mvs_c1c99334f97446908f525cbc3dd93dad'
const TS = Date.UTC(2026, 9, 29, 0, 0, 0)

const writeSession = (lines, { manifest = true, dirName = SESSION_DIR_NAME } = {}) => {
  const dir = path.join(tmp, 'v2', 'sessions', '2026', '10', '29', dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
  if (manifest) {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, sessionId: SESSION_ID, createdAtMs: TS }),
      'utf-8'
    )
  }
  return dir
}

const assistantMsg = (model, usage, ts = TS) => ({
  message_id: 'm1',
  turn_id: 't1',
  message: { role: 'assistant', model, provider: 'minimax', timestamp: ts, usage },
})

check('统计：解析会话 JSONL 的 usage', () => {
  fs.rmSync(path.join(tmp, 'v2'), { recursive: true, force: true })
  writeSession([
    assistantMsg('MiniMax-M3.1-Flash', {
      input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    }),
    assistantMsg('MiniMax-M3', { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60 }),
    // 非 assistant / 无 usage 的消息不计入
    { message_id: 'm2', turn_id: 't1', message: { role: 'user', content: 'hi', timestamp: TS } },
    { message_id: 'm3', turn_id: 't1', message: { role: 'toolResult', content: 'x', timestamp: TS } },
  ])
  const s = mm.readMinimaxUsage()
  assert.strictEqual(s.summary.messageCount, 2, '只统计带 usage 的 assistant 消息')
  assert.strictEqual(s.summary.sessionCount, 1)
  assert.strictEqual(s.summary.inputTokens, 150)
  assert.strictEqual(s.summary.outputTokens, 30)
  assert.strictEqual(s.summary.cacheReadTokens, 5)
  assert.strictEqual(s.summary.cacheWriteTokens, 1)
  assert.strictEqual(s.summary.totalTokens, 186)
  assert.strictEqual(s.summary.totalCost, 3, 'cost.total 累加')
  assert.deepStrictEqual(s.modelStats.map((m) => m.name), ['MiniMax-M3.1-Flash', 'MiniMax-M3'], '按 token 降序')
})

check('统计：epoch 毫秒时间戳换算成日期', () => {
  const s = mm.readMinimaxUsage()
  const day = s.contributions.find((c) => c.tokens > 0)
  assert.ok(day, '应有非零贡献日')
  assert.strictEqual(day.date, '2026-10-29')
  assert.strictEqual(day.tokens, 186)
})

check('统计：会话 id 取自 manifest.json', () => {
  const s = mm.readMinimaxUsage()
  assert.strictEqual(s.summary.sessionCount, 1)
  assert.ok(s.recentSessions.length >= 1)
  assert.strictEqual(s.recentSessions[0].sessionId, SESSION_ID)
})

check('统计：manifest 缺失时从目录名解码 session id', () => {
  fs.rmSync(path.join(tmp, 'v2'), { recursive: true, force: true })
  writeSession([assistantMsg('M', { input: 1, output: 1, totalTokens: 2 })], { manifest: false })
  const s = mm.readMinimaxUsage()
  assert.strictEqual(s.recentSessions[0].sessionId, SESSION_ID, 'base64 目录名应解出同一个 session id')
})

check('统计：坏行跳过不中断整个会话', () => {
  fs.rmSync(path.join(tmp, 'v2'), { recursive: true, force: true })
  const dir = writeSession([assistantMsg('M', { input: 7, output: 3, totalTokens: 10 })])
  fs.appendFileSync(path.join(dir, 'messages.jsonl'), '{ 坏 JSON\n', 'utf-8')
  const s = mm.readMinimaxUsage()
  assert.strictEqual(s.summary.messageCount, 1, '坏行应被跳过')
  assert.strictEqual(s.summary.totalTokens, 10)
})

check('统计：totalTokens 缺失时按四项相加', () => {
  fs.rmSync(path.join(tmp, 'v2'), { recursive: true, force: true })
  writeSession([assistantMsg('M', { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })])
  const s = mm.readMinimaxUsage()
  assert.strictEqual(s.summary.totalTokens, 10)
})

check('统计：无会话目录时返回空结果（365 天零值）', () => {
  fs.rmSync(path.join(tmp, 'v2'), { recursive: true, force: true })
  const s = mm.readMinimaxUsage()
  assert.strictEqual(s.summary.messageCount, 0)
  assert.strictEqual(s.summary.totalTokens, 0)
  assert.strictEqual(s.contributions.length, 365)
  assert.ok(s.contributions.every((c) => c.tokens === 0))
})

check('统计：结果按「通用」统计契约落库', () => {
  fs.rmSync(path.join(tmp, 'v2'), { recursive: true, force: true })
  writeSession([assistantMsg('M', { input: 11, output: 5, totalTokens: 16 })])
  const puts = []
  global.window.utools.db.put = (doc) => { puts.push(doc); return { ok: true } }
  mm.readMinimaxUsage()
  const doc = puts.find((d) => d._id === 'ccconfig_agent_usage_minimax_test')
  assert.ok(doc, '应落库 ccconfig_agent_usage_minimax_<nativeId>')
  assert.strictEqual(doc.agent, 'minimax')
  assert.strictEqual(doc.days['2026-10-29'].tokens, 16)
  assert.strictEqual(doc.days['2026-10-29'].inputTokens, 11)
})

// ==================== 输出 ====================

let failed = 0
for (const [status, name] of results) {
  if (status === 'FAIL') failed++
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
