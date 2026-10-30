// Skill 启停的停用目录（物理移动）。
//
// 存放位置 = <skills 根目录的上一级>/.disabled/<name>，例如
//   ~/.agents/skills        → ~/.agents/.disabled
//   ~/.claude/skills        → ~/.claude/.disabled
//   <项目>/.claude/skills    → <项目>/.claude/.disabled
//
// 不能放在 <skills 根目录>/.disabled：Grok Build 等会递归遍历 skills 根目录找 SKILL.md
// （官方文档明确 walks every directory，且发现过程不读 .gitignore），根目录内的子目录
// 照样会被当成可用 Skill 加载。放到根目录同级后，任何「扫 <root>/skills」的实现都看不到。
//
// 旧版把停用项放在 <root>/.disabled，本模块在扫描/启停前会自动迁移过来（幂等）。
const fs = require("node:fs");
const path = require("node:path");
const { isDirEntry, rmEntry } = require("./fs-utils");
const { t } = require("./i18n");

const DISABLED_DIR_NAME = ".disabled";
// 迁移时新位置已有同名项：旧副本挪到这里（位于停用目录内部，不会被 Agent 扫描到）
const DUPLICATES_DIR_NAME = ".duplicates";

const disabledSkillsDir = (skillsRoot) =>
  path.join(path.dirname(skillsRoot), DISABLED_DIR_NAME);

const legacyDisabledSkillsDir = (skillsRoot) =>
  path.join(skillsRoot, DISABLED_DIR_NAME);

const disabledSkillPath = (skillsRoot, name) =>
  path.join(disabledSkillsDir(skillsRoot), name);

// 断链的软链 existsSync 会返回 false，启停需要能识别它，统一走 lstat
const pathExists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// 移动单个条目（目录 / 文件 / 软链）。软链只移动链接本身，不碰目标目录。
// 跨卷时 rename 会报 EXDEV（skills 根被挂到另一块盘），退化为复制后删源。
const moveEntry = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
  }
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(from);
    let type = "file";
    try {
      type = fs.statSync(from).isDirectory() ? "dir" : "file";
    } catch {
      /* 断链：按文件链接重建 */
    }
    fs.symlinkSync(target, to, type);
    fs.unlinkSync(from);
    return;
  }
  if (st.isDirectory()) {
    fs.cpSync(from, to, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  } else {
    fs.copyFileSync(from, to);
  }
  rmEntry(from);
};

// 把旧版 <root>/.disabled 里的条目搬到新位置；幂等，失败项留给下次重试。
const migrateDisabledSkills = (skillsRoot) => {
  const legacy = legacyDisabledSkillsDir(skillsRoot);
  let st;
  try {
    st = fs.lstatSync(legacy);
  } catch {
    return;
  }
  // 旧目录本身是软链时不跟进，避免改动链接指向的目录
  if (!st.isDirectory()) return;
  const target = disabledSkillsDir(skillsRoot);
  let entries = [];
  try {
    entries = fs.readdirSync(legacy, { withFileTypes: true });
  } catch {
    return;
  }
  entries.forEach((entry, index) => {
    // 软链目标可能已不存在（源目录被删），仍按条目搬走
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
    const from = path.join(legacy, entry.name);
    let to = path.join(target, entry.name);
    if (pathExists(to)) {
      to = path.join(
        target,
        DUPLICATES_DIR_NAME,
        `${entry.name}-${Date.now().toString(36)}-${index}`,
      );
    }
    try {
      moveEntry(from, to);
    } catch (e) {
      console.error("[skill-disabled] 迁移旧停用目录失败:", from, e);
    }
  });
  // Finder 浏览过目录后会留下 .DS_Store，它会让 rmdir 一直失败、旧目录看起来「还在」。
  // 只清这个已知的元数据文件；迁移失败的真实 Skill 目录仍保留，留给下次重试。
  const legacyJunk = path.join(legacy, ".DS_Store");
  if (pathExists(legacyJunk)) {
    try {
      fs.unlinkSync(legacyJunk);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmdirSync(legacy);
  } catch {
    /* 非空（迁移失败项）/ 无权限：下次再试 */
  }
};

const listDisabledSkillNames = (skillsRoot) => {
  migrateDisabledSkills(skillsRoot);
  const dir = disabledSkillsDir(skillsRoot);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => isDirEntry(dir, e) && !e.name.startsWith("."))
    .map((e) => e.name);
};

const isValidSkillName = (name) =>
  !!name &&
  name !== "." &&
  name !== ".." &&
  name !== DISABLED_DIR_NAME &&
  !name.includes(path.sep) &&
  !name.includes("/");

// 启用 / 停用 = 在 skills 根目录与新停用目录之间移动条目
const setSkillEnabled = (skillsRoot, skillName, enabled) => {
  migrateDisabledSkills(skillsRoot);
  const name = String(skillName || "").trim();
  if (!isValidSkillName(name)) {
    return { success: false, error: t("service.skill.notFound") };
  }
  const from = enabled
    ? disabledSkillPath(skillsRoot, name)
    : path.join(skillsRoot, name);
  const to = enabled
    ? path.join(skillsRoot, name)
    : disabledSkillPath(skillsRoot, name);
  if (!pathExists(from)) {
    return { success: false, error: t("service.skill.notFound") };
  }
  if (pathExists(to)) {
    return { success: false, error: t("service.skill.alreadyExists") };
  }
  try {
    moveEntry(from, to);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};

module.exports = {
  DISABLED_DIR_NAME,
  disabledSkillsDir,
  legacyDisabledSkillsDir,
  disabledSkillPath,
  pathExists,
  moveEntry,
  migrateDisabledSkills,
  listDisabledSkillNames,
  setSkillEnabled,
};
