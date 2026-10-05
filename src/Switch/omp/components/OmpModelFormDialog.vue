<script setup>
import { ref, computed, watch } from "vue";
import { Dialog, Input, InputNumber, Textarea, MessagePlugin, Select, Space, CheckboxGroup, Checkbox, Collapse, CollapsePanel, AutoComplete } from "tdesign-vue-next";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import ModelLimitsFields from "../../../components/ModelLimitsFields.vue";
import { useAutoFetchModels } from "../../../composables/useAutoFetchModels";

// omp 模型添加/编辑弹窗（二合一）：高级区为「思考级别 + 费用 + 其他参数 YAML」，
// 编辑模式可改模型 ID（重命名由父级以删旧建新方式落库）。
// 样式沿用 omp/styles/ConfigView.css 全局类（本组件仅在 omp 配置页使用）。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 'add' | 'edit'
  mode: { type: String, default: "add" },
  providerName: { type: String, default: "" },
  // add 模式：用于自动拉取模型列表的 { baseUrl, apiKey } 对象
  provider: { type: Object, default: null },
  // edit 模式：原模型对象
  initial: { type: Object, default: null },
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

const THINKING_MODE_OPTIONS = [
  { label: "effort", value: "effort" },
  { label: "auto", value: "auto" },
];

// 思考级别顺序（小 → 大）
const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];

const emptyThinking = () => ({ minLevel: "", maxLevel: "", mode: "" });

// 表单已管理的模型字段（不在 YAML 文本框里展示）
const MODEL_FORM_KEYS = ["id", "name", "contextWindow", "maxTokens", "reasoning", "input", "thinking", "cost"];

// compat 等参数用 YAML 文本编辑（子级 4 空格缩进，照搬 models.yml 写法）
const dumpYaml = (obj) => {
  if (obj == null) return "";
  try { return yamlDump(obj, { indent: 4 }).replace(/\n$/, ""); } catch { return ""; }
};
const parseYaml = (str) => {
  const t = (str ?? "").trim();
  if (!t) return {};
  try {
    const result = yamlLoad(t);
    // 必须是普通对象（映射）；标量/数组展开成 `...other` 会产生数字键垃圾
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    return result;
  } catch { return null; }
};

// 提取模型对象中表单未管理的字段（compat 及自定义同级参数）
const dumpOtherFields = (model) => {
  if (!model || typeof model !== "object") return "";
  const rest = {};
  for (const [k, v] of Object.entries(model)) {
    if (MODEL_FORM_KEYS.includes(k)) continue;
    // 跳过空值：undefined/null/''/空对象/空数组（避免显示 compat: {}）
    if (v == null) continue;
    if (typeof v === "object" && Object.keys(v).length === 0) continue;
    rest[k] = v;
  }
  if (!Object.keys(rest).length) return "";
  return dumpYaml(rest);
};

// 表单 → models.yml 模型条目：其他参数（compat 及自定义同级字段）在前，
// 表单字段在后覆盖同名键；thinking 仅在有值时写入
const buildModelPayload = (form, fallbackId) => {
  const other = parseYaml(form.otherYaml);
  if (other === null) throw new Error("其他参数 (YAML) 格式不正确");
  const id = form.id?.trim() || fallbackId;
  const thinking = {};
  if (form.thinking?.mode) thinking.mode = form.thinking.mode;
  if (form.thinking?.minLevel) thinking.minLevel = form.thinking.minLevel;
  if (form.thinking?.maxLevel) thinking.maxLevel = form.thinking.maxLevel;
  const hasThinking = thinking.mode || thinking.minLevel || thinking.maxLevel;
  return {
    ...other,
    id,
    name: form.name.trim() || id,
    contextWindow: Number(form.contextWindow) || 0,
    maxTokens: Number(form.maxTokens) || 0,
    reasoning: form.reasoning,
    input: form.input,
    cost: form.cost,
    thinking: hasThinking ? thinking : undefined,
  };
};

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
  thinking: emptyThinking(),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  otherYaml: "",
});
const form = ref(defaultForm());
// 编辑时的新模型 ID（重命名）
const newModelId = ref("");
const advancedOpen = ref(false);

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
        id: m.id || "",
        name: m.name || "",
        contextWindow: m.contextWindow || 0,
        maxTokens: m.maxTokens || 0,
        reasoning: !!m.reasoning,
        input: m.input || ["text"],
        thinking: m.thinking ? { minLevel: m.thinking.minLevel || "", maxLevel: m.thinking.maxLevel || "", mode: m.thinking.mode || "" } : emptyThinking(),
        cost: (m.cost && m.cost.input != null) ? { ...m.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        otherYaml: dumpOtherFields(m),
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
  let payload;
  try {
    payload = buildModelPayload({ ...form.value, id }, id);
  } catch (e) {
    MessagePlugin.error((isAdd.value ? "添加失败: " : "保存失败: ") + e.message);
    return;
  }
  emit("confirm", {
    mode: props.mode,
    providerName: props.providerName,
    originalId: isAdd.value ? null : props.initial?.id ?? null,
    id,
    payload,
  });
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
    <div class="omp-edit-form">
      <div v-if="isAdd" class="omp-form-item">
        <label>所属供应商</label>
        <div class="omp-edit-provider-name">{{ providerName }}</div>
      </div>

      <!-- 模型 ID：添加模式用 AutoComplete（弹窗打开时已自动拉取模型列表），编辑模式可改名 -->
      <div class="omp-form-item">
        <label>模型 ID <span v-if="isAdd" class="omp-form-required">*</span></label>
        <AutoComplete
          v-if="isAdd"
          v-model="form.id"
          :options="modelOptions"
          :loading="autoModelsLoading"
          filterable
          clearable
          placeholder="输入或从下拉选择模型"
          @select="(val) => onModelIdSelect(val, form)"
        />
        <Input v-else v-model="newModelId" placeholder="模型 ID" />
        <template v-if="isAdd">
          <div v-if="autoModelsLoading" class="omp-form-hint">正在自动拉取模型列表…</div>
          <div v-else-if="autoModelsError" class="omp-form-hint omp-fetch-error">
            自动获取失败：{{ autoModelsError }}
            <span class="omp-fetch-retry" @click="fetchAutoModels(provider)">重试</span>
          </div>
          <div v-else-if="autoModels.length > 0" class="omp-form-hint">
            已自动获取 {{ autoModels.length }} 个模型，选中后自动填充名称/上下文等
          </div>
        </template>
      </div>
      <div class="omp-form-item">
        <label>显示名称</label>
        <Input v-model="form.name" :placeholder="isAdd ? '留空则使用模型 ID' : '显示名称'" />
      </div>
      <div class="omp-form-item">
        <label>输入类型</label>
        <Space size="16px" align="center" wrap>
          <CheckboxGroup v-model="form.input" class="omp-checkbox-group">
            <Checkbox v-for="opt in INPUT_TYPE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</Checkbox>
          </CheckboxGroup>
          <Checkbox v-model="form.reasoning" class="omp-reasoning-checkbox">推理模型</Checkbox>
        </Space>
      </div>
      <ModelLimitsFields v-model:context="form.contextWindow" v-model:output="form.maxTokens" item-class="omp-form-item" />
      <Collapse v-model="advancedOpen" class="omp-advanced-collapse">
        <CollapsePanel value="1" header="高级配置（思考级别 / 费用 / 兼容性）">
          <div class="omp-form-item">
            <label>思考级别 (thinking)</label>
            <div class="omp-form-row">
              <div class="omp-form-item">
                <label>模式</label>
                <Select v-model="form.thinking.mode" :options="THINKING_MODE_OPTIONS" clearable placeholder="不设置" />
              </div>
            </div>
            <div class="omp-form-row">
              <div class="omp-form-item">
                <label>最小级别</label>
                <Select v-model="form.thinking.minLevel" :options="LEVEL_ORDER.map(v => ({ label: v, value: v }))" clearable placeholder="不限制" />
              </div>
              <div class="omp-form-item">
                <label>最大级别</label>
                <Select v-model="form.thinking.maxLevel" :options="LEVEL_ORDER.map(v => ({ label: v, value: v }))" clearable placeholder="不限制" />
              </div>
            </div>
            <div class="omp-form-hint">角色选择模型时，思考级别只显示 minLevel ~ maxLevel 范围</div>
          </div>
          <div class="omp-form-item">
            <label>费用 (cost) — 每百万 Token</label>
            <div class="omp-form-row">
              <div class="omp-form-item">
                <label>输入</label>
                <InputNumber v-model="form.cost.input" :min="0" :step="0.1" placeholder="0" />
              </div>
              <div class="omp-form-item">
                <label>输出</label>
                <InputNumber v-model="form.cost.output" :min="0" :step="0.1" placeholder="0" />
              </div>
            </div>
            <div class="omp-form-row">
              <div class="omp-form-item">
                <label>缓存读取</label>
                <InputNumber v-model="form.cost.cacheRead" :min="0" :step="0.1" placeholder="0" />
              </div>
              <div class="omp-form-item">
                <label>缓存写入</label>
                <InputNumber v-model="form.cost.cacheWrite" :min="0" :step="0.1" placeholder="0" />
              </div>
            </div>
          </div>
          <div class="omp-form-item">
            <label>其他参数</label>
            <Textarea
              v-model="form.otherYaml"
              placeholder="compat:&#10;    supportsDeveloperRole: false&#10;    reasoningEffortMap:&#10;        high: high&#10;自定义字段: 值"
              :autosize="{ minRows: 4, maxRows: 14 }"
            />
            <div class="omp-form-hint">原生 YAML，除上方表单字段外的模型参数都在这里，子级 4 空格缩进</div>
          </div>
        </CollapsePanel>
      </Collapse>
    </div>
  </Dialog>
</template>
