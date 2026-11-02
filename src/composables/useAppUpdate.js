import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

// 设置 → 关于 → 自动更新（仅桌面版）。
// 状态放在模块级：设置弹窗切走再切回时组件会重建，下载进度不能跟着丢。
const isDesktop = document.documentElement.classList.contains('is-desktop')

// idle | checking | latest | downloading | installing | ready | error
const state = ref('idle')
const info = ref(null)
const errorKey = ref('')
const progress = ref({ stage: 'idle', downloaded: 0, total: null })

let started = false
let mountedCount = 0
let pollTimer = null

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
    if (next.stage === 'ready') state.value = 'ready'
    if (next.stage === 'error') {
      errorKey.value = 'settings.about.update.installFailed'
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
  progress.value = { stage: 'downloading', downloaded: 0, total: null }
  startPolling()
  try {
    await invoke('install_update')
    state.value = 'ready'
  } catch (e) {
    console.error('install_update failed:', e)
    errorKey.value = 'settings.about.update.installFailed'
    state.value = 'error'
  } finally {
    stopPolling()
  }
}

const check = async () => {
  if (!isDesktop || state.value === 'checking' || state.value === 'downloading' || state.value === 'installing') {
    return
  }
  state.value = 'checking'
  errorKey.value = ''
  try {
    const result = await invoke('check_update')
    info.value = result
    if (result.available) {
      // 发现新版本后直接开始下载，用户只需在完成后重启
      await install()
    } else {
      state.value = 'latest'
    }
  } catch (e) {
    console.error('check_update failed:', e)
    errorKey.value = 'settings.about.update.failed'
    state.value = 'error'
  }
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
    if (state.value === 'error') return t('settings.about.update.retry')
    return t('settings.about.update.check')
  })

  const showAction = computed(() =>
    ['idle', 'latest', 'error', 'ready'].includes(state.value),
  )

  onMounted(() => {
    mountedCount += 1
    if (!isDesktop) return
    // 弹窗切走时轮询会停；回到「关于」继续跟踪同一个后台下载
    if (state.value === 'downloading' || state.value === 'installing') {
      startPolling()
    } else if (!started) {
      started = true
      check()
    }
  })

  onUnmounted(() => {
    mountedCount = Math.max(0, mountedCount - 1)
    if (mountedCount === 0) stopPolling()
  })

  return {
    isDesktop,
    state,
    progress,
    percent,
    statusText,
    actionText,
    showAction,
    check,
    restart,
  }
}
