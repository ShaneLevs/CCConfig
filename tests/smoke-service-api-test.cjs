// window.services API manifest 静态检查 + 运行时暴露面断言。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const root = path.resolve(__dirname, '..')
const manifest = require('../public/preload/services/api-manifest')
const sections = Object.values(manifest)
const allowed = new Set(sections.flat())

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

console.log('1. API manifest 自身')
ok(sections.length > 0, '按功能域声明了 API')
ok(allowed.size === new Set(sections.flat()).size, 'manifest 没有重复方法')
ok(![...allowed].some((key) => key.startsWith('_')), 'manifest 不包含内部下划线方法')
ok(!allowed.has('exportConfigsToFile') && !allowed.has('importConfigsFromFile'), 'manifest 不包含任意文件读写入口')

// 渲染层、共享面板、桌面 bridge 里出现的 window.services 方法必须在清单里。
const sourceFiles = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist-app', 'release'].includes(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.(js|vue|cjs)$/.test(entry.name)) sourceFiles.push(p)
  }
}
for (const dir of ['src', 'shared', 'desktop/bridge']) walk(path.join(root, dir))
const source = sourceFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const referenced = new Set()
for (const re of [/window\.services\??\.([A-Za-z_$][\w$]*)/g, /\bSVC\.([A-Za-z_$][\w$]*)/g]) {
  let match
  while ((match = re.exec(source))) referenced.add(match[1])
}
// 动态调用（useSkillInstall cfg、共享面板 SERVICE_METHODS）按字符串清单登记。
for (const file of ['src/composables/useSkillInstall.js', 'public/preload/services/panel.js']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  for (const match of text.matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) {
    if (/^[a-z]/.test(match[1]) || /^[A-Z]/.test(match[1])) referenced.add(match[1])
  }
}
// 面板内部 RPC 名称，不经过 window.services；其余名称必须能在 manifest 对应分组找到。
const ignored = new Set(['quickPanel', 'getPanelContext'])
const missing = [...referenced].filter((key) => key.length > 2 && /^[a-z]/.test(key) && /[A-Z]/.test(key) && !allowed.has(key) && !ignored.has(key))
ok(missing.length === 0, '渲染层/面板/bridge 引用的方法都在 manifest 中', missing.join(', '))

console.log('2. 运行时暴露面')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-api-home-'))
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-api-data-'))
process.env.CCCONFIG_DATA_DIR = DATA
global.window = {
  utools: {
    getPath: () => HOME,
    getNativeId: () => 'api-test',
    shellOpenPath() {},
    shellOpenExternal() {},
    copyText() {},
    showOpenDialog: () => null,
    setFeature() {},
    removeFeature() {},
    getFeatures: () => [],
    onPluginEnter() {},
    onPluginOut() {},
    db: { get: () => null, put: () => ({ ok: true }), remove: () => ({ ok: true }), allDocs: () => [] },
  },
}
require('../public/preload/services.js')
const runtimeKeys = Object.keys(window.services)
const extra = runtimeKeys.filter((key) => !allowed.has(key))
ok(extra.length === 0, '运行时没有 manifest 之外的方法', extra.join(', '))
ok(!runtimeKeys.some((key) => key.startsWith('_')), '运行时没有内部下划线方法')
ok(!runtimeKeys.includes('exportConfigsToFile') && !runtimeKeys.includes('importConfigsFromFile'), '运行时没有任意文件读写入口')
ok(runtimeKeys.includes('getSubscriptionConsent'), '订阅授权读取接口可用')
ok(runtimeKeys.includes('setSubscriptionConsent'), '订阅授权设置接口可用')
ok(runtimeKeys.includes('readCommonProviders'), '自动网关读取通用供应商接口可用')
ok(runtimeKeys.includes('readCommonUsage'), '通用统计读取接口可用')
ok(runtimeKeys.includes('getGrokUngroupedModels'), 'Grok 未分组模型接口可用')

console.log('3. 未过滤导出完整性')
// 运行时白名单会静默删除未登记方法；这里去掉过滤块加载原始对象，确保 services.js
// 实际挂载的每个方法都已在 manifest 登记，避免页面调用时才出现 is not a function。
const servicesFile = path.join(root, 'public/preload/services.js')
let servicesSource = fs.readFileSync(servicesFile, 'utf8')
const filterStart = servicesSource.indexOf('// 静态允许清单是 window.services 的唯一对外边界')
const filterEnd = servicesSource.indexOf('// ==================== 智能体启停指令同步')
ok(filterStart >= 0 && filterEnd > filterStart, '找到 services.js 运行时过滤块')
if (filterStart >= 0 && filterEnd > filterStart) {
  servicesSource = servicesSource.slice(0, filterStart) + servicesSource.slice(filterEnd)
  const servicesModule = new Module(servicesFile, module)
  servicesModule.filename = servicesFile
  servicesModule.paths = Module._nodeModulePaths(path.dirname(servicesFile))
  servicesModule._compile(servicesSource, servicesFile)
  const unfilteredKeys = Object.keys(window.services)
  const undeclared = unfilteredKeys.filter((key) => !allowed.has(key))
  ok(undeclared.length === 0, 'services.js 挂载的方法都在 manifest 中', undeclared.join(', '))
}

fs.rmSync(HOME, { recursive: true, force: true })
fs.rmSync(DATA, { recursive: true, force: true })
console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed) process.exit(1)
