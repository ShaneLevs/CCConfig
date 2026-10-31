<script setup>
// Codex 统计页：复用通用统计页，重统计走后台线程，进入页面先展示落库历史。
import { useI18n } from 'vue-i18n'
import UsagePage from '../shared/UsagePage.vue'

const { t } = useI18n()

const fetcher = () => window.services.readCodexUsageAsync()
const quickFetcher = () => window.services.readAgentUsageFromHistory('codex')
</script>

<template>
  <UsagePage
    page-app="codex"
    :tip="t('codex.usage.tip')"
    :fetcher="fetcher"
    :quick-fetcher="quickFetcher"
    :empty-description="t('codex.usage.emptyDescription')"
  />
</template>
