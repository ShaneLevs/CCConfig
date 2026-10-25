<script setup>
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, Input, Select, Button } from "tdesign-vue-next";
import ApiKeyInput from "../../../components/ApiKeyInput.vue";
import DynamicKvEditor from "../../../components/DynamicKvEditor.vue";

// opencode Provider 新建/编辑弹窗（同一弹窗双模式）：编辑时 Provider ID 只读。
// 表单初值由父级构建传入，确认时交回父级执行合并写盘。
// 样式沿用 opencode/styles/ConfigView.css 全局类（本组件仅在 opencode 配置页使用）。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'create' | 'edit'
  mode: { type: String, default: "create" },
  initial: { type: Object, required: true },
});
const emit = defineEmits(["update:visible", "confirm"]);

const { t } = useI18n();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const dialogTitle = computed(() => (props.mode === "edit" ? t("opencode.provider.editTitle") : t("opencode.provider.createTitle")));

const NPM_OPTIONS = [
  { label: "@ai-sdk/openai", value: "@ai-sdk/openai" },
  { label: "@ai-sdk/openai-compatible", value: "@ai-sdk/openai-compatible" },
  { label: "@ai-sdk/anthropic", value: "@ai-sdk/anthropic" },
  { label: "@ai-sdk/amazon-bedrock", value: "@ai-sdk/amazon-bedrock" },
  { label: "@ai-sdk/google", value: "@ai-sdk/google" },
];

const formData = ref({});

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    formData.value = { ...props.initial };
  }
);

const handleConfirm = () => {
  emit("confirm", { ...formData.value });
};
</script>

<template>
  <Dialog v-model:visible="dialogVisible" :header="dialogTitle" width="480px">
    <div class="oc-form">
      <!-- Provider ID -->
      <div class="oc-form-item">
        <label>{{ t("opencode.provider.id") }} <span class="required">*</span></label>
        <Input v-model="formData.id" :placeholder="t('opencode.provider.idPlaceholder')" :disabled="mode === 'edit'" />
      </div>

      <!-- NPM Package -->
      <div class="oc-form-item">
        <label>{{ t("opencode.provider.npmPackage") }} <span class="required">*</span></label>
        <Select v-model="formData.npm" :options="NPM_OPTIONS" :placeholder="t('opencode.provider.npmPlaceholder')" />
      </div>

      <!-- Display Name -->
      <div class="oc-form-item">
        <label>{{ t("opencode.provider.displayName") }}</label>
        <Input v-model="formData.name" :placeholder="t('opencode.provider.displayNamePlaceholder')" />
      </div>

      <!-- Base URL -->
      <div class="oc-form-item">
        <label>{{ t("opencode.provider.baseUrl") }}</label>
        <Input v-model="formData.baseUrl" placeholder="https://api.example.com/v1" />
      </div>

      <!-- API Key -->
      <div class="oc-form-item">
        <label>{{ t("opencode.provider.apiKey") }}</label>
        <ApiKeyInput v-model="formData.apiKey" placeholder="sk-..." />
      </div>

      <!-- Extra Options -->
      <div class="oc-form-item">
        <label>{{ t("opencode.provider.extraOptions") }}</label>
        <DynamicKvEditor
          v-model="formData.extraOptions"
          :key-options="[]"
          :key-placeholder="t('opencode.provider.optionName')"
          :value-placeholder="t('opencode.provider.optionValue')"
        />
      </div>
    </div>

    <template #footer>
      <div class="oc-dialog-footer">
        <div class="oc-dialog-footer-right">
          <Button variant="outline" @click="dialogVisible = false">{{ t("common.cancel") }}</Button>
          <Button theme="primary" @click="handleConfirm">{{ t("common.save") }}</Button>
        </div>
      </div>
    </template>
  </Dialog>
</template>
