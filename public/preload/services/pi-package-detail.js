// 已安装 pi 包的清单读取与启停：包级启停写 ~/.pi/agent/settings.json 的 packages
// 过滤数组；单资源启停对齐 pi config TUI 的过滤语义（applyPatterns）。
const fs = require("node:fs");
const path = require("node:path");

const { PI_NPM_DIR, readJson, readPiSettings, writePiSettings } = require("./pi-common");

// 已安装扩展清单：读 settings.packages，结合包目录磁盘内容（package.json /
// .claude-plugin/plugin.json / skills 目录）推断各类型资源列表
const getPiExtensions = () => {
  const settings = readPiSettings();
  const packages = settings.packages || [];
  return packages
    .map((entry) => {
      // pi 新版 packages 条目可能是对象（{ source, extensions: ['+index.ts'] }，含扩展启停状态），兼容纯字符串旧格式
      const src =
        typeof entry === "string" ? entry : (entry && entry.source) || "";
      if (!src) return null;
      const pkgDir = path.join(
        PI_NPM_DIR(),
        ...src.replace("npm:", "").split("/"),
      );
      const name = src.replace("npm:", "");
      let version = "",
        description = "";
      try {
        const pkg = readJson(path.join(pkgDir, "package.json"));
        if (pkg) {
          version = pkg.version || "";
          description = pkg.description || "";
        }
      } catch {
        /* ignore */
      }

      // pi config resource introspection
      const resources = { extensions: [], skills: [], mcpServers: [] };

      // 扩展列表：优先用 pi 自身记录的清单（带 +/−/! 启停前缀，过滤掉标记项）；
      // 其次 package.json 的 pi.extensions 字段；最后扫常见目录
      const rawExts =
        typeof entry === "object" && Array.isArray(entry.extensions)
          ? entry.extensions
          : null;
      const rawExtPaths = rawExts
        ? rawExts
            .map((e) => String(e).replace(/^[+!-]/, ""))
            .filter((e) => e && e !== "*")
        : [];
      if (rawExtPaths.length) {
        resources.extensions = rawExtPaths;
      } else {
        const declared = readJson(path.join(pkgDir, "package.json"))?.pi
          ?.extensions;
        if (Array.isArray(declared) && declared.length) {
          resources.extensions = declared
            .map((e) => String(e).replace(/^\.?\//, ""))
            .filter(Boolean);
        } else {
          for (const sub of ["pi", "extensions"]) {
            const extDir = path.join(pkgDir, sub);
            if (!fs.existsSync(extDir)) continue;
            try {
              resources.extensions = fs
                .readdirSync(extDir)
                .filter(
                  (f) =>
                    f.endsWith(".js") ||
                    f.endsWith(".ts") ||
                    f.endsWith(".mjs"),
                );
            } catch {
              /* ignore */
            }
            if (resources.extensions.length) break;
          }
        }
      }

      const claudePlugin = readJson(
        path.join(pkgDir, ".claude-plugin", "plugin.json"),
      );
      if (claudePlugin?.mcpServers) {
        resources.mcpServers = Object.keys(claudePlugin.mcpServers);
      }

      const skillsDir = path.join(pkgDir, "skills");
      if (fs.existsSync(skillsDir)) {
        try {
          resources.skills = fs
            .readdirSync(skillsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          /* ignore */
        }
      }

      return {
        name,
        source: src,
        version,
        description,
        resources,
        enabled: !isPiPackageEntryDisabled(entry),
      };
    })
    .filter(Boolean);
};

// ==================== 包级启停（写 ~/.pi/agent/settings.json） ====================
// 机制：pi 解析 packages 条目的 extensions/skills/prompts/themes 过滤数组时，
// 空数组 [] 会短路整个 applyPatterns，显式禁用该类型全部资源（pi 源码注释：
// "Empty array explicitly disables all resources of this type"）；四个类型都置 []
// 即整包禁用，且能压过 pi config TUI 写入的 `+path` 强制启用项。
// 启用时删除四个过滤键，无剩余过滤时条目折叠回纯字符串（恢复默认全启用）。
// 改动在 Pi 下次启动时生效。
const PI_FILTER_KEYS = ["extensions", "skills", "prompts", "themes"];

const isPiPackageEntryDisabled = (entry) =>
  !!entry &&
  typeof entry === "object" &&
  PI_FILTER_KEYS.every(
    (k) => Array.isArray(entry[k]) && entry[k].length === 0,
  );

const setPiExtensionEnabled = (source, enabled) => {
  try {
    const settings = readPiSettings();
    const packages = Array.isArray(settings.packages)
      ? [...settings.packages]
      : [];
    const idx = packages.findIndex(
      (e) => (typeof e === "string" ? e : (e && e.source) || "") === source,
    );
    if (idx === -1) {
      return { success: false, message: `未找到包条目: ${source}` };
    }
    const entry = packages[idx];
    if (enabled) {
      if (typeof entry === "string") {
        return { success: true, message: "该扩展已处于启用状态" };
      }
      const next = { ...entry };
      for (const k of PI_FILTER_KEYS) delete next[k];
      const hasFilters = PI_FILTER_KEYS.some((k) => next[k] !== undefined);
      packages[idx] = hasFilters ? next : next.source;
    } else {
      if (isPiPackageEntryDisabled(entry)) {
        return { success: true, message: "该扩展已处于禁用状态" };
      }
      const next = typeof entry === "string" ? { source: entry } : { ...entry };
      for (const k of PI_FILTER_KEYS) next[k] = [];
      packages[idx] = next;
    }
    settings.packages = packages;
    writePiSettings(settings);
    return {
      success: true,
      message: enabled ? "已启用，Pi 下次启动生效" : "已禁用，Pi 下次启动生效",
    };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
};

// ==================== 本地包详情 / 单资源启停 ====================
// 单资源启停对齐 pi config TUI 的过滤语义（applyPatterns）：
// 普通项 = glob 包含；`!x` = glob 排除；`+x` = 精确强制启用；`-x` = 精确强制禁用；
// 空数组 [] = 该类型全部禁用（包级禁用标记）。
const PI_RES_TYPES = ["extensions", "skills", "prompts", "themes"];
// 各类型参与扫描的文件后缀（与 pi collectResourceFiles 对齐，skills 按目录计）
const PI_RES_FILE_EXT = {
  extensions: /\.(js|ts|mjs|cjs)$/i,
  prompts: /\.(md|txt)$/i,
  themes: /\.json$/i,
};

const toPosixPath = (p) => String(p).split(path.sep).join("/");

// 简易通配符匹配（* 不跨 /，? 单字符），同时按 pi 的 matchesAnyPattern 尝试 basename
const piWildcardHit = (rel, pat) => {
  const p = toPosixPath(pat).replace(/^\.\//, "");
  const re = new RegExp(
    "^" +
      p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$",
  );
  return re.test(rel) || re.test(rel.split("/").pop() || "");
};

// 精确匹配（pi matchesAnyExactPattern 的简化版）：全路径或 basename 相等
const piExactHit = (rel, pat) => {
  const p = toPosixPath(pat).replace(/^\.\//, "");
  return p === rel || p === (rel.split("/").pop() || "");
};

// 按 pi applyPatterns 的四步语义计算单个资源是否启用；patterns=undefined → 默认全启用
const isPiResourceEnabled = (rel, patterns) => {
  if (!Array.isArray(patterns)) return true;
  if (patterns.length === 0) return false;
  const includes = [];
  const excludes = [];
  const forceIncludes = [];
  const forceExcludes = [];
  for (const raw of patterns) {
    const p = String(raw);
    if (p.startsWith("+")) forceIncludes.push(p.slice(1));
    else if (p.startsWith("-")) forceExcludes.push(p.slice(1));
    else if (p.startsWith("!")) excludes.push(p.slice(1));
    else includes.push(p);
  }
  let on = includes.length ? includes.some((p) => piWildcardHit(rel, p)) : true;
  if (on && excludes.some((p) => piWildcardHit(rel, p))) on = false;
  if (!on && forceIncludes.some((p) => piExactHit(rel, p))) on = true;
  if (on && forceExcludes.some((p) => piExactHit(rel, p))) on = false;
  return on;
};

// 枚举包内某类型全部资源（相对包根的 posix 路径）：manifest 声明优先（目录展开一层），其次扫常规目录
const collectPiPackageResources = (pkgDir, type) => {
  const out = new Set();
  try {
    const declared = readJson(path.join(pkgDir, "package.json"))?.pi?.[type];
    if (Array.isArray(declared) && declared.length) {
      for (const e of declared) {
        const rel = toPosixPath(e).replace(/^\.\//, "");
        if (!rel) continue;
        const abs = path.join(pkgDir, rel);
        let isDir = false;
        try {
          isDir = fs.statSync(abs).isDirectory();
        } catch {
          /* 声明了但磁盘缺失：仍列出，交给 pi 解析时忽略 */
        }
        if (!isDir) {
          out.add(rel);
          continue;
        }
        if (type === "skills") {
          for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
            if (d.isDirectory()) out.add(`${rel}/${d.name}`);
          }
        } else {
          const extRe = PI_RES_FILE_EXT[type] || PI_RES_FILE_EXT.extensions;
          for (const f of fs.readdirSync(abs)) {
            if (extRe.test(f)) out.add(`${rel}/${f}`);
          }
        }
      }
      return [...out];
    }
  } catch {
    /* fallthrough → 目录扫描 */
  }
  const dir = path.join(pkgDir, type);
  if (!fs.existsSync(dir)) return [];
  try {
    if (type === "skills") {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `skills/${d.name}`);
    }
    const extRe = PI_RES_FILE_EXT[type] || PI_RES_FILE_EXT.extensions;
    const walk = (abs, prefix, depth) => {
      if (depth > 3) return [];
      const res = [];
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
        const rel = `${prefix}/${ent.name}`;
        if (ent.isDirectory()) res.push(...walk(path.join(abs, ent.name), rel, depth + 1));
        else if (extRe.test(ent.name)) res.push(rel);
      }
      return res;
    };
    return walk(dir, type, 0);
  } catch {
    return [];
  }
};

// 已安装包的本地详情：元数据 + pi manifest + 逐资源启停状态
const getPiExtensionDetail = (source) => {
  try {
    const settings = readPiSettings();
    const entry = (Array.isArray(settings.packages) ? settings.packages : []).find(
      (e) => (typeof e === "string" ? e : (e && e.source) || "") === source,
    );
    if (!entry) return { success: false, message: `未找到包条目: ${source}` };
    const name = String(source).replace(/^npm:/, "");
    const pkgDir = path.join(PI_NPM_DIR(), ...String(source).replace("npm:", "").split("/"));
    const exists = fs.existsSync(pkgDir);
    const pkg = exists ? readJson(path.join(pkgDir, "package.json")) : null;
    const author =
      typeof pkg?.author === "string"
        ? pkg.author
        : (pkg?.author && pkg.author.name) || "";
    const repo = pkg?.repository;
    const repoUrl =
      typeof repo === "string"
        ? repo
        : (repo && repo.url) || "";

    // 逐资源状态：按 pi applyPatterns 语义计算
    const resources = {};
    for (const type of PI_RES_TYPES) {
      const patterns = typeof entry === "object" ? entry[type] : undefined;
      resources[type] = exists
        ? collectPiPackageResources(pkgDir, type).map((rel) => ({
            path: rel,
            enabled: isPiResourceEnabled(rel, patterns),
          }))
        : [];
    }
    const claudePlugin = exists
      ? readJson(path.join(pkgDir, ".claude-plugin", "plugin.json"))
      : null;
    const mcpServers = claudePlugin?.mcpServers
      ? Object.keys(claudePlugin.mcpServers)
      : [];

    return {
      success: true,
      data: {
        source,
        name,
        dir: exists ? pkgDir : "",
        version: pkg?.version || "",
        description: pkg?.description || "",
        author,
        license: pkg?.license || "",
        homepage: pkg?.homepage || "",
        repoUrl: String(repoUrl).replace(/^git\+/, ""),
        manifest: pkg?.pi || null,
        enabled: !isPiPackageEntryDisabled(entry),
        resources,
        mcpServers,
      },
    };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
};

// 单资源启停：写 packages 条目对应类型的过滤数组（Pi 下次启动生效）
// 启用：从 []（整包禁用）→ ["!*", "+x"]；否则移除 x 的禁用项，含 !* 时补 +x
// 禁用：无过滤 → ["-x"]；否则移除 x 的启用/包含项后追加 -x（[] 保持整包禁用不变）
const setPiPackageResourceEnabled = (source, type, relPath, enabled) => {
  try {
    if (!PI_RES_TYPES.includes(type)) {
      return { success: false, message: `不支持的资源类型: ${type}` };
    }
    const rel = toPosixPath(relPath).replace(/^\.\//, "");
    if (!rel) return { success: false, message: "资源路径为空" };
    const settings = readPiSettings();
    const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
    const idx = packages.findIndex(
      (e) => (typeof e === "string" ? e : (e && e.source) || "") === source,
    );
    if (idx === -1) return { success: false, message: `未找到包条目: ${source}` };
    const entry = packages[idx];
    const obj = typeof entry === "string" ? { source: entry } : { ...entry };
    const current = Array.isArray(obj[type]) ? obj[type].map(String) : undefined;
    const hits = (p) => piExactHit(rel, String(p).replace(/^[+!-]/, ""));
    let arr;
    if (enabled) {
      if (current === undefined) {
        return { success: true, message: "该资源已处于启用状态" };
      }
      if (current.length === 0) {
        arr = ["!*", `+${rel}`];
      } else {
        arr = current.filter(
          (p) => p !== `+${rel}` && !(hits(p) && (p.startsWith("-") || p.startsWith("!"))),
        );
        // 存在全排除标记时需显式强制启用；否则移除禁用项即恢复默认启用
        if (arr.some((p) => p.replace(/^[+!-]/, "") === "*")) arr.push(`+${rel}`);
      }
    } else {
      if (current !== undefined && current.length === 0) {
        return { success: true, message: "该资源已随整包禁用" };
      }
      arr = (current || []).filter(
        (p) => p !== `-${rel}` && !(hits(p) && !p.startsWith("-") && !p.startsWith("!")),
      );
      arr.push(`-${rel}`);
    }
    if (arr.length) obj[type] = arr;
    else delete obj[type];
    const hasFilters = PI_RES_TYPES.some((k) => obj[k] !== undefined);
    packages[idx] = hasFilters ? obj : obj.source;
    settings.packages = packages;
    writePiSettings(settings);
    return {
      success: true,
      message: enabled ? "已启用，Pi 下次启动生效" : "已禁用，Pi 下次启动生效",
    };
  } catch (e) {
    return { success: false, message: e && e.message ? e.message : String(e) };
  }
};

module.exports = {
  getPiExtensions,
  setPiExtensionEnabled,
  getPiExtensionDetail,
  setPiPackageResourceEnabled,
};
