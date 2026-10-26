// db-migrate.js 冒烟测试：node tests/smoke-db-migrate-test.cjs（仓库根目录运行）
// 验证改名迁移（ccswitch → ccconfig）：
//   1. 旧前缀文档 ID → 新前缀，内容（含 _<nativeId> 后缀、旧共享档）完整保留，旧档删除
//   2. 目标档已存在时不覆盖，只删旧档
//   3. 旧格式密文 `<iv>:<ct>`（旧盐）换盐重加密为 `v2:<iv>:<ct>`，明文不变
//   4. 新格式 / 明文不动
//   5. 幂等：第二次执行什么都不做
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
const crypto = require('node:crypto')

// ==================== 最小 uTools 环境（内存 DB，带 _rev 语义） ====================
const store = new Map()
let rev = 0
const nextRev = () => `${++rev}-fake`

global.window = {
  utools: {
    db: {
      get: (id) => { const d = store.get(String(id)); return d ? JSON.parse(JSON.stringify(d)) : null },
      put: (doc) => {
        if (!doc || !doc._id) return { error: true, message: 'bad doc' }
        const cur = store.get(doc._id)
        if (cur && cur._rev && doc._rev !== cur._rev) return { error: true, message: 'conflict' }
        store.set(doc._id, { ...JSON.parse(JSON.stringify(doc)), _rev: nextRev() })
        return { ok: true, id: doc._id }
      },
      remove: (idOrDoc, maybeRev) => {
        const isDoc = idOrDoc && typeof idOrDoc === 'object'
        const id = isDoc ? idOrDoc._id : idOrDoc
        const r = isDoc ? idOrDoc._rev : maybeRev
        const cur = store.get(String(id))
        if (!cur) return { error: true, message: 'not_found' }
        if (r && cur._rev !== r) return { error: true, message: 'conflict' }
        store.delete(String(id))
        return { ok: true }
      },
      allDocs: () => Array.from(store.values()).map((d) => JSON.parse(JSON.stringify(d))),
    },
  },
}

const cryptoMod = require('../public/preload/services/crypto')
const dbMigrate = require('../public/preload/services/db-migrate')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}

// 造一份旧盐的密文（等价改名前的写入格式：`<ivHex>:<ctHex>`，无 `v2:` 前缀）
const LEGACY_SALT = 'ccswitch-encryption-key'
const legacyKey = crypto.createHash('sha256').update(LEGACY_SALT).digest()
const makeLegacyCiphertext = (plain) => {
  const iv = crypto.randomBytes(16)
  const c = crypto.createCipheriv('aes-256-cbc', legacyKey, iv)
  let out = c.update(plain, 'utf8', 'hex')
  out += c.final('hex')
  return iv.toString('hex') + ':' + out
}

const seed = () => {
  store.clear()
  store.set('ccswitch_active_config_id', { _id: 'ccswitch_active_config_id', _rev: 'r1', configId: 'abc' })
  store.set('ccswitch_config_1_x', {
    _id: 'ccswitch_config_1_x', _rev: 'r1', name: '生产', key: makeLegacyCiphertext('sk-legacy-1'), baseUrl: 'https://a',
  })
  store.set('ccswitch_config_2_y', {
    _id: 'ccswitch_config_2_y', _rev: 'r1', name: '测试', key: cryptoMod.encrypt('sk-new-1'), baseUrl: 'https://b',
  })
  store.set('ccswitch_dark_background_test-native', {
    _id: 'ccswitch_dark_background_test-native', _rev: 'r1', theme: 'dark', enabled: true, effect: 'galaxy',
  })
  store.set('ccswitch_locale', { _id: 'ccswitch_locale', _rev: 'r1', locale: 'en-US' }) // 旧共享档
  store.set('ccswitch_common_providers', {
    _id: 'ccswitch_common_providers', _rev: 'r1',
    providers: [
      { name: 'p1', apiKey: makeLegacyCiphertext('sk-provider-legacy') },
      { name: 'p2', apiKey: 'sk-provider-plain' }, // 明文（历史遗留）不应被加密
    ],
  })
  // 旧档存在且新档也已存在 → 不覆盖新档
  store.set('ccswitch_common_mcp', { _id: 'ccswitch_common_mcp', _rev: 'r1', mcpServers: { old: {} } })
  store.set('ccconfig_common_mcp', { _id: 'ccconfig_common_mcp', _rev: 'r1', mcpServers: { fresh: {} } })
  // 无关文档
  store.set('other_doc', { _id: 'other_doc', _rev: 'r1', x: 1 })
}

;(() => {
  seed()
  const first = dbMigrate.migrateLegacyData()

  // ==================== 文档 ID 迁移 ====================
  ok(!store.has('ccswitch_active_config_id'), '旧 active_config_id 已删除')
  ok(store.get('ccconfig_active_config_id')?.configId === 'abc', 'active_config_id 内容保留')
  ok(store.get('ccconfig_config_1_x')?.name === '生产', 'config 文档迁移且内容保留')
  ok(!store.has('ccswitch_config_1_x'), '旧 config 文档已删除')
  ok(store.get('ccconfig_dark_background_test-native')?.effect === 'galaxy', '带 nativeId 后缀的外观档迁移')
  ok(store.get('ccconfig_locale')?.locale === 'en-US', '旧共享语言档迁移')
  ok(store.get('other_doc')?.x === 1, '无关文档不动')
  ok(store.get('ccconfig_config_1_x')?._rev !== 'r1', '迁移后的文档是新建的（新 _rev）')

  // 目标已存在：不覆盖，旧档删掉
  ok(store.get('ccconfig_common_mcp')?.mcpServers?.fresh && !store.get('ccconfig_common_mcp')?.mcpServers?.old,
    '目标档已存在时保留新档、不覆盖')
  ok(!store.has('ccswitch_common_mcp'), '目标已存在时旧档也删除')

  // ==================== 密文换盐 ====================
  const key1 = store.get('ccconfig_config_1_x').key
  ok(cryptoMod.isLegacyCiphertext(makeLegacyCiphertext('x')) && !cryptoMod.isLegacyCiphertext(key1),
    '旧格式密文已重加密为新格式')
  ok(key1.startsWith('v2:'), '新密文带 v2: 前缀')
  ok(cryptoMod.decrypt(key1) === 'sk-legacy-1', '重加密后明文不变（sk-legacy-1）')

  const key2 = store.get('ccconfig_config_2_y').key
  ok(cryptoMod.decrypt(key2) === 'sk-new-1', '已是新格式的密文不被二次加密')

  const providers = store.get('ccconfig_common_providers').providers
  ok(cryptoMod.decrypt(providers[0].apiKey) === 'sk-provider-legacy', '供应商 apiKey 重加密后明文不变')
  ok(!cryptoMod.isLegacyCiphertext(providers[0].apiKey), '供应商 apiKey 已是新格式')
  ok(providers[1].apiKey === 'sk-provider-plain', '明文 key 保持原样，不被加密')

  // ==================== 计数与幂等 ====================
  ok(first.docIds === 7, `首次迁移文档数 = 7（got=${first.docIds}）`)
  ok(first.ciphertexts >= 1, `首次迁移密文数 >= 1（got=${first.ciphertexts}）`)

  const snapshot = JSON.stringify(Array.from(store.entries()))
  const second = dbMigrate.migrateLegacyData()
  ok(second.skipped === true, '同进程第二次调用直接跳过')
  ok(JSON.stringify(Array.from(store.entries())) === snapshot, '跳过时不改动任何数据')

  // ==================== 幂等（模拟重启后无标记、重新扫描） ====================
  // 清掉进程内 _done 的方式：重新 require 一份干净模块
  delete require.cache[require.resolve('../public/preload/services/db-migrate')]
  const dbMigrate2 = require('../public/preload/services/db-migrate')
  const third = dbMigrate2.migrateLegacyData()
  ok(third.docIds === 0 && third.ciphertexts === 0, '重启后重扫：无事可做（幂等）')
  ok(JSON.stringify(Array.from(store.entries())) === snapshot, '重启重扫后数据不变')

  // ==================== 写入失败时保留旧档（不丢数据） ====================
  store.clear()
  store.set('ccswitch_big', { _id: 'ccswitch_big', _rev: 'r1', payload: 'x'.repeat(64) })
  const realPut = global.window.utools.db.put
  global.window.utools.db.put = () => ({ error: true, message: 'too_large' })
  delete require.cache[require.resolve('../public/preload/services/db-migrate')]
  const dbMigrate3 = require('../public/preload/services/db-migrate')
  const fourth = dbMigrate3.migrateLegacyData()
  global.window.utools.db.put = realPut
  ok(fourth.docIds === 0, '新档写入失败时不计数')
  ok(store.has('ccswitch_big'), '新档写入失败时旧档保留（下次启动重试）')

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
