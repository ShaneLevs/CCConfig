<script setup>
import { computed, onMounted, ref } from 'vue'
import { ConfigProvider } from 'tdesign-vue-next'
import zhConfig from 'tdesign-vue-next/es/locale/zh_CN'
import enConfig from 'tdesign-vue-next/es/locale/en_US'
import Switch from './Switch/index.vue'
import PrismaticBurst from './components/PrismaticBurst.vue'
import FaultyTerminal from './components/FaultyTerminal.vue'
import Aurora from './components/Aurora.vue'
import Galaxy from './components/Galaxy.vue'
import { useAppearance } from './composables/useAppearance'
import { useLocale } from './composables/useLocale'

const route = ref('')
const payload = ref('')

// 解析后的主题（跟随系统 / 固定浅色 / 固定深色）；特效只跟解析结果走
const { isDark, darkBackgroundEnabled, darkEffect } = useAppearance()
const { resolvedLocale } = useLocale()

const tdConfig = computed(() => (resolvedLocale.value === 'en-US' ? enConfig : zhConfig))

onMounted(() => {
  window.utools.onPluginEnter((action) => {
    route.value = action.code
    payload.value = action.payload || ''
  })
  window.utools.onPluginOut(() => {
    route.value = ''
    payload.value = ''
  })
})
</script>

<template>
  <ConfigProvider :global-config="tdConfig">
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
    <Switch v-if="['claudeConfig', 'opencodeConfig', 'piConfig', 'ompConfig', 'reasonixConfig', 'codexConfig', 'kimiConfig', 'minimaxConfig', 'qoderConfig', 'zcodeConfig', 'hermesConfig', 'dshConfig', 'grokConfig', 'clineConfig', 'commandcodeConfig', 'commonConfig', 'installClaudeSkill', 'installOpencodeSkill', 'installCommonSkill', 'installPiExtension', 'installCommandCodeSkill'].includes(route)" :route="route" :payload="payload" />
  </ConfigProvider>
</template>
