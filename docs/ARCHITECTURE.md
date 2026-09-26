# 多智能体插件仓库设计架构（Multi-Agent Plugins Architecture）

## 1. 架构目标

在当今快速演进的 AI Coding Agent 生态中，存在多种主流智能体客户端与宿主运行时（如 **DeepSeek Harness (dsh)**、**PI-Desktop**、**Claude Code**、**Codex**、**OpenCode** 等）。

各智能体的底层插件规范差异显著：
| 智能体宿主 | 扩展架构 | 插件清单格式 | 前端界面能力 |
|---|---|---|---|
| **dsh (DeepSeek Harness)** | Cordis 微内核架构 / Node.js ESM | `package.json` (`dsh` 字段) + `cordis.patch.yml` | 支持通过 `client.js` 和 slots 注入 Web/Desktop 界面 |
| **PI-Desktop** | Electron + Node Sidecar + Webview | `manifest.json` + `.piplug` 打包格式 | 支持右侧工作面板（Work Panel）、独立视图与主题 |
| **Claude Code / Codex** | CLI 进程 / Hook 机制 / MCP Server | `mcp.json` / Extension 注册表 | 终端 ANSI 界面、进度条与确认卡片 |
| **OpenCode** | Webview + TS/JS 引擎 | 模块配置文件 | 面板与主题 |

为了在一个统一仓库中支持**全生态多智能体插件**的开发、维护与分发，本仓库采用 **分智能体命名空间（Agent-Isolated Namespaces） + 自包含包架构（Self-Contained Packages）**。

---

## 2. 目录结构规范

```text
agent-plugins/
├── .gitignore
├── LICENSE
├── README.md                      # 全局索引、各智能体插件总览与快速导航
├── docs/
│   ├── ARCHITECTURE.md            # 统一架构设计理念与技术选型（本文档）
│   └── CONTRIBUTING.md            # 插件开发流程、提交规范与测试要求
└── plugins/                       # 插件顶级目录
    ├── dsh/                       # DeepSeek Harness (dsh) 插件专区
    │   ├── README.md              # DSH 插件规范、安装与开发教程
    │   └── dsh-infinite-retry/    # 无限重试插件（带 UI 开关）
    │       ├── package.json       # 插件定义、peerDependencies、dsh 配置
    │       ├── index.js           # 宿主服务与流水线拦截核心
    │       ├── client.js          # 前端设置页面 Switch 开关组件
    │       ├── cordis.patch.yml   # Cordis 补丁挂载清单
    │       ├── README.md          # 插件专属详细文档
    │       └── LICENSE
    ├── pi-desktop/                # PI-Desktop 插件专区
    │   └── README.md              # PI-Desktop 插件规范（manifest.json、piplug）
    ├── claude-code/               # Claude Code 插件专区
    │   └── README.md
    ├── codex/                     # Codex 插件专区
    │   └── README.md
    └── opencode/                  # OpenCode 插件专区
        └── README.md
```

---

## 3. 设计原则

### 1. 独立自包含（Self-Contained）
每个插件子目录都是一个独立完整的包：
- 拥有独立的 `package.json`（带有该宿主平台的标准元数据，如 `dsh`、`pi-desktop`、`mcp` 等）。
- 拥有专属的 `README.md` 与 `LICENSE`，方便单独打包分发或发布到 npm/平台市场。
- 绝不与外部插件发生隐式跨目录相对引用，保证直接拷贝文件夹即可即插即用。

### 2. 零侵入与干净卸载（Zero Pollution & Clean Disposal）
- 不修改宿主二进制和核心内核源码。
- 严格遵循 Cordis / 宿主事件生命周期，在 `dispose` 时干净注销所有监听器与计时器，卸载即恢复原生。

### 3. 用户主权优先（User Control & Safety First）
- **绝不死循环**：所有重试、自动化或调度类插件，必须精确过滤致命不可恢复错误（如鉴权失败、请求非法、上下文溢出等）。
- **界面可控**：涉及运行时行为变更的插件，优先提供前端 Switch 开关或配置项，拒绝强制硬编码。
- **尊重取消**：严格贯通 `AbortSignal`，用户随时点停止即可立刻退出。

---

## 4. 后续扩展计划

- **CI/CD 自动化**：针对每个子目录独立运行 lint、typecheck 与单元测试。
- **自动发版与构建**：推送 tag 时，自动将 DSH 插件打包为 zip、将 PI-Desktop 插件打包为 `.piplug` 并发布到 GitHub Releases。
