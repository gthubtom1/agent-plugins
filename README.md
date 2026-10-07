# Agent Plugins Hub（多智能体插件库）

全生态 AI Coding Agent 增强插件精选仓库。收录面向 **DeepSeek Harness (dsh)**、**PI-Desktop**、**Claude Code**、**Codex**、**OpenCode** 等主流智能体的优质插件与扩展。

按宿主分层隔离，自包含架构，即插即用。

---

## 📦 已收录插件清单

| 智能体分类 | 插件名称 | 说明 | 交互能力 | 状态 | 快速直达 |
|---|---|---|---|---|
| **Pi Agent** | `cmd-guard` | **命令执行守卫**：自动补 timeout / 物理拦截 GUI 二进制 / 卡死状态栏 | 状态栏 + `/guard` `/stall` | 🟢 生产就绪 | [查看文档](plugins/pi/cmd-guard/README.md) |
| **Pi Agent** | `retry-level` | **重试档位**：菜单切档 off/3/5/15/30/无限，状态栏常显 | `/retry [cycle\|status\|N]` | 🟢 生产就绪 | [查看文档](plugins/pi/retry-level/README.md) |
| **Pi Agent** | `pi-infinite-retry` | Pi Coding Agent 早期简版无限重试扩展（已被 `retry-level` 取代，保留参考） | 斜杠命令 `/retry` | 🟡 已被取代 | [查看文档](plugins/pi/pi-infinite-retry/README.md) |
| **DSH** | `dsh-infinite-retry` | 仿 PI-Desktop 无限重试插件：遇网络波动/429限流持续重试直到成功 | 自带设置页 Switch 开关 | 🟢 生产就绪 | [查看文档](plugins/dsh/dsh-infinite-retry/README.md) |
| **PI-Desktop** | *(规划中)* | 面向 PI-Desktop 的原生 `.piplug` 扩展 | Work Panel / Sidecar | 🟡 建设中 | [分类主页](plugins/pi-desktop/README.md) |
| **Claude Code** | *(规划中)* | 面向 Claude Code 的 MCP 工具与 Hook 增强 | 终端 CLI / Tools | 🟡 建设中 | [分类主页](plugins/claude-code/README.md) |
| **Codex** | *(规划中)* | 面向 Codex 的本地自动化与环境桥接扩展 | CLI / Runtime | 🟡 建设中 | [分类主页](plugins/codex/README.md) |
| **OpenCode** | *(规划中)* | 面向 OpenCode 的前端主题与工作流插件 | Webview / Extensions | 🟡 建设中 | [分类主页](plugins/opencode/README.md) |

---

## 🧾 整机环境清单（插件 / MCP / 技能 / 配置）

本仓库不只收自制插件，还是 **Toti 本机 AI Agent 环境的可复现清单**：

| 资产 | 位置 | 装法 |
|---|---|---|
| 第三方 pi 包（9 个，带锁定版本） | `manifest/pi-settings.json` · `docs/ENV-MANIFEST.md §2` | `pi install npm:<包>@<版本>` |
| 自制 pi 扩展 | `plugins/pi/*`（含源码） | `pi install git:github.com/gthubtom1/agent-plugins@main` |
| MCP server（pi 侧 10 个 + Orca 侧 4 个，带地址） | `manifest/mcp.json` · `manifest/agent-servers.json` | 复制到 `~/.pi/agent/mcp.json` / `~/.agents/servers/` |
| 技能（3 个备份） | `manifest/skills/` | 恢复脚本拷回 `~/.agents/skills/` |
| 配置脱敏模板（models/settings/open-tui/keybindings/trust/web-search） | `manifest/*.json` | 恢复脚本写入 `~/.pi/agent/` |
| 扩展哈希基线 | `manifest/extensions.sha256.json` | `scripts/check-sync.ps1` 对账 |
| 纪律卡 hubcore（私有库） | `docs/ENV-MANIFEST.md §8` | 见该节 |

> 密钥（`auth.json`、provider apiKey、x64dbg Bearer）**一律不入库**：仓内只有 `${NEWAPI_API_KEY}` / `${X64DBG_MCP_TOKEN}` 占位符，
> `.gitignore` 也硬性忽略 `auth.json` / `manifest/local/`。

**换机一条命令：**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\restore-machine.ps1 -ToolRoot 'D:\Tools' -PyRoot 'D:\Tools\py' -NewApiKey 'sk-…' -X64dbgToken '…'
```

> 不传 `-ToolRoot` / `-PyRoot` 时依次取环境变量 `REVERSE_TOOL_ROOT` / `REVERSE_PY_ROOT`，
> 都没有才用 `D:\Tools` / `D:\Tools\py`。换盘不用改脚本。

完整说明（含每个插件的仓库地址、版本、落盘位置与踩坑）见 **[docs/ENV-MANIFEST.md](docs/ENV-MANIFEST.md)**。

---

## 🏛️ 仓库目录结构

```text
agent-plugins/
├── docs/                          # 规范与设计架构
│   ├── ARCHITECTURE.md            # 多智能体插件统一架构设计说明
│   ├── CONTRIBUTING.md            # 新插件接入与提交流程
│   └── ENV-MANIFEST.md            # 本机整机环境清单（插件/MCP/技能/配置 + 地址 + 恢复流程）
├── manifest/                      # 本机环境脱敏模板与哈希基线（不含密钥）
│   ├── pi-settings.json           # settings.json 模板（packages 锁定版本）
│   ├── mcp.json                   # 10 个 MCP server（token 占位）
│   ├── agent-servers.json         # Orca 侧 4 个 MCP server 定义
│   ├── models.json                # provider + 模型表（apiKey 占位）
│   ├── open-tui.json / web-search.json / keybindings.json / trust.json
│   ├── extensions.sha256.json     # 扩展哈希基线（对账用）
│   └── skills/                    # 3 个技能备份 + NOTICE
├── scripts/
│   ├── restore-machine.ps1        # Windows 换机恢复（幂等）
│   ├── restore-machine.sh         # Git Bash / WSL 换机恢复
│   ├── check-sync.ps1             # 本机扩展 vs 哈希基线对账
│   ├── regen-extension-baseline.ps1 # 改了插件后重算基线（必跑，否则对账必报漂移）
│   ├── split-servers.js           # agent-servers.json → 每 server 一个文件
│   └── regen-manifest.js          # 在源机器上重新生成 manifest/（泄露即报错）
└── plugins/                       # 各智能体专属分类目录
    ├── dsh/                       # DeepSeek Harness 插件
    │   └── dsh-infinite-retry/    # 无限重试插件（带 UI 开关）
    ├── pi/                        # Pi Coding Agent 扩展
    │   ├── cmd-guard/             # 命令执行守卫（清单推荐）
    │   ├── retry-level/           # 重试档位（清单推荐）
    │   └── pi-infinite-retry/     # 早期简版（保留参考，不进安装清单）
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

## 🔁 改了插件之后（必做，否则下次换机会拿到旧版）

```powershell
# 1) 本机自测 —— 插件目录里都有 smoke 测试
node plugins\pi\cmd-guard\smoke-cmd-guard.mjs

# 2) 把新版本复制到本机 pi 家目录
copy plugins\pi\cmd-guard\* "$env:USERPROFILE\.pi\agent\extensions\" -Force

# 3) 重算基线并当场对账（一条命令同时做两件事）
powershell -ExecutionPolicy Bypass -File scripts\regen-extension-baseline.ps1 -PiHome $env:USERPROFILE\.pi\agent

# 4) 单独对账（正常机器上退出码 0）
powershell -ExecutionPolicy Bypass -File scripts\check-sync.ps1

# 5) 提交
git add -A && git commit -m "..." && git push
```

**为什么第 3 步不能省**：基线里的哈希是手改的话，换机时 `pi install` 按基线校验就会失败；
基线里写了仓库里根本不存在的文件（本仓库曾经躺着 3 个 `orca-*`），则 check-sync 永远报 MISSING。
两者都是同一个病：**基线必须由仓库内容生成，不能由记忆生成。**

`regen-extension-baseline.ps1` 的收录规则是「扫 `plugins/*/*/` 下的 `*.ts`、`*.rules.json`、
`smoke-*.mjs`」，所以新增插件不用改脚本。唯一的例外：想保留参考但**不要**装到机器上的插件，
在它目录里放一个 `RETIRED` 文件就会被自动跳过（`plugins/pi/pi-infinite-retry/` 就是这么处理的）。

---

---

## 📖 开发者文档

- [查看架构设计文档](docs/ARCHITECTURE.md)
- [查看插件开发与贡献指南](docs/CONTRIBUTING.md)

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。
