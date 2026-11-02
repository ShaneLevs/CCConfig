// skills.sh 安装冒烟测试：node tests/smoke-skills-sh-test.cjs（仓库根目录运行）
// 验证：
//   1. 输入识别（详情页链接 / npx skills add 命令）
//   2. 详情页 URL 解析（GitHub 来源 / site 来源）与安装命令解析
//   3. 详情页载荷解析（ld+json 名称与简介、RSC 里的安装命令）
//   4. 官方 npx 安装参数（非交互、全局、只写 ~/.agents/skills、--copy）
//   5. Node 版本门槛（>= 22.20.0）与目录名归一化（与 CLI 的 sanitizeName 一致）
// 不测联网与真实 npx 执行：command 拼装、版本判断、解析逻辑保持离线可跑。
process.env.CCCONFIG_LOCALE = 'zh-CN'
const skillsSh = require('../public/preload/services/skills-sh')

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

// ==================== 1. 输入识别 ====================
console.log('1. 输入识别')

ok(
  skillsSh.isSkillsShInput('https://www.skills.sh/vercel-labs/skills/find-skills'),
  '识别 skills.sh 详情页链接',
)
ok(
  skillsSh.isSkillsShInput('npx skills add https://github.com/vercel-labs/skills --skill find-skills'),
  '识别 npx skills add 命令',
)
ok(
  skillsSh.isSkillsShInput('npx -y skills@1.7.4 add "https://github.com/acme/skills" --skill demo'),
  '识别带 -y / 固定版本 / 引号的命令',
)
ok(skillsSh.isSkillsShInput('https://skillhub.cn/skills/acme/demo') === false, 'SkillHub 链接不归 skills.sh')
ok(skillsSh.isSkillsShInput('https://www.modelscope.cn/skills/@acme/demo') === false, '魔搭链接不归 skills.sh')
ok(skillsSh.isSkillsShInput('hello') === false, '普通文本不识别')
ok(skillsSh.isSkillsShInput('') === false, '空输入不识别')

// ==================== 2. URL 与命令解析 ====================
console.log('\n2. URL 与命令解析')

const githubRef = skillsSh._parseSkillsShUrl('https://www.skills.sh/vercel-labs/skills/find-skills')
ok(githubRef?.source === 'vercel-labs/skills', 'GitHub 来源拆出 owner/repo')
ok(githubRef?.skillId === 'find-skills', 'GitHub 来源拆出 skillId')

const siteRef = skillsSh._parseSkillsShUrl('https://www.skills.sh/site/open.feishu.cn/lark-doc')
ok(siteRef?.source === 'open.feishu.cn', 'site 来源拆出域名')
ok(siteRef?.skillId === 'lark-doc', 'site 来源拆出 skillId')

ok(skillsSh._parseSkillsShUrl('https://www.skills.sh/') === null, '首页不作为可安装链接')
ok(skillsSh._parseSkillsShUrl('https://example.com/a/b/c') === null, '其它站点链接不解析')
ok(
  skillsSh._detailUrl('open.feishu.cn', 'lark-doc') ===
    'https://www.skills.sh/site/open.feishu.cn/lark-doc',
  'site 来源详情 URL 与站点一致',
)

const githubCommand = skillsSh._parseInstallCommand(
  'npx skills add https://github.com/acme/skills --skill demo-skill',
)
ok(githubCommand?.target === 'https://github.com/acme/skills', '解析 GitHub 安装目标')
ok(githubCommand?.skill === 'demo-skill', '解析 --skill 名称')

const quotedCommand = skillsSh._parseInstallCommand('npx skills add "https://uizze.sh/"')
ok(quotedCommand?.target === 'https://uizze.sh/', '解析带引号、无 --skill 的命令')
ok(quotedCommand?.skill === '', '无 --skill 时 skill 为空')

const repoCommand = skillsSh._parseInstallCommand('npx skills add vercel-labs/skills --skill find-skills')
ok(repoCommand?.target === 'vercel-labs/skills', '支持 owner/repo 简写')

ok(skillsSh._parseInstallCommand('npm install x') === null, '非 skills 命令返回 null')
ok(skillsSh._parseInstallCommand('npx skills add') === null, '缺少目标时返回 null')

// ==================== 3. 详情页解析 ====================
console.log('\n3. 详情页解析')

const detailHtml = [
  '<script type="application/ld+json">',
  JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'demo-skill',
    description: 'A demo skill for testing.',
  }),
  '</script>',
  `<script>self.__next_f.push([1,${JSON.stringify(
    '{"command":"npx skills add https://github.com/acme/skills --skill demo-skill"}',
  )}])</script>`,
].join('')

const detail = skillsSh._parseDetailPage(detailHtml, {
  source: 'acme/skills',
  skillId: 'demo-skill',
})
ok(detail.name === 'demo-skill', '名称来自 ld+json')
ok(detail.description === 'A demo skill for testing.', '简介来自 ld+json')
ok(
  detail.installCommand === 'npx skills add https://github.com/acme/skills --skill demo-skill',
  '安装命令来自站点载荷',
)
ok(
  skillsSh._parseDetailPage('', { source: 'acme/skills', skillId: 'demo-skill' }).installCommand ===
    '',
  '页面缺少命令时保持为空，由调用方兜底',
)

// ==================== 4. npx 安装参数 ====================
console.log('\n4. npx 安装参数')

const args = skillsSh._buildNpxArgs({
  target: 'https://github.com/vercel-labs/skills',
  skill: 'find-skills',
})
ok(args.includes('skills@1.7.4'), '使用固定版本的官方 skills 包')
ok(args.includes('-y'), '跳过 npx / CLI 的交互确认')
ok(args.includes('-g'), '使用全局安装')
ok(args.includes('--copy'), '复制目录，不创建软链接')
ok(args[args.indexOf('-a') + 1] === 'zed', '选择全局目录为 ~/.agents/skills 的 agent')
ok(args[args.indexOf('--skill') + 1] === 'find-skills', '通过 --skill 指定单个 Skill')
ok(args.includes('https://github.com/vercel-labs/skills'), '安装目标来自输入命令')
ok(!args.includes('--all'), '不会安装仓库里的全部 Skill')

const allArgs = skillsSh._buildNpxArgs({ target: 'https://uizze.sh/', skill: '' })
ok(!allArgs.includes('--skill'), '命令没有 --skill 时不传该参数')

// ==================== 5. Node 版本与目录名 ====================
console.log('\n5. Node 版本与目录名')

ok(skillsSh._isNodeSupported('v22.20.0') === true, 'Node 22.20.0 满足要求')
ok(skillsSh._isNodeSupported('v22.19.9') === false, 'Node 22.19.9 版本过低')
ok(skillsSh._isNodeSupported('v20.11.0') === false, 'Node 20 版本过低')
ok(skillsSh._isNodeSupported('v24.1.0') === true, 'Node 24 满足要求')
ok(skillsSh._isNodeSupported('v23.0.0') === true, 'Node 23 满足要求')
ok(skillsSh._isNodeSupported('garbage') === false, '非法版本字符串判定为不支持')
ok(JSON.stringify(skillsSh._parseNodeVersion('v22.20.1')) === '[22,20,1]', '解析版本号')

ok(
  skillsSh._sanitizeSkillName('Vercel React Best Practices') === 'vercel-react-best-practices',
  '目录名小写并用 - 连接',
)
ok(skillsSh._sanitizeSkillName('  .Foo  ') === 'foo', '去掉首尾点与横线')
ok(skillsSh._sanitizeSkillName('中文') === 'unnamed-skill', '无法转写的名称回退 unnamed-skill')
ok(skillsSh._sanitizeSkillName('a'.repeat(300)).length === 255, '目录名截断到 255')

// ==================== 6. uTools 指令匹配 ====================
console.log('\n6. uTools 指令匹配')

const plugin = require('../public/plugin.json')
const installFeature = plugin.features.find((feature) => feature.code === 'installCommonSkill')
const regexes = (installFeature?.cmds || [])
  .filter((cmd) => cmd.type === 'regex')
  .map((cmd) => new RegExp(cmd.match.slice(1, -1)))
const matchesInstallCommand = (input) => regexes.some((re) => re.test(input))

ok(
  matchesInstallCommand('https://www.skills.sh/vercel-labs/skills/find-skills'),
  'uTools 指令匹配 skills.sh 详情页链接',
)
ok(
  matchesInstallCommand('https://www.skills.sh/site/open.feishu.cn/lark-doc'),
  'uTools 指令匹配 skills.sh site 链接',
)
ok(
  matchesInstallCommand('npx skills add https://github.com/vercel-labs/skills --skill find-skills'),
  'uTools 指令匹配 npx skills add 命令',
)
ok(
  matchesInstallCommand('https://skillhub.cn/skills/acme/demo'),
  'uTools 指令仍匹配 SkillHub 链接',
)
ok(
  matchesInstallCommand('https://www.modelscope.cn/skills/@acme/demo'),
  'uTools 指令仍匹配魔搭链接',
)
ok(!matchesInstallCommand('https://example.com/a/b/c'), 'uTools 指令不匹配无关链接')

console.log(`\n通过 ${passed}/${passed + failed}`)
if (failed) process.exit(1)
