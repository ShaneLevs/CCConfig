<script setup>
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog } from "tdesign-vue-next";

// claude 配置详情预览弹窗（点击配置行打开）。
const props = defineProps({
  visible: { type: Boolean, default: false },
  config: { type: Object, default: null },
});
const emit = defineEmits(["update:visible"]);

const { t } = useI18n();

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const maskKey = (key) => {
  if (!key || key.length < 8) return key || "";
  return key.substring(0, 6) + "***" + key.substring(key.length - 4);
};
</script>

<template>
  <Dialog v-model:visible="dialogVisible" :header="t('claude.preview.title')" width="560px" :footer="false">
    <div v-if="config" class="preview-content">
      <div class="preview-item"><span class="preview-label">{{ t('claude.preview.name') }}</span><span class="preview-value">{{ config.name }}</span></div>
      <div class="preview-item"><span class="preview-label">{{ config.authVar || 'ANTHROPIC_AUTH_TOKEN' }}</span><span class="preview-value">{{ maskKey(config.key) || t('common.notSet') }}</span></div>
      <div class="preview-item"><span class="preview-label">BASE_URL</span><span class="preview-value">{{ config.baseUrl || t('common.notSet') }}</span></div>
      <div class="preview-item"><span class="preview-label">MODEL</span><span class="preview-value">{{ config.model || t('common.notSet') }}</span></div>
      <div v-if="config.defaultHaikuModel || config.defaultSonnetModel || config.defaultOpusModel || config.defaultFableModel" class="preview-divider"></div>
      <div v-if="config.defaultHaikuModel" class="preview-item"><span class="preview-label">HAIKU_MODEL</span><span class="preview-value">{{ config.defaultHaikuModel }}</span></div>
      <div v-if="config.defaultSonnetModel" class="preview-item"><span class="preview-label">SONNET_MODEL</span><span class="preview-value">{{ config.defaultSonnetModel }}</span></div>
      <div v-if="config.defaultOpusModel" class="preview-item"><span class="preview-label">OPUS_MODEL</span><span class="preview-value">{{ config.defaultOpusModel }}</span></div>
      <div v-if="config.defaultFableModel" class="preview-item"><span class="preview-label">FABLE_MODEL</span><span class="preview-value">{{ config.defaultFableModel }}</span></div>
      <div v-if="config.subagentModel" class="preview-item"><span class="preview-label">SUBAGENT_MODEL</span><span class="preview-value">{{ config.subagentModel }}</span></div>
      <template v-if="config.extraFields && config.extraFields.length">
        <div class="preview-divider"></div>
        <div class="preview-subtitle">{{ t('claude.preview.extraFields') }}</div>
        <div v-for="(field, idx) in config.extraFields" :key="idx" class="preview-item">
          <span class="preview-label">{{ field.key }}</span>
          <span class="preview-value">{{ field.value }}</span>
        </div>
      </template>
    </div>
  </Dialog>
</template>
