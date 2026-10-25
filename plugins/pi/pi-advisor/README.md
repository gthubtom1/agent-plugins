# pi-advisor（第三方：`@hk_net/pi-advisor`）

本目录**不放代码**，只登记"用哪个顾问、为什么、怎么配"。
装法是一条 npm 命令，所以永远跟着上游更新。

```bash
pi install npm:@hk_net/pi-advisor
```

---

## 为什么是这一个

pi 生态里顾问类插件至少 6 个，但**能跑在 pi-web 里的**只有一部分：

| 包 | 能否在 pi-web（RPC）里用 | 原因 |
|---|---|---|
| **`@hk_net/pi-advisor`** | ✅ 能 | 审查在 `agent_settled` 里做，没有按 `ctx.mode` 设门；意见用 `sendMessage(display:true)` 落到对话里 |
| `@bacnh85/pi-advisor` | ❌ 不能 | `agent_settled` 与 `before_agent_start` 里写着 `if (ctx.mode !== "tui") return` —— **只在终端工作** |
| `pi-advisor-flow` | ✅ 大概能（1MB，未逐行审） | 没有 `ctx.mode` 门 |
| `advisor-pi` / `pi-critique-model` | 未验证 | — |

判断方法（以后换包时照做）：解包后 `grep -rn 'mode !== "tui"'`，命中就说明它在网页里不做事。

---

## 它做什么

- **自动审查**：一轮任务结束后，让第二个（更强的）模型看完整转录，给出**一条**带严重度的意见（blocker / concern / nit），同类重复会被去重；
- **手动审查**：`/advise` 随时来一次；
- **可调用工具**：主模型自己也能咨询顾问；
- **卡住自动求助**：连续报错 / 重复同一个工具调用 N 次触发（`whenStuck`）。

## 配置

全局：`~/.pi/agent/advisor.json`（项目级：`<cwd>/.pi/advisor.json`，仅项目受信任时生效）

```json
{
  "model": "magpie/codex/gpt-6-luna",
  "thinking": "high",
  "onDone": true,
  "whenStuck": 3
}
```

| 键 | 说明 |
|---|---|
| `model` | 审查模型，格式 `<provider>/<modelId>`（按**第一个** `/` 切分，所以 id 里带斜杠也没问题） |
| `thinking` | 审查时的思考档位 |
| `onDone` | 一轮结束后自动审查（**每次多一次模型调用**，费额度） |
| `whenStuck` | 连续 N 次报错或重复工具调用时自动咨询，0 = 关 |

命令：`/advisor status` 看当前解析结果；`/advisor <provider/id>` 直接设模型；`/advise` 立刻审一次；`/advisor on-done off` 关掉自动审查。

> ⚠️ 交互式模型选择器（`/advisor` 不带参数）用的是 `ctx.ui.custom`，**只在终端可用**；
> 在 pi-web 里请用直接指定的形式。

## 注意

- 每轮自动审查会**多花一次模型调用**。只想手动用就 `onDone: false`。
- 这个包里读配置的路径写死了 `~/.pi/agent/advisor.json`，**不认 `PI_CODING_AGENT_DIR`**；
  在隔离环境里试它时，配置会落到真实目录（无副作用，因为隔离环境外的 pi 没装这个包）。
- 与 persona 类插件不冲突：顾问只**读**转录、往对话里投递消息，不改系统提示词。
