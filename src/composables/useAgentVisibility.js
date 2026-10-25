import { h, ref, computed, watch } from "vue";
import { i18n } from "../i18n";
import { AGENT_ORDER, LEGACY_AGENT_ORDER, AGENT_META, COMMON_APP_META } from "./agentMeta";

// Agent 显示管理：勾选/拖拽排序 → 按设备隔离持久化（uTools DB）+ 同步 uTools 启动指令。
// 模块级单例，index.vue 设置弹窗（AgentVisibilitySettings）与切换器下拉共用。
// Agent 顺序与展示名（含图标）见 ./agentMeta.js（纯数据，统计页的 Agent 分组标题也用它）。

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
// 兼容既有调用方：顺序/元数据从本模块取（实际定义在 ./agentMeta.js）
export { AGENT_ORDER, AGENT_META };

// 可见 agent：有记录用记录（缺键默认显示，兼容未来新增 agent），无记录默认全部显示并写库；检测结果只在首次参与，之后不覆盖用户选择
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
  // 存量记录仍是旧默认顺序（说明用户从未拖拽过排序）：升级为新默认顺序
  let orderUpgraded = false;
  if (Array.isArray(storedOrder) && storedOrder.length) {
    // 存量记录里没有的新增 agent 追加到末尾（否则升级后设置列表/切换器永远看不到新 agent）
    const known = storedOrder.filter(a => AGENT_ORDER.includes(a));
    AGENT_ORDER.forEach((app) => { if (!known.includes(app)) known.push(app); });
    if (known.join() === LEGACY_AGENT_ORDER.join()) {
      agentOrder.value = [...AGENT_ORDER];
      orderUpgraded = true;
    } else {
      agentOrder.value = known; // 用户自定义顺序：原样保留
    }
  }
  if (stored) {
    // 有记录：用记录，缺键（未来新增 agent）默认显示
    const result = {};
    AGENT_ORDER.forEach((app) => { result[app] = stored[app] ?? true; });
    visibleAgents.value = result;
    // 刚从旧共享档升级而来 / 刚升级默认顺序：立即写一次本机档
    if (seededFromLegacy || orderUpgraded) {
      try { saveVisibleAgents(); } catch (e) { console.error("保存可见 agent 失败", e); }
    }
  } else {
    // 无记录：默认全部启用（与「Agent 显示」语义一致：默认显示，由用户自行隐藏），写库
    const result = {};
    AGENT_ORDER.forEach((app) => { result[app] = true; });
    visibleAgents.value = result;
    try { saveVisibleAgents(); } catch (e) { console.error("保存可见 agent 失败", e); }
  }
};
initVisibleAgents();

// 同步 uTools 启动指令：隐藏 → 移除该 agent 的功能指令 + 匹配指令；显示 → 恢复（幂等）
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

// 程序调用（入口路由进入隐藏 agent 时自动显示），watch 自动持久化
// 勾选状态由 Checkbox 的 v-model 直接写 visibleAgents，watch 自动持久化；
// 隐藏当前正在使用的 agent 由 index.vue 的 watch 兜底切回「通用」。
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

// 切换器下拉项内容：图标 + 名称（TDesign Dropdown 的 content 支持 (h) => VNode）
// name 省略时退回 meta.name（agent 用固定展示名，只有「通用」需要外部传翻译后的名字）
const dropdownOptionContent = (meta, name = meta.name) => (createElement) =>
  createElement("span", { class: "app-dropdown-option" }, [
    meta.icon
      ? createElement("img", { class: "app-dropdown-option__icon", src: meta.icon, alt: "" })
      : null,
    createElement("span", null, name),
  ]);

// 切换器下拉：通用恒显示 + 勾选的 agent，按拖拽排序后的顺序
const appDropdownOptions = computed(() => {
  // 读取 locale ref，确保切换语言时 computed 重新求值
  i18n.global.locale.value;
  const commonName = i18n.global.t(COMMON_APP_META.nameKey);
  // content 是渲染函数（TDesign Dropdown 用）；label 是纯文本名称（侧栏 AgentSideRail 用，勿取 content）
  const opts = [
    { content: dropdownOptionContent(COMMON_APP_META, commonName), label: commonName, value: "common" },
  ];
  agentOrder.value.forEach((app) => {
    if (visibleAgents.value && visibleAgents.value[app]) {
      const meta = AGENT_META[app] || { name: app, icon: "" };
      opts.push({ content: dropdownOptionContent(meta), label: meta.name, value: app });
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
    toggleAgentVisibility,
    onAgentDragStart,
    onAgentDrop,
    onAgentDragEnd,
  };
}
