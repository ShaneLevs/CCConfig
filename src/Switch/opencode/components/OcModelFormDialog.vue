<script setup>
import { ref, computed, watch } from "vue";
import { Dialog, Input, InputNumber, Select, Checkbox, AutoComplete } from "tdesign-vue-next";
import ModelLimitsFields from "../../../components/ModelLimitsFields.vue";
import DynamicKvEditor from "../../../components/DynamicKvEditor.vue";
import { useAutoFetchModels } from "../../../composables/useAutoFetchModels";

// opencode 模型添加/编辑弹窗（二合一）：add 模式带 /models 自动拉取（选中条件回填），
// edit 模式额外暴露 SDK Options 与额外字段编辑器。表单对象由父级构建传入（initialForm），
// 确认时把表单副本交回父级执行 mutateProviderModels 写入。
// 样式沿用 opencode/styles/ConfigView.css 全局类（本组件仅在 opencode 配置页使用）。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'add' | 'edit'
  mode: { type: String, default: "add" },
  providerName: { type: String, default: "" },
  // add 模式：用于自动拉取模型列表的 { baseUrl, apiKey } 对象
  provider: { type: Object, default: null },
  // 打开时的表单初值（add 为空表单，edit 为父级从原始配置回读构建的对象）
  initialForm: { type: Object, required: true },
});
const emit = defineEmits(["update:visible", "confirm"]);

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const isAdd = computed(() => props.mode === "add");

// 输入/输出模态（opencode modalities 合法值，源自 provider.ts capabilities 解析）
const MODALITY_OPTIONS = [
  { label: "文本 (text)", value: "text" },
  { label: "图像 (image)", value: "image" },
  { label: "音频 (audio)", value: "audio" },
  { label: "视频 (video)", value: "video" },
  { label: "PDF", value: "pdf" },
];
// 思考参数（options.effort / options.thinking，与 MiniMax 页同款枚举）
const EFFORT_OPTIONS = ["minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ label: v, value: v }));
const THINKING_TYPE_OPTIONS = [
  { label: "enabled（预算式思考）", value: "enabled" },
  { label: "adaptive（自适应思考）", value: "adaptive" },
  { label: "disabled（关闭思考）", value: "disabled" },
];

const {
  autoModels, autoModelsLoading, autoModelsError, modelOptions, fetchAutoModels, resetAutoModels,
} = useAutoFetchModels();

const form = ref({});

// 选中模型：条件回填（仅在拉取到值时覆盖，不清空用户已填内容）
const onAutoModelSelect = (val) => {
  const m = autoModels.value.find(x => x.id === val);
  if (!m) return;
  form.value.id = m.id;
  form.value.name = m.name || m.id;
  if (m.contextWindow) form.value.context = m.contextWindow;
  if (m.maxTokens) form.value.output = m.maxTokens;
  if (m.reasoning) form.value.reasoning = true;
};

watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    form.value = { ...props.initialForm };
    if (isAdd.value) {
      resetAutoModels();
      // 打开弹窗即自动拉取模型列表，无需手动点击
      fetchAutoModels(props.provider, "该 Provider 未配置 Base URL，无法自动获取");
    }
  }
);

const handleConfirm = () => {
  emit("confirm", { ...form.value });
};
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    :header="isAdd ? '添加模型' : '编辑模型'"
    width="520px"
    :confirm-btn="{ content: isAdd ? '添加' : '保存', theme: 'primary' }"
    @confirm="handleConfirm"
  >
    <div class="oc-form">
      <div class="oc-form-item">
        <label>所属 Provider</label>
        <div class="oc-provider-name">{{ providerName }}</div>
      </div>
      <div class="oc-form-item">
        <label>模型 ID <span class="required">*</span></label>
        <AutoComplete
          v-if="isAdd"
          v-model="form.id"
          :options="modelOptions"
          :loading="autoModelsLoading"
          filterable
          clearable
          placeholder="输入或从下拉选择模型"
          @select="onAutoModelSelect"
        />
        <Input v-else v-model="form.id" placeholder="例如: deepseek-chat" />
        <template v-if="isAdd">
          <div v-if="autoModelsLoading" class="oc-form-hint">正在自动拉取模型列表…</div>
          <div v-else-if="autoModelsError" class="oc-form-hint oc-fetch-error">
            自动获取失败：{{ autoModelsError }}
            <span class="oc-fetch-retry" @click="fetchAutoModels(provider, '该 Provider 未配置 Base URL，无法自动获取')">重试</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="oc-form-hint">
            已自动获取 {{ autoModels.length }} 个模型，选中后自动填充名称/上下文等
          </div>
        </template>
      </div>
      <div class="oc-form-item">
        <label>显示名称</label>
        <Input v-model="form.name" placeholder="留空则使用模型 ID" />
      </div>
      <ModelLimitsFields v-model:context="form.context" v-model:output="form.output" item-class="oc-form-item" />
      <div class="oc-form-item">
        <Checkbox v-model="form.reasoning">推理模型 (reasoning)</Checkbox>
      </div>
      <div class="oc-form-item-row">
        <div class="oc-form-item oc-form-item--flex">
          <label>输入模态</label>
          <Select v-model="form.modalitiesInput" multiple clearable :options="MODALITY_OPTIONS" placeholder="默认：仅文本" />
        </div>
        <div class="oc-form-item oc-form-item--flex">
          <label>输出模态</label>
          <Select v-model="form.modalitiesOutput" multiple clearable :options="MODALITY_OPTIONS" placeholder="默认：仅文本" />
        </div>
      </div>
      <div class="oc-form-item-row">
        <div class="oc-form-item oc-form-item--flex">
          <label>思考档位</label>
          <Select v-model="form.effort" :options="EFFORT_OPTIONS" clearable placeholder="不设置" />
        </div>
        <div class="oc-form-item oc-form-item--flex">
          <label>思考模式</label>
          <Select v-model="form.thinkingType" :options="THINKING_TYPE_OPTIONS" clearable placeholder="不设置" />
        </div>
      </div>
      <div v-if="form.thinkingType === 'enabled'" class="oc-form-item">
        <label>思考预算（budgetTokens，0 = 不写入）</label>
        <InputNumber v-model="form.thinkingBudget" :min="0" :step="1024" placeholder="0 = 不写入" />
      </div>
      <template v-if="!isAdd">
        <div class="oc-form-subsection">
          <div class="oc-form-subsection-title">SDK Options</div>
          <DynamicKvEditor
            v-model="form.sdkOptions"
            :key-options="[]"
            key-placeholder="选项名"
            value-placeholder="选项值"
          />
        </div>
        <div class="oc-form-subsection">
          <div class="oc-form-subsection-title">额外字段 (variants, cost, tool_call 等)</div>
          <DynamicKvEditor
            v-model="form.extraFields"
            :key-options="[]"
            key-placeholder="字段名"
            value-placeholder="字段值 (JSON 或字符串)"
          />
        </div>
      </template>
    </div>
  </Dialog>
</template>
