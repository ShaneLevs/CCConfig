<script setup>
// omp 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 数据源为 <OMP_DIR>/sessions/**/*.jsonl（含子 agent / 顾问转录）与 archive/sessions/**/*.jsonl.gz
// （omp gc 归档），取 assistant 消息与 model_usage 条目的 usage 字段。
// 重统计走后台线程（readOmpUsageAsync），不阻塞渲染层；进页面先用落库历史快速展示
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = () => window.services.readOmpUsageAsync();

// 快速路径：只读落库历史（不解析会话 JSONL，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readAgentUsageFromHistory("omp");

const sessionsPath = (() => {
  try {
    return window.services.getOmpSessionsDir();
  } catch {
    return "~/.omp/agent/sessions";
  }
})();
</script>

<template>
  <UsagePage
    page-app="omp"
    :tip="t('omp.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('omp.usage.emptyDescription')"
    :empty-hint="t('omp.usage.emptyHint', { path: sessionsPath })"
  />
</template>
