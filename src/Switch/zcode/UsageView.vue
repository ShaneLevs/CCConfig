<script setup>
// ZCode 统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 数据源为 ~/.zcode/cli/db/db.sqlite（ZCode 设置页「使用统计」同源），只读打开不阻塞其写入；
// 页面由 index.vue 的 isTabVisited + v-show 保活（首次进入后不再重复拉取），
// 点「刷新」时重新读库；db 被清理后从落库历史回放，历史不归零。
// 重统计走后台线程（readZcodeUsageAsync），不阻塞渲染层。
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

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
    :tip="t('zcode.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('zcode.usage.empty')"
    :empty-hint="t('zcode.usage.emptyHint', { path: dbPath })"
    :model-hint="t('zcode.usage.modelHint')"
  />
</template>
