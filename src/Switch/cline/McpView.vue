<script setup>
// Cline MCP 配置页：~/.cline/data/settings/cline_mcp_settings.json 的 mcpServers
// 与 IDE 扩展共享同一份文件，所以这里的增删改对 CLI 与编辑器同时生效。
// 关闭态写入条目自身的 disabled: true（Cline 的字段语义），卡片/弹窗复用通用 MCP 组件。
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
    servers.value = window.services.getClineMcpServers() || [];
  } catch (e) {
    console.error("加载 Cline MCP 服务器失败:", e);
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
const { autoRefreshing } = usePageRefresh("cline", "mcp", refresh);

const openConfigFile = () => {
  try { window.services.openClineMcpFile(); } catch { /* ignore */ }
};

// 模板里不能直接写 window.services（模板表达式按组件上下文解析），统一走脚本包装
const genericConfig = (server) => window.services.clineMcpConfigFor(server);

// ==================== 增 / 改 ====================

const dialogRef = ref(null);
const editingName = ref("");

const openCreateDialog = () => {
  editingName.value = "";
  dialogRef.value?.open("create");
};

const openEditDialog = (server) => {
  editingName.value = server.name;
  dialogRef.value?.open("edit", server.name, genericConfig(server));
};

const handleSave = ({ mode, name, config }) => {
  try {
    const prevName = mode === "edit" ? editingName.value : "";
    const prev = servers.value.find((s) => s.name === (prevName || name));
    const nextType = config.type === "sse" ? "sse" : config.type === "http" ? "http" : "stdio";
    // 改名：先删旧键再写新键（服务层按名字定位条目）
    if (prevName && prevName !== name) {
      window.services.deleteClineMcpServer(prevName);
    }
    window.services.setClineMcpServer(name, {
      type: nextType,
      url: config.url || "",
      headers: config.headers || {},
      command: config.command || "",
      args: Array.isArray(config.args) ? config.args : [],
      env: config.env || {},
      enabled: prev ? prev.enabled : true,
    });
    MessagePlugin.success(t(mode === "create" ? "cline.mcp.added" : "cline.mcp.updated"));
    dialogRef.value?.close();
    loadServers();
  } catch (e) {
    MessagePlugin.error(t("common.saveFailed") + ": " + e.message);
  }
};

// ==================== 启停 / 删除 / 查看工具 ====================

const toggleServer = (server) => {
  try {
    window.services.setClineMcpEnabled(server.name, !server.enabled);
    MessagePlugin.success(t(server.enabled ? "cline.mcp.disabled" : "cline.mcp.enabled"));
    loadServers();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.saveFailed"));
  }
};

const deleteServer = (server) => {
  try {
    window.services.deleteClineMcpServer(server.name);
    MessagePlugin.success(t("cline.mcp.deleted"));
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
    MessagePlugin.warning(t("cline.mcp.enableBeforeTools"));
    return;
  }
  toolServerName.value = server.name;
  toolServerConfig.value = genericConfig(server);
  showToolDrawer.value = true;
};

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
  <div class="cline-mcp-container">
    <div class="cline-mcp-header">
      <span class="cline-mcp-tip">
        <span class="hint-link" @click="openConfigFile">cline_mcp_settings.json</span>
        <span class="cline-mcp-sub">{{ t("cline.mcp.tip") }}</span>
      </span>
      <Space size="8px">
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> {{ t("cline.mcp.add") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading || autoRefreshing" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </Space>
    </div>

    <div v-if="!servers.length" class="cline-mcp-empty">
      <Empty :description="t('cline.mcp.empty')">
        <template #action>
          <Button theme="primary" @click="openCreateDialog">
            <template #icon><AddIcon /></template> {{ t("cline.mcp.addFirst") }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="cline-mcp-list">
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
            <Popconfirm theme="danger" :content="t('cline.mcp.deleteConfirm')" @confirm="deleteServer(server)">
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>

        <template #body>
          <div class="cline-mcp-info-row">
            <div class="cline-mcp-summary">{{ configSummary(server) }}</div>
            <div class="cline-mcp-meta">
              <span v-if="server.autoApprove && server.autoApprove.length" class="cline-mcp-meta-item">
                autoApprove: {{ server.autoApprove.length }}
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
