<script setup>
// Cline 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案。
// 数据源为 ~/.cline/data/sessions/<会话>/<会话>.json 的 metadata.usage（会话级汇总，
// 含 inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / totalCost），
// 与 CLI 自身 `cline` 会话记录同源；日期取会话的 updated_at / started_at。
// 重统计走后台线程（readClineUsageAsync），页面由 index.vue 的 isTabVisited + v-show 保活。
// 源会话被清理后从落库历史回放（ccconfig_agent_usage_cline_<nativeId>），历史不归零。
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = (force) => window.services.readClineUsageAsync(force);

// 快速路径：只读落库历史（不解析会话目录，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readClineUsageFromHistory();

const sessionsDir = (() => {
  try {
    return window.services.getClineSessionsDir();
  } catch {
    return "~/.cline/data/sessions";
  }
})();
</script>

<template>
  <UsagePage
    page-app="cline"
    :tip="t('cline.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('cline.usage.empty')"
    :empty-hint="t('cline.usage.emptyHint', { path: sessionsDir })"
    :model-hint="t('cline.usage.modelHint')"
  />
</template>
