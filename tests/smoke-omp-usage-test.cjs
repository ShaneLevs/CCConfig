// omp-usage.js 冒烟测试：node tests/smoke-omp-usage-test.cjs（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包
// 用临时 PI_CONFIG_DIR 伪造 ~/.omp（绝不碰真实 ~/.omp），覆盖：
//   1. 主会话 assistant 消息的 usage 计入；非 assistant（user / toolResult）不计入
//   2. model_usage 条目（对话外的模型调用：压缩 / 标题等）计入
//   3. 缺 entry id 的条目跳过；同一 id 在多处出现只算一次（归档副本去重）
//   4. 子 agent 转录（sessions/<project>/<会话目录>/<id>.jsonl）计入，会话归属到父会话
//   5. gc 归档（archive/sessions/**/*.jsonl.gz）与就地压缩的 .jsonl.gz 都能解析
//   6. 日期按本地时区；口径：输入含缓存、输出单列、总量 = 输入 + 输出
//   7. 落库（ccconfig_agent_usage_omp_<nativeId>）；源文件全没了回放历史不归零
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-omp-usage-'))
process.env.PI_CONFIG_DIR = '.omp-test'
os.homedir = () => tmp

// 内存 DB：只实现统计路径用到的 get / put
const dbDocs = new Map()
global.window = {
  utools: {
    getPath: () => os.homedir(),
    getNativeId: () => 'test-native',
    shellOpenPath() {},
    db: {
      get: (id) => dbDocs.get(id) || null,
      put: (doc) => { dbDocs.set(doc._id, { ...doc }); return { ok: true, id: doc._id } },
    },
  },
}

process.env.CCCONFIG_LOCALE = process.env.CCCONFIG_LOCALE || 'zh-CN'
const ompUsage = require('../public/preload/services/omp-usage')

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const eq = (a, b, name) =>
  ok(JSON.stringify(a) === JSON.stringify(b), name, `got=${JSON.stringify(a)} want=${JSON.stringify(b)}`)

// ==================== fixtures ====================

const AGENT_DIR = path.join(tmp, '.omp-test', 'agent')
const SESSIONS = path.join(AGENT_DIR, 'sessions')
const ARCHIVE = path.join(AGENT_DIR, 'archive', 'sessions')
const PROJECT = '-Users-me-proj'
const SESSION_ID = 'session-1'
const SESSION_DIR = '2026-01-05T10-00-00-000Z_aaaaaaaa'

// 本地时区 2026-01-05 12:00 → 无论 UTC 偏移多少，本地日期都是 2026-01-05
const T1 = new Date(2026, 0, 5, 12, 0, 0).getTime()
const T2 = new Date(2026, 0, 5, 13, 0, 0).getTime()

const write = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
}
const writeGz = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf-8')))
}

const header = (id = SESSION_ID, ts = T1, cwd = '/Users/me/proj') =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(ts).toISOString(), cwd })

// 一条 assistant 消息（usage 形状与 omp 实盘一致）
const assistant = ({ id, model = 'deepseek-flash', ts = T1, usage }) =>
  JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(ts).toISOString(),
    runtime: { version: '18.13.3' },
    message: {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'router',
      model,
      usage,
      stopReason: 'toolUse',
      timestamp: ts,
    },
  })

const usageOf = (input, output, cacheRead = 0, cacheWrite = 0, cost = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
})

// 会话主文件：两条有效 assistant + 一条缺 id（跳过）+ 一条 user（跳过）+ 损坏行
write(path.join(SESSIONS, PROJECT, `${SESSION_DIR}.jsonl`), [
  header(),
  assistant({ id: 'e1', usage: usageOf(100, 10, 1000, 0, 0.5) }),
  JSON.stringify({ type: 'message', id: 'u1', timestamp: new Date(T1).toISOString(), message: { role: 'user', content: 'hi' } }),
  '{ 损坏的 JSON 行',
  // 缺 id：旧版会话，无法去重 → 不计入
  JSON.stringify({
    type: 'message',
    timestamp: new Date(T1).toISOString(),
    message: { role: 'assistant', model: 'deepseek-flash', usage: usageOf(999, 999) },
  }),
  assistant({ id: 'e2', model: 'glm-5.3-flash', ts: T2, usage: usageOf(200, 20, 0, 50, 0.25) }),
  // 对话外的模型调用（标题生成）：计入
  JSON.stringify({
    type: 'model_usage',
    id: 'm1',
    timestamp: new Date(T2).toISOString(),
    purpose: 'title',
    role: 'tiny',
    api: 'openai-completions',
    provider: 'router',
    model: 'minimax-m3.1-flash',
    usage: usageOf(30, 5),
    stopReason: 'stop',
  }),
])

// 子 agent 转录：同一会话目录下的嵌套文件
write(path.join(SESSIONS, PROJECT, SESSION_DIR, 'sub-1.jsonl'), [
  assistant({ id: 's1', model: 'glm-5.3-flash', ts: T2, usage: usageOf(1000, 100) }),
])

// 就地压缩的会话（omp gc --compress）：.jsonl.gz
writeGz(path.join(SESSIONS, PROJECT, '2026-01-06T10-00-00-000Z_bbbbbbbb.jsonl.gz'), [
  header('session-2', new Date(2026, 0, 6, 12, 0, 0).getTime(), '/Users/me/other'),
  assistant({ id: 'c1', ts: new Date(2026, 0, 6, 12, 0, 0).getTime(), usage: usageOf(40, 4) }),
])

// 归档会话：archive/sessions/<project>/<file>.jsonl.gz
writeGz(path.join(ARCHIVE, PROJECT, `${SESSION_DIR}.jsonl.gz`), [
  header(),
  assistant({ id: 'e1', usage: usageOf(100, 10, 1000, 0, 0.5) }), // 与活文件同 id → 去重
  assistant({ id: 'a1', ts: T2, usage: usageOf(70, 7) }),
])

// ==================== 断言 ====================

const stats = ompUsage.readOmpUsage()

// 模型分布（每条 = input+output+cacheRead+cacheWrite）：
//   deepseek-flash = e1 1110 + a1(归档) 77 + c1 44 = 1231
//   glm-5.3-flash  = e2 270 + 子 agent s1 1100 = 1370
//   minimax-m3.1-flash = model_usage m1 35
const modelTokens = Object.fromEntries(stats.modelStats.map((m) => [m.name, m.tokens]))
eq(modelTokens, {
  'glm-5.3-flash': 1370,
  'deepseek-flash': 1231,
  'minimax-m3.1-flash': 35,
}, '模型分布按「输入+输出+缓存」聚合')

// 总量 = 各模型 tokens 之和；输入含缓存
const total = 1370 + 1231 + 35
eq(stats.summary.totalTokens, total, '总 tokens')
eq(stats.summary.outputTokens, 10 + 20 + 5 + 100 + 4 + 7, '输出 tokens')
eq(stats.summary.inputTokens, total - stats.summary.outputTokens, '输入 = 总量 - 输出')

// 日期：本地时区（东八区凌晨不会算到前一天）
const byDate = Object.fromEntries(stats.contributions.map((d) => [d.date, d.tokens]))
eq(byDate['2026-01-05'], 1231 - 44 + 1370 + 35, '2026-01-05 用量')
eq(byDate['2026-01-06'], 44, '2026-01-06 用量（.jsonl.gz）')

// 会话数：session-1（主 + 子 agent 同属一个会话）+ session-2
eq(stats.summary.sessionCount, 2, '会话数按会话 id 聚合')

// 贡献数组补齐 365 天（热力图不塌）
eq(stats.contributions.length, 365, '贡献数组长度 365')

// 落库
const doc = dbDocs.get('ccconfig_agent_usage_omp_test-native')
ok(!!doc, '落库文档 ccconfig_agent_usage_omp_<nativeId>')
ok(!!doc?.days?.['2026-01-05'], '落库包含 2026-01-05')
eq(doc?.days?.['2026-01-06']?.tokens, 44, '落库 2026-01-06 用量')

// 快速路径：纯读落库历史（不解析源文件）
const quick = ompUsage.readOmpUsageFromHistory()
eq(quick?.summary.totalTokens, total, '历史回放总量一致')
eq(quick?.contributions.length, 365, '历史回放补 365 天')

// 源文件全被清理 → 回放历史，不归零
fs.rmSync(SESSIONS, { recursive: true, force: true })
fs.rmSync(ARCHIVE, { recursive: true, force: true })
const afterGc = ompUsage.readOmpUsage()
eq(afterGc.summary.totalTokens, total, '源文件清空后回放历史不归零')
eq(afterGc.contributions.length, 365, '源文件清空后仍补 365 天')

console.log(`\n通过 ${passed}/${passed + failed}`)
if (failed) process.exit(1)
