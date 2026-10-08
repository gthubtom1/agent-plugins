# cmd-guard（Pi Coding Agent 命令执行守卫扩展）

专为 **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** 打造的命令执行守卫：
**自动给命令补超时、物理拦截 GUI 二进制、把易挂命令有界化、实时显示卡死状态**。

解决的是 AI 智能体最容易死的一类问题 —— **命令不返回，模型就永远停在那里**。

---

## 📖 为什么需要这个插件？

Pi 的 `bash` / `powershell` 工具的 `timeout` 参数是**可选**的，不传就无限等：

```javascript
// dist/core/tools/bash.d.ts
timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }));
```

而命令执行是**同步阻塞**的：命令不返回 → 模型不运行 → 没有任何 token 产出 → 终端计时器一直涨。

**关键点：模型不可能自己发现命令卡住。** 它在等待期间不在运行、没有任何代码在跑。
这类卡死**不会自愈** —— 只能中断，换一条路。

所以这件事不能只靠提示词说「记得传 timeout」。必须有一层**物理兜底**。

### 实测的四种卡死场景

| 场景 | 症状 | 根因 | 本插件怎么治 |
|---|---|---|---|
| **GUI 二进制经管道启动** | 弹窗等输入、零 stdout、进程永不退出 | 如 `die.exe`（DIE GUI 版），应改用 `diec` | 物理拦下，给出 CLI 替代 |
| **VMware 快照类操作** | `vmrun snapshot` 对运行中客户机写快照，锁争用时无限期挂起 | VIX 同步调用 | 后台跑 + 轮询产物的提示回灌 |
| **交互式命令无 stdin** | `ssh` 弹 `Are you sure / password` | 缺 `</dev/null`、缺 `ConnectTimeout` | 自动补 |
| **递归扫描大目录** | `find "C:/" ...` 无输出但一直在跑 | 无界耗时 | 抬 timeout 到 ≥180s |

---

## ⚡ 它做什么

### 1. 自动补 timeout（三档 + 一个下限）

| 命令类型 | 补的值 |
|---|---|
| 探查类（`where` / `Test-Path` / `Get-ChildItem`） | 30s |
| 普通命令 | 120s |
| 构建 / 解释器（`npm i` / `cargo build` / `python`） | 600s |
| 递归大目录扫描 / 盘符根扫描 | ≥180s |

**模型自带的 timeout 优先，永不被覆盖、也不会被压低。**

### 2. 物理拦截 GUI 二进制 ★

命中即**拒绝执行**，并把替代方案直接写进拦截理由：

```
[cmd-guard] 已拦下：`die.exe` 是 GUI/交互式程序。
它会弹窗等输入、零 stdout、进程永不退出；命令阻塞期间模型不在运行，物理上无法自愈。
改用：改用 CLI 版 diec（先 --version 确认参数）
工具真实路径怎么查：先跑 `(Get-Command <工具id> -ErrorAction SilentlyContinue).Source`，
无值再按 TOOL-CHAIN.md 的四级递进（env → PATH → _map.json 别名 → 递归兜底）。
```

**只拦「命令位置」上的二进制**，不拦字符串和路径参数：

| 命令 | 结果 |
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

### 4. 把坑回灌给模型（让它自己改）

命中下面这些模式时，在工具结果里追加一段提示，模型看得到就会改：

- 单条命令串了 >8 段（任一段等交互或打错路径，整条就死）
- 同一条命令里混用 POSIX 路径与 Windows 路径（Git-Bash 下 `/tmp` 实为 `C:\tmp`）
- PowerShell 的 `start` 不带 `/b`
- `vmrun snapshot/suspend`

### 5. 卡死可见

- **底栏状态**：`● bash 1m12s · 静默 8s · <命令>`；静默超阈值变 `◐`，总时长超阈值变 `✖`
- `/stall`：正在跑什么、卡多久、注入了什么、被拦过什么、最近 8 条执行记录，外加一份「卡在 xx → 怎么办」的处置处方

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
| `enforce` | `true` | `false` = 只记账不阻断。怀疑守卫判得不准时先关掉观察 |
| `blockGui` | `true` | `false` = **不拦 GUI**，只注入 timeout。客户机 / VM 上用这个 |
| `hardenSsh` | `true` | `false` = 不改写 ssh/scp |
| `guiBinaries` | `{}` | 手工项。值 = 替代提示语；写 `null` = **明确不拦这一条** |
| `toolChainPaths` | `[]` | 额外再从哪些 Markdown 派生 |
| `skillRoot` | `null` | 留空 = 自动探测 |
| `allow` | `["cmd-guard-skip"]` | 命令含其中任一子串则整条跳过守卫 |

**VM / 客户机版**：把同目录的 `cmd-guard.rules.vm.json` 复制成 `cmd-guard.rules.json` 即可。
唯一实质差别是 `blockGui: false`（那边 GUI 工具是正当手段），timeout 档位按 VM 的慢速调高。

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

用假 pi API 驱动插件，走一遍所有判定分支（26 条断言）。它用 **pi 自己的加载器 jiti**
跑插件 —— 与 pi 真正加载扩展的路径一致，所以 `__dirname`、模块解析全都是真的。

换机时指定 pi 家目录：

```powershell
$env:PI_HOME = 'D:\somewhere\.pi\agent'
node smoke-cmd-guard.mjs
```

覆盖的关键行为（每一条都对应一个曾经出过问题的判定）：

- `Test-Path <gui.exe>` / `echo "<gui.exe>"` **不能**被误拦（位置识别）
- 链式命令后半段的 GUI **要**被拦
- `idat.exe` 这类 headless 工具**明确不拦**
- 提示语带「（来源 TOOL-CHAIN.md）」= 文档驱动真的生效了
- 递归扫描抬 timeout、模型自带 timeout 不被覆盖也不被压低
- `echo "ssh is old"` 不被改写；已有 `ConnectTimeout` 不重复注入

---

## 🔌 安装

```powershell
pi install git:github.com/gthubtom1/agent-plugins@main
```

或手动：把 `cmd-guard.ts`、`cmd-guard.rules.json` 复制到 `~/.pi/agent/extensions/`。

装完用 `/guard` 确认一下规则来源。**如果显示「★未找到 TOOL-CHAIN.md」，
说明这台机器上技能包不在已知位置** —— 设 `RELAB_SKILL_ROOT` 指向技能包根，或在
rules.json 里写 `toolChainPaths`。不处理也能用（内置兜底表还在），只是少了文档派生。

对账：`scripts/check-sync.ps1` 会比对本机扩展与 `manifest/extensions.sha256.json` 基线。

---

## 📄 许可

MIT。见 `LICENSE`。