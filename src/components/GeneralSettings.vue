<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Select } from 'tdesign-vue-next'
import { useLocale } from '../composables/useLocale'
import { useAppearance } from '../composables/useAppearance'

// 设置弹窗「通用」页签：语言 + 主题模式（都用下拉，避免一排按钮占宽）
const { t } = useI18n()
const { preference, setPreference } = useLocale()
const { themeMode, setThemeMode } = useAppearance()

const languageOptions = computed(() => [
  { label: t('settings.language.system'), value: 'system' },
  { label: t('settings.language.zhCN'), value: 'zh-CN' },
  { label: t('settings.language.enUS'), value: 'en-US' },
])

const themeOptions = computed(() => [
  { label: t('appearance.theme.system'), value: 'system' },
  { label: t('appearance.theme.light'), value: 'light' },
  { label: t('appearance.theme.dark'), value: 'dark' },
])
</script>

<template>
  <div class="general-settings">
    <div class="settings-row">
      <div class="settings-label">
        <div class="settings-title">{{ t('settings.language.title') }}</div>
        <div class="settings-desc">{{ t('settings.language.desc') }}</div>
      </div>
      <Select
        class="settings-select"
        :value="preference"
        :options="languageOptions"
        @change="setPreference"
      />
    </div>

    <div class="settings-divider" />

    <div class="settings-row">
      <div class="settings-label">
        <div class="settings-title">{{ t('appearance.theme.title') }}</div>
        <div class="settings-desc">{{ t('appearance.theme.desc') }}</div>
      </div>
      <Select
        class="settings-select"
        :value="themeMode"
        :options="themeOptions"
        @change="setThemeMode"
      />
    </div>
  </div>
</template>

<style scoped>
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
}
.settings-label {
  flex: 1;
  min-width: 0;
}
.settings-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--td-text-color-primary);
}
.settings-desc {
  font-size: 12px;
  color: var(--td-text-color-secondary);
  margin-top: 2px;
  line-height: 1.5;
}
.settings-select {
  width: 176px;
  flex-shrink: 0;
}
.settings-divider {
  height: 1px;
  background: var(--td-component-border);
  margin: 14px 0;
}
</style>
