# AGENTS.md

CCSwitch（uTools 插件名 CCConfig）：管理 Claude Code / OpenCode / Pi / omp / Reasonix / Codex / Kimi Code / MiniMax Code 八应用的 API 配置切换、MCP/Skill/Plugin 管理与使用统计；另有「通用配置」应用（跨 agent 供应商/模型主数据、通用 MCP/Skill、自动路由网关、模型下发）。

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
- **视图组织**：`src/Switch/<app>/ConfigView|McpView|SkillView|PluginView|UsageView.vue` + 同名 `styles/` CSS；跨应用共享组件在 `src/components/`，共享逻辑在 `src/composables/`。
- **数据存储**：配置存 uTools DB（API Key 经 AES-256-CBC 加密，`crypto.js`）；按机器隔离的数据（自动路由、Env 额外字段、使用统计 heatmap/usage_cache、MCP 停用、Agent 启停 `ccswitch_visible_agents_<nativeId>`、背景特效 `ccswitch_dark_background_<nativeId>`）用 `_<nativeId>` 后缀分文档，旧共享档仅作迁移种子只读。切换配置 = 写 managed env 字段（见 `constants.js`）+ 清非 managed + 合并全局与配置特定 extra fields；激活配置 ID 存 `ccswitch_active_config_id`。
- **Skill 启停**：`.disabled/` 目录机制（物理移动目录），Claude → `~/.claude/skills`，OpenCode → `~/.config/opencode/skills`，通用 → `~/.agents/skills`。
- **自动路由**（`autoroute.js` + `autoroute-convert/`）：本地网关（默认 127.0.0.1:17877），入站 Anthropic Messages / OpenAI Chat / Responses 三协议，同协议透传、跨协议经 canonical 中间格式转换（含 SSE 流式）；随机 key 防滥用；请求日志存内存（最近 50 条）。

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
