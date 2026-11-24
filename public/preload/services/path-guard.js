// 渲染层传来的名称/路径统一在这里校验。
//
// 安全边界必须落在 preload：window.services 对渲染层可见，任何直接拼接的
// skillName / projectPath / extractDir 都等价于把对应文件系统能力交给页面。
const fs = require("node:fs");
const path = require("node:path");

const { t } = require("./i18n");

const SKILL_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** 技能目录名只允许 [A-Za-z0-9._-]，并拒绝 . / .. / .disabled。 */
const assertSkillName = (name) => {
  const value = String(name == null ? "" : name).trim();
  if (
    !value ||
    value.length > 255 ||
    !SKILL_NAME_RE.test(value) ||
    value === "." ||
    value === ".." ||
    value === ".disabled"
  ) {
    throw new Error(t("service.skill.invalidName"));
  }
  return value;
};

const _realpathOrNull = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * 校验 target 在 root 内，返回 target 的绝对路径。
 *
 * path.resolve 只能挡住词法穿越；父目录如果是指向根目录外的软链，词法路径仍在
 * root 内而真实写入会落到外部，所以再对最近已存在的祖先做 realpath 校验。
 * 目标本身是软链时按「链接所在目录」校验，保留只删除/移动链接本身的能力。
 */
const assertPathInside = (root, target) => {
  const rootAbs = path.resolve(String(root || ""));
  const targetAbs = path.resolve(String(target || ""));
  const rel = path.relative(rootAbs, targetAbs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(t("service.common.pathOutsideRoot"));
  }

  // 根目录尚未创建时 lexical 校验已足够；创建动作发生在该根之下。
  const realRoot = _realpathOrNull(rootAbs);
  if (!realRoot) return targetAbs;
  let probe = targetAbs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = _realpathOrNull(probe) || probe;
  let realTarget = realProbe;
  try {
    if (probe === targetAbs && fs.lstatSync(probe).isSymbolicLink()) {
      realTarget = path.join(
        _realpathOrNull(path.dirname(probe)) || path.dirname(probe),
        path.basename(probe),
      );
    }
  } catch {
    /* probe 不存在时保留 realProbe */
  }
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(t("service.common.pathOutsideRoot"));
  }
  return targetAbs;
};

const _sameRealPath = (a, b) => {
  const ra = _realpathOrNull(a);
  const rb = _realpathOrNull(b);
  if (ra && rb) return ra === rb;
  return path.resolve(a) === path.resolve(b);
};

/**
 * projectPath 必须是已登记项目目录：候选路径先 resolve，能和 allowedPaths
 * 中任意一项的 realpath 对上才算通过；用户主目录、文件系统根目录一律拒绝。
 */
const assertRegisteredPath = (candidate, allowedPaths, homeDir) => {
  const value = String(candidate == null ? "" : candidate).trim();
  if (!value || !path.isAbsolute(value)) {
    throw new Error(t("service.common.invalidPath"));
  }
  const resolved = path.resolve(value);
  const home = homeDir ? path.resolve(homeDir) : "";
  if (home && _sameRealPath(resolved, home)) {
    throw new Error(t("service.common.invalidPath"));
  }
  if (path.dirname(resolved) === resolved) {
    throw new Error(t("service.common.invalidPath"));
  }
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(t("service.common.invalidPath"));

  const allowed = Array.from(allowedPaths || []).some((p) => {
    try {
      return _sameRealPath(resolved, p);
    } catch {
      return false;
    }
  });
  if (!allowed) throw new Error(t("service.common.invalidPath"));
  return resolved;
};

module.exports = {
  SKILL_NAME_RE,
  assertSkillName,
  assertPathInside,
  assertRegisteredPath,
};
