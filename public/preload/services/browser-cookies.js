// 从本机浏览器的 Cookie 库里读指定站点的 Cookie（订阅用量功能用）。
//
// 为什么要读本地库：官方站点只给了登录态（better-auth 的 HttpOnly 会话 Cookie），没有公开 API。
// 让我们自己开窗口登录会另起一套会话，用户还得再登一次；直接读他已经登录的浏览器最省事。
//
// 各平台/浏览器的差异（都是既有事实，不是猜测）：
//   Chromium 系（Chrome/Edge/Brave/Chromium/Vivaldi/Arc/ego lite 等）Cookie 值用 AES 加密：
//     macOS  密钥 = Keychain 里 "<Name> Safe Storage" 的密码，PBKDF2-SHA1(salt='saltysalt', 1003 轮, 16B)
//            密文 = 'v10' + AES-128-CBC(IV = 16 个空格)
//     Windows 密钥 = Local State 的 os_crypt.encrypted_key（DPAPI 保护），
//            密文 = 'v10'/'v11' + AES-256-GCM(nonce 12B + ct + tag 16B)
//     Chrome ≥ 130（库 meta.version ≥ 24）明文开头多 32 字节 SHA256(host_key)，要去掉。
//     Windows Chrome ≥ 127 的 'v20' 是 App-Bound 加密，密钥只能由浏览器自己的提权服务解开，
//     从外部无法解密 —— 遇到就明确报“不支持”，不要假装成功。
//   Firefox：cookies.sqlite 明文。
//   Safari：~/Library/Cookies/Cookies.binarycookies（二进制格式，非加密，但需要完全磁盘访问权限）。
//
// 浏览器清单不是硬限制：CHROMIUM_SOURCES 只是「已知 + 已知密钥名」的优先尝试顺序。
// 之后还会自动扫描用户数据目录里其它 Chromium 系应用（第三方壳浏览器、Electron 应用），
// 以及用户自己手选的目录（见 findCookies 的 customDirs）。密钥名猜不到时，
// macOS 上会从 Keychain 里按「<名字> Safe Storage」模糊匹配（security dump-keychain）。
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { queryCopy, sqliteAvailable } = require('./sqlite-query')

const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'
const HOME = os.homedir()

const expandHome = (p) => (p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p)
const exists = (p) => {
  try {
    return !!p && fs.existsSync(p)
  } catch {
    return false
  }
}

// Chromium 系浏览器：userData 目录 + （macOS）Safe Storage 的 Keychain service 名。
// keychain 允许给多个候选名：同一个应用不同版本/不同安装方式会差一个空格或大小写
// （ego lite 就是全小写的 "ego safe storage"）。
const CHROMIUM_SOURCES = [
  {
    id: 'chrome',
    name: 'Chrome',
    mac: '~/Library/Application Support/Google/Chrome',
    win: '~/AppData/Local/Google/Chrome/User Data',
    keychain: ['Chrome Safe Storage'],
  },
  {
    id: 'edge',
    name: 'Edge',
    mac: '~/Library/Application Support/Microsoft Edge',
    win: '~/AppData/Local/Microsoft/Edge/User Data',
    keychain: ['Microsoft Edge Safe Storage'],
  },
  {
    id: 'brave',
    name: 'Brave',
    mac: '~/Library/Application Support/BraveSoftware/Brave-Browser',
    win: '~/AppData/Local/BraveSoftware/Brave-Browser/User Data',
    keychain: ['Brave Safe Storage'],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    mac: '~/Library/Application Support/Chromium',
    win: '~/AppData/Local/Chromium/User Data',
    keychain: ['Chromium Safe Storage'],
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    mac: '~/Library/Application Support/Vivaldi',
    win: '~/AppData/Local/Vivaldi/User Data',
    keychain: ['Vivaldi Safe Storage'],
  },
  {
    id: 'arc',
    name: 'Arc',
    mac: '~/Library/Application Support/Arc/User Data',
    win: null,
    keychain: ['Arc Safe Storage'],
  },
  // Chrome 二次封装的第三方浏览器：数据根目录没有 "User Data" 这一层，
  // 库在 <根>/Profile N/Cookies（不是 Network/Cookies）。
  {
    id: 'ego',
    name: 'ego lite',
    mac: '~/Library/Application Support/Citro Labs/ego lite',
    win: '~/AppData/Roaming/Citro Labs/ego lite',
    keychain: ['ego safe storage', 'ego Safe Storage'],
  },
  {
    id: 'quark',
    name: 'Quark',
    mac: '~/Library/Application Support/Quark',
    win: '~/AppData/Local/Quark/User Data',
    keychain: ['Quark Safe Storage'],
  },
  {
    id: 'qqbrowser',
    name: 'QQ Browser',
    mac: '~/Library/Application Support/QQBrowser',
    win: '~/AppData/Local/Tencent/QQBrowser/User Data',
    keychain: ['QQBrowser Safe Storage'],
  },
]

const FIREFOX_MAC = '~/Library/Application Support/Firefox'
const FIREFOX_WIN = '~/AppData/Roaming/Mozilla/Firefox'

// ============ 定位 Cookie 库 ============

// profile 目录名不只有 "Default" / "Profile N"：ego 用 "Profile 1"，
// 某些壳浏览器直接用产品名当 profile 目录，甚至把 Cookies 放在根目录下。
const PROFILE_NAME = /^(Default|Default Profile|Profile \d+|User Data|Person \d+)$/i
const CHROMIUM_DB_RELS = ['Network/Cookies', 'Cookies']

/**
 * 在某个 Chromium 用户数据目录里找 Cookie 库。
 * 三级：根目录直接有 Cookies（个别壳浏览器）→ 已知命名 profile → 任意子目录（跳过缓存类目录）。
 */
const chromiumCookieDbs = (root) => {
  const out = []
  if (!exists(root)) return out
  const seen = new Set()
  const push = (db, profile) => {
    if (seen.has(db)) return
    seen.add(db)
    out.push({ db, profile })
  }
  // 1) 根目录本身就是 profile（Cookies / Network/Cookies 直接躺在数据根下）
  for (const rel of CHROMIUM_DB_RELS) {
    const db = path.join(root, rel)
    if (exists(db)) push(db, '')
  }
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  // 2) 已知命名
  for (const name of dirs) {
    if (!PROFILE_NAME.test(name)) continue
    for (const rel of CHROMIUM_DB_RELS) {
      const db = path.join(root, name, rel)
      if (exists(db)) push(db, name)
    }
  }
  // 3) 兜底：任意子目录（最坏情况只多几次 existsSync，命中不了的目录会被跳过）
  for (const name of dirs) {
    if (PROFILE_NAME.test(name) || name.startsWith('.') || SKIP_DIRS.has(name)) continue
    for (const rel of CHROMIUM_DB_RELS) {
      const db = path.join(root, name, rel)
      if (exists(db)) push(db, name)
    }
  }
  return out
}

// 缓存类目录：既没有 Cookie 库，遍历它们还特别慢（Chrome 的 Cache 动辄上万文件）
const SKIP_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'Crashpad',
  'Caches',
  'node_modules',
  'blob_storage',
  'Service Worker',
  'IndexedDB',
  'Local Storage',
  'Session Storage',
  'Sync Data',
])

// ============ 自动发现（浏览器清单之外的应用） ============

const AUTO_DISCOVERY_ROOTS = IS_WIN
  ? ['~/AppData/Local', '~/AppData/Roaming']
  : ['~/Library/Application Support', '~/Library/Containers']
const AUTO_DISCOVERY_MAX_DEPTH = IS_WIN ? 3 : 3
const DISCOVERY_SKIP_DIRS = new Set([...SKIP_DIRS, 'Temp', 'tmp', 'Logs', 'logs', 'Crash Reports'])

const knownRoots = () =>
  CHROMIUM_SOURCES.map((s) => expandHome((IS_MAC ? s.mac : s.win) || ''))
    .filter(Boolean)
    .map((p) => path.resolve(p))

/**
 * 扫描用户数据目录，找出「没写在 CHROMIUM_SOURCES 里、但确实存了 Cookie 库」的 Chromium 系应用。
 * 实测本机约 330ms（1500+ 目录），只在已知清单全都没命中时才会跑，
 * 所以正常路径（Chrome 里登录过）不会变慢。
 */
let discoveryCache = null
const discoverChromiumRoots = () => {
  if (discoveryCache) return discoveryCache
  const known = new Set(knownRoots())
  const found = []
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth > AUTO_DISCOVERY_MAX_DEPTH || seen.has(dir)) return
    seen.add(dir)
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const hasLocalState = entries.some((e) => e.isFile() && e.name === 'Local State')
    if (hasLocalState && !known.has(path.resolve(dir))) {
      // 有 Local State 只说明是个 Chromium 系应用（Lark / Electron 壳都算），
      // 还要真有 Cookie 库才值得尝试解密（否则每次都要白跑一遍密钥流程）。
      if (chromiumCookieDbs(dir).length) found.push(dir)
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const name = e.name
      if (name.startsWith('.') || name.startsWith('com.apple.') || DISCOVERY_SKIP_DIRS.has(name)) continue
      // 找到数据根之后不再往里钻：profile 目录里的 Cookies 已经被 chromiumCookieDbs 覆盖
      if (hasLocalState) continue
      walk(path.join(dir, name), depth + 1)
    }
  }
  for (const root of AUTO_DISCOVERY_ROOTS) walk(expandHome(root), 0)
  discoveryCache = found
  return found
}

// ============ Chromium 解密 ============

let macKeyCache = {}
const keychainExistence = {}
// 钥匙串弹窗没被允许时记下 service 名，UI 据此提示「请在弹出的钥匙串窗口里点允许」
let keychainBlocked = ''
const macKeyAttempted = new Set()
const MAC_KEY_TIMEOUT_FIRST = 15_000
const MAC_KEY_TIMEOUT_RETRY = 5_000
const MAC_KEY_FAIL_TTL = 60_000
const macKeyFailedAt = {}

/** Keychain 里有没有这个 service（不带 -w 只查属性，不会弹授权框，实测 20ms） */
const keychainHas = (service) => {
  if (service in keychainExistence) return keychainExistence[service]
  const { execFileSync } = require('node:child_process')
  let ok = false
  try {
    execFileSync('security', ['find-generic-password', '-s', service], {
      timeout: 3_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    ok = true
  } catch (e) {
    ok = typeof e?.status === 'number' && e.status === 0
  }
  keychainExistence[service] = ok
  return ok
}

let keychainServices = null
/**
 * Keychain 里所有「<某浏览器> Safe Storage」条目名。
 * security dump-keychain 不需要授权就能列出属性（实测 5s 内、不弹窗），
 * 用它给「清单外的浏览器」猜密钥名（ego lite 的条目就叫 "ego safe storage"）。
 */
const discoverKeychainServices = () => {
  if (keychainServices) return keychainServices
  const { execFileSync } = require('node:child_process')
  keychainServices = []
  try {
    const dump = execFileSync('security', ['dump-keychain'], {
      encoding: 'utf-8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    })
    const names = new Set()
    for (const m of dump.matchAll(/"svce"<blob>="([^"]*)"/g)) {
      if (/safe storage$/i.test(m[1])) names.add(m[1])
    }
    keychainServices = [...names]
  } catch (e) {
    console.warn('[subscriptions] 枚举 Keychain 条目失败:', e.message)
  }
  return keychainServices
}

/** 给一个应用的显示名猜它可能的 Safe Storage 条目名 */
const guessKeychainServices = (appName) => {
  const out = []
  const push = (s) => {
    if (s && !out.includes(s)) out.push(s)
  }
  const base = String(appName || '').trim()
  if (!base) return out
  push(`${base} Safe Storage`)
  push(`${base} safe storage`)
  // "ego lite" → 也试 "ego Safe Storage"（实测该应用只注册了短名）
  const first = base.split(/\s+/)[0]
  if (first && first !== base) {
    push(`${first} Safe Storage`)
    push(`${first} safe storage`)
  }
  // 最后按前缀从 Keychain 里模糊捞（大小写不敏感）
  for (const service of discoverKeychainServices()) {
    const lower = service.toLowerCase()
    if (lower.startsWith(`${base.toLowerCase()} `) || (first && lower.startsWith(`${first.toLowerCase()} `))) {
      push(service)
    }
  }
  return out
}

const macKey = (services) => {
  const cacheKey = (services || []).join('|')
  if (cacheKey in macKeyCache) return macKeyCache[cacheKey]
  // 失败结果只缓存 60 秒：用户这次点了「拒绝」，下次愿意点「允许」时不该要求重启插件
  if (macKeyFailedAt[cacheKey] && Date.now() - macKeyFailedAt[cacheKey] < MAC_KEY_FAIL_TTL) return null
  const { execFileSync } = require('node:child_process')
  let key = null
  for (const service of services || []) {
    // 已经弹过一次框且没被允许：继续试下一个条目只会再弹一次，用户体感是「卡住」，直接收手
    if (keychainBlocked) break
    // 先用不带 -w 的探测筛一遍：名字猜错时直接跳过，不必每次白等超时
    if (!keychainHas(service)) continue
    // 第一次取某个条目的密钥时给足时间：macOS 会弹授权框，用户得看到并点「允许」。
    // 之后再失败就只等 5 秒（实测没人点的时候 security 会一直挂着）。
    const first = !macKeyAttempted.has(service)
    macKeyAttempted.add(service)
    try {
      const password = execFileSync('security', ['find-generic-password', '-w', '-s', service], {
        encoding: 'utf-8',
        timeout: first ? MAC_KEY_TIMEOUT_FIRST : MAC_KEY_TIMEOUT_RETRY,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (password) {
        key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
        break
      }
    } catch (e) {
      // 被超时杀掉 = 弹窗没被点允许（拒绝会直接以非 0 退出码返回）
      if (e.signal === 'SIGKILL') keychainBlocked = service
      /* 试下一个 service 名（不同浏览器/装法名字会差一点） */
    }
  }
  if (key) {
    macKeyCache[cacheKey] = key
    delete macKeyFailedAt[cacheKey]
  } else {
    macKeyFailedAt[cacheKey] = Date.now()
  }
  return key
}

// Windows 上每个 Chromium 应用的 os_crypt 密钥各自独立（都是 DPAPI 保护的随机串），
// 所以必须按 root 分别取，不能拿 Chrome 的密钥去解 Edge 的库。
const winKeyCache = {}
const winKey = (root) => {
  if (root in winKeyCache) return winKeyCache[root]
  const { execFileSync } = require('node:child_process')
  winKeyCache[root] = null
  try {
    const localStatePath = path.join(root, 'Local State')
    if (!exists(localStatePath)) return winKeyCache[root]
    const state = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'))
    const b64 = state?.os_crypt?.encrypted_key
    if (!b64) return winKeyCache[root]
    let raw = Buffer.from(b64, 'base64')
    // 前缀 "DPAPI"（5 字节）是标记，不属于密文
    if (raw.subarray(0, 5).toString('latin1') === 'DPAPI') raw = raw.subarray(5)
    const script =
      'Add-Type -AssemblyName System.Security;' +
      `[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${raw.toString('base64')}'),$null,'CurrentUser'))`
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf-8',
      timeout: 20_000,
      windowsHide: true,
    }).trim()
    if (out) winKeyCache[root] = Buffer.from(out, 'base64')
  } catch (e) {
    console.warn('[subscriptions] 读取 Windows DPAPI 密钥失败:', e.message)
    winKeyCache[root] = null
  }
  return winKeyCache[root]
}

class AppBoundEncryption extends Error {}

/** 解一条 Chromium Cookie。返回明文；解不开返回空串（调用方按“没找到”处理） */
const decryptChromium = (encryptedRaw, key, hostKey) => {
  // node:sqlite 把 BLOB 给成 Uint8Array（不是 Buffer），直接 .toString('utf8') 会变成 "118,49,48,..."
  const encrypted = Buffer.isBuffer(encryptedRaw) ? encryptedRaw : Buffer.from(encryptedRaw)
  if (!encrypted || !encrypted.length) return ''
  const prefix = encrypted.length >= 3 ? encrypted.subarray(0, 3).toString('latin1') : ''
  if (prefix === 'v20') throw new AppBoundEncryption('v20')
  let payload = encrypted
  const versioned = prefix === 'v10' || prefix === 'v11'
  if (versioned) payload = encrypted.subarray(3)
  let plain
  if (!key) return ''
  try {
    if (IS_WIN) {
      if (!versioned) return '' // 老格式（整块 DPAPI）已随 Chrome 80 淘汰，不处理
      const nonce = payload.subarray(0, 12)
      const tag = payload.subarray(payload.length - 16)
      const body = payload.subarray(12, payload.length - 16)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      plain = Buffer.concat([decipher.update(body), decipher.final()])
    } else {
      if (!versioned) return encrypted.toString('utf8')
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
      plain = Buffer.concat([decipher.update(payload), decipher.final()])
    }
  } catch {
    return ''
  }
  // Chrome ≥ 130：明文前 32 字节是 SHA256(host_key)，用于把 Cookie 绑到域上
  if (plain.length > 32) {
    const expected = crypto.createHash('sha256').update(hostKey || '').digest()
    if (plain.subarray(0, 32).equals(expected)) plain = plain.subarray(32)
  }
  return plain.toString('utf8')
}

/**
 * 从一个 Chromium 用户数据目录读 Cookie。
 * @param {{root:string, name:string, keychain?:string[]}} source
 */
const readChromium = (source, wanted) => {
  const root = source.root
  if (!root || !exists(root)) return []
  const dbs = chromiumCookieDbs(root)
  if (!dbs.length) return []
  const names = [...wanted.names]
  if (!names.length) return []
  const nameList = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')

  // 第一阶段：只用明文列（host_key / name）判断这个库里到底有没有我们要的 Cookie。
  // 必须在碰钥匙串之前做 —— 否则每个装了的 Chromium 应用都会弹一次授权框（没点就各等 15 秒），
  // 实测「Chromium + ego lite + Quark」能卡 45 秒，而其实只有 ego lite 里有登录态。
  const candidates = []
  for (const { db } of dbs) {
    let rows = []
    try {
      rows = queryCopy(
        db,
        // expires_utc 是 WebKit 时间（~1.34e16），超出 JS 安全整数，必须转 TEXT 否则 node:sqlite 抛 ERR_OUT_OF_RANGE
        `SELECT host_key, name, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc FROM cookies WHERE name IN (${nameList})`
      )
    } catch (e) {
      console.warn(`[subscriptions] 读取 ${source.name} Cookie 库失败:`, e.message)
      continue
    }
    for (const row of rows) {
      const host = String(row.host_key || '').replace(/^\./, '')
      if (wanted.hosts.length && !wanted.hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue
      candidates.push({ row, host })
    }
  }
  if (!candidates.length) return []

  // 第二阶段：确实有目标 Cookie 才去取解密密钥（macOS 可能弹一次钥匙串授权框）
  const key = IS_MAC ? macKey(source.keychain || guessKeychainServices(source.name)) : winKey(root)
  if (!key) return []

  const out = []
  for (const { row, host } of candidates) {
    let value = ''
    try {
      value = decryptChromium(row.encrypted_value, key, String(row.host_key || ''))
    } catch (e) {
      if (e instanceof AppBoundEncryption) throw new Error('app-bound')
      throw e
    }
    if (!value) continue
    out.push({ browser: source.name, host, name: row.name, value })
  }
  return out
}

const sourceRoot = (source) => expandHome((IS_MAC ? source.mac : source.win) || '')

// ============ Firefox（明文 sqlite） ============

const FIREFOX_DB = 'cookies.sqlite'

const firefoxProfiles = (rootOverride) => {
  const root = rootOverride ? expandHome(rootOverride) : expandHome(IS_WIN ? FIREFOX_WIN : FIREFOX_MAC)
  const out = []
  // 用户手选的就是 profile 目录本身（里面直接躺着 cookies.sqlite）
  if (exists(path.join(root, FIREFOX_DB))) return [path.join(root, FIREFOX_DB)]
  const ini = path.join(root, 'profiles.ini')
  try {
    const text = fs.readFileSync(ini, 'utf-8')
    for (const line of text.split('\n')) {
      const m = /^Path=(.+)$/.exec(line.trim())
      if (!m) continue
      const p = path.isAbsolute(m[1]) ? m[1] : path.join(root, m[1])
      if (exists(path.join(p, FIREFOX_DB))) out.push(path.join(p, FIREFOX_DB))
    }
  } catch {
    /* 没装 Firefox / 不是 Firefox 目录 */
  }
  // profiles.ini 缺失时兜底：<root>/<profile>/cookies.sqlite
  if (!out.length) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const db = path.join(root, e.name, FIREFOX_DB)
      if (exists(db)) out.push(db)
    }
  }
  return out
}

const readFirefox = (wanted, roots) => {
  const out = []
  const dbs = []
  for (const root of roots || [null]) dbs.push(...firefoxProfiles(root))
  const nameList = wanted.names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')
  for (const db of dbs) {
    let rows = []
    try {
      rows = queryCopy(db, `SELECT host, name, value FROM moz_cookies WHERE name IN (${nameList})`)
    } catch (e) {
      console.warn('[subscriptions] 读取 Firefox Cookie 库失败:', e.message)
      continue
    }
    for (const row of rows) {
      const host = String(row.host || '').replace(/^\./, '')
      if (wanted.hosts.length && !wanted.hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue
      out.push({ browser: 'Firefox', host, name: row.name, value: String(row.value || '') })
    }
  }
  return out
}

// ============ Safari（binarycookies） ============

const SAFARI_DBS = [
  '~/Library/Cookies/Cookies.binarycookies',
  '~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies',
]

/** 解析 Safari 的 Cookies.binarycookies：文件头 'cook' + 页数 + 每页长度 + 若干页记录 */
const parseBinaryCookies = (buf) => {
  const cookies = []
  if (buf.length < 8 || buf.subarray(0, 4).toString('latin1') !== 'cook') return cookies
  const numPages = buf.readUInt32BE(4)
  const pageSizes = []
  let offset = 8
  for (let i = 0; i < numPages; i++) {
    pageSizes.push(buf.readUInt32BE(offset))
    offset += 4
  }
  let pageStart = offset
  for (const size of pageSizes) {
    const pageEnd = pageStart + size
    const numCookies = buf.readUInt32LE(pageStart + 4)
    const offsets = []
    for (let i = 0; i < numCookies; i++) offsets.push(buf.readUInt32LE(pageStart + 8 + i * 4))
    for (const rec of offsets) {
      let p = pageStart + rec
      const readStr = () => {
        const len = buf.readUInt32LE(p)
        p += 4
        const s = buf.subarray(p, p + len).toString('utf8')
        p += len
        return s
      }
      try {
        const recSize = buf.readUInt32LE(p)
        p += 4
        p += 4 // unknown
        const flags = buf.readUInt32LE(p)
        p += 4
        p += 4 // unknown
        const urlOffset = buf.readUInt32LE(p)
        p += 4
        const nameOffset = buf.readUInt32LE(p)
        p += 4
        const pathOffset = buf.readUInt32LE(p)
        p += 4
        p += 8 // value size / expiry
        const valueOffset = buf.readUInt32LE(p)
        p += 4
        p += 8 // expiry (float) * 2
        const recordStart = pageStart + rec
        const strAt = (off) => {
          let q = recordStart + off
          const len = buf.readUInt32LE(q)
          q += 4
          return buf.subarray(q, q + len).toString('utf8')
        }
        const url = strAt(urlOffset)
        const name = strAt(nameOffset)
        const value = strAt(valueOffset)
        void flags
        void pathOffset
        void recSize
        cookies.push({ host: url.replace(/^\./, ''), name, value })
      } catch {
        /* 单条坏了不影响其他条 */
      }
      void readStr
    }
    pageStart = pageEnd
  }
  return cookies
}

const readSafari = (wanted) => {
  const out = []
  for (const rel of SAFARI_DBS) {
    const file = expandHome(rel)
    if (!exists(file)) continue
    try {
      const buf = fs.readFileSync(file)
      for (const c of parseBinaryCookies(buf)) {
        if (!wanted.names.includes(c.name)) continue
        const host = c.host
        if (wanted.hosts.length && !wanted.hosts.some((h) => host === h || host.endsWith(`.${h}`))) continue
        out.push({ browser: 'Safari', host, name: c.name, value: c.value })
      }
    } catch (e) {
      // 未授予「完全磁盘访问权限」时会 EACCES
      console.warn('[subscriptions] 读取 Safari Cookie 库失败:', e.message)
    }
  }
  return out
}

// ============ 用户手选目录 ============

const displayNameOf = (dir) => {
  const base = path.basename(path.resolve(dir))
  // 手选到 "Profile 1" / "User Data" 这类层级时，用上一级当名字更有意义
  if (/^(Profile \d+|Default|User Data|Default Profile)$/i.test(base)) {
    return path.basename(path.dirname(path.resolve(dir))) || base
  }
  return base
}

/**
 * 判断用户选中的目录能不能读，并说明它是哪种浏览器目录。
 * UI 用它给「选目录」按钮即时反馈，避免用户选了个空目录还以为成功了。
 */
const inspectDir = (dir) => {
  if (!dir || !exists(dir)) return { ok: false, kind: 'missing' }
  const resolved = path.resolve(expandHome(String(dir)))
  const dbs = chromiumCookieDbs(resolved)
  if (dbs.length) {
    // 选中的可能是 profile 目录本身（里面有 Cookies 但没有 Local State）
    const roots = [resolved]
    const parent = path.dirname(resolved)
    if (exists(path.join(parent, 'Local State'))) roots.unshift(parent)
    return {
      ok: true,
      kind: 'chromium',
      name: displayNameOf(roots[0]),
      roots,
      dbCount: dbs.length,
    }
  }
  const ff = firefoxProfiles(resolved)
  if (ff.length) return { ok: true, kind: 'firefox', name: 'Firefox', roots: [resolved], dbCount: ff.length }
  if (/\.binarycookies$/i.test(resolved) && exists(resolved)) {
    return { ok: true, kind: 'safari', name: 'Safari', roots: [resolved], dbCount: 1 }
  }
  return { ok: false, kind: 'unknown' }
}

// ============ 对外接口 ============

/** 本机存在哪些可读的浏览器（用于 UI 提示，不做解密） */
const listBrowsers = () => {
  const list = []
  for (const source of CHROMIUM_SOURCES) {
    const root = sourceRoot(source)
    if (root && exists(root) && chromiumCookieDbs(root).length) list.push(source.name)
  }
  if (firefoxProfiles().length) list.push('Firefox')
  if (IS_MAC && SAFARI_DBS.some((rel) => exists(expandHome(rel)))) list.push('Safari')
  return list
}

/**
 * 在本机所有能想到的地方找目标 Cookie。
 *
 * 顺序（命中即止，因为每多试一个没授权的浏览器就可能白等 5 秒钥匙串超时）：
 *   1. customDirs：用户手选的目录（最可信，放在最前）
 *   2. CHROMIUM_SOURCES：已知浏览器
 *   3. 自动发现的 Chromium 系应用（清单之外的壳浏览器 / Electron 应用）
 *   4. Firefox
 *   5. Safari（macOS）
 *
 * @returns {{ cookies: Array<{browser:string,host:string,name:string,value:string}>, appBound: boolean, supported: boolean, scanned: string[], keychainBlocked: string }}
 */
const findCookies = ({ hosts = [], names = [], customDirs = [] } = {}) => {
  const supported = sqliteAvailable() || (IS_MAC && names.length > 0)
  const cookies = []
  let appBound = false
  const scanned = []
  keychainBlocked = ''
  const wanted = { hosts, names }
  if (!names.length) return { cookies, appBound, supported, scanned, keychainBlocked }
  const missing = () => names.filter((n) => !cookies.some((c) => c.name === n))
  // 命中即止；另外钥匙串授权被拒/超时后立刻收手 —— 否则每个候选应用都各自等一次超时，界面会长时间无响应
  const stop = () => !missing().length || !!keychainBlocked
  const attempt = (label, fn) => {
    scanned.push(label)
    try {
      const rows = fn()
      if (rows.length) cookies.push(...rows)
    } catch (e) {
      if (e.message === 'app-bound') appBound = true
      else console.warn(`[subscriptions] ${label} 读取失败:`, e.message)
    }
  }

  // 1) 用户手选目录
  const customRoots = []
  for (const dir of customDirs || []) {
    const info = inspectDir(dir)
    if (!info.ok) continue
    if (info.kind === 'chromium') {
      for (const root of info.roots) {
        if (customRoots.some((r) => r.root === root)) continue
        const source = { root, name: info.name, keychain: guessKeychainServices(info.name) }
        customRoots.push(source)
      }
    } else if (info.kind === 'firefox') {
      attempt('Firefox(手动目录)', () => readFirefox(wanted, info.roots))
    } else if (info.kind === 'safari') {
      attempt('Safari(手动文件)', () => {
        const buf = fs.readFileSync(info.roots[0])
        return parseBinaryCookies(buf)
          .filter((c) => wanted.names.includes(c.name))
          .filter(
            (c) => !wanted.hosts.length || wanted.hosts.some((h) => c.host === h || c.host.endsWith(`.${h}`)),
          )
          .map((c) => ({ browser: 'Safari', host: c.host, name: c.name, value: c.value }))
      })
    }
    if (stop()) break
  }
  for (const source of customRoots) {
    if (stop()) break
    attempt(source.name, () => readChromium(source, wanted))
  }

  // 2) 已知浏览器
  for (const source of CHROMIUM_SOURCES) {
    if (stop()) break
    const root = sourceRoot(source)
    if (!root || !exists(root)) continue
    attempt(source.name, () => readChromium({ root, name: source.name, keychain: source.keychain }, wanted))
  }

  // 3) 自动发现（只有前面都没命中才会走到这里，避免无谓的全盘扫描）
  if (!stop()) {
    for (const root of discoverChromiumRoots()) {
      if (stop()) break
      const name = displayNameOf(root)
      attempt(name, () => readChromium({ root, name, keychain: guessKeychainServices(name) }, wanted))
    }
  }

  // 4) Firefox
  if (!stop()) attempt('Firefox', () => readFirefox(wanted))

  // 5) Safari
  if (IS_MAC && !stop()) attempt('Safari', () => readSafari(wanted))

  // 同名 Cookie 可能来自多个浏览器：按 host 精确匹配优先
  cookies.sort((a, b) => {
    const score = (c) => (hosts.includes(c.host) ? 0 : 1)
    return score(a) - score(b)
  })
  return { cookies, appBound, supported, scanned, keychainBlocked }
}

module.exports = {
  findCookies,
  listBrowsers,
  parseBinaryCookies,
  inspectDir,
  listKnownBrowsers: () => CHROMIUM_SOURCES.map((s) => s.name),
}
