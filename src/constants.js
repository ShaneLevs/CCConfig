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
