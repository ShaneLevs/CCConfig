<script setup>
// DSH（DeepSeek Harness）统计页：复用通用统计页（shared/UsagePage.vue），仅注入数据源与文案
// 会话日志需要逐帧 zstd 解压，数据量大时较慢，因此统计侧按「日志数:总字节:最新 mtime」签名缓存；
// 页面本身由 index.vue 的 isTabVisited + v-show 保活（首次进入后不再重复拉取），
// 点「刷新」时走同一条签名校验路径（UsagePage 传入的 force 不透传），日志有变化才重新解析。
import UsagePage from "../shared/UsagePage.vue";

const fetcher = () => window.services.readDshUsage();

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
    tip="DSH 使用统计（从会话日志解析，输入含缓存）"
    :fetcher="fetcher"
    empty-description="暂无使用数据，使用 DSH 对话后会在此处显示"
    :empty-hint="`未找到会话日志：${sessionsRoot}；产生用量后重新进入本页或点刷新即可统计`"
    model-hint="模型按「供应商 / 模型」区分"
  />
</template>
