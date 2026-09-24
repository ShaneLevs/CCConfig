<script setup>
// 预设值 + 自定义输入框 二合一选择器
// 用于上下文窗口 / 最大输出等带常见值预设的数字字段。
// 传 kind="context|output" 即自动带出共享预设档位（src/constants.js），无需各视图自写选项；
// 也可显式传 options 覆盖（如批量导入表格需合并非标准值）。
// modelValue 始终为最终数值：选中预设时 = 预设值；自定义时 = 输入框值
import { ref, computed, watch } from "vue";
import { RadioGroup, RadioButton, InputNumber } from "tdesign-vue-next";
import { MODEL_LIMIT_PRESETS } from "../constants";

const props = defineProps({
  modelValue: { type: Number, required: true },
  kind: { type: String, default: "" }, // "context" | "output"，自动带预设
  options: { type: Array, default: null }, // [{ label, value }]，不传则取 kind 预设
  step: { type: Number, default: 0 },
  defaultCustom: { type: Number, default: 0 },
});
const emit = defineEmits(["update:modelValue"]);

const kindPreset = computed(() => MODEL_LIMIT_PRESETS[props.kind] || {});
const options = computed(() => props.options || kindPreset.value.options || []);
const step = computed(() => props.step || kindPreset.value.step || 1000);
const defaultCustom = computed(
  () => props.defaultCustom || kindPreset.value.defaultCustom || 32000,
);

const isPreset = (v) => options.value.some((o) => o.value === v);

// 是否处于"自定义"模式：初始为非预设值即自定义；命中预设时显示预设按钮
const customMode = ref(!isPreset(props.modelValue));
const customVal = ref(customMode.value ? props.modelValue : 0);

const radio = computed({
  get: () => (customMode.value ? -1 : props.modelValue),
  set: (v) => {
    if (v === -1) {
      // 进入自定义：沿用当前值；若是预设/默认则给一个常见默认值
      customMode.value = true;
      customVal.value = isPreset(props.modelValue) || !props.modelValue ? defaultCustom.value : props.modelValue;
      setValue(customVal.value);
    } else {
      customMode.value = false;
      setValue(v);
    }
  },
});

let selfEmit = false;
const setValue = (v) => {
  selfEmit = true;
  emit("update:modelValue", v);
};

// 自定义模式下，输入框变化同步到外层
watch(customVal, (v) => {
  if (radio.value === -1) setValue(v);
});

// 外部改动（如弹窗重置表单）：自发出的值跳过；
// 非自发的值若落在预设上则退出自定义模式，否则同步到输入框
watch(
  () => props.modelValue,
  (v) => {
    if (selfEmit) { selfEmit = false; return; }
    if (isPreset(v)) {
      customMode.value = false;
    } else {
      customMode.value = true;
      customVal.value = v;
    }
  }
);
</script>

<template>
  <div class="preset-custom-input">
    <RadioGroup v-model="radio" variant="default-filled" size="small">
      <RadioButton v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</RadioButton>
      <RadioButton :value="-1">自定义</RadioButton>
    </RadioGroup>
    <div v-if="radio === -1" class="preset-custom-row">
      <InputNumber
        v-model="customVal"
        :step="step"
        size="small"
        style="width: 220px"
      />
      <span class="preset-custom-hint">单位 Token</span>
    </div>
  </div>
</template>

<style scoped>
.preset-custom-input { display: flex; flex-direction: column; gap: 6px; }
.preset-custom-row { display: flex; align-items: center; gap: 8px; }
.preset-custom-hint { font-size: 12px; color: var(--td-text-color-placeholder); }
</style>
