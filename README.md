# Agent Plugins Hub

这个仓库保存我自己维护的智能体插件源码。Pi 插件按独立目录管理，每个插件都可以单独安装，也可以通过根目录的 `package.json` 一次加载全部入口。

## Pi 插件

| 插件 | 功能 | 入口 |
|---|---|---|
| [`persona`](plugins/pi/persona/README.md) | 按当前对话选择 Markdown 人设 | `/persona` |
| [`rewind`](plugins/pi/rewind/README.md) | 回退到消息之前，或撤销最后一条纯文本回复 | `/rewind`、`/undo-reply` |
| [`remote`](plugins/pi/remote/README.md) | 查看局域网和 Tailscale 连接信息，管理 pi-web 远程配置 | `/remote` |
| [`cmd-guard`](plugins/pi/cmd-guard/README.md) | 命令超时兜底、GUI 拦截、长时间运行状态 | `/guard`、`/stall` |
| [`retry-level`](plugins/pi/retry-level/README.md) | 调整模型请求重试档位 | `/retry` |

三个原先放在 `pi-seep-ext` 中的扩展现在已经拆成三个包。它们共享思路，但安装和加载互相独立。

已移除的旧实验插件 `shell-guard`、`seep-workbench` 和 `pi-advisor` 不再属于本仓库。

## 安装

克隆仓库后，只安装需要的插件：

```bash
pi install ./plugins/pi/persona
pi install ./plugins/pi/rewind
pi install ./plugins/pi/remote
pi install ./plugins/pi/cmd-guard
pi install ./plugins/pi/retry-level
```

只执行你需要的那一行。想一次装齐，可在仓库根目录运行 `pi install .`，或直接运行 `pi install git:github.com/gthubtom1/agent-plugins@main`。不要同时安装根包和同名独立包。

安装后重新打开 Pi 会话。每个插件目录的 README 记录了插件用途、命令和单独安装方法。

## 其他宿主

`plugins/dsh`、`plugins/claude-code`、`plugins/codex`、`plugins/opencode` 和 `plugins/pi-desktop` 保存其他宿主的源码或占位说明。`skills/` 保存技能备份。

## 开发检查

```bash
npm test
npm run test:sdk -- <已安装的-pi-coding-agent-包目录>
```

插件代码在宿主进程内运行，安装前请检查来源和权限。提交前先在本地验证，再提交 Git 记录。
