# Agent Plugins Hub（多智能体插件库）

自制插件的**源码仓库**。每个插件自带 `README.md`（人看的说明）和安装方法；
智能体读完文档就能装，**不需要任何安装脚本**。

> **给智能体的一句指令**：把这个仓库里需要的插件装上，装之前先把要装的东西编号列给我确认。

---

## 📦 插件清单

| 宿主 | 插件 | 说明 | 交互 | 状态 | 文档 |
|---|---|---|---|---|---|
| **Pi** | `pi-seep-ext · persona` | **按对话的人设**：人设 = `personas/*.md`（文件名即名字），随时切换/关闭，`cached`（省 token）/ `every-turn` 两种注入；切「无人设」真的删掉系统提示词里的身份 | 状态栏按钮 + `/persona` | 🟢 生产就绪 | [查看](plugins/pi/pi-seep-ext/README.md) |
| **Pi** | `pi-seep-ext · rewind` | **回退**：回到某条消息之前 / 只删最后一条回复，原文放回输入框（官方 `navigateTree`，不碰会话文件）；**状态栏「⟲ 回退」点一下就退** | 状态栏按钮 + `/rewind` `/undo-reply` | 🟢 生产就绪 | [查看](plugins/pi/pi-seep-ext/README.md) |
| **Pi** | `pi-seep-ext · remote` | **手机连上**：局域网/Tailscale 地址、终端二维码、运行期生成密码、5 行自检；不改 pi-web | `/remote` | 🟢 生产就绪 | [查看](plugins/pi/pi-seep-ext/README.md) |
| **Pi** | `cmd-guard` | **命令执行守卫**：自动补 timeout / 拦截 GUI 二进制 / 卡死状态栏 | 状态栏 + `/guard` `/stall` | 🟢 生产就绪 | [查看](plugins/pi/cmd-guard/README.md) |
| **Pi** | `retry-level` | **重试档位**：菜单切档 off/3/5/10/15/30/无限，状态栏常显且可点 | `/retry` | 🟢 生产就绪 | [查看](plugins/pi/retry-level/README.md) |
| **Pi** | `pi-prompt-compat` | **人格与粘性规则兼容层**：PERSONALITY.md + RULES.md 跨轮次常驻 | `/rules-status` `/rules-reload` | 🟢 生产就绪 | [查看](plugins/pi/pi-prompt-compat/README.md) |
| **Pi** | `shell-guard` | 命令护栏：超时分档、拒绝整盘 find/grep、删除分档（用户点名的可删，盘根/系统目录拒绝）、后台未重定向检测；另有 `search_files` 走 Everything 毫秒级查文件名 | 自动生效 + `search_files` | 0.2.2，审查中 | [查看](plugins/pi/shell-guard/README.md) |
| **DSH** | `dsh-infinite-retry` | 仿 PI-Desktop 无限重试插件：遇网络波动/429 持续重试直到成功 | 自带设置页 Switch | 🟢 生产就绪 | [查看](plugins/dsh/dsh-infinite-retry/README.md) |
| **PI-Desktop** | *(规划中)* | 面向 PI-Desktop 的原生 `.piplug` 扩展 | Work Panel / Sidecar | 🟡 建设中 | [分类主页](plugins/pi-desktop/README.md) |
| **Claude Code** | *(规划中)* | 面向 Claude Code 的 MCP 工具与 Hook 增强 | 终端 CLI / Tools | 🟡 建设中 | [分类主页](plugins/claude-code/README.md) |
| **Codex** | *(规划中)* | 面向 Codex 的本地自动化与环境桥接 | CLI / Runtime | 🟡 建设中 | [分类主页](plugins/codex/README.md) |
| **OpenCode** | *(规划中)* | 面向 OpenCode 的前端主题与工作流插件 | Webview / Extensions | 🟡 建设中 | [分类主页](plugins/opencode/README.md) |

### Seep 部署用户特别说明

Seep 中二开过的自有扩展已同步回来。通用插件保持独立可装；完整 Seep 适配代码另存为
[seep-workbench](plugins/pi/seep-workbench/README.md)，**不加入根安装清单**。

- 已经通过 Seep 安装器部署的人，不要再把本仓库根包整包装一遍；人设、守卫、重试、提示词会重复加载。
- 新设备部署 Seep 仍按 [Seep 主仓库](https://github.com/gthubtom1/SRL) 的安装流程；本仓库不是技能、KB、工具和 MCP 的替代安装器。
- 本次同步范围、来源和复验见 [同步说明](docs/SEEP-SYNC-2026-11-02.md)。第三方下载内容未更新。

**第三方 pi 插件**（不在本仓库，用安装命令直接装，**永远是最新版**）：

| 插件 | 装法 | 说明 |
|---|---|---|
| `@hk_net/pi-advisor` | `pi install npm:@hk_net/pi-advisor` | **顾问**：一轮结束后让第二个模型复查并投递意见，可手动 `/advise`。**注意**：热门的 `@bacnh85/pi-advisor` 只在终端工作（`ctx.mode !== "tui"` 直接跳过），pi-web 里用这个 |

---

## 安装

### 本仓库的自制插件（一条命令）

```bash
pi install git:github.com/gthubtom1/agent-plugins@main
```

根 `package.json` 的 `pi.extensions` 是安装清单；pi 会把仓库 checkout 下来按清单加载，
所以**更新 = `pi update`**，不需要重新拷贝文件。

只装其中一包：

```bash
pi install <本地路径>/plugins/pi/pi-seep-ext
```

### 项目组合安装

Reverse workflow 只通过安装器注册 reverse skill、官方工具和可选的 shell-guard；项目状态仍以原始 scope、Evidence、Spec Kit 和项目文件为准。

换电脑使用 [reverse-workflow-installer](https://github.com/gthubtom1/reverse-workflow-installer) 的 Pi 安装，它会冻结所选插件发布 tag 的确切 commit，只注册对应子目录，并保留安装与恢复回执。

### 第三方插件

用 npm 装，不锁版本、跟着上游更新：

```bash
pi install npm:@hk_net/pi-advisor
```

---

## 仓库结构

```text
agent-plugins/
├── plugins/                     # 插件源码，一个宿主一个目录
│   ├── pi/                      # Pi Coding Agent
│   │   ├── pi-seep-ext/         #   人设 / 回退 / 远程（包形式：extensions/ + lib/ + test/）
│   │   ├── cmd-guard/           #   单文件扩展
│   │   ├── retry-level/
│   │   └── pi-prompt-compat/
│   ├── dsh/
│   ├── claude-code/ codex/ opencode/ pi-desktop/   # 占位（只有 README）
│   └── ...
├── skills/                      # 现役技能备份（3 个），拷回 ~/.agents/skills/
├── docs/
│   ├── ARCHITECTURE.md          # 分层设计说明
│   └── CONTRIBUTING.md          # 新插件接入流程
└── package.json                 # pi.extensions = 安装清单
```

**没有的东西（刻意不放）**：安装脚本、环境快照、MCP 清单、机器部署哈希基线。
原因：这些内容里几乎全是"这台机器"的路径、端口和令牌，换机后不可复用；
插件本身是源码，智能体读文档 + 一条 `pi install` 就够了。Seep 专用包的 `SOURCE.json` 只记录公开源码来源与哈希，不是本机环境快照。

---

## 约定

- 单文件插件：源码 + `package.json`（`main` 指向 `.ts`）+ `README.md` + `LICENSE`。
- 多文件/有依赖的插件：做成**包形式**（`package.json` 里写 `pi.extensions`），走 `pi install`。
- 插件里不写死机器路径或用户名；需要外部程序时，运行时探测并给出安装提示。
