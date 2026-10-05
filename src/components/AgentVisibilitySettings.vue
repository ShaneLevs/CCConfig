<script setup>
import { Checkbox } from "tdesign-vue-next";
import { GripVertical } from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { useAgentVisibility } from "../composables/useAgentVisibility";

// 设置弹窗里的「Agent 启停管理」区块：勾选启停 + 拖拽排序。
// 样式自带（settings-* 基础类与 index.vue 内各自 scoped 一份，互不影响）。
const { activeApp } = useAppContext();
const {
  agentOrder,
  AGENT_META,
  visibleAgents,
  onAgentToggle,
  onAgentDragStart,
  onAgentDrop,
  onAgentDragEnd,
} = useAgentVisibility();
</script>

<template>
  <div class="settings-section">
    <div class="settings-title">Agent 启停管理</div>
    <div class="settings-desc">
      勾选 = 启用：显示在顶部切换器，并保留 uTools 启动指令；取消勾选 = 停用：从切换器隐藏，
      并移除该 agent 的 uTools 启动指令（功能指令 + 匹配指令一并移除）；「通用」始终启用；
      当前正在使用的 agent 不可停用；拖动可排序
    </div>
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
        <span v-if="app === activeApp" class="agent-visibility-tag">当前</span>
        <Checkbox
          v-model="visibleAgents[app]"
          :disabled="app === activeApp"
          class="agent-visibility-checkbox"
          @change="(val) => onAgentToggle(app, val)"
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
/* agent 启停复选框绿色由 main.css 全局规则统一处理 */
</style>
