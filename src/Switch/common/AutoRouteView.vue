<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { MessagePlugin, Button, Switch, Tag, Tooltip, Dialog, CheckboxGroup, Checkbox, Input, Cascader } from "tdesign-vue-next";
import { CopyIcon, RefreshIcon, SendIcon } from "tdesign-icons-vue-next";
import { useAutoRouteStatus } from "../../composables/useAutoRouteStatus";
import "./styles/AutoRouteView.css";

// 自动路由：本地模型网关 — 勾选主数据模型，经本地 HTTP 服务暴露给本机任意 agent（跨协议自动转换）
// 开启状态同步到共享 ref，驱动 index.vue「路由」tab 按钮的绿点标识
const { autoRouteEnabled, refreshAutoRouteEnabled } = useAutoRouteStatus();
const AGENT_DISPATCH_OPTIONS = [
  { label: "Claude Code", value: "claude" },
  { label: "OpenCode CLI", value: "opencode" },
  { label: "Pi Agent", value: "pi" },
  { label: "omp", value: "omp" },
  { label: "Reasonix", value: "reasonix" },
  { label: "Codex", value: "codex" },
  { label: "Kimi Code", value: "kimi" },
];

const loading = ref(false);
const config = ref({ enabled: false, port: 17877, key: "", selection: [] });
const status = ref({ running: false, port: 17877, baseUrl: "", logs: [] });
const providers = ref([]);
const selectionKeys = ref([]);
const portDraft = ref(17877); // 端口输入框草稿值，失焦/回车时校验并保存

const modelCount = computed(() => config.value.selection.length);
const baseUrl = computed(() => (status.value.running ? status.value.baseUrl : `http://127.0.0.1:${config.value.port}`));

const routeOptions = computed(() =>
  providers.value.map((p) => ({
    label: p.name,
    value: p.name,
    children: (p.models || []).map((m) => ({
      label: `${m.name || m.id}${m.contextWindow ? `（${formatNumber(m.contextWindow)} ctx）` : ""}`,
      value: `${p.name}::${m.id}`,
    })),
  }))
);

const loadAll = () => {
  try {
    config.value = window.services.readAutoRouteConfig();
    autoRouteEnabled.value = !!config.value.enabled;
    providers.value = window.services.readCommonProviders().providers;
    refreshStatus();
    selectionKeys.value = (config.value.selection || []).map((s) => `${s.provider}::${s.modelId}`);
    portDraft.value = config.value.port;
  } catch (e) {
    MessagePlugin.error("加载自动路由配置失败: " + e.message);
  }
};

const refreshStatus = () => {
  status.value = window.services.getAutoRouteStatus();
};

// 级联选中（含父级=供应商）→ 扁平 selection；父级展开为该供应商当前全部模型
const flattenSelection = (keys) => {
  const entries = [];
  const seen = new Set();
  for (const key of keys || []) {
    const [pName, mId] = String(key).split("::");
    if (!pName) continue;
    if (mId) {
      if (!seen.has(`${pName}::${mId}`)) {
        seen.add(`${pName}::${mId}`);
        entries.push({ provider: pName, modelId: mId });
      }
    } else {
      const provider = providers.value.find((p) => p.name === pName);
      for (const m of (provider && provider.models) || []) {
        if (!seen.has(`${pName}::${m.id}`)) {
          seen.add(`${pName}::${m.id}`);
          entries.push({ provider: pName, modelId: m.id });
        }
      }
    }
  }
  return entries;
};

const saveSelection = () => {
  try {
    config.value = window.services.writeAutoRouteConfig({ selection: flattenSelection(selectionKeys.value) });
  } catch (e) {
    MessagePlugin.error("保存路由模型失败: " + e.message);
  }
};

const onToggleEnabled = async (val) => {
  try {
    status.value = await window.services.setAutoRouteEnabled(!!val);
    autoRouteEnabled.value = !!val;
    MessagePlugin.success(val ? "自动路由已开启" : "自动路由已关闭");
  } catch (e) {
    config.value.enabled = !val;
    // 启动失败时 preload 已回写 enabled=false，从 DB 重读保持绿点一致
    refreshAutoRouteEnabled();
    MessagePlugin.error(e.message);
  }
};

const onPortChange = async (val) => {
  const port = Number(val);
  if (!port || port < 1 || port > 65535 || port === config.value.port) {
    portDraft.value = config.value.port;
    return;
  }
  try {
    config.value = window.services.writeAutoRouteConfig({ port });
    portDraft.value = port;
    if (status.value.running) {
      await window.services.stopAutoRoute();
      status.value = await window.services.startAutoRoute();
      MessagePlugin.success(`端口已切换为 ${port}，网关已重启`);
    } else {
      MessagePlugin.success(`端口已保存为 ${port}`);
    }
  } catch (e) {
    portDraft.value = config.value.port;
    MessagePlugin.error(e.message);
    loadAll();
  }
};

const onRegenKey = () => {
  try {
    config.value = { ...config.value, key: window.services.regenerateAutoRouteKey() };
    MessagePlugin.success("已重新生成 Key，此前下发的 key 将失效");
  } catch (e) {
    MessagePlugin.error(e.message);
  }
};

const copy = (text) => {
  window.utools.copyText(text);
  MessagePlugin.success("已复制");
};

// 下发到 Agent：虚拟供应商「router」写入各 agent（Claude 走 anthropic 协议，其余 openai 兼容；
// 名称用英文，因为它同时作为 Codex model_providers 的 ID，仅支持英文）
const dispatchDialog = ref(false);
const dispatchSubmitting = ref(false);
const dispatchTargets = ref([]);

const openDispatchDialog = () => {
  if (modelCount.value === 0) return MessagePlugin.warning("请先勾选要路由的模型");
  dispatchTargets.value = [];
  dispatchDialog.value = true;
};

const handleDispatch = async () => {
  if (dispatchTargets.value.length === 0) return MessagePlugin.warning("请选择目标 agent");
  dispatchSubmitting.value = true;
  try {
    const results = await window.services.dispatchAutoRoute(dispatchTargets.value.map((app) => ({ app })));
    const byApp = {};
    results.forEach((r) => {
      if (!byApp[r.app]) byApp[r.app] = { ok: 0, fail: 0, err: "" };
      if (r.ok) byApp[r.app].ok++;
      else {
        byApp[r.app].fail++;
        if (!byApp[r.app].err) byApp[r.app].err = r.message;
      }
    });
    Object.entries(byApp).forEach(([app, s]) => {
      const label = (AGENT_DISPATCH_OPTIONS.find((o) => o.value === app) || {}).label || app;
      if (s.fail === 0) MessagePlugin.success(`${label}: ${s.ok} 个模型下发成功`);
      else MessagePlugin.warning(`${label}: ${s.ok} 成功 / ${s.fail} 失败（${s.err}）`);
    });
    dispatchDialog.value = false;
  } catch (e) {
    MessagePlugin.error("下发失败: " + e.message);
  } finally {
    dispatchSubmitting.value = false;
  }
};

// 网关支持的入站接口
const endpoints = [
  { method: "POST", path: "/v1/chat/completions", desc: "OpenAI Chat Completions 格式" },
  { method: "POST", path: "/v1/messages", desc: "Anthropic Messages 格式" },
  { method: "POST", path: "/v1/responses", desc: "OpenAI Responses 格式" },
  { method: "GET", path: "/v1/models", desc: "查询已启用的模型" },
];

// 日志协议显示名：源为适配器标识（anthropic/chat/responses），目标为供应商 api 标识（anthropic-messages 等）
const PROTO_LABELS = {
  anthropic: "Anthropic", chat: "Chat", responses: "Responses", models: "模型列表",
  "anthropic-messages": "Anthropic", "openai-completions": "Chat", "openai-responses": "Responses",
};
const protoLabel = (p) => PROTO_LABELS[p] || p || "-";

const formatTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const formatNumber = (n) => {
  if (!n) return "默认";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
};

let logTimer = null;
onMounted(() => {
  loading.value = true;
  loadAll();
  loading.value = false;
  logTimer = setInterval(refreshStatus, 3000);
});
onUnmounted(() => {
  if (logTimer) clearInterval(logTimer);
});
</script>

<template>
  <div class="autoroute-container">
    <div class="autoroute-header">
      <span class="autoroute-tip">本地模型网关 — 把勾选的主数据模型暴露为本机 OpenAI / Anthropic 兼容端点，任意 agent 均可用三种协议请求，跨协议自动转换</span>
      <div class="autoroute-actions">
        <Tooltip content="把自动路由作为虚拟供应商写入各 agent 的模型配置" placement="top">
          <Button size="small" variant="outline" :disabled="modelCount === 0" @click="openDispatchDialog">
            <template #icon><SendIcon /></template> 下发到 Agent
          </Button>
        </Tooltip>
      </div>
    </div>

    <div class="autoroute-card">
      <div class="autoroute-status-row">
        <Switch v-model="config.enabled" @change="onToggleEnabled" />
        <Tag v-if="status.running" theme="success" size="small">运行中</Tag>
        <Tag v-else theme="default" size="small">已停止</Tag>
        <template v-if="status.running">
          <code class="autoroute-url">{{ status.baseUrl }}</code>
          <Button size="small" variant="text" @click="copy(status.baseUrl)">
            <template #icon><CopyIcon /></template>
          </Button>
        </template>
      </div>
      <div class="autoroute-hint">网关随 uTools 存活，uTools 退出后自动停止；重启后若开关已开启会自动拉起。本机访问，不对外网暴露。</div>

      <div class="autoroute-form-row">
        <span class="autoroute-label">端口</span>
        <Input v-model="portDraft" type="number" size="small" class="autoroute-port" placeholder="1-65535" @change="onPortChange" />
        <span class="autoroute-label">Key</span>
        <code class="autoroute-key">{{ config.key }}</code>
        <Tooltip content="复制 Key" placement="top">
          <Button size="small" variant="text" @click="copy(config.key)">
            <template #icon><CopyIcon /></template>
          </Button>
        </Tooltip>
        <Tooltip content="重新生成（此前下发的 key 失效，需重新下发）" placement="top">
          <Button size="small" variant="text" @click="onRegenKey">
            <template #icon><RefreshIcon /></template> 重新生成
          </Button>
        </Tooltip>
      </div>

      <div class="autoroute-form-row">
        <span class="autoroute-label">路由模型</span>
        <Cascader
          v-model="selectionKeys"
          :options="routeOptions"
          multiple
          filterable
          clearable
          :popup-props="{ overlayClassName: 'autoroute-cascader-popup' }"
          class="autoroute-cascader"
          placeholder="选择供应商与模型（可多选，勾选供应商 = 全选其模型）"
          @change="saveSelection"
        />
      </div>
      <div class="autoroute-hint">
        已启用 {{ modelCount }} 个模型。请求的 model 填模型 ID 即可（多供应商存在同 ID 模型时按勾选顺序取第一个）；仅重名模型会在 GET {{ baseUrl }}/v1/models 中以「供应商/模型ID」形式返回，用完整 ID 指定。
      </div>
    </div>

    <div class="autoroute-card autoroute-endpoints">
      <div class="autoroute-endpoints-title">支持的接口</div>
      <div v-for="ep in endpoints" :key="ep.path" class="autoroute-endpoint-row">
        <Tag size="small" variant="outline" :theme="ep.method === 'POST' ? 'primary' : 'default'" class="autoroute-endpoint-method">{{ ep.method }}</Tag>
        <code class="autoroute-endpoint-path">{{ ep.path }}</code>
        <span class="autoroute-endpoint-desc">{{ ep.desc }}</span>
      </div>
    </div>

    <div class="autoroute-logs">
      <div class="autoroute-logs-title">最近请求（网关运行期间，最多保留 50 条）</div>
      <div v-if="!status.logs.length" class="autoroute-logs-empty">暂无请求</div>
      <div v-for="(log, i) in status.logs" :key="i" class="autoroute-log-row">
        <span class="autoroute-log-time">{{ formatTime(log.time) }}</span>
        <Tag size="small" variant="outline">{{ protoLabel(log.protocol) }}</Tag>
        <template v-if="log.converted && log.target">
          <span class="autoroute-log-arrow">→</span>
          <Tag size="small" variant="outline" theme="warning">{{ protoLabel(log.target) }}</Tag>
        </template>
        <span class="autoroute-log-model">{{ log.model || "-" }}</span>
        <span v-if="log.passthrough" class="autoroute-log-flag">直通</span>
        <Tag size="small" :theme="log.status < 400 ? 'success' : 'danger'">{{ log.status }}</Tag>
        <span v-if="log.error" class="autoroute-log-error" :title="log.error">{{ log.error }}</span>
        <span class="autoroute-log-ms">{{ log.ms }}ms</span>
      </div>
    </div>

    <!-- 下发到 Agent 弹窗 -->
    <Dialog
      v-model:visible="dispatchDialog"
      header="下发自动路由到 Agent"
      width="520px"
      dialog-class-name="autoroute-dispatch-dialog"
      :confirm-btn="{ content: '下发', theme: 'primary', loading: dispatchSubmitting }"
      @confirm="handleDispatch"
    >
      <div class="autoroute-dispatch-form">
        <CheckboxGroup v-model="dispatchTargets" class="autoroute-dispatch-agents">
          <label v-for="opt in AGENT_DISPATCH_OPTIONS" :key="opt.value" class="autoroute-dispatch-agent">
            <Checkbox :value="opt.value">{{ opt.label }}</Checkbox>
          </label>
        </CheckboxGroup>
        <div class="autoroute-hint">
          将写入虚拟供应商「router」：baseUrl = {{ baseUrl }}，模型为全部已启用的 {{ modelCount }} 个模型。Claude Code 目标为 Anthropic 协议，其余目标为 OpenAI 兼容协议。
        </div>
      </div>
    </Dialog>
  </div>
</template>
