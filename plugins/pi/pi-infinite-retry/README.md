# pi-infinite-retry（Pi Coding Agent 无限重试扩展）

专为 **Pi Coding Agent (`@earendil-works/pi-coding-agent`)** 打造的自动无限重试扩展插件。

自带 **原生斜杠命令 `/retry`**，支持实时切换开启、关闭或自定义重试次数，即时热重载生效，无需重启 Pi 进程！

---

## 📖 为什么需要这个插件？

在使用 Pi Coding Agent 进行长流程自动化、网页采集逆向、大规模代码重构或后台无人值守运行（如结合 Orca 挂机调度）时，经常会遇到偶发性网络故障：
- **上游模型网关波动**：中继或大模型网关偶发 `502 Bad Gateway`、`503 Service Unavailable`、`504 Gateway Timeout`、`520 / 524` 或 `ECONNRESET`。
- **高并发 429 限流**：高峰期突发 `429 Too Many Requests`，往往等待几十秒后即可恢复。
- **长连接与流传输中断**：`fetch failed`、`socket hang up`、`other side closed`、`timed out` 等网络瞬态错误。

**原生 Pi 的局限**：
Pi 内核默认的有界重试策略上限仅为 **3 次**。一旦遇到连续十几秒的网络拥塞或网关抖动，3 次耗尽后**整个会话回合直接硬报错中断**，等待人工介入。

**本插件的效果**：
- 通过 `/retry on` 一键将重试上限设为 **9999 次**（无限重试）。
- 直通 Pi 官方底层退避引擎（`retryAssistantCall` 与 `retryDelayMs`），享受官方指数避让与随机防雪崩抖动（单次等待上限安全钳制为 60 秒，绝不打爆网关）。
- 精准智能分类：仅对瞬态网络与网关异常持续重试；对于欠费（`insufficient_quota`）、越界（`context_length_exceeded`）等不可恢复错误立即报错退出，绝不死循环。
- 支持随时按 Esc / Ctrl+C 中断重试过程。

---

## ⚡ 核心命令与用法

在 Pi 的交互式终端（TUI）、Orca 终端或支持 slash-commands 的会话中直接输入：

| 命令 | 行为说明 |
|---|---|
| **`/retry`** | 一键切换开关状态（开 $\leftrightarrow$ 关） |
| **`/retry on`** 或 **`/retry infinite`** | 开启无限重试模式（9999 次重试，指数避让） |
| **`/retry off`** | 关闭无限重试，恢复 Pi 默认策略（3 次重试） |
| **`/retry status`** | 查询当前重试模式与上限设定 |
| **`/retry 50`** | 自定义最大重试次数为指定数值（如 50 次） |

---

## 🚀 安装步骤

### 方式一：直接放入全局扩展目录（推荐，全局生效）

将本插件的 `index.ts` 拷贝至 Pi 的全局扩展目录并重命名为 `infinite-retry.ts` 即可：

```bash
# Windows
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/infinite-retry.ts

# Linux / macOS
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/infinite-retry.ts
```

启动 Pi 或在会话中输入 `/reload` 即可加载。

### 方式二：单项目本地生效

放入当前项目目录的 `.pi/extensions/` 中：

```bash
mkdir -p .pi/extensions
cp index.ts .pi/extensions/infinite-retry.ts
```

---

## 📄 许可证

基于 [MIT License](LICENSE) 开源。
