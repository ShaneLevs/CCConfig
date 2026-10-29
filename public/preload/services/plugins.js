const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const { t } = require('./i18n')
const { isDirEntry, isFileEntry } = require('./fs-utils')

const HOME = () => require('os').homedir()
const PLUGINS_DIR = () => path.join(HOME(), '.claude', 'plugins')
const KNOWN_MARKETPLACES_PATH = () => path.join(PLUGINS_DIR(), 'known_marketplaces.json')
const PLUGIN_CMD_TIMEOUT = 30_000 // 30 秒超时

// ==================== 工具函数 ====================

const readJson = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, { encoding: 'utf-8' }))
  } catch { return null }
}

const listSubdirNames = (dir) => {
  try {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => isDirEntry(dir, d))
      .map(d => d.name)
  } catch { return [] }
}

const visitMdStems = (dir, prefix, depth, visitor) => {
  try {
    if (!fs.existsSync(dir) || depth > 5) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (isDirEntry(dir, entry)) {
        visitMdStems(path.join(dir, entry.name), prefix + entry.name + '/', depth + 1, visitor)
      } else if (isFileEntry(dir, entry) && entry.name.endsWith('.md')) {
        visitor(prefix + entry.name.replace(/\.md$/, ''), depth)
      }
    }
  } catch { /* ignore */ }
}

// ==================== 组件发现 ====================

const discoverPluginComponents = (pluginDir, lspServersJson) => {
  const skills = listSubdirNames(path.join(pluginDir, 'skills'))

  const commands = []
  visitMdStems(path.join(pluginDir, 'commands'), '', 0, (name) => commands.push(name))

  const agents = []
  visitMdStems(path.join(pluginDir, 'agents'), '', 0, (name) => agents.push(name))

  let hooks = []
  const hooksDir = path.join(pluginDir, 'hooks')
  if (fs.existsSync(hooksDir)) {
    try {
      hooks = fs.readdirSync(hooksDir, { withFileTypes: true })
        .filter(d => isFileEntry(hooksDir, d) && !d.name.endsWith('.json') && !d.name.endsWith('.cmd'))
        .map(d => d.name)
    } catch { /* ignore */ }
  }
  if (hooks.length === 0 && fs.existsSync(path.join(pluginDir, 'hooks.json'))) {
    hooks = ['hooks.json']  // 有配置但无独立脚本时给个标记
  }

  let mcpServers = []
  const mcpJson = readJson(path.join(pluginDir, '.mcp.json'))
  if (mcpJson && typeof mcpJson === 'object' && !Array.isArray(mcpJson)) {
    mcpServers = Object.keys(mcpJson)
  }

  let lspServers = []
  if (lspServersJson && typeof lspServersJson === 'object' && !Array.isArray(lspServersJson)) {
    lspServers = Object.keys(lspServersJson)
  }

  return { skills, commands, agents, hooks, mcpServers, lspServers }
}

// ==================== 输入校验 ====================

const validatePluginName = (name) => {
  if (!name || name.length === 0) return { valid: false, error: t('service.plugin.nameRequired') }
  if (name.length > 256) return { valid: false, error: t('service.plugin.nameTooLong') }
  const valid = [...name].every(c => /[a-zA-Z0-9\-_.@/]/.test(c))
  if (!valid) return { valid: false, error: t('service.plugin.nameInvalidChars', { name }) }
  return { valid: true }
}

const validateScope = (scope) => {
  if (!['user', 'project', 'local', 'managed'].includes(scope)) {
    return {
      valid: false,
      error: t('service.plugin.invalidScope', { scope }),
    }
  }
  return { valid: true }
}

const validateMarketplaceSource = (source) => {
  if (!source || source.length === 0) return { valid: false, error: t('service.plugin.sourceRequired') }
  if (source.length > 1024) return { valid: false, error: t('service.plugin.sourceTooLong') }
  const dangerous = [';', '|', '&', '`', '$', '(', ')', '{', '}', '<', '>', '\n', '\r']
  for (const c of dangerous) {
    if (source.includes(c)) {
      return {
        valid: false,
        error: t('service.plugin.sourceInvalidChars', { char: c }),
      }
    }
  }
  return { valid: true }
}

// ==================== CLI 执行引擎 ====================

// 查找 claude 可执行文件
const resolveClaudePath = () => {
  // 尝试常见路径
  const candidates = [
    path.join(HOME(), '.local', 'bin', 'claude'),
    path.join(HOME(), '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* ignore */ }
  }
  // 尝试从 PATH 中查找
  try {
    const which = execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim()
    if (which) return which
  } catch { /* ignore */ }
  return 'claude' // fallback
}

const runPluginCommand = (args, cwd) => {
  const argsStr = args.join(' ')
  const claudeBin = resolveClaudePath()
  const fullCmd = `"${claudeBin}" plugin ${argsStr}`

  // 构建环境变量：移除 CLAUDECODE 避免嵌套问题
  const env = { ...process.env }
  delete env.CLAUDECODE

  const options = { encoding: 'utf-8', timeout: PLUGIN_CMD_TIMEOUT, env }
  if (cwd && fs.existsSync(cwd)) {
    options.cwd = cwd
  }

  console.log(`[plugins] 执行: ${fullCmd}`)
  try {
    const stdout = execSync(fullCmd, options)
    return { success: true, stdout: stdout.trim(), stderr: '' }
  } catch (error) {
    const stderr = error.stderr || error.message || ''
    const stdout = error.stdout || ''
    return { success: false, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
  }
}

// ==================== Marketplace 仓库管理 ====================

const listMarketplaces = () => {
  try {
    const knownPath = KNOWN_MARKETPLACES_PATH()
    const entries = readJson(knownPath)
    if (!entries) return []

    const result = []
    for (const [name, entry] of Object.entries(entries)) {
      const manifestPath = path.join(entry.installLocation || entry.install_location || '', '.claude-plugin', 'marketplace.json')
      const manifest = readJson(manifestPath)
      const pluginCount = manifest?.plugins?.length || 0

      result.push({
        name,
        source: entry.source,
        installLocation: entry.installLocation || entry.install_location || '',
        lastUpdated: entry.lastUpdated || entry.last_updated || null,
        pluginCount,
      })
    }
    return result
  } catch (error) {
    console.error('[plugins] 列出 marketplace 失败:', error)
    return []
  }
}

const addMarketplace = (source) => {
  try {
    const validation = validateMarketplaceSource(source)
    if (!validation.valid) return { success: false, message: validation.error }

    const result = runPluginCommand(['marketplace', 'add', source])
    return { success: result.success, message: result.success ? result.stdout : result.stderr }
  } catch (error) {
    return { success: false, message: error.message || t('service.plugin.addMarketplaceFailed') }
  }
}

const removeMarketplace = (name) => {
  try {
    const validation = validatePluginName(name)
    if (!validation.valid) return { success: false, message: validation.error }

    const result = runPluginCommand(['marketplace', 'remove', name])
    return { success: result.success, message: result.success ? result.stdout : result.stderr }
  } catch (error) {
    return { success: false, message: error.message || t('service.plugin.removeMarketplaceFailed') }
  }
}

const updateMarketplace = (name) => {
  try {
    const args = name ? ['marketplace', 'update', name] : ['marketplace', 'update']
    if (name) {
      const validation = validatePluginName(name)
      if (!validation.valid) return { success: false, message: validation.error }
    }
    const result = runPluginCommand(args)
    return { success: result.success, message: result.success ? result.stdout : result.stderr }
  } catch (error) {
    return { success: false, message: error.message || t('service.plugin.updateMarketplaceFailed') }
  }
}

// ==================== Marketplace 插件浏览 ====================

const listMarketplacePlugins = () => {
  try {
    const marketplaces = listMarketplaces()
    const countsPath = path.join(PLUGINS_DIR(), 'install-counts-cache.json')
    const countsCache = readJson(countsPath)
    const countsMap = {}

    if (countsCache?.counts) {
      for (const entry of countsCache.counts) {
        countsMap[entry.plugin] = entry.uniqueInstalls || entry.unique_installs || 0
      }
    }

    const allPlugins = []
    for (const mp of marketplaces) {
      const manifestPath = path.join(mp.installLocation, '.claude-plugin', 'marketplace.json')
      const manifest = readJson(manifestPath)
      if (!manifest?.plugins) continue

      for (const plugin of manifest.plugins) {
        const countKey = `${plugin.name}@${mp.name}`
        const installCount = countsMap[countKey] || 0

        // 判断是否为本地插件 (source 以 "./" 开头)
        const source = plugin.source
        const isLocal = typeof source === 'string' && source.startsWith('./')

        let components = { skills: [], commands: [], agents: [], hooks: [], mcpServers: [], lspServers: [] }
        if (isLocal) {
          const pluginDir = path.join(mp.installLocation, source)
          components = discoverPluginComponents(pluginDir, plugin.lspServers || plugin.lsp_servers)
        }

        allPlugins.push({
          name: plugin.name,
          description: plugin.description || '',
          version: plugin.version || null,
          author: plugin.author || null,
          category: plugin.category || null,
          homepage: plugin.homepage || null,
          source: plugin.source || null,
          tags: plugin.tags || [],
          strict: plugin.strict || false,
          marketplaceName: mp.name,
          installCount,
          components,
          isLocal,
        })
      }
    }

    // 按安装次数降序排序
    allPlugins.sort((a, b) => b.installCount - a.installCount)
    return allPlugins
  } catch (error) {
    console.error('[plugins] 列出 marketplace 插件失败:', error)
    return []
  }
}

// ==================== 已安装插件 ====================

const listInstalledPlugins = () => {
  try {
    const result = runPluginCommand(['list', '--json'])
    console.log('[plugins] list --json result.success:', result.success, 'stdout.length:', result.stdout?.length)
    if (!result.success || !result.stdout) return []
    const raw = JSON.parse(result.stdout)
    console.log('[plugins] raw installed count:', raw.length)

    // claude plugin list --json 返回的字段是 id 而不是 name
    // id 格式: pluginName@marketplaceName
    return (Array.isArray(raw) ? raw : []).map(plugin => {
      const id = plugin.id || ''
      const lastAt = id.lastIndexOf('@')
      const name = lastAt > 0 ? id.slice(0, lastAt) : id
      const marketplace = lastAt > 0 ? id.slice(lastAt + 1) : plugin.marketplace || null

      return {
        name,
        description: plugin.description || '',
        version: plugin.version || null,
        scope: plugin.scope || 'user',
        enabled: plugin.enabled !== false,
        marketplace,
        pluginId: id,
        installPath: plugin.installPath || null,
        installedAt: plugin.installedAt || null,
        lastUpdated: plugin.lastUpdated || null,
      }
    })
  } catch (error) {
    console.error('[plugins] 列出已安装插件失败:', error)
    return []
  }
}

// ==================== 插件生命周期操作 ====================

const pluginLifecycleOp = (verb, name, scope, cwd) => {
  try {
    const nameValidation = validatePluginName(name)
    if (!nameValidation.valid) return { success: false, message: nameValidation.error }

    const scopeValidation = validateScope(scope)
    if (!scopeValidation.valid) return { success: false, message: scopeValidation.error }

    // project/local scope 需要 cwd
    if ((scope === 'project' || scope === 'local') && (!cwd || !fs.existsSync(cwd))) {
      return {
        success: false,
        message: t('service.plugin.scopeRequiresCwd', { scope }),
      }
    }

    const result = runPluginCommand([verb, name, '--scope', scope], scope === 'project' || scope === 'local' ? cwd : undefined)
    return { success: result.success, message: result.success ? result.stdout : result.stderr }
  } catch (error) {
    return {
      success: false,
      message: error.message || t('service.plugin.operationFailed', { verb }),
    }
  }
}

const installPlugin = (name, scope, cwd) => pluginLifecycleOp('install', name, scope, cwd)
const uninstallPlugin = (name, scope, cwd) => pluginLifecycleOp('uninstall', name, scope, cwd)
const enablePlugin = (name, scope, cwd) => pluginLifecycleOp('enable', name, scope, cwd)
const disablePlugin = (name, scope, cwd) => pluginLifecycleOp('disable', name, scope, cwd)
const updatePlugin = (name, scope, cwd) => pluginLifecycleOp('update', name, scope, cwd)

// ==================== 工具 ====================

const getPluginsDir = () => {
  const dir = PLUGINS_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

const openPluginsDir = () => {
  const dir = getPluginsDir()
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

const getInstalledPluginComponents = (installPath, pluginName) => {
  try {
    // 优先使用 installPath，否则尝试默认路径 ~/.claude/plugins/<name>/
    let dir = installPath || null
    if (!dir || !fs.existsSync(dir)) {
      if (pluginName) {
        dir = path.join(PLUGINS_DIR(), pluginName)
      }
    }
    if (!dir || !fs.existsSync(dir)) return null
    return discoverPluginComponents(dir, null)
  } catch { return null }
}

module.exports = {
  listMarketplaces,
  addMarketplace,
  removeMarketplace,
  updateMarketplace,
  listMarketplacePlugins,
  listInstalledPlugins,
  installPlugin,
  uninstallPlugin,
  enablePlugin,
  disablePlugin,
  updatePlugin,
  getPluginsDir,
  openPluginsDir,
  getInstalledPluginComponents,
  discoverPluginComponents,
  validatePluginName,
  validateScope,
  validateMarketplaceSource,
}
