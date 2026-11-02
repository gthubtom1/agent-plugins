# pi-prompt-compat

> Pi Coding Agent 人格（`PERSONALITY.md`）与全局粘性规则（`RULES.md` / Always-Apply）轻量兼容层扩展。

在不侵入、不修改 Pi 原版 Agent Runtime（保留原生 System Prompt、AGENTS.md、Skills、Tools、Compaction、Agent Loop）的前提下，让 Pi 原生获得两层关键 Prompt 机制：

1. **第一层：`PERSONALITY.md`** —— 独立 Personality Prompt Block（`<personality>` 分段）。
2. **第二层：`RULES.md`** —— 独立 Always-Apply / Sticky Rules Block（`<generic-rules>` 分段），确保在首次请求、连续 Tool Loop、长上下文和 Compaction 上下文压缩后每一次向 LLM 发送的 Prompt 中始终完整携带。

---

## 🌟 核心特性

- **双层独立装配**：`PERSONALITY.md` 与 `RULES.md` 彼此物理和语义解耦，分别注入 Pi 原生的结构化 System Prompt Sections。
- **全生命周期常驻（Sticky & Always-Apply）**：
  - 首轮对话：`before_agent_start` 动态挂载
  - 工具调用轮（Tool Loop）：`_runSystemPromptOptions` 自动延续
  - 上下文压缩后（Post-Compaction）：通过 Pi `CompactionEntry` 系统快照机制完美保留
  - 最底层的发送前拦截校验：`context_with_system` 保证每一轮 LLM 提示词都不丢规则
- **增量缓存与热重载**：基于文件 `mtime` 和 SHA256 哈希自动检测更新，支持运行时 `/rules-reload` 实时重载。
- **段落级去重算法**：内嵌智能段落比对引擎，当规则内容已被项目级 `AGENTS.md`、`SYSTEM.md` 包含时自动去重，杜绝浪费上下文。
- **容错友好**：当文件不存在或为空时，安全回退，不影响 Pi 默认行为。
- **内置调试支持**：提供 `/rules-status` 与 `--rules-debug` 标志，可精确实时监控每一轮注入状态与字数哈希。

---

## 📂 文件放置位置

插件优先读取全局配置，支持项目级覆盖：

| 作用域 | 文件路径 | 说明 |
|---|---|---|
| **全局（推荐）** | `~/.pi/agent/PERSONALITY.md` | 全局生效的人格设定 |
| **全局（推荐）** | `~/.pi/agent/RULES.md` | 全局生效的强制粘性规则 |
| **项目级覆盖** | `<项目根目录>/.pi/PERSONALITY.md` 或 `./PERSONALITY.md` | 当前项目覆盖人格 |
| **项目级规则** | `<项目根目录>/.pi/RULES.md` 或 `./RULES.md` | 当前项目专属 Always-Apply 规则 |

---

## 🚀 安装方式

### 方式一：安装完整本地包（推荐）

```bash
pi install <仓库路径>/plugins/pi/pi-prompt-compat
```

保留同目录的 `lib/`。不要只复制 `.ts` 文件，也不要同时加载 Seep 的提示词扩展。

### 方式二：运行时按需加载
```bash
pi --extension plugins/pi/pi-prompt-compat/index.ts
```

---

## 🛠️ 斜杠命令与调试标志

| 命令 / 标志 | 说明 |
|---|---|
| `/rules-status` | 查看当前生效的 PERSONALITY / RULES 来源路径、哈希、字数与请求统计 |
| `/rules-reload` | 强制从磁盘重新加载 `PERSONALITY.md` 与 `RULES.md` |
| `/rules-debug` | 切换调试模式开关（亦支持 `/rules-debug on` 或 `/rules-debug off`） |
| `pi ... --rules-debug` | 命令行参数，启动时开启每轮 LLM 请求的拦截校验日志 |

*(注：同时支持 `/omp-status`、`/omp-reload`、`/omp-debug` 别名)*

## Seep 回流修复（2026-11-02）

- 与 `pi-seep-ext` 的显式人设、关闭和目录默认选择保持一致，加载顺序不影响生效；不会把关闭的人设补回来。
- 每次模型请求按当前会话重新读文件，工具续轮也能更新/删除规则；修复最后一个系统增量，而非被后续增量覆盖的首条消息。
- 自定义 agent 目录支持 `~/`；仅修复命名系统段，不改用户、助手、工具结果和附件。
- **保留本插件原有的全局 + 项目规则叠加语义**；与 Seep 的项目优先选一份不同，不要两者同时加载。
- 包内 `lib/` 是必需依赖；不能只复制 `prompt-compat.ts` 一个文件。根安装清单已经按包内路径加载。
- 本插件不注入 Seep 专业规则、能力提醒或凭据边界；需要完整 Seep 时使用 Seep 安装器。

本机路径写死的旧冒烟入口已换为可移植入口。真实 SDK 验证：
`node scripts/test-sdk.mjs <pi-coding-agent 包目录> --standalone`（从仓库根执行）。
