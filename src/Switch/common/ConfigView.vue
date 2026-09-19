<script setup>

import { ref, computed, onMounted, watch, h } from "vue";
import {
  Empty, Button, Tag, Space, Tooltip, Dialog, Input, InputNumber, MessagePlugin, Popconfirm, Alert as TAlert, Select, Switch, CheckboxGroup, Checkbox, Collapse, CollapsePanel, AutoComplete, Cascader, Table,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, SendIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import PresetCustomInput from "../../components/PresetCustomInput.vue";
import "./styles/ConfigView.css";

// 通用配置：跨 agent 的供应商/模型主数据库
const API_TYPE_OPTIONS = [
  { label: "OpenAI Chat Completions", value: "openai-completions" },
  { label: "OpenAI Responses", value: "openai-responses" },
  { label: "Anthropic Messages", value: "anthropic-messages" },
  { label: "Google Generative AI", value: "google-generative-ai" },
];

// 常用请求头名（自动完成提示）
const HEADER_KEY_OPTIONS = [
  "x-portkey-api-key",
  "x-api-key",
  "Authorization",
  "x-secret",
];

// 常用 compat 字段名（自动完成提示）
const COMPAT_KEY_OPTIONS = [
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "maxTokensField",
  "supportsStore",
  "thinkingFormat",
];

// 输入类型选项
const INPUT_TYPE_OPTIONS = [
  { label: "文本 (text)", value: "text" },
  { label: "图像 (image)", value: "image" },
];

// 上下文窗口 / 最大输出 常见值选项
const CTX_OPTIONS = [
  { label: "默认", value: 0 },
  { label: "32K", value: 32000 },
  { label: "64K", value: 64000 },
  { label: "128K", value: 128000 },
  { label: "200K", value: 200000 },
  { label: "1M", value: 1000000 },
];
const TOKENS_OPTIONS = [
  { label: "默认", value: 0 },
  { label: "4K", value: 4096 },
  { label: "8K", value: 8192 },
  { label: "16K", value: 16384 },
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 128000 },
  { label: "256K", value: 256000 },
  { label: "384K", value: 384000 },
];

const loading = ref(false);
const providers = ref([]);
const expandedList = ref([]);
const editDialog = ref(false);
const editingProvider = ref(null);
const editForm = ref({ apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true });
const addProviderDialog = ref(false);
const addProviderForm = ref({ name: '', apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true });
const addModelDialog = ref(false);
const addModelProvider = ref(null);
const addModelForm = ref({ id: '', name: '', contextWindow: 0, maxTokens: 0, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: [] });
// 模型编辑
const editModelDialog = ref(false);
// 编辑时的新名称（供应商重命名 / 模型 ID 重命名）
const newProviderName = ref('');
const newModelId = ref('');
// 模型高级配置展开状态（添加/编辑共用）
const modelAdvancedOpen = ref(false);
const editModelProvider = ref(null);
const editingModelId = ref(null);
const editModelForm = ref({ name: '', contextWindow: 0, maxTokens: 0, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: [] });

const loadProviders = () => {
  try {
    providers.value = window.services.getCommonProviderList();
  } catch (e) {
    console.error("加载通用供应商失败:", e);
    providers.value = [];
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.name;
  newProviderName.value = provider.name;
  editForm.value = {
    apiKey: provider.apiKey || '',
    baseUrl: provider.baseUrl || '',
    api: provider.api || 'openai-completions',
    headers: provider.headers ? Object.entries(provider.headers).map(([key, value]) => ({ key, value })) : [],
    authHeader: provider.authHeader !== undefined ? provider.authHeader : true,
  };
  editDialog.value = true;
};

const handleSaveProvider = async () => {
  try {
    const headersObj = {};
    (editForm.value.headers || []).forEach(({ key, value }) => {
      if (key && key.trim()) headersObj[key.trim()] = value;
    });
    const finalName = newProviderName.value.trim() || editingProvider.value;
    if (finalName !== editingProvider.value) {
      // 重命名：删除旧供应商 + 新建（模型跟随迁移）
      const { providers: list } = window.services.readCommonProviders();
      const oldProv = list.find((p) => p.name === editingProvider.value);
      if (!oldProv) throw new Error(`供应商 ${editingProvider.value} 不存在`);
      window.services.deleteCommonProvider(editingProvider.value);
      window.services.addCommonProvider({
        name: finalName,
        apiKey: editForm.value.apiKey,
        baseUrl: editForm.value.baseUrl,
        api: editForm.value.api,
        headers: headersObj,
        authHeader: editForm.value.authHeader,
        models: oldProv.models || [],
      });
    } else {
      window.services.updateCommonProvider(editingProvider.value, {
        apiKey: editForm.value.apiKey,
        baseUrl: editForm.value.baseUrl,
        api: editForm.value.api,
        headers: headersObj,
        authHeader: editForm.value.authHeader,
      });
    }
    MessagePlugin.success("供应商配置已更新");
    editDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const openAddProviderDialog = () => {
  addProviderForm.value = { name: '', apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true };
  addProviderDialog.value = true;
};

const handleAddProvider = async () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning('请输入供应商名称'); return; }
    const headersObj = {};
    (addProviderForm.value.headers || []).forEach(({ key, value }) => {
      if (key && key.trim()) headersObj[key.trim()] = value;
    });
    window.services.addCommonProvider({
      name,
      apiKey: addProviderForm.value.apiKey,
      baseUrl: addProviderForm.value.baseUrl,
      api: addProviderForm.value.api,
      headers: headersObj,
      authHeader: addProviderForm.value.authHeader,
    });
    MessagePlugin.success(`供应商 ${name} 已添加`);
    addProviderDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error('添加失败: ' + e.message);
  }
};

const handleDeleteProvider = async (providerName) => {
  try {
    window.services.deleteCommonProvider(providerName);
    MessagePlugin.success(`供应商 ${providerName} 已删除`);
    loadProviders();
  } catch (e) {
    MessagePlugin.error('删除失败: ' + e.message);
  }
};

const openAddModelDialog = (providerName) => {
  addModelProvider.value = providerName;
  addModelForm.value = { id: '', name: '', contextWindow: 0, maxTokens: 0, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: [] };
  autoModels.value = [];
  autoModelsLoading.value = false;
  autoModelsError.value = "";
  modelAdvancedOpen.value = false;
  addModelDialog.value = true;
  // 打开弹窗即自动拉取模型列表，无需手动点击
  handleAutoFetchModels();
};

const autoModels = ref([]);
const autoModelsLoading = ref(false);
const autoModelsError = ref("");

// ==================== 批量添加模型 ====================
const batchAddDialog = ref(false);
const batchAddProvider = ref(null);
const batchModels = ref([]);          // 拉取到的全部模型（含可选的 name/上下文等元信息）
const batchLoading = ref(false);
const batchError = ref("");
const batchSelected = ref([]);        // 勾选的模型 ID 列表（表格多选）
const batchEdits = ref({});           // 模型 ID → 行内编辑值 { input, contextWindow, maxTokens, reasoning }
const batchSubmitting = ref(false);
const batchFilter = ref('');          // 列表过滤关键字（模型 ID / 拉取名称）

const openBatchAddDialog = (providerName) => {
  batchAddProvider.value = providerName;
  batchModels.value = [];
  batchSelected.value = [];
  batchEdits.value = {};
  batchError.value = '';
  batchFilter.value = '';
  batchAddDialog.value = true;
  // 打开弹窗即自动拉取模型列表（与单个添加弹窗行为一致）
  fetchBatchModels();
};

const fetchBatchModels = async () => {
  const prov = providers.value.find(p => p.name === batchAddProvider.value);
  if (!prov || !prov.baseUrl) {
    batchError.value = '该供应商未配置 Base URL，无法自动获取';
    return;
  }
  batchLoading.value = true;
  batchError.value = '';
  try {
    const list = await window.services.fetchProviderModels(prov.baseUrl, prov.apiKey);
    batchModels.value = list;
    list.forEach(ensureBatchEdit);   // 预填充行内编辑值（优先拉取到的元信息）
    if (list.length === 0) batchError.value = '接口返回空列表';
  } catch (e) {
    batchError.value = e.message;
    batchModels.value = [];
  } finally {
    batchLoading.value = false;
  }
};

// 已存在于通用库中的模型 ID（勾选时预过滤，提示将被跳过）
const batchExistingIds = computed(() => {
  const prov = providers.value.find(p => p.name === batchAddProvider.value);
  return new Set((prov && prov.models || []).map(m => m.id));
});

const batchFilteredModels = computed(() => {
  const kw = batchFilter.value.trim().toLowerCase();
  if (!kw) return batchModels.value;
  return batchModels.value.filter(m =>
    m.id.toLowerCase().includes(kw) || (m.name || '').toLowerCase().includes(kw)
  );
});

const batchColumns = computed(() => [
  { colKey: 'row-select', type: 'multiple', width: 46 },
  { colKey: 'id', title: '模型 ID', ellipsis: true },
  { colKey: 'text', title: () => renderBatchColHeader('text', '文本'), width: 64 },
  { colKey: 'image', title: () => renderBatchColHeader('image', '图像'), width: 64 },
  { colKey: 'reasoning', title: () => renderBatchColHeader('reasoning', '思考'), width: 64 },
  { colKey: 'contextWindow', title: () => renderBatchHeaderSelect('contextWindow', batchCtxOptions.value, '上下文窗口'), width: 130 },
  { colKey: 'maxTokens', title: () => renderBatchHeaderSelect('maxTokens', batchTokensOptions.value, '最大输出'), width: 130 },
]);

const onBatchSelectChange = (keys) => {
  batchSelected.value = keys;
};

// 行内编辑值：优先用已有编辑，否则用拉取到的元信息，再否则默认值
const DEFAULT_BATCH_EDIT = () => ({ input: ['text'], contextWindow: 0, maxTokens: 0, reasoning: false });

const ensureBatchEdit = (m) => {
  if (batchEdits.value[m.id]) return;
  batchEdits.value[m.id] = {
    input: ['text'],
    contextWindow: m.contextWindow || 0,
    maxTokens: m.maxTokens || 0,
    reasoning: !!m.reasoning,
  };
};

const editOf = (row) => batchEdits.value[row.id] || DEFAULT_BATCH_EDIT();

const setBatchEdit = (row, key, value) => {
  ensureBatchEdit(row);
  batchEdits.value[row.id][key] = value;
};

// 文本输入 / 图像输入 / 思考 三列：单元格单复选框，表头复选框全选当前可见行
const hasBatchFlag = (m, flag) => {
  const e = editOf(m);
  return flag === 'reasoning' ? !!e.reasoning : e.input.includes(flag);
};

const setBatchFlag = (row, flag, checked) => {
  ensureBatchEdit(row);
  const e = batchEdits.value[row.id];
  if (flag === 'reasoning') { e.reasoning = !!checked; return; }
  const set = new Set(e.input);
  if (checked) set.add(flag); else set.delete(flag);
  e.input = Array.from(set);
};

const toggleBatchColAll = (flag, checked) => {
  batchFilteredModels.value.forEach(m => setBatchFlag(m, flag, checked));
};

// 表头默认只显示文字，hover 时才显示复选框（可全选/半选该列）
const renderBatchColHeader = (flag, label) => {
  const rows = batchFilteredModels.value;
  const checkedCount = rows.filter(m => hasBatchFlag(m, flag)).length;
  const all = rows.length > 0 && checkedCount === rows.length;
  return h('div', { class: 'common-batch-flag-header' }, [
    h(Checkbox, {
      modelValue: all,
      indeterminate: checkedCount > 0 && !all,
      class: 'common-batch-checkbox',
      title: `全选/取消全选「${label}」`,
      onChange: (checked) => toggleBatchColAll(flag, checked),
    }),
    h('span', { class: 'common-batch-flag-label' }, label),
  ]);
};

// 上下文窗口 / 最大输出表头下拉：选中值后批量应用到勾选行（未勾选则应用到当前可见行），表头不保留选中值
const applyBatchColumn = (key, value) => {
  const visible = batchFilteredModels.value;
  const targets = batchSelected.value.length > 0
    ? visible.filter(m => batchSelected.value.includes(m.id))
    : visible;
  if (targets.length === 0) return;
  targets.forEach(m => setBatchEdit(m, key, value));
  MessagePlugin.success(`已应用到 ${targets.length} 个模型`);
};

const renderBatchHeaderSelect = (key, options, placeholder) => h(Select, {
  modelValue: null,
  placeholder,
  size: 'small',
  options,
  class: 'common-batch-header-select',
  onChange: (v) => applyBatchColumn(key, v),
});

// 预设 + 拉取到的非标准值合并为下拉选项（避免选中项不在选项里）
const mergePresetOptions = (presets, values) => {
  const std = new Set(presets.map(o => o.value));
  const extra = values
    .filter(v => v && !std.has(v))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .sort((a, b) => a - b)
    .map(v => ({ label: formatNumber(v), value: v }));
  return [...presets, ...extra];
};

// 上下文窗口 / 最大输出下拉选项：标准预设 + 接口返回的非标准值自动补进选项不丢数据
const batchCtxOptions = computed(() =>
  mergePresetOptions(CTX_OPTIONS, batchModels.value.map(m => m.contextWindow))
);
const batchTokensOptions = computed(() =>
  mergePresetOptions(TOKENS_OPTIONS, batchModels.value.map(m => m.maxTokens))
);

const handleBatchAdd = async () => {
  if (batchSelected.value.length === 0) { MessagePlugin.warning('请先勾选要添加的模型'); return; }
  const models = batchSelected.value.map(id => {
    const fetched = batchModels.value.find(m => m.id === id) || {};
    const e = batchEdits.value[id] || {};
    return {
      id,
      name: fetched.name || id,
      contextWindow: Number(e.contextWindow) || 0,
      maxTokens: Number(e.maxTokens) || 0,
      reasoning: 'reasoning' in e ? !!e.reasoning : !!fetched.reasoning,
      input: e.input && e.input.length > 0 ? e.input : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {},
    };
  });
  batchSubmitting.value = true;
  try {
    const { added, skipped } = window.services.addCommonModels(batchAddProvider.value, models);
    if (added.length > 0) MessagePlugin.success(`已批量添加 ${added.length} 个模型`);
    if (skipped.length > 0) MessagePlugin.warning(`已自动跳过 ${skipped.length} 个重复模型：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}`);
    if (added.length > 0) {
      batchAddDialog.value = false;
      loadProviders();
    }
  } catch (e) {
    MessagePlugin.error('批量添加失败: ' + e.message);
  } finally {
    batchSubmitting.value = false;
  }
};

// AutoComplete 下拉选项（显示名 → 模型 ID）
const modelOptions = computed(() =>
  autoModels.value.map(m => ({ label: m.name || m.id, value: m.id }))
);

const handleAutoFetchModels = async () => {
  const prov = providers.value.find(p => p.name === addModelProvider.value);
  if (!prov || !prov.baseUrl) {
    autoModelsError.value = "该供应商未配置 Base URL，无法自动获取";
    return;
  }
  autoModelsLoading.value = true;
  autoModelsError.value = "";
  try {
    const list = await window.services.fetchProviderModels(prov.baseUrl, prov.apiKey);
    autoModels.value = list;
    if (list.length === 0) autoModelsError.value = "接口返回空列表";
  } catch (e) {
    autoModelsError.value = e.message;
    autoModels.value = [];
  } finally {
    autoModelsLoading.value = false;
  }
};

const applyAutoModel = (m) => {
  addModelForm.value = {
    ...addModelForm.value,
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.contextWindow || 0,
    maxTokens: m.maxTokens || 0,
    reasoning: !!m.reasoning,
  };
};

// 从下拉选中模型：自动带出名称/上下文/输出/推理
const onModelIdSelect = (val) => {
  const m = autoModels.value.find(x => x.id === val);
  if (m) applyAutoModel(m);
};

// 打开模型编辑弹窗
const openEditModelDialog = (provName, m) => {
  editModelProvider.value = provName;
  editingModelId.value = m.id;
  newModelId.value = m.id;
  editModelForm.value = {
    name: m.name || '',
    contextWindow: m.contextWindow || 0,
    maxTokens: m.maxTokens || 0,
    reasoning: !!m.reasoning,
    input: m.input || ['text'],
    cost: (m.cost && m.cost.input != null) ? { ...m.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: m.compat ? Object.entries(m.compat).map(([key, value]) => ({ key, value })) : [],
  };
  modelAdvancedOpen.value = false;
  editModelDialog.value = true;
};

const handleSaveModel = async () => {
  try {
    const compatObj = {};
    (editModelForm.value.compat || []).forEach(({ key, value }) => {
      if (key && key.trim()) compatObj[key.trim()] = value;
    });
    const finalId = newModelId.value.trim() || editingModelId.value;
    // ID 有变化：删除旧模型，添加新模型
    if (finalId !== editingModelId.value) {
      const okDel = window.services.deleteCommonModel(editModelProvider.value, editingModelId.value);
      if (!okDel) throw new Error('写入通用库失败，请重试');
      const okAdd = window.services.addCommonModel(editModelProvider.value, {
        id: finalId,
        name: editModelForm.value.name.trim() || finalId,
        contextWindow: Number(editModelForm.value.contextWindow) || 0,
        maxTokens: Number(editModelForm.value.maxTokens) || 0,
        reasoning: editModelForm.value.reasoning,
        input: editModelForm.value.input,
        cost: editModelForm.value.cost,
        compat: compatObj,
      });
      if (!okAdd) throw new Error('写入通用库失败，请重试');
    } else {
      const ok = window.services.updateCommonModel(editModelProvider.value, editingModelId.value, {
        name: editModelForm.value.name.trim() || editingModelId.value,
        contextWindow: Number(editModelForm.value.contextWindow) || 0,
        maxTokens: Number(editModelForm.value.maxTokens) || 0,
        reasoning: editModelForm.value.reasoning,
        input: editModelForm.value.input,
        cost: editModelForm.value.cost,
        compat: compatObj,
      });
      if (!ok) throw new Error('写入通用库失败，请重试');
    }
    MessagePlugin.success('模型已更新');
    editModelDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error('保存失败: ' + e.message);
  }
};

const handleAddModel = async () => {
  try {
    const id = addModelForm.value.id.trim();
    if (!id) { MessagePlugin.warning('请输入模型 ID'); return; }
    const compatObj = {};
    (addModelForm.value.compat || []).forEach(({ key, value }) => {
      if (key && key.trim()) compatObj[key.trim()] = value;
    });
    const ok = window.services.addCommonModel(addModelProvider.value, {
      id,
      name: addModelForm.value.name.trim() || id,
      contextWindow: Number(addModelForm.value.contextWindow) || 0,
      maxTokens: Number(addModelForm.value.maxTokens) || 0,
      reasoning: addModelForm.value.reasoning,
      input: addModelForm.value.input,
      cost: addModelForm.value.cost,
      compat: compatObj,
    });
    if (!ok) throw new Error('写入通用库失败，请重试');
    MessagePlugin.success(`模型 ${id} 已添加`);
    addModelDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error('添加失败: ' + e.message);
  }
};

const handleDeleteModel = async (providerName, modelId) => {
  try {
    const ok = window.services.deleteCommonModel(providerName, modelId);
    if (!ok) throw new Error('写入通用库失败，请重试');
    MessagePlugin.success(`模型 ${modelId} 已删除`);
    loadProviders();
  } catch (e) {
    MessagePlugin.error('删除失败: ' + e.message);
  }
};

// ==================== 下发到 Agent（主数据 → 各 agent 模型配置） ====================

const AGENT_DISPATCH_OPTIONS = [
  { label: "Claude Code", value: "claude" },
  { label: "OpenCode CLI", value: "opencode" },
  { label: "Pi Agent", value: "pi" },
  { label: "omp", value: "omp" },
  { label: "Reasonix", value: "reasonix" },
  { label: "Codex", value: "codex" },
  { label: "Kimi Code", value: "kimi" },
  { label: "MiniMax Code", value: "minimax" },
];

// 供应商 + 模型合并为一个级联选择器：按供应商分组，value 用 "供应商::模型ID" 区分同名；
// 父级（供应商）选中时下发该供应商全部模型
const dispatchDialog = ref(false);
const dispatchSubmitting = ref(false);
const dispatchModelKeys = ref([]);
const dispatchTargets = ref([]);

const dispatchCascaderOptions = computed(() =>
  providers.value.map(p => ({
    label: p.name,
    value: p.name,
    children: (p.models || []).map(m => ({
      label: `${m.name || m.id}${m.contextWindow ? `（${formatNumber(m.contextWindow)} ctx）` : ""}`,
      value: `${p.name}::${m.id}`,
    })),
  }))
);

// Claude Code 仅支持 Anthropic Messages 协议：所选供应商全部非该协议时禁用 Claude 目标
const claudeDispatchDisabled = computed(() => {
  const names = new Set(dispatchModelKeys.value.map((k) => k.split("::")[0]));
  const selected = providers.value.filter((p) => names.has(p.name));
  return (
    selected.length > 0 &&
    !selected.some((p) => (p.api || "openai-completions") === "anthropic-messages")
  );
});
watch(claudeDispatchDisabled, (disabled) => {
  if (disabled) dispatchTargets.value = dispatchTargets.value.filter((t) => t !== "claude");
});

// Codex 仅支持 OpenAI 系协议（wire_api chat/responses）：所选供应商全部非该协议时禁用 Codex 目标
const codexDispatchDisabled = computed(() => {
  const names = new Set(dispatchModelKeys.value.map((k) => k.split("::")[0]));
  const selected = providers.value.filter((p) => names.has(p.name));
  return (
    selected.length > 0 &&
    !selected.some((p) =>
      ["openai-completions", "openai-responses"].includes(p.api || "openai-completions")
    )
  );
});
watch(codexDispatchDisabled, (disabled) => {
  if (disabled) dispatchTargets.value = dispatchTargets.value.filter((t) => t !== "codex");
});

// MiniMax Code 支持 OpenAI Chat / Responses / Anthropic Messages（与通用库协议同名）：所选供应商全部不适用时禁用
const minimaxDispatchDisabled = computed(() => {
  const names = new Set(dispatchModelKeys.value.map((k) => k.split("::")[0]));
  const selected = providers.value.filter((p) => names.has(p.name));
  return (
    selected.length > 0 &&
    !selected.some((p) =>
      ["openai-completions", "openai-responses", "anthropic-messages"].includes(p.api || "openai-completions")
    )
  );
});
watch(minimaxDispatchDisabled, (disabled) => {
  if (disabled) dispatchTargets.value = dispatchTargets.value.filter((t) => t !== "minimax");
});

const openDispatchDialog = (providerName = "", modelId = "") => {
  dispatchModelKeys.value = providerName && modelId ? [`${providerName}::${modelId}`] : [];
  dispatchTargets.value = [];
  dispatchDialog.value = true;
};

const handleDispatch = async () => {
  if (dispatchModelKeys.value.length === 0) return MessagePlugin.warning("请选择供应商与模型");
  if (dispatchTargets.value.length === 0) return MessagePlugin.warning("请选择目标 agent");
  const targets = dispatchTargets.value.map(app => ({ app }));
  dispatchSubmitting.value = true;
  try {
    const allResults = [];
    const combos = [];
    for (const key of dispatchModelKeys.value) {
      const [pName, mId] = key.split("::");
      const provider = providers.value.find(p => p.name === pName);
      if (!provider) continue;
      if (mId) {
        const model = provider.models.find(m => m.id === mId);
        if (model) combos.push([provider, model]);
      } else {
        // 选中父级（整个供应商）：下发其全部模型
        provider.models.forEach(m => combos.push([provider, m]));
      }
    }
    for (const [provider, model] of combos) {
      const results = await window.services.dispatchCommonModel(provider, model, targets);
      allResults.push(...results);
    }
    // 按 agent 聚合结果展示
    const byApp = {};
    allResults.forEach(r => {
      if (!byApp[r.app]) byApp[r.app] = { ok: 0, fail: 0, err: "" };
      if (r.ok) byApp[r.app].ok++;
      else { byApp[r.app].fail++; if (!byApp[r.app].err) byApp[r.app].err = r.message; }
    });
    const totalOk = allResults.filter(r => r.ok).length;
    const total = allResults.length;
    Object.entries(byApp).forEach(([app, s]) => {
      const label = (AGENT_DISPATCH_OPTIONS.find(o => o.value === app) || {}).label || app;
      if (s.fail === 0) MessagePlugin.success(`${label}: ${s.ok} 个模型下发成功`);
      else MessagePlugin.warning(`${label}: ${s.ok} 成功 / ${s.fail} 失败（${s.err}）`);
    });
    dispatchDialog.value = false;
    if (totalOk === total) MessagePlugin.success(`下发完成：${totalOk}/${total} 成功`);
    else if (totalOk > 0) MessagePlugin.warning(`下发完成：${totalOk}/${total} 成功，部分失败`);
    else MessagePlugin.error(`下发失败：${total} 个目标全部失败`);
  } catch (e) {
    MessagePlugin.error("下发失败: " + e.message);
  } finally {
    dispatchSubmitting.value = false;
  }
};

const formatNumber = (n) => {
  if (!n) return '默认';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
};

const refresh = () => {
  loading.value = true;
  setTimeout(() => { loadProviders(); loading.value = false; }, 50);
};

onMounted(refresh);
</script>

<template>
  <div class="common-config-container">
    <div class="common-config-header">
      <span class="common-config-tip">
        通用供应商与模型库（存 uTools DB）— 维护一份主数据，后续可下发到各 agent
      </span>
      <div class="common-config-actions">
        <Tooltip content="把通用库的供应商与模型写入各 agent 的模型配置" placement="top">
          <Button size="small" variant="outline" @click="openDispatchDialog()">
            <template #icon><SendIcon /></template> 下发到 Agent
          </Button>
        </Tooltip>
        <Tooltip content="添加供应商" placement="top">
          <Button size="small" variant="outline" @click="openAddProviderDialog">
            <template #icon><AddIcon /></template> 添加供应商
          </Button>
        </Tooltip>
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="providers.length === 0" class="common-config-empty">
      <Empty description="通用库中还没有供应商，点击右上角「添加供应商」开始维护主数据" />
    </div>

    <div v-else class="common-provider-list">
      <Collapse v-model="expandedList" class="common-provider-collapse">
        <CollapsePanel
          v-for="prov in providers"
          :key="prov.name"
          :value="prov.name"
        >
          <template #header>
            <div class="common-provider-header-left">
              <span class="common-provider-name">{{ prov.name }}</span>
              <Tag size="small" variant="outline">{{ prov.api || 'openai-completions' }}</Tag>
            </div>
          </template>
          <template #headerRightContent>
            <div class="common-provider-header-right" @click.stop>
              <span class="common-model-count">{{ prov.models.length }} 个模型</span>
              <Space size="small">
                <Tooltip content="编辑配置" placement="top">
                  <Button size="small" variant="text" @click="handleEdit(prov)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm content="确定删除此供应商？其下所有模型也会被删除。" @confirm="handleDeleteProvider(prov.name)">
                  <Button size="small" variant="text" theme="danger">
                    <template #icon><DeleteIcon /></template>
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </template>

          <template #content>
          <div class="common-provider-info">
            <div class="common-info-row">
              <span class="common-info-label">API Key</span>
              <span class="common-info-value mono">{{ prov.apiKey ? prov.apiKey.slice(0, 8) + '...' + prov.apiKey.slice(-4) : '未设置' }}</span>
            </div>
            <div class="common-info-row">
              <span class="common-info-label">Base URL</span>
              <span class="common-info-value mono">{{ prov.baseUrl || '默认' }}</span>
            </div>
          </div>

          <div class="common-models-section">
            <div class="common-models-title">
              <span>模型列表</span>
              <Space size="small">
                <Button size="small" variant="text" @click="openAddModelDialog(prov.name)">
                  <template #icon><AddIcon /></template> 添加模型
                </Button>
                <Button size="small" variant="text" @click="openBatchAddDialog(prov.name)">
                  <template #icon><AddIcon /></template> 批量添加
                </Button>
              </Space>
            </div>
            <div class="common-model-item" v-for="m in prov.models" :key="m.id">
              <div class="common-model-info">
                <span class="common-model-name">{{ m.name || m.id }}</span>
                <Tag v-if="m.reasoning" size="small" theme="warning" variant="light">推理</Tag>
              </div>
              <div class="common-model-meta">
                <span class="common-model-stat">上下文: {{ formatNumber(m.contextWindow) }}</span>
                <span class="common-model-stat">最大输出: {{ formatNumber(m.maxTokens) }}</span>
                <span v-if="m.input && m.input.includes('image')" class="common-model-stat">图像</span>
                <span v-if="m.cost && m.cost.input != null" class="common-model-stat">
                  费用: ¥{{ m.cost.input }}/1M in · ¥{{ m.cost.output }}/1M out
                </span>
              </div>
              <div class="common-model-actions" @click.stop>
                <Tooltip content="下发到 Agent" placement="top">
                  <Button size="small" variant="text" @click="openDispatchDialog(prov.name, m.id)">
                    <template #icon><SendIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip content="编辑模型" placement="top">
                  <Button size="small" variant="text" @click="openEditModelDialog(prov.name, m)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm content="确定删除此模型？" @confirm="handleDeleteModel(prov.name, m.id)">
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

    <Dialog
      v-model:visible="editDialog"
      header="编辑供应商配置"
      width="480px"
      :confirm-btn="{ content: '保存', theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>供应商名称</label>
          <Input v-model="newProviderName" placeholder="供应商名称" />
        </div>
        <div class="common-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" placeholder="留空则使用默认 URL" />
        </div>
        <div class="common-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" placeholder="输入 API Key" />
        </div>
        <div class="common-form-item">
          <label>API 类型</label>
          <Select v-model="editForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="common-form-item">
          <label>自动添加 Authorization 头</label>
          <Switch v-model="editForm.authHeader" />
        </div>
        <div class="common-form-item">
          <label>自定义请求头 (headers)</label>
          <DynamicKvEditor
            v-model="editForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            key-placeholder="Header 名"
            value-placeholder="Header 值"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="addProviderDialog"
      header="添加供应商"
      width="480px"
      :confirm-btn="{ content: '添加', theme: 'primary' }"
      @confirm="handleAddProvider"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>供应商名称 <span class="common-form-required">*</span></label>
          <Input v-model="addProviderForm.name" placeholder="例如：openai、deepseek、zhipu" />
        </div>
        <div class="common-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" placeholder="留空使用供应商默认 URL" />
        </div>
        <div class="common-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" placeholder="输入 API Key（可留空后续再填）" />
        </div>
        <div class="common-form-item">
          <label>API 类型</label>
          <Select v-model="addProviderForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="common-form-item">
          <label>自动添加 Authorization 头</label>
          <Switch v-model="addProviderForm.authHeader" />
        </div>
        <div class="common-form-item">
          <label>自定义请求头 (headers)</label>
          <DynamicKvEditor
            v-model="addProviderForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            key-placeholder="Header 名"
            value-placeholder="Header 值"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="addModelDialog"
      header="添加模型"
      width="520px"
      :confirm-btn="{ content: '添加', theme: 'primary' }"
      @confirm="handleAddModel"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>所属供应商</label>
          <div class="common-edit-provider-name">{{ addModelProvider }}</div>
        </div>

        <!-- 模型 ID：AutoComplete，弹窗打开时已自动拉取模型列表 -->
        <div class="common-form-item">
          <label>模型 ID <span class="common-form-required">*</span></label>
          <AutoComplete
            v-model="addModelForm.id"
            :options="modelOptions"
            :loading="autoModelsLoading"
            filterable
            clearable
            placeholder="输入或从下拉选择模型"
            :popup-props="{ overlayStyle: { maxHeight: '280px', overflowY: 'auto' } }"
            @select="onModelIdSelect"
          />
          <div v-if="autoModelsLoading" class="common-form-hint">正在自动拉取模型列表…</div>
          <div v-else-if="autoModelsError" class="common-form-hint common-fetch-error">
            自动获取失败：{{ autoModelsError }}
            <span class="common-fetch-retry" @click="handleAutoFetchModels">重试</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="common-form-hint">
            已自动获取 {{ autoModels.length }} 个模型，选中后自动填充名称/上下文等
          </div>
        </div>
        <div class="common-form-item">
          <label>显示名称</label>
          <Input v-model="addModelForm.name" placeholder="留空则使用模型 ID" />
        </div>
        <div class="common-form-item">
          <label>输入类型</label>
          <Space size="16px" align="center" wrap>
            <CheckboxGroup v-model="addModelForm.input" class="common-checkbox-group">
              <Checkbox v-for="opt in INPUT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
            </CheckboxGroup>
            <Checkbox v-model="addModelForm.reasoning" class="common-reasoning-checkbox">推理模型</Checkbox>
          </Space>
        </div>
        <div class="common-form-item">
          <label>上下文窗口</label>
          <PresetCustomInput
            v-model="addModelForm.contextWindow"
            :options="CTX_OPTIONS"
            :step="1000"
            :default-custom="128000"
          />
        </div>
        <div class="common-form-item">
          <label>最大输出</label>
          <PresetCustomInput
            v-model="addModelForm.maxTokens"
            :options="TOKENS_OPTIONS"
            :step="1000"
            :default-custom="16384"
          />
        </div>
        <Collapse v-model="modelAdvancedOpen" class="common-advanced-collapse">
          <CollapsePanel value="1" header="高级配置（费用 / 兼容性）">
            <div class="common-form-item">
              <label>费用 (cost) — 每百万 Token</label>
              <div class="common-form-row">
                <div class="common-form-item">
                  <label>输入</label>
                  <InputNumber v-model="addModelForm.cost.input" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="common-form-item">
                  <label>输出</label>
                  <InputNumber v-model="addModelForm.cost.output" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
              <div class="common-form-row">
                <div class="common-form-item">
                  <label>缓存读取</label>
                  <InputNumber v-model="addModelForm.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="common-form-item">
                  <label>缓存写入</label>
                  <InputNumber v-model="addModelForm.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
            </div>
            <div class="common-form-item">
              <label>兼容性 (compat)</label>
              <DynamicKvEditor
                v-model="addModelForm.compat"
                :key-options="COMPAT_KEY_OPTIONS"
                key-placeholder="compat 字段名"
                value-placeholder="compat 值"
              />
            </div>
          </CollapsePanel>
        </Collapse>
      </div>
    </Dialog>

    <!-- 批量添加模型弹窗：拉取全部模型 → 勾选 → 统一配置 → 一次性写入（重复 ID 自动跳过） -->
    <Dialog
      v-model:visible="batchAddDialog"
      :header="`批量添加模型${batchAddProvider ? ' — ' + batchAddProvider : ''}`"
      width="780px"
      dialog-class-name="common-batch-dialog"
      :confirm-btn="{ content: `添加 ${batchSelected.length} 个`, theme: 'primary', loading: batchSubmitting, disabled: batchSelected.length === 0 }"
      @confirm="handleBatchAdd"
    >
      <div class="common-edit-form common-batch-form">
        <div class="common-batch-toolbar">
          <Input
            v-model="batchFilter"
            size="small"
            clearable
            placeholder="过滤模型 ID / 名称"
            class="common-batch-filter"
          />
          <Button size="small" variant="outline" :loading="batchLoading" @click="fetchBatchModels">
            <template #icon><RefreshIcon /></template> 刷新
          </Button>
          <span class="common-batch-count">
            已选 {{ batchSelected.length }} / {{ batchModels.length }} 个
          </span>
        </div>

        <div v-if="batchLoading" class="common-form-hint">正在自动拉取模型列表…</div>
        <div v-else-if="batchError" class="common-form-hint common-fetch-error">
          自动获取失败：{{ batchError }}
          <span class="common-fetch-retry" @click="fetchBatchModels">重试</span>
        </div>
        <Table
          v-else-if="batchModels.length > 0"
          :data="batchFilteredModels"
          :columns="batchColumns"
          row-key="id"
          size="small"
          class="common-batch-table"
          :max-height="320"
          :selected-row-keys="batchSelected"
          @select-change="onBatchSelectChange"
        >
          <template #id="{ row }">
            <div class="common-batch-id-cell">
              <span v-if="batchExistingIds.has(row.id)" class="common-batch-exist-dot" title="已存在，将自动跳过"></span>
              <span class="common-batch-item-id">{{ row.id }}</span>
            </div>
          </template>
          <template #text="{ row }">
            <Checkbox
              class="common-batch-checkbox"
              :model-value="editOf(row).input.includes('text')"
              @change="(c) => setBatchFlag(row, 'text', c)"
            />
          </template>
          <template #image="{ row }">
            <Checkbox
              class="common-batch-checkbox"
              :model-value="editOf(row).input.includes('image')"
              @change="(c) => setBatchFlag(row, 'image', c)"
            />
          </template>
          <template #reasoning="{ row }">
            <Checkbox
              class="common-batch-checkbox"
              :model-value="!!editOf(row).reasoning"
              @change="(c) => setBatchFlag(row, 'reasoning', c)"
            />
          </template>
          <template #contextWindow="{ row }">
            <Select
              :model-value="editOf(row).contextWindow"
              size="small"
              :options="batchCtxOptions"
              filterable
              @change="(v) => setBatchEdit(row, 'contextWindow', v)"
            />
          </template>
          <template #maxTokens="{ row }">
            <Select
              :model-value="editOf(row).maxTokens"
              size="small"
              :options="batchTokensOptions"
              filterable
              @change="(v) => setBatchEdit(row, 'maxTokens', v)"
            />
          </template>
        </Table>
        <div v-else class="common-form-hint">暂无模型</div>

        <div class="common-form-hint">表头复选框可全选该列；上下文窗口 / 最大输出的表头下拉可批量应用到勾选行（未勾选则应用到可见行）；模型 ID 重复的会自动过滤不添加。</div>
      </div>
    </Dialog>

    <!-- 模型编辑弹窗 -->
    <Dialog
      v-model:visible="editModelDialog"
      header="编辑模型"
      width="480px"
      :confirm-btn="{ content: '保存', theme: 'primary' }"
      @confirm="handleSaveModel"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>模型 ID</label>
          <Input v-model="newModelId" placeholder="模型 ID" />
        </div>
        <div class="common-form-item">
          <label>显示名称</label>
          <Input v-model="editModelForm.name" placeholder="显示名称" />
        </div>
        <div class="common-form-item">
          <label>输入类型</label>
          <Space size="16px" align="center" wrap>
            <CheckboxGroup v-model="editModelForm.input" class="common-checkbox-group">
              <Checkbox v-for="opt in INPUT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
            </CheckboxGroup>
            <Checkbox v-model="editModelForm.reasoning" class="common-reasoning-checkbox">推理模型</Checkbox>
          </Space>
        </div>
        <div class="common-form-item">
          <label>上下文窗口</label>
          <PresetCustomInput
            v-model="editModelForm.contextWindow"
            :options="CTX_OPTIONS"
            :step="1000"
            :default-custom="128000"
          />
        </div>
        <div class="common-form-item">
          <label>最大输出</label>
          <PresetCustomInput
            v-model="editModelForm.maxTokens"
            :options="TOKENS_OPTIONS"
            :step="1000"
            :default-custom="16384"
          />
        </div>
        <Collapse v-model="modelAdvancedOpen" class="common-advanced-collapse">
          <CollapsePanel value="1" header="高级配置（费用 / 兼容性）">
            <div class="common-form-item">
              <label>费用 (cost) — 每百万 Token</label>
              <div class="common-form-row">
                <div class="common-form-item">
                  <label>输入</label>
                  <InputNumber v-model="editModelForm.cost.input" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="common-form-item">
                  <label>输出</label>
                  <InputNumber v-model="editModelForm.cost.output" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
              <div class="common-form-row">
                <div class="common-form-item">
                  <label>缓存读取</label>
                  <InputNumber v-model="editModelForm.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="common-form-item">
                  <label>缓存写入</label>
                  <InputNumber v-model="editModelForm.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
            </div>
            <div class="common-form-item">
              <label>兼容性 (compat)</label>
              <DynamicKvEditor
                v-model="editModelForm.compat"
                :key-options="COMPAT_KEY_OPTIONS"
                key-placeholder="compat 字段名"
                value-placeholder="compat 值"
              />
            </div>
          </CollapsePanel>
        </Collapse>
      </div>
    </Dialog>

    <!-- 下发到 Agent 弹窗：选中主数据 provider + model，写入 6 个 agent 的模型配置 -->
    <Dialog
      v-model:visible="dispatchDialog"
      header="下发模型到 Agent"
      width="560px"
      :confirm-btn="{ content: '下发', theme: 'primary', loading: dispatchSubmitting }"
      @confirm="handleDispatch"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>供应商与模型 <span class="common-form-required">*</span></label>
          <Cascader
            v-model="dispatchModelKeys"
            :options="dispatchCascaderOptions"
            multiple
            filterable
            clearable
            placeholder="选择供应商与模型（可多选，勾选供应商 = 全选其模型）"
            :popup-props="{ overlayClassName: 'common-dispatch-select-popup' }"
          />
        </div>
        <div class="common-form-item">
          <label>目标 Agent <span class="common-form-required">*</span></label>
          <CheckboxGroup v-model="dispatchTargets" class="common-dispatch-agents">
            <label v-for="opt in AGENT_DISPATCH_OPTIONS" :key="opt.value" class="common-dispatch-agent">
              <Tooltip v-if="opt.value === 'claude'" content="仅 Anthropic Messages 协议的供应商可下发 Claude Code">
                <Checkbox :value="opt.value" :disabled="claudeDispatchDisabled" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
              </Tooltip>
              <Tooltip v-else-if="opt.value === 'codex'" content="仅 OpenAI Chat / Responses 协议的供应商可下发 Codex">
                <Checkbox :value="opt.value" :disabled="codexDispatchDisabled" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
              </Tooltip>
              <Tooltip v-else-if="opt.value === 'minimax'" content="仅 OpenAI Chat / Responses / Anthropic Messages 协议的供应商可下发 MiniMax Code；中文供应商名会自动清洗为 ASCII 供应商键">
                <Checkbox :value="opt.value" :disabled="minimaxDispatchDisabled" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
              </Tooltip>
              <Checkbox v-else :value="opt.value" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
            </label>
          </CheckboxGroup>
          <div class="common-form-hint">Claude → 写入 uTools DB 配置（Claude 配置页可见）；OpenCode → opencode.json；Pi → models.json；omp → models.yml；Reasonix → config.toml；Codex → ~/.codex/config.toml；Kimi → ~/.kimi-code/config.toml（别名 供应商/模型ID）；MiniMax Code → ~/.minimax/config.yaml（custom_provider，键名自动 ASCII 化）</div>
        </div>
      </div>
    </Dialog>
  </div>
</template>
