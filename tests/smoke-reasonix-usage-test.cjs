// Reasonix 用量统计冒烟测试（临时 REASONIX_HOME，绝不碰真实 ~/.reasonix）
// 重点锁定：
//   1. 只统计 stats/<日期>.jsonl 的结算行（upload/、.append.lock、损坏行都不能被误解析）
//   2. 口径：prompt 含缓存（cache_hit + cache_miss），output 单列；日期按本地时区
//   3. 模型名只在「前缀确实是配置里的供应商名」时去掉，避免误删命名空间
//   4. 源统计文件被清理后回放落库历史（ccconfig_agent_usage_reasonix_<nativeId>），不归零
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-reasonix-usage-'))
process.env.REASONIX_HOME = tmp

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

// 配置里的供应商名（决定模型引用是否剥前缀）
fs.writeFileSync(path.join(tmp, 'config.toml'), [
  'default_model = "alias/a"',
  '',
  '[[providers]]',
  'name = "alias"',
  'kind = "openai"',
  'base_url = "https://api.example.com/v1"',
  'api_key_env = "ALIAS_API_KEY"',
  'models = ["a"]',
].join('\n') + '\n', 'utf-8')

const reasonixUsage = require('../public/preload/services/reasonix-usage.js')

const STATS = path.join(tmp, 'stats')

// 本地时区 2026-01-05 12:00 → 无论 UTC 偏移多少，本地日期都是 2026-01-05
const T1 = new Date(2026, 0, 5, 12, 0, 0).getTime()
const T2 = new Date(2026, 0, 5, 13, 0, 0).getTime()
const T3 = new Date(2026, 0, 6, 9, 0, 0).getTime()

// ts 用带偏移的 ISO 串（与 Reasonix 实际写入格式一致）
const iso = (ms) => {
  const d = new Date(ms)
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000000${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}

const row = (model, { prompt, completion, cacheHit, ts, source = 'desktop' }) => JSON.stringify({
  ts,
  model,
  source,
  prompt,
  completion,
  cache_hit: cacheHit,
  cache_miss: prompt - cacheHit,
  total: prompt + completion,
  requests: 1,
  estimated: false,
  usage_source: 'executor',
})

const write = (rel, lines) => {
  const file = path.join(STATS, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
}

// 统计文件 1：正常行 + 损坏行 + 零用量行 + 缺 ts 行
write('2026-01-05.jsonl', [
  row('alias/a', { prompt: 1000, completion: 10, cacheHit: 800, ts: iso(T1) }),
  row('alias/a', { prompt: 25, completion: 5, cacheHit: 0, ts: iso(T2), source: 'cli' }),
  '{ 损坏的 JSON 行',
  row('alias/a', { prompt: 0, completion: 0, cacheHit: 0, ts: iso(T2) }),
  JSON.stringify({ model: 'alias/a', prompt: 9, completion: 9 }),
])
// 统计文件 2：跨天 + 命名空间模型（前缀不是配置里的供应商名 → 保留原名）
write('2026-01-06.jsonl', [
  row('moonshotai/kimi-k2', { prompt: 300, completion: 100, cacheHit: 200, ts: iso(T3) }),
])
// 不参与统计：upload/ 与锁文件
write('upload/2026-01-05.1-2.json', [JSON.stringify({ day: '2026-01-05', providers: {} })])
fs.writeFileSync(path.join(STATS, '.append.lock'), '', 'utf-8')

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

// ==================== 解析 ====================

let stats
check('汇总结算行：输入含缓存 / 输出单列', () => {
  stats = reasonixUsage.readReasonixUsage()
  // 1000+10 + 25+5 + 300+100
  assert.strictEqual(stats.summary.totalTokens, 1440)
  assert.strictEqual(stats.summary.outputTokens, 115)
  assert.strictEqual(stats.summary.inputTokens, 1325)
  assert.strictEqual(stats.summary.messageCount, 3, '零用量 / 损坏行 / 缺 ts 行不计')
})

check('模型名只在前缀是已知供应商时剥掉', () => {
  const byName = Object.fromEntries(stats.modelStats.map((m) => [m.name, m]))
  assert.deepStrictEqual(Object.keys(byName).sort(), ['a', 'moonshotai/kimi-k2'])
  assert.strictEqual(byName.a.tokens, 1040)
  assert.strictEqual(byName['moonshotai/kimi-k2'].tokens, 400)
})

check('日期按本地时区，模型维度只存未缓存输入', () => {
  const day = stats.contributions.find((d) => d.date === '2026-01-05')
  assert.ok(day, '2026-01-05 应有数据')
  assert.strictEqual(day.tokens, 1040)
  assert.strictEqual(day.outputTokens, 15)
  assert.strictEqual(day.inputTokens, 1025)
  assert.strictEqual(day.models.a.inputTokens, 225, '未缓存输入 = prompt - cache_hit')
  assert.strictEqual(day.models.a.cacheReadTokens, 800)
  assert.strictEqual(day.models.a.cacheCreationTokens, 0)
})

check('CLI 与桌面版共用同一目录，来源不拆分统计', () => {
  const day = stats.contributions.find((d) => d.date === '2026-01-05')
  const total = day.models.a.inputTokens + day.models.a.outputTokens + day.models.a.cacheReadTokens
  assert.strictEqual(total, 1040)
})

// ==================== 落库 / 历史回放 ====================

check('解析后落库 ccconfig_agent_usage_reasonix_test', () => {
  const doc = dbDocs.get('ccconfig_agent_usage_reasonix_test')
  assert.ok(doc, '应写入 agent usage 文档')
  assert.strictEqual(doc.agent, 'reasonix')
  assert.strictEqual(doc.nativeId, 'test')
  assert.strictEqual(doc.days['2026-01-05'].tokens, 1040)
  assert.ok(doc.days['2026-01-05'].models.a, '落库模型名不带供应商前缀')
})

check('readReasonixUsageFromHistory 返回同口径统计', () => {
  const h = reasonixUsage.readReasonixUsageFromHistory()
  assert.ok(h)
  assert.strictEqual(h.summary.totalTokens, 1440)
  assert.strictEqual(h.summary.outputTokens, 115)
  assert.strictEqual(h.summary.inputTokens, 1325)
})

check('源统计文件被清理后回放落库历史，不归零', () => {
  fs.rmSync(STATS, { recursive: true, force: true })
  const h = reasonixUsage.readReasonixUsage()
  assert.strictEqual(h.summary.totalTokens, 1440)
  assert.strictEqual(h.contributions.find((d) => d.tokens > 0).date, '2026-01-05')
})

check('无源文件且无历史时返回 365 天空档', () => {
  dbDocs.clear()
  const empty = reasonixUsage.readReasonixUsage()
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
