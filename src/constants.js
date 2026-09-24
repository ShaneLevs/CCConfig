export const managedFields = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

// 模型「上下文窗口 / 最大输出」预设档位，各应用配置页共用。
// value 0 = 默认（不写入该字段，回退 CLI 自带默认）；数值统一按十进制 K 计。
export const CTX_OPTIONS = [
  { label: "默认", value: 0 },
  { label: "200K", value: 200000 },
  { label: "400K", value: 400000 },
  { label: "600K", value: 600000 },
  { label: "1M", value: 1000000 },
];
export const TOKENS_OPTIONS = [
  { label: "默认", value: 0 },
  { label: "64K", value: 64000 },
  { label: "128K", value: 128000 },
  { label: "256K", value: 256000 },
  { label: "384K", value: 384000 },
];

// PresetCustomInput 的 kind → 预设配置（选项 / 步进 / 切到自定义时的初始值）
export const MODEL_LIMIT_PRESETS = {
  context: { options: CTX_OPTIONS, step: 1000, defaultCustom: 200000 },
  output: { options: TOKENS_OPTIONS, step: 1000, defaultCustom: 64000 },
};

export const envPresets = [
  { key: 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', label: 'Teammates 模式', type: 'boolean', trueValue: '1' },
  { key: 'ENABLE_TOOL_SEARCH', label: '启用工具搜索', type: 'boolean', trueValue: 'true' },
  {
    key: 'CLAUDE_CODE_EFFORT_LEVEL', label: '思考强度', type: 'select',
    options: [
      { label: 'default', value: '' },
      { label: 'low', value: 'low' },
      { label: 'medium', value: 'medium' },
      { label: 'high', value: 'high' },
      { label: 'xhigh', value: 'xhigh' },
      { label: 'max', value: 'max' },
    ],
  },
  { key: 'CLAUDE_CODE_NO_FLICKER', label: '关闭终端闪烁', type: 'boolean', trueValue: '1' },
];
