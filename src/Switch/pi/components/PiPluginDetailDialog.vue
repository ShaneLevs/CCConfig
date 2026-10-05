<script setup>
import { ref, computed } from "vue";
import { Button, Dialog, Tag, MessagePlugin, RadioGroup, RadioButton, Switch, Tooltip } from "tdesign-vue-next";
import { DownloadIcon } from "tdesign-icons-vue-next";

// pi 包详情弹窗：本地信息 Tab（同步读 ~/.pi/agent/npm 包，含逐资源启停）+
// 市场信息 Tab（pi.dev，首次切换才拉取）。打开入口由父级经 ref 调用
// openMarket(pkg) / openInstalled(p)；启停变化后经 changed 通知父级刷新列表。
const props = defineProps({
  // 已安装包名集合（市场 Tab 的「已安装」标记与安装按钮状态）
  installedNames: { type: Object, required: true },
  // pi 命令是否可用（不可用仅可浏览，无法安装）
  piInstalled: { type: Boolean, default: true },
  // 父级安装流程的 loading 包名
  installingName: { type: String, default: "" },
});
const emit = defineEmits(["install", "changed"]);

const detailVisible = ref(false);
const detailLoading = ref(false);
const detailError = ref("");
const detail = ref(null);
const detailName = ref("");
// 已安装包的本地详情（元数据/路径/逐资源启停），与 pi.dev 在线详情分 Tab 展示
const detailLocal = ref(null);
const detailLocalError = ref("");
// Tab 状态：local = 本地信息（同步读）；market = pi.dev 市场信息（首次切到该 Tab 才拉取）
const detailTab = ref("local");
const detailSource = ref("");
const detailFrom = ref(""); // installed | market
const marketFetched = ref(false);

// 本地 Tab：从已安装列表点开时必有；从市场点开时仅已安装的包可看
const showLocalTab = computed(
  () => detailFrom.value === "installed" || props.installedNames.has(detailName.value),
);
// 市场 Tab：非 npm 源（git:/本地路径）pi.dev 上查不到，隐藏
const showMarketTab = computed(() => detailSource.value.startsWith("npm:"));
const showDetailTabs = computed(() => showLocalTab.value && showMarketTab.value);

const resetDetailState = () => {
  detail.value = null;
  detailLocal.value = null;
  detailError.value = "";
  detailLocalError.value = "";
  marketFetched.value = false;
};

const loadLocalDetail = () => {
  if (!detailSource.value) return;
  try {
    const res = window.services.getPiExtensionDetail(detailSource.value);
    if (res && res.success) {
      detailLocal.value = res.data;
      detailLocalError.value = "";
    } else {
      detailLocalError.value = (res && res.message) || "读取本地包信息失败";
    }
  } catch (e) {
    detailLocalError.value = (e && e.message) || "读取本地包信息失败";
  }
};

const loadMarketDetail = async (force = false) => {
  if (!showMarketTab.value) return;
  if (marketFetched.value && !force) return;
  marketFetched.value = true;
  detailLoading.value = true;
  detailError.value = "";
  try {
    detail.value = await window.services.fetchPiDevPackage(detailName.value);
  } catch (e) {
    detail.value = null;
    detailError.value =
      (e && (e.message || e.stack || String(e))) || "加载 pi.dev 详情失败";
    marketFetched.value = false; // 失败允许重试（重试按钮或再次切换 Tab）
  } finally {
    detailLoading.value = false;
  }
};

// 从市场列表点开：默认市场 Tab 并立即拉取；若已安装可切到本地 Tab（切时再读）
const openMarket = (pkg) => {
  resetDetailState();
  detailName.value = (pkg && pkg.name) || "";
  detailSource.value = detailName.value ? `npm:${detailName.value}` : "";
  detailFrom.value = "market";
  detailTab.value = "market";
  detailVisible.value = true;
  loadMarketDetail();
};

// 点击已安装卡片：本地 Tab 立即展示（同步读，不依赖网络）；市场信息切 Tab 时才加载
const openInstalled = (p) => {
  resetDetailState();
  detailName.value = p.name;
  detailSource.value = p.source;
  detailFrom.value = "installed";
  detailTab.value = "local";
  detailVisible.value = true;
  loadLocalDetail();
};

// Tab 切换：懒加载对应内容（各自只拉一次，失败可重试）
const onDetailTabChange = () => {
  if (detailTab.value === "market") loadMarketDetail();
  else if (detailTab.value === "local" && !detailLocal.value && !detailLocalError.value) loadLocalDetail();
};

const retryDetail = () => {
  if (detailTab.value === "market") loadMarketDetail(true);
  else loadLocalDetail();
};

// 详情弹窗内刷新本地信息 + 同步卡片列表
const refreshDetailLocal = () => {
  if (detailLocal.value) loadLocalDetail();
  emit("changed");
};

const detailToggling = ref(false);
const handleDetailToggleEnabled = () => {
  const d = detailLocal.value;
  if (!d || detailToggling.value) return;
  detailToggling.value = true;
  try {
    const next = !(d.enabled !== false);
    const r = window.services.setPiExtensionEnabled(d.source, next);
    if (r.success) MessagePlugin.success(`${next ? "已启用" : "已禁用"} "${d.name}"，Pi 下次启动生效`);
    else MessagePlugin.error("操作失败: " + (r.message || "未知错误"));
  } catch (e) {
    MessagePlugin.error("操作失败: " + (e && e.message ? e.message : String(e)));
  } finally {
    detailToggling.value = false;
    refreshDetailLocal();
  }
};

const RES_TYPE_LABELS = { extensions: "扩展", skills: "Skill", prompts: "Prompt", themes: "主题" };
const RES_TYPE_COLORS = { extensions: "#1890ff", skills: "#f5222d", prompts: "#722ed1", themes: "#13c2c2" };
const detailResourceRows = computed(() => {
  const d = detailLocal.value;
  if (!d || !d.resources) return [];
  const rows = [];
  for (const t of ["extensions", "skills", "prompts", "themes"]) {
    for (const r of d.resources[t] || []) {
      rows.push({ type: t, label: RES_TYPE_LABELS[t], color: RES_TYPE_COLORS[t], path: r.path, enabled: r.enabled !== false });
    }
  }
  return rows;
});

const detailResToggling = ref("");
const handleDetailResToggle = (row) => {
  const d = detailLocal.value;
  const key = `${row.type}:${row.path}`;
  if (!d || detailResToggling.value) return;
  detailResToggling.value = key;
  try {
    const next = !row.enabled;
    const r = window.services.setPiPackageResourceEnabled(d.source, row.type, row.path, next);
    if (r.success) MessagePlugin.success(`${next ? "已启用" : "已禁用"} ${row.path}，Pi 下次启动生效`);
    else MessagePlugin.error("操作失败: " + (r.message || "未知错误"));
  } catch (e) {
    MessagePlugin.error("操作失败: " + (e && e.message ? e.message : String(e)));
  } finally {
    detailResToggling.value = "";
    refreshDetailLocal();
  }
};

const openLocalDir = () => {
  const dir = detailLocal.value && detailLocal.value.dir;
  if (!dir) return;
  try { window.utools.shellOpenPath(dir); } catch { /* ignore */ }
};

const openExternal = (url) => {
  try {
    window.utools?.shellOpenExternal(url);
  } catch {
    /* ignore */
  }
};

const copyInstallCmd = () => {
  if (detail.value && detail.value.install) {
    window.utools.copyText(detail.value.install);
    MessagePlugin.success("已复制安装命令");
  }
};

const handleInstall = () => {
  if (!detail.value) return;
  emit("install", `npm:${detail.value.name}`);
};

// README 内链接：拦截点击，用系统浏览器打开
const onReadmeClick = (e) => {
  const a = e.target && e.target.closest ? e.target.closest("a") : null;
  if (a && a.href && /^https?:/i.test(a.href)) {
    e.preventDefault();
    openExternal(a.href);
  }
};

defineExpose({ openMarket, openInstalled });
</script>

<template>
  <Dialog
    v-model:visible="detailVisible"
    width="720px"
    dialog-class-name="pi-detail-dialog"
    :confirm-btn="null"
    :cancel-btn="null"
    :close-on-overlay-click="true"
  >
    <!-- 头部：插件名称 + 本地/市场 Tab（同一行，仅有一个数据源时隐藏 Tab） -->
    <template #header>
      <div class="pi-detail-header">
        <span class="pi-detail-header-name">{{ detailName || (detail && detail.name) || '包详情' }}</span>
        <RadioGroup v-if="showDetailTabs" v-model="detailTab" size="small" variant="default-filled" @change="onDetailTabChange">
          <RadioButton value="local">本地信息</RadioButton>
          <RadioButton value="market">市场信息</RadioButton>
        </RadioGroup>
      </div>
    </template>

    <!-- ==================== 本地信息 Tab（同步读本地包，立即展示） ==================== -->
    <div v-if="detailTab === 'local' && showLocalTab" class="pi-detail">
      <div v-if="detailLocalError && !detailLocal" class="pi-detail-error">
        <span>{{ detailLocalError }}</span>
        <Button size="small" variant="outline" @click="retryDetail">重试</Button>
      </div>
      <template v-else-if="detailLocal">
      <div class="pi-detail-head">
        <span class="pi-detail-name mono">{{ detailLocal.name }}</span>
        <Tag v-if="detailLocal.version" size="small" variant="light">{{ detailLocal.version }}</Tag>
        <Tag size="small" theme="success" variant="light">已安装</Tag>
        <Tag v-if="!detailLocal.enabled" size="small" theme="warning" variant="light">已禁用</Tag>
        <Tooltip :content="detailLocal.enabled ? '禁用此扩展（Pi 下次启动生效）' : '启用此扩展（Pi 下次启动生效）'" placement="top">
          <Switch
            class="pi-detail-head-switch"
            :value="detailLocal.enabled"
            size="small"
            :disabled="detailToggling"
            @change="handleDetailToggleEnabled"
          />
        </Tooltip>
      </div>
      <p v-if="detailLocal.description" class="pi-detail-desc">{{ detailLocal.description }}</p>

      <div v-if="detailLocal.dir" class="pi-detail-meta">
        <div class="pi-detail-meta-item pi-detail-meta-dir">
          <span>路径</span><b class="mono" title="点击打开目录" @click="openLocalDir">{{ detailLocal.dir }}</b>
        </div>
      </div>

      <div v-if="detailLocal.repoUrl || detailLocal.homepage || detailLocal.dir" class="pi-detail-actions">
        <Button v-if="detailLocal.repoUrl" size="small" variant="outline" @click="openExternal(detailLocal.repoUrl)">repo</Button>
        <Button v-if="detailLocal.homepage && detailLocal.homepage !== detailLocal.repoUrl" size="small" variant="outline" @click="openExternal(detailLocal.homepage)">home</Button>
        <Button v-if="detailLocal.dir" size="small" variant="outline" @click="openLocalDir">打开目录</Button>
      </div>

      <!-- 逐资源启停（对齐 pi config 的过滤语义） -->
      <div v-if="detailResourceRows.length" class="pi-detail-res">
        <div class="pi-detail-manifest-title">资源（{{ detailResourceRows.length }}）</div>
        <div
          v-for="row in detailResourceRows"
          :key="row.type + ':' + row.path"
          class="pi-detail-res-row"
          :class="{ 'pi-detail-res-off': !row.enabled }"
        >
          <Tag size="small" variant="light" :style="{ background: row.color + '18', color: row.color, borderColor: row.color + '40' }">{{ row.label }}</Tag>
          <span class="pi-detail-res-path mono">{{ row.path }}</span>
          <Tooltip :content="row.enabled ? '禁用此资源（Pi 下次启动生效）' : '启用此资源（Pi 下次启动生效）'" placement="top">
            <Switch
              size="small"
              :value="row.enabled"
              :disabled="!!detailResToggling"
              @change="() => handleDetailResToggle(row)"
            />
          </Tooltip>
        </div>
      </div>

      <div v-if="detailLocal.mcpServers && detailLocal.mcpServers.length" class="pi-detail-res">
        <div class="pi-detail-manifest-title">MCP 服务器（{{ detailLocal.mcpServers.length }}）</div>
        <div v-for="s in detailLocal.mcpServers" :key="s" class="pi-detail-res-row">
          <Tag size="small" variant="light" :style="{ background: '#13c2c218', color: '#13c2c2', borderColor: '#13c2c240' }">MCP</Tag>
          <span class="pi-detail-res-path mono">{{ s }}</span>
        </div>
      </div>
      </template>
    </div>

    <!-- ==================== 市场信息 Tab（pi.dev，首次切换才加载） ==================== -->
    <template v-if="detailTab === 'market' && showMarketTab">
      <div v-if="detailLoading" class="pi-detail-loading">加载中...</div>
      <div v-else-if="detailError" class="pi-detail-error">
        <span>{{ detailError }}</span>
        <Button size="small" variant="outline" @click="retryDetail">重试</Button>
      </div>
      <div v-else-if="detail" class="pi-detail">
      <div class="pi-detail-head">
        <span class="pi-detail-name mono">{{ detail.name }}</span>
        <Tag v-for="t in detail.types" :key="t" size="small" variant="light">{{ t }}</Tag>
        <Tag v-if="installedNames.has(detail.name)" size="small" theme="success" variant="light">已安装</Tag>
      </div>
      <p v-if="detail.description" class="pi-detail-desc">{{ detail.description }}</p>

      <div class="pi-detail-meta">
        <div v-if="detail.version" class="pi-detail-meta-item">
          <span>版本</span><b>{{ detail.version }}</b>
        </div>
        <div v-if="detail.published" class="pi-detail-meta-item">
          <span>发布</span><b>{{ detail.published }}</b>
        </div>
        <div v-if="detail.downloads" class="pi-detail-meta-item">
          <span>下载</span><b>{{ detail.downloads }}</b>
        </div>
        <div v-if="detail.author" class="pi-detail-meta-item">
          <span>作者</span><b>@{{ detail.author }}</b>
        </div>
        <div v-if="detail.license" class="pi-detail-meta-item">
          <span>许可证</span><b>{{ detail.license }}</b>
        </div>
        <div v-if="detail.size" class="pi-detail-meta-item">
          <span>大小</span><b>{{ detail.size }}</b>
        </div>
        <div v-if="detail.dependencies" class="pi-detail-meta-item">
          <span>依赖</span><b>{{ detail.dependencies }}</b>
        </div>
      </div>

      <div v-if="detail.install" class="pi-detail-install">
        <code class="mono">{{ detail.install }}</code>
        <Button size="small" variant="outline" @click="copyInstallCmd">复制</Button>
      </div>

      <div class="pi-detail-actions">
        <Button
          v-if="!installedNames.has(detail.name)"
          size="small"
          theme="primary"
          :loading="installingName === detail.name"
          :disabled="!piInstalled || !!installingName"
          @click="handleInstall"
        >
          <template #icon><DownloadIcon /></template> 安装
        </Button>
        <Button v-else size="small" variant="outline" disabled>已安装</Button>
        <Button v-if="detail.npm" size="small" variant="outline" @click="openExternal(detail.npm)">npm</Button>
        <Button v-if="detail.repo" size="small" variant="outline" @click="openExternal(detail.repo)">repo</Button>
        <Button v-if="detail.home" size="small" variant="outline" @click="openExternal(detail.home)">home</Button>
      </div>

      <div v-if="detail.manifest" class="pi-detail-manifest">
        <div class="pi-detail-manifest-title">PI MANIFEST JSON</div>
        <pre class="mono">{{ JSON.stringify(detail.manifest, null, 2) }}</pre>
      </div>

      <div v-if="detail.readme" class="pi-detail-readme" @click="onReadmeClick">
        <div class="pi-detail-readme-title">README</div>
        <div class="pi-detail-readme-body rich-text" v-html="detail.readme"></div>
      </div>
      </div>
    </template>
  </Dialog>
</template>
