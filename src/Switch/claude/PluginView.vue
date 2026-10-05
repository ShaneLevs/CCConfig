<script setup>
import { ref, onMounted, computed } from "vue";
import {
  Card,
  Empty,
  Button,
  Input,
  MessagePlugin,
  Space,
  Tag,
  Popconfirm,
  RadioGroup,
  RadioButton,
  Tooltip,
  Switch,
} from "tdesign-vue-next";
import {
  AddIcon,
  DeleteIcon,
  RefreshIcon,
  DownloadIcon,
  SearchIcon,
} from "tdesign-icons-vue-next";
import { formatRelativeTime } from "../../utils/time";
import { getScopeLabel, getScopeTheme } from "./components/pluginMeta";
import ClaudeComponentBadges from "./components/ClaudeComponentBadges.vue";
import ClaudeMarketplaceManager from "./components/ClaudeMarketplaceManager.vue";
import ClaudePluginDetailDialog from "./components/ClaudePluginDetailDialog.vue";
import "./styles/PluginView.css";

const activeTab = ref("installed"); // installed | browse | marketplace
const loading = ref(false);
const operationLoading = ref(null);

// ==================== Marketplace（仓库管理子组件自持数据） ====================
const mpManagerRef = ref(null);
const marketplaceCount = ref(0);

// ==================== Browse Marketplace Plugins ====================
const marketplacePlugins = ref([]);
const searchQuery = ref("");
const categoryFilter = ref("all");
const selectedPlugin = ref(null);
const showDetailDialog = ref(false);

const openDetailDialog = (plugin) => {
  selectedPlugin.value = plugin;
  showDetailDialog.value = true;
};

const loadMarketplacePlugins = () => {
  try {
    marketplacePlugins.value = window.services.listMarketplacePlugins();
  } catch (e) {
    console.error("加载 marketplace 插件失败:", e);
  }
};

const availableCategories = computed(() => {
  const cats = new Set();
  marketplacePlugins.value.forEach((p) => {
    if (p.category) cats.add(p.category);
  });
  return [...cats].sort();
});

const filteredPlugins = computed(() => {
  let plugins = marketplacePlugins.value;
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    plugins = plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.tags && p.tags.some((t) => t.toLowerCase().includes(q))),
    );
  }
  if (categoryFilter.value !== "all") {
    plugins = plugins.filter((p) => p.category === categoryFilter.value);
  }
  return plugins;
});

// ==================== Installed Plugins ====================
const installedPlugins = ref([]);

// 将已安装插件与 marketplace 数据合并，补充描述/组件/标签
const enrichedInstalledPlugins = computed(() => {
  const marketMap = new Map();
  for (const p of marketplacePlugins.value) {
    marketMap.set(p.name, p);
  }

  return installedPlugins.value.map((p) => {
    const market = marketMap.get(p.name) || null;
    return {
      ...p,
      description: p.description || market?.description || "",
      author: market?.author || null,
      category: market?.category || null,
      tags: market?.tags || [],
      components: market?.components || {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
      },
      homepage: market?.homepage || null,
    };
  });
});

const loadInstalledPlugins = () => {
  try {
    installedPlugins.value = window.services.listInstalledPlugins();
  } catch (e) {
    console.error("加载已安装插件失败:", e);
    installedPlugins.value = [];
  }
};

const handleInstall = async (pluginName) => {
  operationLoading.value = pluginName;
  try {
    const result = window.services.installPlugin(pluginName, "user");
    if (result.success) {
      MessagePlugin.success(`插件 "${pluginName}" 安装成功`);
      await refreshAll();
    } else {
      MessagePlugin.error(result.message || "安装失败");
    }
  } catch (e) {
    MessagePlugin.error("安装插件失败: " + e.message);
  } finally {
    operationLoading.value = null;
  }
};

const handleUninstall = async (plugin) => {
  const scope = plugin.scope || "user";
  const pluginId = plugin.pluginId || plugin.name;
  operationLoading.value = `__uninstall_${plugin.name}`;
  try {
    const result = window.services.uninstallPlugin(pluginId, scope);
    if (result.success) {
      MessagePlugin.success(`插件 "${plugin.name}" 已卸载`);
      loadInstalledPlugins();
    } else {
      MessagePlugin.error(result.message || "卸载失败");
    }
  } catch (e) {
    MessagePlugin.error("卸载插件失败: " + e.message);
  } finally {
    operationLoading.value = null;
  }
};

const handleToggleEnabled = async (plugin) => {
  const scope = plugin.scope || "user";
  const pluginId = plugin.pluginId || plugin.name;
  const fn =
    plugin.enabled !== false
      ? window.services.disablePlugin
      : window.services.enablePlugin;

  operationLoading.value = `__toggle_${plugin.name}`;
  try {
    const result = fn(pluginId, scope);
    if (result.success) {
      MessagePlugin.success(plugin.enabled !== false ? `已禁用 "${plugin.name}"` : `已启用 "${plugin.name}"`);
      plugin.enabled = plugin.enabled === false;
    } else {
      MessagePlugin.error(result.message || "操作失败");
    }
  } catch (e) {
    MessagePlugin.error("操作失败: " + e.message);
  } finally {
    operationLoading.value = null;
  }
};

const handleUpdateInstalled = async (plugin) => {
  const scope = plugin.scope || "user";
  const pluginId = plugin.pluginId || plugin.name;
  operationLoading.value = `__update_${plugin.name}`;
  try {
    const result = window.services.updatePlugin(pluginId, scope);
    if (result.success) {
      MessagePlugin.success(`插件 "${plugin.name}" 更新成功`);
      loadInstalledPlugins();
    } else {
      MessagePlugin.error(result.message || "更新失败");
    }
  } catch (e) {
    MessagePlugin.error("更新插件失败: " + e.message);
  } finally {
    operationLoading.value = null;
  }
};

const handleOpenPluginsDir = () => {
  try {
    window.services.openPluginsDir();
  } catch (e) {
    MessagePlugin.error("打开目录失败");
  }
};

const refreshAll = async () => {
  loadMarketplacePlugins();
  loadInstalledPlugins();
  mpManagerRef.value?.loadMarketplaces();
};

const handleRefresh = async () => {
  loading.value = true;
  await new Promise((r) => setTimeout(r, 50));
  try {
    refreshAll();
  } catch {
    /* ignore */
  }
  loading.value = false;
};

onMounted(() => {
  setTimeout(() => refreshAll(), 50);
});
</script>

<template>
  <div class="plugin-container">
    <div class="plugin-header">
      <span class="plugin-tip">
        管理 Claude Code 插件 —
        <span class="hint-link" @click="handleOpenPluginsDir">~/.claude/plugins</span>
      </span>
      <div class="plugin-actions">
        <Tooltip content="刷新所有数据" placement="top">
          <Button
            size="small"
            variant="outline"
            :loading="loading"
            @click="handleRefresh"
          >
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <!-- 子标签栏 -->
    <div class="plugin-tabs">
      <RadioGroup v-model="activeTab" size="small" variant="default-filled">
        <RadioButton value="installed">已安装</RadioButton>
        <RadioButton value="browse">浏览插件</RadioButton>
        <RadioButton value="marketplace">Marketplace</RadioButton>
      </RadioGroup>
      <span v-if="activeTab === 'installed'" class="section-count">共 {{ installedPlugins.length }} 个插件</span>
      <span v-if="activeTab === 'marketplace'" class="section-count">共 {{ marketplaceCount }} 个仓库</span>
    </div>

    <!-- ==================== Marketplace 管理 ==================== -->
    <template v-if="activeTab === 'marketplace'">
      <ClaudeMarketplaceManager
        ref="mpManagerRef"
        @changed="loadMarketplacePlugins"
        @loaded="(count) => (marketplaceCount = count)"
      />
    </template>

    <!-- ==================== 浏览 Marketplace 插件 ==================== -->
    <template v-if="activeTab === 'browse'">
      <div class="browse-toolbar">
        <div class="search-row">
          <Input
            v-model="searchQuery"
            placeholder="搜索插件名称、描述或标签..."
            clearable
            class="search-input"
          >
            <template #prefix-icon><SearchIcon /></template>
          </Input>
        </div>
        <div class="filter-row">
          <div class="category-filters">
            <Button
              size="small"
              :theme="categoryFilter === 'all' ? 'primary' : 'default'"
              :variant="categoryFilter === 'all' ? 'base' : 'outline'"
              @click="categoryFilter = 'all'"
              >全部</Button
            >
            <Button
              v-for="cat in availableCategories"
              :key="cat"
              size="small"
              :theme="categoryFilter === cat ? 'primary' : 'default'"
              :variant="categoryFilter === cat ? 'base' : 'outline'"
              @click="categoryFilter = cat"
              >{{ cat }}</Button
            >
          </div>
        </div>
      </div>

      <div v-if="filteredPlugins.length === 0" class="empty-state">
        <Empty description="暂无插件" />
      </div>

      <div v-else class="plugin-grid">
        <div
          v-for="plugin in filteredPlugins"
          :key="`${plugin.marketplaceName}/${plugin.name}`"
          class="plugin-card-item"
          @click="openDetailDialog(plugin)"
        >
          <div class="plugin-card-header">
            <div class="plugin-card-title-row">
              <span class="plugin-card-name">{{ plugin.name }}</span>
              <span v-if="plugin.version" class="plugin-card-version">v{{ plugin.version }}</span>
              <ClaudeComponentBadges :components="plugin.components" />
            </div>
            <span v-if="plugin.author" class="plugin-card-author">{{ plugin.author.name || plugin.author }}</span>
          </div>
          <p class="plugin-card-desc">{{ plugin.description }}</p>
          <div class="plugin-card-tags">
            <Tag
              v-for="tag in (plugin.tags || []).slice(0, 5)"
              :key="tag"
              size="small"
              variant="light"
              >{{ tag }}</Tag
            >
          </div>
          <div class="plugin-card-footer">
            <span v-if="plugin.installCount" class="plugin-installs">{{ plugin.installCount }} 次安装</span>
            <span class="plugin-marketplace-tag">@{{ plugin.marketplaceName }}</span>
            <Tooltip content="安装此插件" placement="top">
              <Button
                size="small"
                theme="primary"
                variant="outline"
                :loading="operationLoading === plugin.name"
                @click.stop="handleInstall(plugin.name)"
              >
                <template #icon><DownloadIcon /></template>
                安装
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== 已安装插件 ==================== -->
    <template v-if="activeTab === 'installed'">
      <div v-if="installedPlugins.length === 0" class="empty-state">
        <Empty description="暂无已安装的插件" />
      </div>

      <div v-else class="installed-list">
        <Card
          v-for="plugin in enrichedInstalledPlugins"
          :key="plugin.pluginId || plugin.name"
          :bordered="true"
          class="installed-card"
          :class="{ 'plugin-disabled': plugin.enabled === false }"
          hover
          @click="openDetailDialog(plugin)"
        >
          <template #header>
            <div class="installed-header">
              <div class="installed-header-left">
                <span class="installed-name">{{ plugin.name }}</span>
                <span v-if="plugin.version" class="installed-version">v{{ plugin.version }}</span>
                <Tag size="small" :theme="getScopeTheme(plugin.scope)" variant="light">
                  {{ getScopeLabel(plugin.scope) }}
                </Tag>
                <Tag v-if="plugin.marketplace" size="small" variant="outline">{{ plugin.marketplace }}</Tag>
                <ClaudeComponentBadges :components="plugin.components" class="installed-badge" />
              </div>
              <Space size="small">
                <Tooltip
                  :content="plugin.enabled !== false ? '点击禁用此插件' : '点击启用此插件'"
                  placement="top"
                >
                  <Switch
                    :value="plugin.enabled !== false"
                    size="small"
                    @change="() => handleToggleEnabled(plugin)"
                    @click.stop
                  />
                </Tooltip>
                <Tooltip content="更新插件到最新版本" placement="top">
                  <Button
                    size="small"
                    variant="text"
                    :loading="operationLoading === `__update_${plugin.name}`"
                    @click.stop="handleUpdateInstalled(plugin)"
                  >
                    <template #icon><RefreshIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm
                  theme="danger"
                  :content="'确认卸载插件 ' + plugin.name + '？'"
                  @confirm="handleUninstall(plugin)"
                >
                  <Tooltip content="卸载此插件" placement="top">
                    <Button
                      size="small"
                      theme="danger"
                      variant="text"
                      :loading="operationLoading === `__uninstall_${plugin.name}`"
                      @click.stop
                    >
                      <template #icon><DeleteIcon /></template>
                    </Button>
                  </Tooltip>
                </Popconfirm>
              </Space>
            </div>
          </template>
          <div class="installed-body">
            <p v-if="plugin.description" class="installed-desc">
              {{ plugin.description }}
            </p>
            <div class="installed-meta">
              <span
                v-if="plugin.installedAt"
                class="installed-meta-item"
                :title="new Date(plugin.installedAt).toLocaleString()"
              >
                安装于 {{ formatRelativeTime(plugin.installedAt) }}
              </span>
              <span
                v-if="plugin.lastUpdated && plugin.lastUpdated !== plugin.installedAt"
                class="installed-meta-item"
                :title="new Date(plugin.lastUpdated).toLocaleString()"
              >
                更新于 {{ formatRelativeTime(plugin.lastUpdated) }}
              </span>
            </div>
            <div v-if="plugin.tags && plugin.tags.length" class="installed-tags">
              <Tag
                v-for="tag in plugin.tags.slice(0, 4)"
                :key="tag"
                size="small"
                variant="light"
                >{{ tag }}</Tag
              >
            </div>
          </div>
        </Card>
      </div>
    </template>

    <!-- ==================== 插件详情弹窗 ==================== -->
    <ClaudePluginDetailDialog
      v-model:visible="showDetailDialog"
      :plugin="selectedPlugin"
      :operation-loading="operationLoading"
      @install="handleInstall"
    />
  </div>
</template>
