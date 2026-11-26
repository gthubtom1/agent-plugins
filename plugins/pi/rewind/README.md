# rewind — 回退对话

- `/rewind` 选择一条用户消息，回退到它之前，并把原文填回输入框。`/rewind list` 列出最近 15 个回退点。
- `/undo-reply` 快速移除最后一条无工具调用的回复，并把问题填回输入框；不能直接回退时会打开选择列表。pi-web 状态栏的「⟲」按钮执行同一命令，仅显示符号以节省手机屏幕宽度。
- 若所选位置之后有工具操作，回退前会确认。回退只改变会话树的当前分支，不删除原分支，也不会撤销文件修改或命令产生的效果。

## 本地安装

在要启用插件的项目目录运行（把路径换成本地仓库的绝对路径）：

```sh
pi install --local "/path/to/agent-plugins/plugins/pi/rewind"
```

只试一次可用 `pi -e "/path/to/agent-plugins/plugins/pi/rewind"`。无需安装其他扩展或依赖。在本包目录用 Node.js 22.18+ 运行 `npm test`。
