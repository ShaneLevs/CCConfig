// Agent 展示元数据（纯数据、无副作用）：切换器下拉、设置弹窗的启停列表、统计页 Agent 分组标题共用。
// 放在 composables 而非 useAgentVisibility.js 里：后者在模块加载时会初始化 DB 并注册 watch，
// 共享的展示组件（如热力图 tooltip）只需要名称/图标时不该被牵连。

// 图标位于 public/ 目录：必须用 BASE_URL 前缀拼接（base: './' 打包后为相对路径，
// 否则 uTools 以 file:// 加载时绝对路径会指向文件系统根目录导致图标丢失）
const ASSET_BASE = import.meta.env.BASE_URL;

// 默认顺序：已有使用统计的应用（Claude Code / Pi Agent / OpenCode / DSH / Grok Build / Command Code）排在前面，其余按原有顺序跟随。
// 用户拖拽排序后以 DB 记录里的 order 为准，仅在「仍是某个历史默认顺序」时升级。
export const AGENT_ORDER = ["claude", "pi", "opencode", "dsh", "grok", "cline", "commandcode", "omp", "reasonix", "codex", "kimi", "minimax", "qoder", "zcode", "hermes"];
// 历史默认顺序（自上而下逐版演进）：仅用于识别「用户仍停在某个历史默认顺序」的存量记录，
// 命中任一即升级为当前 AGENT_ORDER。用户自定义过的顺序不在其中，原样保留（新 agent 追加到末尾）。
export const LEGACY_AGENT_ORDERS = [
  // 第一版：DSH 在末尾
  ["claude", "opencode", "pi", "omp", "reasonix", "codex", "kimi", "minimax", "qoder", "zcode", "hermes", "dsh"],
  // 第二版：DSH 提前到使用统计组末尾
  ["claude", "pi", "opencode", "dsh", "omp", "reasonix", "codex", "kimi", "minimax", "qoder", "zcode", "hermes"],
  // 第三版：Grok Build 追加到使用统计组末尾（Cline / Command Code 加入前的最后一版）
  ["claude", "pi", "opencode", "dsh", "grok", "omp", "reasonix", "codex", "kimi", "minimax", "qoder", "zcode", "hermes"],
];
// 「通用配置」不是 agent，但会出现在切换器下拉里，展示元数据与 agent 放一起便于复用
// 名称是唯一需要翻译的展示字段：这里只放 key，解析交给调用方（保持本文件纯数据、无副作用）
export const COMMON_APP_META = { nameKey: "agents.common", icon: `${ASSET_BASE}gen.svg` };
export const AGENT_META = {
  claude: { name: "Claude Code", icon: `${ASSET_BASE}icon-claude.png` },
  opencode: { name: "OpenCode", icon: `${ASSET_BASE}icon-opencode.png` },
  pi: { name: "Pi Agent", icon: `${ASSET_BASE}icon-pi.png` },
  omp: { name: "omp", icon: `${ASSET_BASE}icon-omp.svg` },
  reasonix: { name: "Reasonix", icon: `${ASSET_BASE}icon-reasonix.png` },
  codex: { name: "Codex", icon: `${ASSET_BASE}icon-codex.png` },
  kimi: { name: "Kimi Code", icon: `${ASSET_BASE}icon-kimi.svg` },
  minimax: { name: "MiniMax Code", icon: `${ASSET_BASE}icon-minimax.svg` },
  qoder: { name: "Qoder", icon: `${ASSET_BASE}icon-qoder.png` },
  zcode: { name: "ZCode", icon: `${ASSET_BASE}icon-zcode.png` },
  hermes: { name: "Hermes", icon: `${ASSET_BASE}icon-hermes.png` },
  dsh: { name: "DSH", icon: `${ASSET_BASE}icon-dsh.png` },
  grok: { name: "Grok Build", icon: `${ASSET_BASE}icon-grok.svg` },
  cline: { name: "Cline", icon: `${ASSET_BASE}icon-cline.svg` },
  commandcode: { name: "Command Code", icon: `${ASSET_BASE}icon-commandcode.svg` },
};

// 落库统计里的 agent id → 展示名（未收录的 id 原样显示，避免新增 agent 时标题消失）
export const agentLabel = (id) => AGENT_META[id]?.name || id;

// 面向「所有 agent」的选项列表（如下发到 Agent 的目标勾选）：顺序跟随传入的 agentOrder，
// 与切换器下拉 / 左侧栏 / 设置里的排序保持一致；传入 visible（设置里的启停状态）时，
// 隐藏的 agent 不再出现（缺键按显示处理，与 useAgentVisibility 的默认一致）。未收录的 id 跳过。
export const agentOptionsInOrder = (order = AGENT_ORDER, visible = null) =>
  order
    .filter((id) => AGENT_META[id] && (!visible || visible[id] !== false))
    .map((id) => ({ value: id, label: AGENT_META[id].name }));
