const fs = require('node:fs')
const path = require('node:path')
const JSON5 = require('json5')

const OPENCODE_DIR = path.join(window.utools.getPath('home'), '.config', 'opencode')

// 动态解析配置文件路径：支持 opencode.json 和 opencode.jsonc（JSON with Comments）
// 优先 .json，不存在则检测 .jsonc；都不存在时默认返回 .json（用于写入）
const resolveOpencodeConfigPath = () => {
  const jsonPath = path.join(OPENCODE_DIR, 'opencode.json')
  const jsoncPath = path.join(OPENCODE_DIR, 'opencode.jsonc')
  if (fs.existsSync(jsonPath)) return jsonPath
  if (fs.existsSync(jsoncPath)) return jsoncPath
  return jsonPath
}

const OPENCODE_DATA_DIR = (() => {
  // 新版 Opencode (>= 2025) 数据目录（按优先级）：
  //   1. ~/.local/share/opencode          （macOS/Linux + Windows XDG 模式，通用优先）
  //   2. %LOCALAPPDATA%\opencode          （Windows 常规安装，上面找不到才回退）
  // 注意：preload 环境 process.env.LOCALAPPDATA 可能为空（uTools Electron 精简）
  const home = window.utools.getPath('home')
  const candidates = [
    path.join(home, '.local', 'share', 'opencode'),
  ]
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'opencode'))
  }
  // Windows 兜底：HOME\AppData\Local\opencode
  if (process.platform === 'win32') {
    candidates.push(path.join(home, 'AppData', 'Local', 'opencode'))
  }
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'opencode.db'))) return c } catch { /* ignore */ }
  }
  // 都找不到时返回 XDG 路径（后续逻辑会检测到 DB 不存在并返回空状态）
  return path.join(home, '.local', 'share', 'opencode')
})()
const OPENCODE_DB_PATH = path.join(OPENCODE_DATA_DIR, 'opencode.db')
const OPENCODE_STORAGE_DIR = path.join(OPENCODE_DATA_DIR, 'storage')

const getOpencodeConfigPath = () => resolveOpencodeConfigPath()

const readOpencodeConfig = () => {
  try {
    const configPath = resolveOpencodeConfigPath()
    if (!fs.existsSync(configPath)) return { provider: {}, mcp: {}, plugin: [] }
    const content = fs.readFileSync(configPath, { encoding: 'utf-8' })
    const parsed = JSON5.parse(content)
    if (!parsed.provider) parsed.provider = {}
    if (!parsed.mcp) parsed.mcp = {}
    if (!parsed.plugin) parsed.plugin = []
    return parsed
  } catch (error) {
    console.error('读取 OpenCode 配置失败:', error)
    return { provider: {}, mcp: {}, plugin: [] }
  }
}

const writeOpencodeConfig = (config) => {
  try {
    if (!fs.existsSync(OPENCODE_DIR)) fs.mkdirSync(OPENCODE_DIR, { recursive: true })
    const configPath = resolveOpencodeConfigPath()
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8' })
    return true
  } catch (error) {
    console.error('写入 OpenCode 配置失败:', error)
    return false
  }
}

// ==================== Provider ====================

const getOpencodeProviders = () => {
  const config = readOpencodeConfig()
  return config.provider || {}
}

const setOpencodeProvider = (id, providerConfig) => {
  const config = readOpencodeConfig()
  if (!config.provider) config.provider = {}
  config.provider[id] = providerConfig
  return writeOpencodeConfig(config)
}

// Batch set multiple providers in a single read-write cycle
const setOpencodeProviders = (providersMap) => {
  const config = readOpencodeConfig()
  if (!config.provider) config.provider = {}
  for (const [id, providerConfig] of Object.entries(providersMap)) {
    config.provider[id] = providerConfig
  }
  return writeOpencodeConfig(config)
}

const removeOpencodeProvider = (id) => {
  const config = readOpencodeConfig()
  if (config.provider && config.provider[id]) {
    delete config.provider[id]
    return writeOpencodeConfig(config)
  }
  return false
}

// ==================== MCP ====================

const getOpencodeMcpServers = () => {
  const config = readOpencodeConfig()
  return config.mcp || {}
}

const setOpencodeMcpServer = (id, serverConfig) => {
  const config = readOpencodeConfig()
  if (!config.mcp) config.mcp = {}
  config.mcp[id] = serverConfig
  return writeOpencodeConfig(config)
}

const removeOpencodeMcpServer = (id) => {
  const config = readOpencodeConfig()
  if (config.mcp && config.mcp[id]) {
    delete config.mcp[id]
    return writeOpencodeConfig(config)
  }
  return false
}

// ==================== Plugin ====================

const getOpencodePlugins = () => {
  const config = readOpencodeConfig()
  return config.plugin || []
}

const setOpencodePlugins = (plugins) => {
  const config = readOpencodeConfig()
  config.plugin = plugins
  return writeOpencodeConfig(config)
}

const addOpencodePlugin = (pluginName) => {
  const config = readOpencodeConfig()
  if (!config.plugin) config.plugin = []
  if (!config.plugin.includes(pluginName)) {
    config.plugin.push(pluginName)
  }
  return writeOpencodeConfig(config)
}

const installOpencodePlugin = (pluginName) => {
  const { execSync } = require('node:child_process')
  if (!fs.existsSync(OPENCODE_DIR)) fs.mkdirSync(OPENCODE_DIR, { recursive: true })
  // 确保有 package.json，否则 npm install 会失败
  const pkgPath = path.join(OPENCODE_DIR, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ private: true }, null, 2))
  }
  execSync(`npm install "${pluginName}"`, { cwd: OPENCODE_DIR, stdio: 'pipe', timeout: 120_000 })
  // 安装成功后写入配置
  const config = readOpencodeConfig()
  if (!config.plugin) config.plugin = []
  if (!config.plugin.includes(pluginName)) config.plugin.push(pluginName)
  return writeOpencodeConfig(config)
}

const removeOpencodePlugin = (pluginName) => {
  const config = readOpencodeConfig()
  if (config.plugin) {
    config.plugin = config.plugin.filter(p => p !== pluginName)
  }
  return writeOpencodeConfig(config)
}

const uninstallOpencodePlugin = (pluginName) => {
  const { execSync } = require('node:child_process')
  // 先从配置移除
  removeOpencodePlugin(pluginName)
  // 卸载 npm 包
  execSync(`npm uninstall "${pluginName}"`, { cwd: OPENCODE_DIR, stdio: 'pipe', timeout: 60_000 })
  return true
}

// ==================== npm Registry 搜索 ====================

const searchOpencodePlugins = (query = 'opencode-plugin') => {
  const https = require('node:https')
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/-/v1/search?text=keywords:${encodeURIComponent(query)}&size=30`
    https.get(url, {
      headers: { 'user-agent': 'CCSwitch/1.0', 'accept': 'application/json' },
      timeout: 10000,
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const packages = (json.objects || []).map(o => ({
            name: o.package.name,
            version: o.package.version,
            description: o.package.description || '',
            publisher: o.package.publisher?.username || '',
            keywords: o.package.keywords || [],
            date: o.package.date,
          }))
          resolve(packages)
        } catch (e) { reject(e) }
      })
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')) })
  })
}

// ==================== Skills ====================

const OPENCODE_SKILLS_PATH = path.join(OPENCODE_DIR, 'skills')

const getOpencodeSkills = () => {
  try {
    if (!fs.existsSync(OPENCODE_SKILLS_PATH)) return []
    const entries = fs.readdirSync(OPENCODE_SKILLS_PATH, { withFileTypes: true })
    const skills = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillName = entry.name
      const skillPath = path.join(OPENCODE_SKILLS_PATH, skillName)
      const skillMdPath = path.join(skillPath, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue
      try {
        const content = fs
          .readFileSync(skillMdPath, { encoding: 'utf-8' })
          .replace(/^\uFEFF/, '')
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
        const frontmatter = frontmatterMatch ? frontmatterMatch[1] : ''
        const fileCount = fs.readdirSync(skillPath).length
        skills.push({ name: skillName, frontmatter, path: skillPath, skillMdPath, fileCount })
      } catch (e) {
        console.error('读取 OpenCode skill 失败:', skillMdPath, e)
      }
    }
    return skills
  } catch (error) {
    console.error('读取 OpenCode skills 目录失败:', error)
    return []
  }
}

const deleteOpencodeSkill = (skillName) => {
  try {
    const skillPath = path.join(OPENCODE_SKILLS_PATH, skillName)
    if (!fs.existsSync(skillPath)) return { success: false, error: 'Skill 不存在' }
    fs.rmSync(skillPath, { recursive: true, force: true })
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

const getOpencodeSkillsPath = () => {
  if (!fs.existsSync(OPENCODE_SKILLS_PATH)) fs.mkdirSync(OPENCODE_SKILLS_PATH, { recursive: true })
  return OPENCODE_SKILLS_PATH
}

// ==================== Usage Statistics ====================

// 统计计算（SQLite 优先、JSON storage 回退，多层出口）
const readOpencodeUsageRaw = () => {
  const usage = require('./usage')
  // 优先 SQLite，回退 JSON storage
  if (fs.existsSync(OPENCODE_DB_PATH)) {
    try {
      const data = readOpencodeUsageFromDb(OPENCODE_DB_PATH)
      if (data.messageRecords.length > 0) return data
    } catch (e) {
      console.warn('[opencode] SQLite 读取失败，回退 JSON storage:', e.message)
    }
  }
  if (fs.existsSync(OPENCODE_STORAGE_DIR)) {
    try {
      return readOpencodeUsageFromJson(OPENCODE_STORAGE_DIR)
    } catch (e) {
      console.warn('[opencode] JSON storage 读取失败:', e.message)
    }
  }
  return usage.calculateStats([], new Map())
}

// 入口：计算完成后统一落库（「通用」统计页数据源；全零结果由落库层跳过，不会清空历史）
const readOpencodeUsage = () => {
  const stats = readOpencodeUsageRaw()
  try {
    require('./usage').saveAgentUsage('opencode', stats.contributions)
  } catch (e) {
    console.error('[opencode] usage 落库失败:', e)
  }
  return stats
}

const readOpencodeUsageFromDb = (dbPath) => {
  const usage = require('./usage')
  // 优先用原生 node:sqlite（Node 22.5+）
  let DatabaseSync
  try {
    ({ DatabaseSync } = require('node:sqlite'))
  } catch {
    DatabaseSync = null
  }

  if (DatabaseSync) {
    try {
      const result = readOpencodeUsageFromDbNative(dbPath, DatabaseSync)
      if (result.messageRecords.length > 0) return result
    } catch (e) {
      console.warn('[opencode] node:sqlite 读取失败，回退子进程方式:', e.message)
    }
  }

  // 回退：通过子进程调用 node --experimental-sqlite 脚本
  try {
    return readOpencodeUsageFromDbViaChildProcess(dbPath)
  } catch (e) {
    console.warn('[opencode] 子进程读取也失败:', e.message)
    return usage.calculateStats([], new Map())
  }
}

const parseOpenCodeModel = (raw) => {
  if (!raw || raw === 'unknown') return 'unknown'
  try {
    const m = JSON.parse(raw)
    if (typeof m === 'object' && m !== null) {
      return m.id || m.model || m.name || 'unknown'
    }
    if (typeof m === 'string' && m) return m
  } catch { /* not JSON */ }
  return raw
}

// 从 part 表 data JSON 提取 token（回退逻辑：当 session 表 token 全为 0 时）
// StepFinishPart 结构：{ type: "step-finish", cost: number, tokens: { input, output, reasoning, cache: { read, write } } }
function computeTokensFromParts(db) {
  const result = new Map()
  try {
    const rows = db.prepare("SELECT session_id, data FROM part WHERE json_extract(data, '$.type') = 'step-finish'").all()
    for (const r of rows) {
      try {
        const data = JSON.parse(r.data)
        if (!data.tokens) continue
        const existing = result.get(r.session_id) || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
        existing.input += data.tokens.input || 0
        existing.output += data.tokens.output || 0
        existing.reasoning += data.tokens.reasoning || 0
        existing.cacheRead += data.tokens.cache?.read || 0
        existing.cacheWrite += data.tokens.cache?.write || 0
        result.set(r.session_id, existing)
      } catch { /* skip malformed JSON */ }
    }
  } catch { /* part 表可能不存在 */ }
  return result
}

const readOpencodeUsageFromDbNative = (dbPath, DatabaseSync) => {
  const usage = require('./usage')
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    // 新版 OpenCode 会话数据迁到了 session_v2（旧 session 表仅存历史且新行 token 恒为 0），两表并集按 id 去重
    const sessionTables = ['session', 'session_v2'].filter((t) => tables.includes(t))
    if (!sessionTables.length) return usage.calculateStats([], new Map())

    const sessionMap = new Map()
    const messageRecords = []
    for (const tbl of sessionTables) {
      const cols = new Set(db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name))
      if (!cols.has('id') || !cols.has('time_created')) continue
      const has = (n) => (cols.has(n) ? n : null)
      const sel = (c, alias) => (c ? `${c} as ${alias}` : `null as ${alias}`)
      const sInputCol = has('tokens_input')
      const sOutputCol = has('tokens_output')

      const sessions = db.prepare(
        `SELECT id, ${sel(has('title'), 'title')}, ${sel(has('directory'), 'directory')}, ${sel(has('model'), 'model')}, time_created, time_updated FROM ${tbl}`
      ).all()
      for (const s of sessions) {
        if (sessionMap.has(s.id)) continue
        const ts = new Date(s.time_created).toISOString()
        sessionMap.set(s.id, {
          sessionId: s.id,
          timestamp: ts,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          project: s.directory || s.title || 'unknown',
          projectPath: s.directory || 'unknown',
          title: s.title || '',
          model: parseOpenCodeModel(s.model),
        })
      }

      // WHERE 子句动态构建，避免引用不存在的列导致 SQL 报错
      const conditions = []
      if (sInputCol) conditions.push(`${sInputCol} > 0`)
      if (sOutputCol) conditions.push(`${sOutputCol} > 0`)
      const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' OR ')}` : ''
      const tokenSql = `SELECT id, ${sel(has('model'), 'model')}, ${sel(sInputCol, 'inp')}, ${sel(sOutputCol, 'out')}, ${sel(has('tokens_reasoning'), 'reas')}, ${sel(has('tokens_cache_read'), 'cread')}, ${sel(has('tokens_cache_write'), 'cwrite')}, time_created FROM ${tbl}${whereClause}`
      const rows = db.prepare(tokenSql).all()
      for (const r of rows) {
        const tsMs = r.time_created
        if (!tsMs || tsMs <= 0) continue
        const ts = new Date(tsMs).toISOString()
        const total = (r.inp || 0) + (r.out || 0) + (r.reas || 0) + (r.cread || 0) + (r.cwrite || 0)
        if (total === 0) continue
        messageRecords.push({
          sessionId: r.id,
          model: parseOpenCodeModel(r.model) || sessionMap.get(r.id)?.model || 'unknown',
          project: sessionMap.get(r.id)?.project || 'unknown',
          projectPath: sessionMap.get(r.id)?.projectPath || 'unknown',
          timestamp: ts,
          date: ts.split('T')[0],
          inputTokens: r.inp || 0,
          outputTokens: r.out || 0,
          cacheReadTokens: r.cread || 0,
          cacheCreationTokens: r.cwrite || 0,
          totalTokens: total,
        })
        if (sessionMap.has(r.id)) {
          const sess = sessionMap.get(r.id)
          sess.inputTokens = r.inp || 0
          sess.outputTokens = r.out || 0
          sess.cacheReadTokens = r.cread || 0
          sess.cacheCreationTokens = r.cwrite || 0
          sess.timestamp = ts
        }
      }
    }

    // 回退：如果 session 表 token 全为 0，尝试从 part 表计算
    if (messageRecords.length === 0 && tables.includes('part')) {
      const partTokens = computeTokensFromParts(db)
      for (const [sessionID, tokens] of partTokens.entries()) {
        const sess = sessionMap.get(sessionID)
        if (!sess) continue
        sess.inputTokens = tokens.input
        sess.outputTokens = tokens.output
        sess.cacheReadTokens = tokens.cacheRead
        sess.cacheCreationTokens = tokens.cacheWrite
        const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning
        if (total > 0) {
          messageRecords.push({
            sessionId: sessionID,
            model: sess.model,
            project: sess.project,
            projectPath: sess.projectPath,
            timestamp: sess.timestamp,
            date: (sess.timestamp || '').split('T')[0],
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadTokens: tokens.cacheRead,
            cacheCreationTokens: tokens.cacheWrite,
            totalTokens: total,
          })
        }
      }
    }

    return usage.calculateStats(messageRecords, sessionMap)
  } finally {
    db.close()
  }
}

const readOpencodeUsageFromDbViaChildProcess = (dbPath) => {
  const usage = require('./usage')
  const { execSync } = require('node:child_process')
  const fs = require('node:fs')
  const os = require('os')
  const tmpScript = path.join(os.tmpdir(), 'oc_usage_reader.js')
  const script = `
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbPath)}, {open:true, readOnly:true});
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
    const sessionTables = ['session','session_v2'].filter(t=>tables.includes(t));
    if (!sessionTables.length) { db.close(); process.stdout.write('[]'); process.exit(0); }
    const rows = [];
    const seen = new Set();
    for (const tbl of sessionTables) {
      const cols = new Set(db.prepare('PRAGMA table_info('+tbl+')').all().map(c=>c.name));
      if (!cols.has('id') || !cols.has('time_created')) continue;
      const h = function(n){ return cols.has(n) ? n : 'null'; };
      const sql = 'SELECT id, '+h('model')+' as model, '+h('tokens_input')+' as inp, '+h('tokens_output')+' as out, '+h('tokens_reasoning')+' as reas, '+h('tokens_cache_read')+' as cread, '+h('tokens_cache_write')+' as cwrite, time_created, '+h('directory')+' as directory, '+h('title')+' as title FROM '+tbl;
      for (const r of db.prepare(sql).all()) { if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); } }
    }

    // 回退：session token 全为 0 时，从 part 表计算
    const allZero = rows.every(r => !((r.inp||0) + (r.out||0) + (r.reas||0) + (r.cread||0) + (r.cwrite||0)));
    if (allZero) {
      try {
        const parts = db.prepare("SELECT session_id, data FROM part WHERE json_extract(data, '$.type') = 'step-finish'").all();
        const partMap = {};
        for (const p of parts) {
          try {
            const d = JSON.parse(p.data);
            if (!d.tokens) continue;
            const sid = p.session_id;
            if (!partMap[sid]) partMap[sid] = {input:0, output:0, reasoning:0, cacheRead:0, cacheWrite:0};
            partMap[sid].input += d.tokens.input || 0;
            partMap[sid].output += d.tokens.output || 0;
            partMap[sid].reasoning += d.tokens.reasoning || 0;
            partMap[sid].cacheRead += (d.tokens.cache && d.tokens.cache.read) || 0;
            partMap[sid].cacheWrite += (d.tokens.cache && d.tokens.cache.write) || 0;
          } catch {}
        }
        // 将 part 计算结果合并到 rows
        for (const r of rows) {
          const pt = partMap[r.id];
          if (pt) {
            r.inp = pt.input;
            r.out = pt.output;
            r.reas = pt.reasoning;
            r.cread = pt.cacheRead;
            r.cwrite = pt.cacheWrite;
          }
        }
      } catch {}
    }

    db.close();
    process.stdout.write(JSON.stringify(rows));
  `
  fs.writeFileSync(tmpScript, script)
  try {
    const stdout = execSync(`node --experimental-sqlite "${tmpScript}"`, {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: '--experimental-sqlite' },
    })
    let rows = []
    try { rows = JSON.parse(stdout) } catch { return usage.calculateStats([], new Map()) }
    const sessionMap = new Map()
    const messageRecords = []
    for (const r of rows) {
      const tsMs = r.time_created
      if (!tsMs || tsMs <= 0) continue
      const ts = new Date(tsMs).toISOString()
      const inp = r.inp || 0, out = r.out || 0, reas = r.reas || 0, cread = r.cread || 0, cwrite = r.cwrite || 0
      const total = inp + out + reas + cread + cwrite
      sessionMap.set(r.id, {
        sessionId: r.id,
        timestamp: ts,
        inputTokens: inp, outputTokens: out,
        cacheReadTokens: cread, cacheCreationTokens: cwrite,
        project: r.directory || r.title || 'unknown',
        projectPath: r.directory || 'unknown',
        title: r.title || '',
        model: parseOpenCodeModel(r.model),
      })
      if (total > 0) {
        messageRecords.push({
          sessionId: r.id, model: parseOpenCodeModel(r.model),
          project: r.directory || r.title || 'unknown',
          projectPath: r.directory || 'unknown',
          timestamp: ts, date: ts.split('T')[0],
          inputTokens: inp, outputTokens: out,
          cacheReadTokens: cread, cacheCreationTokens: cwrite,
          totalTokens: total,
        })
      }
    }
    return usage.calculateStats(messageRecords, sessionMap)
  } finally {
    try { fs.unlinkSync(tmpScript) } catch { /* ignore */ }
  }
}

const readOpencodeUsageFromJson = (storageDir) => {
  const usage = require('./usage')
  const sessionMap = new Map()
  const messageRecords = []

  const sessionDir = path.join(storageDir, 'session')
  const partDir = path.join(storageDir, 'part')

  if (!fs.existsSync(sessionDir)) return usage.calculateStats([], new Map())

  let sessionFiles = []
  try {
    sessionFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'))
  } catch { return usage.calculateStats([], new Map()) }

  for (const sf of sessionFiles) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionDir, sf), 'utf8'))
      const sessionId = s.id || sf.replace('.json', '')
      sessionMap.set(sessionId, {
        sessionId,
        timestamp: s.createdAt || s.updatedAt || '',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        project: s.cwd || s.title || 'unknown',
        projectPath: s.cwd || 'unknown',
      })

      // part 文件：{id}-part-{n}.json
      let partFiles = []
      try {
        partFiles = fs.readdirSync(partDir).filter(f => f.startsWith(sessionId))
      } catch { /* ignore */ }

      for (const pf of partFiles) {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(partDir, pf), 'utf8'))
          if (p.role !== 'assistant') continue
          const u = p.usage || p.metadata?.usage || {}
          const inputTokens = u.inputTokens || u.input_tokens || u.promptTokens || 0
          const outputTokens = u.outputTokens || u.output_tokens || u.completionTokens || 0
          if (inputTokens + outputTokens === 0) continue
          const ts = p.createdAt || p.timestamp || ''
          messageRecords.push({
            sessionId,
            model: p.model || 'unknown',
            project: sessionMap.get(sessionId)?.project || 'unknown',
            projectPath: sessionMap.get(sessionId)?.projectPath || 'unknown',
            timestamp: ts,
            date: typeof ts === 'string' && ts ? ts.split('T')[0] : '',
            inputTokens, outputTokens,
            cacheReadTokens: u.cacheReadTokens || u.cache_read_input_tokens || 0,
            cacheCreationTokens: u.cacheCreationTokens || u.cache_creation_input_tokens || 0,
            totalTokens: inputTokens + outputTokens + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0),
          })
          if (sessionMap.has(sessionId)) {
            const sess = sessionMap.get(sessionId)
            sess.inputTokens += inputTokens
            sess.outputTokens += outputTokens
            sess.cacheReadTokens += u.cacheReadTokens || 0
            sess.cacheCreationTokens += u.cacheCreationTokens || 0
            if (ts && ts > sess.timestamp) sess.timestamp = ts
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return usage.calculateStats(messageRecords, sessionMap)
}

module.exports = {
  getOpencodeConfigPath,
  readOpencodeConfig,
  writeOpencodeConfig,
  getOpencodeProviders,
  setOpencodeProvider,
  setOpencodeProviders,
  removeOpencodeProvider,
  getOpencodeMcpServers,
  setOpencodeMcpServer,
  removeOpencodeMcpServer,
  getOpencodePlugins,
  setOpencodePlugins,
  addOpencodePlugin,
  removeOpencodePlugin,
  installOpencodePlugin,
  uninstallOpencodePlugin,
  searchOpencodePlugins,
  readOpencodeUsage,
  getOpencodeSkills,
  getOpencodeSkillsPath,
  deleteOpencodeSkill,
}
