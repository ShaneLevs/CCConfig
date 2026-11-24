// 订阅用量授权开关测试：关闭时不读取本机 Cookie，也不发出刷新请求。
const store = new Map()
let rev = 0
let findCookiesCalls = 0

global.window = {
  utools: {
    getNativeId: () => 'consent-native',
    db: {
      get: (id) => {
        const doc = store.get(String(id))
        return doc ? JSON.parse(JSON.stringify(doc)) : null
      },
      put: (doc) => {
        const cur = store.get(doc._id)
        if (cur && cur._rev && doc._rev !== cur._rev) return { error: true, name: 'conflict' }
        store.set(doc._id, { ...doc, _rev: `${++rev}-x` })
        return { ok: true }
      },
      remove: (id) => {
        store.delete(typeof id === 'object' ? id._id : id)
        return { ok: true }
      },
    },
    shellOpenExternal: () => {},
    showOpenDialog: () => null,
  },
}

require.cache[require.resolve('../public/preload/services/browser-cookies.js')] = {
  id: 'browser-cookies-stub',
  filename: 'browser-cookies-stub',
  loaded: true,
  exports: {
    findCookies: () => {
      findCookiesCalls += 1
      return { cookies: [], appBound: false, supported: true, scanned: [], keychainBlocked: '' }
    },
    inspectDir: () => ({ ok: false, kind: 'unknown' }),
  },
}

const subs = require('../public/preload/services/subscriptions')

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

const initial = subs.getSubscriptionConsent()
ok(initial.enabled === false && initial.answered === false, '首次使用默认未授权')

let disabledCode = ''
try { subs.captureCookie('open-design') } catch (e) { disabledCode = e.code }
ok(disabledCode === 'disabled', '未授权时读取 Cookie 被拒绝')
ok(findCookiesCalls === 0, '未授权时没有扫描本机浏览器')

subs.setSubscriptionConsent(true)
const enabled = subs.getSubscriptionConsent()
ok(enabled.enabled === true && enabled.answered === true, '同意后授权生效并留痕')
try { subs.captureCookie('open-design') } catch (e) { disabledCode = e.code }
ok(findCookiesCalls === 1, '授权后可以扫描本机浏览器')

subs.setSubscriptionConsent(false)
const disabled = subs.getSubscriptionConsent()
ok(disabled.enabled === false && disabled.answered === true, '关闭后保留已回答状态')
disabledCode = ''
try { subs.captureCookie('open-design') } catch (e) { disabledCode = e.code }
ok(disabledCode === 'disabled', '关闭后读取 Cookie 被拒绝')
ok(findCookiesCalls === 1, '关闭后没有再次扫描本机浏览器')

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed) process.exit(1)
