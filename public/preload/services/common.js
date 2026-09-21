const fs = require("node:fs");
const path = require("node:path");
const crypto = require("./crypto");

// ==================== 通用配置 ====================
// 设计约定：
//   - 模型/供应商主数据：存 uTools DB（ccswitch_common_providers）
//   - MCP：存 uTools DB（ccswitch_common_mcp，格式与 ~/.mcp.json 一致 { mcpServers: {...} }）
//   - Skill：只读扫描 ~/.agents/skills 目录下的 SKILL.md

const AGENTS_DIR = () => path.join(window.utools.getPath("home"), ".agents");
const COMMON_SKILLS_DIR = () => path.join(AGENTS_DIR(), "skills");

const DOC_PROVIDERS = "ccswitch_common_providers";

const readDoc = (docId, fallback) => {
  try {
    const doc = window.utools.db.get(docId);
    if (doc && doc.data !== undefined) return doc.data;
  } catch (e) {
    /* ignore */
  }
  return fallback;
};

// 递归查找不可 JSON 序列化的字段（函数/Symbol），用于诊断克隆失败
const findNonJsonFields = (obj, path = "$", found = []) => {
  if (obj === null || obj === undefined) return found;
  const t = typeof obj;
  if (t === "function" || t === "symbol") {
    found.push(`${path} (${t})`);
    return found;
  }
  if (t !== "object") return found;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findNonJsonFields(v, `${path}[${i}]`, found));
  } else {
    for (const k of Object.keys(obj))
      findNonJsonFields(obj[k], `${path}.${k}`, found);
  }
  return found;
};

const writeDoc = (docId, data) => {
  try {
    const doc = { _id: docId, data, updatedAt: Date.now() };
    const existing = window.utools.db.get(docId);
    if (existing) doc._rev = existing._rev;
    try {
      window.utools.db.put(doc);
    } catch (e) {
      // uTools 内部结构化克隆失败（数据里混入了函数/Symbol 等非 JSON 内容，
      // 常见于历史异常数据）→ 定位异常字段并净化（丢弃）后重试，保证写入成功
      const nonJson = findNonJsonFields(doc);
      console.error(
        `写入通用配置(${docId})克隆失败:`,
        e,
        "非 JSON 字段:",
        nonJson,
      );
      const clean = JSON.parse(JSON.stringify(doc));
      window.utools.db.put(clean);
    }
    return true;
  } catch (e) {
    console.error(`写入通用配置(${docId})失败:`, e);
    // 抛出带原始错误信息的异常，让上层 UI 能显示具体失败原因
    throw new Error(`写入 uTools DB 失败: ${(e && e.message) || e}`);
  }
};

// ==================== 供应商 / 模型库（uTools DB） ====================

const DEFAULT_PROVIDERS = { providers: [] };

const readCommonProviders = () => {
  const data = readDoc(DOC_PROVIDERS, null) || DEFAULT_PROVIDERS;
  const providers = Array.isArray(data.providers) ? data.providers : [];
  // 解密 apiKey（读时解密，写时加密）
  return {
    providers: providers.map((p) => ({
      ...p,
      apiKey: crypto.decrypt(p.apiKey || ""),
      headers: p.headers || {},
      models: Array.isArray(p.models) ? p.models : [],
    })),
  };
};

const writeCommonProviders = (data) => {
  const providers = (
    data && Array.isArray(data.providers) ? data.providers : []
  ).map((p) => ({
    ...p,
    apiKey: crypto.encrypt(p.apiKey || ""),
  }));
  return writeDoc(DOC_PROVIDERS, { providers });
};

const getCommonProviderList = () => readCommonProviders().providers;

const addCommonProvider = (provider) => {
  const { providers } = readCommonProviders();
  if (providers.some((p) => p.name === provider.name))
    throw new Error(`供应商 ${provider.name} 已存在`);
  providers.push({
    name: provider.name,
    apiKey: "",
    baseUrl: "",
    api: "openai-completions",
    headers: {},
    authHeader: true,
    models: [],
    ...provider,
  });
  return writeCommonProviders({ providers });
};

const updateCommonProvider = (name, patch) => {
  const { providers } = readCommonProviders();
  const idx = providers.findIndex((p) => p.name === name);
  if (idx === -1) throw new Error(`供应商 ${name} 不存在`);
  providers[idx] = { ...providers[idx], ...patch, name };
  return writeCommonProviders({ providers });
};

const deleteCommonProvider = (name) => {
  const { providers } = readCommonProviders();
  const next = providers.filter((p) => p.name !== name);
  if (next.length === providers.length)
    throw new Error(`供应商 ${name} 不存在`);
  return writeCommonProviders({ providers: next });
};

const addCommonModel = (providerName, model) => {
  const { providers } = readCommonProviders();
  const prov = providers.find((p) => p.name === providerName);
  if (!prov) throw new Error(`供应商 ${providerName} 不存在`);
  if (prov.models.some((m) => m.id === model.id))
    throw new Error(`模型 ${model.id} 已存在`);
  prov.models.push(model);
  return writeCommonProviders({ providers });
};

// 批量添加模型：模型 ID 重复（已存在或本批次内重复）自动跳过，一次性写入。
// 返回 { added: string[], skipped: string[] }
const addCommonModels = (providerName, models) => {
  const { providers } = readCommonProviders();
  const prov = providers.find((p) => p.name === providerName);
  if (!prov) throw new Error(`供应商 ${providerName} 不存在`);
  const existing = new Set(prov.models.map((m) => m.id));
  const added = [];
  const skipped = [];
  for (const model of models || []) {
    if (!model || !model.id) continue;
    if (existing.has(model.id)) {
      skipped.push(model.id);
      continue;
    }
    existing.add(model.id);
    prov.models.push(model);
    added.push(model.id);
  }
  if (added.length > 0) writeCommonProviders({ providers });
  return { added, skipped };
};

const updateCommonModel = (providerName, modelId, patch) => {
  const { providers } = readCommonProviders();
  const prov = providers.find((p) => p.name === providerName);
  if (!prov) throw new Error(`供应商 ${providerName} 不存在`);
  const idx = prov.models.findIndex((m) => m.id === modelId);
  if (idx === -1) throw new Error(`模型 ${modelId} 不存在`);
  prov.models[idx] = { ...prov.models[idx], ...patch, id: patch.id || modelId };
  return writeCommonProviders({ providers });
};

const deleteCommonModel = (providerName, modelId) => {
  const { providers } = readCommonProviders();
  const prov = providers.find((p) => p.name === providerName);
  if (!prov) throw new Error(`供应商 ${providerName} 不存在`);
  prov.models = prov.models.filter((m) => m.id !== modelId);
  return writeCommonProviders({ providers });
};

// ==================== MCP（云端主档 + 本地启用开关） ====================
// 云端（uTools DB 单 doc：ccswitch_common_mcp -> { mcpServers: { name: config } }）是唯一主档，
// 所有 MCP 服务器都存一份；本地 = 写入多个 JSON 文件（预置常见路径 + 用户自定义，按机器隔离存
//   ccswitch_mcp_local_targets_<nativeId>）的镜像，位置设置与多文件镜像逻辑不变。
// 每台机器一个启用开关（ccswitch_mcp_local_state_<nativeId> 记 disabled 名单，不在名单 = 启用）：
//   开启 → 写入全部选中文件；关闭 → 从全部文件移除。写文件只替换 mcpServers 字段，
//   保留其他字段（如 $schema）。首次进入按「本地文件中存在 → 启用」初始化开关状态。
const DOC_MCP = "ccswitch_common_mcp";
const DOC_MCP_TARGETS = "ccswitch_mcp_local_targets";
const DOC_MCP_STATE = "ccswitch_mcp_local_state";

const mcpHomePath = () => window.utools.getPath("home");

// 预置的常见本地 MCP 配置路径（~/.mcp.json 排首位：兼容旧默认位置，读取合并优先级最高）
const MCP_LOCAL_PRESETS = () => {
  const home = mcpHomePath();
  return [
    path.join(home, ".mcp.json"),
    path.join(home, ".config", "mcp", "mcp.json"),
    path.join(home, ".agents", "mcp.json"),
    path.join(home, ".agents", "mcp", "mcp.json"),
  ];
};

// 绝对路径 → 带 ~ 前缀的展示路径
const toDisplayMcpPath = (p) => {
  const home = mcpHomePath();
  if (!p) return p;
  if (p === home) return "~";
  return p.startsWith(home + path.sep) ? "~/" + p.slice(home.length + 1) : p;
};

// 支持 ~ 前缀与相对路径，解析为绝对路径
const resolveMcpPath = (p) => {
  const raw = String(p || "").trim();
  if (!raw) return "";
  if (raw === "~") return mcpHomePath();
  if (raw.startsWith("~/") || raw.startsWith("~\\"))
    return path.join(mcpHomePath(), raw.slice(2));
  return path.isAbsolute(raw)
    ? path.normalize(raw)
    : path.join(mcpHomePath(), raw);
};

// 当前选中的本地 MCP 存放路径列表。未配置 → 默认 [~/.mcp.json]（兼容旧行为）
const getLocalMcpTargetPaths = () => {
  const data = readDoc(
    `${DOC_MCP_TARGETS}_${window.utools.getNativeId() || ""}`,
    null,
  );
  const list =
    data && Array.isArray(data.paths)
      ? data.paths.map(resolveMcpPath).filter(Boolean)
      : [];
  const uniq = [...new Set(list)];
  return uniq.length ? uniq : [path.join(mcpHomePath(), ".mcp.json")];
};

// 设置弹窗用：预置路径 + 自定义路径（不在预置列表内）+ 当前选中
const getLocalMcpTargetsInfo = () => {
  const presets = MCP_LOCAL_PRESETS();
  const selected = getLocalMcpTargetPaths();
  const wrap = (p) => ({
    path: p,
    label: toDisplayMcpPath(p),
    exists: fs.existsSync(p),
  });
  return {
    presets: presets.map(wrap),
    custom: selected.filter((p) => !presets.includes(p)).map(wrap),
    selected,
  };
};

// 镜像同步：先把本地文件中主档没有的服务器并入主档，再把主档中已启用的服务器
// 全量写回全部选中文件（禁用的从文件移除），保证各位置与主档完全一致（镜像）。
// 返回 { servers, failed }：failed = 写入失败的文件列表（磁盘满/权限等）。
const syncLocalMcpTargets = () => {
  ingestLocalMcpIntoMaster();
  const desired = getEnabledMcpServers();
  const failed = [];
  for (const p of getLocalMcpTargetPaths()) {
    const doc = readMcpDocFile(p);
    doc.mcpServers = JSON.parse(JSON.stringify(desired));
    if (!writeMcpDocFile(p, doc)) failed.push(p);
  }
  return { servers: Object.keys(desired).length, failed };
};

// 保存选中列表（至少一个；排序：预置顺序在前，自定义在后）。
// 保存时：
//   1. 被取消勾选的位置 → 删除已启用的服务器（= 主档管理集），该文件里其他来源
//      独有的条目不动，避免误伤；
//   2. 镜像同步 → 新选中文件里已有的服务器回收进主档，各位置从此与主档一致。
// 返回 { paths, removed }（removed = 被取消并清理的位置列表）
const saveLocalMcpTargets = (paths) => {
  const oldPaths = getLocalMcpTargetPaths();
  const list = [
    ...new Set(
      (Array.isArray(paths) ? paths : []).map(resolveMcpPath).filter(Boolean),
    ),
  ];
  if (list.length === 0)
    throw new Error("请至少保留一个本地存放位置（否则本地端将无文件可写）");
  // 写入逻辑用严格 JSON.parse，非 JSON 文件会被整文件覆盖破坏 → 仅允许 .json
  const notJson = list.filter((p) => !/\.json$/i.test(p));
  if (notJson.length)
    throw new Error(
      `仅支持 .json 文件，以下路径非法：${notJson.map(toDisplayMcpPath).join("、")}`,
    );
  const presets = MCP_LOCAL_PRESETS();
  const ordered = [
    ...presets.filter((p) => list.includes(p)),
    ...list.filter((p) => !presets.includes(p)),
  ];
  writeDoc(`${DOC_MCP_TARGETS}_${window.utools.getNativeId() || ""}`, {
    paths: ordered,
  });
  // 被取消勾选的位置：删除已启用的服务器（= 本库主档管理集），
  // 其他来源独有的条目保留
  const removed = oldPaths.filter((p) => !ordered.includes(p));
  if (removed.length) {
    const managed = getEnabledMcpServers();
    for (const p of removed) {
      const doc = readMcpDocFile(p);
      let dirty = false;
      for (const name of Object.keys(managed)) {
        if (name in doc.mcpServers) {
          delete doc.mcpServers[name];
          dirty = true;
        }
      }
      if (dirty) writeMcpDocFile(p, doc);
    }
  }
  syncLocalMcpTargets();
  return { paths: ordered, removed };
};

// 系统文件选择器选一个本地文件（用于自定义路径），取消返回 null；仅限 .json（写入逻辑用严格 JSON.parse，非 JSON 文件会被整文件覆盖破坏）
const selectLocalMcpTargetFile = () => {
  try {
    const result = window.utools.showOpenDialog({
      title: "选择 MCP 配置文件",
      properties: ["openFile"],
      filters: [{ name: "MCP 配置 (*.json)", extensions: ["json"] }],
    });
    const picked = Array.isArray(result) && result.length ? result[0] : null;
    if (picked && !/\.json$/i.test(picked)) {
      console.error("仅支持 .json 文件:", picked);
      return null;
    }
    return picked;
  } catch (e) {
    console.error("选择 MCP 配置文件失败:", e);
    return null;
  }
};

// ---------- 云端主档（uTools DB，唯一数据源）与本机启停状态 ----------

const readCommonMcpDoc = () => {
  const data = readDoc(DOC_MCP, null) || { mcpServers: {} };
  if (!data.mcpServers || typeof data.mcpServers !== "object")
    data.mcpServers = {};
  return data;
};

const getCommonMcpServers = () => readCommonMcpDoc().mcpServers;

const mcpStateKey = () =>
  `${DOC_MCP_STATE}_${window.utools.getNativeId() || ""}`;

// 本机启停状态：disabled = 未写入本地文件的服务器名单，不在名单 = 启用（默认启用）
const readMcpLocalState = () => {
  const data = readDoc(mcpStateKey(), null);
  return data && Array.isArray(data.disabled) ? data : { disabled: [] };
};

// 主档全部服务器 name → 是否启用本地
const getMcpEnabledMap = () => {
  const disabled = new Set(readMcpLocalState().disabled);
  const map = {};
  for (const name of Object.keys(getCommonMcpServers()))
    map[name] = !disabled.has(name);
  return map;
};

// 当前写入本地（已启用）的主档服务器 name → config
const getEnabledMcpServers = () => {
  const disabled = new Set(readMcpLocalState().disabled);
  const out = {};
  for (const [name, cfg] of Object.entries(getCommonMcpServers()))
    if (!disabled.has(name)) out[name] = cfg;
  return out;
};

// 本地文件回收进主档：文件中存在而主档没有的服务器补进主档（本机视为启用）；
// 已存在的以主档配置为准。首次进入（本机无状态档）按「在本地文件中 → 启用，
// 仅云端 → 关闭」初始化启停名单。
const ingestLocalMcpIntoMaster = () => {
  const master = readCommonMcpDoc();
  const local = getLocalMcpServers();
  let dirty = false;
  for (const [name, cfg] of Object.entries(local)) {
    if (!(name in master.mcpServers)) {
      master.mcpServers[name] = cfg;
      dirty = true;
    }
  }
  if (!readDoc(mcpStateKey(), null))
    writeDoc(mcpStateKey(), {
      disabled: Object.keys(master.mcpServers).filter((n) => !(n in local)),
    });
  if (dirty) writeDoc(DOC_MCP, { mcpServers: master.mcpServers });
};

// 渲染层列表：主档全部服务器 + 本机启停状态 [{ name, config, enabled }]
const listCommonMcpServers = () => {
  ingestLocalMcpIntoMaster();
  const enabled = getMcpEnabledMap();
  return Object.entries(getCommonMcpServers()).map(([name, config]) => ({
    name,
    config,
    enabled: !!enabled[name],
  }));
};

// 添加/编辑：总是写主档，再按启停状态镜像同步本地文件（禁用的只更新主档）
const upsertCommonMcpServer = (name, serverConfig) => {
  const data = readCommonMcpDoc();
  data.mcpServers[name] = serverConfig;
  const ok = writeDoc(DOC_MCP, { mcpServers: data.mcpServers });
  syncLocalMcpTargets();
  return ok;
};

// 删除：主档与启停名单一并移除，并同步落到全部选中本地文件。
// 先从文件精确移除该条目，再镜像同步 —— 防止 sync 内的回收步骤把残留副本重新并入主档。
const deleteCommonMcpServer = (name) => {
  const data = readCommonMcpDoc();
  const existed = name in data.mcpServers;
  delete data.mcpServers[name];
  const state = readMcpLocalState();
  const idx = state.disabled.indexOf(name);
  if (idx >= 0) {
    state.disabled.splice(idx, 1);
    writeDoc(mcpStateKey(), state);
  }
  writeDoc(DOC_MCP, { mcpServers: data.mcpServers });
  for (const p of getLocalMcpTargetPaths()) {
    const doc = readMcpDocFile(p);
    if (doc.mcpServers[name]) {
      delete doc.mcpServers[name];
      writeMcpDocFile(p, doc);
    }
  }
  syncLocalMcpTargets();
  return existed;
};

// 启停开关：开 = 写入全部选中本地文件，关 = 从全部文件移除（主档始终保留一份）
const setCommonMcpEnabled = (name, enabled) => {
  if (!(name in getCommonMcpServers()))
    throw new Error(`服务器 ${name} 不存在`);
  const state = readMcpLocalState();
  const idx = state.disabled.indexOf(name);
  if (enabled) {
    if (idx >= 0) state.disabled.splice(idx, 1);
  } else if (idx < 0) {
    state.disabled.push(name);
  }
  writeDoc(mcpStateKey(), state);
  return syncLocalMcpTargets();
};

// ---------- 本地文件读写（镜像目标：启停与同步由主档 API 驱动） ----------

// 读单个文件（保留 mcpServers 之外的其他字段，如 $schema）；缺失/解析失败返回空壳
const readMcpDocFile = (filePath) => {
  let doc = null;
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, { encoding: "utf-8" }));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) doc = raw;
    }
  } catch (e) {
    console.error(`读取 MCP 配置文件失败 (${filePath}):`, e);
  }
  if (!doc) doc = {};
  if (
    !doc.mcpServers ||
    typeof doc.mcpServers !== "object" ||
    Array.isArray(doc.mcpServers)
  )
    doc.mcpServers = {};
  return doc;
};

const writeMcpDocFile = (filePath, doc) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), {
      encoding: "utf-8",
    });
    return true;
  } catch (e) {
    console.error(`写入 MCP 配置文件失败 (${filePath}):`, e);
    return false;
  }
};

// 合并所有选中文件的 mcpServers（同名以路径顺序先到先得，~/.mcp.json 优先）。
// 仅供主档回收（ingestLocalMcpIntoMaster）使用，不再是独立存储端。
const getLocalMcpServers = () => {
  const merged = {};
  for (const p of getLocalMcpTargetPaths()) {
    const servers = readMcpDocFile(p).mcpServers;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!(name in merged)) merged[name] = cfg;
    }
  }
  return merged;
};

// 本地/云端双端 API 已移除：启停与镜像同步统一由主档 API
// （upsertCommonMcpServer / deleteCommonMcpServer / setCommonMcpEnabled / syncLocalMcpTargets）驱动。

// ==================== Skill 启停（.disabled 文件夹方式，同 Claude Code） ====================
// 通用 Skill 存放在 ~/.agents/skills（跨 Agent 共享）。
// 禁用 = 将 skill 目录移动到 ~/.agents/skills/.disabled/<name>，启用 = 移回，
// 与 Claude Code 的 skill 启停方式一致（agent 扫描时 .disabled 目录会被忽略）。

const DISABLED_DIR_NAME = ".disabled";

const getDisabledSkillsDir = () =>
  path.join(COMMON_SKILLS_DIR(), DISABLED_DIR_NAME);

// 设置通用 Skill 启用/禁用（物理移动目录到 .disabled / 移回）
const setCommonSkillEnabled = (skillName, enabled) => {
  if (!skillName) return { success: false, error: "Skill 名不能为空" };
  const disabledDir = getDisabledSkillsDir();
  const sourceDir = enabled
    ? path.join(disabledDir, skillName)
    : path.join(COMMON_SKILLS_DIR(), skillName);
  const targetDir = enabled
    ? path.join(COMMON_SKILLS_DIR(), skillName)
    : path.join(disabledDir, skillName);
  if (!fs.existsSync(sourceDir))
    return { success: false, error: "Skill 不存在" };
  try {
    if (!enabled) fs.mkdirSync(disabledDir, { recursive: true });
    fs.renameSync(sourceDir, targetDir);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

// 删除通用 Skill（已禁用时从 .disabled 删除）
const deleteCommonSkill = (skillName) => {
  if (!skillName) return { success: false, error: "Skill 名不能为空" };
  const candidates = [
    path.join(COMMON_SKILLS_DIR(), skillName),
    path.join(getDisabledSkillsDir(), skillName),
  ];
  const dir = candidates.find((p) => fs.existsSync(p));
  if (!dir) return { success: false, error: "Skill 目录不存在" };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

// ==================== Skill（只读扫描 ~/.agents/skills） ====================

// 解析 SKILL.md 的 name/description（frontmatter 简单解析，兼容单行与多行块首行）
const parseSkillFrontmatter = (content) => {
  const result = { name: "", description: "" };
  if (!content) return result;
  // 去除 UTF-8 BOM（SkillHub 等来源的 SKILL.md 常带 BOM）
  content = content.replace(/^\uFEFF/, "");
  const lines = content.split("\n");
  let inFm = false;
  let descKey = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "---") {
      if (!inFm) {
        inFm = true;
        continue;
      }
      break;
    }
    if (!inFm) continue;
    const nameMatch = trimmed.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      result.name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const descMatch = trimmed.match(/^description:\s*(.*)$/);
    if (descMatch) {
      if (descMatch[1].trim()) {
        result.description = descMatch[1].trim().replace(/^["']|["']$/g, "");
      } else {
        descKey = true; // 多行块：description: |
      }
      continue;
    }
    // 多行 description 块：取第一个非空行
    if (descKey && !result.description && trimmed) {
      result.description = trimmed.replace(/^["']|["']$/g, "");
      descKey = false;
    }
  }
  return result;
};

// 读取 ~/.agents/skills 下每个子目录的 SKILL.md（目录不存在时自动创建）
// 启用的 skill 直接扫描；禁用的 skill 扫描 .disabled 子目录（与 Claude Code 机制一致）
const readCommonSkills = () => {
  const dir = COMMON_SKILLS_DIR();
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      /* 创建失败则按空目录处理 */
    }
    return [];
  }
  try {
    const skills = [];
    const readOne = (skillDir, dirName, enabled) => {
      const skillMdPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) return;
      try {
        const content = fs
          .readFileSync(skillMdPath, { encoding: "utf-8" })
          .replace(/^\uFEFF/, "");
        const fm = parseSkillFrontmatter(content);
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let fileCount = 0;
        try {
          fileCount = fs
            .readdirSync(skillDir)
            .filter((f) => !f.startsWith(".")).length;
        } catch {
          /* ignore */
        }
        skills.push({
          name: fm.name || dirName,
          dirName,
          description: fm.description,
          dir: skillDir,
          frontmatter: fmMatch ? fmMatch[1] : "",
          fileCount,
          enabled,
        });
      } catch (e) {
        /* 单个 skill 解析失败跳过 */
      }
    };

    // 启用的 skills（跳过 .disabled 及隐藏目录）
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      readOne(path.join(dir, entry.name), entry.name, true);
    }

    // 禁用的 skills（.disabled 目录内）
    const disabledDir = getDisabledSkillsDir();
    if (fs.existsSync(disabledDir)) {
      const disabledEntries = fs.readdirSync(disabledDir, {
        withFileTypes: true,
      });
      for (const entry of disabledEntries) {
        if (!entry.isDirectory()) continue;
        readOne(path.join(disabledDir, entry.name), entry.name, false);
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
  } catch (e) {
    console.error("读取通用 Skill 目录失败:", e);
    return [];
  }
};

const openCommonSkillsDir = () => {
  const dir = COMMON_SKILLS_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  window.utools.shellOpenPath(dir);
};

const getCommonSkillsPath = () => {
  const dir = COMMON_SKILLS_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

module.exports = {
  COMMON_SKILLS_DIR,
  readCommonProviders,
  writeCommonProviders,
  getCommonProviderList,
  addCommonProvider,
  updateCommonProvider,
  deleteCommonProvider,
  addCommonModel,
  addCommonModels,
  updateCommonModel,
  deleteCommonModel,
  listCommonMcpServers,
  upsertCommonMcpServer,
  deleteCommonMcpServer,
  setCommonMcpEnabled,
  getLocalMcpTargetPaths,
  getLocalMcpTargetsInfo,
  saveLocalMcpTargets,
  syncLocalMcpTargets,
  selectLocalMcpTargetFile,
  resolveMcpPath,
  toDisplayMcpPath,
  readCommonSkills,
  openCommonSkillsDir,
  getCommonSkillsPath,
  setCommonSkillEnabled,
  deleteCommonSkill,
};
