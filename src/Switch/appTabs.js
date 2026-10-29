import {
  DashboardIcon,
  ServerIcon,
  BookIcon,
  AppIcon,
  ChartIcon,
  MapRoutePlanningIcon,
  CardmembershipIcon,
  StarIcon,
} from "tdesign-icons-vue-next";

// 各应用的页签配置（顺序即展示顺序）：labelKey 为按钮文案，titleKey 为页标题后缀。
// index.vue 的顶栏 tab 按钮与 pageTitleSuffix 均由本表驱动；文案在 shared/i18n 的 nav.json。
export const APP_TABS = {
  common: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.tab.config", icon: DashboardIcon },
    { key: "autoroute", labelKey: "nav.tab.gateway", titleKey: "nav.title.gateway", icon: MapRoutePlanningIcon, gatewayDot: true },
    { key: "mcp", labelKey: "nav.tab.mcp", titleKey: "nav.tab.mcp", icon: ServerIcon },
    { key: "skill", labelKey: "nav.tab.skill", titleKey: "nav.tab.skill", icon: BookIcon },
    { key: "subscription", labelKey: "nav.tab.subscription", titleKey: "nav.title.subscription", icon: CardmembershipIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  claude: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.configSwitch", icon: DashboardIcon },
    { key: "mcp", labelKey: "nav.tab.mcp", titleKey: "nav.title.mcpConfig", icon: ServerIcon },
    { key: "skill", labelKey: "nav.tab.skill", titleKey: "nav.title.skillConfig", icon: BookIcon },
    { key: "plugin", labelKey: "nav.tab.plugin", titleKey: "nav.title.pluginManage", icon: AppIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  opencode: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.configManage", icon: DashboardIcon },
    { key: "mcp", labelKey: "nav.tab.mcp", titleKey: "nav.title.mcpConfig", icon: ServerIcon },
    { key: "skill", labelKey: "nav.tab.skill", titleKey: "nav.title.skillConfig", icon: BookIcon },
    { key: "plugin", labelKey: "nav.tab.plugin", titleKey: "nav.title.extensionManage", icon: AppIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  pi: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.configManage", icon: DashboardIcon },
    { key: "mcp", labelKey: "nav.tab.mcp", titleKey: "nav.title.mcpConfig", icon: ServerIcon },
    { key: "skill", labelKey: "nav.tab.skill", titleKey: "nav.title.skillManage", icon: BookIcon },
    { key: "plugin", labelKey: "nav.tab.plugin", titleKey: "nav.title.extensionManage", icon: AppIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  omp: [{ key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.configManage", icon: DashboardIcon }],
  reasonix: [{ key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.configManage", icon: DashboardIcon }],
  codex: [{ key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon }],
  kimi: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  minimax: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  qoder: [{ key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon }],
  zcode: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  hermes: [{ key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon }],
  dsh: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  grok: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon },
    { key: "mcp", labelKey: "nav.tab.mcp", titleKey: "nav.title.mcpConfig", icon: ServerIcon },
    { key: "skill", labelKey: "nav.tab.skill", titleKey: "nav.title.skillManage", icon: BookIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  cline: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon },
    { key: "mcp", labelKey: "nav.tab.mcp", titleKey: "nav.title.mcpConfig", icon: ServerIcon },
    { key: "skill", labelKey: "nav.tab.skill", titleKey: "nav.title.skillManage", icon: BookIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
  commandcode: [
    { key: "config", labelKey: "nav.tab.config", titleKey: "nav.title.modelConfig", icon: DashboardIcon },
    { key: "mcp", labelKey: "nav.tab.mcp", titleKey: "nav.title.mcpConfig", icon: ServerIcon },
    { key: "skill", labelKey: "nav.tab.skill", titleKey: "nav.title.skillManage", icon: BookIcon },
    { key: "taste", labelKey: "nav.tab.taste", titleKey: "nav.title.taste", icon: StarIcon },
    { key: "usage", labelKey: "nav.tab.usage", titleKey: "nav.title.usage", icon: ChartIcon },
  ],
};

// uTools 入口深链路由 → 目标应用 / 页签 / 子视图 ref 方法
export const DEEP_LINK_ROUTES = [
  { route: "installClaudeSkill", app: "claude", tab: "skill", refKey: "skillViewRef", method: "openInstallWithUrl" },
  { route: "installOpencodeSkill", app: "opencode", tab: "skill", refKey: "ocSkillViewRef", method: "openInstallWithUrl" },
  { route: "installCommonSkill", app: "common", tab: "skill", refKey: "commonSkillViewRef", method: "openInstallWithUrl" },
  { route: "installPiExtension", app: "pi", tab: "plugin", refKey: "piPluginViewRef", method: "installFromUrl" },
  { route: "installCommandCodeSkill", app: "commandcode", tab: "skill", refKey: "commandCodeSkillViewRef", method: "openInstallWithUrl" },
  { route: "switchSkillScene", app: "common", tab: "skill", refKey: "commonSkillViewRef", method: "applySceneFromCommand" },
];
