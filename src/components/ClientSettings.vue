<script setup>
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Switch } from 'tdesign-vue-next'

// 设置弹窗「客户端」页签：只在桌面版显示。
// 开机自启状态以系统里的实际注册项为准（macOS LaunchAgent / Windows HKCU Run），
// 不额外写 DB，避免用户在系统设置里手动改过后界面与真实状态不一致。
const { t } = useI18n()

const enabled = ref(false)
const loading = ref(true)
const saving = ref(false)
const error = ref('')

// 隐藏 Dock 图标是 macOS 专属配置；Windows 版不渲染这一行。
const isMac = /Mac/i.test(navigator.userAgent)
const hideDock = ref(false)
const dockLoading = ref(isMac)
const dockSaving = ref(false)
const dockError = ref('')

const invoke = (cmd, args) => {
  const internals = window.__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') {
    return Promise.reject(new Error('tauri invoke unavailable'))
  }
  return internals.invoke(cmd, args || {})
}

const loadDock = async () => {
  if (!isMac) return
  try {
    hideDock.value = Boolean(await invoke('get_hide_dock_icon'))
  } catch (e) {
    console.error('get_hide_dock_icon failed:', e)
    dockError.value = t('settings.client.hideDock.failed')
  } finally {
    dockLoading.value = false
  }
}

const load = async () => {
  loading.value = true
  error.value = ''
  try {
    enabled.value = Boolean(await invoke('get_autostart'))
  } catch (e) {
    console.error('get_autostart failed:', e)
    error.value = t('settings.client.autostart.failed')
  } finally {
    loading.value = false
  }
  loadDock()
}

const toggle = async (value) => {
  saving.value = true
  error.value = ''
  try {
    await invoke('set_autostart', { enabled: value })
    enabled.value = value
  } catch (e) {
    console.error('set_autostart failed:', e)
    error.value = t('settings.client.autostart.failed')
  } finally {
    saving.value = false
  }
}

const toggleDock = async (value) => {
  dockSaving.value = true
  dockError.value = ''
  try {
    await invoke('set_hide_dock_icon', { enabled: value })
    hideDock.value = value
  } catch (e) {
    console.error('set_hide_dock_icon failed:', e)
    dockError.value = t('settings.client.hideDock.failed')
  } finally {
    dockSaving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="client-settings">
    <div class="settings-row">
      <div class="settings-label">
        <div class="settings-title">{{ t('settings.client.autostart.title') }}</div>
        <div class="settings-desc">{{ t('settings.client.autostart.desc') }}</div>
      </div>
      <Switch
        :model-value="enabled"
        :loading="saving"
        :disabled="loading"
        @change="toggle"
      />
    </div>
    <div v-if="error" class="settings-error">{{ error }}</div>
    <template v-if="isMac">
      <div class="settings-divider"></div>
      <div class="settings-row">
        <div class="settings-label">
          <div class="settings-title">{{ t('settings.client.hideDock.title') }}</div>
          <div class="settings-desc">{{ t('settings.client.hideDock.desc') }}</div>
        </div>
        <Switch
          :model-value="hideDock"
          :loading="dockSaving"
          :disabled="dockLoading"
          @change="toggleDock"
        />
      </div>
      <div v-if="dockError" class="settings-error">{{ dockError }}</div>
    </template>
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
.settings-error {
  margin-top: 8px;
  font-size: 12px;
  color: var(--td-error-color);
}
.settings-divider {
  height: 1px;
  background: var(--td-component-stroke);
  margin: 8px 0;
}
</style>
