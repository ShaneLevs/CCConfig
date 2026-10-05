// 技能安装流水线（SkillHub / ModelScope → Claude / OpenCode / 通用 ~/.agents/skills）。
// 三个目标目录的安装流程完全同构，统一为参数化实现；对外函数名与原 window.services 一致。
const fs = require("node:fs");
const path = require("node:path");

const config = require("./config");
const opencode = require("./opencode");
const common = require("./common");

// ==================== SkillHub API 辅助 ====================
const SKILLHUB_API_BASE = "https://api.skillhub.cn";
const SKILLHUB_HEADERS = {
  accept: "application/json, text/plain, */*",
  origin: "https://skillhub.cn",
  referer: "https://skillhub.cn/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

// 拼接 SkillHub API URL（自动过滤空参数）
function _skillhubApiUrl(pathname, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, v);
  }
  const q = qs.toString();
  return `${SKILLHUB_API_BASE}${pathname}${q ? `?${q}` : ""}`;
}

// GET JSON（带状态码校验）
function _skillhubGetJson(pathname, params) {
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    https
      .get(_skillhubApiUrl(pathname, params), { headers: SKILLHUB_HEADERS }, (res) => {
        if (res.statusCode === 404) return reject(new Error("Skill not found"));
        if (res.statusCode !== 200)
          return reject(new Error(`请求失败: HTTP ${res.statusCode}`));
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("解析响应失败"));
          }
        });
      })
      .on("error", reject);
  });
}

// 下载文件到本地（支持多级重定向与相对 location）
function _downloadToFile(url, filePath, onProgress, headers = SKILLHUB_HEADERS) {
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    const doGet = (targetUrl, redirectCount = 0) => {
      if (redirectCount > 10) return reject(new Error("重定向次数过多"));
      https
        .get(targetUrl, { headers }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            if (!res.headers.location)
              return reject(new Error("重定向缺少 location"));
            res.resume();
            doGet(
              new URL(res.headers.location, targetUrl).toString(),
              redirectCount + 1,
            );
            return;
          }
          if (res.statusCode !== 200)
            return reject(new Error(`下载失败: HTTP ${res.statusCode}`));
          const totalSize = parseInt(res.headers["content-length"], 10) || 0;
          let downloaded = 0;
          const file = fs.createWriteStream(filePath);
          res.on("data", (chunk) => {
            downloaded += chunk.length;
            if (onProgress && totalSize > 0)
              onProgress(Math.round((downloaded / totalSize) * 100));
          });
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          file.on("error", (err) => {
            try {
              fs.unlinkSync(filePath);
            } catch (e) {
              /* ignore */
            }
            reject(err);
          });
        })
        .on("error", reject);
    };
    doGet(url);
  });
}

// 下载 SkillHub skill 的 zip 包（官方 download 端点，302 到 COS）
function _downloadSkillhubZip({ slug, version, namespace }, zipPath, onProgress) {
  const url = _skillhubApiUrl("/api/v1/download", { slug, version, namespace });
  return _downloadToFile(url, zipPath, onProgress);
}

// 递归查找 SKILL.md
function _findSkillMd(dir, depth = 0) {
  const results = [];
  const skillMd = path.join(dir, "SKILL.md");
  if (fs.existsSync(skillMd))
    results.push({ skillMdPath: skillMd, skillDir: dir, depth });
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory())
        results.push(..._findSkillMd(path.join(dir, entry.name), depth + 1));
    }
  } catch (e) {
    /* ignore */
  }
  return results;
}

// ==================== 安装公共流程 ====================

function _tempInstallDir() {
  return path.join(window.utools.getPath("temp"), "ccswitch-skill-install");
}

function _extractZip(zipPath, extractDir) {
  const { execSync } = require("node:child_process");
  if (window.utools.isMacOS() || window.utools.isLinux()) {
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
  } else if (window.utools.isWindows()) {
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: "pipe" },
    );
  }
}

// 取压缩包内最浅层 SKILL.md 并解析 frontmatter 的 name 字段
function _pickShallowestSkill(extractDir) {
  const allSkillMds = _findSkillMd(extractDir);
  if (allSkillMds.length === 0)
    throw new Error("压缩包中未找到 SKILL.md 文件");

  allSkillMds.sort((a, b) => a.depth - b.depth);
  const skillInfo = allSkillMds[0];
  const skillMdContent = fs.readFileSync(skillInfo.skillMdPath, {
    encoding: "utf-8",
  });
  const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m);
  return { skillInfo, nameFromMd: nameMatch ? nameMatch[1].trim() : null };
}

function _cleanupTempDir() {
  const tempDir = _tempInstallDir();
  if (fs.existsSync(tempDir))
    fs.rmSync(tempDir, { recursive: true, force: true });
}

async function installFromSkillhub(targetBase, slug, version, namespace, onProgress) {
  const tempDir = _tempInstallDir();
  const zipPath = path.join(tempDir, `${slug}-${version}.zip`);
  const extractDir = path.join(tempDir, slug);

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  if (!fs.existsSync(extractDir))
    fs.mkdirSync(extractDir, { recursive: true });

  await _downloadSkillhubZip({ slug, version, namespace }, zipPath, onProgress);
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0)
    throw new Error("下载文件不存在或为空");

  _extractZip(zipPath, extractDir);

  const { skillInfo, nameFromMd } = _pickShallowestSkill(extractDir);
  const skillName = nameFromMd || slug;
  const targetDir = path.join(targetBase, skillName);

  fs.rmSync(zipPath, { force: true });
  return {
    skillName,
    extractDir: skillInfo.skillDir,
    targetDir,
    exists: fs.existsSync(targetDir),
    source: "skillhub",
  };
}

async function installFromModelScope(targetBase, skillPath, onProgress) {
  const encodedPath = skillPath.replace(/@/g, "%40");
  const zipUrl = `https://www.modelscope.cn/skills/${encodedPath}/archive/zip/master.zip`;
  const tempDir = _tempInstallDir();
  const safeName = skillPath.replace(/[/@]/g, "-");
  const zipPath = path.join(tempDir, `${safeName}.zip`);
  const extractDir = path.join(tempDir, safeName);

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  await _downloadToFile(
    zipUrl,
    zipPath,
    onProgress,
    {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      accept: "*/*",
    },
  );

  if (!fs.existsSync(zipPath)) throw new Error("下载文件不存在");
  if (fs.statSync(zipPath).size < 1000)
    throw new Error("下载文件过小，可能下载失败");

  _extractZip(zipPath, extractDir);

  const { skillInfo, nameFromMd } = _pickShallowestSkill(extractDir);
  const skillName = nameFromMd || skillPath.split("/").pop();
  const targetDir = path.join(targetBase, skillName);

  fs.unlinkSync(zipPath);
  return {
    skillName,
    extractDir: skillInfo.skillDir,
    targetDir,
    exists: fs.existsSync(targetDir),
    source: "modelscope",
  };
}

function completeInstall(targetBase, skillName, extractDir) {
  const targetDir = path.join(targetBase, skillName);
  if (!fs.existsSync(targetBase))
    fs.mkdirSync(targetBase, { recursive: true });
  if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
  fs.renameSync(extractDir, targetDir);
  _cleanupTempDir();
  return true;
}

function cancelInstall() {
  _cleanupTempDir();
  return true;
}

// ==================== 信息查询 ====================

async function fetchSkillInfo(slug, namespace) {
  const data = await _skillhubGetJson(`/api/v1/skills/${slug}`, {
    namespace,
  });
  return { source: "skillhub", data };
}

// 获取 SkillHub skill 评测报告（TRACE 体系）；无评测时返回 null
async function fetchSkillEvaluation(slug, namespace) {
  try {
    return await _skillhubGetJson(
      `/api/v1/skills/${slug}/evaluation`,
      { namespace },
    );
  } catch (e) {
    return null;
  }
}

// 获取 SkillHub 分类列表（key → 中文名）
function fetchSkillHubCategories() {
  return _skillhubGetJson("/api/v1/categories");
}

function fetchModelScopeSkillInfo(skillPath) {
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    const url = `https://www.modelscope.cn/api/v1/skills/${skillPath}`;
    const options = {
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "x-modelscope-accept-language": "zh_CN",
      },
    };
    https
      .get(url, options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.Code !== 200 || !json.Data)
              reject(new Error(json.Message || "获取失败"));
            else resolve({ source: "modelscope", data: json.Data });
          } catch (e) {
            reject(new Error("解析响应失败"));
          }
        });
      })
      .on("error", reject);
  });
}

// ==================== 各目标目录的对外入口 ====================

// Claude → ~/.claude/skills
const installSkill = (slug, version, namespace, onProgress) =>
  installFromSkillhub(config.CLAUDE_SKILLS_PATH, slug, version, namespace, onProgress);
const installSkillFromModelScope = (skillPath, onProgress) =>
  installFromModelScope(config.CLAUDE_SKILLS_PATH, skillPath, onProgress);
const completeSkillInstall = (skillName, extractDir) =>
  completeInstall(config.CLAUDE_SKILLS_PATH, skillName, extractDir);
const cancelSkillInstall = () => cancelInstall();

// OpenCode → getOpencodeSkillsPath()（调用时取，保持原惰性求值）
const installOpencodeSkill = (slug, version, namespace, onProgress) =>
  installFromSkillhub(opencode.getOpencodeSkillsPath(), slug, version, namespace, onProgress);
const installOpencodeSkillFromModelScope = (skillPath, onProgress) =>
  installFromModelScope(opencode.getOpencodeSkillsPath(), skillPath, onProgress);
const completeOpencodeSkillInstall = (skillName, extractDir) =>
  completeInstall(opencode.getOpencodeSkillsPath(), skillName, extractDir);
const cancelOpencodeSkillInstall = () => cancelInstall();

// 通用 → ~/.agents/skills
const installCommonSkill = (slug, version, namespace, onProgress) =>
  installFromSkillhub(common.COMMON_SKILLS_DIR(), slug, version, namespace, onProgress);
const installCommonSkillFromModelScope = (skillPath, onProgress) =>
  installFromModelScope(common.COMMON_SKILLS_DIR(), skillPath, onProgress);
const completeCommonSkillInstall = (skillName, extractDir) =>
  completeInstall(common.COMMON_SKILLS_DIR(), skillName, extractDir);
const cancelCommonSkillInstall = () => cancelInstall();

module.exports = {
  fetchSkillInfo,
  fetchSkillEvaluation,
  fetchSkillHubCategories,
  fetchModelScopeSkillInfo,
  installSkill,
  installSkillFromModelScope,
  completeSkillInstall,
  cancelSkillInstall,
  installOpencodeSkill,
  installOpencodeSkillFromModelScope,
  completeOpencodeSkillInstall,
  cancelOpencodeSkillInstall,
  installCommonSkill,
  installCommonSkillFromModelScope,
  completeCommonSkillInstall,
  cancelCommonSkillInstall,
};
