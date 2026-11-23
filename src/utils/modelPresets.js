// 模型预设表入口：Vue 侧统一从这里查表，避免各弹窗重复 import JSON。
import presetData from "../data/modelPresets.json";
import { createModelPresetMatcher } from "./modelPresetMatch";

export const MODEL_PRESETS = presetData.models || [];
export const findModelPreset = createModelPresetMatcher(MODEL_PRESETS);
export { getPresetValues, tokenizeModelId, extractContextHint } from "./modelPresetMatch";
