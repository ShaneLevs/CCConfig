const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// ==================== Reasonix 用量统计 ====================
// 数据源：<REASONIX_HOME>/stats/<YYYY-MM-DD>.jsonl（REASONIX_HOME 默认 ~/.reasonix）
//
// 每行是一次 LLM 请求的结算记录（CLI 与桌面版共用同一目录，config.toml 的
// desktop.metrics 打开时才写）：
//   { ts, model, source, prompt, completion, cache_hit, cache_miss, total,
//     requests, estimated, usage_source, cost_* … }
//   - prompt 已是「含缓存的输入总量」（prompt = cache_hit + cache_miss），
//     completion 是本轮输出；total = prompt + completion；
//   - source = desktop | cli，是使用形态而非会话，统计不区分；
//   - ts 带时区偏移（+08:00），按本地日期分日（同 Grok / Kimi 先例）；
//   - model 是模型引用 `<供应商>/<模型>` 或裸模型名；落库前只在前缀确实是
//     配置里的供应商名时去掉，避免误删 moonshotai/kimi-k2 这类命名空间。
//
// 口径与其它 agent 一致：inputTokens = cache_miss（非缓存输入），
// cacheReadTokens = cache_hit（Reasonix 没有缓存写入计费字段，cacheCreation 恒 0），
// outputTokens = completion，总量 = prompt + completion。
// 重统计由 usage-async 放进 worker_threads；落库 cconfig_agent_usage_reasonix_<nativeId>
// 供「通用」统计页汇总，源文件被清理后回放历史，不归零。

const REASONIX_HOME = () => {
  // 主目录解析复用配置服务的实现（支持 REASONIX_HOME 重定向，与统计口径同源）
  try {
    return require('./reasonix').getReasonixHome()
  } catch (e) {
    return path.join(os.homedir(), '.reasonix')
  }
}
const REASONIX_STATS_DIR = () => path.join(REASONIX_HOME(), 'stats')
const getReasonixStatsDir = REASONIX_STATS_DIR

// 本地时区日期（toISOString 是 UTC，会让东八区凌晨算到前一天）
const localDayKey = (ms) => {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : Number(v) || 0)

// 逐日结算文件（stats/ 下还有 upload/ 子目录与 .append.lock，只认 .jsonl）
const listStatsFiles = () => {
  const root = REASONIX_STATS_DIR()
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch (e) {
    // 没装 / 没开 metrics：静默返回空，统计页回退落库历史
    return []
  }
  return names
    .filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'))
    .sort()
    .map((n) => path.join(root, n))
}

const knownProviderNames = () => {
  try {
    const list = require('./reasonix').getReasonixProviderList() || []
    return new Set(list.map((p) => p && p.name).filter(Boolean))
  } catch (e) {
    return new Set()
  }
}

const modelNameOfRef = (ref, providerNames) => {
  const raw = String(ref || '').trim()
  if (!raw) return 'unknown'
  const i = raw.indexOf('/')
  if (i > 0 && providerNames.has(raw.slice(0, i))) return raw.slice(i + 1)
  return raw
}

const collectUsageRecords = () => {
  const messageRecords = []
  const sessionMap = new Map()
  const providerNames = knownProviderNames()

  for (const file of listStatsFiles()) {
    let content = ''
    try {
      content = fs.readFileSync(file, 'utf-8')
    } catch (e) {
      continue // 正在写入 / 无权限：跳过本次，下次刷新再读
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      // 结算行一定带 "ts"；其余空行 / 残行直接跳过
      if (!trimmed || trimmed[0] !== '{' || !trimmed.includes('"ts"')) continue
      let row
      try {
        row = JSON.parse(trimmed)
      } catch (e) {
        continue // 断尾 / 损坏行跳过
      }
      if (!row) continue
      const time = Date.parse(row.ts)
      if (Number.isNaN(time)) continue // 缺 ts 的记录不猜日期
      const date = localDayKey(time)
      if (!date) continue
      const prompt = toNumber(row.prompt)
      const completion = toNumber(row.completion)
      const cacheHit = toNumber(row.cache_hit)
      if (prompt + completion <= 0) continue
      const source = row.source === 'cli' ? 'cli' : 'desktop'
      // 没有会话 ID：用「来源 + 日期」聚合成伪会话，sessionCount 只表达活跃天数形态
      const sessionId = `${source}:${date}`
      messageRecords.push({
        sessionId,
        model: modelNameOfRef(row.model, providerNames),
        project: '',
        projectPath: '',
        timestamp: new Date(time).toISOString(),
        date,
        inputTokens: Math.max(0, prompt - cacheHit),
        outputTokens: completion,
        cacheReadTokens: cacheHit,
        cacheCreationTokens: 0,
        totalTokens: prompt + completion,
      })

      let sess = sessionMap.get(sessionId)
      if (!sess) {
        sess = {
          sessionId,
          timestamp: '',
          cwd: '',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }
        sessionMap.set(sessionId, sess)
      }
      sess.inputTokens += Math.max(0, prompt - cacheHit)
      sess.outputTokens += completion
      sess.cacheReadTokens += cacheHit
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
  const history = usage.readAgentUsage('reasonix')
  const dates = Object.keys(history)
  if (dates.length === 0) return null
  const contributions = usage.fillEmptyContributions(
    dates.sort().map((date) => ({ date, ...history[date], models: history[date].models || {} })),
  )
  return aggregate(contributions, 0, 0)
}

const readReasonixUsageFromHistory = () => {
  try {
    return statsFromHistory()
  } catch (e) {
    console.error('[Reasonix Usage] 读历史统计失败:', e)
    return null
  }
}

const readReasonixUsage = () => {
  const usage = require('./usage')
  try {
    if (listStatsFiles().length === 0) return statsFromHistory() || emptyResult()
    const { messageRecords, sessionMap } = collectUsageRecords()
    if (messageRecords.length === 0) return statsFromHistory() || emptyResult()
    const stats = usage.calculateStats(messageRecords, sessionMap)
    const result = aggregate(stats.contributions, messageRecords.length, sessionMap.size)
    // 落库（「通用」统计页数据源 + 本页历史档）：全零由落库层跳过，不会清空历史
    usage.saveAgentUsage('reasonix', stats.contributions)
    return result
  } catch (e) {
    console.error('[Reasonix Usage] 统计失败:', e)
    return emptyResult()
  }
}

const openReasonixStatsDir = () => {
  const dir = REASONIX_STATS_DIR()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  try { window.utools.shellOpenPath(dir) } catch (e) { /* ignore */ }
}

module.exports = {
  getReasonixStatsDir,
  listStatsFiles,
  readReasonixUsage,
  readReasonixUsageFromHistory,
  openReasonixStatsDir,
}
