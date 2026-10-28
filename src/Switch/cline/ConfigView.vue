<script setup>
// Cline 模型配置页：~/.cline/data/settings/providers.json + models.json
// 与 Codex / Grok 的「供应商 → 模型」两层结构对齐，但文件布局不同：
//   providers.json  providers.<id>.settings = { provider, apiKey, model, baseUrl, headers }
//                   lastUsedProvider 记录当前使用（切换供应商 = 改这个字段）
//   models.json     providers.<id>.provider = { name, baseUrl, defaultModelId }
//                   providers.<id>.models.<modelId> = { id, name, contextWindow, maxTokens, capabilities }
//
// ⚠️ Cline 严格校验 providers.json（version 必须为 1、updatedAt 必须 ISO、tokenSource 枚举），
// 任一不合规会静默丢弃整档；服务层已做守卫，此处只负责提示。
// IDE 扩展侧的供应商配置在编辑器 globalState 里（不是文件），本页只覆盖 CLI / 桌面版 / SDK。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Empty, Button, Tag, Dialog, Input, MessagePlugin, Popconfirm, Select,
  Alert as TAlert, Tooltip, Link, Collapse, CollapsePanel, Checkbox, CheckboxGroup,
} from "tdesign-vue-next";
import {
  RefreshIcon, EditIcon, AddIcon, DeleteIcon, StarIcon, LockOnIcon, CheckCircleFilledIcon,
} from "tdesign-icons-vue-next";
import ApiKeyInput from "../../components/ApiKeyInput.vue";
import ModelLimitsFields from "../../components/ModelLimitsFields.vue";
import "./styles/ConfigView.css";

const { t } = useI18n();

// 与服务层 CLINE_CAPABILITIES 一致
const CAPABILITY_OPTIONS = ["streaming", "tools", "images", "reasoning"];

const loading = ref(false);
const warningMsg = ref("");
const providers = ref([]);
const expandedList = ref([]);

const formatNumber = (n) => {
  if (!n) return "";
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
};

const maskValue = (v) => {
  if (!v) return "";
  if (v.length <= 8) return "••••••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
};

// ==================== 数据加载 ====================

const refresh = () => {
  loading.value = true;
  warningMsg.value = "";
  try {
    providers.value = window.services.getClineProviderList() || [];
  } catch (e) {
    console.error("加载 Cline 配置失败:", e);
    warningMsg.value = e.message || t("common.loadFailed");
  } finally {
    loading.value = false;
  }
};

const installed = computed(() => {
  try {
    return window.services.isClineInstalled();
  } catch {
    return true;
  }
});

const openProvidersFile = () => {
  try { window.services.openClineProvidersFile(); } catch { /* ignore */ }
};

const providerLabel = (p) => p.displayName || p.id;

// ==================== 切换当前供应商 / 默认模型 ====================

const setActive = (p) => {
  try {
    window.services.setClineActiveProvider(p.id);
    MessagePlugin.success(t("cline.provider.activated", { name: providerLabel(p) }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("cline.provider.activateFailed", { message: e.message }));
    refresh();
  }
};

const setDefaultModel = (p, m) => {
  try {
    window.services.setClineDefaultModel(p.id, m.id);
    MessagePlugin.success(t("cline.model.defaultSet", { id: m.id }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("cline.model.saveFailed", { message: e.message }));
    refresh();
  }
};

const isDefaultModel = (p, m) => p.model === m.id || p.defaultModelId === m.id;

// ==================== 为什么「不生效」 ====================
// Cline 只跑 lastUsedProvider 指向的那条配置；条目被 zod 判废或 lastUsedProvider 悬空时，
// 它会静默回落到内置 cline 账号（表现为「模型配置不生效」），所以这两种情况必须显式提示。
const invalidReasonText = (p) =>
  t(`serviceAgent.cline.entryIssue.${p.invalidReason || "notObject"}`, { value: p.invalidValue || "" });

const entryIssues = computed(() => providers.value.filter((p) => !p.valid));

const danglingActive = computed(() => {
  try {
    return window.services.getClineDanglingActiveProvider() || "";
  } catch {
    return "";
  }
});

const hasActive = computed(() => providers.value.some((p) => p.isActive));

// ==================== 推理档位（settings.reasoning） ====================
// 档位写错会让 Cline 丢弃整个供应商条目，所以只允许从固定清单里选。
const reasoningOptions = computed(() => {
  const list = (() => {
    try {
      return window.services.CLINE_REASONING_EFFORTS || [];
    } catch {
      return [];
    }
  })();
  return [
    { label: t("cline.config.reasoningUnset"), value: "" },
    ...list.map((v) => ({ label: v, value: v })),
  ];
});

const setReasoning = (p, effort) => {
  try {
    window.services.setClineReasoning(p.id, effort == null ? "" : effort);
    MessagePlugin.success(t("cline.config.reasoningSaved"));
  } catch (e) {
    MessagePlugin.error(t("cline.config.reasoningSaveFailed", { message: e.message }));
  }
  refresh();
};

// ==================== 供应商弹窗 ====================

const providerDialog = ref(false);
const providerMode = ref("create"); // create | edit
const providerForm = ref({ id: "", displayName: "", baseUrl: "", apiKey: "" });
const editingProviderId = ref("");

const openAddProviderDialog = () => {
  providerMode.value = "create";
  editingProviderId.value = "";
  providerForm.value = { id: "", displayName: "", baseUrl: "", apiKey: "" };
  providerDialog.value = true;
};

const openEditProviderDialog = (p) => {
  providerMode.value = "edit";
  editingProviderId.value = p.id;
  providerForm.value = {
    id: p.id,
    displayName: p.displayName || "",
    baseUrl: p.baseUrl || "",
    apiKey: "", // 留空 = 不修改
  };
  providerDialog.value = true;
};

const submitProvider = () => {
  const f = providerForm.value;
  if (!String(f.id || "").trim()) {
    MessagePlugin.error(t("cline.provider.idRequired"));
    return;
  }
  try {
    if (providerMode.value === "create") {
      window.services.addClineProvider({
        id: f.id.trim(),
        displayName: f.displayName,
        baseUrl: f.baseUrl,
        apiKey: f.apiKey,
      });
      MessagePlugin.success(t("cline.provider.added", { name: f.id.trim() }));
    } else {
      const payload = { displayName: f.displayName, baseUrl: f.baseUrl };
      // 留空表示保持原 Key，避免「编辑其他字段却把 Key 清空」
      if (String(f.apiKey || "").trim()) payload.apiKey = f.apiKey;
      window.services.updateClineProvider(editingProviderId.value, payload);
      MessagePlugin.success(t("cline.provider.updated"));
    }
    providerDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(
      t(providerMode.value === "create" ? "cline.provider.addFailed" : "cline.provider.saveFailed", {
        message: e.message,
      })
    );
    refresh();
  }
};

const handleDeleteProvider = (p) => {
  try {
    window.services.deleteClineProvider(p.id);
    MessagePlugin.success(t("cline.provider.deleted", { name: providerLabel(p) }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("cline.provider.deleteFailed", { message: e.message }));
    refresh();
  }
};

// ==================== 模型弹窗 ====================

const modelDialog = ref(false);
const modelMode = ref("create"); // create | edit
const modelProviderId = ref("");
const editingModelId = ref("");
const modelForm = ref({
  id: "", name: "", contextWindow: 0, maxTokens: 0,
  capabilities: ["streaming", "tools"],
});

const openAddModelDialog = (p) => {
  modelMode.value = "create";
  modelProviderId.value = p.id;
  editingModelId.value = "";
  modelForm.value = {
    id: "", name: "", contextWindow: 0, maxTokens: 0,
    capabilities: ["streaming", "tools"],
  };
  modelDialog.value = true;
};

const openEditModelDialog = (p, m) => {
  modelMode.value = "edit";
  modelProviderId.value = p.id;
  editingModelId.value = m.id;
  modelForm.value = {
    id: m.id,
    name: m.name || "",
    contextWindow: m.contextWindow || 0,
    maxTokens: m.maxTokens || 0,
    capabilities: Array.isArray(m.capabilities) && m.capabilities.length
      ? [...m.capabilities]
      : ["streaming", "tools"],
  };
  modelDialog.value = true;
};

const submitModel = () => {
  const f = modelForm.value;
  if (!String(f.id || "").trim()) {
    MessagePlugin.error(t("cline.model.idRequired"));
    return;
  }
  const payload = {
    id: f.id.trim(),
    name: f.name,
    contextWindow: f.contextWindow,
    maxTokens: f.maxTokens,
    capabilities: f.capabilities,
  };
  try {
    if (modelMode.value === "create") {
      window.services.addClineModel(modelProviderId.value, payload);
      MessagePlugin.success(t("cline.model.added", { id: payload.id }));
    } else {
      window.services.updateClineModel(modelProviderId.value, editingModelId.value, payload);
      MessagePlugin.success(t("cline.model.updated"));
    }
    modelDialog.value = false;
    refresh();
  } catch (e) {
    MessagePlugin.error(
      t(modelMode.value === "create" ? "cline.model.addFailed" : "cline.model.saveFailed", {
        message: e.message,
      })
    );
    refresh();
  }
};

const handleDeleteModel = (p, m) => {
  try {
    window.services.deleteClineModel(p.id, m.id);
    MessagePlugin.success(t("cline.model.deleted", { id: m.id }));
    refresh();
  } catch (e) {
    MessagePlugin.error(t("cline.model.deleteFailed", { message: e.message }));
    refresh();
  }
};

onMounted(() => setTimeout(refresh, 50));
</script>

<template>
  <div class="cline-config-container">
    <!-- 顶部工具栏：路径提示 + 操作 -->
    <div class="cline-toolbar">
      <div class="cline-toolbar-left">
        <span class="cline-toolbar-tip">
          <Link theme="primary" :underline="true" @click="openProvidersFile">~/.cline/data/settings/providers.json</Link>
          <span class="cline-toolbar-sub">{{ t("cline.config.toolbarSubtitle") }}</span>
        </span>
      </div>
      <div class="cline-toolbar-right">
        <Button size="small" variant="outline" theme="primary" @click="openAddProviderDialog">
          <template #icon><AddIcon /></template> {{ t("cline.config.addProvider") }}
        </Button>
        <Tooltip :content="t('common.refresh')" placement="top">
          <Button size="small" variant="outline" :loading="loading" @click="refresh">
            <template #icon><RefreshIcon /></template>
          </Button>
        </Tooltip>
      </div>
    </div>

    <div v-if="warningMsg" class="cline-config-warning">
      <TAlert :message="warningMsg" theme="warning" show-icon />
    </div>

    <!-- 条目被判废 / 当前使用悬空：Cline 会静默回落内置 cline 账号，必须显式说明 -->
    <div v-if="!loading && providers.length > 0 && entryIssues.length > 0" class="cline-config-warning">
      <TAlert theme="error" show-icon>
        <template #message>
          <div class="cline-issue-list">
            <div>{{ t("cline.config.entryInvalidTitle") }}</div>
            <div v-for="p in entryIssues" :key="p.id" class="cline-issue-item">
              <span class="mono">{{ p.id }}</span> — {{ invalidReasonText(p) }}
            </div>
          </div>
        </template>
      </TAlert>
    </div>

    <div v-if="!loading && providers.length > 0 && !hasActive" class="cline-config-warning">
      <TAlert
        :message="
          t('cline.config.noActiveWarning', {
            id: danglingActive || '—',
          })
        "
        theme="warning"
        show-icon
      />
    </div>

    <div v-if="!installed" class="cline-config-warning">
      <TAlert :message="t('cline.config.notInstalled')" theme="info" show-icon />
    </div>

    <template v-if="!loading">
      <div v-if="providers.length === 0" class="cline-config-empty">
        <Empty :description="t('cline.config.emptyProviders')">
          <template #action>
            <Button theme="primary" @click="openAddProviderDialog">
              <template #icon><AddIcon /></template> {{ t("cline.config.addProvider") }}
            </Button>
          </template>
        </Empty>
      </div>

      <div v-else class="cline-provider-list">
        <Collapse v-model="expandedList" class="cline-provider-collapse">
          <CollapsePanel v-for="p in providers" :key="p.id" :value="p.id">
            <template #header>
              <div class="cline-provider-header-left">
                <span class="cline-provider-name">{{ providerLabel(p) }}</span>
                <Tag v-if="p.isActive" size="small" theme="success" variant="light">
                  {{ t("cline.config.activeTag") }}
                </Tag>
                <Tag v-else-if="!p.valid" size="small" theme="danger" variant="light">
                  {{ t("cline.config.invalidTag") }}
                </Tag>
                <Tag size="small" variant="outline">
                  {{ p.providerType || t("cline.providerType.openaiCompatible") }}
                </Tag>
                <span class="cline-model-count">{{ t("cline.config.modelCount", { count: p.models.length }) }}</span>
              </div>
            </template>
            <template #headerRightContent>
              <div class="cline-provider-header-right" @click.stop>
                <Tooltip v-if="!p.isActive" :content="t('cline.config.setActiveTooltip')" placement="top">
                  <Button size="small" theme="success" variant="text" :disabled="!p.valid" @click="setActive(p)">
                    <template #icon><CheckCircleFilledIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip :content="t('cline.config.editProvider')" placement="top">
                  <Button size="small" theme="default" variant="text" @click="openEditProviderDialog(p)">
                    <template #icon><EditIcon /></template>
                  </Button>
                </Tooltip>
                <Tooltip :content="t('cline.config.deleteProvider')" placement="top">
                  <Popconfirm
                    :content="t('cline.config.deleteProviderConfirm', { name: providerLabel(p) })"
                    theme="danger"
                    @confirm="handleDeleteProvider(p)"
                  >
                    <Button size="small" theme="danger" variant="text">
                      <template #icon><DeleteIcon /></template>
                    </Button>
                  </Popconfirm>
                </Tooltip>
              </div>
            </template>

            <template #content>
              <div class="cline-provider-body">
                <TAlert
                  v-if="!p.valid"
                  :message="t('cline.config.entryInvalidHint', { reason: invalidReasonText(p) })"
                  theme="error"
                  show-icon
                  class="cline-provider-invalid"
                />
                <div class="cline-provider-details">
                  <div class="cline-detail-item">
                    <span class="cline-detail-label">Provider ID</span>
                    <span class="cline-detail-value mono">{{ p.id }}</span>
                  </div>
                  <div class="cline-detail-item">
                    <span class="cline-detail-label">Base URL</span>
                    <span class="cline-detail-value mono">{{ p.baseUrl || "—" }}</span>
                  </div>
                  <div class="cline-detail-item">
                    <span class="cline-detail-label">API Key</span>
                    <span class="cline-detail-value mono">
                      <LockOnIcon v-if="p.hasApiKey" size="12px" class="cline-key-lock" />
                      {{ p.hasApiKey ? maskValue(p.apiKey) : "—" }}
                    </span>
                  </div>
                  <div class="cline-detail-item">
                    <span class="cline-detail-label">Updated</span>
                    <span class="cline-detail-value mono">{{ p.updatedAt || "—" }}</span>
                  </div>
                  <!-- 推理档位：写进 providers.json 的 settings.reasoning，Cline 下一次会话读取 -->
                  <div class="cline-detail-item">
                    <span class="cline-detail-label">{{ t("cline.config.reasoningLabel") }}</span>
                    <Select
                      :value="p.reasoningEnabled === false ? 'none' : p.reasoningEffort"
                      :options="reasoningOptions"
                      size="small"
                      @change="(v) => setReasoning(p, v)"
                    />
                    <span v-if="p.reasoningInvalid" class="cline-detail-hint cline-detail-hint-error">
                      {{ t("cline.config.reasoningInvalidHint") }}
                    </span>
                  </div>
                </div>

                <div class="cline-models-section">
                  <div class="cline-models-title">
                    <span>{{ t("cline.config.modelsTitle") }}</span>
                    <Button size="small" variant="text" @click="openAddModelDialog(p)">
                      <template #icon><AddIcon /></template> {{ t("cline.config.addModel") }}
                    </Button>
                  </div>
                  <div v-if="p.models.length === 0" class="cline-models-empty">
                    {{ t("cline.config.modelsEmpty") }}
                  </div>
                  <div v-else class="cline-model-list">
                    <div v-for="m in p.models" :key="m.id" class="cline-model-item">
                      <div class="cline-model-info">
                        <span class="cline-model-name">{{ m.id }}</span>
                        <span v-if="m.name && m.name !== m.id" class="cline-model-sub">{{ m.name }}</span>
                        <span v-if="m.contextWindow" class="cline-model-sub">{{ formatNumber(m.contextWindow) }} ctx</span>
                        <span v-if="m.maxTokens" class="cline-model-sub">{{ formatNumber(m.maxTokens) }} out</span>
                        <Tag v-for="c in m.capabilities" :key="c" size="small" variant="outline">{{ c }}</Tag>
                        <Tag v-if="isDefaultModel(p, m)" size="small" theme="warning" variant="light">
                          {{ t("cline.config.defaultTag") }}
                        </Tag>
                      </div>
                      <div class="cline-model-actions" @click.stop>
                        <Tooltip v-if="!isDefaultModel(p, m)" :content="t('cline.config.setDefaultTooltip')" placement="top">
                          <Button size="small" theme="warning" variant="text" @click="setDefaultModel(p, m)">
                            <template #icon><StarIcon /></template>
                          </Button>
                        </Tooltip>
                        <Tooltip :content="t('common.edit')" placement="top">
                          <Button size="small" theme="default" variant="text" @click="openEditModelDialog(p, m)">
                            <template #icon><EditIcon /></template>
                          </Button>
                        </Tooltip>
                        <Popconfirm
                          :content="t('cline.config.deleteModelConfirm', { id: m.id })"
                          theme="danger"
                          @confirm="handleDeleteModel(p, m)"
                        >
                          <Button size="small" theme="danger" variant="text">
                            <template #icon><DeleteIcon /></template>
                          </Button>
                        </Popconfirm>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </CollapsePanel>
        </Collapse>
      </div>

      <TAlert :message="t('cline.config.settingsWarn')" theme="info" show-icon />
    </template>

    <!-- 供应商弹窗 -->
    <Dialog
      v-model:visible="providerDialog"
      :header="providerMode === 'create' ? t('cline.config.addProvider') : t('cline.config.editProvider')"
      :confirm-btn="t('common.save')"
      @confirm="submitProvider"
    >
      <div class="cline-edit-form">
        <div class="cline-form-item">
          <label>{{ t("cline.config.providerIdLabel") }} <span class="cline-form-required">*</span></label>
          <Input v-model="providerForm.id" :disabled="providerMode === 'edit'" placeholder="openai-compatible" />
          <span class="cline-form-hint">{{ t("cline.config.providerIdHint") }}</span>
        </div>
        <div class="cline-form-item">
          <label>{{ t("cline.config.displayNameLabel") }}</label>
          <Input v-model="providerForm.displayName" placeholder="magpie" />
          <span class="cline-form-hint">{{ t("cline.config.displayNameHint") }}</span>
        </div>
        <div class="cline-form-item">
          <label>{{ t("cline.config.baseUrlLabel") }}</label>
          <Input v-model="providerForm.baseUrl" placeholder="https://api.example.com/v1" />
          <span class="cline-form-hint">{{ t("cline.config.baseUrlHint") }}</span>
        </div>
        <div class="cline-form-item">
          <label>{{ t("cline.config.apiKeyLabel") }}</label>
          <ApiKeyInput
            v-model="providerForm.apiKey"
            :placeholder="providerMode === 'edit' ? t('cline.config.apiKeySavedPlaceholder') : t('cline.config.apiKeyPlaceholder')"
          />
        </div>
      </div>
    </Dialog>

    <!-- 模型弹窗 -->
    <Dialog
      v-model:visible="modelDialog"
      :header="modelMode === 'create' ? t('cline.config.addModelTitle') : t('cline.config.editModelTitle')"
      :confirm-btn="t('common.save')"
      @confirm="submitModel"
    >
      <div class="cline-edit-form">
        <div class="cline-form-item">
          <label>{{ t("cline.config.modelIdLabel") }} <span class="cline-form-required">*</span></label>
          <Input v-model="modelForm.id" placeholder="deepseek-chat" />
          <span class="cline-form-hint">{{ t("cline.config.modelIdHint") }}</span>
        </div>
        <div class="cline-form-item">
          <label>{{ t("cline.config.nameLabel") }}</label>
          <Input v-model="modelForm.name" :placeholder="t('cline.config.namePlaceholder')" />
        </div>
        <ModelLimitsFields
          v-model:context="modelForm.contextWindow"
          v-model:output="modelForm.maxTokens"
          item-class="cline-form-item"
        />
        <div class="cline-form-item">
          <label>{{ t("cline.config.capabilitiesLabel") }}</label>
          <CheckboxGroup v-model="modelForm.capabilities">
            <Checkbox v-for="c in CAPABILITY_OPTIONS" :key="c" :value="c">{{ c }}</Checkbox>
          </CheckboxGroup>
          <span class="cline-form-hint">{{ t("cline.config.capabilitiesHint") }}</span>
        </div>
      </div>
    </Dialog>
  </div>
</template>
