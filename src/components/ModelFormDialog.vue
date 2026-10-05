<script setup>
import { ref, computed, watch } from "vue";
import {
  Dialog, Input, InputNumber, AutoComplete, Space, CheckboxGroup, Checkbox, Collapse, CollapsePanel, MessagePlugin,
} from "tdesign-vue-next";
import DynamicKvEditor from "./DynamicKvEditor.vue";
import ModelLimitsFields from "./ModelLimitsFields.vue";
import { useAutoFetchModels } from "../composables/useAutoFetchModels";

// 模型添加/编辑弹窗（二合一）：add 模式带供应商模型自动拉取（AutoComplete 选中自动回填），
// edit 模式允许修改模型 ID（重命名由父级以删旧建新方式落库）。高级配置支持插入各应用特有字段。
// 表单样式类沿用调用方视图的全局 CSS（如 common-form-item），item-class 同步传给 ModelLimitsFields。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'add' | 'edit'
  mode: { type: String, default: "add" },
  providerName: { type: String, default: "" },
  // add 模式：用于自动拉取模型列表的 { baseUrl, apiKey } 对象
  provider: { type: Object, default: null },
  // edit 模式：原模型对象
  initial: { type: Object, default: null },
  // 高级配置兼容性字段自动完成提示
  compatKeyOptions: { type: Array, default: () => [] },
});
const emit = defineEmits(["update:visible", "confirm"]);

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const isAdd = computed(() => props.mode === "add");

const INPUT_TYPE_OPTIONS = [
  { label: "文本 (text)", value: "text" },
  { label: "图像 (image)", value: "image" },
];

const {
  autoModels, autoModelsLoading, autoModelsError, modelOptions, fetchAutoModels, resetAutoModels, onModelIdSelect,
} = useAutoFetchModels();

const defaultForm = () => ({
  id: "",
  name: "",
  contextWindow: 0,
  maxTokens: 0,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: [],
});
const form = ref(defaultForm());
// 编辑时的新模型 ID（重命名）
const newModelId = ref("");
// 高级配置展开状态
const advancedOpen = ref(false);

// 最终生效的模型 ID：add 用表单值，edit 用新 ID（留空回退原 ID）
const finalId = computed(() =>
  isAdd.value
    ? form.value.id.trim()
    : newModelId.value.trim() || (props.initial?.id ?? "")
);

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    advancedOpen.value = false;
    if (isAdd.value) {
      form.value = defaultForm();
      resetAutoModels();
      // 打开弹窗即自动拉取模型列表，无需手动点击
      fetchAutoModels(props.provider);
    } else {
      const m = props.initial || {};
      newModelId.value = m.id || "";
      form.value = {
        name: m.name || "",
        contextWindow: m.contextWindow || 0,
        maxTokens: m.maxTokens || 0,
        reasoning: !!m.reasoning,
        input: m.input || ["text"],
        cost: m.cost && m.cost.input != null ? { ...m.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: m.compat ? Object.entries(m.compat).map(([key, value]) => ({ key, value })) : [],
      };
    }
  }
);

const handleConfirm = () => {
  const id = finalId.value;
  if (isAdd.value && !id) {
    MessagePlugin.warning("请输入模型 ID");
    return;
  }
  const compatObj = {};
  (form.value.compat || []).forEach(({ key, value }) => {
    if (key && key.trim()) compatObj[key.trim()] = value;
  });
  emit("confirm", {
    mode: props.mode,
    providerName: props.providerName,
    originalId: isAdd.value ? null : props.initial?.id ?? null,
    id,
    name: form.value.name.trim() || id,
    contextWindow: Number(form.value.contextWindow) || 0,
    maxTokens: Number(form.value.maxTokens) || 0,
    reasoning: form.value.reasoning,
    input: form.value.input,
    cost: form.value.cost,
    compat: compatObj,
  });
};
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    :header="isAdd ? '添加模型' : '编辑模型'"
    :width="isAdd ? '520px' : '480px'"
    :confirm-btn="{ content: isAdd ? '添加' : '保存', theme: 'primary' }"
    @confirm="handleConfirm"
  >
    <div class="common-edit-form">
      <div v-if="isAdd" class="common-form-item">
        <label>所属供应商</label>
        <div class="common-edit-provider-name">{{ providerName }}</div>
      </div>

      <!-- 模型 ID：添加模式用 AutoComplete（弹窗打开时已自动拉取模型列表），编辑模式可改名 -->
      <div class="common-form-item">
        <label>模型 ID <span v-if="isAdd" class="common-form-required">*</span></label>
        <AutoComplete
          v-if="isAdd"
          v-model="form.id"
          :options="modelOptions"
          :loading="autoModelsLoading"
          filterable
          clearable
          placeholder="输入或从下拉选择模型"
          :popup-props="{ overlayStyle: { maxHeight: '280px', overflowY: 'auto' } }"
          @select="(val) => onModelIdSelect(val, form)"
        />
        <Input v-else v-model="newModelId" placeholder="模型 ID" />
        <template v-if="isAdd">
          <div v-if="autoModelsLoading" class="common-form-hint">正在自动拉取模型列表…</div>
          <div v-else-if="autoModelsError" class="common-form-hint common-fetch-error">
            自动获取失败：{{ autoModelsError }}
            <span class="common-fetch-retry" @click="fetchAutoModels(provider)">重试</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="common-form-hint">
            已自动获取 {{ autoModels.length }} 个模型，选中后自动填充名称/上下文等
          </div>
        </template>
      </div>
      <div class="common-form-item">
        <label>显示名称</label>
        <Input v-model="form.name" :placeholder="isAdd ? '留空则使用模型 ID' : '显示名称'" />
      </div>
      <div class="common-form-item">
        <label>输入类型</label>
        <Space size="16px" align="center" wrap>
          <CheckboxGroup v-model="form.input" class="common-checkbox-group">
            <Checkbox v-for="opt in INPUT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
          </CheckboxGroup>
          <Checkbox v-model="form.reasoning" class="common-reasoning-checkbox">推理模型</Checkbox>
        </Space>
      </div>
      <ModelLimitsFields v-model:context="form.contextWindow" v-model:output="form.maxTokens" item-class="common-form-item" />
      <Collapse v-model="advancedOpen" class="common-advanced-collapse">
        <CollapsePanel value="1" header="高级配置（费用 / 兼容性）">
          <div class="common-form-item">
            <label>费用 (cost) — 每百万 Token</label>
            <div class="common-form-row">
              <div class="common-form-item">
                <label>输入</label>
                <InputNumber v-model="form.cost.input" :min="0" :step="0.1" placeholder="0" />
              </div>
              <div class="common-form-item">
                <label>输出</label>
                <InputNumber v-model="form.cost.output" :min="0" :step="0.1" placeholder="0" />
              </div>
            </div>
            <div class="common-form-row">
              <div class="common-form-item">
                <label>缓存读取</label>
                <InputNumber v-model="form.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
              </div>
              <div class="common-form-item">
                <label>缓存写入</label>
                <InputNumber v-model="form.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
              </div>
            </div>
          </div>
          <div class="common-form-item">
            <label>兼容性 (compat)</label>
            <DynamicKvEditor
              v-model="form.compat"
              :key-options="compatKeyOptions"
              key-placeholder="compat 字段名"
              value-placeholder="compat 值"
            />
          </div>
          <!-- 各应用特有高级字段（如 opencode 思考参数） -->
          <slot name="advanced-extra" :form="form" />
        </CollapsePanel>
      </Collapse>
    </div>
  </Dialog>
</template>
