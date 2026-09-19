<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import Switch from './Switch/index.vue'
import PrismaticBurst from './components/PrismaticBurst.vue'
import FaultyTerminal from './components/FaultyTerminal.vue'
import Aurora from './components/Aurora.vue'
import Galaxy from './components/Galaxy.vue'
import { useDarkBackground } from './composables/useDarkBackground'

const route = ref('')
const payload = ref('')
const isDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)
const { darkBackgroundEnabled, darkEffect } = useDarkBackground()

// 特效开启时恢复深色实底色，让 WebGL canvas（含 mix-blend）在原有底上合成；关闭时回到纯玻璃背景
watch([isDark, darkBackgroundEnabled], () => {
  document.documentElement.classList.toggle('effect-active', isDark.value && darkBackgroundEnabled.value)
}, { immediate: true })

let darkQuery
onMounted(() => {
  darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
  isDark.value = darkQuery.matches
  darkQuery.addEventListener('change', (e) => { isDark.value = e.matches })

  window.utools.onPluginEnter((action) => {
    route.value = action.code
    payload.value = action.payload || ''
  })
  window.utools.onPluginOut(() => {
    route.value = ''
    payload.value = ''
  })
})

onUnmounted(() => {
  if (darkQuery) darkQuery.removeEventListener('change', () => {})
})
</script>

<template>
  <PrismaticBurst
    v-if="isDark && darkBackgroundEnabled && darkEffect === 'prismatic'"
    animation-type="rotate3d"
    :intensity="1"
    :speed="0.5"
    :distort="0"
    :paused="false"
    :offset="{ x: 0, y: 0 }"
    :hover-dampness="0.25"
    :ray-count="0"
    mix-blend-mode="lighten"
    :colors="['#a7a7a7', '#656565', '#000000']"
  />
  <FaultyTerminal
    v-if="isDark && darkBackgroundEnabled && darkEffect === 'pixel'"
    :scale="2.4"
    :grid-mul="[2, 1]"
    :digit-size="3"
    :time-scale="0.5"
    :pause="false"
    :scanline-intensity="0.1"
    :glitch-amount="1"
    :flicker-amount="1"
    :noise-amp="1"
    :chromatic-aberration="0"
    :dither="0"
    :curvature="0.1"
    tint="#595959"
    :mouse-react="false"
    :mouse-strength="0.5"
    :page-load-animation="false"
    :brightness="1"
  />
  <Aurora
    v-if="isDark && darkBackgroundEnabled && darkEffect === 'aurora'"
    :color-stops="['#898989', '#141414', '#7e7e7e']"
    :blend="0.5"
    :speed="1"
  />
  <Galaxy
    v-if="isDark && darkBackgroundEnabled && darkEffect === 'galaxy'"
    :transparent="false"
    :mouse-interaction="false"
  />
  <Switch v-if="['claudeConfig', 'opencodeConfig', 'piConfig', 'ompConfig', 'reasonixConfig', 'codexConfig', 'kimiConfig', 'commonConfig', 'installClaudeSkill', 'installOpencodeSkill', 'installCommonSkill', 'installPiExtension'].includes(route)" :route="route" :payload="payload" />
</template>
