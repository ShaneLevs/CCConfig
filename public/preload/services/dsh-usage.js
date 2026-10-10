const fs = require('node:fs')
const path = require('node:path')
const { decompress } = require('fzstd')
const dsh = require('./dsh')
const usage = require('./usage')

// ==================== DSH（DeepSeek Harness）使用统计 ====================
// 数据源：<DSH_HOME>/sessions/<项目目录>/<会话目录>/session[.vN].jsonl[.zstd]
//   DSH_HOME / profile 解析复用 dsh.js（DSH_HOME 环境变量优先，默认 ~/.dsh）。
//   日志是「多个独立 zstd 帧拼接」的容器，每帧内含若干行 JSONL 事件（追加写入 = 追加帧）。
//   关键事件（其余事件一律跳过）：
//     {"type":"session", "id","cwd","createdAt"}                       会话头
//     {"type":"assistant/message","time":<ms>,
//        "data":{"usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens},
//                "message":{"source":{"provider","model"}}}}          一次模型回复及其用量
// 口径（与 Claude / OpenCode / Pi 统计页保持一致，UsagePage 的日期筛选也依赖该形状）：
//   输入（含缓存）= inputTokens + cacheReadTokens + cacheWriteTokens；输出 = outputTokens
//   单日 tokens = 输入 + 输出；day.models[name] 存「未缓存输入 / 输出 / 缓存读 / 缓存写」，
//   day.inputTokens 存含缓存输入（OpenCode 同口径，页面日期筛选直接取该字段）。
//   summary.inputTokens = 总 tokens - 输出（含缓存），modelStats 同样按含缓存口径重算。
// 只统计 assistant/message，因为它同时带用量与模型归属。assistant/attempt（失败重试）只有
// 输入、没有模型字段，compaction/summary、会话标题、web search 等辅助请求也不属于对话用量，
// 一律不计入，避免污染模型分布。
// 已知取舍：解析失败的帧（进程崩溃留下的断尾帧）跳过，最多丢掉该会话最后一个未落盘批次，
// 下次文件 size/mtime 变化时会重新全量解析补上。
// 为什么自带 zstd 解码：uTools 8（Electron 34）的 Node 是 20.x，node:zlib 从 Node 22.15
// 才有 zstd；这里用纯 JS 的 fzstd 逐帧解压，帧边界靠 scanZstdFrames 结构扫描（与 dsh 自身
// session-persistence-jsonl 的 scanZstdFrames 同构，不解压即可定位完整帧）。

const ZSTD_MAGIC = 0xfd2fb528
// 会话目录内的日志文件名：v0 无版本后缀，之后为 session.v<N>.jsonl[.zstd]
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

const getDshSessionsRoot = () => path.join(dsh.getDshHome(), 'sessions')

// ==================== zstd 帧扫描 / 解码 ====================

// 结构扫描完整帧边界（RFC 8878 帧头 + 块头）：不合法或断尾处即停止，
// 返回已确认完整的帧区间（tornStart 仅用于诊断）。
const scanZstdFrames = (buffer) => {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, tornStart: start }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, tornStart: start }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

// 逐行回调日志内容：按帧解压，只保留跨帧的半行，避免把整份明文拼进内存。
const forEachLogLine = (filePath, isZstd, onLine) => {
  const buffer = fs.readFileSync(filePath)
  if (!isZstd) {
    for (const line of buffer.toString('utf-8').split('\n')) onLine(line)
    return
  }
  const { frames } = scanZstdFrames(buffer)
  let carry = ''
  for (const frame of frames) {
    let text
    try {
      text = Buffer.from(decompress(buffer.subarray(frame.start, frame.end))).toString('utf-8')
    } catch {
      continue // 断尾 / 校验失败的帧：跳过
    }
    const parts = (carry + text).split('\n')
    carry = parts.pop() || ''
    for (const line of parts) onLine(line)
  }
  if (carry.trim()) onLine(carry)
}

// ==================== 会话发现 ====================

// 同一会话可能残留多个格式世代，取版本号最高的那个
const pickSessionLog = (dir) => {
  let best = null
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    const m = SESSION_LOG_RE.exec(name)
    if (!m) continue
    const version = m[1] === undefined ? 0 : Number(m[1])
    if (!best || version > best.version) {
      best = { file: path.join(dir, name), version, zstd: !!m[2] }
    }
  }
  return best
}

// 会话日志清单：常规为 sessions/<项目>/<会话>/session*.jsonl[.zstd]，
// 外层项目目录直接放日志文件的老布局也一并收进来。
const listSessionLogs = () => {
  const root = getDshSessionsRoot()
  if (!fs.existsSync(root)) return []
  const logs = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return []
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name)
    const legacy = pickSessionLog(projectDir)
    if (legacy) logs.push({ ...legacy, projectDir })
    let sessions = []
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      sessions = []
    }
    for (const session of sessions) {
      const found = pickSessionLog(path.join(projectDir, session.name))
      if (found) logs.push({ ...found, projectDir, sessionDir: session.name })
    }
  }
  return logs
}

// ==================== 解析 / 聚合 ====================

// 只解析可能是目标事件的行，避免把 tool/result 之类的大 payload 全部 JSON.parse
const parseEvent = (line) => {
  if (line.charCodeAt(0) !== 0x7b) return null // '{'
  if (line.indexOf('"assistant/message"') === -1 && line.indexOf('"type":"session"') === -1) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

const toNumber = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)

const collectRecords = () => {
  const messageRecords = []
  const sessionMap = new Map()
  const logs = listSessionLogs()

  for (const log of logs) {
    const fallbackId = log.sessionDir || path.basename(log.projectDir)
    let sessionId = fallbackId
    const ensureSession = () => {
      if (sessionMap.has(sessionId)) return sessionMap.get(sessionId)
      const s = {
        sessionId,
        timestamp: '',
        cwd: log.projectDir,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
      sessionMap.set(sessionId, s)
      return s
    }

    try {
      forEachLogLine(log.file, log.zstd, (line) => {
        const event = parseEvent(line)
        if (!event) return
        if (event.type === 'session') {
          if (typeof event.id === 'string' && event.id) sessionId = event.id
          const s = ensureSession()
          if (typeof event.cwd === 'string' && event.cwd) s.cwd = event.cwd
          if (typeof event.createdAt === 'number') s.timestamp = new Date(event.createdAt).toISOString()
          return
        }
        if (event.type !== 'assistant/message') return
        const data = event.data && typeof event.data === 'object' ? event.data : {}
        const u = data.usage && typeof data.usage === 'object' ? data.usage : null
        if (!u) return
        const source = (data.message && data.message.source) || {}
        const model = String(source.model || 'unknown').trim() || 'unknown'
        const provider = String(source.provider || '').trim()
        const input = toNumber(u.inputTokens)
        const output = toNumber(u.outputTokens)
        const cacheRead = toNumber(u.cacheReadTokens)
        const cacheWrite = toNumber(u.cacheWriteTokens)
        const total = toNumber(u.totalTokens) || input + output + cacheRead + cacheWrite
        const timeMs = toNumber(event.time)
        const date = new Date(timeMs || Date.now()).toISOString().split('T')[0]

        messageRecords.push({
          sessionId,
          // 同一模型名可能来自不同路由（官方 / 第三方中转），带 provider 前缀区分
          model: provider ? `${provider}/${model}` : model,
          date,
          timestamp: timeMs,
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheWrite,
          totalTokens: total,
        })

        const s = ensureSession()
        s.inputTokens += input
        s.outputTokens += output
        s.cacheReadTokens += cacheRead
        s.cacheWriteTokens += cacheWrite
        const ts = new Date(timeMs || Date.now()).toISOString()
        if (!s.timestamp || ts > s.timestamp) s.timestamp = ts
      })
    } catch {
      /* 单个会话读取失败不影响整体统计 */
    }
  }

  return { messageRecords, sessionMap }
}

const emptyResult = () => {
  const contributions = []
  const now = new Date()
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    contributions.push({
      date: d.toISOString().split('T')[0],
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
    avgTokensPerSession: 0,
    sessionCount: 0,
    messageCount: 0,
  }
}

// 从 contributions 重算 summary / modelStats：口径与 Claude 统计页一致（输入含缓存），
// 也与 UsagePage 选中日期区间后的本地重算结果一致。
// 注意两处 inputTokens 语义不同（对齐 UsagePage 各自的消费方式）：
//   day.inputTokens          = 当天输入（含缓存）——日期区间筛选直接取该字段显示
//   day.models[].inputTokens = 当天该模型的未缓存输入——页面/下面的重算会再叠加
//                              cacheReadTokens + cacheCreationTokens，存含缓存会重复计数
const summarize = (stats, messageCount) => {
  let totalTokens = 0
  let outputTokens = 0
  const modelMap = new Map()
  for (const day of stats.contributions) {
    totalTokens += day.tokens || 0
    outputTokens += day.outputTokens || 0
    // calculateStats 写入的是未缓存输入，这里改写成含缓存输入
    day.inputTokens = (day.tokens || 0) - (day.outputTokens || 0)
    for (const [name, m] of Object.entries(day.models || {})) {
      if (!modelMap.has(name)) modelMap.set(name, { name, tokens: 0, inputTokens: 0, outputTokens: 0 })
      const mm = modelMap.get(name)
      const cacheRead = m.cacheReadTokens || 0
      const cacheWrite = m.cacheCreationTokens || 0
      const input = m.inputTokens || 0
      const output = m.outputTokens || 0
      mm.tokens += input + output + cacheRead + cacheWrite
      mm.inputTokens += input + cacheRead + cacheWrite
      mm.outputTokens += output
    }
  }
  return {
    summary: {
      totalTokens,
      inputTokens: totalTokens - outputTokens,
      outputTokens,
      messageCount,
      sessionCount: stats.summary?.sessionCount || 0,
    },
    modelStats: Array.from(modelMap.values()).sort((a, b) => b.tokens - a.tokens),
    contributions: stats.contributions,
    avgTokensPerSession: stats.avgTokensPerSession || 0,
    sessionCount: stats.summary?.sessionCount || 0,
    messageCount,
  }
}

const buildStats = () => {
  const { messageRecords, sessionMap } = collectRecords()
  const stats = usage.calculateStats(messageRecords, sessionMap)
  return summarize(stats, messageRecords.length)
}

// ==================== 缓存 ====================
// 会话文件可能累计到很大，按「文件数 + 总字节 + 最新 mtime」做签名，命中即跳过解压；
// 文档按机器隔离（同 usage_cache / heatmap 先例）。无 uTools 环境（单测）时自动跳过。
const cacheDocId = () => `ccswitch_dsh_usage_cache_${window.utools.getNativeId()}`

const getCache = () => {
  try {
    const doc = window.utools.db.get(cacheDocId())
    return doc && doc.stats ? doc : null
  } catch {
    return null
  }
}

const saveCache = (signature, stats) => {
  try {
    const docId = cacheDocId()
    const doc = { _id: docId, signature, stats, updatedAt: Date.now() }
    const existing = window.utools.db.get(docId)
    if (existing) doc._rev = existing._rev
    window.utools.db.put(doc)
  } catch (error) {
    console.error('[DSH Usage] 写缓存失败:', error)
  }
}

const calcSignature = (logs) => {
  let totalSize = 0
  let maxMtime = 0
  for (const log of logs) {
    try {
      const st = fs.statSync(log.file)
      totalSize += st.size
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs
    } catch {
      /* ignore */
    }
  }
  return `${logs.length}:${totalSize}:${Math.round(maxMtime)}`
}

// ==================== 对外入口 ====================

const readDshUsage = (forceRefresh = false) => {
  try {
    const logs = listSessionLogs()
    if (logs.length === 0) return emptyResult()
    const signature = calcSignature(logs)
    if (!forceRefresh) {
      const cached = getCache()
      if (cached && cached.signature === signature) return cached.stats
    }
    const stats = buildStats()
    saveCache(signature, stats)
    return stats
  } catch (error) {
    console.error('[DSH Usage] 统计失败:', error)
    return emptyResult()
  }
}

module.exports = {
  readDshUsage,
  getDshSessionsRoot,
  // 诊断 / 单测用
  scanZstdFrames,
  listSessionLogs,
  collectRecords,
}
