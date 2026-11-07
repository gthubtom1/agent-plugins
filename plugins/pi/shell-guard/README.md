# pi-shell-guard

Pi 的 shell 安全护栏：限时、限范围、按档保护删除。纯策略库可离线测试，运行时只做事件接线。

## 为什么需要它

一次真实事故：模型猜错路径后写了

```bash
find / -maxdepth 6 -name "*skinforge*" -newermt "2026-11-06" -type f | head -30
```

在 Windows 上 Git Bash 的 `/` 是整台机器（`/c`、`/d`、`/e`），于是它扫了所有盘，跑了十几分钟，看起来像卡死。`find` 不读 `.gitignore`，`| head` 也不会让它提前停止。

Pi 上游的 `bash` 工具 `timeout` 参数是可选的，不传就没有上限（上游 issue #2987 / #8857 / #9798 记录了同类问题）。社区做法是在扩展里注入默认超时；本项目在此之上增加了范围与删除保护。

## 工作方式

三层，互补而非互斥：

| 层 | 机制 | 作用 |
|---|---|---|
| 硬拦截 | `tool_call` 事件 | 命令执行前判定，可拒绝，或注入 `timeout` |
| 软引导 | `before_agent_start` | 每轮注入一小段策略，让模型第一次就写对 |
| 替代工具 | `registerTool`（P2） | `search_files` 走 Everything，毫秒级全盘按文件名查找 |

嵌套调用同样经过 `tool_call`，所以从 codemode 里调 bash 也拦得住。

## 规则

**超时分档**（显式传入则保留，但夹到上限 1800s）

| 档 | 例子 | 默认 |
|---|---|---|
| fast | `ls` `rg` `git status` `sha256sum` | 60s |
| default | 未识别命令 | 120s |
| heavy | `jadx` `ghidra` `rizin -A` `git clone` `npm i` `binwalk -e` | 900s |

**整盘搜索**：`find` / `grep -r` / `rg` / `du` / `tree` / `dir /s` / `Get-ChildItem -Recurse` / `where /R`，只要搜索根是盘符根、`$HOME` 或共享根就拒绝，并在理由里给出替代写法。

**删除分档**（`rm` `del` `Remove-Item` `git clean` `find -delete` `xargs rm` 及内联 `shutil.rmtree` / `fs.rmSync`）

| 档 | 场景 | 行为 |
|---|---|---|
| T0 | 项目内单文件 | 放行 |
| T1 | 项目内生成目录（`node_modules` `dist` `build`）、临时目录 | 放行并说明 |
| T2 | 通配、项目外递归、项目根、`.git`、未跟踪文件清理 | 需用户确认 |
| T3 | 盘符根、主目录、系统目录、无目标删除 | 拒绝 |

注意：Git Bash 的 `rm` 不进 Windows 回收站，所以这是真删除。

### 你让它删，它就能删

T2 不是一律拦截。只有当**你自己的那条消息**里同时满足下面两点时，才直接放行：

1. 含有删除意图词（删除 / 删掉 / 清理 / 移除 / remove / delete …）
2. 写明了路径，且该路径包含要删的目标

例如你说「删除 D:/Project/other」，那么 `rm -rf ../other` 直接执行，不再弹确认；而同一轮里如果命令还夹带了别的目录，那个目录依然需要确认。

不可绕过的部分：

- 授权只来自**用户消息文本**。模型无法往用户消息里加字，所以无法自己造授权。
- T3（盘符根、主目录、系统目录）永不授权，即使你写了「删除 D:/」。
- 通配符（`*`）、`find -delete`、`xargs rm`、内联 `shutil.rmtree` 等范围不确定的形式，始终需要确认。
- 路径先做 `realpath`，符号链接/junction 指向系统目录时按真实路径判定。
- 授权只对当前这一轮有效，下一轮消息不继承。

**永不返回**：裸 REPL、无参 `cat`/`sort`、`tail -f`、编辑器/分页器、`adb logcat`/`wait-for-device`、前台 `frida`、`http.server`、`npm run dev`、`ssh`/`sudo` 等。

**后台未重定向**：`cmd &` 且没有 `>log 2>&1 </dev/null` 时拒绝，因为执行器会一直等管道关闭。

## Everything 集成

`search_files` 只做**文件名/路径**查找，内容搜索仍用 `rg`（Everything 不索引文件内容）。

```json
{ "shellGuard": { "everything": { "enabled": true, "esPath": "D:/Tools/es/es.exe", "maxResults": 50 } } }
```

`es.exe` 必须配置绝对路径且 Everything 正在运行；缺失时工具降级并明确报错，不会把"没找到"当成事实。

## 配置

```json
{
  "shellGuard": {
    "enabled": true,
    "blockWholeDisk": true,
    "interactive": true,
    "requireBackgroundRedirect": true,
    "timeout": { "fast": 60, "default": 120, "heavy": 900, "ceiling": 1800 },
    "rm": { "policy": "tiered" },
    "protectedPaths": [],
    "allow": []
  }
}
```

## 边界

- **fail-open**：插件内部异常一律放行，绝不因为护栏 bug 卡住 shell。
- 只读命令字符串做判定，不改写命令内容，只改 `timeout` 一个字段。
- shell 是图灵完备的，字符串解析不可能完备；本插件覆盖常见直接写法，不宣称"绝对删不掉"。
- T2 的 UI 确认在 P2 接入 `ui.select`；当前版本把 T2 转成"需要用户确认"的拒绝理由。
- 未做：`write`/`edit` 的路径级保护（P3）。

## 状态

P1 完成：策略库 + 20 项离线语料测试。P2 完成：真实 Pi SDK 验证 15 项全过（拦截、放行、超时注入、授权放行、授权不放宽、`search_files` 实查）。P3 才装进 agent 目录试用。**当前尚未发布、尚未安装。**

```bash
# 离线策略测试
node --test test/*.test.mjs

# 真实 SDK 验证（不联网，进程内假 provider）
PI_SDK_DIR=<.../@earendil-works/pi-coding-agent> PI_SHELL_GUARD_ES=<.../es.exe> node scripts/verify-sdk.mjs
```
