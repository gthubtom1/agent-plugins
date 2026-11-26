# cmd-guard（Pi Coding Agent 命令执行守卫扩展）

专为 **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** 打造的命令执行守卫：
**为前台命令设置超时预算，拦截明显的交互式调用，并通过 `/stall` 查看运行时长和输出静默时间**。

解决的是 AI 智能体最容易死的一类问题 —— **命令不返回，模型就永远停在那里**。

---

## 📖 为什么需要这个插件？

Pi 的 `bash` / `powershell` 工具的 `timeout` 参数是**可选**的，不传就无限等：

```javascript
// dist/core/tools/bash.d.ts
timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }));
```

模型要等工具返回才能继续。此时 Pi 的界面仍可响应；命令没有输出，可能是正常计算、输出缓冲，也可能在等输入或子进程。cmd-guard 通过 `/stall` 报告它观察到的状态，不把静默当成死锁。

### 实测的四种卡死场景

| 场景 | 症状 | 根因 | 本插件怎么治 |
|---|---|---|---|
| **GUI 二进制经管道启动** | 弹窗等输入、零 stdout、进程永不退出 | 如 `die.exe`（DIE GUI 版），应改用 `diec` | 物理拦下，给出 CLI 替代 |
| **VMware 快照类操作** | `vmrun snapshot` 对运行中客户机写快照，锁争用时无限期挂起 | VIX 同步调用 | 后台跑 + 轮询产物的提示回灌 |
| **交互式命令无 stdin** | `ssh` 弹 `Are you sure / password` | 缺 `</dev/null`、缺 `ConnectTimeout` | 自动补 |
| **递归扫描大目录** | `find "C:/" ...` 无输出但一直在跑 | 无界耗时 | 抬 timeout 到 ≥180s；**盘根递归（`find /` / `dir /s C:\`）直接拦下**并给替代路径 |

---

## ⚡ 它做什么

### 1. 自动补 timeout（三档 + 一个下限）

| 命令类型 | 补的值 |
|---|---|
| 探查类（`where` / `Test-Path` / `Get-ChildItem`） | 30s |
| 普通命令 | 120s |
| 构建 / 解释器（`npm i` / `cargo build` / `python`） | 600s |
| 递归大目录扫描 / 盘符根扫描 | ≥180s |

`timeout` 一律按秒处理。有效显式值优先，但扫描下限和 `maxTimeout`（默认 1800 秒）仍适用。超过上限会截到上限并提示秒/毫秒区别，不猜测原意或自动换单位。

### 2. GUI 程序默认放行（可选严格拦截）

命令默认允许启动 GUI 程序，因为 IDA、x64dbg、Wireshark 等工具本来就需要窗口。GUI 名单仍然保留，用于识别工具和在需要时启用严格模式。把 `cmd-guard.rules.json` 的 `blockGui` 改成 `true` 后，命中名单的程序才会被拒绝执行，并给出 CLI 或 headless 替代方案：

```text
[cmd-guard] 已拦下：`die.exe` 是 GUI/交互式程序。
它会弹窗等输入、零 stdout、进程永不退出；命令阻塞期间模型不在运行，物理上无法自愈。
改用：改用 CLI 版 diec（先 --version 确认参数）
工具真实路径怎么查：先跑 `(Get-Command <工具id> -ErrorAction SilentlyContinue).Source`，
无值再按 TOOL-CHAIN.md 的四级递进（env → PATH → _map.json 别名 → 递归兜底）。
```

**只识别「命令位置」上的二进制**，不识别字符串和路径参数；默认模式下这些命令都会放行，严格模式才会拦截：

| 命令 | 严格模式结果 |
|---|---|
| `die.exe sample.exe` | 🚫 拦下 |
| `Test-Path D:\Tools\DIE\die.exe` | ✅ 放行（这是探测文件在不在） |
| `echo "run die.exe first"` | ✅ 放行（这是字符串） |
| `echo hi && die.exe sample.exe` | 🚫 拦下（链后半段也算命令位置） |

### 3. 有界化易挂命令

- `ssh` / `scp` / `sftp` / `rsync` 自动补 `-o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3`，
  bash 侧再补 `</dev/null` 断掉交互提示。
  已经有 `ConnectTimeout` 的不重复注入；`echo "ssh is old"` 这种字符串不被改写。
- 递归大目录扫描 / 盘符根扫描的 timeout 抬到 ≥180s，不会被 30s 的探查档误杀。

- Bash 额外拦截明显需要交互或常驻的形态，如 `watch`、`vim`、`top`、交互式 `fzf` 和未指定序列编辑器的 `git rebase -i`。保留 `vim -es`、`top -b -n 1`、`fzf --filter` 等非交互用法，不把 `less`、`node` 一概拦下。新规则只检查明显的独立命令；管道、命令链、脚本等不做交互式判定，交给超时兜底。

### 4. 把坑回灌给模型（让它自己改）

命中下面这些模式时，在工具结果里追加一段提示，模型看得到就会改：

- 单条命令串了 >8 段（任一段等交互或打错路径，整条就死）
- 同一条命令里混用 POSIX 路径与 Windows 路径（Git-Bash 下 `/tmp` 实为 `C:\tmp`）
- PowerShell 的 `start` 不带 `/b`
- `vmrun snapshot/suspend`

### 5. 长时间运行时怎么看

- **底栏**：不显示常驻汇总或运行中状态；拦截通知和命令弹窗照常显示。
- **`/stall`**：查看命令摘要、运行时长、静默时间、超时预算和最近结果（含超时或中断）。`◐` 表示较久无输出，`⚠` 表示已过预算但工具还没返回。
- **能力边界**：不按静默强杀，不自动转后台，不覆盖 Pi 自带工具。Windows 上如果子进程仍占着输出管道，Pi 的工具调用仍可能超过预算；MCP 无响应和模型流中断也不在本插件范围。

参考：[`pi-prevent-stuck`](https://github.com/lukeramsden/pi-prevent-stuck) 的非 TTY 实测清单、[Pi #11743](https://github.com/earendil-works/pi/issues/11743) 的超时单位反馈、[Pi #11613](https://github.com/earendil-works/pi/issues/11613) 与 [OpenCode #20902](https://github.com/anomalyco/opencode/issues/20902) 的子进程输出管道问题。

---

## ★ GUI 名单从哪来（这是本插件最关键的设计）

**优先级：rules.json 手工项 > 文档派生 > 内置兜底表**

文档派生的意思是：**插件去读你技能包里的 `TOOL-CHAIN.md`，把它写的
`` `foo.exe`→`foo-cli` `` 变成一条拦截规则。**

```
你改了 TOOL-CHAIN.md  →  不用改任何代码  →  拦截自动生效
```

这条设计的后果：

- **加工具不用碰插件。** 文档里加一行 `` `foo.exe`→`foo-cli` ``，下次调用就认得。
- **文档删了，拦截自动消失。** 不存在「清单过时」这个问题。
- **换机零配置。** 插件会自动往上找含 `TOOL-CHAIN.md` 的目录（现为 `skillpack/TOOL-CHAIN.md`，早期是仓根 `TOOL-CHAIN.md`，两种布局都认），
  找不到再依次试环境变量 `RELAB_SKILL_ROOT` / `REVERSE_SKILL_ROOT`、习惯位置 `C:\relab2`。
  全找不到时**只退到内置兜底表，并在启动横幅和会话通知里明说「★未找到 TOOL-CHAIN.md」**。

> ⚠️ 明确不做的事：**不依赖任何 `tool-index.md` 之类的生成物。**
> 那类文件是旧框架的产物，路径在换机后不存在，读不到会导致 GUI 拦截**整个静默失效** ——
> 这是最坏的失败模式（看起来一切正常，其实已经不拦了）。所以宁可少拦，也不静默。

### 怎么确认它到底认得什么

```
/guard          # 看状态：规则来源、条数、当前阈值
/guard rules    # 打印完整名单，派生项会标「（来源 TOOL-CHAIN.md）」
```

---

## ⚙️ 配置：`cmd-guard.rules.json`

每个字段在文件里都带 `_说明` 注释，就地可读。常用的几个：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enforce` | `true` | `false` = 不执行 Shell 规则的阻断；超时和 SSH 参数调整仍生效 |
| `blockInteractive` | `true` | Bash 下的交互式命令拦截，可单独关闭 |
| `maxTimeout` | `1800` | Bash / PowerShell 前台超时上限（秒） |
| `noOutputStallSeconds` | `90` | 无输出更新超过该秒数时在 `/stall` 报告中提示静默；不会自动中断 |
| `blockGui` | `false` | 默认放行 GUI 程序；设为 `true` 才物理拦截 GUI 名单中的程序 |
| `hardenSsh` | `true` | `false` = 不改写 ssh/scp |
| `guiBinaries` | `{}` | 手工项。值 = 替代提示语；写 `null` = **明确不拦这一条** |
| `toolChainPaths` | `[]` | 额外再从哪些 Markdown 派生 |
| `skillRoot` | `null` | 留空 = 自动探测 |
| `allow` | `["cmd-guard-skip"]` | 命令含其中任一子串则整条跳过守卫 |

**当前默认策略**：GUI 程序允许启动，timeout、交互式命令、盘根扫描和网络危险操作继续受保护。需要严格防止 GUI 从 Shell 启动时，把 `blockGui` 改为 `true`，然后运行 `/guard reload`。

改完 30 秒内自动生效，或 `/guard reload` 立即生效。

---

## 🎛️ 命令

| 命令 | 作用 |
|---|---|
| `/guard` | 看状态：规则来源、条数、各档 timeout、enforce / blockGui 开关 |
| `/guard rules` | 打印完整 GUI 名单（派生项标来源） |
| `/guard reload` | 立刻重读 rules.json 与文档 |
| `/guard on` · `/guard off` | 本次会话内开关 |
| `/stall` | 命令执行健康报告 + 处置处方 |

彻底关闭：设环境变量 `CMD_GUARD=0` 后重启 pi。

---

## 🧪 自测

```
node smoke-cmd-guard.mjs
```

用模拟 Pi API 驱动插件，不执行用例中的命令。默认使用 Node.js 22.19+ 的 TypeScript 加载，检测到 Pi 独立安装的 jiti 则用 jiti。也可将 `PI_JITI_ANCHOR` 指向能解析 `jiti` 的 Pi 安装内的绝对文件路径。

覆盖的关键行为（每一条都对应一个曾经出过问题的判定）：

- `Test-Path <gui.exe>` / `echo "<gui.exe>"` **不能**被误拦（位置识别）
- 链式命令后半段的 GUI 遵循 `blockGui` 配置
- `idat.exe` 这类 headless 工具**明确不拦**
- 提示语带「（来源 TOOL-CHAIN.md）」= 文档驱动真的生效了
- 递归扫描下限、有效显式预算和异常 timeout 上限
- 交互式命令拦截、无交互替代和带引号的命令文本不误伤
- 起始空更新不刷新静默，结束事件清理运行状态
- `echo "ssh is old"` 不被改写；已有 `ConnectTimeout` 不重复注入

---

## 🔌 安装

```powershell
pi install "C:/path/to/agent-plugins/plugins/pi/cmd-guard" # 先克隆仓库，只安装本插件
```

或手动：把 `cmd-guard.ts`、`cmd-guard.rules.json` 复制到 `~/.pi/agent/extensions/`。

装完用 `/guard` 确认一下规则来源。**如果显示「★未找到 TOOL-CHAIN.md」，
说明这台机器上技能包不在已知位置** —— 设 `RELAB_SKILL_ROOT` 指向技能包根，或在
rules.json 里写 `toolChainPaths`。不处理也能用（内置兜底表还在），只是少了文档派生。


---

## 📄 许可

MIT。见 `LICENSE`。
## Seep 回流修复（2026-11-02）

通用版同步：只读搜索首段误判、SSH 每段独立补超时、rsync 使用自己的
`--timeout` 参数、自定义禁手可被 `disableDeny` 关闭、ESM 目录解析、移除历史机器路径探测。
`CMD_GUARD_SKILL_ROOT` 与旧环境变量仍可显式指定文档根；没有工具链文档时明确降级。

通用版不实现 Seep 的任务授权或风险预算。`allow` 的整条命令放行语义不变。
