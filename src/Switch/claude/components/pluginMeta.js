// claude 插件页共享的元数据/工具函数（视图与弹窗组件共用）。

// 插件组件类型徽标（顺序即展示顺序）
export const componentBadges = [
  { key: "skills", label: "Skills", color: "#f5222d" },
  { key: "commands", label: "Commands", color: "#1890ff" },
  { key: "agents", label: "Agents", color: "#722ed1" },
  { key: "hooks", label: "Hooks", color: "#fa8c16" },
  { key: "mcpServers", label: "MCP", color: "#13c2c2" },
  { key: "lspServers", label: "LSP", color: "#52c41a" },
];

export const hasComponent = (components, key) => {
  if (!components) return false;
  const arr = components[key];
  return Array.isArray(arr) && arr.length > 0;
};

export const hasAnyComponent = (components) => {
  if (!components) return false;
  return componentBadges.some(b => hasComponent(components, b.key));
};

export const getScopeLabel = (scope) => {
  const map = { user: "用户", project: "项目", local: "本地", managed: "托管" };
  return map[scope] || scope || "用户";
};

export const getScopeTheme = (scope) => {
  const map = {
    user: "primary",
    project: "success",
    local: "warning",
    managed: "default",
  };
  return map[scope] || "primary";
};

export const formatSource = (source) => {
  if (!source) return "";
  if (typeof source === "string") return source;
  if (source.repo && source.source) return `${source.source}:${source.repo}`;
  if (source.repo) return source.repo;
  return JSON.stringify(source);
};
