<script setup>
// MiniMax Code 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 数据源为 ~/.minimax/v2/sessions/<YYYY>/<MM>/<DD>/<会话>/messages.jsonl
// （取 assistant 消息的 usage 字段：input / output / cacheRead / cacheWrite / totalTokens）
// 重统计走后台线程（readMinimaxUsageAsync），不阻塞渲染层；进页面先用落库历史快速展示
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = () => window.services.readMinimaxUsageAsync();

// 快速路径：只读落库历史（不解析会话 JSONL，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readAgentUsageFromHistory("minimax");

const sessionsPath = (() => {
  try {
    return window.services.getMinimaxSessionsDir();
  } catch {
    return "~/.minimax/v2/sessions";
  }
})();
</script>

<template>
  <UsagePage
    page-app="minimax"
    :tip="t('minimax.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('minimax.usage.emptyDescription')"
    :empty-hint="t('minimax.usage.emptyHint', { path: sessionsPath })"
  />
</template>
