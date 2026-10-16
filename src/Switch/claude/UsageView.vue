<script setup>
// Claude Code 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 重统计走后台线程（readClaudeUsageAsync），不阻塞渲染层；进页面先用落库历史快速展示
import UsagePage from "../shared/UsagePage.vue";

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
    tip="统计仅供参考"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    model-hint="同一会话可能使用多个模型，故各模型会话数之和可能大于总会话数"
    empty-description="暂无 Claude Code 使用数据"
  />
</template>
