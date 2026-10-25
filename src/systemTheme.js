// 系统主题（深/浅色）→ <html theme-mode> 属性。
// TDesign 的暗色变量全靠这个属性命中，index（主窗）与 tray（菜单栏面板）两个入口共用。
export function installSystemTheme() {
  const query = window.matchMedia('(prefers-color-scheme: dark)')

  const apply = () => {
    if (query.matches) {
      document.documentElement.setAttribute('theme-mode', 'dark')
    } else {
      document.documentElement.removeAttribute('theme-mode')
    }
  }

  apply()
  query.addEventListener('change', apply)
}
