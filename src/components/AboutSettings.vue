<script setup>
import { useI18n } from 'vue-i18n'
import { LogoGithubIcon } from 'tdesign-icons-vue-next'
import { useAppUpdate } from '../composables/useAppUpdate'

// 设置弹窗「关于」页签：插件 logo + 客户端版本（构建时由 vite define 注入）+ GitHub 入口
// + 桌面版更新（自动检查提示 → 手动下载 → 重启安装）
const { t } = useI18n()
const ASSET_BASE = import.meta.env.BASE_URL
const version = __APP_VERSION__
const GITHUB_URL = 'https://github.com/ShaneLevs/CCConfig'

const {
  isDesktop,
  hasUpdate,
  state: updateState,
  percent,
  statusText,
  actionText,
  showAction,
  check,
  install,
  restart,
} = useAppUpdate()

const openGithub = () => {
  window.utools?.shellOpenExternal?.(GITHUB_URL)
}

const handleUpdateAction = () => {
  if (updateState.value === 'ready') restart()
  else if (updateState.value === 'available') install()
  else check()
}
</script>

<template>
  <div class="about">
    <img class="about-logo" :src="`${ASSET_BASE}logo.png`" alt="CCConfig logo" />
    <div class="about-name">CCConfig</div>
    <div class="about-version">v{{ version }}</div>
    <div class="about-desc">{{ t('settings.about.desc') }}</div>
    <button type="button" class="about-github" @click="openGithub">
      <LogoGithubIcon />
      <span class="about-github__text">ShaneLevs/CCConfig</span>
    </button>

    <div v-if="isDesktop" class="about-update">
      <span v-if="hasUpdate" class="about-update__dot" aria-hidden="true"></span>
      <div
        class="about-update__status"
        :class="{ 'about-update__status--error': updateState === 'error' }"
      >
        {{ statusText }}
      </div>
      <div v-if="updateState === 'downloading' && percent !== null" class="about-update__bar">
        <div class="about-update__bar-fill" :style="{ width: `${percent}%` }"></div>
      </div>
      <button
        v-if="showAction"
        type="button"
        class="about-update__action"
        @click="handleUpdateAction"
      >
        {{ actionText }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 内容区固定高度：整块在弹窗里垂直 + 水平居中；内容比可视区高时（矮窗口）
     min-height 让容器跟内容一起长高，滚动区域不会把顶部裁掉 */
  justify-content: center;
  box-sizing: border-box;
  min-height: 100%;
  padding: 16px 0;
  text-align: center;
}
.about-logo {
  width: 64px;
  height: 64px;
  border-radius: 14px;
  object-fit: contain;
}
.about-name {
  margin-top: 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--td-text-color-primary);
}
.about-version {
  margin-top: 4px;
  font-size: 12px;
  color: var(--td-text-color-secondary);
}
.about-desc {
  margin-top: 8px;
  max-width: 360px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--td-text-color-secondary);
}
.about-github {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 0;
  border: none;
  background: none;
  font-size: 13px;
  color: var(--td-text-color-secondary);
  cursor: pointer;
  transition: color 0.2s ease;
}
.about-github:hover {
  color: var(--td-brand-color);
}
.about-github:hover .about-github__text {
  text-decoration: underline;
}
.about-update {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 360px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--td-component-stroke);
}
.about-update__dot {
  position: absolute;
  top: 5px;
  right: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--td-error-color);
}
.about-update__status {
  font-size: 12px;
  line-height: 1.5;
  color: var(--td-text-color-secondary);
}
.about-update__status--error {
  color: var(--td-error-color);
}
.about-update__bar {
  width: 200px;
  height: 4px;
  margin-top: 8px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--td-component-stroke);
}
.about-update__bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--td-brand-color);
  transition: width 0.2s ease;
}
.about-update__action {
  margin-top: 8px;
  padding: 4px 12px;
  border: 1px solid var(--td-component-stroke);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  color: var(--td-brand-color);
  cursor: pointer;
  transition: background-color 0.2s ease;
}
.about-update__action:hover {
  background: var(--td-bg-color-container-hover);
}
</style>
