<script setup>
// DSH（DeepSeek Harness）统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 会话日志需要逐帧 zstd 解压，数据量大时较慢，因此统计侧按「日志数:总字节:最新 mtime」签名缓存；
// 页面由 index.vue 的 isTabVisited + v-show 保活（首次进入后不再重复拉取），
// 点「刷新」时走同一条签名校验路径（UsagePage 传入的 force 不透传），日志有变化才重新解析。
// 重统计走后台线程（readDshUsageAsync），不阻塞渲染层。
import { useI18n } from "vue-i18n";
import UsagePage from "../shared/UsagePage.vue";

const { t } = useI18n();

const fetcher = () => window.services.readDshUsageAsync();

// 快速路径：只读落库历史（不解析会话日志，返回 UsagePage 契约形状）
const quickFetcher = () => window.services.readDshUsageFromHistory();

const sessionsRoot = (() => {
  try {
    return window.services.getDshSessionsRoot();
  } catch {
    return "~/.dsh/sessions";
  }
})();
</script>

<template>
  <UsagePage
    :tip="t('dsh.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('dsh.usage.empty')"
    :empty-hint="t('dsh.usage.emptyHint', { path: sessionsRoot })"
    :model-hint="t('dsh.usage.modelHint')"
  />
</template>
