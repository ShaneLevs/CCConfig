<script setup>
// Kimi Code 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案。
// 数据源 ~/.kimi-code/sessions/<workspace>/<session>/agents/<agentId>/wire.jsonl 的 usage.record
// （输入 = inputOther + cacheRead + cacheCreation，输出单列；日期按本地时区）。
// 重统计走后台线程（readKimiUsageAsync），进页面先用落库历史快速展示。
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = () => window.services.readKimiUsageAsync();

// 快速路径：只读落库历史（不解析 wire.jsonl，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readAgentUsageFromHistory("kimi");

const sessionsDir = (() => {
  try {
    return window.services.getKimiSessionsDir();
  } catch {
    return "~/.kimi-code/sessions";
  }
})();
</script>

<template>
  <UsagePage
    page-app="kimi"
    :tip="t('kimi.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('kimi.usage.emptyDescription')"
    :empty-hint="t('kimi.usage.emptyHint', { path: sessionsDir })"
  />
</template>
