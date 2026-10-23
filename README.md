# CCConfig

[简体中文](README.zh-CN.md) | **English**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20uTools-blue)](#installation)
[![uTools](https://img.shields.io/badge/uTools-plugin-1a73e8)](https://u.tools/)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8)](https://tauri.app/)
[![Vue](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/ShaneLevs/CCConfig?style=social)](https://github.com/ShaneLevs/CCConfig/stargazers)

A multi-app AI configuration manager, shipped as both a [uTools](https://u.tools/) plugin and a standalone macOS app.

It gives twelve AI coding CLIs a single place to manage API providers, models, MCP servers, skills, plugins and token usage — and lets you switch between providers in one click instead of hand-editing TOML/YAML/JSON.

## Features

- **Unified app switcher** — twelve AI CLIs plus a cross-agent "Common Config", each with independent, switchable API configurations
- **API config management** — read, save and switch provider configs per app, preserving every field the tool does not manage (unknown keys round-trip untouched)
- **Provider/model master data** — a shared provider and model database (AES-256-CBC encrypted keys) supporting OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Google Generative AI; dispatch it into any supported agent with one click
- **Local gateway** — expose selected providers/models at `http://127.0.0.1:<port>` and speak Anthropic, OpenAI Chat or OpenAI Responses to any local agent, with automatic cross-protocol conversion including streaming
- **MCP management** — per-app MCP server config plus a live tool-discovery canvas; shared MCP servers in Common Config mirror into local JSON files with a per-machine enable switch
- **Skill & plugin management** — install skills from SkillHub / ModelScope, toggle them via the `.disabled` mechanism; manage Claude Marketplace plugins, OpenCode plugin arrays and Pi extensions
- **Usage analytics** — token usage, model distribution and GitHub-style contribution heatmaps, aggregated across agents in one view
- **Batch edit, import/export, dark mode** — one-click URL+key updates per provider group, JSON file or obfuscated-string transfer, and system-following dark theme with optional animated backgrounds

## Supported apps

| App | Config location |
|---|---|
| Claude Code | `~/.claude/settings.json` (+ `~/.claude.json` for MCP) |
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
| DSH (DeepSeek Harness) | `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` |

Field-level rules for every app are documented in [docs/architecture.md](docs/architecture.md) (Chinese).

## Installation

**uTools plugin** — search for **CCConfig** in the uTools plugin store.

**macOS app** — requires Node.js ≥ 18 on your machine (the app deliberately does not bundle a runtime).

```bash
npm install
npm run tauri:build
# → src-tauri/target/release/bundle/dmg/CCConfig_*.dmg
```

App data lives in `~/.ccconfig/`. Closing the window keeps the app in the menu bar so the local gateway keeps serving: left-click the tray icon for the menu, right-click to reopen.

If Node was installed via nvm/fnm/volta and the app cannot find it when launched from the Dock, point it explicitly:

```bash
CCCONFIG_NODE=$(which node) open -a CCConfig
```

## Usage

In uTools, type a keyword to open the matching app — `通用配置` (Common Config), `Claude Code配置`, `OpenCode配置`, `Pi Agents配置`, `omp配置`, `Reasonix配置`, `Codex配置`, `Kimi Code配置`, `MiniMax Code配置`, `dsh配置`. Pasting a SkillHub / ModelScope link opens Skill install; `pi install <package>` opens Pi extension install.

The macOS app has no search box: it opens on Common Config and you switch apps from the left rail.

## Development

```bash
npm install
npm run dev          # uTools plugin dev server (localhost:5173)
npm run build        # uTools plugin → dist/
npm run build:app    # desktop renderer → dist-app/ + sidecar resources
npm run tauri:dev    # desktop app in dev mode
npm run tauri:build  # desktop app → .dmg
```

Both builds share `src/` and `public/preload/`; only the shell differs. Architecture notes and the constraints that keep this true are in [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md).

## Tech Stack

Vue 3 + Vite + TDesign Vue Next on the renderer; a bundled esbuild preload for all filesystem/network work, served through the uTools API or a Tauri v2 Node sidecar. Config parsing via json5, js-yaml and smol-toml; MCP tool discovery via `@modelcontextprotocol/sdk`; background effects via ogl.

## License

[MIT](LICENSE)
