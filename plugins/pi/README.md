# Pi Coding Agent 插件专区

收录面向 **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** 的原生 TypeScript / JavaScript 扩展插件。

---

## 插件开发规范（Pi 专有）

1. **入口规范**：插件为标准的 TypeScript 或 JavaScript 模块，默认导出工厂函数 `export default function(pi: ExtensionAPI) { ... }`。
2. **生命周期支持**：
   - 工具注册：`pi.registerTool(...)`
   - 斜杠命令：`pi.registerCommand(name, { description, handler })`
   - 快捷键与标志：`pi.registerShortcut(...)`、`pi.registerFlag(...)`
   - 事件监听：`pi.on("session_start" | "tool_call" | "message_end" | ...)`
3. **即时热重载**：支持在运行时通过 `await ctx.reload()` 动态加载新配置，无需重启宿主进程。

---

## 收录插件清单

| 插件名称 | 说明 | 交互形式 | 状态 | 快速直达 |
|---|---|---|---|---|
| `pi-infinite-retry` | 网络波动/429限流无限重试扩展 | 斜杠命令 `/retry` | 🟢 生产就绪 | [查看文档](pi-infinite-retry/README.md) |
