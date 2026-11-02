// 共享本地文档库：uTools preload 与桌面 sidecar 读写同一份 `~/.ccconfig/db/`。
//
// 存储形态沿用桌面版既有实现：`<slug>-<sha1(id) 前 12 位>.json`，一个文档一个文件。
// 不直接拿文档 ID 当文件名：ID 片段可能来自用户配置，含 `/`、`:`、中文、`..` 都合法；
// macOS 默认的大小写/Unicode 规范化不敏感卷上，slug 只负责可读性，哈希负责唯一性，
// 真正的 `_id` 以文件内容为准。
//
// 读写语义对齐 uTools DB：_rev 冲突校验、单文档 1MB 上限。
// 与旧桌面 shim 的差异：不做进程内缓存、不做防抖，每次读写直接落盘——
// 两个应用进程可能同时访问同一批文件，写穿才能让另一边立刻看到。
// 写入用临时文件 + rename 原子替换；目录 0700、文档 0600。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const legacy = require('./legacy')

const MAX_DOC_BYTES = 1024 * 1024
const RUNTIME_ID_DOC = 'ccconfig_runtime_id'

// 写钩子：uTools 版用它把可移植文档同步到 utools.db；桌面 sidecar 不安装。
let _writeHook = null

const setWriteHook = (fn) => {
  _writeHook = typeof fn === 'function' ? fn : null
}

const notifyWrite = (op, value) => {
  if (!_writeHook) return
  try {
    _writeHook(op, value)
  } catch (e) {
    console.error(`[local-db] 写钩子失败: ${e && e.message ? e.message : e}`)
  }
}

// 数据目录：~/.ccconfig（与 .claude / .dsh / .codex 等 agent 配置同层）。
// 环境变量给测试与特殊部署用；CCSWITCH_DATA_DIR 是改名前的旧名。
const dataDir = () =>
  process.env.CCCONFIG_DATA_DIR ||
  process.env[legacy.DATA_DIR_ENV] ||
  path.join(os.homedir(), '.ccconfig')

const dbDir = () => path.join(dataDir(), 'db')

const ensureDir = () => {
  const dir = dbDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

const docFile = (id) => {
  const hash = crypto
    .createHash('sha1')
    .update(String(id), 'utf8')
    .digest('hex')
    .slice(0, 12)
  const slug =
    String(id)
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'doc'
  return path.join(dbDir(), `${slug}-${hash}.json`)
}

const clone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value))

const nextRev = (prevRev) => {
  const n = prevRev ? parseInt(String(prevRev).split('-')[0], 10) + 1 : 1
  return `${Number.isFinite(n) ? n : 1}-${crypto.randomBytes(8).toString('hex')}`
}

const writeDocFile = (file, doc) => {
  ensureDir()
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file) // 原子替换，避免进程被打断时留下半截文件
    // 库里含 AES 加密后的 API Key 与网关 key，收紧为仅本人可读
    try {
      fs.chmodSync(file, 0o600)
    } catch (e) {
      /* 非 unix 文件系统忽略 */
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch (e2) {
      /* 忽略 */
    }
    throw e
  }
}

// 每次都从磁盘读：另一个进程（uTools / 桌面 sidecar）可能刚刚改过同一文档
const readDoc = (id) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(docFile(id), 'utf8'))
    if (parsed && parsed._id === id) return parsed
    if (parsed && typeof parsed._id === 'string') {
      console.error(`[local-db] 文件名哈希撞车，忽略 ${parsed._id}`)
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[local-db] 读取文档 ${id} 失败: ${e.message}`)
    }
  }
  return null
}

const get = (id) => {
  const doc = readDoc(String(id))
  return doc ? clone(doc) : null
}

const put = (doc) => {
  if (!doc || typeof doc !== 'object' || typeof doc._id !== 'string' || !doc._id) {
    return { error: true, name: 'bad_request', message: 'doc._id 必须是非空字符串' }
  }
  const id = doc._id
  let size = 0
  try {
    size = Buffer.byteLength(JSON.stringify(doc), 'utf8')
  } catch (e) {
    return { error: true, name: 'bad_request', message: `文档无法序列化: ${e.message}`, id }
  }
  if (size > MAX_DOC_BYTES) {
    return { error: true, name: 'too_large', message: `文档 ${size} 字节，超过 1MB 上限`, id }
  }

  const cur = readDoc(id)
  if (cur && cur._rev && doc._rev !== cur._rev) {
    return {
      error: true,
      name: doc._rev ? 'conflict' : 'missing_rev',
      message: doc._rev ? 'Document update conflict' : '更新已有文档必须提供 _rev',
      id,
    }
  }

  const rev = nextRev(cur && cur._rev)
  const stored = clone(doc)
  stored._rev = rev
  try {
    writeDocFile(docFile(id), stored)
  } catch (e) {
    return { error: true, name: 'io_error', message: e.message, id }
  }
  notifyWrite('put', stored)
  return { ok: true, id, rev }
}

// 忽略 _rev 的写入，仅用于迁移/导入（旧库文档的 rev 与本地库无关）
const putForce = (doc) => {
  if (!doc || typeof doc !== 'object' || typeof doc._id !== 'string' || !doc._id) {
    return { error: true, name: 'bad_request', message: 'doc._id 必须是非空字符串' }
  }
  const id = doc._id
  let size = 0
  try {
    size = Buffer.byteLength(JSON.stringify(doc), 'utf8')
  } catch (e) {
    return { error: true, name: 'bad_request', message: `文档无法序列化: ${e.message}`, id }
  }
  if (size > MAX_DOC_BYTES) {
    return { error: true, name: 'too_large', message: `文档 ${size} 字节，超过 1MB 上限`, id }
  }
  const cur = readDoc(id)
  const stored = clone(doc)
  delete stored._rev
  stored._rev = nextRev(cur && cur._rev)
  try {
    writeDocFile(docFile(id), stored)
  } catch (e) {
    return { error: true, name: 'io_error', message: e.message, id }
  }
  notifyWrite('put', stored)
  return { ok: true, id, rev: stored._rev }
}

const remove = (idOrDoc, maybeRev) => {
  const isDoc = idOrDoc && typeof idOrDoc === 'object'
  const id = String(isDoc ? idOrDoc._id : idOrDoc || '')
  const rev = isDoc ? idOrDoc._rev : maybeRev
  if (!id) return { error: true, name: 'bad_request', message: '缺少 _id' }
  const cur = readDoc(id)
  if (!cur) return { error: true, name: 'not_found', message: '文档不存在', id }
  if (rev && cur._rev && rev !== cur._rev) {
    return { error: true, name: 'conflict', message: 'Document update conflict', id }
  }
  try {
    fs.unlinkSync(docFile(id))
  } catch (e) {
    if (e.code !== 'ENOENT') return { error: true, name: 'io_error', message: e.message, id }
  }
  notifyWrite('remove', id)
  return { ok: true, id }
}

// 对齐 uTools：无参返回全部、字符串按 ID 前缀过滤、数组按 ID 取
const allDocs = (arg) => {
  if (Array.isArray(arg)) {
    const docs = []
    for (const id of arg) {
      const doc = readDoc(String(id))
      if (doc) docs.push(clone(doc))
    }
    return docs
  }
  const prefix = typeof arg === 'string' ? arg : ''
  const docs = []
  const seen = new Set()
  let names = []
  try {
    names = fs.readdirSync(dbDir())
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[local-db] 读取文档目录失败: ${e.message}`)
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue // 跳过 .DS_Store、残留 .tmp 等
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dbDir(), name), 'utf8'))
    } catch (e) {
      console.error(`[local-db] 跳过无法解析的文档文件 ${name}: ${e.message}`)
      continue
    }
    if (!parsed || typeof parsed._id !== 'string') continue
    if (prefix && !parsed._id.startsWith(prefix)) continue
    if (seen.has(parsed._id)) continue
    seen.add(parsed._id)
    docs.push(clone(parsed))
  }
  return docs
}

// ==================== 设备 ID ====================
// 与桌面版既有算法保持一致：uTools 与桌面端必须算出同一个 nativeId，
// 所有 `_<nativeId>` 文档才能指向同一批数据。种子与旧文档名绝不能改。
const firstMacAddress = () => {
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return `${name}:${info.mac}`
      }
    }
  }
  return 'no-mac'
}

const getNativeId = () => {
  const cached = get(RUNTIME_ID_DOC) || get(legacy.RUNTIME_ID_DOC)
  if (cached && typeof cached.value === 'string' && cached.value) return cached.value

  const seed = `${os.hostname()}|${firstMacAddress()}|${legacy.NATIVE_ID_SEED_SUFFIX}`
  const value = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)
  putForce({ _id: RUNTIME_ID_DOC, value, createdAt: Date.now() })
  return value
}

// 写穿模式没有待落盘队列；保留给 sidecar 生命周期调用，行为为空操作
const flushNow = () => {}

module.exports = {
  db: { get, put, remove, allDocs },
  get,
  put,
  putForce,
  remove,
  allDocs,
  getNativeId,
  setWriteHook,
  dataDir,
  dbDir,
  flushNow,
  MAX_DOC_BYTES,
  RUNTIME_ID_DOC,
}
