<script setup>
// ZCode 模型配置页：~/.zcode/v2/provider_config.json
// 管理自定义供应商 CRUD + 模型 CRUD（上下文窗口 / 最大输出 / 输入类型 / 模型能力 / 思考等级）。
// 配置项与 ZCode 客户端「自定义模型」编辑界面一致；星标 = 设为首选模型（providerOrder / modelOrder 置顶）。
// 风格与 Qoder 配置页一致：供应商手风琴 + 模型标签。
import { ref, computed, onMounted, nextTick, reactive } from "vue";
import {
  Empty, Button, Tag, Dialog, Input, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link, AutoComplete,
  Switch, Checkbox, Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import "./styles/ConfigView.css";

// API 协议与认证类型，与服务层 ZCODE_API_TYPES / ZCODE_ACCESS_TYPES 一致
const apiTypeOptions = [
  { label: "anthropic-messages（Anthropic Messages）", value: "anthropic-messages" },
  { label: "openai-chat-completions（OpenAI Chat）", value: "openai-chat-completions" },
  { label: "openai-responses（OpenAI Responses）", value: "openai-responses" },
];

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const expandedList = ref([]);

const defaultKey = ref(null); // 首选模型 { providerId, modelId }
const isDefaultModel = (p, m) =>
  !!defaultKey.value &&
  defaultKey.value.providerId === p.id &&
  defaultKey.value.modelId === m.modelId;

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
    providers.value = window.services.getZcodeProviderList() || [];
    defaultKey.value = window.services.getZcodeDefaultModel() || null;
  } catch (e) {
    console.error("加载 ZCode 配置失败:", e);
    warningMsg.value = e.message || "加载失败";
  } finally {
    loading.value = false;
  }
};

const openConfigFile = () => {
  try { window.services.openZcodeConfigFile(); } catch { /* ignore */ }
};

// ==================== 供应商弹窗 ====================

const addProviderDialog = ref(false);
const addProviderForm = ref({ name: "", apiType: "anthropic-messages", baseUrl: "", apiKey: "" });
const editDialog = ref(false);
const editingProvider = ref("");
const editForm = ref({ name: "", apiType: "anthropic-messages", baseUrl: "", apiKey: "" });
// 编辑弹窗初始加载的 key，保存时判断是否被用户改动/清空
const originalApiKey = ref("");

const openAddProviderDialog = () => {
  addProviderForm.value = { name: "", apiType: "anthropic-messages", baseUrl: "", apiKey: "" };
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    window.services.addZcodeProvider({
      name: addProviderForm.value.name.trim(),
      apiType: addProviderForm.value.apiType,
      baseUrl: addProviderForm.value.baseUrl.trim(),
      apiKey: addProviderForm.value.apiKey.trim(),
    });
    MessagePlugin.success("供应商已添加");
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.id;
  editForm.value = {
    name: provider.name || "",
    apiType: provider.apiType || "anthropic-messages",
    baseUrl: provider.baseUrl || "",
    apiKey: provider.apiKey || "",
  };
  originalApiKey.value = provider.apiKey || "";
  editDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    // ID 不改（与 ZCode 一致，界面不展示也不编辑该键）
    const payload = {
      name: editForm.value.name.trim(),
      apiType: editForm.value.apiType,
      baseUrl: editForm.value.baseUrl.trim(),
    };
    // key：清空 → 删除；改动 → 覆盖；未动 → 不回传
    if (!editForm.value.apiKey && originalApiKey.value) payload.clearApiKey = true;
    else if (editForm.value.apiKey !== originalApiKey.value) payload.apiKey = editForm.value.apiKey.trim();
    window.services.updateZcodeProvider(editingProvider.value, payload);
    MessagePlugin.success("供应商配置已更新");
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteProvider = (providerId) => {
  try {
    window.services.deleteZcodeProvider(providerId);
    MessagePlugin.success(`供应商 ${providerId} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

// ==================== 首选模型 ====================

// 星标 → 供应商提到 providerOrder 最前 + 模型提到 modelOrder 最前（ZCode 选择器排序基准）
const setDefaultModel = (p, m) => {
  try {
    window.services.setZcodeDefaultModel(p.id, m.modelId);
    MessagePlugin.success(`首选模型已设为 ${m.modelId}`);
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

// ==================== 模型弹窗 ====================

const addModelDialog = ref(false);
const addModelProvider = ref("");
const emptyModelForm = () => ({
  model: "", enabled: true,
  contextWindow: 0, maxOutputTokens: 0,
  image: false, video: false, audio: false, pdf: false,
  jsonSchema: false, webSearch: false, midSystem: false,
  reasoningLevels: [],
});
const addModelForm = ref(emptyModelForm());
const editModelDialog = ref(false);
const editingModel = ref("");
const editingModelProvider = ref("");
const editModelForm = ref(emptyModelForm());

// 思考等级编辑（从低到高，动态增删）：默认只显示「+」，点击出现输入框，
// 回车/失焦确认后内容变成标签、「+」重新显示（与 ZCode 原生编辑交互一致）
const addLevels = reactive({ editing: false, text: "" });
const editLevels = reactive({ editing: false, text: "" });
const addLevelInput = ref(null);
const editLevelInput = ref(null);

const startLevelEdit = (state, inputRef) => {
  state.editing = true;
  nextTick(() => inputRef.value?.focus?.());
};

const commitLevel = (state, form) => {
  const v = state.text.trim();
  if (v && !form.reasoningLevels.includes(v)) form.reasoningLevels.push(v);
  state.text = "";
  state.editing = false;
};

// 弹窗确认时若输入框还开着，先落账避免丢内容
const commitPendingLevel = (state, form) => {
  if (state.editing) commitLevel(state, form);
};

const removeLevel = (form, idx) => {
  form.reasoningLevels.splice(idx, 1);
};

// 模型候选（复用通用供应商 /models 拉取，失败静默）
const fetchedModels = ref([]);
const fetchingModels = ref(false);
const fetchModelError = ref("");

const handleFetchModels = async () => {
  const p = providers.value.find((x) => x.id === addModelProvider.value);
  if (!p || !p.baseUrl) {
    fetchModelError.value = "该供应商未配置 Base URL，无法自动获取";
    return;
  }
  fetchingModels.value = true;
  fetchModelError.value = "";
  try {
    const list = await window.services.fetchProviderModels(p.baseUrl, p.apiKey);
    fetchedModels.value = list || [];
    if (!fetchedModels.value.length) fetchModelError.value = "未获取到模型";
  } catch (e) {
    fetchModelError.value = e.message || "获取失败";
  } finally {
    fetchingModels.value = false;
  }
};

const modelOptions = computed(() =>
  fetchedModels.value.map((m) => ({ label: m.name || m.id, value: m.id }))
);

const openAddModelDialog = (providerId) => {
  addModelProvider.value = providerId;
  addModelForm.value = emptyModelForm();
  addLevels.text = "";
  addLevels.editing = false;
  fetchedModels.value = [];
  fetchModelError.value = "";
  addModelDialog.value = true;
  handleFetchModels();
};

const handleAddModel = () => {
  try {
    commitPendingLevel(addLevels, addModelForm.value);
    const modelId = addModelForm.value.model.trim();
    if (!modelId) { MessagePlugin.warning("请输入模型 ID"); return; }
    window.services.addZcodeModel(addModelProvider.value, {
      modelId,
      enabled: addModelForm.value.enabled,
      contextWindow: Number(addModelForm.value.contextWindow) || 0,
      maxOutputTokens: Number(addModelForm.value.maxOutputTokens) || 0,
      image: addModelForm.value.image,
      video: addModelForm.value.video,
      audio: addModelForm.value.audio,
      pdf: addModelForm.value.pdf,
      jsonSchema: addModelForm.value.jsonSchema,
      webSearch: addModelForm.value.webSearch,
      midSystem: addModelForm.value.midSystem,
      reasoningLevels: addModelForm.value.reasoningLevels,
    });
    MessagePlugin.success(`模型 ${modelId} 已添加`);
    addModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const openEditModelDialog = (p, m) => {
  editingModel.value = m.modelId;
  editingModelProvider.value = p.id;
  editModelForm.value = {
    model: m.modelId,
    enabled: m.enabled,
    contextWindow: m.contextWindow || 0,
    maxOutputTokens: m.maxOutputTokens || 0,
    image: !!m.image,
    video: !!m.video,
    audio: !!m.audio,
    pdf: !!m.pdf,
    jsonSchema: !!m.jsonSchema,
    webSearch: !!m.webSearch,
    midSystem: !!m.midSystem,
    reasoningLevels: [...(m.reasoningLevels || [])],
  };
  editLevels.text = "";
  editLevels.editing = false;
  editModelDialog.value = true;
};

const handleSaveModel = () => {
  try {
    commitPendingLevel(editLevels, editModelForm.value);
    window.services.updateZcodeModel(editingModelProvider.value, editingModel.value, {
      modelId: editModelForm.value.model.trim(),
      enabled: editModelForm.value.enabled,
      contextWindow: Number(editModelForm.value.contextWindow) || 0,
      maxOutputTokens: Number(editModelForm.value.maxOutputTokens) || 0,
      image: editModelForm.value.image,
      video: editModelForm.value.video,
      audio: editModelForm.value.audio,
      pdf: editModelForm.value.pdf,
      jsonSchema: editModelForm.value.jsonSchema,
      webSearch: editModelForm.value.webSearch,
      midSystem: editModelForm.value.midSystem,
      reasoningLevels: editModelForm.value.reasoningLevels,
    });
    MessagePlugin.success("模型配置已更新");
    editModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteModel = (providerId, modelId) => {
  try {
    window.services.deleteZcodeModel(providerId, modelId);
    MessagePlugin.success(`模型 ${modelId} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

onMounted(refresh);
</script>

<template>
  <div class="zcode-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="zcode-toolbar">
      <div class="zcode-toolbar-left">
        <span class="zcode-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openConfigFile">~/.zcode/v2/provider_config.json</Link>
          <span class="zcode-toolbar-sub">自定义供应商与模型（ZCode 修改后即时生效，无需重启）</span>
        </span>
      </div>
      <div class="zcode-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> 添加供应商
        </Button>
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="zcode-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0" class="zcode-config-empty">
        <Empty description="未检测到 ZCode 自定义供应商；可在 ZCode 内添加，或在此手动添加" />
      </div>

      <div v-else class="zcode-provider-list">
        <Collapse v-model="expandedList" class="zcode-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.id" :value="p.id">
              <template #header>
                <div class="zcode-provider-header-left">
                  <span class="zcode-provider-name">{{ p.name || p.id }}</span>
                  <Tag size="small" variant="outline">{{ p.apiType }}</Tag>
                  <Tag v-if="defaultKey && defaultKey.providerId === p.id" size="small" theme="warning" variant="light">首选供应商</Tag>
                  <span class="zcode-model-count">{{ p.models.length }} 个模型</span>
                </div>
              </template>
              <template #headerRightContent>
                <div class="zcode-provider-header-right" @click.stop>
                  <Button size="small" theme="default" variant="text" @click="handleEdit(p)">
                    <template #icon><EditIcon /></template> 编辑
                  </Button>
                  <Tooltip content="删除供应商（其模型一并删除）">
                    <Popconfirm
                      content="删除该供应商？其模型配置将一并从 provider_config.json 移除"
                      theme="danger"
                      @confirm="handleDeleteProvider(p.id)"
                    >
                      <Button size="small" theme="danger" variant="text">
                        <template #icon><DeleteIcon /></template>
                      </Button>
                    </Popconfirm>
                  </Tooltip>
                </div>
              </template>

              <!-- 展开内容：详情 + 模型列表 -->
              <template #content>
                <div class="zcode-provider-body">
                  <div class="zcode-provider-details">
                    <div class="zcode-detail-item">
                      <span class="zcode-detail-label">Base URL</span>
                      <span class="zcode-detail-value">{{ p.baseUrl || "—" }}</span>
                    </div>
                    <div class="zcode-detail-item">
                      <span class="zcode-detail-label">API Key</span>
                      <span class="zcode-detail-value mono">{{ p.apiKey ? "已配置" : "未配置" }}</span>
                    </div>
                  </div>

                  <div class="zcode-models-section">
                    <div class="zcode-models-title">
                      <span>模型（选择器顺序 = modelOrder）</span>
                      <Button size="small" variant="outline" @click="openAddModelDialog(p.id)">
                        <template #icon><AddIcon /></template> 添加
                      </Button>
                    </div>
                    <div v-if="p.models.length === 0" class="zcode-models-empty">
                      暂无自定义模型，点击「添加」创建
                    </div>
                    <div class="zcode-model-tags">
                      <span v-for="m in p.models" :key="m.modelId" class="zcode-model-tag" :class="{ 'zcode-model-tag--disabled': !m.enabled }">
                        <span class="zcode-model-tag-name">{{ m.modelId }}</span>
                        <span v-if="m.contextWindow" class="zcode-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                        <span v-if="m.reasoningLevels.length" class="zcode-model-tag-sub">思考×{{ m.reasoningLevels.length }}</span>
                        <Tag v-if="!m.enabled" size="small" theme="default" variant="light">已停用</Tag>
                        <Tag v-else-if="isDefaultModel(p, m)" size="small" theme="success" variant="light">首选</Tag>
                        <Tooltip v-else content="设为首选模型（providerOrder / modelOrder 置顶）" placement="top">
                          <span class="zcode-model-tag-star" @click="setDefaultModel(p, m)"><StarIcon size="12px" /></span>
                        </Tooltip>
                        <Tooltip content="编辑模型配置" placement="top">
                          <span class="zcode-model-tag-edit" @click="openEditModelDialog(p, m)"><EditIcon size="12px" /></span>
                        </Tooltip>
                        <Popconfirm content="删除该模型？" theme="danger" @confirm="handleDeleteModel(p.id, m.modelId)">
                          <span class="zcode-model-tag-del"><DeleteIcon size="12px" /></span>
                        </Popconfirm>
                      </span>
                    </div>
                  </div>
                </div>
              </template>
            </CollapsePanel>
          </Collapse>
      </div>
    </template>

    <!-- 添加供应商弹窗 -->
    <Dialog v-model:visible="addProviderDialog" header="添加供应商" width="520px" :confirm-btn="{ content: '添加', theme: 'primary' }" @confirm="handleAddProvider">
      <div class="zcode-edit-form">
        <div class="zcode-form-item">
          <label>供应商名称 <span class="zcode-form-required">*</span></label>
          <Input v-model="addProviderForm.name" placeholder="tiansu" />
          <div class="zcode-form-hint">Provider ID 按名称自动生成（小写字母/数字/中划线，与 ZCode 规则一致）</div>
        </div>
        <div class="zcode-form-item">
          <label>API 协议（api.type）</label>
          <Select v-model="addProviderForm.apiType" :options="apiTypeOptions" />
        </div>
        <div class="zcode-form-item">
          <label>Base URL <span class="zcode-form-required">*</span></label>
          <Input v-model="addProviderForm.baseUrl" placeholder="https://api.example.com" />
        </div>
        <div class="zcode-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" placeholder="明文写入 provider_config.json" />
        </div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗 -->
    <Dialog v-model:visible="editDialog" header="编辑供应商配置" width="520px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="zcode-edit-form">
        <div class="zcode-form-item">
          <label>供应商名称</label>
          <Input v-model="editForm.name" />
        </div>
        <div class="zcode-form-item">
          <label>API 协议（api.type）</label>
          <Select v-model="editForm.apiType" :options="apiTypeOptions" />
        </div>
        <div class="zcode-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" />
        </div>
        <div class="zcode-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="originalApiKey ? '已保存，清空并保存将删除；修改则覆盖' : '留空不写入'" />
        </div>
      </div>
    </Dialog>

    <!-- 添加模型弹窗 -->
    <Dialog v-model:visible="addModelDialog" header="添加模型" width="600px" :confirm-btn="{ content: '添加', theme: 'primary' }" @confirm="handleAddModel">
      <div class="zcode-edit-form">
        <div class="zcode-form-item">
          <label>模型 ID <span class="zcode-form-required">*</span></label>
          <!-- 只绑 @change：TDesign 的 @input 未声明为组件事件，$event 是原生 InputEvent（不是输入值） -->
          <AutoComplete
            :value="addModelForm.model"
            :options="modelOptions"
            :loading="fetchingModels"
            filterable
            clearable
            placeholder="glm-5.3-flash"
            @change="addModelForm.model = $event"
          />
          <div v-if="fetchingModels" class="zcode-form-hint">正在从该供应商拉取模型列表…</div>
          <div v-else-if="fetchModelError" class="zcode-form-hint zcode-fetch-error">
            自动获取失败：{{ fetchModelError }}
            <span class="zcode-fetch-retry" @click="handleFetchModels">重试</span>
          </div>
          <div v-else class="zcode-form-hint">从供应商 Base URL 的 /models 接口获取，也可手动输入</div>
        </div>
        <div class="zcode-form-item zcode-form-inline">
          <label>启用（enabled）</label>
          <Switch v-model="addModelForm.enabled" />
        </div>
        <ModelLimitsFields
          v-model:context="addModelForm.contextWindow"
          v-model:output="addModelForm.maxOutputTokens"
          item-class="zcode-form-item"
          output-label="最大输出 Token（optionSpecs.maxOutputTokens.max）"
        />
        <div class="zcode-form-item">
          <label>输入类型（inputFormat，文本默认支持）</label>
          <div class="zcode-chk-row">
            <Checkbox v-model="addModelForm.image">图片</Checkbox>
            <Checkbox v-model="addModelForm.video">视频</Checkbox>
            <Checkbox v-model="addModelForm.audio">音频</Checkbox>
            <Checkbox v-model="addModelForm.pdf">PDF</Checkbox>
          </div>
        </div>
        <div class="zcode-form-item">
          <label>模型能力（properties）</label>
          <div class="zcode-chk-row">
            <Checkbox v-model="addModelForm.jsonSchema">结构化输出</Checkbox>
            <Checkbox v-model="addModelForm.webSearch">原生联网搜索</Checkbox>
            <Checkbox v-model="addModelForm.midSystem">对话中系统消息</Checkbox>
          </div>
        </div>
        <div class="zcode-form-item">
          <label>思考等级（从低到高，optionSpecs.reasoningLevel.values）</label>
          <div class="zcode-level-editor">
            <span v-for="(lv, idx) in addModelForm.reasoningLevels" :key="lv" class="zcode-level-tag">
              {{ lv }}
              <span class="zcode-level-del" @click="removeLevel(addModelForm, idx)">×</span>
            </span>
            <Input
              v-if="addLevels.editing"
              ref="addLevelInput"
              v-model="addLevels.text"
              size="small"
              class="zcode-level-input"
              placeholder="如 low"
              @enter="commitLevel(addLevels, addModelForm)"
              @blur="commitLevel(addLevels, addModelForm)"
            />
            <Tooltip v-else content="添加思考等级" placement="top">
              <Button size="small" variant="outline" @click="startLevelEdit(addLevels, addLevelInput)">
                <template #icon><AddIcon /></template>
              </Button>
            </Tooltip>
          </div>
          <div class="zcode-form-hint">点「+」输入，回车确认成标签；按从低到高的顺序依次添加，如 low → high → max</div>
        </div>
        <div class="zcode-form-hint">供应商：{{ providers.find((x) => x.id === addModelProvider)?.baseUrl || addModelProvider }}</div>
      </div>
    </Dialog>

    <!-- 编辑模型弹窗 -->
    <Dialog v-model:visible="editModelDialog" header="编辑模型" width="600px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveModel">
      <div class="zcode-edit-form">
        <div class="zcode-form-item">
          <label>模型 ID <span class="zcode-form-required">*</span></label>
          <Input v-model="editModelForm.model" />
          <div class="zcode-form-hint">改 ID 后两个顺序表（personalModelIds / modelOrder）自动同步</div>
        </div>
        <div class="zcode-form-item zcode-form-inline">
          <label>启用（enabled）</label>
          <Switch v-model="editModelForm.enabled" />
        </div>
        <ModelLimitsFields
          v-model:context="editModelForm.contextWindow"
          v-model:output="editModelForm.maxOutputTokens"
          item-class="zcode-form-item"
          output-label="最大输出 Token（optionSpecs.maxOutputTokens.max）"
        />
        <div class="zcode-form-item">
          <label>输入类型（inputFormat，文本默认支持）</label>
          <div class="zcode-chk-row">
            <Checkbox v-model="editModelForm.image">图片</Checkbox>
            <Checkbox v-model="editModelForm.video">视频</Checkbox>
            <Checkbox v-model="editModelForm.audio">音频</Checkbox>
            <Checkbox v-model="editModelForm.pdf">PDF</Checkbox>
          </div>
        </div>
        <div class="zcode-form-item">
          <label>模型能力（properties）</label>
          <div class="zcode-chk-row">
            <Checkbox v-model="editModelForm.jsonSchema">结构化输出</Checkbox>
            <Checkbox v-model="editModelForm.webSearch">原生联网搜索</Checkbox>
            <Checkbox v-model="editModelForm.midSystem">对话中系统消息</Checkbox>
          </div>
        </div>
        <div class="zcode-form-item">
          <label>思考等级（从低到高，optionSpecs.reasoningLevel.values）</label>
          <div class="zcode-level-editor">
            <span v-for="(lv, idx) in editModelForm.reasoningLevels" :key="lv" class="zcode-level-tag">
              {{ lv }}
              <span class="zcode-level-del" @click="removeLevel(editModelForm, idx)">×</span>
            </span>
            <Input
              v-if="editLevels.editing"
              ref="editLevelInput"
              v-model="editLevels.text"
              size="small"
              class="zcode-level-input"
              placeholder="如 low"
              @enter="commitLevel(editLevels, editModelForm)"
              @blur="commitLevel(editLevels, editModelForm)"
            />
            <Tooltip v-else content="添加思考等级" placement="top">
              <Button size="small" variant="outline" @click="startLevelEdit(editLevels, editLevelInput)">
                <template #icon><AddIcon /></template>
              </Button>
            </Tooltip>
          </div>
          <div class="zcode-form-hint">点「+」输入，回车确认成标签；按从低到高的顺序依次添加，如 low → high → max</div>
        </div>
      </div>
    </Dialog>
  </div>
</template>
