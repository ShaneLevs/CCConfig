<script setup>
import { computed } from "vue";
import { Button } from "tdesign-vue-next";
import { APP_TABS } from "../Switch/appTabs";
import { useAutoRouteStatus } from "../composables/useAutoRouteStatus";

// 顶栏页签按钮组：由 APP_TABS[app] 表驱动，替换原来每个应用一段的重复模板。
// common 的「网关」项带自动网关开启绿点标识（AutoRouteView 开关切换时同步）。
const props = defineProps({
  app: { type: String, required: true },
});
const activeTab = defineModel("activeTab", { type: String, default: "config" });

const tabs = computed(() => APP_TABS[props.app] || []);
const { autoRouteEnabled } = useAutoRouteStatus();
</script>

<template>
  <div class="tab-buttons">
    <template v-for="tab in tabs" :key="tab.key">
      <!-- 网关 tab：外层包裹定位，.t-button 自身 overflow: hidden 会裁切溢出角标 -->
      <span v-if="tab.gatewayDot" class="route-tab-btn">
        <Button
          size="small"
          :theme="activeTab === tab.key ? 'primary' : 'default'"
          :variant="activeTab === tab.key ? 'base' : 'outline'"
          @click="activeTab = tab.key"
        >
          <template #icon><component :is="tab.icon" /></template> {{ tab.label }}
        </Button>
        <!-- 自动网关开启标识：按钮右上角绿点 -->
        <span v-if="autoRouteEnabled" class="route-on-dot" />
      </span>
      <Button
        v-else
        size="small"
        :theme="activeTab === tab.key ? 'primary' : 'default'"
        :variant="activeTab === tab.key ? 'base' : 'outline'"
        @click="activeTab = tab.key"
      >
        <template #icon><component :is="tab.icon" /></template> {{ tab.label }}
      </Button>
    </template>
  </div>
</template>

<style scoped>
.tab-buttons {
  display: flex;
  gap: 4px;
  align-items: center;
}
/* 网关 tab 按钮：自动网关开启时右上角绿点标识（表示网关已开启） */
.route-tab-btn {
  position: relative;
  display: inline-flex;
}
.route-on-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--td-success-color);
  border: 1.5px solid var(--td-bg-color-container);
  box-sizing: border-box;
  pointer-events: none;
  z-index: 1;
}
:root[theme-mode="dark"] .route-on-dot {
  border-color: #303133;
}
</style>
