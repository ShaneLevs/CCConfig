const crypto = require("./services/crypto");
const config = require("./services/config");
const mcp = require("./services/mcp");
const opencode = require("./services/opencode");
const plugins = require("./services/plugins");
const usage = require("./services/usage");
const skills = require("./services/skills");
const skillsInstall = require("./services/skills-install");
const claudeUsage = require("./services/claude-usage");
const pi = require("./services/pi");
const omp = require("./services/omp");
const reasonix = require("./services/reasonix");
const kimi = require("./services/kimi");
const minimax = require("./services/minimax");
const qoder = require("./services/qoder");
const zcode = require("./services/zcode");
const hermes = require("./services/hermes");
const dsh = require("./services/dsh");
const dshUsage = require("./services/dsh-usage");
const codex = require("./services/codex");
const common = require("./services/common");
const dispatch = require("./services/dispatch");
const commands = require("./services/commands");
const autoroute = require("./services/autoroute");

const {
  readClaudeSettings,
  writeClaudeSettings,
  getClaudeSettingsPath,
  readClaudeJson,
  writeClaudeJson,
  getClaudeJsonPath,
  getNativeId,
  getMcpServers,
  upsertMcpServer,
  deleteMcpServer,
  getClaudeMcpPath,
  openClaudeMcpFile,
  exportConfigsToFile,
  importConfigsFromFile,
  compressConfigs,
  decompressConfigs,
  saveOverriddenEnv,
  getOverriddenEnv,
  saveHeatmapHistory,
  getHeatmapHistory,
} = config;

const {
  getDisabledMcpServers,
  disableMcpServer,
  enableMcpServer,
  deleteDisabledMcpServer,
  getAllMcpServersWithStatus,
  getMcpServerTools,
} = mcp;

const { encrypt, decrypt, encryptString, decryptString } = crypto;

const {
  getOpencodeConfigPath,
  readOpencodeConfig,
  writeOpencodeConfig,
  getOpencodeProviders,
  setOpencodeProvider,
  setOpencodeProviders,
  removeOpencodeProvider,
  getOpencodeMcpServers,
  setOpencodeMcpServer,
  removeOpencodeMcpServer,
  getOpencodePlugins,
  setOpencodePlugins,
  addOpencodePlugin,
  removeOpencodePlugin,
  installOpencodePlugin,
  uninstallOpencodePlugin,
  getOpencodeSkills,
  getOpencodeSkillsPath,
  deleteOpencodeSkill,
} = opencode;

window.services = {
  getNativeId,
  getDisabledMcpServers,
  disableMcpServer,
  enableMcpServer,
  deleteDisabledMcpServer,
  getAllMcpServersWithStatus,
  readClaudeSettings,
  writeClaudeSettings,
  getClaudeSettingsPath,
  readClaudeJson,
  writeClaudeJson,
  getClaudeJsonPath,
  getMcpServers,
  upsertMcpServer,
  deleteMcpServer,
  getClaudeMcpPath,
  openClaudeMcpFile,
  getMcpServerTools,
  encryptKey: encrypt,
  decryptKey: decrypt,
  saveOverriddenEnv,
  getOverriddenEnv,
  saveHeatmapHistory,
  getHeatmapHistory,
  exportConfigsToFile,
  importConfigsFromFile,
  compressConfigs,
  decompressConfigs,
  encryptString,
  decryptString,

  // ==================== Skills（扫描 / 启停 / 路径） ====================
  ...skills,

  // ==================== Skills Install（SkillHub / ModelScope → Claude / OpenCode / 通用） ====================
  ...skillsInstall,

  // ==================== Claude Usage（JSONL 统计 / 热力图 / MCP 调用） ====================
  ...claudeUsage,

  // ==================== OpenCode ====================
  getOpencodeConfigPath,
  readOpencodeConfig,
  writeOpencodeConfig,
  getOpencodeProviders,
  setOpencodeProvider,
  setOpencodeProviders,
  removeOpencodeProvider,
  getOpencodeMcpServers,
  setOpencodeMcpServer,
  removeOpencodeMcpServer,
  getOpencodePlugins,
  setOpencodePlugins,
  addOpencodePlugin,
  removeOpencodePlugin,
  installOpencodePlugin,
  uninstallOpencodePlugin,
  searchOpencodePlugins: opencode.searchOpencodePlugins,
  readOpencodeUsage: opencode.readOpencodeUsage,
  getOpencodeSkills,
  getOpencodeSkillsPath,
  deleteOpencodeSkill,

  // ==================== Plugins ====================

  listMarketplaces: plugins.listMarketplaces,
  addMarketplace: plugins.addMarketplace,
  removeMarketplace: plugins.removeMarketplace,
  updateMarketplace: plugins.updateMarketplace,
  listMarketplacePlugins: plugins.listMarketplacePlugins,
  listInstalledPlugins: plugins.listInstalledPlugins,
  installPlugin: plugins.installPlugin,
  uninstallPlugin: plugins.uninstallPlugin,
  enablePlugin: plugins.enablePlugin,
  disablePlugin: plugins.disablePlugin,
  updatePlugin: plugins.updatePlugin,
  getPluginsDir: plugins.getPluginsDir,
  openPluginsDir: plugins.openPluginsDir,
  getInstalledPluginComponents: plugins.getInstalledPluginComponents,
  validatePluginName: plugins.validatePluginName,
  validateScope: plugins.validateScope,

  // ==================== Pi Agent ====================

  readPiSettings: pi.readPiSettings,
  writePiSettings: pi.writePiSettings,
  readPiModels: pi.readPiModels,
  writePiModels: pi.writePiModels,
  getPiProviderList: pi.getPiProviderList,
  setPiDefaultProvider: pi.setPiDefaultProvider,
  setPiDefaultModel: pi.setPiDefaultModel,
  updatePiProvider: pi.updatePiProvider,
  updatePiModel: pi.updatePiModel,
  addPiProvider: pi.addPiProvider,
  deletePiProvider: pi.deletePiProvider,
  addPiModel: pi.addPiModel,
  deletePiModel: pi.deletePiModel,
  getPiExtensions: pi.getPiExtensions,
  setPiExtensionEnabled: pi.setPiExtensionEnabled,
  getPiExtensionDetail: pi.getPiExtensionDetail,
  setPiPackageResourceEnabled: pi.setPiPackageResourceEnabled,
  installPiExtension: pi.installPiExtension,
  uninstallPiExtension: pi.uninstallPiExtension,
  updatePiExtensions: pi.updatePiExtensions,
  fetchPiDevPackages: pi.fetchPiDevPackages,
  fetchPiDevPackage: pi.fetchPiDevPackage,
  isPiInstalled: pi.isPiInstalled,
  getPiSkills: pi.getPiSkills,
  getPiMcpServers: pi.getPiMcpServers,
  fetchProviderModels: pi.fetchProviderModels,
  readPiUsage: pi.readPiUsage,
  // 「通用」统计页：打开时先采集各 agent 最新数据落库，再纯读 DB 合并展示
  collectCommonUsage() {
    const collected = {}
    try {
      const s = this.readClaudeUsage(true)
      collected.claude = (s?.contributions || []).some(d => (d.tokens || 0) > 0)
    } catch (e) { console.warn('[common usage] Claude 采集失败:', e); collected.claude = false }
    try {
      const s = opencode.readOpencodeUsage()
      collected.opencode = (s?.contributions || []).some(d => (d.tokens || 0) > 0)
    } catch (e) { console.warn('[common usage] OpenCode 采集失败:', e); collected.opencode = false }
    try {
      const s = pi.readPiUsage()
      collected.pi = (s?.contributions || []).some(d => (d.tokens || 0) > 0)
    } catch (e) { console.warn('[common usage] Pi 采集失败:', e); collected.pi = false }
    return collected
  },
  readCommonUsage: usage.readAllAgentUsage,
  openPiDir: pi.openPiDir,
  openPiExtDir: pi.openPiExtDir,
  resolvePiPath: pi.resolvePiPath,

  // ==================== omp ====================

  readOmpModelRoles: omp.readOmpModelRoles,
  writeOmpModelRoles: omp.writeOmpModelRoles,
  parseOmpModelRef: omp.parseOmpModelRef,
  getOmpModelRoleRefs: omp.getOmpModelRoleRefs,
  readOmpModels: omp.readOmpModels,
  writeOmpModels: omp.writeOmpModels,
  getOmpProviderList: omp.getOmpProviderList,
  addOmpProvider: omp.addOmpProvider,
  updateOmpProvider: omp.updateOmpProvider,
  deleteOmpProvider: omp.deleteOmpProvider,
  addOmpModel: omp.addOmpModel,
  updateOmpModel: omp.updateOmpModel,
  deleteOmpModel: omp.deleteOmpModel,
  openOmpDir: omp.openOmpDir,
  isOmpInstalled: omp.isOmpInstalled,

  // ==================== Codex（Desktop / CLI 模型配置） ====================

  getCodexDir: codex.getCodexDir,
  getCodexConfigPath: codex.getCodexConfigPath,
  getCodexModelsJsonPath: codex.getCodexModelsJsonPath,
  getCodexProviderList: codex.getCodexProviderList,
  addCodexProvider: codex.addCodexProvider,
  updateCodexProvider: codex.updateCodexProvider,
  deleteCodexProvider: codex.deleteCodexProvider,
  getCodexCurrent: codex.getCodexCurrent,
  setCodexDefaultModel: codex.setCodexDefaultModel,
  setCodexReasoningEffort: codex.setCodexReasoningEffort,
  setCodexApiAuth: codex.setCodexApiAuth,
  getCodexProviderModelsMap: codex.getCodexProviderModelsMap,
  addCodexModel: codex.addCodexModel,
  deleteCodexModel: codex.deleteCodexModel,
  syncCodexModelCatalog: codex.syncCodexModelCatalog,
  openCodexDir: codex.openCodexDir,
  isCodexInstalled: codex.isCodexInstalled,

  // ==================== 通用配置（主数据库） ====================

  readCommonProviders: common.readCommonProviders,
  writeCommonProviders: common.writeCommonProviders,
  getCommonProviderList: common.getCommonProviderList,
  addCommonProvider: common.addCommonProvider,
  updateCommonProvider: common.updateCommonProvider,
  deleteCommonProvider: common.deleteCommonProvider,
  addCommonModel: common.addCommonModel,
  addCommonModels: common.addCommonModels,
  updateCommonModel: common.updateCommonModel,
  deleteCommonModel: common.deleteCommonModel,
  // 通用 MCP：云端主档 + 本机启用开关（开启写入本地镜像文件，关闭从本地移除）
  listCommonMcpServers: common.listCommonMcpServers,
  upsertCommonMcpServer: common.upsertCommonMcpServer,
  deleteCommonMcpServer: common.deleteCommonMcpServer,
  setCommonMcpEnabled: common.setCommonMcpEnabled,
  // 本地镜像存放位置（预置多选 + 自定义，按机器隔离）
  getLocalMcpTargetPaths: common.getLocalMcpTargetPaths,
  getLocalMcpTargetsInfo: common.getLocalMcpTargetsInfo,
  saveLocalMcpTargets: common.saveLocalMcpTargets,
  syncLocalMcpTargets: common.syncLocalMcpTargets,
  selectLocalMcpTargetFile: common.selectLocalMcpTargetFile,
  resolveMcpPath: common.resolveMcpPath,
  toDisplayMcpPath: common.toDisplayMcpPath,
  readCommonSkills: common.readCommonSkills,
  openCommonSkillsDir: common.openCommonSkillsDir,
  getCommonSkillsPath: common.getCommonSkillsPath,
  setCommonSkillEnabled: common.setCommonSkillEnabled,
  deleteCommonSkill: common.deleteCommonSkill,
  // 通用库 provider + model → 各 Agent 模型配置下发
  dispatchCommonModel: dispatch.dispatchCommonModel,
  // 自动网关：本地模型代理（配置 / 启停 / 状态 / 下发）
  readAutoRouteConfig: autoroute.readAutoRouteConfig,
  writeAutoRouteConfig: autoroute.writeAutoRouteConfig,
  regenerateAutoRouteKey: autoroute.regenerateAutoRouteKey,
  resolveAutoRouteModels: autoroute.resolveAutoRouteModels,
  startAutoRoute: autoroute.startAutoRoute,
  stopAutoRoute: autoroute.stopAutoRoute,
  setAutoRouteEnabled: autoroute.setAutoRouteEnabled,
  getAutoRouteStatus: autoroute.getAutoRouteStatus,
  dispatchAutoRoute: dispatch.dispatchAutoRoute,

  // ==================== 智能体启停 ↔ uTools 指令同步 ====================
  // 按启停状态增删各 agent 的启动命令（功能指令 + 匹配指令），详见 services/commands.js
  syncAgentCommands: commands.syncAgentCommands,

  getReasonixConfigPath: reasonix.getReasonixConfigPath,
  readReasonixConfig: reasonix.readReasonixConfig,
  writeReasonixConfig: reasonix.writeReasonixConfig,
  getReasonixProviderList: reasonix.getReasonixProviderList,
  addReasonixProvider: reasonix.addReasonixProvider,
  updateReasonixProvider: reasonix.updateReasonixProvider,
  deleteReasonixProvider: reasonix.deleteReasonixProvider,
  addReasonixModel: reasonix.addReasonixModel,
  deleteReasonixModel: reasonix.deleteReasonixModel,
  getReasonixDefaultModel: reasonix.getReasonixDefaultModel,
  setReasonixDefaultModel: reasonix.setReasonixDefaultModel,
  readReasonixEnv: reasonix.readReasonixEnv,
  getReasonixApiKey: reasonix.getReasonixApiKey,
  writeReasonixEnvKey: reasonix.writeReasonixEnvKey,
  deleteReasonixEnvKey: reasonix.deleteReasonixEnvKey,
  generateReasonixApiKeyEnv: reasonix.generateReasonixApiKeyEnv,
  openReasonixDir: reasonix.openReasonixDir,
  isReasonixInstalled: reasonix.isReasonixInstalled,
  // ==================== Kimi Code（~/.kimi-code/config.toml，仅模型配置） ====================
  getKimiConfigPath: kimi.getKimiConfigPath,
  readKimiConfig: kimi.readKimiConfig,
  writeKimiConfig: kimi.writeKimiConfig,
  getKimiProviderList: kimi.getKimiProviderList,
  addKimiProvider: kimi.addKimiProvider,
  updateKimiProvider: kimi.updateKimiProvider,
  deleteKimiProvider: kimi.deleteKimiProvider,
  getKimiModelList: kimi.getKimiModelList,
  addKimiModel: kimi.addKimiModel,
  updateKimiModel: kimi.updateKimiModel,
  deleteKimiModel: kimi.deleteKimiModel,
  getKimiDefaultModel: kimi.getKimiDefaultModel,
  setKimiDefaultModel: kimi.setKimiDefaultModel,

  // ==================== MiniMax Code（~/.minimax/config.yaml，仅模型配置） ====================
  getMinimaxConfigPath: minimax.getMinimaxConfigPath,
  getMinimaxProviderList: minimax.getMinimaxProviderList,
  addMinimaxProvider: minimax.addMinimaxProvider,
  updateMinimaxProvider: minimax.updateMinimaxProvider,
  deleteMinimaxProvider: minimax.deleteMinimaxProvider,
  addMinimaxModel: minimax.addMinimaxModel,
  updateMinimaxModel: minimax.updateMinimaxModel,
  deleteMinimaxModel: minimax.deleteMinimaxModel,
  getMinimaxDefaultModel: minimax.getMinimaxDefaultModel,
  setMinimaxDefaultModel: minimax.setMinimaxDefaultModel,
  isMinimaxDefaultModel: minimax.isMinimaxDefaultModel,
  openMinimaxDir: minimax.openMinimaxDir,
  isMinimaxInstalled: minimax.isMinimaxInstalled,
  openKimiDir: kimi.openKimiDir,
  isKimiInstalled: kimi.isKimiInstalled,

  // ==================== Qoder（~/.qoder 与 ~/.qoder-cn 的 settings.json，仅模型配置） ====================
  getQoderProviderList: qoder.getQoderProviderList,
  addQoderProvider: qoder.addQoderProvider,
  updateQoderProvider: qoder.updateQoderProvider,
  deleteQoderProvider: qoder.deleteQoderProvider,
  addQoderModel: qoder.addQoderModel,
  updateQoderModel: qoder.updateQoderModel,
  deleteQoderModel: qoder.deleteQoderModel,
  getQoderDefaultModel: qoder.getQoderDefaultModel,
  setQoderDefaultModel: qoder.setQoderDefaultModel,
  openQoderDir: qoder.openQoderDir,
  isQoderInstalled: qoder.isQoderInstalled,
  QODER_PROTOCOLS: qoder.PROTOCOL_VALUES,
  QODER_EFFORTS: qoder.EFFORT_VALUES,

  // ==================== ZCode（~/.zcode/v2/provider_config.json，仅自定义模型） ====================
  getZcodeProviderList: zcode.getZcodeProviderList,
  addZcodeProvider: zcode.addZcodeProvider,
  updateZcodeProvider: zcode.updateZcodeProvider,
  deleteZcodeProvider: zcode.deleteZcodeProvider,
  addZcodeModel: zcode.addZcodeModel,
  updateZcodeModel: zcode.updateZcodeModel,
  deleteZcodeModel: zcode.deleteZcodeModel,
  getZcodeDefaultModel: zcode.getZcodeDefaultModel,
  setZcodeDefaultModel: zcode.setZcodeDefaultModel,
  openZcodeDir: zcode.openZcodeDir,
  openZcodeConfigFile: zcode.openZcodeConfigFile,
  isZcodeInstalled: zcode.isZcodeInstalled,
  ZCODE_API_TYPES: zcode.ZCODE_API_TYPES,
  ZCODE_ACCESS_TYPES: zcode.ZCODE_ACCESS_TYPES,

  // ==================== Hermes（~/.hermes/config.yaml，仅模型配置） ====================
  getHermesConfigPath: hermes.getHermesConfigPath,
  getHermesProviderList: hermes.getHermesProviderList,
  addHermesProvider: hermes.addHermesProvider,
  updateHermesProvider: hermes.updateHermesProvider,
  deleteHermesProvider: hermes.removeHermesProvider,
  getHermesDefaultModel: hermes.getHermesDefaultModel,
  setHermesDefaultModel: hermes.setHermesDefaultModel,
  openHermesDir: hermes.openHermesDir,
  openHermesConfigFile: hermes.openHermesConfigFile,
  isHermesInstalled: hermes.isHermesInstalled,
  HERMES_API_MODES: hermes.HERMES_API_MODES,

  // ==================== DSH（DeepSeek Harness：~/.dsh/profiles/<profile>/cordis.patch.yml，仅模型配置） ====================
  getDshProfileName: dsh.getDshProfileName,
  getDshPatchPath: dsh.getDshPatchPath,
  getDshCredentialsPath: dsh.getDshCredentialsPath,
  getDshConfig: dsh.getDshConfig,
  getDshOfficial: dsh.getDshOfficial,
  saveDshOfficial: dsh.saveDshOfficial,
  removeDshOfficial: dsh.removeDshOfficial,
  getDshProviderList: dsh.getDshProviderList,
  addDshProvider: dsh.addDshProvider,
  updateDshProvider: dsh.updateDshProvider,
  deleteDshProvider: dsh.deleteDshProvider,
  getDshDefaultModel: dsh.getDshDefaultModel,
  setDshDefaultModel: dsh.setDshDefaultModel,
  getDshCredential: dsh.getDshCredential,
  openDshDir: dsh.openDshDir,
  openDshConfigFile: dsh.openDshConfigFile,
  openDshCredentialsFile: dsh.openDshCredentialsFile,
  isDshInstalled: dsh.isDshInstalled,
  DSH_PROTOCOLS: dsh.DSH_PROTOCOLS,
  DSH_THINKING_FORMATS: dsh.DSH_THINKING_FORMATS,
  DSH_EFFORTS: dsh.DSH_EFFORTS,
  DSH_PI_EFFORTS: dsh.DSH_PI_EFFORTS,
  DSH_DEFAULT_MODELS: dsh.DSH_DEFAULT_MODELS,
  DSH_OFFICIAL_ROUTE: dsh.OFFICIAL_ROUTE,
  DSH_OFFICIAL_BASE_URL: dsh.OFFICIAL_DEFAULT_BASE_URL,

  // DSH 使用统计（解析 ~/.dsh/sessions 下的 zstd JSONL 会话日志）
  readDshUsage: dshUsage.readDshUsage,
  getDshSessionsRoot: dshUsage.getDshSessionsRoot,

  // 扩展字段枚举与键表（渲染层下拉选项/表单遍历用）
  KIMI_CAPABILITIES: kimi.KIMI_CAPABILITIES,
  KIMI_EFFORTS: kimi.KIMI_EFFORTS,
  MODEL_EXTRA_KEYS: kimi.MODEL_EXTRA_KEYS,
  // 检测各 agent 是否已有配置数据（本地文件 + DB，无网络，全部 try/catch）
  detectAgentsConfig() {
    const hasData = {
      claude: false,
      opencode: false,
      pi: false,
      omp: false,
      reasonix: false,
      codex: false,
      kimi: false,
      qoder: false,
      zcode: false,
      hermes: false,
      dsh: false,
    };
    // claude：settings.json 有 managed env 字段，或 DB 有已存配置
    try {
      const settings = readClaudeSettings();
      if (settings && settings.env) {
        hasData.claude = Object.keys(settings.env).some(
          (k) => k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_"),
        );
      }
      if (!hasData.claude) {
        hasData.claude = window.utools.db
          .allDocs()
          .some((d) => d._id.startsWith("ccswitch_config_"));
      }
    } catch (e) {
      /* ignore */
    }
    // opencode：provider / plugin / mcp 任一有内容
    try {
      const oc = readOpencodeConfig();
      hasData.opencode = !!(
        oc &&
        (Object.keys(oc.provider || {}).length > 0 ||
          (oc.plugin || []).length > 0 ||
          Object.keys(oc.mcp || {}).length > 0)
      );
    } catch (e) {
      /* ignore */
    }
    // pi：models.json 有供应商
    try {
      const models = pi.readPiModels();
      hasData.pi = !!(models && Object.keys(models.providers || {}).length > 0);
    } catch (e) {
      /* ignore */
    }
    // omp：modelRoles 或 models.yml 有内容
    try {
      const roles = omp.readOmpModelRoles();
      const models = omp.readOmpModels();
      hasData.omp = !!(
        Object.keys(roles || {}).length > 0 ||
        Object.keys((models && models.providers) || {}).length > 0
      );
    } catch (e) {
      /* ignore */
    }
    // reasonix：config.toml 有 providers
    try {
      const cfg = reasonix.readReasonixConfig();
      hasData.reasonix = !!((cfg && cfg.providers) || []).length;
    } catch (e) {
      /* ignore */
    }
    // codex：config.toml 有 model_providers 或顶层 model/model_provider
    try {
      const cfg = codex.readCodexConfig();
      hasData.codex = !!(
        (cfg && cfg.model_providers && Object.keys(cfg.model_providers).length > 0) ||
        (cfg && (cfg.model || cfg.model_provider))
      );
    } catch (e) {
      /* ignore */
    }
    // kimi：config.toml 有 providers 或 models
    try {
      const cfg = kimi.readKimiConfig();
      hasData.kimi = !!(
        cfg &&
        (Object.keys(cfg.providers || {}).length > 0 ||
          Object.keys(cfg.models || {}).length > 0)
      );
    } catch (e) {
      /* ignore */
    }
    // qoder：任一 settings.json 有自定义 providers
    try {
      hasData.qoder = qoder.hasQoderProviders();
    } catch (e) {
      /* ignore */
    }
    // zcode：provider_config.json 有自定义供应商
    try {
      hasData.zcode = zcode.hasZcodeProviders();
    } catch (e) {
      /* ignore */
    }
    // hermes：config.yaml 有自定义供应商（含 Hermes 托管 providers 节）
    try {
      hasData.hermes = hermes.hasHermesProviders();
    } catch (e) {
      /* ignore */
    }
    // dsh：cordis.patch.yml 有受管模型路由条目（官方 / 第三方 / 默认模型）
    try {
      hasData.dsh = dsh.hasDshConfig();
    } catch (e) {
      /* ignore */
    }
    return hasData;
  },
};

// ==================== 智能体启停指令同步：生命周期自愈 ====================
// 注意：uTools API 没有 onPluginReady 回调（误用会抛 TypeError 并中断后续注册，
// 导致同步链路整体失效）。preload 顶层代码在插件每次装载（启动）时执行，
// 等价于启动时机，直接重放同步；onPluginEnter 再覆盖每次进入。两者均幂等，
// 覆盖 uTools 重启 / 插件更新 / 开发者工具重新导入后静态指令（plugin.json
// features）回归的场景：停用的 agent 命令在插件装载/进入后即被移除。
const syncLifecycle = () => {
  try { commands.initFromDb(); } catch (e) { console.error("[commands] 启停指令同步失败", e); }
  try { autoroute.startAutoRouteIfEnabled(); } catch (e) { console.error("[autoroute] 网关自启失败", e); }
};
syncLifecycle();
window.utools.onPluginEnter(() => {
  syncLifecycle();
});
