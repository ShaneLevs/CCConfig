// App.vue 路由白名单一致性测试：node tests/smoke-app-routes-test.cjs（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
//
// 背景：index.html 挂载的 <Switch> 由 App.vue 的一条 v-if 白名单把关——
//   <Switch v-if="['claudeConfig', ..., 'commonConfig', ...].includes(route)" />
// onPluginEnter 把 uTools 指令的 action.code 写进 route，只有命中白名单才会渲染页面，
// 没命中就是纯白屏（且不报错）。v1.1.2 加 Cline 时漏了这一处，用户从「Cline配置」
// 指令进入看到空白页，排查了很久才定位。
//
// 本测试静态解析源码（不加载 Vue），断言：
//   1. APP_TABS 的每个 key（= agent id）都能在白名单里找到对应路由码
//   2. DEEP_LINK_ROUTES 的每个 route 也在白名单里
//   3. index.vue 的 appMap 覆盖 APP_TABS 的每个 key，且其路由码 == 白名单里的码
//   4. 白名单里没有多余项（没人消费的路由码 = 拼写错误的信号）
//
// 约定：agent → 路由码 = agent id + "Config"（common → "commonConfig"），
// 与 src/Switch/index.vue 的 appMap 一致。
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}

// ==================== 解析 ====================

// APP_TABS 的 key（每行形如 `  claude: [`）
const parseAppTabKeys = () => {
  const src = read('src/Switch/appTabs.js')
  const start = src.indexOf('export const APP_TABS')
  if (start === -1) return null
  // 取到 DEEP_LINK_ROUTES 之前，避免把后面对象的键也算进来
  const end = src.indexOf('export const DEEP_LINK_ROUTES')
  const block = src.slice(start, end === -1 ? undefined : end)
  const keys = []
  const re = /^ {2}([A-Za-z][\w]*): \[/gm
  let m
  while ((m = re.exec(block))) keys.push(m[1])
  return keys
}

// App.vue 白名单里 .includes(route) 的那个数组
const parseAppWhitelist = () => {
  const src = read('src/App.vue')
  const m = src.match(/\[([^\]]*)\]\.includes\(route\)/)
  if (!m) return null
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

// DEEP_LINK_ROUTES 里声明的 route 码
const parseDeepLinkRoutes = () => {
  const src = read('src/Switch/appTabs.js')
  const start = src.indexOf('export const DEEP_LINK_ROUTES')
  if (start === -1) return []
  const block = src.slice(start)
  return [...block.matchAll(/route:\s*["']([^"']+)["']/g)].map((x) => x[1])
}

// index.vue 的 appMap（路由码 → agent id）
const parseAppMap = () => {
  const src = read('src/Switch/index.vue')
  const m = src.match(/const appMap = \{([\s\S]*?)\r?\n  \};/)
  if (!m) return null
  const map = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z][\w]*)\s*:\s*["']([^"']+)["']\s*,?\s*$/)
    if (kv) map[kv[1]] = kv[2]
  }
  return map
}

// agent id → 期望的路由码
const routeCodeFor = (app) => `${app}Config`

// ==================== 断言 ====================

console.log('1. 解析源码')
const tabKeys = parseAppTabKeys()
const whitelist = parseAppWhitelist()
const deepLinks = parseDeepLinkRoutes()
const appMap = parseAppMap()

ok(Array.isArray(tabKeys) && tabKeys.length > 0, 'APP_TABS 解析到键', `got=${JSON.stringify(tabKeys)}`)
ok(Array.isArray(whitelist) && whitelist.length > 0, 'App.vue 白名单解析到路由码', `got=${JSON.stringify(whitelist)}`)
ok(deepLinks.length > 0, 'DEEP_LINK_ROUTES 解析到路由码', `got=${JSON.stringify(deepLinks)}`)
ok(appMap && Object.keys(appMap).length > 0, 'index.vue appMap 解析到映射', `got=${JSON.stringify(appMap)}`)

// 解析失败时后续断言没有意义，直接判失败退出
if (!tabKeys || !whitelist || !appMap) {
  console.error('\n结果: 解析失败，无法继续')
  process.exit(1)
}

console.log('\n2. APP_TABS 的每个 key 都能在 App.vue 白名单里找到对应路由')
for (const app of tabKeys) {
  const code = routeCodeFor(app)
  ok(whitelist.includes(code), `${app} → ${code} 已在白名单`, `白名单里没有 ${code}：从「${app}配置」指令进入会白屏`)
}

console.log('\n3. DEEP_LINK_ROUTES 的每个 route 都在白名单里')
for (const code of deepLinks) {
  ok(whitelist.includes(code), `${code} 已在白名单`)
}

console.log('\n4. index.vue appMap 覆盖 APP_TABS 且路由码一致')
for (const app of tabKeys) {
  const mapped = appMap[routeCodeFor(app)]
  ok(mapped === app, `appMap.${routeCodeFor(app)} === "${app}"`, `got=${JSON.stringify(mapped)}`)
}

console.log('\n5. 白名单里没有孤儿项')
const known = new Set([...tabKeys.map(routeCodeFor), ...deepLinks])
const orphans = whitelist.filter((code) => !known.has(code))
ok(orphans.length === 0, '白名单项都有消费方', `未被子表引用：${orphans.join(', ')}`)

console.log('\n6. 白名单无重复项')
const dupes = whitelist.filter((code, i) => whitelist.indexOf(code) !== i)
ok(dupes.length === 0, '白名单没有重复的路由码', `重复：${[...new Set(dupes)].join(', ')}`)

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
if (failed) {
  console.error('\n提示：新增 agent 时需在 src/App.vue 的 <Switch> v-if 白名单里补上它的路由码，')
  console.error('      否则 uTools 指令能搜到、但进去是空白页（且不报错）。')
}
process.exit(failed ? 1 : 0)
