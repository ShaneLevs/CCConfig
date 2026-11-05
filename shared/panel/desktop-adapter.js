// 桌面版托盘弹窗适配层：由 Rust 在 shared/panel/panel.html 之前注入。
// 与 uTools 版共用同一套 RPC 协议，差异只在动作命令和窗口尺寸上报。
(function () {
  'use strict'

  const port = () => window.__CCCONFIG_PORT__
  const token = () => window.__CCCONFIG_TOKEN__ || ''
  const i18n = () => window.__CC_TRAY_I18N__ || {}
  const locale = () => window.__CC_LOCALE__ || 'zh-CN'
  const statsUnit = () => (window.__CC_STATS_UNIT__ === 'cn' ? 'cn' : 'compact')

  function invoke(cmd, args) {
    const internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') {
      return Promise.reject(new Error('tauri bridge unavailable'))
    }
    return internals.invoke(cmd, args || {})
  }

  async function rpc(method, args = []) {
    const p = port()
    if (!p) throw new Error('sidecar port missing')
    const res = await fetch('http://127.0.0.1:' + p + '/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CCConfig-Token': token(),
      },
      body: JSON.stringify({ method, args }),
    })
    const data = await res.json()
    if (!data || !data.ok) throw new Error((data && data.error) || method)
    if (data.async) return pollTask(data.taskId, method)
    return data.value
  }

  async function pollTask(taskId, method) {
    for (;;) {
      const p = port()
      const res = await fetch('http://127.0.0.1:' + p + '/rpc-poll', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CCConfig-Token': token(),
        },
        body: JSON.stringify({ taskId }),
      })
      const data = await res.json()
      if (data.status === 'done') return data.value
      if (data.status === 'error') throw new Error(data.error || method)
      if (data.status === 'gone') throw new Error('rpc task gone')
    }
  }

  // 大浮窗与独立小浮窗共用这一层；Rust 用 __CC_WINDOW__ 区分窗口
  const isMiniWindow = () => window.__CC_WINDOW__ === 'mini'

  function invokeAction(action, args) {
    if (isMiniWindow()) {
      if (action === 'hide' || action === 'mini-close') return invoke('mini_popup_hide')
      // 小浮窗的「放大」回到大浮窗，不直接打开主窗口
      if (action === 'mini-expand') return invoke('mini_popup_expand')
      return Promise.resolve({ ok: true })
    }
    if (action === 'hide') return invoke('tray_popup_hide')
    // 大浮窗的「缩小」打开独立小浮窗
    if (action === 'shrink') return invoke('mini_popup_open')
    return invoke('tray_popup_action', { action })
  }

  // 桌面版整窗拖动交给原生 start_dragging，一次性生效，不需要逐帧移动
  function dragWindow(phase) {
    if (phase !== 'start') return
    invoke(isMiniWindow() ? 'mini_popup_drag' : 'tray_popup_drag').catch(() => {})
  }

  function diag(kind, text) {
    rpc('__utools.diag.log', [kind, text]).catch(() => {})
  }

  window.ccPanelAdapter = {
    initialRefresh: false,
    ready: () => Promise.resolve(),
    capabilities: { quit: true, separateMiniWindow: true },
    i18n,
    locale,
    statsUnit,
    rpc,
    invokeAction,
    dragWindow,
    reportHeight: (height, mode, width) => (isMiniWindow()
      ? invoke('mini_popup_resize', { width, height })
      : invoke('tray_popup_resize', { height })
    ).catch(() => {}),
    diag,
  }
})()
