const crypto = require('node:crypto')
const legacy = require('./legacy')

// 密文格式：`v2:<ivHex>:<ctHex>`
// 改名（ccswitch → ccconfig）时换了加密盐，旧密文是 `<ivHex>:<ctHex>`（无前缀）。
// 带版本前缀而不是「先试新盐、失败再试旧盐」来判定：AES-CBC 用错钥匙解密有约 1/256
// 的概率填充恰好合法，会静默返回乱码而完全不抛错 —— 那会把乱码当 API Key 用。
const VERSION_PREFIX = 'v2:'
const IV_LENGTH = 16

const keyFrom = (salt) => crypto.createHash('sha256').update(salt).digest()

const CURRENT_KEY = keyFrom('ccconfig-encryption-key')
const LEGACY_KEY = keyFrom(legacy.ENCRYPTION_SALT)

const HEX_IV_RE = /^[0-9a-f]{32}:[0-9a-f]+$/i

/** 是否为改名前的旧密文（需要旧盐才能解开，也是迁移要重加密的对象） */
const isLegacyCiphertext = (value) =>
  typeof value === 'string' && !value.startsWith(VERSION_PREFIX) && HEX_IV_RE.test(value)

const aesEncrypt = (key, text) => {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return VERSION_PREFIX + iv.toString('hex') + ':' + encrypted
}

const aesDecrypt = (key, ivHex, encryptedHex) => {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

const encrypt = (text) => {
  if (!text) return ''
  return aesEncrypt(CURRENT_KEY, String(text))
}

const decrypt = (encryptedText) => {
  if (!encryptedText) return ''
  if (typeof encryptedText !== 'string') return encryptedText
  let body = encryptedText
  let key = CURRENT_KEY
  if (body.startsWith(VERSION_PREFIX)) {
    body = body.slice(VERSION_PREFIX.length)
  } else if (isLegacyCiphertext(body)) {
    key = LEGACY_KEY
  } else {
    return encryptedText // 明文（历史遗留/手工写入），原样返回
  }
  const parts = body.split(':')
  if (parts.length !== 2) return encryptedText
  try {
    return aesDecrypt(key, parts[0], parts[1])
  } catch (error) {
    return encryptedText
  }
}

// 简单字符替换加密（Base64字符集 → 打乱字符集）
const encryptString = (str) => {
  if (!str) return ''
  const fromChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
  const toChars =   'QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm9876543210-_='
  return str.split('').map(c => {
    const idx = fromChars.indexOf(c)
    return idx >= 0 ? toChars[idx] : c
  }).join('')
}

const decryptString = (str) => {
  if (!str) return ''
  const fromChars = 'QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm9876543210-_='
  const toChars =   'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
  return str.split('').map(c => {
    const idx = fromChars.indexOf(c)
    return idx >= 0 ? toChars[idx] : c
  }).join('')
}

/** 旧密文 → 当前密文；已是新格式或明文则原样返回。迁移与写回共用。 */
const reencrypt = (value) => {
  if (!isLegacyCiphertext(value)) return value
  const plain = decrypt(value)
  if (plain === value) return value // 解不开就别动，留待人工排查
  return encrypt(plain)
}

module.exports = { encrypt, decrypt, encryptString, decryptString, isLegacyCiphertext, reencrypt }
