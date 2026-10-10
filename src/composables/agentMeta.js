// Agent 展示元数据（纯数据、无副作用）：切换器下拉、设置弹窗的启停列表、统计页 Agent 分组标题共用。
// 放在 composables 而非 useAgentVisibility.js 里：后者在模块加载时会初始化 DB 并注册 watch，
// 共享的展示组件（如热力图 tooltip）只需要名称/图标时不该被牵连。

// 图标位于 public/ 目录：必须用 BASE_URL 前缀拼接（base: './' 打包后为相对路径，
// 否则 uTools 以 file:// 加载时绝对路径会指向文件系统根目录导致图标丢失）
const ASSET_BASE = import.meta.env.BASE_URL;

// 默认顺序：已有使用统计的四个应用（Claude Code / Pi Agent / OpenCode / DSH）排在前面，其余按原有顺序跟随。
// 用户拖拽排序后以 DB 记录里的 order 为准，仅在「仍是旧默认顺序」时升级。
export const AGENT_ORDER = ["claude", "pi", "opencode", "dsh", "omp", "reasonix", "codex", "kimi", "minimax", "qoder", "zcode", "hermes"];
// 旧默认顺序：仅用于识别「用户从未拖拽过」的存量记录（用户自定义顺序不覆盖）
export const LEGACY_AGENT_ORDER = ["claude", "opencode", "pi", "omp", "reasonix", "codex", "kimi", "minimax", "qoder", "zcode", "hermes", "dsh"];
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
  dsh: { name: "DSH", icon: `${ASSET_BASE}icon-dsh.png` },
};

// 落库统计里的 agent id → 展示名（未收录的 id 原样显示，避免新增 agent 时标题消失）
export const agentLabel = (id) => AGENT_META[id]?.name || id;
