<script setup>

import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Card, Empty, Tag, Button, Tooltip, Dialog, Input, MessagePlugin, Space, Popconfirm, Loading,
} from "tdesign-vue-next";
import { RefreshIcon, AddIcon, DeleteIcon, SearchIcon } from "tdesign-icons-vue-next";
import { usePageRefresh } from "../../composables/usePageRefresh";
import "./styles/PluginView.css";

const { t } = useI18n();

const loading = ref(false);
const plugins = ref([]);
const addDialog = ref(false);
const newPluginName = ref("");

const searchResults = ref([]);
const searching = ref(false);
const searchKey = ref("opencode-plugin");
const showSearch = ref(false);

const loadPlugins = () => {
  try {
    const raw = window.services.getOpencodePlugins();
    plugins.value = raw.map(name => ({ name }));
  } catch (e) {
    console.error("加载 OpenCode 插件失败:", e);
    plugins.value = [];
  }
};

const installedNames = new Set()

const refresh = () => {
  loading.value = true;
  setTimeout(() => { loadPlugins(); loading.value = false; }, 50);
};

// 切回本页时自动刷新（页面用 v-show 保活，onMounted 不会再跑）
const { autoRefreshing } = usePageRefresh("opencode", "plugin", refresh);

const openAddDialog = () => {
  newPluginName.value = "";
  showSearch.value = false;
  searchResults.value = [];
  addDialog.value = true;
};

const installing = ref(false);

const handleAdd = async () => {
  const name = newPluginName.value.trim();
  if (!name) { MessagePlugin.warning(t('opencode.plugin.packageRequired')); return; }
  installing.value = true;
  try {
    await window.services.installOpencodePlugin(name);
    MessagePlugin.success(t('opencode.plugin.installSuccess', { name }));
    addDialog.value = false;
    loadPlugins();
  } catch (e) {
    MessagePlugin.error(t('opencode.plugin.installFailed', { message: e.stderr || e.message }));
  } finally {
    installing.value = false;
  }
};

const handleRemove = async (name) => {
  try {
    await window.services.uninstallOpencodePlugin(name);
    MessagePlugin.success(t('opencode.plugin.uninstallSuccess', { name }));
    loadPlugins();
  } catch (e) {
    MessagePlugin.error(t('opencode.plugin.uninstallFailed', { message: e.stderr || e.message }));
  }
};

const doSearch = async () => {
  if (!searchKey.value.trim()) return
  searching.value = true
  try {
    searchResults.value = await window.services.searchOpencodePlugins(searchKey.value.trim())
  } catch (e) {
    MessagePlugin.error(t('opencode.plugin.searchFailed', { message: e.message }))
  } finally {
    searching.value = false
  }
}

const pickPlugin = (name) => {
  newPluginName.value = name
  searchResults.value = []
  showSearch.value = false
}

onMounted(refresh);

</script>

<template>
  <div class="oc-plugin-container">
    <div class="oc-plugin-header">
      <div class="oc-plugin-header-left">
        <span class="oc-plugin-tip">{{ t("opencode.plugin.tip") }}</span>
      </div>
      <div class="oc-plugin-actions">
        <Button size="small" variant="outline" @click="openAddDialog">
          <template #icon><AddIcon /></template> {{ t("opencode.plugin.add") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading || autoRefreshing" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="plugins.length === 0" class="oc-plugin-empty">
      <Empty :description="t('opencode.plugin.empty')">
        <template #action>
          <Button size="small" theme="primary" @click="openAddDialog">
            <template #icon><AddIcon /></template> {{ t("opencode.plugin.add") }}
          </Button>
        </template>
      </Empty>
    </div>

    <div v-else class="oc-plugin-list">
      <Card v-for="p in plugins" :key="p.name" :bordered="true">
        <template #header>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div class="oc-plugin-card-header">
              <span class="oc-plugin-name mono">{{ p.name }}</span>
              <Tag size="small" variant="light" theme="success">{{ t("opencode.plugin.installed") }}</Tag>
            </div>
            <Space size="small">
              <Popconfirm :content="t('opencode.plugin.uninstallConfirm')" @confirm="handleRemove(p.name)">
                <Button size="small" variant="text" theme="danger">
                  <template #icon><DeleteIcon /></template>
                </Button>
              </Popconfirm>
            </Space>
          </div>
        </template>
        <div class="oc-plugin-card-body">
          <div class="oc-plugin-info-row">
            <span class="oc-plugin-label">{{ t("opencode.plugin.source") }}</span>
            <span class="oc-plugin-value">{{ t("opencode.plugin.npmPackage") }}</span>
          </div>
        </div>
      </Card>
    </div>

    <Dialog
      v-model:visible="addDialog"
      :header="t('opencode.plugin.installTitle')"
      width="520px"
      dialogClassName="oc-install-dialog"
      :confirm-btn="{ content: installing ? t('opencode.plugin.installing') : t('opencode.plugin.install'), theme: 'primary', loading: installing }"
      :on-confirm="handleAdd"
    >
      <div style="display:flex;flex-direction:column;gap:8px;">
        <label style="font-size:13px;color:var(--td-text-color-secondary);">{{ t("opencode.plugin.packageName") }}</label>
        <Input v-model="newPluginName" :placeholder="t('opencode.plugin.packageNamePlaceholder')" :disabled="installing" />

        <div v-if="!showSearch" style="margin-top: 4px;">
          <Button size="small" variant="text" theme="primary" @click="showSearch = true; doSearch()">
            <template #icon><SearchIcon /></template> {{ t("opencode.plugin.searchAvailable") }}
          </Button>
        </div>

        <template v-if="showSearch">
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
            <Input v-model="searchKey" size="small" :placeholder="t('opencode.plugin.searchKeyword')" @keyup.enter="doSearch" />
            <Button size="small" variant="outline" :loading="searching" @click="doSearch">{{ t("opencode.plugin.search") }}</Button>
          </div>
          <div v-if="searching" style="text-align:center;padding:16px;"><Loading /></div>
          <div v-else-if="searchResults.length > 0" class="oc-search-list">
            <div
              v-for="pkg in searchResults"
              :key="pkg.name"
              class="oc-search-item"
              @click="pickPlugin(pkg.name)"
            >
              <div class="oc-search-item-name">{{ pkg.name }}
                <Tag size="small" variant="light" theme="primary" style="margin-left:6px;">{{ pkg.version }}</Tag>
              </div>
              <div class="oc-search-item-desc">{{ pkg.description || t('skill.noDescription') }}</div>
            </div>
          </div>
          <div v-else-if="!searching" style="text-align:center;padding:16px;color:var(--td-text-color-placeholder);font-size:13px;">
            {{ t("opencode.plugin.noMatch") }}
          </div>
        </template>

        <div style="font-size:12px;color:var(--td-text-color-placeholder);margin-top:4px;">
          {{ t("opencode.plugin.autoInstallHintPrefix") }}<code>npm install</code>{{ t("opencode.plugin.autoInstallHintSuffix") }}
        </div>
      </div>
    </Dialog>
  </div>
</template>
