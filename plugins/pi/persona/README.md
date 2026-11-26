# persona — 按对话选择人设

Pi 首次加载扩展并启动会话时会建立 `<agentDir>/personas/`（默认 `~/.pi/agent/personas/`）。把 `严师.md` 等文件放进去，下一次打开菜单时就会出现，无需重启、重新安装或维护索引。只读取第一层的非隐藏 `.md` 文件；文件名是人设名，正文是人设内容。

- `/persona` 打开菜单，或在 Pi Web 点击底栏的人设名称（未选择时显示「无」）。底栏仅显示名称或「无」，不带 emoji 和「人设：」前缀。从菜单选中人设后，从下一次模型请求起应用到该对话。
- 用菜单的「新建人设」或 `/persona new` 输入名字和 Markdown 正文。保存不会覆盖同名文件，也不会自动切换当前人设。
- `/persona 严师` 直接选择；`/persona list` 列出人设；`/persona off` 关闭。按 Esc 不改变选择。
- 选择保存在当前对话里，回退消息不会恢复旧人设。可在 `<agentDir>/personas.json` 用 `{"defaultId":"严师"}` 为尚未选择人设的对话指定默认值。
- 扩展只修改系统提示词的 `personality` 段，不改写其他段或历史消息。`/persona mode` 在默认的 `cached`（保留提示词缓存）和 `every-turn`（每次请求重建当前系统提示词及工具声明）之间切换。设置是全局的。
- `/persona badge` 切换额外的状态徽标。

## 本地安装

在要启用插件的项目目录运行（把路径换成本地仓库的绝对路径）：

```sh
pi install --local "/path/to/agent-plugins/plugins/pi/persona"
```

只试一次可用 `pi -e "/path/to/agent-plugins/plugins/pi/persona"`。无需安装其他扩展或依赖。在本包目录用 Node.js 22.18+ 运行 `npm test`。
