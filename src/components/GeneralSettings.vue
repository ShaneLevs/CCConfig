<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Select, Switch, RadioGroup, RadioButton } from 'tdesign-vue-next'
import { useLocale } from '../composables/useLocale'
import { useAppearance } from '../composables/useAppearance'
import { useUnitFormat } from '../composables/useUnitFormat'

// 设置弹窗「通用」页签：语言 + 主题模式 + 统计单位 + 深色背景特效（都用下拉 / 开关 / 单选，避免一排按钮占宽）
const { t } = useI18n()
const { preference, setPreference } = useLocale()
const { themeMode, setThemeMode, darkBackgroundEnabled, setDarkBackground, darkEffect, setDarkEffect } =
  useAppearance()
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
      <Switch :model-value="darkBackgroundEnabled" @change="setDarkBackground" />
    </div>
    <div class="effect-cards" :class="{ 'effect-cards--disabled': !darkBackgroundEnabled }">
      <div
        class="effect-card"
        :class="{ 'effect-card--active': darkEffect === 'prismatic' }"
        @click="darkBackgroundEnabled && setDarkEffect('prismatic')"
      >
        <div class="effect-card__name">{{ t('appearance.effects.prismatic.name') }}</div>
        <div class="effect-card__desc">{{ t('appearance.effects.prismatic.desc') }}</div>
      </div>
      <div
        class="effect-card"
        :class="{ 'effect-card--active': darkEffect === 'pixel' }"
        @click="darkBackgroundEnabled && setDarkEffect('pixel')"
      >
        <div class="effect-card__name">{{ t('appearance.effects.pixel.name') }}</div>
        <div class="effect-card__desc">{{ t('appearance.effects.pixel.desc') }}</div>
      </div>
      <div
        class="effect-card"
        :class="{ 'effect-card--active': darkEffect === 'aurora' }"
        @click="darkBackgroundEnabled && setDarkEffect('aurora')"
      >
        <div class="effect-card__name">{{ t('appearance.effects.aurora.name') }}</div>
        <div class="effect-card__desc">{{ t('appearance.effects.aurora.desc') }}</div>
      </div>
      <div
        class="effect-card"
        :class="{ 'effect-card--active': darkEffect === 'galaxy' }"
        @click="darkBackgroundEnabled && setDarkEffect('galaxy')"
      >
        <div class="effect-card__name">{{ t('appearance.effects.galaxy.name') }}</div>
        <div class="effect-card__desc">{{ t('appearance.effects.galaxy.desc') }}</div>
      </div>
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
.effect-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.effect-card {
  flex: 1 1 calc(50% - 5px);
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--td-component-border);
  border-radius: var(--td-radius-default);
  background-color: var(--td-bg-color-container);
  cursor: pointer;
  transition:
    border-color 0.2s,
    background-color 0.2s,
    box-shadow 0.2s;
  user-select: none;
}
.effect-card:hover {
  border-color: var(--td-brand-color);
}
.effect-card--active {
  border-color: var(--td-brand-color);
  background-color: var(--td-brand-color-light);
  box-shadow: 0 0 0 1px var(--td-brand-color) inset;
}
.effect-card__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--td-text-color-primary);
}
.effect-card__desc {
  font-size: 12px;
  color: var(--td-text-color-secondary);
  margin-top: 2px;
}
.effect-cards--disabled .effect-card {
  opacity: 0.5;
  cursor: not-allowed;
}
.effect-cards--disabled .effect-card:hover {
  border-color: var(--td-component-border);
}
/* Switch 暗色修复已收敛至 main.css 全局块（scoped 里写 :root 永不命中） */
</style>
