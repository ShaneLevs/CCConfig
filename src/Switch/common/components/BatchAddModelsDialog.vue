<script setup>
import { ref, computed, watch, h } from "vue";
import {
  Button, Input, Select, Checkbox, Table, Dialog, MessagePlugin,
} from "tdesign-vue-next";
import { RefreshIcon } from "tdesign-icons-vue-next";
import { CTX_OPTIONS, TOKENS_OPTIONS } from "../../../constants";
import { formatNumber } from "../../../utils/format";

// 批量添加模型弹窗：拉取供应商全部模型 → 勾选 → 行内统一配置 → 一次性写入（重复 ID 自动跳过）。
// 样式沿用 common/styles/ConfigView.css 的 common-batch-* 全局类（本组件仅在通用配置页使用）。
const props = defineProps({
  visible: { type: Boolean, default: false },
  // 目标供应商对象（含 baseUrl / apiKey / models）
  provider: { type: Object, default: null },
});
const emit = defineEmits(["update:visible", "added"]);

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const batchModels = ref([]);          // 拉取到的全部模型（含可选的 name/上下文等元信息）
const batchLoading = ref(false);
const batchError = ref("");
const batchSelected = ref([]);        // 勾选的模型 ID 列表（表格多选）
const batchEdits = ref({});           // 模型 ID → 行内编辑值 { input, contextWindow, maxTokens, reasoning }
const batchSubmitting = ref(false);
const batchFilter = ref('');          // 列表过滤关键字（模型 ID / 拉取名称）

const fetchBatchModels = async () => {
  const prov = props.provider;
  if (!prov || !prov.baseUrl) {
    batchError.value = '该供应商未配置 Base URL，无法自动获取';
    return;
  }
  batchLoading.value = true;
  batchError.value = '';
  try {
    const list = await window.services.fetchProviderModels(prov.baseUrl, prov.apiKey);
    batchModels.value = list;
    list.forEach(ensureBatchEdit);   // 预填充行内编辑值（优先拉取到的元信息）
    if (list.length === 0) batchError.value = '接口返回空列表';
  } catch (e) {
    batchError.value = e.message;
    batchModels.value = [];
  } finally {
    batchLoading.value = false;
  }
};

// 已存在于通用库中的模型 ID（勾选时预过滤，提示将被跳过）
const batchExistingIds = computed(
  () => new Set((props.provider?.models || []).map(m => m.id))
);

const batchFilteredModels = computed(() => {
  const kw = batchFilter.value.trim().toLowerCase();
  if (!kw) return batchModels.value;
  return batchModels.value.filter(m =>
    m.id.toLowerCase().includes(kw) || (m.name || '').toLowerCase().includes(kw)
  );
});

const batchColumns = computed(() => [
  { colKey: 'row-select', type: 'multiple', width: 46 },
  { colKey: 'id', title: '模型 ID', ellipsis: true },
  { colKey: 'text', title: () => renderBatchColHeader('text', '文本'), width: 64 },
  { colKey: 'image', title: () => renderBatchColHeader('image', '图像'), width: 64 },
  { colKey: 'reasoning', title: () => renderBatchColHeader('reasoning', '思考'), width: 64 },
  { colKey: 'contextWindow', title: () => renderBatchHeaderSelect('contextWindow', batchCtxOptions.value, '上下文窗口'), width: 130 },
  { colKey: 'maxTokens', title: () => renderBatchHeaderSelect('maxTokens', batchTokensOptions.value, '最大输出'), width: 130 },
]);

const onBatchSelectChange = (keys) => {
  batchSelected.value = keys;
};

// 行内编辑值：优先用已有编辑，否则用拉取到的元信息，再否则默认值
const DEFAULT_BATCH_EDIT = () => ({ input: ['text'], contextWindow: 0, maxTokens: 0, reasoning: false });

const ensureBatchEdit = (m) => {
  if (batchEdits.value[m.id]) return;
  batchEdits.value[m.id] = {
    input: ['text'],
    contextWindow: m.contextWindow || 0,
    maxTokens: m.maxTokens || 0,
    reasoning: !!m.reasoning,
  };
};

const editOf = (row) => batchEdits.value[row.id] || DEFAULT_BATCH_EDIT();

const setBatchEdit = (row, key, value) => {
  ensureBatchEdit(row);
  batchEdits.value[row.id][key] = value;
};

// 文本输入 / 图像输入 / 思考 三列：单元格单复选框，表头复选框全选当前可见行
const hasBatchFlag = (m, flag) => {
  const e = editOf(m);
  return flag === 'reasoning' ? !!e.reasoning : e.input.includes(flag);
};

const setBatchFlag = (row, flag, checked) => {
  ensureBatchEdit(row);
  const e = batchEdits.value[row.id];
  if (flag === 'reasoning') { e.reasoning = !!checked; return; }
  const set = new Set(e.input);
  if (checked) set.add(flag); else set.delete(flag);
  e.input = Array.from(set);
};

const toggleBatchColAll = (flag, checked) => {
  batchFilteredModels.value.forEach(m => setBatchFlag(m, flag, checked));
};

// 表头默认只显示文字，hover 时才显示复选框（可全选/半选该列）
const renderBatchColHeader = (flag, label) => {
  const rows = batchFilteredModels.value;
  const checkedCount = rows.filter(m => hasBatchFlag(m, flag)).length;
  const all = rows.length > 0 && checkedCount === rows.length;
  return h('div', { class: 'common-batch-flag-header' }, [
    h(Checkbox, {
      modelValue: all,
      indeterminate: checkedCount > 0 && !all,
      class: 'common-batch-checkbox',
      title: `全选/取消全选「${label}」`,
      onChange: (checked) => toggleBatchColAll(flag, checked),
    }),
    h('span', { class: 'common-batch-flag-label' }, label),
  ]);
};

// 上下文窗口 / 最大输出表头下拉：选中值后批量应用到勾选行（未勾选则应用到当前可见行），表头不保留选中值
const applyBatchColumn = (key, value) => {
  const visible = batchFilteredModels.value;
  const targets = batchSelected.value.length > 0
    ? visible.filter(m => batchSelected.value.includes(m.id))
    : visible;
  if (targets.length === 0) return;
  targets.forEach(m => setBatchEdit(m, key, value));
  MessagePlugin.success(`已应用到 ${targets.length} 个模型`);
};

const renderBatchHeaderSelect = (key, options, placeholder) => h(Select, {
  modelValue: null,
  placeholder,
  size: 'small',
  options,
  class: 'common-batch-header-select',
  onChange: (v) => applyBatchColumn(key, v),
});

// 预设 + 拉取到的非标准值合并为下拉选项（避免选中项不在选项里）
const mergePresetOptions = (presets, values) => {
  const std = new Set(presets.map(o => o.value));
  const extra = values
    .filter(v => v && !std.has(v))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .sort((a, b) => a - b)
    .map(v => ({ label: formatNumber(v), value: v }));
  return [...presets, ...extra];
};

// 上下文窗口 / 最大输出下拉选项：标准预设 + 接口返回的非标准值自动补进选项不丢数据
const batchCtxOptions = computed(() =>
  mergePresetOptions(CTX_OPTIONS, batchModels.value.map(m => m.contextWindow))
);
const batchTokensOptions = computed(() =>
  mergePresetOptions(TOKENS_OPTIONS, batchModels.value.map(m => m.maxTokens))
);

const handleBatchAdd = async () => {
  if (batchSelected.value.length === 0) { MessagePlugin.warning('请先勾选要添加的模型'); return; }
  const models = batchSelected.value.map(id => {
    const fetched = batchModels.value.find(m => m.id === id) || {};
    const e = batchEdits.value[id] || {};
    return {
      id,
      name: fetched.name || id,
      contextWindow: Number(e.contextWindow) || 0,
      maxTokens: Number(e.maxTokens) || 0,
      reasoning: 'reasoning' in e ? !!e.reasoning : !!fetched.reasoning,
      input: e.input && e.input.length > 0 ? e.input : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {},
    };
  });
  batchSubmitting.value = true;
  try {
    const { added, skipped } = window.services.addCommonModels(props.provider.name, models);
    if (added.length > 0) MessagePlugin.success(`已批量添加 ${added.length} 个模型`);
    if (skipped.length > 0) MessagePlugin.warning(`已自动跳过 ${skipped.length} 个重复模型：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}`);
    if (added.length > 0) {
      dialogVisible.value = false;
      emit("added");
    }
  } catch (e) {
    MessagePlugin.error('批量添加失败: ' + e.message);
  } finally {
    batchSubmitting.value = false;
  }
};

// 打开弹窗即重置并自动拉取模型列表（与单个添加弹窗行为一致）
watch(() => props.visible, (v) => {
  if (!v) return;
  batchModels.value = [];
  batchSelected.value = [];
  batchEdits.value = {};
  batchError.value = '';
  batchFilter.value = '';
  fetchBatchModels();
});
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    :header="`批量添加模型${provider ? ' — ' + provider.name : ''}`"
    width="780px"
    dialog-class-name="common-batch-dialog"
    :confirm-btn="{ content: `添加 ${batchSelected.length} 个`, theme: 'primary', loading: batchSubmitting, disabled: batchSelected.length === 0 }"
    @confirm="handleBatchAdd"
  >
    <div class="common-edit-form common-batch-form">
      <div class="common-batch-toolbar">
        <Input
          v-model="batchFilter"
          size="small"
          clearable
          placeholder="过滤模型 ID / 名称"
          class="common-batch-filter"
        />
        <Button size="small" variant="outline" :loading="batchLoading" @click="fetchBatchModels">
          <template #icon><RefreshIcon /></template> 刷新
        </Button>
        <span class="common-batch-count">
          已选 {{ batchSelected.length }} / {{ batchModels.length }} 个
        </span>
      </div>

      <div v-if="batchLoading" class="common-form-hint">正在自动拉取模型列表…</div>
      <div v-else-if="batchError" class="common-form-hint common-fetch-error">
        自动获取失败：{{ batchError }}
        <span class="common-fetch-retry" @click="fetchBatchModels">重试</span>
      </div>
      <Table
        v-else-if="batchModels.length > 0"
        :data="batchFilteredModels"
        :columns="batchColumns"
        row-key="id"
        size="small"
        class="common-batch-table"
        :max-height="320"
        :selected-row-keys="batchSelected"
        @select-change="onBatchSelectChange"
      >
        <template #id="{ row }">
          <div class="common-batch-id-cell">
            <span v-if="batchExistingIds.has(row.id)" class="common-batch-exist-dot" title="已存在，将自动跳过"></span>
            <span class="common-batch-item-id">{{ row.id }}</span>
          </div>
        </template>
        <template #text="{ row }">
          <Checkbox
            class="common-batch-checkbox"
            :model-value="editOf(row).input.includes('text')"
            @change="(c) => setBatchFlag(row, 'text', c)"
          />
        </template>
        <template #image="{ row }">
          <Checkbox
            class="common-batch-checkbox"
            :model-value="editOf(row).input.includes('image')"
            @change="(c) => setBatchFlag(row, 'image', c)"
          />
        </template>
        <template #reasoning="{ row }">
          <Checkbox
            class="common-batch-checkbox"
            :model-value="!!editOf(row).reasoning"
            @change="(c) => setBatchFlag(row, 'reasoning', c)"
          />
        </template>
        <template #contextWindow="{ row }">
          <Select
            :model-value="editOf(row).contextWindow"
            size="small"
            :options="batchCtxOptions"
            filterable
            @change="(v) => setBatchEdit(row, 'contextWindow', v)"
          />
        </template>
        <template #maxTokens="{ row }">
          <Select
            :model-value="editOf(row).maxTokens"
            size="small"
            :options="batchTokensOptions"
            filterable
            @change="(v) => setBatchEdit(row, 'maxTokens', v)"
          />
        </template>
      </Table>
      <div v-else class="common-form-hint">暂无模型</div>

      <div class="common-form-hint">表头复选框可全选该列；上下文窗口 / 最大输出的表头下拉可批量应用到勾选行（未勾选则应用到可见行）；模型 ID 重复的会自动过滤不添加。</div>
    </div>
  </Dialog>
</template>
