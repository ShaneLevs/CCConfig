<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Tag, Tooltip, Button, Space, Popconfirm, MessagePlugin } from "tdesign-vue-next";
import { ToolsIcon, MoveIcon, EditIcon, DeleteIcon } from "tdesign-icons-vue-next";

// 通用 MCP 服务器展示卡片
// 默认形态（本地/云端双区）：查看工具 / 复制到另一端 / 编辑 / 删除 + 配置信息行
// 可通过插槽自定义：
//   #actions —— 覆盖右侧操作按钮组（如 Claude 的 Switch+按钮组合）
//   #body    —— 覆盖下方配置信息区（如 Claude 的 summary + 使用统计）
//   #tags    —— 在类型标签后追加来源/状态标签（如 本地/云端）
// props：
//   srv        { name, config }
//   target     local | cloud，决定「复制到另一端」按钮文案
//   disabled   禁用态（半透明，如未启用）
//   typeText   类型标签文本（默认 HTTP/STDIO 自动判断）
//   typeTheme  类型标签主题色（默认 http=primary / 其他=success）

const props = defineProps({
  srv: { type: Object, required: true },
  target: { type: String, default: 'local' },
  disabled: { type: Boolean, default: false },
  typeText: { type: String, default: '' },
  typeTheme: { type: String, default: '' },
});

const emit = defineEmits(['view-tools', 'copy', 'edit', 'delete']);
const { t } = useI18n();

const defaultTypeLabel = (config) => (config.type === 'http' || config.url) ? 'HTTP' : 'STDIO';
const typeLabel = props.typeText || defaultTypeLabel(props.srv.config);
const typeTheme = props.typeTheme || (defaultTypeLabel(props.srv.config) === 'HTTP' ? 'primary' : 'success');
const otherLabel = computed(() => (props.target === 'local' ? t('mcp.cloud') : t('mcp.local')));
const formatArgs = (args) => (Array.isArray(args) ? args.join(' ') : '');
const copyName = () => {
  try {
    window.utools.copyText(props.srv.name);
    MessagePlugin.success(t('mcp.nameCopied'));
  } catch { MessagePlugin.error(t('common.copyFailed')); }
};
</script>

<template>
  <div class="mcp-server-card" :class="{ 'mcp-server-card--disabled': disabled }">
    <div class="mcp-server-card-header">
      <div class="mcp-server-srv-name-wrap">
        <Tooltip :content="t('mcp.copyName')" placement="top">
          <span class="mcp-server-srv-name" @click="copyName">{{ srv.name }}</span>
        </Tooltip>
        <Tag size="small" :theme="typeTheme" variant="light">
          {{ typeLabel }}
        </Tag>
        <slot name="tags" />
      </div>
      <div class="mcp-server-card-actions">
        <slot name="actions">
          <Space size="small">
            <Tooltip :content="t('mcp.viewTools')" placement="top">
              <Button size="small" variant="text" @click="emit('view-tools')">
                <template #icon><ToolsIcon /></template>
              </Button>
            </Tooltip>
            <Tooltip :content="t('mcp.copyTo', { target: otherLabel })" placement="top">
              <Button size="small" variant="text" @click="emit('copy')">
                <template #icon><MoveIcon /></template>
              </Button>
            </Tooltip>
            <Tooltip :content="t('common.edit')" placement="top">
              <Button size="small" variant="text" @click="emit('edit')">
                <template #icon><EditIcon /></template>
              </Button>
            </Tooltip>
            <Popconfirm :content="t('mcp.deleteConfirm')" @confirm="emit('delete')">
              <Button size="small" variant="text" theme="danger">
                <template #icon><DeleteIcon /></template>
              </Button>
            </Popconfirm>
          </Space>
        </slot>
      </div>
    </div>

    <div class="mcp-server-card-body">
      <slot name="body">
        <div v-if="defaultTypeLabel(srv.config) === 'STDIO'" class="mcp-server-info-row">
          <span class="mcp-server-label">{{ t('mcp.commandLabel') }}</span>
          <span class="mcp-server-value mono">{{ srv.config.command }}</span>
        </div>
        <div v-if="srv.config.args?.length" class="mcp-server-info-row">
          <span class="mcp-server-label">{{ t('mcp.argsLabel') }}</span>
          <span class="mcp-server-value mono">{{ formatArgs(srv.config.args) }}</span>
        </div>
        <div v-if="srv.config.url" class="mcp-server-info-row">
          <span class="mcp-server-label">URL</span>
          <span class="mcp-server-value mono">{{ srv.config.url }}</span>
        </div>
        <div v-if="Object.keys(srv.config.env || {}).length" class="mcp-server-info-row">
          <span class="mcp-server-label">{{ t('mcp.envLabel') }}</span>
          <span class="mcp-server-value mono">{{ Object.keys(srv.config.env).join(', ') }}</span>
        </div>
        <div v-if="Object.keys(srv.config.headers || {}).length" class="mcp-server-info-row">
          <span class="mcp-server-label">{{ t('mcp.headersLabel') }}</span>
          <span class="mcp-server-value mono">{{ Object.keys(srv.config.headers).join(', ') }}</span>
        </div>
      </slot>
    </div>
  </div>
</template>

<style scoped>
.mcp-server-card {
  border: 1px solid var(--td-component-border);
  border-radius: var(--td-radius-default);
  background-color: var(--td-bg-color-container);
  padding: 12px 16px;
  transition: border-color 0.2s, opacity 0.2s;
}

.mcp-server-card:hover {
  border-color: var(--td-brand-color);
}

.mcp-server-card--disabled {
  opacity: 0.6;
}

.mcp-server-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.mcp-server-srv-name-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mcp-server-srv-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--td-text-color-primary);
  cursor: pointer;
  word-break: break-all;
}

.mcp-server-srv-name:hover {
  color: var(--td-brand-color);
}

.mcp-server-card-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.mcp-server-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mcp-server-info-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
}

.mcp-server-label {
  color: var(--td-text-color-secondary);
  flex-shrink: 0;
  min-width: 56px;
}

.mcp-server-value {
  color: var(--td-text-color-primary);
  word-break: break-all;
}

.mono {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}
</style>
