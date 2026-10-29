<script setup>
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Dialog, Input, InputNumber, AutoComplete, Space, CheckboxGroup, Checkbox, Collapse, CollapsePanel, Select, MessagePlugin,
} from "tdesign-vue-next";
import DynamicKvEditor from "./DynamicKvEditor.vue";
import ModelLimitsFields from "./ModelLimitsFields.vue";
import { useAutoFetchModels } from "../composables/useAutoFetchModels";
import {
  MODEL_API_TYPE_OPTIONS,
  MODEL_CAPABILITY_OPTIONS,
  MODEL_EFFORT_OPTIONS,
  MODEL_MODALITY_OPTIONS,
  MODEL_THINKING_LEVEL_OPTIONS,
  MODEL_THINKING_MODE_OPTIONS,
  MODEL_THINKING_TYPE_OPTIONS,
} from "../constants";

// 模型添加/编辑弹窗（二合一）：add 模式带供应商模型自动拉取（AutoComplete 选中自动回填），
// edit 模式允许修改模型 ID（重命名由父级以删旧建新方式落库）。高级配置支持插入各应用特有字段。
// 通用库字段按「跨 Agent 规范字段 + compat/options 透传」组织，各 Agent 的差异由 dispatch 映射。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'add' | 'edit'
  mode: { type: String, default: "add" },
  providerName: { type: String, default: "" },
  // add 模式：用于自动拉取模型列表的 { baseUrl, apiKey } 对象
  provider: { type: Object, default: null },
  // edit 模式：原模型对象
  initial: { type: Object, default: null },
  // 高级配置兼容性字段自动完成提示
  compatKeyOptions: { type: Array, default: () => [] },
});
const emit = defineEmits(["update:visible", "confirm"]);
const { t } = useI18n();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const isAdd = computed(() => props.mode === "add");

const modalityOptions = computed(() =>
  MODEL_MODALITY_OPTIONS.map((o) => ({ ...o, label: t(o.labelKey) }))
);
const capabilityOptions = computed(() =>
  MODEL_CAPABILITY_OPTIONS.map((o) => ({ ...o, label: t(o.labelKey) }))
);
const thinkingTypeOptions = computed(() =>
  MODEL_THINKING_TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.labelKey) }))
);
const apiOptions = computed(() => [
  { label: t("model.followProvider"), value: "" },
  ...MODEL_API_TYPE_OPTIONS,
]);
const adaptiveThinkingOptions = computed(() => [
  { label: t("model.adaptiveThinkingDefault"), value: "" },
  { label: "true", value: "true" },
  { label: "false", value: "false" },
]);
const effortOptions = MODEL_EFFORT_OPTIONS;
const offEffortOptions = computed(() => [{ label: "none", value: "none" }, ...MODEL_EFFORT_OPTIONS]);
const levelOptions = MODEL_THINKING_LEVEL_OPTIONS;
const thinkingModeOptions = MODEL_THINKING_MODE_OPTIONS;

const {
  autoModels, autoModelsLoading, autoModelsError, modelOptions, fetchAutoModels, resetAutoModels, onModelIdSelect,
} = useAutoFetchModels();

const defaultForm = () => ({
  id: "",
  name: "",
  contextWindow: 0,
  maxTokens: 0,
  reasoning: false,
  input: ["text"],
  output: ["text"],
  reasoningEfforts: [],
  defaultEffort: "",
  capabilities: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: [],
  maxInputTokens: 0,
  offEffort: "",
  reasoningKey: "",
  adaptiveThinking: "",
  thinkingMode: "",
  thinkingMinLevel: "",
  thinkingMaxLevel: "",
  thinkingType: "",
  thinkingBudgetTokens: 0,
  description: "",
  temperature: null,
  topP: null,
  extraHeaders: [],
  options: [],
  api: "",
  baseURL: "",
});
const form = ref(defaultForm());
// 编辑时的新模型 ID（重命名）
const newModelId = ref("");
// 高级配置展开状态
const advancedOpen = ref(false);

// 最终生效的模型 ID：add 用表单值，edit 用新 ID（留空回退原 ID）
const finalId = computed(() =>
  isAdd.value
    ? form.value.id.trim()
    : newModelId.value.trim() || (props.initial?.id ?? "")
);

const toKvRows = (obj) =>
  obj && typeof obj === "object" && !Array.isArray(obj)
    ? Object.entries(obj).map(([key, value]) => ({ key, value }))
    : [];

const kvRowsToObject = (rows) => {
  const obj = {};
  (rows || []).forEach(({ key, value }) => {
    if (key && key.trim()) obj[key.trim()] = value;
  });
  return obj;
};

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    advancedOpen.value = false;
    if (isAdd.value) {
      form.value = defaultForm();
      resetAutoModels();
      // 打开弹窗即自动拉取模型列表，无需手动点击
      fetchAutoModels(props.provider);
    } else {
      const m = props.initial || {};
      const thinking = m.thinking && typeof m.thinking === "object" ? m.thinking : {};
      newModelId.value = m.id || "";
      form.value = {
        name: m.name || "",
        contextWindow: m.contextWindow || 0,
        maxTokens: m.maxTokens || 0,
        reasoning: !!m.reasoning,
        input: Array.isArray(m.input) && m.input.length ? [...m.input] : ["text"],
        output: Array.isArray(m.output) && m.output.length ? [...m.output] : ["text"],
        reasoningEfforts: Array.isArray(m.reasoningEfforts) ? [...m.reasoningEfforts] : [],
        defaultEffort: m.defaultEffort || "",
        capabilities: Array.isArray(m.capabilities) ? [...m.capabilities] : [],
        cost: m.cost && m.cost.input != null ? { ...m.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: toKvRows(m.compat),
        maxInputTokens: Number(m.maxInputTokens) || 0,
        offEffort: m.offEffort || "",
        reasoningKey: m.reasoningKey || "",
        adaptiveThinking: m.adaptiveThinking === true ? "true" : m.adaptiveThinking === false ? "false" : "",
        thinkingMode: thinking.mode || "",
        thinkingMinLevel: thinking.minLevel || "",
        thinkingMaxLevel: thinking.maxLevel || "",
        thinkingType: thinking.type || "",
        thinkingBudgetTokens: Number(thinking.budgetTokens) || 0,
        description: m.description || "",
        temperature: typeof m.temperature === "number" ? m.temperature : null,
        topP: typeof m.topP === "number" ? m.topP : null,
        extraHeaders: toKvRows(m.extraHeaders),
        options: toKvRows(m.options),
        api: m.api || "",
        baseURL: m.baseURL || "",
      };
    }
  }
);

const handleConfirm = () => {
  const id = finalId.value;
  if (isAdd.value && !id) {
    MessagePlugin.warning(t("model.idRequired"));
    return;
  }
  const thinking = {};
  if (form.value.thinkingMode) thinking.mode = form.value.thinkingMode;
  if (form.value.thinkingMinLevel) thinking.minLevel = form.value.thinkingMinLevel;
  if (form.value.thinkingMaxLevel) thinking.maxLevel = form.value.thinkingMaxLevel;
  if (form.value.thinkingType) thinking.type = form.value.thinkingType;
  if (Number(form.value.thinkingBudgetTokens) > 0) thinking.budgetTokens = Number(form.value.thinkingBudgetTokens);
  emit("confirm", {
    mode: props.mode,
    providerName: props.providerName,
    originalId: isAdd.value ? null : props.initial?.id ?? null,
    id,
    name: form.value.name.trim() || id,
    contextWindow: Number(form.value.contextWindow) || 0,
    maxTokens: Number(form.value.maxTokens) || 0,
    reasoning: form.value.reasoning,
    input: form.value.input?.length ? [...form.value.input] : ["text"],
    output: form.value.output?.length ? [...form.value.output] : ["text"],
    reasoningEfforts: [...new Set(form.value.reasoningEfforts || [])],
    defaultEffort: form.value.defaultEffort || "",
    capabilities: [...new Set(form.value.capabilities || [])],
    cost: form.value.cost,
    compat: kvRowsToObject(form.value.compat),
    maxInputTokens: Number(form.value.maxInputTokens) || 0,
    offEffort: form.value.offEffort || "",
    reasoningKey: form.value.reasoningKey.trim(),
    adaptiveThinking: form.value.adaptiveThinking === "" ? null : form.value.adaptiveThinking === "true",
    thinking: Object.keys(thinking).length ? thinking : null,
    description: form.value.description.trim(),
    temperature: numberOrNull(form.value.temperature),
    topP: numberOrNull(form.value.topP),
    extraHeaders: kvRowsToObject(form.value.extraHeaders),
    options: kvRowsToObject(form.value.options),
    api: form.value.api || "",
    baseURL: form.value.baseURL.trim(),
  });
};
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    :header="isAdd ? t('model.addTitle') : t('model.editTitle')"
    width="620px"
    :confirm-btn="{ content: isAdd ? t('model.add') : t('model.save'), theme: 'primary' }"
    @confirm="handleConfirm"
  >
    <div class="common-edit-form">
      <div v-if="isAdd" class="common-form-item">
        <label>{{ t('model.provider') }}</label>
        <div class="common-edit-provider-name">{{ providerName }}</div>
      </div>

      <!-- 模型 ID：添加模式用 AutoComplete（弹窗打开时已自动拉取模型列表），编辑模式可改名 -->
      <div class="common-form-item">
        <label>{{ t('model.id') }} <span v-if="isAdd" class="common-form-required">*</span></label>
        <AutoComplete
          v-if="isAdd"
          v-model="form.id"
          :options="modelOptions"
          :loading="autoModelsLoading"
          filterable
          clearable
          :placeholder="t('model.selectOrEnter')"
          :popup-props="{ overlayStyle: { maxHeight: '280px', overflowY: 'auto' } }"
          @select="(val) => onModelIdSelect(val, form)"
        />
        <Input v-else v-model="newModelId" :placeholder="t('model.idPlaceholder')" />
        <template v-if="isAdd">
          <div v-if="autoModelsLoading" class="common-form-hint">{{ t('model.fetching') }}</div>
          <div v-else-if="autoModelsError" class="common-form-hint common-fetch-error">
            {{ t('model.fetchFailed', { message: autoModelsError }) }}
            <span class="common-fetch-retry" @click="fetchAutoModels(provider)">{{ t('model.retry') }}</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="common-form-hint">
            {{ t('model.fetchedCount', { count: autoModels.length }) }}
          </div>
        </template>
      </div>
      <div class="common-form-item">
        <label>{{ t('model.displayName') }}</label>
        <Input v-model="form.name" :placeholder="isAdd ? t('model.displayNamePlaceholder') : t('model.displayNameEditPlaceholder')" />
      </div>
      <div class="common-form-item">
        <label>{{ t('model.inputType') }}</label>
        <Space size="16px" align="center" wrap>
          <CheckboxGroup v-model="form.input" class="common-checkbox-group">
            <Checkbox v-for="opt in modalityOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
          </CheckboxGroup>
          <Checkbox v-model="form.reasoning" class="common-reasoning-checkbox">{{ t('model.reasoning') }}</Checkbox>
        </Space>
      </div>
      <ModelLimitsFields v-model:context="form.contextWindow" v-model:output="form.maxTokens" item-class="common-form-item" />
      <Collapse v-model="advancedOpen" class="common-advanced-collapse">
        <CollapsePanel value="1" :header="t('model.advanced')">
          <div class="common-form-section-title">{{ t('model.outputType') }}</div>
          <div class="common-form-item">
            <label>{{ t('model.outputModalities') }}</label>
            <Select
              v-model="form.output"
              multiple
              clearable
              :options="modalityOptions"
              :placeholder="t('model.modalityPlaceholder')"
            />
          </div>

          <div class="common-form-section-title">{{ t('model.reasoningAdvanced') }}</div>
          <div class="common-form-item">
            <label>{{ t('model.reasoningEfforts') }}</label>
            <Select
              v-model="form.reasoningEfforts"
              multiple
              clearable
              :options="effortOptions"
              :placeholder="t('model.effortPlaceholder')"
            />
            <div class="common-form-hint">{{ t('model.reasoningEffortsHint') }}</div>
          </div>
          <div class="common-form-row">
            <div class="common-form-item">
              <label>{{ t('model.defaultEffort') }}</label>
              <Select v-model="form.defaultEffort" clearable :options="effortOptions" :placeholder="t('model.effortPlaceholder')" />
            </div>
            <div class="common-form-item">
              <label>{{ t('model.offEffort') }}</label>
              <Select v-model="form.offEffort" clearable :options="offEffortOptions" :placeholder="t('model.effortPlaceholder')" />
            </div>
          </div>
          <div class="common-form-item">
            <label>{{ t('model.maxInputTokens') }}</label>
            <InputNumber v-model="form.maxInputTokens" :min="0" :step="1000" :placeholder="t('model.maxInputTokensPlaceholder')" />
          </div>
          <div class="common-form-row">
            <div class="common-form-item">
              <label>{{ t('model.thinkingMode') }}</label>
              <Select v-model="form.thinkingMode" clearable :options="thinkingModeOptions" :placeholder="t('model.thinkingModePlaceholder')" />
            </div>
            <div class="common-form-item">
              <label>{{ t('model.thinkingMinLevel') }}</label>
              <Select v-model="form.thinkingMinLevel" clearable :options="levelOptions" :placeholder="t('model.thinkingLevelPlaceholder')" />
            </div>
            <div class="common-form-item">
              <label>{{ t('model.thinkingMaxLevel') }}</label>
              <Select v-model="form.thinkingMaxLevel" clearable :options="levelOptions" :placeholder="t('model.thinkingLevelPlaceholder')" />
            </div>
          </div>
          <div class="common-form-row">
            <div class="common-form-item">
              <label>{{ t('model.thinkingType') }}</label>
              <Select v-model="form.thinkingType" clearable :options="thinkingTypeOptions" :placeholder="t('model.thinkingTypePlaceholder')" />
            </div>
            <div class="common-form-item">
              <label>{{ t('model.thinkingBudget') }}</label>
              <InputNumber v-model="form.thinkingBudgetTokens" :min="0" :step="1024" :placeholder="t('model.thinkingBudgetPlaceholder')" />
            </div>
          </div>
          <div class="common-form-row">
            <div class="common-form-item">
              <label>{{ t('model.reasoningKey') }}</label>
              <Input v-model="form.reasoningKey" :placeholder="t('model.reasoningKeyPlaceholder')" />
            </div>
            <div class="common-form-item">
              <label>{{ t('model.adaptiveThinking') }}</label>
              <Select v-model="form.adaptiveThinking" :options="adaptiveThinkingOptions" />
            </div>
          </div>
          <div class="common-form-hint">{{ t('model.thinkingHint') }}</div>

          <div class="common-form-section-title">{{ t('model.capabilities') }}</div>
          <div class="common-form-item">
            <CheckboxGroup v-model="form.capabilities" class="common-checkbox-group">
              <Checkbox v-for="opt in capabilityOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
            </CheckboxGroup>
            <div class="common-form-hint">{{ t('model.capabilitiesHint') }}</div>
          </div>

          <div class="common-form-section-title">{{ t('model.requestParams') }}</div>
          <div class="common-form-item">
            <label>{{ t('model.description') }}</label>
            <Input v-model="form.description" :placeholder="t('model.descriptionPlaceholder')" />
          </div>
          <div class="common-form-row">
            <div class="common-form-item">
              <label>temperature</label>
              <InputNumber v-model="form.temperature" :min="0" :max="2" :step="0.1" :decimal-places="2" :placeholder="t('common.default')" />
            </div>
            <div class="common-form-item">
              <label>top_p</label>
              <InputNumber v-model="form.topP" :min="0" :max="1" :step="0.05" :decimal-places="2" :placeholder="t('common.default')" />
            </div>
          </div>
          <div class="common-form-item">
            <label>{{ t('model.extraHeaders') }}</label>
            <DynamicKvEditor
              v-model="form.extraHeaders"
              :key-options="[]"
              :key-placeholder="t('model.extraHeadersKeyPlaceholder')"
              :value-placeholder="t('model.extraHeadersValuePlaceholder')"
            />
          </div>

          <div class="common-form-section-title">{{ t('model.passthrough') }}</div>
          <div class="common-form-item">
            <label>{{ t('model.options') }}</label>
            <DynamicKvEditor
              v-model="form.options"
              :key-options="[]"
              :key-placeholder="t('model.optionsKeyPlaceholder')"
              :value-placeholder="t('model.optionsValuePlaceholder')"
              parse-scalars
            />
            <div class="common-form-hint">{{ t('model.optionsHint') }}</div>
          </div>
          <div class="common-form-item">
            <label>{{ t('model.compat') }}</label>
            <DynamicKvEditor
              v-model="form.compat"
              :key-options="compatKeyOptions"
              :key-placeholder="t('model.compatKeyPlaceholder')"
              :value-placeholder="t('model.compatValuePlaceholder')"
              parse-scalars
            />
          </div>

          <div class="common-form-section-title">{{ t('model.cost') }}</div>
          <div class="common-form-item">
            <div class="common-form-row">
              <div class="common-form-item">
                <label>{{ t('model.input') }}</label>
                <InputNumber v-model="form.cost.input" :min="0" :step="0.1" placeholder="0" />
              </div>
              <div class="common-form-item">
                <label>{{ t('model.output') }}</label>
                <InputNumber v-model="form.cost.output" :min="0" :step="0.1" placeholder="0" />
              </div>
            </div>
            <div class="common-form-row">
              <div class="common-form-item">
                <label>{{ t('model.cacheRead') }}</label>
                <InputNumber v-model="form.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
              </div>
              <div class="common-form-item">
                <label>{{ t('model.cacheWrite') }}</label>
                <InputNumber v-model="form.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
              </div>
            </div>
          </div>

          <div class="common-form-section-title">{{ t('model.endpointOverride') }}</div>
          <div class="common-form-row">
            <div class="common-form-item">
              <label>{{ t('model.apiOverride') }}</label>
              <Select v-model="form.api" :options="apiOptions" />
            </div>
            <div class="common-form-item">
              <label>{{ t('model.baseUrlOverride') }}</label>
              <Input v-model="form.baseURL" :placeholder="t('model.baseUrlOverridePlaceholder')" />
            </div>
          </div>
          <div class="common-form-hint">{{ t('model.endpointOverrideHint') }}</div>

          <!-- 各应用特有高级字段（如 opencode 思考参数） -->
          <slot name="advanced-extra" :form="form" />
        </CollapsePanel>
      </Collapse>
    </div>
  </Dialog>
</template>
