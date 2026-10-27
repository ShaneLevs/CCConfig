<script setup>
// Grok Build 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案。
// 数据源为 ~/.grok/sessions/<encoded-cwd>/<session-id>/usage.json（每会话一份逐轮用量，
// 与官方 `grok usage` 同源）；按 turn.endedAt 落到当天，多天会话也能正确分日。
// 重统计走后台线程（readGrokUsageAsync），页面由 index.vue 的 isTabVisited + v-show 保活。
// 源文件被清理后从落库历史回放（ccconfig_agent_usage_grok_<nativeId>），历史不归零。
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = (force) => window.services.readGrokUsageAsync(force);

// 快速路径：只读落库历史（不解析会话目录，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readGrokUsageFromHistory();

const sessionsDir = (() => {
  try {
    return window.services.getGrokSessionsDir();
  } catch {
    return "~/.grok/sessions";
  }
})();
</script>

<template>
  <UsagePage
    :tip="t('grok.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('grok.usage.empty')"
    :empty-hint="t('grok.usage.emptyHint', { path: sessionsDir })"
    :model-hint="t('grok.usage.modelHint')"
  />
</template>
