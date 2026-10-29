const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// ==================== Kimi Code 用量统计 ====================
// 数据源：<KIMI_CODE_HOME>/sessions/<workspace>/<session>/agents/<agentId>/wire.jsonl
// （KIMI_CODE_HOME 默认 ~/.kimi-code；与配置服务同一套目录解析）。
//
// 每个 LLM 请求落一条 usage.record（wire.jsonl 一行一个 JSON 事件）：
//   { type: "usage.record", agentId, model, usage: {
//       inputOther, output, inputCacheRead, inputCacheCreation }, usageScope, time }
//   - model 是 Kimi 侧的模型别名（如 router/pro、公司部门/qwen3.8-flash）；
//     统计落库时只记模型名、去掉供应商前缀（优先取同一次请求的 llm.request.model，
//     老日志退回别名并只剥配置里确实存在的供应商名）；
//   - time 是 epoch 毫秒；日期按本地时区分日（同 Grok / Cline 先例）；
//   - usageScope = turn | session（session 为压缩/标题等非 turn 请求），都是真实 API 用量，全部计入。
// 口径与其它 agent 一致：输入 = inputOther + cacheRead + cacheCreation（含缓存），输出 = output，
// 总量 = 输入 + 输出。
//
// 性能：wire.jsonl 里还有 systemPrompt / tool 结果等超长行，只对含 "usage.record" / "llm.request"
// 的行做 JSON.parse（先做子串过滤），避免整档解析。重统计由 usage-async 放进 worker_threads。
// 落库：ccconfig_agent_usage_kimi_<nativeId>（「通用」统计页与历史回档同源；全零跳过不误清）。

const KIMI_HOME = () => process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')
const KIMI_SESSIONS_DIR = () => path.join(KIMI_HOME(), 'sessions')
const getKimiSessionsDir = KIMI_SESSIONS_DIR

// 本地时区日期（toISOString 是 UTC，会让东八区凌晨算到前一天）
const localDayKey = (ms) => {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 列出所有会话的事件流文件；state.json 提供稳定会话 ID 与真实 cwd（目录名是工作目录的
// 有损编码 wd_<slug>_<hash>，不可反解）。读不到 state.json 时退化为目录名。
const listWireLogs = () => {
  const root = KIMI_SESSIONS_DIR()
  if (!fs.existsSync(root)) return []
  const out = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  } catch (e) {
    console.error('[Kimi Usage] 读取 sessions 目录失败:', e)
    return []
  }
  for (const workspace of workspaces) {
    const workspaceDir = path.join(root, workspace.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    } catch (e) {
      continue
    }
    for (const session of sessions) {
      const sessionDir = path.join(workspaceDir, session.name)
      let state = {}
      try {
        state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8')) || {}
      } catch (e) {
        /* 没有 / 正在写入：用目录名兜底 */
      }
      const sessionId = typeof state.id === 'string' && state.id ? state.id : session.name
      const cwd = typeof state.cwd === 'string' ? state.cwd : ''
      const agentsDir = path.join(sessionDir, 'agents')
      let agents = []
      try {
        agents = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
      } catch (e) {
        continue
      }
      for (const agent of agents) {
        const wireFile = path.join(agentsDir, agent.name, 'wire.jsonl')
        if (!fs.existsSync(wireFile)) continue
        out.push({ sessionId, cwd, wireFile })
      }
    }
  }
  return out
}

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : Number(v) || 0)

// usage.record.model 是配置里的模型别名（约定 <供应商>/<模型ID>）。统计只记模型名、不带供应商：
//   - 优先用同一次请求前一条 llm.request 的 model（真正发往 API 的模型 ID，天然不含供应商前缀）；
//   - 老日志没有配对的 llm.request 时退回别名，且只在「前缀确实是配置里的供应商名」时去掉它，
//     避免把模型 ID 自带的命名空间（如 moonshotai/kimi-k2）误删。
const knownProviderNames = () => {
  try {
    return new Set((require('./kimi').getKimiProviderList() || []).map((p) => p.name))
  } catch (e) {
    return new Set()
  }
}

const modelNameOfAlias = (alias, providerNames) => {
  const i = alias.indexOf('/')
  if (i > 0 && providerNames.has(alias.slice(0, i))) return alias.slice(i + 1)
  return alias
}

const collectUsageRecords = () => {
  const messageRecords = []
  const sessionMap = new Map()
  const providerNames = knownProviderNames()

  for (const log of listWireLogs()) {
    let content = ''
    try {
      content = fs.readFileSync(log.wireFile, 'utf-8')
    } catch (e) {
      continue // 正在写入 / 无权限：跳过本次，下次刷新再读
    }
    // 每个 agent 的事件流单独配对：llm.request 在前，usage.record 紧跟其后
    let lastRequestModel = ''
    for (const line of content.split('\n')) {
      // 先做廉价子串过滤：wire.jsonl 的 tool 结果 / systemPrompt 单行可达数百 KB
      if (!line.includes('"usage.record"') && !line.includes('"llm.request"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch (e) {
        continue // 断尾 / 损坏行跳过
      }
      if (!event) continue
      if (event.type === 'llm.request') {
        if (typeof event.model === 'string' && event.model) lastRequestModel = event.model
        continue
      }
      if (event.type !== 'usage.record' || !event.usage) continue
      const u = event.usage
      const input = toNumber(u.inputOther)
      const output = toNumber(u.output)
      const cacheRead = toNumber(u.inputCacheRead)
      const cacheCreation = toNumber(u.inputCacheCreation)
      const total = input + output + cacheRead + cacheCreation
      if (total <= 0) continue
      const time = toNumber(event.time)
      if (!time) continue // 缺 time 的事件不猜日期
      const date = localDayKey(time)
      if (!date) continue
      const alias = String(event.model || '').trim()
      const model = lastRequestModel || modelNameOfAlias(alias, providerNames) || 'unknown'

      messageRecords.push({
        sessionId: log.sessionId,
        model,
        project: log.cwd ? path.basename(log.cwd) : '',
        projectPath: log.cwd,
        date,
        timestamp: new Date(time).toISOString(),
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        totalTokens: total,
      })

      let sess = sessionMap.get(log.sessionId)
      if (!sess) {
        sess = {
          sessionId: log.sessionId,
          timestamp: '',
          cwd: log.cwd,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
        sessionMap.set(log.sessionId, sess)
      }
      sess.inputTokens += input
      sess.outputTokens += output
      sess.cacheReadTokens += cacheRead
      sess.cacheCreationTokens += cacheCreation
      const iso = new Date(time).toISOString()
      if (!sess.timestamp || iso > sess.timestamp) sess.timestamp = iso
    }
  }

  return { messageRecords, sessionMap }
}

// 与其它 agent 同口径：summary.inputTokens = 总量 - 输出；
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

// 源文件被清理后回放落库历史，避免历史归零；无历史返回 null
const statsFromHistory = () => {
  const usage = require('./usage')
  const history = usage.readAgentUsage('kimi')
  const dates = Object.keys(history)
  if (dates.length === 0) return null
  const contributions = usage.fillEmptyContributions(
    dates.sort().map((date) => ({ date, ...history[date], models: history[date].models || {} })),
  )
  return aggregate(contributions, 0, 0)
}

const readKimiUsageFromHistory = () => {
  try {
    return statsFromHistory()
  } catch (e) {
    console.error('[Kimi Usage] 读历史统计失败:', e)
    return null
  }
}

const readKimiUsage = () => {
  const usage = require('./usage')
  try {
    if (listWireLogs().length === 0) return statsFromHistory() || emptyResult()
    const { messageRecords, sessionMap } = collectUsageRecords()
    if (messageRecords.length === 0) return statsFromHistory() || emptyResult()
    const stats = usage.calculateStats(messageRecords, sessionMap)
    const result = aggregate(stats.contributions, messageRecords.length, sessionMap.size)
    // 落库（「通用」统计页数据源 + 本页历史档）：全零由落库层跳过，不会清空历史
    usage.saveAgentUsage('kimi', stats.contributions)
    return result
  } catch (e) {
    console.error('[Kimi Usage] 统计失败:', e)
    return emptyResult()
  }
}

const openKimiSessionsDir = () => {
  const dir = KIMI_SESSIONS_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch (e) { /* ignore */ }
}

module.exports = {
  getKimiSessionsDir,
  listWireLogs,
  readKimiUsage,
  readKimiUsageFromHistory,
  openKimiSessionsDir,
}
