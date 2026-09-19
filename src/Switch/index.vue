<script setup>
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { Button, Dropdown, Dialog, Switch, Checkbox, Divider } from "tdesign-vue-next";
import {
  ChartIcon,
  DashboardIcon,
  ServerIcon,
  BookIcon,
  ChevronDownIcon,
  AppIcon,
  SettingIcon,
  MapRoutePlanningIcon,
} from "tdesign-icons-vue-next";
import { GripVertical } from "@lucide/vue";
import ConfigView from "./claude/ConfigView.vue";
import UsageView from "./claude/UsageView.vue";
import McpView from "./claude/McpView.vue";
import SkillView from "./claude/SkillView.vue";
import PluginView from "./claude/PluginView.vue";
import OpenCodeConfigView from "./opencode/ConfigView.vue";
import PiConfigView from "./pi/ConfigView.vue";
import PiMcpView from "./pi/McpView.vue";
import PiSkillView from "./pi/SkillView.vue";
import PiPluginView from "./pi/PluginView.vue";
import PiUsageView from "./pi/UsageView.vue";
import OpenCodeMcpView from "./opencode/McpView.vue";
import OpenCodePluginView from "./opencode/PluginView.vue";
import OpenCodeSkillView from "./opencode/SkillView.vue";
import OpenCodeUsageView from "./opencode/UsageView.vue";
import OmpConfigView from "./omp/ConfigView.vue";
import ReasonixConfigView from "./reasonix/ConfigView.vue";
import CodexConfigView from "./codex/ConfigView.vue";
import KimiConfigView from "./kimi/ConfigView.vue";
import CommonConfigView from "./common/ConfigView.vue";
import CommonMcpView from "./common/McpView.vue";
import CommonSkillView from "./common/SkillView.vue";
import CommonAutoRouteView from "./common/AutoRouteView.vue";
import CommonUsageView from "./common/UsageView.vue";
import { useAppContext } from "../composables/useAppContext";
import { useAutoRouteStatus } from "../composables/useAutoRouteStatus";
import { useDarkBackground } from "../composables/useDarkBackground";

const props = defineProps({
  route: String,
  payload: String,
});

const { activeApp, setActiveApp, isClaude, isOpenCode, isPi, isOmp, isReasonix, isCodex, isKimi, isCommon } = useAppContext();

// 自动路由开启状态：「路由」tab 按钮右上角绿点标识（AutoRouteView 开关切换时同步）
const { autoRouteEnabled, refreshAutoRouteEnabled } = useAutoRouteStatus();

const { darkBackgroundEnabled, setDarkBackground, darkEffect, setDarkEffect } =
  useDarkBackground();
const showSettings = ref(false);

const activeTab = ref("config");
const skillViewRef = ref(null);
const ocSkillViewRef = ref(null);
const commonSkillViewRef = ref(null);
const piPluginViewRef = ref(null);
// 记录哪些应用已被激活过，激活后保留组件不销毁，避免 v-show 导致热力图宽度计算为 0
const activatedApps = ref(new Set(["claude"]));

const ensureAppActivated = (app) => {
  if (!activatedApps.value.has(app)) {
    activatedApps.value.add(app);
  }
};

// 初始化当前应用为已 activated
ensureAppActivated(activeApp.value);

const isAppReady = (app) => activatedApps.value.has(app);

// 记录每个应用下已访问过的标签页，首次访问后保持组件不销毁
const visitedTabs = ref(new Set(["claude:config"]));

const markTabVisited = (app, tab) => {
  visitedTabs.value.add(`${app}:${tab}`);
};

const isTabVisited = (app, tab) => visitedTabs.value.has(`${app}:${tab}`);

// 初始化当前标签为已访问
markTabVisited(activeApp.value, activeTab.value);

// 标签页/应用切换时自动标记已访问，保持组件不销毁
watch([activeTab, activeApp], () => {
  markTabVisited(activeApp.value, activeTab.value);
});

const appLabel = computed(() => {
  if (isClaude.value) return "Claude Code";
  if (isOpenCode.value) return "OpenCode CLI";
  if (isPi.value) return "Pi Agent";
  if (isOmp.value) return "omp";
  if (isReasonix.value) return "Reasonix";
  if (isCodex.value) return "Codex Desktop";
  if (isKimi.value) return "Kimi Code CLI";
  return "通用";
});

const pageTitleSuffix = computed(() => {
  const map = {
    claude: {
      usage: "使用统计",
      mcp: "MCP 配置",
      skill: "Skill 配置",
      plugin: "插件管理",
      config: "配置切换",
    },
    opencode: {
      config: "配置管理",
      mcp: "MCP 配置",
      skill: "Skill",
      plugin: "扩展管理",
      usage: "使用统计",
    },
    pi: {
      config: "配置管理",
      mcp: "MCP 配置",
      skill: "Skill 管理",
      plugin: "扩展管理",
      usage: "使用统计",
    },
    omp: {
      config: "配置管理",
    },
    reasonix: {
      config: "配置管理",
    },
    codex: {
      config: "模型配置",
    },
    kimi: {
      config: "模型配置",
    },
    common: {
      config: "配置",
      autoroute: "路由",
      mcp: "MCP",
      skill: "Skill",
      usage: "使用统计",
    },
  };
  return map[activeApp.value]?.[activeTab.value] || "配置切换";
});

const pageTitle = computed(() => `${appLabel.value} ${pageTitleSuffix.value}`);

const switchApp = (app) => {
  if (activeApp.value !== app) {
    setActiveApp(app);
    activeTab.value = "config";
    ensureAppActivated(app);
    // 切到新应用后，触发一次 resize 让热力图重新计算宽度
    nextTick(() => window.dispatchEvent(new Event("resize")));
  }
};

// ==================== Agent 显示管理 ====================

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
const AGENT_ORDER = ["claude", "opencode", "pi", "omp", "reasonix", "codex", "kimi"];
const AGENT_META = {
  claude: { name: "Claude Code", icon: `${ASSET_BASE}claudecode.png` },
  opencode: { name: "OpenCode CLI", icon: `${ASSET_BASE}icon-opencode.png` },
  pi: { name: "Pi Agent", icon: `${ASSET_BASE}icon-pi.png` },
  omp: { name: "omp", icon: `${ASSET_BASE}omp-icon.svg` },
  reasonix: { name: "Reasonix", icon: `${ASSET_BASE}reasonix.svg` },
  codex: { name: "Codex Desktop", icon: `${ASSET_BASE}icon-codex.png` },
  kimi: { name: "Kimi Code CLI", icon: `${ASSET_BASE}kimi.svg` },
};

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

// 自动持久化：勾选或排序变化即保存（不依赖组件 change 事件，deep 监听可见状态与顺序）
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

// 启停变化：持久化 + 同步指令（拖拽排序只触发 agentOrder 的 watch，不重复同步指令）
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

const handleAppSelect = (data) => {
  const app = typeof data === "object" ? data.value : data;
  switchApp(app);
};

onMounted(() => {
  // 自动路由开启状态（每次进入插件从 DB 重读，之后由 AutoRouteView 开关同步）
  refreshAutoRouteEnabled();

  // 根据入口命令预选对应应用
  const appMap = {
    claudeConfig: "claude",
    opencodeConfig: "opencode",
    piConfig: "pi",
    ompConfig: "omp",
    reasonixConfig: "reasonix",
    codexConfig: "codex",
    kimiConfig: "kimi",
    commonConfig: "common",
  };
  if (appMap[props.route]) {
    setActiveApp(appMap[props.route]);
    ensureAppActivated(appMap[props.route]);
    // 入口路由进入被隐藏的 agent 时自动显示，避免「回不去」死锁
    if (visibleAgents.value && !visibleAgents.value[appMap[props.route]]) {
      toggleAgentVisibility(appMap[props.route], true);
    }
  }

  if (props.route === "installClaudeSkill" && props.payload) {
    setActiveApp("claude");
    ensureAppActivated("claude");
    markTabVisited("claude", "skill");
    activeTab.value = "skill";
    setTimeout(() => {
      if (skillViewRef.value) {
        skillViewRef.value.openInstallWithUrl(props.payload);
      }
    }, 100);
  } else if (props.route === "installOpencodeSkill" && props.payload) {
    setActiveApp("opencode");
    ensureAppActivated("opencode");
    markTabVisited("opencode", "skill");
    activeTab.value = "skill";
    setTimeout(() => {
      if (ocSkillViewRef.value) {
        ocSkillViewRef.value.openInstallWithUrl(props.payload);
      }
    }, 100);
  } else if (props.route === "installCommonSkill" && props.payload) {
    setActiveApp("common");
    ensureAppActivated("common");
    markTabVisited("common", "skill");
    activeTab.value = "skill";
    setTimeout(() => {
      if (commonSkillViewRef.value) {
        commonSkillViewRef.value.openInstallWithUrl(props.payload);
      }
    }, 100);
  } else if (props.route === "installPiExtension" && props.payload) {
    setActiveApp("pi");
    ensureAppActivated("pi");
    markTabVisited("pi", "plugin");
    activeTab.value = "plugin";
    setTimeout(() => {
      if (piPluginViewRef.value) {
        piPluginViewRef.value.installFromUrl(props.payload);
      }
    }, 100);
  }
});
</script>

<template>
  <div class="container">
    <div class="header">
      <div class="header-left">
        <img v-if="isClaude" :src="`${ASSET_BASE}claudecode.png`" alt="logo" class="logo" />
        <img
          v-else-if="isOpenCode"
          :src="`${ASSET_BASE}icon-opencode.png`"
          alt="logo"
          class="logo"
        />
        <img v-else-if="isOmp" :src="`${ASSET_BASE}omp-icon.svg`" alt="logo" class="logo" />
        <img v-else-if="isReasonix" :src="`${ASSET_BASE}reasonix.svg`" alt="logo" class="logo" />
        <img v-else-if="isCodex" :src="`${ASSET_BASE}icon-codex.png`" alt="logo" class="logo" />
        <img v-else-if="isKimi" :src="`${ASSET_BASE}kimi.svg`" alt="logo" class="logo" />
        <img v-else-if="isPi" :src="`${ASSET_BASE}icon-pi.png`" alt="logo" class="logo" />
        <img v-else-if="isCommon" :src="`${ASSET_BASE}gen.svg`" alt="logo" class="logo" />
        <Dropdown
          :options="appDropdownOptions"
          :min-column-width="160"
          @click="handleAppSelect"
        >
          <span class="app-selector">
            {{ appLabel }} <ChevronDownIcon size="16px" />
          </span>
        </Dropdown>
        <span class="page-title">{{ pageTitleSuffix }}</span>
        <Button
          shape="circle"
          variant="text"
          theme="default"
          class="settings-btn"
          @click="showSettings = true"
        >
          <template #icon><SettingIcon /></template>
        </Button>
      </div>
      <div class="header-right">
        <!-- 通用配置 tabs -->
        <div v-if="isCommon" class="tab-buttons">
          <Button
            size="small"
            :theme="activeTab === 'config' ? 'primary' : 'default'"
            :variant="activeTab === 'config' ? 'base' : 'outline'"
            @click="activeTab = 'config'"
          >
            <template #icon><DashboardIcon /></template> 配置
          </Button>
          <span class="route-tab-btn">
            <Button
              size="small"
              :theme="activeTab === 'autoroute' ? 'primary' : 'default'"
              :variant="activeTab === 'autoroute' ? 'base' : 'outline'"
              @click="activeTab = 'autoroute'"
            >
              <template #icon><MapRoutePlanningIcon /></template> 路由
            </Button>
            <!-- 自动路由开启标识：按钮右上角绿点（外层包裹定位，.t-button 自身 overflow: hidden 会裁切溢出角标） -->
            <span v-if="autoRouteEnabled" class="route-on-dot" />
          </span>
          <Button
            size="small"
            :theme="activeTab === 'mcp' ? 'primary' : 'default'"
            :variant="activeTab === 'mcp' ? 'base' : 'outline'"
            @click="activeTab = 'mcp'"
          >
            <template #icon><ServerIcon /></template> MCP
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'skill' ? 'primary' : 'default'"
            :variant="activeTab === 'skill' ? 'base' : 'outline'"
            @click="activeTab = 'skill'"
          >
            <template #icon><BookIcon /></template> Skill
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'usage' ? 'primary' : 'default'"
            :variant="activeTab === 'usage' ? 'base' : 'outline'"
            @click="activeTab = 'usage'"
          >
            <template #icon><ChartIcon /></template> 统计
          </Button>
        </div>
        <!-- Claude Code tabs -->
        <div v-else-if="isClaude" class="tab-buttons">
          <Button
            size="small"
            :theme="activeTab === 'config' ? 'primary' : 'default'"
            :variant="activeTab === 'config' ? 'base' : 'outline'"
            @click="activeTab = 'config'"
          >
            <template #icon><DashboardIcon /></template> 配置
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'mcp' ? 'primary' : 'default'"
            :variant="activeTab === 'mcp' ? 'base' : 'outline'"
            @click="activeTab = 'mcp'"
          >
            <template #icon><ServerIcon /></template> MCP
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'skill' ? 'primary' : 'default'"
            :variant="activeTab === 'skill' ? 'base' : 'outline'"
            @click="activeTab = 'skill'"
          >
            <template #icon><BookIcon /></template> Skill
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'plugin' ? 'primary' : 'default'"
            :variant="activeTab === 'plugin' ? 'base' : 'outline'"
            @click="activeTab = 'plugin'"
          >
            <template #icon><AppIcon /></template> Plugin
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'usage' ? 'primary' : 'default'"
            :variant="activeTab === 'usage' ? 'base' : 'outline'"
            @click="activeTab = 'usage'"
          >
            <template #icon><ChartIcon /></template> 统计
          </Button>
        </div>
        <!-- Pi Agent tabs -->
        <div v-else-if="isPi" class="tab-buttons">
          <Button
            size="small"
            :theme="activeTab === 'config' ? 'primary' : 'default'"
            :variant="activeTab === 'config' ? 'base' : 'outline'"
            @click="activeTab = 'config'"
          >
            <template #icon><DashboardIcon /></template> 配置
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'mcp' ? 'primary' : 'default'"
            :variant="activeTab === 'mcp' ? 'base' : 'outline'"
            @click="activeTab = 'mcp'"
          >
            <template #icon><ServerIcon /></template> MCP
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'skill' ? 'primary' : 'default'"
            :variant="activeTab === 'skill' ? 'base' : 'outline'"
            @click="activeTab = 'skill'"
          >
            <template #icon><BookIcon /></template> Skill
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'plugin' ? 'primary' : 'default'"
            :variant="activeTab === 'plugin' ? 'base' : 'outline'"
            @click="activeTab = 'plugin'"
          >
            <template #icon><AppIcon /></template> Plugin
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'usage' ? 'primary' : 'default'"
            :variant="activeTab === 'usage' ? 'base' : 'outline'"
            @click="activeTab = 'usage'"
          >
            <template #icon><ChartIcon /></template> 统计
          </Button>
        </div>
        <!-- omp tabs -->
        <div v-else-if="isOmp" class="tab-buttons">
          <Button
            size="small"
            :theme="activeTab === 'config' ? 'primary' : 'default'"
            :variant="activeTab === 'config' ? 'base' : 'outline'"
            @click="activeTab = 'config'"
          >
            <template #icon><DashboardIcon /></template> 配置
          </Button>
        </div>
        <!-- Reasonix tabs -->
        <div v-else-if="isReasonix" class="tab-buttons">
          <Button
            size="small"
            :theme="activeTab === 'config' ? 'primary' : 'default'"
            :variant="activeTab === 'config' ? 'base' : 'outline'"
            @click="activeTab = 'config'"
          >
            <template #icon><DashboardIcon /></template> 配置
          </Button>
        </div>
        <!-- Codex tabs（仅模型配置） -->
        <div v-else-if="isCodex" class="tab-buttons">
          <Button
            size="small"
            :theme="activeTab === 'config' ? 'primary' : 'default'"
            :variant="activeTab === 'config' ? 'base' : 'outline'"
            @click="activeTab = 'config'"
          >
            <template #icon><DashboardIcon /></template> 配置
          </Button>
        </div>
        <!-- Kimi tabs（仅模型配置） -->
        <div v-else-if="isKimi" class="tab-buttons">
          <Button
            size="small"
            :theme="activeTab === 'config' ? 'primary' : 'default'"
            :variant="activeTab === 'config' ? 'base' : 'outline'"
            @click="activeTab = 'config'"
          >
            <template #icon><DashboardIcon /></template> 配置
          </Button>
        </div>
        <!-- OpenCode tabs -->
        <div v-else class="tab-buttons">
          <Button
            size="small"
            :theme="activeTab === 'config' ? 'primary' : 'default'"
            :variant="activeTab === 'config' ? 'base' : 'outline'"
            @click="activeTab = 'config'"
          >
            <template #icon><DashboardIcon /></template> 配置
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'mcp' ? 'primary' : 'default'"
            :variant="activeTab === 'mcp' ? 'base' : 'outline'"
            @click="activeTab = 'mcp'"
          >
            <template #icon><ServerIcon /></template> MCP
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'skill' ? 'primary' : 'default'"
            :variant="activeTab === 'skill' ? 'base' : 'outline'"
            @click="activeTab = 'skill'"
          >
            <template #icon><BookIcon /></template> Skill
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'plugin' ? 'primary' : 'default'"
            :variant="activeTab === 'plugin' ? 'base' : 'outline'"
            @click="activeTab = 'plugin'"
          >
            <template #icon><AppIcon /></template> Plugin
          </Button>
          <Button
            size="small"
            :theme="activeTab === 'usage' ? 'primary' : 'default'"
            :variant="activeTab === 'usage' ? 'base' : 'outline'"
            @click="activeTab = 'usage'"
          >
            <template #icon><ChartIcon /></template> 统计
          </Button>
        </div>
      </div>
    </div>

    <!-- 通用配置 views -->
    <template v-if="isAppReady('common')">
      <CommonConfigView v-if="isCommon && activeTab === 'config'" />
      <CommonMcpView
        v-if="isTabVisited('common', 'mcp')"
        v-show="isCommon && activeTab === 'mcp'"
      />
      <CommonSkillView
        v-if="isTabVisited('common', 'skill')"
        v-show="isCommon && activeTab === 'skill'"
        ref="commonSkillViewRef"
      />
      <CommonAutoRouteView
        v-if="isTabVisited('common', 'autoroute')"
        v-show="isCommon && activeTab === 'autoroute'"
      />
      <CommonUsageView
        v-if="isTabVisited('common', 'usage')"
        v-show="isCommon && activeTab === 'usage'"
      />
    </template>

    <!-- Claude Code views：已访问的标签页用 v-show 保持挂载，避免重复加载 -->
    <template v-if="isAppReady('claude')">
      <ConfigView v-if="isClaude && activeTab === 'config'" />
      <UsageView
        v-if="isTabVisited('claude', 'usage')"
        v-show="isClaude && activeTab === 'usage'"
      />
      <McpView
        v-if="isTabVisited('claude', 'mcp')"
        v-show="isClaude && activeTab === 'mcp'"
      />
      <SkillView
        v-if="isTabVisited('claude', 'skill')"
        v-show="isClaude && activeTab === 'skill'"
        ref="skillViewRef"
      />
      <PluginView
        v-if="isTabVisited('claude', 'plugin')"
        v-show="isClaude && activeTab === 'plugin'"
      />
    </template>

    <!-- Pi Agent views -->
    <template v-if="isAppReady('pi')">
      <PiConfigView v-if="isPi && activeTab === 'config'" />
      <PiUsageView
        v-if="isTabVisited('pi', 'usage')"
        v-show="isPi && activeTab === 'usage'"
      />
      <PiMcpView
        v-if="isTabVisited('pi', 'mcp')"
        v-show="isPi && activeTab === 'mcp'"
      />
      <PiSkillView
        v-if="isTabVisited('pi', 'skill')"
        v-show="isPi && activeTab === 'skill'"
      />
      <PiPluginView
        v-if="isTabVisited('pi', 'plugin')"
        v-show="isPi && activeTab === 'plugin'"
        ref="piPluginViewRef"
      />
    </template>

    <!-- OpenCode views -->
    <template v-if="isAppReady('opencode')">
      <OpenCodeConfigView v-if="isOpenCode && activeTab === 'config'" />
      <OpenCodeMcpView
        v-if="isTabVisited('opencode', 'mcp')"
        v-show="isOpenCode && activeTab === 'mcp'"
      />
      <OpenCodeSkillView
        v-if="isTabVisited('opencode', 'skill')"
        v-show="isOpenCode && activeTab === 'skill'"
        ref="ocSkillViewRef"
      />
      <OpenCodePluginView
        v-if="isTabVisited('opencode', 'plugin')"
        v-show="isOpenCode && activeTab === 'plugin'"
      />
      <OpenCodeUsageView
        v-if="isTabVisited('opencode', 'usage')"
        v-show="isOpenCode && activeTab === 'usage'"
      />
    </template>

    <!-- omp views -->
    <template v-if="isAppReady('omp')">
      <OmpConfigView v-if="isOmp && activeTab === 'config'" />
    </template>

    <!-- Reasonix views -->
    <template v-if="isAppReady('reasonix')">
      <ReasonixConfigView v-if="isReasonix && activeTab === 'config'" />
    </template>

    <!-- Codex views（仅模型配置） -->
    <template v-if="isAppReady('codex')">
      <CodexConfigView v-if="isCodex && activeTab === 'config'" />
    </template>

    <!-- Kimi views（仅模型配置） -->
    <template v-if="isAppReady('kimi')">
      <KimiConfigView v-if="isKimi && activeTab === 'config'" />
    </template>

    <Dialog
      v-model:visible="showSettings"
      header="设置"
      :footer="false"
      width="540px"
      placement="center"
    >
      <div class="settings-body">
        <!-- Agent 启停管理（最上） -->
        <div class="settings-section">
          <div class="settings-title">Agent 启停管理</div>
          <div class="settings-desc">
            勾选 = 启用：显示在顶部切换器，并保留 uTools 启动指令；取消勾选 = 停用：从切换器隐藏，
            并移除该 agent 的 uTools 启动指令（功能指令 + 匹配指令一并移除）；「通用」始终启用；
            当前正在使用的 agent 不可停用；拖动可排序
          </div>
          <div class="agent-visibility-list">
            <div
              v-for="(app, idx) in agentOrder"
              :key="app"
              class="agent-visibility-item"
              @dragover.prevent
              @drop="onAgentDrop(idx)"
            >
              <span
                class="agent-visibility-drag"
                draggable="true"
                @dragstart="onAgentDragStart(idx)"
                @dragend="onAgentDragEnd"
              >
                <GripVertical :size="16" />
              </span>
              <img :src="AGENT_META[app].icon" class="agent-visibility-icon" alt="" />
              <span class="agent-visibility-name">{{ AGENT_META[app].name }}</span>
              <span v-if="app === activeApp" class="agent-visibility-tag">当前</span>
              <Checkbox
                v-model="visibleAgents[app]"
                :disabled="app === activeApp"
                class="agent-visibility-checkbox"
                @change="(val) => onAgentToggle(app, val)"
              />
            </div>
          </div>
        </div>

        <Divider class="settings-divider" />

        <div class="settings-row">
          <div class="settings-label">
            <div class="settings-title">黑暗模式背景特效</div>
            <div class="settings-desc">
              深色模式下的动态背景特效，开启后会覆盖毛玻璃背景，并可能导致电脑卡顿
            </div>
          </div>
          <Switch
            :model-value="darkBackgroundEnabled"
            @change="setDarkBackground"
          />
        </div>
        <div
          class="effect-cards"
          :class="{ 'effect-cards--disabled': !darkBackgroundEnabled }"
        >
          <div
            class="effect-card"
            :class="{ 'effect-card--active': darkEffect === 'prismatic' }"
            @click="darkBackgroundEnabled && setDarkEffect('prismatic')"
          >
            <div class="effect-card__name">Prismatic Burst</div>
            <div class="effect-card__desc">棱镜光谱爆裂</div>
          </div>
          <div
            class="effect-card"
            :class="{ 'effect-card--active': darkEffect === 'pixel' }"
            @click="darkBackgroundEnabled && setDarkEffect('pixel')"
          >
            <div class="effect-card__name">FaultyTerminal</div>
            <div class="effect-card__desc">故障像素终端</div>
          </div>
          <div
            class="effect-card"
            :class="{ 'effect-card--active': darkEffect === 'aurora' }"
            @click="darkBackgroundEnabled && setDarkEffect('aurora')"
          >
            <div class="effect-card__name">Aurora</div>
            <div class="effect-card__desc">流动极光</div>
          </div>
          <div
            class="effect-card"
            :class="{ 'effect-card--active': darkEffect === 'galaxy' }"
            @click="darkBackgroundEnabled && setDarkEffect('galaxy')"
          >
            <div class="effect-card__name">Galaxy</div>
            <div class="effect-card__desc">星河漫游</div>
          </div>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.container {
  padding: 10px 20px 10px;
  min-height: 100vh;
  box-sizing: border-box;
  /* 玻璃背景：不涂色，透出 uTools 8 宿主窗口的原生亚克力模糊（与底栏同源） */
  background: transparent;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-right {
  display: flex;
  align-items: center;
}
.header .logo {
  width: 32px;
  height: 32px;
  border-radius: var(--td-radius-default);
}
.page-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--td-text-color-primary);
  line-height: 1;
}
.tab-buttons {
  display: flex;
  gap: 4px;
  align-items: center;
}
/* 路由 tab 按钮：自动路由开启时右上角绿点标识（表示网关已开启） */
.route-tab-btn {
  position: relative;
  display: inline-flex;
}
.route-on-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--td-success-color);
  border: 1.5px solid var(--td-bg-color-container);
  box-sizing: border-box;
  pointer-events: none;
  z-index: 1;
}
:root[theme-mode="dark"] .route-on-dot {
  border-color: #303133;
}
.opencode-static-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  font-weight: 500;
  color: var(--td-text-color-primary);
  padding: 0 8px;
}

.app-selector {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  font-size: 16px;
  font-weight: 600;
  color: var(--td-text-color-primary);
  padding: 4px 8px;
  border-radius: var(--td-radius-default);
  transition: background-color 0.2s;
  user-select: none;
  /* 不设固定 min-width，宽度跟随选中文本自适应（omp 短文本时不留大空隙） */
}
.app-selector:hover {
  background-color: var(--td-bg-color-container-hover);
}

.settings-btn {
  color: var(--td-text-color-secondary);
}
.settings-btn:hover {
  color: var(--td-brand-color);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}
.settings-row + .settings-row {
  margin-top: 8px;
}
.settings-body {
  max-height: 70vh;
  overflow-y: auto;
  padding-right: 4px;
}
.settings-divider {
  margin: 16px 0 12px;
}
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-visibility-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: 6px;
}
.agent-visibility-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--td-radius-default);
  user-select: none;
}
.agent-visibility-item:hover {
  background: var(--td-bg-color-container-hover);
}
.agent-visibility-drag {
  flex-shrink: 0;
  color: var(--td-text-color-placeholder);
  cursor: grab;
  display: inline-flex;
  align-items: center;
}
.agent-visibility-drag:active {
  cursor: grabbing;
}
.agent-visibility-icon {
  width: 22px;
  height: 22px;
  border-radius: var(--td-radius-default);
}
.agent-visibility-name {
  flex: 1;
  font-size: 13px;
  color: var(--td-text-color-primary);
}
.agent-visibility-tag {
  font-size: 11px;
  color: var(--td-success-color);
  background: var(--td-success-color-1);
  padding: 1px 6px;
  border-radius: 4px;
}
.agent-visibility-checkbox {
  --td-brand-color: var(--td-success-color);
}
.effect-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.effect-card {
  flex: 1 1 calc(50% - 5px);
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--td-component-border);
  border-radius: var(--td-radius-default);
  background-color: var(--td-bg-color-container);
  cursor: pointer;
  transition:
    border-color 0.2s,
    background-color 0.2s,
    box-shadow 0.2s;
  user-select: none;
}
.effect-card:hover {
  border-color: var(--td-brand-color);
}
.effect-card--active {
  border-color: var(--td-brand-color);
  background-color: var(--td-brand-color-light);
  box-shadow: 0 0 0 1px var(--td-brand-color) inset;
}
.effect-card__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--td-text-color-primary);
}
.effect-card__desc {
  font-size: 12px;
  color: var(--td-text-color-secondary);
  margin-top: 2px;
}
.effect-cards--disabled .effect-card {
  opacity: 0.5;
  cursor: not-allowed;
}
.effect-cards--disabled .effect-card:hover {
  border-color: var(--td-component-border);
}
.settings-label {
  flex: 1;
}
.settings-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--td-text-color-primary);
}
.settings-desc {
  font-size: 12px;
  color: var(--td-text-color-secondary);
  margin-top: 2px;
  line-height: 1.5;
}

/* Switch dark mode fix: darken track when off so handle (white #fff) is visible */
:root[theme-mode="dark"] :deep(.t-switch) {
  background-color: var(--td-gray-color-6);
}
:root[theme-mode="dark"] :deep(.t-switch:hover) {
  background-color: var(--td-gray-color-5);
}
</style>

<!-- 全局样式：Dropdown 弹窗（teleport 到 body，scoped 无法覆盖） -->
<style>
:root[theme-mode="dark"] .t-dropdown {
  background-color: var(--td-bg-color-container);
  border-color: var(--td-component-border);
}
:root[theme-mode="dark"] .t-dropdown__item {
  color: var(--td-text-color-primary);
}
:root[theme-mode="dark"] .t-dropdown__item:hover {
  background-color: var(--td-bg-color-container-hover);
}
:root[theme-mode="dark"]
  .t-dropdown__item--theme-default.t-dropdown__item--active {
  color: var(--td-brand-color);
  background-color: var(--td-brand-color-light);
}
:root[theme-mode="dark"] .t-popup__content {
  background: var(--td-bg-color-container);
}
</style>
