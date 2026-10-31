<script setup>
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Dialog, Input, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link,
  Collapse, CollapsePanel, AutoComplete, Switch, Checkbox, CheckboxGroup, InputNumber,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon,
  CopyIcon, LockOnIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import { formatNumber } from "../../utils/format";
import { useFirstProviderExpand } from "../../composables/useFirstProviderExpand";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/ConfigView.css";

const { t } = useI18n();

// Codex 模型配置（Desktop / CLI 共用 ~/.codex/config.toml）。
// 文件结构与 Pi Agent 的 models.json 同构：[model_providers.<id>] 多供应商注册表
// （base_url / wire_api / experimental_bearer_token）+ 顶层 model_provider + model
// 一对当前生效配对，故 UI 形态对齐 Pi 配置页——供应商 Collapse 列表 + 模型行星标切换；
// 在模型行星标设置默认模型时会一并启用当前配置；顶部总开关统一启停认证、模型和目录。
// 仅管理模型相关字段，config.toml 其余配置由服务层读改写原样保留。

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
// 每供应商模型列表（config.toml 无此概念，存 uTools DB，供快捷切换与 models.json 目录生成）
const modelsMap = ref({});
const modelConfigsMap = ref({});
const current = ref({ provider: "", model: "", reasoningEffort: "", apiAuth: false, catalogPath: "", active: false });
const expandedList = ref([]);
useFirstProviderExpand(providers, expandedList);

// ==================== 当前生效配置（摘要 + 全局开关） ====================

// 思考强度：'' = 删除字段走 Codex 默认
const effortValue = ref("");

const effortOptions = [
  { labelKey: "common.default", value: "" },
  { label: "low", value: "low" },
  { label: "medium", value: "medium" },
  { label: "high", value: "high" },
  { label: "xhigh", value: "xhigh" },
];
const effortSelectOptions = computed(() =>
  effortOptions.map((o) => ({ label: o.labelKey ? t(o.labelKey) : o.label, value: o.value }))
);

// Codex 0.166 已移除 Chat Completions provider，wire_api 只允许 responses。
const wireApiOptions = [{ labelKey: "codex.config.wireApi.responses", value: "responses" }];
const wireApiSelectOptions = computed(() =>
  wireApiOptions.map((o) => ({ label: t(o.labelKey), value: o.value }))
);

const WIRE_API_LABEL_KEYS = {
  responses: "codex.config.wireApi.responses",
};
const wireApiLabel = (v) =>
  WIRE_API_LABEL_KEYS[v] ? t(WIRE_API_LABEL_KEYS[v]) : v || "responses";

// 未写 model_provider 时 Codex 走内置 openai
const currentProviderDisplay = () =>
  current.value.provider || t("codex.config.builtinProvider", { name: "openai" });

const isCurrentProvider = (p) => current.value.provider === p.id;
const isCurrentModel = (providerId, m) =>
  current.value.provider === providerId && current.value.model === m;
const modelConfig = (providerId, modelId) =>
  modelConfigsMap.value[providerId]?.[modelId] || {};

const handleEffortChange = (val) => {
  try {
    window.services.setCodexReasoningEffort(val || "");
    MessagePlugin.success(val ? t("codex.effort.set", { effort: val }) : t("codex.effort.reset"));
  } catch (e) {
    MessagePlugin.error(t("codex.effort.saveFailed", { message: e.message }));
  }
};

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    const list = window.services.getCodexProviderList() || [];
    modelsMap.value = window.services.getCodexProviderModelsMap() || {};
    modelConfigsMap.value = window.services.getCodexProviderModelConfigsMap() || {};
    current.value = window.services.getCodexCurrent() || {};
    effortValue.value = current.value.reasoningEffort || "";
    activeConfig.value = !!current.value.active;
    // 当前供应商排最前
    providers.value = list.sort(
      (a, b) => Number(isCurrentProvider(b)) - Number(isCurrentProvider(a))
    );
  } catch (e) {
    console.error("加载 Codex 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
};

// ==================== 供应商 CRUD ====================

const addProviderDialog = ref(false);
const addProviderForm = ref({ id: "", name: "", baseUrl: "", wireApi: "responses", apiKey: "" });
const editDialog = ref(false);
const editingProvider = ref("");
const editForm = ref({ id: "", name: "", baseUrl: "", wireApi: "responses", apiKey: "" });
const editClearKey = ref(false);
// 编辑弹窗初始加载的 key，用于占位提示
const originalApiKey = ref("");

const emptyProviderForm = () => ({ id: "", name: "", baseUrl: "", wireApi: "responses", apiKey: "" });

const openAddProviderDialog = () => {
  addProviderForm.value = emptyProviderForm();
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    const id = addProviderForm.value.id.trim();
    if (!id) return MessagePlugin.warning(t("codex.provider.idRequired"));
    const form = { ...addProviderForm.value, id, name: addProviderForm.value.name.trim() };
    if (!form.name) form.name = id;
    window.services.addCodexProvider(form);
    MessagePlugin.success(t("codex.provider.added", { id }));
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("codex.provider.addFailed", { message: e.message }));
  }
};

const handleEdit = (p) => {
  editingProvider.value = p.id;
  editForm.value = {
    id: p.id,
    name: p.name || p.id,
    baseUrl: p.baseUrl || "",
    wireApi: p.wireApi || "responses",
    apiKey: p.apiKey || "",
  };
  originalApiKey.value = p.apiKey || "";
  editClearKey.value = false;
  editDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    const newId = String(editForm.value.id || "").trim();
    if (!newId) return MessagePlugin.warning(t("codex.provider.idRequired"));
    if (originalApiKey.value && editClearKey.value && editForm.value.apiKey) {
      return MessagePlugin.warning(t("codex.provider.clearKeyConflict"));
    }
    const payload = {
      id: newId,
      name: editForm.value.name.trim() || newId,
      baseUrl: editForm.value.baseUrl.trim(),
      wireApi: editForm.value.wireApi,
    };
    // key 未修改则不回传，避免无意义写回
    if (editForm.value.apiKey && editForm.value.apiKey !== originalApiKey.value) {
      payload.apiKey = editForm.value.apiKey;
    }
    if (originalApiKey.value && editClearKey.value) payload.clearApiKey = true;
    const renamed = newId !== editingProvider.value;
    window.services.updateCodexProvider(editingProvider.value, payload);
    MessagePlugin.success(
      renamed
        ? t("codex.provider.updatedRenamed", { id: newId })
        : t("codex.provider.updated")
    );
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("codex.provider.saveFailed", { message: e.message }));
  }
};

const handleDeleteProvider = (id) => {
  try {
    window.services.deleteCodexProvider(id);
    MessagePlugin.success(t("codex.provider.deleted", { id }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("codex.provider.deleteFailed", { message: e.message }));
  }
};

// ==================== 模型 CRUD（DB 列表） ====================

const addModelDialog = ref(false);
const modelDialogMode = ref("create");
const addModelProvider = ref("");
const addModelId = ref("");
const editingModelId = ref("");
const fetchedModels = ref([]);
const fetchingModels = ref(false);
const fetchModelError = ref("");
// Codex 目录支持的可编辑字段（模型目录与 config.toml 都没有最大输出字段）。
const emptyModelForm = () => ({ id: "", name: "", contextWindow: 0, input: ["text"] });
const addModelForm = ref(emptyModelForm());
const inputTypeOptions = computed(() => [
  { label: t("codex.config.inputText"), value: "text" },
  { label: t("codex.config.inputImage"), value: "image" },
]);

const openAddModelDialog = (providerId) => {
  modelDialogMode.value = "create";
  addModelProvider.value = providerId;
  addModelId.value = "";
  editingModelId.value = "";
  addModelForm.value = emptyModelForm();
  fetchedModels.value = [];
  fetchModelError.value = "";
  addModelDialog.value = true;
  // 弹窗打开即尝试拉取该供应商可用模型（同 Pi 配置页）
  handleFetchModels();
};

const openEditModelDialog = (providerId, modelId) => {
  const cfg = modelConfig(providerId, modelId);
  modelDialogMode.value = "edit";
  addModelProvider.value = providerId;
  editingModelId.value = modelId;
  addModelForm.value = {
    id: modelId,
    name: cfg.name || "",
    contextWindow: Number(cfg.contextWindow) || 0,
    input: Array.isArray(cfg.input) && cfg.input.length ? [...cfg.input] : ["text"],
  };
  fetchedModels.value = [];
  fetchModelError.value = "";
  addModelDialog.value = true;
};

const addModelOptions = computed(() =>
  fetchedModels.value.map((m) => ({ label: m.name || m.id, value: m.id }))
);

const handleFetchModels = async () => {
  const p = providers.value.find((x) => x.id === addModelProvider.value);
  if (!p || !p.baseUrl) {
    fetchModelError.value = t("common.noBaseUrl");
    return;
  }
  fetchingModels.value = true;
  fetchModelError.value = "";
  try {
    const list = await window.services.fetchProviderModels(p.baseUrl, p.apiKey);
    fetchedModels.value = list || [];
    if (!fetchedModels.value.length) fetchModelError.value = t("codex.config.noModels");
  } catch (e) {
    fetchModelError.value = e.message || t("common.fetchFailed");
  } finally {
    fetchingModels.value = false;
  }
};

const modelPayload = (id) => ({
  id,
  name: addModelForm.value.name.trim(),
  contextWindow: Number(addModelForm.value.contextWindow) || 0,
  input: addModelForm.value.input.length ? addModelForm.value.input : ["text"],
});

const handleAddModel = () => {
  try {
    const originalId = addModelId.value.trim();
    const id = String(addModelForm.value.id || originalId).trim();
    if (!id) return MessagePlugin.warning(t("codex.model.idRequired"));
    const payload = modelPayload(id);
    if (modelDialogMode.value === "create") {
      window.services.addCodexModel(addModelProvider.value, id, payload);
      MessagePlugin.success(t("codex.model.added", { id }));
    } else {
      window.services.updateCodexModel(addModelProvider.value, editingModelId.value, payload);
      MessagePlugin.success(t("codex.model.updated"));
    }
    addModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(
      t(modelDialogMode.value === "create" ? "codex.model.addFailed" : "codex.model.saveFailed", {
        message: e.message,
      })
    );
  }
};

const handleDeleteModel = (providerId, modelId) => {
  try {
    window.services.deleteCodexModel(providerId, modelId);
    MessagePlugin.success(t("codex.model.deleted", { id: modelId }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("codex.model.deleteFailed", { message: e.message }));
  }
};

// 点星标 → 设为当前模型；服务层同时启用 API Key 认证并同步模型目录
const setCurrentModel = (providerId, modelId) => {
  try {
    window.services.setCodexDefaultModel(providerId, modelId);
    MessagePlugin.success(t("codex.model.switched", { provider: providerId, model: modelId }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("codex.model.switchFailed", { message: e.message }));
  }
};

// ==================== 使用当前配置 ====================

// 一个总开关绑定 model/model_provider、API Key 认证和模型目录三组字段。
const activeConfig = ref(false);

const handleActiveConfigToggle = (val) => {
  try {
    window.services.setCodexActiveConfig(!!val);
    refresh();
    MessagePlugin.success(val ? t("codex.config.activeEnabled") : t("codex.config.activeDisabled"));
  } catch (e) {
    activeConfig.value = !val;
    MessagePlugin.error(
      val
        ? t("codex.config.activeEnableFailed", { message: e.message })
        : t("codex.config.activeDisableFailed", { message: e.message })
    );
  }
};

// ==================== 恢复默认（撤销全部模型定制） ====================

const showResetDialog = ref(false);

// 是否有可撤销的定制（无可撤销时入口置灰）
const hasCodexCustomization = computed(() =>
  !!(current.value.active || current.value.model || providers.value.length)
);

const resetSummary = computed(() => {
  const items = [];
  if (current.value.model) {
    items.push(
      t("codex.config.resetSummaryCurrent", {
        provider: current.value.provider || t("codex.config.builtin"),
        model: current.value.model,
      })
    );
  }
  if (current.value.reasoningEffort) {
    items.push(t("codex.config.resetSummaryEffort", { effort: current.value.reasoningEffort }));
  }
  if (current.value.active) items.push(t("codex.config.resetSummaryActive"));
  items.push(t("codex.config.resetSummaryProviders", { count: providers.value.length }));
  items.push(t("codex.config.resetSummaryLogin"));
  return items.map((s, i) => `${i + 1}. ${s}`).join("\n");
});

const confirmReset = () => {
  try {
    window.services.resetCodexConfig();
    MessagePlugin.success(t("codex.reset.done"));
    showResetDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("codex.reset.failed", { message: e.message }));
  }
};

// ==================== 辅助 ====================

// 掩码显示：只保留前 4 + 后 4，中间用 ··· 替代
const maskValue = (val) => {
  if (!val) return "";
  if (val.length <= 10) return "••••••";
  return val.slice(0, 4) + "····" + val.slice(-4);
};

const keyDisplay = (p) => {
  if (p.apiKey) return maskValue(p.apiKey);
  if (p.envKey) return t("codex.config.envVar", { name: p.envKey });
  return "—";
};

const copyText = (val) => {
  try {
    window.utools.copyText(val);
    MessagePlugin.success(t("common.copiedToClipboard"));
  } catch {
    MessagePlugin.error(t("common.copyFailed"));
  }
};

const openCodexDir = () => {
  try { window.services.openCodexDir(); } catch { /* ignore */ }
};

const { autoRefreshing, refreshNow } = usePageRefresh("codex", "config", refresh);

onMounted(refreshNow);
</script>

<template>
  <div class="codex-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="codex-toolbar">
      <div class="codex-toolbar-left">
        <span class="codex-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openCodexDir">~/.codex/</Link>
          <span class="codex-toolbar-sub">{{ t("codex.config.toolbarSubtitle") }}</span>
        </span>
      </div>
      <div class="codex-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> {{ t("codex.config.addProvider") }}
        </Button>
        <Tooltip
          :content="!activeConfig && !current.model ? t('codex.config.activeNeedModel') : t('codex.config.activeToggleTooltip')"
          placement="top"
        >
          <span class="codex-catalog-toggle">
            {{ t("codex.config.activeToggle") }}
            <Switch
              v-model="activeConfig"
              size="small"
              :disabled="!activeConfig && !current.model"
              @change="handleActiveConfigToggle"
            />
          </span>
        </Tooltip>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading || autoRefreshing" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="codex-config-warning">
      <t-alert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <!-- 当前生效配置（只读摘要 + Codex 全局开关） -->
      <div class="codex-current-card">
        <div class="codex-current-header">
          <div class="codex-current-header-left">
            <span class="codex-current-title">{{ t("codex.config.currentTitle") }}</span>
            <span
              class="codex-reset-btn"
              :class="{ disabled: !hasCodexCustomization }"
              @click="hasCodexCustomization && (showResetDialog = true)"
            >{{ t("codex.config.reset") }}</span>
            <span class="codex-current-sub">{{ t("codex.config.currentSubtitle") }}</span>
          </div>
          <div class="codex-current-actions">
            <div class="codex-current-effort">
              <span class="codex-current-effort-label">{{ t("codex.config.effort") }}</span>
              <Select
                v-model="effortValue"
                :options="effortSelectOptions"
                size="small"
                style="width: 96px"
                @change="handleEffortChange"
              />
            </div>
          </div>
        </div>
        <div class="codex-current-main">
          <template v-if="current.model">
            <span class="codex-current-provider">{{ currentProviderDisplay() }}</span>
            <span class="codex-current-arrow">→</span>
            <span class="codex-current-model">{{ current.model }}</span>
          </template>
          <span v-else class="codex-current-empty">{{ t("codex.config.currentEmpty") }}</span>
        </div>
      </div>

      <!-- 供应商列表 -->
      <div v-if="providers.length === 0" class="codex-config-empty">
        <Empty :description="t('codex.config.emptyProviders')" />
      </div>

      <div v-else class="codex-provider-list">
        <Collapse v-model="expandedList" class="codex-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.id" :value="p.id">
            <!-- 供应商头部：名称 + 当前标记 + 协议 + 操作 -->
            <template #header>
              <div class="codex-provider-header-left">
                <span class="codex-provider-name">{{ p.id }}</span>
                <Tag v-if="isCurrentProvider(p)" size="small" theme="warning" variant="light">{{ t("codex.config.currentTag") }}</Tag>
                <Tag size="small" variant="outline">{{ p.wireApi }}</Tag>
                <span v-if="p.name && p.name !== p.id" class="codex-provider-display-name">{{ p.name }}</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="codex-provider-header-right" @click.stop>
                <span class="codex-model-count">{{ t("codex.config.modelCount", { count: (modelsMap[p.id] || []).length }) }}</span>
                <Tooltip :content="t('codex.config.editProvider')" placement="top">
                  <Button size="small" theme="default" variant="text" @click="handleEdit(p)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip :content="t('codex.config.deleteProvider')">
                  <Popconfirm
                    :content="t('codex.config.deleteProviderConfirm', { id: p.id })"
                    theme="danger"
                    @confirm="handleDeleteProvider(p.id)"
                  >
                    <Button size="small" theme="danger" variant="text">
                      <template #icon><DeleteIcon /></template>
                    </Button>
                  </Popconfirm>
                </Tooltip>
              </div>
            </template>

            <!-- 展开内容：详情 + 模型列表 -->
            <template #content>
              <div class="codex-provider-body">
                <div class="codex-provider-info">
                  <div class="codex-info-row">
                    <span class="codex-info-label">API Key</span>
                    <span class="codex-info-value mono">
                      <LockOnIcon v-if="p.apiKey" size="12px" class="codex-key-lock" />
                      {{ keyDisplay(p) }}
                      <Tooltip v-if="p.apiKey" :content="t('common.copy')">
                        <span class="codex-key-copy" @click="copyText(p.apiKey)"><CopyIcon size="12px" /></span>
                      </Tooltip>
                    </span>
                  </div>
                  <div class="codex-info-row">
                    <span class="codex-info-label">Base URL</span>
                    <span class="codex-info-value mono">{{ p.baseUrl || "—" }}</span>
                  </div>
                  <div class="codex-info-row">
                    <span class="codex-info-label">{{ t("codex.config.protocol") }}</span>
                    <span class="codex-info-value">{{ wireApiLabel(p.wireApi) }}</span>
                  </div>
                  <div v-if="p._extra && p._extra.model_catalog_url" class="codex-info-row">
                    <span class="codex-info-label">{{ t("codex.config.catalog") }}</span>
                    <span class="codex-info-value mono">{{ p._extra.model_catalog_url }}</span>
                  </div>
                </div>

                <!-- 模型子区 -->
                <div class="codex-models-section">
                  <div class="codex-models-title">
                    <span>{{ t("codex.config.modelsTitle") }}</span>
                    <Button size="small" variant="text" @click="openAddModelDialog(p.id)">
                      <template #icon><AddIcon /></template> {{ t("codex.config.addModel") }}
                    </Button>
                  </div>
                  <div v-if="(modelsMap[p.id] || []).length === 0" class="codex-models-empty">
                    {{ t("codex.config.modelsEmpty") }}
                  </div>
                  <div v-else class="codex-model-list">
                    <div v-for="m in modelsMap[p.id]" :key="m" class="codex-model-item">
                      <div class="codex-model-info">
                        <span class="codex-model-name">{{ modelConfig(p.id, m).name || m }}</span>
                        <Tag v-if="isCurrentModel(p.id, m)" size="small" theme="warning" variant="light">{{ t("codex.config.currentTag") }}</Tag>
                        <span v-if="modelConfig(p.id, m).contextWindow" class="codex-model-meta">
                          {{ t("codex.config.contextShort", { value: formatNumber(modelConfig(p.id, m).contextWindow) }) }}
                        </span>
                        <span v-if="(modelConfig(p.id, m).input || []).includes('image')" class="codex-model-meta">
                          {{ t("codex.config.inputImage") }}
                        </span>
                      </div>
                      <div class="codex-model-actions" @click.stop>
                        <Tooltip v-if="!isCurrentModel(p.id, m)" :content="t('codex.config.setCurrentModel')" placement="top">
                          <Button size="small" theme="default" variant="text" @click="setCurrentModel(p.id, m)">
                            <template #icon><StarIcon /></template>
                          </Button>
                        </Tooltip>
                        <Tooltip :content="t('codex.config.editModel')" placement="top">
                          <Button size="small" theme="default" variant="text" @click="openEditModelDialog(p.id, m)">
                            <template #icon><EditIcon /></template>
                          </Button>
                        </Tooltip>
                        <Popconfirm :content="t('codex.config.deleteModelConfirm')" theme="danger" @confirm="handleDeleteModel(p.id, m)">
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
    </template>

    <!-- 添加供应商弹窗 -->
    <Dialog
      v-model:visible="addProviderDialog"
      :header="t('codex.config.addProvider')"
      width="520px"
      :confirm-btn="{ content: t('common.add'), theme: 'primary' }"
      @confirm="handleAddProvider"
    >
      <div class="codex-edit-form">
        <div class="codex-form-item">
          <label>ID <span class="codex-form-required">*</span></label>
          <Input v-model="addProviderForm.id" placeholder="deepseek" />
          <div class="codex-form-hint">{{ t("codex.config.providerIdHint") }}</div>
        </div>
        <div class="codex-form-item"><label>{{ t("codex.config.nameOptional") }}</label><Input v-model="addProviderForm.name" :placeholder="t('codex.config.namePlaceholder')" /></div>
        <div class="codex-form-item"><label>Base URL</label><Input v-model="addProviderForm.baseUrl" placeholder="https://api.deepseek.com/" /></div>
        <div class="codex-form-item">
          <label>{{ t("codex.config.protocolLabel") }}</label>
          <Select v-model="addProviderForm.wireApi" :options="wireApiSelectOptions" disabled />
        </div>
        <div class="codex-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" :placeholder="t('codex.config.apiKeyPlaceholder')" />
          <div class="codex-form-hint">{{ t("codex.config.apiKeyHint") }}</div>
        </div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗 -->
    <Dialog
      v-model:visible="editDialog"
      :header="t('codex.config.editTitle')"
      width="520px"
      :confirm-btn="{ content: t('common.save'), theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="codex-edit-form">
        <div class="codex-form-item">
          <label>ID <span class="codex-form-required">*</span></label>
          <Input v-model="editForm.id" placeholder="deepseek" />
          <div class="codex-form-hint">{{ t("codex.config.editIdHint") }}</div>
        </div>
        <div class="codex-form-item"><label>{{ t("codex.config.nameOptional") }}</label><Input v-model="editForm.name" :placeholder="t('codex.config.namePlaceholder')" /></div>
        <div class="codex-form-item"><label>Base URL</label><Input v-model="editForm.baseUrl" placeholder="https://api.deepseek.com/" /></div>
        <div class="codex-form-item">
          <label>{{ t("codex.config.protocolLabel") }}</label>
          <Select v-model="editForm.wireApi" :options="wireApiSelectOptions" disabled />
        </div>
        <div class="codex-form-item">
          <label>API Key</label>
          <ApiKeyInput
            v-model="editForm.apiKey"
            :placeholder="originalApiKey ? t('codex.config.apiKeySavedPlaceholder') : t('codex.config.apiKeyPlaceholder')"
          />
          <Checkbox v-if="originalApiKey" v-model="editClearKey" class="codex-clear-key-checkbox">
            {{ t("codex.config.clearKey") }}
          </Checkbox>
        </div>
      </div>
    </Dialog>

    <!-- 添加模型弹窗 -->
    <Dialog
      v-model:visible="addModelDialog"
      :header="modelDialogMode === 'create' ? t('codex.config.addModel') : t('codex.config.editModel')"
      width="500px"
      :confirm-btn="{ content: modelDialogMode === 'create' ? t('common.add') : t('common.save'), theme: 'primary' }"
      @confirm="handleAddModel"
    >
      <div class="codex-edit-form">
        <div class="codex-form-item">
          <label>{{ t("codex.config.modelIdLabel") }} <span class="codex-form-required">*</span></label>
          <AutoComplete
            :model-value="modelDialogMode === 'create' ? addModelId : addModelForm.id"
            :options="addModelOptions"
            :loading="modelDialogMode === 'create' && fetchingModels"
            filterable
            :clearable="modelDialogMode === 'create'"
            :disabled="modelDialogMode === 'edit'"
            placeholder="deepseek-v4-flash"
            @update:model-value="(value) => {
              if (modelDialogMode === 'create') {
                addModelId = value;
                addModelForm.id = value;
              }
            }"
          />
          <div v-if="modelDialogMode === 'create' && fetchingModels" class="codex-form-hint">{{ t("codex.config.fetchingModels") }}</div>
          <div v-else-if="modelDialogMode === 'create' && fetchModelError" class="codex-form-hint codex-fetch-error">
            {{ t("model.fetchFailed", { message: fetchModelError }) }}
            <span class="codex-fetch-retry" @click="handleFetchModels">{{ t("common.retry") }}</span>
          </div>
          <div v-else-if="modelDialogMode === 'create'" class="codex-form-hint">{{ t("codex.config.fetchHint") }}</div>
        </div>
        <div class="codex-form-item">
          <label>{{ t("codex.config.modelDisplayName") }}</label>
          <Input v-model="addModelForm.name" :placeholder="t('codex.config.modelDisplayNamePlaceholder')" />
        </div>
        <div class="codex-form-item">
          <label>{{ t("codex.config.inputType") }}</label>
          <CheckboxGroup v-model="addModelForm.input">
            <Checkbox v-for="opt in inputTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
          </CheckboxGroup>
        </div>
        <ModelLimitsFields
          v-model:context="addModelForm.contextWindow"
          :show-output="false"
          item-class="codex-form-item"
        />
        <div class="codex-form-hint">{{ t("codex.config.modelLimitsHint") }}</div>
        <div class="codex-form-hint">{{ t("codex.config.providerLabel", { name: addModelProvider }) }}</div>
      </div>
    </Dialog>

    <!-- 恢复默认配置确认弹窗 -->
    <Dialog v-model:visible="showResetDialog" :header="t('codex.config.reset')" width="520px" :footer="false">
      <div class="codex-reset-body">
        <p class="codex-reset-warning">{{ t("codex.config.resetWarning") }}</p>
        <pre class="codex-reset-list">{{ resetSummary }}</pre>
        <p class="codex-reset-note">{{ t("codex.config.resetNote") }}</p>
      </div>
      <div class="codex-reset-footer">
        <Button variant="outline" @click="showResetDialog = false">{{ t("common.cancel") }}</Button>
        <Button theme="danger" @click="confirmReset">{{ t("codex.config.confirmReset") }}</Button>
      </div>
    </Dialog>
  </div>
</template>
