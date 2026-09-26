# Agent Plugins Hub（多智能体插件库）

全生态 AI Coding Agent 增强插件精选仓库。收录面向 **DeepSeek Harness (dsh)**、**PI-Desktop**、**Claude Code**、**Codex**、**OpenCode** 等主流智能体的优质插件与扩展。

按宿主分层隔离，自包含架构，即插即用。

---

## 📦 已收录插件清单

| 智能体分类 | 插件名称 | 说明 | 交互能力 | 状态 | 快速直达 |
|---|---|---|---|---|---|
| **DSH** | `dsh-infinite-retry` | 仿 PI-Desktop 无限重试插件：遇网络波动/429限流持续重试直到成功 | 自带设置页 Switch 开关 | 🟢 生产就绪 | [查看文档](plugins/dsh/dsh-infinite-retry/README.md) |
| **PI-Desktop** | *(规划中)* | 面向 PI-Desktop 的原生 `.piplug` 扩展 | Work Panel / Sidecar | 🟡 建设中 | [分类主页](plugins/pi-desktop/README.md) |
| **Claude Code** | *(规划中)* | 面向 Claude Code 的 MCP 工具与 Hook 增强 | 终端 CLI / Tools | 🟡 建设中 | [分类主页](plugins/claude-code/README.md) |
| **Codex** | *(规划中)* | 面向 Codex 的本地自动化与环境桥接扩展 | CLI / Runtime | 🟡 建设中 | [分类主页](plugins/codex/README.md) |
| **OpenCode** | *(规划中)* | 面向 OpenCode 的前端主题与工作流插件 | Webview / Extensions | 🟡 建设中 | [分类主页](plugins/opencode/README.md) |

---

## 🏛️ 仓库目录结构

```text
agent-plugins/
├── docs/                          # 规范与设计架构
│   ├── ARCHITECTURE.md            # 多智能体插件统一架构设计说明
│   └── CONTRIBUTING.md            # 新插件接入与提交流程
└── plugins/                       # 各智能体专属分类目录
    ├── dsh/                       # DeepSeek Harness 插件
    │   └── dsh-infinite-retry/    # 无限重试插件（带 UI 开关）
    ├── pi-desktop/                # PI-Desktop 插件
    ├── claude-code/               # Claude Code 扩展
    ├── codex/                     # Codex 扩展
    └── opencode/                  # OpenCode 扩展
```

---

## 🌟 核心设计原则

1. **分级命名空间隔离**：不同智能体的技术栈（Cordis、piplug、MCP、CLI）彻底物理隔离，互不产生依赖污染。
2. **独立自包含（Self-contained）**：每个插件自成一体，内含独立的 `package.json`、`README.md` 与许可证，支持直接单独拷贝或作为独立包分发。
3. **用户体验优先**：关键行为变更（如重试策略、自动化工具）一律配备开关控件或配置项，支持随时停止与干净注销。

---

## 📖 开发者文档

- [查看架构设计文档](docs/ARCHITECTURE.md)
- [查看插件开发与贡献指南](docs/CONTRIBUTING.md)

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。
