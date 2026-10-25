<script setup>
// MiniMax Code（CLI mcode / Desktop）模型配置页：~/.minimax/config.yaml
// 管理内置 minimax（只读，可设默认）+ custom_provider 第三方供应商/模型 CRUD + 顶层 defaultModel。
// 风格与 Kimi 配置页一致：供应商手风琴 + 模型标签（星标设默认）。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Dialog, Input, InputNumber, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link, AutoComplete,
  Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import "./styles/ConfigView.css";

const { t } = useI18n();

// defaultModel 引用 custom 供应商的前缀，与服务层 CUSTOM_PREFIX 一致
const CUSTOM_PREFIX = "custom_provider";

// 官方支持的 API 格式（docs/cli/configuration），与服务层 MINIMAX_API_FORMATS 一致
const apiOptions = [
  { labelKey: "minimax.config.api.openaiCompletions", value: "openai-completions" },
  { labelKey: "minimax.config.api.openaiResponses", value: "openai-responses" },
  { labelKey: "minimax.config.api.anthropicMessages", value: "anthropic-messages" },
];
const apiSelectOptions = computed(() =>
  apiOptions.map((o) => ({ label: t(o.labelKey), value: o.value }))
);

// 推理等级（thinking.effortOptions）与支持附件（modalities.input），与服务层枚举一致；
// 与桌面版模型编辑界面同组：推理等级 + 支持的附件（图片/PDF/视频/音频）
const effortOptions = ["minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ label: v, value: v }));
const attachmentOptions = [
  { labelKey: "minimax.config.attachment.image", value: "image" },
  { labelKey: "minimax.config.attachment.pdf", value: "pdf" },
  { labelKey: "minimax.config.attachment.video", value: "video" },
  { labelKey: "minimax.config.attachment.audio", value: "audio" },
];
const attachmentSelectOptions = computed(() =>
  attachmentOptions.map((o) => ({ label: t(o.labelKey), value: o.value }))
);
const ATTACH_LABEL_KEYS = {
  image: "minimax.config.attachment.image",
  pdf: "minimax.config.attachment.pdf",
  video: "minimax.config.attachment.video",
  audio: "minimax.config.attachment.audio",
};
const attachmentLabel = (v) => (ATTACH_LABEL_KEYS[v] ? t(ATTACH_LABEL_KEYS[v]) : v);

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
// 顶层 defaultModel 原始字符串（可能带 #variant）；比较时去后缀
const defaultModel = ref("");
const defaultBase = computed(() => defaultModel.value.split("#")[0]);
const expandedList = ref([]);

// 当前 provider+model 的 defaultModel 引用形态
const modelRef = (p, modelId) =>
  p.managed ? `${p.id}/${modelId}` : `${CUSTOM_PREFIX}:${p.id}/${modelId}`;
const isDefaultModel = (p, modelId) => !!defaultBase.value && defaultBase.value === modelRef(p, modelId);
const isDefaultProvider = (p) => p.models.some((m) => isDefaultModel(p, m.id));

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
    providers.value = window.services.getMinimaxProviderList() || [];
    defaultModel.value = window.services.getMinimaxDefaultModel() || "";
  } catch (e) {
    console.error("加载 MiniMax Code 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
};

const openMinimaxDir = () => {
  try { window.services.openMinimaxDir(); } catch { /* ignore */ }
};

// ==================== 弹窗状态 ====================

const addProviderDialog = ref(false);
const addProviderForm = ref({ id: "", name: "", api: "openai-completions", baseUrl: "", apiKey: "" });
const editDialog = ref(false);
const editingProvider = ref("");
const editForm = ref({ id: "", name: "", api: "openai-completions", baseUrl: "", apiKey: "" });
// 编辑弹窗初始加载的 key，保存时判断是否被用户改动/清空
const originalApiKey = ref("");

const addModelDialog = ref(false);
const addModelProvider = ref("");
const emptyModelForm = () => ({ model: "", name: "", contextWindow: 0, outputWindow: 0, effortOptions: [], inputTypes: [] });
const addModelForm = ref(emptyModelForm());
const editModelDialog = ref(false);
const editingModel = ref("");
const editingModelProvider = ref("");
const editModelForm = ref(emptyModelForm());

// 模型候选（复用通用供应商 /models 拉取，失败静默）
const fetchedModels = ref([]);
const fetchingModels = ref(false);
const fetchModelError = ref("");

// ==================== 供应商 CRUD ====================

const openAddProviderDialog = () => {
  addProviderForm.value = { id: "", name: "", api: "openai-completions", baseUrl: "", apiKey: "" };
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    const id = addProviderForm.value.id.trim();
    if (!id) { MessagePlugin.warning(t("minimax.provider.idRequired")); return; }
    window.services.addMinimaxProvider({
      id,
      name: addProviderForm.value.name.trim(),
      api: addProviderForm.value.api,
      baseUrl: addProviderForm.value.baseUrl.trim(),
      apiKey: addProviderForm.value.apiKey,
    });
    MessagePlugin.success(t("minimax.provider.added", { id }));
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("minimax.provider.addFailed", { message: e.message }));
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.id;
  editForm.value = {
    id: provider.id,
    name: provider.name || provider.id,
    api: provider.api || "openai-completions",
    baseUrl: provider.baseUrl || "",
    apiKey: provider.apiKey || "",
  };
  originalApiKey.value = provider.apiKey || "";
  editDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    const newId = String(editForm.value.id || "").trim();
    if (!newId) { MessagePlugin.warning(t("minimax.provider.idRequired")); return; }
    const payload = {
      id: newId,
      name: editForm.value.name.trim(),
      api: editForm.value.api,
      baseUrl: editForm.value.baseUrl.trim(),
    };
    // key：清空 → 删除；改动 → 覆盖；未动 → 不回传
    if (!editForm.value.apiKey && originalApiKey.value) payload.clearApiKey = true;
    else if (editForm.value.apiKey !== originalApiKey.value) payload.apiKey = editForm.value.apiKey;
    window.services.updateMinimaxProvider(editingProvider.value, payload);
    MessagePlugin.success(
      newId !== editingProvider.value
        ? t("minimax.provider.updatedRenamed", { id: newId })
        : t("minimax.provider.updated")
    );
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("minimax.provider.saveFailed", { message: e.message }));
  }
};

const handleDeleteProvider = (providerId) => {
  try {
    window.services.deleteMinimaxProvider(providerId);
    MessagePlugin.success(t("minimax.provider.deleted", { id: providerId }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("minimax.provider.deleteFailed", { message: e.message }));
  }
};

// ==================== 默认模型 ====================

// 模型标签上点星标 → 写入顶层 defaultModel（内置模型同样可设）
const setDefaultModel = (p, modelId) => {
  try {
    window.services.setMinimaxDefaultModel(modelRef(p, modelId));
    MessagePlugin.success(t("minimax.model.defaultSet", { id: modelId }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("minimax.model.saveFailed", { message: e.message }));
  }
};

// ==================== 模型 CRUD ====================

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
    if (!fetchedModels.value.length) fetchModelError.value = t("minimax.config.noModels");
  } catch (e) {
    fetchModelError.value = e.message || t("common.fetchFailed");
  } finally {
    fetchingModels.value = false;
  }
};

const modelOptions = computed(() =>
  fetchedModels.value.map((m) => ({ label: m.name || m.id, value: m.id }))
);

const openAddModelDialog = (providerId) => {
  addModelProvider.value = providerId;
  addModelForm.value = emptyModelForm();
  fetchedModels.value = [];
  fetchModelError.value = "";
  addModelDialog.value = true;
  handleFetchModels();
};

const handleAddModel = () => {
  try {
    const modelId = addModelForm.value.model.trim();
    if (!modelId) { MessagePlugin.warning(t("minimax.model.idRequired")); return; }
    window.services.addMinimaxModel(addModelProvider.value, {
      model: modelId,
      name: addModelForm.value.name.trim(),
      contextWindow: Number(addModelForm.value.contextWindow) || 0,
      outputWindow: Number(addModelForm.value.outputWindow) || 0,
      effortOptions: addModelForm.value.effortOptions,
      inputTypes: addModelForm.value.inputTypes,
    });
    MessagePlugin.success(t("minimax.model.added", { id: modelId }));
    addModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("minimax.model.addFailed", { message: e.message }));
  }
};

const openEditModelDialog = (p, m) => {
  editingModel.value = m.id;
  editingModelProvider.value = p.id;
  editModelForm.value = {
    model: m.id,
    name: m.name === m.id ? "" : m.name || "",
    contextWindow: m.contextWindow || 0,
    outputWindow: m.outputWindow || 0,
    effortOptions: [...(m.effortOptions || [])],
    inputTypes: [...(m.inputTypes || [])],
  };
  editModelDialog.value = true;
};

const handleSaveModel = () => {
  try {
    window.services.updateMinimaxModel(editingModelProvider.value, editingModel.value, {
      model: editModelForm.value.model.trim(),
      name: editModelForm.value.name.trim(),
      contextWindow: Number(editModelForm.value.contextWindow) || 0,
      outputWindow: Number(editModelForm.value.outputWindow) || 0,
      effortOptions: editModelForm.value.effortOptions,
      inputTypes: editModelForm.value.inputTypes,
    });
    MessagePlugin.success(t("minimax.model.updated"));
    editModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("minimax.model.saveFailed", { message: e.message }));
  }
};

const handleDeleteModel = (providerId, modelId) => {
  try {
    window.services.deleteMinimaxModel(providerId, modelId);
    MessagePlugin.success(t("minimax.model.deleted", { id: modelId }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("minimax.model.deleteFailed", { message: e.message }));
  }
};

onMounted(refresh);
</script>

<template>
  <div class="minimax-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="minimax-toolbar">
      <div class="minimax-toolbar-left">
        <span class="minimax-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openMinimaxDir">~/.minimax/</Link>
          <span class="minimax-toolbar-sub">{{ t("minimax.config.toolbarSubtitle") }}</span>
        </span>
      </div>
      <div class="minimax-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> {{ t("minimax.config.addProvider") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="minimax-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0" class="minimax-config-empty">
        <Empty :description="t('minimax.config.emptyProviders')" />
      </div>

      <div v-else class="minimax-provider-list">
        <Collapse v-model="expandedList" class="minimax-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.id" :value="p.id">
              <template #header>
                <div class="minimax-provider-header-left">
                  <span class="minimax-provider-name">{{ p.name }}</span>
                  <Tag size="small" variant="outline">{{ p.api }}</Tag>
                  <Tag v-if="p.managed" size="small" theme="primary" variant="light">{{ t("minimax.config.builtinManaged") }}</Tag>
                  <Tag v-else-if="isDefaultProvider(p)" size="small" theme="warning" variant="light">{{ t("minimax.config.hasDefaultModel") }}</Tag>
                  <span class="minimax-model-count">{{ t("minimax.config.modelCount", { count: p.models.length }) }}</span>
                </div>
              </template>
              <template #headerRightContent>
                <div class="minimax-provider-header-right" @click.stop>
                  <template v-if="!p.managed">
                    <Button size="small" theme="default" variant="text" @click="handleEdit(p)">
                      <template #icon><EditIcon /></template> {{ t("common.edit") }}
                    </Button>
                    <Tooltip :content="t('minimax.config.deleteProviderTooltip')">
                      <Popconfirm
                        :content="t('minimax.config.deleteProviderConfirm', { id: p.id })"
                        theme="danger"
                        @confirm="handleDeleteProvider(p.id)"
                      >
                        <Button size="small" theme="danger" variant="text">
                          <template #icon><DeleteIcon /></template>
                        </Button>
                      </Popconfirm>
                    </Tooltip>
                  </template>
                </div>
              </template>

              <!-- 展开内容：详情 + 模型列表 -->
              <template #content>
                <div class="minimax-provider-body">
                  <div class="minimax-provider-details">
                    <div class="minimax-detail-item">
                      <span class="minimax-detail-label">Base URL</span>
                      <span class="minimax-detail-value">{{ p.baseUrl || t("minimax.config.baseUrlDefault") }}</span>
                    </div>
                    <div class="minimax-detail-item">
                      <span class="minimax-detail-label">API Key</span>
                      <span class="minimax-detail-value mono">{{ p.apiKey ? t("minimax.config.configured") : (p.managed ? t("minimax.config.loginManaged") : t("minimax.config.unconfigured")) }}</span>
                    </div>
                  </div>

                  <div class="minimax-models-section">
                    <div class="minimax-models-title">
                      <span>{{ t("minimax.config.modelsTitle") }}</span>
                      <Button v-if="!p.managed" size="small" variant="outline" @click="openAddModelDialog(p.id)">
                        <template #icon><AddIcon /></template> {{ t("common.add") }}
                      </Button>
                    </div>
                    <div v-if="p.models.length === 0" class="minimax-models-empty">
                      {{ t("minimax.config.modelsEmpty") }}
                    </div>
                    <div class="minimax-model-tags">
                      <span v-for="m in p.models" :key="m.id" class="minimax-model-tag">
                        <span class="minimax-model-tag-name">{{ m.id }}</span>
                        <span v-if="m.name && m.name !== m.id" class="minimax-model-tag-sub">{{ m.name }}</span>
                        <span v-if="m.contextWindow" class="minimax-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                        <span v-if="m.inputTypes && m.inputTypes.length" class="minimax-model-tag-sub">
                          {{ m.inputTypes.map((type) => attachmentLabel(type)).join("/") }}
                        </span>
                        <span v-if="m.effortOptions && m.effortOptions.length" class="minimax-model-tag-sub">
                          {{ m.effortOptions.join("/") }}
                        </span>
                        <Tag v-if="isDefaultModel(p, m.id)" size="small" theme="success" variant="light">{{ t("common.default") }}</Tag>
                        <Tooltip v-else :content="t('minimax.config.setDefaultTooltip')" placement="top">
                          <span class="minimax-model-tag-star" @click="setDefaultModel(p, m.id)"><StarIcon size="12px" /></span>
                        </Tooltip>
                        <template v-if="!p.managed">
                          <Tooltip :content="t('minimax.config.editModelTooltip')" placement="top">
                            <span class="minimax-model-tag-edit" @click="openEditModelDialog(p, m)"><EditIcon size="12px" /></span>
                          </Tooltip>
                          <Popconfirm :content="t('minimax.config.deleteModelConfirm')" theme="danger" @confirm="handleDeleteModel(p.id, m.id)">
                            <span class="minimax-model-tag-del"><DeleteIcon size="12px" /></span>
                          </Popconfirm>
                        </template>
                      </span>
                    </div>
                  </div>
                </div>
              </template>
            </CollapsePanel>
          </Collapse>
      </div>
    </template>

    <!-- 添加供应商弹窗 -->
    <Dialog v-model:visible="addProviderDialog" :header="t('minimax.config.addProvider')" width="520px" :confirm-btn="{ content: t('common.add'), theme: 'primary' }" @confirm="handleAddProvider">
      <div class="minimax-edit-form">
        <div class="minimax-form-item">
          <label>Provider ID <span class="minimax-form-required">*</span></label>
          <Input v-model="addProviderForm.id" :placeholder="t('minimax.config.providerIdPlaceholder')" />
          <div class="minimax-form-hint">{{ t("minimax.config.providerIdHint") }}</div>
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.displayName") }}</label>
          <Input v-model="addProviderForm.name" :placeholder="t('minimax.config.displayNamePlaceholder')" />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.apiFormat") }}</label>
          <Select v-model="addProviderForm.api" :options="apiSelectOptions" />
        </div>
        <div class="minimax-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" placeholder="https://api.deepseek.com/v1" />
        </div>
        <div class="minimax-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" :placeholder="t('minimax.config.apiKeyPlaceholder')" />
        </div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗 -->
    <Dialog v-model:visible="editDialog" :header="t('minimax.config.editTitle')" width="520px" :confirm-btn="{ content: t('common.save'), theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="minimax-edit-form">
        <div class="minimax-form-item">
          <label>Provider ID <span class="minimax-form-required">*</span></label>
          <Input v-model="editForm.id" />
          <div class="minimax-form-hint">{{ t("minimax.config.editIdHint") }}</div>
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.displayName") }}</label>
          <Input v-model="editForm.name" />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.apiFormat") }}</label>
          <Select v-model="editForm.api" :options="apiSelectOptions" />
        </div>
        <div class="minimax-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" />
        </div>
        <div class="minimax-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="originalApiKey ? t('minimax.config.apiKeySavedPlaceholder') : t('minimax.config.apiKeyEmptyPlaceholder')" />
        </div>
      </div>
    </Dialog>

    <!-- 添加模型弹窗 -->
    <Dialog v-model:visible="addModelDialog" :header="t('minimax.config.addModelTitle')" width="560px" :confirm-btn="{ content: t('common.add'), theme: 'primary' }" @confirm="handleAddModel">
      <div class="minimax-edit-form">
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.modelIdLabel") }} <span class="minimax-form-required">*</span></label>
          <!-- 只绑 @change：TDesign 的 @input 未声明为组件事件，$event 是原生 InputEvent（不是输入值） -->
          <AutoComplete
            :value="addModelForm.model"
            :options="modelOptions"
            :loading="fetchingModels"
            filterable
            clearable
            placeholder="deepseek-chat"
            @change="addModelForm.model = $event"
          />
          <div v-if="fetchingModels" class="minimax-form-hint">{{ t("minimax.config.fetchingModels") }}</div>
          <div v-else-if="fetchModelError" class="minimax-form-hint minimax-fetch-error">
            {{ t("model.fetchFailed", { message: fetchModelError }) }}
            <span class="minimax-fetch-retry" @click="handleFetchModels">{{ t("common.retry") }}</span>
          </div>
          <div v-else class="minimax-form-hint">{{ t("minimax.config.fetchHint") }}</div>
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.displayName") }}</label>
          <Input v-model="addModelForm.name" :placeholder="t('minimax.config.modelDisplayNamePlaceholder')" />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.contextLabel") }}</label>
          <InputNumber v-model="addModelForm.contextWindow" :min="0" :step="1000" :placeholder="t('minimax.config.contextPlaceholder')" />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.outputLabel") }}</label>
          <InputNumber v-model="addModelForm.outputWindow" :min="0" :step="1024" :placeholder="t('minimax.config.outputPlaceholder')" />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.effortLabel") }}</label>
          <Select v-model="addModelForm.effortOptions" multiple :options="effortOptions" :placeholder="t('minimax.config.effortPlaceholder')" clearable />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.attachmentsLabel") }}</label>
          <Select v-model="addModelForm.inputTypes" multiple :options="attachmentSelectOptions" :placeholder="t('minimax.config.attachmentsPlaceholder')" clearable />
        </div>
        <div class="minimax-form-hint">{{ t("minimax.config.providerLabel", { name: addModelProvider }) }}</div>
      </div>
    </Dialog>

    <!-- 编辑模型弹窗 -->
    <Dialog v-model:visible="editModelDialog" :header="t('minimax.config.editModelTitle')" width="560px" :confirm-btn="{ content: t('common.save'), theme: 'primary' }" @confirm="handleSaveModel">
      <div class="minimax-edit-form">
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.modelIdLabel") }} <span class="minimax-form-required">*</span></label>
          <Input v-model="editModelForm.model" />
          <div class="minimax-form-hint">{{ t("minimax.config.editIdSyncHint") }}</div>
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.displayName") }}</label>
          <Input v-model="editModelForm.name" :placeholder="t('minimax.config.displayNameEditPlaceholder')" />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.contextLabel") }}</label>
          <InputNumber v-model="editModelForm.contextWindow" :min="0" :step="1000" :placeholder="t('minimax.config.contextEditPlaceholder')" />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.outputLabel") }}</label>
          <InputNumber v-model="editModelForm.outputWindow" :min="0" :step="1024" :placeholder="t('minimax.config.outputEditPlaceholder')" />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.effortLabel") }}</label>
          <Select v-model="editModelForm.effortOptions" multiple :options="effortOptions" :placeholder="t('minimax.config.effortEditPlaceholder')" clearable />
        </div>
        <div class="minimax-form-item">
          <label>{{ t("minimax.config.attachmentsLabel") }}</label>
          <Select v-model="editModelForm.inputTypes" multiple :options="attachmentSelectOptions" :placeholder="t('minimax.config.attachmentsEditPlaceholder')" clearable />
        </div>
      </div>
    </Dialog>
  </div>
</template>
