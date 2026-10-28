// 批量运行 tests/ 下全部冒烟测试：npm test（仓库根目录运行）
// 逐个 spawn 子进程执行（各测试自带独立的最小 uTools 环境与临时目录，不能同进程跑），
// 任一失败即整体失败并列出失败清单。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const TESTS_DIR = __dirname
const files = fs
  .readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith('.cjs') && f !== 'run-all.cjs')
  .sort()

if (files.length === 0) {
  console.error('未找到任何测试文件')
  process.exit(1)
}

console.log(`运行 ${files.length} 个冒烟测试…\n`)

const results = []
for (const file of files) {
  const started = Date.now()
  // stdio: inherit 会吞掉汇总，这里只取退出码，输出按需回显（失败时全量打印）
  const res = spawnSync(process.execPath, [path.join(TESTS_DIR, file)], {
    encoding: 'utf-8',
    timeout: 120000,
  })
  const ms = Date.now() - started
  const out = `${res.stdout || ''}${res.stderr || ''}`
  const okRun = res.status === 0
  results.push({ file, ok: okRun, ms, out })
  console.log(`${okRun ? '✓' : '✗'} ${file}  (${ms}ms)`)
  if (!okRun) {
    console.error(out.split('\n').slice(-40).join('\n'))
    console.error('')
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
if (failed.length) {
  console.error(`失败：${failed.map((r) => r.file).join(', ')}`)
  process.exit(1)
}
