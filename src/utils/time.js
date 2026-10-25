import { i18n, t } from '../i18n'

/**
 * Format a timestamp as a relative time string.
 * @param {number|null} timestamp - Unix timestamp in milliseconds
 * @returns {string}
 */
export function formatLastUsed(timestamp) {
  if (!timestamp) return t('time.neverUsed')
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now - date
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    if (diffHours === 0) {
      const diffMinutes = Math.floor(diffMs / (1000 * 60))
      return diffMinutes <= 1 ? t('time.justNow') : t('time.minutesAgo', { count: diffMinutes })
    }
    return t('time.hoursAgo', { count: diffHours })
  }
  if (diffDays === 1) return t('time.yesterday')
  if (diffDays < 7) return t('time.daysAgo', { count: diffDays })
  if (diffDays < 30) return t('time.weeksAgo', { count: Math.floor(diffDays / 7) })
  return date.toLocaleDateString(i18n.global.locale.value)
}

/**
 * Format a timestamp as a short relative time string（插件安装/更新时间等）。
 * 非法时间戳原样返回。
 * @param {number|string} ts - Unix timestamp in milliseconds
 * @returns {string}
 */
export function formatRelativeTime(ts) {
  if (!ts) return ''
  const date = new Date(ts)
  if (isNaN(date.getTime())) return ts
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (seconds < 60) return t('time.justNow')
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  if (days < 30) return t('time.daysAgo', { count: days })
  return date.toLocaleDateString(i18n.global.locale.value)
}

// 列表连接：英文用逗号 + and，中文用顿号（不依赖 Intl.ListFormat，兼容旧 WebView）
export function formatList(items) {
  const list = (items || []).filter((item) => item != null && item !== '')
  if (list.length === 0) return ''
  const locale = i18n.global.locale.value
  if (locale === 'zh-CN') return list.join(t('common.listSeparator'))
  if (list.length === 1) return String(list[0])
  if (list.length === 2) return `${list[0]} and ${list[1]}`
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`
}
