import { createApp } from 'vue'
import TDesign from 'tdesign-vue-next'
import 'tdesign-vue-next/es/style/index.css'
import './theme.css'
import './main.css'
import App from './App.vue'
import { i18n } from './i18n'
import { installLocale } from './composables/useLocale'
import { installAppearance } from './composables/useAppearance'
import { installUnitFormat } from './composables/useUnitFormat'

// 首帧前解析语言、外观与统计单位，避免界面闪变
installLocale()
installAppearance()
installUnitFormat()

const app = createApp(App)
app.use(TDesign)
app.use(i18n)
app.mount('#app')
