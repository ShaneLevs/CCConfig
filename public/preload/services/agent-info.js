// Agent 安装状态 + CLI 版本探测（设置 → Agent 显示）。
//
// 判定口径（唯一来源：可执行程序）：
//   installed = CLI 可执行文件存在，或该 Agent 的桌面版应用已安装
//   version   = CLI `--version` 输出里第一个语义化版本；只有桌面版时读应用自身版本
//   forms     = 该 Agent 同时有 CLI 与桌面版两种形态时，分别回传各自的 installed / version，
//               供设置页把「CLI vX · 客户端 vY」一起显示（任一形态缺失就只显示存在的那个）
//
// 不再用配置目录判断：配置/数据目录在卸载后仍然存在，会把已卸载的 Agent 误判为已安装。
// 带桌面版的 Agent：Kimi Code / MiniMax Code / Qoder / ZCode / DSH（应用名 DeepSeek Harness）/
// Reasonix（应用名 Reasonix Studio，与 CLI 是两条独立的安装路径，都要探测）。
//
// 全部返回 Promise：uTools 里 execFile 异步、不阻塞渲染；桌面版走 sidecar 异步任务通道，
// 避免多个 `--version` 子进程卡住主线程。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')

const HOME = os.homedir()
const VERSION_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/
const VERSION_TIMEOUT = 3000
const CACHE_TTL = 30_000

// uTools 从 Dock / Finder 启动时 PATH 很精简，npm / bun / volta 安装的 CLI 会 ENOENT。
// 与 pi-common 的 getExtraPathDirs 同口径（那边未导出，这里保留一份最小集合）。
const getExtraPathDirs = () => {
  const dirs = [
    path.join(HOME, '.npm-global', 'bin'),
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, '.bun', 'bin'),
    path.join(HOME, '.volta', 'bin'),
    path.join(HOME, '.fnm', 'aliases', 'default', 'bin'),
    path.join(HOME, '.asdf', 'shims'),
    path.join(HOME, '.local', 'share', 'mise', 'shims'),
    path.join(HOME, '.nix-profile', 'bin'),
    path.join(HOME, '.opencode', 'bin'),
    path.join(HOME, '.grok', 'bin'),
    path.join(HOME, '.kimi-code', 'bin'),
    path.join(HOME, '.minimax', 'bin'),
    path.join(HOME, '.dsh', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]
  try {
    const nvmRoot = path.join(HOME, '.nvm', 'versions', 'node')
    for (const v of fs.readdirSync(nvmRoot)) dirs.push(path.join(nvmRoot, v, 'bin'))
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
    dirs.push(
      path.join(appData, 'npm'),
      path.join(localAppData, 'pnpm'),
      path.join(localAppData, 'Volta', 'bin'),
      path.join(localAppData, 'Programs', 'nodejs'),
      path.join(HOME, 'scoop', 'shims'),
    )
    if (process.env.NVM_SYMLINK) dirs.push(process.env.NVM_SYMLINK)
    if (process.env.NVM_HOME) dirs.push(process.env.NVM_HOME)
  }
  return dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory()
    } catch {
      return false
    }
  })
}

const buildEnv = () => {
  const env = { ...process.env }
  const extras = getExtraPathDirs()
  if (!extras.length) return env
  // Windows 的键名是 Path，合并时避免 PATH / Path 同时存在
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH'
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === 'path' && k !== pathKey) delete env[k]
  }
  env[pathKey] = [...extras, env[pathKey] || ''].filter(Boolean).join(path.delimiter)
  return env
}

const pathExists = (p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

// ==================== 桌面版应用（仅 macOS / Windows） ====================

const MAC_APP_ROOTS = ['/Applications', path.join(HOME, 'Applications')]

const windowsAppRoots = () => {
  const roots = []
  const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
  roots.push(path.join(localAppData, 'Programs'))
  if (process.env.ProgramFiles) roots.push(process.env.ProgramFiles)
  if (process.env['ProgramFiles(x86)']) roots.push(process.env['ProgramFiles(x86)'])
  return roots
}

const findMacApp = (names) => {
  for (const root of MAC_APP_ROOTS) {
    for (const name of names) {
      const app = path.join(root, `${name}.app`)
      // 只认完整 App Bundle：空壳 / 卸载残留目录不算安装
      if (pathExists(path.join(app, 'Contents', 'Info.plist'))) return app
    }
  }
  return ''
}

const findWindowsAppDir = (names) => {
  for (const root of windowsAppRoots()) {
    for (const name of names) {
      const dir = path.join(root, name)
      try {
        // 目录里必须还有 exe，避免卸载残留的空目录被当成安装
        if (fs.readdirSync(dir).some((f) => /\.exe$/i.test(f))) return dir
      } catch {
        /* 目录不存在 */
      }
    }
  }
  return ''
}

const macAppVersion = (appPath) =>
  new Promise((resolve) => {
    execFile(
      'plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', path.join(appPath, 'Contents', 'Info.plist')],
      { encoding: 'utf-8', timeout: VERSION_TIMEOUT, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()),
    )
  })

// Windows 的 Electron 应用没有可读的版本清单文件，取主 exe 的 ProductVersion / FileVersion
const windowsAppVersion = (appDir) =>
  new Promise((resolve) => {
    let exes = []
    try {
      exes = fs.readdirSync(appDir).filter((f) => /\.exe$/i.test(f))
    } catch {
      return resolve('')
    }
    if (!exes.length) return resolve('')
    const base = path.basename(appDir).toLowerCase()
    const exe = exes.find((f) => f.toLowerCase() === `${base}.exe`) || exes[0]
    const target = path.join(appDir, exe).replace(/'/g, "''")
    const script = `$v = (Get-Item -LiteralPath '${target}').VersionInfo; if ($v.ProductVersion) { $v.ProductVersion } else { $v.FileVersion }`
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', timeout: 5000, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()),
    )
  })

const desktopApp = async (names) => {
  if (process.platform === 'darwin') {
    const app = findMacApp(names)
    if (!app) return null
    return { installed: true, version: await macAppVersion(app) }
  }
  if (process.platform === 'win32') {
    const dir = findWindowsAppDir(names)
    if (!dir) return null
    return { installed: true, version: await windowsAppVersion(dir) }
  }
  return null
}

// ==================== Agent 表 ====================

const AGENTS = [
  { id: 'claude', cli: ['claude'] },
  { id: 'opencode', cli: ['opencode'] },
  { id: 'pi', cli: ['pi'] },
  { id: 'omp', cli: ['omp'] },
  // Reasonix 的两种形态是独立安装路径：CLI（npm i -g reasonix 等）与
  // 桌面客户端 Reasonix Studio（Electron，版本读应用包），任一存在即算已安装
  { id: 'reasonix', cli: ['reasonix'], desktop: ['Reasonix Studio', 'ReasonixStudio'] },
  { id: 'codex', cli: ['codex'] },
  // Kimi Code 的 CLI 命令固定为 kimi（npm 包名 kimi-code，但 bin 名是 kimi）
  { id: 'kimi', cli: ['kimi'], desktop: ['Kimi Code', 'KimiCode'] },
  { id: 'minimax', cli: ['mcode'], desktop: ['MiniMax Code', 'MiniMaxCode'] },
  { id: 'qoder', cli: ['qoder', 'qodercli'], desktop: ['Qoder', 'Qoder CN', 'QoderCN'] },
  { id: 'zcode', cli: ['zcode'], desktop: ['ZCode'] },
  { id: 'hermes', cli: ['hermes'] },
  // DSH 的桌面版应用名是 DeepSeek Harness
  { id: 'dsh', cli: ['dsh'], desktop: ['DeepSeek Harness'] },
  { id: 'grok', cli: ['grok'] },
  { id: 'cline', cli: ['cline'] },
  // Command Code 的命令名不含连字符；同时保留 npm 包提供的兼容别名与带空格的写法
  { id: 'commandcode', cli: ['commandcode', 'command code', 'command-code', 'cmdc'] },
]

// 跑 `cmd --version`：成功时返回 { installed: true, version }，命令不存在 / 超时返回 null。
// 版本取 stdout + stderr 里第一个语义化版本（有的 CLI 把版本写到 stderr）。
const probeCli = (cmd, env) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      ['--version'],
      {
        encoding: 'utf-8',
        timeout: VERSION_TIMEOUT,
        windowsHide: true,
        env,
        // Windows 的 npm 全局包是 .cmd shim，execFile 直接跑会 EINVAL；
        // 带空格的命令名交给 cmd 会被拆成两段，必须保持 shell: false
        shell: process.platform === 'win32' && !cmd.includes(' '),
      },
      (err, stdout, stderr) => {
        const text = `${stdout || ''}\n${stderr || ''}`.trim()
        const match = VERSION_RE.exec(text)
        if (match) return resolve({ installed: true, version: match[1] })
        if (!err) return resolve({ installed: true, version: '' })
        resolve(null)
      },
    )
  })

// 探测单个 Agent。CLI 与桌面版是两条独立安装路径，两者都跑（并行，避免逐个串行等待超时），
// 结果汇总成：
//   forms.cli     = { installed, version }（该 Agent 无 CLI 命令时不出现）
//   forms.desktop = { installed, version }（无桌面版白名单时不出现）
//   installed     = 任一形态存在；version 优先取 CLI，其次桌面版（与原口径一致）
const probeAgent = async (agent, env) => {
  const [cli, desktop] = await Promise.all([
    (async () => {
      for (const cmd of agent.cli || []) {
        const hit = await probeCli(cmd, env)
        if (hit) return hit
      }
      return null
    })(),
    agent.desktop ? desktopApp(agent.desktop) : Promise.resolve(null),
  ])

  const forms = {}
  if ((agent.cli || []).length) forms.cli = cli || { installed: false, version: '' }
  if (agent.desktop) forms.desktop = desktop || { installed: false, version: '' }

  const hit = cli || desktop
  if (!hit) return { installed: false, version: '', forms }
  return { installed: true, version: hit.version || '', forms }
}

let cache = null
let cacheAt = 0
let pending = null

const detectAll = async (env) => {
  const entries = await Promise.all(
    AGENTS.map(async (agent) => [agent.id, await probeAgent(agent, env)]),
  )
  return Object.fromEntries(entries)
}

// 返回 { [agentId]: { installed, version } }；30s 内复用结果，并发调用共享同一次探测。
const getAgentInstallInfo = ({ force = false } = {}) => {
  if (!force && cache && Date.now() - cacheAt < CACHE_TTL) return Promise.resolve(cache)
  if (pending) return pending
  pending = detectAll(buildEnv())
    .then((result) => {
      cache = result
      cacheAt = Date.now()
      pending = null
      return result
    })
    .catch((e) => {
      pending = null
      throw e
    })
  return pending
}

module.exports = { getAgentInstallInfo, AGENTS, probeAgent, probeCli }
