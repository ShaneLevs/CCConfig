<script setup>
// ZCode 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 数据源为 ~/.zcode/cli/db/db.sqlite（ZCode 设置页「使用统计」同源），只读打开不阻塞其写入；
// 页面由 index.vue 的 isTabVisited + v-show 保活（首次进入后不再重复拉取），
// 点「刷新」时重新读库；db 被清理后从落库历史回放，历史不归零。
// 重统计走后台线程（readZcodeUsageAsync），不阻塞渲染层。
import UsagePage from "../shared/UsagePage.vue";

const fetcher = () => window.services.readZcodeUsageAsync();

// 快速路径：只读落库历史（不读 SQLite，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readZcodeUsageFromHistory();

const dbPath = (() => {
  try {
    return window.services.getZcodeUsageDbPath();
  } catch {
    return "~/.zcode/cli/db/db.sqlite";
  }
})();
</script>

<template>
  <UsagePage
    tip="ZCode 使用统计（读取本地用量数据库，输入含缓存）"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    empty-description="暂无使用数据，使用 ZCode 对话后会在此处显示"
    :empty-hint="`未找到用量数据库：${dbPath}；产生用量后重新进入本页或点刷新即可统计`"
    model-hint="模型名与 ZCode 设置页口径一致"
  />
</template>
