// 网关 key 持久化测试：旧配置缺 key 时首次读取必须生成并写回，后续读取保持同一 key。
const store = new Map()
let rev = 0

global.window = {
  utools: {
    db: {
      get: (id) => {
        const doc = store.get(String(id))
        return doc ? JSON.parse(JSON.stringify(doc)) : null
      },
      put: (doc) => {
        const cur = store.get(doc._id)
        if (cur && cur._rev && doc._rev !== cur._rev) return { error: true, name: 'conflict' }
        store.set(doc._id, { ...JSON.parse(JSON.stringify(doc)), _rev: `${++rev}-test` })
        return { ok: true }
      },
    },
    getNativeId: () => 'gateway-key-test',
    getPath: () => require('node:os').homedir(),
  },
}

const autoroute = require('../public/preload/services/autoroute')

const first = autoroute.readAutoRouteConfig()
const second = autoroute.readAutoRouteConfig()
const docId = 'ccconfig_autoroute_config_gateway-key-test_utools'
const saved = store.get(docId)

const checks = [
  [typeof first.key === 'string' && first.key.startsWith('sk-ccr-'), '首次读取生成随机 key'],
  [first.key === second.key, '后续读取 key 保持一致'],
  [saved && saved.data && saved.data.key === first.key, 'key 已写回配置档'],
]
let failed = 0
for (const [ok, name] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
if (failed) process.exit(1)
