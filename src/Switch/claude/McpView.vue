<script setup>
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Button,
  MessagePlugin,
  Tag,
  Space,
  Empty,
  Popconfirm,
  Switch,
  Tooltip,
} from "tdesign-vue-next";
import {
  AddIcon,
  EditIcon,
  DeleteIcon,
  ToolsIcon,
  RefreshIcon,
} from "tdesign-icons-vue-next";
import McpToolDrawer from "../../components/McpToolDrawer.vue";
import McpServerDialog from "../../components/McpServerDialog.vue";
import McpServerCard from "../../components/McpServerCard.vue";
import { formatLastUsed } from "../../utils/time";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/McpView.css";

const { t } = useI18n();

const mcpServerList = ref([]);
const mcpUsage = ref({});

// MCP 添加/编辑弹窗（通用组件）
const mcpDialogRef = ref(null);
const editingName = ref("");
const openCreateDialog = () => {
  editingName.value = "";
  mcpDialogRef.value?.open('create');
};
const openEditDialog = (server) => {
  if (!server.enabled) {
    return MessagePlugin.warning(t("claude.mcpView.enableBeforeEdit"));
  }
  editingName.value = server.name;
  mcpDialogRef.value?.open('edit', server.name, server.config);
};
// 保存：编辑改名时删除旧配置；支持 JSON-only 视图没有的校验（组件内已完成）
const handleSaveMcp = ({ mode, name, config }) => {
  if (mode === "edit" && editingName.value && editingName.value !== name) {
    window.services.deleteMcpServer(editingName.value);
  }
  if (window.services.upsertMcpServer(name, config)) {
    MessagePlugin.success(t(mode === "create" ? "claude.mcpView.added" : "claude.mcpView.updated"));
    mcpDialogRef.value?.close();
    loadMcpServers();
  } else {
    MessagePlugin.error(t("common.saveFailed"));
  }
};

// 工具查看相关
const showToolDrawer = ref(false);
const toolServerName = ref("");
const toolServerConfig = ref(null);

// 加载 MCP 服务器列表
const loadMcpServers = () => {
  mcpServerList.value = window.services.getAllMcpServersWithStatus();
};

// 手动刷新（外部修改后重新加载）
const mcpLoading = ref(false);
const handleRefresh = () => {
  mcpLoading.value = true;
  setTimeout(() => {
    loadMcpServers();
    mcpLoading.value = false;
  }, 50);
};

// 切回本页时自动刷新（页面用 v-show 保活，onMounted 不会再跑）
const { autoRefreshing, refreshNow } = usePageRefresh("claude", "mcp", handleRefresh);

// 加载 MCP 使用统计（只在挂载时加载一次，拨动开关不刷新此数据）
const loadMcpUsage = () => {
  mcpUsage.value = window.services.getMcpUsage();
};

// 切换 MCP 状态
const toggleMcpStatus = (server) => {
  if (server.enabled) {
    // 关闭
    const result = window.services.disableMcpServer(server.name);
    if (result.success) {
      MessagePlugin.success(t("claude.mcpView.disabled"));
      loadMcpServers();
    } else {
      MessagePlugin.error(result.error || t("claude.mcpView.disableFailed"));
    }
  } else {
    // 开启
    const result = window.services.enableMcpServer(server.name);
    if (result.success) {
      MessagePlugin.success(t("claude.mcpView.enabled"));
      loadMcpServers();
    } else {
      MessagePlugin.error(result.error || t("claude.mcpView.enableFailed"));
    }
  }
};

// 打开 ~/.claude.json 文件（不存在则自动创建）
const openClaudeMcpFile = () => {
  window.services.openClaudeMcpFile();
};

// 获取类型标签
const getTypeTag = (type) => {
  if (type === "http") return "HTTP";
  if (type === "sse") return "SSE";
  return "STDIO";
};

// 获取类型标签颜色
const getTypeTagTheme = (type) => {
  if (type === "http") return "primary";
  if (type === "sse") return "warning";
  return "success";
};

// 格式化参数显示
const formatArgs = (args) => {
  if (!args || !Array.isArray(args)) return "";
  return args.join(" ");
};

// 删除 MCP 配置
const deleteMcpServer = (server) => {
  let result;
  if (server.enabled) {
    result = window.services.deleteMcpServer(server.name);
  } else {
    result = window.services.deleteDisabledMcpServer(server.name);
  }
  if (result.success) {
    MessagePlugin.success(t("claude.mcpView.deleted"));
    loadMcpServers();
  } else {
    MessagePlugin.error(result.error || t("common.deleteFailed"));
  }
};

// 在卡片上显示的配置摘要
const getConfigSummary = (config) => {
  const parts = [];
  if (config.command) {
    parts.push(`cmd: ${config.command}`);
  }
  if (config.url) {
    parts.push(`url: ${config.url}`);
  }
  if (config.args?.length) {
    parts.push(`args: ${t("common.countItems", { count: config.args.length })}`);
  }
  return parts.join(" | ");
};

// 打开工具查看抽屉（探活与展示逻辑在通用组件 McpToolDrawer 内）
const openToolDrawer = (server) => {
  if (!server.enabled) {
    return MessagePlugin.warning(t("claude.mcpView.enableBeforeTools"));
  }
  toolServerName.value = server.name;
  toolServerConfig.value = server.config;
  showToolDrawer.value = true;
};

onMounted(() => {
  refreshNow();
  setTimeout(() => loadMcpUsage(), 50);
});
</script>

<template>
  <div class="mcp-container">
    <div class="section-header">
      <span class="mcp-tip">{{ t('claude.mcpView.tipPrefix') }} <span class="hint-link" @click="openClaudeMcpFile">~/.claude.json</span> {{ t('claude.mcpView.tipSuffix') }}</span>
      <Space size="8px">
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> {{ t('claude.mcpView.add') }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="mcpLoading || autoRefreshing" @click="handleRefresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </Space>
    </div>

    <div v-if="!mcpServerList.length" class="empty-state">
      <Empty :description="t('claude.mcpView.empty')">
        <template #action>
          <Button theme="primary" @click="openCreateDialog">
            <template #icon><AddIcon /></template> {{ t('claude.mcpView.addFirst') }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="mcp-list">
      <McpServerCard
        v-for="server in mcpServerList"
        :key="server.name + '-' + (server.enabled ? 'on' : 'off')"
        :srv="server"
        :disabled="!server.enabled"
        :type-text="getTypeTag(server.config.type)"
        :type-theme="getTypeTagTheme(server.config.type)"
      >
        <template #actions>
          <Space>
            <Switch
              :value="server.enabled"
              @change="toggleMcpStatus(server)"
              size="small"
            />
            <Tooltip :content="t('mcp.viewTools')" placement="top">
              <Button
                size="small"
                theme="default"
                variant="text"
                :disabled="!server.enabled"
                @click="openToolDrawer(server)"
              >
                <ToolsIcon />
              </Button>
            </Tooltip>
            <Tooltip :content="t('common.edit')" placement="top">
              <Button
                size="small"
                theme="default"
                variant="text"
                :disabled="!server.enabled"
                @click="openEditDialog(server)"
              >
                <EditIcon />
              </Button>
            </Tooltip>
            <Popconfirm
              theme="danger"
              :content="t('claude.mcpView.deleteConfirm')"
              @confirm="deleteMcpServer(server)"
            >
              <Tooltip :content="t('common.delete')" placement="top">
                <Button size="small" theme="danger" variant="text">
                  <DeleteIcon />
                </Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </template>

        <template #body>
          <div class="mcp-info-row">
            <div class="info-item config-summary">
              {{ getConfigSummary(server.config) || t('claude.mcpView.noDetailConfig') }}
            </div>
            <div v-if="mcpUsage[server.name]" class="mcp-stats">
              <Tag size="small" variant="light" theme="primary">{{ t('claude.usageCount', { count: mcpUsage[server.name].usageCount }) }}</Tag>
              <span class="mcp-last-used">{{ formatLastUsed(mcpUsage[server.name].lastUsedAt) }}</span>
            </div>
          </div>
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
