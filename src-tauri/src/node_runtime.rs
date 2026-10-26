// Node 运行时探测（仅使用用户已安装的 Node，不内置）。
//
// GUI 应用从 Dock 启动时 PATH 极窄（launchd 只给 /usr/bin:/bin:/usr/sbin:/sbin），
// homebrew / nvm / fnm / volta / asdf 装的 node 全部不可见，因此必须显式按路径探测。
// 探测顺序（首个满足 >= 18 的胜出）见方案文档 §5.4。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const MIN_MAJOR: u32 = 18;

#[derive(Debug, Clone)]
pub struct NodeRuntime {
    pub path: PathBuf,
    pub version: String,
}

fn parse_version(v: &str) -> Option<(u32, u32, u32)> {
    let mut it = v.trim().split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = it
        .next()
        .map(|s| s.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("0"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Some((major, minor, patch))
}

fn read_node_version(path: &Path) -> Option<String> {
    let out = Command::new(path)
        .arg("-p")
        .arg("process.versions.node")
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// 校验一个候选路径：存在、可执行、版本 >= 18
fn validate(path: &Path) -> Option<NodeRuntime> {
    if !path.is_file() {
        return None;
    }
    let version = read_node_version(path)?;
    let (major, _, _) = parse_version(&version)?;
    if major < MIN_MAJOR {
        return None;
    }
    Some(NodeRuntime {
        path: path.to_path_buf(),
        version,
    })
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 列出目录下的子目录（不存在或不可读时返回空）
fn child_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                out.push(p);
            }
        }
    }
    out
}

/// 版本管理器目录：按 semver 降序挑最高的那个 node
fn from_version_managers() -> Vec<PathBuf> {
    let home = home();
    let mut candidates: Vec<(Option<(u32, u32, u32)>, PathBuf)> = Vec::new();

    // nvm: ~/.nvm/versions/node/v22.1.0/bin/node
    for dir in child_dirs(&home.join(".nvm/versions/node")) {
        let ver = dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.trim_start_matches('v'))
            .and_then(parse_version);
        candidates.push((ver, dir.join("bin/node")));
    }

    // fnm: ~/.local/share/fnm/node-versions/v22.1.0/installation/bin/node
    for dir in child_dirs(&home.join(".local/share/fnm/node-versions")) {
        let ver = dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.trim_start_matches('v'))
            .and_then(parse_version);
        candidates.push((ver, dir.join("installation/bin/node")));
    }

    // asdf: ~/.asdf/installs/nodejs/22.1.0/bin/node
    for dir in child_dirs(&home.join(".asdf/installs/nodejs")) {
        let ver = dir.file_name().and_then(|n| n.to_str()).and_then(parse_version);
        candidates.push((ver, dir.join("bin/node")));
    }

    // n: /usr/local/n/versions/node/22.1.0/bin/node
    for dir in child_dirs(Path::new("/usr/local/n/versions/node")) {
        let ver = dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.trim_start_matches('v'))
            .and_then(parse_version);
        candidates.push((ver, dir.join("bin/node")));
    }

    // volta 是固定路径
    candidates.push((None, home.join(".volta/bin/node")));

    // 有版本号的按降序在前，无版本号的（volta）排最后
    candidates.sort_by(|a, b| match (a.0, b.0) {
        (Some(x), Some(y)) => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    candidates.into_iter().map(|(_, p)| p).collect()
}

/// 登录 shell 兜底：会执行用户的 rc 文件，因此必须限时且只取最后一行
fn from_login_shell() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = Command::new(&shell)
        .arg("-l")
        .arg("-c")
        .arg("command -v node")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut buf = String::new();
                child.stdout.take()?.read_to_string(&mut buf).ok()?;
                let line = buf.lines().rev().find(|l| !l.trim().is_empty())?.trim();
                return Some(PathBuf::from(line));
            }
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(3) {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

fn cache_file() -> PathBuf {
    home().join(".ccconfig").join("runtime.json")
}

fn read_cache() -> Option<PathBuf> {
    let raw = fs::read_to_string(cache_file()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("nodePath")?.as_str().map(PathBuf::from)
}

fn write_cache(path: &Path) {
    let target = cache_file();
    if let Some(dir) = target.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let payload = serde_json::json!({ "nodePath": path.to_string_lossy() });
    let _ = fs::write(target, payload.to_string());
}

/// 改名前的 Node 路径环境变量（CCCONFIG_NODE 未设时作回退）
const LEGACY_NODE_ENV: &str = "CCSWITCH_NODE";

/// 按探测链找到可用的 Node。返回探测过程中尝试过的路径，供失败页展示。
pub fn detect() -> (Option<NodeRuntime>, Vec<String>) {
    let mut tried: Vec<String> = Vec::new();

    // 1. 环境变量（CCCONFIG_NODE 优先，兼容改名前的旧变量名）
    let env_node = std::env::var_os("CCCONFIG_NODE").or_else(|| std::env::var_os(LEGACY_NODE_ENV));
    if let Some(p) = env_node {
        let path = PathBuf::from(p);
        tried.push(format!("$CCCONFIG_NODE = {}", path.display()));
        if let Some(rt) = validate(&path) {
            write_cache(&rt.path);
            return (Some(rt), tried);
        }
    }

    // 2. 上次成功路径
    if let Some(path) = read_cache() {
        tried.push(format!("cache = {}", path.display()));
        if let Some(rt) = validate(&path) {
            return (Some(rt), tried);
        }
    }

    // 3. 固定绝对路径
    let fixed = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for p in fixed {
        let path = PathBuf::from(p);
        tried.push(p.to_string());
        if let Some(rt) = validate(&path) {
            write_cache(&rt.path);
            return (Some(rt), tried);
        }
    }

    // 4. 版本管理器
    for path in from_version_managers() {
        tried.push(path.display().to_string());
        if let Some(rt) = validate(&path) {
            write_cache(&rt.path);
            return (Some(rt), tried);
        }
    }

    // 5. 登录 shell
    tried.push("$SHELL -l -c 'command -v node'".to_string());
    if let Some(path) = from_login_shell() {
        if let Some(rt) = validate(&path) {
            write_cache(&rt.path);
            return (Some(rt), tried);
        }
    }

    (None, tried)
}
