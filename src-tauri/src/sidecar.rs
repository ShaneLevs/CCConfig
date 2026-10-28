// sidecar 进程管理：启动 Node、取回端口、健康检查、优雅退出。

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

pub struct Sidecar {
    child: Child,
    pub port: u16,
    pub token: String,
    pub log_path: PathBuf,
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    if let Ok(mut f) = File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    // 兜底：时间戳混淆（仅本地回环校验用途，强度要求不高）
    format!("{:x}{:x}", std::process::id(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0))
}

fn log_dir() -> PathBuf {
    crate::data_dir().join("logs")
}

fn open_log() -> Result<(File, PathBuf), String> {
    let dir = log_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    let path = dir.join("sidecar.log");
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > LOG_MAX_BYTES {
            let _ = fs::rename(&path, dir.join("sidecar.log.1"));
        }
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志文件失败: {e}"))?;
    // 日志里会出现用户目录与配置路径，收紧为仅本人可读
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok((file, path))
}

/// 从 sidecar stdout 读取端口行，带超时；进程提前退出时返回尾部日志
fn wait_for_port(child: &mut Child) -> Result<u16, String> {
    let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;
    let (tx, rx) = mpsc::channel::<std::io::Result<String>>();

    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader.read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
    });

    match rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(line)) => {
            let port = line
                .trim()
                .strip_prefix("CCCONFIG_SIDECAR_PORT=")
                .and_then(|s| s.trim().parse::<u16>().ok());
            port.ok_or_else(|| {
                let code = child.try_wait().ok().flatten().and_then(|s| s.code());
                format!(
                    "sidecar 未输出合法端口（退出码 {:?}，输出 {:?}），请查看日志 {}",
                    code,
                    line.trim(),
                    log_dir().join("sidecar.log").display()
                )
            })
        }
        Ok(Err(e)) => {
            let _ = child.kill();
            Err(format!("读取 sidecar 输出失败: {e}"))
        }
        Err(_) => {
            let _ = child.kill();
            Err(format!(
                "sidecar 启动超时（{}s），请查看日志 {}",
                START_TIMEOUT.as_secs(),
                log_dir().join("sidecar.log").display()
            ))
        }
    }
}

/// 纯 TCP + HTTP/1.0 探活，不引入额外依赖
pub fn health_ok(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let req = "GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n";
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    if stream.read_to_string(&mut buf).is_err() {
        return false;
    }
    buf.contains("\"ok\":true")
}

impl Sidecar {
    pub fn start(node: &Path, script_dir: &Path, data_dir: Option<&Path>) -> Result<Sidecar, String> {
        let server_js = script_dir.join("server.js");
        if !server_js.is_file() {
            return Err(format!("找不到 sidecar 入口: {}", server_js.display()));
        }
        let (log_file, log_path) = open_log()?;
        let token = random_token();

        let mut cmd = Command::new(node);
        cmd.arg(&server_js)
            .arg("--port")
            .arg("0")
            .arg("--token")
            .arg(&token)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .current_dir(script_dir)
            // 用户全局注入的 --require / --inspect 会干扰 sidecar
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log_file));

        if let Some(dir) = data_dir {
            cmd.arg("--data-dir").arg(dir);
        }

        // debug 构建打开 RPC 方法名日志，便于排查前端调用链路
        if cfg!(debug_assertions) {
            cmd.arg("--verbose");
        }

        // Windows GUI 进程 spawn 控制台程序默认会弹黑窗
        crate::node_runtime::hide_console(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 sidecar 失败（{}）: {e}", node.display()))?;

        let port = wait_for_port(&mut child)?;

        // 端口已 listen，再确认一次 HTTP 层可用
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            if health_ok(port) {
                return Ok(Sidecar {
                    child,
                    port,
                    token,
                    log_path,
                });
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("sidecar 在健康检查前退出（{status}）"));
            }
            std::thread::sleep(Duration::from_millis(120));
        }

        let _ = child.kill();
        Err(format!(
            "sidecar 健康检查超时，请查看日志 {}",
            log_path.display()
        ))
    }

    /// 先请求 /shutdown 让其落盘，再等待退出，超时强杀
    pub fn stop(&mut self) {
        let addr = SocketAddr::from(([127, 0, 0, 1], self.port));
        if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let req = format!(
                "POST /shutdown HTTP/1.0\r\nHost: 127.0.0.1\r\nX-CCConfig-Token: {}\r\nContent-Length: 0\r\n\r\n",
                self.token
            );
            let _ = stream.write_all(req.as_bytes());
        }

        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(3) {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
