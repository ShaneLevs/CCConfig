# AGENTS.md

CCConfig（uTools 插件名 CCConfig）：管理 Claude Code / OpenCode / Pi / omp / Reasonix / Codex / Kimi Code / MiniMax Code / Qoder / ZCode / Hermes / DSH（DeepSeek Harness）/ Grok Build / Cline / Command Code 十五应用的 API 配置切换（Qoder / Hermes 仅模型配置，ZCode / DSH / Grok / Cline / Command Code / MiniMax Code / Kimi Code 另含使用统计，Grok / Cline / Command Code 另含 MCP / Skill，Command Code 另有 Taste）、MCP/Skill/Plugin 管理与使用统计；另有「通用配置」应用（跨 agent 供应商/模型主数据、通用 MCP/Skill、自动网关、模型下发、订阅用量）。

## 技术栈与命令

Vue 3 (`<script setup>`) + Vite + TDesign Vue Next + @lucide/vue；解析库 json5 / js-yaml / smol-toml；MCP SDK；ogl（深色背景特效）。

```bash
npm run dev            # 开发（localhost:5173，watch public/preload/** 与 shared/i18n/** 自动重打包）
npm run build          # 生产构建（含 esbuild 打包 preload）
npm run version:check  # 校验 5 处版本号是否一致（build / build:app 已内置）
npm run i18n:check     # 校验中英文案 key / 占位符一致、英文无残留中文（build / build:app 已内置）
npm run routes:check   # 校验 APP_TABS 每个 agent 都有 App.vue 白名单路由（漏了会白屏；build / build:app 已内置）
npm test               # 跑 tests/ 下全部冒烟测试
npm run bump -- 1.0.2  # 一次写完所有版本号落点（patch / minor / major 亦可）
```

## 版本号

版本号手写在 5 处，分两条发行线：**app**（`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`）与 **utools**（`public/plugin.json`）；默认同号，两条线一起发。

- 改版本只走 `npm run bump -- <版本|patch|minor|major>`（`scripts/bump-version.mjs`），它会就地替换 5 个文件的版本行；`--app` / `--utools` 可只改一条线。**不要手改单个文件**：v1.0.1 曾出现 dmg 文件名 / 应用内关于 / git tag 各说各话。
- `npm run version:check`（`scripts/check-versions.mjs`）已挂在 `build` / `build:app` 前面，不一致直接拦下并列出该改哪几个文件。
- 落点清单与读写规则集中在 `scripts/version-files.mjs`（新增发行目标时只改这里）。
- 发布顺序（CI 出包）：`bump` → 提交推送 → `git tag vX.Y.Z && git push origin vX.Y.Z` → `gh release create vX.Y.Z --generate-notes`（只建 Release，不上传文件）。`.github/workflows/release.yml` 会在 release published 时分别用 GitHub 的 macOS / Windows runner 构建 dmg 与 exe，并自动 `gh release upload --clobber` 到该 Release。tag 用小写 `v` 前缀（历史遗留的 `V2.2.0` 不再沿用）。
- 本地出包仍可用 `npm run tauri:build`（当前平台，dmg 在 `release/`）；CI 的 workflow_dispatch 手动触发只构建并上传 Actions artifact，不会碰 Release。

## Git

`origin` = ShaneLevs/CCConfig，直接在 `main` 提交推送。提交信息用 `feat:` / `fix:` / `style:` / `docs:` / `refactor:` 前缀 + 中文描述。

## 发版（GitHub Actions）

发布 GitHub Release 时，`.github/workflows/release.yml` 会自动用 GitHub 的 macOS / Windows runner 构建 dmg 与 NSIS exe，并 `gh release upload --clobber` 到该 Release 的 Assets。**前提：workflow 已在 `main` 上**——Release 事件用的是默认分支的 workflow 文件，没推 main 之前发 Release 不会触发。

### 首次 / 手动试跑

```bash
gh workflow run release.yml
gh run list --workflow=release.yml --limit 3
gh run watch <run-id>
gh run download <run-id> -n ccconfig-macos-dmg -D /tmp/ccconfig-mac
gh run download <run-id> -n ccconfig-windows-exe -D /tmp/ccconfig-win
```

手动触发只构建并上传 Actions artifact，**不会碰任何 Release**。

### 正式发版

```bash
npm run bump -- 1.3.0        # 或 patch / minor / major；5 个版本落点一次写完
npm run version:check
git add -A
git commit -m "chore: 版本号 1.3.0"
git push origin main

git tag v1.3.0
git push origin v1.3.0
gh release create v1.3.0 --title "CCConfig v1.3.0 — 一句话说明" --generate-notes
```

监控与验收：

```bash
gh run list --workflow=release.yml --limit 3
gh run watch <run-id>
gh release view v1.3.0 --json assets --jq '.assets[].name'
```

也可以走网页：Releases → Draft a new release → 选 tag → 写标题/说明 → **Publish release**。注意是 Publish 那一刻触发，存成 draft 不触发。

### 规则与失败处理

- **tag 必须等于 `v` + `package.json` 版本**：workflow 第一步会校验，不一致直接失败（防止 dmg 文件名 / 应用内关于 / git tag 各说各话）。
- 不需要再手动上传安装包；CI 会覆盖同名资产。uTools 插件不进 CI，仍是 `npm run build` → uTools 开发者工具上传 `dist/`。
- CI 失败先看日志；可直接 `gh run rerun <run-id> --failed`。兜底：本地 `npm run tauri:build` 后 `gh release upload vX.Y.Z <文件> --clobber`。
- Windows exe 未签名（SmartScreen 提示），macOS dmg 未公证（首次打开需右键打开）；首次 Windows 构建约 10–20 分钟，两个 job 各 60 分钟超时。

## 核心架构

- **Fat Preload**：所有 Node 敏感操作（文件 I/O、网络、子进程）在 `public/preload/services/` 实现，经 `services.js` 暴露为 `window.services`；由 `vite.config.js` 的 `bundlePreloadPlugin`（esbuild：bundle/cjs/node18）打进 `dist/preload/services.js`。preload 依赖清单在 `public/preload/package.json`（dev 模式 uTools 直接 require 源码需要）。
- **App Context 单例**：`useAppContext` 用模块级 ref（非 provide/inject）在 index.vue 与各子视图间共享状态。
- **Cline 的写入纪律（`services/cline.js`）**：Cline 用 zod 严格校验 `~/.cline/data/settings/providers.json`——`version` 必须是字面量 `1`、每个 provider 的 `updatedAt` 必须是 ISO datetime（`toISOString`）、`tokenSource` 只能是 `manual`/`oauth`/`migration`、`settings.reasoning.effort` 只能取 `none|minimal|low|medium|high|xhigh|max`（写错会让 Cline **静默丢弃该 provider 条目**）、`settings.provider` 必须**等于条目键**（否则 Cline 视为未配置）、文件权限 `0600`。Cline 只跑 `lastUsedProvider` 指向的那一条，条目缺失/被判废时**静默回落内置 cline 账号**（=「配置不生效」），所以读侧用 `effectiveLastUsedProvider` + `checkProviderEntry` 把判废原因回传页面，写侧拒绝把判废条目设为当前使用；下发（`dispatchToCline`）走 `activateClineIfUnset`——Cline 里没有生效的当前供应商时自动启用刚下发的那条并选上第一个模型，已有生效配置时不动用户的选择。解析失败时一律**抛错中止**，绝不「读成空 → 全量写回」。另注意 `models.json` 与 `providers.json` 是**两套独立的 `version: 1` 信封**；IDE 扩展的供应商/模型存在编辑器 globalState 里（非文件），本模块只覆盖 CLI / 桌面版 / SDK，而 MCP（`cline_mcp_settings.json`）与 rules/skills 是 CLI 与扩展共享的。改动后用 `node tests/smoke-cline-test.cjs` 验证。
- **视图组织**：`src/Switch/<app>/ConfigView|McpView|SkillView|PluginView|UsageView.vue` + 同名 `styles/` CSS；跨应用共享组件在 `src/components/`，共享逻辑在 `src/composables/`（Agent 默认顺序与展示名元数据在 `composables/agentMeta.js`，纯数据、无副作用：切换器 / 设置弹窗 / 统计页 Agent 分组标题共用，不要在展示组件里引 `useAgentVisibility`）；单应用专属的弹窗/卡片等子组件放 `src/Switch/<app>/components/`（如 `common/components/BatchAddModelsDialog.vue`、`pi/components/PiPluginDetailDialog.vue`），沿用该视图 `styles/` 里的全局类，不重复定义样式。preload 各功能域模块也在 `public/preload/services/`（如 `skills.js`、`pi-common.js`、`claude-usage.js`），`services.js` 仅做装配（window.services 公开 API 面不可变）。
- **页面进入自动刷新**：`index.vue` 用 `providePageContext(activeTab)` 提供当前 agent / 页签；用 `v-show` 保活的页面视图调用 `usePageRefresh(app, tab, refresh)` 订阅（`src/composables/usePageRefresh.js`）。切到该页时自动执行一次 `refresh`，`autoRefreshing` 至少保持 400ms，右上角刷新按钮绑定 `:loading="loading || autoRefreshing"`。首屏 `onMounted` 的数据加载也要走同一个 refresh 函数，避免首次进入按钮没有加载态；`ConfigView` 因 `v-if` 每次重建，走 `onMounted(refresh)` 即可。
- **数据存储**：配置存 uTools DB（API Key 经 AES-256-CBC 加密，`crypto.js`）；按机器隔离的数据（自动网关、Env 额外字段、通用 MCP 本地启停 `ccconfig_mcp_local_state_<nativeId>`（disabled 名单，主档在 ccconfig_common_mcp）、使用统计 heatmap/usage_cache、MCP 停用、Agent 启停 `ccconfig_visible_agents_<nativeId>`、外观 `ccconfig_dark_background_<nativeId>`（字段 `theme`/`enabled`/`effect`）、界面语言 `ccconfig_locale_<nativeId>`（`{ locale: 'system'|'zh-CN'|'en-US' }`））用 `_<nativeId>` 后缀分文档，旧共享档仅作迁移种子只读；桌面版 Rust 托盘通过 sidecar RPC 先取 nativeId 再读本机语言档。切换配置 = 写 managed env 字段（见 `constants.js`）+ 清非 managed + 合并全局与配置特定 extra fields；激活配置 ID 存 `ccconfig_active_config_id`。
- **命名迁移（ccswitch → ccconfig）**：项目历史上叫 CCSwitch，已全面统一为 CCConfig。旧名只允许作为**数据兼容常量**存在，不能直接删：
  - JS 侧唯一落点 `public/preload/services/legacy.js`（旧文档 ID 前缀、旧加密盐、旧 codex 条目标记、旧导出 `app` 字段、旧网关响应头），其余 preload 源码不应出现旧名。
  - `public/preload/services/db-migrate.js` 在 preload 装载期（`services.js` 的 `syncLifecycle()` 第一步）一次性把 `ccswitch_*` 文档改名为 `ccconfig_*`，并把旧格式密文（`<iv>:<ct>`）换盐重加密为 `v2:<iv>:<ct>`。幂等、失败不删旧档、下次启动重试。
  - Rust 侧同类常量集中在 `src-tauri/src/main.rs` 顶部与 `node_runtime.rs`（旧数据/日志目录、旧语言档、旧 `CCSWITCH_NODE`）；`desktop/sidecar/utools-shim.js` 保留旧 `CCSWITCH_DATA_DIR`、旧设备 ID 哈希种子与旧 nativeId 缓存文档回退。
  - **设备 ID 哈希种子与旧文档 ID 永远不要改**：变了会让所有 `_<nativeId>` 文档孤儿化。
- **Skill 启停**：`.disabled/` 目录机制（物理移动目录），Claude → `~/.claude/skills`，OpenCode → `~/.config/opencode/skills`，通用 → `~/.agents/skills`。
- **Skill 目录扫描必须跟随软链接**：`Dirent.isDirectory()` 对符号链接恒为 false，而用软链挂载 Skill（`~/.agents/skills/ego-browser -> ~/.local/share/ego/ego-skills`、dotfiles 管理）很常见，直接判 `isDirectory()` 会让条目整条消失且不报错。判定统一走 `public/preload/services/fs-utils.js` 的 `isDirEntry` / `isFileEntry` / `countEntries`，**删除统一走 `rmEntry`（软链只删链接，绝不递归进源目录）**。新增 skill 扫描/删除代码时不得直接写 `entry.isDirectory()` 或裸 `fs.rmSync(..., {recursive:true})`。冒烟测试 `tests/smoke-symlink-skill.cjs`。
- **通用 Skill 场景**（`common.js` 的 `getSkillScenes` / `switchSkillScene`，UI 在「通用 → Skill」）：场景按用途绑定一组 Skill，切换后只启用绑定的那些、其余移入 `.disabled/`；绑定的 Skill 尚未安装时记入 `missing`，安装完成后自动补启用；装载/每次进入时重放一次生效场景。场景与当前场景按机器隔离存 `ccconfig_skill_scenes_<nativeId>`（`activeId` 为空 = 未启用场景，仅作删除当前场景 / 旧数据的兜底，界面不再提供「手动」入口）。逐个勾选 Skill 会同步当前场景绑定，删除 Skill 会从所有场景清理。uTools 用一条动态指令 `switchSkillScene` 承载全部场景名（`场景：<名称>` / `Scene: <名称>`；不再有「场景：关闭」），桌面版在托盘弹窗里用标签按钮展示场景并高亮当前生效项。
- **自动网关**（`autoroute.js` + `autoroute-convert/`，UI 名为「网关」）：本地网关（默认 127.0.0.1:17877），入站 Anthropic Messages / OpenAI Chat / Responses 三协议，同协议透传、跨协议经 canonical 中间格式转换（含 SSE 流式）；不校验 key（仅本机回环，任意值或留空均放行）；请求日志存内存（最近 10 条，解析出目标模型即插「进行中」行、完成原地补全）；模型映射首次初始化自动预置 flash / plus / pro 三行（目标留空，用户自选或删行）——**映射行顺序即下发顺序**（行首序号是拖拽手柄，悬停变手柄图标、上下拖动重排、↑/↓ 等价，松手落库；`mappings` 数组顺序 = `dispatchAutoRoute` 写入顺序）。**映射模式下响应里的 model 也会改写成映射名**（`autoroute-convert/model-alias.js`，配置 `rewriteModel` 默认开、网关页映射区可关）：agent 会把响应 model 记进自己的会话记录（Claude Code 的 `assistant.message.model`、Grok Build 的 `usage.json modelUsage`），各应用的使用统计读的正是这些记录，不改写就只能看到上游真实模型名。共四条出站路径（透传非流式 / 透传流式 SSE / 转换非流式 / 转换流式），改一处必须四处一起改，否则统计口径不一致。转换层规则（推理强度/媒体降级/结构化输出/tool schema 修补）与上游容错（重试、被拒可选字段记忆、断连中止、协议头透传）见 README「数据流」网关小节；**修改转换行为时必须同步 canonical.js 头注释与 README**。

- **订阅用量**（`subscriptions.js` + `browser-cookies.js` + `sqlite-query.js`，UI 在「通用 → 订阅」）：用户手动添加自己订阅的第三方服务，插件读**本机浏览器的会话 Cookie**（Chromium SQLite + 钥匙串/DPAPI、Firefox `moz_cookies`、Safari binarycookies）代他请求官方没有公开的用量接口；Cookie 加密后存 `ccconfig_subscriptions_<nativeId>`，对外结构只留 `hasCookie`。刷新有 5 分钟节流 + 并发守卫；**桌面版托盘弹窗先渲染 `getSubscriptionsTray` 的缓存快照，再在页面里走异步 `/rpc-poll` 触发 `refreshSubscriptions` 后原地更新**（不阻塞 Rust 主线程）。新增站点只需在 `ADAPTERS` 加一条（`{id,cookieHosts,cookieNames,loginUrl,apiBase,fetchUsage}`），UI/存储/托盘都不用改；具体字段与踩过的坑见 [docs/architecture.md](docs/architecture.md)「订阅用量」。

各应用配置文件的具体读写规则与字段约定见 [README.md](README.md)「数据流」与「认证与模型选择细节」两节。

## Agent 启停 ↔ 启动指令

plugin.json **仅静态声明** commonConfig / installCommonSkill；各 agent 指令由 `commands.js` 内置规范（`FEATURE_DEFINITIONS`）按启停状态动态注册/移除（`utools.setFeature/removeFeature`）。preload 顶层 + `onPluginEnter` 每次从 DB（`ccconfig_visible_agents`）重放同步，渲染进程勾选变化即时调 `syncAgentCommands`，语言切换时 `services.setLocale` 也会重放。explain / regex label 跟随当前语言，`cmds` 同时保留中英关键词。**注意 uTools 没有 onPluginReady API**，误用会抛 TypeError 中断注册链路。

## 多语言（i18n）

- 文案单一事实来源：`shared/i18n/{zh-CN,en-US}/*.json`，按域拆文件；根节点即命名空间。Vue 用 `src/i18n/index.js`（`import.meta.glob` 合并），preload 用 `public/preload/services/i18n.js`（CJS require，esbuild 内联），Rust 用 `src-tauri/src/i18n.rs`（`include_str!` 读 `native.json`）。
- 所有用户可见文案走 `t()`；注释、`console.*`、品牌名、DB id、env key、provider/model id、写入外部配置的生成内容不翻译。完整约定与 key 清单见 [docs/i18n.md](docs/i18n.md)。
- 新增文案必须同时写 `zh-CN` 与 `en-US`；`npm run i18n:check` 会校验 key / 占位符一致与英文残留中文。
- 语言切换：`src/composables/useLocale.js`（按机器 `ccconfig_locale_<nativeId>`，旧共享 `ccconfig_locale` 仅作迁移种子；写 DB 要带 `_rev`），变更后调用 `window.services.setLocale()` 让 preload 与 uTools 指令同步换语言。
- 外观：`src/composables/useAppearance.js` 解析 `system|light|dark`；只有固定主题与系统外观不一致时才给 `<html>` 加 `theme-mismatch`（`theme.css` 用 `::before` 铺纯色底），一致时保留原生毛玻璃。

## 样式规范

- 文本/背景色一律用 TDesign CSS 变量（`--td-text-color-primary`、`--td-bg-color-container` 等）以支持暗色；暗色覆盖写 `:root[theme-mode="dark"] .class {}`。
- 复选框/下拉勾选态统一绿色：已在 `src/main.css` 全局固定（`.t-checkbox` / `.t-select-option.t-is-selected` / `.t-cascader__item.t-is-selected` 上重绑 `--td-brand-color: var(--td-success-color)`），新增复选框/多选组件无需也不要再逐视图覆盖。
- 每个视图对应 `src/Switch/<app>/styles/` 同名 CSS；共享组件样式写在组件内部。

## 构建注意

- `build` / `build:app` 会先跑 `version:check`、`i18n:check` 与 `routes:check`。
- **`routes:check`（`tests/smoke-app-routes-test.cjs`）是新增 agent 的防白屏闸**：`src/App.vue` 里 `<Switch v-if="[...].includes(route)" />` 的数组是**整个页面渲染的总闸**，uTools 指令的 `action.code` 不在里面时页面完全不挂载、白屏且不报错。本检查静态解析源码，校验 `APP_TABS` 每个 key（agent id）→ `<agent>Config`（common → `commonConfig`）都在白名单里、`DEEP_LINK_ROUTES` 的 route 也在白名单里、`index.vue` 的 `appMap` 覆盖一致、白名单无孤儿项与重复项。**新增 agent 时不要只补 `agentMeta` / `appTabs` / `commands.js`，`App.vue` 白名单同样必须补**，漏了构建会直接失败。
- **`public/preload` 有独立依赖清单**（json5 / smol-toml / fzstd / js-yaml）：根 `npm install` / `npm ci` 的 `postinstall` 会调 `scripts/install-preload-deps.mjs` 安装到 `public/preload/node_modules`，CI 也显式跑一次。新增 preload 依赖只改 `public/preload/package.json` 并在该目录更新 lock，**不要并进根 `package.json`**（esbuild 打包 preload 时按该目录解析）。
- 构建后清理 Vite 复制到 `dist/preload` 的 node_modules（js-yaml 的 .map 会导致 uTools 打包拒绝）及 .DS_Store。
- `@modelcontextprotocol/sdk` 在 `mcp.js` try/catch 懒加载，缺失时工具发现自动降级。
- Base path `./`（uTools file:// 加载）。
- 普通 CSS 文件（非 SFC scoped）中 `:deep()` 不会被 Vue 转换，是无效选择器，不要使用。

## 双发行：uTools 插件 + 桌面版（macOS / Windows）

同一个仓库产出两个发行目标，**业务代码只有一份**。

| 发行版 | 壳 | 构建命令 | 产物 |
|---|---|---|---|
| uTools 插件 | uTools 宿主 | `npm run build` | `dist/`（加载 `plugin.json`） |
| macOS 桌面版 | Tauri v2 | `npm run tauri:build` | `.dmg` → `release/`（原始产物在 `src-tauri/target/release/bundle/dmg/`） |
| Windows 桌面版 | Tauri v2（NSIS） | `npm run tauri:build`（在 Windows 上） | `*-setup.exe` → `release/`（原始产物在 `src-tauri/target/release/bundle/nsis/`） |
| 桌面版 CI | GitHub Actions | 发布 Release / 手动 `workflow_dispatch` | dmg + exe 自动挂到 Release Assets（见 `.github/workflows/release.yml`） |
| 桌面版开发 | Tauri v2 | `npm run tauri:dev` | 自动串起 `build:app` + `tauri dev` |

`npm run build:app` = `cross-env CCCONFIG_TARGET=app vite build`（产出 `dist-app/`）+ `scripts/prepare-sidecar.mjs`（组装 `src-tauri/resources/sidecar/`）。
`npm run tauri:build` = `build:app` + `tauri build`（npm 的 `@tauri-apps/cli`，会自动合并 `tauri.windows.conf.json`）+ `scripts/collect-release.mjs`（把当次版本的 dmg / exe 复制到仓库根 `release/`，已 gitignore）。

### 目录职责

| 目录 | 归属 |
|---|---|
| `src/**` | **共享**（两个发行版同一份源码） |
| `shared/i18n/**` | **共享**（Vue / preload / Rust 三端共用的中英文案 JSON） |
| `public/preload/services/**`、`services.js` | **共享**（esbuild 打成 `services.js`，uTools 当 preload、桌面版当 sidecar 主体） |
| `public/plugin.json` | 仅 uTools |
| `src-tauri/**` | 仅桌面版（Rust 壳、Node 探测、托盘、窗口） |
| `desktop/sidecar/**` | 仅桌面版（`server.js` HTTP 服务 + `utools-shim.js`） |
| `desktop/bridge/window-shim.js` | 仅桌面版（构建时注入前端，提供 `window.utools` / `window.services`） |
| `desktop/guide.html` | 仅桌面版（启动失败引导页：未装 Node / sidecar 起不来，会显示实际原因） |
| `desktop/tray.html` | 仅桌面版（托盘弹窗静态页：「网关」页签 = 状态 / 统计 / 接入模式配置 / Skill 场景，「用量」页签 = Token 柱状图 + 订阅进度条，底部动作；构建时原样复制进 `dist-app`） |
| `src-tauri/capabilities/default.json` | 仅桌面版（授权 `data-tauri-drag-region` 拖窗口 / 双击最大化用的两个 window 命令） |

唯一的构建期分叉点是 `vite.config.js` 的 `IS_APP`（切 outDir + 注入 bridge）。

### 改动的三条硬约束

1. **新增任何 `utools.xxx` 调用，必须在 `desktop/bridge/window-shim.js` 同步实现。**
   bridge 目前只覆盖：`db.*`、`getPath`、`getNativeId`、`shellOpenPath`、`shellOpenExternal`、`copyText`、`showOpenDialog`、`onPluginEnter/Out`、`setFeature/removeFeature/getFeatures`、`isWindows/isMacOS/isLinux`。
   用了这之外（如 `showNotification`、`getUser`、`db.promises`、`getAppVersion`）→ uTools 版正常，桌面版 `undefined` 直接抛错。
2. **services 方法的返回值必须能 JSON 往返。** 桌面版走 HTTP JSON，uTools 版是共享内存对象。`Buffer` 会变成 `{type:'Buffer',data:[…]}`、`Date` 变字符串、`undefined` 变 `null`、函数/循环引用直接抛错。
3. **慢操作必须返回 Promise。** 桌面版 bridge：同步方法走同步 XHR（Phase 0 实测 WKWebView 支持，含跨域 preflight）；返回 Promise 的方法走**异步任务通道**——sidecar `/rpc` 立即回 taskId，bridge 用异步 XHR 长轮询 `/rpc-poll`（服务端 25s 上限、客户端 35s 超时）取结果并返回真 Promise，主线程不被外部网络等慢操作卡死，await / .then / .catch 语义与 uTools 版一致。注意通道只覆盖「函数返回 Promise」；函数体内的同步慢操作（execSync、同步大文件 IO）仍会同时阻塞 WebView 与 sidecar 事件循环，禁止新增。

### 桌面版特有约定

- 数据目录 `~/.ccconfig/`（`db/` 下每文档一个 JSON、`runtime.json`、`logs/sidecar.log`），文档文件 0600、目录 0700；`db/` 文件名是 `<ID 清洗后的可读前缀>-<sha1(ID) 前 12 位>.json`（ID 可能含 `/`、`:`、中文，macOS 卷还大小写/规范化不敏感，slug 只负责可读性，哈希负责唯一，真实 `_id` 以文件内容为准）；旧位置 `~/Library/Application Support/CCSwitch` 启动时只迁移 `runtime.json` 与日志（`main.rs` 的 `migrate_legacy_data`），旧 `db.json` 不再读取。
- **旧命名兼容清单**（改名前的字面量，已成数据在用户磁盘上，**不可随手改**）：db 文档 ID 前缀、导出文件 `app` 字段、网关响应头、AES 加密盐、`~/.codex/models.json` 里的条目标记、旧数据/日志目录、旧环境变量、设备 ID 哈希种子。落点见上文「命名迁移」小节；新增兼容项请加到 `legacy.js` / `main.rs` 常量区并注明用途与「何时可删」。
- `setFeature` / `removeFeature` / `getFeatures` 在桌面版是 no-op（不迁移 uTools 搜索框指令）。
- `onPluginEnter` 在桌面版只在首帧触发一次，`action.code` 固定 `commonConfig`（桌面版没有「重新进入」的概念，重复触发会重置用户当前视图）。
- 桌面版 bridge 带诊断通道：前端 `console.error` / `window.onerror` / `unhandledrejection` 会转发到 `~/.ccconfig/logs/sidecar.log`（`[webview:*]` 前缀）。排查桌面版问题先看这个日志。
- **窗口外观与 uTools 版共用一套透明 CSS**：主窗口 `transparent(true)` + `window-vibrancy` 的 `NSVisualEffectView`（`UnderWindowBackground`，见 `main.rs` 的 `build_main_window`），页面根节点保持透明（与 uTools 的宿主亚克力同一语义）。因此：
  - **禁止再给 `html` / `body` 注入不透明底色**（旧版 bridge 的 `injectBackground` 已删除）。透明是必需的：WebGL 背景特效的 canvas 是 `position: fixed; z-index: -1`，不透明 `body` 背景会把它整个盖住（桌面版「特效不生效」的历史根因）。同理 `theme.css` 里 `effect-active` 的深色实底给的是 `:root` 而不是 `body`。
  - 顶栏是 **overlay 透明标题栏**（`TitleBarStyle::Overlay` + `hidden_title(true)`）：红绿灯浮在页面上，顶栏区就是页面自己的底色/特效。bridge 在 `<html>` 上打 `.is-desktop`，`main.css` 据此暴露 `--cc-desktop-titlebar`（uTools 版为 0），`index.vue` 的 `.container` 顶部内边距与 `AgentSideRail` 的起始位置都吃这个变量 —— 新增顶部固定元素时同样要用它让开红绿灯。
  - 窗口在应用 vibrancy 后才 `show()`（`visible(false)` 起步），避免首帧白闪；`apply_vibrancy` 失败只退化告警，不影响启动。
  - overlay 标题栏下红绿灯不再自带拖区，拖动靠 **`data-tauri-drag-region`**（Tauri 内置 `drag.js`）：顶部 34px 拖拽带在 `index.vue` 的 `.window-drag-strip`，`.header` 整行也可拖，且带 `="false"` 的可点击元素（如切换器 `.app-selector`）会剥掉拖区。**新增顶部交互元素时必验拖动不吞点击**；对应权限在 `capabilities/default.json`。
- **菜单栏图标 = 自定义弹窗**（`main.rs` 的 `build_tray_popup` + `desktop/tray.html`）：**左键切换弹窗**，**右键直接打开主窗口**。弹窗分两个页签：「网关」= 运行状态 + 2×2 统计卡片 + 接入模式（模型直连 / 模型映射，可直接改并即时落库）+ Skill 场景；「用量」= 通用统计的 Token 柱状图（模型 / Agent 可切，悬浮某色时其余天与图例同步置灰）+ 订阅剩余额度进度条；底部「打开主窗口 / 退出」。不再使用原生 NSMenu —— 原生菜单的纯展示行要么发灰、要么可点击，做不出卡片/图表/进度条观感。
  - 弹窗是常驻隐藏的独立 WebView 窗口（`TRAY_POPUP`），启动时创建，页面在后台加载并量好高度；首次点击零等待。窗口 `transparent + always_on_top + skip_taskbar + decorations(false)`，背景与主窗口同源：macOS 用 `window-vibrancy` 的 `NSVisualEffectView`（`Popover` 材质、radius 14），Windows 用 `apply_acrylic`（失败退化 `apply_blur`，色调跟随 `AppsUseLightTheme`）。
  - **页面根节点保持透明**（`html`/`body` 不铺底色），只在 `#panel` 上叠一层淡色保证可读性；否则原生玻璃被盖住。
  - 数据由 `desktop/tray.html` 自己走 sidecar HTTP `/rpc` 拉（同步方法直取；`refreshSubscriptions` 这类返回 Promise 的走 `/rpc-poll` 异步通道）。Rust 只注入 `__CCCONFIG_PORT__` / `__CCCONFIG_TOKEN__` 与 `native.json` 的 `tray` 子树（`__CC_TRAY_I18N__`）——**展开时重新注入语言并调用 `window.__ccTrayReload()`**，所以主窗口里改语言后下次展开即生效。只读缓存快照先渲染，随后后台刷新，节流在 service 层。
  - 网关页签的模型选择与映射编辑直接读写 `readAutoRouteConfig` / `writeAutoRouteConfig`（连续点击按 Promise 队列串行落库，避免读改写交错）；模型清单走 `getGatewayRouteOptions`（供应商名 + 模型 id/name，**不含解密后的 apiKey**），不要改用 `readCommonProviders`。用量页签走 `readCommonUsageForTray`（只回最近 60 天按模型 / Agent 拆好的 tokens，口径与 `UsageTokenChart` 一致），不传 365 天全量 contributions。
  - 高度自适应：页面渲染后用 `tray_popup_resize` 上报 `#panel` 高度（逻辑像素，上限 560），Rust `set_size` 后在托盘图标旁重新定位；图标在屏幕下半部分时向上展开，并夹在工作区内。
  - 失焦即收起（`WindowEvent::Focused(false)`）；点托盘图标时窗口会先失焦，`hidden_by_blur` 的 350ms 时间窗把紧随其后的 Click 识别为「收起」而不是「重新打开」。
  - 动作走应用命令 `tray_popup_action` / `tray_popup_resize` / `tray_popup_hide`（`invoke_handler`），**不新增 `utools.xxx` 调用**；`tray.html` 是静态页，不经过 Vue 与 desktop bridge，构建时由 `vite.config.js` 的 `closeBundle` 原样复制进 `dist-app`。新增顶部/交互元素不涉及主窗口 `data-tauri-drag-region`。
- sidecar 的资源目录里（`src-tauri/resources/sidecar/`） `server.js`、`services.js`、`usage-worker.js`、`utools-shim.js`、`package.json` **必须同级**（`usage-async.js` 用 `__dirname` 拼 worker 路径；`package.json` 声明 `type: commonjs` 抵消根目录的 `type: module`）。
- 各应用配置文件位置、字段语义与读写规则、网关转换细节统一维护在 `docs/architecture.md`（README 只保留概览，新增/修改数据流规则时改这里）。

### Windows 桌面版（与 macOS 的差异）

- **窗口**：Windows 保留系统原生标题栏。`title_bar_style` / `hidden_title` 在 tauri 里是 `#[cfg(target_os = "macos")]`（无条件调用会编不过 Windows），`main.rs` 已做 cfg 门控；bridge 在 `<html>` 上加 `.is-windows`，`main.css` 据此把 `--cc-desktop-titlebar` 置 0。主窗口背景走 Mica → 亚克力 → 模糊，托盘弹窗只用亚克力。
- **路径**：`home_dir()` 用 `USERPROFILE` / `HOMEDRIVE+HOMEPATH` 兜底（Windows 默认没有 `HOME`），数据目录 `%USERPROFILE%\.ccconfig`；`main.rs` / `node_runtime.rs` / `sidecar.rs` 统一走它。
- **verbatim 路径（v1.3.0 Windows 版打不开的根因）**：tauri 的 `resource_dir()` 内部 `canonicalize()` 了 exe 路径，Windows 上返回 `\\?\C:\...`。Rust 自己用没事，但 Node 24.x 的 `fs.realpathSync` 把根 `\\?\C:\` 原样交给 libuv，libuv 去掉末尾分隔符后只剩 `C:`，直接抛 `EISDIR: illegal operation on a directory, lstat 'C:'`，sidecar 起不来（日志里全是这段栈 +「sidecar 未输出合法端口」；Node 24.21 之后才修了这个 bug，不能指望用户的 Node 版本）。**凡是交给 Node 的路径必须先过 `main.rs` 的 `simplify_path()`**（`resolve_sidecar_dir` 已处理，`Sidecar::start` 里再兜一次）。排查 Windows 启动问题时先看 `~/.ccconfig/logs/sidecar.log` 里 `[sidecar] 启动 node=... script=... cwd=...` 那行，能直接看出传给 Node 的路径。
- **Node 探测**：Program Files / `%LOCALAPPDATA%\Programs`、volta、nvm-windows（`NVM_HOME`/`NVM_SYMLINK`/`%APPDATA%\nvm`）、fnm，最后 `where node`；**过滤 `WindowsApps` 的商店别名**（执行会拉起 Microsoft Store）。所有 spawn 的 Node / reg / where 子进程统一 `CREATE_NO_WINDOW`，否则会弹黑窗。
- **shim**：`desktop/sidecar/utools-shim.js` 的 `isWindows/isMacOS/isLinux` 用 `process.platform`，bridge 用 UA；`shellOpenPath` / `shellOpenExternal` / `copyText` / `showOpenDialog` 在 Windows 走 `cmd /c start`、PowerShell `Set-Clipboard`、PowerShell WinForms 对话框（`clip.exe` 按控制台代码页解码，中文会乱码）。
- **打包**：`src-tauri/tauri.windows.conf.json` 把 target 换成 `nsis` 并指定 `icons/icon.ico`（由 `npx tauri icon` 生成并入库）。Windows 版同样要求本机已装 Node ≥ 18；未签名安装包会触发 SmartScreen 提示。
- **验证状态**：v1.3.0 实机首次运行只走到「sidecar 起不来」，已定位为上面的 verbatim 路径问题并在 v1.3.1 修复；托盘、透明/Mica、Node 探测仍需在 Windows 实机验收。

- 首次 `cargo build` 若卡在 crates.io，可在 `src-tauri/.cargo/config.toml` 加稀疏镜像（该文件已 gitignore，各人自备）：`[source.crates-io] replace-with = "rsproxy"` + `[source.rsproxy] registry = "sparse+https://rsproxy.cn/index/"`。
