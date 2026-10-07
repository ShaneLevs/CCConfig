<script setup>
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { Button, Dropdown, Dialog, Switch, Divider } from "tdesign-vue-next";
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
import { useAppContext } from "../composables/useAppContext";
import { useAutoRouteStatus } from "../composables/useAutoRouteStatus";
import { useDarkBackground } from "../composables/useDarkBackground";
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

const { darkBackgroundEnabled, setDarkBackground, darkEffect, setDarkEffect } =
  useDarkBackground();
const showSettings = ref(false);

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

    <Dialog
      v-model:visible="showSettings"
      header="设置"
      :footer="false"
      width="540px"
      placement="center"
    >
      <div class="settings-body">
        <!-- Agent 启停管理（最上） -->
        <AgentVisibilitySettings />

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
