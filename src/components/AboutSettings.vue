<script setup>
import { useI18n } from 'vue-i18n'
import { LogoGithubIcon } from 'tdesign-icons-vue-next'

// 设置弹窗「关于」页签：插件 logo + 客户端版本（构建时由 vite define 注入）+ GitHub 入口
const { t } = useI18n()
const ASSET_BASE = import.meta.env.BASE_URL
const version = __APP_VERSION__
const GITHUB_URL = 'https://github.com/ShaneLevs/CCConfig'

const openGithub = () => {
  window.utools?.shellOpenExternal?.(GITHUB_URL)
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
</style>
