# DeepSeek Harness (dsh) 插件专区

收录专为 **DeepSeek Harness (dsh)** 开发的增强插件。

---

## 插件索引

- **[dsh-infinite-retry](./dsh-infinite-retry/)**：仿 PI-Desktop 无限重试插件。遇到网络波动或 429 限流时，自动持续重试直到成功，自带设置页面 Switch 开关，支持动态启停。

---

## 插件开发规范（dsh 专有）

DSH 插件基于 **Cordis** 微内核架构：
1. **package.json** 需包含 `dsh` 元数据声明与 `bundle.patch` 路径。
2. 宿主服务入口为 `index.js`，导出 `name`、`inject` 及 `apply(ctx, config)`。
3. 若包含前端 UI 控件，可提供 `client.js` 并通过 `ctx.slots.inject` 挂载到 DSH 前端插槽。
