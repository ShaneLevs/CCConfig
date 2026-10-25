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
