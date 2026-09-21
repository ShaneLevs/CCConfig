<script setup>

import { ref, onMounted } from "vue";
import {
  Empty, Tag, Button, Tooltip, MessagePlugin, Space, Popconfirm, Switch,
} from "tdesign-vue-next";
import {
  RefreshIcon, AddIcon, EditIcon, DeleteIcon, ToolsIcon,
} from "tdesign-icons-vue-next";
import McpToolDrawer from "../../components/McpToolDrawer.vue";
import McpServerDialog from "../../components/McpServerDialog.vue";
import McpServerCard from "../../components/McpServerCard.vue";
import "./styles/McpView.css";

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
    MessagePlugin.success(mode === 'create' ? 'MCP 配置已添加' : 'MCP 配置已更新');
    mcpDialogRef.value?.close();
    loadServers();
  } catch (e) {
    MessagePlugin.error('保存失败: ' + e.message);
  }
};

// ---------- 启用/禁用（写 mcp 条目的 enabled 字段） ----------
const toggleMcpStatus = (srv) => {
  try {
    window.services.setOpencodeMcpServer(srv.name, { ...srv.raw, enabled: !srv.enabled });
    MessagePlugin.success(srv.enabled ? 'MCP 已关闭' : 'MCP 已开启');
    loadServers();
  } catch (e) {
    MessagePlugin.error('操作失败: ' + e.message);
  }
};

const deleteMcpServer = (srv) => {
  try {
    window.services.removeOpencodeMcpServer(srv.name);
    MessagePlugin.success('MCP 配置已删除');
    loadServers();
  } catch (e) {
    MessagePlugin.error('删除失败: ' + e.message);
  }
};

// ---------- 工具查看（探活在通用组件 McpToolDrawer 内） ----------
const showToolDrawer = ref(false);
const toolServerName = ref("");
const toolServerConfig = ref(null);
const openToolDrawer = (srv) => {
  if (!srv.enabled) {
    return MessagePlugin.warning("请先开启 MCP 后再查看工具");
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

onMounted(loadServers);

</script>

<template>
  <div class="oc-mcp-container">
    <div class="oc-mcp-header">
      <div class="oc-mcp-header-left">
        <span class="oc-mcp-tip">OpenCode MCP 服务器配置（直接编辑 <span class="hint-link" @click="openConfigFile">opencode.json/mcp</span>）</span>
      </div>
      <div class="oc-mcp-actions">
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> 添加 MCP
        </Button>
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="servers.length === 0" class="oc-mcp-empty">
      <Empty description="暂无 MCP 配置">
        <template #action>
          <Button size="small" theme="primary" @click="openCreateDialog">
            <template #icon><AddIcon /></template> 添加 MCP
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
            {{ srv.enabled ? '已启用' : '已禁用' }}
          </Tag>
        </template>
        <template #actions>
          <Space size="small">
            <Switch :value="srv.enabled" size="small" @change="toggleMcpStatus(srv)" />
            <Tooltip content="查看工具" placement="top">
              <Button size="small" variant="text" :disabled="!srv.enabled" @click="openToolDrawer(srv)">
                <template #icon><ToolsIcon /></template>
              </Button>
            </Tooltip>
            <Tooltip content="编辑" placement="top">
              <Button size="small" variant="text" @click="openEditDialog(srv)">
                <template #icon><EditIcon /></template>
              </Button>
            </Tooltip>
            <Popconfirm content="确定删除此 MCP 配置？" @confirm="deleteMcpServer(srv)">
              <Tooltip content="删除" placement="top">
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
