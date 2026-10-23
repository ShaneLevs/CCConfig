// 组装 Tauri 的 sidecar 资源目录：把 preload 构建产物与 sidecar 源码放到同一目录。
//
// 三者必须同级：
//   server.js  require('./services.js')、require('./utools-shim')
//   services.js 里 usage-async 用 __dirname 拼 usage-worker.js 的路径

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const dest = path.join(root, 'src-tauri/resources/sidecar')

const files = [
  // preload 构建产物（零改动）
  [path.join(root, 'dist/preload/services.js'), 'services.js'],
  [path.join(root, 'dist/preload/usage-worker.js'), 'usage-worker.js'],
  // sidecar 自身
  [path.join(root, 'desktop/sidecar/server.js'), 'server.js'],
  [path.join(root, 'desktop/sidecar/utools-shim.js'), 'utools-shim.js'],
  [path.join(root, 'desktop/sidecar/package.json'), 'package.json'],
]

fs.mkdirSync(dest, { recursive: true })

for (const [src, name] of files) {
  if (!fs.existsSync(src)) {
    console.error(`[prepare-sidecar] 缺少 ${src}；请先执行 npm run build 生成 dist/preload`)
    process.exit(1)
  }
  fs.copyFileSync(src, path.join(dest, name))
  const size = (fs.statSync(src).size / 1024).toFixed(0)
  console.log(`[prepare-sidecar] ${name}  ${size} KB`)
}

console.log(`[prepare-sidecar] 输出目录 ${path.relative(root, dest)}`)
