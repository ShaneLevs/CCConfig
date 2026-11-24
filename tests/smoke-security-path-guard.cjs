// 路径穿越回归测试：所有技能删除/启停/安装入口都必须拒绝根目录外的名称与路径。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-path-guard-'))
const tempDir = path.join(home, 'tmp')
fs.mkdirSync(tempDir, { recursive: true })

const store = new Map()
global.window = {
  utools: {
    getPath: (name) => (name === 'temp' ? tempDir : home),
    getNativeId: () => 'path-guard-test',
    db: {
      get: (id) => store.get(String(id)) || null,
      put: (doc) => {
        store.set(String(doc._id), doc)
        return { ok: true, id: doc._id }
      },
      allDocs: () => [...store.values()],
    },
    isMacOS: () => false,
    isWindows: () => false,
    isLinux: () => true,
    shellOpenPath: () => {},
  },
}

process.env.CCCONFIG_LOCALE = 'zh-CN'
process.env.GROK_HOME = path.join(home, '.grok')
process.env.CLINE_DIR = path.join(home, '.cline')
process.env.CLINE_DATA_DIR = path.join(home, '.cline', 'data')
process.env.COMMANDCODE_HOME = path.join(home, '.commandcode')

const skills = require('../public/preload/services/skills')
const opencode = require('../public/preload/services/opencode')
const grok = require('../public/preload/services/grok')
const cline = require('../public/preload/services/cline')
const commandCode = require('../public/preload/services/command-code')
const common = require('../public/preload/services/common')
const skillsInstall = require('../public/preload/services/skills-install')
const { rmEntry } = require('../public/preload/services/fs-utils')
const { assertSkillName, assertPathInside } = require('../public/preload/services/path-guard')

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
const makeSkill = (root, name) => {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`, 'utf-8')
  return dir
}
const evilName = (root, outside) => path.relative(root, outside)

const outside = path.join(home, 'outside')
fs.mkdirSync(outside, { recursive: true })
fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep', 'utf-8')

console.log('1. path-guard 基础校验')
{
  for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', '.disabled', '']) {
    let rejected = false
    try { assertSkillName(bad) } catch { rejected = true }
    ok(rejected, `拒绝非法 Skill 名：${JSON.stringify(bad)}`)
  }
  ok(assertSkillName('good-skill_1.2') === 'good-skill_1.2', '接受合法 Skill 名')
  let rejected = false
  try { assertPathInside(path.join(home, '.claude', 'skills'), outside) } catch { rejected = true }
  ok(rejected, '拒绝根目录外路径')
}

console.log('2. Claude / OpenCode / Grok / Cline / Command Code / 通用删除')
{
  const cases = [
    ['claude', path.join(home, '.claude', 'skills'), (name) => skills.deleteSkill(name, false)],
    ['opencode', opencode.getOpencodeSkillsPath(), (name) => opencode.deleteOpencodeSkill(name)],
    ['grok', grok.getGrokSkillsDir(), (name) => grok.deleteGrokSkill(name, false)],
    ['cline', cline.getClineSkillsDir(), (name) => cline.deleteClineSkill(name, false)],
    ['commandcode', commandCode.getCommandCodeSkillsDir(), (name) => commandCode.deleteCommandCodeSkill(name, false)],
    ['common', common.COMMON_SKILLS_DIR(), (name) => common.deleteCommonSkill(name)],
  ]
  for (const [label, root, remove] of cases) {
    makeSkill(root, 'valid-skill')
    const result = remove(evilName(root, outside))
    ok(result && result.success === false, `${label} 拒绝越界删除`, result && result.error)
    ok(fs.existsSync(path.join(outside, 'keep.txt')), `${label} 未删除根目录外文件`)
    const valid = remove('valid-skill')
    ok(valid && valid.success === true, `${label} 合法删除仍可用`, valid && valid.error)
  }
}

console.log('3. 项目 Skill 路径必须已登记')
{
  const project = path.join(home, 'project-a')
  fs.mkdirSync(project, { recursive: true })
  makeSkill(path.join(project, '.claude', 'skills'), 'project-skill')
  const projectsDir = path.join(home, '.claude', 'projects', 'project-a')
  fs.mkdirSync(projectsDir, { recursive: true })
  fs.writeFileSync(path.join(projectsDir, 'session.jsonl'), JSON.stringify({ cwd: project }) + '\n', 'utf-8')

  skills.getSkills()
  const badProject = path.join(home, 'not-registered')
  fs.mkdirSync(badProject, { recursive: true })
  let result = skills.disableProjectSkill('project-skill', badProject)
  ok(result && result.success === false, '未登记项目路径被拒绝', result && result.error)
  ok(fs.existsSync(path.join(project, '.claude', 'skills', 'project-skill')), '合法项目 Skill 未被误删')

  result = skills.disableProjectSkill('project-skill', project)
  ok(result && result.success === true, '已登记项目可停用')
  result = skills.enableProjectSkill('project-skill', project)
  ok(result && result.success === true, '已登记项目可启用')
  result = skills.deleteProjectSkill('../../outside', project, false)
  ok(result && result.success === false, '项目 Skill 名称仍校验')
  result = skills.deleteProjectSkill('project-skill', project, false)
  ok(result && result.success === true, '已登记项目可删除')

  const projectB = path.join(home, 'project-b')
  fs.mkdirSync(projectB, { recursive: true })
  const projectsDirB = path.join(home, '.claude', 'projects', 'project-b')
  fs.mkdirSync(projectsDirB, { recursive: true })
  fs.writeFileSync(path.join(projectsDirB, 'session.jsonl'), JSON.stringify({ cwd: projectB }) + '\n', 'utf-8')
  fs.symlinkSync(outside, path.join(projectB, '.claude'), 'dir')
  skills.getSkills()
  result = skills.openProjectSkillsDir(projectB)
  ok(result && result.success === false, '拒绝 .claude 软链到项目外的目录')
}

console.log('4. rmEntry 根目录约束')
{
  const root = path.join(home, '.claude', 'skills')
  let rejected = false
  try { rmEntry(outside, { root }) } catch { rejected = true }
  ok(rejected, 'rmEntry 拒绝根目录外路径')
  ok(fs.existsSync(path.join(outside, 'keep.txt')), 'rmEntry 未删除根目录外文件')
}

console.log('5. 技能安装 completeInstall 校验')
{
  const extract = path.join(tempDir, 'ccconfig-skill-install', 'valid-skill')
  fs.mkdirSync(extract, { recursive: true })
  fs.writeFileSync(path.join(extract, 'SKILL.md'), '---\nname: valid-skill\n---\n', 'utf-8')
  let rejected = false
  try { skillsInstall.completeSkillInstall('../outside', extract) } catch { rejected = true }
  ok(rejected, 'completeSkillInstall 拒绝非法 skillName')
  rejected = false
  try { skillsInstall.completeSkillInstall('valid-skill', outside) } catch { rejected = true }
  ok(rejected, 'completeSkillInstall 拒绝 temp 目录外的 extractDir')
}

if (failed === 0) fs.rmSync(home, { recursive: true, force: true })
else console.log(`保留现场：${home}`)
console.log(`\n通过 ${passed} / ${passed + failed}`)
if (failed) process.exit(1)
