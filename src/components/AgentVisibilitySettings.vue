<script setup>
import { useI18n } from "vue-i18n";
import { Checkbox } from "tdesign-vue-next";
import { GripVertical } from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { useAgentVisibility } from "../composables/useAgentVisibility";

// 设置弹窗里的「Agent 显示」区块：勾选显示/隐藏 + 拖拽排序。
// 样式自带（settings-* 基础类与 index.vue 内各自 scoped 一份，互不影响）。
const { t } = useI18n();
const { activeApp } = useAppContext();
const {
  agentOrder,
  AGENT_META,
  visibleAgents,
  onAgentDragStart,
  onAgentDrop,
  onAgentDragEnd,
} = useAgentVisibility();
</script>

<template>
  <div class="settings-section">
    <div class="settings-title">{{ t('agents.visibility.title') }}</div>
    <div class="settings-desc">{{ t('agents.visibility.desc') }}</div>
    <div class="agent-visibility-list">
      <div
        v-for="(app, idx) in agentOrder"
        :key="app"
        class="agent-visibility-item"
        @dragover.prevent
        @drop="onAgentDrop(idx)"
      >
        <span
          class="agent-visibility-drag"
          draggable="true"
          @dragstart="onAgentDragStart(idx)"
          @dragend="onAgentDragEnd"
        >
          <GripVertical :size="16" />
        </span>
        <img :src="AGENT_META[app].icon" class="agent-visibility-icon" alt="" />
        <span class="agent-visibility-name">{{ AGENT_META[app].name }}</span>
        <span v-if="app === activeApp" class="agent-visibility-tag">{{ t('agents.visibility.current') }}</span>
        <Checkbox
          v-model="visibleAgents[app]"
          class="agent-visibility-checkbox"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--td-text-color-primary);
}
.settings-desc {
  font-size: 12px;
  color: var(--td-text-color-secondary);
  margin-top: 2px;
  line-height: 1.5;
}
.agent-visibility-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: 6px;
}
.agent-visibility-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--td-radius-default);
  user-select: none;
}
.agent-visibility-item:hover {
  background: var(--td-bg-color-container-hover);
}
.agent-visibility-drag {
  flex-shrink: 0;
  color: var(--td-text-color-placeholder);
  cursor: grab;
  display: inline-flex;
  align-items: center;
}
.agent-visibility-drag:active {
  cursor: grabbing;
}
.agent-visibility-icon {
  width: 22px;
  height: 22px;
  border-radius: var(--td-radius-default);
}
.agent-visibility-name {
  flex: 1;
  font-size: 13px;
  color: var(--td-text-color-primary);
}
.agent-visibility-tag {
  font-size: 11px;
  color: var(--td-success-color);
  background: var(--td-success-color-1);
  padding: 1px 6px;
  border-radius: 4px;
}
/* agent 显示复选框绿色由 main.css 全局规则统一处理 */
</style>
