// 语言常量与解析（不依赖 vue / vue-i18n，避免 useLocale ↔ i18n 循环 import）
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US']
export const DEFAULT_LOCALE = 'zh-CN'
export const LOCALE_DOC_ID = 'ccconfig_locale'

export function normalizeLocale(value) {
  if (!value) return null
  const v = String(value).toLowerCase()
  if (v.startsWith('zh')) return 'zh-CN'
  if (v.startsWith('en')) return 'en-US'
  return null
}

export function detectSystemLocale() {
  try {
    const list =
      typeof navigator !== 'undefined'
        ? navigator.languages && navigator.languages.length
          ? navigator.languages
          : [navigator.language]
        : []
    for (const item of list) {
      const normalized = normalizeLocale(item)
      if (normalized) return normalized
    }
  } catch (e) {
    /* ignore */
  }
  // 只有中英两种语言：非中文系统默认英文
  return 'en-US'
}

export function resolveLocalePreference(preference) {
  if (preference === 'system') return detectSystemLocale()
  return normalizeLocale(preference) || detectSystemLocale()
}
