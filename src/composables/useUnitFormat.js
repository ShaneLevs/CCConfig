import { ref } from 'vue'
import { formatStatNumber, STAT_UNIT_CN, STAT_UNIT_COMPACT } from '../utils/format'

// 使用统计的数字缩写方式：K/M/B（compact）或 万/亿（cn）。
// 按机器隔离（_<nativeId> 后缀），与语言 / 外观偏好一致。
const getNativeId = () => {
  try {
    return window.utools?.getNativeId?.() || ''
  } catch (e) {
    return ''
  }
}

const DOC_ID = (() => {
  const id = getNativeId()
  return id ? `ccconfig_stats_unit_${id}` : 'ccconfig_stats_unit'
})()

const unitMode = ref(STAT_UNIT_COMPACT)

const readDoc = () => {
  try {
    return window.utools?.db?.get(DOC_ID) || null
  } catch (e) {
    return null
  }
}

const saveDoc = (tries = 0) => {
  try {
    const existing = window.utools?.db?.get(DOC_ID) || null
    const doc = { _id: DOC_ID, unit: unitMode.value }
    if (existing?._rev) doc._rev = existing._rev
    const res = window.utools?.db?.put(doc)
    if (res && res.error && res.name === 'conflict' && tries < 1) {
      return saveDoc(tries + 1)
    }
  } catch (e) {
    /* ignore write error */
  }
}

let initialized = false

export function installUnitFormat() {
  if (initialized) return
  initialized = true

  const doc = readDoc()
  if (doc?.unit === STAT_UNIT_CN) unitMode.value = STAT_UNIT_CN
  else if (doc?.unit === STAT_UNIT_COMPACT) unitMode.value = STAT_UNIT_COMPACT
}

export function useUnitFormat() {
  installUnitFormat()

  const setUnitMode = (value) => {
    unitMode.value = value === STAT_UNIT_CN ? STAT_UNIT_CN : STAT_UNIT_COMPACT
    saveDoc()
  }

  // format 读取响应式 unitMode：切换单位后统计页无需重新加载即可刷新。
  const formatStat = (num, options = {}) =>
    formatStatNumber(num, { ...options, mode: unitMode.value })

  return { unitMode, setUnitMode, formatStat }
}
