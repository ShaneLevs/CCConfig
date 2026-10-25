const { getNativeId, getMcpServers, upsertMcpServer, deleteMcpServer } = require('./config')
const { t } = require('./i18n')

// MCP SDK
let _mcpClient, _mcpStdio, _mcpStreamableHttp, _mcpSSE
try {
  _mcpClient = require('@modelcontextprotocol/sdk/client')
  _mcpStdio = require('@modelcontextprotocol/sdk/client/stdio.js')
  _mcpStreamableHttp = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
  _mcpSSE = require('@modelcontextprotocol/sdk/client/sse.js')
} catch (e) {
  console.warn('MCP SDK not available, tool discovery will be disabled:', e.message)
}

// 从登录 shell 获取完整环境变量
const _getShellEnv = () => {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const result = require('node:child_process').execSync(
      `${shell} -l -c 'env'`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const env = { ...process.env }
    for (const line of result.split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) env[line.slice(0, idx)] = line.slice(idx + 1)
    }
    return env
  } catch (e) {
    return process.env
  }
}

const getDisabledMcpServers = () => {
  try {
    const prefix = `ccswitch_mcp_disabled_${getNativeId()}_`
    return window.utools.db.allDocs()
      .filter(d => d._id.startsWith(prefix))
      .map(d => ({ name: d.name, config: d.config, updatedAt: d.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (error) {
    console.error('获取关闭的 MCP 配置失败:', error)
    return []
  }
}

const disableMcpServer = (name) => {
  try {
    const config = getMcpServers()
    if (!config[name]) return { success: false, error: t('service.mcp.notFound') }

    const nativeId = getNativeId()
    const docId = `ccswitch_mcp_disabled_${nativeId}_${name}`
    const existingDoc = window.utools.db.get(docId)
    const doc = { _id: docId, name, config: config[name], nativeId, updatedAt: Date.now() }
    if (existingDoc) doc._rev = existingDoc._rev

    const result = window.utools.db.put(doc)
    if (!result.ok) return { success: false, error: t('service.mcp.saveDbFailed') }

    deleteMcpServer(name)
    return { success: true }
  } catch (error) {
    console.error('关闭 MCP 失败:', error)
    return { success: false, error: error.message }
  }
}

const enableMcpServer = (name) => {
  try {
    const docId = `ccswitch_mcp_disabled_${getNativeId()}_${name}`
    const doc = window.utools.db.get(docId)
    if (!doc) return { success: false, error: t('service.mcp.dbNotFound') }

    const success = upsertMcpServer(name, doc.config)
    if (!success) return { success: false, error: t('service.mcp.writeConfigFailed') }

    window.utools.db.remove(docId)
    return { success: true }
  } catch (error) {
    console.error('开启 MCP 失败:', error)
    return { success: false, error: error.message }
  }
}

const deleteDisabledMcpServer = (name) => {
  try {
    const docId = `ccswitch_mcp_disabled_${getNativeId()}_${name}`
    const doc = window.utools.db.get(docId)
    if (!doc) return { success: false, error: t('service.mcp.configNotFound') }
    const result = window.utools.db.remove(docId)
    return { success: result.ok, error: result.ok ? null : t('service.mcp.deleteFailed') }
  } catch (error) {
    console.error('删除关闭的 MCP 配置失败:', error)
    return { success: false, error: error.message }
  }
}

const getAllMcpServersWithStatus = () => {
  try {
    const enabledServers = getMcpServers()
    const disabledServers = getDisabledMcpServers()
    const result = []

    for (const [name, config] of Object.entries(enabledServers)) {
      result.push({ name, config, enabled: true })
    }

    for (const server of disabledServers) {
      if (!enabledServers[server.name]) {
        result.push({ name: server.name, config: server.config, enabled: false, updatedAt: server.updatedAt })
      }
    }

    return result.sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    console.error('获取 MCP 状态列表失败:', error)
    return []
  }
}

const _tryConnectHttp = async (client, config) => {
  const { StreamableHTTPClientTransport } = _mcpStreamableHttp
  const transportOptions = config.headers
    ? { requestInit: { headers: config.headers } }
    : undefined
  const transport = new StreamableHTTPClientTransport(new URL(config.url), transportOptions)
  await client.connect(transport)
}

const _tryConnectSSE = async (client, config) => {
  const { SSEClientTransport } = _mcpSSE
  const transportOptions = config.headers
    ? { requestInit: { headers: config.headers } }
    : undefined
  const transport = new SSEClientTransport(new URL(config.url), transportOptions)
  await client.connect(transport)
}

const getMcpServerTools = async (config) => {
  if (!_mcpClient) {
    return { success: false, error: t('service.mcp.sdkMissing') }
  }
  let client = null
  try {
    const { Client } = _mcpClient
    client = new Client({ name: 'ccswitch', version: '1.0.0' })

    if (config.type === 'http') {
      // 先尝试 Streamable HTTP，失败后降级到 SSE
      try {
        await _tryConnectHttp(client, config)
      } catch (httpError) {
        try {
          client = new Client({ name: 'ccswitch', version: '1.0.0' })
          await _tryConnectSSE(client, config)
        } catch (sseError) {
          throw new Error(t('service.mcp.connectFailed'))
        }
      }
    } else {
      const { StdioClientTransport } = _mcpStdio
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ..._getShellEnv(), ...(config.env || {}) }
      })
      await client.connect(transport)
    }

    const result = await client.listTools()
    return { success: true, tools: result.tools || [] }
  } catch (error) {
    return { success: false, error: error.message }
  } finally {
    if (client) {
      try { await client.close() } catch (e) { /* 忽略关闭错误 */ }
    }
  }
}

module.exports = {
  getDisabledMcpServers, disableMcpServer, enableMcpServer,
  deleteDisabledMcpServer, getAllMcpServersWithStatus, getMcpServerTools
}
