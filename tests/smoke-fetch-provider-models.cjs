// 模型供应商自动拉取冒烟测试：本地模型服务（127.0.0.1）应被 net-guard 放行。
const http = require('node:http')
const assert = require('node:assert')
const path = require('node:path')

const stub = (relative, exports) => {
  const filename = require.resolve(path.join(__dirname, '..', relative))
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

stub('public/preload/services/i18n.js', { t: (key) => key })
stub('public/preload/services/usage.js', {})
stub('public/preload/services/pi-package-detail.js', {})
stub('public/preload/services/pi-extensions.js', {})

const { fetchProviderModels } = require('../public/preload/services/pi.js')

const seen = []
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers })
  if (req.url === '/models' || req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        {
          id: 'workbuddy/hy4std',
          display_name: 'Hy4',
          context_length: 960000,
          max_output_tokens: 64000,
          reasoning_levels: ['high'],
        },
        { id: 'workbuddy/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
      ],
    }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
})

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address()
  try {
    const models = await fetchProviderModels(`http://127.0.0.1:${port}`, 'sk-local')
    assert.deepStrictEqual(models.map((m) => m.id), ['workbuddy/hy4std', 'workbuddy/deepseek-v4.1-flash'])
    assert.strictEqual(models[0].name, 'Hy4', '应使用 display_name 作为显示名')
    assert.strictEqual(models[0].contextWindow, 960000, '应解析 context_length')
    assert.strictEqual(models[0].maxTokens, 64000, '应解析 max_output_tokens')
    assert.strictEqual(models[0].reasoning, true, '应识别 reasoning_levels')
    assert.strictEqual(seen[0].url, '/models', '应先尝试 /models')
    assert.strictEqual(seen[0].headers.authorization, 'Bearer sk-local', '应带 Bearer')
    assert.strictEqual(seen[0].headers['x-api-key'], 'sk-local', '应带 x-api-key')
    console.log('fetch-provider-models smoke: ok')
  } finally {
    server.close()
  }
})
