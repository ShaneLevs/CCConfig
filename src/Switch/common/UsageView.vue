<script setup>
// 通用配置统计页：合并 Claude Code / OpenCode / Pi Agent 三个已适配 agent 的使用数据。
// 打开/刷新时先调 collectCommonUsage 从各 agent 采集最新数据落库（未安装/无数据的 agent 自动跳过），
// 再纯读 DB 聚合展示（文档 ccswitch_agent_usage_<agent>_<nativeId>）。
import UsagePage from "../shared/UsagePage.vue";

const fetcher = (force) => {
  if (force) {
    try {
      window.services.collectCommonUsage();
    } catch (e) {
      console.warn("采集各 agent 使用统计失败:", e);
    }
  }
  return window.services.readCommonUsage();
};
</script>

<template>
  <UsagePage
    tip="Claude Code / OpenCode / Pi Agent 合并统计"
    :fetcher="fetcher"
    empty-description="暂无使用数据"
    empty-hint="未检测到 Claude Code / OpenCode / Pi Agent 的使用记录，产生用量后重新进入本页或点刷新即可汇总"
  />
</template>
