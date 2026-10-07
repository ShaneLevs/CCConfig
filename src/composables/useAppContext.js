import { ref, computed } from 'vue'

const activeApp = ref('claude')

export function useAppContext() {
  const setActiveApp = (app) => {
    activeApp.value = app
  }

  const isClaude = computed(() => activeApp.value === 'claude')
  const isOpenCode = computed(() => activeApp.value === 'opencode')
  const isPi = computed(() => activeApp.value === 'pi')
  const isOmp = computed(() => activeApp.value === 'omp')
  const isReasonix = computed(() => activeApp.value === 'reasonix')
  const isCodex = computed(() => activeApp.value === 'codex')
  const isKimi = computed(() => activeApp.value === 'kimi')
  const isMinimax = computed(() => activeApp.value === 'minimax')
  const isQoder = computed(() => activeApp.value === 'qoder')
  const isZcode = computed(() => activeApp.value === 'zcode')
  const isHermes = computed(() => activeApp.value === 'hermes')
  const isCommon = computed(() => activeApp.value === 'common')

  return { activeApp, setActiveApp, isClaude, isOpenCode, isPi, isOmp, isReasonix, isCodex, isKimi, isMinimax, isQoder, isZcode, isHermes, isCommon }
}
