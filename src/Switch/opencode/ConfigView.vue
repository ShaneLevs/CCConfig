<script setup>

import { ref, onMounted, computed } from "vue";
import {
  Button,
  Input,
  Select,
  Dialog,
  MessagePlugin,
  Tag,
  Space,
  Empty,
  Popconfirm,
  Textarea,
  Collapse,
  CollapsePanel,
  InputNumber,
  Checkbox,
  Dropdown,
  DropdownMenu,
  DropdownItem,
  Tooltip,
  AutoComplete,
} from "tdesign-vue-next";
import {
  AddIcon,
  EditIcon,
  DeleteIcon,
  DownloadIcon,
  UploadIcon,
  RefreshIcon,
} from "tdesign-icons-vue-next";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import "./styles/ConfigView.css";

// ==================== Constants ====================

const NPM_OPTIONS = [
  { label: "@ai-sdk/openai", value: "@ai-sdk/openai" },
  { label: "@ai-sdk/openai-compatible", value: "@ai-sdk/openai-compatible" },
  { label: "@ai-sdk/anthropic", value: "@ai-sdk/anthropic" },
  { label: "@ai-sdk/amazon-bedrock", value: "@ai-sdk/amazon-bedrock" },
  { label: "@ai-sdk/google", value: "@ai-sdk/google" },
];

const KNOWN_PROVIDER_OPTION_KEYS = ["baseURL", "apiKey", "headers"];
const KNOWN_MODEL_KEYS = ["name", "limit", "options", "reasoning", "modalities"];

// 输入/输出模态（opencode modalities 合法值，源自 provider.ts capabilities 解析）
const MODALITY_OPTIONS = [
  { label: "文本 (text)", value: "text" },
  { label: "图像 (image)", value: "image" },
  { label: "音频 (audio)", value: "audio" },
  { label: "视频 (video)", value: "video" },
  { label: "PDF", value: "pdf" },
];
const MODALITY_LABELS = { text: "文本", image: "图像", audio: "音频", video: "视频", pdf: "PDF" };

// 思考参数（options.effort / options.thinking，与 MiniMax 页同款枚举）
const EFFORT_OPTIONS = ["minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ label: v, value: v }));
const THINKING_TYPE_OPTIONS = [
  { label: "enabled（预算式思考）", value: "enabled" },
  { label: "adaptive（自适应思考）", value: "adaptive" },
  { label: "disabled（关闭思考）", value: "disabled" },
];

// ==================== State ====================

const providers = ref({});
const showDialog = ref(false);
const dialogMode = ref("create");
const showImportDialog = ref(false);
const importString = ref("");

const formData = ref({
  id: "",
  npm: "@ai-sdk/openai-compatible",
  name: "",
  baseUrl: "",
  apiKey: "",
  extraOptions: [],
  models: [],
});

// ==================== Computed ====================

const dialogTitle = computed(() => (dialogMode.value === "edit" ? "编辑 Provider" : "新建 Provider"));

// Provider 展开状态（Pi 风格 Collapse）
const expandedProviders = ref([]);

// 上下文/输出数值格式化（如 128000 → 128K）
const formatCtx = (n) => {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
};

const providerList = computed(() => {
  return Object.entries(providers.value).map(([id, config]) => {
    const models = config.models
      ? Object.entries(config.models).map(([modelId, mc]) => ({
          id: modelId,
          name: mc.name || modelId,
          context: mc.limit?.context || 0,
          output: mc.limit?.output || 0,
          reasoning: mc.reasoning === true || !!mc.options?.effort || !!mc.options?.thinking || !!mc.options?.reasoningEffort || !!mc.variants,
          modIn: (mc.modalities?.input || []).filter((x) => x !== "text"),
          modOut: (mc.modalities?.output || []).filter((x) => x !== "text"),
          raw: mc, // 原始配置条目：编辑/添加单个模型时用于回读回写，避免污染其他字段
        }))
      : [];
    return { id, ...config, models };
  });
});

// ==================== Helpers ====================

const maskUrl = (url) => {
  if (!url) return "";
  if (url.length <= 40) return url;
  return url.substring(0, 37) + "...";
};

const optionsToKv = (optionsObj, knownKeys) => {
  if (!optionsObj || typeof optionsObj !== "object") return [];
  return Object.entries(optionsObj)
    .filter(([key]) => !knownKeys.includes(key))
    .map(([key, value]) => ({ key, value: typeof value === "object" ? JSON.stringify(value) : String(value) }));
};

const kvToOptions = (kvList) => {
  const result = {};
  for (const { key, value } of kvList) {
    if (!key?.trim()) continue;
    try {
      result[key.trim()] = JSON.parse(value);
    } catch {
      result[key.trim()] = value;
    }
  }
  return result;
};

const modelExtraFieldsToKv = (modelObj) => {
  if (!modelObj || typeof modelObj !== "object") return [];
  return Object.entries(modelObj)
    .filter(([key]) => !KNOWN_MODEL_KEYS.includes(key))
    .map(([key, value]) => ({ key, value: typeof value === "object" ? JSON.stringify(value) : String(value) }));
};

const modelOptionsToKv = (optionsObj, excludeKeys = []) => {
  if (!optionsObj || typeof optionsObj !== "object") return [];
  return Object.entries(optionsObj)
    .filter(([key]) => !excludeKeys.includes(key))
    .map(([key, value]) => ({
      key,
      value: typeof value === "object" ? JSON.stringify(value) : String(value),
    }));
};

// ==================== Data Loading ====================

const loadProviders = () => {
  try {
    providers.value = window.services.getOpencodeProviders();
  } catch (e) {
    console.error("Failed to load opencode providers:", e);
    providers.value = {};
  }
};

// ==================== Dialog Actions ====================

const createEmptyModel = () => ({
  id: "",
  name: "",
  context: 0,
  output: 0,
  reasoning: false,
  modalitiesInput: [],
  modalitiesOutput: [],
  effort: "",
  thinkingType: "",
  thinkingBudget: 0,
  thinkingExtra: {}, // 原配置 thinking 中非 type/budgetTokens 的子键，保存时合并回写
  sdkOptions: [],
  extraFields: [],
});

const openCreateDialog = () => {
  dialogMode.value = "create";
  formData.value = {
    id: "",
    npm: "@ai-sdk/openai-compatible",
    name: "",
    baseUrl: "",
    apiKey: "",
    extraOptions: [],
    models: [],
  };
  showDialog.value = true;
};

const openEditDialog = (provider) => {
  dialogMode.value = "edit";
  const options = provider.options || {};
  const extraOptions = optionsToKv(options, KNOWN_PROVIDER_OPTION_KEYS);

  // 模型不在本弹窗内编辑（列表卡片内单独管理），保存时原样保留，避免重建覆盖丢字段
  formData.value = {
    id: provider.id,
    npm: provider.npm || "",
    name: provider.name || "",
    baseUrl: options.baseURL || "",
    apiKey: options.apiKey || "",
    extraOptions,
    models: [],
  };
  showDialog.value = true;
};

// ==================== Model Management（Pi 风格：provider 卡片内管理） ====================

// 添加模型：AutoComplete 弹窗（打开即自动拉取 /models，选中自动填充）
const showAutoModelDialog = ref(false);
const addModelProviderId = ref(null);
const autoModels = ref([]);
const autoModelsLoading = ref(false);
const autoModelsError = ref("");
const autoModelForm = ref(createEmptyModel());

// AutoComplete 下拉选项（显示名 → 模型 ID）
const modelOptions = computed(() =>
  autoModels.value.map(m => ({ label: m.name || m.id, value: m.id }))
);

const getProviderByList = (providerId) =>
  providerList.value.find(p => p.id === providerId);

const openAddModelDialog = (providerId) => {
  addModelProviderId.value = providerId;
  autoModelForm.value = createEmptyModel();
  autoModels.value = [];
  autoModelsLoading.value = false;
  autoModelsError.value = "";
  showAutoModelDialog.value = true;
  // 打开弹窗即自动拉取模型列表，无需手动点击
  handleAutoFetchModels();
};

const handleAutoFetchModels = async () => {
  const prov = getProviderByList(addModelProviderId.value);
  if (!prov || !prov.options?.baseURL) {
    autoModelsError.value = "该 Provider 未配置 Base URL，无法自动获取";
    return;
  }
  autoModelsLoading.value = true;
  autoModelsError.value = "";
  try {
    const list = await window.services.fetchProviderModels(prov.options.baseURL, prov.options.apiKey);
    autoModels.value = list;
    if (list.length === 0) autoModelsError.value = "接口返回空列表";
  } catch (e) {
    autoModelsError.value = e.message;
  } finally {
    autoModelsLoading.value = false;
  }
};

// 选中模型：自动带出名称/上下文/输出/推理
const onAutoModelSelect = (val) => {
  const m = autoModels.value.find(x => x.id === val);
  if (!m) return;
  autoModelForm.value.id = m.id;
  autoModelForm.value.name = m.name || m.id;
  if (m.contextWindow) autoModelForm.value.context = m.contextWindow;
  if (m.maxTokens) autoModelForm.value.output = m.maxTokens;
  if (m.reasoning) autoModelForm.value.reasoning = true;
};

// 列表行思考参数摘要
const thinkingStat = (m) => {
  const o = m.raw?.options || {};
  const parts = [];
  if (o.effort) parts.push("档位 " + o.effort);
  if (o.thinking?.type) parts.push("思考 " + o.thinking.type + (o.thinking.budgetTokens ? " " + formatCtx(o.thinking.budgetTokens) : ""));
  return parts.join(" · ");
};
const modTag = (mods) => mods.map((x) => MODALITY_LABELS[x] || x).join("/");

// 表单 → opencode 模型配置条目（limit 仅在 >0 时写入，0/默认不写；
// reasoning/modalities/effort/thinking 为一级字段，与自由格式 SDK Options 合并写回 options）
const buildModelEntry = (form) => {
  const id = form.id.trim();
  const entry = { name: form.name?.trim() || id };
  const context = Number(form.context) || 0;
  const output = Number(form.output) || 0;
  if (context || output) {
    entry.limit = {};
    if (context) entry.limit.context = context;
    if (output) entry.limit.output = output;
  }
  if (form.reasoning) entry.reasoning = true;
  // 模态：默认纯文本不写（opencode 默认 input/output 均含 text）；清空 = 回退默认
  const mm = {};
  const norm = (arr) => (Array.isArray(arr) ? [...new Set(arr)] : []);
  const inMods = norm(form.modalitiesInput);
  const outMods = norm(form.modalitiesOutput);
  if (inMods.length && !(inMods.length === 1 && inMods[0] === "text")) mm.input = inMods;
  if (outMods.length && !(outMods.length === 1 && outMods[0] === "text")) mm.output = outMods;
  if (Object.keys(mm).length) entry.modalities = mm;
  const opts = kvToOptions(form.sdkOptions || []);
  if (form.effort) opts.effort = form.effort;
  if (form.thinkingType) {
    opts.thinking = { ...(form.thinkingExtra || {}), type: form.thinkingType };
    if (form.thinkingType === "enabled" && (Number(form.thinkingBudget) || 0) > 0) {
      opts.thinking.budgetTokens = Number(form.thinkingBudget);
    } else {
      delete opts.thinking.budgetTokens;
    }
  }
  if (Object.keys(opts).length > 0) entry.options = opts;
  Object.assign(entry, kvToOptions(form.extraFields || []));
  return entry;
};

// 读-改-写：仅修改目标 provider 的 models，其余字段与其他模型条目原样保留
const mutateProviderModels = (providerId, mutate) => {
  const current = window.services.getOpencodeProviders();
  const prov = current[providerId];
  if (!prov) return { ok: false, error: "Provider 不存在" };
  const models = { ...(prov.models || {}) };
  const res = mutate(models);
  if (res && res.error) return { ok: false, error: res.error };
  return { ok: window.services.setOpencodeProvider(providerId, { ...prov, models }) };
};

// 确认添加（支持手动输入 ID，不依赖下拉）
const confirmAddAutoModel = () => {
  const id = autoModelForm.value.id.trim();
  if (!id) return MessagePlugin.warning("请输入模型 ID");
  const res = mutateProviderModels(addModelProviderId.value, (models) => {
    if (models[id]) return { error: "模型已存在: " + id };
    models[id] = buildModelEntry({ ...autoModelForm.value, id });
  });
  if (res.error) return MessagePlugin.warning(res.error);
  if (res.ok) {
    MessagePlugin.success(`模型 ${id} 已添加`);
    showAutoModelDialog.value = false;
    loadProviders();
  } else {
    MessagePlugin.error("添加失败");
  }
};

// ==================== Model Edit ====================

const showEditModelDialog = ref(false);
const editModelProviderId = ref(null);
const editModelOrigId = ref(null);
const editModelForm = ref(createEmptyModel());

const openEditModelDialog = (providerId, model) => {
  editModelProviderId.value = providerId;
  editModelOrigId.value = model.id;
  const raw = model.raw || {};
  const limit = raw.limit || {};
  const rawThinking = raw.options?.thinking;
  const hasValidThinking = rawThinking && typeof rawThinking === "object" && typeof rawThinking.type === "string";
  const hasValidEffort = typeof raw.options?.effort === "string";
  const thinkingExtra = hasValidThinking
    ? Object.fromEntries(Object.entries(rawThinking).filter(([k]) => k !== "type" && k !== "budgetTokens"))
    : {};
  editModelForm.value = {
    id: model.id,
    name: raw.name || model.id,
    context: Number(limit.context) || 0,
    output: Number(limit.output) || 0,
    reasoning: raw.reasoning === true,
    modalitiesInput: Array.isArray(raw.modalities?.input) ? [...raw.modalities.input] : [],
    modalitiesOutput: Array.isArray(raw.modalities?.output) ? [...raw.modalities.output] : [],
    effort: hasValidEffort ? raw.options.effort : "",
    thinkingType: hasValidThinking ? rawThinking.type : "",
    thinkingBudget: Number(rawThinking?.budgetTokens) || 0,
    thinkingExtra,
    // 仅屏蔽确实被结构化字段接管的键，非标准类型值仍留在自由格式编辑器里原样往返
    sdkOptions: modelOptionsToKv(raw.options || {}, [
      ...(hasValidEffort ? ["effort"] : []),
      ...(hasValidThinking ? ["thinking"] : []),
    ]),
    extraFields: modelExtraFieldsToKv(raw),
  };
  showEditModelDialog.value = true;
};

const handleSaveModel = () => {
  const id = editModelForm.value.id.trim();
  if (!id) return MessagePlugin.warning("请输入模型 ID");
  const origId = editModelOrigId.value;
  const res = mutateProviderModels(editModelProviderId.value, (models) => {
    if (id !== origId && models[id]) return { error: "模型已存在: " + id };
    if (id !== origId) delete models[origId];
    models[id] = buildModelEntry({ ...editModelForm.value, id });
  });
  if (res.error) return MessagePlugin.warning(res.error);
  if (res.ok) {
    MessagePlugin.success(`模型 ${id} 已更新`);
    showEditModelDialog.value = false;
    loadProviders();
  } else {
    MessagePlugin.error("保存失败");
  }
};

const handleDeleteModel = (providerId, modelId) => {
  const res = mutateProviderModels(providerId, (models) => {
    delete models[modelId];
  });
  if (res.ok) {
    MessagePlugin.success(`模型 ${modelId} 已删除`);
    loadProviders();
  } else {
    MessagePlugin.error("删除失败");
  }
};

// ==================== Save ====================

const saveProvider = () => {
  const id = formData.value.id.trim();
  if (!id) return MessagePlugin.warning("请输入 Provider ID");
  if (!formData.value.npm) return MessagePlugin.warning("请选择 NPM Package");

  if (dialogMode.value === "create" && providers.value[id]) {
    return MessagePlugin.warning("Provider ID 已存在: " + id);
  }

  // Build options
  const options = {};
  if (formData.value.baseUrl) options.baseURL = formData.value.baseUrl;
  if (formData.value.apiKey) options.apiKey = formData.value.apiKey;
  const extraOptObj = kvToOptions(formData.value.extraOptions);
  Object.assign(options, extraOptObj);

  // 编辑时基于磁盘最新配置合并，models 等其他字段原样保留（切换 npm 等不再重置模型参数）
  const current = window.services.getOpencodeProviders();
  const prev = current[id] || {};
  const providerConfig = {
    ...prev,
    npm: formData.value.npm,
    name: formData.value.name || id,
    options,
    models: dialogMode.value === "create" ? {} : { ...(prev.models || {}) },
  };

  if (window.services.setOpencodeProvider(id, providerConfig)) {
    MessagePlugin.success(dialogMode.value === "create" ? "Provider 已添加" : "Provider 已更新");
    showDialog.value = false;
    loadProviders();
  } else {
    MessagePlugin.error("保存失败");
  }
};

// ==================== Delete ====================

const deleteProvider = (providerId) => {
  if (window.services.removeOpencodeProvider(providerId)) {
    MessagePlugin.success("Provider 已删除");
    loadProviders();
  } else {
    MessagePlugin.error("删除失败");
  }
};

// ==================== Open Config File ====================

const openConfigFile = () => {
  const filePath = window.services.getOpencodeConfigPath();
  window.utools.shellOpenPath(filePath);
};

// ==================== Export / Import ====================

const handleExport = () => {
  try {
    const currentProviders = window.services.getOpencodeProviders();
    const list = Object.entries(currentProviders).map(([id, config]) => ({ id, ...config }));
    if (!list.length) return MessagePlugin.warning("没有 Provider 可导出");
    const compressed = window.services.compressConfigs(list);
    window.utools.copyText(compressed);
    MessagePlugin.success("已复制到剪贴板");
  } catch (e) {
    MessagePlugin.error("导出失败: " + e.message);
  }
};

const openImportDialog = () => {
  importString.value = "";
  showImportDialog.value = true;
};

const handleImport = () => {
  if (!importString.value.trim()) return MessagePlugin.warning("请粘贴配置字符串");
  try {
    const decompressed = window.services.decompressConfigs(importString.value.trim());
    if (!Array.isArray(decompressed)) return MessagePlugin.error("解压数据格式不正确");

    const batch = {};
    for (const item of decompressed) {
      const { id, ...config } = item;
      if (!id) continue;
      // Merge models if provider already exists
      const existing = providers.value[id];
      if (existing && existing.models && config.models) {
        config.models = { ...existing.models, ...config.models };
      }
      batch[id] = config;
    }
    const count = Object.keys(batch).length;
    if (count && window.services.setOpencodeProviders(batch)) {
      MessagePlugin.success(`已导入 ${count} 个 Provider`);
      showImportDialog.value = false;
      loadProviders();
    } else if (!count) {
      MessagePlugin.warning("没有有效的 Provider 可导入");
    }
  } catch (e) {
    MessagePlugin.error("导入失败: " + e.message);
  }
};

// ==================== NPM Tag Color ====================

const getNpmTagTheme = (npm) => {
  if (npm === "@ai-sdk/openai") return "primary";
  if (npm === "@ai-sdk/openai-compatible") return "success";
  if (npm === "@ai-sdk/anthropic") return "warning";
  if (npm === "@ai-sdk/amazon-bedrock") return "default";
  if (npm === "@ai-sdk/google") return "danger";
  return "default";
};

const getNpmShortLabel = (npm) => {
  const map = {
    "@ai-sdk/openai": "OpenAI",
    "@ai-sdk/openai-compatible": "Compatible",
    "@ai-sdk/anthropic": "Anthropic",
    "@ai-sdk/amazon-bedrock": "Bedrock",
    "@ai-sdk/google": "Google",
  };
  return map[npm] || npm;
};

onMounted(() => {
  loadProviders();
});

</script>

<template>
  <div class="opencode-config-view">
    <!-- Section Header -->
    <div class="section-header">
      <span class="section-tip">
        直接编辑 <span class="hint-link" @click="openConfigFile">opencode.json</span>
      </span>
      <Space size="small">
        <Button size="small" variant="outline" @click="handleExport">
          <template #icon><DownloadIcon /></template> 导出
        </Button>
        <Button size="small" variant="outline" @click="openImportDialog">
          <template #icon><UploadIcon /></template> 导入
        </Button>
        <Button size="small" theme="primary" @click="openCreateDialog">
          <template #icon><AddIcon /></template> 新建配置
        </Button>
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" @click="loadProviders">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </Space>
    </div>

    <!-- Empty State -->
    <div v-if="!providerList.length" class="empty-state">
      <Empty description="暂无配置">
        <template #action>
          <Button theme="primary" @click="openCreateDialog">
            <template #icon><AddIcon /></template> 添加第一个配置
          </Button>
        </template>
      </Empty>
    </div>

    <!-- Provider List（Pi 风格 Collapse） -->
    <div v-else class="provider-list">
      <Collapse v-model="expandedProviders" class="oc-provider-collapse">
        <CollapsePanel
          v-for="provider in providerList"
          :key="provider.id"
          :value="provider.id"
        >
          <template #header>
            <div class="oc-provider-header-left">
              <span class="oc-provider-name">{{ provider.id }}</span>
              <Tag size="small" :theme="getNpmTagTheme(provider.npm)" variant="light">
                {{ getNpmShortLabel(provider.npm) }}
              </Tag>
            </div>
          </template>
          <template #headerRightContent>
            <div class="oc-provider-header-right" @click.stop>
              <span class="oc-model-count">{{ provider.models.length }} 个模型</span>
              <Space size="small">
                <Tooltip content="编辑配置" placement="top">
                  <Button size="small" variant="text" @click="openEditDialog(provider)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm theme="danger" content="确定要删除这个 Provider 吗？" @confirm="deleteProvider(provider.id)">
                  <Tooltip content="删除" placement="top">
                    <Button size="small" theme="danger" variant="text">
                      <template #icon><DeleteIcon /></template>
                    </Button>
                  </Tooltip>
                </Popconfirm>
              </Space>
            </div>
          </template>

          <template #content>
            <div class="oc-provider-info">
              <div class="oc-info-row">
                <span class="oc-info-label">API Key</span>
                <span class="oc-info-value mono">{{ provider.options?.apiKey ? provider.options.apiKey.slice(0, 8) + '...' + provider.options.apiKey.slice(-4) : '未设置' }}</span>
              </div>
              <div class="oc-info-row">
                <span class="oc-info-label">Base URL</span>
                <span class="oc-info-value mono">{{ provider.options?.baseURL || '默认' }}</span>
              </div>
              <div v-if="provider.name && provider.name !== provider.id" class="oc-info-row">
                <span class="oc-info-label">显示名称</span>
                <span class="oc-info-value">{{ provider.name }}</span>
              </div>
            </div>

            <div class="oc-models-section">
              <div class="oc-models-title">
                <span>模型列表</span>
                <Button size="small" variant="text" @click="openAddModelDialog(provider.id)">
                  <template #icon><AddIcon /></template> 添加模型
                </Button>
              </div>
              <div v-if="!provider.models.length" class="oc-models-empty">暂无模型</div>
              <div v-else class="oc-model-item" v-for="m in provider.models" :key="m.id">
                <div class="oc-model-info">
                  <span class="oc-model-name">{{ m.name }}</span>
                  <Tag v-if="m.reasoning" size="small" theme="warning" variant="light">推理</Tag>
                  <Tag v-if="m.modIn.length" size="small" theme="primary" variant="light">{{ modTag(m.modIn) }}入</Tag>
                  <Tag v-if="m.modOut.length" size="small" theme="success" variant="light">{{ modTag(m.modOut) }}出</Tag>
                </div>
                <div class="oc-model-meta">
                  <span class="oc-model-stat">上下文: {{ m.context ? formatCtx(m.context) : '-' }}</span>
                  <span class="oc-model-stat">输出: {{ m.output ? formatCtx(m.output) : '-' }}</span>
                  <span v-if="thinkingStat(m)" class="oc-model-stat">{{ thinkingStat(m) }}</span>
                </div>
                <div class="oc-model-actions" @click.stop>
                  <Tooltip content="编辑模型" placement="top">
                    <Button size="small" variant="text" @click="openEditModelDialog(provider.id, m)">
                      <template #icon><EditIcon /></template>
                    </Button>
                  </Tooltip>
                  <Popconfirm content="确定删除此模型？" @confirm="handleDeleteModel(provider.id, m.id)">
                    <Button size="small" variant="text" theme="danger">
                      <template #icon><DeleteIcon /></template>
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            </div>
          </template>
        </CollapsePanel>
      </Collapse>
    </div>

    <!-- Create/Edit Dialog（Pi 风格） -->
    <Dialog v-model:visible="showDialog" :header="dialogTitle" width="480px" @confirm="saveProvider">
      <div class="oc-form">
        <!-- Provider ID -->
        <div class="oc-form-item">
          <label>Provider ID <span class="required">*</span></label>
          <Input v-model="formData.id" placeholder="例如: deepseek" :disabled="dialogMode === 'edit'" />
        </div>

        <!-- NPM Package -->
        <div class="oc-form-item">
          <label>NPM Package <span class="required">*</span></label>
          <Select v-model="formData.npm" :options="NPM_OPTIONS" placeholder="选择 SDK 包" />
        </div>

        <!-- Display Name -->
        <div class="oc-form-item">
          <label>显示名称</label>
          <Input v-model="formData.name" placeholder="Provider 显示名称" />
        </div>

        <!-- Base URL -->
        <div class="oc-form-item">
          <label>Base URL</label>
          <Input v-model="formData.baseUrl" placeholder="https://api.example.com/v1" />
        </div>

        <!-- API Key -->
        <div class="oc-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="formData.apiKey" placeholder="sk-..." />
        </div>

        <!-- Extra Options -->
        <div class="oc-form-item">
          <label>额外选项 (options)</label>
          <DynamicKvEditor
            v-model="formData.extraOptions"
            :key-options="[]"
            key-placeholder="选项名"
            value-placeholder="选项值 (JSON 或字符串)"
          />
        </div>
      </div>

      <template #footer>
        <div class="oc-dialog-footer">
          <div class="oc-dialog-footer-right">
            <Button variant="outline" @click="showDialog = false">取消</Button>
            <Button theme="primary" @click="saveProvider">保存</Button>
          </div>
        </div>
      </template>
    </Dialog>

    <!-- 添加模型（Pi 风格 AutoComplete 自动拉取） -->
    <Dialog
      v-model:visible="showAutoModelDialog"
      header="添加模型"
      width="520px"
      :confirm-btn="{ content: '添加', theme: 'primary' }"
      @confirm="confirmAddAutoModel"
    >
      <div class="oc-form">
        <div class="oc-form-item">
          <label>所属 Provider</label>
          <div class="oc-provider-name">{{ addModelProviderId }}</div>
        </div>
        <div class="oc-form-item">
          <label>模型 ID <span class="required">*</span></label>
          <AutoComplete
            v-model="autoModelForm.id"
            :options="modelOptions"
            :loading="autoModelsLoading"
            filterable
            clearable
            placeholder="输入或从下拉选择模型"
            @select="onAutoModelSelect"
          />
          <div v-if="autoModelsLoading" class="oc-form-hint">正在自动拉取模型列表…</div>
          <div v-else-if="autoModelsError" class="oc-form-hint oc-fetch-error">
            自动获取失败：{{ autoModelsError }}
            <span class="oc-fetch-retry" @click="handleAutoFetchModels">重试</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="oc-form-hint">
            已自动获取 {{ autoModels.length }} 个模型，选中后自动填充名称/上下文等
          </div>
        </div>
        <div class="oc-form-item">
          <label>显示名称</label>
          <Input v-model="autoModelForm.name" placeholder="留空则使用模型 ID" />
        </div>
        <ModelLimitsFields v-model:context="autoModelForm.context" v-model:output="autoModelForm.output" item-class="oc-form-item" />
        <div class="oc-form-item">
          <Checkbox v-model="autoModelForm.reasoning">推理模型 (reasoning)</Checkbox>
        </div>
        <div class="oc-form-item-row">
          <div class="oc-form-item oc-form-item--flex">
            <label>输入模态</label>
            <Select v-model="autoModelForm.modalitiesInput" multiple clearable :options="MODALITY_OPTIONS" placeholder="默认：仅文本" />
          </div>
          <div class="oc-form-item oc-form-item--flex">
            <label>输出模态</label>
            <Select v-model="autoModelForm.modalitiesOutput" multiple clearable :options="MODALITY_OPTIONS" placeholder="默认：仅文本" />
          </div>
        </div>
        <div class="oc-form-item-row">
          <div class="oc-form-item oc-form-item--flex">
            <label>思考档位</label>
            <Select v-model="autoModelForm.effort" :options="EFFORT_OPTIONS" clearable placeholder="不设置" />
          </div>
          <div class="oc-form-item oc-form-item--flex">
            <label>思考模式</label>
            <Select v-model="autoModelForm.thinkingType" :options="THINKING_TYPE_OPTIONS" clearable placeholder="不设置" />
          </div>
        </div>
        <div v-if="autoModelForm.thinkingType === 'enabled'" class="oc-form-item">
          <label>思考预算（budgetTokens，0 = 不写入）</label>
          <InputNumber v-model="autoModelForm.thinkingBudget" :min="0" :step="1024" placeholder="0 = 不写入" />
        </div>
      </div>
    </Dialog>

    <!-- 编辑模型（Pi 风格独立弹窗） -->
    <Dialog
      v-model:visible="showEditModelDialog"
      header="编辑模型"
      width="520px"
      :confirm-btn="{ content: '保存', theme: 'primary' }"
      @confirm="handleSaveModel"
    >
      <div class="oc-form">
        <div class="oc-form-item">
          <label>所属 Provider</label>
          <div class="oc-provider-name">{{ editModelProviderId }}</div>
        </div>
        <div class="oc-form-item">
          <label>模型 ID <span class="required">*</span></label>
          <Input v-model="editModelForm.id" placeholder="例如: deepseek-chat" />
        </div>
        <div class="oc-form-item">
          <label>显示名称</label>
          <Input v-model="editModelForm.name" placeholder="留空则使用模型 ID" />
        </div>
        <ModelLimitsFields v-model:context="editModelForm.context" v-model:output="editModelForm.output" item-class="oc-form-item" />
        <div class="oc-form-item">
          <Checkbox v-model="editModelForm.reasoning">推理模型 (reasoning)</Checkbox>
        </div>
        <div class="oc-form-item-row">
          <div class="oc-form-item oc-form-item--flex">
            <label>输入模态</label>
            <Select v-model="editModelForm.modalitiesInput" multiple clearable :options="MODALITY_OPTIONS" placeholder="默认：仅文本" />
          </div>
          <div class="oc-form-item oc-form-item--flex">
            <label>输出模态</label>
            <Select v-model="editModelForm.modalitiesOutput" multiple clearable :options="MODALITY_OPTIONS" placeholder="默认：仅文本" />
          </div>
        </div>
        <div class="oc-form-item-row">
          <div class="oc-form-item oc-form-item--flex">
            <label>思考档位</label>
            <Select v-model="editModelForm.effort" :options="EFFORT_OPTIONS" clearable placeholder="不设置" />
          </div>
          <div class="oc-form-item oc-form-item--flex">
            <label>思考模式</label>
            <Select v-model="editModelForm.thinkingType" :options="THINKING_TYPE_OPTIONS" clearable placeholder="不设置" />
          </div>
        </div>
        <div v-if="editModelForm.thinkingType === 'enabled'" class="oc-form-item">
          <label>思考预算（budgetTokens，0 = 不写入）</label>
          <InputNumber v-model="editModelForm.thinkingBudget" :min="0" :step="1024" placeholder="0 = 不写入" />
        </div>
        <div class="oc-form-subsection">
          <div class="oc-form-subsection-title">SDK Options</div>
          <DynamicKvEditor
            v-model="editModelForm.sdkOptions"
            :key-options="[]"
            key-placeholder="选项名"
            value-placeholder="选项值"
          />
        </div>
        <div class="oc-form-subsection">
          <div class="oc-form-subsection-title">额外字段 (variants, cost, tool_call 等)</div>
          <DynamicKvEditor
            v-model="editModelForm.extraFields"
            :key-options="[]"
            key-placeholder="字段名"
            value-placeholder="字段值 (JSON 或字符串)"
          />
        </div>
      </div>
    </Dialog>

    <!-- Import Dialog -->
    <Dialog v-model:visible="showImportDialog" header="从字符串导入" width="480px" @confirm="handleImport">
      <div class="oc-form">
        <div class="oc-form-item-vertical">
          <label>配置字符串</label>
          <Textarea
            v-if="showImportDialog"
            v-model="importString"
            placeholder="粘贴配置字符串"
            :autosize="{ minRows: 4, maxRows: 8 }"
          />
        </div>
      </div>
    </Dialog>
  </div>
</template>
