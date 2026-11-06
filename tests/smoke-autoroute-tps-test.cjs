// 网关实时 TPS 集成测试：启动真实网关与可控 SSE 上游，验证
//   1. 流式 chunk 到达时 getAutoRouteStatus().stats.outputTps 实时增长；
//   2. 同协议直通与跨协议转换两条路径都能采样；
//   3. 流停止、网关停止后速率归零；
//   4. usage 仍只记录上游最终值，不把 UI 估算写回历史统计。
const http = require('node:http')
const net = require('node:net')

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
    getNativeId: () => 'tps-smoke',
    getPath: () => require('node:os').homedir(),
  },
}

const autoroute = require('../public/preload/services/autoroute')

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})

const profile = 'tps-smoke'
const gatewayKey = 'sk-gateway-smoke'
const configure = (port, upstreamPort, api) => {
  store.set('ccconfig_common_providers', {
    _id: 'ccconfig_common_providers',
    _rev: nextRev(),
    data: {
      providers: [{
        name: 'mock', api, baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'sk-upstream', authHeader: true, headers: {},
        models: [{ id: 'm1', maxTokens: 1024 }],
      }],
    },
  })
  store.set(`ccconfig_autoroute_config_${profile}`, {
    _id: `ccconfig_autoroute_config_${profile}`,
    _rev: nextRev(),
    data: {
      enabled: true, port, key: gatewayKey, mode: 'direct', mappingSeeded: true,
      selection: [{ provider: 'mock', modelId: 'm1' }], mappings: [],
    },
  })
}

const post = (port, path, payload, during) => new Promise((resolve, reject) => {
  const body = Buffer.from(JSON.stringify(payload))
  const req = http.request(
    `http://127.0.0.1:${port}${path}`,
    {
      method: 'POST', agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        authorization: `Bearer ${gatewayKey}`,
      },
    },
    (res) => {
      let data = ''
      let peakTps = 0
      res.on('data', (chunk) => {
        data += chunk
        peakTps = Math.max(peakTps, Number(autoroute.getAutoRouteStatus().stats.outputTps || 0))
        if (typeof during === 'function') during(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode, body: data, peakTps }))
      res.on('error', reject)
    },
  )
  req.on('error', reject)
  req.end(body)
})

const anthropicEvents = () => [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm1', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abcdefghijklmnop' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

const chatEvents = () => [
  { id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'm1', choices: [{ index: 0, delta: { role: 'assistant', content: 'abcdefghijklmnop' }, finish_reason: null }] },
  { id: 'chatcmpl_1', object: 'chat.completion.chunk', model: 'm1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } },
].map((data) => `data: ${JSON.stringify(data)}\n\n`).concat('data: [DONE]\n\n')

const startUpstream = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const isChat = String(req.url || '').includes('/chat/completions')
      const events = isChat ? chatEvents() : anthropicEvents()
      // 拉开分片间隔，让测试能观察到「流仍活跃」时的实时值；真实上游也是逐 token 下发。
      for (const event of events) {
        res.write(event)
        await sleep(40)
      }
      res.end()
    })
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

;(async () => {
  const upstream = await startUpstream()
  const upstreamPort = upstream.address().port
  const port = await freePort()

  console.log('同协议直通 · Anthropic SSE')
  configure(port, upstreamPort, 'anthropic-messages')
  await autoroute.startAutoRoute()
  const response = await post(port, '/v1/messages', {
    model: 'm1', max_tokens: 32, stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  ok(response.status === 200 && response.body.includes('message_stop'), '流式响应完整')
  const status = autoroute.getAutoRouteStatus()
  ok(response.peakTps > 0, `直通流式期间采样到 TPS（${response.peakTps}）`)
  ok(status.stats.activeStreams === 0, '流结束后在途流计数归零')
  ok(status.stats.outputTokens === 4 && status.history.today.outputTokens === 4, 'usage 仍使用上游最终 output_tokens=4')
  await sleep(1100)
  ok(autoroute.getAutoRouteStatus().stats.outputTps === 0, '流结束且超出窗口后 TPS 归零')

  console.log('跨协议转换 · Anthropic 入站 → OpenAI Chat 上游')
  await autoroute.stopAutoRoute()
  configure(port, upstreamPort, 'openai-completions')
  await autoroute.startAutoRoute()
  const converted = await post(port, '/v1/messages', {
    model: 'm1', max_tokens: 32, stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  ok(converted.status === 200 && converted.body.includes('event: message_stop'), '转换后的流式响应完整')
  const convertedStatus = autoroute.getAutoRouteStatus()
  ok(converted.peakTps > 0, `转换路径采样到 TPS（${converted.peakTps}）`)
  ok(convertedStatus.stats.outputTokens === 4, '转换路径仍使用上游最终 usage')

  await autoroute.stopAutoRoute()
  ok(autoroute.getAutoRouteStatus().stats.outputTps === 0, '停止网关后 TPS 归零')

  await new Promise((resolve) => upstream.close(resolve))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(async (error) => {
  console.error(error)
  try { await autoroute.stopAutoRoute() } catch (e) { /* ignore */ }
  process.exit(1)
})
