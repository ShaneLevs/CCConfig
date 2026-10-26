import { computed, ref, watch } from 'vue'
import { setLocale as applyI18nLocale } from '../i18n'
import {
  LOCALE_DOC_ID,
  detectSystemLocale,
  normalizeLocale,
  resolveLocalePreference,
} from '../i18n/locales'

// 语言偏好：'system' | 'zh-CN' | 'en-US'。
// 按机器隔离（_<nativeId> 后缀，同外观/Agent 启停），旧共享档 ccconfig_locale 仅作迁移种子。
const getNativeId = () => {
  try {
    return window.utools?.getNativeId?.() || ''
  } catch (e) {
    return ''
  }
}
const LEGACY_DOC_ID = LOCALE_DOC_ID
const id = getNativeId()
const DOC_ID = id ? `${LEGACY_DOC_ID}_${id}` : LEGACY_DOC_ID

const preference = ref('system')
const systemLocale = ref(detectSystemLocale())
const resolvedLocale = computed(() => resolveLocalePreference(preference.value))

const readDoc = () => {
  try {
    const doc = window.utools?.db?.get(DOC_ID)
    if (!doc && DOC_ID !== LEGACY_DOC_ID) {
      // 本机尚无记录：回退读旧版共享档（只作种子，writeDoc 总写本机档）
      return window.utools?.db?.get(LEGACY_DOC_ID) || null
    }
    return doc || null
  } catch (e) {
    return null
  }
}

const writeDoc = (tries = 0) => {
  try {
    // 只取本机档的 _rev（旧共享档只读）
    const existing = window.utools?.db?.get(DOC_ID) || null
    const doc = { _id: DOC_ID, locale: preference.value }
    if (existing?._rev) doc._rev = existing._rev
    const res = window.utools?.db?.put(doc)
    if (res && res.error && res.name === 'conflict' && tries < 1) {
      return writeDoc(tries + 1)
    }
  } catch (e) {
    /* ignore write error */
  }
}

const syncRuntime = () => {
  applyI18nLocale(resolvedLocale.value)
  try {
    // 渲染进程是语言权威值：preload / 桌面 sidecar 的 Intl 语言可能与 WebView 不一致
    window.services?.setLocale?.(resolvedLocale.value)
  } catch (e) {
    /* ignore */
  }
}

watch(resolvedLocale, syncRuntime, { flush: 'sync' })

let initialized = false

export function installLocale() {
  if (initialized) return
  initialized = true

  const doc = readDoc()
  if (doc?.locale === 'system') {
    preference.value = 'system'
  } else if (normalizeLocale(doc?.locale)) {
    preference.value = normalizeLocale(doc.locale)
  }

  syncRuntime()
  try {
    window.addEventListener('languagechange', () => {
      systemLocale.value = detectSystemLocale()
    })
  } catch (e) {
    /* ignore */
  }
}

export function useLocale() {
  installLocale()

  const setPreference = (value) => {
    preference.value = value === 'system' ? 'system' : normalizeLocale(value) || 'system'
    writeDoc()
    syncRuntime()
  }

  return { preference, resolvedLocale, systemLocale, setPreference }
}
