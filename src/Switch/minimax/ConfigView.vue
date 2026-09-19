<script setup>
// MiniMax Code（CLI mcode / Desktop）模型配置页：~/.minimax/config.yaml
// 管理内置 minimax（只读，可设默认）+ custom_provider 第三方供应商/模型 CRUD + 顶层 defaultModel。
// 风格与 Kimi 配置页一致：供应商手风琴 + 模型标签（星标设默认）。
import { ref, computed, onMounted } from "vue";
import {
  Empty, Button, Tag, Dialog, Input, InputNumber, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link, AutoComplete,
  Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import "./styles/ConfigView.css";

// defaultModel 引用 custom 供应商的前缀，与服务层 CUSTOM_PREFIX 一致
const CUSTOM_PREFIX = "custom_provider";

// 官方支持的 API 格式（docs/cli/configuration），与服务层 MINIMAX_API_FORMATS 一致
const apiOptions = [
  { label: "openai-completions（OpenAI Chat）", value: "openai-completions" },
  { label: "openai-responses（OpenAI Responses）", value: "openai-responses" },
  { label: "anthropic-messages（Anthropic）", value: "anthropic-messages" },
];

// 推理等级（thinking.effortOptions）与支持附件（modalities.input），与服务层枚举一致；
// 与桌面版模型编辑界面同组：推理等级 + 支持的附件（图片/PDF/视频/音频）
const effortOptions = ["minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ label: v, value: v }));
const attachmentOptions = [
  { label: "图片", value: "image" },
  { label: "PDF", value: "pdf" },
  { label: "视频", value: "video" },
  { label: "音频", value: "audio" },
];
const ATTACH_LABELS = { image: "图片", pdf: "PDF", video: "视频", audio: "音频" };

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
// 顶层 defaultModel 原始字符串（可能带 #variant）；比较时去后缀
const defaultModel = ref("");
const defaultBase = computed(() => defaultModel.value.split("#")[0]);
const expandedList = ref([]);

// 当前 provider+model 的 defaultModel 引用形态
const modelRef = (p, modelId) =>
  p.managed ? `${p.id}/${modelId}` : `${CUSTOM_PREFIX}:${p.id}/${modelId}`;
const isDefaultModel = (p, modelId) => !!defaultBase.value && defaultBase.value === modelRef(p, modelId);
const isDefaultProvider = (p) => p.models.some((m) => isDefaultModel(p, m.id));

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
    providers.value = window.services.getMinimaxProviderList() || [];
    defaultModel.value = window.services.getMinimaxDefaultModel() || "";
  } catch (e) {
    console.error("加载 MiniMax Code 配置失败:", e);
    warningMsg.value = e.message || "加载失败";
  } finally {
    loading.value = false;
  }
};

const openMinimaxDir = () => {
  try { window.services.openMinimaxDir(); } catch { /* ignore */ }
};

// ==================== 弹窗状态 ====================

const addProviderDialog = ref(false);
const addProviderForm = ref({ id: "", name: "", api: "openai-completions", baseUrl: "", apiKey: "" });
const editDialog = ref(false);
const editingProvider = ref("");
const editForm = ref({ id: "", name: "", api: "openai-completions", baseUrl: "", apiKey: "" });
// 编辑弹窗初始加载的 key，保存时判断是否被用户改动/清空
const originalApiKey = ref("");

const addModelDialog = ref(false);
const addModelProvider = ref("");
const emptyModelForm = () => ({ model: "", name: "", contextWindow: 0, outputWindow: 0, effortOptions: [], inputTypes: [] });
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
  addProviderForm.value = { id: "", name: "", api: "openai-completions", baseUrl: "", apiKey: "" };
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    const id = addProviderForm.value.id.trim();
    if (!id) { MessagePlugin.warning("请输入 Provider ID"); return; }
    window.services.addMinimaxProvider({
      id,
      name: addProviderForm.value.name.trim(),
      api: addProviderForm.value.api,
      baseUrl: addProviderForm.value.baseUrl.trim(),
      apiKey: addProviderForm.value.apiKey,
    });
    MessagePlugin.success(`Provider ${id} 已添加`);
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.id;
  editForm.value = {
    id: provider.id,
    name: provider.name || provider.id,
    api: provider.api || "openai-completions",
    baseUrl: provider.baseUrl || "",
    apiKey: provider.apiKey || "",
  };
  originalApiKey.value = provider.apiKey || "";
  editDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    const newId = String(editForm.value.id || "").trim();
    if (!newId) { MessagePlugin.warning("请输入 Provider ID"); return; }
    const payload = {
      id: newId,
      name: editForm.value.name.trim(),
      api: editForm.value.api,
      baseUrl: editForm.value.baseUrl.trim(),
    };
    // key：清空 → 删除；改动 → 覆盖；未动 → 不回传
    if (!editForm.value.apiKey && originalApiKey.value) payload.clearApiKey = true;
    else if (editForm.value.apiKey !== originalApiKey.value) payload.apiKey = editForm.value.apiKey;
    window.services.updateMinimaxProvider(editingProvider.value, payload);
    MessagePlugin.success(newId !== editingProvider.value ? `已更新并重命名为 ${newId}` : "Provider 配置已更新");
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteProvider = (providerId) => {
  try {
    window.services.deleteMinimaxProvider(providerId);
    MessagePlugin.success(`Provider ${providerId} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

// ==================== 默认模型 ====================

// 模型标签上点星标 → 写入顶层 defaultModel（内置模型同样可设）
const setDefaultModel = (p, modelId) => {
  try {
    window.services.setMinimaxDefaultModel(modelRef(p, modelId));
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
    window.services.addMinimaxModel(addModelProvider.value, {
      model: modelId,
      name: addModelForm.value.name.trim(),
      contextWindow: Number(addModelForm.value.contextWindow) || 0,
      outputWindow: Number(addModelForm.value.outputWindow) || 0,
      effortOptions: addModelForm.value.effortOptions,
      inputTypes: addModelForm.value.inputTypes,
    });
    MessagePlugin.success(`模型 ${modelId} 已添加`);
    addModelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const openEditModelDialog = (p, m) => {
  editingModel.value = m.id;
  editingModelProvider.value = p.id;
  editModelForm.value = {
    model: m.id,
    name: m.name === m.id ? "" : m.name || "",
    contextWindow: m.contextWindow || 0,
    outputWindow: m.outputWindow || 0,
    effortOptions: [...(m.effortOptions || [])],
    inputTypes: [...(m.inputTypes || [])],
  };
  editModelDialog.value = true;
};

const handleSaveModel = () => {
  try {
    window.services.updateMinimaxModel(editingModelProvider.value, editingModel.value, {
      model: editModelForm.value.model.trim(),
      name: editModelForm.value.name.trim(),
      contextWindow: Number(editModelForm.value.contextWindow) || 0,
      outputWindow: Number(editModelForm.value.outputWindow) || 0,
      effortOptions: editModelForm.value.effortOptions,
      inputTypes: editModelForm.value.inputTypes,
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
    window.services.deleteMinimaxModel(providerId, modelId);
    MessagePlugin.success(`模型 ${modelId} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

onMounted(refresh);
</script>

<template>
  <div class="minimax-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="minimax-toolbar">
      <div class="minimax-toolbar-left">
        <span class="minimax-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openMinimaxDir">~/.minimax/</Link>
          <span class="minimax-toolbar-sub">config.yaml（custom_provider + defaultModel）</span>
        </span>
      </div>
      <div class="minimax-toolbar-right">
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

    <div v-if="warningMsg" class="minimax-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0" class="minimax-config-empty">
        <Empty description="未检测到 MiniMax Code 配置；内置供应商请先运行 mcode login，第三方供应商可在此手动添加" />
      </div>

      <div v-else class="minimax-provider-list">
        <Collapse v-model="expandedList" class="minimax-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.id" :value="p.id">
              <template #header>
                <div class="minimax-provider-header-left">
                  <span class="minimax-provider-name">{{ p.name }}</span>
                  <Tag size="small" variant="outline">{{ p.api }}</Tag>
                  <Tag v-if="p.managed" size="small" theme="primary" variant="light">内置登录托管</Tag>
                  <Tag v-else-if="isDefaultProvider(p)" size="small" theme="warning" variant="light">含默认模型</Tag>
                  <span class="minimax-model-count">{{ p.models.length }} 个模型</span>
                </div>
              </template>
              <template #headerRightContent>
                <div class="minimax-provider-header-right" @click.stop>
                  <template v-if="!p.managed">
                    <Button size="small" theme="default" variant="text" @click="handleEdit(p)">
                      <template #icon><EditIcon /></template> 编辑
                    </Button>
                    <Tooltip content="删除供应商（其模型一并删除）">
                      <Popconfirm
                        :content="`删除 Provider ${p.id}？其模型与 options.apiKey 将一并从 config.yaml 移除`"
                        theme="danger"
                        @confirm="handleDeleteProvider(p.id)"
                      >
                        <Button size="small" theme="danger" variant="text">
                          <template #icon><DeleteIcon /></template>
                        </Button>
                      </Popconfirm>
                    </Tooltip>
                  </template>
                </div>
              </template>

              <!-- 展开内容：详情 + 模型列表 -->
              <template #content>
                <div class="minimax-provider-body">
                  <div class="minimax-provider-details">
                    <div class="minimax-detail-item">
                      <span class="minimax-detail-label">Base URL</span>
                      <span class="minimax-detail-value">{{ p.baseUrl || "—（使用协议默认）" }}</span>
                    </div>
                    <div class="minimax-detail-item">
                      <span class="minimax-detail-label">API Key</span>
                      <span class="minimax-detail-value mono">{{ p.apiKey ? "已配置" : (p.managed ? "mcode login 托管" : "未配置") }}</span>
                    </div>
                  </div>

                  <div class="minimax-models-section">
                    <div class="minimax-models-title">
                      <span>模型（custom_provider.&lt;id&gt;.models）</span>
                      <Button v-if="!p.managed" size="small" variant="outline" @click="openAddModelDialog(p.id)">
                        <template #icon><AddIcon /></template> 添加
                      </Button>
                    </div>
                    <div v-if="p.models.length === 0" class="minimax-models-empty">
                      暂无模型，defaultModel 需引用此处定义的模型 ID
                    </div>
                    <div class="minimax-model-tags">
                      <span v-for="m in p.models" :key="m.id" class="minimax-model-tag">
                        <span class="minimax-model-tag-name">{{ m.id }}</span>
                        <span v-if="m.name && m.name !== m.id" class="minimax-model-tag-sub">{{ m.name }}</span>
                        <span v-if="m.contextWindow" class="minimax-model-tag-sub">{{ formatNumber(m.contextWindow) }}</span>
                        <span v-if="m.inputTypes && m.inputTypes.length" class="minimax-model-tag-sub">
                          {{ m.inputTypes.map((t) => ATTACH_LABELS[t] || t).join("/") }}
                        </span>
                        <span v-if="m.effortOptions && m.effortOptions.length" class="minimax-model-tag-sub">
                          {{ m.effortOptions.join("/") }}
                        </span>
                        <Tag v-if="isDefaultModel(p, m.id)" size="small" theme="success" variant="light">默认</Tag>
                        <Tooltip v-else content="设为默认模型（defaultModel）" placement="top">
                          <span class="minimax-model-tag-star" @click="setDefaultModel(p, m.id)"><StarIcon size="12px" /></span>
                        </Tooltip>
                        <template v-if="!p.managed">
                          <Tooltip content="编辑模型 ID / 上下文限制" placement="top">
                            <span class="minimax-model-tag-edit" @click="openEditModelDialog(p, m)"><EditIcon size="12px" /></span>
                          </Tooltip>
                          <Popconfirm content="删除该模型？" theme="danger" @confirm="handleDeleteModel(p.id, m.id)">
                            <span class="minimax-model-tag-del"><DeleteIcon size="12px" /></span>
                          </Popconfirm>
                        </template>
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
      <div class="minimax-edit-form">
        <div class="minimax-form-item">
          <label>Provider ID <span class="minimax-form-required">*</span></label>
          <Input v-model="addProviderForm.id" placeholder="deepseek（custom_provider 表键，字母/数字/_/-）" />
          <div class="minimax-form-hint">默认模型引用格式：custom_provider:&lt;ID&gt;/&lt;模型ID&gt;</div>
        </div>
        <div class="minimax-form-item">
          <label>显示名</label>
          <Input v-model="addProviderForm.name" placeholder="留空则与 Provider ID 相同" />
        </div>
        <div class="minimax-form-item">
          <label>API 格式</label>
          <Select v-model="addProviderForm.api" :options="apiOptions" />
        </div>
        <div class="minimax-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" placeholder="https://api.deepseek.com/v1" />
        </div>
        <div class="minimax-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" placeholder="明文写入 config.yaml options.apiKey" />
        </div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗 -->
    <Dialog v-model:visible="editDialog" header="编辑供应商配置" width="520px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="minimax-edit-form">
        <div class="minimax-form-item">
          <label>Provider ID <span class="minimax-form-required">*</span></label>
          <Input v-model="editForm.id" />
          <div class="minimax-form-hint">改 ID 后 defaultModel 若引用该供应商会自动同步</div>
        </div>
        <div class="minimax-form-item">
          <label>显示名</label>
          <Input v-model="editForm.name" />
        </div>
        <div class="minimax-form-item">
          <label>API 格式</label>
          <Select v-model="editForm.api" :options="apiOptions" />
        </div>
        <div class="minimax-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" />
        </div>
        <div class="minimax-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="originalApiKey ? '已保存，清空并保存将删除；修改则覆盖' : '留空不写入'" />
        </div>
      </div>
    </Dialog>

    <!-- 添加模型弹窗 -->
    <Dialog v-model:visible="addModelDialog" header="添加模型" width="560px" :confirm-btn="{ content: '添加', theme: 'primary' }" @confirm="handleAddModel">
      <div class="minimax-edit-form">
        <div class="minimax-form-item">
          <label>模型 ID <span class="minimax-form-required">*</span></label>
          <AutoComplete
            :value="addModelForm.model"
            :options="modelOptions"
            :loading="fetchingModels"
            filterable
            clearable
            placeholder="deepseek-chat"
            @change="addModelForm.model = $event"
            @input="addModelForm.model = $event"
          />
          <div v-if="fetchingModels" class="minimax-form-hint">正在从该供应商拉取模型列表…</div>
          <div v-else-if="fetchModelError" class="minimax-form-hint minimax-fetch-error">
            自动获取失败：{{ fetchModelError }}
            <span class="minimax-fetch-retry" @click="handleFetchModels">重试</span>
          </div>
          <div v-else class="minimax-form-hint">从供应商 Base URL 的 /models 接口获取，也可手动输入</div>
        </div>
        <div class="minimax-form-item">
          <label>显示名</label>
          <Input v-model="addModelForm.name" placeholder="留空与模型 ID 相同" />
        </div>
        <div class="minimax-form-item">
          <label>上下文容量（limit.context）</label>
          <InputNumber v-model="addModelForm.contextWindow" :min="0" :step="1000" placeholder="0 = 不写入（用 CLI 默认）" />
        </div>
        <div class="minimax-form-item">
          <label>输出上限（limit.output）</label>
          <InputNumber v-model="addModelForm.outputWindow" :min="0" :step="1024" placeholder="0 = 不写入" />
        </div>
        <div class="minimax-form-item">
          <label>推理等级（thinking.effortOptions）</label>
          <Select v-model="addModelForm.effortOptions" multiple :options="effortOptions" placeholder="不选 = 不声明思考档位" clearable />
        </div>
        <div class="minimax-form-item">
          <label>支持的附件（modalities.input）</label>
          <Select v-model="addModelForm.inputTypes" multiple :options="attachmentOptions" placeholder="文本始终支持；不选 = 纯文本模型" clearable />
        </div>
        <div class="minimax-form-hint">供应商：{{ addModelProvider }}</div>
      </div>
    </Dialog>

    <!-- 编辑模型弹窗 -->
    <Dialog v-model:visible="editModelDialog" header="编辑模型" width="560px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveModel">
      <div class="minimax-edit-form">
        <div class="minimax-form-item">
          <label>模型 ID <span class="minimax-form-required">*</span></label>
          <Input v-model="editModelForm.model" />
          <div class="minimax-form-hint">改 ID 后 defaultModel 若指向它会自动同步</div>
        </div>
        <div class="minimax-form-item">
          <label>显示名</label>
          <Input v-model="editModelForm.name" placeholder="留空 = 清除并回退到模型 ID" />
        </div>
        <div class="minimax-form-item">
          <label>上下文容量（limit.context）</label>
          <InputNumber v-model="editModelForm.contextWindow" :min="0" :step="1000" placeholder="0 = 清除（回退 CLI 默认）" />
        </div>
        <div class="minimax-form-item">
          <label>输出上限（limit.output）</label>
          <InputNumber v-model="editModelForm.outputWindow" :min="0" :step="1024" placeholder="0 = 清除" />
        </div>
        <div class="minimax-form-item">
          <label>推理等级（thinking.effortOptions）</label>
          <Select v-model="editModelForm.effortOptions" multiple :options="effortOptions" placeholder="清空 = 移除档位声明（thinking 其他子键保留）" clearable />
        </div>
        <div class="minimax-form-item">
          <label>支持的附件（modalities.input）</label>
          <Select v-model="editModelForm.inputTypes" multiple :options="attachmentOptions" placeholder="清空 = 纯文本模型（attachment: false）" clearable />
        </div>
      </div>
    </Dialog>
  </div>
</template>
