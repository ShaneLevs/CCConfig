// Claude 技能管理：~/.claude/skills 全局与项目级技能扫描（frontmatter 解析 +
// mtime 签名缓存）、停用目录（skills 同级的 .disabled）启停机制与路径辅助。
const fs = require("node:fs");
const path = require("node:path");

const { CLAUDE_SKILLS_PATH, CLAUDE_JSON_PATH } = require("./config");
const { t } = require("./i18n");
const { _buildProjectPathMap } = require("./claude-usage");
const { isDirEntry, countEntries, rmEntry } = require("./fs-utils");
const {
  disabledSkillsDir,
  migrateDisabledSkills,
  setSkillEnabled,
} = require("./skill-disabled");
const { assertSkillName, assertPathInside, assertRegisteredPath } = require("./path-guard");

// 缓存：签名 = 技能目录 mtime:disabled 目录 mtime；projectPathMap 只构建一次
let _skillsCache = null;
let _cachedProjectPathMap = null;

const _getProjectRegistry = () => {
  const homeDir = window.utools.getPath("home");
  const projectsDir = path.join(homeDir, ".claude", "projects");
  if (!_cachedProjectPathMap) _cachedProjectPathMap = _buildProjectPathMap(projectsDir);
  const paths = [..._cachedProjectPathMap.values()].filter(
    (p) => typeof p === "string" && p && p !== "unknown" && path.isAbsolute(p),
  );
  return { homeDir, paths };
};

const _assertProjectPath = (projectPath) => {
  const { homeDir, paths } = _getProjectRegistry();
  return assertRegisteredPath(projectPath, paths, homeDir);
};

function getSkills() {
  try {
    migrateDisabledSkills(CLAUDE_SKILLS_PATH);
    const _disabledDirPath = disabledSkillsDir(CLAUDE_SKILLS_PATH);
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

    const disabledDir = disabledSkillsDir(CLAUDE_SKILLS_PATH);
    const skills = [];

    // 读取启用的 skills
    const entries = fs.readdirSync(CLAUDE_SKILLS_PATH, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!isDirEntry(CLAUDE_SKILLS_PATH, entry) || entry.name === ".disabled")
        continue;
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
        const fileCount = countEntries(skillPath);
        skills.push({
          name: skillName,
          frontmatter,
          disabled: false,
          scope: "global",
          skillMdPath,
          fileCount,
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
        if (!isDirEntry(disabledDir, entry)) continue;
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
          const fileCount = countEntries(skillPath);
          skills.push({
            name: skillName,
            frontmatter,
            disabled: true,
            scope: "global",
            skillMdPath,
            fileCount,
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
            !path.isAbsolute(projectPath) ||
            !fs.existsSync(projectPath)
          )
            continue;
          const resolvedProject = path.resolve(projectPath);
          if (
            resolvedProject === path.resolve(homeDir) ||
            path.dirname(resolvedProject) === resolvedProject
          )
            continue;
          const projectSkillsDir = path.join(
            projectPath,
            ".claude",
            "skills",
          );
          if (!fs.existsSync(projectSkillsDir)) continue;
          migrateDisabledSkills(projectSkillsDir);

          const projectSkills = fs.readdirSync(projectSkillsDir, {
            withFileTypes: true,
          });
          for (const entry of projectSkills) {
            if (!isDirEntry(projectSkillsDir, entry) || entry.name === ".disabled")
              continue;
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
              const fileCount = countEntries(skillDir);
              skills.push({
                name: skillName,
                frontmatter,
                disabled: false,
                scope: "project",
                projectName: path.basename(projectPath),
                projectPath,
                skillMdPath,
                fileCount,
                usageCount: usage.usageCount || 0,
                lastUsedAt: usage.lastUsedAt || null,
              });
            } catch (e) {
              console.error("读取项目 skill 文件失败:", skillMdPath, e);
            }
          }

          // 读取项目级禁用的 skills（项目 .claude/.disabled，与 skills 目录同级）
          const projectDisabledDir = disabledSkillsDir(projectSkillsDir);
          if (fs.existsSync(projectDisabledDir)) {
            const disabledEntries = fs.readdirSync(projectDisabledDir, {
              withFileTypes: true,
            });
            for (const entry of disabledEntries) {
              if (!isDirEntry(projectDisabledDir, entry)) continue;
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
                const fileCount = countEntries(skillDir);
                skills.push({
                  name: skillName,
                  frontmatter,
                  disabled: true,
                  scope: "project",
                  projectName: path.basename(projectPath),
                  projectPath,
                  skillMdPath,
                  fileCount,
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
  const result = setSkillEnabled(CLAUDE_SKILLS_PATH, skillName, false);
  if (result.success) _skillsCache = null;
  return result;
}

function enableSkill(skillName) {
  const result = setSkillEnabled(CLAUDE_SKILLS_PATH, skillName, true);
  if (result.success) _skillsCache = null;
  return result;
}

function deleteSkill(skillName, isDisabled) {
  try {
    const name = assertSkillName(skillName);
    const root = isDisabled ? disabledSkillsDir(CLAUDE_SKILLS_PATH) : CLAUDE_SKILLS_PATH;
    const skillPath = path.join(root, name);
    assertPathInside(root, skillPath);
    if (!fs.existsSync(skillPath))
      return { success: false, error: t("service.skill.notFound") };
    // 软链接只删链接本身
    rmEntry(skillPath, { root });
    _skillsCache = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function disableProjectSkill(skillName, projectPath) {
  try {
    const project = _assertProjectPath(projectPath);
    const skillsRoot = path.join(project, ".claude", "skills");
    assertPathInside(project, skillsRoot);
    const result = setSkillEnabled(skillsRoot, skillName, false);
    if (result.success) _skillsCache = null;
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function enableProjectSkill(skillName, projectPath) {
  try {
    const project = _assertProjectPath(projectPath);
    const skillsRoot = path.join(project, ".claude", "skills");
    assertPathInside(project, skillsRoot);
    const result = setSkillEnabled(skillsRoot, skillName, true);
    if (result.success) _skillsCache = null;
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function deleteProjectSkill(skillName, projectPath, isDisabled) {
  try {
    const project = _assertProjectPath(projectPath);
    const name = assertSkillName(skillName);
    const skillsRoot = path.join(project, ".claude", "skills");
    assertPathInside(project, skillsRoot);
    const root = isDisabled ? disabledSkillsDir(skillsRoot) : skillsRoot;
    const skillPath = path.join(root, name);
    assertPathInside(root, skillPath);
    if (!fs.existsSync(skillPath))
      return { success: false, error: t("service.skill.notFound") };
    // 软链接只删链接本身
    rmEntry(skillPath, { root });
    _skillsCache = null;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function moveProjectSkillToGlobal(skillName, projectPath) {
  try {
    const project = _assertProjectPath(projectPath);
    const name = assertSkillName(skillName);
    const srcRoot = path.join(project, ".claude", "skills");
    assertPathInside(project, srcRoot);
    const srcPath = path.join(srcRoot, name);
    const destPath = path.join(CLAUDE_SKILLS_PATH, name);
    assertPathInside(srcRoot, srcPath);
    assertPathInside(CLAUDE_SKILLS_PATH, destPath);
    if (!fs.existsSync(srcPath))
      return { success: false, error: t("service.skill.sourceNotFound") };
    if (fs.existsSync(destPath))
      return { success: false, error: t("service.skill.alreadyExists") };
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
    const name = assertSkillName(skillName);
    let root;
    if (scope === "project") {
      const project = _assertProjectPath(projectPath);
      root = path.join(project, ".claude", "skills");
      assertPathInside(project, root);
    } else {
      root = CLAUDE_SKILLS_PATH;
    }
    const skillDir = path.join(isDisabled ? disabledSkillsDir(root) : root, name);
    const actualRoot = isDisabled ? disabledSkillsDir(root) : root;
    assertPathInside(actualRoot, skillDir);
    const mdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(mdPath))
      return { success: false, error: t("service.skill.skillMdMissing") };
    return { success: true, path: mdPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getSkillDirPath(skillName, scope, projectPath, isDisabled) {
  try {
    const name = assertSkillName(skillName);
    let root;
    if (scope === "project") {
      const project = _assertProjectPath(projectPath);
      root = path.join(project, ".claude", "skills");
      assertPathInside(project, root);
    } else {
      root = CLAUDE_SKILLS_PATH;
    }
    const actualRoot = isDisabled ? disabledSkillsDir(root) : root;
    const skillDir = path.join(actualRoot, name);
    assertPathInside(actualRoot, skillDir);
    if (!fs.existsSync(skillDir))
      return { success: false, error: t("service.skill.folderMissing") };
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
  try {
    const project = _assertProjectPath(projectPath);
    const skillsDir = path.join(project, ".claude", "skills");
    assertPathInside(project, skillsDir);
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
    window.utools.shellOpenPath(skillsDir);
  } catch (error) {
    return { success: false, error: error.message };
  }
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
