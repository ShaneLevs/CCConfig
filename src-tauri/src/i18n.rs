// 桌面版原生文案（托盘菜单 / 引导页标题）。
// 与前端共用 shared/i18n/<locale>/native.json，用 include_str! 在编译期内联，无需复制资源。
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Locale {
    Zh,
    En,
}

const ZH_NATIVE: &str = include_str!("../../shared/i18n/zh-CN/native.json");
const EN_NATIVE: &str = include_str!("../../shared/i18n/en-US/native.json");

/// 系统语言：macOS `defaults read -g AppleLanguages` 的第一项。
/// Dock 启动时没有 LANG/LC_ALL，不能依赖环境变量。
pub fn system_locale() -> Locale {
    let output = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLanguages"])
        .output();
    let Ok(output) = output else {
        return Locale::Zh;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    // 输出形如：(\n    "zh-Hans-CN",\n    "en-US"\n)
    for line in text.lines() {
        let line = line.trim().trim_matches(|c| c == ',' || c == '(' || c == ')' || c == '"');
        if line.is_empty() || line == "(" || line == ")" {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("zh") {
            return Locale::Zh;
        }
        if lower.starts_with("en") {
            return Locale::En;
        }
        // 其他语言：英文作为回退
        return Locale::En;
    }
    Locale::Zh
}

/// 显式偏好（DB 里的 ccswitch_locale）→ Locale；'system' / 缺失 / 未知值返回 None
pub fn from_preference(value: Option<&str>) -> Option<Locale> {
    match value {
        Some("zh-CN") => Some(Locale::Zh),
        Some("en-US") => Some(Locale::En),
        _ => None,
    }
}

/// 取 native.json 里的子树（引导页整块文案注入用）。
/// 文件根节点是命名空间 "native"（与前端 i18n 的约定一致），因此路径直接写
/// ["tray", "quit"] / ["guide"]，不必再带上根节点名。
pub fn native_value(locale: Locale, path: &[&str]) -> Value {
    let raw = match locale {
        Locale::Zh => ZH_NATIVE,
        Locale::En => EN_NATIVE,
    };
    let root: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let mut node = match root.get("native") {
        Some(next) => next.clone(),
        None => return Value::Null,
    };
    for key in path {
        node = match node.get(*key) {
            Some(next) => next.clone(),
            None => {
                // 缺失 key 曾导致托盘菜单全空（菜单被压成一条缝），这里留声便于排查
                eprintln!("[i18n] native.json 缺少 key: {}", path.join("."));
                return Value::Null;
            }
        };
    }
    node
}

/// 取 native.json 里的字符串；路径不存在时返回空串（调用方应始终用存在的 key）
pub fn native(locale: Locale, path: &[&str]) -> String {
    native_value(locale, path)
        .as_str()
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 托盘菜单逐项取文案，缺一个该行就会变成空字符串（菜单会被压到看不见）
    const TRAY_KEYS: &[&str] = &[
        "gatewayDisabled",
        "gatewayPortBusy",
        "gatewayRunning",
        "requests",
        "successRate",
        "tokens",
        "cacheHitRate",
        "showWindow",
        "restartGateway",
        "quit",
    ];

    #[test]
    fn native_keys_exist_in_both_locales() {
        for locale in [Locale::Zh, Locale::En] {
            for key in TRAY_KEYS {
                assert!(
                    !native(locale, &["tray", key]).is_empty(),
                    "native.json 缺少 tray.{key}（{locale:?}）"
                );
            }
            assert!(!native(locale, &["guide", "title"]).is_empty(), "缺少 guide.title");
        }
    }
}
