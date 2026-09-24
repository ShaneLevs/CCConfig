<script setup>
// 「上下文窗口 + 最大输出」双表单项组件，供 opencode / pi / omp / 通用配置 各页复用。
// 预设档位统一取自 src/constants.js（CTX_OPTIONS / TOKENS_OPTIONS），视图不再各自声明。
// itemClass 传入各视图的 form-item 类名以保持原有排版（如 pi-form-item）。
import PresetCustomInput from "./PresetCustomInput.vue";

defineProps({
  // v-model:context / v-model:output
  context: { type: Number, default: 0 },
  output: { type: Number, default: 0 },
  itemClass: { type: String, default: "form-item" },
  contextLabel: { type: String, default: "上下文窗口" },
  outputLabel: { type: String, default: "最大输出" },
});

const emit = defineEmits(["update:context", "update:output"]);
</script>

<template>
  <div :class="itemClass">
    <label>{{ contextLabel }}</label>
    <PresetCustomInput
      :model-value="context"
      kind="context"
      @update:model-value="(v) => emit('update:context', v)"
    />
  </div>
  <div :class="itemClass">
    <label>{{ outputLabel }}</label>
    <PresetCustomInput
      :model-value="output"
      kind="output"
      @update:model-value="(v) => emit('update:output', v)"
    />
  </div>
</template>
