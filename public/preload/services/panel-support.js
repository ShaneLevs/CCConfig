// 快捷面板只在真正具备 uTools 自定义窗口能力的宿主中启用。
// 桌面 sidecar 会显式标记 __CCCONFIG_DESKTOP__，避免把快捷面板入口注册到桌面版。
// sendToParent 由自定义窗口 preload 调用，官方文档保证其在自定义窗口可用，
// 因此这里不把主窗口上是否存在该方法当作入口能力条件。
function isSupported() {
  if (globalThis.__CCCONFIG_DESKTOP__ === true) return false
  if (typeof window === 'undefined' || !window.utools) return false
  return typeof window.utools.createBrowserWindow === 'function' &&
    typeof window.utools.hideMainWindow === 'function' &&
    typeof window.utools.redirect === 'function' &&
    typeof window.utools.redirectHotKeySetting === 'function'
}

module.exports = { isSupported }
