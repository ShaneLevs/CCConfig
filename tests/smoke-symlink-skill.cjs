// 软链接 Skill 冒烟测试：node tests/smoke-symlink-skill.cjs（仓库根目录运行）
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
//
// 背景：fs.readdirSync(..., { withFileTypes: true }) 的 Dirent.isDirectory() 对符号链接
// 恒为 false，所以「用软链挂载 Skill」的目录原本会被整条跳过。本测试锁住以下行为：
//   1. 通用 / Claude / OpenCode / Grok / Cline / Command Code 六个视图都能列到软链 Skill
//   2. 软链 Skill 的 fileCount 正常（走 countEntries，不吃 .DS_Store）
//   3. 启停（移动到 skills 同级的 .disabled）移动的是链接本身，源目录不受影响
//   4. 通用 Skill 场景可以正常启用 / 禁用软链 Skill
//   5. 删除软链 Skill 只删链接，绝不递归删掉源目录
//   6. 断链（指向已不存在的目标）不会让扫描整个崩掉，只是不显示
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-symlink-'))
const links = path.join(home, 'mounts') // 软链接的目标目录放在另一个位置，模拟 dotfiles / ego
fs.mkdirSync(links, { recursive: true })

// ---- 最小 uTools 环境（临时 home + 内存 DB + 功能注册表） ----
const store = new Map()
let rev = 0
const features = new Map()
global.window = {
  utools: {
    getPath: () => home,
    getPathForFile: () => home,
    getNativeId: () => 'test-native',
    db: {
      get: (id) => {
        const doc = store.get(String(id))
        return doc ? JSON.parse(JSON.stringify(doc)) : null
      },
      put: (doc) => {
        if (!doc || !doc._id) return { error: true, message: 'bad doc' }
        const cur = store.get(doc._id)
        if (cur && cur._rev && doc._rev !== cur._rev)
          return { error: true, message: 'conflict' }
        store.set(doc._id, { ...JSON.parse(JSON.stringify(doc)), _rev: `${++rev}-fake` })
        return { ok: true, id: doc._id }
      },
      remove: (doc, maybeRev) => {
        const id = doc && typeof doc === 'object' ? doc._id : doc
        const r = doc && typeof doc === 'object' ? doc._rev : maybeRev
        const cur = store.get(String(id))
        if (!cur) return { error: true, message: 'not_found' }
        if (r && cur._rev !== r) return { error: true, message: 'conflict' }
        store.delete(String(id))
        return { ok: true }
      },
      allDocs: () => Array.from(store.values()),
      bulkDocs: () => [],
    },
    setFeature: (feature) => features.set(feature.code, feature),
    removeFeature: (code) => features.delete(code),
    shellOpenPath: () => {},
    isMacOS: () => false,
    isWindows: () => false,
    isLinux: () => true,
  },
}

// 各 agent 的 skill 根目录都重定向到临时目录（env 优先，不会碰真实 home）
const claudeSkills = path.join(home, '.claude', 'skills')
const grokHome = path.join(home, '.grok')
const clineDir = path.join(home, '.cline')
const ccHome = path.join(home, '.commandcode')
const opencodeDir = path.join(home, '.config', 'opencode')
process.env.GROK_HOME = grokHome
process.env.CLINE_DIR = clineDir
process.env.CLINE_DATA_DIR = path.join(clineDir, 'data')
process.env.COMMANDCODE_HOME = ccHome
process.env.CCCONFIG_LOCALE = 'zh-CN'

const common = require('../public/preload/services/common')
const skills = require('../public/preload/services/skills')
const opencode = require('../public/preload/services/opencode')
const grok = require('../public/preload/services/grok')
const cline = require('../public/preload/services/cline')
const commandCode = require('../public/preload/services/command-code')
const { isDirEntry, countEntries, rmEntry } = require('../public/preload/services/fs-utils')
require('../public/preload/services/commands')

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

// 造一个软链挂载的 Skill：真身在 mounts/<name>，技能根目录里放一个指向它的链接
const mountSkill = (root, name) => {
  const src = path.join(links, name)
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(
    path.join(src, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} mounted by symlink\n---\n`,
    'utf-8',
  )
  fs.writeFileSync(path.join(src, 'helper.js'), 'module.exports = 1\n', 'utf-8')
  fs.mkdirSync(root, { recursive: true })
  const link = path.join(root, name)
  if (fs.existsSync(link)) fs.unlinkSync(link)
  fs.symlinkSync(src, link, 'dir')
  return { src, link }
}

// 造一个普通（非软链）Skill，作为对照
const plainSkill = (root, name) => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} plain dir\n---\n`,
    'utf-8',
  )
  return dir
}

const find = (list, name) => list.find((s) => (s.dirName || s.name) === name)

// ==================== 1. fs-utils 基础 ====================
console.log('1. fs-utils 跟随软链、删除只删链接')
{
  const root = path.join(home, 'unit')
  const { src, link } = mountSkill(root, 'unit-skill')
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const entry = entries.find((e) => e.name === 'unit-skill')
  ok(entry.isDirectory() === false, 'Dirent.isDirectory() 对软链返回 false（前置事实）')
  ok(isDirEntry(root, entry) === true, 'isDirEntry 跟随软链判为目录')
  ok(countEntries(link) === 2, 'countEntries 穿透软链计数', String(countEntries(link)))
  fs.writeFileSync(path.join(link, '.DS_Store'), 'junk', 'utf-8')
  ok(countEntries(link) === 2, 'countEntries 不吃 .DS_Store', String(countEntries(link)))
  rmEntry(link)
  ok(!fs.existsSync(link), 'rmEntry 删掉了链接')
  ok(fs.existsSync(path.join(src, 'SKILL.md')), 'rmEntry 没有动源目录')
}

// ==================== 2. 通用 Skill（~/.agents/skills） ====================
console.log('\n2. 通用 Skill 能列到软链条目')
const commonRoot = path.join(home, '.agents', 'skills')
const commonMounted = mountSkill(commonRoot, 'ego-browser')
plainSkill(commonRoot, 'shadcn')
{
  const list = common.readCommonSkills()
  ok(!!find(list, 'ego-browser'), '列出软链 Skill ego-browser')
  ok(!!find(list, 'shadcn'), '列出普通 Skill shadcn')
  const ego = find(list, 'ego-browser')
  ok(ego && ego.fileCount === 2, '软链 Skill 的 fileCount 正确', ego && String(ego.fileCount))
  ok(ego && ego.enabled === true, '软链 Skill 默认启用')
}

// ==================== 3. 断链不影响扫描 ====================
console.log('\n3. 断链不会拖垮整个扫描')
{
  const brokenRoot = path.join(home, 'broken')
  fs.mkdirSync(brokenRoot, { recursive: true })
  fs.symlinkSync(path.join(home, 'not-exists'), path.join(brokenRoot, 'ghost'), 'dir')
  const list = common.readCommonSkills() // 不崩即可
  ok(Array.isArray(list), '断链场景下通用 Skill 扫描仍返回数组')
  ok(!find(list, 'ghost'), '断链条目不出现在列表里')
  fs.unlinkSync(path.join(brokenRoot, 'ghost'))
}

// ==================== 4. 通用 Skill 启停 / 场景 / 删除 ====================
console.log('\n4. 通用 Skill 启停只移动链接')
{
  const res = common.setCommonSkillEnabled('ego-browser', false)
  ok(res.success, '禁用软链 Skill 成功', res.error)
  const disabledLink = path.join(home, '.agents', '.disabled', 'ego-browser')
  ok(fs.existsSync(disabledLink), '链接已移入 skills 同级的 .disabled')
  ok(!fs.existsSync(path.join(commonRoot, '.disabled')), 'skills 根目录内不再有 .disabled 子目录')
  ok(
    fs.lstatSync(disabledLink).isSymbolicLink(),
    '.disabled 里仍然是符号链接（没被复制成实体目录）',
  )
  ok(fs.existsSync(path.join(commonMounted.src, 'SKILL.md')), '源目录不受影响')
  const afterDisable = common.readCommonSkills()
  ok(find(afterDisable, 'ego-browser').enabled === false, '禁用后列表里标记为 disabled')

  ok(common.setCommonSkillEnabled('ego-browser', true).success, '重新启用成功')
  ok(
    fs.lstatSync(path.join(commonRoot, 'ego-browser')).isSymbolicLink(),
    '回到根目录后仍是链接',
  )
}

console.log('\n5. 场景能绑定软链 Skill')
{
  const scene = common.saveSkillScene({ name: '挂载测试', skillDirs: ['ego-browser'] })
  const applied = common.switchSkillScene(scene.scene.id)
  ok(applied.applied.enabled.includes('ego-browser'), '场景启用软链 Skill')
  ok(applied.applied.disabled.includes('shadcn'), '场景禁用未绑定的普通 Skill')
  ok(applied.applied.missing.length === 0, '没有 missing 项', JSON.stringify(applied.applied.missing))
  ok(fs.existsSync(path.join(commonMounted.src, 'SKILL.md')), '切场景后源目录仍完好')
  common.deleteSkillScene(scene.scene.id)
  ok(common.getSkillScenes().scenes.length === 0, '场景已清理')
}

console.log('\n6. 删除软链 Skill 只删链接')
{
  const res = common.deleteCommonSkill('ego-browser')
  ok(res.success, '删除软链 Skill 成功', res.error)
  ok(!fs.existsSync(path.join(commonRoot, 'ego-browser')), '链接已消失')
  ok(
    fs.existsSync(path.join(commonMounted.src, 'SKILL.md')) &&
      fs.existsSync(path.join(commonMounted.src, 'helper.js')),
    '源目录内容完好（未被递归删除）',
  )
}

// ==================== 5. Claude Skill ====================
console.log('\n7. Claude Skill 能列到软链条目')
const claudeMounted = mountSkill(claudeSkills, 'mounted-claude')
plainSkill(claudeSkills, 'plain-claude')
{
  const list = skills.getSkills()
  ok(!!find(list, 'mounted-claude'), '列出软链 Claude Skill')
  ok(!!find(list, 'plain-claude'), '列出普通 Claude Skill')
  const m = find(list, 'mounted-claude')
  ok(m && m.fileCount === 2, '软链 Claude Skill fileCount 正确', m && String(m.fileCount))

  ok(skills.disableSkill('mounted-claude').success, '禁用软链 Claude Skill')
  ok(
    fs.lstatSync(path.join(home, '.claude', '.disabled', 'mounted-claude')).isSymbolicLink(),
    '.disabled 里仍是链接',
  )
  ok(fs.existsSync(path.join(claudeMounted.src, 'SKILL.md')), '源目录不受影响')
  ok(skills.enableSkill('mounted-claude').success, '重新启用成功')

  ok(skills.deleteSkill('mounted-claude', false).success, '删除软链 Claude Skill')
  ok(fs.existsSync(path.join(claudeMounted.src, 'SKILL.md')), 'Claude 源目录完好')
}

// ==================== 6. OpenCode ====================
console.log('\n8. OpenCode Skill')
{
  const root = opencode.getOpencodeSkillsPath()
  const mounted = mountSkill(root, 'mounted-opencode')
  plainSkill(root, 'plain-opencode')
  let list = opencode.getOpencodeSkills()
  ok(!!find(list, 'mounted-opencode'), '列出软链 OpenCode Skill')
  const m = find(list, 'mounted-opencode')
  ok(m && m.fileCount === 2, '软链 OpenCode Skill fileCount 正确', m && String(m.fileCount))
  ok(opencode.deleteOpencodeSkill('mounted-opencode').success, '删除软链 OpenCode Skill')
  ok(fs.existsSync(path.join(mounted.src, 'SKILL.md')), 'OpenCode 源目录完好')
}

// ==================== 7. Grok ====================
console.log('\n9. Grok Skill')
{
  const root = grok.getGrokSkillsDir()
  const mounted = mountSkill(root, 'mounted-grok')
  plainSkill(root, 'plain-grok')
  let list = grok.getGrokSkills()
  ok(!!find(list, 'mounted-grok'), '列出软链 Grok Skill')
  const m = find(list, 'mounted-grok')
  ok(m && m.fileCount === 2, '软链 Grok Skill fileCount 正确', m && String(m.fileCount))
  ok(grok.setGrokSkillEnabled('mounted-grok', false).success, '禁用软链 Grok Skill')
  ok(
    fs.lstatSync(path.join(grokHome, '.disabled', 'mounted-grok')).isSymbolicLink(),
    '.disabled 里仍是链接',
  )
  ok(fs.existsSync(path.join(mounted.src, 'SKILL.md')), '源目录不受影响')
  ok(grok.deleteGrokSkill('mounted-grok', true).success, '删除已禁用的软链 Grok Skill')
  ok(fs.existsSync(path.join(mounted.src, 'SKILL.md')), 'Grok 源目录完好')
}

// ==================== 8. Cline ====================
console.log('\n10. Cline Skill')
{
  const root = cline.getClineSkillsDir()
  const mounted = mountSkill(root, 'mounted-cline')
  plainSkill(root, 'plain-cline')
  const list = cline.getClineSkills()
  ok(!!find(list, 'mounted-cline'), '列出软链 Cline Skill')
  const m = find(list, 'mounted-cline')
  ok(m && m.fileCount === 2, '软链 Cline Skill fileCount 正确', m && String(m.fileCount))
  ok(cline.setClineSkillEnabled('mounted-cline', false).success, '禁用软链 Cline Skill')
  ok(fs.existsSync(path.join(mounted.src, 'SKILL.md')), '源目录不受影响')
  ok(cline.deleteClineSkill('mounted-cline', true).success, '删除软链 Cline Skill')
  ok(fs.existsSync(path.join(mounted.src, 'SKILL.md')), 'Cline 源目录完好')
}

// ==================== 9. Command Code ====================
console.log('\n11. Command Code Skill')
{
  const root = commandCode.getCommandCodeSkillsDir()
  const mounted = mountSkill(root, 'mounted-cc')
  plainSkill(root, 'plain-cc')
  const list = commandCode.getCommandCodeSkills()
  ok(!!find(list, 'mounted-cc'), '列出软链 Command Code Skill')
  const m = find(list, 'mounted-cc')
  ok(m && m.fileCount === 2, '软链 Command Code Skill fileCount 正确', m && String(m.fileCount))
  ok(commandCode.setCommandCodeSkillEnabled('mounted-cc', false).success, '禁用软链 Command Code Skill')
  ok(fs.existsSync(path.join(mounted.src, 'SKILL.md')), '源目录不受影响')
  ok(commandCode.deleteCommandCodeSkill('mounted-cc', true).success, '删除软链 Command Code Skill')
  ok(fs.existsSync(path.join(mounted.src, 'SKILL.md')), 'Command Code 源目录完好')
}

// ==================== 收尾 ====================
if (failed === 0) {
  fs.rmSync(home, { recursive: true, force: true })
} else {
  console.log(`\n保留现场：${home}`)
}

console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed) {
  console.error(`失败 ${failed} 项`)
  process.exit(1)
}
