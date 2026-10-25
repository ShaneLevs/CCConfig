import { createI18n } from 'vue-i18n'
import { DEFAULT_LOCALE, detectSystemLocale, normalizeLocale } from './locales'

// 文案目录与 preload / Rust 共用：shared/i18n/<locale>/*.json
// 每个文件的根节点就是自己的命名空间（common / nav / claude / service …），浅合并即可。
const localeModules = (modules) => Object.assign({}, ...Object.values(modules))

const zhCN = localeModules(
  import.meta.glob('../../shared/i18n/zh-CN/*.json', { eager: true, import: 'default' })
)
const enUS = localeModules(
  import.meta.glob('../../shared/i18n/en-US/*.json', { eager: true, import: 'default' })
)

export const i18n = createI18n({
  legacy: false,
  locale: detectSystemLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  messages: { 'zh-CN': zhCN, 'en-US': enUS },
  missingWarn: import.meta.env.DEV,
  fallbackWarn: false,
})

// 非 setup 代码（composables / utils / 数据表）使用的全局翻译函数
export const t = (key, params) => i18n.global.t(key, params)

export function getLocale() {
  return i18n.global.locale.value
}

export function setLocale(locale) {
  const resolved = normalizeLocale(locale) || DEFAULT_LOCALE
  i18n.global.locale.value = resolved
  try {
    document.documentElement.lang = resolved
  } catch (e) {
    /* ignore */
  }
  return resolved
}
