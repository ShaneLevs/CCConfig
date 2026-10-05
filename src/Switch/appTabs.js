import {
  DashboardIcon,
  ServerIcon,
  BookIcon,
  AppIcon,
  ChartIcon,
  MapRoutePlanningIcon,
} from "tdesign-icons-vue-next";

// 各应用的页签配置（顺序即展示顺序）：label 为按钮文案，title 为页标题后缀。
// index.vue 的顶栏 tab 按钮与 pageTitleSuffix 均由本表驱动。
export const APP_TABS = {
  common: [
    { key: "config", label: "配置", title: "配置", icon: DashboardIcon },
    { key: "autoroute", label: "网关", title: "网关", icon: MapRoutePlanningIcon, gatewayDot: true },
    { key: "mcp", label: "MCP", title: "MCP", icon: ServerIcon },
    { key: "skill", label: "Skill", title: "Skill", icon: BookIcon },
    { key: "usage", label: "统计", title: "使用统计", icon: ChartIcon },
  ],
  claude: [
    { key: "config", label: "配置", title: "配置切换", icon: DashboardIcon },
    { key: "mcp", label: "MCP", title: "MCP 配置", icon: ServerIcon },
    { key: "skill", label: "Skill", title: "Skill 配置", icon: BookIcon },
    { key: "plugin", label: "Plugin", title: "插件管理", icon: AppIcon },
    { key: "usage", label: "统计", title: "使用统计", icon: ChartIcon },
  ],
  opencode: [
    { key: "config", label: "配置", title: "配置管理", icon: DashboardIcon },
    { key: "mcp", label: "MCP", title: "MCP 配置", icon: ServerIcon },
    { key: "skill", label: "Skill", title: "Skill", icon: BookIcon },
    { key: "plugin", label: "Plugin", title: "扩展管理", icon: AppIcon },
    { key: "usage", label: "统计", title: "使用统计", icon: ChartIcon },
  ],
  pi: [
    { key: "config", label: "配置", title: "配置管理", icon: DashboardIcon },
    { key: "mcp", label: "MCP", title: "MCP 配置", icon: ServerIcon },
    { key: "skill", label: "Skill", title: "Skill 管理", icon: BookIcon },
    { key: "plugin", label: "Plugin", title: "扩展管理", icon: AppIcon },
    { key: "usage", label: "统计", title: "使用统计", icon: ChartIcon },
  ],
  omp: [{ key: "config", label: "配置", title: "配置管理", icon: DashboardIcon }],
  reasonix: [{ key: "config", label: "配置", title: "配置管理", icon: DashboardIcon }],
  codex: [{ key: "config", label: "配置", title: "模型配置", icon: DashboardIcon }],
  kimi: [{ key: "config", label: "配置", title: "模型配置", icon: DashboardIcon }],
  minimax: [{ key: "config", label: "配置", title: "模型配置", icon: DashboardIcon }],
  qoder: [{ key: "config", label: "配置", title: "模型配置", icon: DashboardIcon }],
  zcode: [{ key: "config", label: "配置", title: "模型配置", icon: DashboardIcon }],
};

// uTools 入口深链路由 → 目标应用 / 页签 / 子视图 ref 方法
export const DEEP_LINK_ROUTES = [
  { route: "installClaudeSkill", app: "claude", tab: "skill", refKey: "skillViewRef", method: "openInstallWithUrl" },
  { route: "installOpencodeSkill", app: "opencode", tab: "skill", refKey: "ocSkillViewRef", method: "openInstallWithUrl" },
  { route: "installCommonSkill", app: "common", tab: "skill", refKey: "commonSkillViewRef", method: "openInstallWithUrl" },
  { route: "installPiExtension", app: "pi", tab: "plugin", refKey: "piPluginViewRef", method: "installFromUrl" },
];
