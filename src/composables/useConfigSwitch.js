import { MessagePlugin } from "tdesign-vue-next";
import { managedFields } from "../constants";

export function useConfigSwitch(currentConfig, loadCurrentConfig) {
  const switchConfig = (config) => {
    const settings = window.services.readClaudeSettings() || {};
    if (!settings.env) settings.env = {};

    // 1. 从 DB 读全局基准；首次没有则用当前 settings.json 兜底并存 DB
    let baseExtras = window.services.getOverriddenEnv();
    if (!baseExtras) {
      baseExtras = {};
      Object.keys(settings.env).forEach(key => {
        if (!managedFields.includes(key)) baseExtras[key] = settings.env[key];
      });
      window.services.saveOverriddenEnv(baseExtras);
    }

    // 2. 设置核心字段：按认证方式写对应变量，两者互斥（只保留一个）
    const authVar = config.authVar || 'ANTHROPIC_AUTH_TOKEN';
    ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].forEach(v => {
      if (v !== authVar) delete settings.env[v];
    });
    settings.env[authVar] = config.key;
    settings.env.ANTHROPIC_BASE_URL = config.baseUrl;

    const modelFields = [
      { key: 'model', env: 'ANTHROPIC_MODEL' },
      { key: 'defaultHaikuModel', env: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
      { key: 'defaultSonnetModel', env: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
      { key: 'defaultOpusModel', env: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
      { key: 'defaultFableModel', env: 'ANTHROPIC_DEFAULT_FABLE_MODEL' },
      { key: 'subagentModel', env: 'CLAUDE_CODE_SUBAGENT_MODEL' },
    ];

    modelFields.forEach(({ key, env }) => {
      if (config[key]?.trim()) {
        settings.env[env] = config[key].trim();
      } else {
        delete settings.env[env];
      }
    });

    // 3. 清除所有非托管字段
    Object.keys(settings.env).forEach(key => {
      if (!managedFields.includes(key)) delete settings.env[key];
    });

    // 4. 合并：全局字段 + 配置字段（配置优先）
    const mergedExtras = { ...baseExtras };
    const configExtras = config.extraFields || [];
    configExtras.forEach(field => {
      const k = field.key?.trim();
      const v = field.value?.trim();
      if (k) mergedExtras[k] = v;
    });

    // 5. 写入合并后的字段（托管字段除外，避免 DB 残留的 auth 变量覆盖互斥逻辑）
    Object.entries(mergedExtras).forEach(([k, v]) => {
      if (managedFields.includes(k)) return;
      settings.env[k] = v;
    });

    if (window.services.writeClaudeSettings(settings)) {
      // 保存当前启用的配置 ID，供全局弹窗读取
      if (config.id) {
        const activeDoc = { _id: 'ccswitch_active_config_id', configId: config.id };
        const existing = window.utools.db.get('ccswitch_active_config_id');
        if (existing) activeDoc._rev = existing._rev;
        window.utools.db.put(activeDoc);
      }
      MessagePlugin.success("配置已切换");
      loadCurrentConfig();
    } else {
      MessagePlugin.error("切换失败");
    }
  };

  const isCurrentConfig = (config) =>
    config.key === currentConfig.value.key &&
    (config.authVar || 'ANTHROPIC_AUTH_TOKEN') === (currentConfig.value.authVar || 'ANTHROPIC_AUTH_TOKEN') &&
    config.baseUrl === currentConfig.value.baseUrl &&
    (config.model || "") === (currentConfig.value.model || "") &&
    (config.defaultHaikuModel || "") === (currentConfig.value.defaultHaikuModel || "") &&
    (config.defaultSonnetModel || "") === (currentConfig.value.defaultSonnetModel || "") &&
    (config.defaultOpusModel || "") === (currentConfig.value.defaultOpusModel || "") &&
    (config.defaultFableModel || "") === (currentConfig.value.defaultFableModel || "") &&
    (config.subagentModel || "") === (currentConfig.value.subagentModel || "");

  return { switchConfig, isCurrentConfig };
}
