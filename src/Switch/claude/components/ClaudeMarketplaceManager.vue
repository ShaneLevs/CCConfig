<script setup>
import { ref, onMounted } from "vue";
import { Card, Empty, Button, Dialog, Input, MessagePlugin, Space, Tag, Popconfirm, Tooltip } from "tdesign-vue-next";
import { AddIcon, DeleteIcon, RefreshIcon } from "tdesign-icons-vue-next";
import { formatSource } from "./pluginMeta";

// claude 插件页 Marketplace 仓库管理（含添加仓库弹窗）：列表展示 + 添加/更新/移除。
// 组件自持仓库数据（挂载时加载）；仓库元数据变化后经 changed 通知父级刷新插件列表。
const emit = defineEmits(["changed", "loaded"]);

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
      MessagePlugin.success("仓库添加成功");
      newMarketplaceSource.value = "";
      showAddDialog.value = false;
      loadMarketplaces();
      emit("changed");
    } else {
      MessagePlugin.error(result.message || "添加失败");
    }
  } catch (e) {
    MessagePlugin.error("添加仓库失败: " + e.message);
  } finally {
    mpLoading.value = null;
  }
};

const handleRemoveMarketplace = (name) => {
  mpLoading.value = `__mp_${name}`;
  try {
    const result = window.services.removeMarketplace(name);
    if (result.success) {
      MessagePlugin.success(`已移除仓库 "${name}"`);
      loadMarketplaces();
      emit("changed");
    } else {
      MessagePlugin.error(result.message || "移除失败");
    }
  } catch (e) {
    MessagePlugin.error("移除仓库失败: " + e.message);
  } finally {
    mpLoading.value = null;
  }
};

const handleUpdateMarketplace = (name) => {
  mpLoading.value = `__mp_update_${name}`;
  try {
    const result = window.services.updateMarketplace(name);
    if (result.success) {
      MessagePlugin.success(`仓库 "${name}" 更新成功`);
      loadMarketplaces();
      emit("changed");
    } else {
      MessagePlugin.error(result.message || "更新失败");
    }
  } catch (e) {
    MessagePlugin.error("更新仓库失败: " + e.message);
  } finally {
    mpLoading.value = null;
  }
};

defineExpose({ loadMarketplaces });
onMounted(loadMarketplaces);
</script>

<template>
  <div class="section-header">
    <Tooltip content="添加新的 Marketplace 仓库" placement="top">
      <Button size="small" theme="primary" @click="showAddDialog = true">
        <template #icon><AddIcon /></template> 添加仓库
      </Button>
    </Tooltip>
  </div>

  <div v-if="marketplaces.length === 0" class="empty-state">
    <Empty description="暂无已注册的 Marketplace 仓库" />
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
            <Tag size="small" variant="light">{{ mp.pluginCount }} 个插件</Tag>
          </Space>
        </div>
      </template>
      <div class="mp-body">
        <div class="mp-info">
          <span class="mp-label">来源</span>
          <span class="mp-value">{{ formatSource(mp.source) }}</span>
        </div>
        <div class="mp-info">
          <span class="mp-label">本地路径</span>
          <span class="mp-value mono">{{ mp.installLocation }}</span>
        </div>
        <div v-if="mp.lastUpdated" class="mp-info">
          <span class="mp-label">最后更新</span>
          <span class="mp-value">{{ new Date(mp.lastUpdated).toLocaleString() }}</span>
        </div>
      </div>
      <template #actions>
        <Space size="small">
          <Tooltip content="更新仓库元数据" placement="top">
            <Button
              size="small"
              variant="outline"
              :loading="mpLoading === `__mp_update_${mp.name}`"
              @click="handleUpdateMarketplace(mp.name)"
            >
              <template #icon><RefreshIcon /></template> 更新
            </Button>
          </Tooltip>
          <Popconfirm
            theme="danger"
            :content="'确认移除仓库 ' + mp.name + '？已安装的插件不受影响。'"
            @confirm="handleRemoveMarketplace(mp.name)"
          >
            <Tooltip content="移除此仓库（已安装插件不受影响）" placement="top">
              <Button
                size="small"
                theme="danger"
                variant="outline"
                :loading="mpLoading === `__mp_${mp.name}`"
              >
                <template #icon><DeleteIcon /></template> 移除
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
    header="添加 Marketplace 仓库"
    width="480px"
    :confirm-btn="{
      content: '添加',
      loading: mpLoading === '__marketplace_add',
      theme: 'primary',
      disabled: !newMarketplaceSource.trim(),
    }"
    @confirm="handleAddMarketplace"
  >
    <div class="plugin-add-form">
      <div class="plugin-form-item">
        <label>仓库来源</label>
        <Input
          v-model="newMarketplaceSource"
          placeholder="GitHub URL 或 owner/repo 或 本地路径"
        />
      </div>
      <div class="plugin-form-hint">
        支持格式：<br />
        • <code>https://github.com/user/repo.git</code><br />
        • <code>owner/repo</code>（GitHub 简写）<br />
        • <code>/path/to/local/marketplace</code>（本地路径）
      </div>
    </div>
  </Dialog>
</template>
