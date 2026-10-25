<script setup>
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Space, Tooltip, Dialog, Input, MessagePlugin,
  Select, Switch, Collapse, CollapsePanel, Popconfirm,
} from "tdesign-vue-next";
import { RefreshIcon, EditIcon, FolderOpen1Icon, AddIcon, DeleteIcon } from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import OmpRolesCard from "./components/OmpRolesCard.vue";
import OmpModelFormDialog from "./components/OmpModelFormDialog.vue";
import { formatNumber } from "../../utils/format";
import "./styles/ConfigView.css";

const { t } = useI18n();

// ==================== Constants ====================

// 供应商 API 类型
const API_TYPE_OPTIONS = [
  { label: "OpenAI Chat Completions", value: "openai-completions" },
  { label: "OpenAI Responses", value: "openai-responses" },
  { label: "Anthropic Messages", value: "anthropic-messages" },
  { label: "Google Generative AI", value: "google-generative-ai" },
];

const HEADER_KEY_OPTIONS = ["x-portkey-api-key", "x-api-key", "Authorization", "x-secret"];

// ==================== State ====================

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const expandedList = ref([]);
const rolesCardRef = ref(null);

// 供应商弹窗
const editDialog = ref(false);
const editingProvider = ref(null);
const editForm = ref({ apiKey: "", baseUrl: "", api: "openai-completions", headers: [], authHeader: true });
const addProviderDialog = ref(false);
const addProviderForm = ref({ name: "", apiKey: "", baseUrl: "", api: "openai-completions", headers: [], authHeader: true });

// 模型弹窗（添加/编辑共用 OmpModelFormDialog）
const modelFormVisible = ref(false);
const modelFormMode = ref("add");
const modelFormProviderName = ref("");
const modelFormProvider = ref(null);
const modelFormInitial = ref(null);

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    providers.value = window.services.getOmpProviderList();
  } catch (e) {
    console.error("加载 omp 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
  // 模型角色由角色卡片自加载（失败经 load-error 上抛到 warningMsg）
  rolesCardRef.value?.load();
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
    MessagePlugin.success(t("omp.provider.updated"));
    editDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("omp.provider.saveFailed", { message: e.message }));
  }
};

const openAddProviderDialog = () => {
  addProviderForm.value = { name: "", apiKey: "", baseUrl: "", api: "openai-completions", headers: [], authHeader: true };
  addProviderDialog.value = true;
};

const handleAddProvider = () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning(t("omp.provider.nameRequired")); return; }
    window.services.addOmpProvider(name, buildProviderPayload(addProviderForm.value));
    MessagePlugin.success(t("omp.provider.added", { name }));
    addProviderDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t("omp.provider.addFailed", { message: e.message }));
  }
};

const handleDeleteProvider = (providerName) => {
  try {
    window.services.deleteOmpProvider(providerName);
    MessagePlugin.success(t("omp.provider.deleted", { name: providerName }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("omp.provider.deleteFailed", { message: e.message }));
  }
};

// ==================== 模型 CRUD ====================

const openAddModelDialog = (providerName) => {
  modelFormMode.value = "add";
  modelFormProviderName.value = providerName;
  modelFormProvider.value = providers.value.find(p => p.name === providerName) || null;
  modelFormInitial.value = null;
  modelFormVisible.value = true;
};

const openEditModelDialog = (provName, m) => {
  modelFormMode.value = "edit";
  modelFormProviderName.value = provName;
  modelFormProvider.value = null;
  modelFormInitial.value = m;
  modelFormVisible.value = true;
};

// 模型弹窗确认：添加 / 更新 / 重命名（删旧 + 建新）；payload 已由弹窗构建为 models.yml 条目
const handleModelFormConfirm = ({ mode, providerName, originalId, id, payload }) => {
  try {
    if (mode === "add") {
      window.services.addOmpModel(providerName, payload);
      MessagePlugin.success(t("omp.model.added", { id }));
    } else if (id !== originalId) {
      // ID 变化：删旧 + 建新
      window.services.deleteOmpModel(providerName, originalId);
      window.services.addOmpModel(providerName, payload);
      MessagePlugin.success(t("omp.model.updated"));
    } else {
      window.services.updateOmpModel(providerName, originalId, payload);
      MessagePlugin.success(t("omp.model.updated"));
    }
    modelFormVisible.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(t(mode === "add" ? "omp.model.addFailed" : "omp.model.saveFailed", { message: e.message }));
  }
};

const handleDeleteModel = (providerName, modelId) => {
  try {
    window.services.deleteOmpModel(providerName, modelId);
    MessagePlugin.success(t("omp.model.deleted", { id: modelId }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("omp.model.deleteFailed", { message: e.message }));
  }
};

// ==================== 工具 ====================

const openOmpDir = () => {
  try { window.services.openOmpDir(); } catch { /* ignore */ }
};

onMounted(refresh);
</script>

<template>
  <div class="omp-config-container">
    <div class="omp-config-header">
      <span class="omp-config-tip">
        {{ t("omp.config.toolbarTipPrefix") }}<code class="hint-link">omp config</code>{{ t("omp.config.toolbarTipSuffix") }}
        <span class="hint-link" @click="openOmpDir">~/.omp/agent/models.yml</span>
      </span>
      <div class="omp-config-actions">
        <Button size="small" variant="outline" @click="openOmpDir">
          <template #icon><FolderOpen1Icon /></template> {{ t("omp.config.openDir") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
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
      <OmpRolesCard ref="rolesCardRef" :providers="providers" @load-error="(msg) => (warningMsg = msg)" />

      <!-- 供应商与模型 -->
      <div class="omp-providers-header">
        <span class="omp-providers-title">{{ t("omp.config.providersTitle") }}</span>
        <Button size="small" variant="outline" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> {{ t("omp.provider.addTitle") }}
        </Button>
      </div>

      <div v-if="providers.length === 0" class="omp-config-empty">
        <Empty :description="t('omp.config.emptyProviders')" />
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
                <span class="omp-model-count">{{ t("omp.config.modelCount", { count: prov.models.length }, prov.models.length) }}</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="omp-provider-header-right" @click.stop>
                <Tooltip :content="t('omp.provider.editTooltip')" placement="top">
                  <Button size="small" variant="text" @click="handleEdit(prov)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm :content="t('omp.provider.deleteConfirm')" @confirm="handleDeleteProvider(prov.name)">
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
                <span class="omp-info-value mono">{{ prov.apiKey ? prov.apiKey.slice(0, 8) + '...' + prov.apiKey.slice(-4) : t("common.notSet") }}</span>
              </Space>
              <Space size="8px" align="center" class="omp-info-row">
                <span class="omp-info-label">Base URL</span>
                <span class="omp-info-value mono">{{ prov.baseUrl || t("common.default") }}</span>
              </Space>
            </div>

            <div class="omp-models-section">
              <div class="omp-models-title">
                <span>{{ t("omp.config.modelsTitle") }}</span>
                <Button size="small" variant="text" @click="openAddModelDialog(prov.name)">
                  <template #icon><AddIcon /></template> {{ t("model.addTitle") }}
                </Button>
              </div>
              <div v-for="m in prov.models" :key="m.id" class="omp-model-item">
                <Space size="6px" align="center" class="omp-model-info">
                  <span class="omp-model-name">{{ m.name }}</span>
                </Space>
                <Space size="12px" align="center" class="omp-model-meta">
                  <span class="omp-model-stat">{{ t("common.contextWindow") }}: {{ formatNumber(m.contextWindow) }}</span>
                  <span class="omp-model-stat">{{ t("common.maxOutput") }}: {{ formatNumber(m.maxTokens) }}</span>
                  <span v-if="m.input && m.input.includes('image')" class="omp-model-stat">{{ t("omp.model.image") }}</span>
                  <span v-if="m.cost && m.cost.input != null" class="omp-model-stat">
                    {{ t("omp.model.cost", { input: m.cost.input, output: m.cost.output }) }}
                  </span>
                </Space>
                <div class="omp-model-actions" @click.stop>
                  <Tooltip :content="t('omp.model.editTooltip')" placement="top">
                    <Button size="small" variant="text" @click="openEditModelDialog(prov.name, m)">
                      <template #icon><EditIcon /></template>
                    </Button>
                  </Tooltip>
                  <Popconfirm :content="t('omp.model.deleteConfirm')" @confirm="handleDeleteModel(prov.name, m.id)">
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

    <!-- 供应商编辑弹窗 -->
    <Dialog v-model:visible="editDialog" :header="t('omp.provider.editTitle')" width="480px" :confirm-btn="{ content: t('common.save'), theme: 'primary' }" @confirm="handleSaveProvider">
      <div class="omp-edit-form">
        <div class="omp-form-item">
          <label>{{ t("omp.provider.name") }}</label>
          <div class="omp-edit-provider-name">{{ editingProvider }}</div>
        </div>
        <div class="omp-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" :placeholder="t('omp.provider.baseUrlPlaceholderEdit')" />
        </div>
        <div class="omp-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="t('omp.provider.apiKeyPlaceholder')" />
        </div>
        <div class="omp-form-item">
          <label>{{ t("omp.provider.apiType") }}</label>
          <Select v-model="editForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="omp-form-item">
          <label>{{ t("omp.provider.authHeader") }}</label>
          <Switch v-model="editForm.authHeader" />
        </div>
        <div class="omp-form-item">
          <label>{{ t("omp.provider.headers") }}</label>
          <DynamicKvEditor
            v-model="editForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            :key-placeholder="t('omp.provider.headerKeyPlaceholder')"
            :value-placeholder="t('omp.provider.headerValuePlaceholder')"
          />
        </div>
      </div>
    </Dialog>

    <!-- 供应商添加弹窗 -->
    <Dialog v-model:visible="addProviderDialog" :header="t('omp.provider.addTitle')" width="480px" :confirm-btn="{ content: t('common.add'), theme: 'primary' }" @confirm="handleAddProvider">
      <div class="omp-edit-form">
        <div class="omp-form-item">
          <label>{{ t("omp.provider.name") }} <span class="omp-form-required">*</span></label>
          <Input v-model="addProviderForm.name" :placeholder="t('omp.provider.namePlaceholder')" />
        </div>
        <div class="omp-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" :placeholder="t('omp.provider.baseUrlPlaceholderAdd')" />
        </div>
        <div class="omp-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" :placeholder="t('omp.provider.apiKeyPlaceholderAdd')" />
        </div>
        <div class="omp-form-item">
          <label>{{ t("omp.provider.apiType") }}</label>
          <Select v-model="addProviderForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="omp-form-item">
          <label>{{ t("omp.provider.authHeader") }}</label>
          <Switch v-model="addProviderForm.authHeader" />
        </div>
        <div class="omp-form-item">
          <label>{{ t("omp.provider.headers") }}</label>
          <DynamicKvEditor
            v-model="addProviderForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            :key-placeholder="t('omp.provider.headerKeyPlaceholder')"
            :value-placeholder="t('omp.provider.headerValuePlaceholder')"
          />
        </div>
      </div>
    </Dialog>

    <!-- 模型添加 / 编辑弹窗 -->
    <OmpModelFormDialog
      v-model:visible="modelFormVisible"
      :mode="modelFormMode"
      :provider-name="modelFormProviderName"
      :provider="modelFormProvider"
      :initial="modelFormInitial"
      @confirm="handleModelFormConfirm"
    />
  </div>
</template>
