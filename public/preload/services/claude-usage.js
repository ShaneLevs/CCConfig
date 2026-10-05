// Claude 用量统计：扫描 ~/.claude/projects 下的 JSONL 提取 token 用量，
// 含热力图历史合并与 DB 缓存（签名 = 文件数:最大 mtime）。
const fs = require("node:fs");
const path = require("node:path");

const {
  saveHeatmapHistory,
  getHeatmapHistory,
  saveUsageCache,
  getUsageCache,
} = require("./config");
const usage = require("./usage");

// MCP 调用统计缓存（签名命中则跳过 JSONL 重扫）
let _mcpUsageCache = null;

function _emptyResult() {
  const now = new Date();
  const totalDays = 365;
  const emptyContributions = [];
  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().split("T")[0];
    emptyContributions.push({
      date: dateKey,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      models: {},
    });
  }
  return {
    summary: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      sessionCount: 0,
    },
    modelStats: [],
    projectStats: [],
    contributions: emptyContributions,
    avgTokensPerSession: 0,
    recentSessions: [],
    messageRecords: [],
  };
}

function _findAllJsonlFiles(projectsDir) {
  const results = [];
  try {
    if (!fs.existsSync(projectsDir)) return results;
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(projectsDir, entry.name);
      if (entry.isDirectory())
        results.push(..._findAllJsonlFiles(fullPath));
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        results.push(fullPath);
    }
  } catch (error) {
    console.error("查找 jsonl 文件失败:", error);
  }
  return results;
}

function _calcUsageSignature(projectsDir) {
  try {
    if (!fs.existsSync(projectsDir)) return "0:0";
    const files = _findAllJsonlFiles(projectsDir);
    let maxMtime = 0;
    for (const f of files) {
      try {
        const st = fs.statSync(f);
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      } catch {
        /* skip */
      }
    }
    return `${files.length}:${Math.floor(maxMtime)}`;
  } catch {
    return "0:0";
  }
}

function _processSingleJsonlFile(
  filePath,
  messageRecords,
  sessionMap,
  projectMap,
  projectPathMap,
) {
  const homeDir = window.utools.getPath("home");
  const projectsDir = path.join(homeDir, ".claude", "projects");

  try {
    const relativePath = path.relative(projectsDir, filePath);
    const folderName = relativePath.split(path.sep)[0] || "unknown";
    const projectPath = projectPathMap.get(folderName) || "unknown";
    const projectName =
      projectPath === "unknown" ? "unknown" : path.basename(projectPath);

    const content = fs.readFileSync(filePath, { encoding: "utf-8" });
    const lines = content.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.type !== "assistant" || !data.message?.usage) continue;

        const usage = data.message.usage;
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const model = data.message.model || "unknown";
        const sessionId = data.sessionId || "unknown";

        if (inputTokens + outputTokens > 0) {
          messageRecords.push({
            sessionId,
            model,
            project: projectName,
            projectPath,
            timestamp: data.timestamp,
            date: data.timestamp.split("T")[0],
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            totalTokens:
              inputTokens +
              outputTokens +
              cacheReadTokens +
              cacheCreationTokens,
          });

          if (!sessionMap.has(sessionId)) {
            sessionMap.set(sessionId, {
              sessionId,
              model,
              project: projectName,
              projectPath,
              timestamp: data.timestamp,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            });
          }
          const session = sessionMap.get(sessionId);
          session.inputTokens += inputTokens;
          session.outputTokens += outputTokens;
          session.cacheReadTokens += cacheReadTokens;
          session.cacheCreationTokens += cacheCreationTokens;
          if (data.timestamp > session.timestamp)
            session.timestamp = data.timestamp;

          const projectPathKey = projectPath || "unknown";
          if (!projectMap.has(projectPathKey)) {
            projectMap.set(projectPathKey, {
              name: projectName,
              path: projectPathKey,
              sessions: new Set(),
              tokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            });
          }
          projectMap.get(projectPathKey).sessions.add(sessionId);
        }
      } catch (parseError) {
        /* 跳过解析失败的行 */
      }
    }
  } catch (fileError) {
    console.error("读取文件失败:", filePath, fileError);
  }
}

// folderName（~/.claude/projects 下的目录名）→ 项目真实路径（取最新 jsonl 首条 cwd）
function _buildProjectPathMap(projectsDir) {
  const projectPathMap = new Map();
  try {
    if (!fs.existsSync(projectsDir)) return projectPathMap;
    const projectFolders = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const folderName of projectFolders) {
      const folderPath = path.join(projectsDir, folderName);
      const files = fs
        .readdirSync(folderPath)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          name: f,
          path: path.join(folderPath, f),
          mtime: fs.statSync(path.join(folderPath, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        try {
          const content = fs.readFileSync(files[0].path, {
            encoding: "utf-8",
          });
          const lines = content.split("\n").filter((line) => line.trim());
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              if (data.cwd) {
                projectPathMap.set(folderName, data.cwd);
                break;
              }
            } catch (e) {
              /* 继续下一行 */
            }
          }
        } catch (e) {
          console.error("读取文件失败:", files[0].path, e);
        }
      }
    }
  } catch (error) {
    console.error("构建项目路径映射失败:", error);
  }
  return projectPathMap;
}

function _processAllUsageData(projectsDir) {
  const projectPathMap = _buildProjectPathMap(projectsDir);
  const sessionMap = new Map();
  const projectMap = new Map();
  const messageRecords = [];
  const jsonlFiles = _findAllJsonlFiles(projectsDir);
  for (const filePath of jsonlFiles) {
    _processSingleJsonlFile(
      filePath,
      messageRecords,
      sessionMap,
      projectMap,
      projectPathMap,
    );
  }
  return { messageRecords, sessionMap, projectMap };
}

function _fillEmptyContributions(contributions) {
  const now = new Date();
  const totalDays = 365;
  const dateMap = new Map();
  for (const day of contributions) dateMap.set(day.date, day);

  const result = [];
  for (let i = totalDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().split("T")[0];
    result.push(
      dateMap.get(dateKey) || {
        date: dateKey,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        models: {},
      },
    );
  }
  return result;
}

function readClaudeUsage(forceRefresh = false) {
  try {
    const homeDir = window.utools.getPath("home");
    const projectsDir = path.join(homeDir, ".claude", "projects");
    if (!fs.existsSync(projectsDir)) return _emptyResult();

    const signature = _calcUsageSignature(projectsDir);
    const cached = getUsageCache();

    if (!forceRefresh && cached && cached.signature === signature) {
      console.log("[Claude Usage] 缓存命中，跳过 JSONL 解析");
      return cached.stats;
    }

    console.log(
      `[Claude Usage] 缓存未命中 (${cached?.signature ?? "null"} → ${signature})，开始全量处理...`,
    );
    const processedData = _processAllUsageData(projectsDir);
    const stats = usage.calculateStats(
      processedData.messageRecords,
      processedData.sessionMap,
    );

    // 合并历史热力图数据
    const history = getHeatmapHistory();
    const liveMap = new Map();
    for (const day of stats.contributions) liveMap.set(day.date, day);

    const merged = [];
    for (const [date, histDay] of Object.entries(history)) {
      if (!liveMap.has(date)) merged.push({ date, ...histDay });
    }
    for (const day of stats.contributions) {
      const histDay = history[day.date];
      merged.push(
        histDay && histDay.tokens > day.tokens
          ? { date: day.date, ...histDay }
          : day,
      );
    }
    merged.sort((a, b) => a.date.localeCompare(b.date));

    const contributions = _fillEmptyContributions(merged);
    setTimeout(() => saveHeatmapHistory(contributions), 0);
    // 「通用」统计统一落库（与热力图同源数据）：同步写，保证紧随其后的读库能看到最新数据
    usage.saveAgentUsage("claude", contributions);

    // 从合并后的 contributions 重新计算 summary + modelStats，确保与热力图口径一致
    let mergedTotal = 0,
      mergedOutput = 0;
    const mergedModelMap = new Map();
    for (const day of contributions) {
      mergedTotal += day.tokens || 0;
      mergedOutput += day.outputTokens || 0;
      if (day.models) {
        for (const [modelName, modelData] of Object.entries(day.models)) {
          if (!mergedModelMap.has(modelName))
            mergedModelMap.set(modelName, {
              name: modelName,
              tokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            });
          const m = mergedModelMap.get(modelName);
          const cacheR = modelData.cacheReadTokens || 0;
          const cacheC = modelData.cacheCreationTokens || 0;
          const inp = modelData.inputTokens || 0;
          const out = modelData.outputTokens || 0;
          m.tokens += inp + out + cacheR + cacheC;
          m.inputTokens += inp + cacheR + cacheC;
          m.outputTokens += out;
        }
      }
    }
    const mergedInput = mergedTotal - mergedOutput;

    const mergedSummary = {
      ...stats.summary,
      totalTokens: mergedTotal,
      inputTokens: mergedInput,
      outputTokens: mergedOutput,
    };
    const mergedModelStats = Array.from(mergedModelMap.values()).sort(
      (a, b) => b.tokens - a.tokens,
    );

    const result = {
      summary: mergedSummary,
      modelStats: mergedModelStats,
      contributions,
      messageRecords: processedData.messageRecords,
      avgTokensPerSession: stats.avgTokensPerSession,
      recentSessions: stats.recentSessions,
    };

    // 写入缓存（不含 messageRecords，太大）
    saveUsageCache(signature, {
      summary: result.summary,
      modelStats: result.modelStats,
      contributions: result.contributions,
    });

    console.log(
      `[Claude Usage] 处理完成: ${processedData.messageRecords.length} 条消息记录`,
    );
    return result;
  } catch (error) {
    console.error("读取 Claude usage 数据失败:", error);
    return _emptyResult();
  }
}

// 从持久化热力图数据读取统计（不扫描 JSONL，快速加载）
function readPersistedUsage() {
  try {
    const history = getHeatmapHistory();
    const entries = Object.entries(history);

    if (entries.length === 0) {
      return {
        summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
        modelStats: [],
        contributions: _fillEmptyContributions([]),
        recentSessions: [],
      };
    }

    let totalTokens = 0,
      outputTokens = 0;
    const modelMap = new Map();

    for (const [, day] of entries) {
      totalTokens += day.tokens || 0;
      outputTokens += day.outputTokens || 0;

      if (day.models) {
        for (const [modelName, modelData] of Object.entries(day.models)) {
          if (!modelMap.has(modelName)) {
            modelMap.set(modelName, {
              name: modelName,
              tokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            });
          }
          const m = modelMap.get(modelName);
          const cacheR = modelData.cacheReadTokens || 0;
          const cacheC = modelData.cacheCreationTokens || 0;
          const inp = modelData.inputTokens || 0;
          const out = modelData.outputTokens || 0;
          m.tokens += inp + out + cacheR + cacheC;
          m.inputTokens += inp + cacheR + cacheC;
          m.outputTokens += out;
        }
      }
    }

    const inputTokens = totalTokens - outputTokens;
    const modelStats = Array.from(modelMap.values()).sort(
      (a, b) => b.tokens - a.tokens,
    );

    // 补齐 365 天
    const now = new Date();
    const totalDays = 365;
    const contributions = [];
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().split("T")[0];
      const dayData = history[dateKey];
      contributions.push(
        dayData
          ? {
              date: dateKey,
              tokens: dayData.tokens,
              inputTokens: dayData.inputTokens,
              outputTokens: dayData.outputTokens,
              models: dayData.models || {},
            }
          : {
              date: dateKey,
              tokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              models: {},
            },
      );
    }

    return {
      summary: { totalTokens, inputTokens, outputTokens },
      modelStats,
      contributions,
      recentSessions: [],
    };
  } catch (error) {
    console.error("读取持久化 usage 数据失败:", error);
    return {
      summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
      modelStats: [],
      contributions: _fillEmptyContributions([]),
      recentSessions: [],
    };
  }
}

// 统计各 MCP server 在 Claude 会话中的调用次数（扫描 tool_use mcp__ 前缀）
function getMcpUsage() {
  try {
    const homeDir = window.utools.getPath("home");
    const projectsDir = path.join(homeDir, ".claude", "projects");
    if (!fs.existsSync(projectsDir)) return {};

    const jsonlFiles = _findAllJsonlFiles(projectsDir);
    let maxMtime = 0;
    for (const f of jsonlFiles) {
      try {
        const m = fs.statSync(f).mtimeMs;
        if (m > maxMtime) maxMtime = m;
      } catch {}
    }
    const signature = `${jsonlFiles.length}:${maxMtime}`;
    if (_mcpUsageCache && _mcpUsageCache.signature === signature) {
      return _mcpUsageCache.data;
    }

    const mcpUsage = {};
    for (const filePath of jsonlFiles) {
      try {
        const content = fs.readFileSync(filePath, { encoding: "utf-8" });
        const lines = content.split("\n").filter((line) => line.trim());
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.type !== "assistant" || !data.message?.content) continue;
            const content = data.message.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if (
                block.type === "tool_use" &&
                block.name &&
                block.name.startsWith("mcp__")
              ) {
                const parts = block.name.split("__");
                if (parts.length >= 3) {
                  const serverName = parts.slice(1, -1).join("__");
                  if (!mcpUsage[serverName])
                    mcpUsage[serverName] = {
                      usageCount: 0,
                      lastUsedAt: null,
                    };
                  mcpUsage[serverName].usageCount++;
                  const ts = data.timestamp
                    ? new Date(data.timestamp).getTime()
                    : 0;
                  if (ts > mcpUsage[serverName].lastUsedAt)
                    mcpUsage[serverName].lastUsedAt = ts;
                }
              }
            }
          } catch (e) {
            /* skip */
          }
        }
      } catch (e) {
        /* skip file */
      }
    }
    _mcpUsageCache = { signature, data: mcpUsage };
    return mcpUsage;
  } catch (e) {
    console.error("读取 MCP usage 失败:", e);
    return {};
  }
}

function copyClaudeCommand(projectPath) {
  if (!projectPath || projectPath === "unknown")
    return { success: false, error: "无效的项目路径" };
  try {
    window.utools.copyText(`cd "${projectPath}" && claude`);
    return { success: true };
  } catch (error) {
    console.error("复制命令失败:", error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  readClaudeUsage,
  readPersistedUsage,
  getMcpUsage,
  copyClaudeCommand,
  // 供 skills.js 项目级技能扫描复用
  _buildProjectPathMap,
};
