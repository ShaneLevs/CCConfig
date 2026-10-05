<script setup>

import { ref, onMounted, computed } from "vue";
import {
  Button,
  Dialog,
  MessagePlugin,
  Tag,
  Space,
  Empty,
  Popconfirm,
  Textarea,
  Collapse,
  CollapsePanel,
  Tooltip,
} from "tdesign-vue-next";
import {
  AddIcon,
  EditIcon,
  DeleteIcon,
  DownloadIcon,
  UploadIcon,
  RefreshIcon,
} from "tdesign-icons-vue-next";
import OcModelFormDialog from "./components/OcModelFormDialog.vue";
import OcProviderDialog from "./components/OcProviderDialog.vue";
import "./styles/ConfigView.css";

// ==================== Constants ====================

const KNOWN_PROVIDER_OPTION_KEYS = ["baseURL", "apiKey", "headers"];
const KNOWN_MODEL_KEYS = ["name", "limit", "options", "reasoning", "modalities"];

// 思考参数摘要中的模态文案
const MODALITY_LABELS = { text: "文本", image: "图像", audio: "音频", video: "视频", pdf: "PDF" };

// ==================== State ====================

const createEmptyProviderForm = () => ({
  id: "",
  npm: "@ai-sdk/openai-compatible",
  name: "",
  baseUrl: "",
  apiKey: "",
  extraOptions: [],
  models: [],
});

const providers = ref({});
const showProviderDialog = ref(false);
const providerDialogMode = ref("create");
const providerDialogInitial = ref(createEmptyProviderForm());
const showImportDialog = ref(false);
const importString = ref("");

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
  providerDialogMode.value = "create";
  providerDialogInitial.value = createEmptyProviderForm();
  showProviderDialog.value = true;
};

const openEditDialog = (provider) => {
  providerDialogMode.value = "edit";
  const options = provider.options || {};
  const extraOptions = optionsToKv(options, KNOWN_PROVIDER_OPTION_KEYS);

  // 模型不在本弹窗内编辑（列表卡片内单独管理），保存时原样保留，避免重建覆盖丢字段
  providerDialogInitial.value = {
    id: provider.id,
    npm: provider.npm || "",
    name: provider.name || "",
    baseUrl: options.baseURL || "",
    apiKey: options.apiKey || "",
    extraOptions,
    models: [],
  };
  showProviderDialog.value = true;
};

// ==================== Model Management（Pi 风格：provider 卡片内管理） ====================

// 添加/编辑模型共用弹窗（add 模式内部自动拉取 /models）
const showAddModelDialog = ref(false);
const addModelProviderId = ref(null);
const addModelProviderRef = ref(null); // { baseUrl, apiKey }，供弹窗自动拉取
const addModelInitialForm = ref(createEmptyModel());

const showEditModelDialog = ref(false);
const editModelProviderId = ref(null);
const editModelOrigId = ref(null);
const editModelInitialForm = ref(createEmptyModel());

const getProviderByList = (providerId) =>
  providerList.value.find(p => p.id === providerId);

const openAddModelDialog = (providerId) => {
  addModelProviderId.value = providerId;
  const prov = getProviderByList(providerId);
  addModelProviderRef.value = prov
    ? { baseUrl: prov.options?.baseURL, apiKey: prov.options?.apiKey }
    : null;
  addModelInitialForm.value = createEmptyModel();
  showAddModelDialog.value = true;
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
const confirmAddModel = (form) => {
  const id = form.id.trim();
  if (!id) return MessagePlugin.warning("请输入模型 ID");
  const res = mutateProviderModels(addModelProviderId.value, (models) => {
    if (models[id]) return { error: "模型已存在: " + id };
    models[id] = buildModelEntry({ ...form, id });
  });
  if (res.error) return MessagePlugin.warning(res.error);
  if (res.ok) {
    MessagePlugin.success(`模型 ${id} 已添加`);
    showAddModelDialog.value = false;
    loadProviders();
  } else {
    MessagePlugin.error("添加失败");
  }
};

// ==================== Model Edit ====================

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
  editModelInitialForm.value = {
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

const handleSaveModel = (form) => {
  const id = form.id.trim();
  if (!id) return MessagePlugin.warning("请输入模型 ID");
  const origId = editModelOrigId.value;
  const res = mutateProviderModels(editModelProviderId.value, (models) => {
    if (id !== origId && models[id]) return { error: "模型已存在: " + id };
    if (id !== origId) delete models[origId];
    models[id] = buildModelEntry({ ...form, id });
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

// 弹窗确认 → 合并写盘：编辑时基于磁盘最新配置合并，models 等其他字段原样保留
const saveProvider = (form) => {
  const id = form.id.trim();
  if (!id) return MessagePlugin.warning("请输入 Provider ID");
  if (!form.npm) return MessagePlugin.warning("请选择 NPM Package");

  if (providerDialogMode.value === "create" && providers.value[id]) {
    return MessagePlugin.warning("Provider ID 已存在: " + id);
  }

  // Build options
  const options = {};
  if (form.baseUrl) options.baseURL = form.baseUrl;
  if (form.apiKey) options.apiKey = form.apiKey;
  const extraOptObj = kvToOptions(form.extraOptions);
  Object.assign(options, extraOptObj);

  const current = window.services.getOpencodeProviders();
  const prev = current[id] || {};
  const providerConfig = {
    ...prev,
    npm: form.npm,
    name: form.name || id,
    options,
    models: providerDialogMode.value === "create" ? {} : { ...(prev.models || {}) },
  };

  if (window.services.setOpencodeProvider(id, providerConfig)) {
    MessagePlugin.success(providerDialogMode.value === "create" ? "Provider 已添加" : "Provider 已更新");
    showProviderDialog.value = false;
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

    <!-- Create/Edit Provider Dialog -->
    <OcProviderDialog
      v-model:visible="showProviderDialog"
      :mode="providerDialogMode"
      :initial="providerDialogInitial"
      @confirm="saveProvider"
    />

    <!-- 模型添加 / 编辑弹窗（add 模式带 /models 自动拉取） -->
    <OcModelFormDialog
      v-model:visible="showAddModelDialog"
      mode="add"
      :provider-name="addModelProviderId || ''"
      :provider="addModelProviderRef"
      :initial-form="addModelInitialForm"
      @confirm="confirmAddModel"
    />
    <OcModelFormDialog
      v-model:visible="showEditModelDialog"
      mode="edit"
      :provider-name="editModelProviderId || ''"
      :initial-form="editModelInitialForm"
      @confirm="handleSaveModel"
    />

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
