// 网关映射多模型调配策略冒烟测试：node tests/smoke-autoroute-mapping-strategy-test.cjs（仓库根目录运行）
// 覆盖：旧单模型映射迁移、每行最多 3 个模型、first / failover / random / round-robin 四种策略、
//       /v1/models 同名只返回一次、请求日志记录最终模型。
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
    getNativeId: () => 'mapping-strategy',
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })

// ==================== 上游桩：按请求里的真实模型名返回成功/失败 ====================
const GOOD_MODELS = new Set(['good-a', 'good-b', 'good-c'])
const hits = []
const startUpstream = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let body = {}
        try { body = JSON.parse(raw) } catch (e) { /* ignore */ }
        hits.push(body.model)
        if (!GOOD_MODELS.has(body.model)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'model unavailable' } }))
          return
        }
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(
            'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }) + '\n\n' +
            'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) + '\n\n' +
            'event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n'
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })

const post = (port, payload) =>
  new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload))
    const req = http.request(
      `http://127.0.0.1:${port}/v1/messages`,
      { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: 'Bearer test' } },
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

const request = (model, stream = false) => ({ model, max_tokens: 16, stream, messages: [{ role: 'user', content: 'hi' }] })

const setConfig = (mappings, mode = 'mapping') => {
  const docId = 'ccconfig_autoroute_config_mapping-strategy_utools'
  const prev = store.get(docId)
  store.set(docId, {
    _id: docId,
    ...(prev && prev._rev ? { _rev: prev._rev } : {}),
    data: {
      enabled: true,
      port: global.__port,
      key: 'sk-test',
      mode,
      selection: [],
      mappings,
      mappingSeeded: true,
    },
  })
}

;(async () => {
  const upstream = await startUpstream()
  const upstreamPort = upstream.address().port
  const port = await freePort()
  global.__port = port

  store.set('ccconfig_common_providers', {
    _id: 'ccconfig_common_providers',
    _rev: nextRev(),
    data: {
      providers: [{
        name: 'mock',
        api: 'anthropic-messages',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        apiKey: 'sk-upstream',
        authHeader: true,
        headers: {},
        models: [
          { id: 'bad-1', maxTokens: 1024 },
          { id: 'bad-2', maxTokens: 1024 },
          { id: 'good-a', maxTokens: 1024 },
          { id: 'good-b', maxTokens: 1024 },
          { id: 'good-c', maxTokens: 1024 },
        ],
      }],
    },
  })

  // ---------- 1. 旧单模型映射迁移 ----------
  console.log('旧单模型映射迁移')
  setConfig([{ alias: 'legacy', provider: 'mock', modelId: 'good-a' }])
  let cfg = autoroute.readAutoRouteConfig()
  ok(Array.isArray(cfg.mappings[0].models), '旧行读入后带 models 数组')
  ok(cfg.mappings[0].models.length === 1 && cfg.mappings[0].models[0].modelId === 'good-a', '旧行目标迁移为第一个模型')
  ok(cfg.mappings[0].strategy === 'first', '旧行策略默认 first')

  // ---------- 2. 每行最多三个模型 ----------
  console.log('每行最多三个模型')
  setConfig([{
    alias: 'many',
    models: ['good-a', 'good-b', 'good-c', 'bad-1'].map((modelId) => ({ provider: 'mock', modelId })),
    strategy: 'first',
  }])
  cfg = autoroute.readAutoRouteConfig()
  ok(cfg.mappings[0].models.length === 3, `超过 3 个被截断（实际 ${cfg.mappings[0].models.length}）`)

  await autoroute.startAutoRoute()

  try {
    // ---------- 3. first：只用第一个，失败不切换 ----------
    console.log('first 策略')
    setConfig([{ alias: 'first-only', models: [{ provider: 'mock', modelId: 'bad-1' }, { provider: 'mock', modelId: 'good-a' }], strategy: 'first' }])
    hits.length = 0
    const r1 = await post(port, request('first-only'))
    ok(r1.status === 400, `第一个模型报错时直接失败（实际 ${r1.status}）`)
    ok(JSON.stringify(hits) === JSON.stringify(['bad-1']), `只调用第一个模型（实际 ${JSON.stringify(hits)}）`)

    // ---------- 4. failover：第一个失败自动用下一个 ----------
    console.log('failover 策略')
    setConfig([{ alias: 'failover', models: [{ provider: 'mock', modelId: 'bad-1' }, { provider: 'mock', modelId: 'good-a' }], strategy: 'failover' }])
    hits.length = 0
    const r2 = await post(port, request('failover'))
    const j2 = JSON.parse(r2.body)
    ok(r2.status === 200 && j2.content[0].text === 'ok', `第一个失败后第二个成功（实际 ${r2.status}）`)
    ok(JSON.stringify(hits) === JSON.stringify(['bad-1', 'good-a']), `按顺序尝试到成功（实际 ${JSON.stringify(hits)}）`)
    const log2 = autoroute.getAutoRouteStatus().logs[0]
    ok(log2 && log2.model === 'good-a' && log2.alias === 'failover', `日志记录最终模型与映射名（实际 ${log2 && log2.model}/${log2 && log2.alias}）`)
    ok(log2 && log2.switches === 1, `日志记录切换次数（实际 ${log2 && log2.switches}）`)

    // failover 全部失败：返回最后一个错误
    setConfig([{ alias: 'failover-all-bad', models: [{ provider: 'mock', modelId: 'bad-1' }, { provider: 'mock', modelId: 'bad-2' }], strategy: 'failover' }])
    hits.length = 0
    const r2b = await post(port, request('failover-all-bad'))
    ok(r2b.status === 400, `全部失败时返回错误（实际 ${r2b.status}）`)
    ok(JSON.stringify(hits) === JSON.stringify(['bad-1', 'bad-2']), `全部候选都尝试过（实际 ${JSON.stringify(hits)}）`)

    // ---------- 5. random：每次随机挑一个 ----------
    console.log('random 策略')
    setConfig([{ alias: 'random', models: [{ provider: 'mock', modelId: 'good-a' }, { provider: 'mock', modelId: 'good-b' }], strategy: 'random' }])
    hits.length = 0
    for (let i = 0; i < 30; i++) await post(port, request('random'))
    const randomHits = new Set(hits)
    ok(randomHits.has('good-a') && randomHits.has('good-b'), `两个模型都被随机选中（实际 ${[...randomHits].join(',')}）`)
    ok(hits.length === 30, `每次请求只调用一个模型（实际 ${hits.length}）`)

    // ---------- 6. round-robin：依次轮换 ----------
    console.log('round-robin 策略')
    setConfig([{ alias: 'rr', models: [{ provider: 'mock', modelId: 'good-a' }, { provider: 'mock', modelId: 'good-b' }], strategy: 'round-robin' }])
    hits.length = 0
    for (let i = 0; i < 4; i++) await post(port, request('rr'))
    ok(JSON.stringify(hits) === JSON.stringify(['good-a', 'good-b', 'good-a', 'good-b']), `按顺序轮换（实际 ${JSON.stringify(hits)}）`)

    // ---------- 7. /v1/models 每个映射名只出现一次 ----------
    console.log('/v1/models')
    setConfig([{ alias: 'multi', models: [{ provider: 'mock', modelId: 'good-a' }, { provider: 'mock', modelId: 'good-b' }, { provider: 'mock', modelId: 'good-c' }], strategy: 'failover' }])
    const models = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/v1/models`, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve(JSON.parse(body)))
      }).on('error', reject)
    })
    const multiIds = models.data.filter((m) => m.id === 'multi')
    ok(multiIds.length === 1, `同名多个上游模型只返回一次（实际 ${multiIds.length} 次）`)

    // ---------- 8. 流式 failover：响应头前失败仍可切换 ----------
    console.log('failover 流式')
    setConfig([{ alias: 'stream-failover', models: [{ provider: 'mock', modelId: 'bad-1' }, { provider: 'mock', modelId: 'good-a' }], strategy: 'failover' }])
    hits.length = 0
    const r3 = await post(port, request('stream-failover', true))
    ok(r3.status === 200 && r3.body.includes('message_start'), `流式请求第一个失败后切换到第二个（实际 ${r3.status}）`)
    ok(JSON.stringify(hits) === JSON.stringify(['bad-1', 'good-a']), `流式同样按顺序尝试（实际 ${JSON.stringify(hits)}）`)

    // ---------- 9. 直连模式不受影响 ----------
    console.log('直连模式')
    setConfig([], 'direct')
    const directDoc = store.get('ccconfig_autoroute_config_mapping-strategy_utools')
    directDoc.data.selection = [{ provider: 'mock', modelId: 'good-a' }]
    store.set(directDoc._id, directDoc)
    const r4 = await post(port, request('good-a'))
    ok(r4.status === 200 && JSON.parse(r4.body).model === 'good-a', `直连模式按模型 ID 调用（实际 ${r4.status}）`)
  } finally {
    await autoroute.stopAutoRoute()
    await new Promise((r) => upstream.close(r))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
