<script setup>
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, Input, InputNumber, Textarea, MessagePlugin, Select, Space, CheckboxGroup, Checkbox, Collapse, CollapsePanel, AutoComplete } from "tdesign-vue-next";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import ModelLimitsFields from "../../../components/ModelLimitsFields.vue";
import { useAutoFetchModels } from "../../../composables/useAutoFetchModels";

// omp 模型添加/编辑弹窗（二合一）：高级区为「思考级别 + 费用 + 其他参数 YAML」，
// 编辑模式可改模型 ID（重命名由父级以删旧建新方式落库）。
// 样式沿用 omp/styles/ConfigView.css 全局类（本组件仅在 omp 配置页使用）。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'add' | 'edit'
  mode: { type: String, default: "add" },
  providerName: { type: String, default: "" },
  // add 模式：用于自动拉取模型列表的 { baseUrl, apiKey } 对象
  provider: { type: Object, default: null },
  // edit 模式：原模型对象
  initial: { type: Object, default: null },
});
const emit = defineEmits(["update:visible", "confirm"]);

const { t } = useI18n();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const isAdd = computed(() => props.mode === "add");

const INPUT_TYPE_OPTIONS = [
  { labelKey: "model.text", value: "text" },
  { labelKey: "model.image", value: "image" },
];

const THINKING_MODE_OPTIONS = [
  { label: "effort", value: "effort" },
  { label: "auto", value: "auto" },
];

// 思考级别顺序（小 → 大）
const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];

const emptyThinking = () => ({ minLevel: "", maxLevel: "", mode: "" });

// 表单已管理的模型字段（不在 YAML 文本框里展示）
const MODEL_FORM_KEYS = ["id", "name", "contextWindow", "maxTokens", "reasoning", "input", "thinking", "cost"];

// compat 等参数用 YAML 文本编辑（子级 4 空格缩进，照搬 models.yml 写法）
const dumpYaml = (obj) => {
  if (obj == null) return "";
  try { return yamlDump(obj, { indent: 4 }).replace(/\n$/, ""); } catch { return ""; }
};
const parseYaml = (str) => {
  const text = (str ?? "").trim();
  if (!text) return {};
  try {
    const result = yamlLoad(text);
    // 必须是普通对象（映射）；标量/数组展开成 `...other` 会产生数字键垃圾
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    return result;
  } catch { return null; }
};

// 提取模型对象中表单未管理的字段（compat 及自定义同级参数）
const dumpOtherFields = (model) => {
  if (!model || typeof model !== "object") return "";
  const rest = {};
  for (const [k, v] of Object.entries(model)) {
    if (MODEL_FORM_KEYS.includes(k)) continue;
    // 跳过空值：undefined/null/''/空对象/空数组（避免显示 compat: {}）
    if (v == null) continue;
    if (typeof v === "object" && Object.keys(v).length === 0) continue;
    rest[k] = v;
  }
  if (!Object.keys(rest).length) return "";
  return dumpYaml(rest);
};

// 表单 → models.yml 模型条目：其他参数（compat 及自定义同级字段）在前，
// 表单字段在后覆盖同名键；thinking 仅在有值时写入
const buildModelPayload = (form, fallbackId) => {
  const other = parseYaml(form.otherYaml);
  if (other === null) throw new Error(t("omp.advanced.yamlInvalid"));
  const id = form.id?.trim() || fallbackId;
  const thinking = {};
  if (form.thinking?.mode) thinking.mode = form.thinking.mode;
  if (form.thinking?.minLevel) thinking.minLevel = form.thinking.minLevel;
  if (form.thinking?.maxLevel) thinking.maxLevel = form.thinking.maxLevel;
  const hasThinking = thinking.mode || thinking.minLevel || thinking.maxLevel;
  return {
    ...other,
    id,
    name: form.name.trim() || id,
    contextWindow: Number(form.contextWindow) || 0,
    maxTokens: Number(form.maxTokens) || 0,
    reasoning: form.reasoning,
    input: form.input,
    cost: form.cost,
    thinking: hasThinking ? thinking : undefined,
  };
};

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
  thinking: emptyThinking(),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  otherYaml: "",
});
const form = ref(defaultForm());
// 编辑时的新模型 ID（重命名）
const newModelId = ref("");
const advancedOpen = ref(false);

const finalId = computed(() =>
  isAdd.value
    ? form.value.id.trim()
    : newModelId.value.trim() || (props.initial?.id ?? "")
);

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
      newModelId.value = m.id || "";
      form.value = {
        id: m.id || "",
        name: m.name || "",
        contextWindow: m.contextWindow || 0,
        maxTokens: m.maxTokens || 0,
        reasoning: !!m.reasoning,
        input: m.input || ["text"],
        thinking: m.thinking ? { minLevel: m.thinking.minLevel || "", maxLevel: m.thinking.maxLevel || "", mode: m.thinking.mode || "" } : emptyThinking(),
        cost: (m.cost && m.cost.input != null) ? { ...m.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        otherYaml: dumpOtherFields(m),
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
  let payload;
  try {
    payload = buildModelPayload({ ...form.value, id }, id);
  } catch (e) {
    MessagePlugin.error(t(isAdd.value ? "omp.model.addFailed" : "omp.model.saveFailed", { message: e.message }));
    return;
  }
  emit("confirm", {
    mode: props.mode,
    providerName: props.providerName,
    originalId: isAdd.value ? null : props.initial?.id ?? null,
    id,
    payload,
  });
};
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    :header="isAdd ? t('model.addTitle') : t('model.editTitle')"
    width="520px"
    :confirm-btn="{ content: isAdd ? t('common.add') : t('common.save'), theme: 'primary' }"
    @confirm="handleConfirm"
  >
    <div class="omp-edit-form">
      <div v-if="isAdd" class="omp-form-item">
        <label>{{ t("model.provider") }}</label>
        <div class="omp-edit-provider-name">{{ providerName }}</div>
      </div>

      <!-- 模型 ID：添加模式用 AutoComplete（弹窗打开时已自动拉取模型列表），编辑模式可改名 -->
      <div class="omp-form-item">
        <label>{{ t("model.id") }} <span v-if="isAdd" class="omp-form-required">*</span></label>
        <AutoComplete
          v-if="isAdd"
          v-model="form.id"
          :options="modelOptions"
          :loading="autoModelsLoading"
          filterable
          clearable
          :placeholder="t('model.selectOrEnter')"
          @select="(val) => onModelIdSelect(val, form)"
        />
        <Input v-else v-model="newModelId" :placeholder="t('model.idPlaceholder')" />
        <template v-if="isAdd">
          <div v-if="autoModelsLoading" class="omp-form-hint">{{ t("model.fetching") }}</div>
          <div v-else-if="autoModelsError" class="omp-form-hint omp-fetch-error">
            {{ t("model.fetchFailed", { message: autoModelsError }) }}
            <span class="omp-fetch-retry" @click="fetchAutoModels(provider)">{{ t("model.retry") }}</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="omp-form-hint">
            {{ t("model.fetchedCount", { count: autoModels.length }) }}
          </div>
        </template>
      </div>
      <div class="omp-form-item">
        <label>{{ t("model.displayName") }}</label>
        <Input v-model="form.name" :placeholder="isAdd ? t('model.displayNamePlaceholder') : t('model.displayNameEditPlaceholder')" />
      </div>
      <div class="omp-form-item">
        <label>{{ t("model.inputType") }}</label>
        <Space size="16px" align="center" wrap>
          <CheckboxGroup v-model="form.input" class="omp-checkbox-group">
            <Checkbox v-for="opt in INPUT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ t(opt.labelKey) }}</Checkbox>
          </CheckboxGroup>
          <Checkbox v-model="form.reasoning" class="omp-reasoning-checkbox">{{ t("model.reasoning") }}</Checkbox>
        </Space>
      </div>
      <ModelLimitsFields v-model:context="form.contextWindow" v-model:output="form.maxTokens" item-class="omp-form-item" />
      <Collapse v-model="advancedOpen" class="omp-advanced-collapse">
        <CollapsePanel value="1" :header="t('omp.advanced.title')">
          <div class="omp-form-item">
            <label>{{ t("omp.advanced.thinking") }}</label>
            <div class="omp-form-row">
              <div class="omp-form-item">
                <label>{{ t("omp.advanced.mode") }}</label>
                <Select v-model="form.thinking.mode" :options="THINKING_MODE_OPTIONS" clearable :placeholder="t('omp.advanced.modePlaceholder')" />
              </div>
            </div>
            <div class="omp-form-row">
              <div class="omp-form-item">
                <label>{{ t("omp.advanced.minLevel") }}</label>
                <Select v-model="form.thinking.minLevel" :options="LEVEL_ORDER.map(v => ({ label: v, value: v }))" clearable :placeholder="t('omp.advanced.levelPlaceholder')" />
              </div>
              <div class="omp-form-item">
                <label>{{ t("omp.advanced.maxLevel") }}</label>
                <Select v-model="form.thinking.maxLevel" :options="LEVEL_ORDER.map(v => ({ label: v, value: v }))" clearable :placeholder="t('omp.advanced.levelPlaceholder')" />
              </div>
            </div>
            <div class="omp-form-hint">{{ t("omp.advanced.thinkingHint") }}</div>
          </div>
          <div class="omp-form-item">
            <label>{{ t("model.cost") }}</label>
            <div class="omp-form-row">
              <div class="omp-form-item">
                <label>{{ t("model.input") }}</label>
                <InputNumber v-model="form.cost.input" :min="0" :step="0.1" placeholder="0" />
              </div>
              <div class="omp-form-item">
                <label>{{ t("model.output") }}</label>
                <InputNumber v-model="form.cost.output" :min="0" :step="0.1" placeholder="0" />
              </div>
            </div>
            <div class="omp-form-row">
              <div class="omp-form-item">
                <label>{{ t("model.cacheRead") }}</label>
                <InputNumber v-model="form.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
              </div>
              <div class="omp-form-item">
                <label>{{ t("model.cacheWrite") }}</label>
                <InputNumber v-model="form.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
              </div>
            </div>
          </div>
          <div class="omp-form-item">
            <label>{{ t("omp.advanced.otherParams") }}</label>
            <Textarea
              v-model="form.otherYaml"
              :placeholder="t('omp.advanced.otherParamsPlaceholder')"
              :autosize="{ minRows: 4, maxRows: 14 }"
            />
            <div class="omp-form-hint">{{ t("omp.advanced.otherParamsHint") }}</div>
          </div>
        </CollapsePanel>
      </Collapse>
    </div>
  </Dialog>
</template>
