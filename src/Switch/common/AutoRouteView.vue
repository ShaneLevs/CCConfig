<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { MessagePlugin, Button, Switch, Tag, Tooltip, Dialog, CheckboxGroup, Checkbox, Input, Cascader, RadioGroup, RadioButton } from "tdesign-vue-next";
import { CopyIcon, SendIcon, AddIcon, DeleteIcon, ChevronDownIcon, DragMoveIcon } from "tdesign-icons-vue-next";
import { useAutoRouteStatus } from "../../composables/useAutoRouteStatus";
import { useAgentVisibility } from "../../composables/useAgentVisibility";
import { usePageRefresh } from "../../composables/usePageRefresh";
import { useUnitFormat } from "../../composables/useUnitFormat";
import "./styles/AutoRouteView.css";

const { t } = useI18n();
const { formatStat } = useUnitFormat();

// 自动网关：本地模型网关 — 勾选主数据模型，经本地 HTTP 服务暴露给本机任意 agent（跨协议自动转换）
// 开启状态同步到共享 ref，驱动 index.vue「网关」tab 按钮的绿点标识
const { autoRouteEnabled, refreshAutoRouteEnabled } = useAutoRouteStatus();
// 下发目标的顺序与显隐都跟随设置里的 Agent 管理（与切换器 / 侧栏一致）
const { visibleAgentOptions } = useAgentVisibility();
const AGENT_DISPATCH_OPTIONS = visibleAgentOptions;

const loading = ref(false);
const config = ref({ enabled: false, port: 17877, key: "", selection: [], mode: "direct", mappings: [], rewriteModel: true });
const status = ref({ running: false, port: 17877, baseUrl: "", logs: [], stats: null, history: null });
const providers = ref([]);
const selectionKeys = ref([]);
const portDraft = ref(17877); // 端口输入框草稿值，失焦/回车时校验并保存
const endpointsExpanded = ref(false); // 「支持的接口」默认收起，点标题展开
const now = ref(Date.now()); // 轮询时间戳，用于「进行中」行的实时耗时

const isMappingMode = computed(() => config.value.mode === "mapping");
const mappingRows = computed(() => config.value.mappings || []);
// 只有映射名 + 目标都填好的行才算可用（预置行未选目标时不计入模型数）
const readyMappings = computed(() => mappingRows.value.filter((m) => m.alias && m.provider && m.modelId).length);
const modelCount = computed(() => (isMappingMode.value ? readyMappings.value : config.value.selection.length));
const baseUrl = computed(() => (status.value.running ? status.value.baseUrl : `http://127.0.0.1:${config.value.port}`));
// 下发弹窗说明里的模型范围随模式变化
const dispatchHint = computed(() => {
  const scope = isMappingMode.value
    ? t('commonApp.autoRoute.scopeMappings', { count: modelCount.value })
    : t('commonApp.autoRoute.scopeModels', { count: modelCount.value });
  return t('commonApp.autoRoute.dispatchHint', { baseUrl: baseUrl.value, scope });
});

// 供应商 → 模型 两级级联选项，直连多选与映射目标单选共用；
// 没有模型的供应商不出现（否则会渲染成一个可选却无模型 ID 的父节点）
const routeOptions = computed(() =>
  providers.value
    .filter((p) => (p.models || []).length > 0)
    .map((p) => ({
      label: p.name,
      value: p.name,
      children: (p.models || []).map((m) => ({
        label: `${m.name || m.id}${m.contextWindow ? `（${formatNumber(m.contextWindow)} ctx）` : ""}`,
        value: `${p.name}::${m.id}`,
      })),
    }))
);

// 模型级联的选项来自通用配置的供应商主数据，可能在其他页签里刚改过
const loadProviders = () => {
  providers.value = window.services.readCommonProviders().providers;
};

const loadAll = () => {
  try {
    config.value = window.services.readAutoRouteConfig();
    autoRouteEnabled.value = !!config.value.enabled;
    loadProviders();
    refreshStatus();
    // 首次进入默认看今日；用户手动切过口径后，后续刷新保留其选择
    if (!statsScopeTouched.value) {
      statsScopeTouched.value = true;
      statsScope.value = "today";
    }
    selectionKeys.value = (config.value.selection || []).map((s) => `${s.provider}::${s.modelId}`);
    portDraft.value = config.value.port;
  } catch (e) {
    MessagePlugin.error(t('commonApp.autoRoute.loadFailed', { message: e.message }));
  }
};

const refreshStatus = () => {
  status.value = window.services.getAutoRouteStatus();
  now.value = Date.now();
};

// 桌面版托盘弹窗也能改网关配置（接入模式 / 模型 / 映射）：主窗口重新获得焦点时
// 重读一次配置，避免托盘改完后这里的表单还是旧值。只读库，不重启网关。
const reloadConfig = () => {
  try {
    config.value = window.services.readAutoRouteConfig();
    autoRouteEnabled.value = !!config.value.enabled;
    loadProviders();
    selectionKeys.value = (config.value.selection || []).map((s) => `${s.provider}::${s.modelId}`);
    portDraft.value = config.value.port;
  } catch (e) {
    /* 读失败保持当前表单，下一次进入页面会再读 */
  }
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
    MessagePlugin.error(t('commonApp.autoRoute.saveModelsFailed', { message: e.message }));
  }
};

const onModeChange = (val) => {
  try {
    config.value = window.services.writeAutoRouteConfig({ mode: val });
    MessagePlugin.success(val === "mapping" ? t('commonApp.autoRoute.modeMappingOn') : t('commonApp.autoRoute.modeDirectOn'));
  } catch (e) {
    config.value.mode = val === "mapping" ? "direct" : "mapping";
    MessagePlugin.error(e.message);
  }
};

// ==================== 模型映射（mapping 模式） ====================

const MAX_MAPPINGS = 10;

// 映射名默认由 preload 预置好 flash / plus / pro 三行（见 autoroute.js readAutoRouteConfig），
// 这里不再做成下拉选预设：映射名是可编辑的普通输入框，目标模型默认为空，用户自己选或删行
const PRESET_ALIASES = ["flash", "plus", "pro"];

// 保存后保留本地行对象（不换成服务返回的新克隆）：行的 key 由对象身份决定，
// 每次写库都换一批新对象会让整张表重渲染，拖动/输入过程中输入框会被重建掉（丢焦点、丢半截输入）
const saveMappings = (mappings) => {
  try {
    const saved = window.services.writeAutoRouteConfig({ mappings });
    config.value = { ...saved, mappings };
  } catch (e) {
    MessagePlugin.error(t('commonApp.autoRoute.saveMappingsFailed', { message: e.message }));
    loadAll();
  }
};

const removeMapping = (index) => {
  saveMappings(mappingRows.value.filter((_, i) => i !== index));
};

// 新增映射行：默认取一个尚未使用的预设名（flash / plus / pro），全被占用则留空自填
const addMapping = () => {
  const mappings = mappingRows.value;
  if (mappings.length >= MAX_MAPPINGS) {
    MessagePlugin.warning(t('commonApp.autoRoute.maxMappings', { max: MAX_MAPPINGS }));
    return;
  }
  const used = new Set(mappings.map((m) => m.alias));
  const preset = PRESET_ALIASES.find((alias) => !used.has(alias));
  saveMappings([...mappings, { alias: preset || "", provider: "", modelId: "" }]);
};

const onAliasChange = (index, val) => {
  const mappings = mappingRows.value.map((m, i) => (i === index ? { ...m, alias: String(val || "").trim() } : m));
  saveMappings(mappings);
};

const onMappingTargetChange = (index, val) => {
  const [provider = "", modelId = ""] = String(val || "").split("::");
  const mappings = mappingRows.value.map((m, i) => (i === index ? { ...m, provider, modelId } : m));
  saveMappings(mappings);
};

// ==================== 映射行手动排序 ====================
// mappings 数组顺序就是下发顺序：dispatchAutoRoute 按 resolveAutoRouteModels 的返回顺序
// 逐个模型写入 agent（数组顺序的 agent 保留原顺序，字典类的按写入先后排列），所以这里
// 拖拽重排后直接落库，agent 侧的模型清单顺序与页面一致。
// 用 Pointer Events 而不是 HTML5 DnD：桌面版（Tauri 窗口接管原生拖放）收不到 drag 事件，
// 与设置里的 Agent 排序同一套做法。拖动期间渲染草稿顺序，松手才写库。
const mappingDraft = ref(null);
const draggingIndex = ref(-1);
const dragRows = computed(() => mappingDraft.value || mappingRows.value);
let mappingPress = null;
// 拖拽重排时行不能按数组下标做 key，否则复用的输入框会串值（拖动中每一行的下标都在变）。
// 行 id 挂在映射对象上（ROW_ID 键）：`{...m}` 克隆自动带上，写库前的 sanitizeConfig 只保留
// alias/provider/modelId，所以它不会落库；从库读回来的行没有这个键 → 首次渲染时分配新 id。
const ROW_ID = "__rowId";
let rowSeq = 0;
const rowKey = (row) => {
  if (!row[ROW_ID]) row[ROW_ID] = ++rowSeq;
  return row[ROW_ID];
};

const indexAtPoint = (x, y) => {
  const el = document.elementFromPoint(x, y);
  const row = el && el.closest ? el.closest(".autoroute-mapping-row") : null;
  if (!row || row.dataset.index === undefined) return -1;
  return Number(row.dataset.index);
};

const detachMappingDrag = () => {
  window.removeEventListener("pointermove", onMappingPointerMove);
  window.removeEventListener("pointerup", onMappingPointerUp);
  window.removeEventListener("pointercancel", onMappingPointerUp);
  const press = mappingPress;
  if (press && press.handle.hasPointerCapture && press.handle.hasPointerCapture(press.pointerId)) {
    try { press.handle.releasePointerCapture(press.pointerId); } catch (e) { /* ignore */ }
  }
  const draft = mappingDraft.value;
  const moved = draggingIndex.value >= 0;
  mappingPress = null;
  mappingDraft.value = null;
  draggingIndex.value = -1;
  document.body.classList.remove("autoroute-sorting");
  return moved ? draft : null;
};

const onMappingPointerUp = () => {
  // 只有真正拖动过才落库：单击手柄不应触发一次写库
  const draft = detachMappingDrag();
  if (draft) saveMappings(draft);
};

const onMappingPointerMove = (event) => {
  if (!mappingPress || event.pointerId !== mappingPress.pointerId) return;
  if (draggingIndex.value < 0) {
    // 超过 4px 才算拖动，避免误触打乱顺序
    if (Math.hypot(event.clientX - mappingPress.x, event.clientY - mappingPress.y) < 4) return;
    mappingDraft.value = [...mappingRows.value];
    draggingIndex.value = mappingPress.index;
    document.body.classList.add("autoroute-sorting");
  }
  event.preventDefault();
  const target = indexAtPoint(event.clientX, event.clientY);
  if (target < 0 || target === draggingIndex.value) return;
  const order = [...mappingDraft.value];
  const [moved] = order.splice(draggingIndex.value, 1);
  order.splice(target, 0, moved);
  mappingDraft.value = order;
  draggingIndex.value = target;
};

const startMappingDrag = (event, index) => {
  if (event.button !== 0) return;
  event.preventDefault();
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
  mappingPress = { index, x: event.clientX, y: event.clientY, pointerId: event.pointerId, handle: event.currentTarget };
  window.addEventListener("pointermove", onMappingPointerMove);
  window.addEventListener("pointerup", onMappingPointerUp);
  window.addEventListener("pointercancel", onMappingPointerUp);
};

// 键盘等价操作：手柄可聚焦，↑/↓ 上下移动一行（纯鼠标排序会让键盘用户没法调整）
const onMappingIndexKeydown = (event, index) => {
  const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
  if (!delta) return;
  const target = index + delta;
  if (target < 0 || target >= mappingRows.value.length) return;
  event.preventDefault();
  const mappings = [...mappingRows.value];
  const [moved] = mappings.splice(index, 1);
  mappings.splice(target, 0, moved);
  saveMappings(mappings);
};

// 响应 model 改写开关（映射模式）：agent 的用量统计读的是它自己会话记录里的模型名，
// 这个开关决定记录的是映射名还是上游真实模型名
const onRewriteModelChange = (val) => {
  try {
    config.value = window.services.writeAutoRouteConfig({ rewriteModel: !!val });
  } catch (e) {
    config.value.rewriteModel = !val;
    MessagePlugin.error(e.message);
  }
};

const onToggleEnabled = async (val) => {
  try {
    status.value = await window.services.setAutoRouteEnabled(!!val);
    autoRouteEnabled.value = !!val;
    MessagePlugin.success(val ? t('commonApp.autoRoute.enabledOn') : t('commonApp.autoRoute.enabledOff'));
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
      MessagePlugin.success(t('commonApp.autoRoute.portRestarted', { port }));
    } else {
      MessagePlugin.success(t('commonApp.autoRoute.portSaved', { port }));
    }
  } catch (e) {
    portDraft.value = config.value.port;
    MessagePlugin.error(e.message);
    loadAll();
  }
};

const copy = (text) => {
  window.utools.copyText(text);
  MessagePlugin.success(t('common.copied'));
};

// 下发到 Agent：虚拟供应商「router」写入各 agent（Claude 走 anthropic 协议，其余 openai 兼容；
// 名称用英文，因为它同时作为 Codex model_providers 的 ID，仅支持英文）
const dispatchDialog = ref(false);
const dispatchSubmitting = ref(false);
const dispatchTargets = ref([]);

const openDispatchDialog = () => {
  if (modelCount.value === 0)
    return MessagePlugin.warning(isMappingMode.value ? t('commonApp.autoRoute.mappingRequired') : t('commonApp.autoRoute.modelsRequired'));
  dispatchTargets.value = [];
  dispatchDialog.value = true;
};

const handleDispatch = async () => {
  if (dispatchTargets.value.length === 0) return MessagePlugin.warning(t('commonApp.autoRoute.targetRequired'));
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
      const label = (AGENT_DISPATCH_OPTIONS.value.find((o) => o.value === app) || {}).label || app;
      if (s.fail === 0) MessagePlugin.success(t('commonApp.autoRoute.dispatchSuccess', { label, count: s.ok }));
      else MessagePlugin.warning(t('commonApp.autoRoute.dispatchPartial', { label, ok: s.ok, fail: s.fail, error: s.err }));
    });
    dispatchDialog.value = false;
  } catch (e) {
    MessagePlugin.error(t('commonApp.autoRoute.dispatchFailed', { message: e.message }));
  } finally {
    dispatchSubmitting.value = false;
  }
};

// 网关支持的入站接口
const endpoints = [
  { method: "POST", path: "/v1/chat/completions", desc: "OpenAI Chat Completions" },
  { method: "POST", path: "/v1/messages", desc: "Anthropic Messages" },
  { method: "POST", path: "/v1/responses", desc: "OpenAI Responses" },
  { method: "GET", path: "/v1/models", descKey: "commonApp.autoRoute.modelsListDesc" },
  { method: "GET", path: "/v1/codex/models", descKey: "commonApp.autoRoute.codexCatalogDesc" },
];
const endpointDesc = (ep) => (ep.descKey ? t(ep.descKey) : ep.desc);

// 日志协议显示名：源为适配器标识（anthropic/chat/responses），目标为供应商 api 标识（anthropic-messages 等）
const PROTO_LABELS = {
  anthropic: "Anthropic", chat: "Chat", responses: "Responses",
  "anthropic-messages": "Anthropic", "openai-completions": "Chat", "openai-responses": "Responses",
};
const protoLabel = (p) =>
  p === "models" ? t("commonApp.autoRoute.modelsListDesc") : (PROTO_LABELS[p] || p || "-");

const formatTime = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// 进行中的请求行（preload 在解析出目标模型时就插行，finish 时补 status/ms）
const isPending = (log) => log.status === null || log.status === undefined;
const logMs = (log) => (isPending(log) ? now.value - log.time : log.ms) + "ms";

// 日志行每条 usage 展示：↑输入 ↓输出 + 缓存读标记（c 前缀），悬停 title 看精确值。
// anthropic 的 input 不含缓存，展示用总 prompt 需加回 cache_read/write（与统计口径一致）
const fmtTokensK = (n) => formatStat(n, { decimals: 1, trimZero: true });
const logUsage = (log) => {
  const u = log.usage;
  if (!u) return null;
  const cached = u.cacheReadTokens || 0;
  const prompt = log.target === "anthropic-messages"
    ? (u.inputTokens || 0) + cached + (u.cacheWriteTokens || 0)
    : u.inputTokens || 0;
  const out = u.outputTokens || 0;
  if (!prompt && !out) return null;
  let text = `↑${fmtTokensK(prompt)} ↓${fmtTokensK(out)}`;
  const titleParts = [`prompt ${prompt}`, `completion ${out}`];
  if (cached) {
    text += ` c${fmtTokensK(cached)}`;
    titleParts.push(`${t('commonApp.autoRoute.cacheRead')} ${cached}`);
  }
  if (u.cacheWriteTokens) titleParts.push(`${t('commonApp.autoRoute.cacheWrite')} ${u.cacheWriteTokens}`);
  return { text, title: titleParts.join(" / ") };
};

const formatNumber = (n) => {
  if (!n) return t('common.default');
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
};

// 网关统计口径：本次来自 preload 内存（getAutoRouteStatus.stats），
// 今日 / 本月 / 累积来自按天落库的 history（随轮询刷新，间隔 1s）
const statsScope = ref("today");
const statsScopeTouched = ref(false);
const onStatsScopeChange = () => {
  statsScopeTouched.value = true;
};
const statsScopeOptions = computed(() => [
  { label: t("commonApp.autoRoute.statScopeSession"), value: "session" },
  { label: t("commonApp.autoRoute.statScopeToday"), value: "today" },
  { label: t("commonApp.autoRoute.statScopeMonth"), value: "month" },
  { label: t("commonApp.autoRoute.statScopeTotal"), value: "total" },
]);
const historyInfo = computed(() => status.value.history || {});
const statsSource = computed(() => {
  if (statsScope.value === "session") return status.value.stats || {};
  if (statsScope.value === "today") return historyInfo.value.today || {};
  if (statsScope.value === "month") return historyInfo.value.month || {};
  return historyInfo.value.total || {};
});
// 本次没有调用但历史有数据时也要展示（否则切不回累积）
const hasStats = computed(
  () =>
    ((status.value.stats && status.value.stats.requests) || 0) > 0 ||
    ((historyInfo.value.total && historyInfo.value.total.requests) || 0) > 0
);
const statsSince = computed(() => historyInfo.value.since || "");
const statsSummary = computed(() => {
  const s = statsSource.value;
  const requests = s.requests || 0;
  const prompt = s.promptTokens || 0;
  const output = s.outputTokens || 0;
  const cached = s.cachedTokens || 0;
  const pct = (r) => {
    const v = Math.round(r * 1000) / 10;
    return (v % 1 ? v.toFixed(1) : String(v)) + "%";
  };
  const tokens = (n) => formatStat(n, { decimals: 1 });
  return {
    requests,
    successRate: requests ? pct((s.successes || 0) / requests) : "—",
    tokens: prompt || output ? tokens(prompt + output) : "—",
    cacheHit: prompt ? pct(cached / prompt) : "—",
  };
});

let logTimer = null;
// 页面用 v-show 保活，只在首次挂载读一次会看不到「配置」里新加的模型：
// 每次切回本页签重读配置与供应商模型清单（只读库，不重启网关）
usePageRefresh("common", "autoroute", loadAll);
onMounted(() => {
  loading.value = true;
  loadAll();
  loading.value = false;
  window.addEventListener("focus", reloadConfig);
  // 1s 轮询：getAutoRouteStatus 是 preload 内存读取，开销可忽略；配合「进行中」行做到准实时
  logTimer = setInterval(refreshStatus, 1000);
});
onUnmounted(() => {
  window.removeEventListener("focus", reloadConfig);
  if (logTimer) clearInterval(logTimer);
  detachMappingDrag();
});
</script>

<template>
  <div class="autoroute-container">
    <div class="autoroute-header">
      <span class="autoroute-tip">{{ t('commonApp.autoRoute.tip') }}</span>
      <div class="autoroute-actions">
        <Tooltip :content="t('commonApp.autoRoute.dispatchTooltip')" placement="top">
          <Button size="small" variant="outline" :disabled="modelCount === 0" @click="openDispatchDialog">
            <template #icon><SendIcon /></template> {{ t('commonApp.config.dispatchToAgent') }}
          </Button>
        </Tooltip>
      </div>
    </div>

    <div class="autoroute-card">
      <div class="autoroute-status-row">
        <Switch v-model="config.enabled" @change="onToggleEnabled" />
        <Tag v-if="status.running" theme="success" size="small">{{ t('commonApp.autoRoute.running') }}</Tag>
        <Tag v-else theme="default" size="small">{{ t('commonApp.autoRoute.stopped') }}</Tag>
        <template v-if="status.running">
          <code class="autoroute-url">{{ status.baseUrl }}</code>
          <Button size="small" variant="text" @click="copy(status.baseUrl)">
            <template #icon><CopyIcon /></template>
          </Button>
        </template>
      </div>
      <div class="autoroute-hint">{{ t('commonApp.autoRoute.runningHint') }}</div>

      <div class="autoroute-form-row">
        <span class="autoroute-label">{{ t('commonApp.autoRoute.port') }}</span>
        <Input v-model="portDraft" type="number" size="small" class="autoroute-port" placeholder="1-65535" @change="onPortChange" />
      </div>

      <div class="autoroute-form-row">
        <span class="autoroute-label">{{ t('commonApp.autoRoute.mode') }}</span>
        <RadioGroup v-model="config.mode" variant="default-filled" size="small" @change="onModeChange">
          <RadioButton value="direct">{{ t('commonApp.autoRoute.modeDirect') }}</RadioButton>
          <RadioButton value="mapping">{{ t('commonApp.autoRoute.modeMapping') }}</RadioButton>
        </RadioGroup>
        <span v-if="isMappingMode" class="autoroute-hint autoroute-mode-hint">
          {{ t('commonApp.autoRoute.mappingHint') }}
        </span>
      </div>

      <template v-if="!isMappingMode">
        <div class="autoroute-form-row">
          <span class="autoroute-label">{{ t('commonApp.autoRoute.gatewayModels') }}</span>
          <Cascader
            v-model="selectionKeys"
            :options="routeOptions"
            multiple
            filterable
            clearable
            :popup-props="{ overlayClassName: 'autoroute-cascader-popup' }"
            class="autoroute-cascader"
            :placeholder="t('commonApp.autoRoute.selectModelsPlaceholder')"
            @change="saveSelection"
          />
        </div>
        <div class="autoroute-hint">
          {{ t('commonApp.autoRoute.enabledModelsHint', { count: modelCount }) }}
        </div>
      </template>

      <template v-else>
        <div
          v-for="(m, i) in dragRows"
          :key="rowKey(m)"
          class="autoroute-mapping-row"
          :class="{ 'is-dragging': draggingIndex === i }"
          :data-index="i"
        >
          <span
            class="autoroute-mapping-index"
            role="button"
            tabindex="0"
            :title="t('commonApp.autoRoute.dragMappingHint')"
            :aria-label="t('commonApp.autoRoute.dragMappingHint')"
            @pointerdown="startMappingDrag($event, i)"
            @keydown="onMappingIndexKeydown($event, i)"
          >
            <span class="autoroute-mapping-index-num">{{ i + 1 }}</span>
            <DragMoveIcon class="autoroute-mapping-index-handle" />
          </span>
          <Input
            :value="m.alias"
            size="small"
            class="autoroute-mapping-alias"
            :placeholder="t('commonApp.autoRoute.mappingAliasPlaceholder')"
            @change="(val) => onAliasChange(i, val)"
          />
          <span class="autoroute-mapping-arrow">→</span>
          <Cascader
            :value="m.provider && m.modelId ? `${m.provider}::${m.modelId}` : undefined"
            :options="routeOptions"
            size="small"
            filterable
            clearable
            :popup-props="{ overlayClassName: 'autoroute-cascader-popup' }"
            class="autoroute-mapping-target"
            :placeholder="t('commonApp.autoRoute.selectTargetPlaceholder')"
            @change="(val) => onMappingTargetChange(i, val)"
          />
          <Tooltip :content="t('commonApp.autoRoute.removeMapping')" placement="top">
            <Button size="small" variant="text" theme="danger" @click="removeMapping(i)">
              <template #icon><DeleteIcon /></template>
            </Button>
          </Tooltip>
        </div>
        <div class="autoroute-form-row">
          <Button
            size="small"
            variant="outline"
            :disabled="mappingRows.length >= MAX_MAPPINGS"
            @click="addMapping"
          >
            <template #icon><AddIcon /></template> {{ t('commonApp.autoRoute.addMapping') }}
          </Button>
          <span class="autoroute-hint">
            {{ t('commonApp.autoRoute.mappingStatus', { ready: readyMappings, total: mappingRows.length, max: MAX_MAPPINGS }) }}
          </span>
        </div>
        <div class="autoroute-form-row">
          <span class="autoroute-label">{{ t('commonApp.autoRoute.rewriteModel') }}</span>
          <Switch v-model="config.rewriteModel" @change="onRewriteModelChange" />
          <span class="autoroute-hint autoroute-mode-hint">
            {{ t('commonApp.autoRoute.rewriteModelHint') }}
          </span>
        </div>
      </template>
    </div>

    <div class="autoroute-card autoroute-endpoints">
      <div class="autoroute-endpoints-header" @click="endpointsExpanded = !endpointsExpanded">
        <ChevronDownIcon class="autoroute-endpoints-chevron" :class="{ 'is-expanded': endpointsExpanded }" />
        <span class="autoroute-endpoints-title">{{ t('commonApp.autoRoute.supportedEndpoints') }}</span>
        <span class="autoroute-endpoints-count">{{ endpoints.length }}</span>
      </div>
      <template v-if="endpointsExpanded">
        <div v-for="ep in endpoints" :key="ep.path" class="autoroute-endpoint-row">
          <Tag size="small" variant="outline" :theme="ep.method === 'POST' ? 'primary' : 'default'" class="autoroute-endpoint-method">{{ ep.method }}</Tag>
          <code class="autoroute-endpoint-path">{{ ep.path }}</code>
          <span class="autoroute-endpoint-desc">{{ endpointDesc(ep) }}</span>
        </div>
      </template>
    </div>

    <div v-if="hasStats" class="autoroute-stats-block">
      <div class="autoroute-stats-head">
        <RadioGroup v-model="statsScope" variant="default-filled" size="small" @change="onStatsScopeChange">
          <RadioButton v-for="opt in statsScopeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</RadioButton>
        </RadioGroup>
        <span v-if="statsScope === 'total' && statsSince" class="autoroute-stats-since">
          {{ t('commonApp.autoRoute.statSince', { date: statsSince }) }}
        </span>
      </div>
      <div class="autoroute-stats">
        <div class="autoroute-stat">
          <span class="autoroute-stat-label">{{ t('commonApp.autoRoute.statRequests') }}</span>
          <span class="autoroute-stat-value">{{ statsSummary.requests }}</span>
        </div>
        <div class="autoroute-stat">
          <span class="autoroute-stat-label">{{ t('commonApp.autoRoute.statSuccessRate') }}</span>
          <span class="autoroute-stat-value">{{ statsSummary.successRate }}</span>
        </div>
        <div class="autoroute-stat">
          <span class="autoroute-stat-label">{{ t('commonApp.autoRoute.statTokens') }}</span>
          <span class="autoroute-stat-value">{{ statsSummary.tokens }}</span>
        </div>
        <div class="autoroute-stat">
          <span class="autoroute-stat-label">{{ t('commonApp.autoRoute.statCacheHit') }}</span>
          <span class="autoroute-stat-value">{{ statsSummary.cacheHit }}</span>
        </div>
      </div>
    </div>

    <div class="autoroute-logs">
      <div class="autoroute-logs-title">{{ t('commonApp.autoRoute.recentRequests') }}</div>
      <div v-if="!status.logs.length" class="autoroute-logs-empty">{{ t('commonApp.autoRoute.noRequests') }}</div>
      <div v-for="log in status.logs" :key="log.seq" class="autoroute-log-row">
        <span class="autoroute-log-time">{{ formatTime(log.time) }}</span>
        <Tag size="small" variant="outline">{{ protoLabel(log.protocol) }}</Tag>
        <template v-if="log.converted && log.target">
          <span class="autoroute-log-arrow">→</span>
          <Tag size="small" variant="outline" theme="warning">{{ protoLabel(log.target) }}</Tag>
        </template>
        <span v-if="log.alias" class="autoroute-log-alias" :title="t('commonApp.autoRoute.mappingTitle', { alias: log.alias, model: log.model || '-' })">{{ log.alias }}</span>
        <span v-if="log.alias" class="autoroute-log-arrow">→</span>
        <span class="autoroute-log-model" :title="log.model || '-'" :class="{ 'is-mapped-target': log.alias }">{{ log.model || "-" }}</span>
        <span v-if="log.passthrough" class="autoroute-log-flag">{{ t('commonApp.autoRoute.passthrough') }}</span>
        <Tag v-if="isPending(log)" size="small" theme="primary" variant="light">{{ t('commonApp.autoRoute.pending') }}</Tag>
        <Tag v-else size="small" :theme="log.status < 400 ? 'success' : 'danger'">{{ log.status }}</Tag>
        <span v-if="logUsage(log)" class="autoroute-log-usage" :title="logUsage(log).title">{{ logUsage(log).text }}</span>
        <span v-if="log.error" class="autoroute-log-error" :title="log.error">{{ log.error }}</span>
        <span class="autoroute-log-ms">{{ logMs(log) }}</span>
      </div>
    </div>

    <!-- 下发到 Agent 弹窗 -->
    <Dialog
      v-model:visible="dispatchDialog"
      :header="t('commonApp.autoRoute.dispatchTitle')"
      width="520px"
      dialog-class-name="autoroute-dispatch-dialog"
      :confirm-btn="{ content: t('commonApp.autoRoute.dispatch'), theme: 'primary', loading: dispatchSubmitting }"
      @confirm="handleDispatch"
    >
      <div class="autoroute-dispatch-form">
        <CheckboxGroup v-model="dispatchTargets" class="autoroute-dispatch-agents">
          <label v-for="opt in AGENT_DISPATCH_OPTIONS" :key="opt.value" class="autoroute-dispatch-agent">
            <Checkbox :value="opt.value">{{ opt.label }}</Checkbox>
          </label>
        </CheckboxGroup>
        <div class="autoroute-hint">
          {{ dispatchHint }}
        </div>
      </div>
    </Dialog>
  </div>
</template>
