// 只读 SQLite 查询的最小公共层（订阅功能读浏览器 Cookie 库用）。
// zcode.js / opencode.js 里有各自的同类实现（带业务 SQL），这里只抽「怎么把一条 SQL 跑出来」：
//   1. 优先 node:sqlite（Node ≥ 22.5 / Electron ≥ 35）
//   2. 退化成系统 node 子进程（uTools 8 = Electron 34 / Node 20 没有 node:sqlite）
// 两条路都只读、都在临时副本上跑（浏览器开着时原库被占用，直连可能拿到 SQLITE_BUSY）。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let nativeSqlite
const resolveNativeSqlite = () => {
  if (nativeSqlite !== undefined) return nativeSqlite
  try {
    ;({ DatabaseSync: nativeSqlite } = require('node:sqlite'))
  } catch {
    nativeSqlite = null
  }
  return nativeSqlite
}

// 与 zcode.js 同一套探测顺序：uTools 是 GUI 应用，macOS 的 PATH 只有 /usr/bin:/bin:…，
// execFileSync('node') 会 ENOENT（且 preload 的 console.warn 渲染层看不到，静默变空数据）。
const CHILD_NODE_CANDIDATES = [
  'node',
  '/usr/local/bin/node',
  '/opt/homebrew/bin/node',
  '/usr/local/opt/node/bin/node',
  'C:\\Program Files\\nodejs\\node.exe',
]

const nodeSupportsSqlite = (version) => {
  const m = /^v(\d+)\.(\d+)\./.exec(String(version).trim())
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 22 || (major === 22 && minor >= 5)
}

let childNodeBin
const findChildNode = () => {
  if (childNodeBin !== undefined) return childNodeBin
  const { execFileSync } = require('node:child_process')
  for (const bin of CHILD_NODE_CANDIDATES) {
    try {
      const v = execFileSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5_000, windowsHide: true }).trim()
      if (nodeSupportsSqlite(v)) {
        childNodeBin = bin
        return childNodeBin
      }
    } catch {
      /* 试下一个 */
    }
  }
  childNodeBin = null
  return childNodeBin
}

/** 是否有可用的 SQLite 执行通路（含子进程回退）；没有时调用方应给出「不支持」提示 */
const sqliteAvailable = () => !!resolveNativeSqlite() || !!findChildNode()

const runNative = (dbPath, sql, DatabaseSync) => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

const runChild = (dbPath, sql) => {
  const nodeBin = findChildNode()
  if (!nodeBin) throw new Error('no usable node with node:sqlite')
  const { execFileSync } = require('node:child_process')
  const tmpScript = path.join(os.tmpdir(), `ccconfig_sqlite_read_${process.pid}.js`)
  fs.writeFileSync(
    tmpScript,
    `const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true });
const rows = db.prepare(${JSON.stringify(sql)}).all();
db.close();
process.stdout.write(JSON.stringify(rows));`
  )
  try {
    const stdout = execFileSync(nodeBin, ['--experimental-sqlite', tmpScript], {
      encoding: 'utf-8',
      timeout: 15_000,
      windowsHide: true,
    })
    return JSON.parse(stdout)
  } finally {
    try {
      fs.unlinkSync(tmpScript)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 在数据库副本上执行一条 SQL（只读）。
 * 复制是必须的：浏览器进程持有原库，直连会碰到 SQLITE_BUSY / 读到半个事务。
 */
const queryCopy = (dbPath, sql) => {
  if (!dbPath || !fs.existsSync(dbPath)) return []
  const tmpPath = path.join(os.tmpdir(), `ccconfig_sqlite_${process.pid}_${Date.now()}.sqlite`)
  fs.copyFileSync(dbPath, tmpPath)
  try {
    const DatabaseSync = resolveNativeSqlite()
    if (DatabaseSync) {
      try {
        return runNative(tmpPath, sql, DatabaseSync)
      } catch (e) {
        // 原生模块在（Node 22.5+ 但库损坏）时，别把整个功能判死，交给子进程再试一次
        if (!findChildNode()) throw e
      }
    }
    return runChild(tmpPath, sql)
  } finally {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
  }
}

module.exports = { queryCopy, sqliteAvailable, findChildNode }
