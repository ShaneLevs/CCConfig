// Kimi Code 用量统计冒烟测试（临时 KIMI_CODE_HOME，绝不碰真实 ~/.kimi-code）
// 重点锁定：
//   1. 只统计 wire.jsonl 的 usage.record（super-long tool/systemPrompt 行不能被误解析）
//   2. 输入含缓存（inputOther + cacheRead + cacheCreation），输出单列；日期按本地时区
//   3. 子 agent（agents/<id>/wire.jsonl）用量一并汇总；无 usage 的会话不计 sessionCount
//   4. 源会话被清理后回放落库历史（ccconfig_agent_usage_kimi_<nativeId>），不归零
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-kimi-usage-'))
process.env.KIMI_CODE_HOME = tmp

// 内存 DB：只实现统计路径用到的 get / put / allDocs
const dbDocs = new Map()
global.window = {
  utools: {
    getPath: () => os.homedir(),
    getNativeId: () => 'test',
    shellOpenPath() {},
    db: {
      get: (id) => dbDocs.get(id) || null,
      put: (doc) => { dbDocs.set(doc._id, { ...doc }); return { ok: true, id: doc._id } },
      allDocs: () => ({ docs: [...dbDocs.values()] }),
    },
  },
}

// i18n stub：本测试只关心逻辑，不校验文案
require.cache[require.resolve('../public/preload/services/i18n.js')] = {
  id: 'i18n-stub', filename: 'i18n-stub', loaded: true,
  exports: { t: (k, p) => `${k}${p ? ' ' + JSON.stringify(p) : ''}` },
}

const kimiUsage = require('../public/preload/services/kimi-usage.js')

const SESSIONS = path.join(tmp, 'sessions')

// 本地时区 2026-01-05 12:00 → 无论 UTC 偏移多少，本地日期都是 2026-01-05
const T1 = new Date(2026, 0, 5, 12, 0, 0).getTime()
const T2 = new Date(2026, 0, 5, 13, 0, 0).getTime()
const T3 = new Date(2026, 0, 5, 14, 0, 0).getTime()

const usageEvent = (model, usage, time, scope = 'turn') => JSON.stringify({
  type: 'usage.record', agentId: 'main', model, usage, usageScope: scope, time,
})

const write = (rel, lines) => {
  const file = path.join(SESSIONS, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
}

// 供应商别名（统计落库时要去掉别名里的供应商前缀）
fs.writeFileSync(path.join(tmp, 'config.toml'), [
  '[providers.alias]',
  'type = "openai"',
  'base_url = "https://api.example.com/v1"',
  'api_key = "sk-test"',
].join('\n') + '\n', 'utf-8')

const requestEvent = (model, modelAlias, time) => JSON.stringify({
  type: 'llm.request', agentId: 'main', provider: 'anthropic', model, modelAlias, time,
})

// 会话 1：main + 子 agent 各一条用量；含超长“假 usage.record”行与损坏行
const LONG_LINE = JSON.stringify({
  type: 'tool.result',
  content: `{"type":"usage.record"} ${'x'.repeat(2000)}`,
})
write('wd_proj_abc/session_1/state.json', [JSON.stringify({
  id: 'session_1', cwd: '/Users/me/projects/demo', updatedAt: T2,
})])
write('wd_proj_abc/session_1/agents/main/wire.jsonl', [
  JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: T1 }),
  LONG_LINE,
  '{ 损坏的 JSON 行',
  requestEvent('a', 'alias/a', T1),
  usageEvent('alias/a', { inputOther: 100, output: 10, inputCacheRead: 1000, inputCacheCreation: 0 }, T1),
  requestEvent('a', 'alias/a', T2),
  usageEvent('alias/a', { inputOther: 20, output: 5, inputCacheRead: 2000, inputCacheCreation: 300 }, T2),
  usageEvent('alias/a', { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 }, T2),
  // 缺 time 的事件不猜日期（不能落到 1970）
  JSON.stringify({ type: 'usage.record', model: 'alias/a', usage: { inputOther: 9, output: 9 }, usageScope: 'turn' }),
])
// 子 agent 没有 llm.request：退回别名并按配置里的供应商名剥前缀
write('wd_proj_abc/session_1/agents/sub/wire.jsonl', [
  usageEvent('alias/b', { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 }, T3, 'session'),
])

// 会话 2：只有事件流、没有 usage.record → 不计 sessionCount
write('wd_proj_abc/session_2/state.json', [JSON.stringify({ id: 'session_2', cwd: '/Users/me/other' })])
write('wd_proj_abc/session_2/agents/main/wire.jsonl', [
  JSON.stringify({ type: 'turn.prompt', agentId: 'main', input: 'hi', time: T1 }),
])

// 索引缓存目录必须被忽略（不参与统计）
write('.index-cache/scan.json', ['{}'])

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

// ==================== 解析 ====================

let stats
check('汇总 usage.record：输入含缓存 / 输出单列 / 子 agent 计入', () => {
  stats = kimiUsage.readKimiUsage()
  assert.strictEqual(stats.summary.totalTokens, 1110 + 2325 + 10)
  assert.strictEqual(stats.summary.outputTokens, 10 + 5 + 2)
  assert.strictEqual(stats.summary.inputTokens, 1110 + 2325 + 10 - 17)
  assert.strictEqual(stats.summary.messageCount, 3, '零用量与假 usage.record 行不计')
  assert.strictEqual(stats.summary.sessionCount, 1, '没有 usage 的会话不计 sessionCount')
})

check('模型名不带供应商前缀（优先 llm.request.model，老日志剥已知供应商名）', () => {
  const byName = Object.fromEntries(stats.modelStats.map((m) => [m.name, m]))
  assert.deepStrictEqual(Object.keys(byName).sort(), ['a', 'b'])
  assert.strictEqual(byName.a.tokens, 1110 + 2325)
  assert.strictEqual(byName.a.inputTokens, 100 + 20 + 1000 + 2000 + 300)
  assert.strictEqual(byName.a.outputTokens, 15)
  assert.strictEqual(byName.b.tokens, 10)
})

check('日期取本地时区，day.inputTokens 含缓存', () => {
  const day = stats.contributions.find((d) => d.tokens > 0)
  assert.strictEqual(day.date, '2026-01-05')
  assert.strictEqual(day.tokens, 3445)
  assert.strictEqual(day.outputTokens, 17)
  assert.strictEqual(day.inputTokens, 3428)
  assert.strictEqual(day.models.a.inputTokens, 120, '模型维度只存未缓存输入')
  assert.strictEqual(day.models.a.cacheReadTokens, 3000)
  assert.strictEqual(day.models.a.cacheCreationTokens, 300)
})

check('usageScope=session（压缩/标题等）同样计入', () => {
  const day = stats.contributions.find((d) => d.tokens > 0)
  assert.ok(day.models.b, '子 agent 的 session scope 用量已计入')
})

// ==================== 落库 / 历史回放 ====================

check('解析后落库 ccconfig_agent_usage_kimi_test', () => {
  const doc = dbDocs.get('ccconfig_agent_usage_kimi_test')
  assert.ok(doc, '应写入 agent usage 文档')
  assert.strictEqual(doc.agent, 'kimi')
  assert.strictEqual(doc.nativeId, 'test')
  assert.strictEqual(doc.days['2026-01-05'].tokens, 3445)
  assert.strictEqual(doc.days['2026-01-05'].inputTokens, 3428)
  assert.ok(doc.days['2026-01-05'].models.a, '落库模型名不带供应商前缀')
})

check('readKimiUsageFromHistory 返回同口径统计', () => {
  const h = kimiUsage.readKimiUsageFromHistory()
  assert.ok(h)
  assert.strictEqual(h.summary.totalTokens, 3445)
  assert.strictEqual(h.summary.outputTokens, 17)
  assert.strictEqual(h.summary.inputTokens, 3428)
})

check('源会话被清理后回放落库历史，不归零', () => {
  fs.rmSync(SESSIONS, { recursive: true, force: true })
  const h = kimiUsage.readKimiUsage()
  assert.strictEqual(h.summary.totalTokens, 3445)
  assert.strictEqual(h.contributions.find((d) => d.tokens > 0).date, '2026-01-05')
})

check('无源文件且无历史时返回 365 天空档', () => {
  dbDocs.clear()
  const empty = kimiUsage.readKimiUsage()
  assert.strictEqual(empty.summary.totalTokens, 0)
  assert.strictEqual(empty.contributions.length, 365)
  assert.ok(empty.contributions.every((d) => d.tokens === 0))
})

// ==================== 输出 ====================

let failed = 0
for (const [status, name] of results) {
  if (status === 'FAIL') failed++
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed) process.exit(1)
