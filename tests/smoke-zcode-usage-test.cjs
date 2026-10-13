// zcode.js readZcodeUsage 冒烟测试：node tests/smoke-zcode-usage-test.cjs（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包
// 用临时目录伪造 ~/.zcode/cli/db/db.sqlite（真实 ZCode 库 schema 的最小子集），
// 并搭最小 uTools 环境验证落库 / 历史回放路径。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-usage-test-'))
const zcodeDir = path.join(tmp, '.zcode', 'cli', 'db')
fs.mkdirSync(zcodeDir, { recursive: true })
// 让 zcode.js 的 CONFIG_DIR 指向临时 HOME
const realHomedir = os.homedir()
os.homedir = () => tmp

// 最小 uTools 环境（db 用内存 Map 模拟，便于验证落库/回放）
const savedDocs = new Map()
global.window = {
  utools: {
    getPath: () => tmp,
    getNativeId: () => 'test-native',
    shellOpenPath() {},
    db: {
      get: (id) => savedDocs.get(id) || null,
      put: (doc) => { savedDocs.set(doc._id, { ...doc }); return { ok: true } },
    },
  },
}

const zcode = require('../public/preload/services/zcode')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}

// ==================== 伪造 ZCode db ====================
const buildDb = (dbPath) => {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE session (
      id text primary key, directory text, title text,
      time_created integer, time_updated integer);
    CREATE TABLE model_usage (
      id text primary key, session_id text, status text,
      started_at integer, provider_id text, model_id text,
      input_tokens integer default 0, output_tokens integer default 0,
      reasoning_tokens integer default 0,
      cache_read_input_tokens integer default 0,
      cache_creation_input_tokens integer default 0);
  `)
  return db
}

const DAY1 = Date.parse('2026-01-05T08:00:00Z') // ms
const DAY2 = Date.parse('2026-01-06T09:00:00Z')
const db = buildDb(path.join(zcodeDir, 'db.sqlite'))
db.prepare(`INSERT INTO session (id, directory, title) VALUES (?, ?, ?)`)
  .run('sess-1', '/tmp/proj-a', '测试会话')
const ins = db.prepare(`INSERT INTO model_usage
  (id, session_id, status, started_at, provider_id, model_id,
   input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
  VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`)
// Day1：input 含缓存（read 900 + creation 50），未缓存输入 = 1000 - 950 = 50；total = 1050 + 20
ins.run('mu-1', 'sess-1', DAY1, 'prov-a', 'model-x', 1000, 20, 900, 50)
ins.run('mu-2', 'sess-1', DAY1, 'prov-a', 'model-x', 500, 10, 400, 0)
// Day1 cancelled 行：必须被过滤
db.prepare(`INSERT INTO model_usage (id, session_id, status, started_at, provider_id, model_id)
  VALUES ('mu-bad', 'sess-1', 'cancelled', ?, 'prov-a', 'model-x')`).run(DAY1 + 1000)
// Day2 另一模型
ins.run('mu-3', 'sess-1', DAY2, 'prov-b', 'model-y', 100, 5, 0, 0)
db.close()

// ==================== 用例 ====================
const stats = zcode.readZcodeUsage()

ok(stats.summary.messageCount === 3, `cancelled 行不计入（messageCount=3，got=${stats.summary.messageCount}）`)
// Day1 total = (1000+20) + (500+10) = 1530
const day1 = stats.contributions.find((d) => d.date === '2026-01-05')
ok(day1 && day1.tokens === 1530, `day1 total=1530（got=${day1 && day1.tokens}）`)
// 含缓存输入口径：total - output = 1530 - 30 = 1500
ok(day1.inputTokens === 1500, `day1 含缓存输入=1500（got=${day1.inputTokens}）`)
// 模型名带 provider 前缀
const modelX = stats.modelStats.find((m) => m.name === 'model-x')
ok(!!modelX, '模型名只取 model_id 不带 provider 前缀（model-x）')
// modelStats 未缓存输入 + 缓存 = 含缓存：50+500 + 900 + 50 = 1500
ok(modelX.inputTokens === 1500, `model-x 含缓存输入=1500（got=${modelX.inputTokens}）`)
ok(stats.summary.sessionCount === 1, `sessionCount=1（got=${stats.summary.sessionCount}）`)

// 落库验证
const doc = savedDocs.get('ccswitch_agent_usage_zcode_test-native')
ok(!!doc && doc.days['2026-01-05']?.tokens === 1530, '每日聚合落库 ccswitch_agent_usage_zcode_<nativeId>')

// ==================== db 消失 → 历史回放 ====================
fs.rmSync(path.join(zcodeDir, 'db.sqlite'))
const stats2 = zcode.readZcodeUsage()
const day1b = stats2.contributions.find((d) => d.date === '2026-01-05')
ok(day1b && day1b.tokens === 1530, 'db 清理后从历史档回放，不归零')

// ==================== 历史取较大值合并（db 数据缩水场景） ====================
const db2 = buildDb(path.join(zcodeDir, 'db.sqlite'))
const ins2 = db2.prepare(`INSERT INTO model_usage
  (id, session_id, status, started_at, provider_id, model_id, input_tokens, output_tokens)
  VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`)
ins2.run('mu-s', 'sess-s', DAY1, 'prov-a', 'model-x', 100, 1) // 远小于历史 1530
db2.close()
const stats3 = zcode.readZcodeUsage()
const day1c = stats3.contributions.find((d) => d.date === '2026-01-05')
ok(day1c && day1c.tokens === 1530, `同一天历史取较大值（got=${day1c && day1c.tokens}）`)

// ==================== 无库 + 无历史 → 空统计 ====================
fs.rmSync(path.join(zcodeDir, 'db.sqlite'))
savedDocs.delete('ccswitch_agent_usage_zcode_test-native')
const stats4 = zcode.readZcodeUsage()
ok(stats4.summary.totalTokens === 0 && stats4.contributions.length === 365, '无库无历史返回空统计（365 天骨架）')

// ==================== 旧落库带 provider 前缀 → 读历史时剥前缀（同名合并） ====================
savedDocs.set('ccswitch_agent_usage_zcode_test-native', {
  _id: 'ccswitch_agent_usage_zcode_test-native',
  days: {
    '2026-01-07': {
      tokens: 2000, inputTokens: 1900, outputTokens: 100,
      models: {
        'prov-a/model-x': { inputTokens: 100, outputTokens: 60, cacheReadTokens: 800, cacheCreationTokens: 0 },
        'prov-b/model-x': { inputTokens: 30, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
    },
  },
  updatedAt: Date.now(),
})
const stats5 = zcode.readZcodeUsage()
const day7 = stats5.contributions.find((d) => d.date === '2026-01-07')
ok(day7 && day7.tokens === 2000, `旧前缀历史回放 tokens（got=${day7 && day7.tokens}）`)
ok(day7 && day7.models['model-x'] && !day7.models['prov-a/model-x'] && !day7.models['prov-b/model-x'],
  `历史 models 键剥前缀合并为 model-x（got=${day7 && JSON.stringify(Object.keys(day7.models))}）`)
ok(day7 && day7.models['model-x'].inputTokens === 130 && day7.models['model-x'].outputTokens === 100,
  `同名模型用量合并（input=130 output=100，got=${day7 && JSON.stringify(day7.models['model-x'])}）`)

os.homedir = realHomedir
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
