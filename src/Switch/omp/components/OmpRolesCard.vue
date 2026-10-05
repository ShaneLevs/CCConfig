<script setup>
import { ref, computed, onMounted } from "vue";
import { Card, Button, Tag, Space, Dropdown, Dialog, Select, MessagePlugin, Popconfirm } from "tdesign-vue-next";
import { EditIcon, AddIcon, DeleteIcon } from "tdesign-icons-vue-next";

// omp 模型角色（config.yml · modelRoles）：已配置角色展示 + 添加/编辑/删除。
// 组件自持角色数据，父组件刷新时通过 ref 调 load()；加载失败经 load-error 上抛。
const props = defineProps({
  providers: { type: Array, default: () => [] },
});
const emit = defineEmits(["load-error"]);

// 模型角色场景（固定顺序）
const ROLE_ORDER = ["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"];
const ROLE_LABELS = {
  default: "默认",
  smol: "快速",
  slow: "深度",
  vision: "视觉",
  plan: "规划",
  designer: "设计",
  commit: "提交",
  tiny: "微小",
  task: "任务",
  advisor: "顾问",
};
// 思考级别顺序（小 → 大）
const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];

const modelRoles = ref({});

// 角色弹窗
const roleDialog = ref(false);
const editingRole = ref("");
const roleForm = ref({ provider: "", modelId: "", level: "" });

const load = () => {
  try {
    modelRoles.value = window.services.readOmpModelRoles() || {};
  } catch (e) {
    console.error("加载 omp 配置失败:", e);
    modelRoles.value = {};
    emit("load-error", e.message || "加载失败");
  }
};

const parseRef = (ref) => {
  if (!ref) return null;
  try { return window.services.parseOmpModelRef(ref); } catch { return null; }
};

const findModelProvider = (modelId) => {
  for (const p of props.providers) {
    if (p.models.some(m => m.id === modelId)) return p;
  }
  return null;
};

const findModelById = (providerName, modelId) => {
  const prov = props.providers.find(p => p.name === providerName);
  return prov?.models.find(m => m.id === modelId) || null;
};

// 只展示已配置的角色，未配置的通过「添加角色」入口配置
const configuredRoles = computed(() => ROLE_ORDER.filter(r => modelRoles.value[r]));
const unconfiguredRoles = computed(() => ROLE_ORDER.filter(r => !modelRoles.value[r]));

// 解析角色引用为可展示信息（无前缀引用补全供应商）
const getRoleDisplay = (role) => {
  const ref = modelRoles.value[role];
  if (!ref) return null;
  const parsed = parseRef(ref);
  if (!parsed) return null;
  let provider = parsed.provider;
  if (!provider) {
    const found = findModelProvider(parsed.model);
    if (found) provider = found.name;
  }
  const modelObj = provider ? findModelById(provider, parsed.model) : null;
  return {
    ref,
    provider,
    model: parsed.model,
    modelName: modelObj?.name || parsed.model,
    level: parsed.level,
  };
};

const roleDisplays = computed(() => {
  const map = {};
  for (const role of configuredRoles.value) {
    map[role] = getRoleDisplay(role);
  }
  return map;
});

const onAddRole = (data) => {
  const role = typeof data === "object" ? data.value : data;
  openRoleDialog(role);
};

const openRoleDialog = (role) => {
  editingRole.value = role;
  const ref = modelRoles.value[role];
  const parsed = parseRef(ref);
  let provider = parsed?.provider || "";
  let modelId = parsed?.model || "";
  // 无前缀引用：尝试匹配到具体供应商
  if (parsed && !parsed.provider) {
    const found = findModelProvider(parsed.model);
    if (found) { provider = found.name; modelId = parsed.model; }
  }
  if (!provider && props.providers.length) provider = props.providers[0].name;
  roleForm.value = { provider, modelId, level: parsed?.level || "" };
  roleDialog.value = true;
};

const roleModelOptions = computed(() => {
  const prov = props.providers.find(p => p.name === roleForm.value.provider);
  return (prov?.models || []).map(m => ({ label: m.name || m.id, value: m.id }));
});

const roleLevelOptions = computed(() => {
  const prov = props.providers.find(p => p.name === roleForm.value.provider);
  const model = prov?.models.find(m => m.id === roleForm.value.modelId);
  const opts = [{ label: "默认（不指定）", value: "" }];
  if (!model?.thinking?.minLevel || !model?.thinking?.maxLevel) return opts;
  const start = LEVEL_ORDER.indexOf(model.thinking.minLevel);
  const end = LEVEL_ORDER.indexOf(model.thinking.maxLevel);
  if (start === -1 || end === -1) return opts;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  for (let i = lo; i <= hi; i++) opts.push({ label: LEVEL_ORDER[i], value: LEVEL_ORDER[i] });
  return opts;
});

const onRoleProviderChange = () => {
  roleForm.value.modelId = "";
  roleForm.value.level = "";
};

const saveRole = () => {
  try {
    const { provider, modelId, level } = roleForm.value;
    if (!provider || !modelId) { MessagePlugin.warning("请选择供应商和模型"); return; }
    const ref = `${provider}/${modelId}` + (level ? `:${level}` : "");
    const next = { ...modelRoles.value, [editingRole.value]: ref };
    window.services.writeOmpModelRoles(next);
    modelRoles.value = next;
    MessagePlugin.success(`已设置 ${editingRole.value} = ${ref}`);
    roleDialog.value = false;
  } catch (e) {
    MessagePlugin.error("保存失败: " + e.message);
  }
};

const handleDeleteRole = (role) => {
  try {
    const next = { ...modelRoles.value };
    delete next[role];
    window.services.writeOmpModelRoles(next);
    modelRoles.value = next;
    MessagePlugin.success(`已删除角色 ${role}`);
  } catch (e) {
    MessagePlugin.error("删除失败: " + e.message);
  }
};

defineExpose({ load });
onMounted(load);
</script>

<template>
  <Card :bordered="true" class="omp-roles-card">
    <template #header>
      <div class="omp-roles-header">
        <Space size="12px" align="center">
          <span class="omp-roles-title">模型角色</span>
          <span class="omp-roles-sub">config.yml · modelRoles</span>
          <Tag size="small" variant="outline">{{ configuredRoles.length }} 个已配置</Tag>
        </Space>
        <Dropdown
          v-if="unconfiguredRoles.length"
          :options="unconfiguredRoles.map(r => ({ content: `${ROLE_LABELS[r] || r} (${r})`, value: r }))"
          :min-column-width="140"
          @click="onAddRole"
        >
          <Button size="small" variant="outline">
            <template #icon><AddIcon /></template> 添加角色
          </Button>
        </Dropdown>
      </div>
    </template>
    <div v-for="role in configuredRoles" :key="role" class="omp-role-row">
      <Space size="8px" align="center" class="omp-role-name-wrap">
        <span class="omp-role-name">{{ ROLE_LABELS[role] || role }}</span>
        <code class="omp-role-code">{{ role }}</code>
      </Space>
      <Space size="8px" align="center" class="omp-role-model">
        <span class="omp-role-model-name">{{ roleDisplays[role]?.modelName }}</span>
        <span class="omp-role-model-ref mono">{{ roleDisplays[role]?.provider }}/{{ roleDisplays[role]?.model }}</span>
        <Tag v-if="roleDisplays[role]?.level" size="small" theme="warning" variant="light">{{ roleDisplays[role].level }}</Tag>
      </Space>
      <div class="omp-role-actions">
        <Space size="4px" align="center">
          <Button size="small" variant="text" @click="openRoleDialog(role)">
            <template #icon><EditIcon /></template>
          </Button>
          <Popconfirm content="确定删除此角色？删除后该场景将使用系统默认模型。" @confirm="handleDeleteRole(role)">
            <Button size="small" variant="text" theme="danger">
              <template #icon><DeleteIcon /></template>
            </Button>
          </Popconfirm>
        </Space>
      </div>
    </div>
  </Card>

  <!-- 角色编辑弹窗 -->
  <Dialog v-model:visible="roleDialog" :header="`选择模型角色 — ${ROLE_LABELS[editingRole] || editingRole}`" width="480px" :confirm-btn="{ content: '保存', theme: 'primary' }" @confirm="saveRole">
    <div class="omp-edit-form">
      <div class="omp-form-item">
        <label>角色</label>
        <div class="omp-edit-role-name"><code>{{ editingRole }}</code></div>
      </div>
      <div class="omp-form-item">
        <label>供应商</label>
        <Select v-model="roleForm.provider" :options="providers.map(p => ({ label: p.name, value: p.name }))" filterable placeholder="选择供应商" @change="onRoleProviderChange" />
      </div>
      <div class="omp-form-item">
        <label>模型</label>
        <Select v-model="roleForm.modelId" :options="roleModelOptions" filterable placeholder="选择模型" />
      </div>
      <div class="omp-form-item">
        <label>思考级别</label>
        <Select v-model="roleForm.level" :options="roleLevelOptions" placeholder="默认（不指定）" />
        <div class="omp-form-hint">级别范围由所选模型的 thinking 配置决定</div>
      </div>
    </div>
  </Dialog>
</template>
