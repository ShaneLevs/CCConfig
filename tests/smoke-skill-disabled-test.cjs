// 停用 Skill 目录（skill-disabled.js）冒烟测试：node tests/smoke-skill-disabled-test.cjs
// 放在 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
//
// 锁住的行为：
//   1. 停用目录在 skills 根目录的同级（Agent 递归扫描 <root>/skills 时看不到）
//   2. 启停往返、名称校验
//   3. 旧版 <root>/.disabled 自动迁移（含同名冲突）
//   4. 软链只移动链接本身；断链也能启停
//   5. 跨卷（rename 报 EXDEV）退化为复制 + 删源，内部软链保持为链接
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-skill-disabled-'))
const root = path.join(home, '.agents', 'skills')
const store = path.join(home, '.agents', '.disabled')
process.env.CCCONFIG_LOCALE = 'zh-CN'

const helper = require('../public/preload/services/skill-disabled')

let passed = 0
let failed = 0
const ok = (cond, name, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}${detail ? `（${detail}）` : ''}`) }
}

const plainSkill = (base, name) => {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf-8')
  return dir
}

// 模拟 Agent 的递归扫描：找出目录树下所有 SKILL.md
const findSkillMds = (dir) => {
  const out = []
  const walk = (d) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isSymbolicLink()) {
        // 只关心指向真实目录的链接
        try { if (fs.statSync(p).isDirectory()) walk(p) } catch { /* 断链忽略 */ }
      } else if (e.name === 'SKILL.md') out.push(p)
    }
  }
  walk(dir)
  return out
}

console.log('1. 路径与启停往返')
{
  plainSkill(root, 'alpha')
  const eq = helper.setSkillEnabled(root, 'alpha', false)
  ok(eq.success, '停用成功', eq.error)
  ok(fs.existsSync(path.join(store, 'alpha', 'SKILL.md')), '目录移到 skills 同级 .disabled')
  ok(!fs.existsSync(path.join(root, '.disabled')), 'skills 根目录内没有 .disabled')
  ok(!findSkillMds(root).some((p) => p.includes('.disabled')), '递归扫描 skills 根目录看不到停用项')
  ok(helper.setSkillEnabled(root, 'alpha', true).success, '启用成功')
  ok(fs.existsSync(path.join(root, 'alpha', 'SKILL.md')), '目录移回 skills 根目录')
  ok(helper.setSkillEnabled(root, 'ghost', true).success === false, '不存在的 Skill 返回失败')
  ok(helper.setSkillEnabled(root, '../evil', false).success === false, '路径穿越被拒绝')
  ok(helper.setSkillEnabled(root, '.disabled', false).success === false, '停用目录名本身被拒绝')
}

console.log('\n2. 旧版 <root>/.disabled 迁移')
{
  plainSkill(root, 'beta')
  const legacy = path.join(root, '.disabled')
  fs.mkdirSync(legacy, { recursive: true })
  fs.renameSync(path.join(root, 'beta'), path.join(legacy, 'beta'))
  ok(fs.existsSync(path.join(legacy, 'beta', 'SKILL.md')), '前置：旧位置有条目')
  ok(helper.listDisabledSkillNames(root).includes('beta'), '扫描时自动迁移并列出')
  ok(fs.existsSync(path.join(store, 'beta', 'SKILL.md')), '条目已在新位置')
  ok(!fs.existsSync(legacy), '旧目录已清空移除')
  ok(helper.setSkillEnabled(root, 'beta', true).success, '迁移后可以直接启用')
  ok(fs.existsSync(path.join(root, 'beta', 'SKILL.md')), '启用后回到 skills 根目录')
  fs.rmSync(path.join(root, 'beta'), { recursive: true, force: true })
}

console.log('\n3. 迁移遇到同名冲突')
{
  const legacy = path.join(root, '.disabled')
  plainSkill(legacy, 'gamma')
  plainSkill(store, 'gamma')
  fs.writeFileSync(path.join(store, 'gamma', 'marker'), 'new', 'utf-8')
  helper.migrateDisabledSkills(root)
  ok(fs.existsSync(path.join(store, 'gamma', 'marker')), '新位置同名条目保持不变')
  const dupRoot = path.join(store, '.duplicates')
  const dups = fs.existsSync(dupRoot) ? fs.readdirSync(dupRoot) : []
  ok(dups.some((n) => n.startsWith('gamma-')), '旧副本移到 .duplicates（不丢数据）', dups.join(','))
  fs.rmSync(path.join(store, 'gamma'), { recursive: true, force: true })
  fs.rmSync(dupRoot, { recursive: true, force: true })
}

console.log('\n4. 软链与断链')
{
  const target = plainSkill(path.join(home, 'mounts'), 'linked')
  fs.symlinkSync(target, path.join(root, 'linked'), 'dir')
  ok(helper.setSkillEnabled(root, 'linked', false).success, '停用软链 Skill')
  const moved = path.join(store, 'linked')
  ok(fs.lstatSync(moved).isSymbolicLink(), '移动的是链接本身')
  ok(fs.existsSync(path.join(target, 'SKILL.md')), '源目录不受影响')
  ok(helper.setSkillEnabled(root, 'linked', true).success, '启用软链 Skill')
  ok(fs.lstatSync(path.join(root, 'linked')).isSymbolicLink(), '回到根目录仍是链接')
  fs.unlinkSync(path.join(root, 'linked'))

  fs.symlinkSync(path.join(home, 'gone'), path.join(root, 'broken'), 'dir')
  ok(helper.pathExists(path.join(root, 'broken')), '断链仍被 lstat 识别为存在')
  ok(helper.setSkillEnabled(root, 'broken', false).success, '断链也能停用')
  ok(fs.lstatSync(path.join(store, 'broken')).isSymbolicLink(), '断链按链接移入')
  ok(helper.setSkillEnabled(root, 'broken', true).success, '断链也能启用')
  fs.unlinkSync(path.join(root, 'broken'))
}

console.log('\n5. 跨卷回退（EXDEV）')
{
  const src = plainSkill(root, 'cross')
  const nestedTarget = path.join(home, 'nested-target')
  fs.mkdirSync(nestedTarget, { recursive: true })
  fs.symlinkSync(nestedTarget, path.join(src, 'nested-link'), 'dir')

  const realRename = fs.renameSync
  fs.renameSync = () => {
    const err = new Error('EXDEV: cross-device link not permitted')
    err.code = 'EXDEV'
    throw err
  }
  let result
  try {
    result = helper.setSkillEnabled(root, 'cross', false)
  } finally {
    fs.renameSync = realRename
  }
  ok(result.success, 'EXDEV 时退化为复制成功', result.error)
  ok(!fs.existsSync(path.join(root, 'cross')), '源目录已删除')
  ok(fs.existsSync(path.join(store, 'cross', 'SKILL.md')), '目标目录内容完整')
  ok(fs.lstatSync(path.join(store, 'cross', 'nested-link')).isSymbolicLink(), '内部软链保持为链接')
  fs.rmSync(path.join(store, 'cross'), { recursive: true, force: true })
  fs.rmSync(nestedTarget, { recursive: true, force: true })
}

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
