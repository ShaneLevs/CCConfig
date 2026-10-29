// 共享 JSONL 处理管线 — Claude / Pi 复用
// 导出处理函数和工具，调用方传入 schema 映射函数适配各自格式

const { getNativeId } = require('./config')

// 日期键必须是「本地日期」：热力图按本地日期铺格子，而各 agent 的日期口径有两套——
// Claude / Pi 取 ISO 字符串的 UTC 日期，Kimi / MiniMax / Cline / Grok / omp 取本地日期。
// 以前这里用 toISOString 生成 365 天的骨架：东八区 00:00–08:00 之间本地已是新的一天，
// UTC 还在前一天，本地日期那条数据就永远落不进窗口，当天的用量被静默丢弃。
// 现在骨架按本地日期生成，并把窗口外的已有日期一并追加（排序后返回），任何口径的数据都不丢。
const localDayKey = (date) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const fillEmptyContributions = (contributions) => {
  const now = new Date()
  const dateMap = new Map()
  for (const d of contributions) dateMap.set(d.date, d)
  const result = []
  const seen = new Set()
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i)
    const key = localDayKey(d)
    seen.add(key)
    result.push(dateMap.get(key) || { date: key, tokens: 0, inputTokens: 0, outputTokens: 0, models: {} })
  }
  // 窗口外的已有日期（UTC 口径在跨时区边界上可能落到前一天）照样保留，不静默丢弃
  const extra = []
  for (const [key, value] of dateMap) {
    if (!seen.has(key)) extra.push(value)
  }
  if (extra.length) {
    extra.sort((a, b) => String(a.date).localeCompare(String(b.date)))
    return [...extra, ...result].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }
  return result
}

const calculateStats = (messageRecords, sessionMap, options = {}) => {
  const includeCost = options.includeCost || false
  const sessionArr = Array.from(sessionMap.values()).map(s => ({
    ...s, totalTokens: s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens + s.cacheWriteTokens,
  }))
  sessionArr.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

  const summaryInit = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheWriteTokens: 0, totalTokens: 0, messageCount: messageRecords.length, sessionCount: sessionMap.size }
  if (includeCost) summaryInit.totalCost = 0

  const summary = messageRecords.reduce((acc, r) => {
    acc.inputTokens += r.inputTokens
    acc.outputTokens += r.outputTokens
    acc.cacheReadTokens += r.cacheReadTokens
    if (r.cacheCreationTokens) acc.cacheCreationTokens += r.cacheCreationTokens
    if (r.cacheWriteTokens) acc.cacheWriteTokens += r.cacheWriteTokens
    acc.totalTokens += r.totalTokens
    if (includeCost && r.cost) acc.totalCost += r.cost
    return acc
  }, summaryInit)

  const modelMap = new Map()
  messageRecords.forEach(r => {
    if (!modelMap.has(r.model)) modelMap.set(r.model, { name: r.model, tokens: 0, inputTokens: 0, outputTokens: 0 })
    const m = modelMap.get(r.model)
    m.tokens += r.totalTokens; m.inputTokens += r.inputTokens; m.outputTokens += r.outputTokens
  })
  const modelStats = Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens)

  const contributionMap = new Map()
  messageRecords.forEach(r => {
    if (!contributionMap.has(r.date)) contributionMap.set(r.date, { date: r.date, tokens: 0, inputTokens: 0, outputTokens: 0, models: {} })
    const d = contributionMap.get(r.date)
    d.tokens += r.totalTokens; d.inputTokens += r.inputTokens; d.outputTokens += r.outputTokens
    if (!d.models[r.model]) d.models[r.model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    d.models[r.model].inputTokens += r.inputTokens; d.models[r.model].outputTokens += r.outputTokens
    d.models[r.model].cacheReadTokens += r.cacheReadTokens || 0
    if (r.cacheCreationTokens) d.models[r.model].cacheCreationTokens += r.cacheCreationTokens
  })

  const contributions = fillEmptyContributions(Array.from(contributionMap.values()).sort((a, b) => a.date.localeCompare(b.date)))
  const avgTokensPerSession = sessionMap.size > 0 ? Math.round(summary.totalTokens / sessionMap.size) : 0
  const recentSessions = sessionArr.slice(0, 10)

  return { summary, modelStats, contributions, avgTokensPerSession, recentSessions, messageRecords }
}

// ==================== 跨 agent 统一落库（「通用」统计页数据源） ====================
// 设计：各 agent 统计页计算完成后按 agent 落库（读源文件由 agent 自己的统计页负责，
// 本层只负责存 + 纯 DB 读取聚合，「通用」统计页不重新解析任何源文件）。
// 文档 ID 按机器隔离：ccconfig_agent_usage_<agent>_<nativeId>（同 heatmap/usage_cache 先例，
// 统计派生自本机文件，跨设备同步互相覆盖无意义）。
// days 形状与 heatmap 一致：{ 'YYYY-MM-DD': { tokens, inputTokens, outputTokens, models } }
// 各 agent 统计页打开时在「计算完成」处落库（Claude 另有自己的热力图历史档），
// DSH 反过来把这份落库数据当历史档用：会话日志被清理后，已消失日期仍能参与统计。

// claude / opencode / pi / dsh / zcode / grok / cline / commandcode / minimax / kimi：「通用」统计页合并这些 agent；
// dsh / zcode / grok / cline / commandcode 另用它做历史合并（源数据被清理后回放历史，不归零）
const AGENT_USAGE_IDS = ['claude', 'opencode', 'pi', 'dsh', 'zcode', 'grok', 'cline', 'commandcode', 'minimax', 'kimi']

const agentUsageDocId = (agent) => `ccconfig_agent_usage_${agent}_${getNativeId()}`

// 全零结果跳过写入：OpenCode/Pi 读取失败兜底会返回空统计，避免误清历史数据
const saveAgentUsage = (agent, contributions) => {
  try {
    const docId = agentUsageDocId(agent)
    const days = {}
    for (const day of contributions) {
      if (day.tokens > 0) {
        days[day.date] = {
          tokens: day.tokens,
          inputTokens: day.inputTokens || 0,
          outputTokens: day.outputTokens || 0,
          models: day.models || {},
        }
      }
    }
    if (Object.keys(days).length === 0) return false
    const doc = { _id: docId, nativeId: getNativeId(), agent, days, updatedAt: Date.now() }
    const existing = window.utools.db.get(docId)
    if (existing) doc._rev = existing._rev
    window.utools.db.put(doc)
    return true
  } catch (error) {
    console.error('[agent usage] 落库失败:', agent, error)
    return false
  }
}

// 读单个 agent 的落库聚合（DSH 统计页把它当历史档，合并进当天统计）
const readAgentUsage = (agent) => {
  try {
    const doc = window.utools.db.get(agentUsageDocId(agent))
    return doc?.days || {}
  } catch (error) {
    console.error('[agent usage] 读库失败:', agent, error)
    return {}
  }
}

// 读全部已适配 agent 的落库统计，按日期与模型跨 agent 合并。
// 返回 { summary, modelStats, contributions, agents }，形状与 UsagePage fetcher 契约一致
// （agents 为额外元信息：[{ agent, updatedAt }]，供页面展示数据新鲜度）。
// 每天另带 agentModels = { <agent>: { tokens, inputTokens, outputTokens, models } }：
// models 为跨 agent 合并后的并集（模型分布卡片用），agentModels 保留各 agent 自己的归属
// （热力图 tooltip 按 agent 分组展示用），两者口径一致、不重复计数。
const readAllAgentUsage = () => {
  const agents = []
  const dayMap = new Map()
  for (const agent of AGENT_USAGE_IDS) {
    try {
      const doc = window.utools.db.get(agentUsageDocId(agent))
      if (!doc?.days) continue
      const dayCount = Object.keys(doc.days).length
      if (dayCount === 0) continue
      agents.push({ agent, updatedAt: doc.updatedAt || 0, dayCount })
      for (const [date, d] of Object.entries(doc.days)) {
        let day = dayMap.get(date)
        if (!day) {
          day = { date, tokens: 0, inputTokens: 0, outputTokens: 0, models: {}, agentModels: {} }
          dayMap.set(date, day)
        }
        day.tokens += d.tokens || 0
        day.inputTokens += d.inputTokens || 0
        day.outputTokens += d.outputTokens || 0
        // 每个 agent 每天只出现一次，直接赋值（不用累加）
        day.agentModels[agent] = {
          tokens: d.tokens || 0,
          inputTokens: d.inputTokens || 0,
          outputTokens: d.outputTokens || 0,
          models: d.models || {},
        }
        for (const [model, m] of Object.entries(d.models || {})) {
          let mm = day.models[model]
          if (!mm) {
            mm = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
            day.models[model] = mm
          }
          mm.inputTokens += m.inputTokens || 0
          mm.outputTokens += m.outputTokens || 0
          mm.cacheReadTokens += m.cacheReadTokens || 0
          mm.cacheCreationTokens += m.cacheCreationTokens || 0
        }
      }
    } catch (error) {
      console.error('[agent usage] 读库失败:', agent, error)
    }
  }

  const merged = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date))
  // 完全无落库数据时返回空 contributions（长度 0）——
  // UsagePage 的空态/引导提示以 contributions.length === 0 为判据，填零的 365 天会让引导不显示
  if (merged.length === 0) {
    return {
      summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      modelStats: [],
      contributions: [],
      agents: [],
    }
  }
  const contributions = fillEmptyContributions(merged)

  // 与 Claude 统计页合并历史后的口径保持一致：
  // summary.inputTokens = total - output；模型 tokens = input + output + cacheRead + cacheCreation
  let totalTokens = 0
  let outputTokens = 0
  const modelMap = new Map()
  for (const day of merged) {
    totalTokens += day.tokens || 0
    outputTokens += day.outputTokens || 0
    for (const [name, m] of Object.entries(day.models || {})) {
      if (!modelMap.has(name)) modelMap.set(name, { name, tokens: 0, inputTokens: 0, outputTokens: 0 })
      const mm = modelMap.get(name)
      const inp = m.inputTokens || 0
      const out = m.outputTokens || 0
      const cacheR = m.cacheReadTokens || 0
      const cacheC = m.cacheCreationTokens || 0
      mm.tokens += inp + out + cacheR + cacheC
      mm.inputTokens += inp + cacheR + cacheC
      mm.outputTokens += out
    }
  }

  return {
    summary: {
      totalTokens,
      inputTokens: totalTokens - outputTokens,
      outputTokens,
    },
    modelStats: Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens),
    contributions,
    agents,
  }
}

// 快速路径（统计页进页面先用）：纯读落库历史重建统计，不解析源文件（JSONL/SQLite/日志）；
// 无历史返回 null。返回形状与 UsagePage fetcher 契约一致。
const readAgentUsageFromHistory = (agent) => {
  try {
    const doc = window.utools.db.get(agentUsageDocId(agent))
    const days = doc?.days || {}
    const dates = Object.keys(days)
    if (dates.length === 0) return null
    const contributions = fillEmptyContributions(
      dates.sort().map((date) => ({ date, ...days[date], models: days[date]?.models || {} })),
    )
    // 口径与 readAllAgentUsage 一致：summary.inputTokens = total - output；
    // 模型 tokens = input + output + cacheRead + cacheCreation
    let totalTokens = 0
    let outputTokens = 0
    const modelMap = new Map()
    for (const day of contributions) {
      totalTokens += day.tokens || 0
      outputTokens += day.outputTokens || 0
      for (const [name, m] of Object.entries(day.models || {})) {
        if (!modelMap.has(name)) modelMap.set(name, { name, tokens: 0, inputTokens: 0, outputTokens: 0 })
        const mm = modelMap.get(name)
        const inp = m.inputTokens || 0
        const out = m.outputTokens || 0
        const cacheR = m.cacheReadTokens || 0
        const cacheC = m.cacheCreationTokens || 0
        mm.tokens += inp + out + cacheR + cacheC
        mm.inputTokens += inp + cacheR + cacheC
        mm.outputTokens += out
      }
    }
    return {
      summary: { totalTokens, inputTokens: totalTokens - outputTokens, outputTokens },
      modelStats: Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens),
      contributions,
    }
  } catch (error) {
    console.error('[agent usage] 读历史统计失败:', agent, error)
    return null
  }
}

// 桌面版托盘弹窗：只回最近 N 天、按模型 / Agent 拆好的 Token 用量。
// 统计口径与「通用统计」柱状图一致（模型 = input + output + cacheRead + cacheCreation，
// Agent = 该 agent 当天的 tokens），页面直接画柱，不再传 365 天全量贡献。
const readCommonUsageForTray = (days = 60) => {
  const range = Math.max(1, Math.min(365, Number(days) || 60))
  const { contributions } = readAllAgentUsage()
  return contributions.slice(-range).map((day) => {
    const models = []
    for (const [name, m] of Object.entries(day.models || {})) {
      const tokens =
        (m.inputTokens || 0) + (m.outputTokens || 0) +
        (m.cacheReadTokens || 0) + (m.cacheCreationTokens || 0)
      if (tokens > 0) models.push([name, tokens])
    }
    const agents = []
    for (const [id, group] of Object.entries(day.agentModels || {})) {
      if (group.tokens > 0) agents.push([id, group.tokens])
    }
    return { date: day.date, models, agents }
  })
}

module.exports = { fillEmptyContributions, calculateStats, saveAgentUsage, readAgentUsage, readAgentUsageFromHistory, readAllAgentUsage, readCommonUsageForTray }
