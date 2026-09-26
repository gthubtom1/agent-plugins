# dsh-infinite-retry（DSH 无限重试插件）

仿照 **PI-Desktop（PR #759）** 的「无尽重试（Retry until success）」机制，专为 **DeepSeek Harness（dsh）** 打造的自动无限重试插件。

自带 **原生 Web / Desktop 设置页面 Switch 开关按钮**，随时一键开启或关闭，即点即生效，无需重启！

---

## 📖 为什么需要这个插件？

在使用 DSH 进行长时间任务、复杂代码重构或挂机开发时，常常会遇到以下情况：
- **第三方中继 / 代理服务不稳定**：偶发网关 `502 Bad Gateway`、`504 Gateway Timeout`、连接被对端重置（`ECONNRESET`）或 `fetch failed`。
- **高并发 429 限流**：使用高峰期经常返回 `429 Too Many Requests`，但往往几十秒后即可恢复。
- **非标准网络报错**：部分兼容网关将上游网络中断包装为 `unexpected EOF`、`stream_read_error` 或 `network_error`。

**原生 DSH 的痛点**：
DSH 默认采用有界重试策略（通常仅重试 2 次或 5 次）。一旦中继服务波动超过上限，**整个会话回合直接硬崩溃**，AI 停止输出，必须人工重新输入或手动催促。

**本插件的效果**：
- 在 **设置 → 通用设置** 中自动增加一个 **「无尽重试（Retry until success）」Switch 开关**。
- 开启后，只要发生可恢复的网络波动或限流，系统就会自动按指数退避持续重试，直到恢复并顺利完成任务！
- 关闭后，立即恢复 DSH 原生的默认有限重试逻辑。

---

## ⚡ 核心特性

1. **可视化开关（Switch Toggle）**：
   - 注入 DSH 前端界面的「设置 → 通用设置」区域。
   - 绿色开启、灰色关闭，点击即时保存，下一个模型请求立即生效，**无需重启 DSH**。
2. **直通 DSH 官方底层引擎**：
   DSH 内核（`@deepseek-ai/dsh-llm-retry`）本身原生就设计了 `mode: "always"` 的无限重试执行逻辑。本插件通过 Cordis 的优先前置拦截（`prepend`），将可恢复异常精准引导至官方的 `always` 分支，**零侵入、零破坏，完全享受官方的事件记录与状态流**。
3. **精准过滤，绝不死循环**：
   - **可重试（无限重试）**：网络断连、超时、ECONNRESET、429 限流、5xx 网关错误、流非正常提前关闭、各类代理非标网络异常。
   - **致命错误（立即报错，绝不重试）**：API Key 错误（401/403/AUTH）、请求参数非法（400/422）、上下文超出（CONTEXT_WINDOW_EXCEEDED）、欠费（QUOTA_EXCEEDED）以及用户主动取消。
4. **退避与防雪崩抖动（Jitter）**：
   默认从 1 秒开始指数增加，单次最大等待 60 秒，并附加随机抖动（Jitter），防止多并发请求同时重发打爆反向代理。
5. **随时手动取消（AbortSignal 保护）**：
   完全响应用户的取消操作。在重试退避等待期间，点击界面的停止按钮或按 Ctrl+C，流程立即干净退出，绝不卡死进程。

---

## 🚀 安装步骤

### 本地目录解压挂载（零网络依赖，最稳定）

1. **解压插件**：
   将解压后的 `dsh-infinite-retry` 文件夹放入你的 DSH 插件目录：
   - Windows 默认路径：`C:\Users\<你的用户名>\.dsh\plugins\dsh-infinite-retry`
   - Linux / macOS 默认路径：`~/.dsh/plugins/dsh-infinite-retry`

2. **在 DSH Profile 中启用**：
   打开你的 profile 配置文件（以默认的 `web` profile 为例）：
   - 文件路径：`~/.dsh/profiles/web/package.json`

   在 `dependencies` 中添加本地引用：
   ```json
   "dependencies": {
     "dsh-infinite-retry": "file:../../plugins/dsh-infinite-retry"
   }
   ```

   在 `dsh.profile.bundles` 数组中追加插件名称：
   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "@deepseek-ai/dsh-base",
         "@deepseek-ai/dsh-web-app",
         "dsh-infinite-retry"
       ]
     }
   }
   ```

3. **启动或重启 DSH**：
   重新运行 `dsh` 命令或启动 DSH Desktop。
   打开浏览器访问 DSH，点击左下角 **「设置」→「通用设置」**，即可在界面中看到：
   ```text
   无尽重试（Retry until success）             [  ON  ]
   网络中断、超时或 429 限流时自动持续重试直到成功。关闭后恢复默认重试次数限制。
   ```

---

## ⚙️ 配置文件调参（可选）

如果你需要修改退避的极限时长，可以在 profile 的 `cordis.patch.yml` 中调整：

```yaml
- insert:
    - id: dsh-infinite-retry
      name: 'dsh-infinite-retry'
      config:
        enabled: true           # 初始开关状态
        initialDelayMs: 1000    # 初始等待重试时长（毫秒，默认 1 秒）
        maxDelayMs: 60000       # 最大退避时长（毫秒，默认 60 秒）
        jitterRatio: 0.2        # 随机抖动比例（默认 0.2）
```

---

## 🗑️ 卸载说明

若要卸载本插件：
1. 从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中移除 `"dsh-infinite-retry"`；
2. 从 `dependencies` 中删除 `"dsh-infinite-retry"`；
3. 删除 `~/.dsh/plugins/dsh-infinite-retry` 目录。
卸载后即刻恢复 DSH 原生默认行为。

---

## 📄 许可证

MIT License.
