// 网关端口配置隔离 + 端口占用重试冒烟测试：
//   node tests/smoke-autoroute-port-test.cjs（仓库根目录运行）
// 回归背景：
//   1. 桌面版与 uTools 版同机运行时共用一份网关配置（同一 nativeId），改端口会互相覆盖；
//   2. 更新 / 重装后旧 sidecar 还占着端口，新实例只 bind 一次，EADDRINUSE 后网关一直停着，
//      必须手动「重启网关」才能恢复。
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
        if (cur && cur._rev && doc._rev !== cur._rev) return { error: true, name: 'conflict', message: 'conflict' }
        const r = nextRev()
        store.set(doc._id, { ...JSON.parse(JSON.stringify(doc)), _rev: r })
        return { ok: true, id: doc._id, rev: r }
      },
    },
    getNativeId: () => 'port-smoke',
    getPath: () => require('node:os').homedir(),
  },
}

const autoroute = require('../public/preload/services/autoroute')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.error(`  ✗ ${name}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const port = s.address().port
    s.close(() => resolve(port))
  })
})

const LEGACY_MACHINE = 'ccconfig_autoroute_config_port-smoke'

;(async () => {
  // ---------- 1. 旧机器档迁移：两种运行形态各自独立 ----------
  console.log('配置按运行形态隔离')
  store.set(LEGACY_MACHINE, {
    _id: LEGACY_MACHINE,
    _rev: nextRev(),
    data: {
      enabled: false, port: 19001, key: 'sk-legacy', mode: 'direct',
      selection: [], mappings: [], mappingSeeded: true,
    },
  })

  const utoolsConfig = autoroute.readAutoRouteConfig()
  ok(utoolsConfig.port === 19001, `uTools 首次读取继承旧机器档端口（${utoolsConfig.port}）`)
  ok(store.has('ccconfig_autoroute_config_port-smoke_utools'), 'uTools 写入自己的配置档')

  globalThis.__CCCONFIG_DESKTOP__ = true
  const desktopConfig = autoroute.readAutoRouteConfig()
  ok(desktopConfig.port === 19001, `桌面版首次读取同样继承旧机器档端口（${desktopConfig.port}）`)
  autoroute.writeAutoRouteConfig({ port: 19002 })
  ok(store.has('ccconfig_autoroute_config_port-smoke_desktop'), '桌面版写入自己的配置档')

  delete globalThis.__CCCONFIG_DESKTOP__
  ok(autoroute.readAutoRouteConfig().port === 19001, '桌面版改端口不影响 uTools')

  globalThis.__CCCONFIG_DESKTOP__ = true
  ok(autoroute.readAutoRouteConfig().port === 19002, '桌面版保留自己的端口')
  delete globalThis.__CCCONFIG_DESKTOP__

  // ---------- 2. 端口暂时被旧进程占用：等待释放后自动接管 ----------
  console.log('端口占用重试')
  const port = await freePort()
  const blocker = net.createServer()
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r))

  autoroute.writeAutoRouteConfig({
    enabled: true, port, key: 'sk-port-smoke', mode: 'direct',
    selection: [], mappings: [], mappingSeeded: true,
  })

  const starting = autoroute.startAutoRoute()
  await sleep(900) // 落在第一次 / 第二次退避之间
  ok(!autoroute.getAutoRouteStatus().running, '占用期间网关不会误报 running')
  await new Promise((r) => blocker.close(r))
  const status = await starting
  ok(status.running && status.port === port, `端口释放后自动设为运行中（${status.port}）`)

  await autoroute.stopAutoRoute()
  ok(!autoroute.getAutoRouteStatus().running, '停止后状态回到 stopped')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
