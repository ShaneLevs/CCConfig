// 智能体启停 ↔ uTools 动态指令同步
//
// 指令模型：plugin.json 静态声明会在 uTools 重启 / 插件更新 / 开发者工具重新导入后
// 全部回归注册表，停用 agent 的指令无法清除。因此 agent 指令**不做静态声明**
//（plugin.json 仅保留「通用配置」入口），全部在本模块内置规范定义（FEATURE_DEFINITIONS，
// 与原静态声明逐字段一致），由同步逻辑按启停状态动态注册（utools.setFeature）：
//   默认（未打开过插件）搜索框里没有 agent 指令；首次打开插件后按用户启停状态生成。
//
// 背景：uTools 提供动态指令 API：
//   utools.setFeature(feature) —— 设置/覆盖一个功能
//   utools.removeFeature(code) —— 从指令注册表移除一个功能（静态/动态统一注册表）
//   utools.getFeatures(codes?) —— 读取当前动态功能
//
// 本模块是「启停状态」与「uTools 指令注册表」之间的唯一同步点，幂等：
//   - 插件装载（preload 顶层执行，uTools 无 onPluginReady 回调）与每次进入（onPluginEnter）时
//     从 uTools DB 读取启停状态重放同步；
//   - 设置界面勾选变化时由渲染进程调用 syncAgentCommands 即时同步。
// 「通用配置」（commonConfig / installCommonSkill）为静态声明，永不参与启停。
const FEATURE_DEFINITIONS = {
  claudeConfig: {
    code: "claudeConfig",
    explain: "Claude Code 配置管理工具",
    icon: "claudecode.png",
    cmds: ["Claude Code配置"],
  },
  installClaudeSkill: {
    code: "installClaudeSkill",
    explain: "从 SkillHub/魔搭社区 安装 Claude Code Skill",
    icon: "claudecode.png",
    cmds: [
      {
        type: "regex",
        label: "安装 Claude Code Skill",
        match: "/^https:\\/\\/(www\\.)?(skillhub\\.(tencent\\.com|cn)\\/skills\\/[\\w-]+(\\/[\\w-]+)?|modelscope\\.cn\\/skills\\/@[\\w-]+\\/[\\w-]+)$/",
        minLength: 30,
        maxLength: 200,
      },
    ],
  },
  opencodeConfig: {
    code: "opencodeConfig",
    explain: "OpenCode 配置管理工具",
    icon: "icon-opencode.png",
    cmds: ["OpenCode配置"],
  },
  installOpencodeSkill: {
    code: "installOpencodeSkill",
    explain: "从 SkillHub/魔搭社区 安装 OpenCode Skill",
    icon: "icon-opencode.png",
    cmds: [
      {
        type: "regex",
        label: "安装 OpenCode Skill",
        match: "/^https:\\/\\/(www\\.)?(skillhub\\.(tencent\\.com|cn)\\/skills\\/[\\w-]+(\\/[\\w-]+)?|modelscope\\.cn\\/skills\\/@[\\w-]+\\/[\\w-]+)$/",
        minLength: 30,
        maxLength: 200,
      },
    ],
  },
  piConfig: {
    code: "piConfig",
    explain: "Pi Agent 配置管理工具",
    icon: "icon-pi.png",
    cmds: ["Pi Agents配置"],
  },
  installPiExtension: {
    code: "installPiExtension",
    explain: "安装 Pi Agent 扩展",
    icon: "icon-pi.png",
    cmds: [
      {
        type: "regex",
        label: "安装 Pi Agent 扩展",
        match: "/^pi\\s+install\\s+.+/",
        minLength: 12,
        maxLength: 200,
      },
    ],
  },
  ompConfig: {
    code: "ompConfig",
    explain: "omp CLI 配置管理工具",
    icon: "omp-icon.svg",
    cmds: ["omp配置"],
  },
  reasonixConfig: {
    code: "reasonixConfig",
    explain: "Reasonix 配置管理工具",
    icon: "reasonix.svg",
    cmds: ["Reasonix配置"],
  },
  codexConfig: {
    code: "codexConfig",
    explain: "Codex 模型配置管理工具（Desktop / CLI）",
    icon: "icon-codex.png",
    cmds: ["Codex配置"],
  },
  kimiConfig: {
    code: "kimiConfig",
    explain: "Kimi Code CLI 模型配置管理工具",
    icon: "kimi.svg",
    cmds: ["Kimi配置"],
  },
};

// 各智能体 → 其启动命令对应的 feature code（同时覆盖「功能指令」与「匹配指令」）。
// 新增智能体时需同步补充此表与 FEATURE_DEFINITIONS；common（通用配置）不在此表，永不启停。
const AGENT_FEATURES = {
  claude: ["claudeConfig", "installClaudeSkill"],
  opencode: ["opencodeConfig", "installOpencodeSkill"],
  pi: ["piConfig", "installPiExtension"],
  omp: ["ompConfig"],
  reasonix: ["reasonixConfig"],
  codex: ["codexConfig"],
  kimi: ["kimiConfig"],
};

// 启停状态按设备区分同步（_<nativeId> 后缀，同 heatmap/mcp_disabled 先例）：
// 各机器性能/安装的 agent 不同，启停只对单机有意义；但数据层仍全量同步到其他机器供参考。
// 旧版共享文档 ccswitch_visible_agents 作为回退只读（首次在新设备上是拷）。
const VISIBLE_AGENTS_DB_BASE = "ccswitch_visible_agents";

function getNativeId() {
  try {
    return window.utools.getNativeId() || "";
  } catch (e) {
    return "";
  }
}

function visibleAgentsDocId() {
  const id = getNativeId();
  return id ? `${VISIBLE_AGENTS_DB_BASE}_${id}` : VISIBLE_AGENTS_DB_BASE;
}

// 归一化启停状态：缺键默认启用（兼容未来新增 agent / 首次运行无记录）
function normalizeVisible(visible) {
  const result = {};
  Object.keys(AGENT_FEATURES).forEach((app) => {
    result[app] = visible ? visible[app] !== false : true;
  });
  return result;
}

// 按启停状态同步 uTools 指令注册表（幂等）：
//   启用 → setFeature(内置规范定义)，保证命令存在且为最新定义
//   停用 → removeFeature(code)，从搜索框移除（固定命令 + 匹配命令一并移除）
function syncAgentCommands(visible) {
  const state = normalizeVisible(visible);
  const registered = [];
  const removed = [];
  const failed = [];
  Object.entries(AGENT_FEATURES).forEach(([app, codes]) => {
    const enabled = !!state[app];
    (codes || []).forEach((code) => {
      try {
        if (enabled) {
          const feature = FEATURE_DEFINITIONS[code];
          if (!feature) {
            console.warn(`[commands] 缺少指令规范定义: ${code}`);
            return;
          }
          window.utools.setFeature(feature);
          registered.push(code);
        } else {
          window.utools.removeFeature(code);
          removed.push(code);
        }
      } catch (e) {
        failed.push({ code, error: String((e && e.message) || e) });
        console.error(`[commands] 同步指令失败: ${code}`, e);
      }
    });
  });
  return { ok: failed.length === 0, removed, registered, failed };
}

// 从 uTools DB 读取本机启停状态并同步（preload 装载 / onPluginEnter 自愈调用）
function initFromDb() {
  try {
    let visible = null;
    try {
      const docId = visibleAgentsDocId();
      let doc = null;
      try { doc = window.utools.db.get(docId); } catch (e) { /* ignore */ }
      // 本机尚无记录：回退读旧版共享文档（旧文档可能仍含其他机器的状态，仅作种子）
      if (!doc && docId !== VISIBLE_AGENTS_DB_BASE) {
        try { doc = window.utools.db.get(VISIBLE_AGENTS_DB_BASE); } catch (e) { /* ignore */ }
      }
      visible = doc && doc.visible ? doc.visible : null;
    } catch (e) {
      /* ignore */
    }
    return syncAgentCommands(visible);
  } catch (e) {
    console.error("[commands] initFromDb 失败:", e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { syncAgentCommands, initFromDb };
