// 通用 Skill 场景冒烟测试：node tests/smoke-skill-scenes-test.cjs（仓库根目录运行）
// 验证：
//   1. 场景 CRUD（新建 / 重名与非法名拒绝 / 删除）
//   2. 切换场景 = 绑定的启用、未绑定的移入 .disabled；切回手动模式不动目录
//   3. 手动启停同步当前场景绑定；删除 Skill 从场景绑定里清理
//   4. 场景指令动态注册（cmds 同时含中英文），最后一个场景删除后移除功能
//   5. 绑定但未安装的 Skill 记入 missing
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ==================== 最小 uTools 环境（临时 home + 内存 DB + 功能注册表） ====================
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-skill-scene-'))
const skillsDir = path.join(home, '.agents', 'skills')
const disabledDir = path.join(home, '.agents', '.disabled')

for (const name of ['alpha', 'beta', 'gamma']) {
  const dir = path.join(skillsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
    'utf-8',
  )
}

const store = new Map()
let rev = 0
const features = new Map()
global.window = {
  utools: {
    getPath: () => home,
    getNativeId: () => 'test-native',
    db: {
      get: (id) => {
        const doc = store.get(String(id))
        return doc ? JSON.parse(JSON.stringify(doc)) : null
      },
      put: (doc) => {
        if (!doc || !doc._id) return { error: true, message: 'bad doc' }
        const cur = store.get(doc._id)
        if (cur && cur._rev && doc._rev !== cur._rev) return { error: true, message: 'conflict' }
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
    },
    setFeature: (feature) => features.set(feature.code, feature),
    removeFeature: (code) => features.delete(code),
    shellOpenPath: () => {},
  },
}

const common = require('../public/preload/services/common')
require('../public/preload/services/commands')

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}
const enabled = (name) => fs.existsSync(path.join(skillsDir, name, 'SKILL.md'))
const disabled = (name) => fs.existsSync(path.join(disabledDir, name, 'SKILL.md'))
const sceneFeature = () => features.get('switchSkillScene')

console.log('1. 初始状态')
ok(common.getSkillScenes().scenes.length === 0, '没有场景')
ok(common.getSkillScenes().activeId === '', 'activeId 为空')
ok(enabled('alpha') && enabled('beta') && enabled('gamma'), '三个 Skill 默认启用')

console.log('\n2. 新建场景与指令注册')
const created = common.saveSkillScene({ name: '写作', skillDirs: ['alpha'] })
const sceneId = created.scene.id
ok(!!sceneId, '场景已创建')
ok(common.getSkillScenes().scenes.length === 1, '场景列表有 1 条')
const feature = sceneFeature()
ok(!!feature, '注册了场景指令')
ok(feature && feature.cmds.includes('场景：写作'), '指令含中文场景名')
ok(feature && feature.cmds.includes('Scene: 写作'), '指令含英文场景名')
ok(feature && !feature.cmds.includes('场景：关闭'), '不再注册手动 / 关闭入口')

console.log('\n3. 切换场景只启用绑定的 Skill')
const switched = common.switchSkillScene(sceneId)
ok(common.getSkillScenes().activeId === sceneId, 'activeId 指向场景')
ok(enabled('alpha'), '绑定项 alpha 启用')
ok(disabled('beta') && disabled('gamma'), '未绑定项 beta/gamma 移入 .disabled')
ok(switched.applied.enabled.length === 1, '返回启用列表')
ok(switched.applied.disabled.length === 2, '返回禁用列表')

console.log('\n4. 清空当前场景（删除场景 / 旧数据兜底）不动目录')
common.switchSkillScene('')
ok(common.getSkillScenes().activeId === '', 'activeId 清空')
ok(enabled('alpha') && disabled('beta') && disabled('gamma'), '目录状态保持不变')

console.log('\n5. 手动启停同步当前场景绑定')
common.switchSkillScene(sceneId)
common.setCommonSkillEnabled('beta', true)
let scene = common.getSkillScenes().scenes[0]
ok(enabled('beta'), 'beta 手动启用')
ok(scene.skillDirs.includes('beta'), '绑定自动加入 beta')
common.setCommonSkillEnabled('alpha', false)
scene = common.getSkillScenes().scenes[0]
ok(disabled('alpha'), 'alpha 手动禁用')
ok(!scene.skillDirs.includes('alpha'), '绑定自动移除 alpha')

console.log('\n6. 删除 Skill 清理绑定')
ok(common.deleteCommonSkill('beta').success, '删除 beta')
scene = common.getSkillScenes().scenes[0]
ok(!scene.skillDirs.includes('beta'), '绑定里不再有 beta')
ok(!fs.existsSync(path.join(skillsDir, 'beta')), 'beta 目录已删除')

console.log('\n7. 名称校验')
let dupError = ''
try { common.saveSkillScene({ name: '写作', skillDirs: [] }) } catch (e) { dupError = e.message }
ok(/写作/.test(dupError), '重名被拒绝')
let reservedError = ''
try { common.saveSkillScene({ name: '手动', skillDirs: [] }) } catch (e) { reservedError = e.message }
ok(!!reservedError, '保留名「手动」被拒绝')

console.log('\n8. 绑定但未安装的 Skill 记入 missing')
const ghost = common.saveSkillScene({ name: '缺件', skillDirs: ['ghost'] })
const ghostSwitch = common.switchSkillScene(ghost.scene.id)
ok(ghostSwitch.applied.missing.includes('ghost'), 'missing 包含 ghost')

console.log('\n9. 删除场景与指令回收')
ok(common.deleteSkillScene(ghost.scene.id).success, '删除第二个场景')
ok(common.deleteSkillScene(sceneId).success, '删除第一个场景')
ok(common.getSkillScenes().scenes.length === 0, '场景列表清空')
ok(!sceneFeature(), '没有场景时移除动态指令')

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
fs.rmSync(home, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
