// 映射模式响应 model 改写冒烟测试：node tests/smoke-autoroute-model-alias-test.cjs（仓库根目录运行）
// 背景：网关只在「请求」方向把映射名换成真实模型 ID，上游返回的 model 仍是真名；agent 会把响应 model
// 记进自己的会话记录（Claude Code 的 assistant.message.model、Grok Build 的 usage.json），各应用
// 的使用统计读的就是这些记录 → 统计里显示上游真名而不是映射名。autoroute-convert/model-alias.js
// 负责把响应 model 改写成映射名，本测试覆盖它的四条出站路径与开关：
//   1. 同协议透传 · 非流式（顶层 model）
//   2. 同协议透传 · 流式 SSE（message.model / chunk.model，按行缓冲，正文里的 "model" 字样不得被改）
//   3. 跨协议转换 · 非流式与流式（formatResponse 顶层 model / pipeStream 的 modelOverride）
//   4. rewriteModel=false 时恢复上游真实模型名
//   5. 改写不影响 usage 统计（token 仍记账）
const http = require('node:http')
const net = require('node:net')

// ==================== 最小 uTools 环境 ====================
const store = new Map()
let rev = 0
const nextRev = () => `${++rev}-fake`

global.window = {
  utools: {
    db: {
      get: (id) => {
        const d = store.get(String(id))
        return d ? JSON.parse(JSON.stringify(d)) : null
      },
      put: (doc) => {
        if (!doc || !doc._id) return { error: true, message: 'bad doc' }
        const cur = store.get(doc._id)
        if (cur && cur._rev && doc._rev !== cur._rev) return { error: true, message: 'conflict' }
        const r = nextRev()
        store.set(doc._id, { ...JSON.parse(JSON.stringify(doc)), _rev: r })
        return { ok: true, id: doc._id, rev: r }
      },
    },
    getNativeId: () => 'smoketest',
    getPath: () => require('node:os').homedir(),
  },
}

const autoroute = require('../public/preload/services/autoroute')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })

// ==================== 上游桩 ====================
// 同一台上游同时提供 anthropic /v1/messages 与 openai /v1/chat/completions，
// 用来分别覆盖「同协议透传」与「跨协议转换」。响应里的 model 固定为 m1（真实模型名），
// 正文里故意塞一段 {"model":"decoy"}，验证改写只动结构化位置。
const REAL_MODEL = 'm1'
const DECOY = 'see {"model":"decoy"} inline'
// 中文 / emoji 横跨上游分片时不能被截成 U+FFFD（改写路径自己写字节，不再是 pipe 原样转）
const CJK = '中文与表情 😀 都要完好'

const anthropicBody = () => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: REAL_MODEL,
  content: [{ type: 'text', text: DECOY }], stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
})

const anthropicSse = (text = DECOY) =>
  [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: REAL_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 2 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join('')

const chatBody = () => ({
  id: 'chatcmpl_1', object: 'chat.completion', created: 1, model: REAL_MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: DECOY }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
})

const chatSse = () =>
  [
    `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: REAL_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: DECOY }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: REAL_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')

// OpenAI Responses 形状：model 在 response.model（不在顶层），验证 model-alias.js 的第三个槽位
const responsesBody = () => ({
  id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: REAL_MODEL,
  output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: DECOY, annotations: [] }] }],
  output_text: DECOY,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
})

const responsesSse = () => {
  const base = (status, output) => ({ id: 'resp_1', object: 'response', created_at: 1, model: REAL_MODEL, status, output })
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: base('in_progress', []) })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: DECOY })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { ...base('completed', []), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
  ].join('')
}

const startUpstream = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let body = {}
        try { body = JSON.parse(raw) } catch (e) { /* ignore */ }
        const isChat = (req.url || '').includes('/chat/completions')
        const isResponses = (req.url || '').includes('/responses')
        const stream = body.stream === true
        if (isChat || isResponses) {
          const json = isChat ? chatBody : responsesBody
          const sse = isChat ? chatSse : responsesSse
          if (stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.end(sse())
          } else {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(json()))
          }
          return
        }
        if (stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          if (body.system === 'cjk-split') {
            // 逐 5 字节发：一定会有分片切在多字节字符中间
            const buf = Buffer.from(anthropicSse(CJK), 'utf8')
            for (let i = 0; i < buf.length; i += 5) res.write(buf.subarray(i, i + 5))
            res.end()
            return
          }
          // 故意把 SSE 切成两半发：验证改写器的半行缓冲
          const sse = anthropicSse()
          const cut = Math.floor(sse.length / 2)
          res.write(sse.slice(0, cut))
          res.end(sse.slice(cut))
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(anthropicBody()))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })

// ==================== 网关配置 / 请求 ====================
const GATEWAY_KEY = 'sk-ccr-smoke'
const ALIAS = 'pro'

const configure = (port, upstreamPort, { api, mode, rewriteModel }) => {
  store.set('ccconfig_common_providers', {
    _id: 'ccconfig_common_providers',
    _rev: nextRev(),
    data: {
      providers: [
        {
          name: 'mock', api, baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-upstream', authHeader: true, headers: {},
          models: [{ id: REAL_MODEL, maxTokens: 1024 }],
        },
      ],
    },
  })
  store.set('ccconfig_autoroute_config_smoketest', {
    _id: 'ccconfig_autoroute_config_smoketest',
    _rev: nextRev(),
    data: {
      enabled: true, port, key: GATEWAY_KEY, mode,
      selection: [{ provider: 'mock', modelId: REAL_MODEL }],
      mappings: mode === 'mapping' ? [{ alias: ALIAS, provider: 'mock', modelId: REAL_MODEL }] : [],
      mappingSeeded: true,
      ...(rewriteModel === undefined ? {} : { rewriteModel }),
    },
  })
}

const post = (port, path, payload) =>
  new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload))
    const req = http.request(
      `http://127.0.0.1:${port}${path}`,
      // agent:false：Node ≥19 默认 keep-alive 会复用上一个（已停掉的）网关连接的 socket
      { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${GATEWAY_KEY}` } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
        res.on('error', (e) => resolve({ error: e }))
      }
    )
    req.on('error', (e) => resolve({ error: e }))
    req.end(data)
  })

const anthropicRequest = (model, stream, extra) => ({ model, max_tokens: 32, stream, messages: [{ role: 'user', content: 'hi' }], ...(extra || {}) })
const chatRequest = (model, stream) => ({ model, max_tokens: 32, stream, messages: [{ role: 'user', content: 'hi' }] })

// 从 SSE 文本里取所有 data: 行解析后交给回调
const eachSseEvent = (text, fn) => {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let obj = null
    try { obj = JSON.parse(payload) } catch (e) { continue }
    fn(obj)
  }
}

;(async () => {
  const upstream = await startUpstream()
  const upstreamPort = upstream.address().port
  const port = await freePort()

  // ---------- 1. 同协议透传 · 非流式 ----------
  console.log('同协议透传 · 非流式')
  configure(port, upstreamPort, { api: 'anthropic-messages', mode: 'mapping' })
  await autoroute.startAutoRoute()
  const r1 = await post(port, '/v1/messages', anthropicRequest(ALIAS, false))
  const j1 = JSON.parse(r1.body)
  ok(r1.status === 200, `返回 200（实际 ${r1.status}）`)
  ok(j1.model === ALIAS, `响应 model 改写成映射名（实际 ${j1.model}）`)
  ok(j1.content[0].text === DECOY, '正文里的 "model" 字样原样保留')
  ok(j1.usage.input_tokens === 10 && j1.usage.output_tokens === 5, 'usage 字段未受影响')

  // ---------- 2. 同协议透传 · 流式 ----------
  console.log('同协议透传 · 流式（上游分片切在行中间）')
  const r2 = await post(port, '/v1/messages', anthropicRequest(ALIAS, true))
  let startModel = null
  let decoySeen = false
  let deltaText = ''
  eachSseEvent(r2.body, (evt) => {
    if (evt.type === 'message_start') startModel = evt.message.model
    if (evt.type === 'content_block_delta') deltaText += evt.delta.text || ''
  })
  ok(r2.status === 200, `返回 200（实际 ${r2.status}）`)
  ok(startModel === ALIAS, `message_start 的 model 改写成映射名（实际 ${startModel}）`)
  ok(r2.body.includes('event: message_start') && r2.body.includes('event: message_stop'), 'SSE 事件行完整转发')
  decoySeen = deltaText === DECOY
  ok(decoySeen, `正文 delta 未被改写（实际 ${JSON.stringify(deltaText)}）`)
  const status2 = autoroute.getAutoRouteStatus()
  ok(status2.stats.promptTokens >= 20, `流式 usage 仍记账（promptTokens=${status2.stats.promptTokens}）`)

  // ---------- 2b. 同协议透传 · 流式 · 多字节字符被分片切断 ----------
  console.log('同协议透传 · 流式（上游逐 5 字节切分，必然切断多字节字符）')
  const r2b = await post(port, '/v1/messages', anthropicRequest(ALIAS, true, { system: 'cjk-split' }))
  let cjkModel = null
  let cjkText = ''
  eachSseEvent(r2b.body, (evt) => {
    if (evt.type === 'message_start') cjkModel = evt.message.model
    if (evt.type === 'content_block_delta') cjkText += evt.delta.text || ''
  })
  ok(cjkModel === ALIAS, `message_start model 仍为映射名（实际 ${cjkModel}）`)
  ok(cjkText === CJK, `多字节字符未被切碎（实际 ${JSON.stringify(cjkText)}）`)

  // ---------- 3. 跨协议转换（anthropic 入站 → openai chat 出站）----------
  console.log('跨协议转换')
  await autoroute.stopAutoRoute()
  configure(port, upstreamPort, { api: 'openai-completions', mode: 'mapping' })
  await autoroute.startAutoRoute()
  const r3 = await post(port, '/v1/messages', anthropicRequest(ALIAS, false))
  const j3 = JSON.parse(r3.body)
  ok(j3.type === 'message' && j3.model === ALIAS, `转换后非流式 model = 映射名（实际 ${j3.model}）`)
  ok(j3.content[0].text === DECOY, '转换路径正文原样')
  const r4 = await post(port, '/v1/messages', anthropicRequest(ALIAS, true))
  let convStartModel = null
  eachSseEvent(r4.body, (evt) => {
    if (evt.type === 'message_start') convStartModel = evt.message.model
  })
  ok(convStartModel === ALIAS, `转换后流式 message_start model = 映射名（实际 ${convStartModel}）`)

  // ---------- 4. 入站 chat：顶层 model 改写 ----------
  console.log('入站 OpenAI Chat · 同协议透传')
  await autoroute.stopAutoRoute()
  configure(port, upstreamPort, { api: 'openai-completions', mode: 'mapping' })
  await autoroute.startAutoRoute()
  const r5 = await post(port, '/v1/chat/completions', chatRequest(ALIAS, false))
  const j5 = JSON.parse(r5.body)
  ok(j5.model === ALIAS, `chat 非流式响应 model 改写成映射名（实际 ${j5.model}）`)
  const r6 = await post(port, '/v1/chat/completions', chatRequest(ALIAS, true))
  let chunkModels = new Set()
  eachSseEvent(r6.body, (evt) => { if (evt.model) chunkModels.add(evt.model) })
  ok(chunkModels.size === 1 && chunkModels.has(ALIAS), `chat chunk model 全部改写成映射名（实际 ${[...chunkModels].join(',')}）`)
  ok(r6.body.includes('data: [DONE]'), '[DONE] 终止帧保留')

  // ---------- 4b. 入站 OpenAI Responses：model 在 response.model ----------
  console.log('入站 OpenAI Responses · 同协议透传')
  await autoroute.stopAutoRoute()
  configure(port, upstreamPort, { api: 'openai-responses', mode: 'mapping' })
  await autoroute.startAutoRoute()
  const responsesRequest = (stream) => ({ model: ALIAS, input: 'hi', stream })
  const r10 = await post(port, '/v1/responses', responsesRequest(false))
  const j10 = JSON.parse(r10.body)
  ok(j10.model === ALIAS, `responses 非流式响应 model 改写成映射名（实际 ${j10.model}）`)
  const r11 = await post(port, '/v1/responses', responsesRequest(true))
  const responseModels = new Set()
  let responsesDelta = ''
  eachSseEvent(r11.body, (evt) => {
    if (evt.response && evt.response.model) responseModels.add(evt.response.model)
    if (evt.type === 'response.output_text.delta') responsesDelta += evt.delta || ''
  })
  ok(responseModels.size === 1 && responseModels.has(ALIAS), `responses 事件里的 response.model 全为映射名（实际 ${[...responseModels].join(',')}）`)
  ok(responsesDelta === DECOY, 'responses 正文 delta 未被改写')

  // ---------- 5. rewriteModel=false：恢复上游真实模型名 ----------
  console.log('rewriteModel=false')
  await autoroute.stopAutoRoute()
  configure(port, upstreamPort, { api: 'anthropic-messages', mode: 'mapping', rewriteModel: false })
  await autoroute.startAutoRoute()
  const r7 = await post(port, '/v1/messages', anthropicRequest(ALIAS, false))
  const j7 = JSON.parse(r7.body)
  ok(j7.model === REAL_MODEL, `关掉开关后保留上游真实模型名（实际 ${j7.model}）`)
  const r8 = await post(port, '/v1/messages', anthropicRequest(ALIAS, true))
  let offStartModel = null
  eachSseEvent(r8.body, (evt) => {
    if (evt.type === 'message_start') offStartModel = evt.message.model
  })
  ok(offStartModel === REAL_MODEL, `关掉开关后流式也保留真实模型名（实际 ${offStartModel}）`)

  // ---------- 6. 直连模式不受影响 ----------
  console.log('直连模式')
  await autoroute.stopAutoRoute()
  configure(port, upstreamPort, { api: 'anthropic-messages', mode: 'direct' })
  await autoroute.startAutoRoute()
  const r9 = await post(port, '/v1/messages', anthropicRequest(REAL_MODEL, false))
  ok(JSON.parse(r9.body).model === REAL_MODEL, `直连模式响应 model 不变（实际 ${JSON.parse(r9.body).model}）`)

  await autoroute.stopAutoRoute()
  await new Promise((r) => upstream.close(r))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
