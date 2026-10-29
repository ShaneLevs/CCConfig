const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const usage = require('./usage')
const omp = require('./omp')

// ==================== omp 用量统计 ====================
// 数据源：<agentDir>/sessions/<项目目录>/<时间戳>_<uuid>.jsonl（omp 自己的 stats 数据库同源）。
//   目录解析复用 omp.js（PI_CONFIG_DIR / OMP_PROFILE / PI_CODING_AGENT_DIR，与 CLI 一致）。
//
// 布局（见 @oh-my-pi/omp-stats/parser.ts 的 classifyAgentType）：
//   sessions/<project>/<file>.jsonl              主会话（--a--b-- 是工作目录的有损编码）
//   sessions/<project>/<会话目录>/<id>.jsonl      子 agent（task）
//   sessions/<project>/<会话目录>/__advisor.jsonl 顾问
//   archive/sessions/<project>/<file>.jsonl.gz   omp gc 归档（压缩后删除原文件）
//   .jsonl.gz 也可能直接留在 sessions 里（omp gc --compress）
//
// 每条事件是一行 JSON，只在下列类型上取用量（其余类型跳过）：
//   {"type":"session","id","timestamp","cwd"}                      会话头
//   {"type":"message",
//     "message":{"role":"assistant","api","provider","model",
//                "usage":{input,output,cacheRead,cacheWrite,totalTokens,cost:{...}}}}  一次回复
//   {"type":"model_usage","api","provider","model","usage","timestamp",
//     "purpose","role"}                                            对话之外发生的模型调用
//     （压缩 / 标题 / 预测 / 判分 / 子任务探针等），omp 自己的统计库同样计入
//
// 口径（与 Pi Agent 完全一致，UsagePage 直接复用）：
//   输入（含缓存）= input + cacheRead + cacheWrite；输出 = output；单日 tokens = 输入 + 输出。
//   usage.cacheWrite 映射到 cacheCreationTokens（UsagePage 的模型分布按 cacheRead + cacheCreation 累加）。
//   cost 取 usage.cost.total（缺省 0）。
//   日期按时间戳的本地时区取（toISOString 是 UTC，会让东八区凌晨算到前一天）。
// 去重：同一 entry id 在多处出现只算一次（归档副本 / 子 agent 复制会话头）。缺 id 的
//   条目直接跳过——omp 自己的 parser 出于同样的原因跳过（entry_id 是 stats.db 的主键）。
// 落库：ccconfig_agent_usage_omp_<nativeId>（与「通用」统计页同源）；源文件被 gc 清理后
//   回放落库历史，不归零。
// 重统计走后台线程（usage-worker.js 的 omp runner）；冒烟测试 tests/smoke-omp-usage-test.js。

const getOmpSessionsDir = () => path.join(omp.getOmpDir(), 'sessions')
// gc 的归档根目录：path.join(path.dirname(getSessionsDir()), 'archive', 'sessions')
const getOmpArchiveDir = () => path.join(omp.getOmpDir(), 'archive', 'sessions')

const isCompressed = (file) => file.endsWith('.jsonl.gz')
const SESSION_FILE_RE = /\.jsonl(\.gz)?$/

// 会话文件按「相对 sessions / archive 根目录」的相对路径标识，用于把归档副本与
// 活文件会话头对齐（归档会把 .jsonl 改名为 .jsonl.gz，父目录不变）。
const readLines = (file) => {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return null // 正在写入 / 无权限：跳过本次，下次刷新再读
  }
  if (isCompressed(file)) {
    try {
      buf = zlib.gunzipSync(buf)
    } catch {
      return null // 归档正在写入 / 截断：跳过
    }
  }
  return buf.toString('utf-8').split('\n')
}

// 收集会话文件：{ file, projectDir, relPath }
const collectSessionFiles = () => {
  const out = []
  const walk = (root, dir, depth) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // 跳过隐藏文件（.foo.jsonl.lock.os、gc 临时文件）
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      let st = null
      try {
        st = fs.statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(root, full, depth + 1)
        continue
      }
      if (SESSION_FILE_RE.test(entry.name)) {
        const rel = path.relative(root, full).split(path.sep)
        out.push({ file: full, projectDir: rel[0] || '', relPath: rel.join('/') })
      }
    }
  }
  walk(getOmpSessionsDir(), getOmpSessionsDir(), 0)
  walk(getOmpArchiveDir(), getOmpArchiveDir(), 0)
  return out
}

// 项目目录名是工作目录的有损编码：--Users-shane-code-- → /Users/shane/code
const decodeProjectDir = (name) => {
  if (!name || !name.startsWith('-')) return name
  const body = name.replace(/^-+/, '').replace(/-+$/, '')
  if (!body) return name
  const decoded = path.sep + body.split('-').filter(Boolean).join(path.sep)
  return decoded
}

const toNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const localDayKey = (timeMs) => {
  const d = new Date(timeMs)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 条目时间戳：message.timestamp（epoch ms）优先，退回事件信封的 ISO timestamp
const entryTimeMs = (entry, message) => {
  const fromMessage = toNumber(message && message.timestamp)
  if (fromMessage > 0) return fromMessage
  const parsed = Date.parse(entry.timestamp || '')
  return Number.isFinite(parsed) ? parsed : 0
}

// 一条 usage 记录：{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens, cost }
const bucketsOf = (u) => {
  const input = toNumber(u.input)
  const output = toNumber(u.output)
  const cacheRead = toNumber(u.cacheRead)
  const cacheWrite = toNumber(u.cacheWrite)
  const total = input + output + cacheRead + cacheWrite
  const cost = u.cost && typeof u.cost === 'object' ? toNumber(u.cost.total) : 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    cost,
  }
}

const collectUsageRecords = () => {
  const messageRecords = []
  const sessionMap = new Map()
  const seenEntryIds = new Set()

  const touchSession = (sessionId, timeMs, cwd, b) => {
    let sess = sessionMap.get(sessionId)
    if (!sess) {
      sess = {
        sessionId,
        timestamp: '',
        cwd: cwd || '',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 0,
      }
      sessionMap.set(sessionId, sess)
    }
    const iso = new Date(timeMs).toISOString()
    if (!sess.timestamp || iso > sess.timestamp) sess.timestamp = iso
    sess.inputTokens += b.input
    sess.outputTokens += b.output
    sess.cacheReadTokens += b.cacheRead
    sess.cacheCreationTokens += b.cacheWrite
    sess.totalCost += b.cost
  }

  const sessionFiles = collectSessionFiles()

  // 子 agent / 顾问的转录没有 session 头，只能靠所在会话目录归属；而目录名是
  // `<时间戳>_<uuid>`、会话 id 是 `session` 头里的 uuid，两者不同。先扫一遍顶层
  // 会话文件头，建立「<project>/<目录名> → 会话 id」映射，保证子 agent 的用量并进
  // 父会话（否则 sessionCount 会凭空多出一个假会话）。
  const parentIdByDir = new Map()
  for (const f of sessionFiles) {
    const parts = f.relPath.split('/')
    if (parts.length !== 2) continue // 只认顶层会话文件
    const lines = readLines(f.file)
    if (!lines) continue
    for (const line of lines) {
      if (!line.includes('"type":"session"')) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'session' && typeof entry.id === 'string' && entry.id) {
          parentIdByDir.set(`${f.projectDir}/${path.basename(f.relPath, path.extname(f.relPath)).replace(/\.jsonl$/, '')}`, entry.id)
        }
      } catch {
        /* 坏行跳过 */
      }
      break
    }
  }

  for (const sessionFile of sessionFiles) {
    const lines = readLines(sessionFile.file)
    if (!lines) continue
    const relParts = sessionFile.relPath.split('/')
    // <project>/<会话目录>/<file>：会话目录名去掉扩展名后按父会话头映射回真实 id
    const dirKey = relParts.length >= 3
      ? `${sessionFile.projectDir}/${relParts[1].replace(/\.jsonl(\.gz)?$/, '')}`
      : ''
    const fallbackSessionId = dirKey ? parentIdByDir.get(dirKey) || relParts[1] : relParts.join('/')
    let sessionId = fallbackSessionId
    let cwd = decodeProjectDir(sessionFile.projectDir)
    let project = path.basename(cwd) || sessionFile.projectDir

    for (const line of lines) {
      // 廉价子串过滤：会话文件里 tool 结果 / systemPrompt 单行可达数百 KB
      if (!line.includes('"usage":') && !line.includes('"type":"session"')) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue // 断尾 / 损坏行跳过
      }
      if (!entry || typeof entry !== 'object') continue

      if (entry.type === 'session') {
        if (typeof entry.id === 'string' && entry.id) sessionId = entry.id
        if (typeof entry.cwd === 'string' && entry.cwd) {
          cwd = entry.cwd
          project = path.basename(entry.cwd)
        }
        continue
      }

      let message = null
      if (entry.type === 'message') {
        message = entry.message
        if (!message || message.role !== 'assistant') continue
      } else if (entry.type === 'model_usage') {
        message = entry
      } else {
        continue
      }
      const u = message.usage
      if (!u || typeof u !== 'object') continue
      if (typeof message.model !== 'string' || !message.model) continue
      // 缺 id 的条目（旧版会话）无法去重，omp 自己的统计也跳过
      if (typeof entry.id !== 'string' || !entry.id) continue
      if (seenEntryIds.has(entry.id)) continue
      seenEntryIds.add(entry.id)

      const timeMs = entryTimeMs(entry, message)
      if (!timeMs) continue
      const date = localDayKey(timeMs)
      if (!date) continue
      const b = bucketsOf(u)
      if (b.total <= 0) continue

      messageRecords.push({
        sessionId,
        model: message.model,
        project,
        projectPath: cwd,
        date,
        timestamp: new Date(timeMs).toISOString(),
        inputTokens: b.input,
        outputTokens: b.output,
        cacheReadTokens: b.cacheRead,
        cacheCreationTokens: b.cacheWrite,
        totalTokens: b.total,
        cost: b.cost,
      })
      touchSession(sessionId, timeMs, cwd, b)
    }
  }

  return { messageRecords, sessionMap }
}

// 与 Pi / Kimi / MiniMax 同口径：summary.inputTokens = 总量 - 输出；
// 模型 tokens = input + output + cacheRead + cacheCreation（模型分布 / 柱状图同源）
const aggregate = (contributions, messageCount, sessionCount) => {
  let totalTokens = 0
  let outputTokens = 0
  const modelMap = new Map()
  for (const day of contributions) {
    totalTokens += day.tokens || 0
    outputTokens += day.outputTokens || 0
    day.inputTokens = (day.tokens || 0) - (day.outputTokens || 0)
    for (const [name, m] of Object.entries(day.models || {})) {
      if (!modelMap.has(name)) modelMap.set(name, { name, tokens: 0, inputTokens: 0, outputTokens: 0 })
      const mm = modelMap.get(name)
      const cacheR = m.cacheReadTokens || 0
      const cacheC = m.cacheCreationTokens || 0
      mm.tokens += (m.inputTokens || 0) + (m.outputTokens || 0) + cacheR + cacheC
      mm.inputTokens += (m.inputTokens || 0) + cacheR + cacheC
      mm.outputTokens += m.outputTokens || 0
    }
  }
  return {
    summary: {
      totalTokens,
      inputTokens: totalTokens - outputTokens,
      outputTokens,
      messageCount,
      sessionCount,
    },
    modelStats: Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens),
    contributions,
    sessionCount,
    messageCount,
  }
}

const emptyResult = () => {
  const contributions = []
  const now = new Date()
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    contributions.push({
      // 本地日期（热力图按本地日期铺格子；toISOString 是 UTC）
      date: localDayKey(d.getTime()),
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      models: {},
    })
  }
  return {
    summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, messageCount: 0, sessionCount: 0 },
    modelStats: [],
    contributions,
    sessionCount: 0,
    messageCount: 0,
  }
}

// 源文件被 gc 清理后回放落库历史，避免历史归零；无历史返回 null
const statsFromHistory = () => {
  const history = usage.readAgentUsage('omp')
  const dates = Object.keys(history)
  if (dates.length === 0) return null
  const contributions = usage.fillEmptyContributions(
    dates.sort().map((date) => ({ date, ...history[date], models: history[date].models || {} })),
  )
  return aggregate(contributions, 0, 0)
}

const readOmpUsageFromHistory = () => {
  try {
    return statsFromHistory()
  } catch (e) {
    console.error('[omp Usage] 读历史统计失败:', e)
    return null
  }
}

const readOmpUsage = () => {
  try {
    if (collectSessionFiles().length === 0) return statsFromHistory() || emptyResult()
    const { messageRecords, sessionMap } = collectUsageRecords()
    if (messageRecords.length === 0) return statsFromHistory() || emptyResult()
    const stats = usage.calculateStats(messageRecords, sessionMap, { includeCost: true })
    const result = aggregate(stats.contributions, messageRecords.length, sessionMap.size)
    // 落库（「通用」统计页数据源 + 本页历史档）：全零由落库层跳过，不会清空历史
    usage.saveAgentUsage('omp', stats.contributions)
    return result
  } catch (e) {
    console.error('[omp Usage] 统计失败:', e)
    return emptyResult()
  }
}

const openOmpSessionsDir = () => {
  const dir = getOmpSessionsDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch { /* ignore */ }
}

module.exports = {
  getOmpSessionsDir,
  getOmpArchiveDir,
  collectSessionFiles,
  readOmpUsage,
  readOmpUsageFromHistory,
  openOmpSessionsDir,
}
