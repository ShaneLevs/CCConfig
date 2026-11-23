<script setup>
import { useI18n } from "vue-i18n";
import { AutoComplete, Checkbox, Tooltip } from "tdesign-vue-next";
import { findModelPreset, getPresetValues } from "../../../utils/modelPresets";

// claude 配置表单的模型输入行：AutoComplete 候选 + 「1m」百万上下文后缀复选框。
const props = defineProps({
  label: { type: String, required: true },
  placeholder: { type: String, default: "" },
  options: { type: Array, default: () => [] },
  modelValue: { type: String, default: "" },
  oneM: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "update:oneM"]);

const { t } = useI18n();

const onInput = (val) => emit("update:modelValue", val);
const on1mChange = (checked) => emit("update:oneM", checked);
const onModelBlur = (event) => {
  const value = String(event?.target?.value ?? props.modelValue ?? "").trim();
  const result = findModelPreset(value);
  if (!result) return;
  const values = getPresetValues(result.preset, result.contextWindowOverride);
  if (values.contextWindow >= 1_000_000 && !props.oneM) emit("update:oneM", true);
};
</script>

<template>
  <div class="form-item">
    <label>{{ label }}</label>
    <AutoComplete
      :model-value="modelValue"
      :options="options"
      filterable
      :placeholder="placeholder"
      @change="onInput"
      @blur="onModelBlur"
    >
      <template #suffix>
        <Tooltip :content="t('claude.modelField.oneMHint')">
          <Checkbox
            :checked="oneM"
            size="small"
            :disabled="!modelValue"
            class="model-1m-checkbox"
            @change="on1mChange"
          >1m</Checkbox>
        </Tooltip>
      </template>
    </AutoComplete>
  </div>
</template>
