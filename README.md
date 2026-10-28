# CCConfig

**简体中文** | [English](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20uTools-blue)](#安装)
[![uTools](https://img.shields.io/badge/uTools-plugin-1a73e8)](https://u.tools/)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8)](https://tauri.app/)
[![Vue](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/ShaneLevs/CCConfig?style=social)](https://github.com/ShaneLevs/CCConfig/stargazers)

多应用 AI 配置管理工具，同时提供 [uTools](https://u.tools/) 插件与 macOS 独立应用两种形态。

把十四个 AI 编程 CLI 的供应商、模型、MCP、Skill、插件与 Token 用量收进一个界面，一键切换供应商，不必再手改 TOML/YAML/JSON。

## 功能特性

- **统一应用切换** — 十四个 AI CLI + 跨 agent 的「通用配置」，各自独立配置，一键切换
- **API 配置管理** — 逐应用读取、保存、切换供应商配置，本工具不管理的字段原样保留（未知键往返不丢）
- **供应商/模型主数据** — 共享的供应商与模型库（API Key AES-256-CBC 加密），支持 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages / Google Generative AI 四类协议，一键下发到任意受支持的 agent
- **本地网关** — 把选中的供应商/模型暴露在 `http://127.0.0.1:<port>`，对本机任意 agent 提供 Anthropic / OpenAI Chat / OpenAI Responses 三种协议，跨协议自动转换（含流式）
- **MCP 管理** — 逐应用 MCP Server 配置 + 实时工具发现画布；通用配置里的共享 MCP 按机器开关镜像写入本地 JSON 文件
- **Skill 与插件管理** — 从 SkillHub / 魔搭社区安装 Skill 并用 `.disabled` 机制启停；管理 Claude Marketplace 插件、OpenCode plugin 数组、Pi Extension
- **使用统计** — Token 用量、模型分布、GitHub 风格贡献墙热力图；通用统计页另有按天/按周堆叠的 Token 柱状图，可按模型或 Agent 拆分看用量构成
- **订阅用量** — 手动添加已订阅的服务（目前 open-design），用本机浏览器的登录态代查 5 小时／周额度，同时显示在桌面版托盘面板
- **批量编辑 / 导入导出 / 外观** — 按供应商聚合一键改 URL+Key，JSON 文件或压缩加密字符串导入导出；外观支持跟随系统 / 固定浅色 / 固定深色，深色下可选动态背景特效
- **中英双语** — 默认跟随系统语言，可在「设置 → 通用」中切换简体中文 / English

## 支持的应用

| 应用 | 配置文件 |
|---|---|
| Claude Code | `~/.claude/settings.json`（MCP 在 `~/.claude.json`） |
| OpenCode | `~/.config/opencode.json` / `opencode.jsonc` |
| Pi Agent | `~/.pi/agent/settings.json` + `models.json` |
| omp | `~/.omp/agent/models.yml` + `config.yml` |
| Reasonix | `~/.reasonix/config.toml` |
| Codex | `~/.codex/config.toml` + `models.json` |
| Kimi Code | `~/.kimi-code/config.toml` |
| MiniMax Code | `~/.minimax/config.yaml` |
| Qoder | `~/.qoder/settings.json` / `~/.qoder-cn/settings.json` |
| ZCode | `~/.zcode/v2/provider_config.json` |
| Hermes | `~/.hermes/config.yaml` |
| DSH（DeepSeek Harness） | `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` |
| Grok Build（xAI 官方 CLI） | `~/.grok/config.toml` |
| Cline | `~/.cline/data/settings/providers.json` + `models.json`（MCP 在 `cline_mcp_settings.json`） |
| Command Code | `~/.commandcode/providers.json` + `settings.json`（key 在 `auth.json`，MCP 在 `mcp.json`，Taste 在 `taste/`） |

各应用的字段级规则见 [docs/architecture.md](docs/architecture.md)。

## 安装

**uTools 插件** — 在 uTools 插件商店搜索 **CCConfig** 安装。

**macOS 独立应用** — 需要本机已安装 Node.js ≥ 18（应用刻意不内置运行时）。

```bash
npm install
npm run tauri:build
# → release/CCConfig_<版本>_<arch>.dmg（Tauri 原始产物仍在 src-tauri/target/release/bundle/dmg/，
#   scripts/collect-release.mjs 在构建末尾复制一份到仓库根的 release/）
```

应用数据存放于 `~/.ccconfig/`。关闭窗口只是隐藏到菜单栏，本地网关继续运行：左键单击托盘图标打开状态面板（网关统计、订阅用量、快捷动作），右键单击显示窗口。

如果 Node 是通过 nvm/fnm/volta 安装的、从 Dock 启动后应用找不到它，可显式指定：

```bash
CCCONFIG_NODE=$(which node) open -a CCConfig
```

## 使用方式

uTools 中输入关键词唤起对应应用：`CCConfig` / `通用配置`（指向通用配置）、`Claude Code配置`、`OpenCode配置`、`Pi Agents配置`、`omp配置`、`Reasonix配置`、`Codex配置`、`Kimi Code配置`、`MiniMax Code配置`、`dsh配置`。粘贴 SkillHub / 魔搭链接进入 Skill 安装；`pi install <包名>` 进入 Pi Extension 安装。

macOS 独立应用没有搜索框：启动后进入「通用配置」，通过左侧栏切换应用。

## 开发

```bash
npm install
npm run dev          # uTools 插件开发服务器 (localhost:5173)
npm run build        # uTools 插件 → dist/
npm run build:app    # 桌面版渲染层 → dist-app/ + sidecar 资源
npm run tauri:dev    # 桌面版开发模式
npm run tauri:build  # 桌面版打包 → release/*.dmg
```

两个发行版共用 `src/` 与 `public/preload/`，只有外壳不同。架构说明与维持这一点的约束见 [AGENTS.md](AGENTS.md) 与 [docs/architecture.md](docs/architecture.md)。

## 技术栈

渲染层 Vue 3 + Vite + TDesign Vue Next；文案用 vue-i18n 与共享的 `shared/i18n` JSON（Vue / preload / Rust 三端共用）。文件读写与网络请求全部在打包后的 preload 里，经 uTools API 或 Tauri v2 Node sidecar 暴露。配置解析用 json5 / js-yaml / smol-toml；MCP 工具发现用 `@modelcontextprotocol/sdk`；背景特效用 ogl。

## License

[MIT](LICENSE)
