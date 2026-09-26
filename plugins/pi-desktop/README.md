# PI-Desktop 插件专区

收录面向 **PI-Desktop** 的原生插件与扩展。

---

## 插件开发规范（PI-Desktop 专有）

1. 每个插件须包含 `manifest.json`，声明 `id`、`name`、`version`、`permissions` 与激活事件。
2. 支持使用 PI-Desktop 提供的 `PluginPack` 工具将目录打包为单文件 `.piplug` 分发包。
3. 可注册工作面板视图（Work Panel View）、Agent 工具（`agent.tool.register`）与自定义技能。
