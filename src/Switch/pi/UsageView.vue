<script setup>
// Pi Agent 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 重统计走后台线程（readPiUsageAsync），不阻塞渲染层；进页面先用落库历史快速展示
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = () => window.services.readPiUsageAsync();

// 快速路径：只读落库历史（不解析会话 JSONL，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readAgentUsageFromHistory("pi");
</script>

<template>
  <UsagePage
    :tip="t('pi.usage.tip')"
    :fetcher="fetcher"
    :empty-description="t('pi.usage.emptyDescription')"
  />
</template>
