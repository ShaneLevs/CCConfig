<script setup>
import { AutoComplete, Checkbox, Tooltip } from "tdesign-vue-next";

// claude 配置表单的模型输入行：AutoComplete 候选 + 「1m」百万上下文后缀复选框。
const props = defineProps({
  label: { type: String, required: true },
  placeholder: { type: String, default: "" },
  options: { type: Array, default: () => [] },
  modelValue: { type: String, default: "" },
  oneM: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "update:oneM"]);

const onInput = (val) => emit("update:modelValue", val);
const on1mChange = (checked) => emit("update:oneM", checked);
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
    >
      <template #suffix>
        <Tooltip content="模型支持一百万个上下文时勾选">
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
