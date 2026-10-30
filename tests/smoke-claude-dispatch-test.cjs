// dispatch.js → Claude Code 冒烟测试：node tests/smoke-claude-dispatch-test.cjs
// 验证 1M 上下文标记（[1m]）与 Claude 配置页勾选态互认：
//   1. 通用库模型 contextWindow ≥ 100 万 → 槽位值带 [1m]
//   2. 不足 100 万 → 不带后缀；模型 id 自身带 [1m] 时保留
//   3. 已有同模型缺后缀 → 原地补齐，不占新槽位
//   4. 已有后缀 + 通用库不足 100 万 → 保留后缀（不删手动勾选）
//   5. 同模型重复下发 → 幂等
// 放 tests/ 而非 public/：public 下文件会被 Vite 原样复制进 dist 随插件打包。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccconfig-claude-dispatch-'))
process.env.HOME = tmp
process.env.USERPROFILE = tmp
process.env.CCCONFIG_LOCALE = 'zh-CN'

const dbDocs = new Map()
global.window = global.window || {}
window.utools = {
  getPath: () => tmp,
  getNativeId: () => 'test-native',
  db: {
    get: (id) => dbDocs.get(id) || null,
    put: (doc) => {
      if (!doc || !doc._id) return { ok: false, message: 'id required' }
      const prev = dbDocs.get(doc._id)
      if (prev && doc._rev && prev._rev !== doc._rev) return { ok: false, message: 'conflict' }
      dbDocs.set(doc._id, { ...doc, _rev: (prev && prev._rev) || '1' })
      return { ok: true, id: doc._id, rev: '1' }
    },
    remove: (id) => { dbDocs.delete(id); return { ok: true } },
    allDocs: () => Array.from(dbDocs.values()),
  },
}

const dispatch = require('../public/preload/services/dispatch')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.error(`  ✗ ${name}`) }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（got=${JSON.stringify(a)} want=${JSON.stringify(b)}）`)

const provider = (name) => ({
  name,
  api: 'anthropic-messages',
  baseUrl: 'https://upstream.example.com',
  apiKey: 'sk-test',
})
const model = (id, contextWindow) => ({ id, name: id, contextWindow })
const docOf = (name) => window.utools.db.get('ccconfig_config_dispatch_' + name)
const SLOTS = ['model', 'defaultHaikuModel', 'defaultSonnetModel', 'defaultOpusModel', 'defaultFableModel', 'subagentModel']
const slotValues = (name) => SLOTS.map((s) => docOf(name)[s])

console.log('1. 1M 模型首次下发')
const msg1m = dispatch.dispatchToClaude(provider('p1m'), model('m-1m', 1000000))
eq(docOf('p1m').model, 'm-1m[1m]', 'contextWindow = 100 万 → 默认槽位带 [1m]')
ok(msg1m.includes('1m'), '结果文案包含 1m 提示')

console.log('2. 普通模型首次下发')
dispatch.dispatchToClaude(provider('p200k'), model('m-200k', 200000))
eq(docOf('p200k').model, 'm-200k', 'contextWindow = 20 万 → 不带后缀')
// 模型 id 自带后缀（通用库手填）保留
dispatch.dispatchToClaude(provider('pid'), model('m-id[1m]', 0))
eq(docOf('pid').model, 'm-id[1m]', '模型 id 自带 [1m] → 保留')

console.log('3. 旧配置缺后缀 → 原地补齐')
dispatch.dispatchToClaude(provider('p-upgrade'), model('m-up', 200000))
eq(docOf('p-upgrade').model, 'm-up', '先以 20 万上下文写入默认槽位')
const msgUp = dispatch.dispatchToClaude(provider('p-upgrade'), model('m-up', 1000000))
eq(docOf('p-upgrade').model, 'm-up[1m]', '同模型改为 100 万 → 默认槽位原地补 [1m]')
eq(slotValues('p-upgrade').filter(Boolean).length, 1, '不占用新槽位')
ok(msgUp.includes('1m'), '补齐结果文案包含 1m 提示')

console.log('4. 已有后缀不因通用库缺上下文被删')
dispatch.dispatchToClaude(provider('p-keep'), model('m-keep', 1000000))
const msgKeep = dispatch.dispatchToClaude(provider('p-keep'), model('m-keep', 200000))
eq(docOf('p-keep').model, 'm-keep[1m]', '后缀保留（尊重配置页手动勾选）')
ok(!msgKeep.includes('已更新'), '无变化时按「已存在」返回')

console.log('5. 重复下发幂等')
const before = JSON.stringify(docOf('p1m'))
const msgDup = dispatch.dispatchToClaude(provider('p1m'), model('m-1m', 1000000))
eq(JSON.stringify(docOf('p1m')), before, '重复下发不改变文档')
ok(msgDup.includes('已有模型'), '返回「已有模型」提示')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
