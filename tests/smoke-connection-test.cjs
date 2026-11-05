// 通用配置 · 供应商连接测试冒烟测试
// 用本地 HTTP 服务模拟四种 API 协议，断言请求路径 / 鉴权头 / 首字解析 / 错误透传。
const http = require('node:http')
const assert = require('node:assert')

const PROVIDER = {
  name: 'local',
  api: 'openai-completions',
  baseUrl: '',
  apiKey: 'sk-test',
  authHeader: true,
  headers: { 'x-provider': 'local' },
  models: [
    { id: 'm-chat' },
    { id: 'm-resp', api: 'openai-responses' },
    { id: 'm-anth', api: 'anthropic-messages' },
    { id: 'm-gemini', api: 'google-generative-ai' },
    { id: 'm-bad' },
    { id: 'm-unknown', api: 'bogus-api' },
  ],
}

require.cache[require.resolve('../public/preload/services/i18n.js')] = {
  id: 'i18n-stub',
  filename: 'i18n-stub',
  loaded: true,
  exports: { t: (key, params) => `${key}${params ? ' ' + JSON.stringify(params) : ''}` },
}
require.cache[require.resolve('../public/preload/services/common.js')] = {
  id: 'common-stub',
  filename: 'common-stub',
  loaded: true,
  exports: { readCommonProviders: () => ({ providers: [PROVIDER] }) },
}

const connectionTest = require('../public/preload/services/connection-test.js')

const seen = []
const send = (res, body) => {
  if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(body)
}
const sse = (res, payload) => send(res, `data: ${JSON.stringify(payload)}\n\n`)

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    seen.push({ path: req.url, headers: req.headers, body })
    if (body.model === 'm-bad') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key' } }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      sse(res, { choices: [{ delta: { role: 'assistant' } }] })
      setTimeout(() => {
        sse(res, { choices: [{ delta: { content: 'pong' } }] })
        res.end('data: [DONE]\n\n')
      }, 30)
      return
    }
    if (req.url === '/v1/responses') {
      sse(res, { type: 'response.created' })
      setTimeout(() => {
        sse(res, { type: 'response.output_text.delta', delta: 'pong' })
        res.end()
      }, 30)
      return
    }
    if (req.url === '/v1/messages') {
      sse(res, { type: 'message_start' })
      setTimeout(() => {
        sse(res, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'pong' } })
        res.end()
      }, 30)
      return
    }
    if (req.url.startsWith('/v1/models/m-gemini:streamGenerateContent')) {
      sse(res, { candidates: [{ content: { parts: [{ text: 'pong' }] } }] })
      res.end()
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
})

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address()
  PROVIDER.baseUrl = `http://127.0.0.1:${port}/v1`
  try {
    const results = {}
    for (const model of PROVIDER.models) {
      results[model.id] = await connectionTest.testCommonModelConnection('local', model.id)
    }

    assert.strictEqual(results['m-chat'].ok, true, 'chat 应成功')
    assert.ok(results['m-chat'].latencyMs >= 20, `chat 首字延时应包含等待：${results['m-chat'].latencyMs}`)
    assert.strictEqual(results['m-resp'].ok, true, 'responses 应成功')
    assert.strictEqual(results['m-anth'].ok, true, 'anthropic 应成功')
    assert.strictEqual(results['m-gemini'].ok, true, 'google 应成功')
    assert.strictEqual(results['m-bad'].ok, false, '401 应失败')
    assert.match(results['m-bad'].error, /HTTP 401/, '错误应包含状态码')
    assert.match(results['m-bad'].error, /bad key/, '错误应包含上游 message')
    assert.strictEqual(results['m-unknown'].ok, false, '未知协议应失败')
    assert.match(results['m-unknown'].error, /unsupportedApi/, '未知协议应返回明确错误')

    const chat = seen.find((item) => item.path === '/v1/chat/completions' && item.body.model === 'm-chat')
    assert.ok(chat, '应请求 /v1/chat/completions')
    assert.strictEqual(chat.body.stream, true, 'chat 应要求流式')
    assert.strictEqual(chat.headers.authorization, 'Bearer sk-test', 'chat 应带 Bearer')
    assert.strictEqual(chat.headers['x-provider'], 'local', '应带供应商自定义头')

    const anth = seen.find((item) => item.path === '/v1/messages')
    assert.ok(anth, '应请求 /v1/messages')
    assert.strictEqual(anth.headers['x-api-key'], 'sk-test', 'anthropic 应带 x-api-key')
    assert.strictEqual(anth.headers['anthropic-version'], '2023-06-01', 'anthropic 应带版本头')

    const gemini = seen.find((item) => item.path.startsWith('/v1/models/m-gemini:streamGenerateContent'))
    assert.ok(gemini, 'google 应拼出 streamGenerateContent')
    assert.strictEqual(gemini.headers['x-goog-api-key'], 'sk-test', 'google 应带 x-goog-api-key')

    const missing = await connectionTest.testCommonModelConnection('local', 'nope')
    assert.strictEqual(missing.ok, false, '不存在的模型应失败')

    console.log('connection-test smoke: ok')
  } finally {
    server.close()
  }
})
