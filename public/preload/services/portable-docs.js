// 可移植文档白名单：这些数据属于「用户配置」，通过 uTools 数据库的云同步在设备间保持。
//
// 只有下列文档会双写到 `utools.db`（uTools 版），桌面端和 uTools 版都通过本地共享库读写。
// 统计、缓存、外观、语言、Agent 显隐、MCP 本地状态/路径、网关配置、active config、
// runtime id 等属于机器档，继续只存本机 `~/.ccconfig/db`。
//
// 旧版没有 nativeId 后缀、会被 uTools 云同步覆盖的文档，就是这里列出的这些。
const PORTABLE_IDS = new Set([
  'ccconfig_common_providers', // 通用供应商 + 模型主数据
  'ccconfig_common_mcp', // 通用 MCP 主档
  'extra_field_keys', // 自定义 env 字段候选
  'ccconfig_group_order', // Claude 配置分组顺序
])

const PORTABLE_PREFIXES = [
  'ccconfig_config_', // Claude 配置（含 dispatch 生成的配置）
]

const isPortableDoc = (id) =>
  typeof id === 'string' &&
  (PORTABLE_IDS.has(id) || PORTABLE_PREFIXES.some((prefix) => id.startsWith(prefix)))

module.exports = { isPortableDoc, PORTABLE_IDS, PORTABLE_PREFIXES }
