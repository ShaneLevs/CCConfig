<script setup>
// Command Code MCP 配置页：~/.commandcode/mcp.json 的 mcpServers（仅 user scope）。
// local scope（projects/<slug>/mcp.json）与 project scope（<项目>/.mcp.json）不在此页管理，
// 免得在插件里改了项目内的共享文件。
// Command Code 用显式 transport 字段（stdio | http），比 Claude 的类型推断更明确。
// 卡片/弹窗复用通用 MCP 组件（表单 + JSON 双模式）。
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Button, Empty, Space, Switch, Tooltip, MessagePlugin, Popconfirm } from "tdesign-vue-next";
import { AddIcon, RefreshIcon, ToolsIcon, EditIcon, DeleteIcon } from "tdesign-icons-vue-next";
import McpServerCard from "../../components/McpServerCard.vue";
import McpServerDialog from "../../components/McpServerDialog.vue";
import McpToolDrawer from "../../components/McpToolDrawer.vue";
import "./styles/McpView.css";

const { t } = useI18n();

const servers = ref([]);
const loading = ref(false);

const loadServers = () => {
  try {
    servers.value = window.services.getCommandCodeMcpServers() || [];
  } catch (e) {
    console.error("加载 Command Code MCP 服务器失败:", e);
    MessagePlugin.error(e.message || t("common.loadFailed"));
    servers.value = [];
  }
};

const refresh = () => {
  loading.value = true;
  loadServers();
  setTimeout(() => { loading.value = false; }, 50);
};

const openConfigFile = () => {
  try { window.services.openCommandCodeDir(); } catch { /* ignore */ }
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
  // 把 Command Code 侧条目映射成通用 config 形状（type/http 与 stdio 两种），
  // 保存时再映射回来；未知字段由服务层原样保留
  dialogRef.value?.open("edit", server.name, genericConfig(server));
};

const handleSave = ({ mode, name, config }) => {
  try {
    const prev = servers.value.find((s) => s.name === (mode === "edit" ? editingName.value : name));
    // Command Code 只认 stdio / http（通用弹窗 JSON 模式可能手写 sse → 按 http 落盘）
    const nextType = config.type === "http" || config.type === "sse" ? "http" : "stdio";
    const renaming = mode === "edit" && editingName.value && editingName.value !== name;
    window.services.setCommandCodeMcpServer(name, {
      type: nextType,
      url: config.url || "",
      headers: config.headers || {},
      command: config.command || "",
      args: Array.isArray(config.args) ? config.args : [],
      env: config.env || {},
      enabled: prev ? prev.enabled : true,
    });
    // 先写新条目再删旧条目：中途失败时旧条目仍在，不至于两个都丢
    if (renaming) window.services.deleteCommandCodeMcpServer(editingName.value);
    MessagePlugin.success(t(mode === "create" ? "commandcode.mcp.added" : "commandcode.mcp.updated"));
    dialogRef.value?.close();
    loadServers();
  } catch (e) {
    MessagePlugin.error(t("common.saveFailed") + "：" + e.message);
  }
};

// ==================== 启停 / 删除 / 查看工具 ====================

const toggleServer = (server) => {
  try {
    window.services.setCommandCodeMcpEnabled(server.name, !server.enabled);
    MessagePlugin.success(t(server.enabled ? "commandcode.mcp.disabled" : "commandcode.mcp.enabled"));
    loadServers();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.saveFailed"));
  }
};

const deleteServer = (server) => {
  try {
    window.services.deleteCommandCodeMcpServer(server.name);
    MessagePlugin.success(t("commandcode.mcp.deleted"));
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
    MessagePlugin.warning(t("commandcode.mcp.enableBeforeTools"));
    return;
  }
  toolServerName.value = server.name;
  toolServerConfig.value = genericConfig(server);
  showToolDrawer.value = true;
};

// 模板里不能直接写 window.services（模板表达式按组件上下文解析，没有 window 全局），
// 统一走脚本里的包装函数
const genericConfig = (server) => window.services.getCommandCodeMcpConfigFor(server);

const typeLabel = (server) => (server.type === "http" ? "HTTP" : "STDIO");
const typeTheme = (server) => (server.type === "http" ? "primary" : "success");

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
  <div class="commandcode-mcp-container">
    <div class="commandcode-mcp-header">
      <span class="commandcode-mcp-tip">
        <span class="hint-link" @click="openConfigFile">~/.commandcode/mcp.json</span>
        <span class="commandcode-mcp-sub">{{ t("commandcode.mcp.tip") }}</span>
      </span>
      <Space size="8px">
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> {{ t("commandcode.mcp.add") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </Space>
    </div>

    <div v-if="!servers.length" class="commandcode-mcp-empty">
      <Empty :description="t('commandcode.mcp.empty')">
        <template #action>
          <Button theme="primary" @click="openCreateDialog">
            <template #icon><AddIcon /></template> {{ t("commandcode.mcp.addFirst") }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="commandcode-mcp-list">
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
            <Popconfirm theme="danger" :content="t('commandcode.mcp.deleteConfirm')" @confirm="deleteServer(server)">
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>

        <template #body>
          <div class="commandcode-mcp-info-row">
            <div class="commandcode-mcp-summary">{{ configSummary(server) }}</div>
          </div>
        </template>
      </McpServerCard>
    </div>

    <McpServerDialog ref="dialogRef" @save="handleSave" />

    <McpToolDrawer v-model:visible="showToolDrawer" :server-name="toolServerName" :config="toolServerConfig" />
  </div>
</template>
