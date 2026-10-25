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
      <span class="agent-rail-name">{{ opt.label }}</span>
    </div>
  </nav>
</template>

<style scoped>
.agent-rail {
  /* 水平位置由父级 .page（flex 行，gap 12px）安排；sticky 保证页面滚动时贴住视口顶部。
     桌面版顶部还要让出 overlay 标题栏高度（uTools 版该变量为 0），与内容区顶部对齐。 */
  position: sticky;
  top: calc(10px + var(--cc-desktop-titlebar, 0px));
  margin-top: var(--cc-desktop-titlebar, 0px);
  flex-shrink: 0;
  width: 152px;
  max-height: calc(100vh - 20px - var(--cc-desktop-titlebar, 0px));
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
/* 选中项：theme.css 把整条 brand 色阶换成了灰阶，纯填色在暗色下几乎等于容器底色
   （brand-color-light = #343434 叠在 #303133 上），单靠颜色分不出选中。
   这里补一圈 1px 内描边（暗色近白 / 浅色近黑，均由灰阶 brand-color 提供），
   与「通用 → 外观 → 特效」卡片的选中态同款；用 inset 阴影而不是 border，避免布局跳动。 */
.agent-rail-item--active,
.agent-rail-item--active:hover {
  background: var(--td-brand-color-light);
  color: var(--td-text-color-primary);
  font-weight: 500;
  box-shadow: 0 0 0 1px var(--td-brand-color) inset;
}
/* 选中项 hover 不退回灰色 hover 底，只略微提亮，避免「一碰就失去选中感」 */
.agent-rail-item--active:hover {
  background: var(--td-brand-color-light-hover);
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
