<script setup>
// Grok Build MCP 配置页：~/.grok/config.toml 的 [mcp_servers.<name>]
// Grok 的开关落点是顶层 disabled_mcp_servers 名单（官方 `grok mcp disable` 的行为），
// 本页开关同时维护该名单；卡片/弹窗复用通用 MCP 组件（表单 + JSON 双模式）。
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Button, Empty, Space, Switch, Tooltip, MessagePlugin, Popconfirm } from "tdesign-vue-next";
import { AddIcon, RefreshIcon, ToolsIcon, EditIcon, DeleteIcon } from "tdesign-icons-vue-next";
import McpServerCard from "../../components/McpServerCard.vue";
import McpServerDialog from "../../components/McpServerDialog.vue";
import McpToolDrawer from "../../components/McpToolDrawer.vue";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/McpView.css";

const { t } = useI18n();

const servers = ref([]);
const loading = ref(false);

const loadServers = () => {
  try {
    servers.value = window.services.getGrokMcpServers() || [];
  } catch (e) {
    console.error("加载 Grok MCP 服务器失败:", e);
    MessagePlugin.error(e.message || t("common.loadFailed"));
    servers.value = [];
  }
};

const refresh = () => {
  loading.value = true;
  loadServers();
  setTimeout(() => { loading.value = false; }, 50);
};

// 切回本页时自动刷新（页面用 v-show 保活，onMounted 不会再跑）
const { autoRefreshing } = usePageRefresh("grok", "mcp", refresh);

const openConfigFile = () => {
  try { window.services.openGrokConfigFile(); } catch { /* ignore */ }
};

// ==================== 增 / 改 ====================

const dialogRef = ref(null);
const editingName = ref("");

const openCreateDialog = () => {
  editingName.value = "";
  dialogRef.value?.open("create");
};

const openEditDialog = (server) => {
  editingName.value = server.name;
  // 把 Grok 侧条目映射成通用 config 形状（type/http 与 stdio 两种），
  // 保存时再映射回来；未知字段由服务层原样保留
  dialogRef.value?.open("edit", server.name, genericConfig(server));
};

const handleSave = ({ mode, name, config }) => {
  try {
    // 通用弹窗的 type 只有 stdio / http（JSON 模式下可能手写 sse）；启用状态与扩展字段沿用原条目，
    // 新条目默认启用
    const prev = servers.value.find((s) => s.name === (mode === "edit" ? editingName.value : name));
    const nextType = config.type === "sse"
      ? "sse"
      : config.type === "http"
        ? "http"
        : "stdio";
    if (mode === "edit" && editingName.value && editingName.value !== name) {
      window.services.deleteGrokMcpServer(editingName.value);
    }
    window.services.setGrokMcpServer(name, {
      type: nextType,
      url: config.url || "",
      headers: config.headers || {},
      command: config.command || "",
      args: Array.isArray(config.args) ? config.args : [],
      env: config.env || {},
      enabled: prev ? prev.enabled : true,
      startupTimeoutSec: prev ? prev.startupTimeoutSec : 0,
      toolTimeoutSec: prev ? prev.toolTimeoutSec : 0,
      bearerTokenEnvVar: prev ? prev.bearerTokenEnvVar : "",
    });
    MessagePlugin.success(t(mode === "create" ? "grok.mcp.added" : "grok.mcp.updated"));
    dialogRef.value?.close();
    loadServers();
  } catch (e) {
    MessagePlugin.error(t("common.saveFailed") + "：" + e.message);
  }
};

// ==================== 启停 / 删除 / 查看工具 ====================

const toggleServer = (server) => {
  try {
    window.services.setGrokMcpEnabled(server.name, !server.enabled);
    MessagePlugin.success(t(server.enabled ? "grok.mcp.disabled" : "grok.mcp.enabled"));
    loadServers();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.saveFailed"));
  }
};

const deleteServer = (server) => {
  try {
    window.services.deleteGrokMcpServer(server.name);
    MessagePlugin.success(t("grok.mcp.deleted"));
    loadServers();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.deleteFailed"));
  }
};

const showToolDrawer = ref(false);
const toolServerName = ref("");
const toolServerConfig = ref(null);
const openToolDrawer = (server) => {
  if (!server.enabled) {
    MessagePlugin.warning(t("grok.mcp.enableBeforeTools"));
    return;
  }
  toolServerName.value = server.name;
  toolServerConfig.value = genericConfig(server);
  showToolDrawer.value = true;
};

// 模板里不能直接写 window.services（模板表达式按组件上下文解析，没有 window 全局），
// 统一走脚本里的包装函数
const genericConfig = (server) => window.services.grokMcpConfigFor(server);

const typeLabel = (server) => (server.type === "sse" ? "SSE" : server.type === "http" ? "HTTP" : "STDIO");
const typeTheme = (server) => (server.type === "http" ? "primary" : server.type === "sse" ? "warning" : "success");

const configSummary = (server) => {
  if (server.type === "stdio") {
    const args = (server.args || []).join(" ");
    return `cmd: ${server.command}${args ? ` ${args}` : ""}`;
  }
  return `url: ${server.url}`;
};

onMounted(refresh);
</script>

<template>
  <div class="grok-mcp-container">
    <div class="grok-mcp-header">
      <span class="grok-mcp-tip">
        <span class="hint-link" @click="openConfigFile">~/.grok/config.toml</span>
        <span class="grok-mcp-sub">{{ t("grok.mcp.tip") }}</span>
      </span>
      <Space size="8px">
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> {{ t("grok.mcp.add") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading || autoRefreshing" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </Space>
    </div>

    <div v-if="!servers.length" class="grok-mcp-empty">
      <Empty :description="t('grok.mcp.empty')">
        <template #action>
          <Button theme="primary" @click="openCreateDialog">
            <template #icon><AddIcon /></template> {{ t("grok.mcp.addFirst") }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="grok-mcp-list">
      <McpServerCard
        v-for="server in servers"
        :key="server.name + '-' + (server.enabled ? 'on' : 'off')"
        :srv="{ name: server.name, config: genericConfig(server) }"
        :disabled="!server.enabled"
        :type-text="typeLabel(server)"
        :type-theme="typeTheme(server)"
      >
        <template #actions>
          <Space>
            <Switch :value="server.enabled" size="small" @change="toggleServer(server)" />
            <Tooltip :content="t('mcp.viewTools')" placement="top">
              <Button size="small" theme="default" variant="text" :disabled="!server.enabled" @click="openToolDrawer(server)">
                <ToolsIcon />
              </Button>
            </Tooltip>
            <Tooltip :content="t('common.edit')" placement="top">
              <Button size="small" theme="default" variant="text" @click="openEditDialog(server)">
                <EditIcon />
              </Button>
            </Tooltip>
            <Popconfirm theme="danger" :content="t('grok.mcp.deleteConfirm')" @confirm="deleteServer(server)">
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>

        <template #body>
          <div class="grok-mcp-info-row">
            <div class="grok-mcp-summary">{{ configSummary(server) }}</div>
            <div class="grok-mcp-meta">
              <span v-if="server.startupTimeoutSec" class="grok-mcp-meta-item">
                {{ t("grok.mcp.startupTimeout", { sec: server.startupTimeoutSec }) }}
              </span>
              <span v-if="server.bearerTokenEnvVar" class="grok-mcp-meta-item mono">
                bearer: {{ server.bearerTokenEnvVar }}
              </span>
            </div>
          </div>
        </template>
      </McpServerCard>
    </div>

    <McpServerDialog ref="dialogRef" @save="handleSave" />

    <McpToolDrawer v-model:visible="showToolDrawer" :server-name="toolServerName" :config="toolServerConfig" />
  </div>
</template>
