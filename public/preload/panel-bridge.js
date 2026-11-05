// uTools 自定义窗口的 preload：把页面请求经 IPC 转给主界面 preload，由后者调用 window.services。
// 本文件不直接访问本地文件、DB 或网络，遵循最小暴露原则。
(function () {
  'use strict'

  const REQUEST = 'ccconfig-panel:rpc'
  const RESULT = 'ccconfig-panel:result'
  const ACTION = 'ccconfig-panel:action'
  const pending = new Map()
  let seq = 0

  let ipcRenderer
  try {
    ipcRenderer = require('electron').ipcRenderer
  } catch (e) {
    window.ccPanelAdapter = {
      initialRefresh: false,
      ready: () => Promise.resolve(),
      capabilities: { hotkeySetting: false },
      i18n: () => ({}),
      locale: () => 'zh-CN',
      statsUnit: () => 'compact',
      rpc: () => Promise.reject(new Error('Electron IPC unavailable')),
      invokeAction: () => Promise.reject(new Error('Electron IPC unavailable')),
      dragWindow: () => {},
      reportHeight: () => {},
      diag: () => {},
    }
    return
  }

  ipcRenderer.on(RESULT, (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') return
    const task = pending.get(payload.id)
    if (!task) return
    pending.delete(payload.id)
    if (payload.ok) task.resolve(payload.value)
    else task.reject(new Error(payload.error || 'panel rpc failed'))
  })

  function call(channel, payload) {
    return new Promise((resolve, reject) => {
      const id = 'panel-' + (++seq)
      pending.set(id, { resolve, reject })
      try {
        window.utools.sendToParent(channel, { ...payload, id })
      } catch (e) {
        pending.delete(id)
        reject(e)
      }
    })
  }

  function rpc(method, args) {
    return call(REQUEST, { method, args: Array.isArray(args) ? args : [] })
  }

  function invokeAction(action, args) {
    return call(ACTION, { action, args: args || {} })
  }

  function diag(kind, text) {
    try { window.utools.sendToParent(ACTION, { action: 'diag', args: [kind, text] }) } catch (e) { /* 诊断不能递归 */ }
  }

  function reportHeight(height, mode, width) {
    invokeAction('report-height', { height, mode, width }).catch(() => {})
  }

  // 拖动标题栏是连续动作，逐帧不必等回复，所以走单向 sendToParent（父窗口没有 id 就不回传）。
  function dragWindow(phase, x, y) {
    try {
      window.utools.sendToParent(ACTION, { action: 'drag-window', args: { phase, x, y } })
    } catch (e) {
      /* 窗口可能已销毁 */
    }
  }

  // 首次加载先从主窗口拉回本机语言、统计单位与文案，避免静态页面打包两份语言资源。
  let contextPromise = null
  function context() {
    if (!contextPromise) contextPromise = rpc('getPanelContext').catch(() => ({}))
    return contextPromise
  }

  window.ccPanelAdapter = {
    initialRefresh: true,
    ready: context,
    capabilities: { hotkeySetting: true },
    i18n: () => (window.ccPanelBoot && window.ccPanelBoot.i18n) || {},
    locale: () => (window.ccPanelBoot && window.ccPanelBoot.locale) || 'zh-CN',
    statsUnit: () => (window.ccPanelBoot && window.ccPanelBoot.statsUnit) || 'compact',
    rpc,
    invokeAction,
    dragWindow,
    reportHeight,
    diag,
  }

  // 标题栏只在 uTools 窗口里出现；class 越早打上越好，避免窗口显示后才补一条头部。
  function markRoot() {
    const root = document.documentElement
    if (!root) return
    root.classList.add('cc-panel-utools')
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('cc-panel-dark')
    }
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markRoot, { once: true })
    else markRoot()
  }

  context().then((data) => {
    window.ccPanelBoot = data || {}
    markRoot()
  }).catch(() => {})
})()
