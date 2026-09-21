<script setup>

import { ref, onMounted } from "vue";
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
    MessagePlugin.success(mode === 'create' ? `服务器 ${name} 已添加（默认开启并写入本地）` : `服务器 ${name} 已更新`);
    mcpDialogRef.value?.close();
    loadServers();
  } catch (e) {
    MessagePlugin.error('保存失败: ' + e.message);
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
        MessagePlugin.warning(`同步失败 ${res.failed.length} 个文件: ${res.failed.map((f) => window.services.toDisplayMcpPath(f)).join('、')}`);
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
const targetsSummary = ref("");

const refreshTargetsSummary = () => {
  try {
    const paths = window.services.getLocalMcpTargetPaths() || [];
    targetsSummary.value = paths.length === 1
      ? window.services.toDisplayMcpPath(paths[0])
      : `${paths.length} 个本地文件`;
  } catch (e) {
    targetsSummary.value = "~/.mcp.json";
  }
};
refreshTargetsSummary();

const openTargetsDialog = () => {
  try {
    targetsInfo.value = window.services.getLocalMcpTargetsInfo();
    targetsSelected.value = [...(targetsInfo.value.selected || [])];
    customInput.value = "";
    targetsDialogVisible.value = true;
  } catch (e) {
    MessagePlugin.error('读取存放位置失败: ' + e.message);
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
  if (!raw) { MessagePlugin.warning('请输入文件路径或先选择文件'); return; }
  const abs = window.services.resolveMcpPath(raw);
  if (!/\.json$/i.test(abs)) {
    MessagePlugin.warning('仅支持 .json 文件（非 JSON 会被整文件覆盖破坏）');
    return;
  }
  const all = [
    ...targetsInfo.value.presets.map((p) => p.path),
    ...targetsInfo.value.custom.map((p) => p.path),
  ];
  if (all.includes(abs)) {
    if (!targetsSelected.value.includes(abs)) toggleTarget(abs, true);
    customInput.value = '';
    MessagePlugin.info('该路径已在列表中，已为你勾选');
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
    let msg = `已保存并同步到 ${savedPaths.length} 个位置（配置保持一致）`;
    if (removedList.length)
      msg += `，已从 ${removedList.length} 个取消位置删除本库配置`;
    MessagePlugin.success(msg);
    targetsDialogVisible.value = false;
    refreshTargetsSummary();
    loadServers();
  } catch (e) {
    MessagePlugin.error('保存失败: ' + e.message);
  }
};

// 启用开关：开 = 写入全部选中本地文件，关 = 从本地移除（云端主档始终保留一份）
const onToggleEnabled = (item, val) => {
  try {
    const res = window.services.setCommonMcpEnabled(item.name, !!val);
    item.enabled = !!val;
    const failed = (res && res.failed) || [];
    if (failed.length)
      MessagePlugin.warning(
        `本地 ${failed.length} 个文件操作失败: ${failed.map((f) => window.services.toDisplayMcpPath(f)).join('、')}`,
      );
    else
      MessagePlugin.success(val ? `${item.name} 已开启，写入本地` : `${item.name} 已关闭，从本地移除（云端保留一份）`);
  } catch (e) {
    MessagePlugin.error('切换失败: ' + e.message);
    loadServers();
  }
};

// 删除 = 从云端主档与全部本地文件一并移除
const deleteServer = (item) => {
  try {
    window.services.deleteCommonMcpServer(item.name);
    MessagePlugin.success(`已删除 ${item.name}（云端主档与本地文件）`);
    loadServers();
  } catch (e) {
    MessagePlugin.error('删除失败: ' + e.message);
  }
};

// 卡片上的配置摘要（单行，与 Claude MCP 卡片风格一致）
const getConfigSummary = (config) => {
  const parts = [];
  if (config.command) parts.push(`cmd: ${config.command}`);
  if (config.url) parts.push(`url: ${config.url}`);
  if (config.args?.length) parts.push(`args: ${config.args.length} 个`);
  const envCount = Object.keys(config.env || {}).length;
  if (envCount) parts.push(`env: ${envCount} 个`);
  const headerCount = Object.keys(config.headers || {}).length;
  if (headerCount) parts.push(`headers: ${headerCount} 个`);
  return parts.join(" | ") || "无详细配置";
};

// 查看工具：探活与展示逻辑在通用组件 McpToolDrawer 内（用生效配置）
const openToolDrawer = (item) => {
  toolServerName.value = item.name;
  toolServerConfig.value = item.config;
  showToolDrawer.value = true;
};

onMounted(() => {
  loadServers();
  refreshTargetsSummary();
});
</script>

<template>
  <div class="common-mcp-container">
    <div class="common-mcp-header">
      <div class="common-mcp-tip">
        <span>通用 MCP 服务器库 — 云端 (DB) 统一保管，开启的服务器镜像写入本地（{{ targetsSummary }}）</span>
        <span class="common-mcp-count">{{ servers.length }} 个</span>
      </div>
      <div class="common-mcp-actions">
        <Tooltip content="本地存放位置设置" placement="top">
          <Button size="small" variant="outline" @click="openTargetsDialog">
            <template #icon><SettingIcon /></template>
          </Button>
        </Tooltip>
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> 添加
        </Button>
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="servers.length === 0" class="common-mcp-empty">
      <Empty description="还没有 MCP 服务器，点击右上角「添加」创建" />
    </div>

    <div v-else class="common-mcp-list">
      <McpServerCard
        v-for="item in servers"
        :key="item.name"
        :srv="{ name: item.name, config: item.config }"
        :disabled="!item.enabled"
      >
        <template #tags>
          <Tag v-if="item.enabled" size="small" theme="success" variant="light">已开启</Tag>
          <Tag v-else size="small" theme="default" variant="light">已关闭</Tag>
        </template>

        <template #actions>
          <Space size="small" align="center">
            <Tooltip :content="item.enabled ? '已开启：已写入本地文件，点击关闭并从本地移除' : '已关闭：未写入本地，点击开启并写入本地'" placement="top">
              <Switch :value="item.enabled" size="small" @change="(v) => onToggleEnabled(item, v)" />
            </Tooltip>
            <Tooltip content="查看工具" placement="top">
              <Button size="small" variant="text" @click="openToolDrawer(item)">
                <template #icon><ToolsIcon /></template>
              </Button>
            </Tooltip>
            <Tooltip content="编辑" placement="top">
              <Button size="small" variant="text" @click="openEditDialog(item)">
                <template #icon><EditIcon /></template>
              </Button>
            </Tooltip>
            <Popconfirm
              theme="danger"
              content="将从云端主档与本地文件一并删除，确定？"
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
      header="本地 MCP 存放位置"
      width="560px"
      confirm-btn="保存"
      cancel-btn="取消"
      :close-on-confirm="false"
      @confirm="saveTargets"
    >
      <div class="mcp-targets-body">
        <p class="mcp-targets-desc">
          所有勾选的位置保持同一份 MCP 配置（= 云端主档中已启用服务器的镜像）：切换开关 / 添加 / 编辑 / 删除都会同步到全部位置；
          点「刷新」会先把文件中主档没有的服务器并入主档，再写回全部位置（同名条目以云端主档为准）。
          取消勾选某个位置并保存，会删除该文件中已启用的服务器（其他来源独有的条目保留）。
          很多 Agent 并不读 ~/.mcp.json，请按你实际使用的 Agent 勾选对应位置。
        </p>
        <div class="mcp-targets-section-title">预置位置</div>
        <div class="mcp-targets-list">
          <div v-for="p in targetsInfo.presets" :key="p.path" class="mcp-target-row">
            <Checkbox
              :checked="targetsSelected.includes(p.path)"
              :label="p.label"
              @change="(checked) => toggleTarget(p.path, checked)"
            />
            <Tag v-if="p.exists" size="small" theme="success" variant="light">文件已存在</Tag>
          </div>
        </div>
        <template v-if="targetsInfo.custom.length">
          <div class="mcp-targets-section-title">自定义位置</div>
          <div class="mcp-targets-list">
            <div v-for="c in targetsInfo.custom" :key="c.path" class="mcp-target-row">
              <Checkbox
                :checked="targetsSelected.includes(c.path)"
                :label="c.label"
                @change="(checked) => toggleTarget(c.path, checked)"
              />
              <Tag v-if="c.exists" size="small" theme="success" variant="light">文件已存在</Tag>
              <Button class="mcp-target-remove" size="small" variant="text" theme="danger" @click="removeCustomTarget(c.path)">
                删除
              </Button>
            </div>
          </div>
        </template>
        <div class="mcp-targets-section-title">添加自定义路径</div>
        <div class="mcp-targets-add-row">
          <Input
            v-model="customInput"
            class="mcp-targets-add-input"
            placeholder="如 ~/my-agent/mcp.json（仅支持 .json，支持 ~ 前缀）"
            clearable
            @enter="addCustomTarget"
          />
          <Tooltip content="选择已有文件" placement="top">
            <Button variant="outline" @click="browseCustomFile">
              <template #icon><FolderOpenIcon /></template>
            </Button>
          </Tooltip>
          <Button theme="primary" @click="addCustomTarget">添加</Button>
        </div>
        <div class="mcp-targets-hint">仅限 .json 文件，建议文件名使用 .mcp.json 或 mcp.json，所在目录不存在时会自动创建</div>
      </div>
    </Dialog>
  </div>
</template>
