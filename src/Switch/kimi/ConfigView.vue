<script setup>
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

// services 未加载时的兜底枚举（渲染早于 preload 挂载时不报错）；与服务层 OPENAI_FAMILY 一致
const OPENAI_FAMILY = ["openai", "openai_responses"];
// capabilities / support_efforts 合法枚举，与服务层 KIMI_CAPABILITIES / KIMI_EFFORTS 保持一致
const CAPABILITY_VALUES = ["thinking", "always_thinking", "image_in", "video_in", "audio_in", "tool_use"];
const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];
// UI 管理的模型扩展字段（camelCase），与服务层 MODEL_EXTRA_KEYS 一致；payload 按此遍历
const MODEL_EXTRA_KEYS = ["displayName", "defaultEffort", "offEffort", "reasoningKey",
  "maxInputSize", "maxOutputSize", "adaptiveThinking", "capabilities", "supportEfforts"];

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const models = ref([]);
const defaultModel = ref("");
const expandedList = ref([]);

// 官方扩展字段的枚举选项（docs configuration/config-files.html models 节）
const capabilityOptions = CAPABILITY_VALUES.map(v => ({ label: v, value: v }));
const effortOptions = EFFORT_VALUES.map(v => ({ label: v, value: v }));
const triStateOptions = [
  { labelKey: "kimi.config.triState.auto", value: "" },
  { labelKey: "kimi.config.triState.on", value: "true" },
  { labelKey: "kimi.config.triState.off", value: "false" },
];
const triStateSelectOptions = computed(() =>
  triStateOptions.map((o) => ({ label: t(o.labelKey), value: o.value }))
);
// effort 下拉：含"未设置"空项与 off_effort 专用的 none 编码
const effortSelectOptions = computed(() => [
  { label: t("kimi.config.effortNotSet"), value: "" },
  ...EFFORT_VALUES.map(v => ({ label: v, value: v })),
]);
const offEffortSelectOptions = computed(() => [
  ...effortSelectOptions.value.slice(0, -1),
  { label: "none", value: "none" },
]);

// 官方供应商协议类型（docs configuration/providers.html）
const typeOptions = [
  { labelKey: "kimi.config.type.kimi", value: "kimi" },
  { labelKey: "kimi.config.type.anthropic", value: "anthropic" },
  { labelKey: "kimi.config.type.openai", value: "openai" },
  { labelKey: "kimi.config.type.openaiResponses", value: "openai_responses" },
  { labelKey: "kimi.config.type.googleGenai", value: "google-genai" },
  { labelKey: "kimi.config.type.vertexai", value: "vertexai" },
];
const typeSelectOptions = computed(() =>
  typeOptions.map((o) => ({ label: t(o.labelKey), value: o.value }))
);

// 每个供应商下的模型别名列表（models 表以 provider 字段外键关联）
const modelsByProvider = computed(() => {
  const map = new Map();
  for (const m of models.value) {
    if (!map.has(m.provider)) map.set(m.provider, []);
    map.get(m.provider).push(m);
  }
  return map;
});
const providerModels = (name) => modelsByProvider.value.get(name) || [];

// ==================== 弹窗状态 ====================

const addProviderDialog = ref(false);
const addProviderForm = ref({ name: "", type: "openai", baseUrl: "", apiKey: "" });
const editDialog = ref(false);
const editingProvider = ref("");
const editForm = ref({ name: "", type: "openai", baseUrl: "", apiKey: "" });
// 编辑弹窗初始加载的 key，保存时判断是否被用户改动/清空
const originalApiKey = ref("");

const addModelDialog = ref(false);
const addModelProvider = ref("");
// 基础字段 + 官方扩展字段（空串/0/[] = 不写入）+ advancedOpen（UI-only，不入 payload）
const emptyModelForm = () => ({
  alias: "", model: "", maxContextSize: 131072,
  displayName: "", maxInputSize: 0, maxOutputSize: 0,
  capabilities: [], supportEfforts: [], defaultEffort: "", offEffort: "",
  reasoningKey: "", adaptiveThinking: "",
  advancedOpen: false,
});
const addModelForm = ref(emptyModelForm());
const editModelDialog = ref(false);
const editingModel = ref("");
const editModelForm = ref(emptyModelForm());

// 当前弹窗所属供应商的协议类型（控制专属字段显隐）
const providerTypeOf = (name) => (providers.value.find(p => p.name === name)?.type) || "";
const addProviderType = computed(() => providerTypeOf(addModelProvider.value));
const editProviderType = computed(() => {
  const m = models.value.find(x => x.alias === editingModel.value);
  return m ? providerTypeOf(m.provider) : "";
});

// 模型候选（复用通用供应商 /models 拉取，失败静默）
const fetchedModels = ref([]);
const fetchingModels = ref(false);
const fetchModelError = ref("");

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    providers.value = window.services.getKimiProviderList() || [];
    models.value = window.services.getKimiModelList() || [];
    defaultModel.value = window.services.getKimiDefaultModel() || "";
  } catch (e) {
    console.error("加载 Kimi Code 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
};

// 别名所属供应商是否含默认（default_model 存的就是 models 表的 key）
const isDefaultProvider = (p) => {
  const dm = defaultModel.value;
  if (!dm) return false;
  const entry = models.value.find((m) => m.alias === dm);
  return !!entry && entry.provider === p.name;
};

const formatNumber = (n) => {
  if (!n) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

const openKimiDir = () => {
  try { window.services.openKimiDir(); } catch { /* ignore */ }
};

// ==================== 供应商 CRUD ====================

const openAddProviderDialog = () => {
  addProviderForm.value = { name: "", type: "openai", baseUrl: "", apiKey: "" };
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning(t("kimi.provider.nameRequired")); return; }
    window.services.addKimiProvider({
      name,
      type: addProviderForm.value.type,
      baseUrl: addProviderForm.value.baseUrl.trim(),
      apiKey: addProviderForm.value.apiKey,
    });
    MessagePlugin.success(t("kimi.provider.added", { name }));
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("kimi.provider.addFailed", { message: e.message }));
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.name;
  editForm.value = {
    name: provider.name,
    type: provider.type || "openai",
    baseUrl: provider.baseUrl || "",
    apiKey: provider.apiKey || "",
  };
  originalApiKey.value = provider.apiKey || "";
  editDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    const newName = String(editForm.value.name || "").trim();
    if (!newName) { MessagePlugin.warning(t("kimi.provider.nameRequired")); return; }
    const payload = {
      name: newName,
      type: editForm.value.type,
      baseUrl: editForm.value.baseUrl.trim(),
    };
    // key：清空 → 删除；改动 → 覆盖；未动 → 不回传
    if (!editForm.value.apiKey && originalApiKey.value) payload.clearApiKey = true;
    else if (editForm.value.apiKey !== originalApiKey.value) payload.apiKey = editForm.value.apiKey;
    window.services.updateKimiProvider(editingProvider.value, payload);
    MessagePlugin.success(
      newName !== editingProvider.value
        ? t("kimi.provider.updatedRenamed", { name: newName })
        : t("kimi.provider.updated")
    );
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("kimi.provider.saveFailed", { message: e.message }));
  }
};

const handleDeleteProvider = (providerName) => {
  try {
    window.services.deleteKimiProvider(providerName);
    MessagePlugin.success(t("kimi.provider.deleted", { name: providerName }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("kimi.provider.deleteFailed", { message: e.message }));
  }
};

// ==================== 默认模型 ====================

// 模型别名上点星标 → 写入顶层 default_model
const setDefaultModel = (alias) => {
  try {
    window.services.setKimiDefaultModel(alias);
    MessagePlugin.success(t("kimi.model.defaultSet", { alias }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("kimi.model.saveFailed", { message: e.message }));
  }
};

// ==================== 模型 CRUD ====================

const handleFetchModels = async () => {
  const p = providers.value.find((x) => x.name === addModelProvider.value);
  if (!p || !p.baseUrl) {
    fetchModelError.value = t("common.noBaseUrl");
    return;
  }
  fetchingModels.value = true;
  fetchModelError.value = "";
  try {
    const list = await window.services.fetchProviderModels(p.baseUrl, p.apiKey);
    fetchedModels.value = list || [];
    if (!fetchedModels.value.length) fetchModelError.value = t("kimi.config.noModels");
  } catch (e) {
    fetchModelError.value = e.message || t("common.fetchFailed");
  } finally {
    fetchingModels.value = false;
  }
};

const modelOptions = computed(() =>
  fetchedModels.value.map((m) => ({ label: m.name || m.id, value: m.id }))
);

// 别名跟随输入：用户未手改过别名时，按官方惯例 <供应商>/<模型ID> 自动填
const aliasTouched = ref(false);
const onModelIdInput = (v) => {
  addModelForm.value.model = v;
  if (!aliasTouched.value) {
    addModelForm.value.alias = v ? `${addModelProvider.value}/${v}` : "";
  }
};

const openAddModelDialog = (providerName) => {
  addModelProvider.value = providerName;
  addModelForm.value = emptyModelForm();
  aliasTouched.value = false;
  fetchedModels.value = [];
  fetchModelError.value = "";
  addModelDialog.value = true;
  handleFetchModels();
};

// 表单 → services 入参。扩展字段空值形态：字符串 ''、数字 0、数组 []、三态布尔 ""/"true"/"false"。
// 新增弹窗（initial=null）：只传有值的；
// 编辑弹窗：值有变化才传（清除时传空值形态，adaptiveThinking 从 true/false 回"自动"→ null）。
const isEmptyVal = (v) => v === "" || v === null || v === undefined || v === 0
  || (Array.isArray(v) && !v.length);
const normVal = (v) => Array.isArray(v) ? [...v].sort().join(",") : String(v ?? "");
const buildModelPayload = (form, initial) => {
  const payload = {
    alias: form.alias.trim(),
    model: form.model.trim(),
    maxContextSize: Number(form.maxContextSize) || 0,
  };
  for (const k of MODEL_EXTRA_KEYS) {
    // adaptiveThinking 表单是三态字符串，转 null/true/false 再比较
    const cur = k === "adaptiveThinking"
      ? (form.adaptiveThinking === "" ? null : form.adaptiveThinking === "true")
      : form[k];
    if (!initial) {
      if (!isEmptyVal(cur)) payload[k] = cur;
      continue;
    }
    const had = initial[k];
    const changed = normVal(cur) !== normVal(had);
    // 两边都算"未设置"（null/''/0/[] 互等）视为无变化；false 是显式值，不与 null 互等
    if (changed && !(cur === null && isEmptyVal(had))) payload[k] = cur;
  }
  return payload;
};

const handleAddModel = () => {
  try {
    const alias = addModelForm.value.alias.trim()
      || (addModelForm.value.model.trim() ? `${addModelProvider.value}/${addModelForm.value.model.trim()}` : "");
    if (!alias) { MessagePlugin.warning(t("kimi.model.idOrAliasRequired")); return; }
    if (!addModelForm.value.model.trim()) { MessagePlugin.warning(t("kimi.model.idRequired")); return; }
    window.services.addKimiModel({
      ...buildModelPayload(addModelForm.value, null),
      alias,
      provider: addModelProvider.value,
    });
    MessagePlugin.success(t("kimi.model.added", { alias }));
    addModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("kimi.model.addFailed", { message: e.message }));
  }
};

// 编辑弹窗打开时的原始条目快照，用于判断扩展字段是否被改动/清除
const editModelInitial = ref(null);

const openEditModelDialog = (m) => {
  editingModel.value = m.alias;
  editModelForm.value = {
    ...emptyModelForm(),
    alias: m.alias,
    model: m.model,
    maxContextSize: m.maxContextSize || 0,
    displayName: m.displayName || "",
    maxInputSize: m.maxInputSize || 0,
    maxOutputSize: m.maxOutputSize || 0,
    capabilities: [...(m.capabilities || [])],
    supportEfforts: [...(m.supportEfforts || [])],
    defaultEffort: m.defaultEffort || "",
    offEffort: m.offEffort || "",
    reasoningKey: m.reasoningKey || "",
    adaptiveThinking: m.adaptiveThinking === null ? "" : String(m.adaptiveThinking),
    advancedOpen: !!(m.displayName || m.maxInputSize || m.maxOutputSize || m.capabilities?.length || m.supportEfforts?.length
      || m.defaultEffort || m.offEffort || m.reasoningKey || m.adaptiveThinking !== null),
  };
  editModelInitial.value = m;
  editModelDialog.value = true;
};

const handleSaveModel = () => {
  try {
    window.services.updateKimiModel(editingModel.value, buildModelPayload(editModelForm.value, editModelInitial.value));
    MessagePlugin.success(t("kimi.model.updated"));
    editModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("kimi.model.saveFailed", { message: e.message }));
  }
};

const handleDeleteModel = (alias) => {
  try {
    window.services.deleteKimiModel(alias);
    MessagePlugin.success(t("kimi.model.deleted", { alias }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("kimi.model.deleteFailed", { message: e.message }));
  }
};

onMounted(refresh);
</script>

<template>
  <div class="kimi-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="kimi-toolbar">
      <div class="kimi-toolbar-left">
        <span class="kimi-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openKimiDir">~/.kimi-code/</Link>
          <span class="kimi-toolbar-sub">{{ t("kimi.config.toolbarSubtitle") }}</span>
        </span>
      </div>
      <div class="kimi-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> {{ t("kimi.config.addProvider") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="kimi-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0" class="kimi-config-empty">
        <Empty :description="t('kimi.config.emptyProviders')" />
      </div>

      <div v-else class="kimi-provider-list">
        <Collapse v-model="expandedList" class="kimi-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.name" :value="p.name">
            <template #header>
              <div class="kimi-provider-header-left">
                <span class="kimi-provider-name">{{ p.name }}</span>
                <Tag size="small" variant="outline">{{ p.type }}</Tag>
                <Tag v-if="p.managed" size="small" theme="primary" variant="light">{{ t("kimi.config.loginManaged") }}</Tag>
                <Tag v-if="isDefaultProvider(p)" size="small" theme="warning" variant="light">{{ t("kimi.config.hasDefaultModel") }}</Tag>
                <span class="kimi-model-count">{{ t("kimi.config.modelCount", { count: providerModels(p.name).length }) }}</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="kimi-provider-header-right" @click.stop>
                <template v-if="!p.managed">
                  <Button size="small" theme="default" variant="text" @click="handleEdit(p)">
                    <template #icon><EditIcon /></template> {{ t("common.edit") }}
                  </Button>
                  <Tooltip :content="t('kimi.config.deleteProviderTooltip')">
                    <Popconfirm
                      :content="t('kimi.config.deleteProviderConfirm', { name: p.name })"
                      theme="danger"
                      @confirm="handleDeleteProvider(p.name)"
                    >
                      <Button size="small" theme="danger" variant="text">
                        <template #icon><DeleteIcon /></template>
                      </Button>
                    </Popconfirm>
                  </Tooltip>
                </template>
              </div>
            </template>

            <!-- 展开内容：详情 + 模型别名 -->
            <template #content>
              <div class="kimi-provider-body">
                <div class="kimi-provider-details">
                  <div class="kimi-detail-item">
                    <span class="kimi-detail-label">Base URL</span>
                    <span class="kimi-detail-value">{{ p.baseUrl || t("kimi.config.baseUrlDefault") }}</span>
                  </div>
                  <div class="kimi-detail-item">
                    <span class="kimi-detail-label">API Key</span>
                    <span class="kimi-detail-value mono">{{ p.apiKey ? t("kimi.config.configured") : (p.managed ? t("kimi.config.oauthManaged") : t("kimi.config.unconfigured")) }}</span>
                  </div>
                </div>

                <div class="kimi-models-section">
                  <div class="kimi-models-title">
                    <span>{{ t("kimi.config.modelsTitle") }}</span>
                    <Button v-if="!p.managed" size="small" variant="outline" @click="openAddModelDialog(p.name)">
                      <template #icon><AddIcon /></template> {{ t("common.add") }}
                    </Button>
                  </div>
                  <div v-if="providerModels(p.name).length === 0" class="kimi-models-empty">
                    {{ t("kimi.config.modelsEmpty") }}
                  </div>
                  <div class="kimi-model-tags">
                    <span v-for="m in providerModels(p.name)" :key="m.alias" class="kimi-model-tag">
                      <span class="kimi-model-tag-name">{{ m.alias }}</span>
                      <span v-if="m.displayName" class="kimi-model-tag-sub">{{ m.displayName }}</span>
                      <span v-if="m.model && m.model !== m.alias" class="kimi-model-tag-sub">{{ m.model }}</span>
                      <span v-if="m.maxContextSize" class="kimi-model-tag-sub">{{ formatNumber(m.maxContextSize) }}</span>
                      <Tag v-if="defaultModel === m.alias" size="small" theme="success" variant="light">{{ t("common.default") }}</Tag>
                      <Tooltip v-else-if="!p.managed" :content="t('kimi.config.setDefaultTooltip')" placement="top">
                        <span class="kimi-model-tag-star" @click="setDefaultModel(m.alias)"><StarIcon size="12px" /></span>
                      </Tooltip>
                      <Tooltip v-if="!p.managed" :content="t('kimi.config.editModelTooltip')" placement="top">
                        <span class="kimi-model-tag-edit" @click="openEditModelDialog(m)"><EditIcon size="12px" /></span>
                      </Tooltip>
                      <Popconfirm v-if="!p.managed" :content="t('kimi.config.deleteModelConfirm')" theme="danger" @confirm="handleDeleteModel(m.alias)">
                        <span class="kimi-model-tag-del"><DeleteIcon size="12px" /></span>
                      </Popconfirm>
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
    <Dialog v-model:visible="addProviderDialog" :header="t('kimi.config.addProvider')" width="520px" :confirm-btn="{ content: t('common.add'), theme: 'primary' }" @confirm="handleAddProvider">
      <div class="kimi-edit-form">
        <div class="kimi-form-item">
          <label>{{ t("common.name") }} <span class="kimi-form-required">*</span></label>
          <Input v-model="addProviderForm.name" :placeholder="t('kimi.config.namePlaceholder')" />
        </div>
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.typeLabel") }}</label>
          <Select v-model="addProviderForm.type" :options="typeSelectOptions" />
        </div>
        <div class="kimi-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" :placeholder="t('kimi.config.baseUrlPlaceholder')" />
        </div>
        <div class="kimi-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" :placeholder="t('kimi.config.apiKeyPlaceholder')" />
        </div>
        <div class="kimi-form-hint">{{ t("kimi.config.apiKeyHint") }}</div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗 -->
    <Dialog v-model:visible="editDialog" :header="t('kimi.config.editTitle')" width="520px" :confirm-btn="{ content: t('common.save'), theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="kimi-edit-form">
        <div class="kimi-form-item">
          <label>{{ t("common.name") }} <span class="kimi-form-required">*</span></label>
          <Input v-model="editForm.name" placeholder="deepseek" />
          <div class="kimi-form-hint">{{ t("kimi.config.nameRenameHint") }}</div>
        </div>
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.typeLabel") }}</label>
          <Select v-model="editForm.type" :options="typeSelectOptions" />
        </div>
        <div class="kimi-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" />
        </div>
        <div class="kimi-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="originalApiKey ? t('kimi.config.apiKeySavedPlaceholder') : t('kimi.config.apiKeyEmptyPlaceholder')" />
        </div>
      </div>
    </Dialog>

    <!-- 添加模型弹窗 -->
    <Dialog v-model:visible="addModelDialog" :header="t('kimi.config.addModelTitle')" width="620px" :confirm-btn="{ content: t('common.add'), theme: 'primary' }" @confirm="handleAddModel">
      <div class="kimi-edit-form">
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.modelIdLabel") }} <span class="kimi-form-required">*</span></label>
          <!-- 只绑 @change：TDesign 的 @input 未声明为组件事件，$event 是原生 InputEvent（不是输入值） -->
          <AutoComplete
            :value="addModelForm.model"
            :options="modelOptions"
            :loading="fetchingModels"
            filterable
            clearable
            placeholder="deepseek-chat"
            @change="onModelIdInput"
          />
          <div v-if="fetchingModels" class="kimi-form-hint">{{ t("kimi.config.fetchingModels") }}</div>
          <div v-else-if="fetchModelError" class="kimi-form-hint kimi-fetch-error">
            {{ t("model.fetchFailed", { message: fetchModelError }) }}
            <span class="kimi-fetch-retry" @click="handleFetchModels">{{ t("common.retry") }}</span>
          </div>
          <div v-else class="kimi-form-hint">{{ t("kimi.config.fetchHint") }}</div>
        </div>
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.aliasLabel") }}</label>
          <Input v-model="addModelForm.alias" @change="aliasTouched = true" :placeholder="t('kimi.config.aliasPlaceholder')" />
        </div>
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.maxContextLabel") }}</label>
          <InputNumber v-model="addModelForm.maxContextSize" :min="1" :step="1000" />
        </div>
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.displayNameLabel") }}</label>
          <Input v-model="addModelForm.displayName" :placeholder="t('kimi.config.displayNamePlaceholder')" />
        </div>
        <Collapse v-model="addModelForm.advancedOpen" class="kimi-advanced-collapse">
          <CollapsePanel :header="t('kimi.config.advanced')" value="adv">
            <div class="kimi-edit-form kimi-advanced-grid">
              <div class="kimi-form-item">
                <label>{{ t("kimi.config.maxInputLabel") }}</label>
                <InputNumber v-model="addModelForm.maxInputSize" :min="0" :step="1000" :placeholder="t('kimi.config.zeroNotWrittenPlaceholder')" />
              </div>
              <div v-if="addProviderType === 'anthropic'" class="kimi-form-item">
                <label>{{ t("kimi.config.maxOutputLabel") }}</label>
                <InputNumber v-model="addModelForm.maxOutputSize" :min="0" :step="1024" :placeholder="t('kimi.config.anthropicOnlyPlaceholder')" />
              </div>
              <div v-if="addProviderType === 'anthropic'" class="kimi-form-item">
                <label>Adaptive Thinking</label>
                <Select v-model="addModelForm.adaptiveThinking" :options="triStateSelectOptions" />
              </div>
              <div v-if="OPENAI_FAMILY.includes(addProviderType)" class="kimi-form-item">
                <label>{{ t("kimi.config.reasoningKeyLabel") }}</label>
                <Input v-model="addModelForm.reasoningKey" :placeholder="t('kimi.config.reasoningKeyPlaceholder')" />
              </div>
              <div class="kimi-form-item kimi-form-item-wide">
                <label>{{ t("kimi.config.capabilitiesLabel") }}</label>
                <Select v-model="addModelForm.capabilities" multiple :options="capabilityOptions" :placeholder="t('kimi.config.capabilitiesPlaceholder')" />
              </div>
              <div class="kimi-form-item">
                <label>{{ t("kimi.config.supportEffortsLabel") }}</label>
                <Select v-model="addModelForm.supportEfforts" multiple :options="effortOptions" />
              </div>
              <div class="kimi-form-item">
                <label>{{ t("kimi.config.defaultEffortLabel") }}</label>
                <Select v-model="addModelForm.defaultEffort" clearable :options="effortSelectOptions" />
              </div>
              <div class="kimi-form-item">
                <label>{{ t("kimi.config.offEffortLabel") }}</label>
                <Select v-model="addModelForm.offEffort" clearable :options="offEffortSelectOptions" />
              </div>
            </div>
          </CollapsePanel>
        </Collapse>
        <div class="kimi-form-hint">{{ t("kimi.config.providerLabel", { name: addModelProvider }) }}</div>
      </div>
    </Dialog>

    <!-- 编辑模型弹窗 -->
    <Dialog v-model:visible="editModelDialog" :header="t('kimi.config.editModelTitle')" width="620px" :confirm-btn="{ content: t('common.save'), theme: 'primary' }" @confirm="handleSaveModel">
      <div class="kimi-edit-form">
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.aliasEditLabel") }} <span class="kimi-form-required">*</span></label>
          <Input v-model="editModelForm.alias" />
          <div class="kimi-form-hint">{{ t("kimi.config.aliasEditHint") }}</div>
        </div>
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.modelIdLabel") }} <span class="kimi-form-required">*</span></label>
          <Input v-model="editModelForm.model" />
        </div>
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.maxContextLabel") }}</label>
          <InputNumber v-model="editModelForm.maxContextSize" :min="1" :step="1000" />
        </div>
        <div class="kimi-form-item">
          <label>{{ t("kimi.config.displayNameLabel") }}</label>
          <Input v-model="editModelForm.displayName" :placeholder="t('kimi.config.displayNameEditPlaceholder')" />
        </div>
        <Collapse v-model="editModelForm.advancedOpen" class="kimi-advanced-collapse">
          <CollapsePanel :header="t('kimi.config.advanced')" value="adv">
            <div class="kimi-edit-form kimi-advanced-grid">
              <div class="kimi-form-item">
                <label>{{ t("kimi.config.maxInputLabel") }}</label>
                <InputNumber v-model="editModelForm.maxInputSize" :min="0" :step="1000" :placeholder="t('kimi.config.zeroClearPlaceholder')" />
              </div>
              <div v-if="editProviderType === 'anthropic'" class="kimi-form-item">
                <label>{{ t("kimi.config.maxOutputLabel") }}</label>
                <InputNumber v-model="editModelForm.maxOutputSize" :min="0" :step="1024" :placeholder="t('kimi.config.zeroClearPlaceholder')" />
              </div>
              <div v-if="editProviderType === 'anthropic'" class="kimi-form-item">
                <label>Adaptive Thinking</label>
                <Select v-model="editModelForm.adaptiveThinking" :options="triStateSelectOptions" />
              </div>
              <div v-if="OPENAI_FAMILY.includes(editProviderType)" class="kimi-form-item">
                <label>{{ t("kimi.config.reasoningKeyLabel") }}</label>
                <Input v-model="editModelForm.reasoningKey" :placeholder="t('kimi.config.reasoningKeyEditPlaceholder')" />
              </div>
              <div class="kimi-form-item kimi-form-item-wide">
                <label>{{ t("kimi.config.capabilitiesLabel") }}</label>
                <Select v-model="editModelForm.capabilities" multiple :options="capabilityOptions" :placeholder="t('kimi.config.capabilitiesEditPlaceholder')" />
              </div>
              <div class="kimi-form-item">
                <label>{{ t("kimi.config.supportEffortsLabel") }}</label>
                <Select v-model="editModelForm.supportEfforts" multiple :options="effortOptions" />
              </div>
              <div class="kimi-form-item">
                <label>{{ t("kimi.config.defaultEffortLabel") }}</label>
                <Select v-model="editModelForm.defaultEffort" clearable :options="effortSelectOptions" />
              </div>
              <div class="kimi-form-item">
                <label>{{ t("kimi.config.offEffortLabel") }}</label>
                <Select v-model="editModelForm.offEffort" clearable :options="offEffortSelectOptions" />
              </div>
            </div>
          </CollapsePanel>
        </Collapse>
      </div>
    </Dialog>
  </div>
</template>
