# persona — 按对话选择人设

在 `<agentDir>/personas/` 放入 `严师.md` 等文件（默认目录为 `~/.pi/agent/personas/`）。只读取第一层的非隐藏 `.md` 文件；文件名是人设名，正文是人设内容。

- `/persona` 打开选择菜单；`/persona 严师` 直接选择；`/persona list` 列出人设；`/persona off` 关闭。按 Esc 不改变选择。pi-web 可点状态栏打开菜单。
- 选择保存在当前对话里，回退消息不会恢复旧人设。可在 `<agentDir>/personas.json` 用 `{"defaultId":"严师"}` 为尚未选择人设的对话指定默认值。
- 扩展只修改系统提示词的 `personality` 段，不改写其他段或历史消息。

## 本地安装

在要启用插件的项目目录运行（把路径换成本地仓库的绝对路径）：

```sh
pi install --local "/path/to/agent-plugins/plugins/pi/persona"
```

只试一次可用 `pi -e "/path/to/agent-plugins/plugins/pi/persona"`。无需安装其他扩展或依赖。在本包目录用 Node.js 22.18+ 运行 `npm test`。
