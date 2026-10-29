// Agent 安装检测冒烟测试：node tests/smoke-agent-info-test.cjs（仓库根目录运行）
// 重点锁定：
//   1. 双形态 Agent（Reasonix：CLI + 桌面客户端）两种路径都要探测，任一存在即算已安装
//   2. forms 分别回传 cli / desktop 各自的 installed 与 version，供设置页并排展示
//   3. 单形态 Agent 只回传 cli 一段，设置页仍走原来的「已安装 · vX」
//   4. AGENTS 表里 Reasonix 的桌面版应用名与客户端真实名称一致（Reasonix Studio）
const assert = require('node:assert')

const { probeAgent, AGENTS } = require('../public/preload/services/agent-info.js')

const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]) }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]) }
}

const MISSING = 'ccconfig-no-such-command-xyz'
const env = process.env

const main = async () => {
  await check('Reasonix 在 AGENTS 表里同时声明 CLI 与桌面版', () => {
    const agent = AGENTS.find((a) => a.id === 'reasonix')
    assert.ok(agent, 'AGENTS 必须包含 reasonix')
    assert.deepStrictEqual(agent.cli, ['reasonix'])
    assert.ok(
      (agent.desktop || []).includes('Reasonix Studio'),
      `桌面版应用名应为 Reasonix Studio，实际 ${JSON.stringify(agent.desktop)}`,
    )
  })

  await check('单形态 Agent 只回传 cli 段（设置页保持原展示）', async () => {
    const r = await probeAgent({ id: 'node', cli: ['node'] }, env)
    assert.strictEqual(r.installed, true)
    assert.deepStrictEqual(Object.keys(r.forms), ['cli'])
    assert.strictEqual(r.forms.cli.installed, true)
    assert.ok(r.version, '应解析到 CLI 版本')
  })

  await check('双形态 Agent：CLI 在、桌面版不在 → forms 两段且各自状态正确', async () => {
    const r = await probeAgent(
      { id: 'x', cli: ['node'], desktop: ['CCConfigNoSuchApp'] },
      env,
    )
    assert.strictEqual(r.installed, true)
    assert.deepStrictEqual(Object.keys(r.forms).sort(), ['cli', 'desktop'])
    assert.strictEqual(r.forms.cli.installed, true)
    assert.strictEqual(r.forms.desktop.installed, false)
    assert.strictEqual(r.forms.desktop.version, '')
  })

  await check('双形态 Agent：两者都不在 → installed=false，forms 仍带两段（都是未安装）', async () => {
    const r = await probeAgent(
      { id: 'x', cli: [MISSING], desktop: ['CCConfigNoSuchApp'] },
      env,
    )
    assert.strictEqual(r.installed, false)
    assert.strictEqual(r.version, '')
    assert.strictEqual(r.forms.cli.installed, false)
    assert.strictEqual(r.forms.desktop.installed, false)
  })

  await check('CLI 探测与桌面版探测并行：二者耗时接近单个超时，而不是相加', async () => {
    const started = Date.now()
    await probeAgent({ id: 'x', cli: [MISSING], desktop: ['CCConfigNoSuchApp'] }, env)
    const ms = Date.now() - started
    // 串行时至少两次 ENOENT 查找 + 一次 plutil 调用；并行下应远低于单次 3s 超时
    assert.ok(ms < 3000, `耗时 ${ms}ms 超过单次探测超时`)
  })

  let failed = 0
  for (const [status, name] of results) {
    if (status === 'FAIL') failed++
    console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`)
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  if (failed) process.exit(1)
}

main()
