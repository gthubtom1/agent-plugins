# cmd-guard（Pi Coding Agent 命令执行守卫）

为 Pi 的 `bash` / `powershell` 调用补充超时预算，检查能明确识别的简单命令，并通过 `/stall` 查看运行时长、输出静默时间和最近结果。GUI 默认放行，`blockGui: true` 才启用严格拦截。

## 识别范围与边界

守卫使用保守的词法识别，**不是完整的 Shell 解析器，也不是安全隔离机制**。只有能够确认程序和字面量参数的简单命令，才参与内置阻断判断或 SSH 改写；参数中的命令名称或说明文字不会被当作实际调用。

复杂脚本、heredoc、命令或变量替换、重定向等无法可靠识别的形式会跳过内容判断与改写，仍保留超时和运行记录。简单命令链和管道中可明确识别的调用仍接受网络及根扫描检查；交互式检查和 SSH 改写只处理单条调用。不能依靠本插件限制任意脚本的行为。

## 超时预算

`timeout` 单位为秒。调用方提供的有效正数优先，超过 `maxTimeout` 才截到上限；扫描命令也遵守显式预算。缺失或无效的预算会按命令类型补齐：

| 配置 | 默认值 | 用途 |
|---|---|---|
| `probeTimeout` | 30 | 可识别的探查命令 |
| `analysisTimeout` / `defaultTimeout` | 120 | 可识别的普通命令 |
| `heavyTimeout` | 600 | 构建、解释器，以及无法可靠识别的复杂脚本 |
| `scanTimeout` | 180 | 未提供有效预算的递归扫描 |
| `maxTimeout` | 1800 | 前台超时上限 |

不猜测毫秒，也不自动换算单位。复杂命令即使跳过内容判断，仍有超时兜底。

## 简单命令检查

- **交互式调用**：`blockInteractive: true` 时，检查 Bash 下明显需要交互或长期驻留的简单调用，如 `watch`、`vim`、`top`、交互式 `fzf`。已知的非交互用法，如 `vim -es`、`top -b -n 1`、`fzf --filter`，允许执行。
- **网络设置**：内置规则检查实际程序及子命令。IP、DNS、路由、代理写入，以及接口禁用或重启等危险操作仍受限制；只读查询、启用防火墙和 `Enable-NetAdapter` 允许执行。提示描述操作影响，不依赖特定机器上的脚本。
- **根目录递归扫描**：`blockRootScan: true` 时，只拦截实际从文件系统根或盘符根开始的递归扫描。浅层 `dir C:\`、`Get-ChildItem C:\` 允许执行；`find / -maxdepth 0`、`find / -maxdepth 1`，以及根目录上的 `Get-ChildItem -Depth 0/1` 允许执行。更深的根目录递归仍可能被拦截。非递归文件搜索不会仅因路径在根目录就被判为递归扫描。

### SSH 与 rsync

两个预设均启用 `hardenSsh: true`。只改写**单条、直接调用的字面量 `ssh` / `scp` / `sftp` / `rsync` 命令**，且要求没有 Shell 操作符、重定向或替换表达式。包装命令、显式 `-F` 配置文件、未知选项布局和复杂形式跳过改写，保留工具超时。

对 `ssh` / `scp` / `sftp`，分别检查并补充缺失的选项：

```text
-o ConnectTimeout=15
-o ServerAliveInterval=15
-o ServerAliveCountMax=3
```

每个选项独立处理：已有 `ConnectTimeout` 时，仍可补齐缺失的心跳选项。保留调用方已有选项、参数和数据，不追加 stdin 重定向。`rsync` 使用自己的 `--timeout=15`，已有值保持不变，不向它注入 SSH 的 `-o` 参数。

### GUI 严格模式

`blockGui` 默认为 `false`。启用后，简单调用中命中 GUI 名单的程序会被拦截；已知的帮助、版本查询和控制操作（如 `procmon /Terminate`）仍允许执行。`Test-Path <gui.exe>` 和 `echo "gui.exe"` 不属于启动 GUI。

GUI 名单优先级为：`guiBinaries` 手工项 > 文档派生 > 内置表。手工值为 `null` 或空字符串时，明确放行该项。可通过 `skillRoot`、`toolChainPaths` 或 `CMD_GUARD_SKILL_ROOT` 指定文档来源；兼容 `RELAB_SKILL_ROOT` / `REVERSE_SKILL_ROOT`。找不到 `TOOL-CHAIN.md` 时使用内置表；GUI 拦截关闭时，不显示缺少该文档的启动警告。

## 配置与命令

配置位于同目录的 `cmd-guard.rules.json`。VM 预设为 `cmd-guard.rules.vm.json`，复制为前者即可使用；其探查、分析、构建和扫描预算分别为 60、180、900、240 秒。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enforce` | `true` | 关闭后，Shell 规则只提示；超时与 SSH 参数调整仍生效 |
| `blockInteractive` | `true` | 检查 Bash 简单交互式调用 |
| `blockRootScan` | `true` | 检查实际的根目录递归扫描 |
| `blockGui` | `false` | 显式启用 GUI 严格模式 |
| `hardenSsh` | `true` | 为符合识别条件的直接调用补充缺失选项 |
| `stallSeconds` | `240` | 标记长时间运行，用于报告 |
| `noOutputStallSeconds` | `90` | 标记长时间无输出，用于报告 |
| `allow` | `["cmd-guard-skip"]` | 命令包含任一指定子串时，整条跳过守卫 |

配置通常在 30 秒内自动重读。**每次执行 `/guard`（含子命令）都会重新加载配置**；状态包含 `hardenSsh`。

可用 `disableDeny` 按规则 ID 关闭特定网络检查。`denyRules` 自定义正则匹配规范化后的简单调用文本，建议用 `^程序名` 锚定调用；它们由用户配置，独立于内置检查。

| 命令 | 作用 |
|---|---|
| `/guard` | 重读配置并显示规则来源、超时预算和各开关状态 |
| `/guard rules` | 重读配置并显示 GUI 名单及来源 |
| `/guard reload` | 立即重读配置与文档并报告状态 |
| `/guard on` · `/guard off` | 重读配置后切换本次会话的守卫开关 |
| `/stall` | 报告命令摘要、运行时长、静默时间、预算和最近结果 |

`/stall` 只报告观察到的事实，不附加任务安排或工具路由建议。静默可能来自正常计算、输出缓冲或等待输入，不代表死锁；插件不会因静默自动中断命令，也不会自动转后台。Windows 子进程占用输出管道时，工具仍可能超过预算；MCP 无响应和模型流中断也不在本插件的处理范围。

设环境变量 `CMD_GUARD=0` 后重启 Pi，可彻底关闭插件。

## 安装与验证

```powershell
pi install "C:/path/to/agent-plugins-lab/plugins/pi/cmd-guard"
```

也可把整个 `cmd-guard` 目录复制到 `~/.pi/agent/extensions/cmd-guard/`，保留 `lib/` 和包清单；随后执行 `/reload`，再用 `/guard` 查看生效配置。

```text
node smoke-cmd-guard.mjs
```

自测使用模拟 Pi API，不执行用例中的命令。需要 Node.js 22.19+；Pi SDK 加载另由仓库的 `test:sdk` 检查。

## 许可

MIT，见 `LICENSE`。
