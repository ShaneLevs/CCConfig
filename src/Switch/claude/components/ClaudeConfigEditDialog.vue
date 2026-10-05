<script setup>
import { ref, computed, watch } from "vue";
import {
  Button, Input, AutoComplete, Dialog, Tag, Space, Tooltip, RadioGroup, RadioButton, Checkbox, Divider, MessagePlugin,
} from "tdesign-vue-next";
import { AddIcon, RefreshIcon, DeleteIcon } from "tdesign-icons-vue-next";
import ClaudeModelFieldRow from "./ClaudeModelFieldRow.vue";
import ClaudeEnvPresetEditor from "./ClaudeEnvPresetEditor.vue";

// claude 新建/编辑配置弹窗：基础配置（Key/URL/认证方式/6 个模型字段，防抖拉取模型候选、
// [1m] 后缀同步）与 env 其他字段两个页签。表单状态由本组件持有，保存时把
// { formData, presetValues } 快照交回父级落库。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 编辑时的配置对象；null = 新建
  editingConfig: { type: Object, default: null },
  // 「读取当前配置」来源
  currentConfig: { type: Object, required: true },
  // 全局 env 其他字段（useExtraFields 状态，用于「当前全局字段」只读区）
  globalFields: { type: Array, default: () => [] },
  // useExtraFields 暴露的预设定义与键表
  envPresets: { type: Array, default: () => [] },
  presetKeys: { type: Object, required: true },
  extraFieldKeyOptions: { type: Array, default: () => [] },
});
const emit = defineEmits(["update:visible", "save"]);

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const strip1m = (v) => (v || '').replace(/\[1m\]$/i, '');
const has1m = (v) => /\[1m\]$/i.test(v || '');

// OpenCode Go 预设：baseUrl 固定，模型候选由 /v1/models 实时获取（不写死）
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go";

const dialogTab = ref("basic");
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

const dialogTitle = computed(() => (props.editingConfig ? "编辑配置" : "新建配置"));

const fillCurrentConfig = () => {
  formData.value.key = props.currentConfig.key;
  formData.value.authVar = props.currentConfig.authVar || 'ANTHROPIC_AUTH_TOKEN';
  formData.value.baseUrl = props.currentConfig.baseUrl;
  Object.assign(formData.value, configModelsToForm(props.currentConfig));
};

const addDialogExtraField = () => formData.value.extraFields.push({ key: "", value: "" });
const removeDialogExtraField = (idx) => formData.value.extraFields.splice(idx, 1);

// 配置弹窗中的预设状态
const dialogPresetValues = ref({});
const dialogCustomFields = computed(() =>
  (formData.value.extraFields || []).filter(f => !props.presetKeys.has(f.key?.trim()))
);
// 全局字段中属于预设的，用 disabled checkbox/radio 展示
const globalPresetValues = computed(() => {
  const pv = {};
  props.envPresets.forEach(preset => {
    const found = props.globalFields.find(f => f.key?.trim() === preset.key);
    if (preset.type === 'boolean') {
      pv[preset.key] = !!found;
    } else {
      pv[preset.key] = found ? found.value?.trim() || '' : '';
    }
  });
  return pv;
});
const globalCustomFields = computed(() =>
  props.globalFields.filter(f => !props.presetKeys.has(f.key?.trim()))
);
const syncDialogPresets = (fields) => {
  const pv = {};
  props.envPresets.forEach(preset => {
    const found = fields.find(f => f.key?.trim() === preset.key);
    if (preset.type === 'boolean') {
      pv[preset.key] = found ? true : false;
    } else {
      pv[preset.key] = found ? found.value?.trim() || '' : '';
    }
  });
  dialogPresetValues.value = pv;
};

// 打开时按新建/编辑初始化表单
watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    dialogTab.value = "basic";
    if (props.editingConfig) {
      const config = props.editingConfig;
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
    } else {
      formData.value = {
        name: "",
        key: "",
        authVar: "ANTHROPIC_AUTH_TOKEN",
        baseUrl: "",
        ...configModelsToForm({}),
        extraFields: [],
      };
      syncDialogPresets([]);
    }
  }
);

const handleSave = () => {
  emit("save", { formData: { ...formData.value }, presetValues: { ...dialogPresetValues.value } });
};
</script>

<template>
  <Dialog v-model:visible="dialogVisible" :header="dialogTitle" width="560px">
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
      <ClaudeModelFieldRow label="MODEL" placeholder="ANTHROPIC_MODEL" :options="modelCandidates" v-model="formData.model" v-model:one-m="formData.model1m" />
      <div class="form-hint">分别指定各层级模型版本，留空则使用系统默认分配</div>
      <ClaudeModelFieldRow label="HAIKU" placeholder="ANTHROPIC_DEFAULT_HAIKU_MODEL" :options="modelCandidates" v-model="formData.defaultHaikuModel" v-model:one-m="formData.defaultHaikuModel1m" />
      <ClaudeModelFieldRow label="SONNET" placeholder="ANTHROPIC_DEFAULT_SONNET_MODEL" :options="modelCandidates" v-model="formData.defaultSonnetModel" v-model:one-m="formData.defaultSonnetModel1m" />
      <ClaudeModelFieldRow label="OPUS" placeholder="ANTHROPIC_DEFAULT_OPUS_MODEL" :options="modelCandidates" v-model="formData.defaultOpusModel" v-model:one-m="formData.defaultOpusModel1m" />
      <ClaudeModelFieldRow label="FABLE" placeholder="ANTHROPIC_DEFAULT_FABLE_MODEL" :options="modelCandidates" v-model="formData.defaultFableModel" v-model:one-m="formData.defaultFableModel1m" />
      <div class="form-hint">设置子代理（工具调用、后台任务等）使用的模型</div>
      <ClaudeModelFieldRow label="SUBAGENT" placeholder="CLAUDE_CODE_SUBAGENT_MODEL" :options="modelCandidates" v-model="formData.subagentModel" v-model:one-m="formData.subagentModel1m" />
    </div>
    <div v-else class="extra-fields-dialog">
      <div class="extra-fields-hint">
        <p>以下字段会与全局 env 其他字段合并（配置优先），切换配置时生效。</p>
      </div>
      <div v-if="globalFields.length" class="active-config-extras">
        <div class="active-config-extras-title">当前全局字段</div>
        <!-- 预设项用 disabled checkbox/radio 展示 -->
        <ClaudeEnvPresetEditor
          v-if="globalFields.some(f => presetKeys.has(f.key?.trim()))"
          :values="globalPresetValues"
          disabled
        />
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
        <ClaudeEnvPresetEditor :values="dialogPresetValues" />
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
          <div v-if="globalFields.some(f => f.key?.trim() === field.key?.trim())" class="field-tag-row">
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
        <div class="dialog-footer-right"><Button variant="outline" @click="dialogVisible = false">取消</Button><Button theme="primary" @click="handleSave">保存</Button></div>
      </div>
    </template>
  </Dialog>
</template>
