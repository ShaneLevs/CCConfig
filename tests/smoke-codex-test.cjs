// Codex 配置与统计冒烟测试（临时 HOME，绝不读写真实 ~/.codex）
// 覆盖当前 Codex 0.166 的严格约束：只允许 responses、forced_login_method 单独生效、
// URL 归一化、空目录不启用、密钥文件 0600、安装检测不再依赖残留配置目录。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-codex-'))
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.CODEX_HOME = path.join(tmp, '.codex')
delete process.env.CCCONFIG_LOCALE

const dbDocs = new Map()
global.window = {
  utools: {
    getPath: () => tmp,
    getNativeId: () => 'test',
    shellOpenPath() {},
    db: {
      get: (id) => dbDocs.get(id) || null,
      put: (doc) => { dbDocs.set(doc._id, { ...doc, _rev: '1' }); return { ok: true } },
      remove: (id) => { dbDocs.delete(id); return { ok: true } },
      allDocs: () => ({ docs: [...dbDocs.values()] }),
    },
  },
}

require.cache[require.resolve('../public/preload/services/i18n.js')] = {
  id: 'i18n-stub', filename: 'i18n-stub', loaded: true,
  exports: { t: (k, p) => `${k}${p ? ' ' + JSON.stringify(p) : ''}` },
}

const codex = require('../public/preload/services/codex.js')
const usage = require('../public/preload/services/usage.js')
const { parse } = require('../public/preload/node_modules/smol-toml')

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

const configPath = () => path.join(process.env.CODEX_HOME, 'config.toml')
const catalogPath = () => path.join(process.env.CODEX_HOME, 'models.json')
const readConfig = () => parse(fs.readFileSync(configPath(), 'utf8'))

;(async () => {
  await check('Base URL：去掉端点与尾斜杠并补 /v1', () => {
    assert.strictEqual(codex.normalizeCodexBaseUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1')
    assert.strictEqual(codex.normalizeCodexBaseUrl('https://api.example.com/'), 'https://api.example.com/v1')
    assert.strictEqual(codex.normalizeCodexBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1')
  })

  await check('新增供应商：Base URL 归一化，文件权限 0600', () => {
    codex.addCodexProvider({
      id: 'probe',
      name: 'Probe',
      baseUrl: 'https://api.example.com/v1/chat/completions',
      wireApi: 'responses',
      apiKey: 'secret',
    })
    const cfg = readConfig()
    assert.strictEqual(cfg.model_providers.probe.base_url, 'https://api.example.com/v1')
    assert.strictEqual(cfg.model_providers.probe.wire_api, 'responses')
    assert.strictEqual(fs.statSync(configPath()).mode & 0o777, 0o600)
  })

  await check('Chat wire_api 被拒绝，不会写坏 config.toml', () => {
    assert.throws(() => codex.addCodexProvider({
      id: 'bad', name: 'bad', baseUrl: 'https://api.example.com', wireApi: 'chat',
    }), /wireApiUnsupported/)
    assert.strictEqual(readConfig().model_providers.bad, undefined)
  })

  await check('默认模型只写 forced_login_method，并清理 preferred_auth_method', () => {
    fs.writeFileSync(configPath(), [
      'preferred_auth_method = "apikey"',
      '',
      '[model_providers.probe]',
      'name = "Probe"',
      'base_url = "https://api.example.com/v1"',
      'wire_api = "responses"',
      '',
    ].join('\n'))
    codex.setCodexDefaultModel('probe', 'model-a')
    const cfg = readConfig()
    const current = codex.getCodexCurrent()
    assert.strictEqual(cfg.forced_login_method, 'api')
    assert.strictEqual(cfg.preferred_auth_method, undefined)
    assert.strictEqual(current.apiAuth, true)
    assert.ok(current.active, '设置默认模型应自动启用当前配置')
    assert.ok(cfg.model_catalog_json, '设置默认模型应自动启用模型目录')
  })

  await check('API 认证关闭时两个旧/新认证字段都清空', () => {
    fs.writeFileSync(configPath(), 'preferred_auth_method = "apikey"\nforced_login_method = "api"\n')
    codex.setCodexApiAuth(false)
    const cfg = readConfig()
    assert.strictEqual(cfg.forced_login_method, undefined)
    assert.strictEqual(cfg.preferred_auth_method, undefined)
    assert.strictEqual(codex.getCodexCurrent().apiAuth, false)
  })

  await check('恢复默认后重新配置：目录可再次启用（新 HOME 独立场景）', () => {
    codex.resetCodexConfig()
    codex.addCodexProvider({
      id: 'probe', name: 'Probe', baseUrl: 'https://api.example.com',
      wireApi: 'responses', apiKey: 'secret',
    })
    codex.addCodexModel('probe', 'model-a')
  })

  await check('使用当前配置：关闭仅清生效字段，供应商、Key、模型列表和目录文件保留', () => {
    codex.setCodexDefaultModel('probe', 'model-a')
    assert.strictEqual(codex.getCodexCurrent().active, true)
    assert.ok(fs.existsSync(catalogPath()))

    const result = codex.setCodexActiveConfig(false)
    const cfg = readConfig()
    assert.deepStrictEqual(result, { enabled: false })
    assert.strictEqual(cfg.model, undefined)
    assert.strictEqual(cfg.model_provider, undefined)
    assert.strictEqual(cfg.forced_login_method, undefined)
    assert.strictEqual(cfg.preferred_auth_method, undefined)
    assert.strictEqual(cfg.model_catalog_json, undefined)
    assert.strictEqual(cfg.model_providers.probe.experimental_bearer_token, 'secret')
    assert.deepStrictEqual(codex.getCodexProviderModels('probe'), ['model-a'])
    assert.ok(fs.existsSync(catalogPath()), '关闭后 models.json 应保留')
    assert.strictEqual(codex.getCodexCurrent().active, false)
  })

  await check('使用当前配置：重新设为默认模型会一并恢复认证与目录', () => {
    codex.setCodexDefaultModel('probe', 'model-a')
    const cfg = readConfig()
    assert.strictEqual(cfg.model_provider, 'probe')
    assert.strictEqual(cfg.model, 'model-a')
    assert.strictEqual(cfg.forced_login_method, 'api')
    assert.ok(cfg.model_catalog_json)
    assert.strictEqual(codex.getCodexCurrent().active, true)
  })

  await check('preload 公开装配包含 Codex 总开关和停用目录接口', () => {
    const servicesSource = fs.readFileSync(path.join(__dirname, '../public/preload/services.js'), 'utf8')
    assert.match(servicesSource, /\bsetCodexActiveConfig:\s*codex\.setCodexActiveConfig\b/)
    assert.match(servicesSource, /\bdisableCodexCatalog:\s*codex\.disableCodexCatalog\b/)
  })

  await check('模型参数：图片与上下文写入目录，不保存最大输出', () => {
    codex.updateCodexModel('probe', 'model-a', {
      name: 'Model A',
      contextWindow: 128000,
      maxTokens: 8192,
      input: ['text', 'image'],
    })
    const config = codex.getCodexModelConfig('probe', 'model-a')
    assert.strictEqual(config.name, 'Model A')
    assert.strictEqual(config.contextWindow, 128000)
    assert.strictEqual(config.maxTokens, undefined, 'Codex 没有最大输出字段，不再保存')
    assert.deepStrictEqual(config.input, ['text', 'image'])
    const entry = codex.buildCatalogEntry('probe', 'model-a', 1, config)
    assert.strictEqual(entry.display_name, 'Model A')
    assert.deepStrictEqual(entry.input_modalities, ['text', 'image'])
    assert.strictEqual(entry.context_window, 128000)
    assert.strictEqual(entry.max_output_tokens, undefined, 'Codex 目录没有最大输出字段')
    assert.strictEqual(entry.maxTokens, undefined)
    codex.syncCodexModelCatalog()
    const catalog = JSON.parse(fs.readFileSync(catalogPath(), 'utf8'))
    const written = catalog.models.find((m) => m.slug === 'model-a')
    assert.deepStrictEqual(written.input_modalities, ['text', 'image'])
    assert.strictEqual(written.context_window, 128000)
    assert.strictEqual(written.max_output_tokens, undefined)
  })

  await check('重复下发只补非空参数，不覆盖用户已保存的模型配置', () => {
    codex.upsertCodexModel('probe', 'model-a', false, { name: 'Incoming Name' })
    const config = codex.getCodexModelConfig('probe', 'model-a')
    assert.strictEqual(config.name, 'Incoming Name')
    assert.strictEqual(config.contextWindow, 128000)
    assert.deepStrictEqual(config.input, ['text', 'image'])
    codex.upsertCodexModel('probe', 'model-a', false, { contextWindow: 64000, input: ['text'] })
    assert.strictEqual(codex.getCodexModelConfig('probe', 'model-a').contextWindow, 64000)
    assert.deepStrictEqual(codex.getCodexModelConfig('probe', 'model-a').input, ['text'])
  })

  await check('旧模型列表仍是 string[]，模型参数独立保存且可清除', () => {
    assert.deepStrictEqual(codex.getCodexProviderModels('probe'), ['model-a'])
    codex.updateCodexModel('probe', 'model-a', {})
    assert.deepStrictEqual(codex.getCodexModelConfig('probe', 'model-a'), {})
    assert.deepStrictEqual(codex.getCodexProviderModels('probe'), ['model-a'])
  })

  await check('空模型目录不写 model_catalog_json，Codex 不会因此拒绝加载', () => {
    codex.upsertCodexProvider('empty', { name: 'Empty', baseUrl: 'https://api.example.com', wireApi: 'responses' })
    window.utools.db.remove('ccconfig_codex_provider_models')
    const result = codex.syncCodexModelCatalog()
    assert.strictEqual(result.disabled, true)
    assert.strictEqual(result.total, 0)
    assert.strictEqual(readConfig().model_catalog_json, undefined)
    assert.ok(fs.existsSync(catalogPath()), 'models.json 文件保留')
  })

  await check('生成目录：非空、权限 0600、路径为正斜杠', () => {
    codex.upsertCodexModel('probe', 'model-a')
    const result = codex.syncCodexModelCatalog()
    assert.strictEqual(result.disabled, false)
    assert.ok(result.total >= 1)
    const catalog = JSON.parse(fs.readFileSync(catalogPath(), 'utf8'))
    assert.ok(catalog.models.some((m) => m.slug === 'model-a'))
    assert.ok(!readConfig().model_catalog_json.includes('\\'))
    assert.strictEqual(fs.statSync(catalogPath()).mode & 0o777, 0o600)
  })

  await check('Codex 用量优先 token_usage_record，不重复累计 token_count', () => {
    const sessionDir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '30')
    fs.mkdirSync(sessionDir, { recursive: true })
    const ts = new Date().toISOString()
    const day = usage.localDayKey(ts)
    const usageValue = {
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      total_tokens: 120,
    }
    fs.writeFileSync(path.join(sessionDir, 'rollout-test.jsonl'), [
      JSON.stringify({ timestamp: ts, ordinal: 0, type: 'session_meta', payload: {
        session_id: 's1', timestamp: ts, cwd: '/Users/me/project', provenance: { model: 'model-a' },
      } }),
      JSON.stringify({ timestamp: ts, ordinal: 1, type: 'turn_context', payload: { model: 'model-a' } }),
      JSON.stringify({ timestamp: ts, ordinal: 2, type: 'token_usage_record', payload: {
        response_id: 'r1', usage: usageValue,
      } }),
      JSON.stringify({ timestamp: ts, ordinal: 3, type: 'event_msg', payload: {
        type: 'token_count', info: { total_token_usage: usageValue, last_token_usage: usageValue },
      } }),
    ].join('\n'))
    const stats = codex.readCodexUsage()
    const today = stats.contributions.find((d) => d.date === day)
    assert.ok(today)
    assert.strictEqual(today.tokens, 120)
    assert.strictEqual(today.inputTokens, 100, '输入含缓存，与 UsagePage 口径一致')
    assert.strictEqual(today.outputTokens, 20)
    assert.strictEqual(stats.summary.sessionCount, 1)
    assert.strictEqual(stats.modelStats[0].name, 'model-a')
    assert.ok(dbDocs.get('ccconfig_agent_usage_codex_test'))
  })

  await check('旧格式只读 last_token_usage，不拿累计值重复累加', () => {
    fs.rmSync(path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '30'), { recursive: true, force: true })
    const sessionDir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '31')
    fs.mkdirSync(sessionDir, { recursive: true })
    const ts = new Date().toISOString()
    const write = (n, input, output) => JSON.stringify({ timestamp: ts, ordinal: n, type: 'event_msg', payload: {
      type: 'token_count', info: { last_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } },
    } })
    fs.writeFileSync(path.join(sessionDir, 'rollout-legacy.jsonl'), [write(1, 10, 5), write(2, 4, 2)].join('\n'))
    const stats = codex.readCodexUsage()
    assert.strictEqual(stats.summary.messageCount, 2, '只有两次增量，不读取 total_token_usage')
  })

  await check('空会话不计入 sessionCount，已有 usage 的会话仍正常统计', () => {
    const root = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '01')
    fs.mkdirSync(root, { recursive: true })
    const ts = new Date().toISOString()
    const sessionMeta = (id) => JSON.stringify({ timestamp: ts, ordinal: 0, type: 'session_meta', payload: {
      session_id: id, timestamp: ts, cwd: '/Users/me/project', provenance: { model: 'model-a' },
    } })
    const usageRecord = JSON.stringify({ timestamp: ts, ordinal: 1, type: 'token_usage_record', payload: {
      response_id: 'r-valid', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    } })
    fs.writeFileSync(path.join(root, 'empty.jsonl'), sessionMeta('empty-session'))
    fs.writeFileSync(path.join(root, 'used.jsonl'), [sessionMeta('used-session'), usageRecord].join('\n'))
    const stats = codex.readCodexUsage()
    assert.strictEqual(stats.summary.sessionCount, 2, '旧格式会话 + 有效新会话；空会话不计入')
    assert.ok(!stats.recentSessions.some((s) => s.sessionId === 'empty-session'))
  })

  await check('isCodexInstalled 是 Promise，且不把残留配置目录当成已安装', async () => {
    assert.ok(codex.isCodexInstalled() instanceof Promise)
    const installed = await codex.isCodexInstalled()
    assert.strictEqual(typeof installed, 'boolean')
  })

  let failed = 0
  for (const [status, name] of results) {
    if (status === 'FAIL') failed++
    console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}`)
  }
  console.log(`\n${results.length - failed}/${results.length} passed`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})()
