# 架构与数据流

面向贡献者与问题排查者的技术文档。功能概览、安装与使用方式见 [README](../README.md)。

- 项目结构（渲染层 / preload / 桌面版 / Rust 外壳）见下文「项目结构」。
- 双发行（uTools 插件 + 桌面版 macOS / Windows）的构建命令、目录职责与三条硬约束见 [AGENTS.md](../AGENTS.md)。
- 下文「数据流」逐应用列出文件位置、字段语义与读写规则，「认证与模型选择细节」补充 Claude 的特殊处理。

## 项目结构

```
src/          # Vue 3 渲染层（两个发行版共用）
shared/i18n/  # 中英文案 JSON（Vue / preload / Rust 共用）
public/       # uTools 静态资源（plugin.json、各应用图标）+ preload
desktop/      # 仅桌面版：sidecar 服务、utools shim、前端 bridge、引导页
src-tauri/    # 仅桌面版：Tauri v2 外壳（Rust）
docs/         # 架构文档
```

- **`src/`** — 渲染层。`main.js`/`App.vue` 入口；`i18n/` 语言解析与 vue-i18n 实例，`composables/useAppearance.js` 解析外观（跟随系统/浅色/深色），`composables/useLocale.js` 管理语言；`Switch/<app>/` 每个应用（claude / opencode / pi / omp / reasonix / codex / kimi / minimax / qoder / zcode / hermes / dsh / grok / common 通用配置）一个子目录，内含 ConfigView / McpView / SkillView / PluginView / UsageView 五个视图（部分应用只有其中几个）与同名 `styles/`；`components/` 跨应用共享组件（MCP/Skill 卡片弹窗、外观设置等）；`composables/` 共享逻辑（应用上下文、配置切换/导入导出、Skill 安装等）。
- **`shared/i18n/`** — 中英文案单一事实来源（按域拆 JSON）。Vue 通过 `src/i18n/index.js` 的 `import.meta.glob` 合并；preload 通过 `services/i18n.js` 用 CJS require（esbuild 内联）；Rust 通过 `src-tauri/src/i18n.rs` 的 `include_str!` 读 `native.json`。
- **`public/preload/`** — Node 敏感操作全部在这里：`services.js` 组装暴露为 `window.services`，具体实现在 `services/` 下按应用/职责分模块（config / common / mcp / opencode / pi / omp / reasonix / codex / kimi / minimax / qoder / zcode / hermes / dsh / grok / plugins / dispatch / autoroute / subscriptions / browser-cookies / sqlite-query / commands / usage / crypto / db-migrate / legacy / i18n），构建时由 esbuild 打进 `dist/preload/services.js`；preload 依赖清单在 `public/preload/package.json`。
- **`desktop/`** — 仅桌面版。`sidecar/server.js` 把打包后的 preload 以回环 HTTP 服务暴露；`sidecar/utools-shim.js` 在 Node 里实现最小 uTools API 面；`bridge/window-shim.js` 构建时注入渲染层，提供 `window.utools` / `window.services`；`guide.html` 是启动失败引导页（提示没找到 Node，或 sidecar 起不来——原因由 Rust 注入 `window.__CC_GUIDE__` / `window.__CC_FAIL__`）。
- **`src-tauri/`** — 仅桌面版的 Rust 外壳：Node 运行时探测、sidecar 生命周期、托盘、窗口主题；`i18n.rs` 负责托盘/引导页文案，语言偏好通过 sidecar RPC 先取 nativeId 再读 `ccconfig_locale_<nativeId>`（旧共享档作回退）。

### 命名迁移（ccswitch → ccconfig）

项目原名 CCSwitch，已统一为 CCConfig。大部分标识符是纯代码命名，随手改即可；但**已经落到用户磁盘 / DB 里的字面量不能直接换**，否则老数据读不到、老用户丢配置。这些旧名以「数据兼容常量」的形式保留，只在读取/迁移旧数据时使用，新写入一律用 ccconfig 命名：

| 旧名字面量 | 位置 | 为什么要留着 |
|---|---|---|
| DB 文档 ID 前缀 `ccswitch_*` | `public/preload/services/legacy.js` | 由 `db-migrate.js` 启动时整批改名为 `ccconfig_*`，常量仅用于扫描 |
| AES 加密盐 `ccswitch-encryption-key` | 同上（`crypto.js` 使用） | 旧密文必须用旧盐才能解开 |
| `由 CCSwitch 生成`（codex 条目标记） | 同上（`codex.js` 使用） | 识别改名前的 `~/.codex/models.json` 条目 |
| 导出文件 `app: 'ccswitch'` | 同上（`config.js` 使用） | 导入旧导出文件时归一为新值 |
| 网关响应头 `x-ccswitch-left-out` | 同上（`autoroute.js` 使用） | 新旧头同时补发，外部脚本不断 |
| `~/Library/Application Support/CCSwitch`、`~/Library/Logs/CCSwitch` | `src-tauri/src/main.rs` 常量区 | 启动时把 `runtime.json` 与旧日志搬到 `~/.ccconfig`（DB 已改为 `db/` 每文档一文件，旧 `db.json` 不再迁移） |
| `CCSWITCH_NODE` | `src-tauri/src/node_runtime.rs` | 旧环境变量作回退 |
| `CCSWITCH_DATA_DIR` | `desktop/sidecar/utools-shim.js` | 同上 |
| nativeId 哈希种子 `ccswitch-desktop`、旧文档 `ccswitch_runtime_id` | `desktop/sidecar/utools-shim.js` | **绝不能改**：变了会重算出新的 nativeId，`_<nativeId>` 文档全部孤儿化 |

迁移只做两件事：文档 ID 前缀改名 + 旧格式密文换盐重加密（`<iv>:<ct>` → `v2:<iv>:<ct>`）。密文带版本前缀而不是「先试新盐、失败再试旧盐」：AES-CBC 用错钥匙解密有约 1/256 概率填充合法，会静默返回乱码。幂等、失败保留旧档下次重试。冒烟测试：`node tests/smoke-db-migrate-test.cjs`。

### 桌面版本地数据库（`desktop/sidecar/utools-shim.js`）

uTools 版把文档交给宿主 DB；桌面版在 sidecar 里用文件实现同一套 `utools.db` API，preload services 与渲染层的调用方式不变。

- 位置：`~/.ccconfig/db/<slug>-<sha1(id) 前 12 位>.json`，一文档一文件；目录 0700、文件 0600。
- 文件名不直接用文档 ID：ID 可能含 `/`、`:`、中文（如 `ccconfig_mcp_disabled_<nativeId>_<name>`），而 macOS 默认卷大小写与 Unicode 规范化不敏感，`Foo`/`foo`、NFC/NFD 会撞文件。slug 只保证可读，哈希保证唯一，真实 `_id` 以文件内容为准。
- 语义与 uTools 对齐：`_rev` 冲突 / `missing_rev`、单文档 1MB、`remove` 接受 id 或 doc、`allDocs()` 无参 / 前缀 / ID 数组。
- 写入：`put` / `remove` 只标脏该文档，200ms 防抖后只重写这一条（临时文件 + rename 原子替换）；`onPluginEnter` / `onPluginOut` / 退出 / `allDocs` 前强制 `flushNow()`。内存 Map 既是读缓存，也是进程内的事实来源。
- 冒烟测试：`node tests/smoke-db-shim-test.cjs`（跨进程持久化、特殊 ID、`allDocs`、写入放大、权限）。

## 数据流

```
Claude:
  ~/.claude/settings.json  ←→  本地数据库（AES-256-CBC 加密）
  ~/.claude.json 顶层 mcpServers（MCP，官方位置，单一来源，全局生效）←→ 本地数据库（禁用状态）
  ~/.claude/skills/（全局）+ 项目级 .claude/skills/ + .disabled 目录
  ~/.claude/projects/**/*.jsonl  →  使用统计：
      signature = file_count:max_mtime 校验 → DB 缓存命中秒开
      热力图历史持久化（ccconfig_heatmap_*），全量解析后与历史按日期合并
      JSONL 读取失败时 readPersistedUsage 从历史兜底重建统计

通用配置（跨 agent 主数据）:
  供应商/模型主数据 → 本地数据库（ccconfig_common_providers，API Key 加密）
  通用 MCP → 云端为唯一主档存全量服务器（ccconfig_common_mcp）；本机启停名单存 ccconfig_mcp_local_state_<nativeId>（disabled 列表，不在名单 = 开启）。开启 = 把主档中已启用服务器镜像写入全部选中本地 JSON 文件（只替换 mcpServers 字段，保留其他顶层字段）；关闭/删除 = 从全部文件移除。存放位置按机器隔离存 ccconfig_mcp_local_targets_<nativeId>（未配置默认 ~/.mcp.json），可多选预置路径（~/.mcp.json、~/.config/mcp/mcp.json、~/.agents/mcp.json、~/.agents/mcp/mcp.json）或自定义（仅限 .json）。刷新/变更时先把本地文件中主档没有的服务器回收进主档（首次进入按「在文件中 → 开启，仅云端 → 关闭」初始化启停），同名冲突以云端主档为准，再统一写回全部位置
  通用 Skill → 只读扫描 ~/.agents/skills（SKILL.md 元数据），启停 = 物理移动目录到 .disabled/（同 Claude Code 机制）
    Skill 场景 → 本机档 ccconfig_skill_scenes_<nativeId> = { scenes: [{ id, name, skillDirs }], activeId }；切换场景把绑定目录移回 ~/.agents/skills、其余移入 .disabled/；activeId 为空 = 未启用场景（删除当前场景 / 旧数据的兜底，界面不再提供手动入口）。装载 / 每次进入时重放一次生效场景（外部安装或手动移动目录不会绕过白名单）。逐个勾选 Skill 会同步当前场景绑定，删除 Skill 从所有场景清理；绑定但未安装的目录记入返回值的 missing，安装完成后按场景补启用。场景名不允许冒号与「关闭」「手动」。uTools 指令 switchSkillScene 的 cmds 由场景名动态生成（场景：<名> / Scene: <名>，不再有「场景：关闭」），桌面托盘弹窗用标签按钮展示场景并高亮当前生效项
  协议类型：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Google Generative AI
  模型主数据字段（ccconfig_common_providers.providers[].models[]，均为可选、旧档缺字段按默认值消费）：
    id / name / contextWindow / maxTokens
    input[] / output[]（text / image / audio / video / pdf；默认 [text]）
    reasoning / reasoningEfforts[]（default / minimal / low / medium / high / xhigh / max）
    defaultEffort / capabilities[]（streaming / tools / always_thinking / json_schema / web_search / mid_system）
    cost{input,output,cacheRead,cacheWrite} / compat{} / options{} / extraHeaders{}
    maxInputTokens / offEffort / reasoningKey / adaptiveThinking / thinking{mode,minLevel,maxLevel,type,budgetTokens}
    description / temperature / topP / api / baseURL
    下发映射（普通元数据有值才覆盖；能力类字段按各 Agent 语义合并或推导；各 Agent 只取自己认识的字段并过滤非法枚举）：
      Claude / Codex / Reasonix 只写模型 ID（Codex 的 reasoningEffort 是全局配置）
      OpenCode: input/output → modalities、defaultEffort → options.effort、
        thinking.type/budgetTokens → options.thinking、options/temperature/topP 合并进模型 options、compat 平铺
      Pi / omp: input 只保留 text/image；omp 的 thinking → 模型 thinking
      Kimi: maxInputTokens → max_input_size、capabilities → capabilities、
        reasoningEfforts → support_efforts、defaultEffort/offEffort/reasoningKey/adaptiveThinking 同名下发
      MiniMax: input → modalities+attachment、reasoningEfforts → thinking.effortOptions
      Qoder: input 含 image → capabilities.vision、reasoning/efforts → thinking.modes/supportedEffortLevels
      ZCode: input → inputFormat、capabilities → properties、reasoningEfforts → optionSpecs.reasoningLevel.values
      Hermes: contextWindow → context_length、name / maxTokens → name / max_tokens
      DSH: description / reasoningEfforts / compat 写入官方或 pi-ai 模型条目
      Grok: description / temperature / topP / extraHeaders 写入模型条目
      Cline: input 含 image → images、reasoning → reasoning（streaming/tools 恒开）
      Command Code: options / baseURL / api / reasoningEfforts / cost 写入模型条目
  汇总统计 → 各 agent 统计页计算后落库 ccconfig_agent_usage_<agent>_<nativeId>（agent = claude / opencode / pi / dsh / zcode；days 按日期存 tokens/input/output/models，全零跳过防误清）
    通用统计页纯读这五个 DB 文档跨 agent 合并（日期求和 + 模型并集），不触碰源文件；口径与各 agent 页合并历史后一致
    每日贡献另带 agentModels = { <agent>: { tokens, models } }：热力图 tooltip 据此按 agent 分组（模型并集仍供模型分布卡片用）
    通用统计页的 Token 柱状图是同一份数据的纯前端派生（src/Switch/shared/UsageTokenChart.vue）：按天/按周分桶叠放（跨度 ≤ 30 天按天，> 30 天按周），可切「模型 / Agent」维度；分类取区间总量前 6 名、其余并入「其他」；悬浮某一天的某个分类时其余分类与其余天同步置灰，tooltip 只显示该分类当天用量；价格 / 速度 / 请求数等未落库口径不展示
    DSH / ZCode 反向把该文档当历史档：源数据（会话日志 / 用量库）被清理后回放历史，同一天取较大值
  本地网关 → 本地模型服务（http://127.0.0.1:<port>，默认 17877）：
    入站 POST /v1/messages（Anthropic）/ /v1/chat/completions（OpenAI Chat）/ /v1/responses（OpenAI Responses）+ GET /v1/models、GET /v1/codex/models（Codex 目录形状，1 MiB 上限，与 /v1/models 同一套模型 ID）
    出站支持 anthropic-messages / openai-completions / openai-responses，google-generative-ai 明确 400
    同协议透传（仅重写 model），跨协议经 canonical 中间格式转换（autoroute-convert/，含流式 SSE 双向转换）
    model 直查按勾选顺序取第一个，兼容「供应商/模型ID」消歧；不校验 key（仅监听本机回环地址，Authorization Bearer / x-api-key 传任意值或留空均放行）
    模型映射（mapping 模式）：固定映射名 alias → 主数据模型，/v1/models 只返回映射名；首次初始化自动预置 flash / plus / pro 三行（目标留空，用户自选或删行；mappingSeeded 置位后删空不再回填）
      **映射行顺序 = 下发顺序**：mappings 数组顺序即顺序，resolveAutoRouteModels 按序解析，dispatchAutoRoute 按序逐个写 agent，
      因此网关页映射区的行首序号是拖拽手柄（悬停变手柄图标，上下拖动重排；↑/↓ 键等价），松手即落库；
      数组型存储（pi / omp / dsh / reasonix 模型数组、qoder / zcode personalModelIds+modelOrder、Codex DB 模型列表、Claude 六个槽位）
      严格跟随此顺序；字典型（opencode / minimax / hermes / kimi / cline / commandcode / grok 的 models 字典）
      写入文件时按此顺序落键，但各 agent 自己的选择器可能另有排序（如 Grok 页面按 key 字母序），不保证展示顺序一致
      响应 model 改写（rewriteModel，默认 true，网关页映射区可关）：请求方向只把 model 换成真实模型 ID，上游返回的 model 仍是真名；
      而 agent 会把响应 model 记进自己的会话记录（Claude Code 的 assistant.message.model、Grok Build 的 usage.json modelUsage 键），
      「使用统计」读的正是这些记录 → 不改写就只能看到上游真实模型名。实现见 autoroute-convert/model-alias.js，只改三处结构化位置
      （顶层 model / message.model（Anthropic message_start）/ response.model（Responses 事件）），正文里的 "model" 字样不动；
      四条出站路径都要改：透传非流式 rewriteJsonModel、透传流式 createSseModelRewriter（按行缓冲，支持半行分片与 CRLF，
      与原先的 usage 旁路扫描并行）、转换非流式覆盖 formatResponse 的顶层 model、转换流式走 pipeStream 的 modelOverride
      （三个 FrameWriter 都只从 start 事件取 model，所以只改那一处）。关掉即恢复字节级透传——客户端按响应模型名
      推断上下文窗口 / 定价时（映射名不在其内置表里会退化成默认值）可用它自救。网关自己的请求日志不受影响：仍记真实模型 ID + alias
    最近请求：解析出目标模型即插入 status=null 的「进行中」行，完成时原地补全状态/耗时/usage（流式旁路扫描的 token 随流实时累加），页面 1s 轮询 getAutoRouteStatus；映射模式额外带 alias 字段，日志行显示「映射名 → 实际模型」（多个映射可指向同一模型，只显示模型名无法区分）
    统计落库：会话统计 serverState.stats 随网关启动清零；同一口径按本地日期聚合到 ccconfig_autoroute_usage_<nativeId>（days: 日期 → requests/successes/promptTokens/cachedTokens/outputTokens，每次请求完成即写，stopAutoRoute 再兜底 flush）；getAutoRouteStatus 返回 stats（本次）与 history.today/month/total/since，网关页与托盘统一切换「本次 / 今日 / 本月 / 累积」（网关页默认累积，托盘默认今日，无今日调用时依次回退本次 / 本月 / 累积）。网关口径独立于各 agent 的本地日志统计，不能直接并入「通用统计」求和
    usage 采集（日志行 / 会话统计口径）：
      同协议直通：流式扫原始 SSE、非流式扫整段 JSON（scanUsageFromText 取各字段最大值）
      跨协议转换：取 canonical end 事件的 usage；入站响应（source.formatResponse / 各 FrameWriter）同样回写
        input_tokens / output_tokens 与缓存字段（chat: prompt_tokens_details.cached_tokens，responses: input_tokens_details.cached_tokens），
        否则客户端 anthropic/openai SDK 回写整条 usage 时会把输入 token / 缓存抹成 0
      Anthropic 出站流式：message_start 的 usage 通常全 0，input_tokens 与缓存字段要到 message_delta 才有，两边都要取（非 0 才覆盖）
    跨协议转换规则（autoroute-convert/canonical.js 为中间层，source/target 各三协议）：
      推理强度：Anthropic thinking.budget_tokens ↔ OpenAI reasoning_effort / reasoning.effort 互折（低 4096 / 中 10000 / 高 24000 / 最高 32000；anthropic 侧 budget 被限制在 max_tokens-1024 以内，且不开 thinking 时不回放 thinking 块）
      媒体：图片/文档进 canonical（anthropic image·document / chat image_url / responses input_image·input_file），目标载不了时降级为 [attachment …] 文本占位（含 tool_result 里的图片）；tool_reference 转「Tool X is loaded」文本（Claude Code ToolSearch）
      结构化输出：response_format / text.format / output_config.format 归一后按目标协议重写，Anthropic 等无此能力的写进 system 提示
      工具 schema：补 enum/const 缺的 type、oneOf→anyOf；入站 tool 形状（Chat 嵌套 / Responses 扁平 / Anthropic input_schema / MCP inputSchema）统一识别
      max_tokens：入站未给时用主数据模型 maxTokens，anthropic 出站兜底 16384
      错误体：按状态码归一为协议原生 type（429 rate_limit_error / 5xx·529 overloaded·api_error），上游 Retry-After 透传
    上游容错（sendUpstream）：429/5xx/网络抖动按 Retry-After（≤15s）或指数退避重试 2 次；400/422 点名可选字段（stream_options / reasoning_effort / response_format / thinking …）或拒收 anthropic-beta 头时去掉该字段（或头）立即重试，并按供应商记住不再发
    连接生命周期（长时间常驻必须）：每个入站请求一个上游守卫，客户端一旦断开（含只发出请求、还没收到响应头的阶段）立刻 destroy 它名下所有在途上游并记 499；等响应头超过 10 分钟视为上游卡死，销毁请求回 504（不重试，只覆盖响应头之前，不影响已开始的流式响应；注意流式的响应头 = 首字节 TTFT，非流式要等整段生成完才发头，两者共用同一阈值）；所有在途上游登记在 pendingUpstreams，停网关时一并销毁（server.closeAllConnections 管不到出站 socket）
    客户端协议头透传：anthropic-beta（滤 oauth-*）/ anthropic-version / openai-beta 只发给同协议上游；UA 透传需供应商 passUserAgent=true；provider.headers 优先级最高
    配置存本地数据库（ccconfig_autoroute_config），插件装载 / 进入时幂等自启动；uTools 版随 uTools 退出停止，桌面版窗口隐藏时仍由 sidecar 持续提供服务
    桌面版托盘弹窗的「网关」页签直接复用这份配置（readAutoRouteConfig / writeAutoRouteConfig）：可切「模型直连 / 模型映射」、勾选直连模型、增删改映射行；模型选项由 getGatewayRouteOptions 提供（只含供应商名与模型清单，不含解密后的 apiKey），改动即时落库
  网关下发到 agent（dispatch.dispatchAutoRoute）= **覆盖式重建 router 供应商**，不是合并：
    名称固定 router（同时是 Codex 的 model_providers.<id>，TOML 裸键只能英文）；baseUrl 指向网关、key 为网关占位符
    每次下发先清空该 agent 里的 router 条目与其全部模型，再按「当前网关模型清单」整条重写，
    因此已从网关移除的模型不会残留（普通「通用模型下发」dispatchCommonModel 仍是合并语义）
    AUTOROUTE_REBUILD 为每个 agent 提供 before / clear / after 三个钩子（apis 不匹配时完全不清理，避免先删再报协议错）：
      继承生效状态：router 原本是该 agent 的当前/默认供应商 → 重建后继续生效（Claude 还要同步 settings.json 的托管 env）
      继承默认模型：原默认模型仍在新清单里就沿用，否则取新清单第一个；ZCode 非首选时还会把 providerOrder 位置还回去
      继承停用开关：MiniMax provider.enabled / Command Code provider.disabled / Cline 条目 enabled 原样保留
      各 agent 的「生效点」：Claude 激活配置（ccconfig_active_config_id）、OpenCode 顶层 model、Pi defaultProvider、
      omp modelRoles 引用（旧模型被删时改指新清单第一个，保留 :level）、Reasonix default_model、Codex 顶层 model_provider/model、
      Kimi default_model 别名、MiniMax doc.defaultModel、Qoder provider.model、ZCode providerOrder[0]+modelOrder[0]、
      Hermes 顶层 model.provider/default、DSH agent-default-model、Grok models.default、Cline lastUsedProvider、Command Code settings.model
    清空时绕过 delete* 的「在用」守卫（生效中的供应商本来就删不掉）；Claude 只清空六个模型槽位、保留 _id/名称/额外字段；
    重建后按各 agent 自己的写入路径（dispatchToXxx）重新生成模型条目，元数据映射规则不变

OpenCode:
  ~/.config/opencode.json / opencode.jsonc (json5/jsonc，优先 .json)  ←→  本地数据库
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
  ~/.pi/agent/settings.json + models.json + extensions  ←→  本地数据库
  ~/.pi/agent/sessions/**/*.jsonl  →  解析 & 聚合  →  使用统计
  特殊 schema：cost 必须含 {input, output, cacheRead, cacheWrite} 四项；contextWindow 为 0 则省略

omp:
  <agentDir>/config.yml modelRoles  →  js-yaml 直接读写（load → 改 modelRoles → dump 写回）
  <agentDir>/models.yml providers    →  js-yaml 直接读写
  agentDir 解析与 omp 自身（@oh-my-pi/pi-utils/dirs.ts）逐条对齐，否则插件和 CLI 读写的不是同一份：
    configRoot = $HOME/<PI_CONFIG_DIR 或 ".omp">
    有 profile（OMP_PROFILE / PI_PROFILE）→ configRoot/profiles/<profile>（profile 优先于下面两项）
    否则 agentDir = PI_CODING_AGENT_DIR（若设置）或 configRoot/agent
    Linux 的 XDG_*_HOME 重定向未纳入（需要用户先 `omp config migrate`，属边缘场景）
  模型引用格式：provider/model[:thinkingLevel]，无前缀引用编辑时自动补全带前缀
  删除供应商/模型前检查 modelRoles 引用，被引用时拒绝删除
  写文件一律 0600（models.yml 存明文 apiKey、config.yml 含账号配置）：先写再 chmod，Windows 忽略失败
  YAML 解析失败必须抛错中止（serviceAgent.omp.configParseFailed / modelsParseFailed）：
    读侧静默读成 {} 再整份写回会把用户手写的 symbolPreset / theme / display 等字段连同 API Key 一起抹掉
  纯文件读写，不依赖 omp 二进制 / bun 运行时

Reasonix:
  ~/.reasonix/config.toml（Windows: %APPDATA%\reasonix\config.toml）→ smol-toml 读写
  ~/.reasonix/.env → API Key / 环境变量管理（掩码编辑，支持按 Reasonix 官方规则自动生成变量名）
  供应商支持多种协议（openai 兼容等），未知扩展字段写回时原样保留

Codex:
  ~/.codex/config.toml → smol-toml 读写（解析失败抛错阻断写回，仅管模型相关字段其余原样保留）
  base_url 必须停在版本段：Codex 自己追加 /responses 或 /chat/completions，下发时经 normalizeCodexBaseUrl 归一
  （补 /v1、去 …/chat/completions 等端点后缀，幂等）
  「模型目录」= 合并各供应商模型写 ~/.codex/models.json + model_catalog_json 绝对路径（正斜杠）
  条目必须符合 Codex ModelInfo schema（档位键名必须是 effort）；Codex 逐版新增「缺了整份目录加载失败」的
    必填字段：supports_reasoning_summaries(<0.145)、supports_parallel_tool_calls(≥0.147)、shell_type/
    truncation_policy 等；系统提示词双写 base_instructions（旧版）+ model_messages.instructions_template（新版）
  带「由 CCConfig 生成」标记的旧条目同步时原地重建；打开 Codex 页（getCodexCurrent）时自愈：
    条目缺必填字段 → 重建；models.json 丢了但 config.toml 仍引用 → 按 DB 模型列表补回；文件损坏不动
  网关下发额外写 [model_providers.router].model_catalog_url = <网关>/v1/codex/models：
    Codex ≥0.161 直接拉目录（用 API key 的 Codex 不会自己 GET /v1/models），不再依赖本地文件

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
  通用库下发把模型参数一并带过去（只增不减 / 有值才覆盖，重下发不抹手工字段）：
    provider.headers → [providers.<name>.custom_headers]（与既有头合并）/
    model.name → display_name / contextWindow → max_context_size（取较大值）/
    maxTokens → max_output_size（文档限定仅 anthropic 读取，其余协议不写）/
    input 模态 → capabilities（image/video/audio → image_in/video_in/audio_in）/
    reasoning → capabilities.thinking（capabilities 按官方「只能追加」语义做并集）/
    reasoningEfforts → support_efforts（非法档位过滤）
  使用统计：~/.kimi-code/sessions/<workspace>/<session>/agents/<agentId>/wire.jsonl
    每行一个事件，只取 usage.record（wire.jsonl 里的 tool 结果 / systemPrompt 单行可达数百 KB，
      先按子串过滤再 JSON.parse）：
      { model（Kimi 模型别名，如 router/pro）, usage: { inputOther, output, inputCacheRead,
        inputCacheCreation }, usageScope（turn|session，均计入）, time（epoch ms） }
    模型名只记模型本身、不带供应商：优先取同一次请求前一条 llm.request 的 model（真正发往 API
      的模型 ID）；老日志没有 llm.request 时退回别名，且只剥配置里确实存在的供应商名前缀
      （避免误删 moonshotai/kimi-k2 这类模型 ID 自带的命名空间）
    口径：输入 = inputOther + inputCacheRead + inputCacheCreation（含缓存），输出 = output，
      总量 = 输入 + 输出；日期取 time 的本地日期（同 Grok / Cline）
      day.inputTokens 含缓存（= tokens - output），day.models[].inputTokens 为未缓存输入
      state.json 提供稳定会话 ID 与真实 cwd（目录名 wd_<slug>_<hash> 是有损编码）；
      子 agent（agents/<id>/wire.jsonl）用量一并汇总，按会话 level 合计
    落库：ccconfig_agent_usage_kimi_<nativeId>（与「通用」统计页同源）；无 wire.jsonl 或
      解析不到 usage.record 时回放落库历史，不归零
    重统计走后台线程（usage-worker.js 的 kimi runner）；冒烟测试：node tests/smoke-kimi-usage-test.cjs

MiniMax Code:
  ~/.minimax/config.yaml（MINIMAX_DATA_DIR 优先，MAVIS_DATA_DIR 兼容回退）→ js-yaml 读写（解析失败抛错阻断写回）
  只管理两处：顶层 defaultModel、custom_provider.<id>（name / kind:custom / enabled / api / options{baseURL,authMode,apiKey} / models.<id>）
  defaultModel 引用：内置 "minimax/<模型ID>"，第三方 "custom_provider:<id>/<模型ID>"（可带 #variant 后缀，CLI 0.4.12 实测）
  provider.minimax（mcode login / Token Plan 托管）只读展示，可设默认模型、禁改禁删；
    apiKey 明文写入 options.apiKey（与桌面版自身写法一致）
  models 的 limit{context,output}、name、enabled 外，另显式管理 thinking.effortOptions（推理等级）
    与 modalities.input+attachment（支持附件 图片/PDF/视频/音频 → image/pdf/video/audio，text 隐含）；
    thinking 其他子键 / variants / reasoning 等官方字段 _raw 合并保留原样往返
  推理等级档位枚举 = default / minimal / low / medium / high / xhigh / max；
    'default' 是官方首档（M3.1-Flash 官方 effortOptions 以 default 打头、defaultEffort: default），
    白名单过滤时不得漏掉它，否则保存一次即静默抹档；非法档位照常丢弃
  供应商/模型改 ID 时 defaultModel 引用同步；删除默认模型时清理悬挂引用；API 格式三协议：anthropic-messages / openai-completions / openai-responses
  通用库下发：provider 键经 providerKeyFor 确定性 ASCII 清洗（中文/符号名 → 骨架+稳定哈希，同名恒同键，upsert 幂等）；
    下发刷新 limit/名称/输入模态（model.input 过滤非 text 并入 modalities+attachment）与推理档位
    （model.reasoningEfforts → thinking.effortOptions），未传字段保留既有值；google 协议供应商拒绝下发
  使用统计：~/.minimax/v2/sessions/<YYYY>/<MM>/<DD>/<会话目录>/messages.jsonl（会话 JSONL，形状同 Pi）：
    每行 { message_id, turn_id, message }，只取 message.role=assistant 且带 usage 的行；
    usage = { input, output, cacheRead, cacheWrite, totalTokens, cost:{input,output,cacheRead,cacheWrite,total} }
    两处与 Pi 的差异：① 时间戳是 epoch 毫秒（message.timestamp，需转 ISO 再取日期）；
    ② 会话日志不记录 cwd，project 用日期目录名兜底（UsagePage 不消费该字段，不影响统计口径）
    会话 id 取 manifest.json 的 sessionId，manifest 缺失时从目录名尾部 session_<base64> 解码
    落库：ccconfig_agent_usage_minimax_<nativeId>，源文件被清理后回放历史不归零
    重统计走后台线程（usage-worker.js 的 minimax runner），不阻塞渲染层

Hermes:
  ~/.hermes/config.yaml（HERMES_HOME 优先，Windows %LOCALAPPDATA%\hermes，macOS/Linux ~/.hermes）→ js-yaml 读写（解析失败抛错阻断写回）
  只管理两处：custom_providers[]（name / base_url / api_key / api_mode / models 字典 / model / rate_limit_delay）、
    顶层 model（provider 指供应商名 + default 指模型 ID，其余键如 base_url / context_length 保留）
  models 磁盘为字典 { "<模型ID>": { context_length, ... } }，UI 为有序数组；条目 model（单数）恒为首个模型 ID
  受管字段外的未知键（key_env / request_timeout_seconds 等）经 _extra 合并往返；camelCase 别名归一 snake_case，遗留 api 键丢弃
  Hermes v12+ 顶层 providers 字典（Web UI 托管）只读展示：可设默认模型，禁改禁删
  默认模型语义（即「切换」）：model.provider 必设，model.default 用指定模型或该供应商首个模型
  删除供应商时若 model.provider 悬空，改指首个剩余供应商（无剩余则移除指针）
  通用库下发：协议映射 openai-completions→chat_completions / anthropic-messages→anthropic_messages / openai-responses→codex_responses（google 拒绝）；
    provider 名经 providerKeyFor 确定性清洗（同上）；网关下发走 anthropic_messages + 网关根地址（同 Claude，不带 /v1）

ZCode:
  ~/.zcode/v2/provider_config.json（ZCode 监听变更即时生效）：
    受管字段外的未知键（group / logo 等与 properties/optionSpecs 下的部分键）经 _extra 按层级合并往返（zod strict partial，绝不新增未知键）
    providerId 生成沿用 ZCode 规则（名称 trim → 小写 → 非 [a-z0-9] 转 - → 去首尾 -，冲突加 -2/-3）
    首选模型 = providerOrder 首个供应商 + 其 modelOrder 首个模型（ZCode 选择器排序基准）
    通用库下发 upsert：中文供应商名经 providerIdFor 确定性清洗（ASCII 骨架 + 稳定哈希，同名恒同 ID，upsert 幂等）
  使用统计：~/.zcode/cli/db/db.sqlite（WAL 模式，ZCode 设置页「使用统计」同源）：
    model_usage 表一次模型请求一行，只取 status='completed'（cancelled 行全 0，error 无完成用量）；
    LEFT JOIN session 补项目目录；原生 node:sqlite 只读打开（WAL 快照不阻塞 ZCode 写入）→ Electron 沙箱子进程回退（同 OpenCode）。
      回退子进程按平台探测常见安装位置（macOS /usr/local/bin、/opt/homebrew/bin 等；Windows Program Files\nodejs），
      并校验版本 ≥ 22.5（低版本无 node:sqlite，--experimental-sqlite 会 bad option，探测不通过即当未找到）
    口径：input_tokens 已含缓存（>= cache_read + cache_creation），输入 = input_tokens（含缓存）、输出 = output_tokens、
      total = input + output（= computed_total_tokens，reasoning 含在 output 内）；模型名只取 model_id（不带 provider 前缀，
      同名模型跨供应商用量合并；旧落库的带前缀键读历史时自动剥前缀合并）
      day.inputTokens 含缓存（= tokens - output），day.models[].inputTokens 为未缓存输入（同 DSH 双口径）
    历史落库：ccconfig_agent_usage_zcode_<nativeId>，同一天取较大值合并，db 被清理/换机后回放历史不归零

DSH（DeepSeek Harness）:
  <DSH_HOME>/profiles/<profile>/cordis.patch.yml（DSH_HOME 默认 ~/.dsh，DSH_PROFILE 默认 desktop）→ js-yaml 读写（解析失败抛错阻断写回）
  文件是顶层 YAML 数组，每条 loader patch 条目 { id, name, config }；本插件只管理三条模型路由条目，
  其余条目（ui-chat / ui-settings / 用户插件）与文件头部注释块原样保留：
    llm-deepseek        官方 Messages 路由：apiKeyEnv（固定派生 DEEPSEEK_API_KEY，界面不填）/ baseURL（留空 = 官方
                        https://api.deepseek.com/anthropic，或 $DEEPSEEK_BASE_URL）/ thinking（enabled|disabled）/
                        reasoningEffort（off|low|high|max）/ maxTokens / defaultContextWindow /
                        models（id / name / contextWindow / maxTokens / inputModalities / systemPromptUpdate /
                        toolUpdate 等；缺省 = 内置 deepseek-flash（文+图，1M）与 deepseek-v4-pro（纯文本）；
                        界面首次新增/编辑模型即转为自定义目录，清空即回退内置目录）
    llm-pi-ai           第三方供应商：config.providers.<路由名>（displayName / apiKeyEnv / api（四协议与通用库同名）/
                        baseURL / models（非空，手写路由必需：id / name / contextWindow / maxTokens / input /
                        reasoningEfforts）/ compat.thinkingFormat / headers / retryPolicy 等，未知键原样往返）
    agent-default-model 默认模型（即「切换」语义）：config.provider（官方固定 deepseek-official，第三方为 providers 键）+
                        config.model + 可选 reasoningEffort
  界面约定：供应商与模型分开配置（同 ZCode 页）——供应商弹窗只管名称（支持中文）/ 路由名（必填，小写英文+数字+中划线）/
    协议（手工新增仅开放 openai-completions 与 anthropic-messages）/ Base URL / API Key / thinkingFormat；
    模型在卡片内以标签列出，逐个「添加模型 / 编辑模型」弹窗维护（上下文窗口与最大输出用共享预设档位，同 ZCode）；
    模型标签上的星标 = 设为默认模型（同供应商内切换保留原推理强度，跨供应商切换清空）
  凭据引用名自动派生（界面不填）：第三方 = <路由名大写，非字母数字转 _>_API_KEY；官方 = DEEPSEEK_API_KEY（与 dsh 默认一致）
  密钥：<DSH_HOME>/.credentials.yaml 顶层 refs 字典（{ 引用名: 密钥 }）——patch 不含明文密钥；
    只增删受管引用，version / records（OAuth 授权记录）等其余内容原样往返；删除路由且无其他引用时清理对应密钥
  路由名清洗（仅通用库下发）：中文/符号供应商名 → 小写 ASCII 骨架 + 稳定哈希（同名恒同路由，upsert 幂等）
  默认指针兜底：删除/改名被设为默认的模型时改指该路由目录内首个模型（无可指路由则移除条目），不留悬空指针
  dsh 监听该文件（profile HMR），写入后即时生效；凭据文件改动如未生效可重启 dsh
  通用库下发：四类协议与 pi-ai 协议同名（identity 映射，无协议守卫），供应商名经 providerRouteFor 清洗为路由名；
    密钥写入该路由的 refs[<ROUTE>_API_KEY]；网关下发走 anthropic-messages + 网关根地址（SDK 自行追加 /v1/messages）
  使用统计：<DSH_HOME>/sessions/<项目目录>/<会话目录>/session[.vN].jsonl[.zstd]（同目录多世代取版本最高者；明文 .jsonl 与
    项目目录直放日志的老布局兼容）：
      日志是多帧拼接的 zstd 容器（每次追加写一个新帧），scanZstdFrames 结构扫描帧边界后用 fzstd 逐帧解压；
      只取 assistant/message 事件（data.usage 的 inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens +
      data.message.source.{provider,model} 与事件 time），assistant/attempt（失败重试，只有输入无模型）与
      compaction/summary、会话标题、web search 等辅助请求不计入；断尾/校验失败的帧跳过
      口径：输入 = inputTokens + cacheReadTokens + cacheWriteTokens（含缓存），输出 = outputTokens；
      day.inputTokens 含缓存（页面日期筛选直接取该字段），day.models[].inputTokens 为未缓存输入（页面在模型维度
      自行叠加 cacheRead/cacheCreation），summary.inputTokens = 总 - 输出
      缓存：signature = 日志数:总字节:最新 mtime → 本地数据库（ccconfig_dsh_usage_cache_<nativeId>），
      页面保活（isTabVisited + v-show）不重复拉取，点刷新也走签名校验、日志有变化才重新全量解析
      历史落库：每日聚合落 ccconfig_agent_usage_dsh_<nativeId>（与「通用」统计页同源，不另存一份），
      读取时按「同一天取较大值」合并历史（日志被清理/压缩后历史不缩水），日志全没了则直接回放历史档

Grok Build（xAI 官方编码 CLI，命令 `grok`）:
  ~/.grok/config.toml（GROK_HOME 优先，默认 ~/.grok）→ smol-toml 读写（解析失败抛错阻断写回；Grok 自身也不覆盖无法解析的配置）
  与其它应用一致采用「供应商 → 模型」两层结构；只管理四处，其余节（[ui] / [features] / [permissions] /
  [hooks] / [plugins] / [toolset]）读改写原样保留：
    [model_providers.<name>]  供应商（命名连接信息）。受管字段：base_url / api_backend / api_key / env_key（字符串或数组）/
                            context_window / extra_headers；未知键（api_base_url / auth / auth_provider / query_params /
                            env_http_headers / max_request_bytes / context_windows …）经 _extra 原样往返
                            语义（见 xai-grok-shell/src/agent/model_providers.rs 的 with_provider_defaults）：
                            base_url / api_base_url / api_backend / max_request_bytes / extra_headers 为「模型没写才继承」，
                            context_window 只在模型整组未设时整体继承，api_key / env_key 在模型自己没有任何凭据时继承
                            改名会同步改掉引用它的 model_provider；仍被模型引用时禁止删除
                            没有模型的供应商照常保留（不写空表：条目为空时整节删除）
    [model.<key>]             模型条目，通过 model_provider 引用供应商。受管字段：model（发往 API 的模型 ID）/ name /
                            description / context_window / max_completion_tokens / temperature / top_p / extra_headers
                            内联写法（官方文档里直接给 [model.<id>] 写 base_url 的例子）也支持：条目自带
                            base_url / api_backend / api_key / env_key，此时没有 model_provider，UI 归入「未分组模型」；
                            把内联模型改挂到供应商时会清掉它自己的连接字段（否则会盖掉供应商的值）
                            官方内置模型可只写要覆盖的字段（无连接信息、无 model_provider = 内置覆盖，UI 打标）
                            api_backend 三值：chat_completions（默认）/ responses / messages（Anthropic /v1/messages，
                            但鉴权仍走 Bearer；需要 x-api-key 时用 extra_headers）——google-generative-ai 无对应实现，写入前拦截
                            未知键（reasoning_efforts / reasoning_summary / model_family / query_params / env_http_headers /
                            notice / hidden / stream_tool_calls / supports_backend_search …）经 _extra 原样往返
    [models]                  顶层全局默认：default（默认模型，存的是 [model.<key>] 的模型键，可为内置模型 ID）/
                            web_search 等其余键原样保留；modelId 置空 = 删键，回退 Grok 内置默认
    顶层 disabled_mcp_servers 关闭的 MCP 名单（官方 grok mcp disable 的落点），与 [mcp_servers.<name>] 配合
  模型改键时 models.default 跟随；删除被设为默认的模型时回退到目录内首个剩余模型（无剩余则删键）；新增首个模型时自动设默认
  通用库下发：协议映射 openai-completions→chat_completions / openai-responses→responses / anthropic-messages→messages
    （google 拒绝）；供应商名经 providerKeyFor 确定性清洗为 TOML 裸键（中文/符号名 → ASCII 骨架 + 稳定哈希，upsert 幂等）；
    写入形态 = [model_providers.<key>] 连接信息 + [model.<模型ID>]（model_provider 引用）+ 首次无默认时补 models.default；
    context_window / max_completion_tokens 写在模型条目上（不写供应商，避免同供应商多模型互相覆盖）
  网关下发：走 anthropic-messages + `http://127.0.0.1:<port>/v1`（grok 自己只追加 /messages，不补 /v1，同 Codex / Kimi / ZCode）
  MCP：[mcp_servers.<name>]（stdio: command/args/env/cwd；http: url/headers，SSE 用 type = "sse"）。
    开关同时维护顶层 disabled_mcp_servers 名单（不写条目的 enabled，与官方 CLI 行为一致）；
    oauth / setup / tool_timeouts / bearer_token_* 等未知键经 _extra 原样往返
  Skill：~/.grok/skills/<name>/SKILL.md（官方用户级目录；grok 也递归子目录，这里只读一层，同 OpenCode 视图）；
    启停 = 物理移动目录到 .disabled/（同 Claude / OpenCode / 通用 Skill）；安装复用 SkillHub / 魔搭流水线
  使用统计：~/.grok/sessions/<URL 编码工作目录>/<session-id>/usage.json（`grok usage` 的落盘版本）：
    结构 { sessionId, updatedAt, session: UsageSummary, turns: [{ turnNumber, endedAt, ...UsageSummary }] }（serde camelCase），
    UsageSummary 含 inputTokens / outputTokens / cachedReadTokens / cacheCreationTokens / reasoningTokens /
    modelCalls / primaryModelId / modelUsage{<模型ID>: UsageSummary}
    按 turns 逐轮汇总（多天会话能落到正确日期，日期取 endedAt 的本地日期），模型维度取 turn.modelUsage，
    无 modelUsage 时退回 primaryModelId；无 turns 的老档退回 session 汇总 + updatedAt 日期；读失败的会话跳过（正在写入）
    口径：输入 = inputTokens + cachedReadTokens + cacheCreationTokens（含缓存），输出 = outputTokens；
      day.inputTokens 含缓存（页面日期筛选直接取该字段），day.models[].inputTokens 为未缓存输入（页面重算再叠加缓存）；
      summary.inputTokens = 总 - 输出
    历史落库：ccconfig_agent_usage_grok_<nativeId>（与「通用」统计页同源），源目录被清理后回放历史不归零
  已知取舍：整档 smol-toml 重写不保留 TOML 注释（同 codex / kimi / reasonix）

Cline（AI 编程 agent，命令 `cline`；CLI / Desktop / SDK 共用一套文件，IDE 扩展共用 MCP 与 rules/skills）:
  目录：CLINE_DIR（默认 ~/.cline）、CLINE_DATA_DIR（默认 <CLINE_DIR>/data），与 @cline/shared 的
        resolveClineDir / resolveClineDataDir 一致
  <data>/settings/providers.json  ←→  CLI / Desktop / SDK（IDE 扩展的供应商配置在其 globalState，非文件，本工具不覆盖）
    信封 { version: 1（字面量）, lastUsedProvider?, modes: { voiceInput? }, repairs?, providers: {...} }
    providers.<providerId> = { settings: { provider, apiKey?, model?, baseUrl?, headers?, reasoning? }, updatedAt, tokenSource }
    ⚠️ Cline 用 zod 严格校验整个信封，**任一 provider 条目不合规就丢弃这一条**（不是整个文件；整档被丢弃的
       情况只有 version 不是 1 / 顶层不是对象 / JSON 语法错）。因此本模块：
       - 读到的 version 不是 1 → 抛错中止，绝不写回（否则用户全部供应商被清空）
       - updatedAt 一律写 new Date().toISOString()；tokenSource 只取 manual / oauth / migration，不自造
       - 原子写（tmp + rename）并 chmod 0600（Cline 自己也按 0600 写）
       - settings 内未识别键与供应商条目顶层未识别键均原样往返（_extra / topExtra）
    ⚠️ **Cline 只跑 lastUsedProvider 指向的那一条**（CLI 3.0.74 源码：`getLastUsedProviderSettings()` →
       `providers[lastUsedProvider].settings`，会话模型取 `settings.model`）。该条目缺失或被判废时 Cline
       **静默回落到内置 cline 账号**（表现为「模型配置不生效」），所以：
       - `settings.provider` 必须等于条目键（Cline 的 `resolveProviderSettings` 拿它当「已配置」判据）；
         本模块新建/下发时一律写条目键本身（`openai-compatible` 只在内置条目上才成立）
       - `settings.reasoning` 受严格校验：`effort` 只能是 none/minimal/low/medium/high/xhigh/max
         （`default`/`turbo`/大写都非法），`enabled` 必须是布尔，`budgetTokens` 必须是正整数；任一不合法
         → 整条目被丢弃。`effort: 'none'` 写为 `{ enabled: false }`（Cline 选择器关思考的形状）
       - `settings.protocol` / `settings.client` 也在枚举内校验，非法同样整条目丢弃
       - 对外 API 用 `effectiveLastUsedProvider`（悬空/判废即视为「无当前供应商」）与 `checkProviderEntry`
         （`valid` / `invalidReason` / `invalidValue`）把上述判废原因回传页面，由 ConfigView 显式提示；
         `setClineActiveProvider` 拒绝把判废条目设为当前使用
    切换供应商 = 写 lastUsedProvider；删除当前供应商时清空 lastUsedProvider 与 modes.voiceInput 引用；
    新增供应商时若当前无「实际生效」的供应商（首次 / 悬空）则自动接管，避免新建后仍停在「不生效」；
    通用库 / 网关下发（`dispatchToCline`）在未勾「设为默认」时也调 `activateClineIfUnset`：
    仅当 Cline 里没有生效的当前供应商（空配置 / lastUsedProvider 悬空 / 条目被判废）才启用刚下发的这条，
    并给它选上目录里第一个模型（settings.model + defaultModelId 双写）；已有生效配置时不改动用户的选择
  <data>/settings/models.json  —— 独立于 providers.json 的另一套 { version: 1, providers: {...} } 信封
    providers.<providerId> = { provider: { name, baseUrl, defaultModelId? }, models: { <modelId>: {
      id, name?, contextWindow?, maxTokens?, capabilities? } }, discoveredModelIds? }
    capabilities 只写 Cline 认识的 streaming / tools / images / reasoning（未知值过滤）
    默认模型两处同步：providers.json 的 settings.model 与目录的 provider.defaultModelId
    模型改 ID 时两处引用一起跟随；删掉默认模型时回退到目录内首个剩余模型（无剩余则删键）
  <data>/settings/cline_mcp_settings.json（IDE 扩展与 CLI 共享）
    { mcpServers: { <name>: { command/args/env | type: "streamableHttp"|"sse" + url/headers,
      disabled, autoApprove, ... } } }
    关闭态写条目自身 disabled: true（开启时删掉该键）；autoApprove 等未识别键原样往返
  ~/.cline/skills/<name>/SKILL.md  Skill 目录；启停 = 物理移动目录到 .disabled/（同 Claude / OpenCode / Grok）；
    安装复用 SkillHub / 魔搭流水线（~/.agents/skills 由「通用配置 → Skill」管理，此处不重复接管）
  使用统计：<data>/sessions/<session_id>/<session_id>.json
    { session_id, started_at, updated_at?, provider, model,
      metadata: { usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost },
                  aggregateUsage?: {...} } }
    优先取 metadata.aggregateUsage（多供应商 / 子 agent 合并后），否则 metadata.usage；
    按会话汇总（Cline 只有会话级用量，没有逐轮增量），日期取 updated_at → started_at 的本地日期；
    全零用量会话跳过；读失败的会话跳过（正在写入）
    口径与 Claude / DSH / Grok 一致：输入 = inputTokens + cacheReadTokens + cacheWriteTokens，输出 = outputTokens；
      day.inputTokens 含缓存，day.models[].inputTokens 为未缓存输入
    历史落库：ccconfig_agent_usage_cline_<nativeId>，源会话被清理后回放历史不归零
  通用库下发：Cline 侧第三方端点只有 openai-compatible 协议（settings.provider 写条目键本身，Cline 只按
    「键 = settings.provider」判断已配置），协议守卫只放行 openai-completions（其余协议先接网关）；
    供应商名经 providerKeyFor 确定性清洗为合法 providerId（中文/符号 → ASCII 骨架，upsert 幂等）；
    写入形态 = providers.json settings（provider/baseUrl/apiKey）+ models.json 模型条目 + 可选
    settings.model / defaultModelId / lastUsedProvider
  网关下发：走 openai-completions + `http://127.0.0.1:<port>/v1`（Cline 自行追加 /chat/completions，不补 /v1）

Command Code（cmd，~/.commandcode/，COMMANDCODE_HOME 可覆盖）：
  providers.json  { provider: { "<id>": { name, api, baseURL, apiKey, headers, models{}, disabled } } }
                   api 三值（省略 = 默认）：openai-completions / openai-responses / anthropic-messages
                   apiKey 只接受引用语法（"$ENV" / "{env:VAR}" / "!命令" / false），明文会被官方拒绝；
                   本插件恒写 false，真实 key 落 auth.json（见下）
                   models 为字典 { "<模型ID>": { name, contextWindow, maxOutput, reasoning, reasoningEfforts,
                   cost{input,output,cacheRead,cacheWrite}, options, api, baseURL } }，条目可为 {}
                   别名兼容：limit.context / limit.output 读作 contextWindow / maxOutput，cost 的 cache_read /
                   cache_write 归一为 cacheRead / cacheWrite；未知键经 _extra 原样往返
                   provider id 必须是 slug（^[a-z0-9][a-z0-9-]*$）：它同时是 settings.json 里模型的前缀
  settings.json   { modelProvider, model: "<providerId>/<modelId>", hooks, skills, disabledSkills, ... }
                   其余键读改写原样保留。模型 ID 自身可含 /，解析时只剥首个 provider 前缀
  auth.json       { "<providerId>": { apiKey }, apiKey, userId, userName, keyName, authenticatedAt }
                   ** 顶层 apiKey 是账号登录 key，与供应商 key 不同层**：写入必须 read-modify-write 单项，
                   绝不整体替换，写完 chmod 0600；读失败直接抛错（不能退化成 {} 后整体覆盖，会毁掉登录态）
  mcp.json        { mcpServers: { "<name>": { transport: "stdio"|"http", enabled, command, args, env, url, headers } } }
                   仅 user scope；local scope（projects/<slug>/mcp.json）与 project scope（<项目>/.mcp.json）不碰
                   oauth 等未知键经 _extra 原样往返；开关写条目 enabled（不删条目）
  config.json     localOnly 等少量开关（本插件不写）
  Skill：~/.commandcode/skills/<name>/SKILL.md；启停 = 物理移动目录到 .disabled/（同其它 agent）。
    官方另有 settings.json.disabledSkills 数组也能停用，本插件不写它，避免两套状态打架
  Taste（本项目独有，其它 agent 没有）：<项目>/.commandcode/taste/ + ~/.commandcode/taste/（global）
                   taste.md 用 `# 分类` 分节，条目形如 `- 内容. Confidence: 0.90`；
                   <= 5 条内联主档，> 5 条拆到 <category>/taste.md 并在主档留 `See [x/taste.md](./x/taste.md)`
                   读：引用子文件时正文取子文件；子目录存在但主档未引用时按 orphan 补进来
                   写：整包重写，超过阈值的分类写子文件+留引用，回落 <=5 条时把子文件并回主档并删目录；
                   删除分类时清理其子目录（只 rmdir 空目录，不留误删用户文件的可能）
                   置信度越界（<0 或 >1）直接报错，不静默夹紧
                   项目作用域的项目列表：listCommandCodeProjects() 扫 ~/.commandcode/projects/<slug>/。
                   **slug 是官方对 cwd 的有损编码**（/Users/shane/Documents/GitHub/CCConfig →
                   users-shane-documents-git-hub-cc-config，大小写/连字符全拉平）不可反解，
                   真实路径只存在于会话日志首行的 cwd 字段（{"type":"session",…,"cwd":"/…"}）；
                   因此每个 slug 目录读最新会话文件的前 4KB 取首行 cwd，读不到则退化用 slug 目录本身。
                   cwd 指向的目录已不存在（项目被移动/删除、worktree 已清理）→ 跳过，不列举写不进去的项目。
                   可传 extraRoots（上次选中 / 手动选的目录）并入结果，避免用户切走后找不到；
                   返回按目录内最新会话 mtime 倒序，带 hasTaste 供 UI 标记已初始化。
                   读路径（getCommandCodeTastePackages / Summary）在项目作用域缺 root 时返回空包不抛错，
                   只有写路径（persistTaste / init / open）抛错。
  使用统计：~/.commandcode/projects/<项目slug>/<会话ID>.jsonl，逐行 JSON：
     { type:"message", timestamp, model, usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, message }
     只取带 usage 的行（同一条消息可能拆多行，各自带增量），跳过 *.checkpoints.jsonl；
     日期取 timestamp 的本地日期；口径同其它 agent（输入含缓存 = input + cacheRead + cacheWrite，输出 = output）
     历史落库：ccconfig_agent_usage_commandcode_<nativeId>，源文件被清理后回放历史不归零
  通用库下发：协议一一对应（不做转换，三种 wire 官方都支持）；供应商名经 providerKeyFor 清洗为 slug；
    key 写 auth.json，providers.json 只记 false；contextWindow / maxOutput / reasoningEfforts / cost 写在模型条目上
  网关下发：api 仍按通用库协议（默认 openai-completions），baseUrl 带 /v1（cmd 自己只追加端点路径）
```

### Skill 目录扫描必须跟随符号链接（`fs-utils.js`）

`fs.readdirSync(dir, { withFileTypes: true })` 返回的 `Dirent.isDirectory()` **只看目录项自身的类型，对符号链接恒为 false**。
而「用软链挂载 Skill」是很常见的用法（`~/.agents/skills/ego-browser -> ~/.local/share/ego/ego-skills`、
dotfiles / chezmoi 管理、外部目录共享），直接 `isDirectory()` 会让这些条目**整条从 UI 消失**——不报错、不进场景、
不参与启停与统计。v1.5.0 之前所有 skill 扫描点都有这个问题。

统一规则（改动 skill 相关代码时照此执行）：

- 判定目录/文件一律走 `public/preload/services/fs-utils.js`（`isDirEntry(dir, entry)` / `isFileEntry(dir, entry)`），
  不要直接写 `entry.isDirectory()`。语义：先按 Dirent 判，链接再 `statSync` 跟随目标，断链/无权限返回 false。
- 目录条目计数用 `countEntries(dir)`：穿透软链、跳过隐藏项（`.DS_Store`）。
- **删除一律用 `rmEntry(p)`**：`lstat` 判定是链接就只 `unlink` 链接本身，绝不递归进目标目录。
  覆盖了 `deleteCommonSkill` / `deleteSkill` / `deleteProjectSkill` / `deleteClineSkill` / `deleteGrokSkill` /
  `deleteCommandCodeSkill` / `deleteOpencodeSkill` 与 `skills-install.js` 的 `completeInstall`（重装同名软链 Skill 时）。
- 启停（`renameSync` 到 `.disabled/`）移动的是链接本身，不复制、不动源目录——安全，已在测试里锁住。
- 断链（指向已不存在的目标）不显示、也不让整轮扫描失败。

当前已改造的扫描点：`common.js`（通用 Skill + 场景绑定）、`skills.js`（Claude 全局/项目级）、`opencode.js`、
`grok.js`、`cline.js`、`command-code.js`、`plugins.js`（插件组件发现）、`pi-package-detail.js`（pi 包资源）、
`skills-install.js`（安装时递归找 SKILL.md）。冒烟测试：`tests/smoke-symlink-skill.cjs`。

### 订阅用量（通用 → 订阅）

用户手动添加自己订阅的第三方服务，插件用**本机浏览器的登录态**代他查用量，结果同时显示在订阅页与桌面版托盘面板。
官方没有公开的用量接口，也不发 token，只能用浏览器里那份会话 Cookie 去请求它自家前端调的接口。

```
Cookie 来源（public/preload/services/browser-cookies.js）—— 浏览器清单**不是白名单**，只是加速表：
  查找顺序（命中即止，越靠前越可信）：
    1) 用户手选的目录 customDirs（订阅弹窗里的「选择目录」，存在 item.cookieDirs）
    2) CHROMIUM_SOURCES 已知清单（chrome/edge/brave/chromium/vivaldi/arc/ego lite/quark/qqbrowser）
    3) 自动发现 discoverChromiumRoots()：从 ~/Library/Application Support（win: AppData 的 Local/Roaming）
       起扫 depth≤3，判据是「目录里有 Local State 且真有 Cookie 库」，实测 330ms 扫完 1500+ 目录
    4) Firefox   5) Safari(macOS)
  Chromium 库路径：<root>/Cookies、<root>/Network/Cookies，profile 目录名先按
      Default / Default Profile / Profile N / Person N 匹配，再对任意子目录兜底（跳过 Cache 等 SKIP_DIRS）
      macOS：磁盘库加密 v10 → 钥匙串 “<Browser> Safe Storage” → PBKDF2-SHA1(salt=saltysalt,1003 轮,16B)
             → AES-128-CBC(IV = 16 个 0x20) → 去 "v10" 前缀 → 剥掉开头 32 字节 SHA256(host_key)
             钥匙串条目名要猜：ego lite 注册的 service 是 “ego safe storage”（全小写、短名），
             所以 guessKeychainServices() 试 <name> Safe Storage / 小写 / 首词变体，再按
             `security dump-keychain` 里的 /safe storage$/i 前缀模糊匹配
      Windows：Local State 的 os_crypt.encrypted_key（去 DPAPI 前缀 → DPAPI 解出 32B key）
             → v10/v11 + AES-256-GCM → 同样剥 32 字节 host hash；v20（App-Bound）目前不支持
             **每个应用的 os_crypt 密钥独立**，必须按 root 分别取（winKey 按 root 缓存），
             不能拿 Chrome 的密钥解 Edge 的库
  Firefox → profiles.ini 指向的 moz_cookies（明文；手选目录时直接找 cookies.sqlite）
  Safari  → ~/Library/Cookies/Cookies.binarycookies 或 ~/Library/Containers/com.apple.Safari/.../Cookies.binarycookies
  查询（sqlite-query.js）：先把库文件 copyFileSync 到临时目录再查（浏览器持锁），
      node:sqlite 优先（Node ≥22.5），否则回退子进程 node --experimental-sqlite
  expires_utc 是 WebKit 时间（~1.34e16，超 JS 安全整数）→ SQL 里必须 CAST(expires_utc AS TEXT)

  两个「别把界面卡死」的硬约束（都实测踩过）：
  1) **先查明文列、后碰钥匙串**：readChromium 先用 host_key/name 筛出这个库里到底有没有目标 Cookie，
     有才去取解密密钥。否则每个装了的 Chromium 应用都会弹一次钥匙串授权框、没点就各等超时，
     实测本机 Chromium + ego lite + Quark 三个刚好都装了 → 未优化前 15s 起，优化后 342ms。
  2) **钥匙串授权没被允许就立刻收手**：`security find-generic-password -w -s <svc>` 在没人点弹窗时会
     一直挂着 → 首次超时 15s / 重试 5s，超时（SIGKILL）即记 keychainBlocked 并让 findCookies 的
     stop() 立即终止后续所有浏览器；失败结果只缓存 60s（用户这次点「拒绝」，下次点「允许」不该要重启插件）。
     不带 -w 的 `find-generic-password -s <svc>` 是 10ms 且不弹窗，用来廉价判断条目是否存在。
  keychainBlocked 会随 captureCookie 返回给渲染进程 → UI 显示「去 macOS 弹窗里点允许」而不是干巴巴「没找到」。

适配器（public/preload/services/subscriptions.js 的 ADAPTERS）:
  { id, cookieHosts, cookieNames, loginUrl, apiBase, fetchUsage(cookie) }
  open-design：amr-api.open-design.ai，Cookie __Secure-better-auth.session_token（只发 Cookie + Accept，
      不需 UA/Origin/Referer）
      /api/auth/get-session            → 登录态校验（失效时返回 200 null）
      /api/v1/workspaces/current       → workspaceId（免硬编码）
      /api/v1/billing/summary?timeZone=… → 套餐档位 / 订阅周期 / creditsPerUsd(10000)
      /api/v1/workspaces/<ws>/billing/coding-plan-usage → windows[]：
          durationSeconds 18000 = 5 小时窗口，604800 = 周窗口；usedCredits/limitCredits 是**字符串**
          credits ÷ 10000 = USD
  新增站点：加一个 ADAPTERS 条目即可，UI/存储/托盘都不用改

  自定义目录兜底：captureCookie(provider, {customDirs}) 把用户手选的目录传给 findCookies；
  pickCookieDir() 走 window.utools.showOpenDialog({properties:['openDirectory']}) → inspectDir() 校验
  （返回 {ok, dir, kind:'chromium'|'firefox'|'safari', name, dbCount}，没 Cookie 库则 ok:false + no_cookie_db）。
  注意桌面版 desktop/sidecar/utools-shim.js 的 showOpenDialog 原本只实现 `choose file`，
  必须按 properties 里的 openDirectory 切到 AppleScript 的 `choose folder`，否则选目录框选不到目录。

  手抄 Cookie（订阅弹窗里的「手动填 Cookie」输入框）：钥匙串授权拿不到（uTools 版尤其常见——
  授权主体是宿主 uTools.app，且不能继承终端/桌面版点过的「始终允许」）/ 想用别的机器的登录态时的兜底。
  UI 侧 manualCookie 非空即优先于自动读取结果（effectiveCookie = 手填 || 浏览器读取），
  此时 captureState='manual'、不显示「没找到」/「已从某浏览器读到」；保存时 cookieSource 传空 →
  服务层落 SOURCE_MANUAL='manual'，列表的「重新读取登录态」据此改成「去编辑里重粘」的提示，
  而不是永远报「本机浏览器里没有找到登录态」。addSubscription/updateSubscription 本来就直接收 cookie 字符串，
  服务层只多了一条来源标签，校验仍是 /^[^=;]+=[^;]*/ + 先请求一次接口验活。
  **只粘值也能用**：用户在 DevTools 的「应用 → Cookie」看到的是名称/值两列，复制出来的通常只是值，
  所以 normalizeCookieInput(raw, adapter) 统一做三件事：去首尾引号、「Cookie: 」前缀；
  单 Cookie 站点（适配器 cookieNames 只有一条，如 open-design）在「不含 `;` 且不以 `<name>=` 开头」时
  自动补 `<name>=`；多段（a=1; b=2）原样保留。
  判断「是否已带名称」**不能**用「含 `=`」——base64/URL 编码的值自带 `=` 填充（`...wk=`、`...%3D`），
  否则会把填充符当成分隔符。URL 编码（`%2F`/`%3D`）与解码后的原值服务端都接收，实测 get-session 均 200。

存储:
  ccconfig_subscriptions_<nativeId> → [{ id, provider, label, cookie(加密 v2:<iv>:<ct>), cookieSource,
      cookieDirs(手选的浏览器数据目录，非敏感，对外原样返回), workspaceId, snapshot, lastError,
      lastErrorAt, cookieExpired, updatedAt }]
      cookieSource 为浏览器显示名（如 'ego lite'）或 'manual'（用户手抄）
  对外（getSubscriptions）剥掉 cookie 原文，只留 hasCookie；失效 Cookie 不删（换回登录态就能救活）
  刷新：单个 refreshSubscription / 批量 refreshSubscriptions（只刷超过 5 分钟或已过期的，带并发守卫）
  添加：先读本机 Cookie → 先请求一次接口验活 → 通过才入库（不留永远登不上的死记录）

展示:
  语义：全站一律用「剩余」——用户关心的是还剩多少（进度条越长 = 越充裕，阈值也随之反转：≤30% 橙、≤10% 红）
  订阅页 src/Switch/common/SubscriptionsView.vue：每个窗口一行（名称 + 「剩余 96%」+ 进度条），不显金额与重置时间
  桌面版托盘弹窗（desktop/tray.html）：getSubscriptionsTray() 返回结构化数据，页面直接画进度条
      title = 「站点品牌 · 套餐」（如 `Open Design · go`）；email = 账号邮箱；
      state = 'ok' | 'expired' | 'nodata'；windows = [{ key, label, percent }]（label 已本地化，percent 是**剩余**百分比）；
      message = 过期 / 无数据时的提示文案（已本地化）
      页面先渲染这份缓存快照（绝不在首帧等网络），再用异步 /rpc-poll 调 refreshSubscriptions 原地更新；
      每张卡片右上角有手动刷新（refreshSubscription 单条，绕过 5 分钟节流），失败只短暂提示、保留缓存；
      刷新失败保留缓存，不打扰用户
  两个界面同源（同一份 `ccconfig_subscriptions_<nativeId>`），但**视图各自持有内存副本**：
      托盘每次展开都重读库；只有切到「用量」页签（或展开时正停在该页签）才按 5 分钟节流打一次接口，网关页签不发起订阅请求；订阅页保持挂载（v-if + v-show），所以必须在
      「页签变可见 / 窗口重新聚焦或可见」时重读库（只读，不联网），否则会出现「托盘已刷新、
      页面还是旧值」。只有首次挂载才按 5 分钟节流打一次接口。
  冒烟测试：node tests/smoke-subscriptions.cjs（不联网，覆盖存储脱敏/托盘数据/窗口与倒计时换算）
```

### 启动失败与引导页（桌面版）

- 引导页 `desktop/guide.html` 两个入口：① 探测不到 Node（>=18）；② sidecar 起不来。Rust 通过
  `window.__CC_FAIL__ = {kind, reason, tried}` 注入原因，`kind === "sidecar"` 时标题换成「本地服务没能启动」，
  否则用户会误以为是没装 Node。
- 失败原因同时追加到 `~/.ccconfig/logs/sidecar.log` 的 `[app] ...` 行（Finder 启动时 eprintln 用户看不到），
  引导页的「排查」卡片就指这个文件。
- `Sidecar::start` 失败会**自动重试一次**（`start_sidecar_with_retry`，间隔 1s）：启动瞬间的抢跑（旧实例收尾、健康检查）
  不该直接把用户丢到引导页。
- `desktop/sidecar/server.js` 的父进程守护要求**连续 2 次**探测失败（间隔 3s）才自杀，且 `EPERM`（无权限发信号）
  视为存活；单次 `ESRCH` 就 `process.exit(0)` 会让正常启动的应用掉到引导页。
- 托盘「重启网关」现在也会在主窗口缺失时重建主窗口并关掉引导页（`restart_sidecar`），不必重开应用。

## 认证与模型选择细节

### Claude 认证方式

- 每配置可选 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`（互斥，切换时写一清一）。
- 模型输入框下拉候选对任意供应商实时拉取（复用 Pi 的 `fetchProviderModels`，`{baseUrl}/models` → `/v1/models` 回退，Bearer + x-api-key 双头，防抖 500ms，失败静默为空）。
- OpenCode Go：URL 精确等于 `https://opencode.ai/zen/go`（不带 /v1）时自动切 API_KEY 认证。

## 语言与外观

- **语言**：`src/composables/useLocale.js` 读取本机文档 `ccconfig_locale_<nativeId>`（`system` / `zh-CN` / `en-US`，旧共享 `ccconfig_locale` 仅作迁移种子），默认跟随系统（`navigator.languages`）。变更时同步 `i18n.global.locale`、`<html lang>`、DB，并调用 `window.services.setLocale()`；preload 用它更新 `service.json` 文案与 uTools 指令注册。桌面版 Rust 托盘通过 sidecar RPC 先取 nativeId，再读本机语言档（读不到回退共享档 / 系统语言）。
- **文案目录**：`shared/i18n/{zh-CN,en-US}/*.json`，Vue / preload / Rust 共用；`npm run i18n:check` 校验 key 与占位符。
- **外观**：`src/composables/useAppearance.js` 读取 `ccconfig_dark_background_<nativeId>` 的 `theme`（`system|light|dark`），解析出 `isDark`。`<html theme-mode>` 显式写 `dark`/`light`；`effect-active` 由解析后的深色状态驱动。只有固定主题与系统外观不一致时加 `theme-mismatch`，`theme.css` 用 `::before` 在 WebGL canvas（z-index -1）之下铺 `--td-bg-color-page` 纯色底；一致时保留 uTools 亚克力 / 桌面版 vibrancy。
