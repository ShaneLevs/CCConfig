import { ref } from "vue";
import { findModelPreset, getPresetValues } from "../utils/modelPresets";

// 预设自动填充状态：
// - baseline 记录弹窗打开/表单初始化时的值；
// - lastApplied 记录上一次由预设写入的值；
// - 只有当前值仍等于 baseline 或 lastApplied 时才允许覆盖，用户手改过的字段始终保留。
const cloneValue = (value) => {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
};

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function useModelPresetAutofill() {
  const matchedPreset = ref(null);
  const lastApplied = ref({});
  let baseline = {};
  let baselineReady = false;

  const resetBaseline = (form) => {
    baseline = cloneValue(form) || {};
    lastApplied.value = {};
    matchedPreset.value = null;
    baselineReady = true;
  };

  const setField = (form, key, value) => {
    if (!baselineReady || value === undefined) return false;
    const hasBaseline = Object.prototype.hasOwnProperty.call(baseline, key);
    const current = form[key];
    const initial = hasBaseline ? baseline[key] : undefined;
    const hasLast = Object.prototype.hasOwnProperty.call(lastApplied.value, key);
    const last = lastApplied.value[key];
    const untouched = sameValue(current, initial) || (hasLast && sameValue(current, last));
    if (!untouched) return false;
    if (sameValue(current, value)) {
      lastApplied.value[key] = cloneValue(value);
      return false;
    }
    form[key] = cloneValue(value);
    lastApplied.value[key] = cloneValue(value);
    return true;
  };

  const clearUntouched = (form, keepKeys) => {
    for (const key of Object.keys(lastApplied.value)) {
      if (keepKeys.has(key)) continue;
      const current = form[key];
      const last = lastApplied.value[key];
      if (!sameValue(current, last)) {
        delete lastApplied.value[key];
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(baseline, key)) form[key] = cloneValue(baseline[key]);
      else delete form[key];
      delete lastApplied.value[key];
    }
  };

  const apply = (form, modelId, fillFn) => {
    const result = findModelPreset(modelId);
    if (!result || result.ambiguous) {
      matchedPreset.value = null;
      clearUntouched(form, new Set());
      return null;
    }
    const values = getPresetValues(result.preset, result.contextWindowOverride);
    matchedPreset.value = {
      id: result.preset.id,
      name: result.preset.name,
      confidence: result.confidence,
    };
    const keepKeys = new Set();
    fillFn(values, (key, value) => {
      keepKeys.add(key);
      setField(form, key, value);
    }, result);
    clearUntouched(form, keepKeys);
    return result;
  };

  return { matchedPreset, resetBaseline, apply };
}
