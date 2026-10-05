<script setup>
import { Checkbox, RadioGroup, RadioButton } from "tdesign-vue-next";

// claude env「常用设置」预设块：三个布尔预设复选框 + 思考强度 RadioGroup。
// values 为预设键 → 值 的响应式对象（直接改写其属性以联动父级状态）；
// disabled 时以只读样式展示（全局字段预览），并附加 global-preset-list 类。
const props = defineProps({
  values: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
});

const effortLevelClass = (level) => (level ? `effort-${level}` : "");
</script>

<template>
  <div class="env-preset-list" :class="{ 'global-preset-list': disabled }">
    <div class="env-preset-row preset-checkboxes">
      <Checkbox v-model="values['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']" :disabled="disabled">Teammates 模式</Checkbox>
      <Checkbox v-model="values['ENABLE_TOOL_SEARCH']" :disabled="disabled">启用工具搜索</Checkbox>
      <Checkbox v-model="values['CLAUDE_CODE_NO_FLICKER']" :disabled="disabled">关闭终端闪烁</Checkbox>
    </div>
    <div class="env-preset-row env-preset-row-effort">
      <span class="env-preset-label">思考强度</span>
      <RadioGroup
        :model-value="values['CLAUDE_CODE_EFFORT_LEVEL'] || ''"
        variant="default-filled"
        size="small"
        :disabled="disabled"
        :class="effortLevelClass(values['CLAUDE_CODE_EFFORT_LEVEL'] || '')"
        @change="(v) => (values['CLAUDE_CODE_EFFORT_LEVEL'] = v)"
      >
        <RadioButton value="">default</RadioButton>
        <RadioButton value="low">low</RadioButton>
        <RadioButton value="medium">medium</RadioButton>
        <RadioButton value="high">high</RadioButton>
        <RadioButton value="xhigh">xhigh</RadioButton>
        <RadioButton value="max">max</RadioButton>
      </RadioGroup>
    </div>
  </div>
</template>
