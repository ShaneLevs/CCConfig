// 「订阅」用量：用户手动添加已订阅的服务，插件用本机浏览器的登录态（Cookie）代他查用量，
// 结果同时显示在订阅页和桌面版菜单栏（托盘）里。
//
// 为什么是 Cookie 而不是 API Key / OAuth：
//   open-design 这类站点只给浏览器登录态（better-auth 的 HttpOnly 会话 Cookie），
//   没有公开的用量接口和 token 分发。用户在浏览器里已经登录了，我们就直接读那份 Cookie
//   去请求它自己前端调用的接口，不额外要一次登录。
//
// 结构：
//   ADAPTERS  每个站点一个适配器（接口路径、Cookie 域名、返回结构解析都不同）
//   storage   DB 文档 ccconfig_subscriptions_<nativeId>；Cookie 经 crypto.encrypt 落盘（AES-256-CBC）
//   fetch     node:https 直连；返回值必须是纯 JSON 可往返结构（桌面版走 HTTP JSON）
//
// 密钥只在 sidecar/preload 里解密，getSubscriptions() 返回给渲染层的数据不含 Cookie 原文。
const https = require('node:https')
const crypto = require('./crypto')
const { findCookies, inspectDir } = require('./browser-cookies')
const { t } = require('./i18n')

const DOC_PREFIX = 'ccconfig_subscriptions_'

// 每 5 分钟最多自动查一次（用户手动刷新不受限）：接口没有 ratelimit 头，但也没必要一直打
const AUTO_REFRESH_MS = 5 * 60 * 1000
// 单次请求超时：open-design 实测约 800ms，给足余量但仍要能失败（托盘/UI 会等）
const REQUEST_TIMEOUT_MS = 15 * 1000

// 错误码 → 渲染层按 code 决定是「去登录」还是「稍后重试」，不靠 message 字符串匹配
const ERR_UNAUTHORIZED = 'unauthorized'
const ERR_NETWORK = 'network'
const ERR_HTTP = 'http'
const ERR_EMPTY = 'empty'

const makeError = (code, message, extra) => Object.assign(new Error(message), { code, ...extra })

// ==================== HTTP ====================

/**
 * GET 一个 JSON。只用 Cookie 头就够（实测不需要 UA/Origin/Referer，也没有 CORS —— 这里是 Node 直连）。
 * 404/500 等非 2xx 抛 ERR_HTTP；401 抛 ERR_UNAUTHORIZED，让上层引导重新登录。
 */
const getJson = (url, cookie) =>
  new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      return reject(makeError(ERR_HTTP, `bad url: ${url}`))
    }
    const req = https.get(
      target,
      {
        headers: {
          Cookie: cookie,
          Accept: 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (raw += chunk))
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(makeError(ERR_UNAUTHORIZED, 'unauthorized', { status: res.statusCode }))
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(makeError(ERR_HTTP, `HTTP ${res.statusCode}`, { status: res.statusCode }))
          }
          if (!raw) return resolve(null)
          try {
            resolve(JSON.parse(raw))
          } catch {
            reject(makeError(ERR_HTTP, 'invalid json'))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(makeError(ERR_NETWORK, 'timeout')))
    req.on('error', (e) => reject(e.code === ERR_UNAUTHORIZED ? e : makeError(ERR_NETWORK, e.message)))
  })

const localTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// 接口把 credits / 金额都当**字符串**返回（"2265"、"1.0000"），直接判 typeof number 会全变 null
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

// ==================== 适配器 ====================

// 窗口时长 → 稳定 key（UI 文案按 key 取，不按中文/英文硬编码）
const windowKeyOf = (durationSeconds) => {
  if (durationSeconds === 18000) return 'session' // 5 小时
  if (durationSeconds === 604800) return 'week'
  if (durationSeconds >= 86400) return `d${Math.round(durationSeconds / 86400)}`
  return `h${Math.round(durationSeconds / 3600)}`
}

const openDesign = {
  id: 'open-design',
  // Better Auth 的 Cookie 域名是 amr-api，页面在 open-design.ai —— 两个域都要找
  cookieHosts: ['amr-api.open-design.ai', 'open-design.ai'],
  cookieNames: ['__Secure-better-auth.session_token'],
  loginUrl: 'https://open-design.ai/cloud/dashboard',
  apiBase: 'https://amr-api.open-design.ai',

  /**
   * 站点的数据分散在 4 个接口，且 workspaceId 不能硬编码：
   *   get-session        → 校验登录态（失效时返回 200 null，不是 401，必须单独判）
   *   workspaces/current → workspaceId / 套餐
   *   billing/summary    → 订阅周期、余额、creditsPerUsd
   *   coding-plan-usage  → 5h / 周 窗口的 usedCredits / limitCredits / resetsAt
   */
  async fetchUsage(cookie) {
    const base = this.apiBase
    const session = await getJson(`${base}/api/auth/get-session`, cookie)
    if (!session || !session.session) {
      throw makeError(ERR_UNAUTHORIZED, 'session expired')
    }
    const workspace = await getJson(`${base}/api/v1/workspaces/current`, cookie)
    const workspaceId = workspace?.workspaceId
    if (!workspaceId) throw makeError(ERR_EMPTY, 'no workspace')

    const timeZone = encodeURIComponent(localTimeZone())
    const summary = await getJson(`${base}/api/v1/billing/summary?timeZone=${timeZone}`, cookie)
    const usage = await getJson(
      `${base}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/coding-plan-usage`,
      cookie,
    )

    const creditsPerUsd = num(summary?.creditsPerUsd) || 10000
    const windows = Array.isArray(usage?.windows)
      ? usage.windows
          .map((w) => ({
            key: windowKeyOf(w.durationSeconds),
            durationSeconds: num(w.durationSeconds),
            usedCredits: num(w.usedCredits),
            limitCredits: num(w.limitCredits),
            remainingCredits: num(w.remainingCredits),
            windowStart: w.windowStart || null,
            resetsAt: w.resetsAt || null,
          }))
          // 短窗口在前（5h 比周更容易用满，用户先看它）
          .sort((a, b) => (a.durationSeconds || 0) - (b.durationSeconds || 0))
      : []

    return {
      workspaceId,
      workspaceName: workspace?.workspaceName || '',
      account: {
        name: session.user?.name || '',
        email: session.user?.email || '',
      },
      plan: summary?.membershipTier || usage?.tier || workspace?.personalMembershipTier || '',
      status: summary?.subscriptionStatus || '',
      creditsPerUsd,
      balanceUsd: num(summary?.balanceUsd),
      consumedTotalUsd: num(summary?.totalConsumedUsd),
      consumedTodayUsd: num(summary?.todayConsumedUsd),
      subscriptionCreditsUsd: num(summary?.subscriptionCreditsUsd),
      periodStart: summary?.subscriptionCurrentPeriodStart || null,
      periodEnd: summary?.subscriptionCurrentPeriodEnd || null,
      cancelAtPeriodEnd: !!summary?.subscriptionCancelAtPeriodEnd,
      eligible: usage?.eligible !== false,
      windows,
    }
  },
}

const ADAPTERS = { [openDesign.id]: openDesign }

const getAdapter = (provider) => ADAPTERS[provider] || null

// 站点展示名（品牌名，不翻译）。新增适配器时在这里补一条。
const PROVIDER_LABELS = { 'open-design': 'Open Design' }
const providerLabelOf = (provider) => PROVIDER_LABELS[provider] || provider || ''

// 供 UI 用：可用站点清单（不含 Cookie 域名等实现细节）
const getProviders = () =>
  Object.values(ADAPTERS).map((a) => ({
    id: a.id,
    label: providerLabelOf(a.id),
    loginUrl: a.loginUrl,
  }))

// ==================== 存储 ====================

const docId = () => `${DOC_PREFIX}${window.utools.getNativeId()}`

const readDoc = () => {
  try {
    const doc = window.utools.db.get(docId())
    return Array.isArray(doc?.items) ? doc.items : []
  } catch (e) {
    console.error('[subscriptions] 读取订阅失败:', e)
    return []
  }
}

const writeDoc = (items) => {
  const id = docId()
  const doc = { _id: id, nativeId: window.utools.getNativeId(), items, updatedAt: Date.now() }
  const existing = window.utools.db.get(id)
  if (existing) doc._rev = existing._rev
  const res = window.utools.db.put(doc)
  if (res?.error) throw new Error(res.message || res.error)
  return items
}

// 对外结构：去掉 Cookie 原文（只留「有没有存」的标记），并补上站点元信息
const publicItem = (item) => {
  const adapter = getAdapter(item.provider)
  return {
    id: item.id,
    provider: item.provider,
    providerLabel: providerLabelOf(item.provider),
    label: item.label || '',
    loginUrl: adapter?.loginUrl || '',
    hasCookie: !!item.cookie,
    cookieSource: item.cookieSource || '',
    // 用户手选的浏览器数据目录（不是敏感信息，回给 UI 才能显示/移除）
    cookieDirs: normalizeDirs(item.cookieDirs),
    snapshot: item.snapshot || null,
    lastError: item.lastError || '',
    lastErrorAt: item.lastErrorAt || 0,
    // 渲染层据此显示「登录已过期」标签并高亮「重新读取登录态」按钮
    cookieExpired: !!item.cookieExpired,
    updatedAt: item.updatedAt || 0,
  }
}

const getSubscriptions = () => readDoc().map(publicItem)

const newId = () => `sub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

// 用户手选的浏览器数据目录：去空、去重、最多 8 条（多余的无意义，且每条都会多试一次钥匙串）
const normalizeDirs = (dirs) =>
  Array.from(
    new Set((Array.isArray(dirs) ? dirs : []).map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean)),
  ).slice(0, 8)

const cookieHeaderOf = (item) => {
  if (!item.cookie) return ''
  try {
    return crypto.decrypt(item.cookie)
  } catch (e) {
    console.error('[subscriptions] 解密 Cookie 失败:', e)
    return ''
  }
}

// ==================== 查询用量 ====================

const refreshOne = async (item) => {
  const adapter = getAdapter(item.provider)
  if (!adapter) throw makeError(ERR_EMPTY, `unknown provider: ${item.provider}`)
  const cookie = cookieHeaderOf(item)
  if (!cookie) throw makeError(ERR_UNAUTHORIZED, 'no cookie')
  const snapshot = await adapter.fetchUsage(cookie)
  return { ...snapshot, fetchedAt: Date.now() }
}

/**
 * 刷新一条订阅并写回快照。
 * 失败时**不删 Cookie**（多数是断网/接口抽风），只记 lastError；
 * 但 unauthorized 明确说明登录态没了 → 标记 cookieExpired，UI 引导重新登录。
 */
const refreshSubscription = async (id) => {
  const items = readDoc()
  const index = items.findIndex((i) => i.id === id)
  if (index < 0) throw new Error('not found')
  const item = items[index]
  try {
    const snapshot = await refreshOne(item)
    items[index] = {
      ...item,
      snapshot,
      workspaceId: snapshot.workspaceId || item.workspaceId || '',
      lastError: '',
      lastErrorAt: 0,
      cookieExpired: false,
      updatedAt: Date.now(),
    }
    writeDoc(items)
    return publicItem(items[index])
  } catch (e) {
    items[index] = {
      ...item,
      lastError: e.code || 'error',
      lastErrorAt: Date.now(),
      // 只有登录态过期才建议重新抓 Cookie；网络/HTTP 错误不要误导用户去重登
      cookieExpired: e.code === ERR_UNAUTHORIZED,
    }
    writeDoc(items)
    const err = makeError(e.code || ERR_HTTP, e.message)
    err.item = publicItem(items[index])
    throw err
  }
}

// 并发的 refreshAll（UI 进入 + 托盘展开同时触发）不该叠成一堆重复请求：
// 同一时刻只跑一轮，后来的直接拿到当前列表。
let refreshingAll = false

const refreshAll = async ({ force = false } = {}) => {
  if (refreshingAll) return getSubscriptions()
  const items = readDoc()
  const now = Date.now()
  const targets = items.filter(
    (i) => force || !i.updatedAt || now - i.updatedAt > AUTO_REFRESH_MS || i.cookieExpired,
  )
  if (!targets.length) return getSubscriptions()
  refreshingAll = true
  const results = []
  try {
    for (const item of targets) {
      try {
        results.push(await refreshSubscription(item.id))
      } catch (e) {
        results.push(e.item || publicItem(item))
      }
    }
  } finally {
    refreshingAll = false
  }
  return getSubscriptions()
}

// ==================== Cookie 获取 ====================

/**
 * 从本机浏览器读 Cookie（同步、单次、几百毫秒）。UI 侧用「点按钮 → 立刻调」而不是长轮询，
 * 桌面版 bridge 的 RPC 有 35s 上限，慢操作不���塞在里面。
 *
 * customDirs：用户手选的浏览器数据目录，优先级高于内置清单（读不到时的补救手段）。
 */
const captureCookie = (provider, { customDirs = [] } = {}) => {
  const adapter = getAdapter(provider)
  if (!adapter) return { found: false, error: 'unknown_provider' }
  const result = findCookies({
    hosts: adapter.cookieHosts,
    names: adapter.cookieNames,
    customDirs: Array.isArray(customDirs) ? customDirs : [],
  })
  const hit = result.cookies.find((c) => adapter.cookieNames.includes(c.name))
  if (!hit) {
    return {
      found: false,
      appBound: !!result.appBound,
      supported: !!result.supported,
      // 钥匙串授权框没被点允许时，macOS 只能读到密文 → UI 要专门提示「去点允许」
      keychainBlocked: result.keychainBlocked || '',
      browsers: Array.isArray(result.cookies) ? result.cookies.map((c) => c.browser) : [],
    }
  }
  return {
    found: true,
    browser: hit.browser,
    // 完整 Cookie 头：目前只有一个会话 Cookie，但保留通用形状（多 Cookie 站点不需要改结构）
    header: `${hit.name}=${hit.value}`,
    keychainBlocked: result.keychainBlocked || '',
  }
}

/**
 * 让用户手选一个浏览器数据目录（浏览器清单之外的兜底）。
 * 返回 {ok, dir, kind, name, dbCount} 或 {ok:false, canceled:true}；
 * 目录存在但没有 Cookie 库时 ok:false + kind:'unknown'，UI 据此提示选错了。
 */
// 声明成 async：桌面版 bridge 因此走异步任务通道（不阻塞 WebView），
// uTools 版直接 await 一个同步就能拿到的结果，两边语义一致。
const pickCookieDir = async () => {
  let picked = null
  try {
    picked = window.utools.showOpenDialog({
      title: t('service.subscription.pickDirTitle'),
      properties: ['openDirectory'],
      buttonLabel: t('service.subscription.pickDirConfirm'),
    })
  } catch (e) {
    console.error('[subscriptions] 选择目录失败:', e)
    return { ok: false, error: 'dialog_failed' }
  }
  const dir = Array.isArray(picked) ? picked[0] : picked
  if (!dir) return { ok: false, canceled: true }
  const info = inspectDir(dir)
  if (!info.ok) return { ok: false, dir, kind: info.kind || 'unknown', error: 'no_cookie_db' }
  return { ok: true, dir, kind: info.kind, name: info.name, dbCount: info.dbCount }
}

// 打开系统默认浏览器让用户登录（登录完回来点「读取 Cookie」即可）
const openLogin = (provider) => {
  const adapter = getAdapter(provider)
  if (!adapter) return false
  try {
    window.utools.shellOpenExternal(adapter.loginUrl)
    return true
  } catch (e) {
    console.error('[subscriptions] 打开登录页失败:', e)
    return false
  }
}

// ==================== 增删改 ====================

/**
 * 添加订阅。cookie 可以不传 → 自动从本机浏览器读；读不到就报 not_found，
 * UI 据此弹「打开浏览器登录 → 再读取」的引导，而不是让用户手抄 Cookie。
 */
const addSubscription = async ({ provider, label, cookie, cookieSource, cookieDirs } = {}) => {
  const adapter = getAdapter(provider)
  if (!adapter) throw makeError(ERR_EMPTY, 'unknown_provider')

  const dirs = normalizeDirs(cookieDirs)
  let header = cookie || ''
  let source = cookieSource || ''
  if (!header) {
    const captured = captureCookie(provider, { customDirs: dirs })
    if (!captured.found) {
      const err = makeError('not_found', 'cookie not found')
      err.appBound = captured.appBound
      err.keychainBlocked = captured.keychainBlocked || ''
      throw err
    }
    header = captured.header
    source = captured.browser || ''
  }
  if (!/^[^=;]+=/.test(header)) throw makeError(ERR_EMPTY, 'invalid cookie')

  // 先查一次：Cookie 无效就不该存进去，避免列表里多一条永远显示「未登录」的记录
  const snapshot = await adapter.fetchUsage(header)

  const items = readDoc()
  const item = {
    id: newId(),
    provider,
    label: label || snapshot.account?.email || '',
    cookie: crypto.encrypt(header),
    cookieSource: source,
    cookieDirs: dirs,
    workspaceId: snapshot.workspaceId || '',
    snapshot: { ...snapshot, fetchedAt: Date.now() },
    lastError: '',
    lastErrorAt: 0,
    cookieExpired: false,
    updatedAt: Date.now(),
  }
  items.push(item)
  writeDoc(items)
  return publicItem(item)
}

const updateSubscription = async ({ id, label, cookie, cookieSource, cookieDirs } = {}) => {
  const items = readDoc()
  const index = items.findIndex((i) => i.id === id)
  if (index < 0) throw new Error('not found')
  const item = { ...items[index] }
  if (typeof label === 'string') item.label = label
  if (cookieDirs !== undefined) item.cookieDirs = normalizeDirs(cookieDirs)
  if (cookie) {
    if (!/^[^=;]+=/.test(cookie)) throw makeError(ERR_EMPTY, 'invalid cookie')
    const adapter = getAdapter(item.provider)
    if (!adapter) throw makeError(ERR_EMPTY, 'unknown_provider')
    item.cookie = crypto.encrypt(cookie)
    item.cookieSource = cookieSource || ''
    item.snapshot = { ...(await adapter.fetchUsage(cookie)), fetchedAt: Date.now() }
    item.lastError = ''
    item.lastErrorAt = 0
    item.cookieExpired = false
    // 只改名字不算「取数」，不碰 updatedAt：它同时是自动刷新的节流基准，
    // 改名顺手把它推后会让用量白白陈旧 5 分钟。
    item.updatedAt = Date.now()
  }
  items[index] = item
  writeDoc(items)
  return publicItem(item)
}

const deleteSubscription = (id) => {
  const items = readDoc().filter((i) => i.id !== id)
  writeDoc(items)
  return getSubscriptions()
}

/**
 * 用新 Cookie 换掉过期的登录态（UI 上的「重新登录」按钮）。
 * 与 updateSubscription 的区别：这里强制重新读浏览器 Cookie。
 */
const reloginSubscription = async (id) => {
  const items = readDoc()
  const item = items.find((i) => i.id === id)
  if (!item) throw makeError(ERR_EMPTY, 'not found')
  const captured = captureCookie(item.provider, { customDirs: normalizeDirs(item.cookieDirs) })
  if (!captured.found) throw makeError('not_found', 'cookie not found')
  return updateSubscription({ id, cookie: captured.header, cookieSource: captured.browser || '' })
}

// ==================== 托盘菜单 ====================

const fmtUsd = (credits, creditsPerUsd) => {
  if (credits === null || credits === undefined) return ''
  const rate = creditsPerUsd || 10000
  return `$${(credits / rate).toFixed(2)}`
}

// 窗口名（5 小时 / 本周）；未知时长（如 d3）回落到原始 key，不留 i18n 路径
const windowLabelOf = (key) => {
  const text = t(`service.subscription.window.${key}`)
  return text.startsWith('service.subscription.') ? key : text
}

// 剩余百分比：托盘和卡片都按「还剩多少」说话，用户关心的是余额不是已消耗
const remainingPercentOf = (w) => {
  const used = num(w?.usedCredits) || 0
  const limit = num(w?.limitCredits) || 0
  if (limit <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((limit - used) / limit) * 100)))
}

const formatReset = (iso) => {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const minutes = Math.round((ts - Date.now()) / 60000)
  if (minutes <= 0) return t('service.subscription.resetSoon')
  if (minutes < 60) return t('service.subscription.resetInMinutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('service.subscription.resetInHours', { n: hours })
  return t('service.subscription.resetInDays', { n: Math.round(hours / 24) })
}

/**
 * 桌面版托盘弹窗用的数据（`desktop/tray.html` 直接渲染，不再拼成菜单文本）。
 * 文案仍在 sidecar 侧本地化好，且**只读缓存快照、不发网络请求**：
 * 弹窗打开时先渲染这份缓存，再用异步通道 refreshSubscriptions 刷新后原地更新。
 *
 * 每条返回：
 *   title   「站点品牌 · 套餐」（来源第一要素，用户要能看出是哪个服务）
 *   email   账号邮箱（没有则为空串）
 *   state   'ok' | 'expired' | 'nodata'
 *   windows [{ key, label, percent }] —— percent 是**剩余**百分比，进度条按它画
 *   message 过期 / 无数据时给用户看的提示（已本地化）
 * 不再显示金额与重置时间 —— 托盘里只要「还剩多少」。
 */
const getSubscriptionsTray = () => {
  const items = readDoc()
  return items.map((item) => {
    const snap = item.snapshot || null
    const providerLabel = providerLabelOf(item.provider)
    const plan = snap?.plan || ''
    const title = plan ? `${providerLabel} · ${plan}` : providerLabel
    const email = snap?.account?.email || ''
    if (item.cookieExpired) {
      return {
        id: item.id,
        title,
        email,
        state: 'expired',
        windows: [],
        message: t('service.subscription.trayExpired'),
      }
    }
    if (!snap) {
      return {
        id: item.id,
        title,
        email,
        state: 'nodata',
        windows: [],
        message: t('service.subscription.trayNoData'),
      }
    }
    const windows = Array.isArray(snap.windows)
      ? snap.windows
          .filter((w) => w && w.key)
          .map((w) => ({
            key: w.key,
            label: windowLabelOf(w.key),
            percent: remainingPercentOf(w),
          }))
      : []
    return {
      id: item.id,
      title,
      email,
      state: windows.length ? 'ok' : 'nodata',
      windows,
      message: windows.length ? '' : t('service.subscription.trayNoData'),
    }
  })
}

module.exports = {
  getProviders,
  getSubscriptions,
  addSubscription,
  updateSubscription,
  deleteSubscription,
  refreshSubscription,
  refreshAll,
  reloginSubscription,
  captureCookie,
  pickCookieDir,
  openLogin,
  getSubscriptionsTray,
  AUTO_REFRESH_MS,
  // 冒烟测试用
  _internal: { windowKeyOf, formatReset, readDoc, writeDoc, cookieHeaderOf, remainingPercentOf },
}
