<script setup>
// Claude Code 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 重统计走后台线程（readClaudeUsageAsync），不阻塞渲染层；进页面先用落库历史快速展示
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

// DB 缓存优先；JSONL 读取失败时回退到历史持久化数据
const fetcher = (force) =>
  window.services
    .readClaudeUsageAsync(force)
    .catch(() => window.services.readPersistedUsage());

// 快速路径：只读落库热力图历史（不扫描 JSONL）
const quickFetcher = () => window.services.readPersistedUsage();
</script>

<template>
  <UsagePage
    page-app="claude"
    :tip="t('claude.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :model-hint="t('claude.usage.modelHint')"
    :empty-description="t('claude.usage.empty')"
  />
</template>
