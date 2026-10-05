// pi agent 配置主模块：models.json 供应商/模型管理、自动拉取模型列表、
// 技能/MCP/用量统计与目录操作。路径发现与 CLI 调用在 pi-common，
// 扩展市场在 pi-extensions，已装包启停在 pi-package-detail，这里统一再导出。
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { execSync } = require("node:child_process");
const usage = require("./usage");
const {
  PI_DIR,
  PI_NPM_DIR,
  PI_CMD_TIMEOUT,
  resolvePiPath,
  readJson,
  writeJson,
  buildPiEnv,
  runPiCmd,
  readPiSettings,
  writePiSettings,
} = require("./pi-common");
const packageDetail = require("./pi-package-detail");
const extensionsMarket = require("./pi-extensions");

const PI_MODELS_PATH = () => path.join(PI_DIR(), "models.json");
const PI_SESSIONS_DIR = () => path.join(PI_DIR(), "sessions");

// ==================== Models / Providers ====================

const readPiModels = () => readJson(PI_MODELS_PATH()) || { providers: {} };
const writePiModels = (data) => writeJson(PI_MODELS_PATH(), data);

// ==================== 自动获取模型列表 ====================

// GET {baseUrl}/models —— OpenAI-compatible 接口
// 容错策略：部分中转站（New API / one-api）根路径 /models 返回面板 HTML，
// 真实 OpenAI 兼容端点在 /v1/models；baseUrl 已含 /v1 前缀时直接在其后拼接。
// 依次尝试候选路径，直到拿到合法 JSON 模型列表。
const fetchProviderModels = async (baseUrl, apiKey, timeout = 10_000) => {
  const base = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const root = base.endsWith("/") ? base : base + "/";

  const pathname = new URL(root).pathname;
  const hasV1Prefix = /\/v1\/?$/.test(pathname);
  const candidates = hasV1Prefix ? ["models"] : ["models", "v1/models"];

  const tryOnce = (p) =>
    new Promise((resolve, reject) => {
      // 相对拼接，保留 baseUrl 自身路径（如 /v1 或代理前缀）
      const url = new URL(p, root);
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.get(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: {
            accept: "application/json",
            // 同时带 Bearer 与 x-api-key：OpenAI 兼容中转站认 Bearer，Anthropic 原生接口认 x-api-key
            ...(apiKey
              ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey }
              : {}),
          },
          timeout,
        },
        (res) => {
          // 重定向：跟随（location 为绝对地址时重新解析）
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            return resolve(
              fetchProviderModels(res.headers.location, apiKey, timeout),
            );
          }
          // 非 2xx，或 content-type 明确不是 JSON（如中转站面板 HTML）→ 换下一个候选路径
          const ct = (res.headers["content-type"] || "").toLowerCase();
          if (
            res.statusCode < 200 ||
            res.statusCode >= 300 ||
            (ct && !ct.includes("json"))
          ) {
            res.resume();
            return reject(
              new Error(
                `HTTP ${res.statusCode}${ct ? ` (${ct.split(";")[0]})` : ""}`,
              ),
            );
          }
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              const list = parsed.data || parsed.models || parsed;
              if (!Array.isArray(list))
                return reject(new Error("响应格式错误"));
              resolve(
                list
                  .map((m) => {
                    const item = typeof m === "string" ? { id: m } : m || {};
                    const id = item.id || item.name;
                    if (!id) return null;
                    return {
                      id,
                      name: item.name || item.id || id,
                      contextWindow:
                        item.context_window ||
                        item.context_length ||
                        item.contextWindow ||
                        item.max_context_length ||
                        0,
                      maxTokens: item.max_tokens || item.maxTokens || 0,
                      reasoning: !!(
                        item.capabilities ||
                        item.architecture?.modality ||
                        ""
                      )
                        .toString()
                        .includes("reasoning"),
                    };
                  })
                  .filter(Boolean),
              );
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
    });

  let lastErr = null;
  for (const p of candidates) {
    try {
      return await tryOnce(p);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("获取模型列表失败");
};

const getPiProviderList = () => {
  const models = readPiModels();
  const settings = readPiSettings();
  return Object.entries(models.providers || {}).map(([name, cfg]) => ({
    name,
    apiKey: cfg.apiKey || "",
    baseUrl: cfg.baseUrl || "",
    api: cfg.api || "",
    headers: cfg.headers || {},
    authHeader: !!cfg.authHeader,
    models: (cfg.models || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.contextWindow || undefined,
      maxTokens: m.maxTokens || undefined,
      reasoning: !!m.reasoning,
      isDefault: settings.defaultModel === m.id,
      input: m.input || ["text"],
      cost: m.cost && m.cost.input != null ? m.cost : null,
      compat: m.compat || {},
    })),
    isDefault: settings.defaultProvider === name,
  }));
};

const setPiDefaultProvider = (providerName) => {
  const settings = readPiSettings();
  settings.defaultProvider = providerName;
  // 如果当前 defaultModel 不属于新供应商，自动切到该供应商第一个模型
  const models = readPiModels();
  const prov = models.providers?.[providerName];
  if (prov?.models?.length) {
    const stillValid = prov.models.some((m) => m.id === settings.defaultModel);
    if (!stillValid) {
      settings.defaultModel = prov.models[0].id;
    }
  }
  writePiSettings(settings);
};

const setPiDefaultModel = (modelId) => {
  const settings = readPiSettings();
  settings.defaultModel = modelId;
  writePiSettings(settings);
};

// cost 规范化：全为 0 时返回 undefined（配置文件中不写 cost，Pi schema 约定 0 无效）
const normalizeCost = (cost) => {
  if (!cost || typeof cost !== "object") return undefined;
  const c = {
    input: Number(cost.input) || 0,
    output: Number(cost.output) || 0,
    cacheRead: Number(cost.cacheRead) || 0,
    cacheWrite: Number(cost.cacheWrite) || 0,
  };
  if (!c.input && !c.output && !c.cacheRead && !c.cacheWrite) return undefined;
  return c;
};

const updatePiModel = (providerName, modelId, updates) => {
  const models = readPiModels();
  if (!models.providers?.[providerName])
    throw new Error(`供应商 ${providerName} 不存在`);
  const prov = models.providers[providerName];
  if (!prov.models) return;
  const idx = prov.models.findIndex((m) => m.id === modelId);
  if (idx === -1) throw new Error(`模型 ${modelId} 不存在`);
  // 不允许通过编辑改 id（id 是唯一标识）
  const next = { ...prov.models[idx] };
  if (updates.name !== undefined) next.name = updates.name;
  if (updates.contextWindow !== undefined)
    next.contextWindow = updates.contextWindow || undefined;
  if (updates.maxTokens !== undefined)
    next.maxTokens = updates.maxTokens || undefined;
  if (updates.reasoning !== undefined) next.reasoning = !!updates.reasoning;
  if (updates.input !== undefined) next.input = updates.input;
  if (updates.cost !== undefined) {
    const cost = normalizeCost(updates.cost);
    if (cost) next.cost = cost;
    else delete next.cost;
  }
  if (updates.compat !== undefined) next.compat = updates.compat;
  prov.models[idx] = next;
  writePiModels(models);
};

const updatePiProvider = (providerName, updates) => {
  const models = readPiModels();
  if (!models.providers) models.providers = {};
  if (!models.providers[providerName])
    models.providers[providerName] = { models: [] };
  Object.assign(models.providers[providerName], updates);
  writePiModels(models);
};

const addPiProvider = (providerName, cfg = {}) => {
  if (!providerName || typeof providerName !== "string")
    throw new Error("供应商名不能为空");
  const models = readPiModels();
  if (!models.providers) models.providers = {};
  if (models.providers[providerName])
    throw new Error(`供应商 ${providerName} 已存在`);
  models.providers[providerName] = {
    apiKey: cfg.apiKey || "",
    baseUrl: cfg.baseUrl || "",
    api: cfg.api || "openai-completions",
    headers: cfg.headers || {},
    authHeader: !!cfg.authHeader,
    models: [],
  };
  writePiModels(models);
};

const deletePiProvider = (providerName) => {
  const models = readPiModels();
  if (!models.providers?.[providerName]) throw new Error("供应商不存在");
  delete models.providers[providerName];
  writePiModels(models);
  // 清理 settings 中的 defaultProvider 指向
  const settings = readPiSettings();
  if (settings.defaultProvider === providerName) {
    settings.defaultProvider = "";
    writePiSettings(settings);
  }
};

const addPiModel = (providerName, model) => {
  if (!providerName) throw new Error("供应商名不能为空");
  if (!model?.id) throw new Error("模型 ID 不能为空");
  const models = readPiModels();
  if (!models.providers?.[providerName])
    throw new Error(`供应商 ${providerName} 不存在`);
  const prov = models.providers[providerName];
  if (!prov.models) prov.models = [];
  if (prov.models.some((m) => m.id === model.id))
    throw new Error(`模型 ${model.id} 已存在`);
  const cost = normalizeCost(model.cost);
  prov.models.push({
    id: model.id,
    name: model.name || model.id,
    contextWindow: model.contextWindow || undefined,
    maxTokens: model.maxTokens || undefined,
    reasoning: !!model.reasoning,
    input: model.input || ["text"],
    ...(cost ? { cost } : {}),
    compat: model.compat || {},
  });
  writePiModels(models);
};

const deletePiModel = (providerName, modelId) => {
  const models = readPiModels();
  if (!models.providers?.[providerName])
    throw new Error(`供应商 ${providerName} 不存在`);
  const prov = models.providers[providerName];
  if (!prov.models) return;
  prov.models = prov.models.filter((m) => m.id !== modelId);
  writePiModels(models);
  // 清理 defaultModel 指向
  const settings = readPiSettings();
  if (settings.defaultModel === modelId) {
    settings.defaultModel = "";
    writePiSettings(settings);
  }
};

// ==================== Skills ====================

const getPiSkills = () => {
  const extensions = packageDetail.getPiExtensions();
  const all = [];
  for (const ext of extensions) {
    for (const skill of ext.resources.skills) {
      let frontmatter = "";
      const skillMd = path.join(
        PI_NPM_DIR(),
        ext.name,
        "skills",
        skill,
        "SKILL.md",
      );
      try {
        const content = fs
          .readFileSync(skillMd, { encoding: "utf-8" })
          .replace(/^\uFEFF/, "");
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        frontmatter = match ? match[1] : "";
      } catch {
        /* ignore */
      }
      all.push({ name: skill, package: ext.name, frontmatter });
    }
  }
  return all;
};

// ==================== MCP Servers（pi mcp list --json） ====================

// 通过 pi 官方 CLI 读取 MCP 配置（~/.pi/agent/mcp.json 及受信项目 .pi/mcp.json），
// 返回字段：serverName/name/scope/source/enabled/exposure/transport/state/tools
const getPiMcpServers = async () => {
  try {
    const result = await runPiCmd(["mcp", "list", "--json"], PI_CMD_TIMEOUT.list);
    if (!result.success) {
      console.error("pi mcp list --json 失败:", result.stderr);
      return [];
    }
    const start = result.stdout.indexOf("{");
    if (start < 0) return [];
    const data = JSON.parse(result.stdout.slice(start));
    const servers = Array.isArray(data?.servers) ? data.servers : [];
    return servers.map((s) => ({
      serverName: s.name,
      name: s.name,
      scope: s.scope,
      source: s.source,
      enabled: s.enabled !== false,
      exposure: s.exposure,
      transport: s.transport || "",
      state: s.state,
      tools: Array.isArray(s.tools) ? s.tools : [],
      config: s,
    }));
  } catch (e) {
    console.error("读取 Pi MCP 配置失败:", e);
    return [];
  }
};

// ==================== Usage ====================

const decodePiSessionPath = (encodedDir) => {
  try {
    // Pi Agent 用 -- 替代路径分隔符编码目录名，首尾也有 --
    const sep = path.sep;
    let decoded = encodedDir.replace(/^--|--$/g, "").replace(/--/g, sep);
    // Unix: 还原后需要补前导 /
    if (sep === "/" && !decoded.startsWith("/")) decoded = "/" + decoded;
    return decoded;
  } catch {
    return encodedDir;
  }
};

const readPiUsage = () => {
  const sessionsDir = PI_SESSIONS_DIR();
  if (!fs.existsSync(sessionsDir)) return emptyResult();

  const sessionDirs = fs
    .readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const messageRecords = [];
  const sessionMap = new Map();

  for (const encodedDir of sessionDirs) {
    const dirPath = path.join(sessionsDir, encodedDir);
    const projectPath = decodePiSessionPath(encodedDir);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dirPath, file), {
          encoding: "utf-8",
        });
        const lines = content.split("\n").filter((l) => l.trim());
        let sessionId = "";
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            if (d.type === "session") {
              sessionId = d.id;
              if (!sessionMap.has(sessionId)) {
                sessionMap.set(sessionId, {
                  sessionId,
                  timestamp: d.timestamp,
                  cwd: d.cwd || projectPath,
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  totalCost: 0,
                });
              }
            }
            if (d.type === "message" && d.message?.usage) {
              const u = d.message.usage;
              const model = d.message.model || d.model || "unknown";
              const ts = d.timestamp || "";
              const input = u.input || 0;
              const output = u.output || 0;
              const cacheRead = u.cacheRead || 0;
              const cacheWrite = u.cacheWrite || 0;
              const total =
                u.totalTokens || input + output + cacheRead + cacheWrite;

              messageRecords.push({
                sessionId,
                model,
                project: path.basename(projectPath),
                projectPath,
                timestamp: ts,
                date: ts.split("T")[0],
                inputTokens: input,
                outputTokens: output,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                totalTokens: total,
                cost: u.cost?.total || 0,
              });

              if (sessionMap.has(sessionId)) {
                const s = sessionMap.get(sessionId);
                s.inputTokens += input;
                s.outputTokens += output;
                s.cacheReadTokens += cacheRead;
                s.cacheWriteTokens += cacheWrite;
                s.totalCost += u.cost?.total || 0;
                if (ts > s.timestamp) s.timestamp = ts;
              }
            }
          } catch {
            /* skip parse error */
          }
        }
      } catch {
        /* skip file read error */
      }
    }
  }

  const stats = usage.calculateStats(messageRecords, sessionMap, {
    includeCost: true,
  });
  // 「通用」统计统一落库
  usage.saveAgentUsage("pi", stats.contributions);
  return stats;
};

const emptyResult = () => {
  const now = new Date();
  const contributions = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    contributions.push({
      date: d.toISOString().split("T")[0],
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      models: {},
    });
  }
  return {
    summary: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCost: 0,
      messageCount: 0,
      sessionCount: 0,
    },
    modelStats: [],
    contributions,
    avgTokensPerSession: 0,
    recentSessions: [],
  };
};

// ==================== 目录操作 ====================

const openPiDir = () => {
  const dir = PI_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    window.utools.shellOpenPath(dir);
  } catch {
    /* ignore */
  }
};

const openPiExtDir = () => {
  const dir = PI_NPM_DIR();
  console.log("[openPiExtDir] target dir:", dir, "exists:", fs.existsSync(dir));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    const result = window.utools.shellOpenPath(dir);
    console.log("[openPiExtDir] shellOpenPath result:", result);
  } catch (e) {
    console.error("[openPiExtDir] error:", e.message);
  }
};

// pi 命令是否可用（不存在 = 未安装 Pi Agent）
const isPiInstalled = () => {
  // 1. 已知路径（resolvePiPath 找到真实路径）
  const piBin = resolvePiPath();
  if (piBin && piBin !== "pi") return true;
  // 2. 兜底：shell 执行验证（覆盖 PATH 里但不在候选列表的安装方式）
  try {
    const out = execSync("pi --version", {
      encoding: "utf-8",
      timeout: 8000,
      shell: true,
      env: buildPiEnv(),
    });
    return !!out.trim();
  } catch {
    return false;
  }
};

module.exports = {
  readPiSettings,
  writePiSettings,
  resolvePiPath,
  readPiModels,
  writePiModels,
  getPiProviderList,
  setPiDefaultProvider,
  setPiDefaultModel,
  updatePiProvider,
  updatePiModel,
  addPiProvider,
  deletePiProvider,
  addPiModel,
  deletePiModel,
  isPiInstalled,
  getPiSkills,
  getPiMcpServers,
  readPiUsage,
  fetchProviderModels,
  openPiDir,
  openPiExtDir,
  ...packageDetail,
  ...extensionsMarket,
};
