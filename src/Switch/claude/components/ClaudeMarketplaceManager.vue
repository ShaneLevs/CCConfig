<script setup>
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Card, Empty, Button, Dialog, Input, MessagePlugin, Space, Tag, Popconfirm, Tooltip } from "tdesign-vue-next";
import { AddIcon, DeleteIcon, RefreshIcon } from "tdesign-icons-vue-next";
import { formatSource } from "./pluginMeta";

// claude 插件页 Marketplace 仓库管理（含添加仓库弹窗）：列表展示 + 添加/更新/移除。
// 组件自持仓库数据（挂载时加载）；仓库元数据变化后经 changed 通知父级刷新插件列表。
const emit = defineEmits(["changed", "loaded"]);

const { t } = useI18n();

const marketplaces = ref([]);
const newMarketplaceSource = ref("");
const showAddDialog = ref(false);
// 本区块独立的操作 loading（键与父级 operationLoading 空间不同，互不冲突）
const mpLoading = ref(null);

const loadMarketplaces = () => {
  try {
    marketplaces.value = window.services.listMarketplaces();
  } catch (e) {
    console.error("加载 marketplace 失败:", e);
  }
  emit("loaded", marketplaces.value.length);
};

const handleAddMarketplace = async () => {
  const source = newMarketplaceSource.value.trim();
  if (!source) return;
  mpLoading.value = "__marketplace_add";
  try {
    const result = window.services.addMarketplace(source);
    if (result.success) {
      MessagePlugin.success(t("claude.marketplace.added"));
      newMarketplaceSource.value = "";
      showAddDialog.value = false;
      loadMarketplaces();
      emit("changed");
    } else {
      MessagePlugin.error(result.message || t("common.addFailed"));
    }
  } catch (e) {
    MessagePlugin.error(t("claude.marketplace.addError", { message: e.message }));
  } finally {
    mpLoading.value = null;
  }
};

const handleRemoveMarketplace = (name) => {
  mpLoading.value = `__mp_${name}`;
  try {
    const result = window.services.removeMarketplace(name);
    if (result.success) {
      MessagePlugin.success(t("claude.marketplace.removed", { name }));
      loadMarketplaces();
      emit("changed");
    } else {
      MessagePlugin.error(result.message || t("claude.marketplace.removeFailed"));
    }
  } catch (e) {
    MessagePlugin.error(t("claude.marketplace.removeError", { message: e.message }));
  } finally {
    mpLoading.value = null;
  }
};

const handleUpdateMarketplace = (name) => {
  mpLoading.value = `__mp_update_${name}`;
  try {
    const result = window.services.updateMarketplace(name);
    if (result.success) {
      MessagePlugin.success(t("claude.marketplace.updated", { name }));
      loadMarketplaces();
      emit("changed");
    } else {
      MessagePlugin.error(result.message || t("common.updateFailed"));
    }
  } catch (e) {
    MessagePlugin.error(t("claude.marketplace.updateError", { message: e.message }));
  } finally {
    mpLoading.value = null;
  }
};

defineExpose({ loadMarketplaces });
onMounted(loadMarketplaces);
</script>

<template>
  <div class="section-header">
    <Tooltip :content="t('claude.marketplace.addTooltip')" placement="top">
      <Button size="small" theme="primary" @click="showAddDialog = true">
        <template #icon><AddIcon /></template> {{ t('claude.marketplace.add') }}
      </Button>
    </Tooltip>
  </div>

  <div v-if="marketplaces.length === 0" class="empty-state">
    <Empty :description="t('claude.marketplace.empty')" />
  </div>

  <div v-else class="marketplace-list">
    <Card
      v-for="mp in marketplaces"
      :key="mp.name"
      :bordered="true"
      class="mp-card"
      hover
    >
      <template #header>
        <div class="mp-header">
          <span class="mp-name">{{ mp.name }}</span>
          <Space size="small">
            <Tag size="small" variant="light">{{ t('claude.marketplace.pluginCount', { count: mp.pluginCount }) }}</Tag>
          </Space>
        </div>
      </template>
      <div class="mp-body">
        <div class="mp-info">
          <span class="mp-label">{{ t('claude.marketplace.source') }}</span>
          <span class="mp-value">{{ formatSource(mp.source) }}</span>
        </div>
        <div class="mp-info">
          <span class="mp-label">{{ t('claude.marketplace.localPath') }}</span>
          <span class="mp-value mono">{{ mp.installLocation }}</span>
        </div>
        <div v-if="mp.lastUpdated" class="mp-info">
          <span class="mp-label">{{ t('claude.marketplace.lastUpdated') }}</span>
          <span class="mp-value">{{ new Date(mp.lastUpdated).toLocaleString() }}</span>
        </div>
      </div>
      <template #actions>
        <Space size="small">
          <Tooltip :content="t('claude.marketplace.updateTooltip')" placement="top">
            <Button
              size="small"
              variant="outline"
              :loading="mpLoading === `__mp_update_${mp.name}`"
              @click="handleUpdateMarketplace(mp.name)"
            >
              <template #icon><RefreshIcon /></template> {{ t('claude.marketplace.update') }}
            </Button>
          </Tooltip>
          <Popconfirm
            theme="danger"
            :content="t('claude.marketplace.removeConfirm', { name: mp.name })"
            @confirm="handleRemoveMarketplace(mp.name)"
          >
            <Tooltip :content="t('claude.marketplace.removeTooltip')" placement="top">
              <Button
                size="small"
                theme="danger"
                variant="outline"
                :loading="mpLoading === `__mp_${mp.name}`"
              >
                <template #icon><DeleteIcon /></template> {{ t('claude.marketplace.remove') }}
              </Button>
            </Tooltip>
          </Popconfirm>
        </Space>
      </template>
    </Card>
  </div>

  <!-- 添加仓库弹窗 -->
  <Dialog
    v-model:visible="showAddDialog"
    :header="t('claude.marketplace.addTitle')"
    width="480px"
    :confirm-btn="{
      content: t('common.add'),
      loading: mpLoading === '__marketplace_add',
      theme: 'primary',
      disabled: !newMarketplaceSource.trim(),
    }"
    @confirm="handleAddMarketplace"
  >
    <div class="plugin-add-form">
      <div class="plugin-form-item">
        <label>{{ t('claude.marketplace.sourceLabel') }}</label>
        <Input
          v-model="newMarketplaceSource"
          :placeholder="t('claude.marketplace.sourcePlaceholder')"
        />
      </div>
      <div class="plugin-form-hint">
        {{ t('claude.marketplace.supportedFormats') }}<br />
        • <code>https://github.com/user/repo.git</code><br />
        • <code>owner/repo</code>{{ t('claude.marketplace.githubShort') }}<br />
        • <code>/path/to/local/marketplace</code>{{ t('claude.marketplace.localPathHint') }}
      </div>
    </div>
  </Dialog>
</template>
