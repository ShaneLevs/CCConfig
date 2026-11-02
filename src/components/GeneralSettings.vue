<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Select, Option, RadioGroup, RadioButton } from 'tdesign-vue-next'
import { useLocale } from '../composables/useLocale'
import { useAppearance } from '../composables/useAppearance'
import { useUnitFormat } from '../composables/useUnitFormat'

// 设置弹窗「通用」页签：语言 + 主题模式 + 统计单位 + 深色背景特效（都用下拉 / 单选，避免一排按钮占宽）
const { t } = useI18n()
const { preference, setPreference } = useLocale()
const { themeMode, setThemeMode, backgroundEffect, setBackgroundEffect } = useAppearance()
const { unitMode, setUnitMode } = useUnitFormat()

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

const unitOptions = computed(() => [
  { label: t('settings.statsUnit.compact'), value: 'compact' },
  { label: t('settings.statsUnit.cn'), value: 'cn' },
])

// 五项：关闭 + 四种特效；说明放进每个下拉选项里（label 只用于输入框展示）
const backgroundOptions = computed(() => [
  {
    label: t('appearance.effects.none.name'),
    desc: t('appearance.effects.none.desc'),
    value: 'none',
  },
  {
    label: t('appearance.effects.prismatic.name'),
    desc: t('appearance.effects.prismatic.desc'),
    value: 'prismatic',
  },
  {
    label: t('appearance.effects.pixel.name'),
    desc: t('appearance.effects.pixel.desc'),
    value: 'pixel',
  },
  {
    label: t('appearance.effects.aurora.name'),
    desc: t('appearance.effects.aurora.desc'),
    value: 'aurora',
  },
  {
    label: t('appearance.effects.galaxy.name'),
    desc: t('appearance.effects.galaxy.desc'),
    value: 'galaxy',
  },
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

    <div class="settings-divider" />

    <div class="settings-row">
      <div class="settings-label">
        <div class="settings-title">{{ t('settings.statsUnit.title') }}</div>
        <div class="settings-desc">{{ t('settings.statsUnit.desc') }}</div>
      </div>
      <RadioGroup
        class="settings-unit-radio"
        :value="unitMode"
        variant="default-filled"
        size="small"
        @change="setUnitMode"
      >
        <RadioButton v-for="opt in unitOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </RadioButton>
      </RadioGroup>
    </div>

    <div class="settings-divider" />

    <div class="settings-row">
      <div class="settings-label">
        <div class="settings-title">{{ t('appearance.effects.title') }}</div>
        <div class="settings-desc">{{ t('appearance.effects.desc') }}</div>
      </div>
      <Select
        class="settings-select settings-select--effect"
        :value="backgroundEffect"
        :popup-props="{ overlayInnerStyle: { minWidth: '280px' } }"
        @change="setBackgroundEffect"
      >
        <Option
          v-for="opt in backgroundOptions"
          :key="opt.value"
          :value="opt.value"
          :label="opt.label"
        >
          <div class="effect-option">
            <div class="effect-option__name">{{ opt.label }}</div>
            <div class="effect-option__desc">{{ opt.desc }}</div>
          </div>
        </Option>
      </Select>
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
.settings-unit-radio {
  flex-shrink: 0;
}
.settings-divider {
  height: 1px;
  background: var(--td-component-border);
  margin: 14px 0;
}
.settings-select--effect {
  width: 200px;
}
.effect-option {
  padding: 5px 0;
  white-space: normal;
}
.effect-option__name {
  font-size: 14px;
  color: var(--td-text-color-primary);
}
.effect-option__desc {
  font-size: 12px;
  color: var(--td-text-color-secondary);
  margin-top: 2px;
  line-height: 1.4;
  white-space: normal;
}
/* Switch 暗色修复已收敛至 main.css 全局块（scoped 里写 :root 永不命中） */
</style>
