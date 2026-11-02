// 一次性把 uTools 宿主 DB 搬到共享本地库（`~/.ccconfig/db`）。
//
// 新版开始 uTools 与桌面版共用本地库，宿主 DB 只作为旧数据来源保留（不删除，
// 方便回退到旧版插件时仍有数据）。迁移只在 uTools 里执行；桌面 sidecar 的
// `window.utools.db` 本来就是本地库，无需导入。
//
// 兼容点：
//   1. 旧文档 ID 里的 nativeId 是 uTools 宿主算的，共享库用桌面版算法（同一台机器固定），
//      导入时把 `_<宿主ID>` 片段替换成 `_<共享ID>`（顶层 nativeId 字段同步改写）；
//   2. 统计类文档（agent 每日用量 / Claude 热力图）按天合并：同一个 agent 同一天取
//      tokens 较大的那条，本地较新但天数更少时不会把 uTools 的历史天数挡掉；
//   3. 其余文档目标已存在时按 `updatedAt` 取较新的，没有时间戳时保留本地；
//   4. 设备 ID 文档不导入，统一用共享库自己算的那份；
//   5. 导入完成后写标记（带逻辑版本），同版本 + 同宿主 ID 不再重复扫描。
const localDb = require('./local-db')
const legacy = require('./legacy')
const { isPortableDoc } = require('./portable-docs')

const MARKER_ID = 'ccconfig_utools_import_v1'
// 合并逻辑版本：统计按天合并上线后 +1，旧版本写下的标记会再跑一次（幂等）
const IMPORT_VERSION = 2
const SYNC_STATE_ID = 'ccconfig_utools_sync_state'

// 这些文档的 days 是「日期 → 当日用量」，整份按 updatedAt 取舍会丢历史天数
const DAY_MERGE_PREFIXES = ['ccconfig_agent_usage_', 'ccconfig_heatmap_']

const isDesktop = () =>
  typeof globalThis !== 'undefined' && globalThis.__CCCONFIG_DESKTOP__ === true

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

const newer = (incoming, existing) => {
  const a = Number(incoming && incoming.updatedAt)
  const b = Number(existing && existing.updatedAt)
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b
  return Number.isFinite(a)
}

const rewriteId = (id, hostIds, sharedId) => {
  let out = id
  for (const hostId of hostIds) {
    if (!hostId || hostId === sharedId) continue
    out = out.split(`_${hostId}`).join(`_${sharedId}`)
  }
  return out
}

// 文档里的 nativeId 字段也指向宿主设备 ID；不改写会让后续按设备读取的代码找不到它
const rewriteDoc = (doc, id, hostIds, sharedId) => {
  const out = { ...doc, _id: id }
  if (typeof out.nativeId === 'string' && hostIds.includes(out.nativeId)) {
    out.nativeId = sharedId
  }
  return out
}

const dayTokens = (day) => {
  const n = Number(day && day.tokens)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const isDayMergeDoc = (id) => DAY_MERGE_PREFIXES.some((prefix) => id.startsWith(prefix))

// 同一天取 tokens 较大的整条记录；模型明细随记录一起取舍，保证口径自洽
const mergeDayDocs = (existing, incoming) => {
  const days = { ...(isObject(existing.days) ? existing.days : {}) }
  let changed = false
  for (const [date, day] of Object.entries(isObject(incoming.days) ? incoming.days : {})) {
    if (!isObject(day)) continue
    const cur = days[date]
    if (!cur || dayTokens(day) > dayTokens(cur)) {
      days[date] = day
      changed = true
    }
  }
  if (!changed) return { doc: existing, changed: false }
  const updatedAt = Math.max(
    Number(existing.updatedAt) || 0,
    Number(incoming.updatedAt) || 0,
  )
  return {
    doc: {
      ...existing,
      ...(existing.agent || incoming.agent ? { agent: existing.agent || incoming.agent } : {}),
      nativeId: existing.nativeId || incoming.nativeId,
      days,
      ...(updatedAt ? { updatedAt } : {}),
    },
    changed: true,
  }
}

const hostDocs = (hostDb) => {
  try {
    const all = hostDb.allDocs()
    if (Array.isArray(all)) return all
    if (all && Array.isArray(all.docs)) return all.docs
  } catch (e) {
    console.error('[db-import] 读取 uTools 旧库失败:', e)
  }
  return []
}

const cloudPending = () => {
  try {
    const db = typeof window !== 'undefined' && window.utools && window.utools.db
    if (db && typeof db.replicateStateFromCloud === 'function') {
      return db.replicateStateFromCloud() === 1
    }
  } catch (e) {
    /* ignore */
  }
  return false
}

const NATIVE_ID_RE = /_([0-9a-f]{32})(?:_|$)/
// 只导入本机旧文档、可移植文档和无 nativeId 的旧共享档；
// 其他设备同步到宿主 DB 的机器档（统计/外观/显隐等）不搬进本机。
const shouldImport = (id, hostIds, sharedId) => {
  if (id === MARKER_ID || id === SYNC_STATE_ID) return false
  if (isPortableDoc(id)) return true
  const match = NATIVE_ID_RE.exec(id)
  if (!match) return true
  return match[1] === sharedId || hostIds.includes(match[1])
}

const importUtoolsData = (force = false) => {
  const pending = cloudPending()
  if (isDesktop()) return { imported: 0, skipped: true, reason: 'desktop', cloudPending: pending }
  const hostDb = typeof window !== 'undefined' && window.utools && window.utools.db
  if (!hostDb || typeof hostDb.allDocs !== 'function') {
    return { imported: 0, skipped: true, reason: 'no-host-db', cloudPending: pending }
  }

  let hostId = ''
  try {
    hostId = String(window.utools.getNativeId() || '')
  } catch (e) {
    /* ignore */
  }

  const marker = localDb.get(MARKER_ID)
  if (!force && marker && marker.sourceNativeId === hostId && marker.version === IMPORT_VERSION) {
    return { imported: 0, skipped: true, reason: 'done', cloudPending: pending }
  }

  const docs = hostDocs(hostDb)
  if (docs.length === 0) {
    return { imported: 0, skipped: true, reason: 'empty', cloudPending: pending }
  }

  const sharedId = localDb.getNativeId()
  // uTools 重装后宿主 ID 可能变化：上一次导入记录的 ID 也要一起改写，
  // 否则同名文档会以新旧两个 ID 各存一份。
  const hostIds = [...new Set([hostId, marker && marker.sourceNativeId].filter(Boolean))]
  let imported = 0
  let merged = 0
  let kept = 0
  let ignored = 0
  let failed = 0

  for (const doc of docs) {
    if (!doc || typeof doc._id !== 'string' || !doc._id) continue
    // 设备 ID 由共享库自己维护，宿主 ID 导入进来会让两边再次分叉
    if (doc._id === localDb.RUNTIME_ID_DOC || doc._id === legacy.RUNTIME_ID_DOC) {
      ignored += 1
      continue
    }
    const id = rewriteId(doc._id, hostIds, sharedId)
    const incoming = rewriteDoc(doc, id, hostIds, sharedId)
    if (!shouldImport(id, hostIds, sharedId)) {
      ignored += 1
      continue
    }
    const existing = localDb.get(id)

    if (!existing) {
      if (localDb.putForce(incoming).ok) imported += 1
      else failed += 1
      continue
    }

    // 统计历史：按天合并，本地较新但天数更少时补齐 uTools 的日期
    if (isDayMergeDoc(id)) {
      const result = mergeDayDocs(existing, incoming)
      if (!result.changed) {
        kept += 1
      } else if (localDb.putForce(result.doc).ok) {
        merged += 1
      } else {
        failed += 1
      }
      continue
    }

    if (newer(incoming, existing)) {
      if (localDb.putForce(incoming).ok) imported += 1
      else failed += 1
    } else {
      kept += 1
    }
  }

  // 有失败项时不写标记：下次启动重试（已成功的文档会按合并规则收敛）
  if (failed === 0) {
    localDb.putForce({
      _id: MARKER_ID,
      version: IMPORT_VERSION,
      sourceNativeId: hostId,
      sharedNativeId: sharedId,
      imported,
      merged,
      kept,
      failed,
      importedAt: Date.now(),
    })
  }

  console.log(
    `[db-import] 已从 uTools 旧库迁移到 ~/.ccconfig：导入 ${imported} 个、` +
      `按天合并 ${merged} 个、保留本地 ${kept} 个、忽略 ${ignored} 个、失败 ${failed} 个文档`,
  )
  return {
    imported,
    merged,
    kept,
    ignored,
    failed,
    skipped: false,
    sourceNativeId: hostId,
    sharedNativeId: sharedId,
    cloudPending: pending,
  }
}

module.exports = { importUtoolsData, MARKER_ID, IMPORT_VERSION }
