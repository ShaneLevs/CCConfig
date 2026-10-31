# AGENTS.md

CCConfig 同时发行 uTools 插件与 Tauri 桌面版，业务代码共用一份。它管理 Claude Code、OpenCode、Pi、omp、Reasonix、Codex、Kimi Code、MiniMax Code、Qoder、ZCode、Hermes、DSH、Grok Build、Cline、Command Code 十五个 Agent 的 API 配置；多数 Agent 还支持使用统计，部分支持 MCP / Skill / Plugin。另有「通用配置」，承载跨 Agent 主数据、通用 MCP / Skill、网关、模型下发和订阅用量。

## 常用命令

```bash
npm run dev            # localhost:5173；watch preload / i18n
npm run build          # uTools 插件，产物 dist/
npm run build:app      # 桌面版前端，产物 dist-app/
npm run tauri:build    # 当前平台桌面安装包，复制到 release/
npm test               # tests/ 全部冒烟测试
npm run version:check
npm run i18n:check
npm run routes:check
npm run bump -- 1.0.2  # 同步 5 处版本号，勿手改单个文件
```

提交前缀：`feat:` / `fix:` / `style:` / `docs:` / `refactor:` + 中文描述。`origin` 为 ShaneLevs/CCConfig，日常直接提交 `main`。

版本号落点：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`public/plugin.json`。`scripts/version-files.mjs` 是唯一清单。发版顺序：`bump` → `version:check` → 提交推送 → 小写 `vX.Y.Z` tag → `gh release create --generate-notes`。Release 发布后 CI 用 macOS / Windows runner 构建 dmg 与 NSIS exe 并覆盖上传同名资产；workflow 必须已在 `main`。uTools 仍手动上传 `dist/`。tag 必须等于 `v` + `package.json` 版本。CI 失败可 `gh run rerun <id> --failed`；兜底本地 `tauri:build` 后 `gh release upload --clobber`。

## 核心结构

- **Fat Preload**：文件、网络、子进程都在 `public/preload/services/`；`services.js` 只装配 `window.services`，公开 API 面保持稳定。Vite 的 `bundlePreloadPlugin` 用 esbuild 打成 CJS/node18 的 `dist/preload/services.js`；`usage-worker.js` 必须独立打包。
- **App Context**：`useAppContext` 使用模块级 ref，不用 provide/inject 共享页面状态。
- **视图**：`src/Switch/<app>/ConfigView|McpView|SkillView|PluginView|UsageView.vue` + 同名 `styles/`。共享组件放 `src/components/`，共享逻辑放 `src/composables/`，单应用子组件放 `src/Switch/<app>/components/`。Agent 名称、图标、默认顺序只维护在 `composables/agentMeta.js`，该文件必须纯数据、无副作用。
- **自动刷新**：`index.vue` 调 `providePageContext(activeTab)`；`v-show` 页面用 `usePageRefresh(app, tab, refresh)`，首屏也用同一 refresh。刷新按钮绑定 `loading || autoRefreshing`，自动刷新至少显示 400ms。`ConfigView` 通常因 `v-if` 重建，用 `onMounted(refreshNow)`。
- **uTools DB**：配置与主数据在 uTools DB，API Key 用 AES-256-CBC 加密。机器隔离文档统一带 `_<nativeId>`，包括自动网关、Env 额外字段、通用 MCP 本地状态、统计缓存、Agent 显隐、外观、语言等；旧共享档只作迁移种子。切换 Claude 配置 = 写 managed env + 清非 managed + 合并 extra fields，激活 ID 在 `ccconfig_active_config_id`。
- **旧名兼容**：历史名 CCSwitch 只能作为数据兼容常量存在。JS 集中在 `services/legacy.js`；`db-migrate.js` 幂等迁移 `ccswitch_*` 文档和旧密文；Rust 常量在 `main.rs` / `node_runtime.rs`，桌面 shim 也保留旧目录与 nativeId 缓存回退。设备 ID 哈希种子和旧文档 ID 永不可改。
- **Skill**：停用目录在 skills 根目录**同级** `.disabled/`，不能放进根目录内。扫描必须用 `fs-utils.js` 的 `isDirEntry` / `isFileEntry` / `countEntries` 跟随软链；删除必须用 `rmEntry`，软链只删链接。不要裸用 `Dirent.isDirectory()` 或递归 `fs.rmSync`。通用 Skill 场景按机器存 `ccconfig_skill_scenes_<nativeId>`；未安装的绑定记入 `missing`，安装后自动补启用。
- **网关**：`autoroute.js` + `autoroute-convert/`，默认 `127.0.0.1:17877`，支持 Anthropic Messages、OpenAI Chat、Responses；不校验 key，只允许本机回环。映射行顺序就是下发顺序。映射模式默认把响应 `model` 改写为映射名，否则使用统计会记录上游真实名。出站有透传/转换 × 流式/非流式四条路径，修改转换规则必须同步四处、`canonical.js` 头注释和 `docs/architecture.md`。
- **订阅用量**：`subscriptions.js` 读取本机浏览器 Cookie，加密后按机器存 `ccconfig_subscriptions_<nativeId>`，只向 UI 暴露 `hasCookie`。新增站点只需扩展 `ADAPTERS`。详情见 `docs/architecture.md`。

## Agent 写入纪律

- **Codex**：只写当前 Codex 识别的字段。0.166 起 `wire_api` 只能是 `responses`，`chat` 会让整份配置加载失败；认证只写 `forced_login_method = "api"`，不要再写已删除的 `preferred_auth_method`。`base_url` 必须停在版本段，统一走 `normalizeCodexBaseUrl`。目录为空时绝不能设置 `model_catalog_json`（Codex 会拒绝加载）。`config.toml` 和 `models.json` 新写/改写后权限为 `0600`。模型目录条目缺失 `display_name`、`supported_reasoning_levels`、`shell_type`、`visibility`、`truncation_policy` 等字段会导致整份目录失败；档位键必须是 `effort`。使用统计读 `CODEX_HOME/sessions/**/*.jsonl` 的 `token_usage_record`，旧格式只读 `token_count.last_token_usage`，禁止累加 `total_token_usage`。改完跑 `node tests/smoke-codex-test.cjs`。
- **Cline**：`providers.json` 由 zod 严格校验。`version` 必须为字面量 `1`；`updatedAt` 必须是 ISO datetime；`tokenSource` 仅 `manual|oauth|migration`；`reasoning.effort` 仅 `none|minimal|low|medium|high|xhigh|max`；`settings.provider` 必须等于条目键；权限 `0600`。判废条目会被静默丢弃并回落内置账号，读侧用 `effectiveLastUsedProvider` + `checkProviderEntry`，写侧拒绝把判废条目设为当前。解析失败必须抛错中止。`models.json` 与 `providers.json` 是独立信封。改完跑 `tests/smoke-cline-test.cjs`。
- 其他 Agent 的配置路径、字段、历史和兼容规则统一维护在 `docs/architecture.md`；README 只保留概览。

## Agent 启停与语言

`plugin.json` 只静态声明 commonConfig / installCommonSkill。其余 Agent 指令由 `commands.js` 的 `FEATURE_DEFINITIONS` 根据 `ccconfig_visible_agents` 动态 `setFeature/removeFeature`；preload 顶层、`onPluginEnter`、显隐变化和语言切换都会重放。uTools 没有 `onPluginReady`，误用会中断注册。

文案唯一来源是 `shared/i18n/{zh-CN,en-US}/*.json`。Vue、preload、Rust 分别读取同一套 JSON。所有用户可见文案走 `t()`；注释、日志、品牌名、DB id、env key、provider/model id 和外部配置生成内容不翻译。新增 key 必须中英同步，构建会跑 `i18n:check`。语言按机器存 `ccconfig_locale_<nativeId>`；切换后调 `window.services.setLocale()`。

## 样式与路由

文本/背景色使用 TDesign CSS 变量；暗色覆盖写 `:root[theme-mode="dark"] .class {}`。复选框和下拉勾选态已在 `src/main.css` 全局设为绿色，不要在视图内重复覆盖。普通 CSS 不支持 Vue 的 `:deep()`。

`src/App.vue` 的 Switch 路由数组是总闸，漏路由会白屏且不报错。新增 Agent 时必须同步 `agentMeta`、`appTabs`、`commands.js`、`index.vue appMap` 和 `App.vue` 白名单；`routes:check` 会静态校验。

## 构建

`build` / `build:app` 前置 `version:check`、`i18n:check`、`routes:check`。`public/preload` 有独立 `package.json`，新增 preload 依赖只改这里并更新其 lock，不要并入根依赖。构建后会清理 `dist/preload/node_modules` 与 `.DS_Store`。`@modelcontextprotocol/sdk` 在 `mcp.js` 中懒加载并降级。Base path 为 `./`。

## 双发行

| 目标 | 壳 / 构建 | 产物 |
|---|---|---|
| uTools | 宿主 / `npm run build` | `dist/` |
| macOS | Tauri v2 / `npm run tauri:build` | dmg → `release/` |
| Windows | Tauri v2 + NSIS | setup exe → `release/` |
| CI | Release published / workflow_dispatch | dmg + exe Assets；手动触发仅 Actions artifact |

目录归属：`src/**`、`shared/i18n/**`、`public/preload/**` 两发行版共享；`public/plugin.json` 仅 uTools；`src-tauri/**`、`desktop/sidecar/**`、`desktop/bridge/window-shim.js`、`desktop/*.html` 仅桌面版。唯一构建分叉是 `vite.config.js` 的 `IS_APP`。

### 三条硬约束

1. 新增任何 `utools.xxx` 调用，必须同步实现到 `desktop/bridge/window-shim.js`。当前 bridge 只覆盖 db、路径、nativeId、shell、剪贴板、文件选择、插件生命周期、feature、平台判断。
2. `services` 返回值必须能 JSON 往返；Buffer、Date、undefined、函数、循环引用都要先转换。
3. 慢操作必须返回 Promise。桌面版 bridge 通过 `/rpc` + `/rpc-poll` 异步取结果；服务函数体内的同步慢 I/O 或 `execSync` 仍会阻塞，禁止新增。

### 桌面版

- 数据目录 `~/.ccconfig/`，DB 每文档一个 JSON，文件 `0600`、目录 `0700`。文件名是可读前缀 + ID 的 SHA1 前缀；真实 `_id` 在内容里。旧 `~/Library/Application Support/CCSwitch` 只迁移 runtime 与日志。
- `setFeature/removeFeature/getFeatures` 在桌面版 no-op；`onPluginEnter` 首帧只触发一次，固定 `commonConfig`。
- 前端错误转发到 `~/.ccconfig/logs/sidecar.log`，排查先看这里。
- 主窗口透明 + vibrancy，`html/body` 不得注入不透明底色，否则背景特效被盖住。macOS 是 overlay 标题栏；新增顶部固定元素必须吃 `--cc-desktop-titlebar`，顶部交互元素必须验证不会吞掉拖动/点击。
- 托盘是自定义 WebView，不是 NSMenu。左键切换、右键打开主窗口；页面根节点保持透明。托盘通过 sidecar RPC 取缓存与刷新数据，Rust 只注入端口、token、语言，展开时刷新语言。失焦 350ms 内识别为收起；动作走 `tray_popup_*` 命令，不新增 `utools.xxx`。
- sidecar 资源目录中的 `server.js`、`services.js`、`usage-worker.js`、`utools-shim.js`、`package.json` 必须同级。

### Windows

- Windows 保留原生标题栏；标题栏样式调用必须 cfg 门控，`--cc-desktop-titlebar` 为 0。背景按 Mica → 亚克力 → 模糊退化，托盘只用亚克力。
- home 路径用 `USERPROFILE` / `HOMEDRIVE+HOMEPATH` 兜底；Rust / Node 路径统一走 `main.rs` 的 `simplify_path()`。Node 24.x 遇 `\\?\C:\` 会报 `EISDIR ... lstat 'C:'`，所有交给 Node 的路径必须去掉 verbatim 前缀。
- Node 探测覆盖 Program Files、LocalAppData、volta、nvm-windows、fnm、`where node`，过滤 `WindowsApps` 商店别名。spawn 一律 `CREATE_NO_WINDOW`。
- shell / clipboard / file dialog 在 shim 中使用 `cmd /c start`、PowerShell。打包用 NSIS 与 `icons/icon.ico`；安装包未签名，SmartScreen 会提示。
- 首次 Windows 构建约 10–20 分钟，CI 单 job 超时 60 分钟。v1.3.0 的 sidecar 启动问题已在 v1.3.1 修，托盘、透明/Mica、Node 探测仍需 Windows 实机验收。

## 发布检查

```bash
npm run version:check
npm run i18n:check
npm run routes:check
npm test
npm run build
```

uTools 上传 `dist/`；桌面正式版按上面的 tag / Release 流程发布。CI 不构建 uTools。
