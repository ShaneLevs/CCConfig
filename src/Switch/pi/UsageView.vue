<script setup>
// Pi Agent 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 重统计走后台线程（readPiUsageAsync），不阻塞渲染层
import UsagePage from "../shared/UsagePage.vue";

const fetcher = () => window.services.readPiUsageAsync();
</script>

<template>
  <UsagePage
    tip="Pi Agent 使用统计（从会话 JSONL 解析）"
    :fetcher="fetcher"
    empty-description="暂无使用数据，使用 Pi Agent 后会在此处显示"
  />
</template>
