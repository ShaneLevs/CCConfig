<script setup>
import { ref, computed, onMounted } from "vue";
import {
  Card, Empty, Button, Tag, Space, Tooltip, Dialog, Input, InputNumber, Textarea, MessagePlugin,
  Select, Switch, CheckboxGroup, Checkbox, Collapse, CollapsePanel, Popconfirm, Alert as TAlert,
  Dropdown, AutoComplete,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, FolderOpen1Icon, AddIcon, DeleteIcon,
} from "tdesign-icons-vue-next";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import "./styles/ConfigView.css";

// ==================== Constants ====================

// 模型角色场景（固定顺序）
const ROLE_ORDER = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"];
const ROLE_LABELS = {
  default: "默认",
  smol: "快速",
  slow: "深度",
  vision: "视觉",
  plan: "规划",
  designer: "设计",
  commit: "提交",
  tiny: "微小",
  task: "任务",
  advisor: "顾问",
};

// 思考级别顺序（小 → 大）
const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];

// 供应商 API 类型
const API_TYPE_OPTIONS = [
  { label: "OpenAI Chat Completions", value: "openai-completions" },
  { label: "OpenAI Responses", value: "openai-responses" },
  { label: "Anthropic Messages", value: "anthropic-messages" },
  { label: "Google Generative AI", value: "google-generative-ai" },
];

const INPUT_TYPE_OPTIONS = [
  { label: "文本 (text)", value: "text" },
  { label: "图像 (image)", value: "image" },
];

const HEADER_KEY_OPTIONS = ["x-portkey-api-key", "x-api-key", "Authorization", "x-secret"];

const THINKING_MODE_OPTIONS = [
  { label: "effort", value: "effort" },
  { label: "auto", value: "auto" },
];

const emptyThinking = () => ({ minLevel: "", maxLevel: "", mode: "" });

// 表单已管理的模型字段（不在 YAML 文本框里展示）
const MODEL_FORM_KEYS = ["id", "name", "contextWindow", "maxTokens", "reasoning", "input", "thinking", "cost"];

// compat 等参数用 YAML 文本编辑（子级 4 空格缩进，照搬 models.yml 写法）
const dumpYaml = (obj) => {
  if (obj == null) return "";
  try { return yamlDump(obj, { indent: 4 }).replace(/\n$/, ""); } catch { return ""; }
};
const parseYaml = (str) => {
  const t = (str ?? "").trim();
  if (!t) return {};
  try {
    const result = yamlLoad(t);
    // 必须是普通对象（映射）；标量/数组展开成 `...other` 会产生数字键垃圾
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    return result;
  } catch { return null; }
};

// 提取模型对象中表单未管理的字段（compat 及自定义同级参数）
const dumpOtherFields = (model) => {
  if (!model || typeof model !== "object") return "";
  const rest = {};
  for (const [k, v] of Object.entries(model)) {
    if (MODEL_FORM_KEYS.includes(k)) continue;
    // 跳过空值：undefined/null/''/空对象/空数组（避免显示 compat: {}）
    if (v == null) continue;
    if (typeof v === "object" && Object.keys(v).length === 0) continue;
    rest[k] = v;
  }
  if (!Object.keys(rest).length) return "";
  return dumpYaml(rest);
};

// ==================== State ====================

const loading = ref(false);
const warningMsg = ref("");
const modelRoles = ref({});
const providers = ref([]);
const expandedList = ref([]);

// 角色弹窗
const roleDialog = ref(false);
const editingRole = ref("");
const roleForm = ref({ provider: "", modelId: "", level: "" });

// 供应商弹窗
const editDialog = ref(false);
const editingProvider = ref(null);
const editForm = ref({ apiKey: "", baseUrl: "", api: "openai-completions", headers: [], authHeader: true });
const addProviderDialog = ref(false);
const addProviderForm = ref({ name: "", apiKey: "", baseUrl: "", api: "openai-completions", headers: [], authHeader: true });

// 模型弹窗
const addModelDialog = ref(false);
const addModelProvider = ref(null);
const addModelForm = ref({ id: "", name: "", contextWindow: 0, maxTokens: 0, reasoning: false, input: ["text"], thinking: emptyThinking(), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, otherYaml: "" });
const editModelDialog = ref(false);
const editModelProvider = ref(null);
const editingModelId = ref(null);
const newModelId = ref("");
const editModelForm = ref({ name: "", contextWindow: 0, maxTokens: 0, reasoning: false, input: ["text"], thinking: emptyThinking(), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, otherYaml: "" });
const modelAdvancedOpen = ref(false);

const autoModels = ref([]);
const autoModelsLoading = ref(false);
const autoModelsError = ref("");

// AutoComplete 下拉选项（显示名 → 模型 ID）
const modelOptions = computed(() =>
  autoModels.value.map(m => ({ label: m.name || m.id, value: m.id }))
);

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    modelRoles.value = window.services.readOmpModelRoles() || {};
    providers.value = window.services.getOmpProviderList();
  } catch (e) {
    console.error("加载 omp 配置失败:", e);
    warningMsg.value = e.message || "加载失败";
  } finally {
    loading.value = false;
  }
};

// ==================== 模型角色 ====================

const parseRef = (ref) => {
  if (!ref) return null;
  try { return window.services.parseOmpModelRef(ref); } catch { return null; }
};

const findModelProvider = (modelId) => {
  for (const p of providers.value) {
    if (p.models.some(m => m.id === modelId)) return p;
  }
  return null;
};

const findModelById = (providerName, modelId) => {
  const prov = providers.value.find(p => p.name === providerName);
  return prov?.models.find(m => m.id === modelId) || null;
};

// 只展示已配置的角色，未配置的通过「添加角色」入口配置
const configuredRoles = computed(() => ROLE_ORDER.filter(r => modelRoles.value[r]));
const unconfiguredRoles = computed(() => ROLE_ORDER.filter(r => !modelRoles.value[r]));

// 解析角色引用为可展示信息（无前缀引用补全供应商）
const getRoleDisplay = (role) => {
  const ref = modelRoles.value[role];
  if (!ref) return null;
  const parsed = parseRef(ref);
  if (!parsed) return null;
  let provider = parsed.provider;
  if (!provider) {
    const found = findModelProvider(parsed.model);
    if (found) provider = found.name;
  }
  const modelObj = provider ? findModelById(provider, parsed.model) : null;
  return {
    ref,
    provider,
    model: parsed.model,
    modelName: modelObj?.name || parsed.model,
    level: parsed.level,
  };
};

const roleDisplays = computed(() => {
  const map = {};
  for (const role of configuredRoles.value) {
    map[role] = getRoleDisplay(role);
  }
  return map;
});

const onAddRole = (data) => {
  const role = typeof data === "object" ? data.value : data;
  openRoleDialog(role);
};

const openRoleDialog = (role) => {
  editingRole.value = role;
  const ref = modelRoles.value[role];
  const parsed = parseRef(ref);
  let provider = parsed?.provider || "";
  let modelId = parsed?.model || "";
  // 无前缀引用：尝试匹配到具体供应商
  if (parsed && !parsed.provider) {
    const found = findModelProvider(parsed.model);
    if (found) { provider = found.name; modelId = parsed.model; }
  }
  if (!provider && providers.value.length) provider = providers.value[0].name;
  roleForm.value = { provider, modelId, level: parsed?.level || "" };
  roleDialog.value = true;
};

const roleModelOptions = computed(() => {
  const prov = providers.value.find(p => p.name === roleForm.value.provider);
  return (prov?.models || []).map(m => ({ label: m.name || m.id, value: m.id }));
});

const roleLevelOptions = computed(() => {
  const prov = providers.value.find(p => p.name === roleForm.value.provider);
  const model = prov?.models.find(m => m.id === roleForm.value.modelId);
  const opts = [{ label: "默认（不指定）", value: "" }];
  if (!model?.thinking?.minLevel || !model?.thinking?.maxLevel) return opts;
  const start = LEVEL_ORDER.indexOf(model.thinking.minLevel);
  const end = LEVEL_ORDER.indexOf(model.thinking.maxLevel);
  if (start === -1 || end === -1) return opts;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  for (let i = lo; i <= hi; i++) opts.push({ label: LEVEL_ORDER[i], value: LEVEL_ORDER[i] });
  return opts;
});

const onRoleProviderChange = () => {
  roleForm.value.modelId = "";
  roleForm.value.level = "";
};

const saveRole = () => {
  try {
    const { provider, modelId, level } = roleForm.value;
    if (!provider || !modelId) { MessagePlugin.warning("请选择供应商和模型"); return; }
    const ref = `${provider}/${modelId}` + (level ? `:${level}` : "");
    const next = { ...modelRoles.value, [editingRole.value]: ref };
    window.services.writeOmpModelRoles(next);
    modelRoles.value = next;
    MessagePlugin.success(`已设置 ${editingRole.value} = ${ref}`);
    roleDialog.value = false;
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteRole = (role) => {
  try {
    const next = { ...modelRoles.value };
    delete next[role];
    window.services.writeOmpModelRoles(next);
    modelRoles.value = next;
    MessagePlugin.success(`已删除角色 ${role}`);
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

// ==================== 供应商 CRUD ====================

const handleEdit = (provider) => {
  editingProvider.value = provider.name;
  editForm.value = {
    apiKey: provider.apiKey || "",
    baseUrl: provider.baseUrl || "",
    api: provider.api || "openai-completions",
    headers: provider.headers ? Object.entries(provider.headers).map(([key, value]) => ({ key, value })) : [],
    authHeader: provider.authHeader !== undefined ? provider.authHeader : true,
  };
  editDialog.value = true;
};

const buildProviderPayload = (form) => {
  const headersObj = {};
  (form.headers || []).forEach(({ key, value }) => {
    if (key && key.trim()) headersObj[key.trim()] = value;
  });
  return {
    apiKey: form.apiKey,
    baseUrl: form.baseUrl,
    api: form.api,
    headers: headersObj,
    authHeader: form.authHeader,
  };
};

const handleSaveProvider = () => {
  try {
    const payload = buildProviderPayload(editForm.value);
    // 供应商名称是 providers 的唯一 key，不允许重命名
    window.services.updateOmpProvider(editingProvider.value, payload);
    MessagePlugin.success("供应商配置已更新");
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const openAddProviderDialog = () => {
  addProviderForm.value = { name: "", apiKey: "", baseUrl: "", api: "openai-completions", headers: [], authHeader: true };
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning("请输入供应商名称"); return; }
    window.services.addOmpProvider(name, buildProviderPayload(addProviderForm.value));
    MessagePlugin.success(`供应商 ${name} 已添加`);
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const handleDeleteProvider = (providerName) => {
  try {
    window.services.deleteOmpProvider(providerName);
    MessagePlugin.success(`供应商 ${providerName} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

// ==================== 模型 CRUD ====================

const buildModelPayload = (form, fallbackId) => {
  const other = parseYaml(form.otherYaml);
  if (other === null) throw new Error("其他参数 (YAML) 格式不正确");
  const id = form.id?.trim() || fallbackId;
  const thinking = {};
  if (form.thinking?.mode) thinking.mode = form.thinking.mode;
  if (form.thinking?.minLevel) thinking.minLevel = form.thinking.minLevel;
  if (form.thinking?.maxLevel) thinking.maxLevel = form.thinking.maxLevel;
  const hasThinking = thinking.mode || thinking.minLevel || thinking.maxLevel;
  return {
    ...other, // 其他参数（compat 及自定义同级字段），表单字段在后覆盖同名键
    id,
    name: form.name.trim() || id,
    contextWindow: Number(form.contextWindow) || 0,
    maxTokens: Number(form.maxTokens) || 0,
    reasoning: form.reasoning,
    input: form.input,
    cost: form.cost,
    thinking: hasThinking ? thinking : undefined,
  };
};

const openAddModelDialog = (providerName) => {
  addModelProvider.value = providerName;
  addModelForm.value = { id: "", name: "", contextWindow: 0, maxTokens: 0, reasoning: false, input: ["text"], thinking: emptyThinking(), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, otherYaml: "" };
  autoModels.value = [];
  autoModelsLoading.value = false;
  autoModelsError.value = "";
  modelAdvancedOpen.value = false;
  addModelDialog.value = true;
  // 打开弹窗即自动拉取模型列表，无需手动点击
  handleAutoFetchModels();
};

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

const handleAddModel = () => {
  try {
    const id = addModelForm.value.id.trim();
    if (!id) { MessagePlugin.warning("请输入模型 ID"); return; }
    const payload = buildModelPayload(addModelForm.value, id);
    window.services.addOmpModel(addModelProvider.value, payload);
    MessagePlugin.success(`模型 ${id} 已添加`);
    addModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const openEditModelDialog = (provName, m) => {
  editModelProvider.value = provName;
  editingModelId.value = m.id;
  newModelId.value = m.id;
  editModelForm.value = {
    name: m.name || "",
    contextWindow: m.contextWindow || 0,
    maxTokens: m.maxTokens || 0,
    reasoning: !!m.reasoning,
    input: m.input || ["text"],
    thinking: m.thinking ? { minLevel: m.thinking.minLevel || "", maxLevel: m.thinking.maxLevel || "", mode: m.thinking.mode || "" } : emptyThinking(),
    cost: (m.cost && m.cost.input != null) ? { ...m.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    otherYaml: dumpOtherFields(m),
  };
  modelAdvancedOpen.value = false;
  editModelDialog.value = true;
};

const handleSaveModel = () => {
  try {
    const finalId = newModelId.value.trim() || editingModelId.value;
    if (finalId !== editingModelId.value) {
      // ID 变化：删旧 + 建新
      window.services.deleteOmpModel(editModelProvider.value, editingModelId.value);
      window.services.addOmpModel(editModelProvider.value, buildModelPayload(editModelForm.value, finalId));
    } else {
      const { thinking, ...rest } = buildModelPayload(editModelForm.value, editingModelId.value);
      window.services.updateOmpModel(editModelProvider.value, editingModelId.value, { ...rest, thinking });
    }
    MessagePlugin.success("模型已更新");
    editModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteModel = (providerName, modelId) => {
  try {
    window.services.deleteOmpModel(providerName, modelId);
    MessagePlugin.success(`模型 ${modelId} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

// ==================== 工具 ====================

const formatNumber = (n) => {
  if (!n) return "默认";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
};

const openOmpDir = () => {
  try { window.services.openOmpDir(); } catch { /* ignore */ }
};

onMounted(refresh);
</script>

<template>
  <div class="omp-config-container">
    <div class="omp-config-header">
      <span class="omp-config-tip">
        omp CLI 配置 — 模型角色走 <code class="hint-link">omp config</code>，供应商见
        <span class="hint-link" @click="openOmpDir">~/.omp/agent/models.yml</span>
      </span>
      <div class="omp-config-actions">
        <Button size="small" variant="outline" @click="openOmpDir">
          <template #icon><FolderOpen1Icon /></template> 打开目录
        </Button>
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="omp-config-warning">
      <t-alert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <!-- 模型角色 -->
      <Card :bordered="true" class="omp-roles-card">
        <template #header>
          <div class="omp-roles-header">
            <Space size="12px" align="center">
              <span class="omp-roles-title">模型角色</span>
              <span class="omp-roles-sub">config.yml · modelRoles</span>
              <Tag size="small" variant="outline">{{ configuredRoles.length }} 个已配置</Tag>
            </Space>
            <Dropdown
              v-if="unconfiguredRoles.length"
              :options="unconfiguredRoles.map(r => ({ content: `${ROLE_LABELS[r] || r} (${r})`, value: r }))"
              :min-column-width="140"
              @click="onAddRole"
            >
              <Button size="small" variant="outline">
                <template #icon><AddIcon /></template> 添加角色
              </Button>
            </Dropdown>
          </div>
        </template>
        <div v-for="role in configuredRoles" :key="role" class="omp-role-row">
          <Space size="8px" align="center" class="omp-role-name-wrap">
            <span class="omp-role-name">{{ ROLE_LABELS[role] || role }}</span>
            <code class="omp-role-code">{{ role }}</code>
          </Space>
          <Space size="8px" align="center" class="omp-role-model">
            <span class="omp-role-model-name">{{ roleDisplays[role]?.modelName }}</span>
            <span class="omp-role-model-ref mono">{{ roleDisplays[role]?.provider }}/{{ roleDisplays[role]?.model }}</span>
            <Tag v-if="roleDisplays[role]?.level" size="small" theme="warning" variant="light">{{ roleDisplays[role].level }}</Tag>
          </Space>
          <div class="omp-role-actions">
            <Space size="4px" align="center">
              <Button size="small" variant="text" @click="openRoleDialog(role)">
                <template #icon><EditIcon /></template>
              </Button>
              <Popconfirm content="确定删除此角色？删除后该场景将使用系统默认模型。" @confirm="handleDeleteRole(role)">
                <Button size="small" variant="text" theme="danger">
                  <template #icon><DeleteIcon /></template>
                </Button>
              </Popconfirm>
            </Space>
          </div>
        </div>
      </Card>

      <!-- 供应商与模型 -->
      <div class="omp-providers-header">
        <span class="omp-providers-title">供应商与模型 · models.yml</span>
        <Button size="small" variant="outline" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> 添加供应商
        </Button>
      </div>

      <div v-if="providers.length === 0" class="omp-config-empty">
        <Empty description="未检测到 omp 供应商配置，请在终端中配置或手动编辑 models.yml" />
      </div>

      <div v-else class="omp-provider-list">
        <Collapse v-model="expandedList" class="omp-provider-collapse">
          <CollapsePanel
            v-for="prov in providers"
            :key="prov.name"
            :value="prov.name"
          >
            <!-- 供应商头部：展开箭头由 Collapse 内置渲染 -->
            <template #header>
              <div class="omp-provider-header-left">
                <span class="omp-provider-name">{{ prov.name }}</span>
                <Tag size="small" variant="outline">{{ prov.api || 'openai-completions' }}</Tag>
                <span class="omp-model-count">{{ prov.models.length }} 个模型</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="omp-provider-header-right" @click.stop>
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
              </div>
            </template>

            <!-- 展开内容 -->
            <template #content>
            <div class="omp-provider-info">
              <Space size="8px" align="center" class="omp-info-row">
                <span class="omp-info-label">API Key</span>
                <span class="omp-info-value mono">{{ prov.apiKey ? prov.apiKey.slice(0, 8) + '...' + prov.apiKey.slice(-4) : '未设置' }}</span>
              </Space>
              <Space size="8px" align="center" class="omp-info-row">
                <span class="omp-info-label">Base URL</span>
                <span class="omp-info-value mono">{{ prov.baseUrl || '默认' }}</span>
              </Space>
            </div>

            <div class="omp-models-section">
              <div class="omp-models-title">
                <span>模型列表</span>
                <Button size="small" variant="text" @click="openAddModelDialog(prov.name)">
                  <template #icon><AddIcon /></template> 添加模型
                </Button>
              </div>
              <div v-for="m in prov.models" :key="m.id" class="omp-model-item">
                <Space size="6px" align="center" class="omp-model-info">
                  <span class="omp-model-name">{{ m.name }}</span>
                </Space>
                <Space size="12px" align="center" class="omp-model-meta">
                  <span class="omp-model-stat">上下文: {{ formatNumber(m.contextWindow) }}</span>
                  <span class="omp-model-stat">最大输出: {{ formatNumber(m.maxTokens) }}</span>
                  <span v-if="m.input && m.input.includes('image')" class="omp-model-stat">图像</span>
                  <span v-if="m.cost && m.cost.input != null" class="omp-model-stat">
                    费用: ¥{{ m.cost.input }}/1M in · ¥{{ m.cost.output }}/1M out
                  </span>
                </Space>
                <div class="omp-model-actions" @click.stop>
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
    </template>

    <!-- 角色编辑弹窗 -->
    <Dialog v-model:visible="roleDialog" :header="`选择模型角色 — ${ROLE_LABELS[editingRole] || editingRole}`" width="480px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="saveRole">
      <div class="omp-edit-form">
        <div class="omp-form-item">
          <label>角色</label>
          <div class="omp-edit-role-name"><code>{{ editingRole }}</code></div>
        </div>
        <div class="omp-form-item">
          <label>供应商</label>
          <Select v-model="roleForm.provider" :options="providers.map(p => ({ label: p.name, value: p.name }))" filterable placeholder="选择供应商" @change="onRoleProviderChange" />
        </div>
        <div class="omp-form-item">
          <label>模型</label>
          <Select v-model="roleForm.modelId" :options="roleModelOptions" filterable placeholder="选择模型" />
        </div>
        <div class="omp-form-item">
          <label>思考级别</label>
          <Select v-model="roleForm.level" :options="roleLevelOptions" placeholder="默认（不指定）" />
          <div class="omp-form-hint">级别范围由所选模型的 thinking 配置决定</div>
        </div>
      </div>
    </Dialog>

    <!-- 供应商编辑弹窗 -->
    <Dialog v-model:visible="editDialog" header="编辑供应商配置" width="480px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="omp-edit-form">
        <div class="omp-form-item">
          <label>供应商名称</label>
          <div class="omp-edit-provider-name">{{ editingProvider }}</div>
        </div>
        <div class="omp-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" placeholder="留空则使用默认 URL" />
        </div>
        <div class="omp-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" placeholder="输入 API Key" />
        </div>
        <div class="omp-form-item">
          <label>API 类型</label>
          <Select v-model="editForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="omp-form-item">
          <label>自动添加 Authorization 头</label>
          <Switch v-model="editForm.authHeader" />
        </div>
        <div class="omp-form-item">
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

    <!-- 供应商添加弹窗 -->
    <Dialog v-model:visible="addProviderDialog" header="添加供应商" width="480px" :confirm-btn="{ content: '添加', theme: 'primary' }" @confirm="handleAddProvider">
      <div class="omp-edit-form">
        <div class="omp-form-item">
          <label>供应商名称 <span class="omp-form-required">*</span></label>
          <Input v-model="addProviderForm.name" placeholder="例如：openai、deepseek、zhipu" />
        </div>
        <div class="omp-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" placeholder="留空使用供应商默认 URL" />
        </div>
        <div class="omp-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" placeholder="输入 API Key（可留空后续再填）" />
        </div>
        <div class="omp-form-item">
          <label>API 类型</label>
          <Select v-model="addProviderForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="omp-form-item">
          <label>自动添加 Authorization 头</label>
          <Switch v-model="addProviderForm.authHeader" />
        </div>
        <div class="omp-form-item">
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

    <!-- 添加模型弹窗 -->
    <Dialog v-model:visible="addModelDialog" header="添加模型" width="520px" :confirm-btn="{ content: '添加', theme: 'primary' }" @confirm="handleAddModel">
      <div class="omp-edit-form">
        <div class="omp-form-item">
          <label>所属供应商</label>
          <div class="omp-edit-provider-name">{{ addModelProvider }}</div>
        </div>

        <!-- 模型 ID：AutoComplete，弹窗打开时已自动拉取模型列表 -->
        <div class="omp-form-item">
          <label>模型 ID <span class="omp-form-required">*</span></label>
          <AutoComplete
            v-model="addModelForm.id"
            :options="modelOptions"
            :loading="autoModelsLoading"
            filterable
            clearable
            placeholder="输入或从下拉选择模型"
            @select="onModelIdSelect"
          />
          <div v-if="autoModelsLoading" class="omp-form-hint">正在自动拉取模型列表…</div>
          <div v-else-if="autoModelsError" class="omp-form-hint omp-fetch-error">
            自动获取失败：{{ autoModelsError }}
            <span class="omp-fetch-retry" @click="handleAutoFetchModels">重试</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="omp-form-hint">
            已自动获取 {{ autoModels.length }} 个模型，选中后自动填充名称/上下文等
          </div>
        </div>
        <div class="omp-form-item">
          <label>显示名称</label>
          <Input v-model="addModelForm.name" placeholder="留空则使用模型 ID" />
        </div>
        <div class="omp-form-item">
          <label>输入类型</label>
          <Space size="16px" align="center" wrap>
            <CheckboxGroup v-model="addModelForm.input" class="omp-checkbox-group">
              <Checkbox v-for="opt in INPUT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
            </CheckboxGroup>
            <Checkbox v-model="addModelForm.reasoning" class="omp-reasoning-checkbox">推理模型</Checkbox>
          </Space>
        </div>
        <ModelLimitsFields v-model:context="addModelForm.contextWindow" v-model:output="addModelForm.maxTokens" item-class="omp-form-item" />
        <Collapse v-model="modelAdvancedOpen" class="omp-advanced-collapse">
          <CollapsePanel value="1" header="高级配置（思考级别 / 费用 / 兼容性）">
            <div class="omp-form-item">
              <label>思考级别 (thinking)</label>
              <div class="omp-form-row">
                <div class="omp-form-item">
                  <label>模式</label>
                  <Select v-model="addModelForm.thinking.mode" :options="THINKING_MODE_OPTIONS" clearable placeholder="不设置" />
                </div>
              </div>
              <div class="omp-form-row">
                <div class="omp-form-item">
                  <label>最小级别</label>
                  <Select v-model="addModelForm.thinking.minLevel" :options="LEVEL_ORDER.map(v => ({ label: v, value: v }))" clearable placeholder="不限制" />
                </div>
                <div class="omp-form-item">
                  <label>最大级别</label>
                  <Select v-model="addModelForm.thinking.maxLevel" :options="LEVEL_ORDER.map(v => ({ label: v, value: v }))" clearable placeholder="不限制" />
                </div>
              </div>
              <div class="omp-form-hint">角色选择模型时，思考级别只显示 minLevel ~ maxLevel 范围</div>
            </div>
            <div class="omp-form-item">
              <label>费用 (cost) — 每百万 Token</label>
              <div class="omp-form-row">
                <div class="omp-form-item">
                  <label>输入</label>
                  <InputNumber v-model="addModelForm.cost.input" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="omp-form-item">
                  <label>输出</label>
                  <InputNumber v-model="addModelForm.cost.output" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
              <div class="omp-form-row">
                <div class="omp-form-item">
                  <label>缓存读取</label>
                  <InputNumber v-model="addModelForm.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="omp-form-item">
                  <label>缓存写入</label>
                  <InputNumber v-model="addModelForm.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
            </div>
            <div class="omp-form-item">
              <label>其他参数</label>
              <Textarea
                v-model="addModelForm.otherYaml"
                placeholder="compat:&#10;    supportsDeveloperRole: false&#10;    reasoningEffortMap:&#10;        high: high&#10;自定义字段: 值"
                :autosize="{ minRows: 4, maxRows: 14 }"
              />
              <div class="omp-form-hint">原生 YAML，除上方表单字段外的模型参数都在这里，子级 4 空格缩进</div>
            </div>
          </CollapsePanel>
        </Collapse>
      </div>
    </Dialog>

    <!-- 编辑模型弹窗 -->
    <Dialog v-model:visible="editModelDialog" header="编辑模型" width="520px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveModel">
      <div class="omp-edit-form">
        <div class="omp-form-item">
          <label>模型 ID</label>
          <Input v-model="newModelId" placeholder="模型 ID" />
        </div>
        <div class="omp-form-item">
          <label>显示名称</label>
          <Input v-model="editModelForm.name" placeholder="显示名称" />
        </div>
        <div class="omp-form-item">
          <label>输入类型</label>
          <Space size="16px" align="center" wrap>
            <CheckboxGroup v-model="editModelForm.input" class="omp-checkbox-group">
              <Checkbox v-for="opt in INPUT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
            </CheckboxGroup>
            <Checkbox v-model="editModelForm.reasoning" class="omp-reasoning-checkbox">推理模型</Checkbox>
          </Space>
        </div>
        <ModelLimitsFields v-model:context="editModelForm.contextWindow" v-model:output="editModelForm.maxTokens" item-class="omp-form-item" />
        <Collapse v-model="modelAdvancedOpen" class="omp-advanced-collapse">
          <CollapsePanel value="1" header="高级配置（思考级别 / 费用 / 兼容性）">
            <div class="omp-form-item">
              <label>思考级别 (thinking)</label>
              <div class="omp-form-row">
                <div class="omp-form-item">
                  <label>模式</label>
                  <Select v-model="editModelForm.thinking.mode" :options="THINKING_MODE_OPTIONS" clearable placeholder="不设置" />
                </div>
              </div>
              <div class="omp-form-row">
                <div class="omp-form-item">
                  <label>最小级别</label>
                  <Select v-model="editModelForm.thinking.minLevel" :options="LEVEL_ORDER.map(v => ({ label: v, value: v }))" clearable placeholder="不限制" />
                </div>
                <div class="omp-form-item">
                  <label>最大级别</label>
                  <Select v-model="editModelForm.thinking.maxLevel" :options="LEVEL_ORDER.map(v => ({ label: v, value: v }))" clearable placeholder="不限制" />
                </div>
              </div>
              <div class="omp-form-hint">角色选择模型时，思考级别只显示 minLevel ~ maxLevel 范围</div>
            </div>
            <div class="omp-form-item">
              <label>费用 (cost) — 每百万 Token</label>
              <div class="omp-form-row">
                <div class="omp-form-item">
                  <label>输入</label>
                  <InputNumber v-model="editModelForm.cost.input" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="omp-form-item">
                  <label>输出</label>
                  <InputNumber v-model="editModelForm.cost.output" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
              <div class="omp-form-row">
                <div class="omp-form-item">
                  <label>缓存读取</label>
                  <InputNumber v-model="editModelForm.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
                </div>
                <div class="omp-form-item">
                  <label>缓存写入</label>
                  <InputNumber v-model="editModelForm.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
                </div>
              </div>
            </div>
            <div class="omp-form-item">
              <label>其他参数</label>
              <Textarea
                v-model="editModelForm.otherYaml"
                placeholder="compat:&#10;    supportsDeveloperRole: false&#10;    reasoningEffortMap:&#10;        high: high&#10;自定义字段: 值"
                :autosize="{ minRows: 4, maxRows: 14 }"
              />
              <div class="omp-form-hint">原生 YAML，除上方表单字段外的模型参数都在这里，子级 4 空格缩进</div>
            </div>
          </CollapsePanel>
        </Collapse>
      </div>
    </Dialog>
  </div>
</template>
