<script setup>
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Drawer, Tag, Skeleton, Empty, MessagePlugin, Button, Tooltip } from "tdesign-vue-next";
import { CopyIcon } from "tdesign-icons-vue-next";

// 通用 MCP 工具查看抽屉
// 用法：<McpToolDrawer v-model:visible="show" :server-name="name" :config="config" />
// 打开（或 config 变化）时自动调用 getMcpServerTools 探活并展示工具列表

const props = defineProps({
  visible: { type: Boolean, default: false },
  serverName: { type: String, default: "" },
  config: { type: Object, default: null },
});

const emit = defineEmits(["update:visible"]);
const { t } = useI18n();

const toolList = ref([]);
const toolLoading = ref(false);
const toolError = ref("");

const loadTools = async () => {
  if (!props.config) return;
  toolList.value = [];
  toolLoading.value = true;
  toolError.value = "";
  try {
    const result = await window.services.getMcpServerTools(props.config);
    if (result.success) {
      toolList.value = result.tools;
      if (result.tools.length === 0) {
        MessagePlugin.info(t("mcp.noTools"));
      }
    } else {
      toolError.value = result.error;
      MessagePlugin.error(t("mcp.fetchToolsFailed", { message: result.error }));
    }
  } catch (e) {
    toolError.value = e.message;
    MessagePlugin.error(t("mcp.fetchToolsFailed", { message: e.message }));
  } finally {
    toolLoading.value = false;
  }
};

// 打开时自动探活
watch(() => props.visible, (v) => {
  if (v) loadTools();
});

// 打开状态下 config 变化（切换服务器）时重新探活
watch(() => props.config, () => {
  if (props.visible) loadTools();
});

// 复制文本到剪贴板
const copyText = (text) => {
  try {
    window.utools.copyText(text);
    MessagePlugin.success(t("common.copied"));
  } catch {
    MessagePlugin.error(t("common.copyFailed"));
  }
};

// 格式化 JSON Schema 参数为可读文本
const formatSchema = (schema) => {
  if (!schema || !schema.properties) return null;
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) return null;
  return entries.map(([name, prop]) => ({
    name,
    type: prop.type || "any",
    description: prop.description || "",
    required: schema.required?.includes(name) || false,
  }));
};
</script>

<template>
  <Drawer
    :visible="visible"
    :header="false"
    placement="left"
    size="80%"
    :footer="false"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div v-if="toolLoading" class="tool-skeleton">
      <div v-for="i in 3" :key="i" class="skeleton-card">
        <Skeleton :row="1" :loading="true" animation="fluent" />
        <div class="skeleton-card-body">
          <Skeleton :row="2" :loading="true" animation="fluent" />
        </div>
      </div>
    </div>

    <div v-else-if="toolError" class="tool-error">
      <Tag theme="danger" variant="light">{{ t('mcp.connectionFailed') }}</Tag>
      <span class="tool-error-msg">{{ toolError }}</span>
    </div>

    <div v-else-if="!toolList.length && !toolLoading" class="tool-empty">
      <Empty :description="t('mcp.noToolData')" />
    </div>

    <div v-else class="tool-list">
      <div v-for="tool in toolList" :key="tool.name" class="tool-item">
        <div class="tool-name">{{ tool.name }}</div>
        <div class="tool-meta-row">
          <div class="tool-meta">
            <span class="tool-meta-label">Tool name:</span> {{ tool.name }}
            <Tooltip :content="t('mcp.copyToolName')" placement="top">
              <Button size="small" variant="text" @click="copyText(tool.name)">
                <CopyIcon style="font-size: 14px" />
              </Button>
            </Tooltip>
          </div>
        </div>
        <div class="tool-meta-row">
          <div class="tool-meta">
            <span class="tool-meta-label">Full name:</span> mcp__{{ serverName }}__{{ tool.name }}
            <Tooltip :content="t('mcp.copyFullName')" placement="top">
              <Button size="small" variant="text" @click="copyText('mcp__' + serverName + '__' + tool.name)">
                <CopyIcon style="font-size: 14px" />
              </Button>
            </Tooltip>
          </div>
        </div>

        <div class="tool-section">
          <div class="tool-section-title">Description:</div>
          <div class="tool-desc">{{ tool.description || t('mcp.noDescription') }}</div>
        </div>

        <div v-if="formatSchema(tool.inputSchema)" class="tool-section">
          <div class="tool-section-title">Parameters:</div>
          <div class="param-list">
            <div v-for="param in formatSchema(tool.inputSchema)" :key="param.name" class="param-item">
              <span class="param-bullet">●</span>
              <span class="param-name">{{ param.name }}</span>
              <span class="param-required" v-if="param.required">(required)</span>
              <span class="param-optional" v-else>(optional)</span>
              <span class="param-type">{{ param.type }}</span>
              <span v-if="param.description" class="param-separator"> - </span>
              <span v-if="param.description" class="param-desc">{{ param.description }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Drawer>
</template>

<style scoped>
.tool-skeleton {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.skeleton-card {
  padding: 12px;
  border: 1px solid var(--td-component-border);
  border-radius: var(--td-radius-default);
  background-color: var(--td-bg-color-container);
}

.skeleton-card-body {
  margin-top: 8px;
}

.tool-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--td-error-color);
  border-radius: var(--td-radius-default);
  background-color: var(--td-error-color-1);
}

.tool-error-msg {
  font-size: 13px;
  color: var(--td-error-color);
  word-break: break-all;
}

.tool-empty {
  padding: 40px 0;
}

.tool-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tool-item {
  padding: 16px;
  border: 1px solid var(--td-border-level-1-color);
  border-radius: 6px;
}

.tool-name {
  font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
  font-size: 16px;
  font-weight: 600;
  color: var(--td-brand-color);
  margin-bottom: 4px;
  word-break: break-all;
}

.tool-meta-row {
  display: flex;
  align-items: center;
}

.tool-meta-row .tool-meta {
  min-width: 0;
}

.tool-meta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  color: var(--td-text-color-secondary);
  line-height: 1.6;
  word-break: break-all;
}

.tool-meta-label {
  font-weight: 700;
  color: var(--td-text-color-primary);
}

.tool-section {
  margin-top: 12px;
}

.tool-section-title {
  font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
  font-size: 14px;
  font-weight: 700;
  color: var(--td-text-color-primary);
  margin-bottom: 6px;
}

.tool-desc {
  font-size: 13px;
  color: var(--td-text-color-secondary);
  line-height: 1.6;
  padding-left: 4px;
  word-break: break-all;
}

.param-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 4px;
}

.param-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-family: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-all;
}

.param-bullet {
  color: var(--td-text-color-placeholder);
  font-size: 8px;
}

.param-name {
  color: var(--td-text-color-primary);
}

.param-required {
  color: var(--td-error-color);
  font-size: 12px;
}

.param-optional {
  color: var(--td-text-color-placeholder);
  font-size: 12px;
}

.param-type {
  color: var(--td-text-color-secondary);
}

.param-separator {
  color: var(--td-text-color-placeholder);
}

.param-desc {
  color: var(--td-text-color-placeholder);
  font-size: 13px;
}
</style>
