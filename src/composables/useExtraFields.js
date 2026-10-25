import { ref, computed } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import { t } from "../i18n";
import { managedFields, envPresets } from "../constants";

const SAVED_FIELD_KEYS_ID = "extra_field_keys";
export const fixedFieldKeyOptions = [
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_NO_FLICKER",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
];

// 预设 key 集合，用于快速判断
const presetKeys = new Set(envPresets.map(p => p.key));

export function useExtraFields(loadCurrentConfig, savedConfigs, isCurrentConfig) {
  const showExtraFieldsDialog = ref(false);
  const extraFields = ref([]);
  const activeConfigExtras = ref(null); // { name, extraFields }
  const savedExtraFieldKeys = ref([]);
  const presetValues = ref({}); // { [key]: value } 预设区状态

  const extraFieldKeyOptions = computed(() => {
    const all = [...fixedFieldKeyOptions, ...savedExtraFieldKeys.value];
    const unique = [...new Set(all)].filter(k => !presetKeys.has(k));
    return unique.map(k => ({ label: k, value: k }));
  });

  // 自定义字段 = extraFields 中不属于预设 key 的条目
  const customFields = computed(() =>
    extraFields.value.filter(f => !presetKeys.has(f.key?.trim()))
  );

  const loadExtraFieldKeys = () => {
    const doc = window.utools.db.get(SAVED_FIELD_KEYS_ID);
    savedExtraFieldKeys.value = doc?.keys || [];
  };

  // 通过和前端一样的逻辑找到当前生效的配置
  const findActiveConfig = () => {
    if (!savedConfigs || !isCurrentConfig) return null;
    for (const config of savedConfigs.value || []) {
      if (isCurrentConfig(config)) return config;
    }
    return null;
  };

  // 从 extraFields 数组中初始化预设区状态
  const syncPresetsFromFields = (fields) => {
    const pv = {};
    envPresets.forEach(preset => {
      const found = fields.find(f => f.key?.trim() === preset.key);
      if (preset.type === 'boolean') {
        pv[preset.key] = found ? true : false;
      } else {
        pv[preset.key] = found ? found.value?.trim() || '' : '';
      }
    });
    presetValues.value = pv;
  };

  // 从 fields 中移除预设 key 对应的条目（避免重复）
  const stripPresetFields = (fields) => fields.filter(f => !presetKeys.has(f.key?.trim()));

  const loadGlobalExtraFields = () => {
    const saved = window.services.getOverriddenEnv();
    let fields;
    if (saved) {
      fields = Object.keys(saved).map(key => ({ key, value: String(saved[key]) }));
    } else {
      const settings = window.services.readClaudeSettings() || {};
      const env = settings.env || {};
      fields = [];
      Object.keys(env).forEach(key => {
        if (!managedFields.includes(key)) {
          fields.push({ key, value: String(env[key]) });
        }
      });
    }
    extraFields.value = fields;
    syncPresetsFromFields(fields);
  };

  const openExtraFieldsDialog = () => {
    loadExtraFieldKeys();
    const active = findActiveConfig();
    activeConfigExtras.value = active
      ? { name: active.name, extraFields: active.extraFields || [] }
      : null;
    loadGlobalExtraFields();
    showExtraFieldsDialog.value = true;
  };

  const addExtraField = () => extraFields.value.push({ key: '', value: '' });
  const removeExtraField = (idx) => extraFields.value.splice(idx, 1);

  const saveExtraFieldKeys = (keys) => {
    const userKeys = keys.filter(k => k && !fixedFieldKeyOptions.includes(k));
    if (!userKeys.length) return;
    const existingDoc = window.utools.db.get(SAVED_FIELD_KEYS_ID);
    const existing = existingDoc?.keys || [];
    const merged = [...new Set([...existing, ...userKeys])];
    const doc = { _id: SAVED_FIELD_KEYS_ID, keys: merged };
    if (existingDoc) doc._rev = existingDoc._rev;
    window.utools.db.put(doc);
  };

  // 将预设区的值合并回 extraFields 数组（可传入 values 覆盖默认 presetValues）
  const mergePresetsToFields = (fields, values) => {
    const vals = values || presetValues.value;
    const custom = stripPresetFields(fields);
    envPresets.forEach(preset => {
      const val = vals[preset.key];
      if (preset.type === 'boolean') {
        if (val) custom.push({ key: preset.key, value: preset.trueValue });
      } else {
        // select 类型，空值 = 不设置
        if (val) custom.push({ key: preset.key, value: val });
      }
    });
    return custom;
  };

  const saveExtraFields = () => {
    // 合并预设 + 自定义字段
    const mergedFields = mergePresetsToFields(extraFields.value);

    // 检查自定义字段重复 key
    const keys = mergedFields.map(f => f.key?.trim()).filter(Boolean);
    const duplicateKey = keys.find((k, i) => keys.indexOf(k) !== i);
    if (duplicateKey) return MessagePlugin.warning(t('common.duplicateEnvKey', { key: duplicateKey }));

    // 1. 构建全局 extras 并存 DB
    const globalExtras = {};
    const userKeys = [];
    mergedFields.forEach(field => {
      const key = field.key.trim();
      const value = field.value.trim();
      // 托管字段（如认证变量）由切换逻辑管理，不写入全局 extras，避免破坏互斥
      if (key && !managedFields.includes(key)) {
        globalExtras[key] = value;
        if (!fixedFieldKeyOptions.includes(key)) userKeys.push(key);
      }
    });
    window.services.saveOverriddenEnv(globalExtras);

    // 2. 合并：全局 + 当前活跃配置的 extraFields（配置优先）
    const mergedExtras = { ...globalExtras };
    const configExtras = (activeConfigExtras.value?.extraFields) || [];
    configExtras.forEach(field => {
      const k = field.key?.trim();
      const v = field.value?.trim();
      if (k) mergedExtras[k] = v;
    });

    // 3. 写入 settings.json
    const settings = window.services.readClaudeSettings() || {};
    if (!settings.env) settings.env = {};
    Object.keys(settings.env).forEach(key => {
      if (!managedFields.includes(key)) delete settings.env[key];
    });
    Object.entries(mergedExtras).forEach(([k, v]) => {
      settings.env[k] = v;
    });

    // 4. 保存候选字段名
    const mergedKeysDoc = { _id: SAVED_FIELD_KEYS_ID, keys: [...new Set([...savedExtraFieldKeys.value, ...userKeys])] };
    const existingDoc = window.utools.db.get(SAVED_FIELD_KEYS_ID);
    if (existingDoc) mergedKeysDoc._rev = existingDoc._rev;
    window.utools.db.put(mergedKeysDoc);

    if (window.services.writeClaudeSettings(settings)) {
      MessagePlugin.success(t('common.globalSettingsSaved'));
      showExtraFieldsDialog.value = false;
      loadCurrentConfig();
    } else {
      MessagePlugin.error(t('common.saveFailed'));
    }
  };

  return {
    showExtraFieldsDialog,
    extraFields,
    customFields,
    presetValues,
    activeConfigExtras,
    extraFieldKeyOptions,
    loadExtraFieldKeys,
    loadGlobalExtraFields,
    openExtraFieldsDialog,
    addExtraField,
    removeExtraField,
    saveExtraFields,
    saveExtraFieldKeys,
    syncPresetsFromFields,
    mergePresetsToFields,
    envPresets,
    presetKeys,
  };
}
