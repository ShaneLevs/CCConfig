// dispatch.js 网关下发（覆盖式重建 router 供应商）冒烟测试：node tests/smoke-autoroute-dispatch-test.cjs
// 验证：
//   1. 每次网关下发都把 router 供应商整条重建（旧模型消失，不会累积成混合清单）
//   2. 生效状态继承：router 原本是当前默认/生效供应商 → 重建后继续生效，并沿用原默认模型
//   3. 停用开关继承：MiniMax 的 enabled / Command Code 的 disabled / Cline 的 enabled 保持原样
//   4. 普通「通用模型下发」（dispatchCommonModel）仍是合并语义，不受影响
// 放 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-dispatch-'))
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.CCCONFIG_LOCALE = 'zh-CN'
// 统计/技能等无关域不参与本次测试，清掉外部覆盖变量避免读到真实目录
for (const key of ['CLINE_DIR', 'CLINE_DATA_DIR', 'DSH_HOME', 'KIMI_HOME', 'MINIMAX_HOME', 'CODEX_HOME', 'ZCODE_HOME', 'GROK_HOME', 'HERMES_HOME', 'PI_HOME', 'OMP_HOME']) {
  delete process.env[key]
}

// 最小 uTools stub：DB（配置/主数据）+ 家目录
const dbDocs = new Map()
global.window = global.window || {}
window.utools = {
  getPath: () => tmp,
  getNativeId: () => 'test-native',
  shellOpenPath: () => {},
  shellOpenExternal: () => {},
  copyText: () => {},
  db: {
    get: (id) => dbDocs.get(id) || null,
    put: (doc) => {
      if (!doc || !doc._id) return { ok: false, message: 'id required' }
      const prev = dbDocs.get(doc._id)
      if (prev && doc._rev && prev._rev !== doc._rev) return { ok: false, message: 'conflict' }
      dbDocs.set(doc._id, { ...doc, _rev: (prev && prev._rev) || '1' })
      return { ok: true, id: doc._id, rev: '1' }
    },
    remove: (id) => { dbDocs.delete(id); return { ok: true } },
    allDocs: () => Array.from(dbDocs.values()),
  },
}

const crypto = require('../public/preload/services/crypto')
const pi = require('../public/preload/services/pi')
const opencode = require('../public/preload/services/opencode')
const codex = require('../public/preload/services/codex')
const kimi = require('../public/preload/services/kimi')
const minimax = require('../public/preload/services/minimax')
const zcode = require('../public/preload/services/zcode')
const cline = require('../public/preload/services/cline')
const commandCode = require('../public/preload/services/command-code')
const dispatch = require('../public/preload/services/dispatch')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)

// ==================== 网关配置与主数据 ====================
// 通用库：一个供应商 + 两个模型；网关 direct 模式勾选这两个模型
const makeProvider = (models, extra = {}) => ({
  name: 'gw-upstream',
  api: 'openai-completions',
  baseUrl: 'https://upstream.example.com/v1',
  apiKey: crypto.encrypt('sk-upstream'),
  headers: {},
  models: models.map((id) => ({ id, name: id, contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ['text'] })),
  ...extra,
})

const writeCommonProviders = (providers) => {
  window.utools.db.put({ _id: 'ccconfig_common_providers', data: { providers } })
}

const setGatewayModels = (modelIds, api = 'openai-completions') => {
  writeCommonProviders([makeProvider(modelIds, { api })])
  window.utools.db.put({
    _id: 'ccconfig_autoroute_config_test-native',
    data: {
      enabled: true,
      port: 17877,
      key: 'sk-ccr-testkey',
      mode: 'direct',
      selection: modelIds.map((id) => ({ provider: 'gw-upstream', modelId: id })),
      mappings: [],
      mappingSeeded: true,
    },
  })
}

const dispatchTo = (apps) => {
  const results = dispatch.dispatchAutoRoute(apps.map((app) => ({ app })))
  return results
}

// ==================== 0. 首次下发（没有旧 router 条目） ====================
console.log('0. 首次下发（无旧条目）')
// 模拟各 agent 已安装（目录存在但无配置文件）；pi 等写入前不会自己 mkdir
for (const dir of ['.pi/agent', '.omp/agent', '.reasonix', '.kimi-code', '.minimax', '.qoder', '.zcode/v2', '.hermes', '.dsh/profiles/desktop', '.grok', '.cline/data/settings', '.commandcode', '.codex', '.claude', '.config/opencode']) {
  fs.mkdirSync(path.join(tmp, dir), { recursive: true })
}
setGatewayModels(['m-a', 'm-b'])
const ALL_APPS = ['claude', 'opencode', 'pi', 'omp', 'reasonix', 'codex', 'kimi', 'minimax', 'qoder', 'zcode', 'hermes', 'dsh', 'grok', 'cline', 'commandcode']
const freshResults = dispatch.dispatchAutoRoute(ALL_APPS.map((app) => ({ app })))
const freshFailed = freshResults.filter((r) => !r.ok)
ok(freshFailed.length === 0, `全部 agent 首次下发无报错${freshFailed.length ? `（失败：${JSON.stringify(freshFailed)}）` : ''}`)
ok(pi.readPiModels().providers.router.models.length === 2, '首次下发后 pi 已有 router 条目')

// ==================== 1. Pi：模型覆盖 + 默认供应商/默认模型继承 ====================
console.log('1. Pi 覆盖式重建')
setGatewayModels(['m-a', 'm-b'])
const piModelsFile = path.join(tmp, '.pi', 'agent', 'models.json')
const piSettingsFile = path.join(tmp, '.pi', 'agent', 'settings.json')
fs.mkdirSync(path.dirname(piModelsFile), { recursive: true })
// 模拟「上一轮网关下发」的旧状态：router 下有已下线的旧模型，且它是当前默认供应商
fs.writeFileSync(piModelsFile, JSON.stringify({
  providers: {
    router: { apiKey: 'old', baseUrl: 'http://127.0.0.1:1', api: 'openai-completions', headers: {}, authHeader: false, models: [{ id: 'stale-1' }, { id: 'stale-2' }] },
    keep: { apiKey: 'k', baseUrl: 'https://keep.example.com', api: 'openai-completions', models: [{ id: 'keep-1' }] },
  },
}, null, 2))
fs.writeFileSync(piSettingsFile, JSON.stringify({ defaultProvider: 'router', defaultModel: 'stale-2' }))
const piRes = dispatchTo(['pi'])
ok(piRes.every((r) => r.ok), 'pi 下发全部成功')
const piModels = pi.readPiModels()
eq(piModels.providers.router.models.map((m) => m.id), ['m-a', 'm-b'], 'pi：router 模型列表 = 网关当前模型（旧模型清除）')
ok(!!piModels.providers.keep, 'pi：其它供应商不受影响')
const piSettings = pi.readPiSettings()
eq(piSettings.defaultProvider, 'router', 'pi：原本是默认供应商，重建后仍是')
eq(piSettings.defaultModel, 'm-a', 'pi：原默认模型已不存在 → 取新清单第一个')

// 再下发一次，原默认模型仍在新清单里 → 沿用
fs.writeFileSync(piSettingsFile, JSON.stringify({ defaultProvider: 'router', defaultModel: 'm-b' }))
dispatchTo(['pi'])
eq(pi.readPiSettings().defaultModel, 'm-b', 'pi：原默认模型仍在新清单 → 沿用')

// ==================== 2. OpenCode：顶层 model 指针跟随 ====================
console.log('2. OpenCode 覆盖式重建')
const opencodeFile = path.join(tmp, '.config', 'opencode', 'opencode.json')
fs.mkdirSync(path.dirname(opencodeFile), { recursive: true })
fs.writeFileSync(opencodeFile, JSON.stringify({
  provider: {
    router: { npm: '@ai-sdk/openai-compatible', name: 'router', options: { baseURL: 'http://127.0.0.1:1' }, models: { 'stale-1': { name: 'stale-1' } } },
  },
  model: 'router/stale-1',
}, null, 2))
dispatchTo(['opencode'])
const opencodeDoc = opencode.readOpencodeConfig()
eq(Object.keys(opencodeDoc.provider.router.models), ['m-a', 'm-b'], 'opencode：router 模型替换为网关清单')
eq(opencodeDoc.model, 'router/m-a', 'opencode：model 指针改指新清单第一个（旧模型已不在）')
fs.writeFileSync(opencodeFile, JSON.stringify({
  provider: { router: { npm: '@ai-sdk/openai-compatible', name: 'router', options: {}, models: { 'm-b': {} } } },
  model: 'router/m-b',
}, null, 2))
dispatchTo(['opencode'])
eq(opencode.readOpencodeConfig().model, 'router/m-b', 'opencode：原生效模型仍在新清单 → 沿用')

// ==================== 3. Claude：配置文档槽位重建 + 激活状态继承 ====================
console.log('3. Claude 覆盖式重建')
const claudeDocId = 'ccconfig_config_dispatch_router'
window.utools.db.put({
  _id: claudeDocId,
  name: 'router',
  key: crypto.encrypt('sk-ccr-testkey'),
  authVar: 'ANTHROPIC_AUTH_TOKEN',
  baseUrl: 'http://127.0.0.1:17877',
  model: 'stale-1',
  defaultHaikuModel: '',
  defaultSonnetModel: '',
  defaultOpusModel: '',
  defaultFableModel: '',
  subagentModel: '',
  extraFields: [{ key: 'FOO', value: 'bar' }],
  updatedAt: Date.now(),
})
window.utools.db.put({ _id: 'ccconfig_active_config_id', configId: claudeDocId })
dispatchTo(['claude'])
const claudeDoc = window.utools.db.get(claudeDocId)
eq(claudeDoc.model, 'm-a', 'claude：默认槽位 = 新清单第一个')
eq(claudeDoc.defaultHaikuModel, 'm-b', 'claude：第二个模型进 Haiku 槽位')
eq(claudeDoc.defaultSonnetModel, '', 'claude：旧槽位已清空')
eq(claudeDoc.extraFields, [{ key: 'FOO', value: 'bar' }], 'claude：额外字段保留')
const claudeSettings = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf-8'))
eq(claudeSettings.env.ANTHROPIC_MODEL, 'm-a', 'claude：生效配置重建后 settings.json 的模型同步')
eq(claudeSettings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:17877', 'claude：settings.json 的 baseUrl 同步')
// 原默认模型仍在新清单里 → 换回默认槽位
window.utools.db.put({ ...window.utools.db.get(claudeDocId), model: '', defaultHaikuModel: 'm-b' })
setGatewayModels(['m-a', 'm-b', 'm-c'])
// 先把默认模型改成 m-b 再下发：重建后应把 m-b 换回默认槽
const beforeDoc = window.utools.db.get(claudeDocId)
window.utools.db.put({ ...beforeDoc, model: 'm-b', defaultHaikuModel: 'm-a' })
dispatchTo(['claude'])
const claudeDoc2 = window.utools.db.get(claudeDocId)
eq(claudeDoc2.model, 'm-b', 'claude：原默认模型仍在新清单 → 仍占默认槽位')

// ==================== 4. Codex：DB 模型列表与顶层默认同步 ====================
console.log('4. Codex 覆盖式重建')
const codexConfigFile = path.join(tmp, '.codex', 'config.toml')
fs.mkdirSync(path.dirname(codexConfigFile), { recursive: true })
fs.writeFileSync(codexConfigFile, [
  'model = "stale-1"',
  'model_provider = "router"',
  '',
  '[model_providers.router]',
  'name = "router"',
  'base_url = "http://127.0.0.1:17877/v1"',
  'wire_api = "chat"',
  'experimental_bearer_token = "old"',
  '',
].join('\n'))
window.utools.db.put({ _id: 'ccconfig_codex_provider_models', models: { router: ['stale-1', 'stale-2'] } })
dispatchTo(['codex'])
const codexCurrent = codex.getCodexCurrent()
eq(codexCurrent.provider, 'router', 'codex：原本生效，重建后仍生效')
eq(codexCurrent.model, 'm-a', 'codex：默认模型改指新清单第一个（旧的已不在）')
eq(codex.getCodexProviderModels('router'), ['m-a', 'm-b', 'm-c'], 'codex：DB 模型列表 = 网关清单')
ok(!codex.getCodexProviderModels('router').includes('stale-1'), 'codex：旧模型已从列表清除')

// ==================== 5. Kimi：别名与 default_model ====================
console.log('5. Kimi 覆盖式重建')
const kimiConfigFile = path.join(tmp, '.kimi-code', 'config.toml')
fs.mkdirSync(path.dirname(kimiConfigFile), { recursive: true })
fs.writeFileSync(kimiConfigFile, [
  'default_model = "router/stale-1"',
  '',
  '[providers.router]',
  'type = "openai"',
  'base_url = "http://127.0.0.1:17877/v1"',
  'api_key = "old"',
  '',
  '[models."router/stale-1"]',
  'provider = "router"',
  'model = "stale-1"',
  '',
].join('\n'))
dispatchTo(['kimi'])
const kimiAliases = kimi.getKimiModelList().filter((m) => m.provider === 'router').map((m) => m.alias).sort()
eq(kimiAliases, ['router/m-a', 'router/m-b', 'router/m-c'], 'kimi：router 下的别名 = 网关清单（旧别名清除）')
eq(kimi.getKimiDefaultModel(), 'router/m-a', 'kimi：default_model 改指新清单第一个')

// ==================== 6. MiniMax：停用开关 + 默认模型 ====================
console.log('6. MiniMax 覆盖式重建')
const minimaxKey = minimax.providerKeyFor('router')
const minimaxFile = path.join(tmp, '.minimax', 'config.yaml')
fs.mkdirSync(path.dirname(minimaxFile), { recursive: true })
fs.writeFileSync(minimaxFile, [
  'defaultModel: "custom_provider:router/stale-1"',
  'custom_provider:',
  '  router:',
  '    name: router',
  '    kind: custom',
  '    enabled: false',
  '    api: openai-completions',
  '    options:',
  '      baseURL: http://127.0.0.1:1',
  '    models:',
  '      stale-1:',
  '        name: stale-1',
  '',
].join('\n'))
dispatchTo(['minimax'])
const minimaxProv = minimax.getMinimaxProviderList().find((p) => p.id === minimaxKey)
eq(minimaxProv.models.map((m) => m.id), ['m-a', 'm-b', 'm-c'], 'minimax：模型字典 = 网关清单')
eq(minimaxProv.enabled, false, 'minimax：原本停用 → 重建后仍停用')
const minimaxDoc = fs.readFileSync(minimaxFile, 'utf-8')
ok(minimaxDoc.includes('custom_provider:router/m-a'), 'minimax：defaultModel 改指新清单第一个')

// ==================== 7. Cline：启用/停用开关 + 当前使用 ====================
console.log('7. Cline 覆盖式重建')
const clineDir = path.join(tmp, '.cline', 'data', 'settings')
fs.mkdirSync(clineDir, { recursive: true })
fs.writeFileSync(path.join(clineDir, 'providers.json'), JSON.stringify({
  version: 1,
  lastUsedProvider: 'router',
  modes: {},
  providers: {
    router: {
      settings: { provider: 'router', apiKey: 'old', model: 'stale-1', baseUrl: 'http://127.0.0.1:1' },
      updatedAt: new Date().toISOString(),
      tokenSource: 'manual',
      enabled: false,
    },
  },
}, null, 2))
fs.writeFileSync(path.join(clineDir, 'models.json'), JSON.stringify({
  version: 1,
  providers: { router: { provider: { name: 'router', baseUrl: 'http://127.0.0.1:1', defaultModelId: 'stale-1' }, models: { 'stale-1': { name: 'stale-1' } } } },
}, null, 2))
dispatchTo(['cline'])
const clineProviders = cline.readProvidersDoc()
eq(Object.keys(cline.readModelsDoc().providers.router.models), ['m-a', 'm-b', 'm-c'], 'cline：模型目录 = 网关清单')
eq(cline.effectiveLastUsedProvider(clineProviders), 'router', 'cline：原本是当前使用 → 重建后仍是')
eq(clineProviders.providers.router.settings.model, 'm-a', 'cline：默认模型改指新清单第一个')
eq(clineProviders.providers.router.enabled, false, 'cline：原本停用 → 重建后仍停用')

// ==================== 8. Command Code：disabled 继承 ====================
console.log('8. Command Code 覆盖式重建')
const ccHome = path.join(tmp, '.commandcode')
fs.mkdirSync(ccHome, { recursive: true })
fs.writeFileSync(path.join(ccHome, 'providers.json'), JSON.stringify({
  provider: {
    router: {
      name: 'router',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: false,
      models: { 'stale-1': { name: 'stale-1' } },
      disabled: true,
    },
  },
}, null, 2))
fs.writeFileSync(path.join(ccHome, 'settings.json'), JSON.stringify({ modelProvider: 'router', model: 'router/stale-1' }, null, 2))
fs.writeFileSync(path.join(ccHome, 'auth.json'), JSON.stringify({ router: { apiKey: 'sk-old' } }, null, 2))
dispatchTo(['commandcode'])
const ccProv = commandCode.getCommandCodeProviderList().find((p) => p.id === 'router')
eq(ccProv.models.map((m) => m.id), ['m-a', 'm-b', 'm-c'], 'commandcode：模型字典 = 网关清单')
eq(ccProv.disabled, true, 'commandcode：原本停用 → 重建后仍停用')
eq(commandCode.getCommandCodeDefaultModel().modelId, 'm-a', 'commandcode：默认模型改指新清单第一个')
eq(JSON.parse(fs.readFileSync(path.join(ccHome, 'auth.json'), 'utf-8')).router.apiKey, 'sk-ccr-testkey', 'commandcode：apiKey 按网关占位 key 重写')

// ==================== 9. ZCode：首选顺序 + 模型规则 ====================
console.log('9. ZCode 覆盖式重建')
const zcodeFile = path.join(tmp, '.zcode', 'v2', 'provider_config.json')
fs.mkdirSync(path.dirname(zcodeFile), { recursive: true })
fs.writeFileSync(zcodeFile, JSON.stringify({
  schemaVersion: 1,
  config: {
    providerOrder: ['other', 'router'],
    providerConfigRules: {
      providerRules: [
        { providerId: 'other', providerName: 'other', config: { access: { type: 'api-key' }, api: { type: 'openai-chat-completions', baseUrl: 'https://other.example.com' }, personalModelIds: ['o-1'], modelOrder: ['o-1'] } },
        { providerId: 'router', providerName: 'router', config: { access: { type: 'api-key' }, api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:1/v1' }, personalModelIds: ['stale-1'], modelOrder: ['stale-1'] } },
      ],
    },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
}, null, 2))
dispatchTo(['zcode'])
const zcodeDoc = JSON.parse(fs.readFileSync(zcodeFile, 'utf-8'))
const zcodeRouter = zcodeDoc.config.providerConfigRules.providerRules.find((r) => r.providerId === 'router')
eq(zcodeRouter.config.modelOrder, ['m-a', 'm-b', 'm-c'], 'zcode：router 的模型顺序 = 网关清单')
eq(zcodeDoc.config.providerOrder, ['other', 'router'], 'zcode：原本不是首选 → 选择器位置不变')
// 让 router 成为首选后再下发
fs.writeFileSync(zcodeFile, JSON.stringify({
  schemaVersion: 1,
  config: {
    providerOrder: ['router', 'other'],
    providerConfigRules: { providerRules: [
      { providerId: 'router', providerName: 'router', config: { access: { type: 'api-key' }, api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:1/v1' }, personalModelIds: ['stale-1'], modelOrder: ['stale-1'] } },
    ] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
}, null, 2))
dispatchTo(['zcode'])
const zcodeDef = zcode.getZcodeDefaultModel()
eq(zcodeDef.modelId, 'm-a', 'zcode：原本是首选供应商 → 重建后仍是首选（默认模型 = 新清单第一个）')

// ==================== 10. omp：modelRoles 引用跟随 ====================
console.log('10. omp 覆盖式重建')
const ompDir = path.join(tmp, '.omp', 'agent')
fs.mkdirSync(ompDir, { recursive: true })
fs.writeFileSync(path.join(ompDir, 'models.yml'), [
  'providers:',
  '  router:',
  '    apiKey: old',
  '    baseUrl: http://127.0.0.1:1',
  '    api: openai-completions',
  '    models:',
  '      - id: stale-1',
  '',
].join('\n'))
fs.writeFileSync(path.join(ompDir, 'config.yml'), [
  'modelRoles:',
  '  main: router/stale-1',
  '  fast: "router/stale-1:low"',
  '',
].join('\n'))
dispatchTo(['omp'])
const ompModels = require('../public/preload/services/omp').readOmpModels()
eq(ompModels.providers.router.models.map((m) => m.id), ['m-a', 'm-b', 'm-c'], 'omp：router 模型 = 网关清单')
const ompRoles = require('../public/preload/services/omp').readOmpModelRoles()
eq(ompRoles.main, 'router/m-a', 'omp：角色引用的旧模型改指新清单第一个')
eq(ompRoles.fast, 'router/m-a:low', 'omp：角色的 :level 后缀保留')

// ==================== 11. Reasonix：default_model + 模型数组 ====================
console.log('11. Reasonix 覆盖式重建')
const reasonixDir = path.join(tmp, '.reasonix')
fs.mkdirSync(reasonixDir, { recursive: true })
fs.writeFileSync(path.join(reasonixDir, 'config.toml'), [
  'default_model = "router/stale-1"',
  '',
  '[[providers]]',
  'name = "router"',
  'kind = "openai"',
  'base_url = "http://127.0.0.1:1"',
  'api_key_env = "ROUTER_API_KEY"',
  'models = ["stale-1"]',
  '',
].join('\n'))
fs.writeFileSync(path.join(reasonixDir, '.env'), 'ROUTER_API_KEY=old\n')
dispatchTo(['reasonix'])
const reasonix = require('../public/preload/services/reasonix')
eq(reasonix.getReasonixProviderList().find((p) => p.name === 'router').models, ['m-a', 'm-b', 'm-c'], 'reasonix：router 模型 = 网关清单')
eq(reasonix.getReasonixDefaultModel(), 'router/m-a', 'reasonix：default_model 改指新清单第一个')

// ==================== 12. Qoder：provider.model 默认模型 ====================
console.log('12. Qoder 覆盖式重建')
const qoder = require('../public/preload/services/qoder')
const qoderKey = qoder.providerKeyFor('router')
const qoderFile = path.join(tmp, '.qoder', 'settings.json')
fs.mkdirSync(path.dirname(qoderFile), { recursive: true })
fs.writeFileSync(qoderFile, JSON.stringify({
  providers: {
    [qoderKey]: { baseUrl: 'http://127.0.0.1:1', apiKey: 'old', type: 'openai-compatible', protocol: 'openai', authType: 'api-key', model: 'stale-1', models: [{ model: 'stale-1', displayName: 'stale-1' }] },
  },
}, null, 2))
dispatchTo(['qoder'])
const qoderProv = qoder.getQoderProviderList().find((p) => p.id === qoderKey)
eq(qoderProv.models.map((m) => m.model), ['m-a', 'm-b', 'm-c'], 'qoder：router 模型 = 网关清单')
eq(qoder.getQoderDefaultModel(qoderKey), 'm-a', 'qoder：默认模型改指新清单第一个')

// ==================== 13. Hermes：model.provider / model.default ====================
console.log('13. Hermes 覆盖式重建')
const hermes = require('../public/preload/services/hermes')
const hermesKey = hermes.providerKeyFor('router')
const hermesFile = path.join(tmp, '.hermes', 'config.yaml')
fs.mkdirSync(path.dirname(hermesFile), { recursive: true })
fs.writeFileSync(hermesFile, [
  'model:',
  '  provider: router',
  '  default: stale-1',
  'custom_providers:',
  '  - name: router',
  '    base_url: http://127.0.0.1:1',
  '    api_mode: chat_completions',
  '    models:',
  '      stale-1:',
  '        name: stale-1',
  '',
].join('\n'))
dispatchTo(['hermes'])
const hermesProv = hermes.getHermesProviderList().find((p) => p.name === hermesKey && p.source === 'custom')
eq(hermesProv.models.map((m) => m.modelId), ['m-a', 'm-b', 'm-c'], 'hermes：router 模型 = 网关清单')
eq(hermes.getHermesDefaultModel(), { provider: hermesKey, modelId: 'm-a' }, 'hermes：默认模型改指新清单第一个')

// ==================== 14. DSH：路由模型列表 + agent-default-model ====================
console.log('14. DSH 覆盖式重建')
const dsh = require('../public/preload/services/dsh')
const dshRoute = dsh.providerRouteFor('router')
const dshPatchFile = path.join(tmp, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
fs.mkdirSync(path.dirname(dshPatchFile), { recursive: true })
fs.writeFileSync(dshPatchFile, [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  `      ${dshRoute}:`,
  '        displayName: router',
  `        apiKeyEnv: ${dshRoute.toUpperCase()}_API_KEY`,
  '        api: anthropic-messages',
  '        baseURL: http://127.0.0.1:17877',
  '        models:',
  '          - modelId: stale-1',
  '- id: agent-default-model',
  '  config:',
  `    provider: ${dshRoute}`,
  '    model: stale-1',
  '',
].join('\n'))
dispatchTo(['dsh'])
const dshProv = dsh.getDshProviderList().find((p) => p.route === dshRoute)
eq(dshProv.models.map((m) => m.modelId), ['m-a', 'm-b', 'm-c'], 'dsh：路由模型 = 网关清单')
eq(dsh.getDshDefaultModel().modelId, 'm-a', 'dsh：默认模型改指新清单第一个')

// ==================== 15. Grok：[model_providers.key] + [model.<id>] + models.default ====================
console.log('15. Grok 覆盖式重建')
const grok = require('../public/preload/services/grok')
const grokKey = grok.providerKeyFor('router')
const grokFile = path.join(tmp, '.grok', 'config.toml')
fs.mkdirSync(path.dirname(grokFile), { recursive: true })
fs.writeFileSync(grokFile, [
  '[models]',
  'default = "stale-1"',
  '',
  `[model_providers.${grokKey}]`,
  `name = "${grokKey}"`,
  'base_url = "http://127.0.0.1:17877/v1"',
  'api_backend = "messages"',
  'api_key = "old"',
  '',
  '[model.stale-1]',
  'model = "stale-1"',
  `model_provider = "${grokKey}"`,
  '',
].join('\n'))
dispatchTo(['grok'])
eq(grok.getGrokModelList().filter((m) => m.modelProvider === grokKey).map((m) => m.id), ['m-a', 'm-b', 'm-c'], 'grok：模型条目 = 网关清单')
eq(grok.getGrokDefaultModel().modelId, 'm-a', 'grok：models.default 改指新清单第一个')

// ==================== 16. 非网关下发仍是合并语义 ====================
console.log('16. 通用模型下发仍为合并')
setGatewayModels(['m-a', 'm-b'], 'anthropic-messages')
const mergeProvider = {
  name: 'other-provider',
  api: 'anthropic-messages',
  baseUrl: 'https://other.example.com',
  apiKey: 'sk-other',
  models: [],
}
dispatch.dispatchCommonModel(mergeProvider, { id: 'x-1', name: 'x-1' }, [{ app: 'pi' }])
dispatch.dispatchCommonModel(mergeProvider, { id: 'x-2', name: 'x-2' }, [{ app: 'pi' }])
eq(pi.readPiModels().providers['other-provider'].models.map((m) => m.id), ['x-1', 'x-2'], 'pi：普通下发按模型累加（未受影响）')
eq(pi.readPiModels().providers.router.models.map((m) => m.id), ['m-a', 'm-b'], 'pi：普通下发不改动 router 的清单')

// ==================== 17. 未生效时不得抢走当前的供应商 ====================
console.log('17. 未生效时不改变当前选择')
setGatewayModels(['m-a', 'm-b'])
// Cline：当前使用是另一条供应商 → 重建 router 后不得接管
const clineDir2 = path.join(tmp, '.cline', 'data', 'settings')
fs.writeFileSync(path.join(clineDir2, 'providers.json'), JSON.stringify({
  version: 1,
  lastUsedProvider: 'other',
  modes: {},
  providers: {
    other: { settings: { provider: 'other', apiKey: 'k', model: 'o-1', baseUrl: 'https://other.example.com' }, updatedAt: new Date().toISOString(), tokenSource: 'manual' },
    router: { settings: { provider: 'router', apiKey: 'old', model: 'stale-1', baseUrl: 'http://127.0.0.1:1' }, updatedAt: new Date().toISOString(), tokenSource: 'manual' },
  },
}, null, 2))
dispatchTo(['cline'])
eq(cline.effectiveLastUsedProvider(cline.readProvidersDoc()), 'other', 'cline：当前使用是别的供应商 → 不被 router 抢走')
eq(Object.keys(cline.readModelsDoc().providers.router.models), ['m-a', 'm-b'], 'cline：router 仍按覆盖式重建')

// Claude：生效的是另一份配置 → 不写 settings.json、不改激活指针
const otherClaudeId = 'ccconfig_config_other'
window.utools.db.put({ _id: otherClaudeId, name: 'other', key: crypto.encrypt('sk-other'), authVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'https://other.example.com', model: 'o-1', extraFields: [], updatedAt: Date.now() })
window.utools.db.put({ _id: 'ccconfig_active_config_id', configId: otherClaudeId })
window.utools.db.put({ _id: claudeDocId, name: 'router', key: crypto.encrypt('sk-ccr-testkey'), authVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'http://127.0.0.1:17877', model: 'stale-1', defaultHaikuModel: 'stale-2', defaultSonnetModel: '', defaultOpusModel: '', defaultFableModel: '', subagentModel: '', extraFields: [], updatedAt: Date.now() })
fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-other', ANTHROPIC_BASE_URL: 'https://other.example.com', ANTHROPIC_MODEL: 'o-1' } }, null, 2))
dispatchTo(['claude'])
const settingsAfter = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf-8'))
eq(settingsAfter.env.ANTHROPIC_MODEL, 'o-1', 'claude：未生效的 router 重建不动 settings.json')
eq(window.utools.db.get('ccconfig_active_config_id').configId, otherClaudeId, 'claude：激活指针不变')
eq(window.utools.db.get(claudeDocId).model, 'm-a', 'claude：router 自身仍被重建')

// ==================== 18. 超过槽位数的模型：前 6 个成功、其余报槽位满 ====================
console.log('18. Claude 槽位上限')
setGatewayModels(['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7', 'm-8'])
const manyRes = dispatchTo(['claude'])
const okCount = manyRes.filter((r) => r.ok).length
eq(okCount, 6, 'claude：6 个槽位写满')
ok(manyRes.filter((r) => !r.ok).length === 2, 'claude：超出的 2 个模型报错（不影响已写入的 6 个）')
const manyDoc = window.utools.db.get(claudeDocId)
eq([manyDoc.model, manyDoc.defaultHaikuModel, manyDoc.defaultSonnetModel, manyDoc.defaultOpusModel, manyDoc.defaultFableModel, manyDoc.subagentModel], ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'], 'claude：六个槽位按网关顺序填满')

console.log(`\n通过 ${passed}/${passed + failed}`)
process.exit(failed === 0 ? 0 : 1)
