// preload / desktop sidecar 的最小 i18n：与渲染进程共用 shared/i18n/<locale>/service.json。
// JSON 由 esbuild 内联进 services.js，桌面 sidecar 不需要额外复制资源。
// 语言权威值是渲染进程（通过 services.setLocale 推送）：桌面 sidecar 从 Dock 启动时
// Node 的 Intl 语言可能与 WKWebView 不一致，这里只负责首帧的合理猜测。
const zhCN = {
  ...require("../../../shared/i18n/zh-CN/service.json"),
  ...require("../../../shared/i18n/zh-CN/serviceAgent.json"),
};
const enUS = {
  ...require("../../../shared/i18n/en-US/service.json"),
  ...require("../../../shared/i18n/en-US/serviceAgent.json"),
};

const MESSAGES = { "zh-CN": zhCN, "en-US": enUS };
const DEFAULT_LOCALE = "zh-CN";

function normalizeLocale(value) {
  if (!value) return null;
  const v = String(value).toLowerCase();
  if (v.startsWith("zh")) return "zh-CN";
  if (v.startsWith("en")) return "en-US";
  return null;
}

function detectInitialLocale() {
  try {
    if (typeof process !== "undefined" && process.env && process.env.CCCONFIG_LOCALE) {
      return normalizeLocale(process.env.CCCONFIG_LOCALE) || DEFAULT_LOCALE;
    }
  } catch (e) {
    /* ignore */
  }
  // 纯 Node（smoke 测试直接 require service 模块）没有 window：沿用中文，保证既有断言稳定。
  // uTools preload 与桌面 sidecar 都会提供 window，不受影响。
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    if (typeof window !== "undefined" && window.utools && window.utools.db) {
      // 按机器隔离的文档优先；旧共享档 ccconfig_locale 仅作迁移种子
      let nativeId = "";
      try {
        nativeId = window.utools.getNativeId() || "";
      } catch (e) {
        /* ignore */
      }
      const docId = nativeId ? `ccconfig_locale_${nativeId}` : "ccconfig_locale";
      let doc = window.utools.db.get(docId);
      if (!doc && docId !== "ccconfig_locale") {
        doc = window.utools.db.get("ccconfig_locale");
      }
      if (doc && doc.locale && doc.locale !== "system") {
        const normalized = normalizeLocale(doc.locale);
        if (normalized) return normalized;
      }
    }
  } catch (e) {
    /* ignore */
  }
  try {
    const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    return normalizeLocale(systemLocale) || DEFAULT_LOCALE;
  } catch (e) {
    return DEFAULT_LOCALE;
  }
}

let locale = detectInitialLocale();

function lookup(messages, key) {
  return String(key)
    .split(".")
    .reduce((obj, part) => (obj == null ? undefined : obj[part]), messages);
}

function interpolate(text, params) {
  if (!params || typeof text !== "string") return text;
  return text.replace(/\{\s*([\w-]+)\s*\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

function t(key, params) {
  const current = MESSAGES[locale] || MESSAGES[DEFAULT_LOCALE];
  const text = lookup(current, key) ?? lookup(MESSAGES[DEFAULT_LOCALE], key) ?? key;
  return interpolate(text, params);
}

function getLocale() {
  return locale;
}

function setLocale(value) {
  locale = normalizeLocale(value) || DEFAULT_LOCALE;
  return locale;
}

module.exports = { t, getLocale, setLocale, normalizeLocale };
