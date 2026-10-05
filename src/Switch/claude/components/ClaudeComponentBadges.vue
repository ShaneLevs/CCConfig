<script setup>
import { componentBadges, hasComponent } from "./pluginMeta";

// claude 插件的组件类型徽标（Skills/Commands/Agents/Hooks/MCP/LSP），
// 仅展示有内容的类型；样式类由 PluginView.css 的 .component-badge 提供。
const props = defineProps({
  // 组件清单对象：{ skills: [], commands: [], ... }
  components: { type: Object, default: null },
});
</script>

<template>
  <span
    v-for="badge in componentBadges"
    :key="badge.key"
    v-show="hasComponent(components, badge.key)"
    class="component-badge"
    :style="{ background: badge.color + '18', color: badge.color, borderColor: badge.color + '40' }"
  >{{ badge.label }}</span>
</template>
