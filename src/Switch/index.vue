<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { Button, Dropdown, Dialog, RadioGroup, RadioButton } from "tdesign-vue-next";
import { ChevronDownIcon, SettingIcon } from "tdesign-icons-vue-next";
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
import MinimaxConfigView from "./minimax/ConfigView.vue";
import QoderConfigView from "./qoder/ConfigView.vue";
import ZcodeConfigView from "./zcode/ConfigView.vue";
import HermesConfigView from "./hermes/ConfigView.vue";
import CommonConfigView from "./common/ConfigView.vue";
import CommonMcpView from "./common/McpView.vue";
import CommonSkillView from "./common/SkillView.vue";
import CommonAutoRouteView from "./common/AutoRouteView.vue";
import CommonUsageView from "./common/UsageView.vue";
import AppTabBar from "../components/AppTabBar.vue";
import AgentVisibilitySettings from "../components/AgentVisibilitySettings.vue";
import BackgroundEffectSettings from "../components/BackgroundEffectSettings.vue";
import AgentSideRail from "../components/AgentSideRail.vue";
import { useAppContext } from "../composables/useAppContext";
import { useAutoRouteStatus } from "../composables/useAutoRouteStatus";
import { useAgentVisibility } from "../composables/useAgentVisibility";
import { APP_TABS, DEEP_LINK_ROUTES } from "./appTabs";

const props = defineProps({
  route: String,
  payload: String,
});

const { activeApp, setActiveApp } = useAppContext();
const { AGENT_META, appDropdownOptions, toggleAgentVisibility, visibleAgents } = useAgentVisibility();

// 自动网关开启状态（每次进入插件从 DB 重读，之后由 AutoRouteView 开关同步）
const { refreshAutoRouteEnabled } = useAutoRouteStatus();

// 设置弹窗页签：agents = Agent 启停管理，background = 深色背景特效
const settingsTab = ref("agents");
const showSettings = ref(false);

// 左侧 agent 快速切换栏：窗口宽度超过内容上限后，左空隙 ≥ 侧栏宽 152 + 内容间距 12 +
// 窗沿留白 8 时显示，并隐藏头部下拉（菜单变成侧栏）。800 须与 .container 的 --content-max 同步。
const AGENT_RAIL_MIN_GAP = 172;
const showAgentRail = ref(false);
const updateAgentRail = () => {
  showAgentRail.value = (window.innerWidth - 800) / 2 >= AGENT_RAIL_MIN_GAP;
};

// 图标位于 public/ 目录：必须用 BASE_URL 前缀拼接（base: './' 打包后为相对路径）
const ASSET_BASE = import.meta.env.BASE_URL;

const activeTab = ref("config");
const skillViewRef = ref(null);
const ocSkillViewRef = ref(null);
const commonSkillViewRef = ref(null);
const piPluginViewRef = ref(null);
// 深链路由 → 子视图 ref 查找表
const deepLinkRefs = { skillViewRef, ocSkillViewRef, commonSkillViewRef, piPluginViewRef };

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

// 标签页/应用切换时自动标记已访问，保持组件不销毁
watch([activeTab, activeApp], () => {
  markTabVisited(activeApp.value, activeTab.value);
});

const appLabel = computed(
  () => (activeApp.value === "common" ? "通用" : AGENT_META[activeApp.value]?.name) || "通用"
);

// 页标题后缀：页签的 title 字段（按钮文案 label 之外的完整标题）
const pageTitleSuffix = computed(() => {
  const tab = (APP_TABS[activeApp.value] || []).find((t) => t.key === activeTab.value);
  return tab?.title || "配置切换";
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

const handleAppSelect = (data) => {
  const app = typeof data === "object" ? data.value : data;
  switchApp(app);
};

onMounted(() => {
  refreshAutoRouteEnabled();
  updateAgentRail();
  window.addEventListener("resize", updateAgentRail);

  // 根据入口命令预选对应应用
  const appMap = {
    claudeConfig: "claude",
    opencodeConfig: "opencode",
    piConfig: "pi",
    ompConfig: "omp",
    reasonixConfig: "reasonix",
    codexConfig: "codex",
    kimiConfig: "kimi",
    minimaxConfig: "minimax",
    qoderConfig: "qoder",
    zcodeConfig: "zcode",
    hermesConfig: "hermes",
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

  // 安装类深链：切到目标应用/页签后调用子视图暴露的安装方法
  const deepLink = DEEP_LINK_ROUTES.find((r) => r.route === props.route && props.payload);
  if (deepLink) {
    setActiveApp(deepLink.app);
    ensureAppActivated(deepLink.app);
    markTabVisited(deepLink.app, deepLink.tab);
    activeTab.value = deepLink.tab;
    setTimeout(() => {
      const comp = deepLinkRefs[deepLink.refKey]?.value;
      if (comp) {
        comp[deepLink.method](props.payload);
      }
    }, 100);
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", updateAgentRail);
});
</script>

<template>
  <div class="container">
    <div class="header">
      <div class="header-left">
        <img
          :src="activeApp === 'common' ? `${ASSET_BASE}gen.svg` : AGENT_META[activeApp]?.icon"
          alt="logo"
          class="logo"
        />
        <Dropdown
          v-show="!showAgentRail"
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
        <AppTabBar :app="activeApp" v-model:active-tab="activeTab" />
      </div>
    </div>

    <!-- 通用配置 views -->
    <template v-if="isAppReady('common')">
      <CommonConfigView v-if="activeApp === 'common' && activeTab === 'config'" />
      <CommonMcpView
        v-if="isTabVisited('common', 'mcp')"
        v-show="activeApp === 'common' && activeTab === 'mcp'"
      />
      <CommonSkillView
        v-if="isTabVisited('common', 'skill')"
        v-show="activeApp === 'common' && activeTab === 'skill'"
        ref="commonSkillViewRef"
      />
      <CommonAutoRouteView
        v-if="isTabVisited('common', 'autoroute')"
        v-show="activeApp === 'common' && activeTab === 'autoroute'"
      />
      <CommonUsageView
        v-if="isTabVisited('common', 'usage')"
        v-show="activeApp === 'common' && activeTab === 'usage'"
      />
    </template>

    <!-- Claude Code views：已访问的标签页用 v-show 保持挂载，避免重复加载 -->
    <template v-if="isAppReady('claude')">
      <ConfigView v-if="activeApp === 'claude' && activeTab === 'config'" />
      <UsageView
        v-if="isTabVisited('claude', 'usage')"
        v-show="activeApp === 'claude' && activeTab === 'usage'"
      />
      <McpView
        v-if="isTabVisited('claude', 'mcp')"
        v-show="activeApp === 'claude' && activeTab === 'mcp'"
      />
      <SkillView
        v-if="isTabVisited('claude', 'skill')"
        v-show="activeApp === 'claude' && activeTab === 'skill'"
        ref="skillViewRef"
      />
      <PluginView
        v-if="isTabVisited('claude', 'plugin')"
        v-show="activeApp === 'claude' && activeTab === 'plugin'"
      />
    </template>

    <!-- Pi Agent views -->
    <template v-if="isAppReady('pi')">
      <PiConfigView v-if="activeApp === 'pi' && activeTab === 'config'" />
      <PiUsageView
        v-if="isTabVisited('pi', 'usage')"
        v-show="activeApp === 'pi' && activeTab === 'usage'"
      />
      <PiMcpView
        v-if="isTabVisited('pi', 'mcp')"
        v-show="activeApp === 'pi' && activeTab === 'mcp'"
      />
      <PiSkillView
        v-if="isTabVisited('pi', 'skill')"
        v-show="activeApp === 'pi' && activeTab === 'skill'"
      />
      <PiPluginView
        v-if="isTabVisited('pi', 'plugin')"
        v-show="activeApp === 'pi' && activeTab === 'plugin'"
        ref="piPluginViewRef"
      />
    </template>

    <!-- OpenCode views -->
    <template v-if="isAppReady('opencode')">
      <OpenCodeConfigView v-if="activeApp === 'opencode' && activeTab === 'config'" />
      <OpenCodeMcpView
        v-if="isTabVisited('opencode', 'mcp')"
        v-show="activeApp === 'opencode' && activeTab === 'mcp'"
      />
      <OpenCodeSkillView
        v-if="isTabVisited('opencode', 'skill')"
        v-show="activeApp === 'opencode' && activeTab === 'skill'"
        ref="ocSkillViewRef"
      />
      <OpenCodePluginView
        v-if="isTabVisited('opencode', 'plugin')"
        v-show="activeApp === 'opencode' && activeTab === 'plugin'"
      />
      <OpenCodeUsageView
        v-if="isTabVisited('opencode', 'usage')"
        v-show="activeApp === 'opencode' && activeTab === 'usage'"
      />
    </template>

    <!-- omp views -->
    <template v-if="isAppReady('omp')">
      <OmpConfigView v-if="activeApp === 'omp' && activeTab === 'config'" />
    </template>

    <!-- Reasonix views -->
    <template v-if="isAppReady('reasonix')">
      <ReasonixConfigView v-if="activeApp === 'reasonix' && activeTab === 'config'" />
    </template>

    <!-- Codex views（仅模型配置） -->
    <template v-if="isAppReady('codex')">
      <CodexConfigView v-if="activeApp === 'codex' && activeTab === 'config'" />
    </template>

    <!-- Kimi views（仅模型配置） -->
    <template v-if="isAppReady('kimi')">
      <KimiConfigView v-if="activeApp === 'kimi' && activeTab === 'config'" />
    </template>

    <!-- MiniMax Code views（仅模型配置） -->
    <template v-if="isAppReady('minimax')">
      <MinimaxConfigView v-if="activeApp === 'minimax' && activeTab === 'config'" />
    </template>

    <!-- Qoder views（仅模型配置） -->
    <template v-if="isAppReady('qoder')">
      <QoderConfigView v-if="activeApp === 'qoder' && activeTab === 'config'" />
    </template>

    <!-- ZCode views（仅模型配置） -->
    <template v-if="isAppReady('zcode')">
      <ZcodeConfigView v-if="activeApp === 'zcode' && activeTab === 'config'" />
    </template>

    <!-- Hermes views（仅模型配置） -->
    <template v-if="isAppReady('hermes')">
      <HermesConfigView v-if="activeApp === 'hermes' && activeTab === 'config'" />
    </template>

    <!-- 左侧 agent 快速切换栏（宽窗口时出现在限宽内容的左侧空隙内） -->
    <AgentSideRail v-if="showAgentRail" @select="switchApp" />

    <Dialog
      v-model:visible="showSettings"
      header="设置"
      :footer="false"
      width="540px"
      placement="center"
    >
      <div class="settings-body">
        <RadioGroup v-model="settingsTab" variant="default-filled" size="small" class="settings-tabs">
          <RadioButton value="agents">Agent 启停</RadioButton>
          <RadioButton value="background">背景特效</RadioButton>
        </RadioGroup>

        <AgentVisibilitySettings v-if="settingsTab === 'agents'" />
        <BackgroundEffectSettings v-else />
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.container {
  /* 限宽居中：窗口过宽时页面不再无限拉伸，两侧留空透出玻璃/特效背景；
     --content-max 供 AgentSideRail 定位计算，与 updateAgentRail 里的 800 同步 */
  --content-max: 800px;
  max-width: var(--content-max);
  margin: 0 auto;
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
.settings-body {
  max-height: 70vh;
  overflow-y: auto;
  padding-right: 4px;
}
.settings-tabs {
  margin-bottom: 12px;
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
