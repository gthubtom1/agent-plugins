# Pi 插件

每个插件都是独立的包，有自己的入口、清单和文档。

| 插件 | 命令 | 功能 |
|---|---|---|
| [persona](persona/README.md) | `/persona` | 选择当前对话的 Markdown 人设 |
| [rewind](rewind/README.md) | `/rewind`、`/undo-reply` | 回退对话或撤销最后一条纯文本回复 |
| [remote](remote/README.md) | `/remote` | pi-web 远程连接信息和配置 |
| [retry-level](retry-level/README.md) | `/retry` | 调整模型请求重试档位 |
| [cmd-guard](cmd-guard/README.md) | `/guard`、`/stall` | 前台命令超时兜底和状态显示 |

先克隆仓库，再在仓库根目录安装需要的插件，例如：

```bash
pi install ./plugins/pi/persona
```

只试一次用 `pi -e ./plugins/pi/persona`。需要全部插件时可运行 `pi install git:github.com/gthubtom1/agent-plugins@main`。不要同时安装根包和其中同名的独立插件。安装后新开 Pi 会话生效。

如果先前按本地路径安装了旧三合一包，先用 `pi list` 找到旧路径并用 `pi remove <旧路径>` 移除，再按需装新目录。已有的人设文件和会话选择不用迁移。
