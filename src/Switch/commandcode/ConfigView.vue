<script setup>
// Command Code 模型配置页：~/.commandcode/providers.json + settings.json + auth.json
// - 供应商：providers.json 的 provider.<id>（api 三协议 / baseURL / headers / disabled）
// - 模型：供应商条目的 models 字典（contextWindow / maxOutput / reasoningEfforts / cost / options）
// - 默认模型：settings.json 的 modelProvider + model（全限定名 <providerId>/<modelId>）
// - API Key：**不在 providers.json 里**（那里只接受 $ENV / {env:} / !cmd 引用语法，明文会被拒绝），
//   而是写进 auth.json 的 <providerId>.apiKey（与 /connect 同源）；页面只展示是否已保存 + 掩码。
// 风格：供应商手风琴 + 模型标签（同 Hermes / ZCode），模型在供应商弹窗内编辑。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Dialog, Input, InputNumber, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link, Checkbox, CheckboxGroup,
  Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import "./styles/ConfigView.css";

const { t } = useI18n();

// 与服务层 CC_APIS 一致；顺序即下拉顺序，默认第一项（配置文件省略该字段时的值）
const API_OPTIONS = [
  { value: "openai-completions", labelKey: "commandcode.config.api.openaiCompletions" },
  { value: "openai-responses", labelKey: "commandcode.config.api.openaiResponses" },
  { value: "anthropic-messages", labelKey: "commandcode.config.api.anthropicMessages" },
];
const apiSelectOptions = computed(() =>
  API_OPTIONS.map((o) => ({ label: t(o.labelKey), value: o.value }))
);

// 与服务层 CC_EFFORTS 一致
const EFFORT_OPTIONS = [
  { value: "low", labelKey: "commandcode.config.effort.low" },
  { value: "medium", labelKey: "commandcode.config.effort.medium" },
  { value: "high", labelKey: "commandcode.config.effort.high" },
  { value: "xhigh", labelKey: "commandcode.config.effort.xhigh" },
  { value: "max", labelKey: "commandcode.config.effort.max" },
];
const effortOptions = computed(() => EFFORT_OPTIONS.map((o) => ({ label: t(o.labelKey), value: o.value })));

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const expandedList = ref([]);

const defaultKey = ref(null); // { provider, modelId }
const isDefaultModel = (p, m) =>
  !!defaultKey.value &&
  defaultKey.value.provider === p.id &&
  defaultKey.value.modelId === m.id;

const formatNumber = (n) => {
  if (!n) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

const headersToFields = (headers) =>
  Object.entries(headers || {}).map(([key, value]) => ({ key, value: String(value ?? "") }));
const fieldsToHeaders = (fields) => {
  const out = {};
  for (const f of fields || []) {
    const k = String(f?.key || "").trim();
    if (k) out[k] = f.value == null ? "" : String(f.value);
  }
  return out;
};

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    providers.value = window.services.getCommandCodeProviderList() || [];
    defaultKey.value = window.services.getCommandCodeDefaultModel() || null;
  } catch (e) {
    console.error("加载 Command Code 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
};

const openConfigFile = () => {
  try { window.services.openCommandCodeConfigFile(); } catch { /* ignore */ }
};

// ==================== 供应商弹窗 ====================

const emptyModelRow = () => ({
  id: "", name: "", contextWindow: null, maxOutput: null,
  reasoning: null, reasoningEfforts: [], cost: {}, options: [], api: "", baseURL: "", _extra: {},
});

const emptyForm = () => ({
  id: "", name: "", api: "openai-completions", baseUrl: "",
  apiKey: "", headers: [], models: [], disabled: false,
});

const addDialog = ref(false);
const addForm = ref(emptyForm());
const editDialog = ref(false);
const editingId = ref("");
const editForm = ref(emptyForm());
// 编辑弹窗已有 key 的掩码（用于提示「已保存」），以及是否要清除
const originalHasKey = ref(false);
const clearApiKeyFlag = ref(false);

const addModelRow = (form) => form.models.push(emptyModelRow());
const removeModelRow = (form, idx) => form.models.splice(idx, 1);

const optionsToFields = (options) =>
  Object.entries(options || {}).map(([key, value]) => ({ key, value: String(value ?? "") }));
const fieldsToOptions = (fields) => {
  const out = {};
  for (const f of fields || []) {
    const k = String(f?.key || "").trim();
    if (!k) continue;
    const raw = f.value == null ? "" : String(f.value);
    // 数字看起来像数字就存数字，布尔同理：options 是透传给上游的请求体字段
    if (raw === "true" || raw === "false") out[k] = raw === "true";
    else if (raw !== "" && !Number.isNaN(Number(raw))) out[k] = Number(raw);
    else out[k] = raw;
  }
  return out;
};

const costToForm = (cost) => ({
  input: cost?.input ?? null,
  output: cost?.output ?? null,
  cacheRead: cost?.cacheRead ?? null,
  cacheWrite: cost?.cacheWrite ?? null,
});
const formToCost = (cost) => {
  const out = {};
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
    const n = Number(cost?.[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
};

const modelFromEntry = (m) => ({
  id: m.id,
  name: m.name || "",
  contextWindow: m.contextWindow || null,
  maxOutput: m.maxOutput || null,
  reasoning: m.reasoning === true ? true : m.reasoning === false ? false : null,
  reasoningEfforts: Array.isArray(m.reasoningEfforts) ? [...m.reasoningEfforts] : [],
  cost: costToForm(m.cost),
  options: optionsToFields(m.options),
  api: m.api || "",
  baseURL: m.baseURL || "",
  _extra: m._extra || {},
});

const modelToPayload = (m) => ({
  id: m.id,
  name: m.name,
  contextWindow: Number(m.contextWindow) || 0,
  maxOutput: Number(m.maxOutput) || 0,
  reasoning: m.reasoning,
  reasoningEfforts: m.reasoningEfforts || [],
  cost: formToCost(m.cost),
  options: fieldsToOptions(m.options),
  api: m.api || "",
  baseURL: m.baseURL || "",
  _extra: m._extra || {},
});

const openAddDialog = () => {
  addForm.value = emptyForm();
  addDialog.value = true;
};

const handleAddProvider = () => {
  const id = addForm.value.id.trim();
  const name = addForm.value.name.trim() || id;
  if (!id) { MessagePlugin.warning(t("commandcode.provider.idRequired")); return; }
  try {
    window.services.addCommandCodeProvider({
      id,
      name,
      api: addForm.value.api,
      baseUrl: addForm.value.baseUrl.trim(),
      apiKey: addForm.value.apiKey.trim(),
      headers: fieldsToHeaders(addForm.value.headers),
    });
    // 供应商弹窗里排的模型逐条追加（add 接口只建供应商，模型走 addModel）
    for (const m of addForm.value.models) {
      if (!String(m.id || "").trim()) continue;
      window.services.addCommandCodeModel(id, modelToPayload(m));
    }
    MessagePlugin.success(t("commandcode.provider.added", { name }));
    if (addForm.value.apiKey.trim()) MessagePlugin.success(t("commandcode.config.apiKeySaved"));
    addDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("commandcode.provider.addFailed", { message: e.message }));
  }
};

const handleEdit = (provider) => {
  editingId.value = provider.id;
  editForm.value = {
    id: provider.id,
    name: provider.name || "",
    api: provider.api || "openai-completions",
    baseUrl: provider.baseUrl || "",
    apiKey: "",
    headers: headersToFields(provider.headers),
    models: (provider.models || []).map(modelFromEntry),
    disabled: !!provider.disabled,
  };
  originalHasKey.value = !!provider.hasStoredKey;
  clearApiKeyFlag.value = false;
  editDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    const payload = {
      name: editForm.value.name.trim(),
      api: editForm.value.api,
      baseUrl: editForm.value.baseUrl.trim(),
      headers: fieldsToHeaders(editForm.value.headers),
      disabled: editForm.value.disabled,
    };
    // key：勾了清除 → 删；填了新值 → 覆盖；否则不动
    if (clearApiKeyFlag.value) payload.clearApiKey = true;
    else if (editForm.value.apiKey.trim()) payload.apiKey = editForm.value.apiKey.trim();
    window.services.updateCommandCodeProvider(editingId.value, payload);

    // 模型增删改：以弹窗里的列表为准
    const prevModels = providers.value.find((p) => p.id === editingId.value)?.models || [];
    const prevIds = new Set(prevModels.map((m) => m.id));
    const nextIds = new Set(editForm.value.models.map((m) => String(m.id || "").trim()).filter(Boolean));
    for (const id of prevIds) {
      if (!nextIds.has(id)) window.services.deleteCommandCodeModel(editingId.value, id);
    }
    for (const m of editForm.value.models) {
      const mid = String(m.id || "").trim();
      if (!mid) continue;
      if (prevIds.has(mid)) window.services.updateCommandCodeModel(editingId.value, mid, modelToPayload(m));
      else window.services.addCommandCodeModel(editingId.value, modelToPayload(m));
    }

    MessagePlugin.success(t("commandcode.provider.updated"));
    if (payload.apiKey) MessagePlugin.success(t("commandcode.config.apiKeySaved"));
    if (payload.clearApiKey) MessagePlugin.success(t("commandcode.config.apiKeyCleared"));
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("commandcode.provider.saveFailed", { message: e.message }));
  }
};

const handleDeleteProvider = (provider) => {
  try {
    window.services.deleteCommandCodeProvider(provider.id);
    MessagePlugin.success(t("commandcode.provider.deleted", { name: provider.name }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("commandcode.provider.deleteFailed", { message: e.message }));
  }
};

// ==================== 默认模型 ====================

const setDefaultModel = (p, m) => {
  try {
    window.services.setCommandCodeDefaultModel(p.id, m.id);
    MessagePlugin.success(t("commandcode.model.defaultSet", { model: m.id }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("commandcode.model.saveFailed", { message: e.message }));
  }
};

onMounted(refresh);
</script>

<template>
  <div class="commandcode-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="commandcode-toolbar">
      <div class="commandcode-toolbar-left">
        <span class="commandcode-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openConfigFile">~/.commandcode/providers.json</Link>
          <span class="commandcode-toolbar-sub">{{ t("commandcode.config.toolbarSubtitle") }}</span>
        </span>
      </div>
      <div class="commandcode-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddDialog">
          <template #icon><AddIcon /></template> {{ t("commandcode.config.addProvider") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="commandcode-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0" class="commandcode-config-empty">
        <Empty :description="t('commandcode.config.emptyProviders')" />
      </div>

      <div v-else class="commandcode-provider-list">
        <Collapse v-model="expandedList" class="commandcode-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.id" :value="p.id">
            <template #header>
              <div class="commandcode-provider-header-left">
                <span class="commandcode-provider-name">{{ p.name }}</span>
                <Tag size="small" variant="outline">{{ p.api }}</Tag>
                <Tag v-if="p.disabled" size="small" theme="default" variant="light">{{ t("common.disabled") }}</Tag>
                <Tag
                  size="small"
                  :theme="p.hasStoredKey ? 'success' : 'default'"
                  variant="light"
                >{{ p.hasStoredKey ? t("commandcode.config.apiKeySavedTag") : t("commandcode.config.apiKeyMissingTag") }}</Tag>
                <Tag v-if="defaultKey && defaultKey.provider === p.id" size="small" theme="warning" variant="light">
                  {{ t("commandcode.config.defaultTag") }}
                </Tag>
                <span class="commandcode-model-count">{{ t("commandcode.config.modelCount", { count: p.models.length }) }}</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="commandcode-provider-header-right" @click.stop>
                <Button size="small" theme="default" variant="text" @click="handleEdit(p)">
                  <template #icon><EditIcon /></template> {{ t("common.edit") }}
                </Button>
                <Popconfirm
                  :content="t('commandcode.config.deleteProviderConfirm', { name: p.name })"
                  theme="danger"
                  @confirm="handleDeleteProvider(p)"
                >
                  <Button size="small" theme="danger" variant="text">
                    <template #icon><DeleteIcon /></template>
                  </Button>
                </Popconfirm>
              </div>
            </template>

            <!-- 展开内容：详情 + 模型列表 -->
            <template #content>
              <div class="commandcode-provider-body">
                <div class="commandcode-provider-details">
                  <div class="commandcode-detail-item">
                    <span class="commandcode-detail-label">Provider ID</span>
                    <span class="commandcode-detail-value mono">{{ p.id }}</span>
                  </div>
                  <div class="commandcode-detail-item">
                    <span class="commandcode-detail-label">Base URL</span>
                    <span class="commandcode-detail-value">{{ p.baseUrl || "—" }}</span>
                  </div>
                  <div class="commandcode-detail-item">
                    <span class="commandcode-detail-label">API Key</span>
                    <span class="commandcode-detail-value mono">{{ p.keyMasked || "—" }}</span>
                  </div>
                </div>

                <div class="commandcode-models-section">
                  <div class="commandcode-models-title">
                    <span>{{ t("commandcode.config.modelsTitle") }}</span>
                  </div>
                  <div v-if="p.models.length === 0" class="commandcode-models-empty">
                    {{ t("commandcode.config.modelsEmpty") }}
                  </div>
                  <div class="commandcode-model-tags">
                    <span v-for="m in p.models" :key="m.id" class="commandcode-model-tag">
                      <span class="commandcode-model-tag-name">{{ m.name || m.id }}</span>
                      <span v-if="m.contextWindow" class="commandcode-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                      <Tag v-if="isDefaultModel(p, m)" size="small" theme="success" variant="light">{{ t("common.default") }}</Tag>
                      <Tooltip :content="t('commandcode.config.setDefaultTooltip')" placement="top">
                        <span class="commandcode-model-tag-star" @click="setDefaultModel(p, m)"><StarIcon size="12px" /></span>
                      </Tooltip>
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
    <Dialog
      v-model:visible="addDialog"
      :header="t('commandcode.config.addProvider')"
      width="680px"
      :confirm-btn="{ content: t('common.add'), theme: 'primary' }"
      @confirm="handleAddProvider"
    >
      <div class="commandcode-edit-form">
        <div class="commandcode-form-item">
          <label>Provider ID <span class="commandcode-form-required">*</span></label>
          <Input v-model="addForm.id" placeholder="acme" />
          <div class="commandcode-form-hint">{{ t("commandcode.config.providerIdHint") }}</div>
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.providerNameLabel") }}</label>
          <Input v-model="addForm.name" :placeholder="t('common.optional')" />
          <div class="commandcode-form-hint">{{ t("commandcode.config.providerNameHint") }}</div>
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.apiLabel") }}</label>
          <Select v-model="addForm.api" :options="apiSelectOptions" />
          <div class="commandcode-form-hint">{{ t("commandcode.config.apiHint") }}</div>
        </div>
        <div class="commandcode-form-item">
          <label>Base URL</label>
          <Input v-model="addForm.baseUrl" placeholder="https://api.example.com/v1" />
          <div class="commandcode-form-hint">{{ t("commandcode.config.baseUrlHint") }}</div>
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.apiKeyLabel") }}</label>
          <ApiKeyInput v-model="addForm.apiKey" :placeholder="t('commandcode.config.apiKeyPlaceholder')" />
          <div class="commandcode-form-hint">{{ t("commandcode.config.apiKeyHint") }}</div>
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.headersLabel") }}</label>
          <DynamicKvEditor v-model="addForm.headers" :show-add="true" />
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.modelsTitle") }}</label>
          <div v-for="(m, idx) in addForm.models" :key="idx" class="commandcode-model-row">
            <Input v-model="m.id" :placeholder="t('commandcode.config.modelIdLabel')" />
            <span class="commandcode-model-row-del" @click="removeModelRow(addForm, idx)"><DeleteIcon size="14px" /></span>
          </div>
          <Button size="small" variant="outline" @click="addModelRow(addForm)">
            <template #icon><AddIcon /></template> {{ t("commandcode.config.addModel") }}
          </Button>
          <div class="commandcode-form-hint">{{ t("commandcode.config.modelIdHint") }}</div>
        </div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗（ID 固定；模型内嵌编辑，未知字段自动保留） -->
    <Dialog
      v-model:visible="editDialog"
      :header="t('commandcode.config.editProvider')"
      width="760px"
      :confirm-btn="{ content: t('common.save'), theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="commandcode-edit-form">
        <div class="commandcode-form-item">
          <label>Provider ID</label>
          <Input :value="editForm.id" disabled />
          <div class="commandcode-form-hint">{{ t("commandcode.config.providerIdHint") }}</div>
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.providerNameLabel") }}</label>
          <Input v-model="editForm.name" />
          <div class="commandcode-form-hint">{{ t("commandcode.config.editProviderNameHint") }}</div>
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.apiLabel") }}</label>
          <Select v-model="editForm.api" :options="apiSelectOptions" />
          <div class="commandcode-form-hint">{{ t("commandcode.config.apiHint") }}</div>
        </div>
        <div class="commandcode-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" />
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.apiKeyLabel") }}</label>
          <ApiKeyInput
            v-model="editForm.apiKey"
            :placeholder="originalHasKey ? t('commandcode.config.apiKeySavedPlaceholder') : t('commandcode.config.apiKeyPlaceholder')"
          />
          <div class="commandcode-form-hint">{{ t("commandcode.config.apiKeyHint") }}</div>
          <Checkbox v-if="originalHasKey" v-model="clearApiKeyFlag" class="commandcode-clear-key">
            {{ t("commandcode.config.apiKeyClearHint") }}
          </Checkbox>
        </div>
        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.headersLabel") }}</label>
          <DynamicKvEditor v-model="editForm.headers" :show-add="true" />
        </div>

        <div class="commandcode-form-item">
          <label>{{ t("commandcode.config.modelsTitle") }}</label>
          <div v-for="(m, idx) in editForm.models" :key="idx" class="commandcode-model-block">
            <div class="commandcode-model-block-header">
              <span class="commandcode-model-block-title">{{ m.id || t("commandcode.config.addModelTitle") }}</span>
              <span class="commandcode-model-row-del" @click="removeModelRow(editForm, idx)"><DeleteIcon size="14px" /></span>
            </div>
            <div class="commandcode-form-item">
              <label>{{ t("commandcode.config.modelIdLabel") }}</label>
              <Input v-model="m.id" :placeholder="t('commandcode.config.modelIdLabel')" />
              <div class="commandcode-form-hint">{{ t("commandcode.config.modelIdHint") }}</div>
            </div>
            <div class="commandcode-form-item">
              <label>{{ t("common.name") }}</label>
              <Input v-model="m.name" :placeholder="t('commandcode.config.namePlaceholder')" />
            </div>
            <ModelLimitsFields
              v-model:context="m.contextWindow"
              v-model:output="m.maxOutput"
              item-class="commandcode-form-item"
            />
            <div class="commandcode-form-item">
              <label>{{ t("commandcode.config.reasoningEffortsLabel") }}</label>
              <CheckboxGroup v-model="m.reasoningEfforts" :options="effortOptions" />
              <div class="commandcode-form-hint">{{ t("commandcode.config.reasoningEffortsHint") }}</div>
            </div>
            <div class="commandcode-form-item">
              <label>{{ t("commandcode.config.costLabel") }}</label>
              <div class="commandcode-cost-grid">
                <InputNumber v-model="m.cost.input" :min="0" :placeholder="t('commandcode.config.costInput')" />
                <InputNumber v-model="m.cost.output" :min="0" :placeholder="t('commandcode.config.costOutput')" />
                <InputNumber v-model="m.cost.cacheRead" :min="0" :placeholder="t('commandcode.config.costCacheRead')" />
                <InputNumber v-model="m.cost.cacheWrite" :min="0" :placeholder="t('commandcode.config.costCacheWrite')" />
              </div>
            </div>
            <div class="commandcode-form-item">
              <label>{{ t("commandcode.config.optionsLabel") }}</label>
              <DynamicKvEditor v-model="m.options" :show-add="true" />
              <div class="commandcode-form-hint">{{ t("commandcode.config.optionsHint") }}</div>
            </div>
            <div class="commandcode-form-item">
              <label>{{ t("commandcode.config.apiLabel") }}</label>
              <Select
                v-model="m.api"
                :options="[{ label: t('commandcode.config.inheritApi'), value: '' }, ...apiSelectOptions]"
              />
              <div class="commandcode-form-hint">{{ t("commandcode.config.apiDefaultHint") }}</div>
            </div>
          </div>
          <Button size="small" variant="outline" @click="addModelRow(editForm)">
            <template #icon><AddIcon /></template> {{ t("commandcode.config.addModel") }}
          </Button>
        </div>

        <div class="commandcode-form-item">
          <Checkbox v-model="editForm.disabled">{{ t("common.disabled") }}</Checkbox>
          <div class="commandcode-form-hint">{{ t("commandcode.config.modelsDisabledHint") }}</div>
        </div>
      </div>
    </Dialog>
  </div>
</template>
