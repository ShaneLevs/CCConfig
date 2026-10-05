<script setup>
import { ref, onMounted, computed } from "vue";
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
  Checkbox,
  Divider,
} from "tdesign-vue-next";
import {
  AddIcon,
  RefreshIcon,
  DownloadIcon,
  UploadIcon,
  DeleteIcon,
  SettingIcon,
} from "tdesign-icons-vue-next";
import { useConfigColumns } from "../../composables/useConfigColumns";
import { useConfigImportExport } from "../../composables/useConfigImportExport";
import { useConfigSwitch } from "../../composables/useConfigSwitch";
import { useExtraFields } from "../../composables/useExtraFields";
import { managedFields } from "../../constants";
import ClaudeConfigGroups from "./components/ClaudeConfigGroups.vue";
import ClaudeConfigEditDialog from "./components/ClaudeConfigEditDialog.vue";
import ClaudePreviewDialog from "./components/ClaudePreviewDialog.vue";
import ClaudeEnvPresetEditor from "./components/ClaudeEnvPresetEditor.vue";
import "./styles/ConfigView.css";

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
const showPreviewDialog = ref(false);
const previewConfig = ref(null);
const showBatchEditDialog = ref(false);
const batchEditGroup = ref(null);
const batchUrl = ref("");
const batchKey = ref("");

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
  loadGlobalExtraFields();
  showDialog.value = true;
};

const openEditDialog = (config) => {
  editingConfig.value = config;
  loadGlobalExtraFields();
  showDialog.value = true;
};

const saveConfig = (snapshot) => {
  const form = snapshot.formData;
  if (!form.name.trim()) return MessagePlugin.warning("请输入配置名称");
  if (!form.key.trim()) return MessagePlugin.warning("请输入 Key");
  if (!form.baseUrl.trim()) return MessagePlugin.warning("请输入 URL");

  const now = Date.now();
  const id = editingConfig.value ? editingConfig.value.id : DB_PREFIX + now;
  // 合并预设 + 自定义字段
  const cleanExtraFields = mergePresetsToFields(form.extraFields || [], snapshot.presetValues)
    .map(f => ({ key: f.key.trim(), value: f.value?.trim() || "" }));
  // 检查重复 key
  const extraKeys = cleanExtraFields.map(f => f.key);
  const duplicateKey = extraKeys.find((k, i) => extraKeys.indexOf(k) !== i);
  if (duplicateKey) return MessagePlugin.warning(`env字段 key 重复: ${duplicateKey}`);
  const buildModelValue = (field, checked) => {
    const stripped = (form[field] || '').trim().replace(/\[1m\]$/i, '');
    return checked ? stripped + '[1m]' : stripped;
  };

  const doc = {
    _id: id,
    name: form.name.trim(),
    key: window.services.encryptKey(form.key.trim()),
    authVar: form.authVar || 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: form.baseUrl.trim(),
    model: buildModelValue('model', form.model1m),
    defaultHaikuModel: buildModelValue('defaultHaikuModel', form.defaultHaikuModel1m),
    defaultSonnetModel: buildModelValue('defaultSonnetModel', form.defaultSonnetModel1m),
    defaultOpusModel: buildModelValue('defaultOpusModel', form.defaultOpusModel1m),
    defaultFableModel: buildModelValue('defaultFableModel', form.defaultFableModel1m),
    subagentModel: buildModelValue('subagentModel', form.subagentModel1m),
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
        key: form.key.trim(),
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
        <div v-if="currentConfig.model || currentConfig.defaultHaikuModel || currentConfig.defaultSonnetModel || currentConfig.defaultOpusModel || currentConfig.defaultFableModel || currentConfig.subagentModel" class="current-config-models">
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
      <ClaudeConfigGroups
        :groups="leftColumn"
        side="left"
        :drag-state="dragState"
        :is-current="isCurrentConfig"
        @drag-mousedown="(idx, e) => onDragMouseDown('left', idx, e)"
        @batch-edit="openBatchEditDialog"
        @preview="openPreviewDialog"
        @switch="switchConfig"
        @edit="openEditDialog"
        @del="deleteConfig"
      />
      <ClaudeConfigGroups
        :groups="rightColumn"
        side="right"
        :drag-state="dragState"
        :is-current="isCurrentConfig"
        @drag-mousedown="(idx, e) => onDragMouseDown('right', idx, e)"
        @batch-edit="openBatchEditDialog"
        @preview="openPreviewDialog"
        @switch="switchConfig"
        @edit="openEditDialog"
        @del="deleteConfig"
      />
    </div>

    <!-- 新建 / 编辑配置弹窗 -->
    <ClaudeConfigEditDialog
      v-model:visible="showDialog"
      :editing-config="editingConfig"
      :current-config="currentConfig"
      :global-fields="extraFields"
      :env-presets="envPresets"
      :preset-keys="presetKeys"
      :extra-field-key-options="extraFieldKeyOptions"
      @save="saveConfig"
    />

    <Dialog v-model:visible="showImportStringDialog" header="从字符串导入" @confirm="handleImportFromString" width="480px">
      <div class="form"><div class="form-item-vertical"><label>配置字符串</label><Textarea v-if="showImportStringDialog" v-model="importString" placeholder="粘贴配置字符串" :autosize="{ minRows: 4, maxRows: 8 }" /></div></div>
    </Dialog>

    <!-- 配置详情预览 -->
    <ClaudePreviewDialog v-model:visible="showPreviewDialog" :config="previewConfig" />

    <Dialog v-model:visible="showExtraFieldsDialog" header="env其他字段设置" width="600px" @confirm="saveExtraFields">
      <div class="extra-fields-dialog">
        <div class="extra-fields-hint">
          <p>以下为全局基础值，切换配置时会与配置中的env其他字段合并（配置优先）。</p>
        </div>
        <!-- 预设区 -->
        <div class="env-preset-section">
          <div class="env-preset-title">常用设置</div>
          <ClaudeEnvPresetEditor :values="presetValues" />
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
