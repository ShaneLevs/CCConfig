<script setup>

import { ref, onMounted } from "vue";
import {
  Empty, Button, Tag, Space, Tooltip, Dialog, Input, MessagePlugin, Popconfirm, Select, Switch, Collapse, CollapsePanel, Textarea,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, SendIcon, DownloadIcon, UploadIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import ModelFormDialog from "../../components/ModelFormDialog.vue";
import BatchAddModelsDialog from "./components/BatchAddModelsDialog.vue";
import DispatchDialog from "./components/DispatchDialog.vue";
import { formatNumber } from "../../utils/format";
import "./styles/ConfigView.css";

// 通用配置：跨 agent 的供应商/模型主数据库
const API_TYPE_OPTIONS = [
  { label: "OpenAI Chat Completions", value: "openai-completions" },
  { label: "OpenAI Responses", value: "openai-responses" },
  { label: "Anthropic Messages", value: "anthropic-messages" },
  { label: "Google Generative AI", value: "google-generative-ai" },
];

// 常用请求头名（自动完成提示）
const HEADER_KEY_OPTIONS = [
  "x-portkey-api-key",
  "x-api-key",
  "Authorization",
  "x-secret",
];

// 常用 compat 字段名（自动完成提示，传给模型弹窗）
const COMPAT_KEY_OPTIONS = [
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "maxTokensField",
  "supportsStore",
  "thinkingFormat",
];

const loading = ref(false);
const providers = ref([]);
const expandedList = ref([]);
const editDialog = ref(false);
const editingProvider = ref(null);
const editForm = ref({ apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true });
const addProviderDialog = ref(false);
const addProviderForm = ref({ name: '', apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true });
// 编辑时的新名称（供应商重命名 = 删旧 + 建新）
const newProviderName = ref('');

// 模型弹窗（添加/编辑共用 ModelFormDialog）
const modelFormVisible = ref(false);
const modelFormMode = ref('add');
const modelFormProviderName = ref('');
const modelFormProvider = ref(null);
const modelFormInitial = ref(null);

// 批量添加弹窗
const batchVisible = ref(false);
const batchProvider = ref(null);

const loadProviders = () => {
  try {
    providers.value = window.services.getCommonProviderList();
  } catch (e) {
    console.error("加载通用供应商失败:", e);
    providers.value = [];
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.name;
  newProviderName.value = provider.name;
  editForm.value = {
    apiKey: provider.apiKey || '',
    baseUrl: provider.baseUrl || '',
    api: provider.api || 'openai-completions',
    headers: provider.headers ? Object.entries(provider.headers).map(([key, value]) => ({ key, value })) : [],
    authHeader: provider.authHeader !== undefined ? provider.authHeader : true,
  };
  editDialog.value = true;
};

const handleSaveProvider = async () => {
  try {
    const headersObj = {};
    (editForm.value.headers || []).forEach(({ key, value }) => {
      if (key && key.trim()) headersObj[key.trim()] = value;
    });
    const finalName = newProviderName.value.trim() || editingProvider.value;
    if (finalName !== editingProvider.value) {
      // 重命名：删除旧供应商 + 新建（模型跟随迁移）
      const { providers: list } = window.services.readCommonProviders();
      const oldProv = list.find((p) => p.name === editingProvider.value);
      if (!oldProv) throw new Error(`供应商 ${editingProvider.value} 不存在`);
      window.services.deleteCommonProvider(editingProvider.value);
      window.services.addCommonProvider({
        name: finalName,
        apiKey: editForm.value.apiKey,
        baseUrl: editForm.value.baseUrl,
        api: editForm.value.api,
        headers: headersObj,
        authHeader: editForm.value.authHeader,
        models: oldProv.models || [],
      });
    } else {
      window.services.updateCommonProvider(editingProvider.value, {
        apiKey: editForm.value.apiKey,
        baseUrl: editForm.value.baseUrl,
        api: editForm.value.api,
        headers: headersObj,
        authHeader: editForm.value.authHeader,
      });
    }
    MessagePlugin.success("供应商配置已更新");
    editDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const openAddProviderDialog = () => {
  addProviderForm.value = { name: '', apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true };
  addProviderDialog.value = true;
};

const handleAddProvider = async () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning('请输入供应商名称'); return; }
    const headersObj = {};
    (addProviderForm.value.headers || []).forEach(({ key, value }) => {
      if (key && key.trim()) headersObj[key.trim()] = value;
    });
    window.services.addCommonProvider({
      name,
      apiKey: addProviderForm.value.apiKey,
      baseUrl: addProviderForm.value.baseUrl,
      api: addProviderForm.value.api,
      headers: headersObj,
      authHeader: addProviderForm.value.authHeader,
    });
    MessagePlugin.success(`供应商 ${name} 已添加`);
    addProviderDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error('添加失败: ' + e.message);
  }
};

const handleDeleteProvider = async (providerName) => {
  try {
    window.services.deleteCommonProvider(providerName);
    MessagePlugin.success(`供应商 ${providerName} 已删除`);
    loadProviders();
  } catch (e) {
    MessagePlugin.error('删除失败: ' + e.message);
  }
};

const openAddModelDialog = (providerName) => {
  modelFormMode.value = 'add';
  modelFormProviderName.value = providerName;
  modelFormProvider.value = providers.value.find(p => p.name === providerName) || null;
  modelFormInitial.value = null;
  modelFormVisible.value = true;
};

const openBatchAddDialog = (prov) => {
  batchProvider.value = prov;
  batchVisible.value = true;
};

const openEditModelDialog = (provName, m) => {
  modelFormMode.value = 'edit';
  modelFormProviderName.value = provName;
  modelFormProvider.value = null;
  modelFormInitial.value = m;
  modelFormVisible.value = true;
};

// 模型弹窗确认：添加 / 更新 / 重命名（删旧 + 建新）
const handleModelFormConfirm = async (payload) => {
  const model = {
    id: payload.id,
    name: payload.name,
    contextWindow: payload.contextWindow,
    maxTokens: payload.maxTokens,
    reasoning: payload.reasoning,
    input: payload.input,
    cost: payload.cost,
    compat: payload.compat,
  };
  try {
    if (payload.mode === 'add') {
      const ok = window.services.addCommonModel(payload.providerName, model);
      if (!ok) throw new Error('写入通用库失败，请重试');
      MessagePlugin.success(`模型 ${payload.id} 已添加`);
    } else if (payload.id !== payload.originalId) {
      // ID 有变化：删除旧模型，添加新模型
      const okDel = window.services.deleteCommonModel(payload.providerName, payload.originalId);
      if (!okDel) throw new Error('写入通用库失败，请重试');
      const okAdd = window.services.addCommonModel(payload.providerName, model);
      if (!okAdd) throw new Error('写入通用库失败，请重试');
      MessagePlugin.success('模型已更新');
    } else {
      const ok = window.services.updateCommonModel(payload.providerName, payload.originalId, model);
      if (!ok) throw new Error('写入通用库失败，请重试');
      MessagePlugin.success('模型已更新');
    }
    modelFormVisible.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error((payload.mode === 'add' ? '添加失败: ' : '保存失败: ') + e.message);
  }
};

const handleDeleteModel = async (providerName, modelId) => {
  try {
    const ok = window.services.deleteCommonModel(providerName, modelId);
    if (!ok) throw new Error('写入通用库失败，请重试');
    MessagePlugin.success(`模型 ${modelId} 已删除`);
    loadProviders();
  } catch (e) {
    MessagePlugin.error('删除失败: ' + e.message);
  }
};

// ==================== 下发到 Agent（主数据 → 各 agent 模型配置） ====================

const dispatchVisible = ref(false);
const dispatchInitialKeys = ref([]);

const openDispatchDialog = (providerName = "", modelId = "") => {
  dispatchInitialKeys.value = providerName && modelId ? [`${providerName}::${modelId}`] : [];
  dispatchVisible.value = true;
};

const refresh = () => {
  loading.value = true;
  setTimeout(() => { loadProviders(); loading.value = false; }, 50);
};

const copyText = (text) => {
  window.utools.copyText(text);
  MessagePlugin.success('已复制');
};

// ==================== 导入 / 导出（与 Claude Code 配置页同一套压缩 + 混淆字符串机制） ====================
const showImportDialog = ref(false);
const importString = ref("");

const handleExport = () => {
  if (!providers.value.length) return MessagePlugin.warning("没有可导出的供应商");
  window.utools.copyText(window.services.encryptString(window.services.compressConfigs(providers.value)));
  MessagePlugin.success("通用库已复制到剪贴板");
};

const openImportDialog = () => { importString.value = ""; showImportDialog.value = true; };

const handleImport = () => {
  const str = importString.value.trim();
  if (!str) return MessagePlugin.warning("请输入通用库字符串");
  const list = window.services.decompressConfigs(window.services.decryptString(str));
  if (!list || !Array.isArray(list)) return MessagePlugin.error("通用库字符串格式不正确");
  let ok = 0, skip = 0, fail = 0;
  for (const p of list) {
    if (!p || !p.name) { fail++; continue; }
    try {
      window.services.addCommonProvider({
        name: p.name,
        apiKey: p.apiKey || "",
        baseUrl: p.baseUrl || "",
        api: p.api || "openai-completions",
        headers: p.headers || {},
        authHeader: p.authHeader !== undefined ? p.authHeader : true,
        models: Array.isArray(p.models) ? p.models : [],
      });
      ok++;
    } catch (e) {
      if ((e.message || "").includes("已存在")) skip++; else fail++;
    }
  }
  loadProviders();
  showImportDialog.value = false;
  if (ok > 0 && skip === 0 && fail === 0) MessagePlugin.success(`成功导入 ${ok} 个供应商`);
  else if (ok > 0) MessagePlugin.warning(`成功导入 ${ok} 个，跳过 ${skip} 个已存在，失败 ${fail} 个`);
  else if (skip > 0) MessagePlugin.warning(`全部 ${skip} 个供应商已存在，未导入`);
  else MessagePlugin.error("导入失败");
};

onMounted(refresh);
</script>

<template>
  <div class="common-config-container">
    <div class="common-config-header">
      <span class="common-config-tip">
        供应商与模型主数据，可一键下发到各 agent
      </span>
      <div class="common-config-actions">
        <Button size="small" variant="outline" @click="handleExport">
          <template #icon><DownloadIcon /></template> 导出
        </Button>
        <Button size="small" variant="outline" @click="openImportDialog">
          <template #icon><UploadIcon /></template> 导入
        </Button>
        <Tooltip content="把通用库的供应商与模型写入各 agent 的模型配置" placement="top">
          <Button size="small" variant="outline" @click="openDispatchDialog()">
            <template #icon><SendIcon /></template> 下发到 Agent
          </Button>
        </Tooltip>
        <Tooltip content="添加供应商" placement="top">
          <Button size="small" variant="outline" @click="openAddProviderDialog">
            <template #icon><AddIcon /></template> 添加供应商
          </Button>
        </Tooltip>
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="providers.length === 0" class="common-config-empty">
      <Empty description="通用库中还没有供应商，点击右上角「添加供应商」开始维护主数据" />
    </div>

    <div v-else class="common-provider-list">
      <Collapse v-model="expandedList" class="common-provider-collapse">
        <CollapsePanel
          v-for="prov in providers"
          :key="prov.name"
          :value="prov.name"
        >
          <template #header>
            <div class="common-provider-header-left">
              <span class="common-provider-name">{{ prov.name }}</span>
              <Tag size="small" variant="outline">{{ prov.api || 'openai-completions' }}</Tag>
            </div>
          </template>
          <template #headerRightContent>
            <div class="common-provider-header-right" @click.stop>
              <span class="common-model-count">{{ prov.models.length }} 个模型</span>
              <Space size="small">
                <Tooltip content="编辑配置" placement="top">
                  <Button size="small" variant="text" @click="handleEdit(prov)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm content="确定删除此供应商？其下所有模型也会被删除。" @confirm="handleDeleteProvider(prov.name)">
                  <Button size="small" variant="text" theme="danger">
                    <template #icon><DeleteIcon /></template>
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </template>

          <template #content>
          <div class="common-provider-info">
            <div class="common-info-row">
              <span class="common-info-label">API Key</span>
              <span v-if="prov.apiKey" class="common-info-value mono common-copyable" title="点击复制" @click="copyText(prov.apiKey)">{{ prov.apiKey.slice(0, 8) + '...' + prov.apiKey.slice(-4) }}</span>
              <span v-else class="common-info-value mono">未设置</span>
            </div>
            <div class="common-info-row">
              <span class="common-info-label">Base URL</span>
              <span v-if="prov.baseUrl" class="common-info-value mono common-copyable" title="点击复制" @click="copyText(prov.baseUrl)">{{ prov.baseUrl }}</span>
              <span v-else class="common-info-value mono">默认</span>
            </div>
          </div>

          <div class="common-models-section">
            <div class="common-models-title">
              <span>模型列表</span>
              <Space size="small">
                <Button size="small" variant="text" @click="openAddModelDialog(prov.name)">
                  <template #icon><AddIcon /></template> 添加模型
                </Button>
                <Button size="small" variant="text" @click="openBatchAddDialog(prov)">
                  <template #icon><AddIcon /></template> 批量添加
                </Button>
              </Space>
            </div>
            <div class="common-model-item" v-for="m in prov.models" :key="m.id">
              <div class="common-model-info">
                <span class="common-model-name common-copyable" title="点击复制" @click="copyText(m.id)">{{ m.name || m.id }}</span>
                <Tag v-if="m.reasoning" size="small" theme="warning" variant="light">推理</Tag>
              </div>
              <div class="common-model-meta">
                <span class="common-model-stat">上下文: {{ formatNumber(m.contextWindow) }}</span>
                <span class="common-model-stat">最大输出: {{ formatNumber(m.maxTokens) }}</span>
                <span v-if="m.input && m.input.includes('image')" class="common-model-stat">图像</span>
                <span v-if="m.cost && m.cost.input != null" class="common-model-stat">
                  费用: ¥{{ m.cost.input }}/1M in · ¥{{ m.cost.output }}/1M out
                </span>
              </div>
              <div class="common-model-actions" @click.stop>
                <Tooltip content="下发到 Agent" placement="top">
                  <Button size="small" variant="text" @click="openDispatchDialog(prov.name, m.id)">
                    <template #icon><SendIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip content="编辑模型" placement="top">
                  <Button size="small" variant="text" @click="openEditModelDialog(prov.name, m)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm content="确定删除此模型？" @confirm="handleDeleteModel(prov.name, m.id)">
                  <Button size="small" variant="text" theme="danger">
                    <template #icon><DeleteIcon /></template>
                  </Button>
                </Popconfirm>
              </div>
            </div>
          </div>
            </template>
          </CollapsePanel>
        </Collapse>
    </div>

    <Dialog
      v-model:visible="editDialog"
      header="编辑供应商配置"
      width="480px"
      :confirm-btn="{ content: '保存', theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>供应商名称</label>
          <Input v-model="newProviderName" placeholder="供应商名称" />
        </div>
        <div class="common-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" placeholder="留空则使用默认 URL" />
        </div>
        <div class="common-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" placeholder="输入 API Key" />
        </div>
        <div class="common-form-item">
          <label>API 类型</label>
          <Select v-model="editForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="common-form-item">
          <label>自动添加 Authorization 头</label>
          <Switch v-model="editForm.authHeader" />
        </div>
        <div class="common-form-item">
          <label>自定义请求头 (headers)</label>
          <DynamicKvEditor
            v-model="editForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            key-placeholder="Header 名"
            value-placeholder="Header 值"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="addProviderDialog"
      header="添加供应商"
      width="480px"
      :confirm-btn="{ content: '添加', theme: 'primary' }"
      @confirm="handleAddProvider"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>供应商名称 <span class="common-form-required">*</span></label>
          <Input v-model="addProviderForm.name" placeholder="例如：openai、deepseek、zhipu" />
        </div>
        <div class="common-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" placeholder="留空使用供应商默认 URL" />
        </div>
        <div class="common-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" placeholder="输入 API Key（可留空后续再填）" />
        </div>
        <div class="common-form-item">
          <label>API 类型</label>
          <Select v-model="addProviderForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="common-form-item">
          <label>自动添加 Authorization 头</label>
          <Switch v-model="addProviderForm.authHeader" />
        </div>
        <div class="common-form-item">
          <label>自定义请求头 (headers)</label>
          <DynamicKvEditor
            v-model="addProviderForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            key-placeholder="Header 名"
            value-placeholder="Header 值"
          />
        </div>
      </div>
    </Dialog>

    <!-- 模型添加 / 编辑弹窗 -->
    <ModelFormDialog
      v-model:visible="modelFormVisible"
      :mode="modelFormMode"
      :provider-name="modelFormProviderName"
      :provider="modelFormProvider"
      :initial="modelFormInitial"
      :compat-key-options="COMPAT_KEY_OPTIONS"
      @confirm="handleModelFormConfirm"
    />

    <!-- 批量添加模型弹窗 -->
    <BatchAddModelsDialog
      v-model:visible="batchVisible"
      :provider="batchProvider"
      @added="loadProviders"
    />

    <!-- 下发到 Agent 弹窗 -->
    <DispatchDialog
      v-model:visible="dispatchVisible"
      :providers="providers"
      :initial-keys="dispatchInitialKeys"
    />

    <Dialog v-model:visible="showImportDialog" header="导入通用库" @confirm="handleImport" width="480px">
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>通用库字符串</label>
          <Textarea
            v-if="showImportDialog"
            v-model="importString"
            placeholder="粘贴导出的通用库字符串"
            :autosize="{ minRows: 4, maxRows: 8 }"
          />
          <div class="common-form-hint">同名供应商会跳过，其余自动合并导入（含模型与 API Key）</div>
        </div>
      </div>
    </Dialog>
  </div>
</template>
