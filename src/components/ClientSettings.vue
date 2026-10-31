<script setup>
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Switch } from 'tdesign-vue-next'

// 设置弹窗「客户端」页签：只在桌面版显示。
// 开机自启状态以系统里的实际注册项为准（macOS LaunchAgent / Windows HKCU Run），
// 不额外写 DB，避免用户在系统设置里手动改过后界面与真实状态不一致。
const { t } = useI18n()

const enabled = ref(false)
const loading = ref(true)
const saving = ref(false)
const error = ref('')

// Codex 安装检测：实际问题可能是「CLI 未安装」，也可能只是 GUI 启动时 PATH 不完整。
// 服务层会实际执行 codex --version，并返回安装形态与版本；用户可主动重新检测。
const codexInstall = ref(null)
const checkingCodex = ref(false)

const invoke = (cmd, args) => {
  const internals = window.__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') {
    return Promise.reject(new Error('tauri invoke unavailable'))
  }
  return internals.invoke(cmd, args || {})
}

const checkCodex = async () => {
  checkingCodex.value = true
  try {
    if (window.services?.getAgentInstallInfo) {
      const list = await window.services.getAgentInstallInfo({ force: true })
      codexInstall.value = list?.codex || { installed: false, version: '', forms: {} }
    }
  } catch (e) {
    console.error('Codex install check failed:', e)
    codexInstall.value = { installed: false, version: '', forms: {}, error: true }
  } finally {
    checkingCodex.value = false
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
  checkCodex()
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
    <div class="settings-divider"></div>
    <div class="settings-row">
      <div class="settings-label">
        <div class="settings-title">{{ t('settings.client.codex.title') }}</div>
        <div class="settings-desc">
          <template v-if="checkingCodex">{{ t('settings.client.codex.checking') }}</template>
          <template v-else-if="codexInstall?.installed">
            {{ t('settings.client.codex.installed') }}<template v-if="codexInstall.version"> · v{{ codexInstall.version }}</template>
          </template>
          <template v-else>{{ t('settings.client.codex.notInstalled') }}</template>
        </div>
      </div>
      <Button size="small" variant="outline" :loading="checkingCodex" @click="checkCodex">
        {{ t('settings.client.codex.recheck') }}
      </Button>
    </div>
    <div v-if="codexInstall?.error" class="settings-error">{{ t('settings.client.codex.failed') }}</div>
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
