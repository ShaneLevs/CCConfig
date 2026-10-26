// subscriptions.js 冒烟测试：node tests/smoke-subscriptions.cjs（仓库根目录运行）
//
// 只测「不联网」的部分：存储文档、对外结构脱敏、托盘行文案、窗口/倒计时换算。
// 真正打接口（open-design）的路径不在单测里跑 —— 它依赖本机浏览器 Cookie 与网络，
// 用手工脚本验证（见 docs/architecture.md「订阅用量」小节）。
const path = require('node:path')
process.env.CCCONFIG_LOCALE = process.env.CCCONFIG_LOCALE || 'zh-CN'

// ---- window.utools 内存桩（在 require 服务模块之前就位）----
const store = new Map()
let rev = 0
global.window = {
  utools: {
    getNativeId: () => 'test-native-id',
    db: {
      get: (id) => {
        const doc = store.get(id)
        return doc ? JSON.parse(JSON.stringify(doc)) : null
      },
      put: (doc) => {
        const next = { ...doc, _rev: `${++rev}-x` }
        store.set(doc._id, next)
        return { ok: true, id: doc._id, rev: next._rev }
      },
      remove: (id) => {
        store.delete(id)
        return { ok: true }
      },
    },
    shellOpenExternal: () => {},
  },
}

const subs = require('../public/preload/services/subscriptions')
const { windowKeyOf, formatReset, writeDoc, readDoc } = subs._internal

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)

// ==================== 1. 适配器与纯函数 ====================
console.log('1. 适配器与纯函数')
const providers = subs.getProviders()
ok(providers.length === 1 && providers[0].id === 'open-design', 'getProviders 目前只暴露 open-design')
ok(providers[0].loginUrl === 'https://open-design.ai/cloud/dashboard', 'loginUrl 指向用量页面')
eq(windowKeyOf(18000), 'session', '18000s = 5 小时会话窗口')
eq(windowKeyOf(604800), 'week', '604800s = 周窗口')
eq(windowKeyOf(86400), 'd1', '86400s 落 d1')
eq(windowKeyOf(7200), 'h2', '7200s 落 h2')
eq(formatReset(new Date(Date.now() - 1000).toISOString()), '即将重置', '已到重置时间显示「即将重置」')
eq(formatReset(''), '', '空值不抛错、返回空串')

// 手抄 Cookie 的规整：用户在 DevTools 里看到的是「名称 / 值」两列，只粘值是最自然的动作
const { normalizeCookieInput } = subs._internal
const odNames = { cookieNames: ['__Secure-better-auth.session_token'] }
eq(
  normalizeCookieInput('stTb6fr9Hq4kHzgl3B2h1KT6sJcvl89X.leov2Mnvst3aF27gQbZbKTOL00mVRV7W0%2FM7NzkY8wk%3D', odNames),
  '__Secure-better-auth.session_token=stTb6fr9Hq4kHzgl3B2h1KT6sJcvl89X.leov2Mnvst3aF27gQbZbKTOL00mVRV7W0%2FM7NzkY8wk%3D',
  '只粘值（URL 编码带 %3D）→ 自动补全名称',
)
// 用户粘贴的往往是解码后的值（末尾那个 = 是 base64 填充符，不是名称分隔符）
eq(
  normalizeCookieInput('stTb6fr9Hq4kHzgl3B2h1KT6sJcvl89X.leov2Mnvst3aF27gQbZbKTOL00mVRV7W0/M7NzkY8wk=', odNames),
  '__Secure-better-auth.session_token=stTb6fr9Hq4kHzgl3B2h1KT6sJcvl89X.leov2Mnvst3aF27gQbZbKTOL00mVRV7W0/M7NzkY8wk=',
  '只粘值（解码后末尾带 =）→ 仍补全名称，不被当成 header',
)
eq(
  normalizeCookieInput('  "__Secure-better-auth.session_token=abc%3D"  ', odNames),
  '__Secure-better-auth.session_token=abc%3D',
  '带引号和空格 → 去掉包裹',
)
eq(
  normalizeCookieInput('Cookie: __Secure-better-auth.session_token=abc', odNames),
  '__Secure-better-auth.session_token=abc',
  '带「Cookie: 」前缀 → 去掉',
)
eq(
  normalizeCookieInput('__Secure-better-auth.session_token=abc%3D', odNames),
  '__Secure-better-auth.session_token=abc%3D',
  '已带正确名称 → 不重复补',
)
eq(normalizeCookieInput('', odNames), '', '空输入返回空串')
eq(
  normalizeCookieInput('a=1; b=2', odNames),
  'a=1; b=2',
  '多段 Cookie 原样保留（不按第一段拆）',
)

// ==================== 2. 存储与脱敏 ====================
console.log('2. 存储与脱敏')
eq(readDoc(), [], '空库读出空数组')
const snapshot = {
  workspaceId: 'ws_1',
  plan: 'go',
  status: 'active',
  creditsPerUsd: 10000,
  account: { name: 'Shanelevs', email: 'a@b.c' },
  periodStart: '2026-10-23T00:00:00.000Z',
  periodEnd: '2026-11-23T00:00:00.000Z',
  windows: [
    { key: 'session', durationSeconds: 18000, usedCredits: 2000, limitCredits: 50000, resetsAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
    { key: 'week', durationSeconds: 604800, usedCredits: 21700, limitCredits: 150000, resetsAt: new Date(Date.now() + 3 * 86400 * 1000).toISOString() },
  ],
}
writeDoc([
  {
    id: 's1',
    provider: 'open-design',
    label: 'Open Design',
    cookie: 'encrypted-blob',
    cookieSource: 'Chrome',
    snapshot: { ...snapshot, fetchedAt: Date.now() },
    lastError: '',
    lastErrorAt: 0,
    cookieExpired: false,
    updatedAt: Date.now(),
  },
  // 登录态失效的那种：有旧快照但要标过期
  {
    id: 's2',
    provider: 'open-design',
    label: 'Expired',
    cookie: 'encrypted-blob-2',
    snapshot: { ...snapshot, fetchedAt: Date.now() },
    lastError: 'unauthorized',
    lastErrorAt: Date.now(),
    cookieExpired: true,
    updatedAt: Date.now(),
  },
  // 从没成功抓过数据
  { id: 's3', provider: 'open-design', label: 'Fresh', cookie: 'encrypted-blob-3', snapshot: null, lastError: 'network', cookieExpired: false },
])

const list = subs.getSubscriptions()
eq(list.length, 3, '三条记录都能读出')
ok(!('cookie' in list[0]), '对外结构不含 cookie 原文')
ok(list[0].hasCookie === true, 'hasCookie 标记存在')
ok(list[2].cookieExpired === false && list[1].cookieExpired === true, 'cookieExpired 透传到渲染层')
eq(list[0].providerLabel, 'Open Design', 'providerLabel 用于展示')

// ==================== 3. 托盘弹窗数据 ====================
console.log('3. 托盘弹窗数据')
const tray = subs.getSubscriptionsTray()
eq(tray.length, 3, '每条订阅一项')
eq(tray[0].title, 'Open Design · go', '标题 = 站点品牌 · 套餐')
eq(tray[0].email, 'a@b.c', '邮箱单独返回，由弹窗排版')
eq(tray[0].state, 'ok', '正常记录 state=ok')
eq(tray[0].windows.length, 2, '两个窗口各一条进度')
eq(tray[0].windows[0].label, '5 小时', '窗口名已本地化')
eq(tray[0].windows[0].percent, 96, '5h 剩余 96%（2000/50000 已用）')
eq(tray[0].windows[1].label, '本周', '周窗口名已本地化')
eq(tray[0].windows[1].percent, 86, '周剩余 86%（21700/150000 已用）')
ok(!/\$/.test(JSON.stringify(tray[0])), '不返回金额')
eq(tray[1].state, 'expired', '过期订阅 state=expired')
eq(tray[1].windows, [], '过期不给过期进度条')
eq(tray[1].message, '登录已过期，请在插件里重新登录', '过期提示已本地化')
eq(tray[2].state, 'nodata', '无快照 state=nodata')
eq(tray[2].message, '暂无数据，打开插件刷新', '无数据提示已本地化')

// ==================== 4. 删除 ====================
console.log('4. 删除')
const afterDelete = subs.deleteSubscription('s3')
eq(afterDelete.length, 2, '删除后剩两条')
eq(readDoc().length, 2, '删除已落库')
eq(subs.getSubscriptionsTray().length, 2, '托盘同步减少')

// ==================== 5. 名称修改不联网 ====================
console.log('5. 名称修改')
const docId = `ccconfig_subscriptions_test-native-id`
const beforeUpdatedAt = readDoc().find((i) => i.id === 's1').updatedAt
subs
  .updateSubscription({ id: 's1', label: '我的 Open Design' })
  .then((item) => {
    eq(item.label, '我的 Open Design', '只传 label 时改名生效')
    ok(item.hasCookie === true, '改名不动 Cookie')
    eq(readDoc().find((i) => i.id === 's1').updatedAt, beforeUpdatedAt, '改名不推进 updatedAt（节流基准）')
    const afterDeleteById = subs.deleteSubscription('s1')
    ok(Array.isArray(afterDeleteById) && afterDeleteById.length === 1, '按 id 删除返回剩余列表')
    ok(store.get(docId) !== undefined, '文档仍存在（只是少了一条）')
    finish()
  })
  .catch((e) => {
    failed++
    console.error('  ✗ updateSubscription 抛错：', e.message)
    finish()
  })

function finish() {
  console.log(`\n${failed === 0 ? '✅' : '❌'} passed=${passed} failed=${failed}`)
  process.exit(failed === 0 ? 0 : 1)
}
