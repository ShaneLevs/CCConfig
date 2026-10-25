<script setup>
// 「上下文窗口 + 最大输出」双表单项组件，供 opencode / pi / omp / 通用配置 各页复用。
// 预设档位统一取自 src/constants.js（CTX_OPTIONS / TOKENS_OPTIONS），视图不再各自声明。
// itemClass 传入各视图的 form-item 类名以保持原有排版（如 pi-form-item）。
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import PresetCustomInput from "./PresetCustomInput.vue";

const props = defineProps({
  // v-model:context / v-model:output
  context: { type: Number, default: 0 },
  output: { type: Number, default: 0 },
  itemClass: { type: String, default: "form-item" },
  contextLabel: { type: String, default: "" },
  outputLabel: { type: String, default: "" },
});

const emit = defineEmits(["update:context", "update:output"]);
const { t } = useI18n();
const contextLabelText = computed(() => props.contextLabel || t("common.contextWindow"));
const outputLabelText = computed(() => props.outputLabel || t("common.maxOutput"));
</script>

<template>
  <div :class="itemClass">
    <label>{{ contextLabelText }}</label>
    <PresetCustomInput
      :model-value="context"
      kind="context"
      @update:model-value="(v) => emit('update:context', v)"
    />
  </div>
  <div :class="itemClass">
    <label>{{ outputLabelText }}</label>
    <PresetCustomInput
      :model-value="output"
      kind="output"
      @update:model-value="(v) => emit('update:output', v)"
    />
  </div>
</template>
