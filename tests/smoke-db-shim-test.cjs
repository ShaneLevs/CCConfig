// utools-shim.js DB 存储冒烟测试：node tests/smoke-db-shim-test.cjs（仓库根目录运行）
// 验证桌面版把 uTools DB 落到 ~/.ccconfig/db/ 下「一文档一文件」的行为：
//   1. put/get/_rev 冲突、1MB 上限、remove 与 not_found
//   2. 跨进程持久化（每次子进程重新装载 shim，只靠磁盘）
//   3. 文件名映射：含 `/`、`:`、中文、大小写、NFC/NFD、超长 ID 都能独立存取且不互相覆盖
//   4. allDocs：无参 / 前缀 / ID 数组，跳过 .tmp 与坏文件
//   5. 只重写被改动的文档，其它文档文件不动
//   6. 目录 0700、文档文件 0600
// 放 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SHIM = path.join(__dirname, '..', 'desktop', 'sidecar', 'utools-shim.js')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-shim-'))
const DB_DIR = path.join(DATA_DIR, 'db')
const ENV = { ...process.env, CCCONFIG_DATA_DIR: DATA_DIR }

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

// 在独立子进程里装载 shim 执行代码，返回最后一段 JSON。
// 每个场景一个进程：既避免模块级缓存互相污染，也顺带验证「数据只靠磁盘恢复」。
function inChild(code) {
  const script = `
    const shimMod = require(${JSON.stringify(SHIM)});
    const db = shimMod.createUtoolsShim().db;
    const out = (() => { ${code} })();
    shimMod.flushNow();
    process.stdout.write(JSON.stringify(out === undefined ? null : out));
  `
  const res = spawnSync(process.execPath, ['-e', script], { env: ENV, encoding: 'utf-8', timeout: 30000 })
  if (res.status !== 0) throw new Error(`子进程失败:\n${res.stderr || ''}${res.stdout || ''}`)
  return JSON.parse(res.stdout)
}

const docFiles = () => {
  if (!fs.existsSync(DB_DIR)) return []
  return fs
    .readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, raw: fs.readFileSync(path.join(DB_DIR, f), 'utf-8') }))
}
const fileOf = (id) => {
  const hit = docFiles().find((f) => {
    try {
      return JSON.parse(f.raw)._id === id
    } catch (e) {
      return false
    }
  })
  return hit ? path.join(DB_DIR, hit.name) : null
}

// ==================== 1. 基本语义 ====================
console.log('基本读写与 _rev：')
{
  const first = inChild(`
    const put = db.put({ _id: 'ccconfig_config_1', name: 'a', value: 1 });
    return { put, got: db.get('ccconfig_config_1'), missing: db.get('nope') };
  `)
  ok(first.put.ok === true && /^1-/.test(first.put.rev), 'put 新建文档返回 ok + rev')
  ok(first.got && first.got.name === 'a' && first.got._rev === first.put.rev, 'get 读回刚写入的文档')
  ok(first.missing === null, 'get 不存在的文档返回 null')

  const conflict = inChild(`
    return db.put({ _id: 'ccconfig_config_1', name: 'b' });
  `)
  ok(conflict.error === true && conflict.name === 'missing_rev', '更新已有文档缺少 _rev 返回 missing_rev')

  const updated = inChild(`
    const cur = db.get('ccconfig_config_1');
    const wrong = db.put({ _id: 'ccconfig_config_1', _rev: '9-deadbeef', name: 'c' });
    const right = db.put({ _id: 'ccconfig_config_1', _rev: cur._rev, name: 'b' });
    return { wrong, right, now: db.get('ccconfig_config_1') };
  `)
  ok(updated.wrong.error === true && updated.wrong.name === 'conflict', '_rev 不匹配返回 conflict')
  ok(updated.right.ok === true && /^2-/.test(updated.right.rev), '正确 _rev 可更新，rev 递增')
  ok(updated.now.name === 'b', '更新后内容生效')

  const removed = inChild(`
    const res = db.remove('ccconfig_config_1');
    const again = db.remove('ccconfig_config_1');
    return { res, again, got: db.get('ccconfig_config_1') };
  `)
  ok(removed.res.ok === true, 'remove 删除文档')
  ok(removed.again.error === true && removed.again.name === 'not_found', '重复 remove 返回 not_found')
  ok(removed.got === null, '删除后 get 返回 null')
  ok(fileOf('ccconfig_config_1') === null, '删除后磁盘文件被移除')
}

// ==================== 2. 1MB 上限 ====================
console.log('单文档 1MB 上限：')
{
  const res = inChild(`
    return db.put({ _id: 'ccconfig_big', blob: 'x'.repeat(1024 * 1024) });
  `)
  ok(res.error === true && res.name === 'too_large', '超过 1MB 的文档被拒绝')
}

// ==================== 3. 文件名映射 ====================
console.log('文档 ID → 文件名：')
{
  const ids = [
    'ccconfig_mcp_disabled_abc_my/server',
    'ccconfig_mcp_disabled_abc_my:server',
    'ccconfig_mcp_disabled_abc_中文 名称',
    'ccconfig_case_Foo',
    'ccconfig_case_foo',
    'ccconfig_caf\u00e9', // NFC
    'ccconfig_cafe\u0301', // NFD：在大小写/规范化不敏感的卷上与上一行同名
    'ccconfig_long_' + 'y'.repeat(300),
    '..',
  ]
  const write = inChild(`
    const ids = ${JSON.stringify(ids)};
    return ids.map((id, i) => db.put({ _id: id, n: i }));
  `)
  ok(write.every((r) => r.ok), '全部特殊 ID 均可写入')

  const read = inChild(`
    const ids = ${JSON.stringify(ids)};
    return ids.map((id) => db.get(id));
  `)
  ok(
    read.every((doc, i) => doc && doc.n === i && doc._id === ids[i]),
    '每个特殊 ID 读回自己那条（大小写 / NFC-NFD 不串档）'
  )
  ok(docFiles().length === ids.length, `一个文档一个文件（${docFiles().length}/${ids.length}）`)
  ok(docFiles().every((f) => f.name.length <= 120), '文件名长度受控')
}

// ==================== 4. allDocs ====================
console.log('allDocs：')
{
  const all = inChild(`return db.allDocs();`)
  ok(Array.isArray(all) && all.length === 9, `无参返回全部文档（${all.length}）`)

  const prefix = inChild(`return db.allDocs('ccconfig_case_');`)
  ok(prefix.length === 2 && prefix.every((d) => d._id.startsWith('ccconfig_case_')), '字符串参数按 ID 前缀过滤')

  const byIds = inChild(`return db.allDocs(['ccconfig_case_Foo', 'nope']);`)
  ok(byIds.length === 1 && byIds[0]._id === 'ccconfig_case_Foo', '数组参数按 ID 取，缺失项跳过')

  // 目录里的无关文件（.tmp / 坏 JSON）不应影响 allDocs
  fs.writeFileSync(path.join(DB_DIR, 'leftover.1234abcd.tmp'), '{"_id":"tmp"}')
  fs.writeFileSync(path.join(DB_DIR, 'broken.json'), '{not json')
  const afterJunk = inChild(`return db.allDocs();`)
  ok(afterJunk.length === 9, '跳过 .tmp 与无法解析的文件')
  fs.unlinkSync(path.join(DB_DIR, 'leftover.1234abcd.tmp'))
  fs.unlinkSync(path.join(DB_DIR, 'broken.json'))
}

// ==================== 5. 只重写改动的文档 ====================
console.log('写入放大：')
{
  const target = 'ccconfig_case_Foo'
  const other = 'ccconfig_case_foo'
  const otherFile = fileOf(other)
  const before = fs.statSync(otherFile).mtimeMs
  // 等待一段时间，确保 mtime 变化可辨认
  const wait = Date.now() + 30
  while (Date.now() < wait) {}
  inChild(`
    const cur = db.get(${JSON.stringify(target)});
    return db.put({ _id: ${JSON.stringify(target)}, _rev: cur._rev, n: 99 });
  `)
  const after = fs.statSync(otherFile).mtimeMs
  ok(after === before, '改 A 文档不会重写 B 文档的文件')
  const targetDoc = inChild(`return db.get(${JSON.stringify(target)});`)
  ok(targetDoc.n === 99, '被改动的文档已持久化')
}

// ==================== 6. 权限 ====================
console.log('文件权限：')
{
  const dirMode = fs.statSync(DB_DIR).mode & 0o777
  const fileMode = fs.statSync(fileOf('ccconfig_case_Foo')).mode & 0o777
  ok(dirMode === 0o700, `文档目录 0700（实际 ${dirMode.toString(8)}）`)
  ok(fileMode === 0o600, `文档文件 0600（实际 ${fileMode.toString(8)}）`)
}

// ==================== 7. 设备 ID 持久化 ====================
console.log('设备 ID：')
{
  const a = inChild(`return shimMod.createUtoolsShim().getNativeId();`)
  const b = inChild(`return shimMod.createUtoolsShim().getNativeId();`)
  ok(typeof a === 'string' && a.length === 32, 'getNativeId 返回 32 位哈希')
  ok(a === b, '重启后设备 ID 保持不变')
  ok(fileOf('ccconfig_runtime_id') !== null, '设备 ID 落在文档目录里')
}

fs.rmSync(DATA_DIR, { recursive: true, force: true })

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}：${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
