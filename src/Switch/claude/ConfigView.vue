<script setup>
import { ref, onMounted, computed, watch } from "vue";
import {
  Button,
  Input,
  AutoComplete,
  Dialog,
  MessagePlugin,
  Tag,
  Space,
  Empty,
  Popconfirm,
  Textarea,
  Tooltip,
  RadioGroup,
  RadioButton,
  Checkbox,
  Divider,
} from "tdesign-vue-next";
import {
  AddIcon,
  RefreshIcon,
  DownloadIcon,
  UploadIcon,
  PlayIcon,
  EditIcon,
  DeleteIcon,
  SettingIcon,
} from "tdesign-icons-vue-next";
import { useConfigColumns } from "../../composables/useConfigColumns";
import { useConfigImportExport } from "../../composables/useConfigImportExport";
import { useConfigSwitch } from "../../composables/useConfigSwitch";
import { useExtraFields } from "../../composables/useExtraFields";
import { managedFields } from "../../constants";
import "./styles/ConfigView.css";

const strip1m = (v) => (v || '').replace(/\[1m\]$/i, '');
const has1m = (v) => /\[1m\]$/i.test(v || '');

// OpenCode Go 预设：baseUrl 固定，模型候选由 /v1/models 实时获取（不写死）
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go";

const effortLevelClass = (level) => level ? `effort-${level}` : '';

const DB_PREFIX = "ccswitch_config_";

const currentConfig = ref({
  key: "",
  authVar: "ANTHROPIC_AUTH_TOKEN",
  baseUrl: "",
  model: "",
  defaultHaikuModel: "",
  defaultSonnetModel: "",
  defaultOpusModel: "",
  subagentModel: "",
});
const savedConfigs = ref([]);
const showDialog = ref(false);
const editingConfig = ref(null);
const dialogTab = ref("basic");
const showPreviewDialog = ref(false);
const previewConfig = ref(null);
const showBatchEditDialog = ref(false);
const batchEditGroup = ref(null);
const batchUrl = ref("");
const batchKey = ref("");
const formData = ref({
  name: "",
  key: "",
  authVar: "ANTHROPIC_AUTH_TOKEN",
  baseUrl: "",
  model: "",
  model1m: false,
  defaultHaikuModel: "",
  defaultHaikuModel1m: false,
  defaultSonnetModel: "",
  defaultSonnetModel1m: false,
  defaultOpusModel: "",
  defaultOpusModel1m: false,
  defaultFableModel: "",
  defaultFableModel1m: false,
  subagentModel: "",
  subagentModel1m: false,
  extraFields: [],
});

// 模型候选：编辑配置时从 {baseUrl}/models 实时获取（任意供应商；OpenCode Go 额外自动切认证方式）
const modelCandidates = ref([]);
let _candidatesTimer = null;

const loadModelCandidates = async () => {
  const baseUrl = (formData.value.baseUrl || '').trim();
  if (!baseUrl) {
    modelCandidates.value = [];
    return;
  }
  try {
    const models = await window.services.fetchProviderModels(baseUrl, formData.value.key || '');
    // 请求期间 URL 已变化 → 丢弃过期结果
    if ((formData.value.baseUrl || '').trim() !== baseUrl) return;
    const ids = [...new Set((models || []).map(m => m.id).filter(Boolean))];
    modelCandidates.value = ids.map(id => ({ label: id, value: id }));
  } catch {
    // 获取失败静默保持为空，不打断编辑
    if ((formData.value.baseUrl || '').trim() === baseUrl) modelCandidates.value = [];
  }
};

const scheduleLoadModelCandidates = () => {
  clearTimeout(_candidatesTimer);
  _candidatesTimer = setTimeout(loadModelCandidates, 500);
};

// URL 为 OpenCode Go 时自动切认证方式；URL/Key 变化后防抖拉取模型候选
const syncOpencodeGoFromUrl = (url) => {
  const clean = (url || '').trim().replace(/\/+$/, '');
  if (clean === OPENCODE_GO_BASE_URL) formData.value.authVar = 'ANTHROPIC_API_KEY';
};
watch(() => formData.value.baseUrl, (url) => {
  syncOpencodeGoFromUrl(url);
  scheduleLoadModelCandidates();
});
watch(() => formData.value.key, scheduleLoadModelCandidates);

// 当用户手动在输入框输入 [1m] 时，同步勾选复选框并自动清除输入中的 [1m]
// 输入框为空时，同步取消勾选 1m
const modelFields = ['model', 'defaultHaikuModel', 'defaultSonnetModel', 'defaultOpusModel', 'defaultFableModel', 'subagentModel'];
modelFields.forEach(field => {
  watch(() => formData.value[field], (val) => {
    if (!val || val.trim() === '') {
      formData.value[field + '1m'] = false;
      return;
    }
    if (has1m(val)) {
      formData.value[field] = strip1m(val);
      formData.value[field + '1m'] = true;
    }
  });
});

// Convert model fields from a config object to formData shape (strip [1m] suffix into separate booleans)
const configModelsToForm = (src) => {
  const result = {};
  modelFields.forEach(field => {
    result[field] = strip1m(src[field] || '');
    result[field + '1m'] = has1m(src[field] || '');
  });
  return result;
};

const dialogTitle = computed(() => (editingConfig.value ? "编辑配置" : "新建配置"));

const hasModelFields = computed(() =>
  currentConfig.value.model || currentConfig.value.defaultHaikuModel ||
  currentConfig.value.defaultSonnetModel || currentConfig.value.defaultOpusModel ||
  currentConfig.value.defaultFableModel || currentConfig.value.subagentModel
);

const loadCurrentConfig = () => {
  const settings = window.services.readClaudeSettings();
  if (settings?.env) {
    // 镜像 Claude Code 优先级：AUTH_TOKEN 优先，为空才读 API_KEY
    const authToken = settings.env.ANTHROPIC_AUTH_TOKEN || "";
    const apiKey = settings.env.ANTHROPIC_API_KEY || "";
    const authVar = authToken ? 'ANTHROPIC_AUTH_TOKEN' : (apiKey ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN');
    currentConfig.value = {
      key: authToken || apiKey,
      authVar,
      baseUrl: settings.env.ANTHROPIC_BASE_URL || "",
      model: settings.env.ANTHROPIC_MODEL || "",
      defaultHaikuModel: settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "",
      defaultSonnetModel: settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "",
      defaultOpusModel: settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL || "",
      defaultFableModel: settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL || "",
      subagentModel: settings.env.CLAUDE_CODE_SUBAGENT_MODEL || "",
    };
  }
};

const loadSavedConfigs = () => {
  savedConfigs.value = window.utools.db
    .allDocs()
    .filter((d) => d._id.startsWith(DB_PREFIX))
    .map((d) => {
      const hasOldFields = d.apiTimeoutMs !== undefined || d.disableNonessentialTraffic !== undefined;
      if (hasOldFields) {
        const cleanDoc = {
          _id: d._id,
          _rev: d._rev,
          name: d.name,
          key: d.key,
          baseUrl: d.baseUrl,
          model: d.model,
          defaultHaikuModel: d.defaultHaikuModel || "",
          defaultSonnetModel: d.defaultSonnetModel || "",
          defaultOpusModel: d.defaultOpusModel || "",
          defaultFableModel: d.defaultFableModel || "",
          subagentModel: d.subagentModel || "",
          authVar: d.authVar || 'ANTHROPIC_AUTH_TOKEN',
          extraFields: d.extraFields || [],
          updatedAt: d.updatedAt,
        };
        window.utools.db.put(cleanDoc);
      }
      const createdAt = parseInt(d._id.replace(DB_PREFIX, "")) || d.updatedAt || 0;
      return {
        id: d._id,
        name: d.name,
        key: window.services.decryptKey(d.key),
        authVar: d.authVar || 'ANTHROPIC_AUTH_TOKEN',
        baseUrl: d.baseUrl,
        model: d.model,
        defaultHaikuModel: d.defaultHaikuModel || "",
        defaultSonnetModel: d.defaultSonnetModel || "",
        defaultOpusModel: d.defaultOpusModel || "",
        defaultFableModel: d.defaultFableModel || "",
        subagentModel: d.subagentModel || "",
        extraFields: d.extraFields || [],
        updatedAt: d.updatedAt,
        createdAt,
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt);
};

const {
  leftColumn, rightColumn, dragState, groupOrder,
  loadGroupOrder, onDragMouseDown,
} = useConfigColumns(savedConfigs);

const {
  showImportStringDialog, importString,
  handleExportAsString, openImportStringDialog, handleImportFromString,
} = useConfigImportExport(savedConfigs, loadSavedConfigs);

const maskKey = (key) => {
  if (!key || key.length < 8) return key || "";
  return key.substring(0, 6) + "***" + key.substring(key.length - 4);
};

const openPreviewDialog = (config) => {
  previewConfig.value = config;
  showPreviewDialog.value = true;
};

const openCreateDialog = () => {
  editingConfig.value = null;
  dialogTab.value = "basic";
  loadGlobalExtraFields();
  formData.value = {
    name: "",
    key: "",
    authVar: "ANTHROPIC_AUTH_TOKEN",
    baseUrl: "",
    ...configModelsToForm({}),
    extraFields: [],
  };
  syncDialogPresets([]);
  showDialog.value = true;
};

const openEditDialog = (config) => {
  editingConfig.value = config;
  dialogTab.value = "basic";
  loadGlobalExtraFields();
  const fields = (config.extraFields || []).map(f => ({ ...f }));
  formData.value = {
    name: config.name,
    key: config.key,
    authVar: config.authVar || 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: config.baseUrl,
    ...configModelsToForm(config),
    extraFields: fields,
  };
  syncDialogPresets(fields);
  scheduleLoadModelCandidates();
  showDialog.value = true;
};

const fillCurrentConfig = () => {
  formData.value.key = currentConfig.value.key;
  formData.value.authVar = currentConfig.value.authVar || 'ANTHROPIC_AUTH_TOKEN';
  formData.value.baseUrl = currentConfig.value.baseUrl;
  Object.assign(formData.value, configModelsToForm(currentConfig.value));
};

const addDialogExtraField = () => formData.value.extraFields.push({ key: "", value: "" });
const removeDialogExtraField = (idx) => formData.value.extraFields.splice(idx, 1);

// 配置弹窗中的预设状态
const dialogPresetValues = ref({});
const dialogCustomFields = computed(() =>
  (formData.value.extraFields || []).filter(f => !presetKeys.has(f.key?.trim()))
);
// 全局字段中属于预设的，用 disabled checkbox/radio 展示
const globalPresetValues = computed(() => {
  const pv = {};
  envPresets.forEach(preset => {
    const found = extraFields.value.find(f => f.key?.trim() === preset.key);
    if (preset.type === 'boolean') {
      pv[preset.key] = !!found;
    } else {
      pv[preset.key] = found ? found.value?.trim() || '' : '';
    }
  });
  return pv;
});
const globalCustomFields = computed(() =>
  extraFields.value.filter(f => !presetKeys.has(f.key?.trim()))
);
const syncDialogPresets = (fields) => {
  const pv = {};
  envPresets.forEach(preset => {
    const found = fields.find(f => f.key?.trim() === preset.key);
    if (preset.type === 'boolean') {
      pv[preset.key] = found ? true : false;
    } else {
      pv[preset.key] = found ? found.value?.trim() || '' : '';
    }
  });
  dialogPresetValues.value = pv;
};

const saveConfig = () => {
  if (!formData.value.name.trim()) return MessagePlugin.warning("请输入配置名称");
  if (!formData.value.key.trim()) return MessagePlugin.warning("请输入 Key");
  if (!formData.value.baseUrl.trim()) return MessagePlugin.warning("请输入 URL");

  const now = Date.now();
  const id = editingConfig.value ? editingConfig.value.id : DB_PREFIX + now;
  // 合并预设 + 自定义字段
  const cleanExtraFields = mergePresetsToFields(formData.value.extraFields || [], dialogPresetValues.value)
    .map(f => ({ key: f.key.trim(), value: f.value?.trim() || "" }));
  // 检查重复 key
  const extraKeys = cleanExtraFields.map(f => f.key);
  const duplicateKey = extraKeys.find((k, i) => extraKeys.indexOf(k) !== i);
  if (duplicateKey) return MessagePlugin.warning(`env字段 key 重复: ${duplicateKey}`);
  const buildModelValue = (field, checked) => {
    const stripped = strip1m(formData.value[field].trim());
    return checked ? stripped + '[1m]' : stripped;
  };

  const doc = {
    _id: id,
    name: formData.value.name.trim(),
    key: window.services.encryptKey(formData.value.key.trim()),
    authVar: formData.value.authVar || 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: formData.value.baseUrl.trim(),
    model: buildModelValue('model', formData.value.model1m),
    defaultHaikuModel: buildModelValue('defaultHaikuModel', formData.value.defaultHaikuModel1m),
    defaultSonnetModel: buildModelValue('defaultSonnetModel', formData.value.defaultSonnetModel1m),
    defaultOpusModel: buildModelValue('defaultOpusModel', formData.value.defaultOpusModel1m),
    defaultFableModel: buildModelValue('defaultFableModel', formData.value.defaultFableModel1m),
    subagentModel: buildModelValue('subagentModel', formData.value.subagentModel1m),
    extraFields: cleanExtraFields,
    updatedAt: now,
  };
  if (editingConfig.value) doc._rev = window.utools.db.get(id)._rev;

  if (window.utools.db.put(doc).ok) {
    // 保存使用过的字段名到候选列表
    saveExtraFieldKeys(cleanExtraFields.map(f => f.key));
    MessagePlugin.success(editingConfig.value ? "配置已更新" : "配置已保存");
    showDialog.value = false;
    loadSavedConfigs();
    // 如果编辑的是当前启用的配置，自动重新启用
    if (editingConfig.value && isCurrentConfig(editingConfig.value)) {
      switchConfig({
        ...doc,
        key: formData.value.key.trim(),
        extraFields: cleanExtraFields,
      });
    }
  } else {
    MessagePlugin.error("保存失败");
  }
};

const deleteConfig = (config) => {
  if (window.utools.db.remove(config.id).ok) {
    MessagePlugin.success("配置已删除");
    loadSavedConfigs();
  } else {
    MessagePlugin.error("删除失败");
  }
};

const { switchConfig, isCurrentConfig } = useConfigSwitch(currentConfig, loadCurrentConfig);

const openBatchEditDialog = (group) => {
  batchEditGroup.value = group;
  batchUrl.value = group.baseUrl;
  batchKey.value = group.key;
  showBatchEditDialog.value = true;
};

const saveBatchEdit = () => {
  const group = batchEditGroup.value;
  if (!group) return;
  const url = batchUrl.value.trim();
  const key = batchKey.value.trim();
  if (!url) return MessagePlugin.warning("请输入 URL");
  if (!key) return MessagePlugin.warning("请输入 Key");

  const now = Date.now();
  let activeConfig = null;

  group.configs.forEach(config => {
    const existing = window.utools.db.get(config.id);
    if (!existing) return;
    const doc = {
      ...existing,
      baseUrl: url,
      key: window.services.encryptKey(key),
      updatedAt: now,
    };
    if (window.utools.db.put(doc).ok) {
      if (isCurrentConfig(config)) activeConfig = config;
    }
  });

  const count = group.configs.length;
  MessagePlugin.success(`已更新 ${count} 个配置`);
  showBatchEditDialog.value = false;
  batchEditGroup.value = null;
  loadSavedConfigs();
  if (activeConfig) {
    switchConfig({ ...activeConfig, baseUrl: url, key });
  }
};

// 首次打开检测：新设备上自动将当前配置入库
const checkFirstOpen = () => {
  const marker = window.utools.db.get('ccswitch_first_open_done');
  if (marker) return;

  // 已经有过配置（老用户升级），跳过首次入库
  const existingConfigs = window.utools.db.allDocs().filter(d => d._id.startsWith(DB_PREFIX));
  if (existingConfigs.length > 0) {
    window.utools.db.put({ _id: 'ccswitch_first_open_done', done: true });
    return;
  }

  const settings = window.services.readClaudeSettings();
  const token = settings?.env?.ANTHROPIC_AUTH_TOKEN;
  const apiKey = settings?.env?.ANTHROPIC_API_KEY;
  const url = settings?.env?.ANTHROPIC_BASE_URL;

  if ((token || apiKey) && url) {
    const now = Date.now();
    const authVar = token ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
    const doc = {
      _id: DB_PREFIX + now,
      name: 'default',
      key: window.services.encryptKey(token || apiKey),
      authVar,
      baseUrl: url,
      model: settings.env.ANTHROPIC_MODEL || '',
      defaultHaikuModel: settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
      defaultSonnetModel: settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
      defaultOpusModel: settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL || '',
      subagentModel: settings.env.CLAUDE_CODE_SUBAGENT_MODEL || '',
      extraFields: [],
      updatedAt: now,
    };
    window.utools.db.put(doc);
  }

  window.utools.db.put({ _id: 'ccswitch_first_open_done', done: true });
};

// 清除敏感配置
const hasSensitiveConfig = computed(() =>
  !!(currentConfig.value.key || currentConfig.value.baseUrl || currentConfig.value.model ||
     currentConfig.value.defaultHaikuModel || currentConfig.value.defaultSonnetModel ||
     currentConfig.value.defaultOpusModel || currentConfig.value.defaultFableModel || currentConfig.value.subagentModel)
);

const showClearDialog = ref(false);

const clearConfirmContent = computed(() => {
  const items = [];
  if (currentConfig.value.key) items.push(`Token (${currentConfig.value.authVar || 'ANTHROPIC_AUTH_TOKEN'})`);
  if (currentConfig.value.baseUrl) items.push('URL (ANTHROPIC_BASE_URL)');
  if (currentConfig.value.model) items.push('默认模型 (ANTHROPIC_MODEL)');
  if (currentConfig.value.defaultHaikuModel) items.push('Haiku 模型');
  if (currentConfig.value.defaultSonnetModel) items.push('Sonnet 模型');
  if (currentConfig.value.defaultOpusModel) items.push('Opus 模型');
  if (currentConfig.value.defaultFableModel) items.push('Fable 模型');
  if (currentConfig.value.subagentModel) items.push('Subagent 模型');
  return items.map((s, i) => (i + 1) + '. ' + s).join('\n');
});

const confirmClearConfig = () => {
  const settings = window.services.readClaudeSettings();
  if (!settings?.env) return;

  managedFields.forEach(key => delete settings.env[key]);

  if (window.services.writeClaudeSettings(settings)) {
    MessagePlugin.success('已清除配置');
    showClearDialog.value = false;
    loadCurrentConfig();
  } else {
    MessagePlugin.error('清除失败');
  }
};

const {
  showExtraFieldsDialog, extraFields, customFields, presetValues, activeConfigExtras, extraFieldKeyOptions,
  loadExtraFieldKeys, loadGlobalExtraFields, openExtraFieldsDialog, addExtraField, removeExtraField, saveExtraFields, saveExtraFieldKeys,
  syncPresetsFromFields, mergePresetsToFields, envPresets, presetKeys,
} = useExtraFields(loadCurrentConfig, savedConfigs, isCurrentConfig);

const reloadFromSettings = () => {
  const settings = window.services.readClaudeSettings() || {};
  const env = settings.env || {};
  const managedKeys = [
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  ];
  extraFields.value = [];
  Object.keys(env).forEach(key => {
    if (!managedKeys.includes(key)) {
      extraFields.value.push({ key, value: String(env[key]) });
    }
  });
  syncPresetsFromFields(extraFields.value);
  MessagePlugin.success('已从 settings.json 读取');
};

const skipLogin = ref(false);

const loadSkipLogin = () => {
  const config = window.services.readClaudeJson();
  skipLogin.value = !!config.hasCompletedOnboarding;
};

const toggleSkipLogin = (val) => {
  const config = window.services.readClaudeJson();
  if (val) {
    config.hasCompletedOnboarding = true;
  } else {
    delete config.hasCompletedOnboarding;
  }
  if (window.services.writeClaudeJson(config)) {
    skipLogin.value = val;
  } else {
    MessagePlugin.error('写入 .claude.json 失败');
  }
};

const openSettingsFile = () => {
  const filePath = window.services.getClaudeSettingsPath();
  window.utools.shellOpenPath(filePath);
};

const copyModelName = (name) => {
  window.utools.copyText(name);
  MessagePlugin.success('已复制: ' + name);
};

onMounted(() => { loadCurrentConfig(); checkFirstOpen(); loadSavedConfigs(); loadExtraFieldKeys(); loadGroupOrder(); loadSkipLogin(); });
</script>

<template>
  <div class="config-view">
    <div class="section-header">
      <span class="section-tip">直接编辑 <span class="hint-link" @click="openSettingsFile">settings.json</span><span class="section-tip-divider">|</span><Checkbox v-model="skipLogin" @change="toggleSkipLogin" class="skip-login-checkbox">跳过登录验证</Checkbox></span>
      <Space size="small">
        <Button size="small" variant="outline" @click="handleExportAsString"><template #icon><DownloadIcon /></template> 导出</Button>
        <Button size="small" variant="outline" @click="openImportStringDialog"><template #icon><UploadIcon /></template> 导入</Button>
        <Button size="small" theme="primary" @click="openCreateDialog"><template #icon><AddIcon /></template> 新建配置</Button>
        <Tooltip content="刷新" placement="top"><Button size="small" variant="outline" @click="loadSavedConfigs"><template #icon><RefreshIcon /></template></Button></Tooltip>
      </Space>
    </div>

    <!-- 当前配置展示 -->
    <div class="current-config-card">
      <div class="current-config-header">
        <div class="current-config-header-left">
          <span class="current-config-title">当前生效配置</span>
          <span
            class="clear-sensitive-btn"
            :class="{ disabled: !hasSensitiveConfig }"
            @click="hasSensitiveConfig && (showClearDialog = true)"
          >清除配置</span>
        </div>
        <Button size="small" theme="primary" variant="text" @click="openExtraFieldsDialog"><template #icon><SettingIcon /></template>env其他字段设置</Button>
      </div>
      <div class="current-config-content">
        <div class="current-config-main">
          <span class="current-config-token">{{ maskKey(currentConfig.key) || '未设置' }}</span>
          <span class="current-config-arrow">→</span>
          <span class="current-config-url">{{ currentConfig.baseUrl || '未设置' }}</span>
        </div>
        <div v-if="hasModelFields" class="current-config-models">
          <Tag v-if="currentConfig.model" size="medium" variant="outline" class="model-tag" @click="copyModelName(currentConfig.model)">MODEL: {{ currentConfig.model }}</Tag>
          <Tag v-if="currentConfig.defaultHaikuModel" size="medium" variant="outline" class="model-tag" @click="copyModelName(currentConfig.defaultHaikuModel)">HAIKU: {{ currentConfig.defaultHaikuModel }}</Tag>
          <Tag v-if="currentConfig.defaultSonnetModel" size="medium" variant="outline" class="model-tag" @click="copyModelName(currentConfig.defaultSonnetModel)">SONNET: {{ currentConfig.defaultSonnetModel }}</Tag>
          <Tag v-if="currentConfig.defaultOpusModel" size="medium" variant="outline" class="model-tag" @click="copyModelName(currentConfig.defaultOpusModel)">OPUS: {{ currentConfig.defaultOpusModel }}</Tag>
          <Tag v-if="currentConfig.defaultFableModel" size="medium" variant="outline" class="model-tag" @click="copyModelName(currentConfig.defaultFableModel)">FABLE: {{ currentConfig.defaultFableModel }}</Tag>
          <Tag v-if="currentConfig.subagentModel" size="medium" variant="outline" class="model-tag" @click="copyModelName(currentConfig.subagentModel)">SUBAGENT: {{ currentConfig.subagentModel }}</Tag>
        </div>
      </div>
    </div>

    <div v-if="!savedConfigs.length" class="empty-state"><Empty description="暂无保存的配置方案" /></div>

    <div v-else class="config-groups">
      <div class="masonry-col">
        <template v-for="(group, idx) in leftColumn" :key="group.isPlaceholder ? 'placeholder' : 'l-' + idx + '-' + group.key">
          <div v-if="group.isPlaceholder" class="config-group drag-gap-parent">
            <div class="drag-gap" :style="{ height: dragState.dragHeight + 'px' }"></div>
          </div>
          <div v-else class="config-group">
            <div class="group-conn" @mousedown="onDragMouseDown('left', idx, $event)">
              <div class="group-conn-info">
                <span class="group-key">{{ maskKey(group.key) }}</span>
                <span class="group-url">{{ group.baseUrl }}</span>
              </div>
              <div class="group-conn-actions" @click.stop @mousedown.stop>
                <Tooltip content="批量编辑 URL 和 Key" placement="top">
                  <Button size="small" theme="default" variant="text" @click="openBatchEditDialog(group)"><EditIcon /></Button>
                </Tooltip>
              </div>
            </div>
            <div v-for="config in group.configs" :key="config.id + '-' + (isCurrentConfig(config) ? 'cur' : 'other')" class="config-row" @click="openPreviewDialog(config)">
              <span class="config-name">{{ config.name }}</span>
              <Space size="small" @click.stop>
                <Tag v-if="isCurrentConfig(config)" theme="success" variant="light" size="small">当前</Tag>
                <Button v-else size="small" theme="success" variant="text" @click="switchConfig(config)"><template #icon><PlayIcon /></template>启用</Button>
                <Tooltip content="编辑" placement="top">
                  <Button size="small" theme="default" variant="text" @click="openEditDialog(config)"><EditIcon /></Button>
                </Tooltip>
                <Tooltip content="删除" placement="top">
                  <Popconfirm theme="danger" content="确定要删除这个配置吗？" @confirm="deleteConfig(config)">
                    <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
                  </Popconfirm>
                </Tooltip>
              </Space>
            </div>
          </div>
        </template>
      </div>
      <div class="masonry-col">
        <template v-for="(group, idx) in rightColumn" :key="group.isPlaceholder ? 'placeholder' : 'r-' + idx + '-' + group.key">
          <div v-if="group.isPlaceholder" class="config-group drag-gap-parent">
            <div class="drag-gap" :style="{ height: dragState.dragHeight + 'px' }"></div>
          </div>
          <div v-else class="config-group">
            <div class="group-conn" @mousedown="onDragMouseDown('right', idx, $event)">
              <div class="group-conn-info">
                <span class="group-key">{{ maskKey(group.key) }}</span>
                <span class="group-url">{{ group.baseUrl }}</span>
              </div>
              <div class="group-conn-actions" @click.stop @mousedown.stop>
                <Tooltip content="批量编辑 URL 和 Key" placement="top">
                  <Button size="small" theme="default" variant="text" @click="openBatchEditDialog(group)"><EditIcon /></Button>
                </Tooltip>
              </div>
            </div>
            <div v-for="config in group.configs" :key="config.id + '-' + (isCurrentConfig(config) ? 'cur' : 'other')" class="config-row" @click="openPreviewDialog(config)">
              <span class="config-name">{{ config.name }}</span>
              <Space size="small" @click.stop>
                <Tag v-if="isCurrentConfig(config)" theme="success" variant="light" size="small">当前</Tag>
                <Button v-else size="small" theme="success" variant="text" @click="switchConfig(config)"><template #icon><PlayIcon /></template>启用</Button>
                <Tooltip content="编辑" placement="top">
                  <Button size="small" theme="default" variant="text" @click="openEditDialog(config)"><EditIcon /></Button>
                </Tooltip>
                <Tooltip content="删除" placement="top">
                  <Popconfirm theme="danger" content="确定要删除这个配置吗？" @confirm="deleteConfig(config)">
                    <Button size="small" theme="danger" variant="text"><DeleteIcon /></Button>
                  </Popconfirm>
                </Tooltip>
              </Space>
            </div>
          </div>
        </template>
      </div>
    </div>

    <Dialog v-model:visible="showDialog" :header="dialogTitle" @confirm="saveConfig" width="560px">
      <div class="dialog-switch">
        <RadioGroup v-model="dialogTab" variant="default-filled" size="small">
          <RadioButton value="basic">基础配置</RadioButton>
          <RadioButton value="extra">env其他字段</RadioButton>
        </RadioGroup>
      </div>
      <div v-if="dialogTab === 'basic'" class="form">
        <div class="form-item"><label>名称 <span class="required">*</span></label><Input v-model="formData.name" placeholder="方便分辨的名字" /></div>
        <div class="form-item"><label>URL <span class="required">*</span></label><Input v-model="formData.baseUrl" placeholder="ANTHROPIC_BASE_URL" /></div>
        <div class="form-item"><label>认证方式</label>
          <RadioGroup v-model="formData.authVar" variant="default-filled" size="small" class="auth-var-group">
            <RadioButton value="ANTHROPIC_AUTH_TOKEN">AUTH_TOKEN</RadioButton>
            <RadioButton value="ANTHROPIC_API_KEY">API_KEY</RadioButton>
          </RadioGroup>
        </div>
        <div class="form-item"><label>TOKEN <span class="required">*</span></label><Input v-model="formData.key" type="password" :placeholder="formData.authVar || 'ANTHROPIC_AUTH_TOKEN'" /></div>
        <div class="form-hint">设置默认对话模型，留空则跟随系统默认</div>
        <div class="form-item"><label>MODEL</label><AutoComplete v-model="formData.model" :options="modelCandidates" filterable placeholder="ANTHROPIC_MODEL"><template #suffix><Tooltip content="模型支持一百万个上下文时勾选"><Checkbox v-model="formData.model1m" size="small" :disabled="!formData.model" class="model-1m-checkbox">1m</Checkbox></Tooltip></template></AutoComplete></div>
        <div class="form-hint">分别指定各层级模型版本，留空则使用系统默认分配</div>
        <div class="form-item"><label>HAIKU</label><AutoComplete v-model="formData.defaultHaikuModel" :options="modelCandidates" filterable placeholder="ANTHROPIC_DEFAULT_HAIKU_MODEL"><template #suffix><Tooltip content="模型支持一百万个上下文时勾选"><Checkbox v-model="formData.defaultHaikuModel1m" size="small" :disabled="!formData.defaultHaikuModel" class="model-1m-checkbox">1m</Checkbox></Tooltip></template></AutoComplete></div>
        <div class="form-item"><label>SONNET</label><AutoComplete v-model="formData.defaultSonnetModel" :options="modelCandidates" filterable placeholder="ANTHROPIC_DEFAULT_SONNET_MODEL"><template #suffix><Tooltip content="模型支持一百万个上下文时勾选"><Checkbox v-model="formData.defaultSonnetModel1m" size="small" :disabled="!formData.defaultSonnetModel" class="model-1m-checkbox">1m</Checkbox></Tooltip></template></AutoComplete></div>
        <div class="form-item"><label>OPUS</label><AutoComplete v-model="formData.defaultOpusModel" :options="modelCandidates" filterable placeholder="ANTHROPIC_DEFAULT_OPUS_MODEL"><template #suffix><Tooltip content="模型支持一百万个上下文时勾选"><Checkbox v-model="formData.defaultOpusModel1m" size="small" :disabled="!formData.defaultOpusModel" class="model-1m-checkbox">1m</Checkbox></Tooltip></template></AutoComplete></div>
<div class="form-item"><label>FABLE</label><AutoComplete v-model="formData.defaultFableModel" :options="modelCandidates" filterable placeholder="ANTHROPIC_DEFAULT_FABLE_MODEL"><template #suffix><Tooltip content="模型支持一百万个上下文时勾选"><Checkbox v-model="formData.defaultFableModel1m" size="small" :disabled="!formData.defaultFableModel" class="model-1m-checkbox">1m</Checkbox></Tooltip></template></AutoComplete></div>
        <div class="form-hint">设置子代理（工具调用、后台任务等）使用的模型</div>
        <div class="form-item"><label>SUBAGENT</label><AutoComplete v-model="formData.subagentModel" :options="modelCandidates" filterable placeholder="CLAUDE_CODE_SUBAGENT_MODEL"><template #suffix><Tooltip content="模型支持一百万个上下文时勾选"><Checkbox v-model="formData.subagentModel1m" size="small" :disabled="!formData.subagentModel" class="model-1m-checkbox">1m</Checkbox></Tooltip></template></AutoComplete></div>
      </div>
      <div v-else class="extra-fields-dialog">
        <div class="extra-fields-hint">
          <p>以下字段会与全局 env 其他字段合并（配置优先），切换配置时生效。</p>
        </div>
        <div v-if="extraFields.length" class="active-config-extras">
          <div class="active-config-extras-title">当前全局字段</div>
          <!-- 预设项用 disabled checkbox/radio 展示 -->
          <div v-if="extraFields.some(f => presetKeys.has(f.key?.trim()))" class="env-preset-list global-preset-list">
            <div class="env-preset-row preset-checkboxes">
              <Checkbox :checked="!!globalPresetValues['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']" disabled>Teammates 模式</Checkbox>
              <Checkbox :checked="!!globalPresetValues['ENABLE_TOOL_SEARCH']" disabled>启用工具搜索</Checkbox>
              <Checkbox :checked="!!globalPresetValues['CLAUDE_CODE_NO_FLICKER']" disabled>关闭终端闪烁</Checkbox>
            </div>
            <div class="env-preset-row env-preset-row-effort">
              <span class="env-preset-label">思考强度</span>
              <RadioGroup :value="globalPresetValues['CLAUDE_CODE_EFFORT_LEVEL'] || ''" variant="default-filled" size="small" disabled :class="effortLevelClass(globalPresetValues['CLAUDE_CODE_EFFORT_LEVEL'] || '')">
                <RadioButton value="">default</RadioButton>
                <RadioButton value="low">low</RadioButton>
                <RadioButton value="medium">medium</RadioButton>
                <RadioButton value="high">high</RadioButton>
                <RadioButton value="xhigh">xhigh</RadioButton>
                <RadioButton value="max">max</RadioButton>
              </RadioGroup>
            </div>
          </div>
          <!-- 非预设的自定义全局字段 -->
          <div v-if="globalCustomFields.length" class="extra-fields-list">
            <div v-for="(field, idx) in globalCustomFields" :key="idx" class="extra-field-wrap extra-field-readonly">
              <div class="extra-field-row">
                <div class="field-key-readonly">{{ field.key }}</div>
                <div class="field-value-readonly">{{ field.value }}</div>
              </div>
            </div>
          </div>
        </div>
        <!-- 预设区 -->
        <div class="env-preset-section">
          <div class="env-preset-title">常用设置</div>
          <div class="env-preset-list">
            <div class="env-preset-row preset-checkboxes">
              <Checkbox v-model="dialogPresetValues['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']">Teammates 模式</Checkbox>
              <Checkbox v-model="dialogPresetValues['ENABLE_TOOL_SEARCH']">启用工具搜索</Checkbox>
              <Checkbox v-model="dialogPresetValues['CLAUDE_CODE_NO_FLICKER']">关闭终端闪烁</Checkbox>
            </div>
            <div class="env-preset-row env-preset-row-effort">
              <span class="env-preset-label">思考强度</span>
              <RadioGroup v-model="dialogPresetValues['CLAUDE_CODE_EFFORT_LEVEL']" variant="default-filled" size="small" :class="effortLevelClass(dialogPresetValues['CLAUDE_CODE_EFFORT_LEVEL'] || '')">
                <RadioButton value="">default</RadioButton>
                <RadioButton value="low">low</RadioButton>
                <RadioButton value="medium">medium</RadioButton>
                <RadioButton value="high">high</RadioButton>
                <RadioButton value="xhigh">xhigh</RadioButton>
                <RadioButton value="max">max</RadioButton>
              </RadioGroup>
            </div>
          </div>
        </div>
        <Divider />
        <div class="env-preset-title">自定义字段</div>
        <div class="extra-fields-list">
          <div v-for="(field, idx) in dialogCustomFields" :key="idx" class="extra-field-wrap">
            <div class="extra-field-row">
              <AutoComplete v-model="field.key" class="field-key" :options="extraFieldKeyOptions" filterable placeholder="字段名" />
              <Input v-model="field.value" class="field-value" placeholder="字段值" />
              <Button size="small" theme="danger" variant="text" @click="removeDialogExtraField(formData.extraFields.indexOf(field))"><DeleteIcon /></Button>
            </div>
            <div v-if="extraFields.some(f => f.key?.trim() === field.key?.trim())" class="field-tag-row">
              <Tag size="small" theme="warning" variant="light">覆盖全局</Tag>
            </div>
          </div>
        </div>
        <Button size="small" variant="outline" @click="addDialogExtraField" class="add-field-btn"><template #icon><AddIcon /></template> 添加字段</Button>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <Button v-if="!editingConfig" variant="outline" @click="fillCurrentConfig"><template #icon><RefreshIcon /></template> 读取当前配置</Button>
          <span v-else></span>
          <div class="dialog-footer-right"><Button variant="outline" @click="showDialog = false">取消</Button><Button theme="primary" @click="saveConfig">保存</Button></div>
        </div>
      </template>
    </Dialog>

    <Dialog v-model:visible="showImportStringDialog" header="从字符串导入" @confirm="handleImportFromString" width="480px">
      <div class="form"><div class="form-item-vertical"><label>配置字符串</label><Textarea v-if="showImportStringDialog" v-model="importString" placeholder="粘贴配置字符串" :autosize="{ minRows: 4, maxRows: 8 }" /></div></div>
    </Dialog>

    <Dialog v-model:visible="showPreviewDialog" header="配置详情" width="560px" :footer="false">
      <div v-if="previewConfig" class="preview-content">
        <div class="preview-item"><span class="preview-label">配置名称</span><span class="preview-value">{{ previewConfig.name }}</span></div>
        <div class="preview-item"><span class="preview-label">{{ previewConfig.authVar || 'ANTHROPIC_AUTH_TOKEN' }}</span><span class="preview-value">{{ maskKey(previewConfig.key) || "未设置" }}</span></div>
        <div class="preview-item"><span class="preview-label">BASE_URL</span><span class="preview-value">{{ previewConfig.baseUrl || "未设置" }}</span></div>
        <div class="preview-item"><span class="preview-label">MODEL</span><span class="preview-value">{{ previewConfig.model || "未设置" }}</span></div>
        <div v-if="previewConfig.defaultHaikuModel || previewConfig.defaultSonnetModel || previewConfig.defaultOpusModel || previewConfig.defaultFableModel" class="preview-divider"></div>
        <div v-if="previewConfig.defaultHaikuModel" class="preview-item"><span class="preview-label">HAIKU_MODEL</span><span class="preview-value">{{ previewConfig.defaultHaikuModel }}</span></div>
        <div v-if="previewConfig.defaultSonnetModel" class="preview-item"><span class="preview-label">SONNET_MODEL</span><span class="preview-value">{{ previewConfig.defaultSonnetModel }}</span></div>
        <div v-if="previewConfig.defaultOpusModel" class="preview-item"><span class="preview-label">OPUS_MODEL</span><span class="preview-value">{{ previewConfig.defaultOpusModel }}</span></div>
        <div v-if="previewConfig.defaultFableModel" class="preview-item"><span class="preview-label">FABLE_MODEL</span><span class="preview-value">{{ previewConfig.defaultFableModel }}</span></div>
        <div v-if="previewConfig.subagentModel" class="preview-item"><span class="preview-label">SUBAGENT_MODEL</span><span class="preview-value">{{ previewConfig.subagentModel }}</span></div>
        <template v-if="previewConfig.extraFields && previewConfig.extraFields.length">
          <div class="preview-divider"></div>
          <div class="preview-subtitle">env 其他字段</div>
          <div v-for="(field, idx) in previewConfig.extraFields" :key="idx" class="preview-item">
            <span class="preview-label">{{ field.key }}</span>
            <span class="preview-value">{{ field.value }}</span>
          </div>
        </template>
      </div>
    </Dialog>

    <Dialog v-model:visible="showExtraFieldsDialog" header="env其他字段设置" width="600px" @confirm="saveExtraFields">
      <div class="extra-fields-dialog">
        <div class="extra-fields-hint">
          <p>以下为全局基础值，切换配置时会与配置中的env其他字段合并（配置优先）。</p>
        </div>
        <!-- 预设区 -->
        <div class="env-preset-section">
          <div class="env-preset-title">常用设置</div>
          <div class="env-preset-list">
            <div class="env-preset-row preset-checkboxes">
              <Checkbox v-model="presetValues['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']">Teammates 模式</Checkbox>
              <Checkbox v-model="presetValues['ENABLE_TOOL_SEARCH']">启用工具搜索</Checkbox>
              <Checkbox v-model="presetValues['CLAUDE_CODE_NO_FLICKER']">关闭终端闪烁</Checkbox>
            </div>
            <div class="env-preset-row env-preset-row-effort">
              <span class="env-preset-label">思考强度</span>
              <RadioGroup v-model="presetValues['CLAUDE_CODE_EFFORT_LEVEL']" variant="default-filled" size="small" :class="effortLevelClass(presetValues['CLAUDE_CODE_EFFORT_LEVEL'] || '')">
                <RadioButton value="">default</RadioButton>
                <RadioButton value="low">low</RadioButton>
                <RadioButton value="medium">medium</RadioButton>
                <RadioButton value="high">high</RadioButton>
                <RadioButton value="xhigh">xhigh</RadioButton>
                <RadioButton value="max">max</RadioButton>
              </RadioGroup>
            </div>
          </div>
        </div>
        <!-- 当前活跃配置的 env 其他字段（只读） -->
        <div v-if="activeConfigExtras && activeConfigExtras.extraFields.length" class="active-config-extras">
          <div class="active-config-extras-title">{{ activeConfigExtras.name ? '来自当前配置「' + activeConfigExtras.name + '」' : '当前生效的 env 其他字段' }}</div>
          <div class="extra-fields-list">
            <div v-for="(field, idx) in activeConfigExtras.extraFields" :key="idx" class="extra-field-wrap extra-field-readonly">
              <div class="extra-field-row">
                <div class="field-key-readonly">{{ field.key }}</div>
                <div class="field-value-readonly">{{ field.value }}</div>
              </div>
              <div class="field-tag-row">
                <Tag v-if="extraFields.some(f => f.key?.trim() === field.key) || (presetKeys.has(field.key?.trim()) && presetValues[field.key?.trim()])" size="small" theme="warning" variant="light">覆盖全局</Tag>
                <Tag v-else size="small" theme="success" variant="light">生效中</Tag>
              </div>
            </div>
          </div>
        </div>
        <Divider />
        <div class="env-preset-title">自定义字段</div>
        <div class="extra-fields-list">
          <div v-for="(field, idx) in customFields" :key="idx" class="extra-field-wrap">
            <div class="extra-field-row">
              <AutoComplete v-model="field.key" class="field-key" :options="extraFieldKeyOptions" filterable placeholder="字段名" />
              <Input v-model="field.value" class="field-value" placeholder="字段值" />
              <Button size="small" theme="danger" variant="text" @click="removeExtraField(extraFields.indexOf(field))"><DeleteIcon /></Button>
            </div>
            <div v-if="activeConfigExtras?.extraFields.some(f => f.key?.trim() === field.key?.trim())" class="field-tag-row">
              <Tag size="small" theme="warning" variant="light">被覆盖</Tag>
            </div>
          </div>
        </div>
        <div class="extra-fields-actions">
          <Button size="small" variant="outline" @click="addExtraField"><template #icon><AddIcon /></template> 添加字段</Button>
          <Button size="small" variant="outline" @click="reloadFromSettings"><template #icon><RefreshIcon /></template> 重新读取其他字段设置</Button>
        </div>
      </div>
      <template #footer>
        <Button variant="outline" @click="showExtraFieldsDialog = false">取消</Button>
        <Button theme="primary" @click="saveExtraFields">保存</Button>
      </template>
    </Dialog>

    <!-- 批量编辑弹窗 -->
    <Dialog v-model:visible="showBatchEditDialog" header="批量编辑此组" width="560px" @confirm="saveBatchEdit">
      <div class="form">
        <div class="form-item"><label>URL <span class="required">*</span></label><Input v-model="batchUrl" placeholder="ANTHROPIC_BASE_URL" /></div>
        <div class="form-item"><label>KEY <span class="required">*</span></label><Input v-model="batchKey" type="password" placeholder="认证 Key" /></div>
      </div>
      <div class="batch-edit-hint">将更新本组共 {{ batchEditGroup?.configs.length }} 个配置的 URL 与 Key。</div>
    </Dialog>

    <!-- 清除配置确认弹窗 -->
    <Dialog v-model:visible="showClearDialog" header="清除配置" width="480px" :footer="false">
      <div class="clear-dialog-body">
        <p class="clear-dialog-warning">以下配置项将被清除，操作不可恢复：</p>
        <pre class="clear-dialog-list">{{ clearConfirmContent }}</pre>
        <p class="clear-dialog-note">其余 env 字段将保留。</p>
      </div>
      <div class="clear-dialog-footer">
        <Button variant="outline" @click="showClearDialog = false">取消</Button>
        <Button theme="danger" @click="confirmClearConfig">确认清除</Button>
      </div>
    </Dialog>
  </div>
</template>
