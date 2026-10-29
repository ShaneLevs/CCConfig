// Pi Agent 用量统计冒烟测试（临时 HOME，绝不碰真实 ~/.pi）
// 重点锁定「派 agent（subagent）的用量进不了今日统计」的根因：
//   Pi 会话 JSONL 的 timestamp 是 UTC ISO 串。旧实现取 `ts.split('T')[0]` 得到 **UTC 日期**，
//   东八区 00:00–08:00 之间本地已经是新的一天、UTC 还在前一天，于是：
//     - 当天新建的会话（含所有 subagent 会话）全部被记到「昨天」
//     - 热力图 / 柱状图的「今日」恒为 0，用户看到「今天没数据」
//   本测试用「本地某天 00:30」这种跨 UTC 日界的时间点做断言，保证任何时区下都覆盖到该分支。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-pi-usage-'))
process.env.HOME = tmp
// pi-common.js 用 os.homedir()，Windows 下走 USERPROFILE；两套都指到临时目录
process.env.USERPROFILE = tmp

// 内存 DB：只实现统计路径用到的 get / put / allDocs
const dbDocs = new Map()
global.window = {
  utools: {
    getPath: () => tmp,
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

const pi = require('../public/preload/services/pi.js')
const usage = require('../public/preload/services/usage.js')

const SESSIONS = path.join(tmp, '.pi', 'agent', 'sessions')

const localKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// 「本地今天 00:30」——东八区时这条时间戳的 UTC 日期是昨天，正是出问题的窗口
const now = new Date()
const earlyToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30, 0)
const todayKey = localKey(earlyToday)
const utcKeyOfEarlyToday = earlyToday.toISOString().split('T')[0]

const sessionLine = (id, ts) =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: ts, cwd: '/Users/me/proj' })

const messageLine = (ts, usageFields) =>
  JSON.stringify({
    type: 'message',
    timestamp: ts,
    message: { role: 'assistant', model: 'deepseek-flash', usage: usageFields },
  })

const writeSession = (relDir, file, lines) => {
  const dir = path.join(SESSIONS, relDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), lines.join('\n') + '\n', 'utf-8')
}

const iso = (d) => d.toISOString()
const usageOf = (input, output, cacheRead = 0) => ({
  input, output, cacheRead, cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: { total: 0 },
})

// 主会话（本地凌晨 00:30）
writeSession('--Users-me-proj--', 'main.jsonl', [
  sessionLine('main-1', iso(earlyToday)),
  messageLine(iso(earlyToday), usageOf(100, 20, 300)),
])

// subagent 会话：pi-subagents 把子会话写在 sessions/<父会话同款项目目录>/<父会话名>/<runId>/run-N/ 下，
// 也可能落在 temp 目录。这里模拟项目目录下的嵌套形态（真实布局）。
const subDir = path.join('--Users-me-proj--', 'parent', 'async-abc', 'run-0')
writeSession(subDir, 'child.jsonl', [
  sessionLine('child-1', iso(earlyToday)),
  messageLine(iso(earlyToday), usageOf(50, 10, 0)),
])

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

// ==================== 断言 ====================

let stats
check('读取 Pi 用量', () => {
  stats = pi.readPiUsage()
  assert.ok(stats, 'readPiUsage 返回结果')
})

check('凌晨的用量记在「本地今天」而不是 UTC 昨天', () => {
  const today = stats.contributions.find((d) => d.date === todayKey)
  assert.ok(today, `存在 ${todayKey} 这一天`)
  // 主会话 100+20+300 + 子会话 50+10 = 480
  assert.strictEqual(today.tokens, 480, `今天 tokens（got=${today.tokens}）`)
})

check('UTC 日期那条骨架为 0（不再把当天用量错记到昨天）', () => {
  if (utcKeyOfEarlyToday === todayKey) return // 该时区下 UTC 与本地同日，跳过
  const utcDay = stats.contributions.find((d) => d.date === utcKeyOfEarlyToday)
  assert.ok(utcDay, `存在 ${utcKeyOfEarlyToday}`)
  assert.strictEqual(utcDay.tokens, 0, `UTC 昨天不应有当天用量（got=${utcDay.tokens}）`)
})

check('usage.localDayKey 支持 ISO 串 / 毫秒 / Date', () => {
  assert.strictEqual(usage.localDayKey(iso(earlyToday)), todayKey)
  assert.strictEqual(usage.localDayKey(earlyToday.getTime()), todayKey)
  assert.strictEqual(usage.localDayKey(earlyToday), todayKey)
  assert.strictEqual(usage.localDayKey(''), '')
  assert.strictEqual(usage.localDayKey('not-a-date'), '')
})

check('落库文档包含今天（否则「通用」统计页的今日也是 0）', () => {
  const doc = dbDocs.get('ccconfig_agent_usage_pi_test')
  assert.ok(doc, '已落库')
  assert.ok(doc.days[todayKey], `落库含 ${todayKey}`)
  assert.strictEqual(doc.days[todayKey].tokens, 480)
})

check('365 天骨架按本地日期生成，最后一天是今天', () => {
  const empty = usage.emptyContributions()
  assert.strictEqual(empty.length, 365)
  assert.strictEqual(empty[empty.length - 1].date, localKey(new Date()), '骨架末位是本地今天')
})

for (const [status, name] of results) console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}`)
const failed = results.filter(([s]) => s === 'FAIL').length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
