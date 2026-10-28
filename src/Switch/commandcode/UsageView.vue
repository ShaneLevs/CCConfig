<script setup>
// Command Code 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案。
// 数据源为 ~/.commandcode/projects/<项目slug>/<会话ID>.jsonl 的逐轮 usage
// （每行 message 顶层带 usage: inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens）。
// 重统计走后台线程（readCommandCodeUsageAsync），页面由 index.vue 的 isTabVisited + v-show 保活。
// 源文件被清理后从落库历史回放（ccconfig_agent_usage_commandcode_<nativeId>），历史不归零。
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = (force) => window.services.readCommandCodeUsageAsync(force);

// 快速路径：只读落库历史（不解析会话文件，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readCommandCodeUsageFromHistory();

const sessionsDir = (() => {
  try {
    return window.services.getCommandCodeProjectsDir();
  } catch {
    return "~/.commandcode/projects";
  }
})();
</script>

<template>
  <UsagePage
    :tip="t('commandcode.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('commandcode.usage.empty')"
    :empty-hint="t('commandcode.usage.emptyHint', { path: sessionsDir })"
    :model-hint="t('commandcode.usage.modelHint')"
  />
</template>
