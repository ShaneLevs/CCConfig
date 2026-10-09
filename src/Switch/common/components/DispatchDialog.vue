<script setup>
import { ref, computed, watch } from "vue";
import { Dialog, Cascader, CheckboxGroup, Checkbox, Tooltip, MessagePlugin } from "tdesign-vue-next";
import { formatNumber } from "../../../utils/format";

// 下发到 Agent 弹窗：把通用库的供应商/模型写入各 agent 的模型配置。
// 样式沿用 common/styles/ConfigView.css 全局类（本组件仅在通用配置页使用）。
const props = defineProps({
  visible: { type: Boolean, default: false },
  providers: { type: Array, default: () => [] },
  // 打开时预选的 "供应商::模型ID" 键列表
  initialKeys: { type: Array, default: () => [] },
});
const emit = defineEmits(["update:visible"]);

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit("update:visible", v),
});

const AGENT_DISPATCH_OPTIONS = [
  { label: "Claude Code", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "Pi Agent", value: "pi" },
  { label: "omp", value: "omp" },
  { label: "Reasonix", value: "reasonix" },
  { label: "Codex", value: "codex" },
  { label: "Kimi Code", value: "kimi" },
  { label: "MiniMax Code", value: "minimax" },
  { label: "Qoder", value: "qoder" },
  { label: "ZCode", value: "zcode" },
  { label: "Hermes", value: "hermes" },
  { label: "DSH", value: "dsh" },
];

// 各 agent 支持的通用库协议（不在表内的目标不做协议限制）
const AGENT_PROTOCOLS = {
  claude: ["anthropic-messages"],
  codex: ["openai-completions", "openai-responses"],
  minimax: ["openai-completions", "openai-responses", "anthropic-messages"],
  qoder: ["openai-completions", "openai-responses", "anthropic-messages"],
  zcode: ["openai-completions", "openai-responses", "anthropic-messages"],
  hermes: ["openai-completions", "openai-responses", "anthropic-messages"],
};

const modelKeys = ref([]);
const targets = ref([]);
const submitting = ref(false);

// 供应商 + 模型合并为一个级联选择器：按供应商分组，value 用 "供应商::模型ID" 区分同名；
// 父级（供应商）选中时下发该供应商全部模型
const cascaderOptions = computed(() =>
  props.providers.map(p => ({
    label: p.name,
    value: p.name,
    children: (p.models || []).map(m => ({
      label: `${m.name || m.id}${m.contextWindow ? `（${formatNumber(m.contextWindow)} ctx）` : ""}`,
      value: `${p.name}::${m.id}`,
    })),
  }))
);

const selectedProviders = computed(() => {
  const names = new Set(modelKeys.value.map((k) => k.split("::")[0]));
  return props.providers.filter((p) => names.has(p.name));
});

// 所选供应商全部不支持该 agent 协议时禁用对应目标
const isTargetDisabled = (app) => {
  const allowed = AGENT_PROTOCOLS[app];
  if (!allowed) return false;
  return (
    selectedProviders.value.length > 0 &&
    !selectedProviders.value.some((p) => allowed.includes(p.api || "openai-completions"))
  );
};

// 所选协议变化导致目标失效时自动取消勾选（过滤幂等，与逐项目标 watch 等价）
watch(selectedProviders, () => {
  for (const app of Object.keys(AGENT_PROTOCOLS)) {
    if (isTargetDisabled(app)) targets.value = targets.value.filter((t) => t !== app);
  }
});

const handleDispatch = async () => {
  if (modelKeys.value.length === 0) return MessagePlugin.warning("请选择供应商与模型");
  if (targets.value.length === 0) return MessagePlugin.warning("请选择目标 agent");
  const targetPayload = targets.value.map(app => ({ app }));
  submitting.value = true;
  try {
    const allResults = [];
    const combos = [];
    for (const key of modelKeys.value) {
      const [pName, mId] = key.split("::");
      const provider = props.providers.find(p => p.name === pName);
      if (!provider) continue;
      if (mId) {
        const model = provider.models.find(m => m.id === mId);
        if (model) combos.push([provider, model]);
      } else {
        // 选中父级（整个供应商）：下发其全部模型
        provider.models.forEach(m => combos.push([provider, m]));
      }
    }
    for (const [provider, model] of combos) {
      const results = await window.services.dispatchCommonModel(provider, model, targetPayload);
      allResults.push(...results);
    }
    // 按 agent 聚合结果展示
    const byApp = {};
    allResults.forEach(r => {
      if (!byApp[r.app]) byApp[r.app] = { ok: 0, fail: 0, err: "" };
      if (r.ok) byApp[r.app].ok++;
      else { byApp[r.app].fail++; if (!byApp[r.app].err) byApp[r.app].err = r.message; }
    });
    const totalOk = allResults.filter(r => r.ok).length;
    const total = allResults.length;
    Object.entries(byApp).forEach(([app, s]) => {
      const label = (AGENT_DISPATCH_OPTIONS.find(o => o.value === app) || {}).label || app;
      if (s.fail === 0) MessagePlugin.success(`${label}: ${s.ok} 个模型下发成功`);
      else MessagePlugin.warning(`${label}: ${s.ok} 成功 / ${s.fail} 失败（${s.err}）`);
    });
    dialogVisible.value = false;
    if (totalOk === total) MessagePlugin.success(`下发完成：${totalOk}/${total} 成功`);
    else if (totalOk > 0) MessagePlugin.warning(`下发完成：${totalOk}/${total} 成功，部分失败`);
    else MessagePlugin.error(`下发失败：${total} 个目标全部失败`);
  } catch (e) {
    MessagePlugin.error("下发失败: " + e.message);
  } finally {
    submitting.value = false;
  }
};

watch(() => props.visible, (v) => {
  if (!v) return;
  modelKeys.value = [...props.initialKeys];
  targets.value = [];
});
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    header="下发模型到 Agent"
    width="560px"
    :confirm-btn="{ content: '下发', theme: 'primary', loading: submitting }"
    @confirm="handleDispatch"
  >
    <div class="common-edit-form">
      <div class="common-form-item">
        <label>供应商与模型 <span class="common-form-required">*</span></label>
        <Cascader
          v-model="modelKeys"
          :options="cascaderOptions"
          multiple
          filterable
          clearable
          placeholder="选择供应商与模型（可多选，勾选供应商 = 全选其模型）"
          :popup-props="{ overlayClassName: 'common-dispatch-select-popup' }"
        />
      </div>
      <div class="common-form-item">
        <label>目标 Agent <span class="common-form-required">*</span></label>
        <CheckboxGroup v-model="targets" class="common-dispatch-agents">
          <label v-for="opt in AGENT_DISPATCH_OPTIONS" :key="opt.value" class="common-dispatch-agent">
            <Tooltip v-if="opt.value === 'claude'" content="仅 Anthropic Messages 协议的供应商可下发 Claude Code">
              <Checkbox :value="opt.value" :disabled="isTargetDisabled('claude')" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
            </Tooltip>
            <Tooltip v-else-if="opt.value === 'codex'" content="仅 OpenAI Chat / Responses 协议的供应商可下发 Codex">
              <Checkbox :value="opt.value" :disabled="isTargetDisabled('codex')" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
            </Tooltip>
            <Tooltip v-else-if="opt.value === 'minimax'" content="仅 OpenAI Chat / Responses / Anthropic Messages 协议的供应商可下发 MiniMax Code；中文供应商名会自动清洗为 ASCII 供应商键">
              <Checkbox :value="opt.value" :disabled="isTargetDisabled('minimax')" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
            </Tooltip>
            <Tooltip v-else-if="opt.value === 'qoder'" content="仅 OpenAI Chat / Responses / Anthropic Messages 协议的供应商可下发 Qoder；中文供应商名会自动清洗为 ASCII 供应商键">
              <Checkbox :value="opt.value" :disabled="isTargetDisabled('qoder')" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
            </Tooltip>
            <Tooltip v-else-if="opt.value === 'zcode'" content="仅 OpenAI Chat / Responses / Anthropic Messages 协议的供应商可下发 ZCode；供应商名会按 ZCode 规则清洗为小写 ID">
              <Checkbox :value="opt.value" :disabled="isTargetDisabled('zcode')" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
            </Tooltip>
            <Tooltip v-else-if="opt.value === 'dsh'" content="dsh 支持四类协议（手工新增供应商时仅开放 OpenAI Chat / Anthropic Messages）；中文供应商名会自动清洗为路由名，密钥写入 ~/.dsh/.credentials.yaml">
              <Checkbox :value="opt.value" :disabled="isTargetDisabled('dsh')" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
            </Tooltip>
            <Checkbox v-else :value="opt.value" class="common-dispatch-checkbox">{{ opt.label }}</Checkbox>
          </label>
        </CheckboxGroup>
        <div class="common-form-hint">Claude → 写入 uTools DB 配置（Claude 配置页可见）；OpenCode → opencode.json；Pi → models.json；omp → models.yml；Reasonix → config.toml；Codex → ~/.codex/config.toml；Kimi → ~/.kimi-code/config.toml（别名 供应商/模型ID）；MiniMax Code → ~/.minimax/config.yaml（custom_provider，键名自动 ASCII 化）；Qoder → ~/.qoder/settings.json（providers，键名自动 ASCII 化）；ZCode → ~/.zcode/v2/provider_config.json（自定义模型，ID 按 ZCode 规则清洗）；Hermes → ~/.hermes/config.yaml；DSH → ~/.dsh/profiles/&lt;profile&gt;/cordis.patch.yml（llm-pi-ai.providers，路由名自动 ASCII 化，密钥写入 .credentials.yaml）</div>
      </div>
    </div>
  </Dialog>
</template>
