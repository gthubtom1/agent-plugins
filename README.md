# Agent Plugins Hub

这个仓库保存我自己维护的智能体插件源码。Pi 插件按独立目录管理，每个插件都可以单独安装，也可以通过根目录的 `package.json` 一次加载全部入口。

## Pi 插件

| 插件 | 安装短名 | 功能 | 入口 |
|---|---|---|---|
| [`persona`](plugins/pi/persona/README.md) | `pi-persona` | 按当前对话选择 Markdown 人设 | `/persona` |
| [`persona-old`](plugins/pi/persona-old/README.md) | `pi-persona-old` | 人设插件的历史完整版，与 `persona` 二选一 | `/persona` |
| [`rewind`](plugins/pi/rewind/README.md) | `pi-rewind` | 回退到消息之前，或撤销最后一条纯文本回复 | `/rewind`、`/undo-reply` |
| [`remote`](plugins/pi/remote/README.md) | `pi-remote` | 查看局域网和 Tailscale 连接信息，管理 pi-web 远程配置 | `/remote` |
| [`cmd-guard`](plugins/pi/cmd-guard/README.md) | `pi-cmd-guard` | 命令超时兜底、GUI 拦截、命令运行健康报告 | `/guard`、`/stall` |
| [`retry-level`](plugins/pi/retry-level/README.md) | `pi-retry-level` | 调整模型请求重试档位 | `/retry` |
| [`lab`](plugins/pi/lab/README.md) | `pi-lab` | 保存常用语，添加 `lab:` 前缀填入输入框 | `/lab`、`/LAB` |

「安装短名」就是 `settings.json` 里 `packages` 会出现的字符串，也是 Pi Web 插件页显示的名称。

三个原先放在 `pi-seep-ext` 中的扩展现在已经拆成三个包。它们共享思路，但安装和加载互相独立。

已移除的旧实验插件 `shell-guard`、`seep-workbench` 和 `pi-advisor` 不再属于本仓库。

## 安装

### 推荐：用安装脚本（安装后显示短名）

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\scripts\install-pi-plugins.ps1
```

```bash
# Linux / macOS
./scripts/install-pi-plugins.sh
```

脚本会在 agent 目录下为每个插件建立同名链接（Windows 用 Junction，其他平台用符号链接），
再按这个名字安装，所以 `settings.json` 里记录的是干净的短名：

```json
{
  "packages": [
    "pi-cmd-guard",
    "pi-retry-level",
    "pi-remote",
    "pi-lab"
  ]
}
```

Pi Web 的插件页和 `pi list` 直接显示这个字符串，短名比长路径好认得多。
插件升级只需在仓库里 `git pull`，链接不用重建。

安装脚本在 `pi-remote` 安装成功后，会自动持久化 `PI_WEB_HOSTNAME=0.0.0.0`。重启 pi-web 后，照常运行 `pi-web` 即可监听所有 IPv4 网卡。Windows 安装还会让 PowerShell/CMD 的 pi-web 启动入口每次重新读取已保存的设置，因此在原终端停止并再次启动也能生效。局域网使用电脑 IP，异地使用已连通的 Tailscale；公网域名访问仍需已有的 HTTPS 入口和路由。脚本不修改密码、防火墙或路由。详见 [remote 安装说明](plugins/pi/remote/README.md#安装时默认配好手机访问)。

常用参数：

```powershell
# 只查看每个插件的安装状态，不做修改
.\scripts\install-pi-plugins.ps1 -List

# 只装其中几个
.\scripts\install-pi-plugins.ps1 -Plugins pi-cmd-guard,pi-lab

# 装到别的 agent 目录（DSH 或自定义 profile）
.\scripts\install-pi-plugins.ps1 -AgentDir 'D:\other\agent'
```

默认安装 `pi-cmd-guard`、`pi-retry-level`、`pi-remote`、`pi-lab`、`pi-rewind`。
`pi-persona` 和 `pi-persona-old` 都注册 `/persona`，脚本不会默认装任何一个，需要时显式指定，且两者只能选一个。

### 为什么不要直接 `pi install ./plugins/pi/xxx`

`pi install` 会把来源路径写进 `settings.json` 的 `packages` 数组，而界面显示的就是这个字符串。
直接按相对路径安装时，写进去的是相对路径；换一个目录再装一次，就可能变成
`plugin-src\agent-plugins\plugins\pi\cmd-guard` 这样的长串。同一台机器上装两次，还会出现
同一个插件被登记两次、被加载两次的问题。

想手动装单个插件，请先建链接再按名字装，效果和脚本一致：

```powershell
# Windows：在 agent 目录下建 Junction，再按名字安装
$agent = "$HOME\.pi\agent"
New-Item -ItemType Junction -Path "$agent\pi-lab" -Target "<仓库路径>\plugins\pi\lab"
pi install "$agent\pi-lab"
```

```bash
# Linux / macOS
agent="$HOME/.pi/agent"
ln -s "<仓库路径>/plugins/pi/lab" "$agent/pi-lab"
pi install "$agent/pi-lab"
```

如果已经有长路径条目，运行一次安装脚本会自动清理并改成短名。

安装后重新打开 Pi 会话，或在已有会话执行 `/reload`。每个插件目录的 README 记录了插件用途、命令和单独安装方法。

Pi Web 底栏中，`retry-level` 和 `cmd-guard` 不显示入口或运行状态，使用 `/retry` 打开菜单、`/guard` 和 `/stall` 查看通知报告；人设入口仅显示当前名称或「无」。LAB 的底栏入口显示为「常用」，菜单先列常用语，再列新增、修改、删除操作。

## 其他宿主

`plugins/dsh`、`plugins/claude-code`、`plugins/codex`、`plugins/opencode` 和 `plugins/pi-desktop` 保存其他宿主的源码或占位说明。`skills/` 保存技能备份。

## 开发检查

```bash
npm test
npm run test:sdk -- <已安装的-pi-coding-agent-包目录>
```

插件代码在宿主进程内运行，安装前请检查来源和权限。提交前先在本地验证，再提交 Git 记录。
