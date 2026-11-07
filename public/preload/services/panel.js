// uTools 快捷面板：由主界面 preload 创建独立 BrowserWindow，并通过 IPC 把白名单服务调用
// 转发给它。自定义窗口自己的 preload 只做桥接，不重复装载 services.js，避免共享 DB / 网关
// 生命周期被第二个进程接管。
const zhCN = require('../../../shared/i18n/zh-CN/native.json')
const enUS = require('../../../shared/i18n/en-US/native.json')
const db = require('./db')

const PANEL_WIDTH = 400
const PANEL_HEIGHT = 420
const PANEL_MIN_HEIGHT = 120
// 比桌面托盘高 40px：uTools 版顶部多一条可拖动的标题栏。
const PANEL_MAX_HEIGHT = 600
// 小浮窗：一行放本次用量与订阅余量，宽度由页面按内容量出来后上报
const MINI_WIDTH = 320
const MINI_MIN_WIDTH = 96
const MINI_MAX_WIDTH = 360
const MINI_HEIGHT = 60
const MINI_MIN_HEIGHT = 48
// 贴边单列时本次用量 / 输出速率 / 每个圆环各占一行，上限要够高
const MINI_MAX_HEIGHT = 240
const PANEL_MARGIN = 8
const PANEL_CODE = 'quickPanel'
const PANEL_CMD = 'CCConfig 面板'
const PANEL_CMDS = new Set([PANEL_CMD, '快捷面板', 'CCConfig Panel'])
const IPC_REQUEST = 'ccconfig-panel:rpc'
const IPC_RESULT = 'ccconfig-panel:result'
const IPC_ACTION = 'ccconfig-panel:action'

const SERVICE_METHODS = new Set([
  'getPanelContext',
  'getAutoRouteStatus',
  'readAutoRouteConfig',
  'writeAutoRouteConfig',
  'getGatewayRouteOptions',
  'getSkillScenes',
  'switchSkillScene',
  'readCommonUsageForTray',
  'collectCommonUsageAsync',
  'getSubscriptionsTray',
  'refreshSubscription',
  'refreshSubscriptions',
])

const UTOOLS_ACTIONS = new Set([
  'show-main',
  'show-hotkey-setting',
  'restart-gateway',
  'hide',
  'quit',
  'report-height',
  'drag-window',
  'mini-close',
  'diag',
])

let panelWindow = null
let ipcInstalled = false
let panelHeight = PANEL_HEIGHT
let panelMode = 'panel'
let miniWidth = MINI_WIDTH
// 页面拖动标题栏时按「起点窗口坐标 + 指针位移」计算位置，避免逐帧累加误差。
let dragState = null

function nativeMessages(locale) {
  const dict = locale === 'en-US' ? enUS : zhCN
  return (dict && dict.native && dict.native.tray) || {}
}

function pluginRoot() {
  // 开发工程由 development.main 指向 Vite，URL 与 plugin.json 同源；生产版用相对路径。
  if (typeof location !== 'undefined' && /^https?:/.test(location.href || '')) {
    return location.origin
  }
  return ''
}

function pageUrl() {
  const root = pluginRoot()
  return root ? new URL('panel.html', root.endsWith('/') ? root : root + '/').toString() : 'panel.html'
}

function preloadPath() {
  return 'preload/panel-bridge.js'
}

function displayAtPoint(point) {
  try {
    if (window.utools.getDisplayNearestPoint) return window.utools.getDisplayNearestPoint(point)
  } catch (e) {
    /* 退化到主显示器 */
  }
  try {
    if (window.utools.getPrimaryDisplay) return window.utools.getPrimaryDisplay()
  } catch (e) {
    /* 无可用显示器信息时让系统自己摆窗口 */
  }
  return null
}

function initialPosition(width, height) {
  try {
    if (!window.utools.getCursorScreenPoint) return null
    const point = window.utools.getCursorScreenPoint()
    const display = displayAtPoint(point)
    const area = (display && (display.workArea || display.bounds)) || null
    if (!area) return null
    const maxX = area.x + area.width - width - PANEL_MARGIN
    const maxY = area.y + area.height - height - PANEL_MARGIN
    const x = Math.min(Math.max(point.x + PANEL_MARGIN, area.x + PANEL_MARGIN), Math.max(area.x + PANEL_MARGIN, maxX))
    const y = Math.min(Math.max(point.y + PANEL_MARGIN, area.y + PANEL_MARGIN), Math.max(area.y + PANEL_MARGIN, maxY))
    return { x: Math.round(x), y: Math.round(y) }
  } catch (e) {
    return null
  }
}

function jsonSafe(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

function sendResult(win, id, ok, value, error) {
  try {
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC_RESULT, { id, ok, value: ok ? jsonSafe(value) : null, error: error || '' })
  } catch (e) {
    console.error('[quick-panel] 回传调用结果失败:', e)
  }
}

function machineDocId(base) {
  let id = ''
  try { id = db.getNativeId() || '' } catch (e) { /* 回退到旧共享档 */ }
  return id ? `${base}_${id}` : base
}

function localePreference() {
  try {
    const id = machineDocId('ccconfig_locale')
    const doc = db.get(id) || db.get('ccconfig_locale')
    if (doc && doc.locale === 'en-US') return 'en-US'
    if (doc && doc.locale === 'zh-CN') return 'zh-CN'
  } catch (e) {
    /* 按当前运行语言兜底 */
  }
  const current = window.services && window.services.getLocale && window.services.getLocale()
  if (current === 'en-US' || current === 'zh-CN') return current
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale || '').startsWith('zh') ? 'zh-CN' : 'en-US'
  } catch (e) {
    return 'zh-CN'
  }
}

function statsUnitPreference() {
  try {
    const id = machineDocId('ccconfig_stats_unit')
    const doc = db.get(id) || db.get('ccconfig_stats_unit')
    return doc && doc.unit === 'cn' ? 'cn' : 'compact'
  } catch (e) {
    return 'compact'
  }
}

function panelContext() {
  const locale = localePreference()
  return {
    locale,
    statsUnit: statsUnitPreference(),
    i18n: nativeMessages(locale),
  }
}

async function handleRequest(win, payload) {
  const id = payload && payload.id
  const method = payload && payload.method
  const args = payload && Array.isArray(payload.args) ? payload.args : []
  if (!SERVICE_METHODS.has(method)) {
    sendResult(win, id, false, null, 'unknown panel service method: ' + method)
    return
  }
  try {
    if (method === 'getPanelContext') {
      sendResult(win, id, true, panelContext(), '')
      return
    }
    const fn = window.services && window.services[method]
    if (typeof fn !== 'function') throw new Error('service unavailable: ' + method)
    sendResult(win, id, true, await fn(...args), '')
  } catch (e) {
    sendResult(win, id, false, null, String((e && e.message) || e))
  }
}

async function restartGateway() {
  const config = (window.services && window.services.readAutoRouteConfig()) || {}
  if (!config.enabled) return { ok: false, reason: 'disabled' }
  await window.services.stopAutoRoute()
  await window.services.startAutoRoute()
  return { ok: true }
}

// 动态功能命中时 code 是 quickPanel；个别宿主会把搜索命中的指令文案放进 payload，
// 此时即使落到了默认功能上也按面板入口处理。
function isPanelEntry(action) {
  if (!action) return false
  if (action.code === PANEL_CODE) return true
  return typeof action.payload === 'string' && PANEL_CMDS.has(action.payload.trim())
}

function handleEnter(action) {
  if (!isPanelEntry(action)) return false
  // 同一入口再次触发（快捷键 / 搜索指令）当作开关：面板已显示就关掉。
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
    try { window.utools.hideMainWindow(false) } catch (e) { /* 主窗口可能已隐藏 */ }
    closePanel()
    return false
  }
  openPanel({ hideMain: true })
  return true
}

function openPanel(options) {
  dragState = null
  if (options && options.hideMain) {
    try { window.utools.hideMainWindow(false) } catch (e) { /* 主窗口可能已隐藏 */ }
  }
  try {
    if (panelWindow && !panelWindow.isDestroyed()) {
      if (!panelWindow.isVisible()) panelWindow.show()
      panelWindow.focus()
      return { ok: true }
    }
  } catch (e) {
    panelWindow = null
  }
  if (typeof window.utools.createBrowserWindow !== 'function') {
    return { ok: false, error: 'createBrowserWindow unavailable' }
  }
  const position = initialPosition(PANEL_WIDTH, panelHeight) || {}
  let win = null
  try {
    win = window.utools.createBrowserWindow(
      pageUrl(),
      {
        show: false,
        title: 'CCConfig',
        width: PANEL_WIDTH,
        height: panelHeight,
        minHeight: PANEL_MIN_HEIGHT,
        maxHeight: PANEL_MAX_HEIGHT,
        resizable: false,
        movable: true,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: true,
        ...position,
        webPreferences: { preload: preloadPath() },
      },
      () => {
        try {
          if (!win) return
          win.setSize(PANEL_WIDTH, panelHeight)
          win.show()
          win.focus()
          // 常驻置顶：失焦不收起，保持在普通窗口之上，并跟随到所有工作区（含全屏应用）。
          try { win.setAlwaysOnTop(true, 'floating') } catch (e) { /* 平台不支持层级 */ }
          try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (e) { /* 仅 macOS / Linux */ }
        } catch (e) {
          console.error('[quick-panel] 显示窗口失败:', e)
        }
      },
    )
  } catch (e) {
    console.error('[quick-panel] 创建窗口失败:', e)
    if (options && options.hideMain) {
      try { window.utools.showMainWindow() } catch (err) { /* 主窗口可能不可用 */ }
    }
    return { ok: false, error: String((e && e.message) || e) }
  }
  panelWindow = win
  return { ok: true }
}

function closePanel() {
  try {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.close()
  } catch (e) {
    /* 窗口可能已销毁 */
  }
  panelWindow = null
  dragState = null
  panelMode = 'panel'
  panelHeight = PANEL_HEIGHT
  miniWidth = MINI_WIDTH
}

// uTools 自定义窗口的拖动兜底：页面标题栏发来指针屏幕坐标，这里换算成窗口位置。
// 屏幕坐标与窗口位置都按 DIP 计，无需换算缩放。
function dragWindow(win, args) {
  if (!win || win.isDestroyed()) return { ok: false }
  const phase = args && args.phase
  if (phase === 'start') {
    const [x, y] = win.getPosition()
    dragState = {
      x,
      y,
      pointerX: Number(args.x) || 0,
      pointerY: Number(args.y) || 0,
    }
    return { ok: true }
  }
  if (phase === 'end') {
    dragState = null
    return { ok: true }
  }
  if (!dragState) return { ok: false }
  const dx = Math.round((Number(args.x) || 0) - dragState.pointerX)
  const dy = Math.round((Number(args.y) || 0) - dragState.pointerY)
  win.setPosition(dragState.x + dx, dragState.y + dy)
  return { ok: true }
}

function installIpc() {
  if (ipcInstalled) return
  let ipcRenderer
  try {
    ipcRenderer = require('electron').ipcRenderer
  } catch (e) {
    console.error('[quick-panel] Electron IPC 不可用:', e)
    return
  }
  ipcInstalled = true
  ipcRenderer.on(IPC_REQUEST, (_event, payload) => {
    handleRequest(panelWindow, payload)
  })
  ipcRenderer.on(IPC_ACTION, (_event, payload) => {
    handleAction(panelWindow, payload)
  })
}

function modeMetrics(mode) {
  return mode === 'mini'
    ? { width: miniWidth, min: MINI_MIN_HEIGHT, max: MINI_MAX_HEIGHT }
    : { width: PANEL_WIDTH, min: PANEL_MIN_HEIGHT, max: PANEL_MAX_HEIGHT }
}

async function handleAction(win, payload) {
  const action = payload && payload.action
  const id = payload && payload.id
  const args = payload && payload.args
  let result = { ok: true }
  try {
    if (!UTOOLS_ACTIONS.has(action)) throw new Error('unknown panel action: ' + action)
    if (action === 'show-main') {
      closePanel()
      try { window.utools.showMainWindow() } catch (e) { /* 主窗口可能已隐藏 */ }
      window.utools.redirect(['CCConfig', '通用配置'])
    } else if (action === 'show-hotkey-setting') {
      window.utools.redirectHotKeySetting(PANEL_CMD)
    } else if (action === 'restart-gateway') {
      result = await restartGateway()
    } else if (action === 'hide' || action === 'quit') {
      closePanel()
    } else if (action === 'mini-close') {
      // 关闭小浮窗后回到完整面板，下次从快捷键 / 托盘打开不会被留在 mini 尺寸
      panelMode = 'panel'
      panelHeight = PANEL_HEIGHT
      closePanel()
    } else if (action === 'drag-window') {
      result = dragWindow(win, args || {})
    } else if (action === 'report-height') {
      const mode = args && args.mode === 'mini' ? 'mini' : 'panel'
      if (mode === 'mini') {
        const width = Math.ceil(Number(args && args.width) || 0)
        if (width > 0) miniWidth = Math.max(MINI_MIN_WIDTH, Math.min(MINI_MAX_WIDTH, width))
      }
      const metrics = modeMetrics(mode)
      const raw = Math.ceil(Number(args && args.height) || (mode === 'mini' ? MINI_HEIGHT : PANEL_HEIGHT))
      panelMode = mode
      panelHeight = Math.max(metrics.min, Math.min(metrics.max, raw))
      try {
        if (win && !win.isDestroyed()) {
          // 创建时的 min/max 是完整面板尺寸，切到 mini 必须先放宽，否则 setSize 会被夹回 120
          if (win.setMinimumSize) win.setMinimumSize(metrics.width, metrics.min)
          if (win.setMaximumSize) win.setMaximumSize(metrics.width, metrics.max)
          win.setSize(metrics.width, panelHeight)
        }
      } catch (e) {
        /* 忽略窗口已销毁 */
      }
    } else if (action === 'diag') {
      console.error('[quick-panel:' + String((args && args[0]) || 'log') + '] ' + String((args && args[1]) || ''))
    }
    if (id) sendResult(win, id, true, result, '')
  } catch (e) {
    console.error('[quick-panel] 动作失败:', e)
    if (id) sendResult(win, id, false, null, String((e && e.message) || e))
  }
}

function init() {
  installIpc()
}

module.exports = {
  init,
  openPanel,
  handleEnter,
  isPanelEntry,
  panelContext,
  PANEL_CODE,
  PANEL_CMD,
  IPC_REQUEST,
  IPC_RESULT,
  IPC_ACTION,
  SERVICE_METHODS,
  UTOOLS_ACTIONS,
}
