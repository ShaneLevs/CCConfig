<script setup>
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Space, Dialog, Input, InputNumber, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link,
  Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon,
  CopyIcon, LockOnIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import "./styles/ConfigView.css";

const { t } = useI18n();

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const defaultModel = ref("");
const expandedList = ref([]);

// ==================== 弹窗状态 ====================

const addProviderDialog = ref(false);
const addProviderForm = ref({ name: "", kind: "openai", baseUrl: "", chatUrl: "", modelsUrl: "", requestUrl: "", apiKeyEnv: "", apiKey: "", contextWindow: 0, maxOutputTokens: 0 });
// 添加弹窗内 Key 环境变量名的提示（选择已有变量时显示是否已存 Key）
const addApiKeyEnvHint = ref("");
const editDialog = ref(false);
const editingProvider = ref("");
const editForm = ref({ name: "", kind: "openai", baseUrl: "", chatUrl: "", modelsUrl: "", requestUrl: "", apiKeyEnv: "", apiKey: "", contextWindow: 0, maxOutputTokens: 0 });
// 编辑弹窗内 Key 环境变量名的提示（共享/已存 Key）
const editEnvHint = ref("");

const addModelDialog = ref(false);
const addModelProvider = ref("");
const addModelId = ref("");

// Reasonix 支持的 provider kind（官方 internal/contract/config 的三种实现）：
//   openai    — OpenAI 兼容 /chat/completions（绝大多数中转站）
//   anthropic — Anthropic 兼容 /v1/messages
//   gemini    — Google Interactions API（官方标注实验性；写 "google" 会被配置校验拒绝）
const kindOptions = [
  { label: "openai", value: "openai" },
  { label: "anthropic", value: "anthropic" },
  { label: "gemini", value: "gemini" },
];
// 编辑弹窗初始加载的 key，用于保存时判断是否被用户修改
const originalApiKey = ref("");

// ==================== .env 环境变量管理 ====================

const envEntries = ref([]);
const envDialog = ref(false);
const envForm = ref({ name: "", value: "" });
// 当前正在行内编辑值的变量名（null = 全部收起，只读展示）
const editingEnvName = ref(null);
const editingEnvValue = ref("");

const loadEnv = () => {
  try {
    const env = window.services.readReasonixEnv() || {};
    envEntries.value = Object.entries(env)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    console.error("读取 Reasonix .env 失败:", e);
    envEntries.value = [];
  }
};

// 环境变量名 → 引用它的供应商名（删除/编辑时提示）
// 预计算成 Map，避免模板里每行每个引用位点反复 filter
const envRefMap = computed(() => {
  const map = new Map();
  for (const p of providers.value) {
    if (!p.apiKeyEnv) continue;
    if (!map.has(p.apiKeyEnv)) map.set(p.apiKeyEnv, []);
    map.get(p.apiKeyEnv).push(p.name);
  }
  return map;
});
const envRefProviders = (name) => envRefMap.value.get(name) || [];

// Key 环境变量下拉选项 = .env 中已存在的变量名
const envKeyOptions = computed(() => envEntries.value.map(e => ({ label: e.name, value: e.name })));

// 掩码显示：只保留前 4 + 后 4，中间用 ··· 替代
const maskValue = (val) => {
  if (!val) return "";
  if (val.length <= 10) return "••••••";
  return val.slice(0, 4) + "····" + val.slice(-4);
};

const startEditEnv = (entry) => {
  editingEnvName.value = entry.name;
  editingEnvValue.value = entry.value;
};

const cancelEditEnv = () => {
  editingEnvName.value = null;
  editingEnvValue.value = "";
};

const saveEnvEntry = (entry) => {
  try {
    if (!String(editingEnvValue.value || "").trim()) { MessagePlugin.warning(t("reasonix.env.valueRequired")); return; }
    window.services.writeReasonixEnvKey(entry.name, String(editingEnvValue.value).trim());
    entry.value = String(editingEnvValue.value).trim();
    MessagePlugin.success(t("reasonix.env.saved", { name: entry.name }));
    cancelEditEnv();
  } catch (e) {
    MessagePlugin.error(t("reasonix.env.saveFailed", { message: e.message }));
  }
};

const openAddEnvDialog = () => {
  envForm.value = { name: "", value: "" };
  envDialog.value = true;
};

const handleAddEnv = () => {
  try {
    const name = envForm.value.name.trim();
    const value = String(envForm.value.value || "").trim();
    if (!name) { MessagePlugin.warning(t("reasonix.env.nameRequired")); return; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      MessagePlugin.warning(t("reasonix.env.nameInvalid"));
      return;
    }
    if (envEntries.value.some(e => e.name === name)) { MessagePlugin.warning(t("reasonix.env.exists", { name })); return; }
    if (!value) { MessagePlugin.warning(t("reasonix.env.valueEmpty")); return; }
    window.services.writeReasonixEnvKey(name, value);
    MessagePlugin.success(t("reasonix.env.added", { name }));
    envDialog.value = false;
    loadEnv();
  } catch (e) {
    MessagePlugin.error(t("reasonix.env.addFailed", { message: e.message }));
  }
};

const handleDeleteEnv = (name) => {
  try {
    window.services.deleteReasonixEnvKey(name);
    MessagePlugin.success(t("reasonix.env.deleted", { name }));
    loadEnv();
  } catch (e) {
    MessagePlugin.error(t("reasonix.env.deleteFailed", { message: e.message }));
  }
};

// 复制值到剪贴板（uTools 环境用 utools.copyText，比 navigator.clipboard 可靠）
const copyEnvValue = (val) => {
  try {
    window.utools.copyText(val);
    MessagePlugin.success(t("common.copiedToClipboard"));
  } catch {
    MessagePlugin.error(t("common.copyFailed"));
  }
};

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    const list = window.services.getReasonixProviderList() || [];
    defaultModel.value = window.services.getReasonixDefaultModel() || "";
    // 默认供应商排最前
    providers.value = list.sort((a, b) => Number(isDefaultProvider(b)) - Number(isDefaultProvider(a)));
    loadEnv();
  } catch (e) {
    console.error("加载 Reasonix 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
};

// ==================== 默认模型 ====================

// 判断供应商是否为全局默认（default_model 指向其某个模型，或裸供应商名）
const isDefaultProvider = (p) => {
  const dm = defaultModel.value;
  if (!dm) return false;
  if (dm === p.name) return true;
  if (dm.startsWith(`${p.name}/`)) return true;
  return false;
};

// 判断模型是否为全局默认模型（provider/model 引用，或裸供应商名解析到其 default）
const isDefaultModel = (prov, m) => {
  const dm = defaultModel.value;
  if (!dm) return false;
  if (dm === `${prov.name}/${m}`) return true;
  if (dm === prov.name && prov.default === m) return true;
  return false;
};

// 模型上点星标 → 设为全局默认模型（provider/model）
const setDefaultModel = (providerName, modelId) => {
  try {
    const ref = `${providerName}/${modelId}`;
    window.services.setReasonixDefaultModel(ref);
    MessagePlugin.success(t("reasonix.model.defaultSet", { ref }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("reasonix.model.saveFailed", { message: e.message }));
  }
};

// ==================== 供应商 CRUD ====================

const emptyProviderForm = () => ({ name: "", kind: "openai", baseUrl: "", chatUrl: "", modelsUrl: "", requestUrl: "", apiKeyEnv: "", apiKey: "", contextWindow: 0, maxOutputTokens: 0 });

const buildProviderPayload = (form) => ({
  name: form.name,
  kind: form.kind,
  baseUrl: form.baseUrl,
  chatUrl: form.chatUrl,
  modelsUrl: form.modelsUrl,
  requestUrl: form.requestUrl,
  apiKeyEnv: form.apiKeyEnv,
  apiKey: form.apiKey,
  contextWindow: Number(form.contextWindow) || 0,
  maxOutputTokens: Number(form.maxOutputTokens) || 0,
});

const openAddProviderDialog = () => {
  addProviderForm.value = emptyProviderForm();
  addApiKeyEnvHint.value = "";
  addProviderDialog.value = true;
};

// 添加弹窗：选择已有环境变量时提示是否已存 Key，避免误覆盖共享 key
const onAddApiKeyEnvChange = (newEnv) => {
  const env = String(newEnv || "").trim();
  addProviderForm.value.apiKeyEnv = env;
  if (!env) { addApiKeyEnvHint.value = ""; return; }
  const key = window.services.getReasonixApiKey(env);
  const refs = envRefProviders(env);
  if (key) {
    addApiKeyEnvHint.value = refs.length
      ? t("reasonix.env.hintHasKeyWithRefs", { providers: refs.join(t("common.listSeparator")) })
      : t("reasonix.env.hintHasKey");
  } else {
    addApiKeyEnvHint.value = t("reasonix.env.hintNoKey");
  }
};

const handleAddProvider = () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning(t("reasonix.provider.nameRequired")); return; }
    const form = { ...addProviderForm.value, name, apiKeyEnv: addProviderForm.value.apiKeyEnv.trim() };
    // 留空时按 Reasonix 官方命名规则生成（CONFIG_PATHS.md "Custom provider api_key_env names"）
    if (!form.apiKeyEnv) form.apiKeyEnv = window.services.generateReasonixApiKeyEnv(name);
    window.services.addReasonixProvider(buildProviderPayload(form));
    MessagePlugin.success(t("reasonix.provider.added", { name }));
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("reasonix.provider.addFailed", { message: e.message }));
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.name;
  editForm.value = {
    name: provider.name,
    kind: provider.kind || "openai",
    baseUrl: provider.baseUrl || "",
    chatUrl: provider.chatUrl || "",
    modelsUrl: provider.modelsUrl || "",
    requestUrl: provider.requestUrl || "",
    apiKeyEnv: provider.apiKeyEnv || "",
    apiKey: window.services.getReasonixApiKey(provider.apiKeyEnv) || "",
    contextWindow: provider.contextWindow || 0,
    maxOutputTokens: provider.maxOutputTokens || 0,
  };
  originalApiKey.value = editForm.value.apiKey;
  editEnvHint.value = buildEnvHint(editingProvider.value, editForm.value.apiKeyEnv);
  editDialog.value = true;
};

// 编辑弹窗内 Key 环境变量名的提示：是否被其他供应商共享 / 是否已存有 Key
const buildEnvHint = (providerName, env) => {
  if (!env) return "";
  const shared = providers.value
    .filter(p => p.apiKeyEnv === env && p.name !== providerName)
    .map(p => p.name);
  const key = window.services.getReasonixApiKey(env);
  const parts = [];
  if (shared.length) parts.push(t("reasonix.env.sharedRefs", { providers: shared.join(t("common.listSeparator")) }));
  if (key) parts.push(t("reasonix.env.keyExistsHint"));
  else parts.push(t("reasonix.env.noKeyHint"));
  return parts.join(t("reasonix.env.hintSeparator"));
};

// 编辑弹窗：Key 环境变量名变更 → 重载该变量已存的 key，避免静默指向共享/已有 key
const onEditApiKeyEnvChange = (newEnv) => {
  const env = String(newEnv || "").trim();
  editForm.value.apiKeyEnv = env;
  const key = env ? (window.services.getReasonixApiKey(env) || "") : "";
  editForm.value.apiKey = key;
  originalApiKey.value = key;
  editEnvHint.value = buildEnvHint(editingProvider.value, env);
};

const handleSaveProvider = () => {
  try {
    const { apiKey, ...rest } = editForm.value;
    const newName = String(editForm.value.name || "").trim();
    if (!newName) { MessagePlugin.warning(t("reasonix.provider.nameRequired")); return; }
    // 已保存过 key 且用户清空了输入框 → 走删除确认流程
    if (originalApiKey.value && !apiKey && editForm.value.apiKeyEnv) {
      const newEnv = editForm.value.apiKeyEnv;
      const oldEnv = providers.value.find(p => p.name === editingProvider.value)?.apiKeyEnv || "";
      pendingDeleteKeyEnv.value = newEnv;
      // clearApiKey 会同时清理新名与旧名的 key，两个名的共享者都要列出
      sharedEnvProviders.value = [];
      const newRefs = providers.value
        .filter(p => p.apiKeyEnv === newEnv && p.name !== editingProvider.value)
        .map(p => p.name);
      if (newRefs.length) sharedEnvProviders.value.push({ env: newEnv, providers: newRefs });
      if (oldEnv && oldEnv !== newEnv) {
        const oldRefs = providers.value
          .filter(p => p.apiKeyEnv === oldEnv && p.name !== editingProvider.value)
          .map(p => p.name);
        if (oldRefs.length) sharedEnvProviders.value.push({ env: oldEnv, providers: oldRefs });
      }
      deleteKeyDialog.value = true;
      return;
    }
    // 填了新 key 但 env 名为空 → key 无处可存，提示而非静默丢弃
    if (apiKey && !editForm.value.apiKeyEnv) {
      MessagePlugin.warning(t("reasonix.provider.envRequiredForKey"));
      return;
    }
    // 清空了 key 且 env 名为空 → 无法定位要删的 key，提示旧 key 仍保留在 .env
    if (originalApiKey.value && !apiKey && !editForm.value.apiKeyEnv) {
      MessagePlugin.warning(t("reasonix.provider.clearedNoEnv"));
      return;
    }
    const payload = buildProviderPayload({ ...rest, name: newName });
    // key 未修改则不回传，避免对 .env 做无意义写入（也避免把已保存的 key 再透传一遍）
    if (apiKey && apiKey !== originalApiKey.value) payload.apiKey = apiKey;
    const renamed = newName !== editingProvider.value;
    window.services.updateReasonixProvider(editingProvider.value, payload);
    MessagePlugin.success(renamed ? t("reasonix.provider.updatedRenamed", { name: newName }) : t("reasonix.provider.updated"));
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("reasonix.provider.saveFailed", { message: e.message }));
  }
};

// 删除已保存 key（清空 key 输入框保存时触发）
const deleteKeyDialog = ref(false);
const pendingDeleteKeyEnv = ref("");
// 共享同一 env 名（含新名/旧名）的其他供应商，删除确认时提示
// 结构：[{ env, providers: string[] }]
const sharedEnvProviders = ref([]);

// 取消删除时恢复 key 输入框，避免误触后无法找回
const cancelDeleteKey = () => {
  editForm.value.apiKey = originalApiKey.value;
};

const confirmDeleteKey = () => {
  try {
    const newName = String(editForm.value.name || "").trim();
    if (!newName) { MessagePlugin.warning(t("reasonix.provider.nameRequired")); return; }
    // clearApiKey 由后端统一处理：清理旧/新 env 名下已保存的 key
    window.services.updateReasonixProvider(editingProvider.value, {
      ...buildProviderPayload({ ...editForm.value, name: newName }),
      clearApiKey: true,
    });
    MessagePlugin.success(t("reasonix.provider.keyDeleted"));
    deleteKeyDialog.value = false;
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("reasonix.provider.deleteFailed", { message: e.message }));
  }
};

const handleDeleteProvider = (providerName) => {
  try {
    window.services.deleteReasonixProvider(providerName);
    MessagePlugin.success(t("reasonix.provider.deleted", { name: providerName }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("reasonix.provider.deleteFailed", { message: e.message }));
  }
};

// ==================== 模型 CRUD ====================

const openAddModelDialog = (providerName) => {
  addModelProvider.value = providerName;
  addModelId.value = "";
  addModelDialog.value = true;
};

const handleAddModel = () => {
  try {
    const id = addModelId.value.trim();
    if (!id) { MessagePlugin.warning(t("model.idRequired")); return; }
    window.services.addReasonixModel(addModelProvider.value, id);
    MessagePlugin.success(t("reasonix.model.added", { id }));
    addModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("reasonix.model.addFailed", { message: e.message }));
  }
};

const handleDeleteModel = (providerName, modelId) => {
  try {
    window.services.deleteReasonixModel(providerName, modelId);
    MessagePlugin.success(t("reasonix.model.deleted", { id: modelId }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("reasonix.model.deleteFailed", { message: e.message }));
  }
};

// ==================== 逐模型覆盖（model_overrides） ====================

const overrideDialog = ref(false);
const overrideProvider = ref("");
const overrideModel = ref("");
const overrideForm = ref({ contextWindow: 0, maxOutputTokens: 0 });
// 该模型下不受 UI 管理的其它覆盖项（reasoning_protocol / vision 等），仅提示不编辑
const overrideExtraKeys = ref([]);

const openOverrideDialog = (provider, modelId) => {
  overrideProvider.value = provider.name;
  overrideModel.value = modelId;
  const ov = provider.modelOverrides?.[modelId] || {};
  overrideForm.value = {
    contextWindow: Number(ov.context_window) || 0,
    maxOutputTokens: Number(ov.max_output_tokens) || 0,
  };
  overrideExtraKeys.value = Object.keys(ov).filter(
    (k) => k !== "context_window" && k !== "max_output_tokens",
  );
  overrideDialog.value = true;
};

const handleSaveOverride = () => {
  try {
    window.services.setReasonixModelOverride(overrideProvider.value, overrideModel.value, {
      contextWindow: Number(overrideForm.value.contextWindow) || 0,
      maxOutputTokens: Number(overrideForm.value.maxOutputTokens) || 0,
    });
    MessagePlugin.success(t("reasonix.override.saved", { id: overrideModel.value }));
    overrideDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("reasonix.override.saveFailed", { message: e.message }));
  }
};

// 模型上的覆盖摘要（只在真的配了逐模型上下文/输出时显示，避免每个 tag 都挂数字）
const overrideLabel = (provider, modelId) => {
  const ov = provider.modelOverrides?.[modelId];
  if (!ov) return "";
  const parts = [];
  if (ov.context_window) parts.push(`C ${formatNumber(ov.context_window)}`);
  if (ov.max_output_tokens) parts.push(`O ${formatNumber(ov.max_output_tokens)}`);
  return parts.join(" · ");
};

const formatNumber = (n) => {
  if (!n) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
};

const openReasonixDir = () => {
  try { window.services.openReasonixDir(); } catch { /* ignore */ }
};

onMounted(refresh);
</script>

<template>
  <div class="reasonix-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="reasonix-toolbar">
      <div class="reasonix-toolbar-left">
        <span class="reasonix-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openReasonixDir">~/.reasonix/</Link>
          <span class="reasonix-toolbar-sub">config.toml + .env</span>
        </span>
      </div>
      <div class="reasonix-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> {{ t("reasonix.provider.add") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="reasonix-config-warning">
      <t-alert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <!-- 供应商列表 -->
      <div v-if="providers.length === 0" class="reasonix-config-empty">
        <Empty :description="t('reasonix.config.emptyProviders')" />
      </div>

      <div v-else class="reasonix-provider-list">
        <Collapse v-model="expandedList" class="reasonix-provider-collapse">
          <CollapsePanel
            v-for="p in providers"
            :key="p.name"
            :value="p.name"
          >
            <!-- 供应商头部：展开箭头由 Collapse 内置渲染，名称 + 标签 + 操作 -->
            <template #header>
              <div class="reasonix-provider-header-left">
                <span class="reasonix-provider-name">{{ p.name }}</span>
                <Tag size="small" variant="outline">{{ p.kind }}</Tag>
                <Tag v-if="isDefaultProvider(p)" size="small" theme="warning" variant="light">{{ t("common.default") }}</Tag>
                <span class="reasonix-model-count">{{ t("reasonix.config.modelCount", { count: p.models.length }, p.models.length) }}</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="reasonix-provider-header-right" @click.stop>
                <Button size="small" theme="default" variant="text" @click="handleEdit(p)">
                  <template #icon><EditIcon /></template> {{ t("common.edit") }}
                </Button>
                <Tooltip :content="t('reasonix.provider.deleteTooltip')">
                  <Popconfirm
                    :content="p.apiKeyEnv ? t('reasonix.provider.deleteConfirmWithEnv', { env: p.apiKeyEnv }) : t('reasonix.provider.deleteConfirm')"
                    theme="danger"
                    @confirm="handleDeleteProvider(p.name)"
                  >
                    <Button size="small" theme="danger" variant="text">
                      <template #icon><DeleteIcon /></template>
                    </Button>
                  </Popconfirm>
                </Tooltip>
              </div>
            </template>

            <!-- 展开内容：详情 + 模型 -->
            <template #content>
              <div class="reasonix-provider-body">
            <div class="reasonix-provider-details">
              <div class="reasonix-detail-item">
                <span class="reasonix-detail-label">Base URL</span>
                <span class="reasonix-detail-value">{{ p.baseUrl || "—" }}</span>
              </div>
              <div v-if="p.requestUrl" class="reasonix-detail-item">
                <span class="reasonix-detail-label">Request URL</span>
                <span class="reasonix-detail-value">{{ p.requestUrl }}</span>
              </div>
              <div v-if="p.chatUrl" class="reasonix-detail-item">
                <span class="reasonix-detail-label">Chat URL</span>
                <span class="reasonix-detail-value">{{ p.chatUrl }}</span>
              </div>
              <div v-if="p.modelsUrl" class="reasonix-detail-item">
                <span class="reasonix-detail-label">Models URL</span>
                <span class="reasonix-detail-value">{{ p.modelsUrl }}</span>
              </div>
              <div class="reasonix-detail-item">
                <span class="reasonix-detail-label">{{ t("reasonix.provider.keyEnv") }}</span>
                <span class="reasonix-detail-value mono">{{ p.apiKeyEnv || "—" }}</span>
              </div>
              <div v-if="p.contextWindow || p.maxOutputTokens" class="reasonix-detail-item">
                <span class="reasonix-detail-label">{{ t("reasonix.provider.limits") }}</span>
                <span class="reasonix-detail-value">
                  <template v-if="p.contextWindow">{{ t("common.contextWindow") }} {{ formatNumber(p.contextWindow) }}</template>
                  <template v-if="p.contextWindow && p.maxOutputTokens"> · </template>
                  <template v-if="p.maxOutputTokens">{{ t("common.maxOutput") }} {{ formatNumber(p.maxOutputTokens) }}</template>
                </span>
              </div>
            </div>

            <!-- 模型子区 -->
            <div class="reasonix-models-section">
              <div class="reasonix-models-title">
                <span>{{ t("reasonix.config.modelsTitle") }}</span>
                <Button size="small" variant="outline" @click="openAddModelDialog(p.name)">
                  <template #icon><AddIcon /></template> {{ t("common.add") }}
                </Button>
              </div>
              <div v-if="p.models.length === 0" class="reasonix-models-empty">{{ t("reasonix.config.modelsEmpty") }}</div>
              <div class="reasonix-model-tags">
                <span v-for="m in p.models" :key="m" class="reasonix-model-tag">
                  <span class="reasonix-model-tag-name">{{ m }}</span>
                  <Tag v-if="overrideLabel(p, m)" size="small" variant="light">{{ overrideLabel(p, m) }}</Tag>
                  <Tag v-if="isDefaultModel(p, m)" size="small" theme="success" variant="light">{{ t("common.default") }}</Tag>
                  <Tooltip v-if="!isDefaultModel(p, m)" :content="t('reasonix.model.setDefaultTooltip')" placement="top">
                    <span class="reasonix-model-tag-star" @click="setDefaultModel(p.name, m)"><StarIcon size="12px" /></span>
                  </Tooltip>
                  <Tooltip :content="t('reasonix.override.editTooltip')" placement="top">
                    <span class="reasonix-model-tag-edit" @click="openOverrideDialog(p, m)"><EditIcon size="12px" /></span>
                  </Tooltip>
                  <Popconfirm :content="t('reasonix.model.deleteConfirm')" theme="danger" @confirm="handleDeleteModel(p.name, m)">
                    <span class="reasonix-model-tag-del"><DeleteIcon size="12px" /></span>
                  </Popconfirm>
                </span>
              </div>
            </div>
          </div>
        </template>
        </CollapsePanel>
        </Collapse>
      </div>

      <!-- 环境变量 / API Key -->
      <div class="reasonix-env-section">
        <div class="reasonix-env-header">
          <Space size="8px" align="center">
            <span class="reasonix-block-title">{{ t("reasonix.env.title") }}</span>
            <Tag size="small" variant="outline">{{ envEntries.length }}</Tag>
            <span class="reasonix-block-sub">~/.reasonix/.env</span>
          </Space>
          <Button size="small" variant="outline" @click="openAddEnvDialog">
            <template #icon><AddIcon /></template> {{ t("reasonix.env.add") }}
          </Button>
        </div>

        <div v-if="envEntries.length === 0" class="reasonix-env-empty">
          {{ t("reasonix.env.emptyHint") }}
        </div>

        <div v-else class="reasonix-env-list">
          <div v-for="e in envEntries" :key="e.name" class="reasonix-env-item">
            <!-- 左：变量名 + 引用标记 -->
            <div class="reasonix-env-name-col">
              <span class="reasonix-env-name mono">{{ e.name }}</span>
              <Tooltip v-if="envRefProviders(e.name).length" :content="t('reasonix.env.referencedBy', { providers: envRefProviders(e.name).join(t('common.listSeparator')) })">
                <Tag size="small" theme="warning" variant="light">{{ t("reasonix.env.refCount", { count: envRefProviders(e.name).length }, envRefProviders(e.name).length) }}</Tag>
              </Tooltip>
            </div>

            <!-- 右：值展示/编辑 + 操作 -->
            <div class="reasonix-env-value-col">
              <template v-if="editingEnvName === e.name">
                <ApiKeyInput v-model="editingEnvValue" :placeholder="t('reasonix.env.newValuePlaceholder')" class="reasonix-env-edit-input" />
                <Button size="small" theme="primary" variant="base" @click="saveEnvEntry(e)">{{ t("common.save") }}</Button>
                <Button size="small" variant="text" @click="cancelEditEnv">{{ t("common.cancel") }}</Button>
              </template>
              <template v-else>
                <span class="reasonix-env-mask mono">
                  <LockOnIcon size="12px" class="reasonix-env-lock" />
                  {{ maskValue(e.value) }}
                </span>
                <Tooltip :content="t('common.copy')">
                  <Button size="small" variant="text" @click="copyEnvValue(e.value)">
                    <template #icon><CopyIcon /></template>
                  </Button>
                </Tooltip>
                <Button size="small" variant="text" @click="startEditEnv(e)">{{ t("common.edit") }}</Button>
                <Popconfirm
                  :content="envRefProviders(e.name).length
                    ? t('reasonix.env.deleteConfirmReferenced', { providers: envRefProviders(e.name).join(t('common.listSeparator')) })
                    : t('reasonix.env.deleteConfirm')"
                  theme="danger"
                  @confirm="handleDeleteEnv(e.name)"
                >
                  <Button size="small" theme="danger" variant="text">
                    <template #icon><DeleteIcon /></template>
                  </Button>
                </Popconfirm>
              </template>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 添加供应商弹窗 -->
    <Dialog v-model:visible="addProviderDialog" :header="t('reasonix.provider.addTitle')" width="520px" :confirm-btn="{ content: t('common.add'), theme: 'primary' }" @confirm="handleAddProvider">
      <div class="reasonix-edit-form">
        <div class="reasonix-form-item"><label>{{ t("common.name") }} <span class="reasonix-form-required">*</span></label><Input v-model="addProviderForm.name" placeholder="deepseek" /></div>
        <div class="reasonix-form-item"><label>Kind</label><Select v-model="addProviderForm.kind" :options="kindOptions" creatable /></div>
        <div class="reasonix-form-item"><label>Base URL</label><Input v-model="addProviderForm.baseUrl" placeholder="https://api.deepseek.com" /></div>
        <div class="reasonix-form-item">
          <label>{{ t("reasonix.provider.requestUrlOptional") }}</label>
          <Input v-model="addProviderForm.requestUrl" :placeholder="t('reasonix.provider.requestUrlPlaceholder')" />
          <div class="reasonix-form-hint">{{ t("reasonix.provider.requestUrlHint") }}</div>
        </div>
        <div class="reasonix-form-row">
          <div class="reasonix-form-item"><label>{{ t("reasonix.provider.chatUrlOptional") }}</label><Input v-model="addProviderForm.chatUrl" :placeholder="t('reasonix.provider.chatUrlPlaceholder')" /></div>
        </div>
        <div class="reasonix-form-item"><label>{{ t("reasonix.provider.modelsUrlOptional") }}</label><Input v-model="addProviderForm.modelsUrl" :placeholder="t('reasonix.provider.modelsUrlPlaceholder')" /></div>
        <div class="reasonix-form-item">
          <label>{{ t("reasonix.provider.keyEnvLabel") }}</label>
          <Select
            v-model="addProviderForm.apiKeyEnv"
            :options="envKeyOptions"
            filterable
            creatable
            clearable
            :placeholder="t('reasonix.provider.keyEnvPlaceholder')"
            @change="onAddApiKeyEnvChange"
          />
          <div v-if="addApiKeyEnvHint" class="reasonix-form-hint">{{ addApiKeyEnvHint }}</div>
        </div>
        <div class="reasonix-form-item"><label>API Key</label><ApiKeyInput v-model="addProviderForm.apiKey" :placeholder="t('reasonix.provider.apiKeyPlaceholder')" /></div>
        <div class="reasonix-form-item"><label>{{ t("common.contextWindow") }}</label><InputNumber v-model="addProviderForm.contextWindow" :min="0" :step="1000" /></div>
        <div class="reasonix-form-item"><label>{{ t("common.maxOutput") }}</label><InputNumber v-model="addProviderForm.maxOutputTokens" :min="0" :step="1000" /></div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗 -->
    <Dialog v-model:visible="editDialog" :header="t('reasonix.provider.editTitle')" width="520px" :confirm-btn="{ content: t('common.save'), theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="reasonix-edit-form">
        <div class="reasonix-form-item"><label>{{ t("common.name") }} <span class="reasonix-form-required">*</span></label><Input v-model="editForm.name" placeholder="deepseek" /></div>
        <div class="reasonix-form-item"><label>Kind</label><Select v-model="editForm.kind" :options="kindOptions" creatable /></div>
        <div class="reasonix-form-item"><label>Base URL</label><Input v-model="editForm.baseUrl" placeholder="https://api.deepseek.com" /></div>
        <div class="reasonix-form-item">
          <label>{{ t("reasonix.provider.requestUrlOptional") }}</label>
          <Input v-model="editForm.requestUrl" :placeholder="t('reasonix.provider.requestUrlPlaceholder')" />
          <div class="reasonix-form-hint">{{ t("reasonix.provider.requestUrlHint") }}</div>
        </div>
        <div class="reasonix-form-item"><label>{{ t("reasonix.provider.chatUrlOptional") }}</label><Input v-model="editForm.chatUrl" /></div>
        <div class="reasonix-form-item"><label>{{ t("reasonix.provider.modelsUrlOptional") }}</label><Input v-model="editForm.modelsUrl" /></div>
        <div class="reasonix-form-item">
          <label>{{ t("reasonix.provider.keyEnvLabel") }}</label>
          <Select
            v-model="editForm.apiKeyEnv"
            :options="envKeyOptions"
            filterable
            creatable
            clearable
            @change="onEditApiKeyEnvChange"
          />
          <div v-if="editEnvHint" class="reasonix-form-hint">{{ editEnvHint }}</div>
        </div>
        <div class="reasonix-form-item"><label>API Key</label><ApiKeyInput v-model="editForm.apiKey" :placeholder="editForm.apiKeyEnv ? (originalApiKey ? t('reasonix.provider.apiKeyPlaceholderSaved') : t('reasonix.provider.apiKeyPlaceholder')) : t('reasonix.provider.apiKeyPlaceholder')" /></div>
        <div class="reasonix-form-item"><label>{{ t("common.contextWindow") }}</label><InputNumber v-model="editForm.contextWindow" :min="0" :step="1000" /></div>
        <div class="reasonix-form-item"><label>{{ t("common.maxOutput") }}</label><InputNumber v-model="editForm.maxOutputTokens" :min="0" :step="1000" /></div>
      </div>
    </Dialog>

    <!-- 添加模型弹窗 -->
    <Dialog v-model:visible="addModelDialog" :header="t('model.addTitle')" width="420px" :confirm-btn="{ content: t('common.add'), theme: 'primary' }" @confirm="handleAddModel">
      <div class="reasonix-edit-form">
        <div class="reasonix-form-item">
          <label>{{ t("model.id") }} <span class="reasonix-form-required">*</span></label>
          <Input v-model="addModelId" placeholder="deepseek-v4-flash" @enter="handleAddModel" />
        </div>
        <div class="reasonix-form-hint">{{ t("reasonix.model.providerLabel", { provider: addModelProvider }) }}</div>
      </div>
    </Dialog>

    <!-- 逐模型覆盖弹窗（model_overrides.<模型>） -->
    <Dialog v-model:visible="overrideDialog" :header="t('reasonix.override.title')" width="460px" :confirm-btn="{ content: t('common.save'), theme: 'primary' }" @confirm="handleSaveOverride">
      <div class="reasonix-edit-form">
        <div class="reasonix-form-hint">{{ t("reasonix.override.scopeHint", { provider: overrideProvider, model: overrideModel }) }}</div>
        <div class="reasonix-form-item">
          <label>{{ t("common.contextWindow") }}</label>
          <InputNumber v-model="overrideForm.contextWindow" :min="0" :step="1000" />
          <div class="reasonix-form-hint">{{ t("reasonix.override.blankHint") }}</div>
        </div>
        <div class="reasonix-form-item">
          <label>{{ t("common.maxOutput") }}</label>
          <InputNumber v-model="overrideForm.maxOutputTokens" :min="0" :step="1000" />
        </div>
        <div v-if="overrideExtraKeys.length" class="reasonix-form-hint">
          {{ t("reasonix.override.extraKept", { keys: overrideExtraKeys.join(t("common.listSeparator")) }) }}
        </div>
      </div>
    </Dialog>

    <!-- 删除已保存 Key 确认弹窗 -->
    <Dialog v-model:visible="deleteKeyDialog" :header="t('reasonix.provider.deleteKeyTitle')" width="480px" :confirm-btn="{ content: t('common.delete'), theme: 'danger' }" @confirm="confirmDeleteKey" @cancel="cancelDeleteKey" @close="cancelDeleteKey">
      <div class="reasonix-edit-form">
        <p>{{ t("reasonix.provider.deleteKeyBody", { env: pendingDeleteKeyEnv }) }}</p>
        <p v-for="s in sharedEnvProviders" :key="s.env" class="reasonix-form-hint">
          {{ t("reasonix.provider.deleteKeySharedPrefix") }}<span class="mono">{{ s.env }}</span>{{ t("reasonix.provider.deleteKeySharedSuffix", { providers: s.providers.join(t("common.listSeparator")) }) }}
        </p>
      </div>
    </Dialog>

    <!-- 添加环境变量弹窗 -->
    <Dialog v-model:visible="envDialog" :header="t('reasonix.env.addTitle')" width="440px" :confirm-btn="{ content: t('common.add'), theme: 'primary' }" @confirm="handleAddEnv">
      <div class="reasonix-edit-form">
        <div class="reasonix-form-item">
          <label>{{ t("reasonix.env.nameLabel") }} <span class="reasonix-form-required">*</span></label>
          <Input v-model="envForm.name" placeholder="DEEPSEEK_API_KEY" />
        </div>
        <div class="reasonix-form-item">
          <label>{{ t("reasonix.env.valueLabel") }} <span class="reasonix-form-required">*</span></label>
          <ApiKeyInput v-model="envForm.value" :placeholder="t('reasonix.env.valuePlaceholder')" />
        </div>
        <div class="reasonix-form-hint">{{ t("reasonix.env.addHint") }}</div>
      </div>
    </Dialog>
  </div>
</template>
