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

/// 取 native.json 里的子树（引导页整块文案注入用）
pub fn native_value(locale: Locale, path: &[&str]) -> Value {
    let raw = match locale {
        Locale::Zh => ZH_NATIVE,
        Locale::En => EN_NATIVE,
    };
    let mut node: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    for key in path {
        node = match node.get(*key) {
            Some(next) => next.clone(),
            None => return Value::Null,
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
