<script setup>
// DSH（DeepSeek Harness）模型配置页：<DSH_HOME>/profiles/<profile>/cordis.patch.yml
// 三块受管内容（其余 patch 条目原样保留）：
//   DeepSeek 官方（llm-deepseek 条目）— API Key（凭据引用自动派生）+ 自定义 Base URL + 模型目录
//   第三方供应商（llm-pi-ai 条目的 providers 字典）— 协议 / Base URL / 凭据引用 / 模型目录
//   默认模型（agent-default-model 条目）— 星标 = 设为默认（新会话使用的 provider/model，即「切换」语义）
// 供应商与模型分开配置（同 ZCode 页）：供应商弹窗只管名称/路由/协议/Base URL/API Key，
// 模型在卡片内以标签列出，逐个「添加模型 / 编辑模型」弹窗维护。
// dsh 对 cordis.patch.yml 有监听（HMR），写入后即时生效；密钥文件写后如未生效可重启 dsh。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Dialog, Input, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link,
  Checkbox, AutoComplete, Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon, LockOnIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import "./styles/ConfigView.css";

const { t } = useI18n();

// 协议 / 思考格式 / 推理强度：来自 preload 常量表（与 dsh 侧枚举一致）
const SVC = window.services || {};
// 手工新增供应商只开放两类协议（其余协议仅由「通用配置 → 下发」写入，编辑时按当前值回显）
const PROVIDER_PROTOCOLS = ["openai-completions", "anthropic-messages"];
const protocolLabel = (v) =>
  v === "openai-completions" ? t("dsh.config.protocols.openaiCompletions")
  : v === "openai-responses" ? t("dsh.config.protocols.openaiResponses")
  : v === "anthropic-messages" ? t("dsh.config.protocols.anthropicMessages")
  : t("dsh.config.protocols.googleGenerativeAi");
const protocolShortLabel = (v) =>
  v === "openai-completions" ? "OpenAI Chat"
  : v === "openai-responses" ? "OpenAI Responses"
  : v === "anthropic-messages" ? "Anthropic Messages"
  : v === "google-generative-ai" ? "Google Generative AI"
  : v || "—";

const thinkingFormatOptions = computed(() => [
  { label: t("dsh.config.autoDetect"), value: "" },
  ...(SVC.DSH_THINKING_FORMATS || []).map((v) => ({ label: v, value: v })),
]);
const officialEffortOptions = computed(() =>
  (SVC.DSH_EFFORTS || []).map((v) => ({ label: v, value: v }))
);
const thinkingOptions = computed(() => [
  { label: t("dsh.config.thinkingEnabled"), value: "enabled" },
  { label: t("dsh.config.thinkingDisabled"), value: "disabled" },
]);
const DEFAULT_BASE_URL = SVC.DSH_OFFICIAL_BASE_URL || "https://api.deepseek.com/anthropic";
const OFFICIAL_ROUTE = SVC.DSH_OFFICIAL_ROUTE || "deepseek-official";
// 路由名（providers 字典键 / 凭据引用名来源）：小写字母、数字、中划线
const ROUTE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const loading = ref(false);
const warningMsg = ref("");
const config = ref(null);
const providers = ref([]);
const official = ref(null);
const defaultKey = ref(null);
const expandedList = ref([]);

const providerOf = (route) => providers.value.find((p) => p.route === route) || null;

const formatNumber = (n) => {
  if (!n) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    const cfg = SVC.getDshConfig();
    config.value = cfg;
    official.value = cfg.official;
    providers.value = cfg.providers || [];
    defaultKey.value = cfg.defaultModel || null;
  } catch (e) {
    console.error("加载 DSH 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
};

const openConfigFile = () => { try { SVC.openDshConfigFile(); } catch { /* ignore */ } };

// ==================== 默认模型（星标 = agent-default-model 条目） ====================

const isDefaultModel = (route, modelId) =>
  !!defaultKey.value && defaultKey.value.provider === route && defaultKey.value.modelId === modelId;

const starModel = (route, modelId) => {
  try {
    SVC.setDshDefaultModel(route, modelId);
    MessagePlugin.success(t("dsh.model.defaultSet", { modelId }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("dsh.model.saveFailed", { message: e.message }));
  }
};

// ==================== 模型弹窗（官方 / 第三方共用） ====================

const modelDialog = ref(false);
const modelEditing = ref(""); // 空 = 新增；否则为原模型 ID（改名时默认指针跟随）
const modelTarget = ref({ kind: "official", route: "" });
const emptyModelForm = () => ({ modelId: "", name: "", contextWindow: 0, maxTokens: 0, image: false, _raw: {} });
const modelForm = ref(emptyModelForm());

// 供应商弹窗里「首个模型」的候选同样复用该拉取结果
const fetchedModels = ref([]);
const fetchingModels = ref(false);
const fetchModelError = ref("");
const resetFetch = () => { fetchedModels.value = []; fetchingModels.value = false; fetchModelError.value = ""; };

// 从 Base URL 的 /models 拉取候选（复用通用供应商拉取逻辑，失败提示）
const handleFetchModels = async (baseURL, apiKey) => {
  const base = String(baseURL || "").trim();
  if (!base) { fetchModelError.value = t("dsh.config.noBaseUrl"); return; }
  fetchingModels.value = true;
  fetchModelError.value = "";
  try {
    const list = await SVC.fetchProviderModels(base, apiKey);
    fetchedModels.value = list || [];
    if (!fetchedModels.value.length) fetchModelError.value = t("dsh.config.noModelsReturned");
  } catch (e) {
    fetchModelError.value = e.message || t("common.fetchFailed");
  } finally {
    fetchingModels.value = false;
  }
};

const modelIdOptions = computed(() =>
  fetchedModels.value
    .filter((m) => m && m.id)
    .map((m) => ({
      label: m.name && m.name !== m.id ? t("dsh.config.modelOption", { name: m.name, id: m.id }) : m.id,
      value: m.id,
    }))
);

const targetModels = computed(() =>
  modelTarget.value.kind === "official"
    ? (official.value ? official.value.models : []).map((m) => ({ ...m }))
    : (providerOf(modelTarget.value.route)?.models || []).map((m) => ({ ...m }))
);
const targetRoute = computed(() => (modelTarget.value.kind === "official" ? OFFICIAL_ROUTE : modelTarget.value.route));
const targetLabel = computed(() => {
  if (modelTarget.value.kind === "official") return t("dsh.config.officialTarget", { route: OFFICIAL_ROUTE });
  const p = providerOf(modelTarget.value.route);
  return p ? t("dsh.config.providerTarget", { name: p.displayName, route: p.route }) : modelTarget.value.route;
});
const targetBaseURL = computed(() =>
  modelTarget.value.kind === "official" ? (official.value?.baseURL || "") : (providerOf(modelTarget.value.route)?.baseURL || "")
);
const targetApiKey = computed(() =>
  modelTarget.value.kind === "official" ? (official.value?.apiKey || "") : (providerOf(modelTarget.value.route)?.apiKey || "")
);

const openAddModel = (kind, route = "") => {
  modelTarget.value = { kind, route };
  modelEditing.value = "";
  modelForm.value = emptyModelForm();
  resetFetch();
  modelDialog.value = true;
  handleFetchModels(targetBaseURL.value, targetApiKey.value);
};

const openEditModel = (kind, route, m) => {
  modelTarget.value = { kind, route };
  modelEditing.value = m.modelId;
  modelForm.value = {
    modelId: m.modelId, name: m.name || "",
    contextWindow: m.contextWindow || 0, maxTokens: m.maxTokens || 0,
    image: !!m.image, _raw: { ...(m._raw || {}) },
  };
  resetFetch();
  modelDialog.value = true;
  handleFetchModels(targetBaseURL.value, targetApiKey.value);
};

const handleSaveModel = () => {
  try {
    const target = modelTarget.value;
    const f = modelForm.value;
    const id = String(f.modelId || "").trim();
    if (!id) { MessagePlugin.warning(t("model.idRequired")); return; }
    const route = targetRoute.value;
    const prevDef = SVC.getDshDefaultModel();
    const prevModels = targetModels.value;
    const model = {
      modelId: id,
      name: String(f.name || "").trim(),
      contextWindow: Number(f.contextWindow) || 0,
      maxTokens: Number(f.maxTokens) || 0,
      image: !!f.image,
      _raw: { ...(f._raw || {}) },
    };
    let models;
    if (!modelEditing.value) {
      if (prevModels.some((m) => m.modelId === id)) { MessagePlugin.warning(t("dsh.model.alreadyExists", { id })); return; }
      models = [...prevModels, model];
    } else {
      models = prevModels.map((m) => (m.modelId === modelEditing.value ? model : m));
    }
    // 官方首次改动模型即从「内置目录」转为「自定义目录」（整表写回，_raw 扩展字段原样保留）
    if (target.kind === "official") SVC.saveDshOfficial({ models });
    else SVC.updateDshProvider(target.route, { models });
    // 改 ID 时默认指针跟随到新 ID（服务端兜底会改指目录内首个模型，这里按改名结果纠正）
    if (modelEditing.value && modelEditing.value !== id && prevDef &&
        prevDef.provider === route && prevDef.modelId === modelEditing.value) {
      SVC.setDshDefaultModel(route, id, prevDef.reasoningEffort);
    }
    MessagePlugin.success(modelEditing.value ? t("dsh.model.updated", { id }) : t("dsh.model.added", { id }));
    modelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("dsh.model.saveFailed", { message: e.message }));
  }
};

// 删除模型：官方删空即回退内置目录；第三方删空会被服务端拒绝（pi-ai 手写路由要求非空 models）
const handleDeleteModel = (kind, route, m) => {
  try {
    const models = (kind === "official"
      ? (official.value ? official.value.models : [])
      : (providerOf(route)?.models || [])
    ).filter((x) => x.modelId !== m.modelId).map((x) => ({ ...x }));
    if (kind === "official") SVC.saveDshOfficial({ models });
    else SVC.updateDshProvider(route, { models });
    MessagePlugin.success(
      kind === "official" && models.length === 0
        ? t("dsh.model.deletedRestored", { modelId: m.modelId })
        : t("dsh.model.deleted", { modelId: m.modelId })
    );
    refresh();
  } catch (e) {
    MessagePlugin.error(t("dsh.model.deleteFailed", { message: e.message }));
  }
};

// 恢复官方内置目录（deepseek-flash / deepseek-v4-pro）
const handleRestoreBuiltinCatalog = () => {
  try {
    SVC.saveDshOfficial({ models: [] });
    MessagePlugin.success(t("dsh.official.restoreSuccess"));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("dsh.official.restoreFailed", { message: e.message }));
  }
};

// ==================== DeepSeek 官方（llm-deepseek） ====================

const officialDialog = ref(false);
const officialForm = ref({ apiKey: "", baseURL: "", thinking: "enabled", reasoningEffort: "high", maxTokens: 0, defaultContextWindow: 0 });
const originalOfficialKey = ref("");

const openOfficialDialog = () => {
  const o = official.value;
  officialForm.value = o
    ? {
        apiKey: o.apiKey, baseURL: o.baseURL, thinking: o.thinking,
        reasoningEffort: o.reasoningEffort, maxTokens: o.maxTokens,
        defaultContextWindow: o.defaultContextWindow,
      }
    : {
        apiKey: "", baseURL: "", thinking: "enabled", reasoningEffort: "high",
        maxTokens: (config.value?.defaults?.officialMaxTokens) || 256000,
        defaultContextWindow: (config.value?.defaults?.officialContextWindow) || 1000000,
      };
  originalOfficialKey.value = officialForm.value.apiKey || "";
  officialDialog.value = true;
};

const handleSaveOfficial = () => {
  try {
    const f = officialForm.value;
    const payload = {
      enabled: true,
      baseURL: String(f.baseURL || "").trim(),
      thinking: f.thinking,
      reasoningEffort: f.reasoningEffort,
      maxTokens: Number(f.maxTokens) || 0,
      defaultContextWindow: Number(f.defaultContextWindow) || 0,
    };
    // 凭据引用名由服务端按官方路由派生（DEEPSEEK_API_KEY）；模型目录在卡片内单独维护
    // key：清空 → 删除；改动 → 覆盖；未动 → 不回传
    if (!f.apiKey && originalOfficialKey.value) payload.clearApiKey = true;
    else if (f.apiKey !== originalOfficialKey.value) payload.apiKey = String(f.apiKey || "").trim();
    SVC.saveDshOfficial(payload);
    MessagePlugin.success(t("dsh.official.saved"));
    officialDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("dsh.official.saveFailed", { message: e.message }));
  }
};

const handleRemoveOfficial = () => {
  try {
    SVC.removeDshOfficial();
    MessagePlugin.success(t("dsh.official.removed"));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("dsh.official.removeFailed", { message: e.message }));
  }
};

// ==================== 第三方供应商（llm-pi-ai providers） ====================

const providerDialog = ref(false);
const providerEditing = ref(""); // 空 = 新增
const emptyProviderForm = () => ({
  displayName: "", route: "", api: "openai-completions",
  baseURL: "", thinkingFormat: "", apiKey: "", firstModel: "",
});
const providerForm = ref(emptyProviderForm());
const originalProviderKey = ref("");

// 编辑已有供应商时若协议来自下发（不在手工两选项内），按当前值补一项，避免误改
const providerProtocolOptions = computed(() => {
  const opts = PROVIDER_PROTOCOLS.map((v) => ({ label: protocolLabel(v), value: v }));
  const cur = String(providerForm.value.api || "").trim();
  if (cur && !PROVIDER_PROTOCOLS.includes(cur)) {
    opts.push({ label: t("dsh.config.currentConfigOption", { protocol: protocolLabel(cur) }), value: cur });
  }
  return opts;
});

// 路由名仅允许英文（小写字母 / 数字 / 中划线）：输入即清洗
const onRouteInput = (val) => {
  providerForm.value.route = String(val ?? "").toLocaleLowerCase().replace(/[^a-z0-9-]/g, "");
};

const openAddProvider = () => {
  providerEditing.value = "";
  providerForm.value = emptyProviderForm();
  originalProviderKey.value = "";
  resetFetch();
  providerDialog.value = true;
};

const openEditProvider = (p) => {
  providerEditing.value = p.route;
  providerForm.value = {
    ...emptyProviderForm(),
    displayName: p.displayName, route: p.route, api: p.api || "openai-completions",
    baseURL: p.baseURL, thinkingFormat: p.thinkingFormat || "", apiKey: p.apiKey,
  };
  originalProviderKey.value = p.apiKey || "";
  resetFetch();
  providerDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    const f = providerForm.value;
    const displayName = String(f.displayName || "").trim();
    const route = String(f.route || "").trim();
    const baseURL = String(f.baseURL || "").trim();
    if (!displayName) { MessagePlugin.warning(t("dsh.provider.nameRequired")); return; }
    if (!route) { MessagePlugin.warning(t("dsh.provider.routeRequired")); return; }
    if (!ROUTE_RE.test(route)) { MessagePlugin.warning(t("dsh.provider.routeInvalid")); return; }
    if (!baseURL) { MessagePlugin.warning(t("dsh.provider.baseUrlRequired")); return; }
    const keyPayload = {};
    if (!f.apiKey && originalProviderKey.value) keyPayload.clearApiKey = true;
    else if (f.apiKey !== originalProviderKey.value) keyPayload.apiKey = String(f.apiKey || "").trim();
    if (providerEditing.value) {
      // 路由名（providers 键）不可改；凭据引用名由服务端按路由派生，故不回传 apiKeyEnv
      SVC.updateDshProvider(providerEditing.value, {
        displayName, api: f.api, baseURL,
        thinkingFormat: f.thinkingFormat,
        ...keyPayload,
      });
      MessagePlugin.success(t("dsh.provider.updated"));
    } else {
      const firstModel = String(f.firstModel || "").trim();
      if (!firstModel) { MessagePlugin.warning(t("dsh.provider.firstModelRequired")); return; }
      SVC.addDshProvider({
        displayName, route, api: f.api, baseURL,
        thinkingFormat: f.thinkingFormat,
        apiKey: String(f.apiKey || "").trim(),
        models: [{ modelId: firstModel }],
      });
      MessagePlugin.success(t("dsh.provider.added"));
    }
    providerDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("dsh.provider.saveFailed", { message: e.message }));
  }
};

const handleDeleteProvider = (p) => {
  try {
    SVC.deleteDshProvider(p.route);
    MessagePlugin.success(t("dsh.provider.deleted", { name: p.displayName }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("dsh.provider.deleteFailed", { message: e.message }));
  }
};

onMounted(refresh);
</script>

<template>
  <div class="dsh-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="dsh-toolbar">
      <div class="dsh-toolbar-left">
        <span class="dsh-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openConfigFile">cordis.patch.yml</Link>
          <span class="dsh-toolbar-sub">
            {{ t("dsh.config.toolbarSubtitle", { profile: config?.profile || "desktop" }) }}
          </span>
        </span>
      </div>
      <div class="dsh-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProvider">
          <template #icon><AddIcon /></template> {{ t("dsh.config.addProviderTitle") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="dsh-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <!-- DeepSeek 官方（llm-deepseek 条目） -->
      <div class="dsh-card">
        <div class="dsh-card-title">
          <span>{{ t("dsh.config.officialSection") }}</span>
          <span class="dsh-card-sub">{{ t("dsh.config.officialSubtitle") }}</span>
          <div class="dsh-card-title-right">
            <Button size="small" variant="outline" theme="primary" @click="openOfficialDialog">
              <template #icon><AddIcon v-if="!official" /><EditIcon v-else /></template>
              {{ official ? t("common.edit") : t("dsh.config.configureOfficialKey") }}
            </Button>
            <Popconfirm
              v-if="official"
              :content="t('dsh.config.removeOfficialConfirm')"
              theme="danger"
              @confirm="handleRemoveOfficial"
            >
              <Button size="small" theme="danger" variant="text">
                <template #icon><DeleteIcon /></template>
              </Button>
            </Popconfirm>
          </div>
        </div>

        <div v-if="!official" class="dsh-official-empty">
          <span>{{ t("dsh.config.officialNotConfigured") }}</span>
        </div>
        <template v-else>
          <div class="dsh-details">
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">{{ t("dsh.config.credentialRef") }}</span>
              <span class="dsh-detail-value mono">{{ official.apiKeyEnv }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">API Key</span>
              <span class="dsh-detail-value mono">{{ official.apiKey ? t("dsh.config.configuredInCredentials") : t("dsh.config.unconfigured") }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">Base URL</span>
              <span class="dsh-detail-value">{{ official.baseURL || t("dsh.config.officialDefaultUrl", { url: DEFAULT_BASE_URL }) }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">{{ t("dsh.config.thinkingEffort") }}</span>
              <span class="dsh-detail-value">{{ official.thinking }} / {{ official.reasoningEffort }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">{{ t("dsh.config.maxTokens") }}</span>
              <span class="dsh-detail-value">{{ formatNumber(official.maxTokens) }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">{{ t("dsh.config.defaultContextWindow") }}</span>
              <span class="dsh-detail-value">{{ formatNumber(official.defaultContextWindow) }}</span>
            </div>
          </div>
          <div class="dsh-models-section">
            <div class="dsh-models-title">
              <span>
                {{ t("dsh.config.modelCatalog") }}
                <Tag v-if="!official.modelsExplicit" size="small" theme="default" variant="light">{{ t("dsh.config.builtinCatalog") }}</Tag>
                <Tag v-else size="small" variant="outline">{{ t("dsh.config.customCatalog") }}</Tag>
                <span class="dsh-muted">{{ t("dsh.config.starHint") }}</span>
              </span>
              <div class="dsh-models-title-right">
                <Popconfirm
                  v-if="official.modelsExplicit"
                  :content="t('dsh.config.restoreConfirm')"
                  theme="warning"
                  @confirm="handleRestoreBuiltinCatalog"
                >
                  <Button size="small" variant="text">{{ t("dsh.config.restore") }}</Button>
                </Popconfirm>
                <Button size="small" variant="outline" @click="openAddModel('official')">
                  <template #icon><AddIcon /></template> {{ t("model.addTitle") }}
                </Button>
              </div>
            </div>
            <div class="dsh-model-tags">
              <span v-for="m in official.models" :key="m.modelId" class="dsh-model-tag">
                <span class="dsh-model-tag-name">{{ m.modelId }}</span>
                <span v-if="m.name && m.name !== m.modelId" class="dsh-model-tag-sub">{{ m.name }}</span>
                <span v-if="m.contextWindow" class="dsh-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                <span v-if="m.image" class="dsh-model-tag-sub">{{ t("dsh.config.image") }}</span>
                <Tag v-if="isDefaultModel(OFFICIAL_ROUTE, m.modelId)" size="small" theme="success" variant="light">{{ t("common.default") }}</Tag>
                <Tooltip v-else :content="t('dsh.config.setDefaultTooltip')" placement="top">
                  <span class="dsh-model-tag-star" @click="starModel(OFFICIAL_ROUTE, m.modelId)"><StarIcon size="12px" /></span>
                </Tooltip>
                <Tooltip :content="t('dsh.config.editModelTooltip')" placement="top">
                  <span class="dsh-model-tag-edit" @click="openEditModel('official', '', m)"><EditIcon size="12px" /></span>
                </Tooltip>
                <Popconfirm :content="t('dsh.config.deleteModelConfirm')" theme="danger" @confirm="handleDeleteModel('official', '', m)">
                  <span class="dsh-model-tag-del"><DeleteIcon size="12px" /></span>
                </Popconfirm>
              </span>
            </div>
          </div>
        </template>
      </div>

      <!-- 第三方供应商（llm-pi-ai providers） -->
      <div class="dsh-section-title">
        <span>{{ t("dsh.config.thirdPartySection") }}</span>
        <span class="dsh-muted">{{ t("dsh.config.routeCount", { count: providers.length }, providers.length) }}</span>
      </div>
      <div v-if="providers.length === 0" class="dsh-config-empty">
        <Empty :description="t('dsh.config.emptyProviders')" />
      </div>
      <div v-else class="dsh-provider-list">
        <Collapse v-model="expandedList" class="dsh-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.route" :value="p.route">
            <template #header>
              <div class="dsh-provider-header-left">
                <span class="dsh-provider-name">{{ p.displayName }}</span>
                <Tag size="small" variant="outline">{{ p.route }}</Tag>
                <Tag size="small" variant="outline">{{ protocolShortLabel(p.api) }}</Tag>
                <Tooltip v-if="p.thinkingFormat" :content="`compat.thinkingFormat = ${p.thinkingFormat}`" placement="top">
                  <Tag size="small" theme="default" variant="light">thinking: {{ p.thinkingFormat }}</Tag>
                </Tooltip>
                <Tag v-if="defaultKey && defaultKey.provider === p.route" size="small" theme="warning" variant="light">{{ t("dsh.config.defaultProvider") }}</Tag>
                <span class="dsh-model-count">{{ t("dsh.config.modelCount", { count: p.models.length }, p.models.length) }}</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="dsh-provider-header-right" @click.stop>
                <Button size="small" theme="default" variant="text" @click="openEditProvider(p)">
                  <template #icon><EditIcon /></template> {{ t("common.edit") }}
                </Button>
                <Popconfirm
                  :content="t('dsh.config.deleteProviderConfirm')"
                  theme="danger"
                  @confirm="handleDeleteProvider(p)"
                >
                  <Button size="small" theme="danger" variant="text">
                    <template #icon><DeleteIcon /></template>
                  </Button>
                </Popconfirm>
              </div>
            </template>

            <template #content>
              <div class="dsh-provider-body">
                <div class="dsh-details">
                  <div class="dsh-detail-item">
                    <span class="dsh-detail-label">Base URL</span>
                    <span class="dsh-detail-value">{{ p.baseURL || "—" }}</span>
                  </div>
                  <div class="dsh-detail-item">
                    <span class="dsh-detail-label">{{ t("dsh.config.protocolLabel") }}</span>
                    <span class="dsh-detail-value mono">{{ p.api || "—" }}</span>
                  </div>
                  <div class="dsh-detail-item">
                    <span class="dsh-detail-label">{{ t("dsh.config.credentialRef") }}</span>
                    <span class="dsh-detail-value mono">{{ p.apiKeyEnv }}</span>
                  </div>
                  <div class="dsh-detail-item">
                    <span class="dsh-detail-label">API Key</span>
                    <span class="dsh-detail-value mono">{{ p.apiKey ? t("dsh.config.configured") : t("dsh.config.unconfigured") }}</span>
                  </div>
                </div>
                <div class="dsh-models-section">
                  <div class="dsh-models-title">
                    <span>{{ t("dsh.config.modelsTitle") }}</span>
                    <Button size="small" variant="outline" @click="openAddModel('provider', p.route)">
                      <template #icon><AddIcon /></template> {{ t("model.addTitle") }}
                    </Button>
                  </div>
                  <div v-if="p.models.length === 0" class="dsh-models-empty">
                    {{ t("dsh.config.modelsEmpty") }}
                  </div>
                  <div class="dsh-model-tags">
                    <span v-for="m in p.models" :key="m.modelId" class="dsh-model-tag">
                      <span class="dsh-model-tag-name">{{ m.modelId }}</span>
                      <span v-if="m.name && m.name !== m.modelId" class="dsh-model-tag-sub">{{ m.name }}</span>
                      <span v-if="m.contextWindow" class="dsh-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                      <span v-if="m.image" class="dsh-model-tag-sub">{{ t("dsh.config.image") }}</span>
                      <Tag v-if="isDefaultModel(p.route, m.modelId)" size="small" theme="success" variant="light">{{ t("common.default") }}</Tag>
                      <Tooltip v-else :content="t('dsh.config.setDefaultTooltip')" placement="top">
                        <span class="dsh-model-tag-star" @click="starModel(p.route, m.modelId)"><StarIcon size="12px" /></span>
                      </Tooltip>
                      <Tooltip :content="t('dsh.config.editModelTooltip')" placement="top">
                        <span class="dsh-model-tag-edit" @click="openEditModel('provider', p.route, m)"><EditIcon size="12px" /></span>
                      </Tooltip>
                      <Popconfirm :content="t('dsh.config.deleteModelConfirm')" theme="danger" @confirm="handleDeleteModel('provider', p.route, m)">
                        <span class="dsh-model-tag-del"><DeleteIcon size="12px" /></span>
                      </Popconfirm>
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </CollapsePanel>
        </Collapse>
      </div>

      <div class="dsh-footer-hint">
        <LockOnIcon size="12px" />
        {{ t("dsh.config.footerHint") }}
      </div>
    </template>

    <!-- 官方配置弹窗（模型目录在卡片内单独维护） -->
    <Dialog
      v-model:visible="officialDialog"
      :header="official ? t('dsh.config.officialDialogEdit') : t('dsh.config.officialDialogAdd')"
      width="600px"
      :confirm-btn="{ content: t('common.save'), theme: 'primary' }"
      @confirm="handleSaveOfficial"
    >
      <div class="dsh-edit-form">
        <div class="dsh-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="officialForm.apiKey" :placeholder="originalOfficialKey ? t('dsh.config.apiKeySavedPlaceholder') : 'sk-...'" />
          <div class="dsh-form-hint">{{ t("dsh.config.credentialHint", { env: official?.apiKeyEnv || config?.defaults?.officialApiKeyEnv || "DEEPSEEK_API_KEY" }) }}</div>
        </div>
        <div class="dsh-form-item">
          <label>{{ t("dsh.config.baseUrl") }}</label>
          <Input v-model="officialForm.baseURL" :placeholder="DEFAULT_BASE_URL" />
          <div class="dsh-form-hint">{{ t("dsh.config.baseUrlHint") }}</div>
        </div>
        <div class="dsh-form-grid">
          <div class="dsh-form-item">
            <label>{{ t("dsh.config.thinkingPolicy") }}</label>
            <Select v-model="officialForm.thinking" :options="thinkingOptions" />
          </div>
          <div class="dsh-form-item">
            <label>{{ t("dsh.config.reasoningEffort") }}</label>
            <Select v-model="officialForm.reasoningEffort" :options="officialEffortOptions" />
          </div>
        </div>
        <ModelLimitsFields
          v-model:context="officialForm.defaultContextWindow"
          v-model:output="officialForm.maxTokens"
          item-class="dsh-form-item"
          :context-label="t('dsh.config.defaultContextWindow')"
          :output-label="t('dsh.config.maxTokens')"
        />
        <div class="dsh-form-hint">{{ t("dsh.config.officialCatalogHint") }}</div>
      </div>
    </Dialog>

    <!-- 供应商弹窗（新增 / 编辑，仅供应商级字段；模型在卡片内单独维护） -->
    <Dialog
      v-model:visible="providerDialog"
      :header="providerEditing ? t('dsh.config.editProviderTitle') : t('dsh.config.addProviderTitle')"
      width="600px"
      :confirm-btn="{ content: providerEditing ? t('common.save') : t('common.add'), theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="dsh-edit-form">
        <div class="dsh-form-item">
          <label>{{ t("dsh.config.providerName") }} <span class="dsh-form-required">*</span></label>
          <Input v-model="providerForm.displayName" :placeholder="t('dsh.config.providerNamePlaceholder')" />
        </div>
        <div class="dsh-form-item">
          <label>{{ t("dsh.config.routeName") }} <span class="dsh-form-required">*</span></label>
          <Input
            :value="providerForm.route"
            :disabled="!!providerEditing"
            :placeholder="t('dsh.config.routePlaceholder')"
            @change="onRouteInput"
          />
          <div class="dsh-form-hint">
            <template v-if="providerEditing">{{ t("dsh.config.routeHintLocked") }}</template>
            <template v-else>{{ t("dsh.config.routeHint") }}</template>
          </div>
        </div>
        <div class="dsh-form-item">
          <label>{{ t("dsh.config.protocolLabel") }}</label>
          <Select v-model="providerForm.api" :options="providerProtocolOptions" />
        </div>
        <div class="dsh-form-item">
          <label>Base URL <span class="dsh-form-required">*</span></label>
          <Input v-model="providerForm.baseURL" placeholder="https://api.example.com/v1" />
          <div class="dsh-form-hint">
            {{ t("dsh.config.baseUrlHintProtocol") }}
          </div>
        </div>
        <div class="dsh-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="providerForm.apiKey" :placeholder="originalProviderKey ? t('dsh.config.apiKeySavedPlaceholder') : 'sk-...'" />
        </div>
        <div class="dsh-form-item">
          <label>{{ t("dsh.config.thinkingFormat") }}</label>
          <Select v-model="providerForm.thinkingFormat" :options="thinkingFormatOptions" />
        </div>
        <template v-if="!providerEditing">
          <div class="dsh-form-item">
            <div class="dsh-models-toolbar">
              <label>{{ t("dsh.config.firstModelId") }} <span class="dsh-form-required">*</span></label>
              <Button
                size="small"
                variant="outline"
                :loading="fetchingModels"
                @click="handleFetchModels(providerForm.baseURL, providerForm.apiKey)"
              >
                {{ t("dsh.config.fetchFromEndpoint") }}
              </Button>
            </div>
            <AutoComplete
              :value="providerForm.firstModel"
              :options="modelIdOptions"
              :loading="fetchingModels"
              filterable
              clearable
              :placeholder="t('dsh.config.firstModelPlaceholder')"
              @change="providerForm.firstModel = $event"
            />
            <div v-if="fetchModelError" class="dsh-form-hint dsh-fetch-error">{{ fetchModelError }}</div>
            <div class="dsh-form-hint">{{ t("dsh.config.firstModelHint") }}</div>
          </div>
        </template>
      </div>
    </Dialog>

    <!-- 模型弹窗（新增 / 编辑，官方与第三方共用） -->
    <Dialog
      v-model:visible="modelDialog"
      :header="modelEditing ? t('model.editTitle') : t('model.addTitle')"
      width="600px"
      :confirm-btn="{ content: modelEditing ? t('common.save') : t('common.add'), theme: 'primary' }"
      @confirm="handleSaveModel"
    >
      <div class="dsh-edit-form">
        <div class="dsh-form-item">
          <label>{{ t("model.id") }} <span class="dsh-form-required">*</span></label>
          <AutoComplete
            :value="modelForm.modelId"
            :options="modelIdOptions"
            :loading="fetchingModels"
            filterable
            clearable
            :placeholder="t('dsh.config.firstModelPlaceholder')"
            @change="modelForm.modelId = $event"
          />
          <div v-if="fetchingModels" class="dsh-form-hint">{{ t("dsh.config.fetchingCandidates") }}</div>
          <div v-else-if="fetchModelError" class="dsh-form-hint dsh-fetch-error">{{ fetchModelError }}</div>
          <div v-else class="dsh-form-hint">{{ t("dsh.config.modelFetchHint") }}</div>
        </div>
        <div class="dsh-form-item">
          <label>{{ t("dsh.config.displayName") }}</label>
          <Input v-model="modelForm.name" :placeholder="t('dsh.config.displayNamePlaceholder')" />
        </div>
        <ModelLimitsFields
          v-model:context="modelForm.contextWindow"
          v-model:output="modelForm.maxTokens"
          item-class="dsh-form-item"
          :context-label="t('dsh.config.contextLabel')"
          :output-label="t('dsh.config.outputLabel')"
        />
        <div class="dsh-form-item">
          <label>{{ t("dsh.config.inputTypes") }}</label>
          <div class="dsh-chk-row">
            <Checkbox v-model="modelForm.image">{{ t("dsh.config.image") }}</Checkbox>
          </div>
        </div>
        <div class="dsh-form-hint">
          {{ t("dsh.config.routePrefix", { label: targetLabel }) }}
          <template v-if="!modelEditing && targetModels.length === 0">{{ t("dsh.config.emptyCatalogSuffix") }}</template>
        </div>
        <div v-if="modelEditing" class="dsh-form-hint">{{ t("dsh.config.editExtFieldsHint") }}</div>
        <div v-else-if="modelTarget.kind === 'official'" class="dsh-form-hint">{{ t("dsh.config.officialFirstModelHint") }}</div>
        <div v-else class="dsh-form-hint">{{ t("dsh.config.piAiFieldsHint") }}</div>
      </div>
    </Dialog>
  </div>
</template>
