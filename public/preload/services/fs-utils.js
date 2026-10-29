// 文件系统小工具：统一「跟随软链接」的目录/文件判定。
//
// 为什么要单独一层：fs.readdirSync(dir, { withFileTypes: true }) 返回的 Dirent
// 只看目录项自身的类型，isDirectory() 对符号链接恒为 false。而用软链挂载 Skill
// （~/.agents/skills/ego-browser -> ~/.local/share/ego/ego-skills、dotfiles 管理、
// 外部目录共享）是很常见的用法，直接 isDirectory() 会让这些条目整条消失。
// 所以判定一律走本模块：先按 Dirent 判，命中不了再 lstat/stat 兜底（防断链）。
//
// 删除也必须走本模块：直接 fs.rmSync(link, { recursive: true }) 只会删链接本身
// （Node 不跟随），但为确保语义清晰、且避免「链接指向目录时被误判成要递归」，
// 统一先 lstat 判断，链接只删链接。
const fs = require("node:fs");
const path = require("node:path");

const _lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

// 目录项是否为目录（跟随符号链接；断链 / 无权限返回 false）
const isDirEntry = (dir, entry) => {
  if (!entry) return false;
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
};

// 目录项是否为普通文件（跟随符号链接）
const isFileEntry = (dir, entry) => {
  if (!entry) return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, entry.name)).isFile();
  } catch {
    return false;
  }
};

// 列出目录下的子目录名（跟随软链；不存在 / 读失败返回 []）
const listDirNames = (dir, { skipHidden = false } = {}) => {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => isDirEntry(dir, e))
      .filter((e) => !skipHidden || !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

// 目录下的条目数（用于 UI 的 fileCount）：跳过隐藏项（.DS_Store 之类），
// 读失败返回 0。软链目标可读即可，不递归。
const countEntries = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".")).length;
  } catch {
    return 0;
  }
};

// 当前路径本身是否是一个符号链接（不看目标）
const isSymlink = (p) => {
  const st = _lstat(p);
  return !!st && st.isSymbolicLink();
};

// 删除一个目录/文件条目：符号链接只删链接本身，绝不递归进目标目录。
// 返回 true 表示已删除（或本来就不存在）。
const rmEntry = (p) => {
  const st = _lstat(p);
  if (!st) return true;
  if (st.isSymbolicLink()) {
    fs.unlinkSync(p);
    return true;
  }
  fs.rmSync(p, { recursive: true, force: true });
  return true;
};

module.exports = {
  isDirEntry,
  isFileEntry,
  listDirNames,
  countEntries,
  isSymlink,
  rmEntry,
};
