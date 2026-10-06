# ENV-MANIFEST · 本机 Pi Agent 环境总清单（换机照此安装）

> 盘点时间：2026-10-07 · 盘点机：Toti-Windows（`C:\Users\Toti`）
> 本文件是 `agent-plugins` 仓库的**整机环境清单**：插件、地址、版本、落盘位置、脱敏配置模板、恢复脚本。
> 仓库里只有源码与清单，**不含任何密钥**；密钥一律占位符，换机后填。

一键恢复：`scripts/restore-machine.ps1`（Windows）或 `scripts/restore-machine.sh`（Git Bash / WSL）。

---

## 0. 一分钟总览

| 层 | 数量 | 来源 | 是否已在本仓库 |
|---|---|---|---|
| pi 本体 | 1 | npm `@earendil-works/pi-coding-agent@1.0.0` | 否（记录安装命令） |
| pi 第三方 npm 包 | 9 | npm 公网 | 否（仅登记地址+版本） |
| pi 自制扩展 | 2（+1 遗留 +1 冒烟测试） | 本仓库源码 | ✅ `plugins/pi/*` |
| Orca 托管扩展 | 3 | Orca 桌面端注入 | 否（记录来源与哈希） |
| MCP server | 10（pi 侧）+ 4（Orca 侧） | npx / 本地 exe / HTTP | 否（登记地址+脱敏模板） |
| 技能 skill | 3 | Orca 内置技能集 | ✅ 备份在 `manifest/skills/` |
| 纪律卡 hubcore | 1 | 私有库 `gthubtom1/hubcore` | 否（登记地址+安装命令） |

---

## 1. pi 本体

| 项 | 值 |
|---|---|
| 包 | `@earendil-works/pi-coding-agent` |
| 版本 | `1.0.0`（managed install，`layout=releases-v1`） |
| 入口 | `C:\Users\Toti\.pi\agent\bin\pi.cmd` |
| 运行时 | Node `v24.19.0`（要求 `>=22.19.0`）、npm `11.17.0`、Python `3.12.0` |
| 自动更新 | 开，周期 1 小时（`~/.pi/agent/auto-update.json`） |

```bash
npm i -g @earendil-works/pi-coding-agent@1.0.0    # 或 pi 自身的 managed installer
```

---

## 2. 第三方 pi 插件（npm 公网，本仓库不存源码）

本机 `settings.json` 已配置这 9 个包，换机用 `pi install npm:<包名>` 逐个装。

| # | 包名 | 本机版本 | 作用 | 上游地址 | 安装命令 |
|---|---|---|---|---|---|
| 1 | `pi-plan-task` | 5.0.7 | 计划/任务（Plan-Task） | npm（无 repository 字段） | `pi install npm:pi-plan-task@5.0.7` |
| 2 | `@demigodmode/pi-web-agent` | 1.14.0 | Web Agent 能力 | https://github.com/demigodmode/pi-web-agent | `pi install npm:@demigodmode/pi-web-agent@1.14.0` |
| 3 | `@aaronkyriesenbach/pi-package-manager` | 0.5.0 | 包管理器 UI | https://github.com/aaronkyriesenbach/pi-packages | `pi install npm:@aaronkyriesenbach/pi-package-manager@0.5.0` |
| 4 | `pi-open-tui` | 0.3.11 | TUI 增强（本机 TUI 模式由它接管） | https://github.com/OldSuns/pi-open-tui | `pi install npm:pi-open-tui@0.3.11` |
| 5 | `pi-web-access` | 0.35.0 | 联网访问 | https://github.com/nicobailon/pi-web-access | `pi install npm:pi-web-access@0.35.0` |
| 6 | `pi-mcp-adapter` | 5.0.0 | MCP 适配层 | https://github.com/nicobailon/pi-mcp-adapter | `pi install npm:pi-mcp-adapter@5.0.0` |
| 7 | `pi-tool-display` | 0.5.0 | 工具调用展示 | https://github.com/MasuRii/pi-tool-display | `pi install npm:pi-tool-display@0.5.0` |
| 8 | `pi-win-notify` | 1.0.15 | Windows 桌面通知 | https://github.com/ryanchan720/pi-desktop-notify | `pi install npm:pi-win-notify@1.0.15` |
| 9 | `@gotgenes/pi-subagents` | 22.0.0 | 子代理（本会话的 subagent 工具来源） | https://github.com/gotgenes/pi-packages | `pi install npm:@gotgenes/pi-subagents@22.0.0` |

一次性全装：

```bash
for p in pi-plan-task@5.0.7 @demigodmode/pi-web-agent@1.14.0 @aaronkyriesenbach/pi-package-manager@0.5.0 \
         pi-open-tui@0.3.11 pi-web-access@0.35.0 pi-mcp-adapter@5.0.0 pi-tool-display@0.5.0 \
         pi-win-notify@1.0.15 @gotgenes/pi-subagents@22.0.0; do pi install "npm:$p"; done
```

npm 依赖树落在 `~/.pi/agent/npm/`（`package.json` + `package-lock.json` 已在仓内可复现）。

---

## 3. 自制 pi 扩展（源码在本仓库）

| 插件 | 作用 | 交互 | 本机落盘 | 状态 |
|---|---|---|---|---|
| `cmd-guard` | 自动补 bash timeout / 物理拦截 GUI 二进制 / 卡死状态栏 | 状态栏 + `/guard` `/stall` | `~/.pi/agent/extensions/cmd-guard.ts`、`cmd-guard.rules.json` | 🟢 生产（哈希与仓库一致） |
| `retry-level` | 重试档位 off/3/5/15/30/无限，状态栏常显 | `/retry [cycle|status|N]` | `~/.pi/agent/extensions/retry-level.ts` | 🟢 生产（哈希与仓库一致） |
| `pi-infinite-retry` | 早期简版无限重试，与 `retry-level` 都注册 `/retry` | `/retry on\|off` | 未安装 | 🟡 保留参考，**不要同时启用** |
| `smoke-cmd-guard.mjs` | cmd-guard 冒烟自测脚本（非扩展） | `node smoke-cmd-guard.mjs` | `~/.pi/agent/extensions/` | 🟡 测试件 |

安装（一条命令装完自制插件）：

```bash
pi install git:github.com/gthubtom1/agent-plugins@main
```

仓库内另有 `plugins/pi/cmd-guard/cmd-guard.rules.vm.json`（VM 专用规则）——**本机未装**，只在 VM 内调试时手工拷。

哈希基线（`manifest/extensions.sha256.json`，用于换机后对账）：

```
279896b34e455cfa447f6bd64ff8cbaafdfc8d105151a197e7b230f52e3209f0  cmd-guard.ts
21f95eae296961bf6444f911395d77695dec5b928237a43a64b561e5291489a0  cmd-guard.rules.json
e88dafbda5fe77b668e27215a99b7ee2b90d81f23f2382e86320cd5d5c445688  retry-level.ts
95d3e6f0c69d97f959946832b6268c85a8465a8bb78fb474687a8d420f863f02  smoke-cmd-guard.mjs
```

---

## 4. Orca 托管扩展（非本仓库资产）

| 文件 | 来源 | 说明 |
|---|---|---|
| `orca-agent-status.ts` | Orca 桌面端（`@orca-managed-pi-extension` 头） | worktree 状态上报 |
| `orca-prefill.ts` | 同上 | 启动预填 |
| `orca-titlebar-spinner.ts` | 同上 | 标题栏 spinner |

它们由 Orca 注入 `~/.pi/agent/extensions/`，**换机装 Orca 后自动回来**，不要手工往仓库里搬；本机哈希已记入 `manifest/extensions.sha256.json` 仅供对账。
（Orca 本体路径已不在 `AppData/Local/Programs/orca`，当前只剩 `AppData/Roaming/orca/codex-runtime-home`。）

---

## 5. MCP server 清单（10 个，pi 侧）

配置文件：`~/.pi/agent/mcp.json`；脱敏模板：`manifest/mcp.json`（占位符 `${TOOL_ROOT}` = 逆向工具根、`${PY_ROOT}` = Python 根、`${X64DBG_MCP_TOKEN}`）。

| id | 传输 | 地址 / 命令 | 换机注意 |
|---|---|---|---|
| `jshook` | npx stdio | `npx -y @jshookmcp/jshook@0.3.4`（`JSHOOK_BASE_PROFILE=search`） | 纯 npm，无需配置 |
| `reqable-mcp` | npx stdio | `npx -y reqable-mcp-server@1.0.1 --scope minimal` | 需本机装 Reqable 并开抓包 |
| `playwright-mcp` | npx stdio | `npx -y @playwright/mcp@latest` | 首次用需 `npx playwright install` |
| `chrome-devtools` | npx stdio | `npx -y chrome-devtools-mcp@latest` | 需本机 Chrome |
| `xquik` | HTTP | `https://xquik.com/mcp` | 远端服务，直连 |
| `idalib-mcp` | 本地 exe stdio | `${PY_ROOT}\python\Scripts\idalib-mcp.exe --stdio`，`IDADIR=${TOOL_ROOT}\IDA Professional 9.4` | 需 IDA Pro 9.4 + Python 包 `idalib-mcp`（本机 `PY_ROOT=D:\EXE`、`TOOL_ROOT=D:\HACKER`） |
| `idapro` | HTTP | `http://127.0.0.1:13337/mcp` | 需 IDA GUI 打开并加载 ida-pro-mcp 插件 |
| `x64dbg` | HTTP | `http://127.0.0.1:9094/` + `Bearer ${X64DBG_MCP_TOKEN}` | 需先启动 x64dbg；token 在 `release\x64\mcp_config.json` |
| `x64dbg32` | HTTP | `http://127.0.0.1:9095/` + `Bearer ${X64DBG_MCP_TOKEN}` | x32 调试器（VM 逆向工作机-01） |
| （内置）`mcp` | — | 本机 `settings.json` 里 `extensions: ["-builtin:mcp"]` 禁用了 pi 内置 MCP | — |

> ⚠️ 两个 `Authorization: Bearer …` 是**本机令牌**，仓库模板里只留占位符。仓库里出现的真实令牌已清零，泄露风险面为零。

### 5.1 Orca 侧 MCP server（4 个）

配置文件：`~/.agents/servers/*.json`；汇总模板：`manifest/agent-servers.json`。

| id | 命令 | 作用 |
|---|---|---|
| `context7` | `npx -y @upstash/context7-mcp` | 查最新框架文档 |
| `everything` | `npx -y @modelcontextprotocol/server-everything` | MCP 能力自检 |
| `playwright` | `npx -y @playwright/mcp@latest` | 浏览器无障碍树驱动 |
| `sequential-thinking` | `npx -y @modelcontextprotocol/server-sequential-thinking` | 分步反思推理 |

---

## 6. 技能 skill（3 个）

落盘：`~/.agents/skills/`；备份在本仓库 `manifest/skills/`。

| skill | 来源 | 说明 |
|---|---|---|
| `computer-use` | Orca 内置技能集（原始副本一度在 `AppData/Local/Temp/skills-3avm3i/`） | 驱动可见窗口 GUI |
| `orca-cli` | 同上 | Orca worktree/终端/artifact/浏览器操作 |
| `orchestration` | 同上 | 受管 worker 编排、任务 DAG、决策门 |

无公开仓库地址（Orca 随桌面端分发），换机恢复用仓内备份覆盖 `~/.agents/skills/<name>/SKILL.md`。

---

## 7. 配置文件落盘表（脱敏模板全部在 `manifest/`）

| 文件 | 位置 | 模板 | 说明 |
|---|---|---|---|
| `settings.json` | `~/.pi/agent/settings.json` | `manifest/pi-settings.json` | packages 列表、retry 策略、禁内置 mcp、TUI 全屏、信任策略、思考等级 |
| `mcp.json` | `~/.pi/agent/mcp.json` | `manifest/mcp.json` | 10 个 MCP，token 占位 |
| `models.json` | `~/.pi/agent/models.json` | `manifest/models.json` | newapi provider + 全部模型 id/上下文/思考档，key 占位 |
| `auth.json` | `~/.pi/agent/auth.json` | ❌ 不入库 | 真实 API key，换机手填或 `pi` 重新登录 |
| `open-tui.json` | `~/.pi/agent/open-tui.json` | `manifest/open-tui.json` | footer 段、图标 ascii、遥测全关 |
| `web-search.json` | `~/.pi/agent/web-search.json` | `manifest/web-search.json` | workflow=none |
| `keybindings.json` | `~/.pi/agent/keybindings.json` | `manifest/keybindings.json` | `alt+enter` 续发 |
| `trust.json` | `~/.pi/agent/trust.json` | `manifest/trust.json` | 项目免信任白名单（换机改路径） |

模型 provider：`newapi` → `https://newapi.totii.ccwu.cc/v1`（api=`openai-responses`），模型含 `claude-sonnet-4-6`、`deepseek-flash`、`deepseek-v4-pro`、`gemini-3.8-flash` 等，详见 `manifest/models.json`。

---

## 8. 纪律卡 hubcore（私有库）

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/gthubtom1/hubcore`（private，默认分支 `master`） |
| 本机安装记录 | `~/.pi/agent/hub/install-manifest.json`（91 文件 / 1,073,166 B，安装于 2026-10-05） |
| 注入方式 | 三段标记注入 `~/.pi/agent/AGENTS.md`：`hubcore base` / `hubcore guest` / `hubcore hub` |
| 卸载 | `python ~/.pi/agent/hub/uninstall.py --host-home ~/.pi/agent` |

`AGENTS.md` 本体（约 48 KB）是本机状态（含指纹与改动），**不入公开仓库**；换机重装 hubcore 会重建标记块，需要的话从本机单独备份。

---

## 9. 换机恢复流程

```powershell
git clone https://github.com/gthubtom1/agent-plugins.git C:\Tools\agent-plugins
cd C:\Tools\agent-plugins
powershell -ExecutionPolicy Bypass -File scripts\restore-machine.ps1 `
    -ToolRoot 'D:\HACKER' `
    -NewApiKey 'sk-…' `
    -X64dbgToken '…'
```

脚本做四件事（幂等，可重复跑）：

1. 装 pi 本体 + 9 个 npm 包 + `git:github.com/gthubtom1/agent-plugins@main`（自制扩展走 package 安装，不再手工拷 `.ts`）。
2. 覆盖 `settings.json` / `mcp.json` / `models.json` / `open-tui.json` / `web-search.json` / `keybindings.json`（模板占位符用参数替换；已存在文件先备份为 `*.bak-<时间戳>`）。
3. 恢复 `~/.agents/skills/`（仓内备份）与 `~/.agents/servers/`（若缺失）。
4. 打印 `pi list` 与哈希对账结果。

手工核对：`scripts/check-sync.ps1`（比对 `~/.pi/agent/extensions/*.ts` 与 `manifest/extensions.sha256.json`）。

---

## 10. 为什么之前"没同步到仓库"（复盘）

| 现象 | 根因 |
|---|---|
| 自制扩展改完没进仓库 | 本机是**手工拷 `.ts`** 到 `~/.pi/agent/extensions/`，没走 `pi install git:`，仓库侧无感知 |
| MCP / skills / models 全在仓库外 | 它们落在 `~/.pi/agent/`、`~/.agents/`，从未纳入版本管理；`~/.pi/agent` **本身不是 git 仓库**（无 `.git`） |
| 配置里有 token 和 API key | 直接 push 会把密钥送进 **public** 仓库，因此之前采取了"只登记名字不落文件"的做法 → 现在改用**占位符模板 + `.gitignore` 兜底** |
| 清单靠 README 手写漂移 | README 只有自制插件表，第三方包没有版本列；本次改为 `manifest/` 机读清单 + 本文件 |

修复后的事实：仓库 = 源码 + 清单 + 脱敏模板 + 恢复脚本；本机 = `pi install git:` 拉取；三方包版本可复现。