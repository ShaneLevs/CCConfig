<script setup>
// Qoder 模型配置页：~/.qoder/settings.json
// 管理 providers 表（第三方 openai-compatible 供应商 CRUD + 模型 CRUD + 默认模型 provider.model）。
// 风格与 MiniMax 配置页一致：供应商手风琴 + 模型标签（星标设默认）。
import { ref, computed, onMounted } from "vue";
import {
  Empty, Button, Tag, Dialog, Input, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link, AutoComplete,
  Switch, Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import "./styles/ConfigView.css";

// 协议与思考档位枚举，与服务层 PROTOCOL_VALUES / EFFORT_VALUES 一致
const protocolOptions = [
  { label: "anthropic（Anthropic Messages）", value: "anthropic" },
  { label: "openai（OpenAI Chat）", value: "openai" },
];
const effortOptions = ["low", "medium", "high", "xhigh", "max"].map((v) => ({ label: v, value: v }));

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const expandedList = ref([]);

const isDefaultProvider = (p) => !!p.model && p.models.some((m) => m.model === p.model);

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
    providers.value = window.services.getQoderProviderList() || [];
  } catch (e) {
    console.error("加载 Qoder 配置失败:", e);
    warningMsg.value = e.message || "加载失败";
  } finally {
    loading.value = false;
  }
};

const openQoderDir = () => {
  try { window.services.openQoderDir(); } catch { /* ignore */ }
};

// ==================== 弹窗状态 ====================

const addProviderDialog = ref(false);
const addProviderForm = ref({ protocol: "anthropic", baseUrl: "", apiKey: "" });
const editDialog = ref(false);
const editingProvider = ref("");
const editForm = ref({ protocol: "anthropic", baseUrl: "", apiKey: "" });
// 编辑弹窗初始加载的 key，保存时判断是否被用户改动/清空
const originalApiKey = ref("");

const addModelDialog = ref(false);
const addModelProvider = ref("");
const emptyModelForm = () => ({
  model: "", displayName: "", contextWindow: 0, maxOutputTokens: 0,
  vision: false, thinkingEnabled: false, supportsEffort: false, effortLevels: [],
});
const addModelForm = ref(emptyModelForm());
const editModelDialog = ref(false);
const editingModel = ref("");
const editingModelProvider = ref("");
const editModelForm = ref(emptyModelForm());

// 模型候选（复用通用供应商 /models 拉取，失败静默）
const fetchedModels = ref([]);
const fetchingModels = ref(false);
const fetchModelError = ref("");

// ==================== 供应商 CRUD ====================

const openAddProviderDialog = () => {
  addProviderForm.value = { protocol: "anthropic", baseUrl: "", apiKey: "" };
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    // Provider ID 不由用户输入，服务层按官方规范自动生成 qoder-custom-<uuid>
    window.services.addQoderProvider({
      protocol: addProviderForm.value.protocol,
      baseUrl: addProviderForm.value.baseUrl.trim(),
      apiKey: addProviderForm.value.apiKey,
    });
    MessagePlugin.success("Provider 已添加");
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.id;
  editForm.value = {
    protocol: provider.protocol || "openai",
    baseUrl: provider.baseUrl || "",
    apiKey: provider.apiKey || "",
  };
  originalApiKey.value = provider.apiKey || "";
  editDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    // 不改 Provider ID（界面不展示也不编辑该键），仅更新协议 / Base URL / API Key
    const payload = {
      protocol: editForm.value.protocol,
      baseUrl: editForm.value.baseUrl.trim(),
    };
    // key：清空 → 删除；改动 → 覆盖；未动 → 不回传
    if (!editForm.value.apiKey && originalApiKey.value) payload.clearApiKey = true;
    else if (editForm.value.apiKey !== originalApiKey.value) payload.apiKey = editForm.value.apiKey;
    window.services.updateQoderProvider(editingProvider.value, payload);
    MessagePlugin.success("Provider 配置已更新");
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteProvider = (providerId) => {
  try {
    window.services.deleteQoderProvider(providerId);
    MessagePlugin.success(`Provider ${providerId} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

// ==================== 默认模型 ====================

// 模型标签上点星标 → 写入 provider 顶层 model 字段
const setDefaultModel = (p, modelId) => {
  try {
    window.services.setQoderDefaultModel(p.id, modelId);
    MessagePlugin.success(`默认模型已设为 ${modelId}`);
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

// ==================== 模型 CRUD ====================

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
  fetchedModels.value = [];
  fetchModelError.value = "";
  addModelDialog.value = true;
  handleFetchModels();
};

const handleAddModel = () => {
  try {
    const modelId = addModelForm.value.model.trim();
    if (!modelId) { MessagePlugin.warning("请输入模型 ID"); return; }
    window.services.addQoderModel(addModelProvider.value, {
      model: modelId,
      displayName: addModelForm.value.displayName.trim(),
      contextWindow: Number(addModelForm.value.contextWindow) || 0,
      maxOutputTokens: Number(addModelForm.value.maxOutputTokens) || 0,
      vision: addModelForm.value.vision,
      thinkingEnabled: addModelForm.value.thinkingEnabled,
      supportsEffort: addModelForm.value.supportsEffort,
      effortLevels: addModelForm.value.effortLevels,
    });
    MessagePlugin.success(`模型 ${modelId} 已添加`);
    addModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const openEditModelDialog = (p, m) => {
  editingModel.value = m.model;
  editingModelProvider.value = p.id;
  editModelForm.value = {
    model: m.model,
    displayName: m.displayName === m.model ? "" : m.displayName || "",
    contextWindow: m.contextWindow || 0,
    maxOutputTokens: m.maxOutputTokens || 0,
    vision: !!m.vision,
    thinkingEnabled: !!m.thinkingEnabled,
    supportsEffort: !!m.supportsEffort,
    effortLevels: [...(m.effortLevels || [])],
  };
  editModelDialog.value = true;
};

const handleSaveModel = () => {
  try {
    window.services.updateQoderModel(editingModelProvider.value, editingModel.value, {
      model: editModelForm.value.model.trim(),
      displayName: editModelForm.value.displayName.trim(),
      contextWindow: Number(editModelForm.value.contextWindow) || 0,
      maxOutputTokens: Number(editModelForm.value.maxOutputTokens) || 0,
      vision: editModelForm.value.vision,
      thinkingEnabled: editModelForm.value.thinkingEnabled,
      supportsEffort: editModelForm.value.supportsEffort,
      effortLevels: editModelForm.value.effortLevels,
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
    window.services.deleteQoderModel(providerId, modelId);
    MessagePlugin.success(`模型 ${modelId} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

onMounted(refresh);
</script>

<template>
  <div class="qoder-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="qoder-toolbar">
      <div class="qoder-toolbar-left">
        <span class="qoder-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openQoderDir">~/.qoder/</Link>
          <span class="qoder-toolbar-sub">settings.json（providers）</span>
        </span>
      </div>
      <div class="qoder-toolbar-right">
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

    <div v-if="warningMsg" class="qoder-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0" class="qoder-config-empty">
        <Empty description="未检测到 Qoder 自定义供应商；可在 Qoder 内添加，或在此手动添加" />
      </div>

      <div v-else class="qoder-provider-list">
        <Collapse v-model="expandedList" class="qoder-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.id" :value="p.id">
              <template #header>
                <div class="qoder-provider-header-left">
                  <span class="qoder-provider-name">{{ p.baseUrl || "未配置 Base URL" }}</span>
                  <Tag size="small" variant="outline">{{ p.protocol }}</Tag>
                  <Tag v-if="isDefaultProvider(p)" size="small" theme="warning" variant="light">默认 {{ p.model }}</Tag>
                  <span class="qoder-model-count">{{ p.models.length }} 个模型</span>
                </div>
              </template>
              <template #headerRightContent>
                <div class="qoder-provider-header-right" @click.stop>
                  <Button size="small" theme="default" variant="text" @click="handleEdit(p)">
                    <template #icon><EditIcon /></template> 编辑
                  </Button>
                  <Tooltip content="删除供应商（其模型一并删除）">
                    <Popconfirm
                      content="删除该 Provider？其模型与 apiKey 将一并从 settings.json 移除"
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
                <div class="qoder-provider-body">
                  <div class="qoder-provider-details">
                    <div class="qoder-detail-item">
                      <span class="qoder-detail-label">Base URL</span>
                      <span class="qoder-detail-value">{{ p.baseUrl || "—" }}</span>
                    </div>
                    <div class="qoder-detail-item">
                      <span class="qoder-detail-label">API Key</span>
                      <span class="qoder-detail-value mono">{{ p.apiKey ? "已配置" : "未配置" }}</span>
                    </div>
                  </div>

                  <div class="qoder-models-section">
                    <div class="qoder-models-title">
                      <span>模型（providers.&lt;id&gt;.models）</span>
                      <Button size="small" variant="outline" @click="openAddModelDialog(p.id)">
                        <template #icon><AddIcon /></template> 添加
                      </Button>
                    </div>
                    <div v-if="p.models.length === 0" class="qoder-models-empty">
                      暂无模型，默认模型（provider.model）需引用此处定义的模型 ID
                    </div>
                    <div class="qoder-model-tags">
                      <span v-for="m in p.models" :key="m.model" class="qoder-model-tag">
                        <span class="qoder-model-tag-name">{{ m.model }}</span>
                        <span v-if="m.displayName && m.displayName !== m.model" class="qoder-model-tag-sub">{{ m.displayName }}</span>
                        <span v-if="m.contextWindow" class="qoder-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                        <span v-if="m.vision" class="qoder-model-tag-sub">视觉</span>
                        <span v-if="m.thinkingEnabled" class="qoder-model-tag-sub">思考</span>
                        <Tag v-if="p.model === m.model" size="small" theme="success" variant="light">默认</Tag>
                        <Tooltip v-else content="设为默认模型（provider.model）" placement="top">
                          <span class="qoder-model-tag-star" @click="setDefaultModel(p, m.model)"><StarIcon size="12px" /></span>
                        </Tooltip>
                        <Tooltip content="编辑模型配置" placement="top">
                          <span class="qoder-model-tag-edit" @click="openEditModelDialog(p, m)"><EditIcon size="12px" /></span>
                        </Tooltip>
                        <Popconfirm content="删除该模型？" theme="danger" @confirm="handleDeleteModel(p.id, m.model)">
                          <span class="qoder-model-tag-del"><DeleteIcon size="12px" /></span>
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
      <div class="qoder-edit-form">
        <div class="qoder-form-item">
          <label>协议（protocol）</label>
          <Select v-model="addProviderForm.protocol" :options="protocolOptions" />
        </div>
        <div class="qoder-form-item">
          <label>Base URL <span class="qoder-form-required">*</span></label>
          <Input v-model="addProviderForm.baseUrl" placeholder="https://api.example.com" />
        </div>
        <div class="qoder-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" placeholder="明文写入 settings.json apiKey" />
        </div>
        <div class="qoder-form-hint">Provider ID 将按官方规范自动生成（qoder-custom-&lt;uuid&gt;）</div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗 -->
    <Dialog v-model:visible="editDialog" header="编辑供应商配置" width="520px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="qoder-edit-form">
        <div class="qoder-form-item">
          <label>协议（protocol）</label>
          <Select v-model="editForm.protocol" :options="protocolOptions" />
        </div>
        <div class="qoder-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" />
        </div>
        <div class="qoder-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="originalApiKey ? '已保存，清空并保存将删除；修改则覆盖' : '留空不写入'" />
        </div>
      </div>
    </Dialog>

    <!-- 添加模型弹窗 -->
    <Dialog v-model:visible="addModelDialog" header="添加模型" width="560px" :confirm-btn="{ content: '添加', theme: 'primary' }" @confirm="handleAddModel">
      <div class="qoder-edit-form">
        <div class="qoder-form-item">
          <label>模型 ID <span class="qoder-form-required">*</span></label>
          <!-- 只绑 @change：TDesign 的 @input 未声明为组件事件，$event 是原生 InputEvent（不是输入值） -->
          <AutoComplete
            :value="addModelForm.model"
            :options="modelOptions"
            :loading="fetchingModels"
            filterable
            clearable
            placeholder="qwen3.8-flash"
            @change="addModelForm.model = $event"
          />
          <div v-if="fetchingModels" class="qoder-form-hint">正在从该供应商拉取模型列表…</div>
          <div v-else-if="fetchModelError" class="qoder-form-hint qoder-fetch-error">
            自动获取失败：{{ fetchModelError }}
            <span class="qoder-fetch-retry" @click="handleFetchModels">重试</span>
          </div>
          <div v-else class="qoder-form-hint">从供应商 Base URL 的 /models 接口获取，也可手动输入</div>
        </div>
        <div class="qoder-form-item">
          <label>显示名（displayName）</label>
          <Input v-model="addModelForm.displayName" placeholder="留空与模型 ID 相同" />
        </div>
        <ModelLimitsFields v-model:context="addModelForm.contextWindow" v-model:output="addModelForm.maxOutputTokens" item-class="qoder-form-item" />
        <div class="qoder-form-item qoder-form-inline">
          <label>视觉能力（capabilities.vision）</label>
          <Switch v-model="addModelForm.vision" />
        </div>
        <div class="qoder-form-item qoder-form-inline">
          <label>思考能力（capabilities.thinking）</label>
          <Switch v-model="addModelForm.thinkingEnabled" />
        </div>
        <template v-if="addModelForm.thinkingEnabled">
          <div class="qoder-form-item qoder-form-inline">
            <label>支持推理档位（supportsEffort）</label>
            <Switch v-model="addModelForm.supportsEffort" />
          </div>
          <div v-if="addModelForm.supportsEffort" class="qoder-form-item">
            <label>支持的档位（supportedEffortLevels）</label>
            <Select v-model="addModelForm.effortLevels" multiple :options="effortOptions" placeholder="不选 = 不声明档位" clearable />
          </div>
        </template>
        <div class="qoder-form-hint">供应商：{{ providers.find((x) => x.id === addModelProvider)?.baseUrl || addModelProvider }}</div>
      </div>
    </Dialog>

    <!-- 编辑模型弹窗 -->
    <Dialog v-model:visible="editModelDialog" header="编辑模型" width="560px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveModel">
      <div class="qoder-edit-form">
        <div class="qoder-form-item">
          <label>模型 ID <span class="qoder-form-required">*</span></label>
          <Input v-model="editModelForm.model" />
          <div class="qoder-form-hint">改 ID 后默认模型若指向它会自动同步</div>
        </div>
        <div class="qoder-form-item">
          <label>显示名（displayName）</label>
          <Input v-model="editModelForm.displayName" placeholder="留空 = 清除并回退到模型 ID" />
        </div>
        <ModelLimitsFields v-model:context="editModelForm.contextWindow" v-model:output="editModelForm.maxOutputTokens" item-class="qoder-form-item" />
        <div class="qoder-form-item qoder-form-inline">
          <label>视觉能力（capabilities.vision）</label>
          <Switch v-model="editModelForm.vision" />
        </div>
        <div class="qoder-form-item qoder-form-inline">
          <label>思考能力（capabilities.thinking）</label>
          <Switch v-model="editModelForm.thinkingEnabled" />
        </div>
        <template v-if="editModelForm.thinkingEnabled">
          <div class="qoder-form-item qoder-form-inline">
            <label>支持推理档位（supportsEffort）</label>
            <Switch v-model="editModelForm.supportsEffort" />
          </div>
          <div v-if="editModelForm.supportsEffort" class="qoder-form-item">
            <label>支持的档位（supportedEffortLevels）</label>
            <Select v-model="editModelForm.effortLevels" multiple :options="effortOptions" placeholder="清空 = 不声明档位" clearable />
          </div>
        </template>
      </div>
    </Dialog>
  </div>
</template>
