<script setup>
// Hermes 模型配置页：~/.hermes/config.yaml
// 管理自定义供应商（custom_providers 列表）CRUD + 内嵌模型编辑（models 字典：ID + 上下文长度），
// 星标 = 设为默认模型（顶层 model.provider / model.default）。
// Hermes v12+ 顶层 providers 字典（Web UI 托管）只读展示：可设默认，禁改禁删。
// 风格与 ZCode 配置页一致：供应商手风琴 + 模型标签；模型在供应商弹窗内编辑（Hermes 数据模型如此）。
import { ref, onMounted } from "vue";
import {
  Empty, Button, Tag, Dialog, Input, InputNumber, MessagePlugin,
  Select, Popconfirm, Alert as TAlert, Tooltip, Link,
  Collapse, CollapsePanel,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon, LockOnIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import "./styles/ConfigView.css";

// API 模式与服务层 HERMES_API_MODES 一致（chat_completions / anthropic_messages / codex_responses / bedrock_converse）
const apiModeOptions = [
  { label: "chat_completions（OpenAI Chat）", value: "chat_completions" },
  { label: "anthropic_messages（Anthropic Messages）", value: "anthropic_messages" },
  { label: "codex_responses（OpenAI Responses）", value: "codex_responses" },
  { label: "bedrock_converse（AWS Bedrock）", value: "bedrock_converse" },
];

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const expandedList = ref([]);

const defaultKey = ref(null); // { provider, modelId }
const isDefaultModel = (p, m) =>
  !!defaultKey.value &&
  defaultKey.value.provider === p.name &&
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
    providers.value = window.services.getHermesProviderList() || [];
    defaultKey.value = window.services.getHermesDefaultModel() || null;
  } catch (e) {
    console.error("加载 Hermes 配置失败:", e);
    warningMsg.value = e.message || "加载失败";
  } finally {
    loading.value = false;
  }
};

const openConfigFile = () => {
  try { window.services.openHermesConfigFile(); } catch { /* ignore */ }
};

// ==================== 供应商弹窗（模型内嵌编辑） ====================

const emptyForm = () => ({
  name: "", apiMode: "chat_completions", baseUrl: "", apiKey: "",
  rateLimitDelay: null, models: [],
});
const addDialog = ref(false);
const addForm = ref(emptyForm());
const editDialog = ref(false);
const editingProvider = ref("");
const editForm = ref(emptyForm());
// 编辑弹窗初始加载的 key，保存时判断是否被用户改动/清空
const originalApiKey = ref("");

const addModelRow = (form) => {
  form.models.push({ modelId: "", contextLength: null, _raw: {} });
};

const removeModelRow = (form, idx) => {
  form.models.splice(idx, 1);
};

const openAddDialog = () => {
  addForm.value = emptyForm();
  addDialog.value = true;
};

const handleAddProvider = () => {
  const name = addForm.value.name.trim();
  if (!name) { MessagePlugin.warning("请输入供应商名称"); return; }
  try {
    window.services.addHermesProvider({
      name,
      apiMode: addForm.value.apiMode,
      baseUrl: addForm.value.baseUrl.trim(),
      apiKey: addForm.value.apiKey.trim(),
      rateLimitDelay: Number(addForm.value.rateLimitDelay) || 0,
      models: addForm.value.models,
    });
    MessagePlugin.success("供应商已添加");
    addDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("添加失败: " + e.message);
  }
};

const handleEdit = (provider) => {
  editingProvider.value = provider.name;
  editForm.value = {
    name: provider.name || "",
    apiMode: provider.apiMode || "chat_completions",
    baseUrl: provider.baseUrl || "",
    apiKey: provider.apiKey || "",
    rateLimitDelay: provider.rateLimitDelay || null,
    models: (provider.models || []).map((m) => ({ ...m })),
  };
  originalApiKey.value = provider.apiKey || "";
  editDialog.value = true;
};

const handleSaveProvider = () => {
  try {
    const payload = {
      apiMode: editForm.value.apiMode,
      baseUrl: editForm.value.baseUrl.trim(),
      rateLimitDelay: Number(editForm.value.rateLimitDelay) || 0,
      models: editForm.value.models,
    };
    // key：清空 → 删除；改动 → 覆盖；未动 → 不回传
    if (!editForm.value.apiKey && originalApiKey.value) payload.clearApiKey = true;
    else if (editForm.value.apiKey !== originalApiKey.value) payload.apiKey = editForm.value.apiKey.trim();
    window.services.updateHermesProvider(editingProvider.value, payload);
    MessagePlugin.success("供应商配置已更新");
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteProvider = (provider) => {
  try {
    window.services.deleteHermesProvider(provider.name);
    MessagePlugin.success(`供应商 ${provider.name} 已删除`);
    refresh();
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

// ==================== 默认模型 ====================

// 星标 → 顶层 model.provider 指向该供应商 + model.default 指向该模型
// （即 cc-switch 对 Hermes 的「切换」语义；Hermes 托管供应商也可设默认）
const setDefaultModel = (p, m) => {
  try {
    window.services.setHermesDefaultModel(p.name, m.modelId);
    MessagePlugin.success(`默认模型已设为 ${m.modelId}`);
    refresh();
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

onMounted(refresh);
</script>

<template>
  <div class="hermes-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="hermes-toolbar">
      <div class="hermes-toolbar-left">
        <span class="hermes-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openConfigFile">~/.hermes/config.yaml</Link>
          <span class="hermes-toolbar-sub">custom_providers 供应商与顶层 model 默认指针</span>
        </span>
      </div>
      <div class="hermes-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddDialog">
          <template #icon><AddIcon /></template> 添加供应商
        </Button>
        <Tooltip content="刷新" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="hermes-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0" class="hermes-config-empty">
        <Empty description="未检测到 Hermes 供应商；可在 Hermes 内添加，或在此手动添加" />
      </div>

      <div v-else class="hermes-provider-list">
        <Collapse v-model="expandedList" class="hermes-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.name" :value="p.name">
              <template #header>
                <div class="hermes-provider-header-left">
                  <span class="hermes-provider-name">{{ p.name }}</span>
                  <Tag size="small" variant="outline">{{ p.apiMode }}</Tag>
                  <Tooltip v-if="p.readonly" content="由 Hermes Web UI 托管（providers 节），仅可设为默认" placement="top">
                    <Tag size="small" theme="default" variant="light"><LockOnIcon size="11px" style="vertical-align: -1px" /> Hermes 托管</Tag>
                  </Tooltip>
                  <Tag v-if="defaultKey && defaultKey.provider === p.name" size="small" theme="warning" variant="light">默认供应商</Tag>
                  <span class="hermes-model-count">{{ p.models.length }} 个模型</span>
                </div>
              </template>
              <template #headerRightContent>
                <div class="hermes-provider-header-right" @click.stop>
                  <Tooltip v-if="p.readonly" content="由 Hermes Web UI 托管，不可在此编辑" placement="top">
                    <Button size="small" theme="default" variant="text" disabled>
                      <template #icon><EditIcon /></template> 编辑
                    </Button>
                  </Tooltip>
                  <Button v-else size="small" theme="default" variant="text" @click="handleEdit(p)">
                    <template #icon><EditIcon /></template> 编辑
                  </Button>
                  <Tooltip v-if="p.readonly" content="由 Hermes Web UI 托管，不可在此删除" placement="top">
                    <Button size="small" theme="danger" variant="text" disabled>
                      <template #icon><DeleteIcon /></template>
                    </Button>
                  </Tooltip>
                  <Popconfirm
                    v-else
                    content="删除该供应商？若为当前默认供应商，默认指针将改指首个剩余供应商"
                    theme="danger"
                    @confirm="handleDeleteProvider(p)"
                  >
                    <Button size="small" theme="danger" variant="text">
                      <template #icon><DeleteIcon /></template>
                    </Button>
                  </Popconfirm>
                </div>
              </template>

              <!-- 展开内容：详情 + 模型列表 -->
              <template #content>
                <div class="hermes-provider-body">
                  <div class="hermes-provider-details">
                    <div class="hermes-detail-item">
                      <span class="hermes-detail-label">Base URL</span>
                      <span class="hermes-detail-value">{{ p.baseUrl || "—" }}</span>
                    </div>
                    <div class="hermes-detail-item">
                      <span class="hermes-detail-label">API Key</span>
                      <span class="hermes-detail-value mono">{{ p.apiKey ? "已配置" : "未配置" }}</span>
                    </div>
                    <div class="hermes-detail-item">
                      <span class="hermes-detail-label">请求间隔（rate_limit_delay）</span>
                      <span class="hermes-detail-value">{{ p.rateLimitDelay ? `${p.rateLimitDelay} 秒` : "—" }}</span>
                    </div>
                  </div>

                  <div class="hermes-models-section">
                    <div class="hermes-models-title">
                      <span>模型（星标 = 设为默认，写入顶层 model.provider / model.default）</span>
                    </div>
                    <div v-if="p.models.length === 0" class="hermes-models-empty">
                      暂无模型{{ p.readonly ? "" : "，点击「编辑」在弹窗中添加" }}
                    </div>
                    <div class="hermes-model-tags">
                      <span v-for="m in p.models" :key="m.modelId" class="hermes-model-tag">
                        <span class="hermes-model-tag-name">{{ m.modelId }}</span>
                        <span v-if="m.contextLength" class="hermes-model-tag-sub">{{ formatNumber(m.contextLength) }}</span>
                        <Tag v-if="isDefaultModel(p, m)" size="small" theme="success" variant="light">默认</Tag>
                        <Tooltip content="设为默认模型" placement="top">
                          <span class="hermes-model-tag-star" @click="setDefaultModel(p, m)"><StarIcon size="12px" /></span>
                        </Tooltip>
                      </span>
                    </div>
                  </div>
                </div>
              </template>
            </CollapsePanel>
          </Collapse>
      </div>
    </template>

    <!-- 添加供应商弹窗（模型内嵌编辑） -->
    <Dialog v-model:visible="addDialog" header="添加供应商" width="640px" :confirm-btn="{ content: '添加', theme: 'primary' }" @confirm="handleAddProvider">
      <div class="hermes-edit-form">
        <div class="hermes-form-item">
          <label>供应商名称 <span class="hermes-form-required">*</span></label>
          <Input v-model="addForm.name" placeholder="openrouter" />
          <div class="hermes-form-hint">名称即 config.yaml 中的 YAML 身份，被顶层 model.provider 引用</div>
        </div>
        <div class="hermes-form-item">
          <label>API 模式（api_mode）</label>
          <Select v-model="addForm.apiMode" :options="apiModeOptions" />
        </div>
        <div class="hermes-form-item">
          <label>Base URL（base_url）</label>
          <Input v-model="addForm.baseUrl" placeholder="https://openrouter.ai/api/v1" />
        </div>
        <div class="hermes-form-item">
          <label>API Key（api_key）</label>
          <ApiKeyInput v-model="addForm.apiKey" placeholder="明文写入 config.yaml" />
        </div>
        <div class="hermes-form-item">
          <label>请求间隔秒数（rate_limit_delay，可选）</label>
          <InputNumber v-model="addForm.rateLimitDelay" :min="0" :step="1" placeholder="0" style="width: 220px" />
        </div>
        <div class="hermes-form-item">
          <label>模型（models，首个模型将作为该供应商的 model 默认值）</label>
          <div class="hermes-model-rows">
            <div v-for="(m, idx) in addForm.models" :key="idx" class="hermes-model-row">
              <Input v-model="m.modelId" placeholder="模型 ID，如 anthropic/claude-opus-4-8" />
              <InputNumber v-model="m.contextLength" :min="0" :step="1000" placeholder="上下文长度" class="hermes-model-row-ctx" />
              <span class="hermes-model-row-del" @click="removeModelRow(addForm, idx)"><DeleteIcon size="14px" /></span>
            </div>
            <Button size="small" variant="outline" @click="addModelRow(addForm)">
              <template #icon><AddIcon /></template> 添加模型
            </Button>
          </div>
          <div class="hermes-form-hint">模型 ID 必填；上下文长度（context_length）可选</div>
        </div>
      </div>
    </Dialog>

    <!-- 编辑供应商弹窗（名称固定；模型内嵌编辑，未知字段自动保留） -->
    <Dialog v-model:visible="editDialog" header="编辑供应商配置" width="640px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="hermes-edit-form">
        <div class="hermes-form-item">
          <label>供应商名称</label>
          <Input :value="editForm.name" disabled />
          <div class="hermes-form-hint">名称被 model.provider 引用，不随编辑变化</div>
        </div>
        <div class="hermes-form-item">
          <label>API 模式（api_mode）</label>
          <Select v-model="editForm.apiMode" :options="apiModeOptions" />
        </div>
        <div class="hermes-form-item">
          <label>Base URL（base_url）</label>
          <Input v-model="editForm.baseUrl" />
        </div>
        <div class="hermes-form-item">
          <label>API Key（api_key）</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="originalApiKey ? '已保存，清空并保存将删除；修改则覆盖' : '留空不写入'" />
        </div>
        <div class="hermes-form-item">
          <label>请求间隔秒数（rate_limit_delay，可选）</label>
          <InputNumber v-model="editForm.rateLimitDelay" :min="0" :step="1" placeholder="0" style="width: 220px" />
        </div>
        <div class="hermes-form-item">
          <label>模型（models，首个模型将作为该供应商的 model 默认值）</label>
          <div class="hermes-model-rows">
            <div v-for="(m, idx) in editForm.models" :key="idx" class="hermes-model-row">
              <Input v-model="m.modelId" placeholder="模型 ID" />
              <InputNumber v-model="m.contextLength" :min="0" :step="1000" placeholder="上下文长度" class="hermes-model-row-ctx" />
              <span class="hermes-model-row-del" @click="removeModelRow(editForm, idx)"><DeleteIcon size="14px" /></span>
            </div>
            <Button size="small" variant="outline" @click="addModelRow(editForm)">
              <template #icon><AddIcon /></template> 添加模型
            </Button>
          </div>
          <div class="hermes-form-hint">改模型 ID = 删旧建新；模型条目上的其他自定义键（如 name / max_tokens）自动保留</div>
        </div>
      </div>
    </Dialog>
  </div>
</template>
