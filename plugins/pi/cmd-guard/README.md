# cmd-guard（Pi Coding Agent 命令执行守卫扩展）

专为 **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** 打造的命令执行守卫：
**自动给命令补超时、物理拦截 GUI 二进制、实时显示卡死状态**。

解决的是 AI 智能体最容易死的一类问题 —— **命令不返回，模型就永远停在那里**。

---

## 📖 为什么需要这个插件？

Pi 的 `bash` 工具的 `timeout` 参数是**可选**的，不传就无限等：

```javascript
// dist/core/tools/bash.js
timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }))
```

而命令执行是**同步阻塞**的：命令不返回 → 模型不运行 → 没有任何 token 产出 → 终端计时器一直涨。

**关键点：模型不可能自己发现命令卡住。** 它在等待期间不在运行、没有任何代码在跑。

### 实测的四种卡死场景

| 场景 | 症状 | 根因 |
|---|---|---|
| **GUI 二进制经管道启动** | 弹窗等输入、零 stdout、进程永不退出 | 如 `die.exe`（DIE GUI 版），应改用 `diec.exe` |
| **VMware 快照类操作** | `vmrun snapshot` 对运行中客户机写快照，锁争用时无限期挂起 | VIX 同步调用，应在后台跑并轮询产物 |
| **交互式命令无 stdin** | `ssh` 等 `Are you sure / password` 提示 | 缺 `</dev/null` |
| **递归扫描大目录** | `find "D:/" ...` 之类，无输出但一直在跑 | 无界耗时 |

实测代价：一次会话里连续三次无响应停顿，每次 3 分钟以上。

---

## ⚡ 它做什么

### 1. 自动补 timeout

| 命令类型 | 补的值 |
|---|---|
| 探查类（`where` / `Test-Path` / `-v`） | 30s |
| 普通命令 | 120s |
| 重活（`vmrun` / 构建 / 批量传输） | 600s |
| 递归大目录扫描 | ≥180s |

**模型自带的 timeout 优先，不被覆盖。**

### 2. 物理拦截 GUI 二进制

命中即**拒绝执行**并返回替代方案：

```
[cmd-guard] 已拦下：`die.exe` 是 GUI/交互式二进制。
它会弹窗等输入、零 stdout、进程永不退出 —— 一旦同步等它，
模型全程不运行且无法自愈（终端计时器会一直涨而 token 停止）。
改用：diec.exe（CLI 孪生）
```

**GUI 名单有两种来源**，优先级（后者覆盖前者）：

```
内置基线 → 技能包索引派生（tool-index 里「运行模式=GUI」的行）→ rules.json 手工条目
```

> 规则从索引**派生**，所以技能包新增工具时，守卫自动跟上，不用改代码。

### 3. ssh / scp 有界化

自动注入 `-o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3`
与 `</dev/null`（断交互）。

**只在真命令位置注入** —— 见下方「踩过的坑」。

### 4. 卡死状态栏 + 诊断命令

底部实时显示：

```
⛨ ●bash 93s · 静默 60s · 已注入 1 条 · 规则源=索引派生(11条)
     ↑ 标记      ↑ 已跑  ↑ 无输出   ↑ 改了啥        ↑ 规则从哪来
```

标记含义：

| 标记 | 含义 | 该做什么 |
|---|---|---|
| `●` | 正常在跑 | 等着 |
| `◐` | 无输出超过阈值（默认 90s） | 留意 |
| `✖` | 超过卡死阈值（默认 240s） | **中断** |

**两条斜杠命令**：

| 命令 | 作用 |
|---|---|
| `/guard` | 看当前规则、拦截记录、被注入的命令清单 |
| `/guard reload` | 热重载规则（改完 rules.json 想立即生效） |
| `/stall` | 打印当前在跑的命令、已耗时、静默时长、abort 历史、按工具类型给处置处方 |

---

## 🚀 安装

### 方式 A：手动放文件（推荐）

```bash
# 1. 把两个文件放进 pi 的扩展目录
cp cmd-guard.ts        ~/.pi/agent/extensions/
cp cmd-guard.rules.json ~/.pi/agent/extensions/cmd-guard.rules.json

# 2. 重启 pi（扩展在启动时加载）
```

### 方式 B：改完规则热重载

```
/guard reload
```

---

## ⚙️ 配置：两套规则文件

扩展会读**同目录下的** `cmd-guard.rules.json`。仓库提供两套：

| 文件 | 用在哪 | 关键区别 |
|---|---|---|
| `cmd-guard.rules.json` | **宿主机** | `blockGui: true` —— 宿主上 GUI 经 bash 会挂死模型，必须拦 |
| `cmd-guard.rules.vm.json` | **虚拟机内** | `blockGui: false` —— 客户机里 GUI 是正常手段（PE-bear / ImHex / x64dbg GUI），只注入 timeout 兜底 |

> **为什么两套**：同一个扩展，在宿主和客户机里的正确行为是**相反**的。
> 宿主拦 GUI（防挂死），客户机放行 GUI（那些工具只有 GUI 版）。

配置项：

```jsonc
{
  "defaultTimeout": 120,      // 默认超时
  "probeTimeout": 30,         // 探查类
  "heavyTimeout": 600,        // 重活类
  "stallSeconds": 240,        // 卡死阈值（状态栏 ✖）
  "noOutputStallSeconds": 90, // 无输出告警阈值（状态栏 ◐）
  "enforce": true,            // false = 只提示不改写
  "blockGui": true,           // ★ 宿主 true / 客户机 false
  "guiBinaries": [],          // 手工补充 GUI 名单
  "allow": ["cmd-guard-skip"],// 含此串的命令整条跳过守卫（救急用）
  "indexPaths": [".../skills/tool-index.md"]  // 技能包索引（GUI 规则来源）
}
```

---

## 🐛 踩过的坑（改代码前先读）

### 1. ssh 误判：命令里出现 `ssh` 三个字母就注入

**症状**：`echo "ssh is old" > f.txt` 被改写成 `echo "ssh -o ConnectTimeout=15 ... is old" > f.txt`。

**原因**：早期实现对**整个命令字符串**做 `/\bssh\b/i` 匹配。

**后果**：审计子代理写报告时，凡是内容里带 `ssh` 字样的输出，都被注入命令参数，污染整份报告。

**修法**：只在**真命令位置**注入 —— 字符串开头，或 `&&` `||` `;` `|` `(` 换行之后：

```javascript
const SEG = /(^|[\n;|&(]\s*)((?:[\w.]+=\S+\s+)*)((?:ssh|scp|sftp|rsync))\b/gi;
```

### 2. PowerShell 数组字面量里逗号优先级高于加号

```powershell
@('a', '-v' + $x)      # ← 被解析成两个元素：'-v' 和 $x
@('a', ('-v' + $x))    # ← 正确
```

**症状**：7z 收到裸的 `-v`（缺参数）→ 立即退出 → 打包静默失败，日志停在命令那一行没有报错。

### 3. 自检绕过了被测对象 → 假 PASS

`adapt.ps1` 的 PATH 写入曾有一个 bug：判重对象写成含 `$add` 的变量 → 恒为空 → PATH 永远不写。

**但它的自检全绿** —— 因为自检在**自己进程里用全路径**跑，完全绕过了 PATH。

**纪律**：验证「PATH 写没写」必须**开一个新子进程**验证（`cmd /c "where <命令>"`），
不能在同一个会话里用 `$env:Path` 自证。

### 4. 反虚拟化不要调过头（这条踩在 VMware Tools 上）

在 `.vmx` 里加反检测设置时，这两条**会切断 VMware Tools 自己的通信通道**：

```
monitor_control.restrict_backdoor = "TRUE"    ← Tools 就是用这个后门通信的
monitor_control.disable_directexec = "TRUE"
```

**症状**：客户机弹窗 `VMware Tools unrecoverable error: (host-6240) Exception 0xc0000096`
（`0xc0000096` = STATUS_PRIVILEGED_INSTRUCTION），随后 vmrun 客户机操作全部失效。

**安全的反检测项**（不破坏 Tools）：

```
hypervisor.cpuid.v0 = "FALSE"      ← 隐藏 CPUID 的 hypervisor 位（最要紧）
SMBIOS.reflectHost = "TRUE"        ← SMBIOS 不再报 VMware
ethernet0.addressType = "static"
ethernet0.address = "<非 VMware OUI>"  ← 避免 00:0C:29 / 00:50:56 / 00:05:69
```

**取舍**：`restrict_backdoor` 的隐藏效果更好，但会让 Tools 崩 → 依赖 vmrun 自动化的场景不能用。
若确实需要更强的隐藏，另起一台不装 Tools 的机器专门跑样本。

---

## 📁 文件说明

| 文件 | 作用 |
|---|---|
| `cmd-guard.ts` | 扩展本体（Pi 启动时加载） |
| `cmd-guard.rules.json` | 宿主机规则（`blockGui: true`） |
| `cmd-guard.rules.vm.json` | 虚拟机上用的规则（`blockGui: false`），改名为 `cmd-guard.rules.json` 后使用 |

---

## 🔗 相关

- 配套：`/stall` 命令（本扩展内置）与 `retry` 系列（见 `pi-infinite-retry`）
- 反检测脚本与 VM 环境构建见另一个仓库（环境构建类，非插件）

---

## 📜 许可

MIT
