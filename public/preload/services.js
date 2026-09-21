const fs = require("node:fs");
const path = require("node:path");

const crypto = require("./services/crypto");
const config = require("./services/config");
const mcp = require("./services/mcp");
const opencode = require("./services/opencode");
const plugins = require("./services/plugins");
const usage = require("./services/usage");
const pi = require("./services/pi");
const omp = require("./services/omp");
const reasonix = require("./services/reasonix");
const kimi = require("./services/kimi");
const minimax = require("./services/minimax");
const codex = require("./services/codex");
const common = require("./services/common");
const dispatch = require("./services/dispatch");
const commands = require("./services/commands");
const autoroute = require("./services/autoroute");

const {
  CLAUDE_SETTINGS_PATH,
  CLAUDE_JSON_PATH,
  CLAUDE_SKILLS_PATH,
  readClaudeSettings,
  writeClaudeSettings,
  getClaudeSettingsPath,
  readClaudeJson,
  writeClaudeJson,
  getClaudeJsonPath,
  getNativeId,
  getMcpServers,
  upsertMcpServer,
  deleteMcpServer,
  getClaudeMcpPath,
  openClaudeMcpFile,
  exportConfigsToFile,
  importConfigsFromFile,
  compressConfigs,
  decompressConfigs,
  saveOverriddenEnv,
  getOverriddenEnv,
  saveHeatmapHistory,
  getHeatmapHistory,
  saveUsageCache,
  getUsageCache,
} = config;

const {
  getDisabledMcpServers,
  disableMcpServer,
  enableMcpServer,
  deleteDisabledMcpServer,
  getAllMcpServersWithStatus,
  getMcpServerTools,
} = mcp;

const { encrypt, decrypt, encryptString, decryptString } = crypto;

const {
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
  getOpencodeSkills,
  getOpencodeSkillsPath,
  deleteOpencodeSkill,
} = opencode;

window.services = {
  getNativeId,
  getDisabledMcpServers,
  disableMcpServer,
  enableMcpServer,
  deleteDisabledMcpServer,
  getAllMcpServersWithStatus,
  readClaudeSettings,
  writeClaudeSettings,
  getClaudeSettingsPath,
  readClaudeJson,
  writeClaudeJson,
  getClaudeJsonPath,
  getMcpServers,
  upsertMcpServer,
  deleteMcpServer,
  getClaudeMcpPath,
  openClaudeMcpFile,
  getMcpServerTools,
  encryptKey: encrypt,
  decryptKey: decrypt,
  saveOverriddenEnv,
  getOverriddenEnv,
  saveHeatmapHistory,
  getHeatmapHistory,
  exportConfigsToFile,
  importConfigsFromFile,
  compressConfigs,
  decompressConfigs,
  encryptString,
  decryptString,

  // ==================== OpenCode ====================
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
  searchOpencodePlugins: opencode.searchOpencodePlugins,
  readOpencodeUsage: opencode.readOpencodeUsage,
  getOpencodeSkills,
  getOpencodeSkillsPath,
  deleteOpencodeSkill,

  // ==================== Plugins ====================

  listMarketplaces: plugins.listMarketplaces,
  addMarketplace: plugins.addMarketplace,
  removeMarketplace: plugins.removeMarketplace,
  updateMarketplace: plugins.updateMarketplace,
  listMarketplacePlugins: plugins.listMarketplacePlugins,
  listInstalledPlugins: plugins.listInstalledPlugins,
  installPlugin: plugins.installPlugin,
  uninstallPlugin: plugins.uninstallPlugin,
  enablePlugin: plugins.enablePlugin,
  disablePlugin: plugins.disablePlugin,
  updatePlugin: plugins.updatePlugin,
  getPluginsDir: plugins.getPluginsDir,
  openPluginsDir: plugins.openPluginsDir,
  getInstalledPluginComponents: plugins.getInstalledPluginComponents,
  validatePluginName: plugins.validatePluginName,
  validateScope: plugins.validateScope,

  // ==================== Skills ====================

  _skillsCache: null,
  _mcpUsageCache: null,

  getSkills() {
    try {
      const _disabledDirPath = path.join(CLAUDE_SKILLS_PATH, ".disabled");
      const dirMtime = fs.existsSync(CLAUDE_SKILLS_PATH)
        ? fs.statSync(CLAUDE_SKILLS_PATH).mtimeMs
        : 0;
      const disabledMtime = fs.existsSync(_disabledDirPath)
        ? fs.statSync(_disabledDirPath).mtimeMs
        : 0;
      const signature = `${dirMtime}:${disabledMtime}`;
      if (this._skillsCache && this._skillsCache.signature === signature) {
        return this._skillsCache.data;
      }

      if (!fs.existsSync(CLAUDE_SKILLS_PATH)) {
        this._skillsCache = { signature, data: [] };
        return [];
      }

      let skillUsage = {};
      try {
        if (fs.existsSync(CLAUDE_JSON_PATH)) {
          const claudeJson = JSON.parse(
            fs.readFileSync(CLAUDE_JSON_PATH, { encoding: "utf-8" }),
          );
          skillUsage = claudeJson.skillUsage || {};
        }
      } catch (e) {
        console.error("读取 skillUsage 失败:", e);
      }

      const disabledDir = path.join(CLAUDE_SKILLS_PATH, ".disabled");
      const skills = [];

      // 读取启用的 skills
      const entries = fs.readdirSync(CLAUDE_SKILLS_PATH, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === ".disabled") continue;
        const skillName = entry.name;
        const skillPath = path.join(CLAUDE_SKILLS_PATH, skillName);
        const skillMdPath = path.join(skillPath, "SKILL.md");
        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const content = fs
            .readFileSync(skillMdPath, { encoding: "utf-8" })
            .replace(/^\uFEFF/, "");
          const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
          const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
          const usage = skillUsage[skillName] || {};
          const skillFiles = fs.readdirSync(skillPath);
          skills.push({
            name: skillName,
            frontmatter,
            disabled: false,
            scope: "global",
            skillMdPath,
            fileCount: skillFiles.length,
            usageCount: usage.usageCount || 0,
            lastUsedAt: usage.lastUsedAt || null,
          });
        } catch (e) {
          console.error("读取 skill 文件失败:", skillMdPath, e);
        }
      }

      // 读取禁用的 skills
      if (fs.existsSync(disabledDir)) {
        const disabledEntries = fs.readdirSync(disabledDir, {
          withFileTypes: true,
        });
        for (const entry of disabledEntries) {
          if (!entry.isDirectory()) continue;
          const skillName = entry.name;
          const skillPath = path.join(disabledDir, skillName);
          const skillMdPath = path.join(skillPath, "SKILL.md");
          if (!fs.existsSync(skillMdPath)) continue;

          try {
            const content = fs
              .readFileSync(skillMdPath, { encoding: "utf-8" })
              .replace(/^\uFEFF/, "");
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
            const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
            const usage = skillUsage[skillName] || {};
            const skillFiles = fs.readdirSync(skillPath);
            skills.push({
              name: skillName,
              frontmatter,
              disabled: true,
              scope: "global",
              skillMdPath,
              fileCount: skillFiles.length,
              usageCount: usage.usageCount || 0,
              lastUsedAt: usage.lastUsedAt || null,
            });
          } catch (e) {
            console.error("读取 skill 文件失败:", skillMdPath, e);
          }
        }
      }

      // 读取项目级 skills（缓存 projectPathMap 避免每次 toggle 扫描 JSONL）
      try {
        const homeDir = window.utools.getPath("home");
        const projectsDir = path.join(homeDir, ".claude", "projects");
        if (fs.existsSync(projectsDir)) {
          if (!this._cachedProjectPathMap)
            this._cachedProjectPathMap = this._buildProjectPathMap(projectsDir);
          const projectPathMap = this._cachedProjectPathMap;
          for (const [, projectPath] of projectPathMap) {
            if (
              !projectPath ||
              projectPath === "unknown" ||
              !fs.existsSync(projectPath)
            )
              continue;
            if (path.resolve(projectPath) === path.resolve(homeDir)) continue;
            const projectSkillsDir = path.join(
              projectPath,
              ".claude",
              "skills",
            );
            if (!fs.existsSync(projectSkillsDir)) continue;

            const projectSkills = fs.readdirSync(projectSkillsDir, {
              withFileTypes: true,
            });
            for (const entry of projectSkills) {
              if (!entry.isDirectory() || entry.name === ".disabled") continue;
              const skillName = entry.name;
              const skillMdPath = path.join(
                projectSkillsDir,
                skillName,
                "SKILL.md",
              );
              if (!fs.existsSync(skillMdPath)) continue;

              try {
                const content = fs
                  .readFileSync(skillMdPath, {
                    encoding: "utf-8",
                  })
                  .replace(/^\uFEFF/, "");
                const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
                const usage = skillUsage[skillName] || {};
                const skillDir = path.join(projectSkillsDir, skillName);
                const skillFiles = fs.readdirSync(skillDir);
                skills.push({
                  name: skillName,
                  frontmatter,
                  disabled: false,
                  scope: "project",
                  projectName: path.basename(projectPath),
                  projectPath,
                  skillMdPath,
                  fileCount: skillFiles.length,
                  usageCount: usage.usageCount || 0,
                  lastUsedAt: usage.lastUsedAt || null,
                });
              } catch (e) {
                console.error("读取项目 skill 文件失败:", skillMdPath, e);
              }
            }

            // 读取项目级禁用的 skills
            const projectDisabledDir = path.join(projectSkillsDir, ".disabled");
            if (fs.existsSync(projectDisabledDir)) {
              const disabledEntries = fs.readdirSync(projectDisabledDir, {
                withFileTypes: true,
              });
              for (const entry of disabledEntries) {
                if (!entry.isDirectory()) continue;
                const skillName = entry.name;
                const skillMdPath = path.join(
                  projectDisabledDir,
                  skillName,
                  "SKILL.md",
                );
                if (!fs.existsSync(skillMdPath)) continue;

                try {
                  const content = fs
                    .readFileSync(skillMdPath, {
                      encoding: "utf-8",
                    })
                    .replace(/^\uFEFF/, "");
                  const frontmatterMatch = content.match(
                    /^---\n([\s\S]*?)\n---/,
                  );
                  const frontmatter = frontmatterMatch
                    ? frontmatterMatch[1]
                    : "";
                  const usage = skillUsage[skillName] || {};
                  const skillDir = path.join(projectDisabledDir, skillName);
                  const skillFiles = fs.readdirSync(skillDir);
                  skills.push({
                    name: skillName,
                    frontmatter,
                    disabled: true,
                    scope: "project",
                    projectName: path.basename(projectPath),
                    projectPath,
                    skillMdPath,
                    fileCount: skillFiles.length,
                    usageCount: usage.usageCount || 0,
                    lastUsedAt: usage.lastUsedAt || null,
                  });
                } catch (e) {
                  console.error(
                    "读取项目 disabled skill 文件失败:",
                    skillMdPath,
                    e,
                  );
                }
              }
            }
          }
        }
      } catch (e) {
        console.error("读取项目 skills 失败:", e);
      }

      const sorted = skills.sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === "global" ? -1 : 1;
        if (
          a.scope === "project" &&
          b.scope === "project" &&
          a.projectPath !== b.projectPath
        ) {
          return a.projectPath.localeCompare(b.projectPath);
        }
        return a.name.localeCompare(b.name);
      });
      this._skillsCache = { signature, data: sorted };
      return sorted;
    } catch (error) {
      console.error("读取 skills 目录失败:", error);
      return [];
    }
  },

  disableSkill(skillName) {
    try {
      const skillPath = path.join(CLAUDE_SKILLS_PATH, skillName);
      const disabledDir = path.join(CLAUDE_SKILLS_PATH, ".disabled");
      const targetPath = path.join(disabledDir, skillName);
      if (!fs.existsSync(skillPath))
        return { success: false, error: "Skill 不存在" };
      if (!fs.existsSync(disabledDir))
        fs.mkdirSync(disabledDir, { recursive: true });
      fs.renameSync(skillPath, targetPath);
      this._skillsCache = null;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  enableSkill(skillName) {
    try {
      const disabledDir = path.join(CLAUDE_SKILLS_PATH, ".disabled");
      const skillPath = path.join(disabledDir, skillName);
      const targetPath = path.join(CLAUDE_SKILLS_PATH, skillName);
      if (!fs.existsSync(skillPath))
        return { success: false, error: "Skill 不存在" };
      fs.renameSync(skillPath, targetPath);
      this._skillsCache = null;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  deleteSkill(skillName, isDisabled) {
    try {
      const skillPath = isDisabled
        ? path.join(CLAUDE_SKILLS_PATH, ".disabled", skillName)
        : path.join(CLAUDE_SKILLS_PATH, skillName);
      if (!fs.existsSync(skillPath))
        return { success: false, error: "Skill 不存在" };
      fs.rmSync(skillPath, { recursive: true, force: true });
      this._skillsCache = null;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  disableProjectSkill(skillName, projectPath) {
    try {
      const skillPath = path.join(projectPath, ".claude", "skills", skillName);
      const disabledDir = path.join(
        projectPath,
        ".claude",
        "skills",
        ".disabled",
      );
      const targetPath = path.join(disabledDir, skillName);
      if (!fs.existsSync(skillPath))
        return { success: false, error: "Skill 不存在" };
      if (!fs.existsSync(disabledDir))
        fs.mkdirSync(disabledDir, { recursive: true });
      fs.renameSync(skillPath, targetPath);
      this._skillsCache = null;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  enableProjectSkill(skillName, projectPath) {
    try {
      const disabledDir = path.join(
        projectPath,
        ".claude",
        "skills",
        ".disabled",
      );
      const skillPath = path.join(disabledDir, skillName);
      const targetPath = path.join(projectPath, ".claude", "skills", skillName);
      if (!fs.existsSync(skillPath))
        return { success: false, error: "Skill 不存在" };
      fs.renameSync(skillPath, targetPath);
      this._skillsCache = null;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  deleteProjectSkill(skillName, projectPath, isDisabled) {
    try {
      const skillPath = isDisabled
        ? path.join(projectPath, ".claude", "skills", ".disabled", skillName)
        : path.join(projectPath, ".claude", "skills", skillName);
      if (!fs.existsSync(skillPath))
        return { success: false, error: "Skill 不存在" };
      fs.rmSync(skillPath, { recursive: true, force: true });
      this._skillsCache = null;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  moveProjectSkillToGlobal(skillName, projectPath) {
    try {
      const srcPath = path.join(projectPath, ".claude", "skills", skillName);
      const destPath = path.join(CLAUDE_SKILLS_PATH, skillName);
      if (!fs.existsSync(srcPath))
        return { success: false, error: "源 Skill 不存在" };
      if (fs.existsSync(destPath))
        return { success: false, error: "用户目录下已存在同名 Skill" };
      if (!fs.existsSync(CLAUDE_SKILLS_PATH))
        fs.mkdirSync(CLAUDE_SKILLS_PATH, { recursive: true });
      fs.renameSync(srcPath, destPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  getSkillMdPath(skillName, scope, projectPath, isDisabled) {
    try {
      let skillDir;
      if (scope === "project") {
        skillDir = isDisabled
          ? path.join(projectPath, ".claude", "skills", ".disabled", skillName)
          : path.join(projectPath, ".claude", "skills", skillName);
      } else {
        skillDir = isDisabled
          ? path.join(CLAUDE_SKILLS_PATH, ".disabled", skillName)
          : path.join(CLAUDE_SKILLS_PATH, skillName);
      }
      const mdPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(mdPath))
        return { success: false, error: "SKILL.md 不存在" };
      return { success: true, path: mdPath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  getSkillDirPath(skillName, scope, projectPath, isDisabled) {
    try {
      let skillDir;
      if (scope === "project") {
        skillDir = isDisabled
          ? path.join(projectPath, ".claude", "skills", ".disabled", skillName)
          : path.join(projectPath, ".claude", "skills", skillName);
      } else {
        skillDir = isDisabled
          ? path.join(CLAUDE_SKILLS_PATH, ".disabled", skillName)
          : path.join(CLAUDE_SKILLS_PATH, skillName);
      }
      if (!fs.existsSync(skillDir))
        return { success: false, error: "Skill 文件夹不存在" };
      return { success: true, path: skillDir };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },

  getSkillsPath() {
    if (!fs.existsSync(CLAUDE_SKILLS_PATH))
      fs.mkdirSync(CLAUDE_SKILLS_PATH, { recursive: true });
    return CLAUDE_SKILLS_PATH;
  },

  openProjectSkillsDir(projectPath) {
    const skillsDir = path.join(projectPath, ".claude", "skills");
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
    window.utools.shellOpenPath(skillsDir);
  },

  async fetchSkillInfo(slug, namespace) {
    const data = await _skillhubGetJson(`/api/v1/skills/${slug}`, {
      namespace,
    });
    return { source: "skillhub", data };
  },

  // 获取 SkillHub skill 评测报告（TRACE 体系）；无评测时返回 null
  async fetchSkillEvaluation(slug, namespace) {
    try {
      return await _skillhubGetJson(
        `/api/v1/skills/${slug}/evaluation`,
        { namespace },
      );
    } catch (e) {
      return null;
    }
  },

  // 获取 SkillHub 分类列表（key → 中文名）
  fetchSkillHubCategories() {
    return _skillhubGetJson("/api/v1/categories");
  },

  fetchModelScopeSkillInfo(skillPath) {
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
  },

  async installSkill(slug, version, namespace, onProgress) {
    const { execSync } = require("node:child_process");

    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    const zipPath = path.join(tempDir, `${slug}-${version}.zip`);
    const extractDir = path.join(tempDir, slug);

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    if (!fs.existsSync(extractDir))
      fs.mkdirSync(extractDir, { recursive: true });

    await _downloadSkillhubZip({ slug, version, namespace }, zipPath, onProgress);
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0)
      throw new Error("下载文件不存在或为空");

    if (window.utools.isMacOS() || window.utools.isLinux()) {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    } else if (window.utools.isWindows()) {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: "pipe" },
      );
    }

    const allSkillMds = _findSkillMd(extractDir);
    if (allSkillMds.length === 0)
      throw new Error("压缩包中未找到 SKILL.md 文件");

    allSkillMds.sort((a, b) => a.depth - b.depth);
    const skillInfo = allSkillMds[0];
    const skillMdContent = fs.readFileSync(skillInfo.skillMdPath, {
      encoding: "utf-8",
    });
    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m);
    const skillName = nameMatch ? nameMatch[1].trim() : slug;
    const targetDir = path.join(CLAUDE_SKILLS_PATH, skillName);

    fs.rmSync(zipPath, { force: true });
    return {
      skillName,
      extractDir: skillInfo.skillDir,
      targetDir,
      exists: fs.existsSync(targetDir),
      source: "skillhub",
    };
  },

  async installSkillFromModelScope(skillPath, onProgress) {
    const https = require("node:https");
    const { execSync } = require("node:child_process");

    const encodedPath = skillPath.replace(/@/g, "%40");
    const zipUrl = `https://www.modelscope.cn/skills/${encodedPath}/archive/zip/master.zip`;
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    const safeName = skillPath.replace(/[/@]/g, "-");
    const zipPath = path.join(tempDir, `${safeName}.zip`);
    const extractDir = path.join(tempDir, safeName);

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    await new Promise((resolve, reject) => {
      const doDownload = (url, redirectCount = 0) => {
        if (redirectCount > 10) return reject(new Error("重定向次数过多"));
        https
          .get(
            url,
            {
              headers: {
                "user-agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                accept: "*/*",
              },
            },
            (res) => {
              if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                if (!res.headers.location)
                  return reject(new Error("重定向缺少 location"));
                res.resume();
                doDownload(res.headers.location, redirectCount + 1);
                return;
              }
              if (res.statusCode !== 200)
                return reject(new Error(`下载失败: HTTP ${res.statusCode}`));

              const totalSize =
                parseInt(res.headers["content-length"], 10) || 0;
              let downloaded = 0;
              const file = fs.createWriteStream(zipPath);
              res.on("data", (chunk) => {
                downloaded += chunk.length;
                if (onProgress && totalSize > 0)
                  onProgress(Math.round((downloaded / totalSize) * 100));
              });
              res.pipe(file);
              file.on("finish", () => file.close(resolve));
              file.on("error", (err) => {
                fs.unlinkSync(zipPath);
                reject(err);
              });
            },
          )
          .on("error", reject);
      };
      doDownload(zipUrl);
    });

    if (!fs.existsSync(zipPath)) throw new Error("下载文件不存在");
    if (fs.statSync(zipPath).size < 1000)
      throw new Error("下载文件过小，可能下载失败");

    if (window.utools.isMacOS() || window.utools.isLinux()) {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    } else if (window.utools.isWindows()) {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: "pipe" },
      );
    }

    const allSkillMds = _findSkillMd(extractDir);
    if (allSkillMds.length === 0)
      throw new Error("压缩包中未找到 SKILL.md 文件");

    allSkillMds.sort((a, b) => a.depth - b.depth);
    const skillInfo = allSkillMds[0];
    const skillMdContent = fs.readFileSync(skillInfo.skillMdPath, {
      encoding: "utf-8",
    });
    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m);
    const skillName = nameMatch
      ? nameMatch[1].trim()
      : skillPath.split("/").pop();
    const targetDir = path.join(CLAUDE_SKILLS_PATH, skillName);

    fs.unlinkSync(zipPath);
    return {
      skillName,
      extractDir: skillInfo.skillDir,
      targetDir,
      exists: fs.existsSync(targetDir),
      source: "modelscope",
    };
  },

  completeSkillInstall(skillName, extractDir) {
    const targetDir = path.join(CLAUDE_SKILLS_PATH, skillName);
    if (!fs.existsSync(CLAUDE_SKILLS_PATH))
      fs.mkdirSync(CLAUDE_SKILLS_PATH, { recursive: true });
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
    fs.renameSync(extractDir, targetDir);
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
    return true;
  },

  cancelSkillInstall() {
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
    return true;
  },

  // ==================== OpenCode Skills Install ====================

  async installOpencodeSkill(slug, version, namespace, onProgress) {
    const { execSync } = require("node:child_process");
    const targetBase = opencode.getOpencodeSkillsPath();

    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    const zipPath = path.join(tempDir, `${slug}-${version}.zip`);
    const extractDir = path.join(tempDir, slug);

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    if (!fs.existsSync(extractDir))
      fs.mkdirSync(extractDir, { recursive: true });

    await _downloadSkillhubZip({ slug, version, namespace }, zipPath, onProgress);
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0)
      throw new Error("下载文件不存在或为空");

    if (window.utools.isMacOS() || window.utools.isLinux()) {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    } else if (window.utools.isWindows()) {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: "pipe" },
      );
    }

    const allSkillMds = _findSkillMd(extractDir);
    if (allSkillMds.length === 0)
      throw new Error("压缩包中未找到 SKILL.md 文件");

    allSkillMds.sort((a, b) => a.depth - b.depth);
    const skillInfo = allSkillMds[0];
    const skillMdContent = fs.readFileSync(skillInfo.skillMdPath, {
      encoding: "utf-8",
    });
    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m);
    const skillName = nameMatch ? nameMatch[1].trim() : slug;
    const targetDir = path.join(targetBase, skillName);

    fs.rmSync(zipPath, { force: true });
    return {
      skillName,
      extractDir: skillInfo.skillDir,
      targetDir,
      exists: fs.existsSync(targetDir),
      source: "skillhub",
    };
  },

  async installOpencodeSkillFromModelScope(skillPath, onProgress) {
    const https = require("node:https");
    const { execSync } = require("node:child_process");
    const targetBase = opencode.getOpencodeSkillsPath();

    const encodedPath = skillPath.replace(/@/g, "%40");
    const zipUrl = `https://www.modelscope.cn/skills/${encodedPath}/archive/zip/master.zip`;
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    const safeName = skillPath.replace(/[/@]/g, "-");
    const zipPath = path.join(tempDir, `${safeName}.zip`);
    const extractDir = path.join(tempDir, safeName);

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    await new Promise((resolve, reject) => {
      const doDownload = (url, redirectCount = 0) => {
        if (redirectCount > 10) return reject(new Error("重定向次数过多"));
        https
          .get(
            url,
            {
              headers: {
                "user-agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                accept: "*/*",
              },
            },
            (res) => {
              if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                if (!res.headers.location)
                  return reject(new Error("重定向缺少 location"));
                res.resume();
                doDownload(res.headers.location, redirectCount + 1);
                return;
              }
              if (res.statusCode !== 200)
                return reject(new Error(`下载失败: HTTP ${res.statusCode}`));

              const totalSize =
                parseInt(res.headers["content-length"], 10) || 0;
              let downloaded = 0;
              const file = fs.createWriteStream(zipPath);
              res.on("data", (chunk) => {
                downloaded += chunk.length;
                if (onProgress && totalSize > 0)
                  onProgress(Math.round((downloaded / totalSize) * 100));
              });
              res.pipe(file);
              file.on("finish", () => file.close(resolve));
              file.on("error", (err) => {
                fs.unlinkSync(zipPath);
                reject(err);
              });
            },
          )
          .on("error", reject);
      };
      doDownload(zipUrl);
    });

    if (!fs.existsSync(zipPath)) throw new Error("下载文件不存在");
    if (fs.statSync(zipPath).size < 1000)
      throw new Error("下载文件过小，可能下载失败");

    if (window.utools.isMacOS() || window.utools.isLinux()) {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    } else if (window.utools.isWindows()) {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: "pipe" },
      );
    }

    const allSkillMds = _findSkillMd(extractDir);
    if (allSkillMds.length === 0)
      throw new Error("压缩包中未找到 SKILL.md 文件");

    allSkillMds.sort((a, b) => a.depth - b.depth);
    const skillInfo = allSkillMds[0];
    const skillMdContent = fs.readFileSync(skillInfo.skillMdPath, {
      encoding: "utf-8",
    });
    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m);
    const skillName = nameMatch
      ? nameMatch[1].trim()
      : skillPath.split("/").pop();
    const targetDir = path.join(targetBase, skillName);

    fs.unlinkSync(zipPath);
    return {
      skillName,
      extractDir: skillInfo.skillDir,
      targetDir,
      exists: fs.existsSync(targetDir),
      source: "modelscope",
    };
  },

  completeOpencodeSkillInstall(skillName, extractDir) {
    const targetBase = opencode.getOpencodeSkillsPath();
    const targetDir = path.join(targetBase, skillName);
    if (!fs.existsSync(targetBase))
      fs.mkdirSync(targetBase, { recursive: true });
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
    fs.renameSync(extractDir, targetDir);
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
    return true;
  },

  cancelOpencodeSkillInstall() {
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
    return true;
  },

  // ==================== Common Skills Install（~/.agents/skills） ====================

  async installCommonSkill(slug, version, namespace, onProgress) {
    const { execSync } = require("node:child_process");
    const targetBase = common.COMMON_SKILLS_DIR();

    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    const zipPath = path.join(tempDir, `${slug}-${version}.zip`);
    const extractDir = path.join(tempDir, slug);

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    if (!fs.existsSync(extractDir))
      fs.mkdirSync(extractDir, { recursive: true });

    await _downloadSkillhubZip({ slug, version, namespace }, zipPath, onProgress);
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0)
      throw new Error("下载文件不存在或为空");

    if (window.utools.isMacOS() || window.utools.isLinux()) {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    } else if (window.utools.isWindows()) {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: "pipe" },
      );
    }

    const allSkillMds = _findSkillMd(extractDir);
    if (allSkillMds.length === 0)
      throw new Error("压缩包中未找到 SKILL.md 文件");

    allSkillMds.sort((a, b) => a.depth - b.depth);
    const skillInfo = allSkillMds[0];
    const skillMdContent = fs.readFileSync(skillInfo.skillMdPath, {
      encoding: "utf-8",
    });
    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m);
    const skillName = nameMatch ? nameMatch[1].trim() : slug;
    const targetDir = path.join(targetBase, skillName);

    fs.rmSync(zipPath, { force: true });
    return {
      skillName,
      extractDir: skillInfo.skillDir,
      targetDir,
      exists: fs.existsSync(targetDir),
      source: "skillhub",
    };
  },

  async installCommonSkillFromModelScope(skillPath, onProgress) {
    const https = require("node:https");
    const { execSync } = require("node:child_process");
    const targetBase = common.COMMON_SKILLS_DIR();

    const encodedPath = skillPath.replace(/@/g, "%40");
    const zipUrl = `https://www.modelscope.cn/skills/${encodedPath}/archive/zip/master.zip`;
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    const safeName = skillPath.replace(/[/@]/g, "-");
    const zipPath = path.join(tempDir, `${safeName}.zip`);
    const extractDir = path.join(tempDir, safeName);

    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    await new Promise((resolve, reject) => {
      const doDownload = (url, redirectCount = 0) => {
        if (redirectCount > 10) return reject(new Error("重定向次数过多"));
        https
          .get(
            url,
            {
              headers: {
                "user-agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                accept: "*/*",
              },
            },
            (res) => {
              if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                if (!res.headers.location)
                  return reject(new Error("重定向缺少 location"));
                res.resume();
                doDownload(res.headers.location, redirectCount + 1);
                return;
              }
              if (res.statusCode !== 200)
                return reject(new Error(`下载失败: HTTP ${res.statusCode}`));

              const totalSize =
                parseInt(res.headers["content-length"], 10) || 0;
              let downloaded = 0;
              const file = fs.createWriteStream(zipPath);
              res.on("data", (chunk) => {
                downloaded += chunk.length;
                if (onProgress && totalSize > 0)
                  onProgress(Math.round((downloaded / totalSize) * 100));
              });
              res.pipe(file);
              file.on("finish", () => file.close(resolve));
              file.on("error", (err) => {
                fs.unlinkSync(zipPath);
                reject(err);
              });
            },
          )
          .on("error", reject);
      };
      doDownload(zipUrl);
    });

    if (!fs.existsSync(zipPath)) throw new Error("下载文件不存在");
    if (fs.statSync(zipPath).size < 1000)
      throw new Error("下载文件过小，可能下载失败");

    if (window.utools.isMacOS() || window.utools.isLinux()) {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    } else if (window.utools.isWindows()) {
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
        { stdio: "pipe" },
      );
    }

    const allSkillMds = _findSkillMd(extractDir);
    if (allSkillMds.length === 0)
      throw new Error("压缩包中未找到 SKILL.md 文件");

    allSkillMds.sort((a, b) => a.depth - b.depth);
    const skillInfo = allSkillMds[0];
    const skillMdContent = fs.readFileSync(skillInfo.skillMdPath, {
      encoding: "utf-8",
    });
    const nameMatch = skillMdContent.match(/^name:\s*(.+)$/m);
    const skillName = nameMatch
      ? nameMatch[1].trim()
      : skillPath.split("/").pop();
    const targetDir = path.join(targetBase, skillName);

    fs.unlinkSync(zipPath);
    return {
      skillName,
      extractDir: skillInfo.skillDir,
      targetDir,
      exists: fs.existsSync(targetDir),
      source: "modelscope",
    };
  },

  completeCommonSkillInstall(skillName, extractDir) {
    const targetBase = common.COMMON_SKILLS_DIR();
    const targetDir = path.join(targetBase, skillName);
    if (!fs.existsSync(targetBase))
      fs.mkdirSync(targetBase, { recursive: true });
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true });
    fs.renameSync(extractDir, targetDir);
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
    return true;
  },

  cancelCommonSkillInstall() {
    const tempDir = path.join(
      window.utools.getPath("temp"),
      "ccswitch-skill-install",
    );
    if (fs.existsSync(tempDir))
      fs.rmSync(tempDir, { recursive: true, force: true });
    return true;
  },

  // ==================== Usage ====================

  _emptyResult() {
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
  },

  _findAllJsonlFiles(projectsDir) {
    const results = [];
    try {
      if (!fs.existsSync(projectsDir)) return results;
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(projectsDir, entry.name);
        if (entry.isDirectory())
          results.push(...this._findAllJsonlFiles(fullPath));
        else if (entry.isFile() && entry.name.endsWith(".jsonl"))
          results.push(fullPath);
      }
    } catch (error) {
      console.error("查找 jsonl 文件失败:", error);
    }
    return results;
  },

  _calcUsageSignature(projectsDir) {
    try {
      if (!fs.existsSync(projectsDir)) return "0:0";
      const files = this._findAllJsonlFiles(projectsDir);
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
  },

  _processSingleJsonlFile(
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
  },

  _buildProjectPathMap(projectsDir) {
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
  },

  _calculateStats(messageRecords, sessionMap) {
    const allRecords = Array.from(sessionMap.values()).map((session) => ({
      ...session,
      totalTokens:
        session.inputTokens +
        session.outputTokens +
        session.cacheReadTokens +
        session.cacheCreationTokens,
    }));
    allRecords.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const summary = messageRecords.reduce(
      (acc, record) => {
        acc.inputTokens += record.inputTokens;
        acc.outputTokens += record.outputTokens;
        acc.cacheReadTokens += record.cacheReadTokens;
        acc.cacheCreationTokens += record.cacheCreationTokens;
        acc.totalTokens += record.totalTokens;
        return acc;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 0,
        messageCount: messageRecords.length,
        sessionCount: sessionMap.size,
      },
    );

    const modelMap = new Map();
    messageRecords.forEach((record) => {
      if (!modelMap.has(record.model))
        modelMap.set(record.model, {
          name: record.model,
          sessions: new Set(),
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        });
      const stat = modelMap.get(record.model);
      stat.sessions.add(record.sessionId);
      stat.tokens += record.totalTokens;
      stat.inputTokens +=
        record.inputTokens +
        record.cacheCreationTokens +
        record.cacheReadTokens;
      stat.outputTokens += record.outputTokens;
    });
    const modelStats = Array.from(modelMap.values())
      .map((s) => ({ ...s, sessions: s.sessions.size }))
      .sort((a, b) => b.tokens - a.tokens);

    const projectMap = new Map();
    messageRecords.forEach((record) => {
      const projectPathKey = record.projectPath || "unknown";
      const projectDisplayName =
        projectPathKey === "unknown"
          ? "unknown"
          : path.basename(projectPathKey);
      if (!projectMap.has(projectPathKey)) {
        const exists =
          projectPathKey === "unknown" ? false : fs.existsSync(projectPathKey);
        projectMap.set(projectPathKey, {
          name: projectDisplayName,
          path: projectPathKey,
          exists,
          sessions: new Set(),
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      const stat = projectMap.get(projectPathKey);
      stat.sessions.add(record.sessionId);
      stat.tokens += record.totalTokens;
      stat.inputTokens +=
        record.inputTokens +
        record.cacheCreationTokens +
        record.cacheReadTokens;
      stat.outputTokens += record.outputTokens;
    });
    const projectStats = Array.from(projectMap.values())
      .map((s) => ({ ...s, sessions: s.sessions.size }))
      .sort((a, b) => b.tokens - a.tokens);

    const contributionMap = new Map();
    messageRecords.forEach((record) => {
      const dateKey = record.timestamp.split("T")[0];
      if (!contributionMap.has(dateKey))
        contributionMap.set(dateKey, {
          date: dateKey,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          models: {},
        });
      const day = contributionMap.get(dateKey);
      day.tokens += record.totalTokens;
      day.inputTokens +=
        record.inputTokens +
        record.cacheCreationTokens +
        record.cacheReadTokens;
      day.outputTokens += record.outputTokens;
      if (!day.models[record.model])
        day.models[record.model] = { inputTokens: 0, outputTokens: 0 };
      day.models[record.model].inputTokens +=
        record.inputTokens +
        record.cacheCreationTokens +
        record.cacheReadTokens;
      day.models[record.model].outputTokens += record.outputTokens;
    });
    const contributions = Array.from(contributionMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    const avgTokensPerSession =
      sessionMap.size > 0
        ? Math.round(summary.totalTokens / sessionMap.size)
        : 0;
    const recentSessions = Array.from(sessionMap.values())
      .map((s) => ({
        ...s,
        totalTokens:
          s.inputTokens +
          s.outputTokens +
          s.cacheReadTokens +
          s.cacheCreationTokens,
      }))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 10);

    return {
      records: allRecords,
      summary,
      modelStats,
      projectStats,
      contributions,
      avgTokensPerSession,
      recentSessions,
    };
  },

  _processAllUsageData(projectsDir) {
    const projectPathMap = this._buildProjectPathMap(projectsDir);
    const sessionMap = new Map();
    const projectMap = new Map();
    const messageRecords = [];
    const jsonlFiles = this._findAllJsonlFiles(projectsDir);
    for (const filePath of jsonlFiles) {
      this._processSingleJsonlFile(
        filePath,
        messageRecords,
        sessionMap,
        projectMap,
        projectPathMap,
      );
    }
    return { messageRecords, sessionMap, projectMap };
  },

  _fillEmptyContributions(contributions) {
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
  },

  readClaudeUsage(forceRefresh = false) {
    try {
      const homeDir = window.utools.getPath("home");
      const projectsDir = path.join(homeDir, ".claude", "projects");
      if (!fs.existsSync(projectsDir)) return this._emptyResult();

      const signature = this._calcUsageSignature(projectsDir);
      const cached = getUsageCache();

      if (!forceRefresh && cached && cached.signature === signature) {
        console.log("[Claude Usage] 缓存命中，跳过 JSONL 解析");
        return cached.stats;
      }

      console.log(
        `[Claude Usage] 缓存未命中 (${cached?.signature ?? "null"} → ${signature})，开始全量处理...`,
      );
      const processedData = this._processAllUsageData(projectsDir);
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

      const contributions = this._fillEmptyContributions(merged);
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
      return this._emptyResult();
    }
  },

  // 从持久化热力图数据读取统计（不扫描 JSONL，快速加载）
  readPersistedUsage() {
    try {
      const history = getHeatmapHistory();
      const entries = Object.entries(history);

      if (entries.length === 0) {
        return {
          summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
          modelStats: [],
          contributions: this._fillEmptyContributions([]),
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
        contributions: this._fillEmptyContributions([]),
        recentSessions: [],
      };
    }
  },

  getMcpUsage() {
    try {
      const homeDir = window.utools.getPath("home");
      const projectsDir = path.join(homeDir, ".claude", "projects");
      if (!fs.existsSync(projectsDir)) return {};

      const jsonlFiles = this._findAllJsonlFiles(projectsDir);
      let maxMtime = 0;
      for (const f of jsonlFiles) {
        try {
          const m = fs.statSync(f).mtimeMs;
          if (m > maxMtime) maxMtime = m;
        } catch {}
      }
      const signature = `${jsonlFiles.length}:${maxMtime}`;
      if (this._mcpUsageCache && this._mcpUsageCache.signature === signature) {
        return this._mcpUsageCache.data;
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
      this._mcpUsageCache = { signature, data: mcpUsage };
      return mcpUsage;
    } catch (e) {
      console.error("读取 MCP usage 失败:", e);
      return {};
    }
  },

  copyClaudeCommand(projectPath) {
    if (!projectPath || projectPath === "unknown")
      return { success: false, error: "无效的项目路径" };
    try {
      window.utools.copyText(`cd "${projectPath}" && claude`);
      return { success: true };
    } catch (error) {
      console.error("复制命令失败:", error);
      return { success: false, error: error.message };
    }
  },

  // ==================== Pi Agent ====================

  readPiSettings: pi.readPiSettings,
  writePiSettings: pi.writePiSettings,
  readPiModels: pi.readPiModels,
  writePiModels: pi.writePiModels,
  getPiProviderList: pi.getPiProviderList,
  setPiDefaultProvider: pi.setPiDefaultProvider,
  setPiDefaultModel: pi.setPiDefaultModel,
  updatePiProvider: pi.updatePiProvider,
  updatePiModel: pi.updatePiModel,
  addPiProvider: pi.addPiProvider,
  deletePiProvider: pi.deletePiProvider,
  addPiModel: pi.addPiModel,
  deletePiModel: pi.deletePiModel,
  getPiExtensions: pi.getPiExtensions,
  setPiExtensionEnabled: pi.setPiExtensionEnabled,
  getPiExtensionDetail: pi.getPiExtensionDetail,
  setPiPackageResourceEnabled: pi.setPiPackageResourceEnabled,
  installPiExtension: pi.installPiExtension,
  uninstallPiExtension: pi.uninstallPiExtension,
  updatePiExtensions: pi.updatePiExtensions,
  fetchPiDevPackages: pi.fetchPiDevPackages,
  fetchPiDevPackage: pi.fetchPiDevPackage,
  isPiInstalled: pi.isPiInstalled,
  getPiSkills: pi.getPiSkills,
  getPiMcpServers: pi.getPiMcpServers,
  getPiMcpTools: pi.getPiMcpTools,
  fetchProviderModels: pi.fetchProviderModels,
  readPiUsage: pi.readPiUsage,
  // 「通用」统计页：打开时先采集各 agent 最新数据落库，再纯读 DB 合并展示
  collectCommonUsage() {
    const collected = {}
    try {
      const s = this.readClaudeUsage(true)
      collected.claude = (s?.contributions || []).some(d => (d.tokens || 0) > 0)
    } catch (e) { console.warn('[common usage] Claude 采集失败:', e); collected.claude = false }
    try {
      const s = opencode.readOpencodeUsage()
      collected.opencode = (s?.contributions || []).some(d => (d.tokens || 0) > 0)
    } catch (e) { console.warn('[common usage] OpenCode 采集失败:', e); collected.opencode = false }
    try {
      const s = pi.readPiUsage()
      collected.pi = (s?.contributions || []).some(d => (d.tokens || 0) > 0)
    } catch (e) { console.warn('[common usage] Pi 采集失败:', e); collected.pi = false }
    return collected
  },
  readCommonUsage: usage.readAllAgentUsage,
  openPiDir: pi.openPiDir,
  openPiExtDir: pi.openPiExtDir,
  resolvePiPath: pi.resolvePiPath,

  // ==================== omp ====================

  readOmpModelRoles: omp.readOmpModelRoles,
  writeOmpModelRoles: omp.writeOmpModelRoles,
  parseOmpModelRef: omp.parseOmpModelRef,
  getOmpModelRoleRefs: omp.getOmpModelRoleRefs,
  readOmpModels: omp.readOmpModels,
  writeOmpModels: omp.writeOmpModels,
  getOmpProviderList: omp.getOmpProviderList,
  addOmpProvider: omp.addOmpProvider,
  updateOmpProvider: omp.updateOmpProvider,
  deleteOmpProvider: omp.deleteOmpProvider,
  addOmpModel: omp.addOmpModel,
  updateOmpModel: omp.updateOmpModel,
  deleteOmpModel: omp.deleteOmpModel,
  openOmpDir: omp.openOmpDir,
  isOmpInstalled: omp.isOmpInstalled,

  // ==================== Codex（Desktop / CLI 模型配置） ====================

  getCodexDir: codex.getCodexDir,
  getCodexConfigPath: codex.getCodexConfigPath,
  getCodexModelsJsonPath: codex.getCodexModelsJsonPath,
  getCodexProviderList: codex.getCodexProviderList,
  addCodexProvider: codex.addCodexProvider,
  updateCodexProvider: codex.updateCodexProvider,
  deleteCodexProvider: codex.deleteCodexProvider,
  getCodexCurrent: codex.getCodexCurrent,
  setCodexDefaultModel: codex.setCodexDefaultModel,
  setCodexReasoningEffort: codex.setCodexReasoningEffort,
  setCodexApiAuth: codex.setCodexApiAuth,
  getCodexProviderModelsMap: codex.getCodexProviderModelsMap,
  addCodexModel: codex.addCodexModel,
  deleteCodexModel: codex.deleteCodexModel,
  syncCodexModelCatalog: codex.syncCodexModelCatalog,
  openCodexDir: codex.openCodexDir,
  isCodexInstalled: codex.isCodexInstalled,

  // ==================== 通用配置（主数据库） ====================

  readCommonProviders: common.readCommonProviders,
  writeCommonProviders: common.writeCommonProviders,
  getCommonProviderList: common.getCommonProviderList,
  addCommonProvider: common.addCommonProvider,
  updateCommonProvider: common.updateCommonProvider,
  deleteCommonProvider: common.deleteCommonProvider,
  addCommonModel: common.addCommonModel,
  addCommonModels: common.addCommonModels,
  updateCommonModel: common.updateCommonModel,
  deleteCommonModel: common.deleteCommonModel,
  // 通用 MCP：云端主档 + 本机启用开关（开启写入本地镜像文件，关闭从本地移除）
  listCommonMcpServers: common.listCommonMcpServers,
  upsertCommonMcpServer: common.upsertCommonMcpServer,
  deleteCommonMcpServer: common.deleteCommonMcpServer,
  setCommonMcpEnabled: common.setCommonMcpEnabled,
  // 本地镜像存放位置（预置多选 + 自定义，按机器隔离）
  getLocalMcpTargetPaths: common.getLocalMcpTargetPaths,
  getLocalMcpTargetsInfo: common.getLocalMcpTargetsInfo,
  saveLocalMcpTargets: common.saveLocalMcpTargets,
  syncLocalMcpTargets: common.syncLocalMcpTargets,
  selectLocalMcpTargetFile: common.selectLocalMcpTargetFile,
  resolveMcpPath: common.resolveMcpPath,
  toDisplayMcpPath: common.toDisplayMcpPath,
  readCommonSkills: common.readCommonSkills,
  openCommonSkillsDir: common.openCommonSkillsDir,
  getCommonSkillsPath: common.getCommonSkillsPath,
  setCommonSkillEnabled: common.setCommonSkillEnabled,
  deleteCommonSkill: common.deleteCommonSkill,
  // 通用库 provider + model → 各 Agent 模型配置下发
  dispatchCommonModel: dispatch.dispatchCommonModel,
  // 自动网关：本地模型代理（配置 / 启停 / 状态 / 下发）
  readAutoRouteConfig: autoroute.readAutoRouteConfig,
  writeAutoRouteConfig: autoroute.writeAutoRouteConfig,
  regenerateAutoRouteKey: autoroute.regenerateAutoRouteKey,
  resolveAutoRouteModels: autoroute.resolveAutoRouteModels,
  startAutoRoute: autoroute.startAutoRoute,
  stopAutoRoute: autoroute.stopAutoRoute,
  setAutoRouteEnabled: autoroute.setAutoRouteEnabled,
  getAutoRouteStatus: autoroute.getAutoRouteStatus,
  dispatchAutoRoute: dispatch.dispatchAutoRoute,

  // ==================== 智能体启停 ↔ uTools 指令同步 ====================
  // 按启停状态增删各 agent 的启动命令（功能指令 + 匹配指令），详见 services/commands.js
  syncAgentCommands: commands.syncAgentCommands,

  getReasonixConfigPath: reasonix.getReasonixConfigPath,
  readReasonixConfig: reasonix.readReasonixConfig,
  writeReasonixConfig: reasonix.writeReasonixConfig,
  getReasonixProviderList: reasonix.getReasonixProviderList,
  addReasonixProvider: reasonix.addReasonixProvider,
  updateReasonixProvider: reasonix.updateReasonixProvider,
  deleteReasonixProvider: reasonix.deleteReasonixProvider,
  addReasonixModel: reasonix.addReasonixModel,
  deleteReasonixModel: reasonix.deleteReasonixModel,
  getReasonixDefaultModel: reasonix.getReasonixDefaultModel,
  setReasonixDefaultModel: reasonix.setReasonixDefaultModel,
  readReasonixEnv: reasonix.readReasonixEnv,
  getReasonixApiKey: reasonix.getReasonixApiKey,
  writeReasonixEnvKey: reasonix.writeReasonixEnvKey,
  deleteReasonixEnvKey: reasonix.deleteReasonixEnvKey,
  generateReasonixApiKeyEnv: reasonix.generateReasonixApiKeyEnv,
  openReasonixDir: reasonix.openReasonixDir,
  isReasonixInstalled: reasonix.isReasonixInstalled,
  // ==================== Kimi Code（~/.kimi-code/config.toml，仅模型配置） ====================
  getKimiConfigPath: kimi.getKimiConfigPath,
  readKimiConfig: kimi.readKimiConfig,
  writeKimiConfig: kimi.writeKimiConfig,
  getKimiProviderList: kimi.getKimiProviderList,
  addKimiProvider: kimi.addKimiProvider,
  updateKimiProvider: kimi.updateKimiProvider,
  deleteKimiProvider: kimi.deleteKimiProvider,
  getKimiModelList: kimi.getKimiModelList,
  addKimiModel: kimi.addKimiModel,
  updateKimiModel: kimi.updateKimiModel,
  deleteKimiModel: kimi.deleteKimiModel,
  getKimiDefaultModel: kimi.getKimiDefaultModel,
  setKimiDefaultModel: kimi.setKimiDefaultModel,

  // ==================== MiniMax Code（~/.minimax/config.yaml，仅模型配置） ====================
  getMinimaxConfigPath: minimax.getMinimaxConfigPath,
  getMinimaxProviderList: minimax.getMinimaxProviderList,
  addMinimaxProvider: minimax.addMinimaxProvider,
  updateMinimaxProvider: minimax.updateMinimaxProvider,
  deleteMinimaxProvider: minimax.deleteMinimaxProvider,
  addMinimaxModel: minimax.addMinimaxModel,
  updateMinimaxModel: minimax.updateMinimaxModel,
  deleteMinimaxModel: minimax.deleteMinimaxModel,
  getMinimaxDefaultModel: minimax.getMinimaxDefaultModel,
  setMinimaxDefaultModel: minimax.setMinimaxDefaultModel,
  isMinimaxDefaultModel: minimax.isMinimaxDefaultModel,
  openMinimaxDir: minimax.openMinimaxDir,
  isMinimaxInstalled: minimax.isMinimaxInstalled,
  openKimiDir: kimi.openKimiDir,
  isKimiInstalled: kimi.isKimiInstalled,
  // 扩展字段枚举与键表（渲染层下拉选项/表单遍历用）
  KIMI_CAPABILITIES: kimi.KIMI_CAPABILITIES,
  KIMI_EFFORTS: kimi.KIMI_EFFORTS,
  MODEL_EXTRA_KEYS: kimi.MODEL_EXTRA_KEYS,
  // 检测各 agent 是否已有配置数据（本地文件 + DB，无网络，全部 try/catch）
  detectAgentsConfig() {
    const hasData = {
      claude: false,
      opencode: false,
      pi: false,
      omp: false,
      reasonix: false,
      codex: false,
      kimi: false,
    };
    // claude：settings.json 有 managed env 字段，或 DB 有已存配置
    try {
      const settings = readClaudeSettings();
      if (settings && settings.env) {
        hasData.claude = Object.keys(settings.env).some(
          (k) => k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_"),
        );
      }
      if (!hasData.claude) {
        hasData.claude = window.utools.db
          .allDocs()
          .some((d) => d._id.startsWith("ccswitch_config_"));
      }
    } catch (e) {
      /* ignore */
    }
    // opencode：provider / plugin / mcp 任一有内容
    try {
      const oc = readOpencodeConfig();
      hasData.opencode = !!(
        oc &&
        (Object.keys(oc.provider || {}).length > 0 ||
          (oc.plugin || []).length > 0 ||
          Object.keys(oc.mcp || {}).length > 0)
      );
    } catch (e) {
      /* ignore */
    }
    // pi：models.json 有供应商
    try {
      const models = pi.readPiModels();
      hasData.pi = !!(models && Object.keys(models.providers || {}).length > 0);
    } catch (e) {
      /* ignore */
    }
    // omp：modelRoles 或 models.yml 有内容
    try {
      const roles = omp.readOmpModelRoles();
      const models = omp.readOmpModels();
      hasData.omp = !!(
        Object.keys(roles || {}).length > 0 ||
        Object.keys((models && models.providers) || {}).length > 0
      );
    } catch (e) {
      /* ignore */
    }
    // reasonix：config.toml 有 providers
    try {
      const cfg = reasonix.readReasonixConfig();
      hasData.reasonix = !!((cfg && cfg.providers) || []).length;
    } catch (e) {
      /* ignore */
    }
    // codex：config.toml 有 model_providers 或顶层 model/model_provider
    try {
      const cfg = codex.readCodexConfig();
      hasData.codex = !!(
        (cfg && cfg.model_providers && Object.keys(cfg.model_providers).length > 0) ||
        (cfg && (cfg.model || cfg.model_provider))
      );
    } catch (e) {
      /* ignore */
    }
    // kimi：config.toml 有 providers 或 models
    try {
      const cfg = kimi.readKimiConfig();
      hasData.kimi = !!(
        cfg &&
        (Object.keys(cfg.providers || {}).length > 0 ||
          Object.keys(cfg.models || {}).length > 0)
      );
    } catch (e) {
      /* ignore */
    }
    return hasData;
  },
};

// 辅助函数：递归查找 SKILL.md
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

// ==================== SkillHub 辅助函数 ====================
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
function _downloadToFile(url, filePath, onProgress) {
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    const doGet = (targetUrl, redirectCount = 0) => {
      if (redirectCount > 10) return reject(new Error("重定向次数过多"));
      https
        .get(targetUrl, { headers: SKILLHUB_HEADERS }, (res) => {
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

// ==================== 智能体启停指令同步：生命周期自愈 ====================
// 注意：uTools API 没有 onPluginReady 回调（误用会抛 TypeError 并中断后续注册，
// 导致同步链路整体失效）。preload 顶层代码在插件每次装载（启动）时执行，
// 等价于启动时机，直接重放同步；onPluginEnter 再覆盖每次进入。两者均幂等，
// 覆盖 uTools 重启 / 插件更新 / 开发者工具重新导入后静态指令（plugin.json
// features）回归的场景：停用的 agent 命令在插件装载/进入后即被移除。
const syncLifecycle = () => {
  try { commands.initFromDb(); } catch (e) { console.error("[commands] 启停指令同步失败", e); }
  try { autoroute.startAutoRouteIfEnabled(); } catch (e) { console.error("[autoroute] 网关自启失败", e); }
};
syncLifecycle();
window.utools.onPluginEnter(() => {
  syncLifecycle();
});
