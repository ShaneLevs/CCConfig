<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Checkbox } from "tdesign-vue-next";
import { GripVertical } from "@lucide/vue";
import { useAppContext } from "../composables/useAppContext";
import { useAgentVisibility } from "../composables/useAgentVisibility";

// 设置弹窗里的「Agent 显示」区块：勾选显示/隐藏 + 拖拽排序。
// 样式自带（settings-* 基础类与 index.vue 内各自 scoped 一份，互不影响）。
const { t } = useI18n();
const { activeApp } = useAppContext();
const { agentOrder, AGENT_META, visibleAgents } = useAgentVisibility();

// 每行右侧的安装状态 / 版本：服务层异步探测 CLI（桌面版走 sidecar 异步通道），
// 组件挂载时拉一次，检测期间显示「检测中…」。
const installInfo = ref({});
const checking = ref(false);

onMounted(async () => {
  if (!window.services?.getAgentInstallInfo) return;
  checking.value = true;
  try {
    installInfo.value = (await window.services.getAgentInstallInfo()) || {};
  } catch (e) {
    console.error("检测 Agent 安装状态失败:", e);
  } finally {
    checking.value = false;
  }
});

// 拖拽排序用 Pointer Events：HTML5 DnD 在桌面版（Tauri 窗口接管原生拖放）里收不到 drag 事件。
// 拖动期间渲染一份草稿顺序，指针落到哪一项就把它插到那一项的位置（实时重排），松手才写回 agentOrder。
const draftOrder = ref(null);
const draggingApp = ref(null);
const listOrder = computed(() => draftOrder.value || agentOrder.value);
let press = null;

const appAtPoint = (x, y) => {
  const el = document.elementFromPoint(x, y);
  const item = el && el.closest ? el.closest(".agent-visibility-item") : null;
  return item ? item.dataset.app : null;
};

const stopDrag = () => {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", stopDrag);
  window.removeEventListener("pointercancel", stopDrag);
  if (press && press.handle.hasPointerCapture && press.handle.hasPointerCapture(press.pointerId)) {
    try { press.handle.releasePointerCapture(press.pointerId); } catch (e) { /* ignore */ }
  }
  // 只有真正拖动过才落库：单击手柄不应触发一次写库
  if (draftOrder.value && draggingApp.value) agentOrder.value = draftOrder.value;
  draftOrder.value = null;
  draggingApp.value = null;
  press = null;
  document.body.classList.remove("agent-sorting");
};

function onPointerMove(event) {
  if (!press || event.pointerId !== press.pointerId) return;
  if (!draggingApp.value) {
    // 超过 4px 才算拖动，避免误触打乱顺序
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4) return;
    draftOrder.value = [...agentOrder.value];
    draggingApp.value = press.app;
    document.body.classList.add("agent-sorting");
  }
  event.preventDefault();
  const targetApp = appAtPoint(event.clientX, event.clientY);
  if (!targetApp || targetApp === press.app) return;
  const order = [...draftOrder.value];
  const from = order.indexOf(press.app);
  const to = order.indexOf(targetApp);
  if (from < 0 || to < 0 || from === to) return;
  order.splice(from, 1);
  order.splice(to, 0, press.app);
  draftOrder.value = order;
}

const startDrag = (event, app) => {
  if (event.button !== 0) return;
  event.preventDefault();
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
  press = { app, x: event.clientX, y: event.clientY, pointerId: event.pointerId, handle: event.currentTarget };
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopDrag);
  window.addEventListener("pointercancel", stopDrag);
};

// 安装形态摘要：Reasonix 这类「CLI + 桌面客户端」双形态的 Agent 分别回传各自状态，
// 这里把已安装的形态并排展示（如 CLI v1.2.3 · 客户端 v2.55.0），避免只看到其中一个的版本。
// 单形态 Agent（forms 只有一段）返回空串，模板退回原来的「已安装 · vX」。
const formSummary = (app) => {
  const info = installInfo.value[app];
  const forms = info?.forms || {};
  const keys = Object.keys(forms);
  if (keys.length < 2) return "";
  const labels = {
    cli: t("agents.visibility.formCli"),
    desktop: t("agents.visibility.formDesktop"),
  };
  return keys
    .filter((k) => forms[k]?.installed)
    .map((k) => `${labels[k] || k}${forms[k].version ? ` v${forms[k].version}` : ""}`)
    .join(" · ");
};

onBeforeUnmount(stopDrag);
</script>

<template>
  <div class="settings-section">
    <div class="settings-title">{{ t('agents.visibility.title') }}</div>
    <div class="settings-desc">{{ t('agents.visibility.desc') }}</div>
    <div class="agent-visibility-list">
      <div
        v-for="app in listOrder"
        :key="app"
        class="agent-visibility-item"
        :class="{ 'is-dragging': draggingApp === app }"
        :data-app="app"
      >
        <span
          class="agent-visibility-drag"
          @pointerdown="startDrag($event, app)"
        >
          <GripVertical :size="16" />
        </span>
        <img :src="AGENT_META[app].icon" class="agent-visibility-icon" alt="" />
        <span class="agent-visibility-name">{{ AGENT_META[app].name }}</span>
        <span v-if="app === activeApp" class="agent-visibility-tag">{{ t('agents.visibility.current') }}</span>
        <span
          v-if="installInfo[app]"
          class="agent-visibility-status"
          :class="installInfo[app].installed ? 'is-installed' : 'is-missing'"
        >
          <template v-if="installInfo[app].installed">
            <template v-if="formSummary(app)">{{ formSummary(app) }}</template>
            <template v-else>
              {{ t('agents.visibility.installed') }}<template v-if="installInfo[app].version"> · v{{ installInfo[app].version }}</template>
            </template>
          </template>
          <template v-else>{{ t('agents.visibility.notInstalled') }}</template>
        </span>
        <span v-else-if="checking" class="agent-visibility-status">{{ t('agents.visibility.checking') }}</span>
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
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}
.agent-visibility-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--td-radius-default);
  user-select: none;
  /* 拖动中其它项让开时不选中文字 */
  transition: background-color 0.12s ease;
}
.agent-visibility-item:hover {
  background: var(--td-bg-color-container-hover);
}
.agent-visibility-item.is-dragging {
  background: var(--td-bg-color-container-hover);
  opacity: 0.55;
}
.agent-visibility-drag {
  flex-shrink: 0;
  color: var(--td-text-color-placeholder);
  cursor: grab;
  display: inline-flex;
  align-items: center;
  touch-action: none;
}
.agent-visibility-item.is-dragging .agent-visibility-drag {
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
.agent-visibility-status {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--td-text-color-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.agent-visibility-status.is-installed {
  color: var(--td-success-color);
}
/* 暗色下 --td-success-color 是深绿，11px 小字对比度不够，用同一色阶的亮端 */
:root[theme-mode="dark"] .agent-visibility-status.is-installed {
  color: var(--td-success-color-7);
}
.agent-visibility-status.is-missing {
  color: var(--td-text-color-placeholder);
}
/* agent 显示复选框绿色由 main.css 全局规则统一处理 */
:global(body.agent-sorting) {
  cursor: grabbing;
}
</style>
