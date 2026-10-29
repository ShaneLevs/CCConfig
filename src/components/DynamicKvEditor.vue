<script setup>
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button, Textarea, AutoComplete, Tag } from "tdesign-vue-next";
import { AddIcon, DeleteIcon } from "tdesign-icons-vue-next";
import { load, dump } from "js-yaml";

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  keyOptions: { type: Array, default: () => [] },
  readonly: { type: Boolean, default: false },
  keyPlaceholder: { type: String, default: "" },
  valuePlaceholder: { type: String, default: "" },
  showAdd: { type: Boolean, default: true },
  // 标量值按 JSON 解析（true/false/数字/null）。默认关闭，headers 等字符串值必须原样往返。
  parseScalars: { type: Boolean, default: false },
});

const emit = defineEmits(["update:modelValue"]);
const { t } = useI18n();
const keyPlaceholderText = computed(() => props.keyPlaceholder || t("common.fieldName"));
const valuePlaceholderText = computed(() => props.valuePlaceholder || t("common.fieldValue"));

const addField = () => {
  emit("update:modelValue", [...props.modelValue, { key: "", value: "" }]);
};

const removeField = (idx) => {
  const newVal = [...props.modelValue];
  newVal.splice(idx, 1);
  emit("update:modelValue", newVal);
};

const updateKey = (idx, newKey) => {
  const newVal = props.modelValue.map((f, i) =>
    i === idx ? { ...f, key: newKey } : f
  );
  emit("update:modelValue", newVal);
};

// 值展示：对象/数组用 YAML 格式展示（照搬 models.yml 的写法），避免 [object Object]
const displayValue = (value) => {
  if (value !== null && typeof value === "object") {
    try { return dump(value).replace(/\n$/, ""); } catch { return String(value); }
  }
  return value;
};

// 值解析：仅对象/数组按 YAML 解析（嵌套结构）；标量保留原字符串，避免 YAML 强制转换
// 损坏数字（01234→1234、大数精度丢失）——headers 等字符串值必须原样往返
const parseValue = (str) => {
  const trimmed = (str ?? "").trim();
  if (trimmed === "") return "";
  // parseScalars 供 compat / options 等结构化字段使用：true/false/数字要按原类型写入，
  // headers 这类值保持字符串，因此默认不开启。
  if (props.parseScalars) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object") return parsed;
    } catch { /* 不是 JSON 标量，继续走 YAML */ }
  }
  try {
    const parsed = load(trimmed);
    if (parsed !== null && typeof parsed === "object") return parsed;
    return str;
  } catch { return str; }
};

const updateValue = (idx, newValue) => {
  const newVal = props.modelValue.map((f, i) =>
    i === idx ? { ...f, value: parseValue(newValue) } : f
  );
  emit("update:modelValue", newVal);
};

const onBlurCommitKey = (idx, e) => {
  updateKey(idx, e.target.value);
};
</script>

<template>
  <div class="dynamic-kv-editor">
    <div v-for="(field, idx) in modelValue" :key="idx" class="kv-field-wrap">
      <div class="kv-field-row">
        <template v-if="readonly">
          <div class="kv-key-readonly">{{ field.key }}</div>
          <div class="kv-value-readonly">{{ displayValue(field.value) }}</div>
        </template>
        <template v-else>
          <AutoComplete
            :value="field.key"
            class="kv-key"
            :options="keyOptions"
            filterable
            :placeholder="keyPlaceholderText"
            @blur="onBlurCommitKey(idx, $event)"
            @change="(val) => updateKey(idx, val)"
          />
          <Textarea
            :value="displayValue(field.value)"
            class="kv-value"
            :placeholder="valuePlaceholderText"
            :autosize="{ minRows: 1, maxRows: 8 }"
            @change="(val) => updateValue(idx, val)"
          />
          <Button
            size="small"
            theme="danger"
            variant="text"
            @click="removeField(idx)"
          >
            <DeleteIcon />
          </Button>
        </template>
      </div>
    </div>
    <Button
      v-if="showAdd && !readonly"
      size="small"
      variant="outline"
      @click="addField"
      class="kv-add-btn"
    >
      <template #icon><AddIcon /></template> {{ t('common.addField') }}
    </Button>
  </div>
</template>

<style scoped>
.dynamic-kv-editor { display: flex; flex-direction: column; gap: 8px; }
.kv-field-row { display: flex; gap: 8px; align-items: flex-start; }
.kv-key { flex: 1; min-width: 0; }
.kv-value { flex: 1; min-width: 0; }
.kv-key-readonly { flex: 1; font-size: 12px; color: var(--td-text-color-secondary); word-break: break-all; }
.kv-value-readonly { flex: 1; font-size: 12px; color: var(--td-text-color-primary); word-break: break-all; }
.kv-add-btn { align-self: flex-start; }
</style>
