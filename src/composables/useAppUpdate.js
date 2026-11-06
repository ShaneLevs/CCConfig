import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

// 设置 → 关于 → 自动更新（仅桌面版）。状态放模块级，供设置按钮和关于页共同使用。
const isDesktop = document.documentElement.classList.contains('is-desktop')

// idle | checking | available | latest | downloading | installing | ready | error
const state = ref('idle')
const info = ref(null)
const updateAvailable = ref(false)
const errorKey = ref('')
const failedStage = ref('')
const progress = ref({ stage: 'idle', downloaded: 0, total: null })

let pollTimer = null
let checkPromise = null

const invoke = (cmd, args) => {
  const internals = window.__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') {
    return Promise.reject(new Error('tauri invoke unavailable'))
  }
  return internals.invoke(cmd, args || {})
}

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

const pollProgress = async () => {
  try {
    const next = await invoke('get_update_progress')
    progress.value = next
    // 命令在后台完成时（例如弹窗已切走）也能从 Rust 侧状态追上最终结果
    if (next.stage === 'installing') state.value = 'installing'
    if (next.stage === 'ready') {
      updateAvailable.value = false
      state.value = 'ready'
    }
    if (next.stage === 'error') {
      errorKey.value = 'settings.about.update.installFailed'
      failedStage.value = 'install'
      state.value = 'error'
    }
  } catch (e) {
    console.error('get_update_progress failed:', e)
  }
}

const startPolling = () => {
  stopPolling()
  pollTimer = setInterval(pollProgress, 300)
}

const install = async () => {
  state.value = 'downloading'
  errorKey.value = ''
  failedStage.value = ''
  progress.value = { stage: 'downloading', downloaded: 0, total: null }
  startPolling()
  try {
    await invoke('install_update')
    updateAvailable.value = false
    state.value = 'ready'
  } catch (e) {
    console.error('install_update failed:', e)
    errorKey.value = 'settings.about.update.installFailed'
    failedStage.value = 'install'
    state.value = 'error'
  } finally {
    stopPolling()
  }
}

const runCheck = async () => {
  state.value = 'checking'
  errorKey.value = ''
  failedStage.value = ''
  const previousAvailable = updateAvailable.value
  try {
    const result = await invoke('check_update')
    info.value = result
    updateAvailable.value = Boolean(result.available)
    if (result.available) {
      // 自动检查只负责提示；下载安装由用户在「关于」页手动触发。
      state.value = 'available'
    } else {
      state.value = 'latest'
    }
  } catch (e) {
    console.error('check_update failed:', e)
    errorKey.value = 'settings.about.update.failed'
    failedStage.value = 'check'
    // 已发现新版本时，偶发联网失败不清红点；自动检查的后台错误也不打断主流程。
    updateAvailable.value = previousAvailable
    state.value = previousAvailable ? 'available' : 'error'
  } finally {
    checkPromise = null
  }
}

const check = async () => {
  if (
    !isDesktop ||
    state.value === 'downloading' ||
    state.value === 'installing' ||
    state.value === 'ready'
  ) {
    return
  }
  if (!checkPromise) checkPromise = runCheck()
  return checkPromise
}

const restart = async () => {
  try {
    await invoke('restart_app')
  } catch (e) {
    // 重启命令会让进程退出，invoke 可能以连接断开结束，这里不再提示
    console.error('restart_app failed:', e)
  }
}

export function useAppUpdate() {
  const { t } = useI18n()

  const percent = computed(() => {
    const { downloaded, total } = progress.value
    if (!total) return null
    return Math.min(100, Math.round((downloaded / total) * 100))
  })

  const statusText = computed(() => {
    switch (state.value) {
      case 'checking':
        return t('settings.about.update.checking')
      case 'available':
        return t('settings.about.update.available', {
          version: info.value?.version || '',
        })
      case 'latest':
        return t('settings.about.update.latest', {
          version: info.value?.currentVersion || __APP_VERSION__,
        })
      case 'downloading':
        return percent.value === null
          ? t('settings.about.update.downloadingUnknown')
          : t('settings.about.update.downloading', { progress: percent.value })
      case 'installing':
        return t('settings.about.update.installing')
      case 'ready':
        return t('settings.about.update.ready')
      case 'error':
        return t(errorKey.value || 'settings.about.update.failed')
      default:
        return t('settings.about.update.idle')
    }
  })

  const actionText = computed(() => {
    if (state.value === 'ready') return t('settings.about.update.restart')
    if (state.value === 'error') {
      return failedStage.value === 'install'
        ? t('settings.about.update.retryInstall')
        : t('settings.about.update.retry')
    }
    if (updateAvailable.value) return t('settings.about.update.downloadInstall')
    return t('settings.about.update.check')
  })

  const showAction = computed(() =>
    ['idle', 'available', 'latest', 'error', 'ready'].includes(state.value),
  )

  onMounted(() => {
    if (!isDesktop) return
    // 下载中切回「关于」时恢复进度轮询；检查由主窗口显示事件负责。
    if (state.value === 'downloading' || state.value === 'installing') startPolling()
  })

  onUnmounted(stopPolling)

  return {
    isDesktop,
    hasUpdate: updateAvailable,
    state,
    progress,
    percent,
    statusText,
    actionText,
    showAction,
    check,
    install,
    restart,
  }
}
