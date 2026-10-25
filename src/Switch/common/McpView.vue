<script setup>

import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Space, Tooltip, MessagePlugin, Popconfirm,
  Dialog, Checkbox, Input, Switch,
} from "tdesign-vue-next";
import {
  RefreshIcon, AddIcon, ToolsIcon, EditIcon, DeleteIcon,
  SettingIcon, FolderOpenIcon,
} from "tdesign-icons-vue-next";
import McpToolDrawer from "../../components/McpToolDrawer.vue";
import McpServerDialog from "../../components/McpServerDialog.vue";
import McpServerCard from "../../components/McpServerCard.vue";
import "./styles/McpView.css";

const { t } = useI18n();

// 通用 MCP 库：云端 (uTools DB) 是唯一主档，所有服务器都存一份；本地（多个 JSON 文件，
//   位置由头部齿轮按钮设置）是它的镜像，每条卡片一个启用开关：
//   - 开启 = 写入全部选中本地文件（镜像一致）；关闭 = 从本地文件移除（云端仍保留一份）
//   - 启停状态按机器隔离；首次进入按「本地文件中已存在 → 启用」初始化
//   - 顶部不再按启停筛选，全部服务器统一展示（卡片开关 + tag 区分启用态）；删除 = 主档与本地一并删除
//   - 添加/编辑总是写主档，再按当前启用状态同步本地文件
//   - 多文件镜像 / 存放位置逻辑不变：刷新/保存位置时先把文件中主档没有的服务器并入主档，再写回全部位置

const loading = ref(false);

// 主档服务器列表 [{ name, config, enabled }]
const servers = ref([]);

// MCP 添加/编辑弹窗（通用组件）：保存总是写云端主档，并按该服务器当前启用状态同步本地文件
const mcpDialogRef = ref(null);
const openCreateDialog = () => {
  mcpDialogRef.value?.open('create', '', null);
};
const openEditDialog = (item) => {
  mcpDialogRef.value?.open('edit', item.name, item.config);
};
const handleSaveMcp = ({ mode, name, config }) => {
  try {
    window.services.upsertCommonMcpServer(name, config);
    MessagePlugin.success(mode === 'create' ? t('commonApp.mcp.addedToast', { name }) : t('commonApp.mcp.updatedToast', { name }));
    mcpDialogRef.value?.close();
    loadServers();
  } catch (e) {
    MessagePlugin.error(t('common.saveFailed') + ': ' + e.message);
  }
};

// 工具抽屉
const showToolDrawer = ref(false);
const toolServerName = ref('');
const toolServerConfig = ref(null);

const loadServers = () => {
  try {
    servers.value = (window.services.listCommonMcpServers() || []).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.error("加载 MCP 服务器失败:", e);
    servers.value = [];
  }
};

// 刷新 = 回收 + 镜像：先把本地文件中主档没有的服务器并入主档，再把已启用服务器写回全部位置；
// 若外部（agent / 手工）改过某个选中文件，同名条目以云端主档为准
const refresh = () => {
  loading.value = true;
  setTimeout(() => {
    try {
      const res = window.services.syncLocalMcpTargets();
      if (res && res.failed && res.failed.length) {
        MessagePlugin.warning(t('commonApp.mcp.syncFailed', {
          count: res.failed.length,
          files: res.failed.map((f) => window.services.toDisplayMcpPath(f)).join(t('common.listSeparator')),
        }));
      }
    } catch (e) {
      console.error("镜像同步本地 MCP 失败:", e);
    }
    loadServers();
    loading.value = false;
  }, 50);
};

// ---------- 本地存放位置设置（齿轮弹窗） ----------
const targetsDialogVisible = ref(false);
const targetsSelected = ref([]); // 选中的绝对路径集合（预置 + 自定义）
const targetsInfo = ref({ presets: [], custom: [] });
const customInput = ref("");

const openTargetsDialog = () => {
  try {
    targetsInfo.value = window.services.getLocalMcpTargetsInfo();
    targetsSelected.value = [...(targetsInfo.value.selected || [])];
    customInput.value = "";
    targetsDialogVisible.value = true;
  } catch (e) {
    MessagePlugin.error(t('commonApp.mcp.readTargetsFailed', { message: e.message }));
  }
};

const toggleTarget = (p, checked) => {
  const set = new Set(targetsSelected.value);
  if (checked) set.add(p); else set.delete(p);
  targetsSelected.value = [...set];
};

// 浏览选择已有文件，填入自定义输入框（路径解析在保存时统一处理，支持 ~ 前缀）
const browseCustomFile = () => {
  const picked = window.services.selectLocalMcpTargetFile();
  if (picked) customInput.value = window.services.toDisplayMcpPath(picked);
};

const addCustomTarget = () => {
  const raw = customInput.value.trim();
  if (!raw) { MessagePlugin.warning(t('commonApp.mcp.pathRequired')); return; }
  const abs = window.services.resolveMcpPath(raw);
  if (!/\.json$/i.test(abs)) {
    MessagePlugin.warning(t('commonApp.mcp.jsonOnly'));
    return;
  }
  const all = [
    ...targetsInfo.value.presets.map((p) => p.path),
    ...targetsInfo.value.custom.map((p) => p.path),
  ];
  if (all.includes(abs)) {
    if (!targetsSelected.value.includes(abs)) toggleTarget(abs, true);
    customInput.value = '';
    MessagePlugin.info(t('commonApp.mcp.alreadyInList'));
    return;
  }
  targetsInfo.value = {
    ...targetsInfo.value,
    custom: [...targetsInfo.value.custom, { path: abs, label: window.services.toDisplayMcpPath(abs), exists: false }],
  };
  targetsSelected.value = [...targetsSelected.value, abs];
  customInput.value = "";
};

const removeCustomTarget = (p) => {
  targetsInfo.value = {
    ...targetsInfo.value,
    custom: targetsInfo.value.custom.filter((c) => c.path !== p),
  };
  targetsSelected.value = targetsSelected.value.filter((x) => x !== p);
};

const saveTargets = () => {
  try {
    const res = window.services.saveLocalMcpTargets(targetsSelected.value);
    // 兼容旧 preload（返回裸数组）：uTools 开发时渲染层热更新但 preload 只在插件
    // 重新载入时才刷新，两种形态都归一化处理
    const savedPaths = Array.isArray(res) ? res : (res && res.paths) || [];
    const removedList = Array.isArray(res) ? [] : (res && res.removed) || [];
    targetsSelected.value = savedPaths;
    let msg = t('commonApp.mcp.targetsSaved', { count: savedPaths.length });
    if (removedList.length)
      msg += t('commonApp.mcp.targetsRemoved', { count: removedList.length });
    MessagePlugin.success(msg);
    targetsDialogVisible.value = false;
    loadServers();
  } catch (e) {
    MessagePlugin.error(t('common.saveFailed') + ': ' + e.message);
  }
};

// 启用开关：开 = 写入全部选中本地文件，关 = 从本地移除（云端主档始终保留一份）
const onToggleEnabled = (item, val) => {
  try {
    const res = window.services.setCommonMcpEnabled(item.name, !!val);
    item.enabled = !!val;
    const failed = (res && res.failed) || [];
    if (failed.length)
      MessagePlugin.warning(t('commonApp.mcp.localFilesFailed', {
        count: failed.length,
        files: failed.map((f) => window.services.toDisplayMcpPath(f)).join(t('common.listSeparator')),
      }));
    else
      MessagePlugin.success(val ? t('commonApp.mcp.enabledToast', { name: item.name }) : t('commonApp.mcp.disabledToast', { name: item.name }));
  } catch (e) {
    MessagePlugin.error(t('commonApp.mcp.toggleFailed', { message: e.message }));
    loadServers();
  }
};

// 删除 = 从云端主档与全部本地文件一并移除
const deleteServer = (item) => {
  try {
    window.services.deleteCommonMcpServer(item.name);
    MessagePlugin.success(t('commonApp.mcp.deletedToast', { name: item.name }));
    loadServers();
  } catch (e) {
    MessagePlugin.error(t('common.deleteFailed') + ': ' + e.message);
  }
};

// 卡片上的配置摘要（单行，与 Claude MCP 卡片风格一致）
const getConfigSummary = (config) => {
  const parts = [];
  if (config.command) parts.push(`cmd: ${config.command}`);
  if (config.url) parts.push(`url: ${config.url}`);
  if (config.args?.length) parts.push(t('commonApp.mcp.argsCount', { count: config.args.length }));
  const envCount = Object.keys(config.env || {}).length;
  if (envCount) parts.push(t('commonApp.mcp.envCount', { count: envCount }));
  const headerCount = Object.keys(config.headers || {}).length;
  if (headerCount) parts.push(t('commonApp.mcp.headersCount', { count: headerCount }));
  return parts.join(" | ") || t('commonApp.mcp.noConfigSummary');
};

// 查看工具：探活与展示逻辑在通用组件 McpToolDrawer 内（用生效配置）
const openToolDrawer = (item) => {
  toolServerName.value = item.name;
  toolServerConfig.value = item.config;
  showToolDrawer.value = true;
};

onMounted(() => {
  loadServers();
});
</script>

<template>
  <div class="common-mcp-container">
    <div class="common-mcp-header">
      <div class="common-mcp-tip">
        <span class="common-mcp-count">{{ t('common.countItems', { count: servers.length }) }}</span>
      </div>
      <div class="common-mcp-actions">
        <Tooltip :content="t('commonApp.mcp.targetsTooltip')" placement="top">
          <Button size="small" variant="outline" @click="openTargetsDialog">
            <template #icon><SettingIcon /></template>
          </Button>
        </Tooltip>
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> {{ t('common.add') }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="servers.length === 0" class="common-mcp-empty">
      <Empty :description="t('commonApp.mcp.empty')" />
    </div>

    <div v-else class="common-mcp-list">
      <McpServerCard
        v-for="item in servers"
        :key="item.name"
        :srv="{ name: item.name, config: item.config }"
        :disabled="!item.enabled"
      >
        <template #tags>
          <Tag v-if="item.enabled" size="small" theme="success" variant="light">{{ t('commonApp.mcp.enabledTag') }}</Tag>
          <Tag v-else size="small" theme="default" variant="light">{{ t('commonApp.mcp.disabledTag') }}</Tag>
        </template>

        <template #actions>
          <Space size="small" align="center">
            <Tooltip :content="item.enabled ? t('commonApp.mcp.toggleOnHint') : t('commonApp.mcp.toggleOffHint')" placement="top">
              <Switch :value="item.enabled" size="small" @change="(v) => onToggleEnabled(item, v)" />
            </Tooltip>
            <Tooltip :content="t('mcp.viewTools')" placement="top">
              <Button size="small" variant="text" @click="openToolDrawer(item)">
                <template #icon><ToolsIcon /></template>
              </Button>
            </Tooltip>
            <Tooltip :content="t('common.edit')" placement="top">
              <Button size="small" variant="text" @click="openEditDialog(item)">
                <template #icon><EditIcon /></template>
              </Button>
            </Tooltip>
            <Popconfirm
              theme="danger"
              :content="t('commonApp.mcp.deleteConfirm')"
              @confirm="deleteServer(item)"
            >
              <Button size="small" variant="text" theme="danger">
                <template #icon><DeleteIcon /></template>
              </Button>
            </Popconfirm>
          </Space>
        </template>
        <template #body>
          <div class="common-mcp-info-row">
            <div class="common-mcp-config-summary">
              {{ getConfigSummary(item.config) }}
            </div>
          </div>
        </template>
      </McpServerCard>
    </div>

    <McpServerDialog
      ref="mcpDialogRef"
      :name-disabled-on-edit="true"
      @save="handleSaveMcp"
    />

    <McpToolDrawer
      v-model:visible="showToolDrawer"
      :server-name="toolServerName"
      :config="toolServerConfig"
    />

    <!-- 本地 MCP 存放位置设置：预置多选 + 自定义路径（多选 = 写入时同步到全部文件） -->
    <Dialog
      v-model:visible="targetsDialogVisible"
      :header="t('commonApp.mcp.targetsTitle')"
      width="560px"
      :confirm-btn="t('common.save')"
      :cancel-btn="t('common.cancel')"
      :close-on-confirm="false"
      @confirm="saveTargets"
    >
      <div class="mcp-targets-body">
        <p class="mcp-targets-desc">
          {{ t('commonApp.mcp.targetsDesc') }}
        </p>
        <div class="mcp-targets-section-title">{{ t('commonApp.mcp.presetsTitle') }}</div>
        <div class="mcp-targets-list">
          <div v-for="p in targetsInfo.presets" :key="p.path" class="mcp-target-row">
            <Checkbox
              :checked="targetsSelected.includes(p.path)"
              :label="p.label"
              @change="(checked) => toggleTarget(p.path, checked)"
            />
            <Tag v-if="p.exists" size="small" theme="success" variant="light">{{ t('commonApp.mcp.fileExists') }}</Tag>
          </div>
        </div>
        <template v-if="targetsInfo.custom.length">
          <div class="mcp-targets-section-title">{{ t('commonApp.mcp.customTitle') }}</div>
          <div class="mcp-targets-list">
            <div v-for="c in targetsInfo.custom" :key="c.path" class="mcp-target-row">
              <Checkbox
                :checked="targetsSelected.includes(c.path)"
                :label="c.label"
                @change="(checked) => toggleTarget(c.path, checked)"
              />
              <Tag v-if="c.exists" size="small" theme="success" variant="light">{{ t('commonApp.mcp.fileExists') }}</Tag>
              <Button class="mcp-target-remove" size="small" variant="text" theme="danger" @click="removeCustomTarget(c.path)">
                {{ t('common.delete') }}
              </Button>
            </div>
          </div>
        </template>
        <div class="mcp-targets-section-title">{{ t('commonApp.mcp.addCustomTitle') }}</div>
        <div class="mcp-targets-add-row">
          <Input
            v-model="customInput"
            class="mcp-targets-add-input"
            :placeholder="t('commonApp.mcp.customPlaceholder')"
            clearable
            @enter="addCustomTarget"
          />
          <Tooltip :content="t('commonApp.mcp.selectExistingFile')" placement="top">
            <Button variant="outline" @click="browseCustomFile">
              <template #icon><FolderOpenIcon /></template>
            </Button>
          </Tooltip>
          <Button theme="primary" @click="addCustomTarget">{{ t('common.add') }}</Button>
        </div>
        <div class="mcp-targets-hint">{{ t('commonApp.mcp.jsonHint') }}</div>
      </div>
    </Dialog>
  </div>
</template>
