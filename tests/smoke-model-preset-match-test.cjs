// 模型预设匹配冒烟测试：验证 ID 归一化、别名、日期/供应商前后缀、上下文提示和最长匹配。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/data/modelPresets.json'), 'utf8'))

;(async () => {
  const { createModelPresetMatcher, getPresetValues, tokenizeModelId } = await import(
    pathToFileURL(path.join(__dirname, '..', 'src/utils/modelPresetMatch.js')).href
  )
  const find = createModelPresetMatcher(data.models)
  const results = []
  const check = (name, fn) => {
    try {
      fn()
      results.push(['PASS', name])
    } catch (e) {
      results.push(['FAIL', name + ' — ' + e.message])
    }
  }

  check('tokenize：点号、下划线、连字符等价', () => {
    assert.deepStrictEqual(tokenizeModelId('claude-sonnet-4.5'), ['claude-sonnet-4-5'.split('-')[0], 'sonnet', '4', '5'])
    assert.deepStrictEqual(tokenizeModelId('claude_sonnet-4_5'), tokenizeModelId('claude-sonnet-4-5'))
    assert.deepStrictEqual(tokenizeModelId('gpt-5.4-mini'), ['gpt', '5', '4', 'mini'])
  })

  check('全部预设 ID 和别名都能精确匹配自己', () => {
    for (const model of data.models) {
      for (const key of [model.id, ...(model.aliases || [])]) {
        const result = find(key)
        assert.ok(result, `没有匹配：${key}`)
        assert.strictEqual(result.preset.id, model.id, `${key} 匹配到了 ${result.preset.id}`)
      }
    }
  })

  check('模型家族短名匹配到唯一模型', () => {
    assert.strictEqual(find('deepseek-flash').preset.id, 'deepseek-v4.1-flash')
    assert.strictEqual(find('deepseek-v4.1-flash-1017').preset.id, 'deepseek-v4.1-flash')
    assert.strictEqual(find('deepseek-pro').preset.id, 'deepseek-v4-pro')
    assert.strictEqual(find('glm').preset.id, 'glm-5.3')
    assert.strictEqual(find('qwen-flash').preset.id, 'qwen3.8-flash')
  })

  check('日期后缀匹配基础模型', () => {
    assert.strictEqual(find('claude-sonnet-4-5-20250929').preset.id, 'claude-sonnet-4-5')
    assert.strictEqual(find('gpt-5.4-mini-2025-08-07').preset.id, 'gpt-5.4-mini')
  })

  check('供应商前缀 / 云厂商前缀匹配', () => {
    assert.strictEqual(find('anthropic/claude-sonnet-4.5').preset.id, 'claude-sonnet-4-5')
    assert.strictEqual(
      find('us.anthropic.claude-sonnet-4-5-20250929-v1:0').preset.id,
      'claude-sonnet-4-5',
    )
    assert.strictEqual(find('openai/gpt-5.4').preset.id, 'gpt-5.4')
  })

  check('最长 token 序列优先', () => {
    assert.strictEqual(find('gpt-5.4-mini').preset.id, 'gpt-5.4-mini')
    assert.notStrictEqual(find('gpt-5.4-mini').preset.id, 'gpt-5.4')
    assert.strictEqual(find('gemini-3.5-flash-lite').preset.id, 'gemini-3.5-flash-lite')
  })

  check('未知变体不误匹配基础模型', () => {
    assert.strictEqual(find('gpt-5.4-turbo'), null)
    assert.strictEqual(find('my-private-model'), null)
  })

  check('[1m] 上下文提示覆盖上下文窗口', () => {
    const result = find('claude-opus-4-5[1m]')
    assert.ok(result)
    assert.strictEqual(result.preset.id, 'claude-opus-4-5')
    assert.strictEqual(result.contextWindowOverride, 1000000)
    assert.strictEqual(getPresetValues(result.preset, result.contextWindowOverride).contextWindow, 1000000)
  })

  check('模糊/歧义输入不自动填充', () => {
    assert.strictEqual(find('gpt-5.4-unknown'), null)
    assert.strictEqual(find('claude-sonnet'), null)
  })

  const failed = results.filter(([, status]) => status === 'FAIL')
  for (const [status, name] of results) console.log(`${status === 'PASS' ? '✓' : '✗'} ${name}`)
  if (failed.length) process.exit(1)
  console.log(`\n通过 ${results.length}/${results.length}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
