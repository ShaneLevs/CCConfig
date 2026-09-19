# CCConfig

多应用 AI 配置管理工具 — 一款 [uTools](https://u.tools/) 插件，支持 **Claude Code**、**OpenCode CLI**、**Pi Agent**、**omp**、**Reasonix**、**Codex**、**Kimi Code**、**MiniMax Code** 八个 AI 工具的 API 配置切换、MCP/Skill/Plugin 管理以及使用统计分析，另含「**通用配置**」应用（跨 agent 供应商/模型主数据 + 通用 MCP + 通用 Skill）。

## 功能特性

- **应用切换** — Claude Code / OpenCode CLI / Pi Agent / omp / Reasonix / Codex / Kimi Code / MiniMax Code + 通用配置，各自独立配置，一键切换
- **配置管理** — 读取、保存、切换各应用的 API 配置：
  - Claude：`~/.claude/settings.json`（7 个托管 env 字段 + 可变额外字段）
  - OpenCode CLI：`~/.config/opencode.json` / `opencode.jsonc`（json5/jsonc 解析，优先 `.json`，不存在自动检测 `.jsonc`）
  - Pi Agent：`~/.pi/agent/settings.json` + `models.json`
  - omp：`~/.omp/agent/models.yml` 供应商/模型 + `config.yml` modelRoles
  - Reasonix：`~/.reasonix/config.toml`（smol-toml 读写，保留未知扩展字段）+ `~/.reasonix/.env` 密钥管理
  - Codex：`~/.codex/config.toml` + `~/.codex/models.json` 模型目录（仅管模型字段，其余原样保留）
  - Kimi Code：`~/.kimi-code/config.toml`（仅模型配置：providers / models 别名 / default_model）
  - MiniMax Code：`~/.minimax/config.yaml`（仅模型配置：custom_provider 第三方供应商/模型 + 顶层 defaultModel，内置 minimax 只读；跟随 MINIMAX_DATA_DIR / MAVIS_DATA_DIR）
- **通用配置（跨 agent 主数据）** — 供应商/模型主数据库（uTools DB 加密存储），支持 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Google Generative AI 四类协议；MCP 本地（`~/.mcp.json`）与云端（uTools DB）双存储、合并为单一列表管理；Skill 存放于 `~/.agents/skills`（跨 agent 共享），支持链接安装与 `.disabled` 启停；汇总统计合并展示已适配 agent（Claude Code / OpenCode / Pi）的使用数据，纯读 uTools DB 秒开
- **自动路由（本地模型网关）** — 通用配置内勾选供应商+模型，经本地端点 `http://127.0.0.1:<port>` 暴露给本机任意 agent：支持 Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三种协议请求，跨协议自动转换（含流式）；随机 key 鉴权，一键下发虚拟供应商到各 agent
- **MCP 配置** — 管理各应用的 MCP Server，支持实时工具发现画布
  - Claude MCP 读写 `~/.claude.json` 顶层 `mcpServers`（Claude Code 官方位置，单一来源，全局生效）
- **Skill 管理** — 从 SkillHub / 魔搭社区一键安装 Skill（通用 / Claude Code / OpenCode CLI），支持全局与项目级 Skill 启用/禁用（`.disabled` 目录机制）
- **Plugin / Extension 管理** — Claude Marketplace 仓库 + 插件生命周期、OpenCode CLI plugin 数组、Pi Extension (npm/git + pi.dev 包市场浏览)
- **使用统计** — Token 用量、模型分布、GitHub 风格贡献墙热力图：
  - Claude：DB 缓存加速二次打开（`file_count:max_mtime` 签名校验），热力图历史持久化，JSONL 读取失败时从历史兜底重建
  - OpenCode CLI：SQLite（opencode.db）原生 `node:sqlite` 读取，Electron 沙箱下子进程回退
  - Pi Agent：JSONL sessions 解析聚合
  - 通用汇总：读取各 agent 统计页落库的 `ccswitch_agent_usage_<agent>_<nativeId>`（按日期与模型跨 agent 合并），不重新解析源文件；数据新鲜度 = 各 agent 统计页最近一次访问
- **模型 CRUD** — Pi / omp / Reasonix / 通用 供应商与模型增删改，模型 ID 可编辑，Pi 支持从 `/models` API 自动拉取模型列表、设置默认模型自动切换供应商
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
| `OpenCode配置` | 打开 OpenCode CLI 配置管理 |
| `Pi Agents配置` | 打开 Pi Agent 配置管理 |
| `omp配置` | 打开 omp 配置管理 |
| `Reasonix配置` | 打开 Reasonix 配置管理 |
| `Codex配置` | 打开 Codex 配置管理 |
| `Kimi Code配置` | 打开 Kimi Code 模型配置 |
| `MiniMax Code配置` | 打开 MiniMax Code 模型配置 |
| 粘贴 SkillHub / 魔搭链接 | 自动进入 Skill 安装（通用 / Claude Code / OpenCode CLI） |
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
src/
├── main.js                    # 入口，主题检测与初始化
├── App.vue                    # 根组件：uTools 路由分发 + 深色模式背景特效渲染
├── constants.js               # 托管 env 字段 + 环境变量预设
├── main.css / theme.css       # 全局样式与主题变量
├── components/                # 跨应用共享组件
│   ├── ApiKeyInput.vue        # 密码输入框（可见性切换）
│   ├── DynamicKvEditor.vue    # 可复用 K/V 编辑器（自动补全）
│   ├── PresetCustomInput.vue  # 预设 + 自定义输入
│   ├── McpServerCard.vue      # 通用 MCP 卡片（#tags 插槽，本地/云端 tag）
│   ├── McpServerDialog.vue    # 通用 MCP 添加/编辑弹窗（表单 ↔ JSON 切换，可选 showTarget）
│   ├── McpToolDrawer.vue      # MCP 工具发现抽屉
│   ├── SkillCard.vue          # 通用 Skill 卡片
│   ├── SkillInstallDialog.vue # Skill 链接安装弹窗
│   ├── PrismaticBurst.vue     # 深色背景特效：棱镜光谱爆裂
│   ├── FaultyTerminal.vue     # 深色背景特效：故障像素终端
│   ├── Aurora.vue             # 深色背景特效：流动极光
│   └── Galaxy.vue             # 深色背景特效：星河漫游
├── composables/
│   ├── useAppContext.js       # 应用切换状态（Claude / OpenCode / Pi / omp / Reasonix / Codex / Kimi / 通用）
│   ├── useConfigColumns.js    # 双列可拖拽瀑布流布局
│   ├── useConfigImportExport.js  # 压缩字符串导入导出
│   ├── useConfigSwitch.js     # 应用配置到 settings.json
│   ├── useExtraFields.js      # 全局 vs 配置特定 env 额外字段
│   ├── useDarkBackground.js   # 深色模式背景开关 + 效果选择（DB 持久化）
│   └── useSkillInstall.js     # SkillHub / ModelScope 安装流程
├── utils/
│   └── time.js                # 时间格式化工具
└── Switch/                    # 每个应用一个子目录（views + styles）
    ├── index.vue              # 主界面（应用切换 + 各应用 Tab 栏 + 设置弹窗）
    ├── shared/
    │   ├── ContributionGrid.vue  # GitHub 风格贡献墙热力图
    │   └── styles/
    ├── claude/                # Claude Code 视图
    │   ├── ConfigView.vue     # 配置 CRUD + 双列布局
    │   ├── McpView.vue        # MCP 管理（读写 ~/.claude.json 顶层 mcpServers）
    │   ├── SkillView.vue      # Skill 管理（全局/项目级）
    │   ├── PluginView.vue     # Marketplace 仓库 + 插件生命周期
    │   ├── UsageView.vue      # 使用统计（DB 缓存 + 热力图历史合并）
    │   └── styles/
    ├── opencode/              # OpenCode CLI 视图
    │   ├── ConfigView.vue     # Provider CRUD（Provider Collapse + 卡片内模型管理）
    │   ├── McpView.vue        # MCP 管理（LOCAL/REMOTE）
    │   ├── SkillView.vue      # Skill 管理
    │   ├── PluginView.vue     # plugin 数组管理
    │   ├── UsageView.vue      # 使用统计（opencode.db SQLite + JSON 兜底）
    │   └── styles/
    ├── pi/                    # Pi Agent 视图
    │   ├── ConfigView.vue     # 供应商/模型 CRUD + 自动拉取 + 默认模型自动切换供应商
    │   ├── McpView.vue        # MCP（来自扩展）
    │   ├── SkillView.vue      # Skill（来自扩展）
    │   ├── PluginView.vue     # Extension（npm/git + pi.dev 市场浏览）
    │   ├── UsageView.vue      # 使用统计（JSONL sessions）
    │   └── styles/
    ├── omp/                   # omp 视图
    │   ├── ConfigView.vue     # modelRoles + 供应商/模型 CRUD
    │   └── styles/
    ├── reasonix/              # Reasonix 视图
    │   ├── ConfigView.vue     # 供应商/模型/默认模型 + .env 密钥管理
    │   └── styles/
    ├── codex/                 # Codex 视图（仅配置 tab）
    │   ├── ConfigView.vue     # 供应商 CRUD + 模型目录同步（~/.codex/models.json）
    │   └── styles/
    ├── kimi/                  # Kimi Code 视图（仅配置 tab）
    │   ├── ConfigView.vue     # 供应商手风琴 + 模型别名标签（星标设默认，含扩展字段高级选项）
    │   └── styles/
    ├── minimax/               # MiniMax Code 视图（仅配置 tab）
    │   ├── ConfigView.vue     # 供应商手风琴 + 模型标签（内置只读可设默认，星标设 defaultModel）
    │   └── styles/
    └── common/                # 通用配置（跨 agent 主数据）
        ├── ConfigView.vue     # 供应商/模型主数据库 CRUD（四协议）
        ├── McpView.vue        # MCP：本地 ~/.mcp.json + 云端 DB 合并单一列表
        ├── SkillView.vue      # Skill：只读扫描 ~/.agents/skills + 链接安装 + .disabled 启停
        ├── AutoRouteView.vue  # 自动路由：本地模型网关（开关/端口/key/模型勾选/下发/请求日志）
        ├── UsageView.vue      # 汇总统计：纯读 DB 合并 Claude/OpenCode/Pi 落库数据
        └── styles/
public/
├── plugin.json                # uTools 插件配置（关键词/特性）
├── logo.png                   # 插件主 logo（45° 彩虹星芒）
├── gen.svg                    # 通用配置功能图标
├── claudecode.png             # Claude Code 专属图标
├── icon-opencode.png / icon-pi.png / omp-icon.svg / reasonix.svg / icon-codex.png / kimi.svg
└── preload/
    ├── services.js            # 服务入口 → window.services
    ├── package.json           # Preload 依赖清单（json5 / js-yaml / smol-toml）
    └── services/
        ├── config.js          # Claude settings.json / ~/.claude.json I/O（含顶层 mcpServers）、压缩、持久化
        ├── common.js          # 通用配置：供应商/模型主数据 + 本地/云端 MCP + ~/.agents/skills Skill
        ├── crypto.js          # AES-256-CBC 加密 + 替换加密
        ├── mcp.js             # MCP 启停 + SDK 工具发现（STDIO/HTTP/SSE）
        ├── plugins.js         # Claude 插件 Marketplace / 组件发现
        ├── opencode.js        # OpenCode CLI 配置 CRUD（json5/jsonc）+ SQLite/JSON 统计
        ├── pi.js              # Pi Agent 供应商/模型/扩展 CRUD + /models API 自动拉取
        ├── omp.js             # omp modelRoles + models.yml providers CRUD（js-yaml）
        ├── reasonix.js        # Reasonix config.toml + .env 读写（smol-toml）
        ├── codex.js           # Codex config.toml + models.json 模型目录读写（smol-toml）
        ├── kimi.js            # Kimi Code config.toml 读写（providers/models/default_model，smol-toml）
        ├── minimax.js         # MiniMax Code config.yaml 读写（custom_provider/models/defaultModel，js-yaml）
        ├── commands.js        # 各 agent 动态启动指令注册/移除（FEATURE_DEFINITIONS ↔ 启停状态同步）
        ├── dispatch.js        # 通用库 → 各 agent 模型配置下发（dispatchCommonModel / dispatchAutoRoute）
        ├── autoroute.js       # 自动路由本地网关（uTools DB 配置、http server 启停、路由、请求日志）
        ├── autoroute-convert/ # 协议转换层：canonical.js + source.js/target.js + stream.js
        └── usage.js           # 共享统计聚合（Claude / OpenCode / Pi）+ 跨 agent 统一落库（saveAgentUsage / readAllAgentUsage → ccswitch_agent_usage_*）
```

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
  通用 MCP → uTools DB（ccswitch_common_mcp）+ 本地 ~/.mcp.json 双存储，按名称合并单一列表，本地/云端 tag 标注，支持双端复制/移除
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

OpenCode CLI:
  ~/.config/opencode.json / opencode.jsonc (json5/jsonc，优先 .json)  ←→  uTools DB
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
