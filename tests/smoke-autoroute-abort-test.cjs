// autoroute.js 连接生命周期冒烟测试：node tests/smoke-autoroute-abort-test.cjs（仓库根目录运行）
// 验证「网关长跑不漏连接」：
//   1. 上游卡死（收下请求但永不响应）+ 客户端取消 → 上游 socket 立即释放，日志记 499
//   2. 取消后不重试（每条请求只打一次上游）
//   3. stopAutoRoute 后没有残留的入站/出站连接
// 回归背景：此前 forwardUpstream 没有超时、客户端断开的处理只写在拿到上游响应之后，
// 上游卡死时每条被取消的请求都会漏一个 socket，且停网关也清不掉。
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 取一个空闲端口给网关（先监听 0 拿到端口再释放）
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => resolve(port))
    })
  })

const GATEWAY_KEY = 'sk-ccr-smoke'

const configure = (port, upstreamPort) => {
  store.set('ccconfig_common_providers', {
    _id: 'ccconfig_common_providers',
    _rev: nextRev(),
    data: {
      providers: [
        {
          name: 'mock', api: 'anthropic-messages',
          baseUrl: `http://127.0.0.1:${upstreamPort}`,
          apiKey: 'sk-upstream', authHeader: true, headers: {},
          models: [{ id: 'm1', maxTokens: 1024 }],
        },
      ],
    },
  })
  store.set('ccconfig_autoroute_config_smoketest', {
    _id: 'ccconfig_autoroute_config_smoketest',
    _rev: nextRev(),
    data: {
      enabled: true, port, key: GATEWAY_KEY, mode: 'direct',
      selection: [{ provider: 'mock', modelId: 'm1' }], mappings: [], mappingSeeded: true,
    },
  })
}

// 发一次非流式请求；abortAfterMs > 0 时到点主动断开（模拟 agent 取消）
const request = (port, abortAfterMs = 0) =>
  new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({
      model: 'm1', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }],
    }))
    const req = http.request(
      `http://127.0.0.1:${port}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          authorization: `Bearer ${GATEWAY_KEY}`,
        },
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
        res.on('error', () => resolve({ aborted: true }))
      }
    )
    req.on('error', () => resolve({ aborted: true }))
    req.write(payload)
    req.end()
    if (abortAfterMs > 0) setTimeout(() => { req.destroy(); resolve({ aborted: true }) }, abortAfterMs)
  })

const countSockets = () => process._getActiveHandles().filter((h) => h.constructor && h.constructor.name === 'Socket').length

;(async () => {
  // ---------- 1. 上游卡死 + 客户端取消：不漏 socket ----------
  console.log('上游卡死 + 客户端取消')
  const sockets = new Set()
  let upstreamHits = 0
  const stuck = net.createServer((sock) => {
    upstreamHits += 1
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    sock.on('data', () => {}) // 收下请求，永不响应
  })
  await new Promise((r) => stuck.listen(0, '127.0.0.1', r))

  const port = await freePort()
  configure(port, stuck.address().port)
  await autoroute.startAutoRoute()

  const N = 10
  for (let i = 0; i < N; i++) {
    await request(port, 30)
    await sleep(10)
  }
  await sleep(400) // 等取消传播到上游
  ok(sockets.size === 0, `取消后上游 socket 全部释放（仍连着 ${sockets.size} 个）`)
  ok(upstreamHits === N, `取消不触发重试（上游命中 ${upstreamHits} 次 / 请求 ${N} 次）`)
  const logs = autoroute.getAutoRouteStatus().logs
  ok(logs.length > 0 && logs.every((l) => l.status === 499), `请求日志记为 499（${logs.map((l) => l.status).join(',')}）`)
  ok(autoroute.getAutoRouteStatus().stats.successes === 0, '取消的请求不计入成功数')

  // ---------- 2. 停网关：不残留连接 ----------
  console.log('停止网关')
  await autoroute.stopAutoRoute()
  await sleep(200)
  ok(sockets.size === 0, `停止后上游 socket 为 0（${sockets.size}）`)
  ok(countSockets() <= 2, `进程内残留 socket 只剩测试自身的（${countSockets()}）`)

  for (const s of sockets) s.destroy()
  await new Promise((r) => stuck.close(r))

  // ---------- 3. 正常请求仍然成功（没有被守卫误伤） ----------
  console.log('正常请求')
  const healthy = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'm1',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }))
    })
  })
  await new Promise((r) => healthy.listen(0, '127.0.0.1', r))
  const port2 = await freePort()
  configure(port2, healthy.address().port)
  await autoroute.startAutoRoute()
  const res = await request(port2)
  ok(res.status === 200, `正常请求返回 200（实际 ${res.status}）`)
  ok(autoroute.getAutoRouteStatus().stats.successes === 1, '正常请求计入成功数')
  await autoroute.stopAutoRoute()
  await new Promise((r) => healthy.close(r))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
