// 校验 shared/i18n 两种语言的 key / 占位符一致、无空值、英文无残留中文。
// 用法：npm run i18n:check（build / build:app 自动执行）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = ['zh-CN', 'en-US']
const BASE = path.join(ROOT, 'shared/i18n')

// 英文里允许保留中文的路径（语言名称本身）
const ALLOW_CJK = new Set(['settings.language.zhCN'])
// 某些语言没有对应后缀，空串是有意为之
const ALLOW_EMPTY = new Set(['skill.install.hintManualSuffix'])

const errors = []
const warnings = []

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    errors.push(`${path.relative(ROOT, file)} 不是合法 JSON: ${e.message}`)
    return {}
  }
}

const listFiles = (locale) => {
  const dir = path.join(BASE, locale)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

const flatten = (obj, prefix = '', out = {}) => {
  for (const [key, value] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, full, out)
    } else {
      out[full] = value
    }
  }
  return out
}

const placeholders = (value) => {
  if (typeof value !== 'string') return []
  // 英文复数形式会重复出现同一个 {count}，去重后再比较
  return [...new Set([...value.matchAll(/\{\s*([\w-]+)\s*\}/g)].map((m) => m[1]))].sort()
}

const files = Object.fromEntries(LOCALES.map((locale) => [locale, listFiles(locale)]))
const allFiles = [...new Set([...files['zh-CN'], ...files['en-US']])].sort()

for (const name of allFiles) {
  for (const locale of LOCALES) {
    if (!files[locale].includes(name)) {
      errors.push(`缺少文件 ${locale}/${name}`)
    }
  }
  const zhFile = path.join(BASE, 'zh-CN', name)
  const enFile = path.join(BASE, 'en-US', name)
  if (!fs.existsSync(zhFile) || !fs.existsSync(enFile)) continue

  const zh = flatten(readJson(zhFile))
  const en = flatten(readJson(enFile))
  const zhKeys = new Set(Object.keys(zh))
  const enKeys = new Set(Object.keys(en))

  for (const key of zhKeys) {
    if (!enKeys.has(key)) errors.push(`${name}: en-US 缺少 key ${key}`)
  }
  for (const key of enKeys) {
    if (!zhKeys.has(key)) errors.push(`${name}: zh-CN 缺少 key ${key}`)
  }

  for (const key of zhKeys) {
    if (!enKeys.has(key)) continue
    const zhValue = zh[key]
    const enValue = en[key]
    // 空串是允许的（有些语言没有对应后缀，例如英文的 hintManualSuffix），只提示不拦截
    if (!ALLOW_EMPTY.has(key)) {
      if (typeof zhValue === 'string' && !zhValue.trim()) warnings.push(`${name}: zh-CN ${key} 为空`)
      if (typeof enValue === 'string' && !enValue.trim()) warnings.push(`${name}: en-US ${key} 为空`)
    }

    const zhVars = placeholders(zhValue).join(',')
    const enVars = placeholders(enValue).join(',')
    if (zhVars !== enVars) {
      errors.push(`${name}: ${key} 占位符不一致（zh: [${zhVars}] / en: [${enVars}]）`)
    }

    if (typeof enValue === 'string' && !ALLOW_CJK.has(key) && /[㐀-鿿]/.test(enValue)) {
      errors.push(`${name}: en-US ${key} 仍含中文: ${enValue}`)
    }
  }
}

if (warnings.length) {
  console.warn(warnings.map((w) => `⚠️  ${w}`).join('\n'))
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'))
  console.error(`\n❌ i18n 校验失败：${errors.length} 个问题`)
  process.exit(1)
}

console.log(`✓ i18n 文案一致（${allFiles.length} 个文件，${LOCALES.join(' / ')}）`)
