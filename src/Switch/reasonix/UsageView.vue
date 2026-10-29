<script setup>
// Reasonix 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案。
// 数据源为 ~/.reasonix/stats/<YYYY-MM-DD>.jsonl 的逐请求结算行
// （{ ts, model, source, prompt, completion, cache_hit, cache_miss, total }），
// CLI 与桌面版共用同一目录（config.toml 的 desktop.metrics 开启时才写）。
// 重统计走后台线程（readReasonixUsageAsync），进页面先用落库历史快速展示。
// 源文件被清理后从落库历史回放（ccconfig_agent_usage_reasonix_<nativeId>），历史不归零。
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = () => window.services.readReasonixUsageAsync();

// 快速路径：只读落库历史（不解析 stats 文件，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readReasonixUsageFromHistory();

const statsDir = (() => {
  try {
    return window.services.getReasonixStatsDir();
  } catch {
    return "~/.reasonix/stats";
  }
})();
</script>

<template>
  <UsagePage
    page-app="reasonix"
    :tip="t('reasonix.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('reasonix.usage.emptyDescription')"
    :empty-hint="t('reasonix.usage.emptyHint', { path: statsDir })"
    :model-hint="t('reasonix.usage.modelHint')"
  />
</template>
