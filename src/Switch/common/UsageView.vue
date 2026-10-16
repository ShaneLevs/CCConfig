<script setup>
// 通用配置统计页：合并 Claude Code / Pi Agent / OpenCode / DSH / ZCode 五个已适配 agent 的使用数据。
// 打开/刷新时先调 collectCommonUsageAsync 从各 agent 采集最新数据落库（后台线程，未安装/无数据的
// agent 自动跳过），再纯读 DB 聚合展示（文档 ccswitch_agent_usage_<agent>_<nativeId>）。
// 快速路径直接纯读 DB 展示上一次落库的合并结果，采集在后台完成后自动刷新。
import UsagePage from "../shared/UsagePage.vue";

const fetcher = (force) =>
  window.services.collectCommonUsageAsync().then(() => window.services.readCommonUsage());

// 快速路径：纯读 DB 合并（不触发任何采集）
const quickFetcher = () => window.services.readCommonUsage();
</script>

<template>
  <UsagePage
    tip="Claude Code / Pi Agent / OpenCode / DSH / ZCode 合并统计"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    empty-description="暂无使用数据"
    empty-hint="未检测到 Claude Code / Pi Agent / OpenCode / DSH / ZCode 的使用记录，产生用量后重新进入本页或点刷新即可汇总"
  />
</template>
