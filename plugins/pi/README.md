# Pi Coding Agent 插件专区

收录面向 **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** 的原生 TypeScript / JavaScript 扩展插件。

> 这里只有**源码和文档**。没有安装脚本、没有环境快照、没有 MCP 清单 ——
> 插件就是文件，装法是 `pi install`，具体步骤每个插件的 README 写清楚，智能体读完就能做。

---

## 🚀 装（三选一）

### 装全部自制插件（一条命令）

```bash
pi install git:github.com/gthubtom1/agent-plugins@main
pi list                 # 验证
```

根 `package.json` 的 `pi.extensions` 是安装清单。pi 会把仓库 checkout 下来按清单加载，
所以**更新只需要 `pi update`**（或重新执行上面的 install），不用重新拷文件。

### 只装一个包

```bash
pi install <仓库路径>/plugins/pi/pi-seep-ext
pi -e     <仓库路径>/plugins/pi/pi-seep-ext     # 临时试一次，不写配置
```

### 单文件插件（想放进 `~/.pi/agent/extensions/` 时）

```bash
cp cmd-guard/cmd-guard.ts            ~/.pi/agent/extensions/
cp cmd-guard/cmd-guard.rules.json    ~/.pi/agent/extensions/
cp retry-level/retry-level.ts        ~/.pi/agent/extensions/
cp pi-prompt-compat/prompt-compat.ts ~/.pi/agent/extensions/
```

> `pi-seep-ext` 是**包形式**（多文件 + 依赖），不要手工拷单个文件，用上面的 `pi install`。

装完**新开一个会话**生效（扩展在会话启动时加载）。

---

## 📋 自制插件（本仓库保存源码）

| 插件 | 说明 | 交互形式 | 状态 | 文档 |
|---|---|---|---|---|
| `pi-seep-ext · persona` | **按对话的人设**：人设 = `personas/*.md`（文件名就是名字），随时切换/关闭，`cached`（省 token）或 `every-turn` 注入；切「无人设」会真的删掉系统提示词里的身份 | 状态栏按钮 + `/persona` | 🟢 生产就绪 | [查看](pi-seep-ext/README.md) |
| `pi-seep-ext · rewind` | **回退**：回到某条消息之前、或只删最后一条回复，原文放回输入框（官方 `navigateTree`，不碰会话文件） | `/rewind` `/undo-reply` | 🟢 生产就绪 | [查看](pi-seep-ext/README.md) |
| `pi-seep-ext · remote` | **手机连上**：局域网/Tailscale 地址、终端二维码、运行期生成密码、5 行自检；不改 pi-web | `/remote` | 🟢 生产就绪 | [查看](pi-seep-ext/README.md) |
| `cmd-guard` | **命令执行守卫**：自动补 timeout / 物理拦截 GUI 二进制 / 卡死状态栏 | 状态栏 + `/guard` `/stall` | 🟢 生产就绪 | [查看](cmd-guard/README.md) |
| `retry-level` | **重试档位**：菜单切档（off/3/5/10/15/30/无限），状态栏常显且可点，无限档可 Esc 中断 | `/retry` | 🟢 生产就绪 | [查看](retry-level/README.md) |
| `pi-prompt-compat` | **人格与粘性规则兼容层**：PERSONALITY.md + RULES.md 跨轮次常驻 | `/rules-status` `/rules-reload` | 🟢 生产就绪 | [查看](pi-prompt-compat/README.md) |

---

## 🌐 第三方插件（npm 上，装法只写命令，永远跟着上游更新）

| 插件 | 作用 | 安装 |
|---|---|---|
| `@hk_net/pi-advisor` | **顾问**：一轮结束后让第二个模型复查并投递意见（可按需 `/advise` 手动触发） | `pi install npm:@hk_net/pi-advisor` |

> **为什么是这一个**：最热门的 [`@bacnh85/pi-advisor`](https://www.npmjs.com/package/@bacnh85/pi-advisor)
> 在 `agent_settled` 里写着 `if (ctx.mode !== "tui") return` —— **只在终端工作，pi-web 里什么都不做**。
> `@hk_net/pi-advisor` 没有这道门，pi-web 里能正常审查并 `sendMessage` 到对话里。
> 详见 [`pi-advisor/README.md`](pi-advisor/README.md)。

其它按需自装（本仓库不登记、不锁版本）：

```bash
pi install npm:pi-web-access          # 联网访问
pi install npm:pi-tool-display        # 工具调用展示
pi install npm:pi-open-tui            # TUI 增强
pi install npm:pi-mcp-adapter         # MCP 适配层
```

---

## 🧩 技能备份

`skills/` 下是 3 个现役技能（computer-use / orca-cli / orchestration），拷回即可用：

```bash
cp -r skills/* ~/.agents/skills/
```

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
