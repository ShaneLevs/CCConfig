<script setup>

import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Card, Empty, Button, Tag, Space, Tooltip, Dialog, Input, InputNumber, MessagePlugin, Table, Loading, Popconfirm, Alert as TAlert, Select, Switch, CheckboxGroup, Checkbox, Collapse, CollapsePanel, AutoComplete,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, FolderOpen1Icon, StarIcon,
  AddIcon, DeleteIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import { useFirstProviderExpand } from "../../composables/useFirstProviderExpand";
import "./styles/ConfigView.css";

const { t } = useI18n();

// Pi 官方文档支持的 API 类型
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

// 常用 compat 字段名（自动完成提示）
const COMPAT_KEY_OPTIONS = [
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "maxTokensField",
  "supportsStore",
  "thinkingFormat",
];

// 输入类型选项
const INPUT_TYPE_OPTIONS = [
  { labelKey: "pi.model.inputTypes.text", value: "text" },
  { labelKey: "pi.model.inputTypes.image", value: "image" },
];
const inputTypeOptions = computed(() => INPUT_TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.labelKey) })));

const loading = ref(false);
const providers = ref([]);
const expandedList = ref([]);
useFirstProviderExpand(providers, expandedList, (p) => p.name);
const warningMsg = ref("");
const editDialog = ref(false);
const editingProvider = ref(null);
const editForm = ref({ apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true });
const addProviderDialog = ref(false);
const addProviderForm = ref({ name: '', apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true });
const addModelDialog = ref(false);
const addModelProvider = ref(null);
const addModelForm = ref({ id: '', name: '', contextWindow: 0, maxTokens: 0, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: [] });
// 模型编辑
const editModelDialog = ref(false);
// 编辑时的新名称（供应商重命名 / 模型 ID 重命名）
const newProviderName = ref('');
const newModelId = ref('');
// 模型高级配置展开状态（添加/编辑共用）
const modelAdvancedOpen = ref(false);
const editModelProvider = ref(null);
const editingModelId = ref(null);
const editModelForm = ref({ name: '', contextWindow: 0, maxTokens: 0, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: [] });

const loadProviders = () => {
  try {
    providers.value = window.services.getPiProviderList();
    validateConfig();
  } catch (e) {
    console.error("加载 Pi 供应商失败:", e);
    providers.value = [];
  }
};

// 校验 defaultModel 是否在 defaultProvider 下，否则 Pi CLI 会报"无可用模型"
const validateConfig = () => {
  try {
    const settings = window.services.readPiSettings();
    const defProv = settings.defaultProvider;
    const defModel = settings.defaultModel;
    if (!defProv) { warningMsg.value = t("pi.config.warningNoDefaultProvider"); return; }
    if (!defModel) { warningMsg.value = t("pi.config.warningNoDefaultModel"); return; }
    const prov = providers.value.find(p => p.name === defProv);
    if (!prov) { warningMsg.value = t("pi.config.warningProviderMissing", { provider: defProv }); return; }
    if (!prov.models.some(m => m.id === defModel)) {
      warningMsg.value = t("pi.config.warningModelMissing", { model: defModel, provider: defProv });
      return;
    }
    warningMsg.value = "";
  } catch { /* ignore */ }
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
    // 名称有变化：删除旧供应商，创建新供应商
    if (finalName !== editingProvider.value) {
      const oldData = window.services.readPiModels();
      const oldProv = oldData.providers[editingProvider.value];
      delete oldData.providers[editingProvider.value];
      oldData.providers[finalName] = {
        apiKey: editForm.value.apiKey,
        baseUrl: editForm.value.baseUrl,
        api: editForm.value.api,
        headers: headersObj,
        authHeader: editForm.value.authHeader,
        models: oldProv.models || [],
      };
      window.services.writePiModels(oldData);
      // 如果默认供应商是旧的，同步更新
      const settings = window.services.readPiSettings();
      if (settings.defaultProvider === editingProvider.value) {
        settings.defaultProvider = finalName;
        window.services.writePiSettings(settings);
      }
    } else {
      window.services.updatePiProvider(editingProvider.value, {
        apiKey: editForm.value.apiKey,
        baseUrl: editForm.value.baseUrl,
        api: editForm.value.api,
        headers: headersObj,
        authHeader: editForm.value.authHeader,
      });
    }
    MessagePlugin.success(t("pi.config.providerUpdated"));
    editDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t("pi.config.saveFailed", { message: e.message }));
  }
};

const setDefaultProvider = (name) => {
  try {
    // 记录切换前的默认模型，用于提示
    const before = window.services.readPiSettings();
    const oldModel = before.defaultModel;
    window.services.setPiDefaultProvider(name);
    loadProviders();
    // 读取切换后的默认模型，若有变化则提示
    const after = window.services.readPiSettings();
    if (after.defaultModel && after.defaultModel !== oldModel) {
      MessagePlugin.success(t("pi.config.switchedDefaultModel", { model: after.defaultModel }));
    } else {
      MessagePlugin.success(t("pi.config.defaultProviderSet", { provider: name }));
    }
  } catch (e) {
    MessagePlugin.error(t("pi.config.setDefaultProviderFailed", { message: e.message }));
  }
};

const setDefaultModel = (providerName, modelId) => {
  try {
    // 设置默认模型时，自动切换到该模型所属的供应商，避免"默认模型不在供应商下"的警告
    window.services.setPiDefaultProvider(providerName);
    window.services.setPiDefaultModel(modelId);
    loadProviders();
    MessagePlugin.success(t("pi.config.switchedAndSetDefaultModel", { model: modelId }));
  } catch (e) {
    MessagePlugin.error(t("pi.config.setDefaultModelFailed", { message: e.message }));
  }
};

const openAddProviderDialog = () => {
  addProviderForm.value = { name: '', apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true };
  addProviderDialog.value = true;
};

const handleAddProvider = async () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning(t('pi.config.providerNameRequired')); return; }
    const headersObj = {};
    (addProviderForm.value.headers || []).forEach(({ key, value }) => {
      if (key && key.trim()) headersObj[key.trim()] = value;
    });
    window.services.addPiProvider(name, {
      apiKey: addProviderForm.value.apiKey,
      baseUrl: addProviderForm.value.baseUrl,
      api: addProviderForm.value.api,
      headers: headersObj,
      authHeader: addProviderForm.value.authHeader,
    });
    MessagePlugin.success(t('pi.config.providerAdded', { provider: name }));
    addProviderDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('pi.config.addFailed', { message: e.message }));
  }
};

const handleDeleteProvider = async (providerName) => {
  try {
    window.services.deletePiProvider(providerName);
    MessagePlugin.success(t('pi.config.providerDeleted', { provider: providerName }));
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('pi.config.deleteFailed', { message: e.message }));
  }
};

const openAddModelDialog = (providerName) => {
  addModelProvider.value = providerName;
  addModelForm.value = { id: '', name: '', contextWindow: 0, maxTokens: 0, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: [] };
  autoModels.value = [];
  autoModelsLoading.value = false;
  autoModelsError.value = "";
  modelAdvancedOpen.value = false;
  addModelDialog.value = true;
  // 打开弹窗即自动拉取模型列表，无需手动点击
  handleAutoFetchModels();
};

const autoModels = ref([]);
const autoModelsLoading = ref(false);
const autoModelsError = ref("");

// AutoComplete 下拉选项（显示名 → 模型 ID）
const modelOptions = computed(() =>
  autoModels.value.map(m => ({ label: m.name || m.id, value: m.id }))
);

const handleAutoFetchModels = async () => {
  const prov = providers.value.find(p => p.name === addModelProvider.value);
  if (!prov || !prov.baseUrl) {
    autoModelsError.value = t("pi.config.missingBaseUrl");
    return;
  }
  autoModelsLoading.value = true;
  autoModelsError.value = "";
  try {
    const list = await window.services.fetchProviderModels(prov.baseUrl, prov.apiKey);
    autoModels.value = list;
    if (list.length === 0) autoModelsError.value = t("pi.config.emptyList");
  } catch (e) {
    autoModelsError.value = e.message;
  } finally {
    autoModelsLoading.value = false;
  }
};

const applyAutoModel = (m) => {
  addModelForm.value = {
    ...addModelForm.value,
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.contextWindow || 0,
    maxTokens: m.maxTokens || 0,
    reasoning: !!m.reasoning,
  };
};

// 从下拉选中模型：自动带出名称/上下文/输出/推理
const onModelIdSelect = (val) => {
  const m = autoModels.value.find(x => x.id === val);
  if (m) applyAutoModel(m);
};

// 打开模型编辑弹窗
const openEditModelDialog = (provName, m) => {
  editModelProvider.value = provName;
  editingModelId.value = m.id;
  newModelId.value = m.id;
  editModelForm.value = {
    name: m.name || '',
    contextWindow: m.contextWindow || 0,
    maxTokens: m.maxTokens || 0,
    reasoning: !!m.reasoning,
    input: m.input || ['text'],
    cost: (m.cost && m.cost.input != null) ? { ...m.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: m.compat ? Object.entries(m.compat).map(([key, value]) => ({ key, value })) : [],
  };
  modelAdvancedOpen.value = false;
  editModelDialog.value = true;
};

const handleSaveModel = async () => {
  try {
    const compatObj = {};
    (editModelForm.value.compat || []).forEach(({ key, value }) => {
      if (key && key.trim()) compatObj[key.trim()] = value;
    });
    const finalId = newModelId.value.trim() || editingModelId.value;
    // ID 有变化：删除旧模型，添加新模型
    if (finalId !== editingModelId.value) {
      window.services.deletePiModel(editModelProvider.value, editingModelId.value);
      window.services.addPiModel(editModelProvider.value, {
        id: finalId,
        name: editModelForm.value.name.trim() || finalId,
        contextWindow: Number(editModelForm.value.contextWindow) || 0,
        maxTokens: Number(editModelForm.value.maxTokens) || 0,
        reasoning: editModelForm.value.reasoning,
        input: editModelForm.value.input,
        cost: editModelForm.value.cost,
        compat: compatObj,
      });
      // 如果默认模型是旧的，同步更新
      const settings = window.services.readPiSettings();
      if (settings.defaultModel === editingModelId.value) {
        settings.defaultModel = finalId;
        window.services.writePiSettings(settings);
      }
    } else {
      window.services.updatePiModel(editModelProvider.value, editingModelId.value, {
        name: editModelForm.value.name.trim() || editingModelId.value,
        contextWindow: Number(editModelForm.value.contextWindow) || 0,
        maxTokens: Number(editModelForm.value.maxTokens) || 0,
        reasoning: editModelForm.value.reasoning,
        input: editModelForm.value.input,
        cost: editModelForm.value.cost,
        compat: compatObj,
      });
    }
    MessagePlugin.success(t('pi.config.modelUpdated'));
    editModelDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('pi.config.saveFailed', { message: e.message }));
  }
};

const handleAddModel = async () => {
  try {
    const id = addModelForm.value.id.trim();
    if (!id) { MessagePlugin.warning(t('pi.config.modelIdRequired')); return; }
    const compatObj = {};
    (addModelForm.value.compat || []).forEach(({ key, value }) => {
      if (key && key.trim()) compatObj[key.trim()] = value;
    });
    window.services.addPiModel(addModelProvider.value, {
      id,
      name: addModelForm.value.name.trim() || id,
      contextWindow: Number(addModelForm.value.contextWindow) || 0,
      maxTokens: Number(addModelForm.value.maxTokens) || 0,
      reasoning: addModelForm.value.reasoning,
      input: addModelForm.value.input,
      cost: addModelForm.value.cost,
      compat: compatObj,
    });
    MessagePlugin.success(t('pi.config.modelAdded', { id }));
    addModelDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('pi.config.addFailed', { message: e.message }));
  }
};

const handleDeleteModel = async (providerName, modelId) => {
  try {
    window.services.deletePiModel(providerName, modelId);
    MessagePlugin.success(t('pi.config.modelDeleted', { id: modelId }));
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('pi.config.deleteFailed', { message: e.message }));
  }
};

const formatNumber = (n) => {
  if (!n) return t('pi.config.defaultValue');
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
};

const openPiDir = () => {
  try { window.services.openPiDir(); } catch { /* ignore */ }
};

const refresh = () => {
  loading.value = true;
  setTimeout(() => { loadProviders(); loading.value = false; }, 50);
};

onMounted(refresh);

</script>

<template>
  <div class="pi-config-container">
    <div class="pi-config-header">
      <span class="pi-config-tip">
        {{ t("pi.config.tipPrefix") }}<span class="hint-link" @click="openPiDir">~/.pi/agent/models.json</span>
      </span>
      <div class="pi-config-actions">
        <Tooltip :content="t('pi.config.addProvider')" placement="top">
          <Button size="small" variant="outline" @click="openAddProviderDialog">
            <template #icon><AddIcon /></template> {{ t("pi.config.addProvider") }}
          </Button>
        </Tooltip>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="pi-config-warning">
      <t-alert :message="warningMsg" theme="warning" show-icon />
    </div>

    <div v-if="providers.length === 0" class="pi-config-empty">
      <Empty :description="t('pi.config.empty')" />
    </div>

    <div v-else class="pi-provider-list">
      <Collapse v-model="expandedList" class="pi-provider-collapse">
        <CollapsePanel
          v-for="prov in providers"
          :key="prov.name"
          :value="prov.name"
        >
          <!-- 供应商头部：展开箭头由 Collapse 内置渲染 -->
          <template #header>
            <div class="pi-provider-header-left">
              <span class="pi-provider-name">{{ prov.name }}</span>
              <Tag v-if="prov.isDefault" size="small" theme="warning" variant="light">{{ t("pi.config.defaultTag") }}</Tag>
              <Tag size="small" variant="outline">{{ prov.api || 'openai-completions' }}</Tag>
            </div>
          </template>
          <template #headerRightContent>
            <div class="pi-provider-header-right" @click.stop>
              <span class="pi-model-count">{{ t("pi.config.modelCount", { count: prov.models.length }) }}</span>
              <Space size="small">
                <Tooltip :content="t('pi.config.setDefaultProvider')" placement="top">
                  <Button v-if="!prov.isDefault" size="small" variant="text" @click="setDefaultProvider(prov.name)">
                    <template #icon><StarIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip :content="t('pi.config.editConfig')" placement="top">
                  <Button size="small" variant="text" @click="handleEdit(prov)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm :content="t('pi.config.deleteProviderConfirm')" @confirm="handleDeleteProvider(prov.name)">
                  <Button size="small" variant="text" theme="danger">
                    <template #icon><DeleteIcon /></template>
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </template>

          <!-- 展开内容 -->
          <template #content>
          <div class="pi-provider-info">
            <div class="pi-info-row">
              <span class="pi-info-label">API Key</span>
              <span class="pi-info-value mono">{{ prov.apiKey ? prov.apiKey.slice(0, 8) + '...' + prov.apiKey.slice(-4) : t('common.notSet') }}</span>
            </div>
            <div class="pi-info-row">
              <span class="pi-info-label">Base URL</span>
              <span class="pi-info-value mono">{{ prov.baseUrl || t('pi.config.defaultValue') }}</span>
            </div>
          </div>

          <div class="pi-models-section">
            <div class="pi-models-title">
              <span>{{ t("pi.config.modelList") }}</span>
              <Button size="small" variant="text" @click="openAddModelDialog(prov.name)">
                <template #icon><AddIcon /></template> {{ t("pi.config.addModel") }}
              </Button>
            </div>
            <div class="pi-model-item" v-for="m in prov.models" :key="m.id">
              <div class="pi-model-info">
                <span class="pi-model-name">{{ m.name || m.id }}</span>
                <Tag v-if="m.isDefault" size="small" theme="warning" variant="light">{{ t("pi.config.defaultTag") }}</Tag>
                <Tag v-if="m.reasoning" size="small" theme="warning" variant="light">{{ t("pi.config.reasoning") }}</Tag>
              </div>
              <div class="pi-model-meta">
                <span class="pi-model-stat">{{ t("pi.config.context", { value: formatNumber(m.contextWindow) }) }}</span>
                <span class="pi-model-stat">{{ t("pi.config.maxOutput", { value: formatNumber(m.maxTokens) }) }}</span>
                <span v-if="m.input && m.input.includes('image')" class="pi-model-stat">{{ t("pi.config.image") }}</span>
                <span v-if="m.cost && m.cost.input != null" class="pi-model-stat">
                  {{ t("pi.config.cost", { input: m.cost.input, output: m.cost.output }) }}
                </span>
              </div>
              <div class="pi-model-actions" @click.stop>
                <Tooltip v-if="!m.isDefault" :content="t('pi.config.setDefaultModel')" placement="top">
                  <Button size="small" variant="text" @click="setDefaultModel(prov.name, m.id)">
                    <template #icon><StarIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip :content="t('pi.config.editModel')" placement="top">
                  <Button size="small" variant="text" @click="openEditModelDialog(prov.name, m)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm :content="t('pi.config.deleteModelConfirm')" @confirm="handleDeleteModel(prov.name, m.id)">
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
      :header="t('pi.provider.editTitle')"
      width="480px"
      :confirm-btn="{ content: t('common.save'), theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="pi-edit-form">
        <div class="pi-form-item">
          <label>{{ t("pi.provider.name") }}</label>
          <Input v-model="newProviderName" :placeholder="t('pi.provider.namePlaceholder')" />
        </div>
        <div class="pi-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" :placeholder="t('pi.provider.baseUrlPlaceholderEdit')" />
        </div>
        <div class="pi-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="t('pi.provider.apiKeyPlaceholder')" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.provider.apiType") }}</label>
          <Select v-model="editForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.provider.authHeader") }}</label>
          <Switch v-model="editForm.authHeader" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.provider.customHeaders") }}</label>
          <DynamicKvEditor
            v-model="editForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            :key-placeholder="t('pi.provider.headerKey')"
            :value-placeholder="t('pi.provider.headerValue')"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="addProviderDialog"
      :header="t('pi.provider.addTitle')"
      width="480px"
      :confirm-btn="{ content: t('common.add'), theme: 'primary' }"
      @confirm="handleAddProvider"
    >
      <div class="pi-edit-form">
        <div class="pi-form-item">
          <label>{{ t("pi.provider.name") }} <span class="pi-form-required">*</span></label>
          <Input v-model="addProviderForm.name" :placeholder="t('pi.provider.namePlaceholderAdd')" />
        </div>
        <div class="pi-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" :placeholder="t('pi.provider.baseUrlPlaceholderAdd')" />
        </div>
        <div class="pi-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" :placeholder="t('pi.provider.apiKeyPlaceholderAdd')" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.provider.apiType") }}</label>
          <Select v-model="addProviderForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.provider.authHeader") }}</label>
          <Switch v-model="addProviderForm.authHeader" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.provider.customHeaders") }}</label>
          <DynamicKvEditor
            v-model="addProviderForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            :key-placeholder="t('pi.provider.headerKey')"
            :value-placeholder="t('pi.provider.headerValue')"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="addModelDialog"
      :header="t('pi.model.addTitle')"
      width="520px"
      :confirm-btn="{ content: t('common.add'), theme: 'primary' }"
      @confirm="handleAddModel"
    >
      <div class="pi-edit-form">
        <div class="pi-form-item">
          <label>{{ t("pi.model.provider") }}</label>
          <div class="pi-edit-provider-name">{{ addModelProvider }}</div>
        </div>

        <!-- 模型 ID：AutoComplete，弹窗打开时已自动拉取模型列表 -->
        <div class="pi-form-item">
          <label>{{ t("pi.model.id") }} <span class="pi-form-required">*</span></label>
          <AutoComplete
            v-model="addModelForm.id"
            :options="modelOptions"
            :loading="autoModelsLoading"
            filterable
            clearable
            :placeholder="t('pi.model.inputOrSelect')"
            @select="onModelIdSelect"
          />
          <div v-if="autoModelsLoading" class="pi-form-hint">{{ t("pi.model.fetching") }}</div>
          <div v-else-if="autoModelsError" class="pi-form-hint pi-fetch-error">
            {{ t("pi.model.fetchFailed", { message: autoModelsError }) }}
            <span class="pi-fetch-retry" @click="handleAutoFetchModels">{{ t("common.retry") }}</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="pi-form-hint">
            {{ t("pi.model.fetchedCount", { count: autoModels.length }) }}
          </div>
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.model.displayName") }}</label>
          <Input v-model="addModelForm.name" :placeholder="t('pi.model.displayNamePlaceholder')" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.model.inputType") }}</label>
          <Space size="16px" align="center" wrap>
            <CheckboxGroup v-model="addModelForm.input" class="pi-checkbox-group">
              <Checkbox v-for="opt in inputTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
            </CheckboxGroup>
            <Checkbox v-model="addModelForm.reasoning" class="pi-reasoning-checkbox">{{ t("pi.model.reasoning") }}</Checkbox>
          </Space>
        </div>
        <ModelLimitsFields v-model:context="addModelForm.contextWindow" v-model:output="addModelForm.maxTokens" item-class="pi-form-item" />
        <Collapse v-model="modelAdvancedOpen" class="pi-advanced-collapse">
          <CollapsePanel value="1" :header="t('pi.model.advanced')">
            <div class="pi-form-item">
              <label>{{ t("pi.model.cost") }}</label>
              <div class="pi-form-row">
                <div class="pi-form-item">
                  <label>{{ t("pi.model.input") }}</label>
                  <InputNumber v-model="addModelForm.cost.input" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="pi-form-item">
                  <label>{{ t("pi.model.output") }}</label>
                  <InputNumber v-model="addModelForm.cost.output" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
              <div class="pi-form-row">
                <div class="pi-form-item">
                  <label>{{ t("pi.model.cacheRead") }}</label>
                  <InputNumber v-model="addModelForm.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="pi-form-item">
                  <label>{{ t("pi.model.cacheWrite") }}</label>
                  <InputNumber v-model="addModelForm.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
            </div>
            <div class="pi-form-item">
              <label>{{ t("pi.model.compat") }}</label>
              <DynamicKvEditor
                v-model="addModelForm.compat"
                :key-options="COMPAT_KEY_OPTIONS"
                :key-placeholder="t('pi.model.compatKey')"
                :value-placeholder="t('pi.model.compatValue')"
              />
            </div>
          </CollapsePanel>
        </Collapse>
      </div>
    </Dialog>

    <!-- 模型编辑弹窗 -->
    <Dialog
      v-model:visible="editModelDialog"
      :header="t('pi.model.editTitle')"
      width="480px"
      :confirm-btn="{ content: t('common.save'), theme: 'primary' }"
      @confirm="handleSaveModel"
    >
      <div class="pi-edit-form">
        <div class="pi-form-item">
          <label>{{ t("pi.model.id") }}</label>
          <Input v-model="newModelId" :placeholder="t('pi.model.idPlaceholder')" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.model.displayName") }}</label>
          <Input v-model="editModelForm.name" :placeholder="t('pi.model.displayNameEditPlaceholder')" />
        </div>
        <div class="pi-form-item">
          <label>{{ t("pi.model.inputType") }}</label>
          <Space size="16px" align="center" wrap>
            <CheckboxGroup v-model="editModelForm.input" class="pi-checkbox-group">
              <Checkbox v-for="opt in inputTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
            </CheckboxGroup>
            <Checkbox v-model="editModelForm.reasoning" class="pi-reasoning-checkbox">{{ t("pi.model.reasoning") }}</Checkbox>
          </Space>
        </div>
        <ModelLimitsFields v-model:context="editModelForm.contextWindow" v-model:output="editModelForm.maxTokens" item-class="pi-form-item" />
        <Collapse v-model="modelAdvancedOpen" class="pi-advanced-collapse">
          <CollapsePanel value="1" :header="t('pi.model.advanced')">
            <div class="pi-form-item">
              <label>{{ t("pi.model.cost") }}</label>
              <div class="pi-form-row">
                <div class="pi-form-item">
                  <label>{{ t("pi.model.input") }}</label>
                  <InputNumber v-model="editModelForm.cost.input" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="pi-form-item">
                  <label>{{ t("pi.model.output") }}</label>
                  <InputNumber v-model="editModelForm.cost.output" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
              <div class="pi-form-row">
                <div class="pi-form-item">
                  <label>{{ t("pi.model.cacheRead") }}</label>
                  <InputNumber v-model="editModelForm.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="pi-form-item">
                  <label>{{ t("pi.model.cacheWrite") }}</label>
                  <InputNumber v-model="editModelForm.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
            </div>
            <div class="pi-form-item">
              <label>{{ t("pi.model.compat") }}</label>
              <DynamicKvEditor
                v-model="editModelForm.compat"
                :key-options="COMPAT_KEY_OPTIONS"
                :key-placeholder="t('pi.model.compatKey')"
                :value-placeholder="t('pi.model.compatValue')"
              />
            </div>
          </CollapsePanel>
        </Collapse>
      </div>
    </Dialog>
  </div>
</template>
