// 一次性数据迁移：把历史命名（ccswitch）的落库数据改写成 ccconfig。
//
// 覆盖两件事：
//   1. DB 文档 ID 前缀 `ccswitch_*` → `ccconfig_*`（配置、供应商主数据、MCP、统计、语言、外观…）
//   2. AES 密文换盐：旧格式 `<iv>:<ct>` 重加密为 `v2:<iv>:<ct>`（API Key 等）
//
// 幂等：只处理「仍带旧前缀」的文档 / 「仍是旧格式」的密文，跑完再跑无事可做。
// 失败不阻断启动：异常只记日志，下次启动重试（旧档不删，数据不会丢）。
//
// 注意：本模块是唯一允许出现旧前缀字面量的 preload 逻辑（字面量来自 ./legacy.js）。
//
// 旧命名兼容清单集中在 ./legacy.js。

const crypto = require('./crypto')
const legacy = require('./legacy')

const NEW_PREFIX = 'ccconfig_' // 新文档 ID 前缀
const CONFIG_DOC_PREFIX = 'ccconfig_config_' // 配置类文档（claude 配置 / dispatch 下发档），.key 为 AES 密文
const PROVIDERS_DOC_ID = 'ccconfig_common_providers' // 供应商主数据档，providers[].apiKey 为 AES 密文

const db = () => window.utools.db

// uTools / sidecar 的 db 写入体积上限（sidecar 1MB；uTools 同量级）。
// 迁移不改变文档结构，只有可能出现「本来就超限」的统计档，put 失败时保留旧档即可。
const putDoc = (doc) => {
  try {
    return db().put(doc) || {}
  } catch (e) {
    return { error: true, message: (e && e.message) || String(e) }
  }
}

// ==================== 1. 文档 ID 前缀 ====================

/** 把旧前缀文档搬到新前缀下；旧的删除。返回迁移条数。 */
const migrateDocIds = () => {
  let migrated = 0
  const docs = db().allDocs() || []
  for (const doc of docs) {
    if (!doc || typeof doc._id !== 'string') continue
    if (!doc._id.startsWith(legacy.DOC_ID_PREFIX)) continue

    const nextId = NEW_PREFIX + doc._id.slice(legacy.DOC_ID_PREFIX.length)
    const existing = db().get(nextId)
    if (!existing) {
      const { _id, _rev, ...fields } = doc
      const res = putDoc({ ...fields, _id: nextId })
      if (res.error) {
        // 新档写失败：保留旧档，下次启动重试
        console.error(`[db-migrate] 迁移文档 ${_id} → ${nextId} 失败: ${res.message || 'unknown'}`)
        continue
      }
    }
    // 新档已就绪（本次写入成功，或目标已存在）→ 删旧档
    const removed = db().remove(doc._id, doc._rev)
    if (removed && removed.error) {
      console.error(`[db-migrate] 删除旧文档 ${doc._id} 失败: ${removed.message || 'unknown'}`)
      continue
    }
    migrated += 1
  }
  return migrated
}

// ==================== 2. 密文换盐 ====================

/**
 * 重加密单个文档里的指定字段，返回是否改动。
 * getField/setField 拿到文档本体，便于处理嵌套结构。
 */
const reencryptDoc = (docId, rewrite) => {
  const doc = db().get(docId)
  if (!doc) return false
  if (rewrite(doc) !== true) return false
  const res = putDoc({ ...doc, _id: docId, _rev: doc._rev })
  if (res.error) {
    console.error(`[db-migrate] 重加密文档 ${docId} 失败: ${res.message || 'unknown'}`)
    return false
  }
  return true
}

const migrateCiphertexts = () => {
  let migrated = 0
  // 配置类文档：顶层 key 字段
  for (const doc of db().allDocs() || []) {
    if (!doc || typeof doc._id !== 'string') continue
    if (!doc._id.startsWith(CONFIG_DOC_PREFIX)) continue
    const plain = crypto.isLegacyCiphertext(doc.key) ? crypto.reencrypt(doc.key) : null
    if (plain === null || plain === doc.key) continue
    if (reencryptDoc(doc._id, (d) => { d.key = plain; return true })) migrated += 1
  }
  // 供应商主数据：providers[].apiKey
  const providersDoc = db().get(PROVIDERS_DOC_ID)
  if (providersDoc && Array.isArray(providersDoc.providers)) {
    let touched = false
    const providers = providersDoc.providers.map((p) => {
      if (!p || !crypto.isLegacyCiphertext(p.apiKey)) return p
      const plain = crypto.reencrypt(p.apiKey)
      if (plain === p.apiKey) return p
      touched = true
      return { ...p, apiKey: plain }
    })
    if (touched && reencryptDoc(PROVIDERS_DOC_ID, (d) => { d.providers = providers; return true })) {
      migrated += touched ? 1 : 0
    }
  }
  return migrated
}

// ==================== 入口 ====================

let _done = false

/**
 * 执行一次性迁移（幂等）。
 * 在 preload 装载期调用一次即可：早于渲染层模块初始化，
 * 也早于 sidecar 开始监听（桌面版），所以读到的都是迁移后的新文档 ID。
 */
const migrateLegacyData = () => {
  if (_done) return { docIds: 0, ciphertexts: 0, skipped: true }
  _done = true
  let docIds = 0
  let ciphertexts = 0
  try {
    docIds = migrateDocIds()
  } catch (e) {
    console.error('[db-migrate] 文档 ID 迁移失败', e)
  }
  try {
    ciphertexts = migrateCiphertexts()
  } catch (e) {
    console.error('[db-migrate] 密文换盐失败', e)
  }
  if (docIds || ciphertexts) {
    console.log(`[db-migrate] 已迁移 ${docIds} 个文档 ID、${ciphertexts} 份密文`)
  }
  return { docIds, ciphertexts, skipped: false }
}

module.exports = { migrateLegacyData, migrateDocIds, migrateCiphertexts }
