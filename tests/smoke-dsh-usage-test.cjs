// dsh-usage.js 冒烟测试：node tests/smoke-dsh-usage-test.cjs（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包
// 会话日志的 zstd 帧以 base64 常量内嵌（由 node:zlib zstdCompressSync 生成），
// 好处是任意 Node 版本都能跑——uTools 的 Node 20 没有 zstd 压缩 API，但解码用的是 fzstd。
// 注意：帧内嵌了固定时间戳（2026-01-05 / 01-06，UTC），需落在统计的最近 365 天窗口内；
// 若窗口外需重新生成（内容见下方 FIXTURE_* 注释）。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-test-'))
process.env.DSH_HOME = tmp

// dsh-usage 经 usage.js 间接依赖 config.js（模块加载时读 window.utools.getPath），
// 先搭最小 uTools 环境；db 用内存 Map 模拟，便于验证缓存写入/命中
const savedDocs = new Map()
global.window = {
  utools: {
    getPath: () => os.homedir(),
    getNativeId: () => 'test-native',
    shellOpenPath() {},
    db: {
      get: (id) => savedDocs.get(id) || null,
      put: (doc) => { savedDocs.set(doc._id, { ...doc }); return { ok: true } },
    },
  },
}

const dshUsage = require('../public/preload/services/dsh-usage')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)

// ==================== fixtures ====================
// 帧 A（4 行，含会话头 / 非目标事件 / 一条 assistant/message）
//   assistant/message: deepseek-official/deepseek-flash，input 100 + cacheRead 900 + cacheWrite 50, output 20
const FRAME_A = Buffer.from(
  'KLUv/WAxAaUKAGZSQDVgRZsOAwZgGKYM/IcQQNcQV1kBhpIRCkFLpCxqu12r++jLxjwSSAdZGlzTxya6opHoiCXgAS8ALQAwAO3Irg8GOS3HqtpxmN6eSHoiUkSC3PvgbevO6e2q+njwDeLmWt4eJWRevvtaD30sl4TcOW5FJvRlRXjMXQS7oMxbOR21GTJrBrlj7tr6oK1gv0XuDctv76nNTpxXk4l8VHbZ2n13n/ugRU7r7dQ+WUVYmeYl+Zh7yx7pgSht2W9PwTacCgZPF2Epk0Ydjiw7AAEZCUymIoKAxQCNxqXABUYzESBDAbG5ZGwwNjQDl0ju3nE7yimCUBfvdCgpO8tOYaUmCicYISBgApmDtgNQ9HwBmRGJqxUoYpx/E4oBE4kXsjGql38ihkqOTpq40N5VxEsHZpprCAB7JQPnARjdz2QhMlI9e7spiOO4qniMzOxwW6htEAM=',
  'base64',
)
// 帧 B（1 行，追加帧）：newapi/glm-5.3-flash，input 7，output 3，日期 2026-01-06
const FRAME_B = Buffer.from(
  'KLUv/SDr/QQAYgohH2BJqwMUXWwiXLu724BUfgqnhiCFMP/f32YqK4JcAieGGGN8gjUZFAhAUqiEeD7tYermqKnCrufdHpTAXFvcY3yYN9E4kjbrbeQKjKM7sIlFlxukH7tR8rz2gBH0awsd5jvMa+u5MQQOykE58qtQ3yR5hOWbL0KZVwX00mbErM9vW+jDCQAtwS+G6JlE4zR6MzOkCEXTBFR3ygD2',
  'base64',
)
// 帧 B 截断到 60%（断尾帧：结构完整但解压失败，必须被安全跳过）
const FRAME_B_TORN = Buffer.from(
  'KLUv/SDr/QQAYgohH2BJqwMUXWwiXLu724BUfgqnhiCFMP/f32YqK4JcAieGGGN8gjUZFAhAUqiEeD7tYermqKnCrufdHpTAXFvcY3yYN9E4kjbrbeQKjKM7sIlFlxukH7tR8rz2gBH0awsd5jvMa+u5MQQOykE58qtQ3yR5hOWbL0KZVwX00mbErM9vW+jDCQAtwS+G6JlE4zR6MzOkCEXTBFR3ygD2',
  'base64',
).subarray(0, 100)
// 无 zstd 的明文日志（compression: none 的部署）
const PLAIN_LINES = [
  JSON.stringify({ type: 'session', version: 4, id: 'session-plain', createdAt: Date.parse('2026-01-07T08:00:00Z'), cwd: '/tmp/proj-plain' }),
  JSON.stringify({ type: 'assistant/message', seq: 2, time: Date.parse('2026-01-07T08:01:00Z'), data: { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, message: { source: { model: 'deepseek-v4-pro' } } } }),
].join('\n') + '\n'
// 与帧 A 同一天（2026-01-05）但量更小的明文日志：验证历史合并「同一天取较大值」
const SMALL_SAME_DAY = [
  JSON.stringify({ type: 'session', version: 4, id: 'session-small', createdAt: Date.parse('2026-01-05T09:00:00Z'), cwd: '/tmp/proj-small' }),
  JSON.stringify({ type: 'assistant/message', time: Date.parse('2026-01-05T09:01:00Z'), data: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, message: { source: { model: 'retired-model' } } } }),
].join('\n') + '\n'

const sessionsRoot = path.join(tmp, 'sessions')
const HISTORY_DOC = 'ccswitch_agent_usage_dsh_test-native'
const writeLog = (relDir, name, chunks) => {
  const dir = path.join(sessionsRoot, relDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks))
}
// 只删会话日志（保留落库历史）
const rmLogs = () => fs.rmSync(sessionsRoot, { recursive: true, force: true })
// 会话日志 + DSH 落库历史一起清空：历史会被合并进统计，分区用例需要干净环境
const rmSessions = () => { rmLogs(); savedDocs.delete(HISTORY_DOC) }

// ==================== 1. 空档 ====================
console.log('1. 空档')
rmSessions()
eq(dshUsage.getDshSessionsRoot(), sessionsRoot, 'sessions 根目录 = <DSH_HOME>/sessions')
eq(dshUsage.listSessionLogs(), [], '无 sessions 目录时无日志')
let result = dshUsage.readDshUsage(true)
eq(result.summary, { totalTokens: 0, inputTokens: 0, outputTokens: 0, messageCount: 0, sessionCount: 0 }, '空档 summary 全 0')
eq(result.contributions.length, 365, '空档仍补满 365 天（与 Pi 统计页一致）')
eq(result.modelStats, [], '空档无模型分布')

// ==================== 2. 多帧解析 + 按天/按模型聚合 ====================
console.log('2. 多帧解析与聚合')
writeLog(path.join('proj-a', 'session-aaa'), 'session.v4.jsonl.zstd', [FRAME_A, FRAME_B])
result = dshUsage.readDshUsage(true)
eq(result.summary.messageCount, 2, '两条 assistant/message 被统计')
eq(result.summary.sessionCount, 1, '一个会话')
eq(result.summary.totalTokens, 1080, '总 tokens = 1070 + 10')
eq(result.summary.inputTokens, 1057, '输入（含缓存）= 总 - 输出')
eq(result.summary.outputTokens, 23, '输出 tokens')

const dayA = result.contributions.find((d) => d.date === '2026-01-05')
ok(!!dayA, 'fixture 日期 2026-01-05 落在 365 天窗口内（否则需重新生成 fixture）')
eq(dayA.tokens, 1070, '单日 tokens = 输入(含缓存 1050) + 输出(20)')
eq(dayA.inputTokens, 1050, '单日 inputTokens 含缓存（日期筛选直接取该值）')
eq(dayA.outputTokens, 20, '单日 outputTokens')
eq(dayA.models['deepseek-official/deepseek-flash'], { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 50 }, '模型维度存未缓存输入 + 缓存明细')
const dayB = result.contributions.find((d) => d.date === '2026-01-06')
eq(dayB.tokens, 10, '追加帧落到次日')
eq(dayB.models['newapi/glm-5.3-flash'], { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 }, '第三方供应商按 provider/model 区分')

eq(result.modelStats.length, 2, '两个模型')
eq(result.modelStats[0].name, 'deepseek-official/deepseek-flash', '模型按 tokens 降序')
eq(result.modelStats[0].tokens, 1070, '模型 tokens = 未缓存输入 + 输出 + 缓存读 + 缓存写')
eq(result.modelStats[0].inputTokens, 1050, '模型输入含缓存')
eq(dayA.inputTokens + dayA.outputTokens, dayA.tokens, '单日 输入 + 输出 = 总量')
eq(result.summary.inputTokens + result.summary.outputTokens, result.summary.totalTokens, 'summary 输入 + 输出 = 总量')
ok(!/tool\/result/.test(JSON.stringify(result)), '非 assistant/message 事件（tool/result）被忽略')

// ==================== 3. 世代选择 / 老布局 / 明文 ====================
console.log('3. 世代选择、项目目录老布局、明文日志')
rmSessions()
writeLog(path.join('proj-a', 'session-aaa'), 'session.v4.jsonl.zstd', [FRAME_A, FRAME_B])
writeLog(path.join('proj-a', 'session-aaa'), 'session.v3.jsonl.zstd', [FRAME_B])
result = dshUsage.readDshUsage(true)
eq(result.summary.messageCount, 2, '同目录多世代只取版本最高的 v4（v3 不重复计数）')
eq(dshUsage.listSessionLogs().map((l) => l.version), [4], 'listSessionLogs 只返回选中世代')

rmSessions()
writeLog('proj-legacy', 'session.v4.jsonl.zstd', [FRAME_A])
result = dshUsage.readDshUsage(true)
eq(result.summary.messageCount, 1, '老布局（日志直接放项目目录下）可统计')

rmSessions()
writeLog(path.join('proj-plain', 'session-plain'), 'session.v4.jsonl', [Buffer.from(PLAIN_LINES, 'utf8')])
result = dshUsage.readDshUsage(true)
eq(result.summary.messageCount, 1, '明文 .jsonl 日志可统计')
eq(result.summary.totalTokens, 10, '明文日志 tokens')
eq(result.contributions.find((d) => d.date === '2026-01-07').models, { 'deepseek-v4-pro': { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } }, '无 provider 时模型名不带前缀')

// ==================== 4. 断尾帧 / 损坏数据 ====================
console.log('4. 断尾帧与损坏数据')
rmSessions()
writeLog(path.join('proj-torn', 'session-torn'), 'session.v4.jsonl.zstd', [FRAME_A, FRAME_B_TORN])
result = dshUsage.readDshUsage(true)
eq(result.summary.messageCount, 1, '断尾帧被跳过，前面的完整帧照常统计')
eq(result.summary.totalTokens, 1070, '断尾帧不计入用量')

rmSessions()
writeLog(path.join('proj-junk', 'session-junk'), 'session.v4.jsonl.zstd', [Buffer.from('not a zstd frame at all', 'utf8')])
result = dshUsage.readDshUsage(true)
eq(result.summary.messageCount, 0, '非法帧头不报错、统计为空')
ok(!savedDocs.has(HISTORY_DOC), '全零结果不落库（避免误清已有历史）')
const scan = dshUsage.scanZstdFrames(Buffer.from('0123456789', 'utf8'))
eq(scan.frames, [], 'scanZstdFrames 对垃圾数据返回空帧表')

// ==================== 5. 缓存 ====================
console.log('5. 缓存')
rmSessions()
writeLog(path.join('proj-a', 'session-aaa'), 'session.v4.jsonl.zstd', [FRAME_A])
const first = dshUsage.readDshUsage()
const second = dshUsage.readDshUsage()
ok(first === second, '签名未变时命中缓存（返回同一对象，未重新解析）')
ok(savedDocs.has('ccswitch_dsh_usage_cache_test-native'), '缓存写入 ccswitch_dsh_usage_cache_<nativeId>')
const forced = dshUsage.readDshUsage(true)
ok(forced !== first, 'force 刷新跳过缓存')

writeLog(path.join('proj-a', 'session-aaa'), 'session.v4.jsonl.zstd', [FRAME_A, FRAME_B])
const afterAppend = dshUsage.readDshUsage()
ok(afterAppend !== first, '追加帧后签名变化，缓存失效')
eq(afterAppend.summary.messageCount, 2, '追加帧后统计到新用量')

// ==================== 6. 单文件读取失败不影响整体 ====================
console.log('6. 坏路径容错')
fs.rmSync(path.join(sessionsRoot, 'proj-a'), { recursive: true, force: true })
writeLog(path.join('proj-plain', 'session-plain'), 'session.v4.jsonl', [Buffer.from(PLAIN_LINES, 'utf8')])
result = dshUsage.readDshUsage(true)
eq(result.summary.messageCount, 1, '删除部分项目后仍能统计剩余会话')

// ==================== 7. 历史落库 / 合并 / 回放 ====================
console.log('7. 历史落库与合并')
rmSessions()
writeLog(path.join('proj-a', 'session-aaa'), 'session.v4.jsonl.zstd', [FRAME_A])
dshUsage.readDshUsage(true)
const histDoc = savedDocs.get(HISTORY_DOC)
ok(!!histDoc, '每日聚合落库到 ccswitch_agent_usage_dsh_<nativeId>')
eq(Object.keys(histDoc.days), ['2026-01-05'], '只落库有量的日期')
eq(histDoc.days['2026-01-05'].tokens, 1070, '落库当天 tokens')
eq(histDoc.days['2026-01-05'].inputTokens, 1050, '落库当天输入（含缓存）')
eq(
  histDoc.days['2026-01-05'].models['deepseek-official/deepseek-flash'],
  { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 50 },
  '落库保留模型缓存明细（供「通用」统计页重算）',
)

// 「通用」统计页（readAllAgentUsage）把 DSH 一起合并
const commonUsage = require('../public/preload/services/usage').readAllAgentUsage()
eq(commonUsage.summary.totalTokens, 1070, '通用统计页纳入 DSH 落库数据')
eq(commonUsage.agents.map((a) => a.agent), ['dsh'], '通用统计页 agent 元信息包含 dsh')
eq(commonUsage.modelStats[0].inputTokens, 1050, '通用统计页模型输入含缓存（与 DSH 页口径一致）')

// 按 agent 分组（热力图 tooltip 数据）：day.agentModels 保留各 agent 归属，与合并后的 day.models 并存
const groupedDay = commonUsage.contributions.find((d) => d.date === '2026-01-05')
eq(Object.keys(groupedDay.agentModels), ['dsh'], '每日贡献带 agent 归属')
eq(groupedDay.agentModels.dsh.tokens, 1070, 'agent 分组保留该 agent 当天 tokens')
eq(groupedDay.agentModels.dsh.models['deepseek-official/deepseek-flash'].cacheReadTokens, 900, 'agent 分组保留模型缓存明细')

// 再塞一个假 claude 落库文档：多 agent 各自一个分组，模型不串组
savedDocs.set('ccswitch_agent_usage_claude_test-native', {
  _id: 'ccswitch_agent_usage_claude_test-native',
  agent: 'claude',
  updatedAt: Date.now(),
  days: {
    '2026-01-05': {
      tokens: 500,
      inputTokens: 450,
      outputTokens: 50,
      models: { 'qwen3.8-max': { inputTokens: 400, outputTokens: 50, cacheReadTokens: 50, cacheCreationTokens: 0 } },
    },
  },
})
const groupedUsage = require('../public/preload/services/usage').readAllAgentUsage()
const bothDay = groupedUsage.contributions.find((d) => d.date === '2026-01-05')
eq(Object.keys(bothDay.agentModels).sort(), ['claude', 'dsh'], '多 agent 各自一个分组')
eq(Object.keys(bothDay.agentModels.claude.models), ['qwen3.8-max'], 'claude 分组只含自己的模型')
eq(Object.keys(bothDay.agentModels.dsh.models), ['deepseek-official/deepseek-flash'], 'dsh 分组只含自己的模型')
eq(Object.keys(bothDay.models).sort(), ['deepseek-official/deepseek-flash', 'qwen3.8-max'], '合并后的 day.models 仍是并集（模型分布卡片用）')
eq(bothDay.tokens, 1570, '当天总量 = 各 agent 之和')

// 会话日志被清理：回放落库历史，统计不归零
rmLogs()
result = dshUsage.readDshUsage(true)
eq(result.summary.totalTokens, 1070, '日志被清理后回放历史档，统计不归零')
eq(result.summary.messageCount, 0, '回放历史时无实时消息数')
eq(result.modelStats[0].name, 'deepseek-official/deepseek-flash', '回放历史时模型分布仍可显示')

// 同一天日志缩水（旧日志被清理 / 压缩）：取历史较大值，不被覆盖
rmLogs()
writeLog(path.join('proj-small', 'session-small'), 'session.v4.jsonl', [Buffer.from(SMALL_SAME_DAY, 'utf8')])
result = dshUsage.readDshUsage(true)
eq(result.summary.totalTokens, 1070, '同一天取较大值：日志缩水后历史不被覆盖')
eq(result.modelStats.length, 1, '模型分布同样取历史档')
eq(result.modelStats[0].name, 'deepseek-official/deepseek-flash', '历史模型名保留（不退化成本次解析的模型）')
eq(result.contributions.find((d) => d.date === '2026-01-05').models['deepseek-official/deepseek-flash'].cacheReadTokens, 900, '历史缓存明细保留')

// 落库写回的是合并后的结果：历史档不会被缩水结果清掉
eq(savedDocs.get(HISTORY_DOC).days['2026-01-05'].tokens, 1070, '落库写回合并结果，历史档不缩水')

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
