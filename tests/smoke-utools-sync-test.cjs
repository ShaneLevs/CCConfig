// utools-sync.js 冒烟测试：node tests/smoke-utools-sync-test.cjs（仓库根目录运行）
// 验证可移植文档与 uTools DB 的双向镜像、三向合并与删除传播。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-utools-sync-'))
process.env.CCCONFIG_DATA_DIR = DATA_DIR
delete process.env.CCCONFIG_LOCALE

// uTools 宿主 DB（内存模拟，带 _rev 语义与云同步状态）
const hostStore = new Map()
let hostRev = 0
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const hostDb = {
  get: (id) => (hostStore.has(String(id)) ? clone(hostStore.get(String(id))) : null),
  put: (doc) => {
    if (!doc || !doc._id) return { error: true, name: 'bad_request' }
    const cur = hostStore.get(doc._id)
    if (cur && cur._rev && doc._rev !== cur._rev) return { error: true, name: doc._rev ? 'conflict' : 'missing_rev' }
    const stored = clone(doc)
    stored._rev = `${cur ? 2 : 1}-${++hostRev}`
    hostStore.set(doc._id, stored)
    return { ok: true, id: doc._id, rev: stored._rev }
  },
  remove: (idOrDoc, maybeRev) => {
    const id = typeof idOrDoc === 'object' ? idOrDoc._id : idOrDoc
    const rev = typeof idOrDoc === 'object' ? idOrDoc._rev : maybeRev
    const cur = hostStore.get(String(id))
    if (!cur) return { error: true, name: 'not_found' }
    if (rev && cur._rev !== rev) return { error: true, name: 'conflict' }
    hostStore.delete(String(id))
    return { ok: true, id: String(id) }
  },
  allDocs: () => [...hostStore.values()].map(clone),
  replicateStateFromCloud: () => 0,
}
global.window = {
  utools: { db: hostDb, getNativeId: () => 'host-test' },
}

const localDb = require('../public/preload/services/local-db')
const utoolsSync = require('../public/preload/services/utools-sync')
const SHARED_ID = localDb.getNativeId()
const machineId = `ccconfig_agent_usage_claude_${SHARED_ID}`

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)

// ==================== 首次同步：本地较新 → 推到宿主 ====================
localDb.putForce({ _id: 'ccconfig_config_seed', name: 'local-newer', updatedAt: 100 })
hostStore.set('ccconfig_config_seed', { _id: 'ccconfig_config_seed', name: 'host-older', updatedAt: 50, _rev: '1-seed' })
utoolsSync.start()
eq(hostStore.get('ccconfig_config_seed')?.name, 'local-newer', '首次同步本地较新时推到 uTools DB')

// ==================== 写钩子：可移植写入即时镜像 ====================
localDb.put({ _id: 'ccconfig_config_mirror', name: 'mirror', updatedAt: 300 })
ok(hostStore.has('ccconfig_config_mirror'), '可移植文档写入即时镜像到 uTools DB')
localDb.remove('ccconfig_config_mirror')
ok(!hostStore.has('ccconfig_config_mirror'), '可移植文档删除即时从 uTools DB 移除')

// ==================== 机器档不镜像 ====================
localDb.put({ _id: machineId, agent: 'claude', days: {}, updatedAt: 400 })
ok(!hostStore.has(machineId), '机器档（统计）不写入 uTools DB')

// ==================== 宿主新增 → 拉到本地 ====================
hostDb.put({ _id: 'ccconfig_config_from_cloud', name: 'cloud', updatedAt: 500 })
utoolsSync.syncNow()
eq(localDb.get('ccconfig_config_from_cloud')?.name, 'cloud', 'uTools DB 新增可移植文档会拉到本地')

// ==================== 宿主删除 → 本地删除 ====================
hostDb.put({ _id: 'ccconfig_config_host_del', name: 'to-delete', updatedAt: 600 })
utoolsSync.syncNow()
ok(!!localDb.get('ccconfig_config_host_del'), '同步后本地存在待删除文档')
hostDb.remove('ccconfig_config_host_del', hostStore.get('ccconfig_config_host_del')._rev)
utoolsSync.syncNow()
eq(localDb.get('ccconfig_config_host_del'), null, 'uTools DB 删除后本地同步删除')

// ==================== 本地删除（uTools 未运行时的桌面修改）→ 宿主删除 ====================
localDb.setWriteHook(null)
localDb.putForce({ _id: 'ccconfig_config_local_del', name: 'desktop-delete', updatedAt: 700 })
hostDb.put({ _id: 'ccconfig_config_local_del', name: 'desktop-delete', updatedAt: 700 })
utoolsSync.start()
ok(!!hostStore.get('ccconfig_config_local_del'), '同步后宿主存在待删除文档')
localDb.setWriteHook(null)
localDb.remove('ccconfig_config_local_del')
ok(!!hostStore.get('ccconfig_config_local_del'), '无钩子时本地删除不会立即改宿主')
utoolsSync.start()
eq(hostStore.get('ccconfig_config_local_del'), undefined, '本地删除在下一次同步传播到 uTools DB')

// ==================== 两边都改：updatedAt 新的赢 ====================
localDb.setWriteHook(null)
localDb.putForce({ _id: 'ccconfig_config_conflict', name: 'local', updatedAt: 800 })
hostDb.put({ _id: 'ccconfig_config_conflict', name: 'host', updatedAt: 900 })
utoolsSync.start()
eq(localDb.get('ccconfig_config_conflict')?.name, 'host', '冲突时较新的云端值合并到本地')

// ==================== 桌面端守卫 ====================
globalThis.__CCCONFIG_DESKTOP__ = true
localDb.setWriteHook(null)
ok(utoolsSync.start() === false, '桌面端 start 直接返回 false')
localDb.put({ _id: 'ccconfig_config_desktop_only', name: 'desktop', updatedAt: 1000 })
ok(!hostStore.has('ccconfig_config_desktop_only'), '桌面端不安装镜像钩子')
delete globalThis.__CCCONFIG_DESKTOP__

// ==================== 云端拉取期间只拉不推，完成后补跑 ====================
;(async () => {
  globalThis.__CCCONFIG_DESKTOP__ = false
  let cloudStatus = 1
  hostDb.replicateStateFromCloud = () => cloudStatus

  localDb.setWriteHook(null)
  localDb.putForce({ _id: 'ccconfig_config_cloud_pending', name: 'local-only', updatedAt: 1200 })
  let reimported = false
  utoolsSync.start({ cloudPending: true, reimport: () => { reimported = true } })
  ok(!hostStore.has('ccconfig_config_cloud_pending'), '云端拉取中不把本地文档推到宿主')
  ok(reimported === false, '云端拉取中不执行强制重导')

  cloudStatus = 0
  await new Promise((resolve) => setTimeout(resolve, 700))
  ok(hostStore.has('ccconfig_config_cloud_pending'), '云端拉取完成后补推本地文档')
  ok(reimported === true, '云端拉取完成后执行强制重导')

  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()

