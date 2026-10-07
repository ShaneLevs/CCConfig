import { ref, computed, watch } from "vue";
import { useAppContext } from "./useAppContext";

// Agent 启停管理：勾选/拖拽排序 → 按设备隔离持久化（uTools DB）+ 同步 uTools 启动指令。
// 模块级单例，index.vue 设置弹窗（AgentVisibilitySettings）与切换器下拉共用。

// 图标位于 public/ 目录：必须用 BASE_URL 前缀拼接（base: './' 打包后为相对路径，
// 否则 uTools 以 file:// 加载时绝对路径会指向文件系统根目录导致图标丢失）
const ASSET_BASE = import.meta.env.BASE_URL;
// 启停状态按设备区分：主档 ccswitch_visible_agents_<nativeId>，旧共享档作首次迁移种子（只读）
function getNativeId() {
  try { return window.utools.getNativeId() || ""; } catch (e) { return ""; }
}
const VISIBLE_AGENTS_DB_BASE = "ccswitch_visible_agents";
const VISIBLE_AGENTS_DB = (() => {
  const id = getNativeId();
  return id ? `${VISIBLE_AGENTS_DB_BASE}_${id}` : VISIBLE_AGENTS_DB_BASE;
})();
const LEGACY_VISIBLE_AGENTS_DB = VISIBLE_AGENTS_DB_BASE;
export const AGENT_ORDER = ["claude", "opencode", "pi", "omp", "reasonix", "codex", "kimi", "minimax", "qoder", "zcode", "hermes"];
export const AGENT_META = {
  claude: { name: "Claude Code", icon: `${ASSET_BASE}icon-claude.png` },
  opencode: { name: "OpenCode", icon: `${ASSET_BASE}icon-opencode.png` },
  pi: { name: "Pi Agent", icon: `${ASSET_BASE}icon-pi.png` },
  omp: { name: "omp", icon: `${ASSET_BASE}icon-omp.svg` },
  reasonix: { name: "Reasonix", icon: `${ASSET_BASE}icon-reasonix.svg` },
  codex: { name: "Codex", icon: `${ASSET_BASE}icon-codex.png` },
  kimi: { name: "Kimi Code", icon: `${ASSET_BASE}icon-kimi.svg` },
  minimax: { name: "MiniMax Code", icon: `${ASSET_BASE}icon-minimax.svg` },
  qoder: { name: "Qoder", icon: `${ASSET_BASE}icon-qoder.png` },
  zcode: { name: "ZCode", icon: `${ASSET_BASE}icon-zcode.png` },
  hermes: { name: "Hermes", icon: `${ASSET_BASE}icon-hermes.png` },
};

const { activeApp } = useAppContext();

// 可见 agent：有记录用记录（缺键默认启用，兼容未来新增 agent），无记录默认全部启用并写库；检测结果只在首次参与，之后不覆盖用户选择
const visibleAgents = ref(null);
// agent 显示顺序（可拖拽排序），默认 AGENT_ORDER
const agentOrder = ref([...AGENT_ORDER]);
let dragAgentIndex = null;

const saveVisibleAgents = () => {
  let existing = null;
  try { existing = window.utools.db.get(VISIBLE_AGENTS_DB); } catch (e) { /* ignore */ }
  const doc = { _id: VISIBLE_AGENTS_DB, visible: { ...visibleAgents.value }, order: [...agentOrder.value] };
  if (existing) doc._rev = existing._rev;
  try {
    const res = window.utools.db.put(doc);
    if (!res || !res.ok) console.error("保存可见 agent 失败", res);
  } catch (e) { console.error("保存可见 agent 失败", e); }
};

const initVisibleAgents = () => {
  let doc = null;
  try { doc = window.utools.db.get(VISIBLE_AGENTS_DB); } catch (e) { /* ignore */ }
  // 本机尚无记录：从旧共享档取种子，并升级写入本机档（避免下次启动又读旧档）
  let seededFromLegacy = false;
  if (!doc && VISIBLE_AGENTS_DB !== LEGACY_VISIBLE_AGENTS_DB) {
    try {
      doc = window.utools.db.get(LEGACY_VISIBLE_AGENTS_DB);
      if (doc) {
        seededFromLegacy = true;
        doc = { ...doc, _id: VISIBLE_AGENTS_DB };
        delete doc._rev;
      }
    } catch (e) { /* ignore */ }
  }
  const stored = doc?.visible || null;
  const storedOrder = doc?.order || null;
  if (Array.isArray(storedOrder) && storedOrder.length) {
    // 存量记录里没有的新增 agent 追加到末尾（否则升级后设置列表/切换器永远看不到新 agent）
    const known = storedOrder.filter(a => AGENT_ORDER.includes(a));
    AGENT_ORDER.forEach((app) => { if (!known.includes(app)) known.push(app); });
    agentOrder.value = known;
  }
  if (stored) {
    // 有记录：用记录，缺键（未来新增 agent）默认显示
    const result = {};
    AGENT_ORDER.forEach((app) => { result[app] = stored[app] ?? true; });
    visibleAgents.value = result;
    // 刚从旧共享档升级而来：立即写一次本机档，后续不再读旧档
    if (seededFromLegacy) {
      try { saveVisibleAgents(); } catch (e) { console.error("保存可见 agent 失败", e); }
    }
  } else {
    // 无记录：默认全部启用（与「Agent 启停管理」语义一致：默认开启，由用户自行停用），写库
    const result = {};
    AGENT_ORDER.forEach((app) => { result[app] = true; });
    visibleAgents.value = result;
    try { saveVisibleAgents(); } catch (e) { console.error("保存可见 agent 失败", e); }
  }
};
initVisibleAgents();

// 同步 uTools 启动指令：停用 → 移除该 agent 的功能指令 + 匹配指令；启用 → 恢复（幂等）
const syncAgentCommands = () => {
  try {
    if (visibleAgents.value && window.services.syncAgentCommands) {
      const res = window.services.syncAgentCommands({ ...visibleAgents.value });
      if (res && res.failed && res.failed.length) {
        console.error("同步启动指令失败:", res.failed);
      }
    }
  } catch (e) {
    console.error("同步启动指令失败", e);
  }
};

// 自动持久化：勾选或排序变化即保存（不依赖组件 change 事件，deep 监听可见状态与顺序）
// 启停变化同步指令；拖拽排序只触发 agentOrder 的 watch，不重复同步指令
watch(visibleAgents, () => {
  saveVisibleAgents();
  syncAgentCommands();
}, { deep: true });
watch(agentOrder, () => {
  saveVisibleAgents();
}, { deep: true });

// checkbox 点击：只做禁用兜底，勾选状态由 v-model 更新，watch 自动持久化
const onAgentToggle = (app, val) => {
  if (!val && app === activeApp.value) {
    visibleAgents.value[app] = true; // 禁止取消当前活跃，恢复勾选
  }
};

// 程序调用（入口路由进入隐藏 agent 时自动显示），watch 自动持久化
const toggleAgentVisibility = (app, val) => {
  visibleAgents.value[app] = val;
};

// 拖拽排序：调整 agentOrder 并持久化
const onAgentDragStart = (idx) => { dragAgentIndex = idx; };
const onAgentDrop = (idx) => {
  if (dragAgentIndex === null || dragAgentIndex === idx) { dragAgentIndex = null; return; }
  const order = [...agentOrder.value];
  const [moved] = order.splice(dragAgentIndex, 1);
  order.splice(idx, 0, moved);
  agentOrder.value = order; // watch 自动持久化
  dragAgentIndex = null;
};
const onAgentDragEnd = () => { dragAgentIndex = null; };

// 切换器下拉：通用恒显示 + 勾选的 agent，按拖拽排序后的顺序
const appDropdownOptions = computed(() => {
  const opts = [{ content: "通用", value: "common" }];
  agentOrder.value.forEach((app) => {
    if (visibleAgents.value && visibleAgents.value[app]) {
      opts.push({ content: AGENT_META[app].name, value: app });
    }
  });
  return opts;
});

export function useAgentVisibility() {
  return {
    AGENT_ORDER,
    AGENT_META,
    visibleAgents,
    agentOrder,
    appDropdownOptions,
    onAgentToggle,
    toggleAgentVisibility,
    onAgentDragStart,
    onAgentDrop,
    onAgentDragEnd,
  };
}
