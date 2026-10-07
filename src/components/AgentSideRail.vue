<script setup>
import { useAppContext } from "../composables/useAppContext";
import { useAgentVisibility } from "../composables/useAgentVisibility";

// 左侧快速切换栏：窗口较宽时由 index.vue 控制挂载，与内容组成 flex 行整体居中（sticky 随滚动贴住视口顶部），
// 与顶部下拉共用 useAgentVisibility 的可见 agent 数据与排序，点击向上抛 select。
const emit = defineEmits(["select"]);
const { activeApp } = useAppContext();
const { AGENT_META, appDropdownOptions } = useAgentVisibility();

const ASSET_BASE = import.meta.env.BASE_URL;
</script>

<template>
  <nav class="agent-rail">
    <div
      v-for="opt in appDropdownOptions"
      :key="opt.value"
      class="agent-rail-item"
      :class="{ 'agent-rail-item--active': opt.value === activeApp }"
      @click="emit('select', opt.value)"
    >
      <img
        :src="opt.value === 'common' ? `${ASSET_BASE}gen.svg` : AGENT_META[opt.value].icon"
        class="agent-rail-icon"
        alt=""
      />
      <span class="agent-rail-name">{{ opt.content }}</span>
    </div>
  </nav>
</template>

<style scoped>
.agent-rail {
  /* 水平位置由父级 .page（flex 行，gap 12px）安排；sticky 保证页面滚动时贴住视口顶部 */
  position: sticky;
  top: 10px;
  flex-shrink: 0;
  width: 152px;
  max-height: calc(100vh - 20px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  box-sizing: border-box;
  background: var(--td-bg-color-container);
  border: 1px solid var(--td-component-border);
  border-radius: 9px;
}
.agent-rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--td-text-color-primary);
  user-select: none;
  flex-shrink: 0;
}
.agent-rail-item:hover {
  background: var(--td-bg-color-container-hover);
}
.agent-rail-item--active {
  background: var(--td-brand-color-light);
  color: var(--td-brand-color);
  font-weight: 500;
}
.agent-rail-icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  flex-shrink: 0;
}
.agent-rail-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
