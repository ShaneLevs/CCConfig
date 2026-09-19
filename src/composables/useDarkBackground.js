import { ref } from 'vue'

// 深色模式背景特效开关 + 效果选择（模块级单例，App.vue 渲染 / index.vue 设置弹窗共享）
// 关：保留 uTools 8 原生亚克力毛玻璃背景（默认）；开：WebGL canvas 覆盖为背景（仅深色模式生效）
// 按设备区分同步（_<nativeId> 后缀，同 heatmap 先例）：各机器性能不同，特效开关只对单机有意义；
// 旧共享档 ccswitch_dark_background 作首次迁移种子（读到后由下次变更写入本机档）
const getNativeId = () => {
  try {
    return window.utools.getNativeId() || ''
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

function readDoc() {
  try {
    const doc = window.utools?.db?.get(DOC_ID)
    if (!doc && DOC_ID !== LEGACY_DOC_ID) {
      // 本机尚无记录：回退读旧版共享档（只作种子，saveDoc 总写本机档）
      return window.utools.db.get(LEGACY_DOC_ID) || null
    }
    return doc || null
  } catch (e) {
    return null
  }
}

let initialized = false
function init() {
  if (initialized) return
  initialized = true
  const doc = readDoc()
  if (doc) {
    if (typeof doc.enabled === 'boolean') darkBackgroundEnabled.value = doc.enabled
    if (doc.effect === 'prismatic' || doc.effect === 'pixel' || doc.effect === 'aurora' || doc.effect === 'galaxy') darkEffect.value = doc.effect
  }
}

function saveDoc() {
  // 只取本机档的 _rev（旧共享档内容只读，不可覆盖回写）
  let existing = null
  try { existing = window.utools?.db?.get(DOC_ID) } catch (e) { /* ignore */ }
  window.utools?.db?.put({
    _id: DOC_ID,
    enabled: darkBackgroundEnabled.value,
    effect: darkEffect.value,
    ...(existing ? { _rev: existing._rev } : {}),
  })
}

export function useDarkBackground() {
  init()

  const setDarkBackground = (enabled) => {
    darkBackgroundEnabled.value = enabled
    try { saveDoc() } catch (e) { /* ignore write error */ }
  }

  const setDarkEffect = (effect) => {
    darkEffect.value = effect
    try { saveDoc() } catch (e) { /* ignore write error */ }
  }

  return { darkBackgroundEnabled, setDarkBackground, darkEffect, setDarkEffect }
}
