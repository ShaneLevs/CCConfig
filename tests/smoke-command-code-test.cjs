// Command Code 服务层冒烟测试（临时 COMMANDCODE_HOME，绝不碰真实 ~/.commandcode）
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'))
process.env.COMMANDCODE_HOME = tmp

// stub uTools（service 里 openXxxDir 会调）
global.window = { utools: { shellOpenPath() {}, db: { get: () => null, put: () => ({ ok: true }) } } }

const t = (k) => k
// i18n stub：本测试只关心逻辑，不校验文案
require.cache[require.resolve('../public/preload/services/i18n.js')] = {
  id: 'i18n-stub', filename: 'i18n-stub', loaded: true,
  exports: { t: (k, p) => `${k}${p ? ' ' + JSON.stringify(p) : ''}` },
}

const cc = require('../public/preload/services/command-code.js')

const results = []
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

// ==================== Provider ====================
check('add provider', () => {
  cc.addCommandCodeProvider({ id: 'acme', name: 'Acme AI', api: 'anthropic-messages', baseUrl: 'https://api.acme.example/v1' })
  const list = cc.getCommandCodeProviderList()
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].name, 'Acme AI')
  assert.strictEqual(list[0].api, 'anthropic-messages')
  assert.strictEqual(list[0].hasStoredKey, false)
})

check('provider json has no plaintext key', () => {
  const doc = cc.readProvidersDoc()
  assert.strictEqual(doc.provider.acme.apiKey, false)
})

check('duplicate provider rejected', () => {
  assert.throws(() => cc.addCommandCodeProvider({ id: 'acme' }))
})

check('invalid provider id rejected', () => {
  assert.throws(() => cc.addCommandCodeProvider({ id: 'Bad_ID' }))
})

// ==================== auth.json 隔离 ====================
check('auth.json 账号字段不被破坏', () => {
  fs.writeFileSync(path.join(tmp, 'auth.json'), JSON.stringify({
    apiKey: 'ACCOUNT_KEY',
    userId: 'u-1',
    userName: 'Shane',
    authenticatedAt: '2026-01-01T00:00:00.000Z',
  }), { encoding: 'utf-8' })
  cc.setCommandCodeApiKey('acme', 'sk-provider-secret')
  const auth = cc.readAuthDoc()
  assert.strictEqual(auth.apiKey, 'ACCOUNT_KEY')
  assert.strictEqual(auth.userId, 'u-1')
  assert.strictEqual(auth.acme.apiKey, 'sk-provider-secret')
  const mode = fs.statSync(path.join(tmp, 'auth.json')).mode & 0o777
  assert.strictEqual(mode, 0o600, 'auth.json 权限应为 600，实际 ' + mode.toString(8))
})

check('hasStoredKey / keyMasked 不泄露明文', () => {
  const p = cc.getCommandCodeProviderList().find((x) => x.id === 'acme')
  assert.strictEqual(p.hasStoredKey, true)
  assert.ok(!p.keyMasked.includes('secret'), '掩码不应含完整 key')
})

check('clear key 只删该 provider', () => {
  cc.writeJsonDoc(path.join(tmp, 'auth.json'), {
    apiKey: 'ACCOUNT_KEY',
    acme: { apiKey: 'sk-a' },
    other: { apiKey: 'sk-b' },
  })
  cc.clearCommandCodeApiKey('acme')
  const auth = cc.readAuthDoc()
  assert.strictEqual(auth.apiKey, 'ACCOUNT_KEY')
  assert.strictEqual(auth.acme, undefined)
  assert.strictEqual(auth.other.apiKey, 'sk-b')
})

// ==================== Model ====================
check('add model + alias normalization', () => {
  cc.addCommandCodeModel('acme', {
    id: 'qwen/qwen3.6-27b',
    name: 'Qwen 3.6',
    contextWindow: 131072,
    maxOutput: 16384,
    reasoningEfforts: ['low', 'bogus', 'high'],
    cost: { input: 0.4, output: 1.6, cache_read: 0.1 },
    options: { temperature: 0.6 },
  })
  const p = cc.getCommandCodeProviderList().find((x) => x.id === 'acme')
  const m = p.models.find((x) => x.id === 'qwen/qwen3.6-27b')
  assert.ok(m, '模型应存在')
  assert.strictEqual(m.contextWindow, 131072)
  assert.deepStrictEqual(m.reasoningEfforts, ['low', 'high'], '非法 effort 应被丢弃')
  assert.strictEqual(m.cost.cacheRead, 0.1, 'cache_read 应归一为 cacheRead')
  assert.strictEqual(m.options.temperature, 0.6)
})

check('limit.context 别名读取', () => {
  const doc = cc.readProvidersDoc()
  doc.provider.acme.models['legacy-model'] = { limit: { context: 200000, output: 8000 } }
  cc.writeProvidersDoc(doc)
  const p = cc.getCommandCodeProviderList().find((x) => x.id === 'acme')
  const m = p.models.find((x) => x.id === 'legacy-model')
  assert.strictEqual(m.contextWindow, 200000)
  assert.strictEqual(m.maxOutput, 8000)
})

check('model api override 保留', () => {
  cc.updateCommandCodeModel('acme', 'legacy-model', { api: 'openai-responses' })
  const doc = cc.readProvidersDoc()
  assert.strictEqual(doc.provider.acme.models['legacy-model'].api, 'openai-responses')
})

// ==================== 默认模型 ====================
check('set default writes qualified name', () => {
  cc.setCommandCodeDefaultModel('acme', 'qwen/qwen3.6-27b')
  const settings = cc.readSettingsDoc()
  assert.strictEqual(settings.modelProvider, 'acme')
  assert.strictEqual(settings.model, 'acme/qwen/qwen3.6-27b')
})

check('get default 只剥首个 provider 前缀', () => {
  const d = cc.getCommandCodeDefaultModel()
  assert.strictEqual(d.provider, 'acme')
  assert.strictEqual(d.modelId, 'qwen/qwen3.6-27b')
})

check('settings 其它键不被抹掉', () => {
  cc.writeSettingsDoc({
    modelProvider: 'acme',
    model: 'acme/qwen/qwen3.6-27b',
    hooks: { a: 1 },
    disabledSkills: ['x'],
    localOnly: true,
  })
  cc.setCommandCodeDefaultModel('acme', 'legacy-model')
  const s = cc.readSettingsDoc()
  assert.deepStrictEqual(s.hooks, { a: 1 })
  assert.deepStrictEqual(s.disabledSkills, ['x'])
  assert.strictEqual(s.localOnly, true)
})

check('delete model 清理悬空默认', () => {
  cc.setCommandCodeDefaultModel('acme', 'legacy-model')
  cc.deleteCommandCodeModel('acme', 'legacy-model')
  const s = cc.readSettingsDoc()
  assert.notStrictEqual(s.model, 'acme/legacy-model')
})

// ==================== 改名联动 ====================
check('provider 改名同步 settings', () => {
  cc.setCommandCodeDefaultModel('acme', 'qwen/qwen3.6-27b')
  cc.updateCommandCodeProvider('acme', { id: 'acme2' })
  const s = cc.readSettingsDoc()
  assert.strictEqual(s.modelProvider, 'acme2')
  assert.strictEqual(s.model, 'acme2/qwen/qwen3.6-27b')
  assert.ok(!cc.readProvidersDoc().provider.acme, '旧 id 应删除')
})

// ==================== MCP ====================
check('mcp stdio + http', () => {
  cc.setCommandCodeMcpServer('playwright', { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: { A: '1' } })
  cc.setCommandCodeMcpServer('notion', { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { 'X-K': 'v' } })
  const list = cc.getCommandCodeMcpServers()
  assert.strictEqual(list.length, 2)
  const pl = list.find((s) => s.name === 'playwright')
  assert.strictEqual(pl.type, 'stdio')
  assert.deepStrictEqual(pl.args, ['-y', '@playwright/mcp@latest'])
  assert.deepStrictEqual(pl.env, { A: '1' })
  const no = list.find((s) => s.name === 'notion')
  assert.strictEqual(no.type, 'http')
  assert.strictEqual(no.url, 'https://mcp.notion.com/mcp')
  // 磁盘格式
  const doc = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf-8'))
  assert.strictEqual(doc.mcpServers.playwright.transport, 'stdio')
  assert.strictEqual(doc.mcpServers.notion.transport, 'http')
})

check('mcp toggle enabled', () => {
  cc.setCommandCodeMcpEnabled('notion', false)
  let doc = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf-8'))
  assert.strictEqual(doc.mcpServers.notion.enabled, false)
  cc.setCommandCodeMcpEnabled('notion', true)
  doc = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf-8'))
  assert.strictEqual(doc.mcpServers.notion.enabled, undefined)
})

check('mcp generic config 可用于工具探活', () => {
  const list = cc.getCommandCodeMcpServers()
  const g = cc.getCommandCodeMcpConfigFor(list.find((s) => s.name === 'playwright'))
  assert.strictEqual(g.type, 'stdio')
  assert.strictEqual(g.command, 'npx')
})

check('mcp 保留未知字段', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf-8'))
  doc.mcpServers.notion.oauth = { clientId: 'x' }
  fs.writeFileSync(path.join(tmp, 'mcp.json'), JSON.stringify(doc))
  cc.setCommandCodeMcpEnabled('notion', false)
  cc.setCommandCodeMcpEnabled('notion', true)
  const after = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp.json'), 'utf-8'))
  assert.deepStrictEqual(after.mcpServers.notion.oauth, { clientId: 'x' }, 'oauth 等未知字段应保留')
})

// ==================== Skill ====================
check('skill 启停 .disabled 往返', () => {
  const dir = cc.getCommandCodeSkillsDir()
  const skillDir = path.join(dir, 'code-review')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: code-review\ndescription: d\n---\nbody\n')
  let list = cc.getCommandCodeSkills()
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].disabled, false)
  assert.ok(list[0].frontmatter.includes('name: code-review'))

  assert.deepStrictEqual(cc.setCommandCodeSkillEnabled('code-review', false), { success: true })
  assert.ok(fs.existsSync(path.join(dir, '.disabled', 'code-review')), '应移入 .disabled')
  list = cc.getCommandCodeSkills()
  assert.strictEqual(list[0].disabled, true)

  assert.deepStrictEqual(cc.setCommandCodeSkillEnabled('code-review', true), { success: true })
  assert.ok(fs.existsSync(path.join(dir, 'code-review')), '应移回')
})

// ==================== Taste ====================
const projRoot = path.join(tmp, 'proj')
check('taste 初始化 + 内联写入', () => {
  cc.initCommandCodeTaste('project', projRoot)
  cc.addCommandCodeTasteEntry('project', projRoot, 'javascript', 'Use const instead of let. Confidence: 0.90', 0.9)
  const pkgs = cc.getCommandCodeTastePackages(projRoot)
  assert.strictEqual(pkgs.project.exists, true)
  assert.strictEqual(pkgs.project.categories.length, 1)
  assert.strictEqual(pkgs.project.categories[0].name, 'javascript')
  assert.strictEqual(pkgs.project.categories[0].entries.length, 1)
  assert.strictEqual(pkgs.project.categories[0].entries[0].confidence, 0.9)
  assert.strictEqual(pkgs.project.categories[0].inline, true)
})

check('taste 超过 5 条自动拆子文件', () => {
  // 已有 1 条，加到第 6 条触发拆分
  for (let i = 0; i < 5; i++) {
    cc.addCommandCodeTasteEntry('project', projRoot, 'javascript', `Rule number ${i}`, 0.8)
  }
  const root = path.join(projRoot, '.commandcode', 'taste')
  assert.ok(fs.existsSync(path.join(root, 'javascript', 'taste.md')), '第 6 条应拆到子文件')
  const main = fs.readFileSync(path.join(root, 'taste.md'), 'utf-8')
  assert.ok(main.includes('See [javascript/taste.md]'), '主档应留引用')
  // 再读应合并回来
  const pkgs = cc.getCommandCodeTastePackages(projRoot)
  assert.strictEqual(pkgs.project.categories[0].entries.length, 6)
  assert.strictEqual(pkgs.project.categories[0].inline, false)
})

check('taste 删回 5 条并回主档', () => {
  cc.deleteCommandCodeTasteEntry('project', projRoot, 'javascript', 0)
  const root = path.join(projRoot, '.commandcode', 'taste')
  assert.ok(!fs.existsSync(path.join(root, 'javascript', 'taste.md')), '子文件应删除')
  const main = fs.readFileSync(path.join(root, 'taste.md'), 'utf-8')
  assert.ok(!main.includes('See ['), '主档不应再有引用')
  const pkgs = cc.getCommandCodeTastePackages(projRoot)
  assert.strictEqual(pkgs.project.categories[0].entries.length, 5)
  assert.strictEqual(pkgs.project.categories[0].inline, true)
})

check('taste 校验：非法置信度拒绝', () => {
  assert.throws(() => cc.addCommandCodeTasteEntry('project', projRoot, 'javascript', 'bad', 5))
  assert.throws(() => cc.addCommandCodeTasteEntry('project', projRoot, 'javascript', 'neg', -1))
})

check('taste 校验：空文本拒绝', () => {
  assert.throws(() => cc.addCommandCodeTasteEntry('project', projRoot, 'javascript', '   ', 0.5))
})

check('taste 分类重名拒绝', () => {
  assert.throws(() => cc.addCommandCodeTasteCategory('project', projRoot, 'javascript'))
})

check('taste 汇总与去重', () => {
  // 全局包里放一条与项目包相同的偏好
  cc.initCommandCodeTaste('global', null)
  cc.addCommandCodeTasteEntry('global', null, 'js', 'Rule number 1', 0.7)
  // 再加一条高置信度，覆盖 high 桶
  cc.addCommandCodeTasteEntry('global', null, 'js', 'Always run the tests', 0.95)
  const sum = cc.getCommandCodeTasteSummary(projRoot)
  assert.strictEqual(sum.scopes.project.categories, 1)
  assert.ok(sum.scopes.global.entries >= 1)
  assert.ok(sum.buckets.high >= 1, '高置信度桶应有条目')
  const dup = sum.duplicates.find((d) => d.text === 'Rule number 1')
  assert.ok(dup, '跨包重复偏好应被识别')
  assert.deepStrictEqual(dup.scopes.sort(), ['global', 'project'])
})

check('taste 编辑条目', () => {
  cc.updateCommandCodeTasteEntry('project', projRoot, 'javascript', 0, { text: 'Renamed rule', confidence: 0.95 })
  const pkgs = cc.getCommandCodeTastePackages(projRoot)
  assert.strictEqual(pkgs.project.categories[0].entries[0].text, 'Renamed rule')
  assert.strictEqual(pkgs.project.categories[0].entries[0].confidence, 0.95)
})

check('taste 删除分类并清子目录', () => {
  for (let i = 0; i < 6; i++) cc.addCommandCodeTasteEntry('project', projRoot, 'python', `Py rule ${i}`, 0.8)
  const root = path.join(projRoot, '.commandcode', 'taste')
  assert.ok(fs.existsSync(path.join(root, 'python', 'taste.md')))
  cc.deleteCommandCodeTasteCategory('project', projRoot, 'python')
  assert.ok(!fs.existsSync(path.join(root, 'python')), '分类目录应删除')
})

check('未选项目目录时读取不抛错（页面首屏）', () => {
  const pkgs = cc.getCommandCodeTastePackages(undefined)
  assert.strictEqual(pkgs.project.exists, false)
  assert.deepStrictEqual(pkgs.project.categories, [])
  assert.strictEqual(pkgs.project.root, '')
  assert.strictEqual(pkgs.global.exists, true, '全局包仍应正常读取')
  const sum = cc.getCommandCodeTasteSummary(undefined)
  assert.strictEqual(sum.scopes.project.entries, 0)
  // 写路径仍然要报错（不能默默写到错误位置）
  assert.throws(() => cc.addCommandCodeTasteCategory('project', undefined, 'x'))
})

// ==================== 项目发现 ====================
check('listCommandCodeProjects 从会话首行 cwd 还原真实路径', () => {
  const projectsDir = path.join(tmp, 'projects')
  const slug = 'users-shane-documents-git-hub-demo-app'
  const dir = path.join(projectsDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  // slug 是有损编码，真实路径只在会话首行
  const realRoot = path.join(tmp, 'demo-app')
  fs.mkdirSync(realRoot, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session-1.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-10-28T09:00:00.000Z', cwd: realRoot }) + '\n' +
    JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user' } }) + '\n',
  )
  // 回滚点文件不应被当成会话
  fs.writeFileSync(path.join(dir, 'session-1.checkpoints.jsonl'), '{"id":"x"}\n')

  const list = cc.listCommandCodeProjects()
  const found = list.find((p) => p.slug === slug)
  assert.ok(found, '应发现该 slug 项目')
  assert.strictEqual(found.root, realRoot, 'root 应来自会话 cwd 而非 slug')
  assert.strictEqual(found.name, 'demo-app')
  assert.strictEqual(found.hasTaste, false)
})

check('项目发现：cwd 已失效的项目被跳过', () => {
  const projectsDir = path.join(tmp, 'projects')
  const slug = 'gone-project'
  const dir = path.join(projectsDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  const goneRoot = path.join(tmp, 'already-deleted-dir')
  fs.writeFileSync(
    path.join(dir, 'session-1.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 's2', cwd: goneRoot }) + '\n',
  )
  assert.ok(!cc.listCommandCodeProjects().some((p) => p.slug === slug), '目录已不存在的项目不应列出')
})

check('项目发现：首行非 session 头时退化为 slug 目录且不抛错', () => {
  const projectsDir = path.join(tmp, 'projects')
  const slug = 'broken-project'
  const dir = path.join(projectsDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session-1.jsonl'), '{"type":"message"}\n')
  const list = cc.listCommandCodeProjects()
  const found = list.find((p) => p.slug === slug)
  assert.ok(found, '读不出 cwd 也要能列出（用 slug 目录兜底）')
  assert.ok(found.root.endsWith(slug))
})

check('项目发现：hasTaste 跟随 .commandcode/taste/taste.md', () => {
  const projectRoot = path.join(tmp, 'taste-demo')
  fs.mkdirSync(projectRoot, { recursive: true })
  cc.initCommandCodeTaste('project', projectRoot)
  const slug = 'taste-demo-slug'
  const dir = path.join(tmp, 'projects', slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session-1.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id: 's3', cwd: projectRoot }) + '\n',
  )
  const found = cc.listCommandCodeProjects().find((p) => p.slug === slug)
  assert.strictEqual(found.hasTaste, true, '已有 taste.md 的项目应标记 hasTaste')
})

// ==================== 损坏文件 ====================
check('providers.json 损坏时抛错而不是清空', () => {
  fs.writeFileSync(path.join(tmp, 'providers.json'), '{ broken')
  assert.throws(() => cc.getCommandCodeProviderList())
})

check('auth.json 损坏时抛错（保护登录态）', () => {
  fs.writeFileSync(path.join(tmp, 'auth.json'), 'not-json')
  assert.throws(() => cc.readAuthDoc())
})

// ==================== 输出 ====================
const failed = results.filter(([s]) => s === 'FAIL')
for (const [s, name] of results) console.log(`${s === 'PASS' ? '✓' : '✗'} ${name}`)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
