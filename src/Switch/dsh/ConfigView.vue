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

// 协议 / 思考格式 / 推理强度：来自 preload 常量表（与 dsh 侧枚举一致）
const SVC = window.services || {};
// 手工新增供应商只开放两类协议（其余协议仅由「通用配置 → 下发」写入，编辑时按当前值回显）
const PROVIDER_PROTOCOLS = ["openai-completions", "anthropic-messages"];
const protocolLabel = (v) =>
  v === "openai-completions" ? "openai-completions（OpenAI Chat）"
  : v === "openai-responses" ? "openai-responses（OpenAI Responses）"
  : v === "anthropic-messages" ? "anthropic-messages（Anthropic Messages）"
  : "google-generative-ai（Google Generative AI）";
const protocolShortLabel = (v) =>
  v === "openai-completions" ? "OpenAI Chat"
  : v === "openai-responses" ? "OpenAI Responses"
  : v === "anthropic-messages" ? "Anthropic Messages"
  : v === "google-generative-ai" ? "Google Generative AI"
  : v || "—";

const thinkingFormatOptions = [
  { label: "（自动检测）", value: "" },
  ...(SVC.DSH_THINKING_FORMATS || []).map((v) => ({ label: v, value: v })),
];
const officialEffortOptions = (SVC.DSH_EFFORTS || []).map((v) => ({ label: v, value: v }));
const thinkingOptions = [
  { label: "enabled（允许思考）", value: "enabled" },
  { label: "disabled（全部锁 off）", value: "disabled" },
];
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
    warningMsg.value = e.message || "加载失败";
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
    MessagePlugin.success(`默认模型已设为 ${modelId}`);
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
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
  if (!base) { fetchModelError.value = "未配置 Base URL，无法自动获取"; return; }
  fetchingModels.value = true;
  fetchModelError.value = "";
  try {
    const list = await SVC.fetchProviderModels(base, apiKey);
    fetchedModels.value = list || [];
    if (!fetchedModels.value.length) fetchModelError.value = "端点未返回模型";
  } catch (e) {
    fetchModelError.value = e.message || "获取失败";
  } finally {
    fetchingModels.value = false;
  }
};

const modelIdOptions = computed(() =>
  fetchedModels.value
    .filter((m) => m && m.id)
    .map((m) => ({ label: m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id, value: m.id }))
);

const targetModels = computed(() =>
  modelTarget.value.kind === "official"
    ? (official.value ? official.value.models : []).map((m) => ({ ...m }))
    : (providerOf(modelTarget.value.route)?.models || []).map((m) => ({ ...m }))
);
const targetRoute = computed(() => (modelTarget.value.kind === "official" ? OFFICIAL_ROUTE : modelTarget.value.route));
const targetLabel = computed(() => {
  if (modelTarget.value.kind === "official") return `DeepSeek 官方（${OFFICIAL_ROUTE}）`;
  const p = providerOf(modelTarget.value.route);
  return p ? `${p.displayName}（${p.route}）` : modelTarget.value.route;
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
    const t = modelTarget.value;
    const f = modelForm.value;
    const id = String(f.modelId || "").trim();
    if (!id) { MessagePlugin.warning("请输入模型 ID"); return; }
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
      if (prevModels.some((m) => m.modelId === id)) { MessagePlugin.warning(`模型 ${id} 已在目录中`); return; }
      models = [...prevModels, model];
    } else {
      models = prevModels.map((m) => (m.modelId === modelEditing.value ? model : m));
    }
    // 官方首次改动模型即从「内置目录」转为「自定义目录」（整表写回，_raw 扩展字段原样保留）
    if (t.kind === "official") SVC.saveDshOfficial({ models });
    else SVC.updateDshProvider(t.route, { models });
    // 改 ID 时默认指针跟随到新 ID（服务端兜底会改指目录内首个模型，这里按改名结果纠正）
    if (modelEditing.value && modelEditing.value !== id && prevDef &&
        prevDef.provider === route && prevDef.modelId === modelEditing.value) {
      SVC.setDshDefaultModel(route, id, prevDef.reasoningEffort);
    }
    MessagePlugin.success(modelEditing.value ? `模型 ${id} 已更新` : `模型 ${id} 已添加`);
    modelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
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
        ? `模型 ${m.modelId} 已删除，已回退内置模型目录`
        : `模型 ${m.modelId} 已删除`
    );
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

// 恢复官方内置目录（deepseek-flash / deepseek-v4-pro）
const handleRestoreBuiltinCatalog = () => {
  try {
    SVC.saveDshOfficial({ models: [] });
    MessagePlugin.success("已恢复内置模型目录");
    refresh();
  } catch (e) {
    MessagePlugin.error("恢复失败: " + e.message);
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
    MessagePlugin.success("DeepSeek 官方配置已保存");
    officialDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleRemoveOfficial = () => {
  try {
    SVC.removeDshOfficial();
    MessagePlugin.success("已移除 DeepSeek 官方配置");
    refresh();
  } catch (e) {
    MessagePlugin.error("移除失败: " + e.message);
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
    opts.push({ label: `${protocolLabel(cur)}（当前配置，来自下发）`, value: cur });
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
    if (!displayName) { MessagePlugin.warning("请输入供应商名称"); return; }
    if (!route) { MessagePlugin.warning("请输入路由名（英文）"); return; }
    if (!ROUTE_RE.test(route)) { MessagePlugin.warning("路由名仅支持小写字母 / 数字 / 中划线，且不能以中划线开头或结尾"); return; }
    if (!baseURL) { MessagePlugin.warning("请输入 Base URL"); return; }
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
      MessagePlugin.success("供应商配置已更新");
    } else {
      const firstModel = String(f.firstModel || "").trim();
      if (!firstModel) { MessagePlugin.warning("请填写首个模型 ID（pi-ai 手写路由要求 models 非空）"); return; }
      SVC.addDshProvider({
        displayName, route, api: f.api, baseURL,
        thinkingFormat: f.thinkingFormat,
        apiKey: String(f.apiKey || "").trim(),
        models: [{ modelId: firstModel }],
      });
      MessagePlugin.success("供应商已添加");
    }
    providerDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteProvider = (p) => {
  try {
    SVC.deleteDshProvider(p.route);
    MessagePlugin.success(`供应商 ${p.displayName} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
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
            profile {{ config?.profile || "desktop" }} · 官方密钥 / 自定义地址 / 第三方供应商（dsh 监听该文件，写入后即时生效）
          </span>
        </span>
      </div>
      <div class="dsh-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProvider">
          <template #icon><AddIcon /></template> 添加供应商
        </Button>
        <Tooltip content="刷新" placement="top">
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
          <span>DeepSeek 官方（llm-deepseek）</span>
          <span class="dsh-card-sub">官方 API Key 或自定义 Messages 兼容地址</span>
          <div class="dsh-card-title-right">
            <Button size="small" variant="outline" theme="primary" @click="openOfficialDialog">
              <template #icon><AddIcon v-if="!official" /><EditIcon v-else /></template>
              {{ official ? "编辑" : "配置官方密钥" }}
            </Button>
            <Popconfirm
              v-if="official"
              content="移除 llm-deepseek 条目？该路由将从 dsh 配置中移除（密钥若无其他引用一并清理）"
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
          <span>未配置：dsh 使用内置 deepseek-flash / deepseek-v4-pro 目录，但缺少 API Key 凭据，请求会以 MISSING_CREDENTIAL 失败</span>
        </div>
        <template v-else>
          <div class="dsh-details">
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">凭据引用（自动派生）</span>
              <span class="dsh-detail-value mono">{{ official.apiKeyEnv }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">API Key</span>
              <span class="dsh-detail-value mono">{{ official.apiKey ? "已配置（.credentials.yaml）" : "未配置" }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">Base URL</span>
              <span class="dsh-detail-value">{{ official.baseURL || `${DEFAULT_BASE_URL}（官方默认）` }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">思考 / 推理强度</span>
              <span class="dsh-detail-value">{{ official.thinking }} / {{ official.reasoningEffort }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">单次输出上限（maxTokens）</span>
              <span class="dsh-detail-value">{{ formatNumber(official.maxTokens) }}</span>
            </div>
            <div class="dsh-detail-item">
              <span class="dsh-detail-label">容量回退（defaultContextWindow）</span>
              <span class="dsh-detail-value">{{ formatNumber(official.defaultContextWindow) }}</span>
            </div>
          </div>
          <div class="dsh-models-section">
            <div class="dsh-models-title">
              <span>
                模型目录
                <Tag v-if="!official.modelsExplicit" size="small" theme="default" variant="light">内置目录</Tag>
                <Tag v-else size="small" variant="outline">自定义目录</Tag>
                <span class="dsh-muted">（星标 = 设为默认模型）</span>
              </span>
              <div class="dsh-models-title-right">
                <Popconfirm
                  v-if="official.modelsExplicit"
                  content="恢复内置目录？当前自定义模型目录将整体移除（deepseek-flash / deepseek-v4-pro 回归）"
                  theme="warning"
                  @confirm="handleRestoreBuiltinCatalog"
                >
                  <Button size="small" variant="text">恢复内置目录</Button>
                </Popconfirm>
                <Button size="small" variant="outline" @click="openAddModel('official')">
                  <template #icon><AddIcon /></template> 添加模型
                </Button>
              </div>
            </div>
            <div class="dsh-model-tags">
              <span v-for="m in official.models" :key="m.modelId" class="dsh-model-tag">
                <span class="dsh-model-tag-name">{{ m.modelId }}</span>
                <span v-if="m.name && m.name !== m.modelId" class="dsh-model-tag-sub">{{ m.name }}</span>
                <span v-if="m.contextWindow" class="dsh-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                <span v-if="m.image" class="dsh-model-tag-sub">图片</span>
                <Tag v-if="isDefaultModel(OFFICIAL_ROUTE, m.modelId)" size="small" theme="success" variant="light">默认</Tag>
                <Tooltip v-else content="设为默认模型" placement="top">
                  <span class="dsh-model-tag-star" @click="starModel(OFFICIAL_ROUTE, m.modelId)"><StarIcon size="12px" /></span>
                </Tooltip>
                <Tooltip content="编辑模型配置" placement="top">
                  <span class="dsh-model-tag-edit" @click="openEditModel('official', '', m)"><EditIcon size="12px" /></span>
                </Tooltip>
                <Popconfirm content="删除该模型？" theme="danger" @confirm="handleDeleteModel('official', '', m)">
                  <span class="dsh-model-tag-del"><DeleteIcon size="12px" /></span>
                </Popconfirm>
              </span>
            </div>
          </div>
        </template>
      </div>

      <!-- 第三方供应商（llm-pi-ai providers） -->
      <div class="dsh-section-title">
        <span>第三方供应商（llm-pi-ai）</span>
        <span class="dsh-muted">{{ providers.length }} 个路由</span>
      </div>
      <div v-if="providers.length === 0" class="dsh-config-empty">
        <Empty description="未配置第三方供应商；点「添加供应商」写入 llm-pi-ai 的 providers 字典" />
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
                <Tag v-if="defaultKey && defaultKey.provider === p.route" size="small" theme="warning" variant="light">默认供应商</Tag>
                <span class="dsh-model-count">{{ p.models.length }} 个模型</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="dsh-provider-header-right" @click.stop>
                <Button size="small" theme="default" variant="text" @click="openEditProvider(p)">
                  <template #icon><EditIcon /></template> 编辑
                </Button>
                <Popconfirm
                  content="删除该供应商？默认模型指针将改指官方或首个剩余供应商"
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
                    <span class="dsh-detail-label">协议（api）</span>
                    <span class="dsh-detail-value mono">{{ p.api || "—" }}</span>
                  </div>
                  <div class="dsh-detail-item">
                    <span class="dsh-detail-label">凭据引用（自动派生）</span>
                    <span class="dsh-detail-value mono">{{ p.apiKeyEnv }}</span>
                  </div>
                  <div class="dsh-detail-item">
                    <span class="dsh-detail-label">API Key</span>
                    <span class="dsh-detail-value mono">{{ p.apiKey ? "已配置" : "未配置" }}</span>
                  </div>
                </div>
                <div class="dsh-models-section">
                  <div class="dsh-models-title">
                    <span>模型（星标 = 设为默认模型）</span>
                    <Button size="small" variant="outline" @click="openAddModel('provider', p.route)">
                      <template #icon><AddIcon /></template> 添加模型
                    </Button>
                  </div>
                  <div v-if="p.models.length === 0" class="dsh-models-empty">
                    暂无模型（该路由在 dsh 内不可用，请添加）
                  </div>
                  <div class="dsh-model-tags">
                    <span v-for="m in p.models" :key="m.modelId" class="dsh-model-tag">
                      <span class="dsh-model-tag-name">{{ m.modelId }}</span>
                      <span v-if="m.name && m.name !== m.modelId" class="dsh-model-tag-sub">{{ m.name }}</span>
                      <span v-if="m.contextWindow" class="dsh-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                      <span v-if="m.image" class="dsh-model-tag-sub">图片</span>
                      <Tag v-if="isDefaultModel(p.route, m.modelId)" size="small" theme="success" variant="light">默认</Tag>
                      <Tooltip v-else content="设为默认模型" placement="top">
                        <span class="dsh-model-tag-star" @click="starModel(p.route, m.modelId)"><StarIcon size="12px" /></span>
                      </Tooltip>
                      <Tooltip content="编辑模型配置" placement="top">
                        <span class="dsh-model-tag-edit" @click="openEditModel('provider', p.route, m)"><EditIcon size="12px" /></span>
                      </Tooltip>
                      <Popconfirm content="删除该模型？" theme="danger" @confirm="handleDeleteModel('provider', p.route, m)">
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
        API Key 不写入 cordis.patch.yml：条目只记录按路由名自动派生的引用名（如 NEWAPI_API_KEY），明文密钥存于
        ~/.dsh/.credentials.yaml 的 refs 字典（records 授权记录原样保留）
      </div>
    </template>

    <!-- 官方配置弹窗（模型目录在卡片内单独维护） -->
    <Dialog
      v-model:visible="officialDialog"
      :header="official ? '编辑 DeepSeek 官方配置' : '配置 DeepSeek 官方密钥'"
      width="600px"
      :confirm-btn="{ content: '保存', theme: 'primary' }"
      @confirm="handleSaveOfficial"
    >
      <div class="dsh-edit-form">
        <div class="dsh-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="officialForm.apiKey" :placeholder="originalOfficialKey ? '已保存，清空并保存将删除；修改则覆盖' : 'sk-...'" />
          <div class="dsh-form-hint">密钥写入 ~/.dsh/.credentials.yaml 的 refs[{{ official?.apiKeyEnv || config?.defaults?.officialApiKeyEnv || 'DEEPSEEK_API_KEY' }}]（引用名固定派生，无需填写）</div>
        </div>
        <div class="dsh-form-item">
          <label>Base URL（baseURL，留空 = 官方默认）</label>
          <Input v-model="officialForm.baseURL" :placeholder="DEFAULT_BASE_URL" />
          <div class="dsh-form-hint">自定义地址需为 Messages 兼容端点：dsh 在根地址后追加 /v1/messages（末尾 /v1 会直接复用）</div>
        </div>
        <div class="dsh-form-grid">
          <div class="dsh-form-item">
            <label>思考策略（thinking）</label>
            <Select v-model="officialForm.thinking" :options="thinkingOptions" />
          </div>
          <div class="dsh-form-item">
            <label>推理强度（reasoningEffort）</label>
            <Select v-model="officialForm.reasoningEffort" :options="officialEffortOptions" />
          </div>
        </div>
        <ModelLimitsFields
          v-model:context="officialForm.defaultContextWindow"
          v-model:output="officialForm.maxTokens"
          item-class="dsh-form-item"
          context-label="容量回退（defaultContextWindow）"
          output-label="单次输出上限（maxTokens）"
        />
        <div class="dsh-form-hint">模型目录在卡片内以「添加模型 / 编辑模型」单独维护（关闭自定义目录即用内置 deepseek-flash / deepseek-v4-pro）</div>
      </div>
    </Dialog>

    <!-- 供应商弹窗（新增 / 编辑，仅供应商级字段；模型在卡片内单独维护） -->
    <Dialog
      v-model:visible="providerDialog"
      :header="providerEditing ? '编辑供应商配置' : '添加供应商'"
      width="600px"
      :confirm-btn="{ content: providerEditing ? '保存' : '添加', theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="dsh-edit-form">
        <div class="dsh-form-item">
          <label>供应商名称 <span class="dsh-form-required">*</span></label>
          <Input v-model="providerForm.displayName" placeholder="公司中转（支持中文，仅作展示）" />
        </div>
        <div class="dsh-form-item">
          <label>路由名（providers 字典键） <span class="dsh-form-required">*</span></label>
          <Input
            :value="providerForm.route"
            :disabled="!!providerEditing"
            placeholder="newapi"
            @change="onRouteInput"
          />
          <div class="dsh-form-hint">
            <template v-if="providerEditing">路由名即 providers 键，不可修改（如需改名请删除后重新添加）</template>
            <template v-else>仅小写字母 / 数字 / 中划线；同时用于派生凭据引用名（NEWAPI_API_KEY）</template>
          </div>
        </div>
        <div class="dsh-form-item">
          <label>协议（api）</label>
          <Select v-model="providerForm.api" :options="providerProtocolOptions" />
        </div>
        <div class="dsh-form-item">
          <label>Base URL <span class="dsh-form-required">*</span></label>
          <Input v-model="providerForm.baseURL" placeholder="https://api.example.com/v1" />
          <div class="dsh-form-hint">
            OpenAI Chat 协议由 SDK 追加 /chat/completions，Base URL 需含 /v1；
            Anthropic Messages 协议自动追加 /v1/messages，填根地址
          </div>
        </div>
        <div class="dsh-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="providerForm.apiKey" :placeholder="originalProviderKey ? '已保存，清空并保存将删除；修改则覆盖' : 'sk-...'" />
        </div>
        <div class="dsh-form-item">
          <label>思考参数格式（compat.thinkingFormat，可留空自动检测）</label>
          <Select v-model="providerForm.thinkingFormat" :options="thinkingFormatOptions" />
        </div>
        <template v-if="!providerEditing">
          <div class="dsh-form-item">
            <div class="dsh-models-toolbar">
              <label>首个模型 ID <span class="dsh-form-required">*</span></label>
              <Button
                size="small"
                variant="outline"
                :loading="fetchingModels"
                @click="handleFetchModels(providerForm.baseURL, providerForm.apiKey)"
              >
                从端点拉取
              </Button>
            </div>
            <AutoComplete
              :value="providerForm.firstModel"
              :options="modelIdOptions"
              :loading="fetchingModels"
              filterable
              clearable
              placeholder="glm-5.3-flash"
              @change="providerForm.firstModel = $event"
            />
            <div v-if="fetchModelError" class="dsh-form-hint dsh-fetch-error">{{ fetchModelError }}</div>
            <div class="dsh-form-hint">手写路由要求 models 非空，先写入首个模型；其余模型与上下文 / 输出上限在卡片内继续添加</div>
          </div>
        </template>
      </div>
    </Dialog>

    <!-- 模型弹窗（新增 / 编辑，官方与第三方共用） -->
    <Dialog
      v-model:visible="modelDialog"
      :header="modelEditing ? '编辑模型' : '添加模型'"
      width="600px"
      :confirm-btn="{ content: modelEditing ? '保存' : '添加', theme: 'primary' }"
      @confirm="handleSaveModel"
    >
      <div class="dsh-edit-form">
        <div class="dsh-form-item">
          <label>模型 ID <span class="dsh-form-required">*</span></label>
          <AutoComplete
            :value="modelForm.modelId"
            :options="modelIdOptions"
            :loading="fetchingModels"
            filterable
            clearable
            placeholder="glm-5.3-flash"
            @change="modelForm.modelId = $event"
          />
          <div v-if="fetchingModels" class="dsh-form-hint">正在从该路由的 /models 拉取候选…</div>
          <div v-else-if="fetchModelError" class="dsh-form-hint dsh-fetch-error">{{ fetchModelError }}</div>
          <div v-else class="dsh-form-hint">候选来自该路由 Base URL 的 /models 接口，也可手动输入</div>
        </div>
        <div class="dsh-form-item">
          <label>显示名（name，可选）</label>
          <Input v-model="modelForm.name" placeholder="GLM 5.3 Flash" />
        </div>
        <ModelLimitsFields
          v-model:context="modelForm.contextWindow"
          v-model:output="modelForm.maxTokens"
          item-class="dsh-form-item"
          context-label="上下文窗口（contextWindow）"
          output-label="最大输出（maxTokens）"
        />
        <div class="dsh-form-item">
          <label>输入类型（文本默认支持）</label>
          <div class="dsh-chk-row">
            <Checkbox v-model="modelForm.image">图片</Checkbox>
          </div>
        </div>
        <div class="dsh-form-hint">
          路由：{{ targetLabel }}
          <template v-if="!modelEditing && targetModels.length === 0">（当前目录为空，添加后写入）</template>
        </div>
        <div v-if="modelEditing" class="dsh-form-hint">改模型 ID 时条目上的其他扩展字段（description / systemPromptUpdate / reasoningEfforts 等）原样保留</div>
        <div v-else-if="modelTarget.kind === 'official'" class="dsh-form-hint">官方路由首次新增模型即从「内置目录」转为「自定义目录」</div>
        <div v-else class="dsh-form-hint">条目上的其他 pi-ai 字段（reasoningEfforts / compat / headers 等）原样保留</div>
      </div>
    </Dialog>
  </div>
</template>
