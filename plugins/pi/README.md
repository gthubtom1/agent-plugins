# Pi Coding Agent 插件专区

收录面向 **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** 的原生 TypeScript / JavaScript 扩展插件。

---

## 🚀 换机器怎么恢复（照这个做）

### 方式一：一条命令装完自制插件（推荐）

```bash
pi install git:github.com/gthubtom1/agent-plugins@main
```

本仓库根目录有 `package.json` 的 `pi.extensions` 清单，pi 会按它装好全部 **PI 侧自制插件**。

装完验证：

```bash
pi list                    # 看已配置包
```

### 方式二：补装公开插件（它们在 npm 上，不在本仓库）

本仓库只放**自制**插件。公开插件用 npm 装：

```bash
pi install npm:pi-plan-task
pi install npm:@demigodmode/pi-web-agent
pi install npm:@aaronkyriesenbach/pi-package-manager
pi install npm:pi-open-tui
pi install npm:pi-web-access
pi install npm:pi-mcp-adapter
pi install npm:pi-tool-display
pi install npm:pi-win-notify
pi install npm:@gotgenes/pi-subagents
```

> **一次性把上面全装完**（复制整段）：

```bash
for p in pi-plan-task @demigodmode/pi-web-agent @aaronkyriesenbach/pi-package-manager \
         pi-open-tui pi-web-access pi-mcp-adapter pi-tool-display pi-win-notify \
         @gotgenes/pi-subagents; do pi install "npm:$p"; done
```

### 方式三：手工放文件（上面都不行时）

```bash
# 把仓库克隆下来，挑要用的插件目录，把里面的 .ts 拷进 pi 的扩展目录
cp cmd-guard/cmd-guard.ts             ~/.pi/agent/extensions/
cp cmd-guard/cmd-guard.rules.json     ~/.pi/agent/extensions/
cp retry-level/retry-level.ts         ~/.pi/agent/extensions/
# 重启 pi（扩展在启动时加载）
```

---

## 📋 公开插件清单（npm 上可下，本仓库不存文件）

| 插件 | 作用 | 安装 |
|---|---|---|
| `pi-plan-task` | 任务计划 | `pi install npm:pi-plan-task` |
| `@demigodmode/pi-web-agent` | Web Agent 能力 | `pi install npm:@demigodmode/pi-web-agent` |
| `@aaronkyriesenbach/pi-package-manager` | 包管理器界面 | `pi install npm:@aaronkyriesenbach/pi-package-manager` |
| `pi-open-tui` | TUI 增强 | `pi install npm:pi-open-tui` |
| `pi-web-access` | 联网访问 | `pi install npm:pi-web-access` |
| `pi-mcp-adapter` | MCP 适配 | `pi install npm:pi-mcp-adapter` |
| `pi-tool-display` | 工具调用展示 | `pi install npm:pi-tool-display` |
| `pi-win-notify` | Windows 桌面通知 | `pi install npm:pi-win-notify` |
| `@gotgenes/pi-subagents` | 子代理 | `pi install npm:@gotgenes/pi-subagents` |

> 这些是**第三方公开发布**的包，随上游更新。本仓库只登记名字与安装命令，不放它们的源码。

---

## 🔧 自制插件清单（本仓库保存源码）

| 插件 | 说明 | 交互形式 | 状态 | 文档 |
|---|---|---|---|---|
| `cmd-guard` | **命令执行守卫**：自动补 timeout / 物理拦截 GUI 二进制 / 卡死状态栏 | 状态栏 + `/guard` `/stall` | 🟢 生产就绪 | [查看](cmd-guard/README.md) |
| `retry-level` | **重试档位**：菜单切档（off/3/5/10/15/30/无限），状态栏常显，无限档可 Esc 中断 | `/retry` `/retry cycle` `/retry status` | 🟢 生产就绪 | [查看](retry-level/README.md) |
| `pi-infinite-retry` | 老版无限重试（简版）：开关式，无档位菜单 | `/retry on\|off\|status\|<num>` | 🟡 被 `retry-level` 取代 | [查看](pi-infinite-retry/README.md) |

> ⚠️ **`retry-level` 与 `pi-infinite-retry` 都注册 `/retry`，不要同时启用**。
> 新装机器建议只用 `retry-level`（功能更全）。`pi-infinite-retry` 的源码保留作参考，
> 不在根 `package.json` 的自动安装清单里。

---

## 📖 插件开发规范（Pi 专有）

1. **入口规范**：插件为标准的 TypeScript 或 JavaScript 模块，默认导出工厂函数 `export default function(pi: ExtensionAPI) { ... }`。
2. **生命周期支持**：
   - 工具注册：`pi.registerTool(...)`
   - 斜杠命令：`pi.registerCommand(name, { description, handler })`
   - 快捷键与标志：`pi.registerShortcut(...)`、`pi.registerFlag(...)`
   - 事件监听：`pi.on("session_start" | "tool_call" | "message_end" | ...)`
3. **即时热重载**：支持在运行时通过 `await ctx.reload()` 动态加载新配置，无需重启宿主进程。
4. **加入本仓库的约定**：
   - 每个插件一个目录：`plugins/pi/<插件名>/`
   - 目录内必须含：入口文件、`README.md`、`package.json`、`LICENSE`
   - 新增后**记得往仓库根 `package.json` 的 `pi.extensions` 里加一行**（否则 `pi install` 装不到它）
   - `README.md` 要写：为什么需要它 / 它做什么 / 怎么装 / 踩过的坑

---

## 🗂 其他宿主的插件

| 宿主 | 目录 |
|---|---|
| Claude Code | `plugins/claude-code/` |
| Codex | `plugins/codex/` |
| DeepSeek Harness (dsh) | `plugins/dsh/` |
| OpenCode | `plugins/opencode/` |
| PI-Desktop | `plugins/pi-desktop/` |

各宿主的加载方式不同，见对应目录下的 `README.md`。
