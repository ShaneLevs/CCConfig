<script setup>
import { ref, computed, watch } from "vue";
import { Button, Dialog, Tag, MessagePlugin } from "tdesign-vue-next";
import { DownloadIcon } from "tdesign-icons-vue-next";
import ClaudeComponentBadges from "./ClaudeComponentBadges.vue";
import { componentBadges, hasComponent, hasAnyComponent, getScopeLabel, getScopeTheme } from "./pluginMeta";

// claude 插件详情弹窗：基础信息 + 组件清单（已安装的本地详情，可点击复制）+ 元数据 + 安装按钮。
const props = defineProps({
  visible: { type: Boolean, default: false },
  plugin: { type: Object, default: null },
  // 父级安装操作 loading 键（与 operationLoading 同源）
  operationLoading: { type: String, default: null },
});
const emit = defineEmits(["update:visible", "install"]);

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const detailComponents = ref(null);

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    detailComponents.value = null;
    const plugin = props.plugin;
    if (plugin?.pluginId) {
      try {
        detailComponents.value = window.services.getInstalledPluginComponents(
          plugin.installPath,
          plugin.name
        );
        console.log('[PluginView] installPath:', plugin.installPath, 'name:', plugin.name);
        console.log('[PluginView] detailComponents:', JSON.stringify(detailComponents.value));
      } catch (e) {
        console.error('[PluginView] getInstalledPluginComponents error:', e);
        detailComponents.value = null;
      }
    }
  }
);

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    MessagePlugin.success(`已复制: ${text}`);
  } catch {
    MessagePlugin.error('复制失败');
  }
};

const handleInstall = () => {
  emit("install", props.plugin.name);
  dialogVisible.value = false;
};
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    header="插件详情"
    width="520px"
    :footer="false"
  >
    <div v-if="plugin" class="plugin-detail">
      <div class="plugin-detail-header">
        <div class="plugin-detail-title-row">
          <span class="plugin-detail-name">{{ plugin.name }}</span>
          <span v-if="plugin.version" class="plugin-detail-version">v{{ plugin.version }}</span>
          <ClaudeComponentBadges :components="plugin.components" />
        </div>
        <span v-if="plugin.author" class="plugin-detail-author">{{ plugin.author.name || plugin.author }}</span>
      </div>
      <p class="plugin-detail-desc">{{ plugin.description || '暂无描述' }}</p>
      <div v-if="plugin.tags && plugin.tags.length" class="plugin-detail-tags">
        <Tag v-for="tag in plugin.tags" :key="tag" size="small" variant="light">{{ tag }}</Tag>
      </div>
      <div v-if="hasAnyComponent(detailComponents || plugin.components)" class="plugin-detail-components">
        <template v-for="badge in componentBadges" :key="badge.key">
          <div v-if="hasComponent(detailComponents || plugin.components, badge.key)" class="plugin-detail-comp-row">
            <span class="plugin-detail-comp-label">{{ badge.label }}</span>
            <span class="plugin-detail-comp-items">
              <Tag v-for="name in (detailComponents || plugin.components)[badge.key]" :key="name" size="small" variant="outline" style="cursor: pointer;" @click="copyToClipboard(name)">{{ name }}</Tag>
            </span>
          </div>
        </template>
      </div>
      <div class="plugin-detail-meta">
        <div v-if="plugin.scope" class="plugin-detail-meta-item">
          <span class="plugin-detail-label">范围</span>
          <Tag size="small" :theme="getScopeTheme(plugin.scope)" variant="light">{{ getScopeLabel(plugin.scope) }}</Tag>
        </div>
        <div v-if="plugin.pluginId" class="plugin-detail-meta-item">
          <span class="plugin-detail-label">状态</span>
          <Tag size="small" :theme="plugin.enabled !== false ? 'success' : 'default'" variant="light">{{ plugin.enabled !== false ? '已启用' : '已禁用' }}</Tag>
        </div>
        <div v-if="plugin.installedAt" class="plugin-detail-meta-item">
          <span class="plugin-detail-label">安装时间</span>
          <span class="plugin-detail-value">{{ new Date(plugin.installedAt).toLocaleString() }}</span>
        </div>
        <div v-if="plugin.lastUpdated && plugin.lastUpdated !== plugin.installedAt" class="plugin-detail-meta-item">
          <span class="plugin-detail-label">更新时间</span>
          <span class="plugin-detail-value">{{ new Date(plugin.lastUpdated).toLocaleString() }}</span>
        </div>
        <div v-if="plugin.homepage" class="plugin-detail-meta-item">
          <span class="plugin-detail-label">主页</span>
          <a :href="plugin.homepage" target="_blank" class="plugin-detail-link">{{ plugin.homepage }}</a>
        </div>
        <div v-if="plugin.marketplaceName" class="plugin-detail-meta-item">
          <span class="plugin-detail-label">来源</span>
          <span class="plugin-detail-value">@{{ plugin.marketplaceName }}</span>
        </div>
        <div v-if="plugin.installCount" class="plugin-detail-meta-item">
          <span class="plugin-detail-label">安装次数</span>
          <span class="plugin-detail-value">{{ plugin.installCount }}</span>
        </div>
        <div v-if="plugin.category" class="plugin-detail-meta-item">
          <span class="plugin-detail-label">分类</span>
          <span class="plugin-detail-value">{{ plugin.category }}</span>
        </div>
        <div v-if="plugin.strict" class="plugin-detail-meta-item">
          <Tag size="small" theme="warning" variant="light">严格模式</Tag>
        </div>
      </div>
      <div v-if="!plugin.pluginId" class="plugin-detail-actions">
        <Button
          theme="primary"
          :loading="operationLoading === plugin.name"
          @click="handleInstall"
        >
          <template #icon><DownloadIcon /></template>
          安装
        </Button>
      </div>
    </div>
  </Dialog>
</template>
