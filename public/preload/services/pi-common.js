// pi 公共层：路径发现、执行环境兜底（uTools 精简 PATH）、pi CLI 调用与 settings.json 读写。
// 被 pi.js（模型/技能/MCP/统计）与 pi-extensions / pi-package-detail 共用。
const fs = require("node:fs");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");

const PI_DIR = () => path.join(require("os").homedir(), ".pi", "agent");
const PI_SETTINGS_PATH = () => path.join(PI_DIR(), "settings.json");
const PI_NPM_DIR = () => path.join(PI_DIR(), "npm", "node_modules");
const PI_CMD_TIMEOUT = { list: 15_000, install: 120_000, default: 30_000 };

// ==================== 路径发现 ====================

const resolvePiPath = () => {
  const candidates = [
    path.join(require("os").homedir(), ".local", "bin", "pi"),
    path.join(require("os").homedir(), ".npm-global", "bin", "pi"),
    path.join(require("os").homedir(), ".bun", "bin", "pi"),
    path.join(
      require("os").homedir(),
      ".bun",
      "install",
      "global",
      "bin",
      "pi",
    ),
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  try {
    const which = execSync("where pi 2>nul", {
      encoding: "utf-8",
      timeout: 5000,
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const w of which) {
      // 优先用 .cmd — 自带 node.exe 查找逻辑
      if (w.toLowerCase().endsWith(".cmd")) return w;
    }
    // .ps1 → 转换为 node.exe + cli.js 直调
    for (const w of which) {
      if (w.toLowerCase().endsWith(".ps1")) {
        const basedir = path.dirname(w);
        const cliPath = path.join(
          basedir,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "cli.js",
        );
        if (!fs.existsSync(cliPath)) continue;
        const localNode = path.join(basedir, "node.exe");
        if (fs.existsSync(localNode)) return `${localNode}|${cliPath}`;
        try {
          const pathNode = execSync("where node 2>nul", {
            encoding: "utf-8",
            timeout: 5000,
          })
            .trim()
            .split("\n")[0];
          if (pathNode && fs.existsSync(pathNode))
            return `${pathNode}|${cliPath}`;
        } catch {
          /* ignore */
        }
      }
    }
    // 没扩展名的 pi（shell script）→ 直接用，cmd.exe 会通过 PATHEXT 解析
    if (which.length > 0) return which[0];
  } catch {
    /* ignore */
  }
  return "pi";
};

const readJson = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, { encoding: "utf-8" }));
  } catch {
    return null;
  }
};

const writeJson = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
  });
};

// ==================== 执行环境（uTools PATH 精简兜底） ====================

// uTools 从 Dock/Finder 启动时子进程 PATH 很精简（如 /usr/bin:/bin:/usr/sbin:/sbin），
// 而 pi 入口脚本 shebang 是 #!/usr/bin/env node，内部还会调 bun/npm 装包管理器。
// 这里把常见 bin 目录补进 PATH，保证 env node / env bun / env npm 都能解析到。

const getExtraPathDirs = () => {
  const home = require("os").homedir();
  const dirs = [
    path.join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".fnm", "aliases", "default", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".nix-profile", "bin"),
  ];
  // nvm 各版本 node
  try {
    const nvmRoot = path.join(home, ".nvm", "versions", "node");
    if (fs.existsSync(nvmRoot)) {
      for (const v of fs.readdirSync(nvmRoot))
        dirs.push(path.join(nvmRoot, v, "bin"));
    }
  } catch {
    /* ignore */
  }
  if (process.platform === "win32") dirs.push(...getWindowsPathDirs());
  return dirs;
};

// Windows：uTools 进程环境可能过时/精简（如装完 node 未重启 uTools），
// pi 内部 spawn npm 报 ENOENT（'npm' is not recognized...）。直接按磁盘位置补全 node/npm 目录。
const getWindowsPathDirs = () => {
  const home = require("os").homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const dirs = [
    path.join(appData, "npm"),                              // npm 全局安装目录（pi.cmd 等 shim）
    "C:\\Program Files\\nodejs",                            // node 官方安装器（npm.cmd 与 node.exe 同目录）
    path.join(localAppData, "Programs", "nodejs"),          // node 按用户安装
    path.join(localAppData, "Volta", "bin"),                // volta
    path.join(home, "scoop", "shims"),                      // scoop
  ];
  if (process.env.NVM_SYMLINK) dirs.push(process.env.NVM_SYMLINK); // nvm-windows 符号链接目录
  if (process.env.NVM_HOME) dirs.push(process.env.NVM_HOME);
  // nvm-windows 各版本目录
  try {
    const nvmHome = process.env.NVM_HOME || path.join(appData, "nvm");
    if (fs.existsSync(nvmHome)) {
      for (const v of fs.readdirSync(nvmHome))
        if (/^v?\d/.test(v)) dirs.push(path.join(nvmHome, v));
    }
  } catch {
    /* ignore */
  }
  // PATH 可用时直接取 node / npm 所在目录
  for (const tool of ["node", "npm"]) {
    try {
      const p = execSync(`where ${tool} 2>nul`, {
        encoding: "utf-8",
        timeout: 5000,
      })
        .trim()
        .split(/\r?\n/)[0]
        .trim();
      if (p) dirs.push(path.dirname(p));
    } catch {
      /* ignore */
    }
  }
  // pi 入口自身目录（npm 全局安装的 pi.cmd 与全局 shim 同目录）
  try {
    const piBin = resolvePiPath();
    if (piBin && !piBin.includes("|") && /\.(cmd|bat|exe)$/i.test(piBin))
      dirs.push(path.dirname(piBin));
  } catch {
    /* ignore */
  }
  return dirs;
};

const buildPiEnv = () => {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const extra = getExtraPathDirs().filter((d) => {
    try {
      return fs.existsSync(d);
    } catch {
      return false;
    }
  });
  if (extra.length) {
    // Windows 系统变量为 Path（大小写不敏感），合并到已有键，避免 PATH/Path 双键并存导致子进程取值不稳
    const pathKey =
      Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
    for (const k of Object.keys(env))
      if (k.toLowerCase() === "path" && k !== pathKey) delete env[k];
    env[pathKey] = [...extra, env[pathKey] || ""].join(path.delimiter);
  }
  return env;
};

// 查找解释器绝对路径（node / bun），用于绕过 shebang 的 env 解析
const resolveInterpreter = (name) => {
  const home = require("os").homedir();
  const candidates =
    name === "bun"
      ? [
          path.join(home, ".bun", "bin", "bun"),
          "/usr/local/bin/bun",
          "/opt/homebrew/bin/bun",
        ]
      : [
          "/usr/local/bin/node",
          "/opt/homebrew/bin/node",
          path.join(home, ".volta", "bin", "node"),
          path.join(home, ".fnm", "aliases", "default", "bin", "node"),
        ];
  if (name === "node") {
    try {
      const nvmRoot = path.join(home, ".nvm", "versions", "node");
      if (fs.existsSync(nvmRoot)) {
        const vers = fs.readdirSync(nvmRoot).sort();
        for (const v of vers)
          candidates.push(path.join(nvmRoot, v, "bin", "node"));
      }
    } catch {
      /* ignore */
    }
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
};

// 解析 pi 真实入口：symlink 指向 node/bun 脚本时，直接以解释器绝对路径启动，
// 避免精简 PATH 下 #!/usr/bin/env node 找不到解释器（env: node: No such file or directory）
const resolvePiInvocation = (piBin) => {
  if (piBin.includes("|")) return piBin;
  try {
    const real = fs.realpathSync(piBin);
    if (!real || real === piBin) return piBin;
    const head = fs.readFileSync(real, { encoding: "utf-8" }).slice(0, 200);
    const m = head.match(/^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+)?(\S+)/);
    if (!m) return piBin;
    const interp = m[1];
    if (interp.startsWith("/")) return `${interp}|${real}`;
    const exe = resolveInterpreter(interp);
    if (!exe) return piBin;
    return `${exe}|${real}`;
  } catch {
    return piBin;
  }
};

const runPiCmd = (args, timeout) =>
  new Promise((resolve) => {
    const env = buildPiEnv();
    const ms = timeout || PI_CMD_TIMEOUT.default;
    const invocation = resolvePiInvocation(resolvePiPath());

    let command, spawnArgs;
    if (invocation.includes("|")) {
      const [exe, cliPath] = invocation.split("|");
      command = exe;
      spawnArgs = [cliPath, ...args];
    } else {
      command = invocation;
      spawnArgs = args;
    }

    const child = spawn(command, spawnArgs, {
      env,
      shell: true,
      windowsHide: true,
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        success: false,
        stdout: stdout.trim(),
        stderr: `timeout after ${ms}ms`,
      });
    }, ms);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0)
        resolve({
          success: true,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      else
        resolve({
          success: false,
          stdout: stdout.trim(),
          stderr: stderr.trim() || `exit code ${code}`,
        });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, stdout: stdout.trim(), stderr: err.message });
    });
  });

// ==================== Settings ====================

const readPiSettings = () => readJson(PI_SETTINGS_PATH()) || {};
const writePiSettings = (data) => writeJson(PI_SETTINGS_PATH(), data);

module.exports = {
  PI_DIR,
  PI_NPM_DIR,
  PI_CMD_TIMEOUT,
  resolvePiPath,
  readJson,
  writeJson,
  buildPiEnv,
  runPiCmd,
  readPiSettings,
  writePiSettings,
};
