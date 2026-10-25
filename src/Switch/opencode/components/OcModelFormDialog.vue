<script setup>
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, Input, InputNumber, Select, Checkbox, AutoComplete } from "tdesign-vue-next";
import ModelLimitsFields from "../../../components/ModelLimitsFields.vue";
import DynamicKvEditor from "../../../components/DynamicKvEditor.vue";
import { useAutoFetchModels } from "../../../composables/useAutoFetchModels";

// opencode 模型添加/编辑弹窗（二合一）：add 模式带 /models 自动拉取（选中条件回填），
// edit 模式额外暴露 SDK Options 与额外字段编辑器。表单对象由父级构建传入（initialForm），
// 确认时把表单副本交回父级执行 mutateProviderModels 写入。
// 样式沿用 opencode/styles/ConfigView.css 全局类（本组件仅在 opencode 配置页使用）。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'add' | 'edit'
  mode: { type: String, default: "add" },
  providerName: { type: String, default: "" },
  // add 模式：用于自动拉取模型列表的 { baseUrl, apiKey } 对象
  provider: { type: Object, default: null },
  // 打开时的表单初值（add 为空表单，edit 为父级从原始配置回读构建的对象）
  initialForm: { type: Object, required: true },
});
const emit = defineEmits(["update:visible", "confirm"]);

const { t } = useI18n();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const isAdd = computed(() => props.mode === "add");

// 输入/输出模态（opencode modalities 合法值，源自 provider.ts capabilities 解析）
const MODALITY_OPTIONS = [
  { labelKey: "opencode.model.modalities.text", value: "text" },
  { labelKey: "opencode.model.modalities.image", value: "image" },
  { labelKey: "opencode.model.modalities.audio", value: "audio" },
  { labelKey: "opencode.model.modalities.video", value: "video" },
  { labelKey: "opencode.model.modalities.pdf", value: "pdf" },
];
// 思考参数（options.effort / options.thinking，与 MiniMax 页同款枚举）
const EFFORT_OPTIONS = ["minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ label: v, value: v }));
const THINKING_TYPE_OPTIONS = [
  { labelKey: "opencode.model.thinkingTypes.enabled", value: "enabled" },
  { labelKey: "opencode.model.thinkingTypes.adaptive", value: "adaptive" },
  { labelKey: "opencode.model.thinkingTypes.disabled", value: "disabled" },
];
const modalityOptions = computed(() => MODALITY_OPTIONS.map((o) => ({ ...o, label: t(o.labelKey) })));
const thinkingTypeOptions = computed(() => THINKING_TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.labelKey) })));

const {
  autoModels, autoModelsLoading, autoModelsError, modelOptions, fetchAutoModels, resetAutoModels,
} = useAutoFetchModels();

const form = ref({});

// 选中模型：条件回填（仅在拉取到值时覆盖，不清空用户已填内容）
const onAutoModelSelect = (val) => {
  const m = autoModels.value.find(x => x.id === val);
  if (!m) return;
  form.value.id = m.id;
  form.value.name = m.name || m.id;
  if (m.contextWindow) form.value.context = m.contextWindow;
  if (m.maxTokens) form.value.output = m.maxTokens;
  if (m.reasoning) form.value.reasoning = true;
};

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    form.value = { ...props.initialForm };
    if (isAdd.value) {
      resetAutoModels();
      // 打开弹窗即自动拉取模型列表，无需手动点击
      fetchAutoModels(props.provider, t("opencode.model.missingBaseUrl"));
    }
  }
);

const handleConfirm = () => {
  emit("confirm", { ...form.value });
};
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    :header="isAdd ? t('opencode.model.addTitle') : t('opencode.model.editTitle')"
    width="520px"
    :confirm-btn="{ content: isAdd ? t('opencode.model.add') : t('common.save'), theme: 'primary' }"
    @confirm="handleConfirm"
  >
    <div class="oc-form">
      <div class="oc-form-item">
        <label>{{ t("opencode.model.provider") }}</label>
        <div class="oc-provider-name">{{ providerName }}</div>
      </div>
      <div class="oc-form-item">
        <label>{{ t("opencode.model.id") }} <span class="required">*</span></label>
        <AutoComplete
          v-if="isAdd"
          v-model="form.id"
          :options="modelOptions"
          :loading="autoModelsLoading"
          filterable
          clearable
          :placeholder="t('opencode.model.inputOrSelect')"
          @select="onAutoModelSelect"
        />
        <Input v-else v-model="form.id" :placeholder="t('opencode.model.idPlaceholder')" />
        <template v-if="isAdd">
          <div v-if="autoModelsLoading" class="oc-form-hint">{{ t("opencode.model.fetching") }}</div>
          <div v-else-if="autoModelsError" class="oc-form-hint oc-fetch-error">
            {{ t("opencode.model.fetchFailed", { message: autoModelsError }) }}
            <span class="oc-fetch-retry" @click="fetchAutoModels(provider, t('opencode.model.missingBaseUrl'))">{{ t("common.retry") }}</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="oc-form-hint">
            {{ t("opencode.model.fetchedCount", { count: autoModels.length }) }}
          </div>
        </template>
      </div>
      <div class="oc-form-item">
        <label>{{ t("opencode.model.displayName") }}</label>
        <Input v-model="form.name" :placeholder="t('opencode.model.displayNamePlaceholder')" />
      </div>
      <ModelLimitsFields v-model:context="form.context" v-model:output="form.output" item-class="oc-form-item" />
      <div class="oc-form-item">
        <Checkbox v-model="form.reasoning">{{ t("opencode.model.reasoning") }}</Checkbox>
      </div>
      <div class="oc-form-item-row">
        <div class="oc-form-item oc-form-item--flex">
          <label>{{ t("opencode.model.inputModalities") }}</label>
          <Select v-model="form.modalitiesInput" multiple clearable :options="modalityOptions" :placeholder="t('opencode.model.defaultTextOnly')" />
        </div>
        <div class="oc-form-item oc-form-item--flex">
          <label>{{ t("opencode.model.outputModalities") }}</label>
          <Select v-model="form.modalitiesOutput" multiple clearable :options="modalityOptions" :placeholder="t('opencode.model.defaultTextOnly')" />
        </div>
      </div>
      <div class="oc-form-item-row">
        <div class="oc-form-item oc-form-item--flex">
          <label>{{ t("opencode.model.effort") }}</label>
          <Select v-model="form.effort" :options="EFFORT_OPTIONS" clearable :placeholder="t('opencode.model.notSet')" />
        </div>
        <div class="oc-form-item oc-form-item--flex">
          <label>{{ t("opencode.model.thinkingType") }}</label>
          <Select v-model="form.thinkingType" :options="thinkingTypeOptions" clearable :placeholder="t('opencode.model.notSet')" />
        </div>
      </div>
      <div v-if="form.thinkingType === 'enabled'" class="oc-form-item">
        <label>{{ t("opencode.model.thinkingBudget") }}</label>
        <InputNumber v-model="form.thinkingBudget" :min="0" :step="1024" :placeholder="t('opencode.model.thinkingBudgetPlaceholder')" />
      </div>
      <template v-if="!isAdd">
        <div class="oc-form-subsection">
          <div class="oc-form-subsection-title">{{ t("opencode.model.sdkOptions") }}</div>
          <DynamicKvEditor
            v-model="form.sdkOptions"
            :key-options="[]"
            :key-placeholder="t('opencode.model.optionName')"
            :value-placeholder="t('opencode.model.optionValue')"
          />
        </div>
        <div class="oc-form-subsection">
          <div class="oc-form-subsection-title">{{ t("opencode.model.extraFields") }}</div>
          <DynamicKvEditor
            v-model="form.extraFields"
            :key-options="[]"
            :key-placeholder="t('opencode.model.fieldName')"
            :value-placeholder="t('opencode.model.fieldValue')"
          />
        </div>
      </template>
    </div>
  </Dialog>
</template>
