// 共享本地库端到端冒烟测试：node tests/smoke-shared-db-test.cjs（仓库根目录运行）
// 模拟 uTools 装载 preload 的完整入口 services.js，验证：
//   1. uTools 旧宿主 DB 自动导入 ~/.ccconfig/db，文档 ID 换成共享 nativeId
//   2. 之后所有 service 读写都走共享库（写入能落盘，宿主旧库不再变化）
//   3. 语言等按机器隔离的文档在 import 后能被 i18n 首帧读到
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-shared-home-'))
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-shared-data-'))
process.env.CCCONFIG_DATA_DIR = DATA
delete process.env.CCCONFIG_LOCALE

const HOST_ID = 'utools-host-native-id-abcdef'

// uTools 宿主 DB（内存模拟）；desktop sidecar 不会走到这里
const hostStore = new Map()
const hostDoc = (id, fields) => ({ ...fields, _id: id, _rev: '1-host' })
hostStore.set(
  `ccconfig_locale_${HOST_ID}`,
  hostDoc(`ccconfig_locale_${HOST_ID}`, { locale: 'en-US' }),
)
hostStore.set(
  'ccconfig_common_providers',
  hostDoc('ccconfig_common_providers', {
    data: { providers: [{ name: 'P1', apiKey: '', baseUrl: 'https://x', api: 'openai-completions', models: [] }] },
    updatedAt: 1,
  }),
)
// 改名前的旧前缀 + 宿主 nativeId：导入后应同时完成 ID 后缀重写与前缀迁移
hostStore.set(
  `ccswitch_config_legacy_${HOST_ID}`,
  hostDoc(`ccswitch_config_legacy_${HOST_ID}`, { name: '旧前缀配置', key: '', baseUrl: '', updatedAt: 2 }),
)
const hostCalls = { put: 0, remove: 0 }
global.window = {
  utools: {
    getPath: () => HOME,
    getNativeId: () => HOST_ID,
    shellOpenPath() {},
    shellOpenExternal() {},
    copyText() {},
    showOpenDialog: () => null,
    setFeature() {},
    removeFeature() {},
    getFeatures: () => [],
    onPluginEnter() {},
    onPluginOut() {},
    db: {
      get: (id) => hostStore.get(id) || null,
      put: (doc) => { hostCalls.put += 1; hostStore.set(doc._id, doc); return { ok: true } },
      remove: (id) => { hostCalls.remove += 1; hostStore.delete(id); return { ok: true } },
      allDocs: () => Array.from(hostStore.values()),
    },
  },
}

require('../public/preload/services.js')
const localDb = require('../public/preload/services/local-db')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)

const sharedId = localDb.getNativeId()
const dbFiles = () => {
  try { return fs.readdirSync(path.join(DATA, 'db')).filter((f) => f.endsWith('.json')) }
  catch (e) { return [] }
}

ok(!!window.ccconfigDb, 'preload 向渲染层暴露 window.ccconfigDb')
eq(window.services.getNativeId(), sharedId, 'window.services.getNativeId 返回共享设备 ID')
ok(/^[0-9a-f]{32}$/.test(sharedId), '共享设备 ID 为 32 位哈希')

eq(window.services.getLocale(), 'en-US', '宿主语言文档导入后 i18n 首帧读到')
eq(window.services.getCommonProviderList().map((p) => p.name), ['P1'], '宿主供应商主数据导入后可读')
ok(
  localDb.get(`ccconfig_config_legacy_${sharedId}`)?.name === '旧前缀配置',
  '旧前缀文档完成宿主 ID 重写与 ccswitch → ccconfig 迁移',
)

const beforeFiles = dbFiles().length
const hostPutsBefore = hostCalls.put
window.services.saveOverriddenEnv({ FOO: 'bar' })
eq(window.services.getOverriddenEnv(), { FOO: 'bar' }, 'service 写入共享库后可读回')
ok(dbFiles().length >= beforeFiles, '共享库文档文件已落盘')
eq(hostCalls.put, hostPutsBefore, '机器档写入不回写 uTools 宿主 DB')
eq(hostCalls.remove, 0, '运行期不删 uTools 宿主 DB')

// 可移植文档（通用供应商）写入应镜像到 uTools DB，供 uTools 云同步
const providersDoc = window.ccconfigDb.get('ccconfig_common_providers')
ok(!!providersDoc?._rev, '通用供应商文档已从宿主导入')
const putsBeforePortable = hostCalls.put
window.ccconfigDb.put({
  ...providersDoc,
  data: { providers: [...providersDoc.data.providers, { name: 'P2', apiKey: '', baseUrl: '', api: 'openai-completions', models: [] }] },
  updatedAt: Date.now(),
})
ok(hostCalls.put > putsBeforePortable, '可移植文档写入镜像到 uTools 宿主 DB')
const mirrored = hostStore.get('ccconfig_common_providers')
ok(
  mirrored && mirrored.data.providers.some((p) => p.name === 'P2'),
  'uTools 宿主 DB 中能看到新供应商',
)
ok(hostStore.has(`ccconfig_locale_${HOST_ID}`), '宿主旧库文档保留')
ok(hostStore.has('ccconfig_common_providers'), '宿主共享档保留')

// 导入标记：再次装载 preload 不应该重复导入
const marker = localDb.get('ccconfig_utools_import_v1')
eq(marker?.sourceNativeId, HOST_ID, '导入标记记录宿主 nativeId')
eq(marker?.sharedNativeId, sharedId, '导入标记记录共享 nativeId')

fs.rmSync(HOME, { recursive: true, force: true })
fs.rmSync(DATA, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
