// SSRF 防护回归测试：只允许公网 http/https，回环、内网、非 HTTP 协议必须拒绝。
const assert = require('node:assert')
const { assertSafeUrl, isPrivateIp, safeLookup } = require('../public/preload/services/net-guard')

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
const rejects = (value) => {
  try {
    assertSafeUrl(value)
    return false
  } catch {
    return true
  }
}

console.log('1. 私网地址识别')
for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
  ok(isPrivateIp(ip), `识别内网地址 ${ip}`)
}
for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
  ok(!isPrivateIp(ip), `识别公网地址 ${ip}`)
}

console.log('2. URL 协议与主机校验')
for (const url of [
  'http://127.0.0.1:17877',
  'http://localhost:3000',
  'http://[::1]:3000',
  'http://169.254.169.254/latest/meta-data',
  'http://10.0.0.1/v1',
  'http://172.16.0.1/v1',
  'http://192.168.1.1/v1',
  'http://100.64.0.1/v1',
  'file:///etc/passwd',
  'ftp://example.com/x',
  'javascript:alert(1)',
]) {
  ok(rejects(url), `拒绝非法地址 ${url}`)
}
ok(!rejects('https://api.openai.com/v1'), '允许公网 https')
ok(!rejects('api.openai.com/v1'), '无协议时按 https 解析')
ok(!rejects('http://example.com/v1'), '允许公网 http')

console.log('3. DNS 解析结果校验')
;(async () => {
  const result = await new Promise((resolve) => {
    safeLookup('localhost', { all: true }, (error, addresses) => resolve({ error, addresses }))
  })
  ok(!!result.error, 'DNS 解析到本机地址时拒绝', result.error && result.error.message)

  console.log(`\n通过 ${passed} / ${passed + failed}`)
  if (failed) process.exit(1)
})()
