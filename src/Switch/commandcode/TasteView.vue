<script setup>
// Command Code Taste 管理：taste 是 Command Code 的偏好学习包（taste-1 模型边用边学）。
// - 项目级：<当前项目>/.commandcode/taste（项目特有偏好）
// - 全局级：~/.commandcode/taste（跨项目个人偏好）
// 落盘规则（与服务层 persistTaste 一致，官方 lint 也认这套）：
//   分类条目 <= 5 条内联在 taste.md；> 5 条拆到 <category>/taste.md，主档留 See 引用。
// 条目格式：- 内容. Confidence: 0.90（置信度可省略）。
// 项目目录来源：自动列出本机用 cmd 打开过的所有项目（~/.commandcode/projects/<slug>
// 的会话日志首行带 cwd，服务层解析成真实路径），下拉切换；仍保留手动选目录作为兜底。
// 最后选中的项目缓存在本机（ccconfig_commandcode_taste_project_<nativeId>）。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Button, Empty, Tag, Tooltip, MessagePlugin, Dialog, Input, Slider, Select,
  Popconfirm, Space, Collapse, CollapsePanel, RadioGroup, RadioButton, Link,
} from "tdesign-vue-next";
import {
  RefreshIcon, AddIcon, DeleteIcon, EditIcon, FolderOpen1Icon, ChevronRightIcon,
} from "tdesign-icons-vue-next";
import "./styles/TasteView.css";

const { t } = useI18n();

const TASTE_MAX_INLINE = 5;

const scope = ref("project");
const loading = ref(false);
const packages = ref({ project: { root: "", exists: false, categories: [] }, global: { root: "", exists: false, categories: [] } });
const summary = ref(null);
const activeCategory = ref("");
// 自动发现的项目（按最近活跃倒序）+ 当前选中项目根目录
const projects = ref([]);
const projectRoot = ref("");

const scopeOptions = computed(() => [
  { value: "project", label: t("commandcode.taste.scopeProject") },
  { value: "global", label: t("commandcode.taste.scopeGlobal") },
]);

// ~ 缩写，下拉里显示更短
const shortPath = (p) => String(p || "").replace(/^\/(?:Users|home)\/[^/]+/, "~");

const projectOptions = computed(() =>
  projects.value.map((p) => ({
    value: p.root,
    // 同名项目（不同目录同名文件夹）靠路径区分，所以路径一定要带上
    label: `${p.name}  ${shortPath(p.root)}`,
  }))
);

const currentPkg = computed(() => packages.value[scope.value] || { root: "", exists: false, categories: [] });
const categories = computed(() => currentPkg.value.categories || []);

const activeCat = computed(() => categories.value.find((c) => c.name === activeCategory.value) || null);
const activeEntries = computed(() => activeCat.value?.entries || []);

// 选中分类失效（切换 scope / 删除）时自动落到第一个
const ensureActiveCategory = () => {
  if (!categories.value.some((c) => c.name === activeCategory.value)) {
    activeCategory.value = categories.value[0]?.name || "";
  }
};

// ==================== 项目目录 ====================

const PROJECT_DB_KEY = "ccconfig_commandcode_taste_project";

const readSavedRoot = () => {
  try {
    const nativeId = window.utools?.getNativeId?.() || "local";
    const doc = window.utools.db.get(`${PROJECT_DB_KEY}_${nativeId}`);
    return doc?.root || "";
  } catch {
    return "";
  }
};

const saveProjectRoot = (root) => {
  try {
    const nativeId = window.utools?.getNativeId?.() || "local";
    const id = `${PROJECT_DB_KEY}_${nativeId}`;
    const prev = window.utools.db.get(id);
    const doc = { _id: id, root };
    if (prev?._rev) doc._rev = prev._rev;
    window.utools.db.put(doc);
    projectRoot.value = root;
    return true;
  } catch (e) {
    MessagePlugin.error(e.message || t("common.saveFailed"));
    return false;
  }
};

// 拉取本机所有项目；优先保留上次选中的项目，其次选第一个（按最近活跃排序）。
// 上次选中的目录作为 extra 传给服务层：它可能不是 cmd 打开过的项目（手动选的），
// 但那正是用户当前在用的项目，必须留在下拉里。
const loadProjects = () => {
  const saved = readSavedRoot();
  try {
    projects.value = window.services.listCommandCodeProjects(saved ? [saved] : []) || [];
  } catch (e) {
    console.error("列出 Command Code 项目失败:", e);
    projects.value = [];
  }
  const match = projects.value.find((p) => p.root === saved);
  if (match) projectRoot.value = match.root;
  else if (projects.value.length) {
    // 上次选的项目已被删除/移动：落到最近活跃的那个，并把选择持久化
    saveProjectRoot(projects.value[0].root);
  } else {
    projectRoot.value = "";
  }
};

// uTools 的目录选择器；桌面版 bridge 也实现了 showOpenDialog
const pickProjectRoot = () => {
  try {
    const picked = window.utools?.showOpenDialog?.({
      title: t("commandcode.taste.pickProjectTitle"),
      properties: ["openDirectory", "createDirectory"],
    });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return;
    // 先落库再重建列表：loadProjects 会把已保存目录作为 extra 并入下拉
    if (!saveProjectRoot(dir)) return;
    loadProjects();
    activeCategory.value = "";
    refresh();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.saveFailed"));
  }
};

const onProjectChange = (root) => {
  projectRoot.value = root;
  saveProjectRoot(root);
  activeCategory.value = "";
  refresh();
};

// ==================== 数据加载 ====================

// 项目作用域要把 root 作为最后一个参数传给服务层；全局作用域传 undefined。
// 各方法签名不同（有的没有 root 参数），所以逐个显式拼，不做通用 …args 转发。
const serviceRoot = () => (scope.value === "project" ? projectRoot.value || undefined : undefined);

const refresh = () => {
  loading.value = true;
  try {
    const root = serviceRoot();
    packages.value = window.services.getCommandCodeTastePackages(root) || packages.value;
    summary.value = window.services.getCommandCodeTasteSummary(root);
    ensureActiveCategory();
  } catch (e) {
    console.error("加载 Command Code taste 失败:", e);
    MessagePlugin.error(t("commandcode.taste.loadFailed", { message: e.message }));
  } finally {
    loading.value = false;
  }
};

const onScopeChange = () => {
  activeCategory.value = "";
  refresh();
};

const initializePackage = () => {
  try {
    const file = window.services.initCommandCodeTaste(scope.value, serviceRoot());
    MessagePlugin.success(t("commandcode.taste.initialized", { path: file }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("commandcode.taste.initFailed", { message: e.message }));
  }
};

const openTasteDir = () => {
  try {
    window.services.openCommandCodeTasteDir(scope.value, serviceRoot());
  } catch (e) {
    MessagePlugin.error(e.message || t("commandcode.taste.openDirFailed"));
  }
};

// ==================== 分类 ====================

const categoryDialog = ref(false);
const newCategoryName = ref("");

const openCategoryDialog = () => {
  newCategoryName.value = "";
  categoryDialog.value = true;
};

const handleAddCategory = () => {
  const name = newCategoryName.value.trim();
  if (!name) { MessagePlugin.warning(t("commandcode.taste.categoryNameHint")); return; }
  try {
    window.services.addCommandCodeTasteCategory(scope.value, serviceRoot(), name);
    MessagePlugin.success(t("commandcode.taste.categoryAdded", { name }));
    categoryDialog.value = false;
    activeCategory.value = name;
    refresh();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.saveFailed"));
  }
};

const handleDeleteCategory = (cat) => {
  try {
    window.services.deleteCommandCodeTasteCategory(scope.value, serviceRoot(), cat.name);
    MessagePlugin.success(t("commandcode.taste.categoryDeleted", { name: cat.name }));
    refresh();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.deleteFailed"));
  }
};

// ==================== 条目 ====================

const entryDialog = ref(false);
const editingIndex = ref(-1);
const entryForm = ref({ category: "", text: "", confidence: 0.8 });

const openAddEntry = () => {
  editingIndex.value = -1;
  entryForm.value = {
    category: activeCategory.value || categories.value[0]?.name || "",
    text: "",
    confidence: 0.8,
  };
  entryDialog.value = true;
};

const openEditEntry = (entry, idx) => {
  editingIndex.value = idx;
  entryForm.value = {
    category: activeCategory.value,
    text: entry.text,
    confidence: entry.confidence === null ? 0.8 : entry.confidence,
  };
  entryDialog.value = true;
};

const handleSaveEntry = () => {
  const text = entryForm.value.text.trim();
  if (!text) { MessagePlugin.warning(t("commandcode.taste.entryTextRequired")); return; }
  try {
    if (editingIndex.value >= 0) {
      window.services.updateCommandCodeTasteEntry(
        scope.value, serviceRoot(), entryForm.value.category, editingIndex.value,
        { text, confidence: entryForm.value.confidence },
      );
      MessagePlugin.success(t("commandcode.taste.updated"));
    } else {
      window.services.addCommandCodeTasteEntry(
        scope.value, serviceRoot(), entryForm.value.category, text, entryForm.value.confidence,
      );
      MessagePlugin.success(t("commandcode.taste.added"));
      activeCategory.value = entryForm.value.category;
    }
    entryDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.saveFailed"));
  }
};

const handleDeleteEntry = (idx) => {
  try {
    window.services.deleteCommandCodeTasteEntry(scope.value, serviceRoot(), activeCategory.value, idx);
    MessagePlugin.success(t("commandcode.taste.deleted"));
    refresh();
  } catch (e) {
    MessagePlugin.error(e.message || t("common.deleteFailed"));
  }
};

// 保存后可能触发拆分/合并，提前告知（不阻断）
const splitNotice = computed(() => {
  if (!activeCat.value) return "";
  const n = activeEntries.value.length;
  if (n === TASTE_MAX_INLINE) return t("commandcode.taste.splitNotice", { count: n + 1, max: TASTE_MAX_INLINE });
  if (n === TASTE_MAX_INLINE + 1) return t("commandcode.taste.mergeNotice", { max: TASTE_MAX_INLINE });
  return "";
});

// ==================== 展示辅助 ====================

const confidenceBucket = (c) => {
  if (c === null || c === undefined) return "unknown";
  if (c < 0.6) return "low";
  if (c <= 0.85) return "mid";
  return "high";
};

const confidenceLabel = (c) => {
  const b = confidenceBucket(c);
  if (b === "unknown") return t("commandcode.taste.confidenceUnset");
  return `${c.toFixed(2)} · ${t(`commandcode.taste.confidence${b[0].toUpperCase()}${b.slice(1)}`)}`;
};

const confidenceTheme = (c) => {
  const b = confidenceBucket(c);
  return b === "high" ? "success" : b === "mid" ? "primary" : b === "low" ? "default" : "default";
};

const duplicateScopesText = (scopes) =>
  scopes
    .map((s) => t(s === "project" ? "commandcode.taste.scopeProject" : "commandcode.taste.scopeGlobal"))
    .join(" / ");

const summaryBuckets = computed(() => summary.value?.buckets || { low: 0, mid: 0, high: 0, unknown: 0 });
const duplicates = computed(() => summary.value?.duplicates || []);

onMounted(() => {
  loadProjects();
  refresh();
});
</script>

<template>
  <div class="commandcode-taste-container">
    <!-- 顶部：作用域切换 + 项目选择 + 操作 -->
    <div class="commandcode-taste-toolbar">
      <div class="commandcode-taste-toolbar-left">
        <RadioGroup v-model="scope" variant="default-filled" size="small" @change="onScopeChange">
          <RadioButton v-for="o in scopeOptions" :key="o.value" :value="o.value">{{ o.label }}</RadioButton>
        </RadioGroup>
        <template v-if="scope === 'project'">
          <Select
            v-if="projectOptions.length"
            :value="projectRoot"
            :options="projectOptions"
            class="commandcode-taste-project-select"
            size="small"
            filterable
            :placeholder="t('commandcode.taste.pickProjectTitle')"
            @change="onProjectChange"
          />
          <Tooltip :content="t('commandcode.taste.pickOtherProject')" placement="top">
            <Button size="small" variant="outline" @click="pickProjectRoot">
              <template #icon><FolderOpen1Icon /></template>
            </Button>
          </Tooltip>
        </template>
        <span v-else class="commandcode-taste-path">
          <Link theme="primary" :underline="true" @click="openTasteDir">{{ currentPkg.root || "—" }}</Link>
        </span>
      </div>
      <div class="commandcode-taste-toolbar-right">
        <Tooltip v-if="scope === 'project' && currentPkg.root" :content="t('commandcode.taste.openDir')" placement="top">
          <Button size="small" variant="outline" @click="openTasteDir">
            <template #icon><FolderOpen1Icon /></template>
          </Button>
        </Tooltip>
        <Button size="small" variant="outline" theme="primary" :disabled="!categories.length" @click="openAddEntry">
          <template #icon><AddIcon /></template> {{ t("commandcode.taste.addEntry") }}
        </Button>
        <Button size="small" variant="outline" @click="openCategoryDialog">
          <template #icon><AddIcon /></template> {{ t("commandcode.taste.addCategory") }}
        </Button>
        <Tooltip :content="t('commandcode.taste.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div class="commandcode-taste-tip">{{ t("commandcode.taste.tip") }}</div>

    <!-- 项目作用域但没发现任何项目、也没手动选过 -->
    <div v-if="scope === 'project' && !projectRoot" class="commandcode-taste-projectpick">
      <Empty :description="t('commandcode.taste.noProjects')">
        <template #action>
          <Button theme="primary" @click="pickProjectRoot">
            <template #icon><FolderOpen1Icon /></template> {{ t("commandcode.taste.pickProjectTitle") }}
          </Button>
        </template>
      </Empty>
    </div>

    <!-- 包不存在：给初始化入口 -->
    <div v-else-if="!currentPkg.exists" class="commandcode-taste-empty">
      <Empty :description="t('commandcode.taste.empty')">
        <template #action>
          <Button theme="primary" @click="initializePackage">
            <template #icon><AddIcon /></template> {{ t("commandcode.taste.initialize") }}
          </Button>
        </template>
      </Empty>
      <div class="commandcode-taste-empty-hint">{{ t("commandcode.taste.emptyHint") }}</div>
    </div>

    <div v-else class="commandcode-taste-body">
      <!-- 左：分类列表 -->
      <div class="commandcode-taste-sidebar">
        <div class="commandcode-taste-sidebar-title">
          <span>{{ t("commandcode.taste.categoryTitle") }}</span>
          <span class="commandcode-taste-sidebar-count">{{ categories.length }}</span>
        </div>
        <div v-if="!categories.length" class="commandcode-taste-sidebar-empty">
          {{ t("commandcode.taste.categoryEmpty") }}
        </div>
        <div
          v-for="cat in categories"
          :key="cat.name"
          class="commandcode-taste-cat"
          :class="{ 'is-active': cat.name === activeCategory }"
          @click="activeCategory = cat.name"
        >
          <ChevronRightIcon size="14px" class="commandcode-taste-cat-arrow" />
          <span class="commandcode-taste-cat-name">{{ cat.name }}</span>
          <Tooltip :content="cat.inline ? t('commandcode.taste.categoryInlineTip', { max: TASTE_MAX_INLINE }) : t('commandcode.taste.categoryFile', { path: cat.refPath || '' })" placement="top">
            <Tag size="small" :theme="cat.inline ? 'default' : 'primary'" variant="light">
              {{ cat.inline ? t("commandcode.taste.categoryInline") : t("commandcode.taste.categoryFile") }}
            </Tag>
          </Tooltip>
          <span class="commandcode-taste-cat-count">{{ cat.entries.length }}</span>
          <Popconfirm
            :content="t('commandcode.taste.deleteCategoryConfirm', { name: cat.name })"
            theme="danger"
            @confirm="handleDeleteCategory(cat)"
          >
            <span class="commandcode-taste-cat-del" @click.stop><DeleteIcon size="13px" /></span>
          </Popconfirm>
        </div>
      </div>

      <!-- 右：条目表 -->
      <div class="commandcode-taste-main">
        <template v-if="activeCat">
          <div class="commandcode-taste-main-header">
            <div class="commandcode-taste-main-title">
              <span>{{ activeCat.name }}</span>
              <span class="commandcode-taste-main-count">{{ t("commandcode.taste.entryCount", { count: activeEntries.length }) }}</span>
              <Tag v-if="activeCat.orphan" size="small" theme="warning" variant="light">
                {{ t("commandcode.taste.categoryOrphanTip") }}
              </Tag>
            </div>
            <Button size="small" variant="outline" @click="openAddEntry">
              <template #icon><AddIcon /></template> {{ t("commandcode.taste.addEntry") }}
            </Button>
          </div>

          <div v-if="splitNotice" class="commandcode-taste-notice">{{ splitNotice }}</div>

          <div v-if="!activeEntries.length" class="commandcode-taste-main-empty">
            {{ t("commandcode.taste.entryEmpty") }}
          </div>

          <div v-else class="commandcode-taste-entries">
            <div v-for="(entry, idx) in activeEntries" :key="idx" class="commandcode-taste-entry">
              <div class="commandcode-taste-entry-main">
                <div class="commandcode-taste-entry-text">{{ entry.text }}</div>
                <div class="commandcode-taste-entry-meta">
                  <Tag size="small" :theme="confidenceTheme(entry.confidence)" variant="light">
                    {{ confidenceLabel(entry.confidence) }}
                  </Tag>
                </div>
              </div>
              <Space size="small" class="commandcode-taste-entry-actions">
                <Tooltip :content="t('common.edit')" placement="top">
                  <Button size="small" theme="default" variant="text" @click="openEditEntry(entry, idx)">
                    <EditIcon />
                  </Button>
                </Tooltip>
                <Popconfirm :content="t('commandcode.taste.deleteConfirm')" theme="danger" @confirm="handleDeleteEntry(idx)">
                  <Tooltip :content="t('common.delete')" placement="top">
                    <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
                  </Tooltip>
                </Popconfirm>
              </Space>
            </div>
          </div>
        </template>

        <Empty v-else :description="t('commandcode.taste.categoryEmpty')" />
      </div>
    </div>

    <!-- 汇总 -->
    <Collapse v-if="currentPkg.exists" class="commandcode-taste-summary">
      <CollapsePanel :value="'summary'" :header="t('commandcode.taste.summaryTitle')">
        <template #content>
          <div v-if="!summary" class="commandcode-taste-summary-empty">—</div>
          <template v-else>
            <div class="commandcode-taste-summary-grid">
              <div class="commandcode-taste-summary-item">
                <span class="commandcode-taste-summary-label">{{ t("commandcode.taste.scopeProject") }}</span>
                <span class="commandcode-taste-summary-value">
                  {{ t("commandcode.taste.summaryCategories") }} {{ summary.scopes.project.categories }} ·
                  {{ t("commandcode.taste.summaryEntries") }} {{ summary.scopes.project.entries }}
                </span>
              </div>
              <div class="commandcode-taste-summary-item">
                <span class="commandcode-taste-summary-label">{{ t("commandcode.taste.scopeGlobal") }}</span>
                <span class="commandcode-taste-summary-value">
                  {{ t("commandcode.taste.summaryCategories") }} {{ summary.scopes.global.categories }} ·
                  {{ t("commandcode.taste.summaryEntries") }} {{ summary.scopes.global.entries }}
                </span>
              </div>
              <div class="commandcode-taste-summary-item">
                <span class="commandcode-taste-summary-label">{{ t("commandcode.taste.summaryHigh") }}</span>
                <span class="commandcode-taste-summary-value">{{ summaryBuckets.high }}</span>
              </div>
              <div class="commandcode-taste-summary-item">
                <span class="commandcode-taste-summary-label">{{ t("commandcode.taste.summaryMid") }}</span>
                <span class="commandcode-taste-summary-value">{{ summaryBuckets.mid }}</span>
              </div>
              <div class="commandcode-taste-summary-item">
                <span class="commandcode-taste-summary-label">{{ t("commandcode.taste.summaryLow") }}</span>
                <span class="commandcode-taste-summary-value">{{ summaryBuckets.low }}</span>
              </div>
              <div class="commandcode-taste-summary-item">
                <span class="commandcode-taste-summary-label">{{ t("commandcode.taste.summaryUnknown") }}</span>
                <span class="commandcode-taste-summary-value">{{ summaryBuckets.unknown }}</span>
              </div>
            </div>

            <div class="commandcode-taste-dup-title">
              {{ t("commandcode.taste.summaryDuplicatesTitle", { count: duplicates.length }) }}
            </div>
            <div v-if="!duplicates.length" class="commandcode-taste-dup-empty">
              {{ t("commandcode.taste.summaryDuplicatesEmpty") }}
            </div>
            <div v-else class="commandcode-taste-dup-list">
              <div v-for="(d, i) in duplicates" :key="i" class="commandcode-taste-dup">
                <span class="commandcode-taste-dup-text">{{ d.text }}</span>
                <Tag size="small" variant="light">{{ d.count }}×</Tag>
                <span class="commandcode-taste-dup-scopes">
                  {{ t("commandcode.taste.duplicateInScopes", { scopes: duplicateScopesText(d.scopes) }) }}
                </span>
              </div>
            </div>
          </template>
        </template>
      </CollapsePanel>
    </Collapse>

    <!-- 新建分类 -->
    <Dialog
      v-model:visible="categoryDialog"
      :header="t('commandcode.taste.addCategoryTitle')"
      width="480px"
      :confirm-btn="{ content: t('common.add'), theme: 'primary' }"
      @confirm="handleAddCategory"
    >
      <div class="commandcode-taste-form">
        <div class="commandcode-taste-form-item">
          <label>{{ t("commandcode.taste.categoryNameLabel") }}</label>
          <Input v-model="newCategoryName" :placeholder="t('commandcode.taste.categoryNamePlaceholder')" />
          <div class="commandcode-taste-form-hint">{{ t("commandcode.taste.categoryNameHint") }}</div>
        </div>
      </div>
    </Dialog>

    <!-- 添加 / 编辑条目 -->
    <Dialog
      v-model:visible="entryDialog"
      :header="editingIndex >= 0 ? t('commandcode.taste.editEntryTitle') : t('commandcode.taste.addEntryTitle')"
      width="560px"
      :confirm-btn="{ content: t('common.save'), theme: 'primary' }"
      @confirm="handleSaveEntry"
    >
      <div class="commandcode-taste-form">
        <div v-if="editingIndex < 0" class="commandcode-taste-form-item">
          <label>{{ t("commandcode.taste.categoryTitle") }}</label>
          <Select
            v-model="entryForm.category"
            :options="categories.map((c) => ({ label: c.name, value: c.name }))"
            :placeholder="t('commandcode.taste.categoryNamePlaceholder')"
          />
        </div>
        <div class="commandcode-taste-form-item">
          <label>{{ t("commandcode.taste.entryTextLabel") }}</label>
          <Input v-model="entryForm.text" :placeholder="t('commandcode.taste.entryTextPlaceholder')" />
          <div class="commandcode-taste-form-hint">{{ t("commandcode.taste.entryTextHint") }}</div>
        </div>
        <div class="commandcode-taste-form-item">
          <label>{{ t("commandcode.taste.confidenceLabel") }} — {{ entryForm.confidence.toFixed(2) }}</label>
          <Slider v-model="entryForm.confidence" :min="0" :max="1" :step="0.05" />
          <div class="commandcode-taste-form-hint">{{ t("commandcode.taste.confidenceHint") }}</div>
        </div>
      </div>
    </Dialog>
  </div>
</template>
