<script setup>
import { ref, computed, onMounted } from "vue";
import {
  Card, Empty, Button, Dialog, Input, MessagePlugin, Tag, Popconfirm, Tooltip, Select, Alert, RadioGroup, RadioButton, Pagination, Switch,
} from "tdesign-vue-next";
import { AddIcon, DeleteIcon, RefreshIcon, LinkIcon, SearchIcon, DownloadIcon, CloudDownloadIcon } from "tdesign-icons-vue-next";
import PiPluginDetailDialog from "./components/PiPluginDetailDialog.vue";
import "./styles/PluginView.css";

const loading = ref(false);
const plugins = ref([]);
const addDialog = ref(false);
const newPluginName = ref("");

const loadPlugins = () => {
  try {
    const raw = window.services.getPiExtensions();
    plugins.value = raw.map(ext => ({ name: ext.name, source: ext.source, version: ext.version, description: ext.description, resources: ext.resources, enabled: ext.enabled !== false }));
  } catch (e) {
    console.error("加载 Pi 扩展失败:", e);
    plugins.value = [];
  }
};

const refresh = () => {
  loading.value = true;
  setTimeout(() => { loadPlugins(); loading.value = false; }, 50);
};

const openAddDialog = () => {
  newPluginName.value = "";
  addDialog.value = true;
};

const installing = ref(false);

const handleAdd = async () => {
  const name = newPluginName.value.trim();
  if (!name) {
    MessagePlugin.warning("请输入扩展包名");
    return;
  }
  installing.value = true;
  try {
    let raw = name.replace(/^pi\s+(install\s+)?/i, '').trim()
    const source = raw.startsWith('npm:') || raw.startsWith('git:') || raw.startsWith('http') || raw.startsWith('ssh') || raw.startsWith('./')
      ? raw
      : `npm:${raw}`;
    const result = await window.services.installPiExtension(source);
    if (result.success) {
      MessagePlugin.success((result.message || '').trim() || '安装完成');
      addDialog.value = false;
      loadPlugins();
    } else {
      MessagePlugin.error("安装失败: " + (result.message || "未知错误"));
    }
  } catch (e) {
    MessagePlugin.error("安装失败: " + (e.stderr || e.message || "未知错误"));
  } finally {
    installing.value = false;
  }
};

const handleRemove = async (source) => {
  if (deletingSource.value) return;
  deletingSource.value = source;
  let msg = null;
  try {
    msg = await MessagePlugin.loading({
      content: `正在卸载 ${source.replace(/^npm:/, "")} ...`,
      duration: 0,
    });
    const result = await window.services.uninstallPiExtension(source);
    try {
      msg.close();
    } catch {
      /* 消息可能已自动关闭 */
    }
    if (result.success) {
      MessagePlugin.success((result.message || "").trim() || "扩展已卸载");
      loadPlugins();
    } else {
      MessagePlugin.error("卸载失败: " + (result.message || "未知错误"));
    }
  } catch (e) {
    try {
      msg && msg.close();
    } catch {
      /* ignore */
    }
    MessagePlugin.error("卸载失败: " + (e.stderr || e.message || "未知错误"));
  } finally {
    deletingSource.value = "";
  }
};

const openPiDevPackages = () => {
  try { window.utools.shellOpenExternal("https://pi.dev/packages"); } catch { }
};

// 启用/禁用扩展：写 ~/.pi/agent/settings.json 的 packages 过滤（!* 标记），Pi 下次启动生效
const togglingSource = ref("");
const handleToggleEnabled = (p) => {
  if (togglingSource.value) return;
  togglingSource.value = p.source;
  try {
    const result = window.services.setPiExtensionEnabled(p.source, !(p.enabled !== false));
    if (result.success) {
      MessagePlugin.success(`${p.enabled !== false ? "已禁用" : "已启用"} "${p.name}"，Pi 下次启动生效`);
    } else {
      MessagePlugin.error("操作失败: " + (result.message || "未知错误"));
    }
  } catch (e) {
    MessagePlugin.error("操作失败: " + (e && e.message ? e.message : String(e)));
  } finally {
    togglingSource.value = "";
    loadPlugins();
  }
};

// 一键更新全部已安装扩展（pi update --extensions）
const updating = ref(false);
const handleUpdateAll = async () => {
  if (updating.value) return;
  updating.value = true;
  let msg = null;
  try {
    msg = await MessagePlugin.loading({ content: "正在更新全部扩展（pi update --extensions）...", duration: 0 });
    const result = await window.services.updatePiExtensions();
    try { msg.close(); } catch { /* 消息可能已自动关闭 */ }
    if (result.success) {
      MessagePlugin.success((result.message || "").trim() || "扩展已更新");
      loadPlugins();
    } else {
      MessagePlugin.error("更新失败: " + (result.message || "未知错误"));
    }
  } catch (e) {
    try { msg && msg.close(); } catch { /* ignore */ }
    MessagePlugin.error("更新失败: " + (e.stderr || e.message || "未知错误"));
  } finally {
    updating.value = false;
  }
};

// ==================== 包市场（pi.dev/packages） ====================

const activeTab = ref("installed"); // installed | browse
const marketLoading = ref(false);
const marketError = ref("");
const marketItems = ref([]);
const marketTotal = ref(0);
const marketLastPage = ref(1);
const marketPage = ref(1);
const marketName = ref("");
const marketType = ref("");
const marketSort = ref("downloads");
const installedNames = ref(new Set());
const piInstalled = ref(true);
const installingName = ref("");
const deletingSource = ref("");

const MARKET_SORT_OPTIONS = [
  { label: "下载量最多", value: "downloads" },
  { label: "最近发布", value: "recent" },
  { label: "名称 A-Z", value: "name" },
];

const MARKET_TYPE_OPTIONS = [
  { label: "全部类型", value: "" },
  { label: "extension", value: "extension" },
  { label: "skill", value: "skill" },
  { label: "theme", value: "theme" },
  { label: "prompt", value: "prompt" },
];

const refreshInstalledNames = () => {
  try {
    const exts = window.services.getPiExtensions();
    installedNames.value = new Set(exts.map(e => e.name));
  } catch (e) {
    console.error("读取已安装扩展失败:", e);
    installedNames.value = new Set();
  }
};

const loadMarket = async (page = marketPage.value) => {
  marketLoading.value = true;
  marketError.value = "";
  try {
    const data = await window.services.fetchPiDevPackages({
      page,
      name: marketName.value.trim(),
      type: marketType.value,
      sort: marketSort.value,
    });
    marketItems.value = data.items || [];
    marketTotal.value = data.total || 0;
    marketLastPage.value = Math.max(data.lastPage || 1, 1);
    marketPage.value = page;
  } catch (e) {
    marketError.value = (e && (e.message || e.stack || String(e))) || "加载市场失败";
    marketItems.value = [];
  } finally {
    marketLoading.value = false;
  }
};

const openMarket = async () => {
  activeTab.value = "browse";
  refreshInstalledNames();
  try { piInstalled.value = await window.services.isPiInstalled(); } catch { piInstalled.value = true; }
  if (!marketItems.value.length) loadMarket(1);
};

const marketSearch = () => loadMarket(1);
// TDesign Pagination 翻页：先更新 current 再加载
const onMarketPageChange = (info) => {
  const page = (info && info.current) || info;
  if (page < 1 || page > marketLastPage.value || page === marketPage.value) return;
  marketPage.value = page;
  loadMarket(page);
};

const formatMarketDownloads = (n) => {
  if (!n) return "";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};

const marketDateText = (ts) => {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "1 天前";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
};

// 安装 npm 源扩展（市场列表 / 详情弹窗共用流程）
const installSource = async (source) => {
  if (installingName.value) return;
  const name = source.replace(/^npm:/, "");
  installingName.value = name;
  try {
    const result = await window.services.installPiExtension(source);
    if (result.success) {
      MessagePlugin.success(`${name} 安装完成`);
      refreshInstalledNames();
      loadPlugins();
    } else {
      MessagePlugin.error("安装失败: " + (result.message || "未知错误"));
    }
  } catch (e) {
    MessagePlugin.error("安装失败: " + (e.stderr || e.message || "未知错误"));
  } finally {
    installingName.value = "";
  }
};

const installFromMarket = (pkg) => installSource(`npm:${pkg.name}`);

// ==================== 包详情弹窗（子组件自持详情状态） ====================

const detailDialogRef = ref(null);

const openPackageDetail = (pkg) => detailDialogRef.value?.openMarket(pkg);
// 市场 Tab 的「已安装」标记/按钮依赖此集合，打开前先刷新
const openInstalledDetail = (p) => {
  refreshInstalledNames();
  detailDialogRef.value?.openInstalled(p);
};
// 详情内启停变化 → 同步卡片列表
const handleDetailChanged = () => {
  loadPlugins();
  refreshInstalledNames();
};

const resourceBadges = [
  { key: "extensions", label: "扩展", color: "#1890ff" },
  { key: "skills", label: "Skills", color: "#f5222d" },
  { key: "mcpServers", label: "MCP", color: "#13c2c2" },
];

onMounted(() => {
  setTimeout(() => { loadPlugins(); loading.value = false; }, 50);
});

const installFromUrl = (payload) => {
  newPluginName.value = payload || '';
  addDialog.value = true;
};

defineExpose({ installFromUrl });
</script>

<template>
  <div class="pi-plugin-container">
    <!-- 子标签栏（右侧：已安装 → 添加扩展 + 刷新；浏览市场 → 搜索/筛选） -->
    <div class="pi-plugin-tabs">
      <div class="pi-plugin-tabs-left">
        <RadioGroup v-model="activeTab" size="small" variant="default-filled">
          <RadioButton value="installed">已安装</RadioButton>
          <RadioButton value="browse" @click="openMarket">浏览市场</RadioButton>
        </RadioGroup>
        <span v-if="activeTab === 'installed'" class="pi-section-count">共 {{ plugins.length }} 个扩展</span>
        <span v-if="activeTab === 'browse'" class="pi-section-count">共 {{ marketTotal }} 个包</span>
      </div>
      <div class="pi-plugin-tabs-right">
        <template v-if="activeTab === 'installed'">
          <Tooltip content="更新全部已安装扩展（pi update --extensions）" placement="top">
            <Button size="small" variant="outline" :loading="updating" :disabled="updating || !!deletingSource" @click="handleUpdateAll">
              <template #icon><CloudDownloadIcon /></template> 一键更新
            </Button>
          </Tooltip>
          <Button size="small" variant="outline" @click="openAddDialog">
            <template #icon><AddIcon /></template> 添加扩展
          </Button>
          <Tooltip content="刷新" placement="top">
            <Button size="small" variant="outline" :loading="loading" @click="refresh">
              <template #icon><RefreshIcon /></template>
            </Button>
          </Tooltip>
        </template>
        <template v-else>
          <Input
            v-model="marketName"
            placeholder="搜索包名 / 描述 / 作者..."
            clearable
            size="small"
            class="pi-market-search"
            @enter="marketSearch"
            @clear="marketSearch"
          >
            <template #prefixIcon><SearchIcon /></template>
          </Input>
          <Select v-model="marketType" :options="MARKET_TYPE_OPTIONS" size="small" class="pi-market-select" @change="marketSearch" />
          <Select v-model="marketSort" :options="MARKET_SORT_OPTIONS" size="small" class="pi-market-select" @change="marketSearch" />
          <Tooltip content="刷新" placement="top">
            <Button size="small" variant="outline" :loading="marketLoading" @click="marketSearch" class="pi-market-refresh-btn">
              <template #icon><RefreshIcon /></template>
            </Button>
          </Tooltip>
        </template>
      </div>
    </div>

    <!-- ==================== 浏览市场（pi.dev/packages） ==================== -->
    <template v-if="activeTab === 'browse'">
      <div class="pi-market-wrap">
      <Alert
        v-if="!piInstalled"
        theme="warning"
        message="未检测到 pi 命令，可能未安装 Pi Agent。仅可浏览市场，无法安装扩展。"
      />

      <!-- 工具栏已并入上方子标签栏右侧：搜索 + 类型筛选 + 排序 + 刷新 -->

      <div v-if="marketError" class="pi-market-error">
        {{ marketError }}
        <Button size="small" variant="outline" @click="marketSearch">重试</Button>
      </div>

      <div v-else-if="marketLoading" class="pi-market-loading">加载中...</div>

      <div v-else-if="!marketItems.length" class="pi-market-empty">
        <Empty description="无匹配的包" />
      </div>

      <div v-else class="pi-market-list">
        <div
          v-for="pkg in marketItems"
          :key="pkg.name"
          class="pi-market-item"
          @click="openPackageDetail(pkg)"
        >
          <div class="pi-market-item-main">
            <div class="pi-market-item-head">
              <span class="pi-market-name mono">{{ pkg.name }}</span>
              <Tag v-for="t in pkg.types" :key="t" size="small" variant="light" class="pi-market-type">{{ t }}</Tag>
            </div>
            <p v-if="pkg.description" class="pi-market-desc">{{ pkg.description }}</p>
            <div class="pi-market-meta">
              <span v-if="pkg.author" class="pi-market-author">@{{ pkg.author }}</span>
              <span v-if="pkg.downloads" class="pi-market-stat">⬇ {{ formatMarketDownloads(pkg.downloads) }}/mo</span>
              <span v-if="pkg.date" class="pi-market-stat">{{ marketDateText(pkg.date) }}</span>
            </div>
          </div>
          <div class="pi-market-item-actions">
            <Button
              v-if="!installedNames.has(pkg.name)"
              size="small"
              theme="primary"
              :loading="installingName === pkg.name"
              :disabled="!piInstalled || !!installingName"
              @click.stop="installFromMarket(pkg)"
            >
              <template #icon><DownloadIcon /></template> 安装
            </Button>
            <Button v-else size="small" variant="outline" disabled @click.stop>已安装</Button>
          </div>
        </div>
      </div>

      <!-- 分页：TDesign Pagination，固定底部常驻（列表区内部滚动） -->
      <div v-if="marketTotal > 0" class="pi-market-footer">
        <Pagination
          :current="marketPage"
          :total="marketTotal"
          :page-size="50"
          :show-jumper="true"
          :show-page-size="false"
          size="small"
          @change="onMarketPageChange"
        />
      </div>
      </div>
    </template>

    <!-- ==================== 已安装 ==================== -->
    <template v-else>
      <div v-if="plugins.length === 0" class="pi-plugin-empty">
        <Empty description="暂无已安装的 Pi 扩展">
          <template #action>
            <Button size="small" theme="primary" @click="openAddDialog">
              <template #icon><AddIcon /></template> 添加扩展
            </Button>
          </template>
        </Empty>
      </div>

    <div v-else class="pi-plugin-list">
      <Card v-for="p in plugins" :key="p.source" :bordered="true" :class="['pi-plugin-card', { 'pi-plugin-disabled': p.enabled === false }]" @click="openInstalledDetail(p)">
        <div class="pi-plugin-card-row">
          <div class="pi-plugin-card-main">
            <div class="pi-plugin-card-header">
              <span class="pi-plugin-name mono">{{ p.name }}</span>
              <Tag v-if="p.version" size="small" variant="light">{{ p.version }}</Tag>
              <Tag v-if="p.enabled === false" size="small" theme="warning" variant="light">已禁用</Tag>
              <Tag v-for="badge in resourceBadges" :key="badge.key"
                v-show="p.resources && p.resources[badge.key] && p.resources[badge.key].length"
                size="small"
                :style="{ background: badge.color + '18', color: badge.color, borderColor: badge.color + '40' }"
              >{{ badge.label }} {{ p.resources[badge.key].length }}</Tag>
            </div>
            <p v-if="p.description" class="pi-plugin-desc">{{ p.description }}</p>
          </div>
          <div class="pi-plugin-card-side" @click.stop>
            <Tooltip :content="p.enabled !== false ? '禁用此扩展（Pi 下次启动生效）' : '启用此扩展（Pi 下次启动生效）'" placement="top">
              <Switch
                :value="p.enabled !== false"
                size="small"
                :disabled="togglingSource === p.source"
                @change="() => handleToggleEnabled(p)"
                @click.stop
              />
            </Tooltip>
            <Popconfirm content="确定卸载此扩展？" @confirm="handleRemove(p.source)">
              <Button
                size="small"
                variant="text"
                theme="danger"
                :loading="deletingSource === p.source"
                :disabled="!!deletingSource"
              >
                <template #icon><DeleteIcon /></template>
              </Button>
            </Popconfirm>
          </div>
        </div>
      </Card>
    </div>
    </template>

    <Dialog
      v-model:visible="addDialog"
      header="安装 Pi 扩展"
      width="520px"
      :confirm-btn="null"
      :cancel-btn="null"
      :close-on-overlay-click="false"
    >
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <label style="font-size:13px;color:var(--td-text-color-secondary);">扩展包名或来源</label>
          <Button size="small" variant="text" theme="primary" @click="openPiDevPackages">
            <template #icon><LinkIcon /></template> pi.dev/packages
          </Button>
        </div>
        <Input v-model="newPluginName" placeholder='例如：@hypabolic/pi-hypa 或 npm:@hypabolic/pi-hypa' :disabled="installing" />

        <div style="font-size:12px;color:var(--td-text-color-placeholder);margin-top:4px;">
          支持格式：<code>npm:package</code>、<code>git:github.com/user/repo</code>、<code>https://...</code>
        </div>
      </div>
      <template #footer>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <Button variant="outline" :disabled="installing" @click="addDialog = false">取消</Button>
          <Button theme="primary" :loading="installing" @click="handleAdd">{{ installing ? '安装中...' : '安装' }}</Button>
        </div>
      </template>
    </Dialog>

    <!-- ==================== 包详情弹窗 ==================== -->
    <PiPluginDetailDialog
      ref="detailDialogRef"
      :installed-names="installedNames"
      :pi-installed="piInstalled"
      :installing-name="installingName"
      @install="installSource"
      @changed="handleDetailChanged"
    />
  </div>
</template>
