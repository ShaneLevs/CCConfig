import { computed, ref, watch } from 'vue'

// 外观设置（主题模式 + 深色背景特效），模块级单例：
// - App.vue 读取解析后的 isDark 决定是否渲染特效；
// - 设置弹窗的「外观」页签读写配置；
// - main.js 在 mount 前调用 installAppearance()，避免首帧主题闪变。
//
// 按设备区分同步（_<nativeId> 后缀）：各机器性能/外观偏好不同。
// 文档 ID 沿用旧的 ccswitch_dark_background（schema 不迁移），新增 theme 字段。
const getNativeId = () => {
  try {
    return window.utools?.getNativeId?.() || ''
  } catch (e) {
    return ''
  }
}

const LEGACY_DOC_ID = 'ccswitch_dark_background'
const id = getNativeId()
const DOC_ID = id ? `${LEGACY_DOC_ID}_${id}` : LEGACY_DOC_ID

const darkBackgroundEnabled = ref(false)
// 'prismatic' | 'pixel' | 'aurora' | 'galaxy'
const darkEffect = ref('prismatic')
// 'system' | 'light' | 'dark'
const themeMode = ref('system')

const mediaQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null
const systemDark = ref(!!mediaQuery?.matches)

const isDark = computed(() =>
  themeMode.value === 'system' ? systemDark.value : themeMode.value === 'dark'
)
// 只有手动固定主题且与系统外观不一致时，才需要纯色底盖住宿主毛玻璃
const isThemeMismatch = computed(
  () => themeMode.value !== 'system' && isDark.value !== systemDark.value
)

const readDoc = () => {
  try {
    const doc = window.utools?.db?.get(DOC_ID)
    if (!doc && DOC_ID !== LEGACY_DOC_ID) {
      // 本机尚无记录：回退读旧版共享档（只作种子，saveDoc 总写本机档）
      return window.utools?.db?.get(LEGACY_DOC_ID) || null
    }
    return doc || null
  } catch (e) {
    return null
  }
}

const saveDoc = (tries = 0) => {
  try {
    // 只取本机档的 _rev（旧共享档内容只读，不可覆盖回写）
    const existing = window.utools?.db?.get(DOC_ID) || null
    const doc = {
      _id: DOC_ID,
      theme: themeMode.value,
      enabled: darkBackgroundEnabled.value,
      effect: darkEffect.value,
    }
    if (existing?._rev) doc._rev = existing._rev
    const res = window.utools?.db?.put(doc)
    if (res && res.error && res.name === 'conflict' && tries < 1) {
      return saveDoc(tries + 1)
    }
  } catch (e) {
    /* ignore write error */
  }
}

const apply = () => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('theme-mode', isDark.value ? 'dark' : 'light')
  root.classList.toggle('theme-mismatch', isThemeMismatch.value)
  root.classList.toggle('effect-active', isDark.value && darkBackgroundEnabled.value)
}

watch([isDark, isThemeMismatch, darkBackgroundEnabled], apply, { flush: 'sync' })

let initialized = false

export function installAppearance() {
  if (initialized) return
  initialized = true

  const doc = readDoc()
  if (doc) {
    if (doc.theme === 'system' || doc.theme === 'light' || doc.theme === 'dark') {
      themeMode.value = doc.theme
    }
    if (typeof doc.enabled === 'boolean') darkBackgroundEnabled.value = doc.enabled
    if (
      doc.effect === 'prismatic' ||
      doc.effect === 'pixel' ||
      doc.effect === 'aurora' ||
      doc.effect === 'galaxy'
    ) {
      darkEffect.value = doc.effect
    }
  }

  apply()

  try {
    mediaQuery?.addEventListener?.('change', (event) => {
      // 固定主题下也要更新 systemDark：isThemeMismatch 依赖它实时切换纯色底
      systemDark.value = event.matches
    })
  } catch (e) {
    /* ignore */
  }
}

export function useAppearance() {
  installAppearance()

  const setThemeMode = (mode) => {
    themeMode.value = mode === 'light' || mode === 'dark' ? mode : 'system'
    saveDoc()
  }

  const setDarkBackground = (enabled) => {
    darkBackgroundEnabled.value = enabled
    saveDoc()
  }

  const setDarkEffect = (effect) => {
    darkEffect.value = effect
    saveDoc()
  }

  return {
    themeMode,
    setThemeMode,
    isDark,
    isThemeMismatch,
    darkBackgroundEnabled,
    setDarkBackground,
    darkEffect,
    setDarkEffect,
  }
}
