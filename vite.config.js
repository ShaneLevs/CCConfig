import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { build as esbuildBuild } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))

// 双 target：默认产出 uTools 插件（dist/），CCCONFIG_TARGET=app 产出桌面版（dist-app/）
const IS_APP = process.env.CCCONFIG_TARGET === 'app'
const OUT_DIR = IS_APP ? 'dist-app' : 'dist'

function bundlePreloadPlugin() {
  // 桌面与 uTools 都从 dist/preload 取打好的 CJS；所有目标统一将 electron 交给宿主运行时。
  const preloadExternal = ['electron']
  const buildPreload = async () => {
    const outDir = path.resolve(__dirname, 'dist/preload')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    // 自定义窗口 preload 不经过 Vite 的 HTML 入口：单独打成 CJS，供 createBrowserWindow 加载。
    await esbuildBuild({
      entryPoints: [path.resolve(__dirname, 'public/preload/panel-bridge.js')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'panel-bridge.js'),
      format: 'cjs',
      external: preloadExternal,
      allowOverwrite: true,
      logLevel: 'info',
    })
    await esbuildBuild({
      entryPoints: [path.resolve(__dirname, 'public/preload/services.js')],
      bundle: true,
      platform: 'node',
      target: 'node18',
      outfile: path.join(outDir, 'services.js'),
      format: 'cjs',
      external: preloadExternal,
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
    // 共享面板静态页按发行目标分别落到 dist/panel.html 与 dist-app/tray.html。
    // 开发服务器从 /panel.html 提供同一份页面，页面脚本仍是原生 JS，不依赖 Vite 入口。
    const panelHtml = fs.readFileSync(path.resolve(__dirname, 'shared/panel/panel.html'), 'utf8')
    const desktopAdapter = fs.readFileSync(path.resolve(__dirname, 'shared/panel/desktop-adapter.js'), 'utf8')
    const outRoot = path.resolve(__dirname, OUT_DIR)
    if (!fs.existsSync(outRoot)) fs.mkdirSync(outRoot, { recursive: true })
    fs.writeFileSync(
      path.join(outRoot, IS_APP ? 'tray.html' : 'panel.html'),
      IS_APP
        ? panelHtml.replace('</head>', '<script>' + desktopAdapter + '</script></head>')
        : panelHtml,
      'utf8',
    )
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
      server.middlewares.use('/panel.html', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(fs.readFileSync(path.resolve(__dirname, 'shared/panel/panel.html'), 'utf8'))
      })
      server.middlewares.use('/preload/panel-bridge.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.end(fs.readFileSync(path.join(path.resolve(__dirname, 'dist/preload'), 'panel-bridge.js'), 'utf8'))
      })
      const watcher = server.watcher
      watcher.add(path.resolve(__dirname, 'public/preload/**'))
      // 共享文案目录会被 esbuild 内联进 services.js；共享面板与适配层也要触发静态页重建。
      watcher.add(path.resolve(__dirname, 'shared/i18n/**'))
      watcher.add(path.resolve(__dirname, 'shared/panel/**'))
      watcher.on('change', async (file) => {
        const normalized = file.replace(/\\/g, '/')
        if (
          normalized.includes('public/preload/') ||
          normalized.includes('shared/i18n/') ||
          normalized.includes('shared/panel/')
        ) {
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
      // 引导页仍是桌面版独立静态页；tray.html 由 bundlePreloadPlugin 从共享面板生成。
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
  // 「关于」页展示的客户端版本：构建时取自 package.json（version:check 保证与 plugin.json / Cargo 一致）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: OUT_DIR,
    // uTools 以 file:// 加载单页插件，拆 chunk 会引入 ES module 跨文件加载风险；
    // 主包体积主要来自 TDesign 全量组件 + 图标库，本地加载无性能瓶颈，故仅调高阈值
    chunkSizeWarningLimit: 2200,
  },
})
