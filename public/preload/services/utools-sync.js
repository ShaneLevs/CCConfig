// uTools 跨设备同步桥。
//
// 背景：uTools 数据库自带云同步（用户开启「数据同步」后生效）。新的共享本地库
// `~/.ccconfig/db` 不参与 uTools 云同步，所以这里把「可移植文档」额外镜像到
// `window.utools.db`，并在每次进入插件 / 云端拉取完成后做一次三向合并：
//
//   host（uTools DB，云端会更新） ↔ local（共享本地库） ↔ synced（上次同步快照）
//
// - 本地写入可移植文档：立即镜像到 host（uTools 云同步负责推送到其他设备）。
// - host 新增/更新：合并到 local。
// - 本地删除 / host 删除：根据上次同步快照判断是哪一边删的，并同步到另一边。
// - 统计、缓存、外观、语言、显隐、MCP 本地状态、网关配置等机器档不参与，
//   只留在本地库（见 ./portable-docs.js）。
//
// 桌面 sidecar 没有 uTools DB，install 直接返回 false，不会安装写钩子。
const crypto = require('node:crypto')
const localDb = require('./local-db')
const { isPortableDoc } = require('./portable-docs')

const SYNC_STATE_ID = 'ccconfig_utools_sync_state'
const CLOUD_POLL_MS = 500
const CLOUD_MAX_TRIES = 120

let applying = false
let running = false
let rerun = false
let cloudTimer = null
let cloudReimported = false
let options = {}

const hostDb = () => {
  if (globalThis.__CCCONFIG_DESKTOP__) return null
  if (typeof window === 'undefined' || !window.utools || !window.utools.db) return null
  return window.utools.db
}

const cloudState = () => {
  const db = hostDb()
  if (!db || typeof db.replicateStateFromCloud !== 'function') return null
  try {
    return db.replicateStateFromCloud()
  } catch (e) {
    return null
  }
}

// ==================== 文档快照 ====================

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key])
    return out
  }
  return value
}

const docHash = (doc) => {
  const copy = { ...(doc || {}) }
  delete copy._rev
  return crypto.createHash('sha1').update(JSON.stringify(stable(copy))).digest('hex')
}

const stampOf = (doc) => {
  const ts = Number(doc && doc.updatedAt)
  return {
    updatedAt: Number.isFinite(ts) ? ts : 0,
    hash: docHash(doc),
  }
}

// 没有 updatedAt 的文档（group_order / extra_field_keys）用内容哈希判断是否变过
const changedSince = (doc, stamp) => {
  if (!stamp) return true
  const ts = Number(doc && doc.updatedAt)
  const docTs = Number.isFinite(ts) ? ts : 0
  if (docTs || stamp.updatedAt) return docTs > stamp.updatedAt
  return docHash(doc) !== stamp.hash
}

const readState = () => {
  const doc = localDb.get(SYNC_STATE_ID)
  return doc && doc.ids && typeof doc.ids === 'object' ? doc.ids : {}
}

const writeState = (ids) => {
  localDb.putForce({ _id: SYNC_STATE_ID, ids, updatedAt: Date.now() })
}

const hostPortableDocs = (db) => {
  const out = new Map()
  try {
    const all = db.allDocs()
    const list = Array.isArray(all) ? all : (all && Array.isArray(all.docs) ? all.docs : [])
    for (const doc of list) {
      if (doc && isPortableDoc(doc._id)) out.set(doc._id, doc)
    }
  } catch (e) {
    console.error(`[utools-sync] 读取 uTools 数据库失败: ${e.message || e}`)
  }
  return out
}

const localPortableDocs = () =>
  localDb.allDocs().filter((doc) => doc && isPortableDoc(doc._id))

// ==================== 镜像到 uTools DB ====================

const mirrorPut = (doc) => {
  const db = hostDb()
  if (!db || !doc || typeof doc._id !== 'string') return false
  try {
    const payload = JSON.parse(JSON.stringify(doc))
    delete payload._rev
    const doPut = () => {
      const cur = db.get(doc._id)
      if (cur && cur._rev) payload._rev = cur._rev
      else delete payload._rev
      return db.put(payload)
    }
    let res = doPut()
    // 云端刚好更新过同一文档：拿最新 _rev 再试一次（本地这次写入视为最后修改）
    if (res && res.error && res.name === 'conflict') res = doPut()
    if (res && res.error) {
      console.error(`[utools-sync] 回写 ${doc._id} 失败: ${res.name || res.message || 'unknown'}`)
      return false
    }
    return true
  } catch (e) {
    console.error(`[utools-sync] 回写 ${doc._id} 异常: ${e.message || e}`)
    return false
  }
}

const mirrorRemove = (id) => {
  const db = hostDb()
  if (!db) return false
  try {
    let cur = db.get(id)
    if (!cur) return true
    let res = db.remove(id, cur._rev)
    if (res && res.error && res.name === 'conflict') {
      cur = db.get(id)
      if (cur && cur._rev) res = db.remove(id, cur._rev)
    }
    if (res && res.error) {
      console.error(`[utools-sync] 删除 ${id} 失败: ${res.name || res.message || 'unknown'}`)
      return false
    }
    return true
  } catch (e) {
    console.error(`[utools-sync] 删除 ${id} 异常: ${e.message || e}`)
    return false
  }
}

// ==================== 合并 ====================

// 云端还在拉取时只做「host → local」，不推本地、不处理删除，
// 避免用不完整的云端状态覆盖本地或误删另一端的数据。
const pullPortable = (db) => {
  const hostMap = hostPortableDocs(db)
  applying = true
  try {
    for (const [id, host] of hostMap) {
      const local = localDb.get(id)
      if (!local) {
        localDb.putForce(host)
        continue
      }
      const hostTs = Number(host.updatedAt) || 0
      const localTs = Number(local.updatedAt) || 0
      if (hostTs > localTs) localDb.putForce(host)
    }
  } finally {
    applying = false
  }
}

const syncNow = ({ pullOnly = false } = {}) => {
  const db = hostDb()
  if (!db) return
  if (running) {
    rerun = true
    return
  }
  if (pullOnly) {
    pullPortable(db)
    return
  }

  running = true
  applying = true
  try {
    const synced = readState()
    const hostMap = hostPortableDocs(db)
    const localMap = new Map(localPortableDocs().map((doc) => [doc._id, doc]))
    const ids = new Set([...hostMap.keys(), ...localMap.keys(), ...Object.keys(synced)])
    const next = {}

    for (const id of ids) {
      const host = hostMap.get(id)
      const local = localMap.get(id)
      const stamp = synced[id]

      if (host && local) {
        const hostChanged = changedSince(host, stamp)
        const localChanged = changedSince(local, stamp)
        if (hostChanged && !localChanged) {
          localDb.putForce(host)
          next[id] = stampOf(host)
        } else if (localChanged && !hostChanged) {
          if (mirrorPut(local)) next[id] = stampOf(local)
          else if (stamp) next[id] = stamp
        } else if (hostChanged && localChanged) {
          // 两边都动过：有 updatedAt 用较新的；都没有时本地优先
          const hostTs = Number(host.updatedAt) || 0
          const localTs = Number(local.updatedAt) || 0
          if (hostTs > localTs) {
            localDb.putForce(host)
            next[id] = stampOf(host)
          } else if (mirrorPut(local)) {
            next[id] = stampOf(local)
          } else if (stamp) {
            next[id] = stamp
          }
        } else {
          next[id] = stampOf(local)
        }
        continue
      }

      if (host && !local) {
        if (!stamp || changedSince(host, stamp)) {
          // 云端新增，或云端在本地删除之后又更新过 → 以云端为准
          localDb.putForce(host)
          next[id] = stampOf(host)
        } else if (mirrorRemove(id)) {
          // 本地删除了（上次同步后本地没有变化）→ 把删除同步到云端
        } else if (stamp) {
          next[id] = stamp
        }
        continue
      }

      if (!host && local) {
        if (!stamp) {
          if (mirrorPut(local)) next[id] = stampOf(local)
        } else if (changedSince(local, stamp)) {
          // 云端删除后本地又改过 → 用本地覆盖云端
          if (mirrorPut(local)) next[id] = stampOf(local)
          else next[id] = stamp
        } else {
          // 云端删除，本地未改 → 删除本地
          localDb.remove(id)
        }
        continue
      }

      // 两边都没有：从同步快照里移除
    }

    writeState(next)
  } catch (e) {
    console.error(`[utools-sync] 合并失败: ${e.message || e}`)
  } finally {
    applying = false
    running = false
    if (rerun) {
      rerun = false
      syncNow({ pullOnly })
    }
  }
}

// ==================== 生命周期 ====================

const onLocalWrite = (op, value) => {
  if (applying) return
  const id = typeof value === 'string' ? value : (value && value._id)
  if (!isPortableDoc(id)) return
  if (op === 'put') mirrorPut(value)
  else if (op === 'remove') mirrorRemove(id)
}

const handleCloudReady = () => {
  if (!options.cloudPending || cloudReimported) return
  cloudReimported = true
  applying = true
  try {
    options.reimport && options.reimport()
  } catch (e) {
    console.error(`[utools-sync] 云端拉取后重新导入失败: ${e.message || e}`)
  } finally {
    applying = false
  }
}

const scheduleCloud = () => {
  if (cloudTimer) return
  let tries = 0
  const poll = () => {
    cloudTimer = null
    const current = cloudState()
    if (current === 1 && tries++ < CLOUD_MAX_TRIES) {
      cloudTimer = setTimeout(poll, CLOUD_POLL_MS)
      return
    }
    handleCloudReady()
    syncNow()
  }
  cloudTimer = setTimeout(poll, CLOUD_POLL_MS)
}

/**
 * 安装同步钩子并立即对一次账；可重复调用（每次进入插件都会再对一次）。
 * options.cloudPending: 装载时的导入是否发生在云端拉取完成前
 * options.reimport: 云端拉取完成后重新执行一次全量导入
 */
const start = (nextOptions = {}) => {
  // 每次 start 都重置选项并重装钩子：单测/热重载可能把钩子清掉，重装是幂等的
  options = { ...nextOptions }
  const db = hostDb()
  if (!db) return false
  localDb.setWriteHook(onLocalWrite)
  const state = cloudState()
  if (state === 1) {
    syncNow({ pullOnly: true })
    scheduleCloud()
  } else {
    if (cloudTimer) {
      clearTimeout(cloudTimer)
      cloudTimer = null
    }
    handleCloudReady()
    syncNow()
  }
  return true
}

module.exports = {
  start,
  syncNow,
  isPortableDoc,
  SYNC_STATE_ID,
}
