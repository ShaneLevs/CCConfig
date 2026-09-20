<script setup>

import { ref, computed, onMounted } from "vue";
import {
  Empty, Button, Tag, Space, Tooltip, MessagePlugin, Popconfirm,
  Dropdown, DropdownMenu, DropdownItem, DialogPlugin,
  RadioGroup, RadioButton, Dialog, Checkbox, Input,
} from "tdesign-vue-next";
import {
  RefreshIcon, AddIcon, MoreIcon, ToolsIcon, EditIcon, DeleteIcon,
  SettingIcon, FolderOpenIcon,
} from "tdesign-icons-vue-next";
import McpToolDrawer from "../../components/McpToolDrawer.vue";
import McpServerDialog from "../../components/McpServerDialog.vue";
import McpServerCard from "../../components/McpServerCard.vue";
import "./styles/McpView.css";

// 通用 MCP 库：本地（多个本地 JSON 文件，位置可设置，见头部齿轮按钮）与云端 (uTools DB) 合并为单一列表
//   - 每条卡片用 tag 标注来源（本地 / 云端，可同时存在）
//   - 顶部按钮组可按 全部/本地/云端 快速筛选
//   - 删除 = 两端同时删除；三点菜单按归属差异化：仅本地→「本地到云端」、
//     仅云端→「云端到本地」、双端→「移除本地/移除云端」
//   - 添加/编辑弹窗内可选择保存目标端
//   - 本地端为镜像语义：所有选中位置保持同一份配置，保存位置/刷新时合并后写回全部文件
//   - 本地存放位置：预置四个常见路径多选 + 自定义文件，未配置时默认 ~/.mcp.json

const loading = ref(false);

// 来源筛选：all | local | cloud
const filterType = ref('all');

// 筛选后的展示列表
const filteredServers = computed(() => {
  if (filterType.value === 'local') return mergedServers.value.filter((s) => s.hasLocal);
  if (filterType.value === 'cloud') return mergedServers.value.filter((s) => s.hasCloud);
  return mergedServers.value;
});

// 两个存储端
const localServers = ref([]);
const cloudServers = ref([]);

// MCP 添加/编辑弹窗（通用组件）：「保存到」本地/云端为多选，勾选几端写几端；
// 编辑时取消勾选某端 = 从该端删除副本（统一控制语义，同位置设置里的取消勾选）
const mcpDialogRef = ref(null);
const openCreateDialog = () => {
  mcpDialogRef.value?.open('create', '', null, ['local', 'cloud']);
};
const openEditDialog = (item) => {
  const targets = [
    ...(item.hasLocal ? ['local'] : []),
    ...(item.hasCloud ? ['cloud'] : []),
  ];
  mcpDialogRef.value?.open('edit', item.name, item.config, targets);
};
const handleSaveMcp = ({ mode, name, config, target }) => {
  try {
    const targets = Array.isArray(target) ? target : [target];
    const done = [];
    const removed = [];
    for (const t of ['local', 'cloud']) {
      if (targets.includes(t)) {
        if (t === 'local') window.services.upsertLocalMcpServer(name, config);
        else window.services.upsertCommonMcpServer(name, config);
        done.push(t === 'local' ? '本地' : '云端');
      } else if (mode === 'edit') {
        // 取消勾选的端：删除副本（返回 true = 原本存在并已删）
        const ok = t === 'local'
          ? window.services.deleteLocalMcpServer(name)
          : window.services.deleteCommonMcpServer(name);
        if (ok) removed.push(t === 'local' ? '本地' : '云端');
      }
    }
    let msg = `${done.join('、')}服务器 ${name} ${mode === 'create' ? '已添加' : '已更新'}`;
    if (removed.length) msg += `，已移除${removed.join('、')}副本`;
    MessagePlugin.success(msg);
    mcpDialogRef.value?.close();
    loadServers();
  } catch (e) {
    MessagePlugin.error('保存失败: ' + e.message);
  }
};

// 合并列表：以名称为键合并两端，同名的本地/云端并列展示
const mergedServers = computed(() => {
  const map = new Map();
  for (const s of localServers.value) {
    map.set(s.name, { name: s.name, local: s, cloud: null });
  }
  for (const s of cloudServers.value) {
    const ex = map.get(s.name);
    if (ex) ex.cloud = s;
    else map.set(s.name, { name: s.name, local: null, cloud: s });
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      hasLocal: !!item.local,
      hasCloud: !!item.cloud,
      // 生效配置：本地优先（本地是 agent 实际读取的）
      config: (item.local || item.cloud).config,
      diff: !!item.local && !!item.cloud
        && JSON.stringify(item.local.config) !== JSON.stringify(item.cloud.config),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

// 工具抽屉
const showToolDrawer = ref(false);
const toolServerName = ref('');
const toolServerConfig = ref(null);

const targetLabel = (t) => (t === 'local' ? '本地' : '云端');

const loadServers = () => {
  try {
    localServers.value = Object.entries(window.services.getLocalMcpServers() || {}).map(([name, config]) => ({ name, config }));
  } catch (e) {
    console.error("加载本地 MCP 服务器失败:", e);
    localServers.value = [];
  }
  try {
    cloudServers.value = Object.entries(window.services.getCommonMcpServers() || {}).map(([name, config]) => ({ name, config }));
  } catch (e) {
    console.error("加载云端 MCP 服务器失败:", e);
    cloudServers.value = [];
  }
};

// 刷新 = 先镜像同步再重载：若外部（agent / 手工）改过某个选中文件，
// 刷新会把所有文件的 mcpServers 合并后写回全部位置，保证各处完全一致
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

// 删除 = 两端同时删除
const deleteBoth = (item) => {
  const removed = [];
  try {
    if (item.hasLocal) {
      window.services.deleteLocalMcpServer(item.name);
      removed.push('本地');
    }
    if (item.hasCloud) {
      window.services.deleteCommonMcpServer(item.name);
      removed.push('云端');
    }
    if (removed.length === 0) { MessagePlugin.warning('未找到该服务器'); return; }
    MessagePlugin.success(`已删除 ${item.name}（${removed.join('、')}）`);
    loadServers();
  } catch (e) {
    MessagePlugin.error('删除失败: ' + e.message);
  }
};

// 单端移除（仅删某一端副本）
const removeSide = (item, side) => {
  try {
    if (side === 'local') {
      window.services.deleteLocalMcpServer(item.name);
    } else {
      window.services.deleteCommonMcpServer(item.name);
    }
    MessagePlugin.success(`已移除${targetLabel(side)}副本 ${item.name}`);
    loadServers();
  } catch (e) {
    MessagePlugin.error('移除失败: ' + e.message);
  }
};
const confirmRemoveSide = (item, side) => {
  // TDesign v1.20.3 的 DialogPlugin.confirm 不会在 onConfirm 后自动关闭，
  // 需用返回的实例手动 destroy（否则弹窗会一直挂着）
  const dialog = DialogPlugin.confirm({
    header: '移除确认',
    body: `确定移除「${item.name}」的${targetLabel(side)}副本吗？（${targetLabel(side === 'local' ? 'cloud' : 'local')}端保留）`,
    confirmBtn: '移除',
    cancelBtn: '取消',
    onConfirm: () => {
      removeSide(item, side);
      dialog.destroy();
    },
  });
};

// 单端复制：source 为源端（local → 复制到云端；cloud → 复制到本地），同名覆盖目标端
const copyFrom = (item, source) => {
  const dest = source === 'local' ? 'cloud' : 'local';
  try {
    window.services.copyCommonMcpServer(item.name, dest);
    MessagePlugin.success(`已复制 "${item.name}" ${targetLabel(source)} → ${targetLabel(dest)}`);
    loadServers();
  } catch (e) {
    MessagePlugin.error('复制失败: ' + e.message);
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
        <RadioGroup v-model="filterType" variant="default-filled" size="small" class="common-mcp-filter">
          <RadioButton value="all">全部</RadioButton>
          <RadioButton value="local">本地</RadioButton>
          <RadioButton value="cloud">云端</RadioButton>
        </RadioGroup>
        <span>通用 MCP 服务器库 — 本地（{{ targetsSummary }}）与云端 (DB) 合并展示</span>
        <span class="common-mcp-count">{{ filteredServers.length }} 个</span>
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

    <div v-if="filteredServers.length === 0" class="common-mcp-empty">
      <Empty :description="mergedServers.length === 0 ? '还没有 MCP 服务器，点击右上角「添加」创建' : '当前筛选条件下没有 MCP 服务器'" />
    </div>

    <div v-else class="common-mcp-list">
      <McpServerCard
        v-for="item in filteredServers"
        :key="item.name"
        :srv="{ name: item.name, config: item.config }"
        :target="item.hasLocal ? 'local' : 'cloud'"
      >
        <template #tags>
          <Tag v-if="item.hasLocal" size="small" theme="success" variant="light">本地</Tag>
          <Tag v-if="item.hasCloud" size="small" theme="primary" variant="light">云端</Tag>
          <Tag v-if="item.diff" size="small" theme="warning" variant="light">配置不同</Tag>
        </template>

        <template #actions>
          <Space size="small">
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
            <Dropdown trigger="click" placement="bottom-right">
              <Button size="small" variant="text" title="更多操作">
                <template #icon><MoreIcon /></template>
              </Button>
              <template #dropdown>
                <DropdownMenu>
                  <!-- 仅本地：本地 → 云端 -->
                  <DropdownItem
                    v-if="item.hasLocal && !item.hasCloud"
                    @click="copyFrom(item, 'local')"
                  >本地到云端</DropdownItem>
                  <!-- 仅云端：云端 → 本地 -->
                  <DropdownItem
                    v-if="item.hasCloud && !item.hasLocal"
                    @click="copyFrom(item, 'cloud')"
                  >云端到本地</DropdownItem>
                  <!-- 同时存在两端：移除单端 -->
                  <template v-if="item.hasLocal && item.hasCloud">
                    <DropdownItem @click="confirmRemoveSide(item, 'local')">移除本地</DropdownItem>
                    <DropdownItem @click="confirmRemoveSide(item, 'cloud')">移除云端</DropdownItem>
                  </template>
                </DropdownMenu>
              </template>
            </Dropdown>
            <Popconfirm
              content="将从本地与云端同时删除该服务器，确定？"
              @confirm="deleteBoth(item)"
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
      :show-target="true"
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
          所有勾选的位置保持同一份 MCP 配置（镜像）：保存时会把已勾选文件的服务器合并后写回全部位置；
          添加 / 编辑 / 删除同步到所有文件，点「刷新」也会重新对齐（同名冲突以 ~/.mcp.json 优先）。
          取消勾选某个位置并保存，会删除该文件中本库管理的服务器（其他来源独有的条目保留）。
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
            placeholder="如 ~/my-agent/mcp.json（支持 ~ 前缀）"
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
        <div class="mcp-targets-hint">建议文件名使用 .mcp.json 或 mcp.json，所在目录不存在时会自动创建</div>
      </div>
    </Dialog>
  </div>
</template>
