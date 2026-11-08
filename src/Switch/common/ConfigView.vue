<script setup>

import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Space, Tooltip, Dialog, Input, MessagePlugin, Popconfirm, Select, Switch, Collapse, CollapsePanel,
  Textarea, Loading,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, SendIcon, DownloadIcon, UploadIcon, LinkIcon,
  CheckCircleFilledIcon, ErrorCircleFilledIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import DynamicKvEditor from "../../components/DynamicKvEditor.vue";
import ModelFormDialog from "../../components/ModelFormDialog.vue";
import BatchAddModelsDialog from "./components/BatchAddModelsDialog.vue";
import DispatchDialog from "./components/DispatchDialog.vue";
import { formatNumber } from "../../utils/format";
import { MODEL_API_TYPE_OPTIONS } from "../../constants";
import { useFirstProviderExpand } from "../../composables/useFirstProviderExpand";
import "./styles/ConfigView.css";

const { t } = useI18n();

// 通用配置：跨 agent 的供应商/模型主数据库
const API_TYPE_OPTIONS = MODEL_API_TYPE_OPTIONS;

// 模型列表里的模态短标签（text 隐含在输入类型里，不重复展示）
const MODALITY_LABEL_KEYS = {
  image: "model.modality.image",
  audio: "model.modality.audio",
  video: "model.modality.video",
  pdf: "model.modality.pdf",
};
const modalityLabel = (value) => (MODALITY_LABEL_KEYS[value] ? t(MODALITY_LABEL_KEYS[value]) : value);

// 常用请求头名（自动完成提示）
const HEADER_KEY_OPTIONS = [
  "x-portkey-api-key",
  "x-api-key",
  "Authorization",
  "x-secret",
];

// 常用 compat 字段名（自动完成提示，传给模型弹窗）
const COMPAT_KEY_OPTIONS = [
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "maxTokensField",
  "supportsStore",
  "thinkingFormat",
];

const loading = ref(false);
const providers = ref([]);
const expandedList = ref([]);
useFirstProviderExpand(providers, expandedList, (p) => p.name);
const editDialog = ref(false);
const editingProvider = ref(null);
const editForm = ref({ apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true });
const addProviderDialog = ref(false);
const addProviderForm = ref({ name: '', apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true });
// 编辑时的新名称（供应商重命名 = 删旧 + 建新）
const newProviderName = ref('');

// 模型弹窗（添加/编辑共用 ModelFormDialog）
const modelFormVisible = ref(false);
const modelFormMode = ref('add');
const modelFormProviderName = ref('');
const modelFormProvider = ref(null);
const modelFormInitial = ref(null);

// 批量添加弹窗
const batchVisible = ref(false);
const batchProvider = ref(null);

const loadProviders = () => {
  try {
    providers.value = window.services.getCommonProviderList();
  } catch (e) {
    console.error("加载通用供应商失败:", e);
    providers.value = [];
  }
};

// ==================== 供应商连接测试 ====================
// 打开弹窗只准备模型列表；点击单个模型或一键测试才发请求，结果随进度实时更新。
// 序号用来丢弃已关闭弹窗的旧结果。
const TEST_CONCURRENCY = 3;
const testVisible = ref(false);
const testProviderName = ref('');
const testResults = ref([]);
const testRunning = ref(false);
const testSession = ref(0);

const testDoneCount = computed(() => testResults.value.filter((item) => item.status === 'success' || item.status === 'error').length);
const testOkCount = computed(() => testResults.value.filter((item) => item.status === 'success').length);
const testFailCount = computed(() => testResults.value.filter((item) => item.status === 'error').length);

const modelApiType = (provider, model) => model.api || provider.api || 'openai-completions';

const buildTestRows = (provider) =>
  (provider.models || []).map((model) => ({
    id: model.id,
    name: model.name || '',
    api: modelApiType(provider, model),
    status: 'pending',
    latencyMs: 0,
    error: '',
  }));

const openTestDialog = (provider) => {
  // 重新打开时丢弃旧弹窗仍在途的结果
  testSession.value += 1;
  testRunning.value = false;
  testProviderName.value = provider.name;
  testResults.value = buildTestRows(provider);
  testVisible.value = true;
};

const runConnectionTest = async (item, session) => {
  item.status = 'testing';
  item.latencyMs = 0;
  item.error = '';
  let result;
  try {
    result = await window.services.testCommonModelConnection(testProviderName.value, item.id);
  } catch (e) {
    result = { ok: false, error: (e && e.message) || t('common.unknownError') };
  }
  if (session !== testSession.value) return;
  if (result && result.ok) {
    item.status = 'success';
    item.latencyMs = Number(result.latencyMs) || 0;
  } else {
    item.status = 'error';
    item.error = (result && result.error) || t('common.unknownError');
  }
};

const testSingleModel = (item) => {
  if (testRunning.value || item.status === 'testing') return;
  runConnectionTest(item, testSession.value);
};

const startConnectionTests = async () => {
  if (testRunning.value || !testResults.value.length) return;
  const session = ++testSession.value;
  const queue = testResults.value;
  queue.forEach((item) => {
    item.status = 'pending';
    item.latencyMs = 0;
    item.error = '';
  });
  testRunning.value = true;
  let cursor = 0;
  const worker = async () => {
    while (session === testSession.value) {
      const item = queue[cursor];
      cursor += 1;
      if (!item) return;
      await runConnectionTest(item, session);
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(TEST_CONCURRENCY, queue.length) }, worker),
    );
  } finally {
    if (session === testSession.value) testRunning.value = false;
  }
};

const handleTestDialogClosed = () => {
  // 关闭后不再把在途请求写回结果，也避免 header 按钮一直转圈
  testSession.value += 1;
  testRunning.value = false;
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
      if (!oldProv) throw new Error(t('commonApp.config.providerNotFound', { name: editingProvider.value }));
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
    MessagePlugin.success(t('commonApp.config.providerUpdated'));
    editDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('common.saveFailed') + ': ' + e.message);
  }
};

const openAddProviderDialog = () => {
  addProviderForm.value = { name: '', apiKey: '', baseUrl: '', api: 'openai-completions', headers: [], authHeader: true };
  addProviderDialog.value = true;
};

const handleAddProvider = async () => {
  try {
    const name = addProviderForm.value.name.trim();
    if (!name) { MessagePlugin.warning(t('commonApp.config.providerNameRequired')); return; }
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
    MessagePlugin.success(t('commonApp.config.providerAdded', { name }));
    addProviderDialog.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('common.addFailed') + ': ' + e.message);
  }
};

const handleDeleteProvider = async (providerName) => {
  try {
    window.services.deleteCommonProvider(providerName);
    MessagePlugin.success(t('commonApp.config.providerDeleted', { name: providerName }));
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('common.deleteFailed') + ': ' + e.message);
  }
};

const openAddModelDialog = (providerName) => {
  modelFormMode.value = 'add';
  modelFormProviderName.value = providerName;
  modelFormProvider.value = providers.value.find(p => p.name === providerName) || null;
  modelFormInitial.value = null;
  modelFormVisible.value = true;
};

const openBatchAddDialog = (prov) => {
  batchProvider.value = prov;
  batchVisible.value = true;
};

const openEditModelDialog = (provName, m) => {
  modelFormMode.value = 'edit';
  modelFormProviderName.value = provName;
  modelFormProvider.value = null;
  modelFormInitial.value = m;
  modelFormVisible.value = true;
};

// 模型弹窗确认：添加 / 更新 / 重命名（删旧 + 建新）
const handleModelFormConfirm = async (payload) => {
  const oldModel = payload.mode === 'edit'
    ? (providers.value.find((p) => p.name === payload.providerName)?.models || [])
      .find((m) => m.id === payload.originalId)
    : null;
  // 保留旧对象里当前弹窗未管理的扩展字段；弹窗覆盖的字段以用户输入为准。
  const model = {
    ...(oldModel || {}),
    id: payload.id,
    name: payload.name,
    contextWindow: payload.contextWindow,
    maxTokens: payload.maxTokens,
    reasoning: payload.reasoning,
    input: payload.input,
    output: payload.output,
    reasoningEfforts: payload.reasoningEfforts,
    defaultEffort: payload.defaultEffort,
    capabilities: payload.capabilities,
    cost: payload.cost,
    compat: payload.compat,
    maxInputTokens: payload.maxInputTokens,
    offEffort: payload.offEffort,
    reasoningKey: payload.reasoningKey,
    adaptiveThinking: payload.adaptiveThinking,
    thinking: payload.thinking,
    description: payload.description,
    temperature: payload.temperature,
    topP: payload.topP,
    extraHeaders: payload.extraHeaders,
    options: payload.options,
    api: payload.api,
    baseURL: payload.baseURL,
  };
  try {
    if (payload.mode === 'add') {
      const ok = window.services.addCommonModel(payload.providerName, model);
      if (!ok) throw new Error(t('commonApp.config.writeFailed'));
      MessagePlugin.success(t('commonApp.config.modelAdded', { id: payload.id }));
    } else if (payload.id !== payload.originalId) {
      // ID 有变化：删除旧模型，添加新模型
      const okDel = window.services.deleteCommonModel(payload.providerName, payload.originalId);
      if (!okDel) throw new Error(t('commonApp.config.writeFailed'));
      const okAdd = window.services.addCommonModel(payload.providerName, model);
      if (!okAdd) throw new Error(t('commonApp.config.writeFailed'));
      MessagePlugin.success(t('commonApp.config.modelUpdated'));
    } else {
      const ok = window.services.updateCommonModel(payload.providerName, payload.originalId, model);
      if (!ok) throw new Error(t('commonApp.config.writeFailed'));
      MessagePlugin.success(t('commonApp.config.modelUpdated'));
    }
    modelFormVisible.value = false;
    loadProviders();
  } catch (e) {
    MessagePlugin.error((payload.mode === 'add' ? t('common.addFailed') : t('common.saveFailed')) + ': ' + e.message);
  }
};

const handleDeleteModel = async (providerName, modelId) => {
  try {
    const ok = window.services.deleteCommonModel(providerName, modelId);
    if (!ok) throw new Error(t('commonApp.config.writeFailed'));
    MessagePlugin.success(t('commonApp.config.modelDeleted', { id: modelId }));
    loadProviders();
  } catch (e) {
    MessagePlugin.error(t('common.deleteFailed') + ': ' + e.message);
  }
};

// ==================== 下发到 Agent（主数据 → 各 agent 模型配置） ====================

const dispatchVisible = ref(false);
const dispatchInitialKeys = ref([]);

const openDispatchDialog = (providerName = "", modelId = "") => {
  dispatchInitialKeys.value = providerName && modelId ? [`${providerName}::${modelId}`] : [];
  dispatchVisible.value = true;
};

const refresh = () => {
  loading.value = true;
  setTimeout(() => { loadProviders(); loading.value = false; }, 50);
};

const copyText = (text) => {
  window.utools.copyText(text);
  MessagePlugin.success(t('common.copied'));
};

// ==================== 导入 / 导出（与 Claude Code 配置页同一套压缩 + 混淆字符串机制） ====================
const showImportDialog = ref(false);
const importString = ref("");

const handleExport = () => {
  if (!providers.value.length) return MessagePlugin.warning(t('commonApp.config.nothingToExport'));
  window.utools.copyText(window.services.encryptString(window.services.compressConfigs(providers.value)));
  MessagePlugin.success(t('commonApp.config.exported'));
};

const openImportDialog = () => { importString.value = ""; showImportDialog.value = true; };

const handleImport = () => {
  const str = importString.value.trim();
  if (!str) return MessagePlugin.warning(t('commonApp.config.importInputRequired'));
  const list = window.services.decompressConfigs(window.services.decryptString(str));
  if (!list || !Array.isArray(list)) return MessagePlugin.error(t('commonApp.config.importInvalid'));
  let ok = 0, skip = 0, fail = 0;
  for (const p of list) {
    if (!p || !p.name) { fail++; continue; }
    try {
      window.services.addCommonProvider({
        name: p.name,
        apiKey: p.apiKey || "",
        baseUrl: p.baseUrl || "",
        api: p.api || "openai-completions",
        headers: p.headers || {},
        authHeader: p.authHeader !== undefined ? p.authHeader : true,
        models: Array.isArray(p.models) ? p.models : [],
      });
      ok++;
    } catch (e) {
      // 优先用结构化错误码；旧版 preload 无 svcCode 时回退到中文消息判断
      const exists = e.svcCode ? e.svcCode === 'PROVIDER_EXISTS' : (e.message || "").includes("已存在");
      if (exists) skip++; else fail++;
    }
  }
  loadProviders();
  showImportDialog.value = false;
  if (ok > 0 && skip === 0 && fail === 0) MessagePlugin.success(t('commonApp.config.importSuccess', { count: ok }));
  else if (ok > 0) MessagePlugin.warning(t('commonApp.config.importPartial', { ok, skip, fail }));
  else if (skip > 0) MessagePlugin.warning(t('commonApp.config.importAllSkipped', { count: skip }));
  else MessagePlugin.error(t('commonApp.config.importFailed'));
};

onMounted(refresh);
</script>

<template>
  <div class="common-config-container">
    <div class="common-config-header">
      <span class="common-config-tip">
        {{ t('commonApp.config.tip') }}
      </span>
      <div class="common-config-actions">
        <Button size="small" variant="outline" @click="handleExport">
          <template #icon><DownloadIcon /></template> {{ t('commonApp.config.export') }}
        </Button>
        <Button size="small" variant="outline" @click="openImportDialog">
          <template #icon><UploadIcon /></template> {{ t('commonApp.config.import') }}
        </Button>
        <Tooltip :content="t('commonApp.config.dispatchTooltip')" placement="top">
          <Button size="small" variant="outline" @click="openDispatchDialog()">
            <template #icon><SendIcon /></template> {{ t('commonApp.config.dispatchToAgent') }}
          </Button>
        </Tooltip>
        <Tooltip :content="t('commonApp.config.addProvider')" placement="top">
          <Button size="small" variant="outline" @click="openAddProviderDialog">
            <template #icon><AddIcon /></template> {{ t('commonApp.config.addProvider') }}
          </Button>
        </Tooltip>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="providers.length === 0" class="common-config-empty">
      <Empty :description="t('commonApp.config.empty')" />
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
              <span class="common-model-count">{{ t('commonApp.config.modelCount', { count: prov.models.length }) }}</span>
              <Space size="small">
                <Tooltip :content="t('commonApp.config.testConnection')" placement="top">
                  <Button
                    size="small"
                    variant="text"
                    :aria-label="t('commonApp.config.testConnection')"
                    :loading="testRunning && testProviderName === prov.name"
                    @click="openTestDialog(prov)"
                  >
                    <template #icon><LinkIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip :content="t('commonApp.config.editConfig')" placement="top">
                  <Button size="small" variant="text" @click="handleEdit(prov)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm :content="t('commonApp.config.deleteProviderConfirm')" @confirm="handleDeleteProvider(prov.name)">
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
              <span v-if="prov.apiKey" class="common-info-value mono common-copyable" :title="t('commonApp.config.clickToCopy')" @click="copyText(prov.apiKey)">{{ prov.apiKey.slice(0, 8) + '...' + prov.apiKey.slice(-4) }}</span>
              <span v-else class="common-info-value mono">{{ t('common.notSet') }}</span>
            </div>
            <div class="common-info-row">
              <span class="common-info-label">Base URL</span>
              <span v-if="prov.baseUrl" class="common-info-value mono common-copyable" :title="t('commonApp.config.clickToCopy')" @click="copyText(prov.baseUrl)">{{ prov.baseUrl }}</span>
              <span v-else class="common-info-value mono">{{ t('common.default') }}</span>
            </div>
          </div>

          <div class="common-models-section">
            <div class="common-models-title">
              <span>{{ t('commonApp.config.modelList') }}</span>
              <Space size="small">
                <Button size="small" variant="text" @click="openAddModelDialog(prov.name)">
                  <template #icon><AddIcon /></template> {{ t('model.addTitle') }}
                </Button>
                <Button size="small" variant="text" @click="openBatchAddDialog(prov)">
                  <template #icon><AddIcon /></template> {{ t('commonApp.config.batchAdd') }}
                </Button>
              </Space>
            </div>
            <div class="common-model-item" v-for="m in prov.models" :key="m.id">
              <div class="common-model-info">
                <span class="common-model-name common-copyable" :title="t('commonApp.config.clickToCopy')" @click="copyText(m.id)">{{ m.name || m.id }}</span>
                <Tag v-if="m.reasoning" size="small" theme="warning" variant="light">{{ t('commonApp.config.reasoningTag') }}</Tag>
              </div>
              <div class="common-model-meta">
                <span class="common-model-stat">{{ t('commonApp.config.contextValue', { value: formatNumber(m.contextWindow) }) }}</span>
                <span class="common-model-stat">{{ t('commonApp.config.maxOutputValue', { value: formatNumber(m.maxTokens) }) }}</span>
                <span
                  v-for="mod in (m.input || []).filter((x) => x !== 'text')"
                  :key="mod"
                  class="common-model-stat"
                >{{ modalityLabel(mod) }}</span>
                <span v-if="m.reasoningEfforts && m.reasoningEfforts.length" class="common-model-stat">
                  {{ t('commonApp.config.effortValue', { value: m.reasoningEfforts.join(' / ') }) }}
                </span>
                <span v-if="m.capabilities && m.capabilities.length" class="common-model-stat">
                  {{ t('commonApp.config.capabilitiesValue', { value: m.capabilities.join(' / ') }) }}
                </span>
                <span v-if="m.cost && (m.cost.input || m.cost.output || m.cost.cacheRead || m.cost.cacheWrite)" class="common-model-stat">
                  {{ t('commonApp.config.costValue', { input: m.cost.input, output: m.cost.output }) }}
                </span>
              </div>
              <div class="common-model-actions" @click.stop>
                <Tooltip :content="t('commonApp.config.dispatchToAgent')" placement="top">
                  <Button size="small" variant="text" @click="openDispatchDialog(prov.name, m.id)">
                    <template #icon><SendIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip :content="t('model.editTitle')" placement="top">
                  <Button size="small" variant="text" @click="openEditModelDialog(prov.name, m)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Popconfirm :content="t('commonApp.config.deleteModelConfirm')" @confirm="handleDeleteModel(prov.name, m.id)">
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

    <!-- 供应商连接测试：逐模型请求并显示首字延时 / 错误 -->
    <Dialog
      v-model:visible="testVisible"
      :header="t('commonApp.config.testConnectionTitle', { name: testProviderName })"
      width="640px"
      class="common-test-dialog"
      @closed="handleTestDialogClosed"
    >
      <div class="common-test-hint">{{ t('commonApp.config.testProviderHint') }}</div>
      <div v-if="!testResults.length" class="common-test-empty">
        <Empty :description="t('commonApp.config.testNoModels')" />
      </div>
      <template v-else>
        <div class="common-test-summary">
          {{ t('commonApp.config.testSummary', {
            done: testDoneCount,
            total: testResults.length,
            ok: testOkCount,
            fail: testFailCount,
          }) }}
        </div>
        <div class="common-test-list">
          <div
            v-for="item in testResults"
            :key="item.id"
            class="common-test-row"
            :class="{ 'common-test-row-clickable': !testRunning && item.status !== 'testing' }"
            @click="testSingleModel(item)"
          >
            <div class="common-test-model">
              <div class="common-test-model-head">
                <span class="common-test-model-name">{{ item.name || item.id }}</span>
                <Tag size="small" variant="outline">{{ item.api }}</Tag>
              </div>
              <span v-if="item.name && item.name !== item.id" class="common-test-model-id mono">{{ item.id }}</span>
            </div>
            <div class="common-test-result">
              <span v-if="item.status === 'pending'" class="common-test-pending">
                {{ testRunning ? t('commonApp.config.testStatusPending') : t('commonApp.config.testClickToTest') }}
              </span>
              <template v-else-if="item.status === 'testing'">
                <Loading size="14px" />
                <span class="common-test-testing">{{ t('commonApp.config.testStatusTesting') }}</span>
              </template>
              <template v-else-if="item.status === 'success'">
                <CheckCircleFilledIcon class="common-test-icon-success" />
                <span class="common-test-success">{{ t('commonApp.config.testSuccess', { ms: item.latencyMs }) }}</span>
              </template>
              <template v-else>
                <ErrorCircleFilledIcon class="common-test-icon-error" />
                <Tooltip
                  :content="item.error"
                  placement="top"
                  overlay-class-name="common-test-tooltip"
                >
                  <span class="common-test-error">{{ item.error }}</span>
                </Tooltip>
              </template>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <Button
          theme="primary"
          :loading="testRunning"
          :disabled="!testResults.length"
          @click="startConnectionTests"
        >
          {{ t('commonApp.config.testAll') }}
        </Button>
        <Button variant="outline" @click="testVisible = false">{{ t('commonApp.config.testClose') }}</Button>
      </template>
    </Dialog>

    <Dialog
      v-model:visible="editDialog"
      :header="t('commonApp.config.editProviderTitle')"
      width="480px"
      :confirm-btn="{ content: t('common.save'), theme: 'primary' }"
      @confirm="handleSaveProvider"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>{{ t('commonApp.config.providerName') }}</label>
          <Input v-model="newProviderName" :placeholder="t('commonApp.config.providerNamePlaceholder')" />
        </div>
        <div class="common-form-item">
          <label>Base URL</label>
          <Input v-model="editForm.baseUrl" :placeholder="t('commonApp.config.baseUrlDefaultPlaceholder')" />
        </div>
        <div class="common-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="editForm.apiKey" :placeholder="t('commonApp.config.apiKeyPlaceholder')" />
        </div>
        <div class="common-form-item">
          <label>{{ t('commonApp.config.apiType') }}</label>
          <Select v-model="editForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="common-form-item">
          <label>{{ t('commonApp.config.autoAuthHeader') }}</label>
          <Switch v-model="editForm.authHeader" />
        </div>
        <div class="common-form-item">
          <label>{{ t('commonApp.config.customHeaders') }}</label>
          <DynamicKvEditor
            v-model="editForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            :key-placeholder="t('mcp.headerKeyPlaceholder')"
            :value-placeholder="t('mcp.headerValuePlaceholder')"
          />
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:visible="addProviderDialog"
      :header="t('commonApp.config.addProvider')"
      width="480px"
      :confirm-btn="{ content: t('common.add'), theme: 'primary' }"
      @confirm="handleAddProvider"
    >
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>{{ t('commonApp.config.providerName') }} <span class="common-form-required">*</span></label>
          <Input v-model="addProviderForm.name" :placeholder="t('commonApp.config.providerNameExample')" />
        </div>
        <div class="common-form-item">
          <label>Base URL</label>
          <Input v-model="addProviderForm.baseUrl" :placeholder="t('commonApp.config.baseUrlProviderPlaceholder')" />
        </div>
        <div class="common-form-item">
          <label>API Key</label>
          <ApiKeyInput v-model="addProviderForm.apiKey" :placeholder="t('commonApp.config.apiKeyPlaceholderOptional')" />
        </div>
        <div class="common-form-item">
          <label>{{ t('commonApp.config.apiType') }}</label>
          <Select v-model="addProviderForm.api" :options="API_TYPE_OPTIONS" />
        </div>
        <div class="common-form-item">
          <label>{{ t('commonApp.config.autoAuthHeader') }}</label>
          <Switch v-model="addProviderForm.authHeader" />
        </div>
        <div class="common-form-item">
          <label>{{ t('commonApp.config.customHeaders') }}</label>
          <DynamicKvEditor
            v-model="addProviderForm.headers"
            :key-options="HEADER_KEY_OPTIONS"
            :key-placeholder="t('mcp.headerKeyPlaceholder')"
            :value-placeholder="t('mcp.headerValuePlaceholder')"
          />
        </div>
      </div>
    </Dialog>

    <!-- 模型添加 / 编辑弹窗 -->
    <ModelFormDialog
      v-model:visible="modelFormVisible"
      :mode="modelFormMode"
      :provider-name="modelFormProviderName"
      :provider="modelFormProvider"
      :initial="modelFormInitial"
      :compat-key-options="COMPAT_KEY_OPTIONS"
      @confirm="handleModelFormConfirm"
    />

    <!-- 批量添加模型弹窗 -->
    <BatchAddModelsDialog
      v-model:visible="batchVisible"
      :provider="batchProvider"
      @added="loadProviders"
    />

    <!-- 下发到 Agent 弹窗 -->
    <DispatchDialog
      v-model:visible="dispatchVisible"
      :providers="providers"
      :initial-keys="dispatchInitialKeys"
    />

    <Dialog v-model:visible="showImportDialog" :header="t('commonApp.config.importTitle')" @confirm="handleImport" width="480px">
      <div class="common-edit-form">
        <div class="common-form-item">
          <label>{{ t('commonApp.config.importLabel') }}</label>
          <Textarea
            v-if="showImportDialog"
            v-model="importString"
            :placeholder="t('commonApp.config.importPlaceholder')"
            :autosize="{ minRows: 4, maxRows: 8 }"
          />
          <div class="common-form-hint">{{ t('commonApp.config.importHint') }}</div>
        </div>
      </div>
    </Dialog>
  </div>
</template>
