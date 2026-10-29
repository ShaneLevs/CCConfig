<script setup>

import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Tag, Button, Tooltip, MessagePlugin, Space, Popconfirm, Switch,
} from "tdesign-vue-next";
import {
  RefreshIcon, AddIcon, EditIcon, DeleteIcon, ToolsIcon,
} from "tdesign-icons-vue-next";
import McpToolDrawer from "../../components/McpToolDrawer.vue";
import McpServerDialog from "../../components/McpServerDialog.vue";
import McpServerCard from "../../components/McpServerCard.vue";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/McpView.css";

const { t } = useI18n();

const loading = ref(false);
const servers = ref([]);

// ---------- OpenCode mcp 格式 ⇄ 通用（Claude 组件）格式转换 ----------
// OpenCode: local → { type:'local', command:[cmd,...args], environment:{}, enabled }
//           remote → { type:'remote', url, headers:{}, enabled }
// 通用：      { type:'stdio'|'http', command, args, env, url, headers }
const toGeneric = (cfg) => {
  const isRemote = cfg.type === 'remote' || (!cfg.type && !!cfg.url);
  if (isRemote) {
    const g = { type: 'http', url: String(cfg.url || '') };
    if (cfg.headers && Object.keys(cfg.headers).length) g.headers = { ...cfg.headers };
    return g;
  }
  const cmd = Array.isArray(cfg.command)
    ? cfg.command.map(String)
    : String(cfg.command || '').trim().split(/\s+/).filter(Boolean);
  const g = { type: 'stdio' };
  if (cmd.length) g.command = cmd[0];
  if (cmd.length > 1) g.args = cmd.slice(1);
  const env = cfg.environment || cfg.env;
  if (env && Object.keys(env).length) g.env = { ...env };
  return g;
};

// 通用格式写回 OpenCode 格式：保留原有未知字段与 enabled 状态
const toOpencode = (generic, prevRaw, isEdit) => {
  const out = { ...(prevRaw || {}) };
  for (const k of ['type', 'command', 'url', 'environment', 'env', 'headers']) delete out[k];
  if (generic.type === 'http') {
    out.type = 'remote';
    if (generic.url) out.url = generic.url;
    if (generic.headers && Object.keys(generic.headers).length) out.headers = generic.headers;
  } else {
    out.type = 'local';
    out.command = [generic.command, ...(generic.args || [])].filter((s) => s !== '' && s != null);
    if (generic.env && Object.keys(generic.env).length) out.environment = generic.env;
  }
  if (!isEdit) out.enabled = true;
  return out;
};

const loadServers = () => {
  try {
    const raw = window.services.getOpencodeMcpServers() || {};
    servers.value = Object.entries(raw).map(([name, cfg]) => ({
      name,
      enabled: cfg.enabled !== false,
      raw: cfg,
      config: toGeneric(cfg),
    }));
  } catch (e) {
    console.error("加载 OpenCode MCP 失败:", e);
    servers.value = [];
  }
};

const refresh = () => {
  loading.value = true;
  setTimeout(() => { loadServers(); loading.value = false; }, 50);
};

// 切回本页时自动刷新（页面用 v-show 保活，onMounted 不会再跑）
const { autoRefreshing } = usePageRefresh("opencode", "mcp", refresh);

// ---------- 添加/编辑弹窗（通用组件） ----------
const mcpDialogRef = ref(null);
const editingName = ref("");

const openCreateDialog = () => {
  editingName.value = "";
  mcpDialogRef.value?.open('create');
};
const openEditDialog = (srv) => {
  editingName.value = srv.name;
  mcpDialogRef.value?.open('edit', srv.name, srv.config);
};
const handleSaveMcp = ({ mode, name, config }) => {
  try {
    const raw = window.services.getOpencodeMcpServers() || {};
    // 编辑改名：删除旧键
    if (mode === 'edit' && editingName.value && editingName.value !== name) {
      window.services.removeOpencodeMcpServer(editingName.value);
    }
    const isEdit = mode === 'edit' && !!raw[name];
    window.services.setOpencodeMcpServer(name, toOpencode(config, raw[name], isEdit));
    MessagePlugin.success(mode === 'create' ? t('opencode.mcp.added') : t('opencode.mcp.updated'));
    mcpDialogRef.value?.close();
    loadServers();
  } catch (e) {
    MessagePlugin.error(t('opencode.mcp.saveFailed', { message: e.message }));
  }
};

// ---------- 启用/禁用（写 mcp 条目的 enabled 字段） ----------
const toggleMcpStatus = (srv) => {
  try {
    window.services.setOpencodeMcpServer(srv.name, { ...srv.raw, enabled: !srv.enabled });
    MessagePlugin.success(srv.enabled ? t('opencode.mcp.disabledToast') : t('opencode.mcp.enabledToast'));
    loadServers();
  } catch (e) {
    MessagePlugin.error(t('opencode.mcp.operationFailed', { message: e.message }));
  }
};

const deleteMcpServer = (srv) => {
  try {
    window.services.removeOpencodeMcpServer(srv.name);
    MessagePlugin.success(t('opencode.mcp.deleted'));
    loadServers();
  } catch (e) {
    MessagePlugin.error(t('opencode.mcp.deleteFailed', { message: e.message }));
  }
};

// ---------- 工具查看（探活在通用组件 McpToolDrawer 内） ----------
const showToolDrawer = ref(false);
const toolServerName = ref("");
const toolServerConfig = ref(null);
const openToolDrawer = (srv) => {
  if (!srv.enabled) {
    return MessagePlugin.warning(t("opencode.mcp.enableFirst"));
  }
  toolServerName.value = srv.name;
  toolServerConfig.value = srv.config;
  showToolDrawer.value = true;
};

// ---------- 打开 opencode.json ----------
const openConfigFile = () => {
  const filePath = window.services.getOpencodeConfigPath();
  window.utools.shellOpenPath(filePath);
};

// 类型标签
const getTypeTag = (config) => (config.type === 'http' ? 'HTTP' : 'STDIO');
const getTypeTagTheme = (config) => (config.type === 'http' ? 'primary' : 'success');

onMounted(refresh);

</script>

<template>
  <div class="oc-mcp-container">
    <div class="oc-mcp-header">
      <div class="oc-mcp-header-left">
        <span class="oc-mcp-tip">{{ t("opencode.mcp.tipPrefix") }}<span class="hint-link" @click="openConfigFile">opencode.json/mcp</span>{{ t("opencode.mcp.tipSuffix") }}</span>
      </div>
      <div class="oc-mcp-actions">
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> {{ t("opencode.mcp.add") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading || autoRefreshing" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="servers.length === 0" class="oc-mcp-empty">
      <Empty :description="t('opencode.mcp.empty')">
        <template #action>
          <Button size="small" theme="primary" @click="openCreateDialog">
            <template #icon><AddIcon /></template> {{ t("opencode.mcp.add") }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="oc-mcp-list">
      <McpServerCard
        v-for="srv in servers"
        :key="srv.name"
        :srv="{ name: srv.name, config: srv.config }"
        :disabled="!srv.enabled"
        :type-text="getTypeTag(srv.config)"
        :type-theme="getTypeTagTheme(srv.config)"
      >
        <template #tags>
          <Tag size="small" variant="light" :theme="srv.enabled ? 'success' : 'default'">
            {{ srv.enabled ? t('common.enabled') : t('common.disabled') }}
          </Tag>
        </template>
        <template #actions>
          <Space size="small">
            <Switch :value="srv.enabled" size="small" @change="toggleMcpStatus(srv)" />
            <Tooltip :content="t('mcp.viewTools')" placement="top">
              <Button size="small" variant="text" :disabled="!srv.enabled" @click="openToolDrawer(srv)">
                <template #icon><ToolsIcon /></template>
              </Button>
            </Tooltip>
            <Tooltip :content="t('common.edit')" placement="top">
              <Button size="small" variant="text" @click="openEditDialog(srv)">
                <template #icon><EditIcon /></template>
              </Button>
            </Tooltip>
            <Popconfirm :content="t('opencode.mcp.deleteConfirm')" @confirm="deleteMcpServer(srv)">
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" variant="text" theme="danger">
                  <template #icon><DeleteIcon /></template>
                </Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>
      </McpServerCard>
    </div>

    <McpServerDialog
      ref="mcpDialogRef"
      @save="handleSaveMcp"
    />

    <McpToolDrawer
      v-model:visible="showToolDrawer"
      :server-name="toolServerName"
      :config="toolServerConfig"
    />
  </div>
</template>
