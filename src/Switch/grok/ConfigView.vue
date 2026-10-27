<script setup>
// Grok Build 模型配置页：~/.grok/config.toml
// 与 Codex / Qoder / Kimi 一致的「供应商 → 模型」两层结构：
//   [model_providers.<name>]  共享连接信息（base_url / api_backend / api_key / env_key /
//                             context_window / extra_headers），模型通过 model_provider 引用它
//   [model.<key>]             模型条目：model（发往 API 的 ID）/ name / 上下文 / 输出上限 /
//                             采样参数 / extra_headers；官方内置模型也可只用少量字段覆盖
//   [models].default          新会话默认模型，存 [model.<key>] 的键
// 兼容官方文档里「内联连接信息」的写法（模型自带 base_url / api_key，无 model_provider）：
// 这类条目归到「未分组模型」区，连接信息显示在模型自己身上。
// 风格与 Codex 配置页一致：供应商手风琴 + 组内模型标签 + 星标设默认。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Dialog, Input, InputNumber, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link, AutoComplete,
  Checkbox, Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon, CopyIcon, LockOnIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import "./styles/ConfigView.css";

const { t } = useI18n();

// 与服务层 GROK_API_BACKENDS 一致：官方只有三种线上协议
const backendOptions = [
  { labelKey: "grok.config.apiBackend.chatCompletions", value: "chat_completions" },
  { labelKey: "grok.config.apiBackend.responses", value: "responses" },
  { labelKey: "grok.config.apiBackend.messages", value: "messages" },
];
const backendSelectOptions = computed(() =>
  backendOptions.map((o) => ({ label: t(o.labelKey), value: o.value }))
);
const backendLabel = (v) => {
  const hit = backendOptions.find((o) => o.value === (v || "chat_completions"));
  return hit ? t(hit.labelKey) : v;
};

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const ungrouped = ref([]);
const defaultKey = ref({ modelId: "", webSearch: "" });
const expandedList = ref([]);

const formatNumber = (n) => {
  if (!n) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    providers.value = window.services.getGrokProviderList() || [];
    ungrouped.value = window.services.getGrokUngroupedModels() || [];
    defaultKey.value = window.services.getGrokDefaultModel() || { modelId: "", webSearch: "" };
  } catch (e) {
    console.error("加载 Grok 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
};

const openConfigFile = () => {
  try { window.services.openGrokConfigFile(); } catch { /* ignore */ }
};

// 默认模型统一由每个模型上的星标设置；这里不再提供顶部下拉，避免和星标重复
const isDefault = (m) => defaultKey.value.modelId === m.key;
const setDefaultModel = (m) => {
  try {
    window.services.setGrokDefaultModel(m.key);
    MessagePlugin.success(t("grok.model.defaultSet", { id: m.key }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("grok.model.saveFailed", { message: e.message }));
    refresh();
  }
};

// 模型实际生效的连接信息：挂了供应商就取供应商的，否则取模型自己的（内联写法）
const resolvedConn = (m) => {
  const p = m.modelProvider ? providers.value.find((x) => x.name === m.modelProvider) : null;
  return {
    provider: p,
    baseUrl: m.baseUrl || (p && p.baseUrl) || "",
    apiBackend: m.apiBackend || (p && p.apiBackend) || "chat_completions",
    hasKey: !!(m.apiKey || m.envKey || (p && p.hasKey)),
    contextWindow: m.contextWindow || (p && p.contextWindow) || 0,
    _from: p ? "provider" : (m.baseUrl ? "inline" : "builtin"),
  };
};

// ==================== 供应商弹窗 ====================

const emptyProviderForm = () => ({
  name: "", baseUrl: "", apiBackend: "chat_completions", apiKey: "", envKey: "",
  contextWindow: 0, extraHeaders: [], advancedOpen: false,
});

const headersToRows = (obj) =>
  Object.entries(obj || {}).map(([key, value]) => ({ key, value: String(value == null ? "" : value) }));
const rowsToHeaders = (rows) => {
  const out = {};
  for (const { key, value } of rows || []) {
    if (String(key || "").trim()) out[String(key).trim()] = String(value == null ? "" : value);
  }
  return out;
};

const addProviderDialog = ref(false);
const addProviderForm = ref(emptyProviderForm());
const editProviderDialog = ref(false);
const editingProvider = ref("");
const editProviderForm = ref(emptyProviderForm());
const originalProviderKey = ref("");
const originalProviderEnvKey = ref("");

const openAddProviderDialog = () => {
  addProviderForm.value = emptyProviderForm();
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning(t("grok.provider.nameRequired")); return; }
    window.services.addGrokProvider({
      name,
      baseUrl: addProviderForm.value.baseUrl.trim(),
      apiBackend: addProviderForm.value.apiBackend,
      apiKey: addProviderForm.value.apiKey.trim(),
      envKey: addProviderForm.value.envKey.trim(),
      contextWindow: Number(addProviderForm.value.contextWindow) || 0,
      extraHeaders: rowsToHeaders(addProviderForm.value.extraHeaders),
    });
    MessagePlugin.success(t("grok.provider.added", { name }));
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("grok.provider.addFailed", { message: e.message }));
  }
};

const openEditProviderDialog = (p) => {
  editingProvider.value = p.name;
  editProviderForm.value = {
    name: p.name,
    baseUrl: p.baseUrl || "",
    apiBackend: p.apiBackend || "chat_completions",
    apiKey: p.apiKey || "",
    envKey: p.envKey || "",
    contextWindow: p.contextWindow || 0,
    extraHeaders: headersToRows(p.extraHeaders),
    advancedOpen: !!(p.contextWindow || Object.keys(p.extraHeaders || {}).length),
  };
  originalProviderKey.value = p.apiKey || "";
  originalProviderEnvKey.value = p.envKey || "";
  editProviderDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    const payload = {
      name: editProviderForm.value.name.trim(),
      baseUrl: editProviderForm.value.baseUrl.trim(),
      apiBackend: editProviderForm.value.apiBackend,
      envKey: editProviderForm.value.envKey.trim(),
      contextWindow: Number(editProviderForm.value.contextWindow) || 0,
      extraHeaders: rowsToHeaders(editProviderForm.value.extraHeaders),
    };
    if (!payload.name) { MessagePlugin.warning(t("grok.provider.nameRequired")); return; }
    // key：清空 → 删除；改动 → 覆盖；未动 → 不回传
    if (!editProviderForm.value.apiKey && originalProviderKey.value) payload.clearApiKey = true;
    else if (editProviderForm.value.apiKey !== originalProviderKey.value) {
      payload.apiKey = editProviderForm.value.apiKey.trim();
    }
    const renamed = payload.name !== editingProvider.value;
    window.services.updateGrokProvider(editingProvider.value, payload);
    MessagePlugin.success(renamed ? t("grok.provider.updatedRenamed", { name: payload.name }) : t("grok.provider.updated"));
    editProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("grok.provider.saveFailed", { message: e.message }));
  }
};

const handleDeleteProvider = (p) => {
  try {
    window.services.deleteGrokProvider(p.name);
    MessagePlugin.success(t("grok.provider.deleted", { name: p.name }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("grok.provider.deleteFailed", { message: e.message }));
  }
};

// ==================== 模型弹窗 ====================

const emptyModelForm = () => ({
  key: "", model: "", name: "", description: "",
  contextWindow: 0, maxCompletionTokens: 0,
  temperature: null, topP: null, extraHeaders: [],
  advancedOpen: false,
});

const modelDialog = ref(false);
const modelDialogProvider = ref("");
const editingModelKey = ref("");
const modelForm = ref(emptyModelForm());
const originalModelHeaders = ref({});

// 模型候选（复用通用供应商 /models 拉取，失败静默）
const fetchedModels = ref([]);
const fetchingModels = ref(false);
const fetchModelError = ref("");

const modelOptions = computed(() => fetchedModels.value.map((m) => ({ label: m.name || m.id, value: m.id })));

const fetchBase = computed(() => {
  const p = providers.value.find((x) => x.name === modelDialogProvider.value);
  return {
    baseUrl: p ? p.baseUrl : "",
    apiKey: p ? p.apiKey : "",
  };
});

const handleFetchModels = async () => {
  if (!fetchBase.value.baseUrl) {
    fetchModelError.value = t("common.noBaseUrl");
    return;
  }
  fetchingModels.value = true;
  fetchModelError.value = "";
  try {
    const list = await window.services.fetchProviderModels(fetchBase.value.baseUrl, fetchBase.value.apiKey);
    fetchedModels.value = list || [];
    if (!fetchedModels.value.length) fetchModelError.value = t("grok.config.noModels");
  } catch (e) {
    fetchModelError.value = e.message || t("common.fetchFailed");
  } finally {
    fetchingModels.value = false;
  }
};

// providerName 为空 = 未分组模型（内联连接信息写法 / 内置模型覆盖）
const openAddModelDialog = (providerName) => {
  modelDialogProvider.value = providerName || "";
  editingModelKey.value = "";
  modelForm.value = emptyModelForm();
  originalModelHeaders.value = {};
  fetchedModels.value = [];
  fetchModelError.value = "";
  modelDialog.value = true;
  if (providerName) handleFetchModels();
};

const openEditModelDialog = (m) => {
  modelDialogProvider.value = m.modelProvider || "";
  editingModelKey.value = m.key;
  modelForm.value = {
    key: m.key,
    model: m.model,
    name: m.name || "",
    description: m.description || "",
    contextWindow: m.contextWindow || 0,
    maxCompletionTokens: m.maxCompletionTokens || 0,
    temperature: m.temperature,
    topP: m.topP,
    extraHeaders: headersToRows(m.extraHeaders),
    advancedOpen: !!(m.description || m.temperature != null || m.topP != null || Object.keys(m.extraHeaders || {}).length),
  };
  originalModelHeaders.value = m.extraHeaders || {};
  fetchedModels.value = [];
  fetchModelError.value = "";
  modelDialog.value = true;
  if (m.modelProvider) handleFetchModels();
};

const isModelDialogAdd = computed(() => !editingModelKey.value);

const handleSaveModel = () => {
  const provider = modelDialogProvider.value;
  const payload = {
    key: modelForm.value.key.trim(),
    model: modelForm.value.model.trim(),
    name: modelForm.value.name.trim(),
    description: modelForm.value.description.trim(),
    contextWindow: Number(modelForm.value.contextWindow) || 0,
    maxCompletionTokens: Number(modelForm.value.maxCompletionTokens) || 0,
    temperature: typeof modelForm.value.temperature === "number" ? modelForm.value.temperature : null,
    topP: typeof modelForm.value.topP === "number" ? modelForm.value.topP : null,
    extraHeaders: rowsToHeaders(modelForm.value.extraHeaders),
  };
  try {
    if (!payload.key) { MessagePlugin.warning(t("grok.model.keyRequired")); return; }
    if (isModelDialogAdd.value) {
      window.services.addGrokModel(provider, payload);
      MessagePlugin.success(t("grok.model.added", { id: payload.key }));
    } else {
      window.services.updateGrokModel(editingModelKey.value, payload);
      MessagePlugin.success(t("grok.model.updated"));
    }
    modelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(
      isModelDialogAdd.value
        ? t("grok.model.addFailed", { message: e.message })
        : t("grok.model.saveFailed", { message: e.message })
    );
  }
};

const handleDeleteModel = (m) => {
  try {
    window.services.deleteGrokModel(m.key);
    MessagePlugin.success(t("grok.model.deleted", { id: m.key }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("grok.model.deleteFailed", { message: e.message }));
  }
};

// ==================== 辅助 ====================

const maskValue = (val) => {
  if (!val) return "";
  if (val.length <= 10) return "••••••";
  return val.slice(0, 4) + "····" + val.slice(-4);
};

const copyText = (val) => {
  try {
    window.utools.copyText(val);
    MessagePlugin.success(t("common.copiedToClipboard"));
  } catch {
    MessagePlugin.error(t("common.copyFailed"));
  }
};

const openDir = () => {
  try { window.services.openGrokDir(); } catch { /* ignore */ }
};

onMounted(refresh);
</script>

<template>
  <div class="grok-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="grok-toolbar">
      <div class="grok-toolbar-left">
        <span class="grok-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openConfigFile">~/.grok/config.toml</Link>
          <span class="grok-toolbar-sub">{{ t("grok.config.toolbarSubtitle") }}</span>
        </span>
      </div>
      <div class="grok-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> {{ t("grok.config.addProvider") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="grok-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0 && ungrouped.length === 0" class="grok-config-empty">
        <Empty :description="t('grok.config.emptyProviders')">
          <template #action>
            <Button theme="primary" @click="openAddProviderDialog">
              <template #icon><AddIcon /></template> {{ t("grok.config.addProvider") }}
            </Button>
          </template>
        </Empty>
      </div>

      <template v-else>
        <!-- 供应商列表 -->
        <div v-if="providers.length" class="grok-provider-list">
          <Collapse v-model="expandedList" class="grok-provider-collapse">
            <CollapsePanel v-for="p in providers" :key="p.name" :value="p.name">
              <template #header>
                <div class="grok-provider-header-left">
                  <span class="grok-provider-name">{{ p.name }}</span>
                  <Tag size="small" variant="outline">{{ backendLabel(p.apiBackend) }}</Tag>
                  <span class="grok-model-count">{{ t("grok.config.modelCount", { count: p.modelCount }) }}</span>
                </div>
              </template>
              <template #headerRightContent>
                <div class="grok-provider-header-right" @click.stop>
                  <Tooltip :content="t('grok.config.editProvider')" placement="top">
                    <Button size="small" theme="default" variant="text" @click="openEditProviderDialog(p)">
                      <template #icon><EditIcon /></template>
                    </Button>
                  </Tooltip>
                  <Tooltip :content="t('grok.config.deleteProvider')" placement="top">
                    <Popconfirm
                      :content="t('grok.config.deleteProviderConfirm', { name: p.name })"
                      theme="danger"
                      @confirm="handleDeleteProvider(p)"
                    >
                      <Button size="small" theme="danger" variant="text">
                        <template #icon><DeleteIcon /></template>
                      </Button>
                    </Popconfirm>
                  </Tooltip>
                </div>
              </template>

              <template #content>
                <div class="grok-provider-body">
                  <div class="grok-provider-details">
                    <div class="grok-detail-item">
                      <span class="grok-detail-label">Base URL</span>
                      <span class="grok-detail-value mono">{{ p.baseUrl || "—" }}</span>
                    </div>
                    <div class="grok-detail-item">
                      <span class="grok-detail-label">API Key</span>
                      <span class="grok-detail-value mono">
                        <LockOnIcon v-if="p.apiKey" size="12px" class="grok-key-lock" />
                        {{ p.apiKey ? maskValue(p.apiKey) : (p.envKey ? t("grok.config.envVar", { name: p.envKey }) : "—") }}
                        <Tooltip v-if="p.apiKey" :content="t('common.copy')">
                          <span class="grok-key-copy" @click="copyText(p.apiKey)"><CopyIcon size="12px" /></span>
                        </Tooltip>
                      </span>
                    </div>
                    <div class="grok-detail-item">
                      <span class="grok-detail-label">api_backend</span>
                      <span class="grok-detail-value">{{ backendLabel(p.apiBackend) }}</span>
                    </div>
                    <div class="grok-detail-item">
                      <span class="grok-detail-label">context_window</span>
                      <span class="grok-detail-value">{{ p.contextWindow ? formatNumber(p.contextWindow) : t("grok.config.inheritHint") }}</span>
                    </div>
                  </div>

                  <!-- 模型子区 -->
                  <div class="grok-models-section">
                    <div class="grok-models-title">
                      <span>{{ t("grok.config.modelsTitle") }}</span>
                      <Button size="small" variant="text" @click="openAddModelDialog(p.name)">
                        <template #icon><AddIcon /></template> {{ t("grok.config.addModel") }}
                      </Button>
                    </div>
                    <div v-if="p.models.length === 0" class="grok-models-empty">
                      {{ t("grok.config.modelsEmpty") }}
                    </div>
                    <div v-else class="grok-model-list">
                      <div v-for="m in p.models" :key="m.key" class="grok-model-item">
                        <div class="grok-model-info">
                          <span class="grok-model-name">{{ m.key }}</span>
                          <span v-if="m.model && m.model !== m.key" class="grok-model-sub mono">{{ m.model }}</span>
                          <span v-if="m.name && m.name !== m.key" class="grok-model-sub">{{ m.name }}</span>
                          <span v-if="m.contextWindow" class="grok-model-sub">{{ formatNumber(m.contextWindow) }} ctx</span>
                          <Tag v-if="isDefault(m)" size="small" theme="warning" variant="light">{{ t("grok.config.defaultTag") }}</Tag>
                        </div>
                        <div class="grok-model-actions" @click.stop>
                          <Tooltip v-if="!isDefault(m)" :content="t('grok.config.setDefaultTooltip')" placement="top">
                            <Button size="small" theme="warning" variant="text" @click="setDefaultModel(m)">
                              <template #icon><StarIcon /></template>
                            </Button>
                          </Tooltip>
                          <Tooltip :content="t('common.edit')" placement="top">
                            <Button size="small" theme="default" variant="text" @click="openEditModelDialog(m)">
                              <template #icon><EditIcon /></template>
                            </Button>
                          </Tooltip>
                          <Popconfirm :content="t('grok.config.deleteModelConfirm')" theme="danger" @confirm="handleDeleteModel(m)">
                            <Button size="small" theme="danger" variant="text">
                              <template #icon><DeleteIcon /></template>
                            </Button>
                          </Popconfirm>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
            </CollapsePanel>
          </Collapse>
        </div>

        <!-- 未分组模型：内联连接信息写法 / 内置模型覆盖 -->
        <div v-if="ungrouped.length" class="grok-ungrouped-block">
          <div class="grok-ungrouped-title">
            <span>{{ t("grok.config.ungroupedTitle") }}</span>
            <Button size="small" variant="text" @click="openAddModelDialog('')">
              <template #icon><AddIcon /></template> {{ t("grok.config.addUngroupedModel") }}
            </Button>
          </div>
          <div class="grok-ungrouped-list">
            <div v-for="m in ungrouped" :key="m.key" class="grok-ungrouped-item">
              <div class="grok-model-info">
                <span class="grok-model-name">{{ m.key }}</span>
                <span v-if="m.model && m.model !== m.key" class="grok-model-sub mono">{{ m.model }}</span>
                <Tag v-if="m.isBuiltinOverride" size="small" theme="default" variant="light">{{ t("grok.config.builtinOverride") }}</Tag>
                <Tag v-else size="small" variant="outline">{{ backendLabel(resolvedConn(m).apiBackend) }}</Tag>
                <span v-if="resolvedConn(m).baseUrl" class="grok-model-sub mono">{{ resolvedConn(m).baseUrl }}</span>
                <Tag v-if="isDefault(m)" size="small" theme="warning" variant="light">{{ t("grok.config.defaultTag") }}</Tag>
              </div>
              <div class="grok-model-actions">
                <Tooltip v-if="!isDefault(m)" :content="t('grok.config.setDefaultTooltip')" placement="top">
                  <Button size="small" theme="warning" variant="text" @click="setDefaultModel(m)">
                    <template #icon><StarIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip :content="t('common.edit')" placement="top">
                  <Button size="small" theme="default" variant="text" @click="openEditModelDialog(m)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm :content="t('grok.config.deleteModelConfirm')" theme="danger" @confirm="handleDeleteModel(m)">
                  <Button size="small" theme="danger" variant="text">
                    <template #icon><DeleteIcon /></template>
                  </Button>
                </Popconfirm>
              </div>
            </div>
          </div>
          <div class="grok-form-hint">{{ t("grok.config.ungroupedHint") }}</div>
        </div>
      </template>
    </template>

    <!-- 添加供应商弹窗 -->
    <Dialog
      v-model:visible="addProviderDialog"
      :header="t('grok.config.addProvider')"
      width="580px"
      :confirm-btn="{ content: t('common.add'), theme: 'primary' }"
      @confirm="handleAddProvider"
    >
      <div class="grok-edit-form">
        <div class="grok-form-item">
          <label>{{ t("grok.config.providerNameLabel") }} <span class="grok-form-required">*</span></label>
          <Input v-model="addProviderForm.name" placeholder="zhipu" />
          <div class="grok-form-hint">{{ t("grok.config.providerNameHint") }}</div>
        </div>
        <div class="grok-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" placeholder="https://api.example.com/v1" />
          <div class="grok-form-hint">{{ t("grok.config.baseUrlHint") }}</div>
        </div>
        <div class="grok-form-item">
          <label>{{ t("grok.config.apiBackendLabel") }}</label>
          <Select v-model="addProviderForm.apiBackend" :options="backendSelectOptions" />
          <div class="grok-form-hint">{{ t("grok.config.apiBackendHint") }}</div>
        </div>
        <div class="grok-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" :placeholder="t('grok.config.apiKeyPlaceholder')" />
        </div>
        <div class="grok-form-item">
          <label>{{ t("grok.config.envKeyLabel") }}</label>
          <Input v-model="addProviderForm.envKey" placeholder="OPENAI_API_KEY" />
          <div class="grok-form-hint">{{ t("grok.config.envKeyHint") }}</div>
        </div>
        <Button size="small" variant="text" @click="addProviderForm.advancedOpen = !addProviderForm.advancedOpen">
          {{ addProviderForm.advancedOpen ? t("grok.config.collapseAdvanced") : t("grok.config.expandAdvanced") }}
        </Button>
        <template v-if="addProviderForm.advancedOpen">
          <div class="grok-form-item">
            <label>context_window</label>
            <InputNumber v-model="addProviderForm.contextWindow" :min="0" :step="1000" style="width: 220px" :placeholder="t('grok.config.contextDefaultHint')" />
          </div>
          <div class="grok-form-item">
            <label>extra_headers</label>
            <DynamicKvEditor v-model="addProviderForm.extraHeaders" :key-placeholder="t('grok.config.headerKeyPlaceholder')" :value-placeholder="t('grok.config.headerValuePlaceholder')" />
          </div>
        </template>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗 -->
    <Dialog
      v-model:visible="editProviderDialog"
      :header="t('grok.config.editProvider')"
      width="580px"
      :confirm-btn="{ content: t('common.save'), theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="grok-edit-form">
        <div class="grok-form-item">
          <label>{{ t("grok.config.providerNameLabel") }}</label>
          <Input v-model="editProviderForm.name" />
          <div class="grok-form-hint">{{ t("grok.config.editProviderNameHint") }}</div>
        </div>
        <div class="grok-form-item">
          <label>Base URL</label>
          <Input v-model="editProviderForm.baseUrl" />
        </div>
        <div class="grok-form-item">
          <label>{{ t("grok.config.apiBackendLabel") }}</label>
          <Select v-model="editProviderForm.apiBackend" :options="backendSelectOptions" />
        </div>
        <div class="grok-form-item">
          <label>API Key</label>
          <ApiKeyInput
            v-model="editProviderForm.apiKey"
            :placeholder="originalProviderKey ? t('grok.config.apiKeySavedPlaceholder') : t('grok.config.apiKeyEmptyPlaceholder')"
          />
        </div>
        <div class="grok-form-item">
          <label>{{ t("grok.config.envKeyLabel") }}</label>
          <Input v-model="editProviderForm.envKey" :placeholder="t('grok.config.envKeyHint')" />
        </div>
        <Button size="small" variant="text" @click="editProviderForm.advancedOpen = !editProviderForm.advancedOpen">
          {{ editProviderForm.advancedOpen ? t("grok.config.collapseAdvanced") : t("grok.config.expandAdvanced") }}
        </Button>
        <template v-if="editProviderForm.advancedOpen">
          <div class="grok-form-item">
            <label>context_window</label>
            <InputNumber v-model="editProviderForm.contextWindow" :min="0" :step="1000" style="width: 220px" />
          </div>
          <div class="grok-form-item">
            <label>extra_headers</label>
            <DynamicKvEditor v-model="editProviderForm.extraHeaders" :key-placeholder="t('grok.config.headerKeyPlaceholder')" :value-placeholder="t('grok.config.headerValuePlaceholder')" />
          </div>
        </template>
      </div>
    </Dialog>

    <!-- 添加 / 编辑模型弹窗 -->
    <Dialog
      v-model:visible="modelDialog"
      :header="isModelDialogAdd ? t('grok.config.addModelTitle') : t('grok.config.editModelTitle')"
      width="620px"
      :confirm-btn="{ content: isModelDialogAdd ? t('common.add') : t('common.save'), theme: 'primary' }"
      @confirm="handleSaveModel"
    >
      <div class="grok-edit-form">
        <div class="grok-form-item">
          <label>{{ t("grok.config.modelKeyLabel") }} <span class="grok-form-required">*</span></label>
          <Input v-model="modelForm.key" placeholder="glm-5" />
          <div class="grok-form-hint">
            {{ isModelDialogAdd ? t("grok.config.modelKeyHint") : t("grok.config.editIdSyncHint") }}
          </div>
        </div>
        <div class="grok-form-item">
          <label>{{ t("grok.config.modelIdLabel") }}</label>
          <AutoComplete
            :value="modelForm.model"
            :options="modelOptions"
            :loading="fetchingModels"
            filterable
            clearable
            placeholder="z-ai/glm-5"
            @change="modelForm.model = $event"
          />
          <div v-if="fetchingModels" class="grok-form-hint">{{ t("grok.config.fetchingModels") }}</div>
          <div v-else-if="fetchModelError" class="grok-form-hint grok-fetch-error">
            {{ t("model.fetchFailed", { message: fetchModelError }) }}
            <span class="grok-fetch-retry" @click="handleFetchModels">{{ t("common.retry") }}</span>
          </div>
          <div v-else class="grok-form-hint">{{ t("grok.config.modelIdHint") }}</div>
        </div>
        <div class="grok-form-item">
          <label>name</label>
          <Input v-model="modelForm.name" :placeholder="t('grok.config.namePlaceholder')" />
        </div>
        <ModelLimitsFields
          v-model:context="modelForm.contextWindow"
          v-model:output="modelForm.maxCompletionTokens"
          item-class="grok-form-item"
        />
        <Button size="small" variant="text" @click="modelForm.advancedOpen = !modelForm.advancedOpen">
          {{ modelForm.advancedOpen ? t("grok.config.collapseAdvanced") : t("grok.config.expandAdvanced") }}
        </Button>
        <template v-if="modelForm.advancedOpen">
          <div class="grok-form-item">
            <label>{{ t("grok.config.descriptionLabel") }}</label>
            <Input v-model="modelForm.description" />
          </div>
          <div class="grok-form-row">
            <div class="grok-form-item">
              <label>temperature</label>
              <InputNumber v-model="modelForm.temperature" :min="0" :max="2" :step="0.1" :decimal-places="2" style="width: 180px" />
            </div>
            <div class="grok-form-item">
              <label>top_p</label>
              <InputNumber v-model="modelForm.topP" :min="0" :max="1" :step="0.05" :decimal-places="2" style="width: 180px" />
            </div>
          </div>
          <div class="grok-form-item">
            <label>extra_headers</label>
            <DynamicKvEditor v-model="modelForm.extraHeaders" :key-placeholder="t('grok.config.headerKeyPlaceholder')" :value-placeholder="t('grok.config.headerValuePlaceholder')" />
          </div>
        </template>
        <div class="grok-form-hint">
          {{ modelDialogProvider
            ? t("grok.config.modelInProvider", { name: modelDialogProvider })
            : t("grok.config.modelUngroupedHint") }}
        </div>
      </div>
    </Dialog>
  </div>
</template>
