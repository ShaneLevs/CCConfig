# OpenCode 配置联动与交互修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复用户反馈的 OpenCode 配置五个问题——通用库下发不复用接口类型、模型上下文/最大输出透传、单模型编辑污染同组其他模型、配置交互与 Pi/omp 不统一、切换 SDK 类型重置模型参数，把界面文案「OpenCode CLI」统一改为「OpenCode」；并扩展模型高级参数：插件内一等公民支持 reasoning / modalities（输入输出模态）/ options.effort / options.thinking 的配置、回显与下发透传。

**Architecture:** 三处改动点：① preload 下发层 `dispatch.js` 的 `dispatchToOpencode` 增加通用库协议 → opencode npm 包映射，并将模型条目由整体替换改为合并写入（保留 opencode 侧手工字段）；② 渲染层 `src/Switch/opencode/ConfigView.vue` 重构模型读-改-写路径——列表项携带原始配置条目 `raw`，所有写操作基于磁盘最新配置仅修改目标模型，Provider 编辑弹窗不再重建 models；③ 上下文/最大输出输入控件换成共享组件 `PresetCustomInput`（常用预设 + 自定义），与 Pi/omp 一致。

**Tech Stack:** Vue 3 Composition API、TDesign Vue Next、PresetCustomInput（共享组件）、preload services（Node fs/JSON5）、uTools DB（通用主数据，本次不改结构）

**状态（2026-09-21）：** Task 1–8 代码改动已在工作区完成并通过构建与 Node 模拟验证，尚未真机回归、未提交。

---

## 背景与根因分析

OpenCode 配置文件为 `~/.config/opencode/opencode.json(.jsonc)`，模型条目 schema：

```json
"provider": {
  "id": {
    "npm": "@ai-sdk/anthropic",
    "options": { "baseURL": "...", "apiKey": "..." },
    "models": {
      "model-id": { "name": "...", "limit": { "context": 200000, "output": 64000 } }
    }
  }
}
```

协议 → npm 映射（依据 opencode 官方文档 providers.mdx）：

| 通用库 provider.api | opencode npm |
|---|---|
| `openai-completions` | `@ai-sdk/openai-compatible` |
| `openai-responses` | `@ai-sdk/openai` |
| `anthropic-messages` | `@ai-sdk/anthropic` |
| `google-generative-ai` | `@ai-sdk/google` |

三个问题的根因：

1. **下发不复用接口类型**：`dispatchToOpencode` 写死 `npm: prev.npm || '@ai-sdk/openai-compatible'`，完全忽略通用库协议。
2. **编辑一个模型、同组其他模型变初始值**：`providerList` 把模型简化成 `{id, name, context, output, reasoning}` 显示对象，`handleSaveModel` / `confirmAddAutoModel` 却拿这批简化对象重建整个 `models` 映射写回文件——其他模型的 `{name, limit, options, cost...}` 正确格式被替换成扁平字段，重载后 `mc.limit?.context` 读不到值归零；且编辑目标模型有 `context || 128000` / `output || 4096` 兜底，未设置的模型被强灌初始值。
3. **切换 SDK 类型重置参数**：Provider 编辑弹窗 `openEditDialog` 对**数组**做 `Object.entries()`，解析出 `"0"/"1"` 伪模型 ID；保存时 `saveProvider` 用这批垃圾数据重建 models，全量覆盖真实模型配置。

---

### Task 1: 下发层——协议复用 + limit 透传合并写入

**Files:**
- Modify: `public/preload/services/dispatch.js`（`dispatchToOpencode`，约 L98–L145）

**Step 1: 新增协议映射表**

```javascript
const OPENCODE_NPM_BY_API = {
  'openai-completions': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  'anthropic-messages': '@ai-sdk/anthropic',
  'google-generative-ai': '@ai-sdk/google',
}
```

**Step 2: 重写 dispatchToOpencode**

- `nextNpm = OPENCODE_NPM_BY_API[provider.api || 'openai-completions'] || prev.npm || '@ai-sdk/openai-compatible'`（未知协议保留已有值）；
- 模型条目**合并写入**：`nextModel = { ...prevModel, name: model.name || prevModel.name || model.id }`，保留 opencode 侧已有的 `cost`/`tool_call` 等字段；
- `context/output` 经 `Number()` 归一后仅 >0 时写入 `limit`，且 `limit` 与旧值合并（不清空未下发的一侧）；
- 返回信息带协议短名：`provider[${id}]（anthropic）已更新…`。

**Step 3: 验证（Node 模拟）**

用临时 HOME 构造含手工字段（cost/tool_call/旧 limit）的存量配置，模拟 `dispatchToOpencode({api:'anthropic-messages',...}, {contextWindow:200000, maxTokens:64000,...})`：

Expected: `npm` 变为 `@ai-sdk/anthropic`；`limit.context=200000`、`limit.output=64000`；`cost`、`tool_call` 原样保留。

---

### Task 2: 渲染层——模型读-改-写重构（修复问题 2）

**Files:**
- Modify: `src/Switch/opencode/ConfigView.vue`

**Step 1: providerList 模型项携带原始条目**

简化显示对象追加 `raw: mc`，供编辑弹窗回读回写。

**Step 2: 新增 buildModelEntry / mutateProviderModels**

```javascript
// 表单 → opencode 模型条目；limit 仅 >0 时写入（0 = 默认，不落盘）
const buildModelEntry = (form) => { ... }  // name + limit? + options? + 额外字段

// 读-改-写：从磁盘取最新 provider，仅改动目标模型，其余条目/字段原样保留
const mutateProviderModels = (providerId, mutate) => { ... }
```

**Step 3: 重写增删改三个入口**

- `confirmAddAutoModel`：磁盘取 provider，`models[id]` 已存在则警告，否则 `buildModelEntry` 写入；
- `handleSaveModel`：支持模型 ID 改名（删旧键；新键冲突警告）；`openEditModelDialog` 从 `model.raw` 回读 limit/options/extraFields（此前编辑弹窗的 sdkOptions、extraFields 永远为空，保存即丢失）；
- `handleDeleteModel`：仅 `delete models[modelId]`。

**Step 4: 删除旧的 writeProviderModels 与所有 `|| 128000` / `|| 4096` 兜底**

`createEmptyModel` 初始值改为 `context: 0, output: 0`。

---

### Task 3: Provider 编辑弹窗——切换 npm 不再重置模型（修复问题 4）

**Files:**
- Modify: `src/Switch/opencode/ConfigView.vue`（`openEditDialog` / `saveProvider`）

**Step 1: openEditDialog 不再解析 models**

弹窗模板本就没有模型编辑 UI，删除 `Object.entries(provider.models)`（数组→伪 ID "0/1" 的根源）整段，`formData.models` 置空。

**Step 2: saveProvider 合并写回**

```javascript
const current = window.services.getOpencodeProviders();
const prev = current[id] || {};
const providerConfig = {
  ...prev,                      // 未知顶层字段原样保留
  npm: formData.value.npm,
  name: formData.value.name || id,
  options,                      // baseURL/apiKey/extraOptions 照表单重建
  models: dialogMode.value === "create" ? {} : { ...(prev.models || {}) },  // 编辑时原样保留
};
```

---

### Task 4: 统一上下文/最大输出交互（修复问题 3）

**Files:**
- Modify: `src/Switch/opencode/ConfigView.vue`（添加模型弹窗 + 编辑模型弹窗）

**Step 1: 引入共享组件与预设**

- import `PresetCustomInput`；移除 `InputNumber` import（本文件已无使用处）；
- 复制 Pi 同款预设 `CTX_OPTIONS`（默认/32K/64K/128K/200K/1M）、`TOKENS_OPTIONS`（默认/4K…384K）。

**Step 2: 替换两处表单项**

「Context 限制 / Output 限制」并排 InputNumber → 纵向两个 `PresetCustomInput`（label：上下文窗口 / 最大输出，`:default-custom` 分别为 128000/16384），与非预设值自动进入自定义模式，自动拉取带出的任意值同样支持。

---

### Task 5: 文案「OpenCode CLI」→「OpenCode」（修复问题 5）

**Files:**
- Modify: `src/Switch/index.vue`（页面标题 computed L96 + APP_META L185）
- Modify: `src/Switch/common/ConfigView.vue`（下发目标选项 L549）
- Modify: `src/Switch/common/AutoRouteView.vue`（路由目标选项 L13）
- Modify: `public/preload/services/dispatch.js`（注释）
- Modify: `README.md`（8 处）

**验证：** `grep -rn "OpenCode CLI" src README.md public` 无结果；`commands.js` 内置指令 label 原本即无 CLI，不动。

---

### Task 6: 模型高级参数——reasoning / modalities / effort / thinking

背景：opencode 模型条目远不止 name + limit（官方源码 `provider.ts` 解析 schema）：顶层 `reasoning: boolean`、`modalities: { input: [...], output: [...] }`（合法值 text/image/audio/video/pdf）、`options.effort`（思考档位）、`options.thinking: { type, budgetTokens }`（思考模式/预算），另有 tool_call/attachment/cost 等（继续走额外字段/SDK Options 自由格式）。需插件内一等公民配置 + 下发透传。

**Files:**
- Modify: `src/Switch/opencode/ConfigView.vue`
- Modify: `public/preload/services/dispatch.js`

**Step 1: 常量与表单字段**

- `KNOWN_MODEL_KEYS` 加 `reasoning`、`modalities`（不再泄漏进额外字段编辑器）；
- 新增 `MODALITY_OPTIONS`（文本/图像/音频/视频/PDF）、`EFFORT_OPTIONS`（minimal…max，与 MiniMax 页同款）、`THINKING_TYPE_OPTIONS`（enabled/adaptive/disabled）；
- `createEmptyModel` 加 `reasoning/modalitiesInput/modalitiesOutput/effort/thinkingType/thinkingBudget/thinkingExtra`。

**Step 2: buildModelEntry 写入规则**

- `reasoning: true` 仅勾选时写；
- 模态：输入/输出各自等于默认（纯文本或空）时不写 `modalities`，否则写选中数组；
- `options.effort` / `options.thinking` 由结构化字段接管：自由格式 SDK Options 编辑器回显时排除这两个键（`modelOptionsToKv(raw.options, ["effort","thinking"])`）；thinking 非 type/budgetTokens 子键存 `thinkingExtra` 合并回写，不丢数据；budgetTokens 仅 type=enabled 且 >0 时写（预算输入框也仅此时显示）。

**Step 3: 回显与自动拉取**

- `openEditModelDialog` 从 raw 读回全部结构化字段；
- `onAutoModelSelect` 带出 `reasoning`（fetchProviderModels 已返回该字段）。

**Step 4: 列表展示**

`providerList` 推理判定改为 `mc.reasoning === true || options.effort || options.thinking || reasoningEffort || variants`；模型行新增「X入/X出」模态 Tag 与思考参数摘要 stat（`thinkingStat`）；额外字段子标题去掉 modalities 字样。

**Step 5: 下发透传（dispatchToOpencode）**

- `model.reasoning` 为真 → `reasoning: true`；`model.input` 数组 → 合并写 `modalities.input`（通用库值集 text/image 为 opencode 合法值子集；有值才写，不清 opencode 侧已有声明）；
- 顺带补齐 cost 透传：通用 `{input,output,cacheRead,cacheWrite}` 全 0 省略，否则转 opencode 扁平 `{input,output,cache_read,cache_write}`（与 pi/omp 分支对齐）。

**Step 6: 验证**

- Node 模拟：通用库 `{reasoning:true, input:['text','image'], cost:{input:1,output:4}}` 下发 → 产出含 `reasoning: true`、`modalities.input`、`cost.cache_read`；
- 真机：编辑弹窗对示例配置（qwen3.8-max effort xhigh / qwen3.7-max thinking budgetTokens 8192）正确回显；纯文本模型保存不产出冗余 `modalities`；thinking 非标准子键往返不丢。

---

### Task 7: Pi / omp 重复下发由跳过改为合并覆盖更新

背景：旧实现 `if (!list.some(m => m.id === model.id)) list.push(entry)`——模型已存在则整个跳过，通用库改值后重下发 Pi/omp 侧不更新，与 OpenCode/MiniMax 的合并语义不一致。

**Files:**
- Modify: `public/preload/services/dispatch.js`

**Step 1: 抽共享函数 upsertDispatchModel(list, model)**

- 不存在 → 按原规则 push 新条目（返回 'added'）；
- 已存在 → 合并按钮：`name` 非空覆盖；`contextWindow/maxTokens` 仅 >0 覆盖（空不清旧）；`reasoning` 仅 true 时置 true；`input` 非空数组覆盖；`cost` normalizeCost 非空覆盖；`compat` 浅合并（未下发子键保留）；未知本地字段原样不动（返回 'updated'）。

**Step 2: dispatchToPi / dispatchToOmp 改调共享函数**，结果文案区分「已写入 / 已合并更新」。

**Step 3: 验证（Node 模拟，HOME 指向临时目录）**

- 二次下发改 contextWindow 64000→128000 生效，maxTokens=0 不清旧值；name 留空保留旧名；cost 全 0 保留；input/compat 正确覆盖/合并；
- omp 存量条目带本地手加 `localCustom`/`compat.prevKey`：空值下发仅动非空字段，未知键原样往返；
- 自动路由下发（同走此两分支）：重复下发由「首次写入后不变」变为「随网关配置更新」，预期改进。

---

### Task 8: 构建验证 + 真机回归 + 提交

**Step 1: 构建**

Run: `npm run build` → Expected: 无错误、无 `:deep()` 类警告（本轮依赖升级 + 清理后基线干净）。

**Step 2: 真机回归清单（uTools 内）**

- [ ] 通用库勾选 Anthropic 协议供应商下发 OpenCode → `opencode.json` 中 npm 为 `@ai-sdk/anthropic`，模型带 `limit.context/output`；
- [ ] 编辑模型 A 的上下文并保存 → 同组模型 B 的 limit/options/cost 不变；
- [ ] 编辑弹窗打开时 SDK Options/额外字段正确回显原配置；
- [ ] Provider 弹窗切换 npm 保存 → models 全部原样；
- [ ] 上下文窗口/最大输出预设点选 + 自定义输入 + 非预设回显自动切自定义；
- [ ] 添加模型弹窗从 `/models` 自动拉取选中后值正常带出；
- [ ] 界面各处标题/勾选项显示「OpenCode」（无 CLI）；
- [ ] 模型 ID 改名：旧键删除、新键冲突提示；
- [ ] 模型高级参数：reasoning 勾选/模态多选/effort/thinking 设置保存后 JSON 格式正确，重开弹窗回显一致；下发带 reasoning/input 的通用模型后 opencode.json 出现对应字段；
- [ ] Pi / omp 重复下发：改上下文后重下发值更新；通用库留空的字段不清 opencode/pi/omp 侧已有值；本地手加的未知键不丢。

**Step 3: Commit（main 直推，按关注点拆分）**

```bash
git add public/preload/services/dispatch.js src/Switch/opencode/ConfigView.vue
git commit -m "fix: OpenCode 配置五连修+增强——下发按协议映射 npm 并合并写入透传 limit/reasoning/modalities/cost；模型增删改仅触碰目标条目修同组污染；Provider 弹窗不再重建 models；模型弹窗一等公民支持 reasoning/modalities/effort/thinking；上下文/输出换 PresetCustomInput 与 Pi/omp 统一；Pi/omp 重复下发由跳过改为非空才覆盖的合并更新"
git add src/Switch/index.vue src/Switch/common/ConfigView.vue src/Switch/common/AutoRouteView.vue README.md
git commit -m "style: OpenCode CLI 文案统一改为 OpenCode（界面标题/下发与路由目标/README）"
git push origin main
```

（注：工作区另有依赖升级 + `:deep()` 清理两笔先前改动，建议先行单独提交 `chore:` / `fix:` 再叠本批；Task 1–3、6–7 的 dispatch.js 改动交织，统一并入本批 `feat:` 提交。）

---

## 影响面与风险

- **数据迁移**：无 schema 变更；此前被旧 bug 污染过的模型条目（扁平 `context/output` 字段）不会被自动修复，但再次编辑保存该模型即恢复正常格式，其余条目不受影响。
- **下发语义变化**：`dispatchToOpencode` 不再整条替换模型——同名模型重下发时 opencode 侧手工加的未知字段会保留（视为改进；若需"以通用库为准清场"需另加显式清除）。
- **自动路由下发**：`dispatchAutoRoute` 对 opencode 用 `openai-completions` → 现在会显式写 `@ai-sdk/openai-compatible`（与旧兜底一致），无行为回退。
- **预设控件**：0（默认）不再落盘 limit，依赖 opencode 从 models.dev 取标准值——与 Pi/omp 语义一致。
