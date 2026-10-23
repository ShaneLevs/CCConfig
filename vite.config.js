import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { build as esbuildBuild } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 双 target：默认产出 uTools 插件（dist/），CCCONFIG_TARGET=app 产出桌面版（dist-app/）
const IS_APP = process.env.CCCONFIG_TARGET === 'app'
const OUT_DIR = IS_APP ? 'dist-app' : 'dist'

function bundlePreloadPlugin() {
  const buildPreload = async () => {
    const outDir = path.resolve(__dirname, 'dist/preload')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    await esbuildBuild({
      entryPoints: [path.resolve(__dirname, 'public/preload/services.js')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'services.js'),
      format: 'cjs',
      allowOverwrite: true,
      logLevel: 'info',
    })
    // 统计后台线程（worker_threads）独立打包：worker 必须以真实文件路径被 new Worker 加载，
    // 不能混进 services.js（bundle 后的模块系统里拿不到独立入口）
    await esbuildBuild({
      entryPoints: [path.resolve(__dirname, 'public/preload/services/usage-worker.js')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'usage-worker.js'),
      format: 'cjs',
      allowOverwrite: true,
      logLevel: 'info',
    })
    // Vite 会把 public/preload 整个复制到 dist（含 node_modules），但依赖已被 esbuild
    // bundle 进 services.js，运行时不需要；且 js-yaml 自带 .map 调试文件，uTools 打包会
    // 拒绝，因此构建后清理复制的 node_modules
    const nodeModulesDir = path.join(outDir, 'node_modules')
    if (fs.existsSync(nodeModulesDir)) {
      fs.rmSync(nodeModulesDir, { recursive: true, force: true })
    }
  }
  return {
    name: 'bundle-preload',
    async buildStart() { await buildPreload() },
    async closeBundle() {
      await buildPreload()
      // 清理构建产物中的 macOS 系统文件（uTools 打包可能拒绝 .DS_Store）
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(p)
          else if (entry.name === '.DS_Store') fs.rmSync(p, { force: true })
        }
      }
      walk(path.resolve(__dirname, 'dist'))
    },
    async configureServer(server) {
      await buildPreload()
      const watcher = server.watcher
      watcher.add(path.resolve(__dirname, 'public/preload/**'))
      watcher.on('change', async (file) => {
        if (file.includes('public\\preload\\') || file.includes('public/preload/')) {
          console.log('[preload] 文件变动，重新构建...')
          await buildPreload()
        }
      })
    },
  }
}

// 桌面版需要在 Vue 挂载前同步装上 window.utools / window.services 垫片。
// 内联注入而不是外部 <script src>：避免 Vite 把该文件当 asset 解析，也少一个请求。
function injectAppShimPlugin() {
  return {
    name: 'inject-app-shim',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!IS_APP) return html
        const shim = fs.readFileSync(path.resolve(__dirname, 'desktop/bridge/window-shim.js'), 'utf8')
        return {
          html,
          tags: [{ tag: 'script', children: shim, injectTo: 'head-prepend' }],
        }
      },
    },
    closeBundle() {
      if (!IS_APP) return
      // Node 探测失败的引导页：作为静态资源放进 dist-app，由 Rust 用 WebviewUrl::App 打开
      fs.copyFileSync(
        path.resolve(__dirname, 'desktop/guide.html'),
        path.resolve(__dirname, OUT_DIR, 'guide.html')
      )
    },
  }
}

export default defineConfig({
  plugins: [
    vue(),
    bundlePreloadPlugin(),
    injectAppShimPlugin(),
    {
      name: 'remove-crossorigin',
      enforce: 'post',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return html.replace(/ crossorigin/g, '')
        },
      },
    },
  ],
  base: './',
  build: {
    outDir: OUT_DIR,
    // uTools 以 file:// 加载单页插件，拆 chunk 会引入 ES module 跨文件加载风险；
    // 主包体积主要来自 TDesign 全量组件 + 图标库，本地加载无性能瓶颈，故仅调高阈值
    chunkSizeWarningLimit: 2200,
  },
})
