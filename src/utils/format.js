import { t } from '../i18n'

// 数字缩写展示（模型上下文窗口 / 最大输出等）。
// 保留各视图的差异：小数位、是否裁掉 .0、0 的展示文案（默认/空）。
export const formatCompactNumber = (n, options = {}) => {
  const { zeroLabel = '', decimals = 1, trimZero = false, units = ['K', 'M'] } = options
  if (!n) return zeroLabel
  const trim = (value) => {
    const text = value.toFixed(decimals)
    return trimZero ? text.replace(/\.0+$/, '') : text
  }
  if (n >= 1000000) return trim(n / 1000000) + (units[1] || 'M')
  if (n >= 1000) return trim(n / 1000) + (units[0] || 'K')
  return String(n)
}

// 兼容既有调用：0/空 → 「默认」，≥1M → x.xM，≥1K → x.xK
export const formatNumber = (n) =>
  formatCompactNumber(n, { zeroLabel: t('common.default'), decimals: 1 })

// 使用统计数据缩写。mode: 'compact' → K/M/B/T/Q，'cn' → 万/亿/万亿。
// decimals 传 'auto' 时按换算后的数值量级选 0/1/2 位（图表轴用）。
export const STAT_UNIT_COMPACT = 'compact'
export const STAT_UNIT_CN = 'cn'

const formatScaled = (value, decimals, trimZero) => {
  const digits = decimals === 'auto' ? (value >= 100 ? 0 : value >= 10 ? 1 : 2) : decimals
  const text = value.toFixed(digits)
  if (!trimZero) return text
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

export const formatStatNumber = (num, options = {}) => {
  // 万/亿 默认去掉小数尾零（7000万 比 7000.00万 更自然）；K/M/B 保持原有两位小数
  const { mode = STAT_UNIT_COMPACT, decimals = 2, trimZero = mode === STAT_UNIT_CN, zeroLabel = '0' } = options
  if (!num || num <= 0) return zeroLabel

  if (mode === STAT_UNIT_CN) {
    if (num >= 1e12) return formatScaled(num / 1e12, decimals, trimZero) + '万亿'
    if (num >= 1e8) return formatScaled(num / 1e8, decimals, trimZero) + '亿'
    if (num >= 1e4) return formatScaled(num / 1e4, decimals, trimZero) + '万'
    return String(Math.round(num))
  }

  const units = ['', 'K', 'M', 'B', 'T', 'Q']
  let value = num
  let tier = 0
  while (value >= 1000 && tier < units.length - 1) {
    value /= 1000
    tier++
  }
  return tier === 0
    ? String(Math.round(num))
    : formatScaled(value, decimals, trimZero) + units[tier]
}
