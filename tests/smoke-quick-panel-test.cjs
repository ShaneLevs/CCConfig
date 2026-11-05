// uTools 快捷面板冒烟测试：能力判定、动态指令、机器语言/统计单位读取、IPC 服务白名单。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-quick-panel-'))
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-quick-panel-data-'))
process.env.CCCONFIG_DATA_DIR = DATA
process.env.CCCONFIG_LOCALE = 'zh-CN'

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}

const windows = []
const features = new Map()
const windowStub = () => {
  const win = {
    destroyed: false,
    visible: false,
    size: [400, 420],
    position: [100, 100],
    topLevel: null,
    sent: [],
    show() { this.visible = true },
    focus() {},
    hide() { this.visible = false },
    close() { this.destroyed = true; this.visible = false },
    isDestroyed() { return this.destroyed },
    isVisible() { return this.visible },
    setSize(width, height) { this.size = [width, height] },
    getPosition() { return this.position.slice() },
    setPosition(x, y) { this.position = [x, y] },
    setAlwaysOnTop(flag, level) { this.topLevel = flag ? (level || 'always') : null },
    setVisibleOnAllWorkspaces() {},
    webContents: { send: (channel, payload) => win.sent.push([channel, payload]) },
  }
  return win
}

const ipcHandlers = new Map()
global.window = {
  location: { href: 'file:///plugin/index.html', origin: '' },
  utools: {
    getPath: () => HOME,
    getNativeId: () => 'quick-panel-native',
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
    }),
    createBrowserWindow: (url, options, callback) => {
      const win = windowStub()
      windows.push({ url, options, callback, win })
      if (callback) setImmediate(callback)
      return win
    },
    sendToParent: () => {},
    hideMainWindow: () => true,
    redirect: () => true,
    redirectHotKeySetting: () => {},
    getCmdHotKey: () => null,
    setFeature: (feature) => features.set(feature.code, feature),
    removeFeature: (code) => features.delete(code),
    onPluginEnter: (callback) => ipcHandlers.set('enter', callback),
    db: {
      get: () => null,
      put: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      allDocs: () => [],
    },
    shellOpenPath: () => {},
    shellOpenExternal: () => {},
    copyText: () => {},
    showOpenDialog: () => null,
    isWindows: () => false,
    isMacOS: () => true,
    isLinux: () => false,
  },
  services: {
    getLocale: () => 'zh-CN',
    getAutoRouteStatus: () => ({ running: true, port: 17877 }),
    readAutoRouteConfig: () => ({ enabled: true, port: 17877 }),
    writeAutoRouteConfig: (patch) => patch,
    getGatewayRouteOptions: () => [],
    getSkillScenes: () => ({ scenes: [], activeId: '' }),
    switchSkillScene: () => ({}),
    readCommonUsageForTray: () => [],
    collectCommonUsageAsync: async () => ({}),
    getSubscriptionsTray: () => [],
    refreshSubscription: async () => ({}),
    refreshSubscriptions: async () => ({}),
    stopAutoRoute: async () => ({}),
    startAutoRoute: async () => ({}),
  },
}

// Electron 由宿主提供；测试里只验证主 preload 能拿到 ipcRenderer 注册回调。
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcRenderer: { on: (channel, cb) => ipcHandlers.set(channel, cb) } }
  return originalLoad.call(this, request, parent, isMain)
}

const support = require('../public/preload/services/panel-support')
const localDb = require('../public/preload/services/local-db')
globalThis.__CCCONFIG_USE_LOCAL_DB__ = true
const nativeId = localDb.getNativeId()
const panel = require('../public/preload/services/panel')
const commands = require('../public/preload/services/commands')

async function main() {
  console.log('1. 能力判定与指令注册')
  ok(support.isSupported() === true, 'uTools 宿主支持快捷面板')
  commands.syncQuickPanelFeature()
  const feature = features.get(panel.PANEL_CODE)
  ok(!!feature, 'quickPanel 动态指令已注册')
  ok(feature && feature.mainHide === true, '动态指令不主动拉起主窗口')
  ok(feature && feature.cmds.includes(panel.PANEL_CMD), '动态指令包含功能指令')

  console.log('\n2. 主窗口语言与统计单位从机器档读取')
  const db = require('../public/preload/services/db')
  db.put({ _id: `ccconfig_locale_${nativeId}`, locale: 'en-US' })
  db.put({ _id: `ccconfig_stats_unit_${nativeId}`, unit: 'cn' })
  const context = panel.panelContext()
  ok(context.locale === 'en-US', '语言按本机文档读取')
  ok(context.statsUnit === 'cn', '统计单位按本机文档读取')
  ok(context.i18n.setHotkey === 'Set hotkey', '文案按语言选择')

  console.log('\n3. 入口拉起独立窗口')
  panel.init()
  ok(typeof panel.handleEnter === 'function', '导出统一入口处理函数')
  ok(panel.isPanelEntry({ code: 'quickPanel' }) === true, '快捷面板 code 命中入口')
  ok(panel.isPanelEntry({ code: 'commonConfig', payload: '快捷面板' }) === true, '指令文案落到默认功能时仍命中入口')
  ok(panel.isPanelEntry({ code: 'commonConfig', payload: 'CCConfig' }) === false, '普通通用配置入口不误命中')
  panel.handleEnter({ code: panel.PANEL_CODE, type: 'text', payload: '', from: 'hotkey' })
  await new Promise((resolve) => setImmediate(resolve))
  ok(windows.length === 1, '创建 1 个自定义窗口')
  ok(windows[0] && windows[0].url === 'panel.html', '生产环境加载相对页面')
  ok(windows[0] && windows[0].options.show === false, '页面加载前不显示窗口')
  ok(windows[0] && windows[0].options.webPreferences.preload === 'preload/panel-bridge.js', '自定义窗口加载 IPC preload')
  ok(windows[0] && windows[0].win.visible === true, '页面加载完成后显示窗口')

  console.log('\n4. IPC 白名单与动作')
  const rpcHandler = ipcHandlers.get(panel.IPC_REQUEST)
  ok(typeof rpcHandler === 'function', '注册了服务调用 IPC')
  await rpcHandler({}, { id: 'ctx', method: 'getPanelContext', args: [] })
  await rpcHandler({}, { id: 'status', method: 'getAutoRouteStatus', args: [] })
  await rpcHandler({}, { id: 'bad', method: 'readClaudeJson', args: [] })
  const sent = windows[0].win.sent
  const byId = Object.fromEntries(sent.map(([channel, payload]) => [payload.id, payload]))
  ok(byId.ctx && byId.ctx.ok === true, '上下文调用成功')
  ok(byId.status && byId.status.value.running === true, '白名单服务调用成功')
  ok(byId.bad && byId.bad.ok === false, '白名单外调用被拒绝')

  const actionHandler = ipcHandlers.get(panel.IPC_ACTION)
  ok(typeof actionHandler === 'function', '注册了动作 IPC')
  await actionHandler({}, { id: 'height', action: 'report-height', args: { height: 999 } })
  ok(windows[0].win.size[1] === 600, '窗口高度被限制到上限')
  await actionHandler({}, { action: 'drag-window', args: { phase: 'start', x: 500, y: 500 } })
  await actionHandler({}, { action: 'drag-window', args: { phase: 'move', x: 540, y: 520 } })
  ok(windows[0].win.position.join(',') === '140,120', '拖动标题栏按指针位移移动窗口')
  await actionHandler({}, { action: 'drag-window', args: { phase: 'end', x: 540, y: 520 } })
  await actionHandler({}, { action: 'drag-window', args: { phase: 'move', x: 700, y: 700 } })
  ok(windows[0].win.position.join(',') === '140,120', '拖动结束后不再移动窗口')
  await actionHandler({}, { id: 'mini', action: 'report-height', args: { height: 60, mode: 'mini', width: 210 } })
  ok(windows[0].win.size.join(',') === '210,60', '小浮窗按内容宽度与 mini 高度切换')
  await actionHandler({}, { id: 'mini2', action: 'report-height', args: { height: 60, mode: 'mini', width: 80 } })
  ok(windows[0].win.size[0] === 96, '小浮窗宽度有下限，避免内容被裁掉')
  await actionHandler({}, { id: 'panel', action: 'report-height', args: { height: 420, mode: 'panel' } })
  ok(windows[0].win.size.join(',') === '400,420', '关闭小浮窗后回到完整面板尺寸')
  await actionHandler({}, { id: 'hide', action: 'hide', args: {} })
  ok(windows[0].win.destroyed === true, '隐藏动作关闭自定义窗口')

  panel.handleEnter({ code: panel.PANEL_CODE, type: 'text', payload: '', from: 'hotkey' })
  await new Promise((resolve) => setImmediate(resolve))
  ok(windows.length === 2 && windows[1].win.visible === true, '隐藏后再次触发入口重新打开面板')
  ok(windows[1].win.topLevel === 'floating', '面板保持置顶层级')
  panel.handleEnter({ code: panel.PANEL_CODE, type: 'text', payload: '', from: 'hotkey' })
  ok(windows[1].win.destroyed === true, '面板已显示时再次触发入口将其关闭')
  ok(windows[1].options.movable === true, '窗口允许移动')

  console.log('\n5. uTools 标题栏')
  const panelHtml = fs.readFileSync(path.join(__dirname, '../shared/panel/panel.html'), 'utf8')
  const bridgeSource = fs.readFileSync(path.join(__dirname, '../public/preload/panel-bridge.js'), 'utf8')
  ok(panelHtml.includes('id="panel-head"'), '面板包含标题栏')
  ok(panelHtml.includes('id="panel-close"'), '标题栏包含关闭按钮')
  ok(panelHtml.includes('html.cc-panel-utools .panel-head'), '标题栏只在 uTools 版显示')
  ok(panelHtml.includes('-webkit-app-region: drag'), '标题栏声明系统拖动区域')
  ok(panelHtml.includes("dragWindow('move'"), '标题栏提供指针拖动兜底')
  ok(bridgeSource.includes('function dragWindow'), '自定义窗口 bridge 转发拖动动作')

  console.log('\n6. 小浮窗')
  ok(panelHtml.includes('id="mini"'), '面板包含小浮窗容器')
  ok(panelHtml.includes('data-action="shrink"'), '底部提供缩小按钮')
  ok(panelHtml.includes('const MINI_REFRESH_MS = 60 * 1000'), '小浮窗每分钟刷新')
  ok(panelHtml.includes('function renderMini'), '小浮窗渲染本次用量与订阅余量')
  ok(panelHtml.includes('mini-ring'), '订阅余量画成进度圆')
  ok(panelHtml.includes('function miniContentWidth'), '小浮窗宽度按内容测量')
  ok(panelHtml.includes('mini-close'), '小浮窗提供关闭按钮')
  ok(panelHtml.includes('mini-expand'), '小浮窗提供放大按钮')
  const miniRule = panelHtml.slice(panelHtml.indexOf('html.cc-mini .mini'), panelHtml.indexOf('html.cc-mini .mini') + 500)
  ok(!miniRule.includes('-webkit-app-region: drag'), '小浮窗不用系统拖动区域，hover 才能收到鼠标事件')
  const desktopAdapter = fs.readFileSync(path.join(__dirname, '../shared/panel/desktop-adapter.js'), 'utf8')
  ok(desktopAdapter.includes('tray_popup_drag'), '桌面版拖动走原生命令')
  ok(desktopAdapter.includes('separateMiniWindow'), '桌面版声明独立小浮窗能力')
  ok(desktopAdapter.includes('mini_popup_open'), '桌面版缩小打开独立小浮窗')
  const rustSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8')
  ok(rustSource.includes('fn tray_popup_drag'), 'Rust 暴露托盘弹窗拖动命令')
  ok(rustSource.includes('const MINI_POPUP'), 'Rust 定义独立小浮窗窗口')
  ok(rustSource.includes('fn mini_popup_open'), 'Rust 支持打开小浮窗')
  ok(rustSource.includes('fn mini_popup_hide'), 'Rust 关闭小浮窗只收起它自己')
  ok(rustSource.includes('fn mini_popup_expand'), 'Rust 放大回到大浮窗')

  console.log('\n7. 桌面 / 旧宿主降级')
  globalThis.__CCCONFIG_DESKTOP__ = true
  ok(support.isSupported() === false, '桌面 sidecar 不注册快捷面板')
  delete globalThis.__CCCONFIG_DESKTOP__
  delete global.window.utools.createBrowserWindow
  ok(support.isSupported() === false, '缺少 createBrowserWindow 时降级')

  console.log('\n8. 入口注册不被生命周期回调覆盖')
  const servicesSource = fs.readFileSync(path.join(__dirname, '../public/preload/services.js'), 'utf8')
  const appSource = fs.readFileSync(path.join(__dirname, '../src/App.vue'), 'utf8')
  ok((servicesSource.match(/window\.utools\.onPluginEnter\(/g) || []).length === 1, 'preload 只注册一个 onPluginEnter')
  ok(servicesSource.includes('panel.handleEnter(action)'), 'preload 入口回调里处理快捷面板')
  ok(appSource.includes('handleQuickPanelEnter'), '页面把 enter 转回 preload')

  fs.rmSync(HOME, { recursive: true, force: true })
  fs.rmSync(DATA, { recursive: true, force: true })
  Module._load = originalLoad
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
