<script setup>
import { useI18n } from 'vue-i18n'
import { Switch } from 'tdesign-vue-next'
import { useAppearance } from '../composables/useAppearance'

// 设置弹窗「外观」页签：深色背景特效（主题模式已移到「通用」）
const { t } = useI18n()
const { darkBackgroundEnabled, setDarkBackground, darkEffect, setDarkEffect } = useAppearance()
</script>

<template>
  <div>
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
/* settings-* 基础类与 index.vue / AgentVisibilitySettings.vue 内各自 scoped 一份，互不影响 */
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}
.settings-label {
  flex: 1;
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
