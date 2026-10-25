import { createApp } from 'vue'
import TDesign from 'tdesign-vue-next'
import 'tdesign-vue-next/es/style/index.css'
import './theme.css'
import './main.css'
import App from './App.vue'
import { installSystemTheme } from './systemTheme'

// 系统主题 → <html theme-mode>（与桌面版菜单栏面板共用同一实现）
installSystemTheme()

const app = createApp(App)
app.use(TDesign)
app.mount('#app')
