import { t } from '../i18n'

// preload 抛出的 Error.message 已经是当前语言的文案；这里只负责在缺失时补一个本地化兜底。
export function errorText(error, fallbackKey = 'common.operationFailed') {
  const message = error && error.message
  return message || t(fallbackKey)
}

// 返回对象：优先 error，其次 message（均可能由 preload 本地化），最后本地化兜底。
export function resultError(result, fallbackKey = 'common.operationFailed') {
  return result?.error || result?.message || t(fallbackKey)
}

// 给带操作前缀的 toast 用：t('common.addFailed', { message: errorText(e) })
export function withMessage(key, error, params = {}) {
  return t(key, { ...params, message: errorText(error) })
}
