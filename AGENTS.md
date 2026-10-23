# AGENTS.md

CCSwitch（uTools 插件名 CCConfig）：管理 Claude Code / OpenCode / Pi / omp / Reasonix / Codex / Kimi Code / MiniMax Code / Qoder / ZCode / Hermes / DSH（DeepSeek Harness）十二应用的 API 配置切换（Qoder / Hermes 仅模型配置，ZCode / DSH 另含使用统计）、MCP/Skill/Plugin 管理与使用统计；另有「通用配置」应用（跨 agent 供应商/模型主数据、通用 MCP/Skill、自动网关、模型下发）。

## 技术栈与命令

Vue 3 (`<script setup>`) + Vite + TDesign Vue Next + @lucide/vue；解析库 json5 / js-yaml / smol-toml；MCP SDK；ogl（深色背景特效）。

```bash
npm run dev     # 开发（localhost:5173，watch public/preload/** 自动重打包）
npm run build   # 生产构建（含 esbuild 打包 preload）
```

## Git

`origin` = ShaneLevs/CCSwitch，直接在 `main` 提交推送。提交信息用 `feat:` / `fix:` / `style:` / `docs:` / `refactor:` 前缀 + 中文描述。

## 核心架构

- **Fat Preload**：所有 Node 敏感操作（文件 I/O、网络、子进程）在 `public/preload/services/` 实现，经 `services.js` 暴露为 `window.services`；由 `vite.config.js` 的 `bundlePreloadPlugin`（esbuild：bundle/cjs/node18）打进 `dist/preload/services.js`。preload 依赖清单在 `public/preload/package.json`（dev 模式 uTools 直接 require 源码需要）。
- **App Context 单例**：`useAppContext` 用模块级 ref（非 provide/inject）在 index.vue 与各子视图间共享状态。
- **视图组织**：`src/Switch/<app>/ConfigView|McpView|SkillView|PluginView|UsageView.vue` + 同名 `styles/` CSS；跨应用共享组件在 `src/components/`，共享逻辑在 `src/composables/`（Agent 默认顺序与展示名元数据在 `composables/agentMeta.js`，纯数据、无副作用：切换器 / 设置弹窗 / 统计页 Agent 分组标题共用，不要在展示组件里引 `useAgentVisibility`）；单应用专属的弹窗/卡片等子组件放 `src/Switch/<app>/components/`（如 `common/components/BatchAddModelsDialog.vue`、`pi/components/PiPluginDetailDialog.vue`），沿用该视图 `styles/` 里的全局类，不重复定义样式。preload 各功能域模块也在 `public/preload/services/`（如 `skills.js`、`pi-common.js`、`claude-usage.js`），`services.js` 仅做装配（window.services 公开 API 面不可变）。
- **数据存储**：配置存 uTools DB（API Key 经 AES-256-CBC 加密，`crypto.js`）；按机器隔离的数据（自动网关、Env 额外字段、通用 MCP 本地启停 `ccswitch_mcp_local_state_<nativeId>`（disabled 名单，主档在 ccswitch_common_mcp）、使用统计 heatmap/usage_cache、MCP 停用、Agent 启停 `ccswitch_visible_agents_<nativeId>`、背景特效 `ccswitch_dark_background_<nativeId>`）用 `_<nativeId>` 后缀分文档，旧共享档仅作迁移种子只读。切换配置 = 写 managed env 字段（见 `constants.js`）+ 清非 managed + 合并全局与配置特定 extra fields；激活配置 ID 存 `ccswitch_active_config_id`。
- **Skill 启停**：`.disabled/` 目录机制（物理移动目录），Claude → `~/.claude/skills`，OpenCode → `~/.config/opencode/skills`，通用 → `~/.agents/skills`。
- **自动网关**（`autoroute.js` + `autoroute-convert/`，UI 名为「网关」）：本地网关（默认 127.0.0.1:17877），入站 Anthropic Messages / OpenAI Chat / Responses 三协议，同协议透传、跨协议经 canonical 中间格式转换（含 SSE 流式）；随机 key 防滥用；请求日志存内存（最近 10 条，解析出目标模型即插「进行中」行、完成原地补全）；模型映射首次初始化自动预置 flash / plus / pro 三行（目标留空，用户自选或删行）。转换层规则（推理强度/媒体降级/结构化输出/tool schema 修补）与上游容错（重试、被拒可选字段记忆、断连中止、协议头透传）见 README「数据流」网关小节；**修改转换行为时必须同步 canonical.js 头注释与 README**。

各应用配置文件的具体读写规则与字段约定见 [README.md](README.md)「数据流」与「认证与模型选择细节」两节。

## Agent 启停 ↔ 启动指令

plugin.json **仅静态声明** commonConfig / installCommonSkill；各 agent 指令由 `commands.js` 内置规范（`FEATURE_DEFINITIONS`）按启停状态动态注册/移除（`utools.setFeature/removeFeature`）。preload 顶层 + `onPluginEnter` 每次从 DB（`ccswitch_visible_agents`）重放同步，渲染进程勾选变化即时调 `syncAgentCommands`。**注意 uTools 没有 onPluginReady API**，误用会抛 TypeError 中断注册链路。

## 样式规范

- 文本/背景色一律用 TDesign CSS 变量（`--td-text-color-primary`、`--td-bg-color-container` 等）以支持暗色；暗色覆盖写 `:root[theme-mode="dark"] .class {}`。
- 复选框/下拉勾选态统一绿色：已在 `src/main.css` 全局固定（`.t-checkbox` / `.t-select-option.t-is-selected` / `.t-cascader__item.t-is-selected` 上重绑 `--td-brand-color: var(--td-success-color)`），新增复选框/多选组件无需也不要再逐视图覆盖。
- 每个视图对应 `src/Switch/<app>/styles/` 同名 CSS；共享组件样式写在组件内部。

## 构建注意

- 构建后清理 Vite 复制到 `dist/preload` 的 node_modules（js-yaml 的 .map 会导致 uTools 打包拒绝）及 .DS_Store。
- `@modelcontextprotocol/sdk` 在 `mcp.js` try/catch 懒加载，缺失时工具发现自动降级。
- Base path `./`（uTools file:// 加载）。
- 普通 CSS 文件（非 SFC scoped）中 `:deep()` 不会被 Vue 转换，是无效选择器，不要使用。

## 双发行：uTools 插件 + macOS 桌面版

同一个仓库产出两个发行目标，**业务代码只有一份**。

| 发行版 | 壳 | 构建命令 | 产物 |
|---|---|---|---|
| uTools 插件 | uTools 宿主 | `npm run build` | `dist/`（加载 `plugin.json`） |
| macOS 桌面版 | Tauri v2 | `npm run tauri:build` | `.dmg` |
| 桌面版开发 | Tauri v2 | `npm run tauri:dev` | 自动串起 `build:app` + `cargo tauri dev` |

`npm run build:app` = `CCCONFIG_TARGET=app vite build`（产出 `dist-app/`）+ `scripts/prepare-sidecar.mjs`（组装 `src-tauri/resources/sidecar/`）。

### 目录职责

| 目录 | 归属 |
|---|---|
| `src/**` | **共享**（两个发行版同一份源码） |
| `public/preload/services/**`、`services.js` | **共享**（esbuild 打成 `services.js`，uTools 当 preload、桌面版当 sidecar 主体） |
| `public/plugin.json` | 仅 uTools |
| `src-tauri/**` | 仅桌面版（Rust 壳、Node 探测、托盘、窗口） |
| `desktop/sidecar/**` | 仅桌面版（`server.js` HTTP 服务 + `utools-shim.js`） |
| `desktop/bridge/window-shim.js` | 仅桌面版（构建时注入前端，提供 `window.utools` / `window.services`） |
| `desktop/guide.html` | 仅桌面版（未装 Node 时的引导页） |

唯一的构建期分叉点是 `vite.config.js` 的 `IS_APP`（切 outDir + 注入 bridge）。

### 改动的三条硬约束

1. **新增任何 `utools.xxx` 调用，必须在 `desktop/bridge/window-shim.js` 同步实现。**
   bridge 目前只覆盖：`db.*`、`getPath`、`getNativeId`、`shellOpenPath`、`shellOpenExternal`、`copyText`、`showOpenDialog`、`onPluginEnter/Out`、`setFeature/removeFeature/getFeatures`、`isWindows/isMacOS/isLinux`。
   用了这之外（如 `showNotification`、`getUser`、`db.promises`、`getAppVersion`）→ uTools 版正常，桌面版 `undefined` 直接抛错。
2. **services 方法的返回值必须能 JSON 往返。** 桌面版走 HTTP JSON，uTools 版是共享内存对象。`Buffer` 会变成 `{type:'Buffer',data:[…]}`、`Date` 变字符串、`undefined` 变 `null`、函数/循环引用直接抛错。
3. **慢操作必须 `async`。** 桌面版 bridge 用**同步 XHR**（Phase 0 实测 WKWebView 支持，含跨域 preflight），同步调用会阻塞 WebView 主线程。

### 桌面版特有约定

- 数据目录 `~/.ccconfig/`（`db.json` / `runtime.json` / `logs/sidecar.log`），权限 600；旧位置 `~/Library/Application Support/CCSwitch` 在启动时一次性迁移。
- **db 文档 ID 前缀 `ccswitch_*`、导出文件的 `app: "ccswitch"`、网关提示头 `x-ccswitch-left-out` 都不改**：属于数据 schema，改了会破坏与 uTools 版的导入兼容。
- `setFeature` / `removeFeature` / `getFeatures` 在桌面版是 no-op（不迁移 uTools 搜索框指令）。
- `onPluginEnter` 在桌面版只在首帧触发一次，`action.code` 固定 `commonConfig`（桌面版没有「重新进入」的概念，重复触发会重置用户当前视图）。
- 桌面版 bridge 带诊断通道：前端 `console.error` / `window.onerror` / `unhandledrejection` 会转发到 `~/.ccconfig/logs/sidecar.log`（`[webview:*]` 前缀）。排查桌面版问题先看这个日志。
- sidecar 的资源目录里（`src-tauri/resources/sidecar/`） `server.js`、`services.js`、`usage-worker.js`、`utools-shim.js`、`package.json` **必须同级**（`usage-async.js` 用 `__dirname` 拼 worker 路径；`package.json` 声明 `type: commonjs` 抵消根目录的 `type: module`）。
- 各应用配置文件位置、字段语义与读写规则、网关转换细节统一维护在 `docs/architecture.md`（README 只保留概览，新增/修改数据流规则时改这里）。

- 首次 `cargo build` 若卡在 crates.io，可在 `src-tauri/.cargo/config.toml` 加稀疏镜像（该文件已 gitignore，各人自备）：`[source.crates-io] replace-with = "rsproxy"` + `[source.rsproxy] registry = "sparse+https://rsproxy.cn/index/"`。
