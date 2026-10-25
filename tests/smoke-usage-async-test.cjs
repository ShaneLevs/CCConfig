// usage-async.js + usage-worker.js 冒烟测试：node tests/smoke-usage-async-test.cjs（仓库根目录运行）
// 验证统计后台线程全链路：主线程（最小 uTools 环境）→ worker（stub window.utools）→
// 历史档种子命中 / 落库写队列重放 / 真实 JSONL 解析。
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-async-test-'))
process.env.DSH_HOME = tmp

// 伪造 ~/.claude/projects/<proj>/conv.jsonl（一条 assistant 消息）
const projDir = path.join(tmp, '.claude', 'projects', '-tmp-proj')
fs.mkdirSync(projDir, { recursive: true })
const ts = new Date().toISOString()
const line = JSON.stringify({
  type: 'assistant', sessionId: 's1', timestamp: ts,
  message: { model: 'claude-test', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } },
})
fs.writeFileSync(path.join(projDir, 'conv.jsonl'), line + '\n')

// 主线程最小 uTools 环境（db 内存 Map 模拟，便于验证写队列重放）
const savedDocs = new Map()
global.window = {
  utools: {
    getPath: () => tmp,
    getNativeId: () => 'test-native',
    shellOpenPath() {},
    db: {
      get: (id) => savedDocs.get(id) || null,
      put: (doc) => { savedDocs.set(doc._id, { ...doc }); return { ok: true } },
      remove: () => ({ ok: true }),
      allDocs: () => Array.from(savedDocs.values()),
    },
  },
}

process.env.CCCONFIG_LOCALE = process.env.CCCONFIG_LOCALE || 'zh-CN'
const usageAsync = require('../public/preload/services/usage-async')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}

;(async () => {
  // ==================== DSH：无日志无历史 → 空统计 ====================
  const stats = await usageAsync.readDshUsageAsync()
  ok(stats && stats.contributions.length === 365, 'DSH worker 空统计返回 365 天骨架')

  // ==================== DSH：历史档种子 → worker 内历史回放不归零 ====================
  const docId = 'ccswitch_agent_usage_dsh_test-native'
  savedDocs.set(docId, {
    _id: docId, nativeId: 'test-native', agent: 'dsh', updatedAt: Date.now(),
    days: { '2026-01-05': { tokens: 1070, inputTokens: 1050, outputTokens: 20,
      models: { 'deepseek-flash': { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 50 } } } },
  })
  const stats2 = await usageAsync.readDshUsageAsync()
  const day = stats2.contributions.find(d => d.date === '2026-01-05')
  ok(day && day.tokens === 1070, `DSH worker 历史回放 tokens=1070（got=${day && day.tokens}）`)

  // ==================== ZCode：历史档种子回放 ====================
  const zdocId = 'ccswitch_agent_usage_zcode_test-native'
  savedDocs.set(zdocId, {
    _id: zdocId, nativeId: 'test-native', agent: 'zcode', updatedAt: Date.now(),
    days: { '2026-01-06': { tokens: 1530, inputTokens: 1500, outputTokens: 30,
      models: { 'model-x': { inputTokens: 550, outputTokens: 30, cacheReadTokens: 900, cacheCreationTokens: 50 } } } },
  })
  const stats3 = await usageAsync.readZcodeUsageAsync()
  const day3 = stats3.contributions.find(d => d.date === '2026-01-06')
  ok(day3 && day3.tokens === 1530, `ZCode worker 历史回放 tokens=1530（got=${day3 && day3.tokens}）`)

  // ==================== Claude：真实 JSONL 解析 + 落库写队列重放 ====================
  const stats4 = await usageAsync.readClaudeUsageAsync()
  const day4 = stats4.contributions.find(d => d.tokens > 0)
  ok(!!day4, `Claude worker 真实解析 JSONL（tokens=${day4 && day4.tokens}）`)
  ok(stats4.summary.totalTokens === 180, `totalTokens=180（got=${stats4.summary.totalTokens}）`)
  const claudeDoc = savedDocs.get('ccswitch_agent_usage_claude_test-native')
  ok(!!claudeDoc && claudeDoc.days[day4.date]?.tokens === 180, 'worker 落库写队列重放到主线程 DB')
  ok(!!savedDocs.get('ccswitch_heatmap_test-native'), '热力图历史落库重放')
  ok(!!savedDocs.get('ccswitch_usage_cache_test-native'), 'usage 缓存落库重放')

  console.log(`\n${passed} passed, ${failed} failed`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
