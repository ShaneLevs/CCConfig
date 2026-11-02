// db-import.js 冒烟测试：node tests/smoke-db-import-test.cjs（仓库根目录运行）
// 验证 uTools 旧宿主 DB → ~/.ccconfig 共享库的一次性迁移：
//   1. 旧文档 ID 里的宿主 nativeId 替换为共享 nativeId
//   2. 目标已存在时按 updatedAt 取较新；无时间戳时保留本地
//   3. 设备 ID 文档不导入，宿主旧库不删除
//   4. 标记写入后不重复扫描；桌面端跳过
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-db-import-'))
process.env.CCCONFIG_DATA_DIR = DATA_DIR

const HOST_ID = 'host-native-id-0123456789abcdef'

// 宿主 uTools DB（内存模拟，不删文档）
const hostStore = new Map()
const hostDoc = (id, fields) => ({ ...fields, _id: id, _rev: '1-host' })
global.window = {
  utools: {
    getNativeId: () => HOST_ID,
    db: {
      get: (id) => (hostStore.has(id) ? { ...hostStore.get(id) } : null),
      put: (doc) => { hostStore.set(doc._id, { ...doc }); return { ok: true } },
      remove: () => ({ ok: true }),
      allDocs: () => Array.from(hostStore.values()).map((d) => ({ ...d })),
    },
  },
}

const localDb = require('../public/preload/services/local-db')
const dbImport = require('../public/preload/services/db-import')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)

const SHARED_ID = localDb.getNativeId()
const localId = (suffix) => `${suffix}_${SHARED_ID}`

// 宿主旧库
hostStore.set(`ccconfig_config_${HOST_ID}`, hostDoc(`ccconfig_config_${HOST_ID}`, {
  name: 'uTools 配置', nativeId: HOST_ID, updatedAt: 200,
}))
hostStore.set(`ccconfig_agent_usage_claude_${HOST_ID}`, hostDoc(`ccconfig_agent_usage_claude_${HOST_ID}`, {
  agent: 'claude', nativeId: HOST_ID,
  days: { '2026-01-01': { tokens: 100 }, '2026-01-02': { tokens: 200 } }, updatedAt: 300,
}))
hostStore.set('ccconfig_common_providers', hostDoc('ccconfig_common_providers', { providers: [{ name: 'p1' }] }))
hostStore.set(`ccswitch_config_legacy_${HOST_ID}`, hostDoc(`ccswitch_config_legacy_${HOST_ID}`, { name: '旧前缀', updatedAt: 150 }))
hostStore.set(`ccconfig_locale_${HOST_ID}`, hostDoc(`ccconfig_locale_${HOST_ID}`, { locale: 'en-US' }))
hostStore.set(`ccconfig_dark_background_${HOST_ID}`, hostDoc(`ccconfig_dark_background_${HOST_ID}`, { theme: 'dark', updatedAt: 200 }))
hostStore.set(`ccconfig_stats_unit_${HOST_ID}`, hostDoc(`ccconfig_stats_unit_${HOST_ID}`, { unit: 'cn', updatedAt: 100 }))
hostStore.set('ccswitch_runtime_id', hostDoc('ccswitch_runtime_id', { value: HOST_ID }))

// 本地已有文档：一份较旧（应被覆盖）、一份较新（应保留）、一份无时间戳（应保留）、
// 一份统计档「更新但天数更少」（应补齐 uTools 的天数）
localDb.putForce({ _id: localId('ccconfig_dark_background'), theme: 'light', updatedAt: 100 })
localDb.putForce({ _id: localId('ccconfig_stats_unit'), unit: 'K/M/B', updatedAt: 300 })
localDb.putForce({ _id: localId('ccconfig_locale'), locale: 'zh-CN' })
localDb.putForce({
  _id: localId('ccconfig_agent_usage_claude'), agent: 'claude', nativeId: SHARED_ID,
  days: { '2026-01-01': { tokens: 300 }, '2026-01-03': { tokens: 50 } }, updatedAt: 400,
})

const result = dbImport.importUtoolsData()
ok(result.skipped === false, '首次导入执行')
eq(result.sourceNativeId, HOST_ID, '记录宿主 nativeId')
eq(result.sharedNativeId, SHARED_ID, '使用共享 nativeId')

eq(localDb.get(localId('ccconfig_config'))?.name, 'uTools 配置', '普通文档按共享 ID 导入')
eq(localDb.get(localId('ccconfig_config'))?.nativeId, SHARED_ID, '文档内的宿主 nativeId 字段同步改写')
const mergedClaude = localDb.get(localId('ccconfig_agent_usage_claude'))
eq(mergedClaude?.days['2026-01-01'].tokens, 300, '同一天本地 tokens 更大时保留本地')
eq(mergedClaude?.days['2026-01-02'].tokens, 200, 'uTools 独有的历史日期补进来')
eq(mergedClaude?.days['2026-01-03'].tokens, 50, '本地独有日期保留')
eq(result.merged, 1, '统计档计入按天合并')
eq(result.kept, 2, '按 updatedAt 保留本地 2 个文档')
eq(result.imported, 4, '其余文档正常导入')
eq(localDb.get('ccconfig_common_providers')?.providers?.[0]?.name, 'p1', '无宿主机后缀的文档原样导入')
eq(localDb.get(localId('ccswitch_config_legacy'))?.name, '旧前缀', '旧前缀文档的宿主 ID 也被替换')

eq(localDb.get(localId('ccconfig_dark_background'))?.theme, 'dark', '较新的导入值覆盖本地旧值')
eq(localDb.get(localId('ccconfig_stats_unit'))?.unit, 'K/M/B', '较新的本地值保留')
eq(localDb.get(localId('ccconfig_locale'))?.locale, 'zh-CN', '无时间戳时保留本地')
eq(localDb.get('ccswitch_runtime_id'), null, '宿主设备 ID 文档不导入')
ok(localDb.get('ccconfig_runtime_id')?.value === SHARED_ID, '共享设备 ID 文档由本地库维护')

ok(hostStore.has(`ccconfig_config_${HOST_ID}`), '宿主旧库不删除')
eq(localDb.get(dbImport.MARKER_ID)?.sourceNativeId, HOST_ID, '写入导入标记')
eq(localDb.get(dbImport.MARKER_ID)?.version, dbImport.IMPORT_VERSION, '导入标记带合并逻辑版本')

const again = dbImport.importUtoolsData()
ok(again.skipped === true && again.reason === 'done', '同宿主 ID 不重复导入')

// 宿主 nativeId 变化（如重装 uTools）→ 允许再导入一次，仍按 updatedAt 合并
hostStore.set(`ccconfig_config_${HOST_ID}`, hostDoc(`ccconfig_config_${HOST_ID}`, { name: '更新后的配置', updatedAt: 999 }))
global.window.utools.getNativeId = () => 'another-host-id'
const changed = dbImport.importUtoolsData()
ok(changed.skipped === false, '宿主 ID 变化时重新导入')

// 桌面端跳过（sidecar 的 window.utools.db 本来就是本地库）
globalThis.__CCCONFIG_DESKTOP__ = true
const desktop = dbImport.importUtoolsData()
ok(desktop.skipped === true && desktop.reason === 'desktop', '桌面端跳过导入')
delete globalThis.__CCCONFIG_DESKTOP__

fs.rmSync(DATA_DIR, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
