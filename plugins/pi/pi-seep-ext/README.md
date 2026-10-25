# pi-seep-ext —— pi 的三件套：人设 / 回退 / 手机连

一个包，三个独立扩展，**不需要修改 pi-web**，pi CLI 与 pi-web 都能用。

| 扩展 | 一句话 | 命令 |
| --- | --- | --- |
| **persona** | 按**对话**选人设，随时切换 / 关闭；人设就是目录里的文件 | `/persona` |
| **rewind** | 回退到某条消息之前；只删最后一条回复 | `/rewind`、`/undo-reply` |
| **remote** | 手机连上这台机器：地址 + 终端二维码 + 密码 + 自检 | `/remote` |

> **给智能体**：安装请照 [`INSTALL.md`](INSTALL.md) 执行（先探测、编号清单、问过再装）。
> 人只需要说：「把这个仓库里 pi 的插件装上，装之前先问我要装哪些。」

---

## 安装

```bash
# 从 GitHub（root package.json 的 pi.extensions 已包含本包）
pi install git:github.com/gthubtom1/agent-plugins@main

# 或只装这一包（本地路径 / 临时试用）
pi install <repo>/plugins/pi/pi-seep-ext
pi -e <repo>/plugins/pi/pi-seep-ext
```

装完**新开一个会话**生效（扩展在会话启动时加载）。

可选依赖：`qrcode-generator` —— 只有想在**终端**里看二维码才需要；网页端只显示网址，缺了也不影响加载。

---

## persona —— 人设是目录，选择跟着对话走

```
~/.pi/agent/
├── personas/
│   ├── 色情破甲.md       ← 文件名就是人设名，也是弹窗里显示的名字
│   └── 小码酱.md
├── RULES.md              ← 全局规则，与人设解耦（换人设不影响规则）
└── personas.json         ← 只有两个设置：mode、defaultId
```

- **放进去 = 可用**，移走 = 下架，改名 = 改名；不需要 reload，不需要索引文件。
- 只认一级目录下的 `.md`；隐藏文件、子目录、其它扩展名忽略。
- 内容**整份原文**注入，所以别放 frontmatter 之类的元数据。

| 操作 | 方式 |
| --- | --- |
| 看当前人设 | 状态栏常显 `🧑‍🎤 人设：小码酱` / `人设：无`，**这一格是按钮**，点它等于 `/persona` |
| 换 / 关 | `/persona` → 弹窗（`无人设` + 每个文件 + `⚙ 注入模式`）；`/persona off` 直接关 |
| 直接指定 | `/persona 小码酱` |
| 切注入模式 | 弹窗里的 `⚙` 行，或 `/persona mode` |
| 大号徽标 | `/persona badge` —— 在输入框上方多一行 |

- 弹窗里按 **Esc = 什么都不改**（不会被当成"无人设"）。
- 选择**写进当前会话**（append-only 的 session entry）→ 两个对话互不影响。
- **人设不随回退还原**：它是这个对话的设置，不是历史事件。

### 两种注入模式

| 模式 | 行为 | 代价 |
| --- | --- | --- |
| `cached`（默认） | 写成结构化 prompt **section**，逐字不变 → **提示词缓存继续有效** | 依赖 section 机制 |
| `every-turn` | 每轮强制写进系统提示词 | 破坏缓存，贵 |

### 这一版修掉的两个真问题

1. **切「无人设」不残留**：`cached` 模式下显式**删除** `personality` section
   （pi 的 `diffSystemPromptSections` 支持 `null` 删除语义）。旧实现只"不再写"，
   于是旧人设会一直跟着请求走，而 UI 显示"无人设"。
2. **只删自己写过的 section**：由 `PERSONALITY.md` 插件挂上去的身份不动；
   `every-turn` 模式下会剥掉别人的 `<personality>` 块，保证**模型只看到一个身份**。

### 迁移旧布局

上一代实现把文件名生成成 `p_k1udshge.md`、名字存在 `personas.json` 里。本扩展以文件名为准：

```bash
node --experimental-strip-types scripts/migrate-legacy-personas.mjs --dry-run   # 先看计划
node --experimental-strip-types scripts/migrate-legacy-personas.mjs            # 执行
```

不删文件、不覆盖已有文件；`mode` 从 `persona-inject.json` 继承。

---

## rewind —— 回退用官方 API，不碰会话文件

| 命令 | 做什么 |
| --- | --- |
| `/rewind` | 弹窗选一条用户消息（新的在前）→ 有工具调用时二次确认 → 回退 → **原文放回输入框** |
| `/rewind list` | 列出可回退点（最近 15 条，带 `[tools]` 标记） |
| `/undo-reply` | 只删最后一条**纯文本**回复，问题回到输入框（重刷被拒绝的回合） |

实现只用 `navigateTree(targetId)`：把会话树的当前叶子移回去。旧分支还在文件里，可以再走回来，
**不存在写坏会话文件的风险**（上一代是物理截断 JSONL）。

两点必须说清：

- 回退只影响**上下文**，不撤销**副作用**（写过的文件、跑过的命令）；
- 含工具调用的回合会先确认；`/undo-reply` 遇到这种回合会拒绝并提示改用 `/rewind`。

---

## remote —— 手机连上，不改 pi-web

一次性设置（每台电脑一次，只有用手机才需要）：

```powershell
setx PI_WEB_HOSTNAME 0.0.0.0     # 之后照常 `pi-web`
```

`setx` 只影响新开的进程 → **重开终端 + 重启 pi-web** 才生效；忘了设也没关系，
`/remote` 会直接告诉你，而不是给一个打不开的链接。

| 命令 | 做什么 |
| --- | --- |
| `/remote` | 菜单：局域网 / Tailscale / 登录密码 / 自检（上次成功的排第一） |
| `/remote lan` | 枚举地址 → **逐个真连一次** → 地址 + 密码状态（终端里还画二维码） |
| `/remote tailscale` | 查状态 → 没连就问一句再 `tailscale up` → 地址；域名可选启用 |
| `/remote password` | 显示 / 生成（**立即生效**）/ 关闭 |
| `/remote check` | 自检 5 行：绑定 · 端口 · Tailscale · 地址 · 结论 |
| `/remote qr` | 强制画二维码（网页里行高会撕开图案，一般扫不了） |

### 为什么网页里只给网址

二维码是**半方块字符**画的，要求行高 1:1。终端满足，pi-web 的代码块行高约 1.5 →
图案被撕成一条条缝、扫不出来。所以：**网页只给可点的网址，终端才画码**。

### Tailscale 探测（哪台机器都能用）

安装位置因机器/包管理器而异，按顺序试，猜错只花一次 spawn：

1. `PI_TAILSCALE_PATH` / `TAILSCALE_PATH` / `TAILSCALE_CLI`（显式指定，永远优先）
2. `PATH` 里的 `tailscale`
3. 平台常见位置：`%ProgramFiles%\Tailscale`、用户目录、scoop、winget link、chocolatey /
   macOS 应用包与 Homebrew / Linux 的 `/usr/bin`、`/usr/sbin`、snap
4. 都没有 CLI 时，退化成**读网卡的 100.64/10 地址**：能出地址，只是查不到连接状态

状态处理（不杀进程 —— Windows 上它是系统服务）：

| `BackendState` | 处理 |
| --- | --- |
| `Running` | 直接给地址 |
| `NoState` / `Stopped` / `Starting` | 问一句再 `tailscale up`；Windows 上还会检查并拉起托盘 `tailscale-ipn.exe`（**必须**，否则后端一直停在 `Starting`），然后每秒轮询最多 45 秒 |
| `NeedsLogin` | 给 `AuthURL` / 提示打开客户端 —— 只能人来点 |

### 能力边界

- **绑定地址改不了**（socket 在启动时定死）→ 探测不通时报告会说"重启 pi-web 并 `setx`"。
- **密码可以运行期改**：pi-web 与扩展同进程，`proxy.ts` 每个请求都读 `process.env.PI_WEB_PASSWORD`，
  所以生成后立即生效；密码存进 `<agentDir>/pi-web-remote.json`，重启后自动恢复。
- **二维码里放不了密码**：上游登录页只认表单（`?pw=` 是旧 fork 的补丁，已放弃）→ 扫码后输一次，cookie 管 30 天。
- **域名（MagicDNS）**：IP 不需要白名单；域名会被 pi-web 挡成 403，`/remote tailscale` 里选「是」即**立即启用**并持久化。
- **Cloudflare 临时隧道不适用**：域名每次都变，而上游只支持精确白名单 → 403。

---

## 开发

```bash
npm test     # 77 个用例：纯逻辑 + 用假运行时把三个扩展端到端跑一遍
```

没有构建步骤：pi 直接加载 TypeScript。`typescript` / `@types/node` 只在开发时用。

```
extensions/persona.ts   状态栏 + /persona 弹窗 + 注入钩子
extensions/rewind.ts    /rewind、/undo-reply
extensions/remote.ts    /remote 四项菜单
lib/inject.ts           section 增删（含"只删自己的"）、历史人设文本剔除
lib/personas.ts         目录即人设、RULES.md、personas.json
lib/session-state.ts    每会话 persona entry
lib/rewind-targets.ts   可回退点、只删回复的判定
lib/net.ts              网卡枚举分类（局域网 / Tailscale / 虚拟网卡）
lib/tailscale*.ts       状态解析 + CLI 多路探测
lib/qr.ts               文本二维码（半方块，可选依赖）
lib/probe.ts            端口探测与识别
lib/remote-settings.ts  远程设置与密码持久化
lib/migrate-legacy.ts   旧布局 → 文件名布局
lib/pi-api.ts           用到的 pi 扩展 API 结构类型（无依赖、无构建）
```
