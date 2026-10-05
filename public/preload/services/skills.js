// Claude 技能管理：~/.claude/skills 全局与项目级技能扫描（frontmatter 解析 +
// mtime 签名缓存）、.disabled 目录启停机制与路径辅助。
const fs = require("node:fs");
const path = require("node:path");

const { CLAUDE_SKILLS_PATH, CLAUDE_JSON_PATH } = require("./config");
const { _buildProjectPathMap } = require("./claude-usage");

// 缓存：签名 = 技能目录 mtime:disabled 目录 mtime；projectPathMap 只构建一次
let _skillsCache = null;
let _cachedProjectPathMap = null;

function getSkills() {
  try {
    const _disabledDirPath = path.join(CLAUDE_SKILLS_PATH, ".disabled");
    const dirMtime = fs.existsSync(CLAUDE_SKILLS_PATH)
      ? fs.statSync(CLAUDE_SKILLS_PATH).mtimeMs
      : 0;
    const disabledMtime = fs.existsSync(_disabledDirPath)
      ? fs.statSync(_disabledDirPath).mtimeMs
      : 0;
    const signature = `${dirMtime}:${disabledMtime}`;
    if (_skillsCache && _skillsCache.signature === signature) {
      return _skillsCache.data;
    }

    if (!fs.existsSync(CLAUDE_SKILLS_PATH)) {
      _skillsCache = { signature, data: [] };
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
        if (!_cachedProjectPathMap)
          _cachedProjectPathMap = _buildProjectPathMap(projectsDir);
        const projectPathMap = _cachedProjectPathMap;
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
    _skillsCache = { signature, data: sorted };
    return sorted;
  } catch (error) {
    console.error("读取 skills 目录失败:", error);
    return [];
  }
}

function disableSkill(skillName) {
  try {
    const skillPath = path.join(CLAUDE_SKILLS_PATH, skillName);
    const disabledDir = path.join(CLAUDE_SKILLS_PATH, ".disabled");
    const targetPath = path.join(disabledDir, skillName);
    if (!fs.existsSync(skillPath))
      return { success: false, error: "Skill 不存在" };
    if (!fs.existsSync(disabledDir))
      fs.mkdirSync(disabledDir, { recursive: true });
    fs.renameSync(skillPath, targetPath);
    _skillsCache = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function enableSkill(skillName) {
  try {
    const disabledDir = path.join(CLAUDE_SKILLS_PATH, ".disabled");
    const skillPath = path.join(disabledDir, skillName);
    const targetPath = path.join(CLAUDE_SKILLS_PATH, skillName);
    if (!fs.existsSync(skillPath))
      return { success: false, error: "Skill 不存在" };
    fs.renameSync(skillPath, targetPath);
    _skillsCache = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function deleteSkill(skillName, isDisabled) {
  try {
    const skillPath = isDisabled
      ? path.join(CLAUDE_SKILLS_PATH, ".disabled", skillName)
      : path.join(CLAUDE_SKILLS_PATH, skillName);
    if (!fs.existsSync(skillPath))
      return { success: false, error: "Skill 不存在" };
    fs.rmSync(skillPath, { recursive: true, force: true });
    _skillsCache = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function disableProjectSkill(skillName, projectPath) {
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
    _skillsCache = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function enableProjectSkill(skillName, projectPath) {
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
    _skillsCache = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function deleteProjectSkill(skillName, projectPath, isDisabled) {
  try {
    const skillPath = isDisabled
      ? path.join(projectPath, ".claude", "skills", ".disabled", skillName)
      : path.join(projectPath, ".claude", "skills", skillName);
    if (!fs.existsSync(skillPath))
      return { success: false, error: "Skill 不存在" };
    fs.rmSync(skillPath, { recursive: true, force: true });
    _skillsCache = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function moveProjectSkillToGlobal(skillName, projectPath) {
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
}

function getSkillMdPath(skillName, scope, projectPath, isDisabled) {
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
}

function getSkillDirPath(skillName, scope, projectPath, isDisabled) {
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
}

function getSkillsPath() {
  if (!fs.existsSync(CLAUDE_SKILLS_PATH))
    fs.mkdirSync(CLAUDE_SKILLS_PATH, { recursive: true });
  return CLAUDE_SKILLS_PATH;
}

function openProjectSkillsDir(projectPath) {
  const skillsDir = path.join(projectPath, ".claude", "skills");
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
  window.utools.shellOpenPath(skillsDir);
}

module.exports = {
  getSkills,
  disableSkill,
  enableSkill,
  deleteSkill,
  disableProjectSkill,
  enableProjectSkill,
  deleteProjectSkill,
  moveProjectSkillToGlobal,
  getSkillMdPath,
  getSkillDirPath,
  getSkillsPath,
  openProjectSkillsDir,
};
