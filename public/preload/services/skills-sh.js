// skills.sh 安装：接受技能详情页链接或 `npx skills add` 命令，调用官方 CLI 安装到 ~/.agents/skills。
// 站点是 Next.js RSC 渲染，安装命令藏在 self.__next_f.push 的字符串载荷里，这里按载荷解析，不依赖 DOM。
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawn } = require("node:child_process");

const common = require("./common");
const { t } = require("./i18n");
const { isDirEntry } = require("./fs-utils");

const MARKET_SITE = "https://www.skills.sh";
const DETAIL_TTL = 30 * 60 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// 官方 CLI 要求 Node.js >= 22.20.0（见 skills 包 engines 字段）
const MIN_NODE_VERSION = "22.20.0";
// 固定 CLI 版本：-a zed 的全局目录在 1.7.4 是 ~/.agents/skills，
// 升级前需重新确认该映射，避免把文件写到别的 Agent 目录。
const SKILLS_CLI_VERSION = "1.7.4";
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
// 官方 CLI 中 zed 的全局目录就是 ~/.agents/skills；配合 --copy 只写这一处，
// 不会在 ~/.zed 等其它 Agent 目录留下软链接。
const MARKET_AGENT_ID = "zed";

const _detailCache = new Map();
let _nodeRuntimeOk = false;

// ==================== HTTP ====================

// GET 文本（跟随重定向、带超时）；站点只走 https
function _getText(url, { headers = {}, timeout = 20000, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error(t("service.skill.tooManyRedirects")));
    const req = https.get(
      url,
      { headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          const location = res.headers.location;
          if (!location) return reject(new Error(t("service.skill.redirectMissingLocation")));
          const next = new URL(location, url).toString();
          return _getText(next, { headers, timeout, redirects: redirects + 1 }).then(
            resolve,
            reject,
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(t("service.skill.requestFailed", { status: res.statusCode })));
        }
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error(t("service.skill.skillsSh.timeout")));
    });
  });
}

// ==================== 站点解析 ====================

// Next.js RSC：self.__next_f.push([1,"<转义后的字符串>"])，逐段按 JSON 字符串解码后拼接
function _decodeFlight(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch (e) {
      /* 单段损坏不影响其它段 */
    }
  }
  return chunks.join("\n");
}

const _jsonString = (raw) => {
  try {
    return JSON.parse(`"${raw}"`);
  } catch (e) {
    return raw;
  }
};

// owner/repo 形态 = GitHub 仓库来源；其余是站点来源（open.feishu.cn 等），详情页路径不同。
const _isGithubSource = (source) =>
  /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(source || ""));

const _detailUrl = (source, skillId) =>
  _isGithubSource(source)
    ? `${MARKET_SITE}/${source}/${encodeURIComponent(skillId)}`
    : `${MARKET_SITE}/site/${encodeURIComponent(source)}/${encodeURIComponent(skillId)}`;

// 详情页：ld+json 提供名称/简介，载荷提供安装命令
function _parseDetailPage(html, { source, skillId }) {
  const flight = _decodeFlight(html);
  let meta = null;
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && parsed["@type"] === "SoftwareApplication") {
        meta = parsed;
        break;
      }
    } catch (e) {
      /* 跳过坏块 */
    }
  }

  const commandMatch = flight.match(
    /"command":"((?:[^"\\]|\\.)*?npx skills add(?:[^"\\]|\\.)*?)"/i,
  );
  return {
    source,
    skillId,
    name: meta?.name || skillId,
    description: typeof meta?.description === "string" ? meta.description : "",
    installCommand: commandMatch ? _jsonString(commandMatch[1]) : "",
    url: typeof meta?.url === "string" && meta.url ? meta.url : _detailUrl(source, skillId),
  };
}

// 安装命令：npx skills add <target> [--skill <name>]（引号可省略，允许 -y / skills@版本）
function _parseInstallCommand(command) {
  const text = String(command || "");
  const match = text.match(
    /(?:^|\s)npx\s+(?:(?:-y|--yes)\s+)?skills(?:@[^\s]+)?\s+add\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i,
  );
  if (!match) return null;
  const target = (match[1] || match[2] || match[3] || "").trim();
  const skillMatch = text.match(/--skill\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const skill = skillMatch
    ? (skillMatch[1] || skillMatch[2] || skillMatch[3] || "").trim()
    : "";
  if (!/^https?:\/\//i.test(target) && !_isGithubSource(target)) return null;
  return { target, skill, command: text.trim() };
}

// skills.sh 详情页：/owner/repo/skillId 或 /site/<source>/<skillId>
const _safeDecode = (part) => {
  try {
    return decodeURIComponent(part);
  } catch (e) {
    return part;
  }
};

function _parseSkillsShUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input || "").trim());
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol) || !/^(?:www\.)?skills\.sh$/i.test(parsed.hostname)) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean).map(_safeDecode);
  if (parts[0] === "site" && parts.length >= 3) {
    return { source: parts[1], skillId: parts.slice(2).join("/"), url: parsed.toString() };
  }
  if (parts.length >= 3) {
    return { source: `${parts[0]}/${parts[1]}`, skillId: parts.slice(2).join("/"), url: parsed.toString() };
  }
  return null;
}

// 弹窗输入是否属于 skills.sh 安装（详情页链接或 npx 命令）
function isSkillsShInput(input) {
  return !!(_parseSkillsShUrl(input) || _parseInstallCommand(input));
}

// ==================== 安装计划 ====================

const _normalizeTarget = (target) =>
  _isGithubSource(target) ? `https://github.com/${target.replace(/\.git$/, "")}` : target;

const _sourceLabel = (target) => {
  try {
    const parsed = new URL(target);
    if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
      const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
      if (owner && repo) return `${owner}/${repo.replace(/\.git$/, "")}`;
    }
    return parsed.hostname;
  } catch (e) {
    return String(target || "");
  }
};

// 命令参数会拼进 Windows 的 cmd 行；这些字符在两种 shell 下都不安全，直接拒绝
const UNSAFE_ARG_RE = /["'`$&|;<>()%!^\\\r\n\t]/;

const _assertSafeTarget = (target) => {
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    throw new Error(t("service.skill.skillsSh.invalidInstallTarget"));
  }
  if (!/^https?:$/.test(parsed.protocol) || UNSAFE_ARG_RE.test(target)) {
    throw new Error(t("service.skill.skillsSh.invalidInstallTarget"));
  }
  return target;
};

const _assertSafeSkillName = (skill) => {
  if (!skill || UNSAFE_ARG_RE.test(skill)) {
    throw new Error(t("service.skill.skillsSh.invalidSkillName"));
  }
  return skill;
};

function _planFromCommand(parsed) {
  const target = _normalizeTarget(parsed.target);
  _assertSafeTarget(target);
  if (parsed.skill) _assertSafeSkillName(parsed.skill);
  return {
    target,
    skill: parsed.skill,
    name: parsed.skill || _sourceLabel(target),
    sourceLabel: _sourceLabel(target),
    installCommand: parsed.command,
  };
}

async function _fetchDetail(source, skillId, url) {
  const key = `${source}/${skillId}`;
  const cached = _detailCache.get(key);
  if (cached && Date.now() - cached.at < DETAIL_TTL) return cached.data;
  const html = await _getText(url || _detailUrl(source, skillId), { timeout: 30000 });
  const data = _parseDetailPage(html, { source, skillId });
  _detailCache.set(key, { at: Date.now(), data });
  return data;
}

// 详情页 → 安装计划：优先用站点给的权威命令；抓不到命令时 GitHub 来源按 owner/repo 兜底。
async function _planFromDetail(ref) {
  let detail = null;
  let fetchError = null;
  try {
    detail = await _fetchDetail(ref.source, ref.skillId, ref.url);
  } catch (e) {
    fetchError = e;
  }

  const parsed = detail && _parseInstallCommand(detail.installCommand);
  if (parsed) {
    const plan = _planFromCommand(parsed);
    return {
      ...plan,
      name: detail.name || plan.name,
      description: detail.description || "",
      detailUrl: detail.url,
    };
  }

  if (_isGithubSource(ref.source)) {
    const target = `https://github.com/${ref.source}`;
    return {
      target,
      skill: ref.skillId,
      name: detail?.name || ref.skillId,
      description: detail?.description || "",
      sourceLabel: ref.source,
      installCommand: `npx skills add ${target} --skill ${ref.skillId}`,
      detailUrl: _detailUrl(ref.source, ref.skillId),
    };
  }

  if (fetchError) throw fetchError;
  throw new Error(t("service.skill.skillsSh.sourceUnsupported", { source: ref.source }));
}

async function _resolvePlan(input) {
  const parsed = _parseInstallCommand(input);
  if (parsed) return _planFromCommand(parsed);
  const ref = _parseSkillsShUrl(input);
  if (!ref) throw new Error(t("service.skill.skillsSh.invalidInput"));
  return _planFromDetail(ref);
}

// ==================== 安装：官方 npx ====================

const _sanitizeSkillName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .substring(0, 255) || "unnamed-skill";

function _parseNodeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// 与 CLI 的 engines 一致：>= 22.20.0
function _isNodeSupported(value) {
  const version = _parseNodeVersion(value);
  if (!version) return false;
  const required = MIN_NODE_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== required[i]) return version[i] > required[i];
  }
  return true;
}

// npx 参数：非交互、全局、只写 ~/.agents/skills（zed 的全局目录）、复制而非软链。
// 命令里没有 --skill 时交给 CLI 安装仓库内的全部 Skill。
function _buildNpxArgs({ target, skill }) {
  const args = ["-y", `skills@${SKILLS_CLI_VERSION}`, "add", target];
  if (skill) args.push("--skill", skill);
  args.push("-g", "-a", MARKET_AGENT_ID, "--copy", "-y");
  return args;
}

const _npxWorkDir = () =>
  path.join(window.utools.getPath("temp"), "ccconfig-skill-market");

const _cleanupWorkDir = () => {
  try {
    if (fs.existsSync(_npxWorkDir())) fs.rmSync(_npxWorkDir(), { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
};

function _npxEnv() {
  const env = {
    ...process.env,
    // 官方 CLI 默认上报匿名安装遥测；应用内安装一律关闭
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    CI: "1",
    NO_COLOR: "1",
    npm_config_yes: "true",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  // 桌面版 sidecar 的 Node 可能是 Rust 用绝对路径启动的，PATH 里未必有它所在的 bin 目录；
  // 补上后 npx / node 的版本探测才会命中同一个 Node。
  const execDir = path.dirname(process.execPath);
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const current = env[pathKey] || env.PATH || "";
  env[pathKey] = current ? `${execDir}${path.delimiter}${current}` : execDir;
  if (process.platform === "win32") env.PATH = env[pathKey];
  return env;
}

const _quoteWinArg = (arg) => `"${String(arg).replace(/"/g, '""')}"`;

// 执行子进程并收集输出；Windows 上 .cmd 必须经 cmd.exe 启动
function _spawnCapture(command, args, { cwd, env, timeout = 15000, viaCmd = false } = {}) {
  return new Promise((resolve, reject) => {
    const options = { cwd, env: env || process.env, windowsHide: true };
    let child;
    try {
      if (viaCmd) {
        // 命令本身不加引号（npx.cmd 无空格），参数逐个加引号，避开 cmd /s 的引号剥离规则
        const line = [command, ...args.map(_quoteWinArg)].join(" ");
        child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], options);
      } else {
        child = spawn(command, args, options);
      }
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current, chunk) => (current.length < 200000 ? current + chunk : current);

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (e) {
        /* ignore */
      }
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(t("service.skill.skillsSh.installTimeout")));
      resolve({ code: typeof code === "number" ? code : 1, signal, stdout, stderr });
    });
  });
}

// 启动 npx 前确认 PATH 上的 Node 满足官方 CLI 的 engines 要求
async function _ensureNodeRuntime() {
  if (_nodeRuntimeOk) return;
  let versionText = "";
  try {
    const result = await _spawnCapture("node", ["--version"], {
      env: _npxEnv(),
      timeout: 15000,
    });
    versionText = String(result.stdout || "").trim();
    if (result.code !== 0 || !versionText) throw new Error("node --version failed");
  } catch (e) {
    throw new Error(t("service.skill.skillsSh.nodeMissing", { required: MIN_NODE_VERSION }));
  }
  if (!_isNodeSupported(versionText)) {
    throw new Error(
      t("service.skill.skillsSh.nodeTooOld", {
        required: MIN_NODE_VERSION,
        version: versionText,
      }),
    );
  }
  _nodeRuntimeOk = true;
}

async function _runNpx(args, cwd) {
  const viaCmd = process.platform === "win32";
  try {
    return await _spawnCapture(viaCmd ? "npx.cmd" : "npx", args, {
      cwd,
      env: _npxEnv(),
      timeout: INSTALL_TIMEOUT_MS,
      viaCmd,
    });
  } catch (e) {
    if (e && e.code === "ENOENT") {
      throw new Error(t("service.skill.skillsSh.npxMissing", { required: MIN_NODE_VERSION }));
    }
    throw e;
  }
}

const _outputTail = (result) => {
  const text = `${(result && result.stderr) || ""}\n${(result && result.stdout) || ""}`
    .trim()
    .replace(/\s+/g, " ");
  return text.slice(-600) || t("service.skill.skillsSh.npxUnknownError");
};

const _listSkillDirs = (base) => {
  const names = new Set();
  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (isDirEntry(base, entry)) names.add(entry.name);
    }
  } catch (e) {
    /* 目录不存在按空处理 */
  }
  return names;
};

// 安装结果：优先校验命令里指定的名称；目录名与预期不一致时用安装前后新增的目录兜底，
// 命令没带 --skill 时则直接返回新增的全部 Skill 目录。
function _collectInstalled(base, expected, before) {
  const hasSkillMd = (name) => fs.existsSync(path.join(base, name, "SKILL.md"));
  if (expected && hasSkillMd(expected)) return [expected];
  return [..._listSkillDirs(base)].filter((name) => !before.has(name) && hasSkillMd(name));
}

// ==================== 对外接口 ====================

// 弹窗预览：解析输入并返回名称 / 来源 / 安装命令；不可安装的输入直接抛错。
async function fetchSkillsShInfo(input) {
  const plan = await _resolvePlan(input);
  return {
    source: "skills-sh",
    displayName: plan.name,
    summary: plan.description || "",
    sourceLabel: plan.sourceLabel,
    installCommand: plan.installCommand,
    installTarget: plan.target,
    detailUrl: plan.detailUrl || "",
  };
}

// 通过官方 CLI 安装到 ~/.agents/skills（= zed 的全局目录）。
// overwrite=false 且目标目录已存在时返回 { exists: true }，由界面确认后再装。
async function installCommonSkillFromSkillsSh(input, overwrite = false) {
  const plan = await _resolvePlan(input);
  _assertSafeTarget(plan.target);
  if (plan.skill) _assertSafeSkillName(plan.skill);
  const skillName = plan.skill ? _sanitizeSkillName(plan.skill) : "";
  await _ensureNodeRuntime();

  const base = common.COMMON_SKILLS_DIR();
  fs.mkdirSync(base, { recursive: true });
  if (skillName) {
    const targetDir = path.join(base, skillName);
    if (fs.existsSync(targetDir) && !overwrite) {
      return { exists: true, skillName, targetDir };
    }
  }

  const before = _listSkillDirs(base);
  const cwd = _npxWorkDir();
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const result = await _runNpx(_buildNpxArgs({ target: plan.target, skill: plan.skill }), cwd);
    if (result.code !== 0) {
      throw new Error(t("service.skill.skillsSh.npxFailed", { message: _outputTail(result) }));
    }

    const installedNames = _collectInstalled(base, skillName, before);
    if (!installedNames.length) {
      throw new Error(
        t("service.skill.skillsSh.installDirMissing", { name: skillName || plan.target }),
      );
    }

    // 当前有生效场景时，新装的 Skill 也遵守白名单（未绑定则立即禁用）
    try {
      common.enforceActiveSkillScene();
    } catch (e) {
      console.error("[skill-scene] 安装后应用场景失败:", e);
    }

    return {
      success: true,
      skillName: installedNames.join(", "),
      skillDirs: installedNames.map((name) => path.join(base, name)),
    };
  } finally {
    _cleanupWorkDir();
  }
}

module.exports = {
  fetchSkillsShInfo,
  installCommonSkillFromSkillsSh,
  isSkillsShInput,
  // 解析 / 版本判断导出给冒烟测试
  _parseSkillsShUrl,
  _parseInstallCommand,
  _parseDetailPage,
  _decodeFlight,
  _detailUrl,
  _sanitizeSkillName,
  _buildNpxArgs,
  _isNodeSupported,
  _parseNodeVersion,
};
