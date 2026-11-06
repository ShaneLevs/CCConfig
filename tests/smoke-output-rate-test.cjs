// 网关实时输出速率冒烟测试：验证三类上游 SSE 的增量估算、跨分片采样与滑动窗口。
// 实时 TPS 只供 UI 展示，usage 仍由上游最终值记账。
const {
  estimateTokenCount,
  outputTokenDeltaFromCanonical,
  outputTokenDeltaFromSseData,
  createSseOutputTokenProbe,
  createOutputRateMeter,
} = require('../public/preload/services/output-rate')

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const near = (actual, expected, epsilon = 0.001) => Math.abs(actual - expected) <= epsilon

console.log('token 估算')
ok(near(estimateTokenCount('abcdefgh'), 2), 'ASCII 约 4 字符 / token')
ok(near(estimateTokenCount('你好😀'), 3), 'CJK 与 emoji 按宽字符估算')
ok(near(estimateTokenCount('中文abcd'), 3), '中英混合分别累计')
ok(estimateTokenCount('') === 0 && estimateTokenCount(null) === 0, '空值不计 token')

console.log('三种协议增量')
ok(near(outputTokenDeltaFromCanonical({ type: 'text_delta', delta: 'abcdefgh' }), 2), 'canonical 文本增量')
ok(outputTokenDeltaFromCanonical({ type: 'start', model: 'm' }) === 0, '控制事件不计入')
ok(near(outputTokenDeltaFromSseData({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考' } }), 2), 'Anthropic 推理增量')
ok(near(outputTokenDeltaFromSseData({ choices: [{ delta: { content: 'hello world!' } }] }), 3), 'OpenAI Chat 文本增量')
ok(near(outputTokenDeltaFromSseData({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"a":1}' } }] } }] }), 1.75), 'OpenAI Chat 工具参数增量')
ok(near(outputTokenDeltaFromSseData({ type: 'response.output_text.delta', delta: '测试文本' }), 4), 'Responses 文本增量')
ok(outputTokenDeltaFromSseData({ type: 'response.function_call_arguments.delta', delta: 'abcdefgh' }) === 2, 'Responses 工具参数增量')

console.log('原始 SSE 跨分片')
const observed = []
const probe = createSseOutputTokenProbe((tokens) => observed.push(tokens))
const payload = JSON.stringify({ choices: [{ delta: { content: 'abcdefgh' } }] })
const firstHalf = payload.slice(0, 20)
probe.push(`event: message\r\ndata: ${firstHalf}\r\n`)
probe.push(`data: ${payload.slice(20)}\r\n\r\n`)
ok(observed.length === 1 && near(observed[0], 2), '多 data 字段拼接与 CRLF 分片')
probe.push(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '中文' })}\n`)
probe.flush()
ok(observed.length === 2 && observed[1] === 2, '无末尾空行时 flush 仍采样')
probe.flush()
ok(observed.length === 2, '重复 flush 不重复计数')
probe.push(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'after flush' })}\n\n`)
ok(observed.length === 2, 'flush 后不再接收迟到分片')

console.log('滑动窗口与并发聚合')
const meter = createOutputRateMeter()
meter.record(10, 1000)
meter.record(6, 1200) // 200ms 最短跨度 → 80 tps，避免首个分片虚高
ok(near(meter.rate(1200), 80), '短跨度使用 200ms 下限')
ok(near(meter.rate(1500), 80), '短跨度按首尾样本间隔计算')
meter.record(8, 1600) // 仍按首尾 600ms 算 → 40 tps
ok(near(meter.rate(1600), 40), '并发流共享采样并聚合')
meter.record(4, 2300) // 最新样本仍离首样本 1.3s，窗口内剩 18 token
ok(near(meter.rate(2300), 120 / 7), '一至两秒跨度按窗口内总 token 计算')
ok(near(meter.rate(3401), 120 / 7), '窗口滑出后仍保留最后采样结果')
ok(near(meter.rate(4500), 120 / 7), '活跃流停顿时保留最后一次速率')
meter.record(4, 4000)
meter.record(4, 5500) // 新 chunk 距离旧样本超过窗口，保留旧瞬时值作衰减起点
ok(near(meter.rate(5500), 20), '长流恢复输出时从旧瞬时值继续采样')
meter.reset()
ok(meter.rate(4000) === 0, '网关重启清零')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
