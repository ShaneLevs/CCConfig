# CCConfig

多应用 AI 配置管理工具 — 一款 [uTools](https://u.tools/) 插件，支持 **Claude Code**、**OpenCode**、**Pi Agent**、**omp**、**Reasonix**、**Codex**、**Kimi Code**、**MiniMax Code** 八个 AI 工具的 API 配置切换、MCP/Skill/Plugin 管理以及使用统计分析，另含「**通用配置**」应用（跨 agent 供应商/模型主数据 + 通用 MCP + 通用 Skill）。

## 功能特性

- **应用切换** — Claude Code / OpenCode / Pi Agent / omp / Reasonix / Codex / Kimi Code / MiniMax Code + 通用配置，各自独立配置，一键切换
- **配置管理** — 读取、保存、切换各应用的 API 配置：
  - Claude：`~/.claude/settings.json`（7 个托管 env 字段 + 可变额外字段）
  - OpenCode：`~/.config/opencode.json` / `opencode.jsonc`（json5/jsonc 解析，优先 `.json`，不存在自动检测 `.jsonc`）
  - Pi Agent：`~/.pi/agent/settings.json` + `models.json`
  - omp：`~/.omp/agent/models.yml` 供应商/模型 + `config.yml` modelRoles
  - Reasonix：`~/.reasonix/config.toml`（smol-toml 读写，保留未知扩展字段）+ `~/.reasonix/.env` 密钥管理
  - Codex：`~/.codex/config.toml` + `~/.codex/models.json` 模型目录（仅管模型字段，其余原样保留）
  - Kimi Code：`~/.kimi-code/config.toml`（仅模型配置：providers / models 别名 / default_model）
  - MiniMax Code：`~/.minimax/config.yaml`（仅模型配置：custom_provider 第三方供应商/模型 + 顶层 defaultModel，内置 minimax 只读；跟随 MINIMAX_DATA_DIR / MAVIS_DATA_DIR）
- **通用配置（跨 agent 主数据）** — 供应商/模型主数据库（uTools DB 加密存储），支持 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Google Generative AI 四类协议；MCP 本地（多个本地 JSON 文件，存放位置可设置：预置 `~/.mcp.json` / `~/.config/mcp/mcp.json` / `~/.agents/mcp.json` / `~/.agents/mcp/mcp.json` 多选 + 自定义，未配置默认 `~/.mcp.json`）与云端（uTools DB）双存储、合并为单一列表管理；Skill 存放于 `~/.agents/skills`（跨 agent 共享），支持链接安装与 `.disabled` 启停；汇总统计合并展示已适配 agent（Claude Code / OpenCode / Pi）的使用数据，纯读 uTools DB 秒开
- **自动路由（本地模型网关）** — 通用配置内勾选供应商+模型，经本地端点 `http://127.0.0.1:<port>` 暴露给本机任意 agent：支持 Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三种协议请求，跨协议自动转换（含流式）；随机 key 鉴权，一键下发虚拟供应商到各 agent
- **MCP 配置** — 管理各应用的 MCP Server，支持实时工具发现画布
  - Claude MCP 读写 `~/.claude.json` 顶层 `mcpServers`（Claude Code 官方位置，单一来源，全局生效）
- **Skill 管理** — 从 SkillHub / 魔搭社区一键安装 Skill（通用 / Claude Code / OpenCode），支持全局与项目级 Skill 启用/禁用（`.disabled` 目录机制）
- **Plugin / Extension 管理** — Claude Marketplace 仓库 + 插件生命周期、OpenCode plugin 数组、Pi Extension (npm/git + pi.dev 包市场浏览)
- **使用统计** — Token 用量、模型分布、GitHub 风格贡献墙热力图：
  - Claude：DB 缓存加速二次打开（`file_count:max_mtime` 签名校验），热力图历史持久化，JSONL 读取失败时从历史兜底重建
  - OpenCode：SQLite（opencode.db）原生 `node:sqlite` 读取，Electron 沙箱下子进程回退
  - Pi Agent：JSONL sessions 解析聚合
  - 通用汇总：读取各 agent 统计页落库的 `ccswitch_agent_usage_<agent>_<nativeId>`（按日期与模型跨 agent 合并），不重新解析源文件；数据新鲜度 = 各 agent 统计页最近一次访问
- **模型 CRUD** — OpenCode / Pi / omp / Reasonix / 通用 供应商与模型增删改，模型 ID 可编辑，支持自动从 `/models` API 拉取模型列表；OpenCode / Pi / omp 模型支持上下文窗口与最大输出预设+自定义，OpenCode 另支持 reasoning / modalities（输入输出模态）/ options.effort / options.thinking 思考参数配置，设置默认模型自动切换供应商
- **批量编辑** — 配置聚合组头部 hover 显示批量编辑按钮，一键批量修改聚合组 URL + Key
- **导入导出** — 支持 JSON 文件方式或压缩加密字符串方式
- **密钥加密** — API Key 使用 AES-256-CBC 加密存储到 uTools 数据库
- **深色模式** — 自动跟随系统主题切换，支持可配置的动态背景特效（棱镜光谱爆裂 / 故障像素终端 / 流动极光 / 星河漫游）

## 安装

### 方式一：uTools 插件商店

在 uTools 插件商店搜索 **CCConfig** 即可安装。

### 方式二：本地开发

```bash
# 克隆仓库
git clone https://github.com/<your-username>/CCSwitch.git
cd CCSwitch

# 安装依赖
npm install

# 开发模式（localhost:5173）
npm run dev

# 构建生产版本
npm run build
```

构建产物在 `dist/` 目录，可通过 uTools 开发者工具加载。

## 使用方式

在 uTools 中输入以下关键词唤起插件（点击运行时默认执行第一个关键词）：

| 关键词 | 功能 |
|--------|------|
| `通用配置` | 打开通用配置（跨 agent 供应商/模型主数据、MCP、Skill） |
| `Claude Code配置` | 打开 Claude Code 配置管理 |
| `OpenCode配置` | 打开 OpenCode 配置管理 |
| `Pi Agents配置` | 打开 Pi Agent 配置管理 |
| `omp配置` | 打开 omp 配置管理 |
| `Reasonix配置` | 打开 Reasonix 配置管理 |
| `Codex配置` | 打开 Codex 配置管理 |
| `Kimi Code配置` | 打开 Kimi Code 模型配置 |
| `MiniMax Code配置` | 打开 MiniMax Code 模型配置 |
| 粘贴 SkillHub / 魔搭链接 | 自动进入 Skill 安装（通用 / Claude Code / OpenCode） |
| `pi install <包名>` | 自动进入 Pi Extension 安装 |

## 技术栈

- [Vue 3](https://vuejs.org/) (Composition API + `<script setup>`)
- [Vite](https://vitejs.dev/) + esbuild（preload 打包）
- [TDesign Vue Next](https://tdesign.tencent.com/vue-next)
- [uTools API](https://u.tools/docs/developer/api.html)
- [json5](https://github.com/json5/json5)（OpenCode json/jsonc 配置解析）
- [js-yaml](https://github.com/nodeca/js-yaml)（omp models.yml / config.yml 读写）
- [smol-toml](https://github.com/squirrelchat/smol-toml)（Reasonix / Codex / Kimi Code config.toml 读写）
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)（MCP 工具发现）
- [ogl](https://github.com/oframe/ogl)（深色背景特效 WebGL 渲染）

## 项目结构

```
src/          # Vue 3 渲染层
public/       # uTools 静态资源（plugin.json、各应用图标）
docs/         # 设计文档与计划
```

- **`src/`** — 渲染层。`main.js`/`App.vue` 入口与主题；`Switch/<app>/` 每个应用（claude / opencode / pi / omp / reasonix / codex / kimi / minimax / common 通用配置）一个子目录，内含 ConfigView / McpView / SkillView / PluginView / UsageView 五个视图（部分应用只有其中几个）与同名 `styles/`；`components/` 跨应用共享组件（MCP/Skill 卡片弹窗、背景特效等）；`composables/` 共享逻辑（应用上下文、配置切换/导入导出、Skill 安装等）。
- **`public/preload/`** — Node 敏感操作全部在这里：`services.js` 组装暴露为 `window.services`，具体实现在 `services/` 下按应用/职责分模块（config / common / mcp / opencode / pi / omp / reasonix / codex / kimi / minimax / plugins / dispatch / autoroute / commands / usage / crypto），构建时由 esbuild 打进 `dist/preload/services.js`；preload 依赖清单在 `public/preload/package.json`。

## 数据流

```
Claude:
  ~/.claude/settings.json  ←→  uTools DB（AES-256-CBC 加密）
  ~/.claude.json 顶层 mcpServers（MCP，官方位置，单一来源，全局生效）←→ uTools DB（禁用状态）
  ~/.claude/skills/（全局）+ 项目级 .claude/skills/ + .disabled 目录
  ~/.claude/projects/**/*.jsonl  →  使用统计：
      signature = file_count:max_mtime 校验 → DB 缓存命中秒开
      热力图历史持久化（ccswitch_heatmap_*），全量解析后与历史按日期合并
      JSONL 读取失败时 readPersistedUsage 从历史兜底重建统计

通用配置（跨 agent 主数据）:
  供应商/模型主数据 → uTools DB（ccswitch_common_providers，API Key 加密）
  通用 MCP → uTools DB（ccswitch_common_mcp）+ 本地多个 JSON 文件双存储，按名称合并单一列表，本地/云端 tag 标注，支持双端复制/移除。本地存放位置按机器隔离存 ccswitch_mcp_local_targets_<nativeId>（未配置默认 ~/.mcp.json），可多选预置路径（~/.mcp.json、~/.config/mcp/mcp.json、~/.agents/mcp.json、~/.agents/mcp/mcp.json）或自定义。本地端为镜像语义：所有选中位置保持同一份配置，添加/编辑/删除写入全部文件；保存位置与点「刷新」时合并各文件（同名以 ~/.mcp.json 优先）后统一写回，自动对齐外部修改
  通用 Skill → 只读扫描 ~/.agents/skills（SKILL.md 元数据），启停 = 物理移动目录到 .disabled/（同 Claude Code 机制）
  协议类型：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Google Generative AI
  汇总统计 → 各 agent 统计页计算后落库 ccswitch_agent_usage_<agent>_<nativeId>（days 按日期存 tokens/input/output/models，全零跳过防误清）
    通用统计页纯读这三个 DB 文档跨 agent 合并（日期求和 + 模型并集），不触碰源文件；口径与各 agent 页合并历史后一致
  自动路由 → 本地模型网关（http://127.0.0.1:<port>，默认 17877）：
    入站 POST /v1/messages（Anthropic）/ /v1/chat/completions（OpenAI Chat）/ /v1/responses（OpenAI Responses）+ GET /v1/models
    出站支持 anthropic-messages / openai-completions / openai-responses，google-generative-ai 明确 400
    同协议透传（仅重写 model），跨协议经 canonical 中间格式转换（autoroute-convert/，含流式 SSE 双向转换）
    model 直查按勾选顺序取第一个，兼容「供应商/模型ID」消歧；随机 key 鉴权（Authorization Bearer / x-api-key）
    配置存 uTools DB（ccswitch_autoroute_config），onPluginReady/onPluginEnter 幂等自启动，uTools 退出即停

OpenCode:
  ~/.config/opencode.json / opencode.jsonc (json5/jsonc，优先 .json)  ←→  uTools DB
  模型配置：provider[id].models[id]（name / limit.context / limit.output / reasoning /
    modalities.input、output（text|image|audio|video|pdf）/ options.effort / options.thinking，
    其余未识别字段原样往返；协议→npm 映射见 dispatch.js OPENCODE_NPM_BY_API）
  使用统计：
    数据目录（全平台）：~/.local/share/opencode/opencode.db
    回退候选：%LOCALAPPDATA%\opencode\ → ~/AppData/Local/opencode\ → storage/*.json
    读取路径：原生 node:sqlite → 子进程 --experimental-sqlite（Electron 沙箱回退）
    模型名：session.model 列存 JSON {"id":"...","providerID":"..."}，需取 .id 字段
    usage.calculateStats 汇总 tokens_* 五列（input/output/reasoning/cache_read/cache_write）

Pi Agent:
  ~/.pi/agent/settings.json + models.json + extensions  ←→  uTools DB
  ~/.pi/agent/sessions/**/*.jsonl  →  解析 & 聚合  →  使用统计
  特殊 schema：cost 必须含 {input, output, cacheRead, cacheWrite} 四项；contextWindow 为 0 则省略

omp:
  ~/.omp/agent/config.yml modelRoles  →  js-yaml 直接读写（load → 改 modelRoles → dump 写回）
  ~/.omp/agent/models.yml providers    →  js-yaml 直接读写
  模型引用格式：provider/model[:thinkingLevel]，无前缀引用编辑时自动补全带前缀
  删除供应商/模型前检查 modelRoles 引用，被引用时拒绝删除
  纯文件读写，不依赖 omp 二进制 / bun 运行时

Reasonix:
  ~/.reasonix/config.toml（Windows: %APPDATA%\reasonix\config.toml）→ smol-toml 读写
  ~/.reasonix/.env → API Key / 环境变量管理（掩码编辑，支持按 Reasonix 官方规则自动生成变量名）
  供应商支持多种协议（openai 兼容等），未知扩展字段写回时原样保留

Codex:
  ~/.codex/config.toml → smol-toml 读写（解析失败抛错阻断写回，仅管模型相关字段其余原样保留）
  「模型目录」= 合并各供应商模型写 ~/.codex/models.json + model_catalog_json 绝对路径（正斜杠）
  条目必须符合 Codex ModelInfo schema（reasoning level 键名必须是 effort，含 instructions_template）
  带「由 CCSwitch 生成」标记的旧条目同步时原地升级

Kimi Code:
  ~/.kimi-code/config.toml（KIMI_CODE_HOME 可重定向）→ smol-toml 读写（解析失败抛错）
  只管理三处：顶层 default_model、[providers.<name>]（type/base_url/api_key）、[models."<alias>"]（provider/model/max_context_size 必填）
  api_key 明文写入文件：CLI 不从 shell 环境取凭证（文档要求）
  官方可选扩展字段 display_name / max_input_size / max_output_size / capabilities / support_efforts /
    default_effort / off_effort / reasoning_key / adaptive_thinking 经 MODEL_*_FIELDS 表管理
  协议守卫：max_output_size + adaptive_thinking 仅 anthropic；reasoning_key 仅 openai/openai_responses
  overrides / base_url / protocol 等 CLI 自动写入字段走 _extra 原样往返，UI 不暴露编辑入口
  含 oauth 字段的 /login 托管供应商只读禁改禁删；下发别名 = 供应商/模型ID
  通用库四种协议全支持（openai / openai_responses / anthropic / google-genai 映射）

MiniMax Code:
  ~/.minimax/config.yaml（MINIMAX_DATA_DIR 优先，MAVIS_DATA_DIR 兼容回退）→ js-yaml 读写（解析失败抛错阻断写回）
  只管理两处：顶层 defaultModel、custom_provider.<id>（name / kind:custom / enabled / api / options{baseURL,authMode,apiKey} / models.<id>）
  defaultModel 引用：内置 "minimax/<模型ID>"，第三方 "custom_provider:<id>/<模型ID>"（可带 #variant 后缀，CLI 0.4.12 实测）
  provider.minimax（mcode login / Token Plan 托管）只读展示，可设默认模型、禁改禁删；
    apiKey 明文写入 options.apiKey（与桌面版自身写法一致）
  models 的 limit{context,output}、name、enabled 外，另显式管理 thinking.effortOptions（推理等级）
    与 modalities.input+attachment（支持附件 图片/PDF/视频/音频 → image/pdf/video/audio，text 隐含）；
    thinking 其他子键 / variants / reasoning 等官方字段 _raw 合并保留原样往返
  供应商/模型改 ID 时 defaultModel 引用同步；删除默认模型时清理悬挂引用；API 格式三协议：anthropic-messages / openai-completions / openai-responses
  通用库下发：provider 键经 providerKeyFor 确定性 ASCII 清洗（中文/符号名 → 骨架+稳定哈希，同名恒同键，upsert 幂等）；
    下发刷新 limit/名称/输入模态（model.input 过滤非 text 并入 modalities+attachment），未传字段保留既有值；google 协议供应商拒绝下发
```

## 认证与模型选择细节

### Claude 认证方式

- 每配置可选 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`（互斥，切换时写一清一）。
- 模型输入框下拉候选对任意供应商实时拉取（复用 Pi 的 `fetchProviderModels`，`{baseUrl}/models` → `/v1/models` 回退，Bearer + x-api-key 双头，防抖 500ms，失败静默为空）。
- OpenCode Go：URL 精确等于 `https://opencode.ai/zen/go`（不带 /v1）时自动切 API_KEY 认证。

## 开发

```bash
npm run dev     # 启动开发服务器 http://localhost:5173
npm run build   # 构建生产版本到 dist/
```

## License

MIT
