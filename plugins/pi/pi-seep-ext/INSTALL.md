# INSTALL —— 给 AI 智能体的安装指令

> 这份文件是**写给智能体看的**，不是给人看的。人只需要说一句：
> 「把这个仓库里 pi 的插件装上，装之前先问我要装哪些。」
> 智能体读到这里，按下面的顺序执行。**任何一步都不许跳过、不许合并。**

---

## 0. 铁律（违反就等于装错）

1. **先探测，再列编号清单，然后停下来问用户。** 不要一条命令装完再汇报。
2. **清单必须编号**，每项都要写：装什么 / 为什么 / 要不要重启 / 怎么撤销 / 有什么风险。
   用户只会回「1、3」这种编号，所以编号必须稳定。
3. **不要代替用户装第三方软件**（尤其 Tailscale）。缺了就告知 + 给官方下载地址，等用户装完再继续。
4. **不要静默改系统环境变量。** 要改就写清楚改了什么、写进哪里、怎么撤销。
5. **装完必须验证**，并把「装了什么 / 没装什么 / 为什么」三段结论报告给用户。

---

## 1. 探测（全部只读，不改变任何东西）

| 要探测的 | 命令（Windows / macOS·Linux） | 用来决定 |
| --- | --- | --- |
| pi 在不在、什么版本 | `pi --version` | 版本太老就提示升级，别硬装 |
| pi 的 agent 目录 | `$env:PI_CODING_AGENT_DIR` / `$PI_CODING_AGENT_DIR`，为空则是 `~/.pi/agent` | 人设文件、远程配置放哪 |
| 已装了哪些包 | `pi list` | 是否已装过本包（避免重复） |
| 是否已有单文件扩展 | 列 `~/.pi/agent/extensions/*.ts` | 是否与旧版插件撞车 |
| pi-web 在不在 | `pi-web --version`（或看 30141 端口是否在听） | **远程功能的前提**；没有 web UI 时「远程」这项可以跳过 |
| Tailscale CLI | `where tailscale`（Win）/ `which tailscale`（*nix）；再查常见位置 | 远程「随时随地」的前提 |
| Tailscale 状态 | `tailscale status --json` → 看 `BackendState` | 决定要不要执行 `tailscale up` |
| 是否要用局域网连 | `$env:PI_WEB_HOSTNAME` | 不是 `0.0.0.0` 就得改，否则手机连不上 |
| 端口占用 | Windows `netstat -ano \| findstr :30141` | 端口被占就得换端口 |

> 探测结果自己留着，不要一次性全贴给用户；用户只在清单里看结论。

---

## 2. 生成编号清单（然后**停住**）

按探测结果，只把**确实需要**的项列出来，格式照抄：

```text
我查了一下这台机器，需要你决定这几件事（回编号就行，例如「1、3」）：

1) 装 pi-seep-ext（人设 + 回退 + 远程三个扩展）
   方式：pi install <本包路径或 git 地址>
   影响：新开 pi 会话生效；不改任何全局配置
   撤销：pi remove <同一个地址>

2) 设 PI_WEB_HOSTNAME=0.0.0.0（只有想用手机/局域网连才需要）
   影响：pi-web 会监听所有网卡；**同一 Wi-Fi 的其他人也能打开**
   撤销：setx PI_WEB_HOSTNAME ""（然后重开终端）

3) 装 / 登录 Tailscale（只有想在外网用手机才需要）
   现状：<没装 | 已装未连接 | 已连接 100.x.x.x>
   没装的话请你先去 https://tailscale.com/download 装好并登录，装完告诉我

4) 迁移旧版人设文件名（只有你以前用过 p_xxxxxxxx.md 那种才需要）
   方式：先 --dry-run 给你看清单，再决定要不要执行

5) （可选）装 qrcode-generator —— 只有想在终端里看二维码才需要；
   网页端只显示网址，不装也能用
```

**列完就停。** 用户不回，就什么都不做。

---

## 3. 安装（只做用户点到的编号）

### 3.1 装本包

```bash
# 从 GitHub（推荐，root package.json 的 pi.extensions 已包含本包）
pi install git:github.com/gthubtom1/agent-plugins@main

# 或只装本目录（本地路径）
pi install <仓库路径>/plugins/pi/pi-seep-ext

# 临时试一次，不写配置
pi -e <仓库路径>/plugins/pi/pi-seep-ext
```

装完**必须新开一个会话**（扩展在会话启动时加载，正在跑的会话不会更新）。

### 3.2 可选二维码依赖

网页端不需要它（只显示网址）。想在**终端**里看二维码才装：

```bash
npm install qrcode-generator --prefix <包目录>
```

缺了它不影响加载：`/remote` 会退回只给网址。

### 3.3 旧人设迁移（只在用户点 4 时做）

```bash
node --experimental-strip-types <包目录>/scripts/migrate-legacy-personas.mjs --dry-run
# 把清单给用户确认后，去掉 --dry-run 再跑
```

它只做一件事：把 `p_xxxxxxxx.md` 改名为 `<名字>.md`（内容不动、不删文件、不覆盖已有文件），
并把旧的 `persona-inject.json` 里的 `mode` 继承过来。执行前先确认 agent 目录是最新的备份。

---

## 4. 验证（装完立刻做，别问用户"你试试"）

```bash
pi list                                  # 应能看到本包
```

然后**新开一个 pi 会话**，确认：

1. `/persona`、`/rewind`、`/undo-reply`、`/remote` 出现在命令列表里；
2. 状态栏出现 `🧑‍🎤 人设：无`（pi-web 里是可点的按钮）；
3. `/remote check` 输出 5 行左右：绑定 / 端口 / Tailscale / 地址 / 结论。

pi-web 里的手工验收（一次就够）：

1. 点状态栏的「人设」→ 弹窗列出 `无人设` + 每个人设文件 + `⚙ 注入模式`；
2. 选一个人设 → 状态栏变成 `🧑‍🎤 人设：<名字>`；
3. 再选「无人设」→ 状态栏回到 `人设：无`，**下一轮回答不再带人设语气**（旧实现这里会残留，已修）；
4. 发一句话后 `/undo-reply` → 最后一条回复消失、问题回到输入框。

---

## 5. 远程访问的前置（最容易装错的地方）

**先判断用户要哪种连法，再动手。**

| 用户想要 | 需要什么 | 谁来做 |
| --- | --- | --- |
| 手机在同一 Wi-Fi 打开 | `PI_WEB_HOSTNAME=0.0.0.0` + 重启 pi-web | 智能体执行，**告知风险**（同一网络内谁都能进） |
| 在外面/4G 也能开 | 电脑和手机都装 Tailscale 并登录同一账号 | **用户自己装**；智能体只做检测与提示 |
| 用固定域名打开 | 上面 + `/remote tailscale` 里选「启用域名」 | 智能体可以点，但要让用户确认 |

### Tailscale 检测与处理

1. **没装**（找不到 CLI、也没有 100.x 地址）
   → 告诉用户：`请到 https://tailscale.com/download 安装并登录，装好告诉我`。
   → **不要**自己下载安装包，也不要代为登录。
2. **装了但没连**（`BackendState` 是 `Stopped`/`NoState`）
   → 让用户在 pi 里执行 `/remote tailscale`，它会问一句再 `tailscale up`；
   → Windows 上它还会检查托盘程序 `tailscale-ipn.exe`，没跑就自动拉起（**必须**，否则后端会一直停在 `Starting`）。
3. **需要登录**（`BackendState` 是 `NeedsLogin`）
   → 只能用户本人点：给出 `AuthURL` 或让他打开托盘图标。
4. **已连接**（`Running`）
   → `/remote tailscale` 直接给地址：优先 `100.x.x.x`（不需要白名单），
   域名（`xxx.ts.net`）需要 `/remote tailscale` 里启用一次（立即生效，会写进 `pi-web-remote.json`）。

### 密码策略

默认**不设密码**。如果用户要局域网访问，必须明确告知：

> 不设密码时，同一 Wi-Fi 里任何人打开浏览器就能操作你的 agent（读文件、跑命令）。

要加密码：`/remote password` → 生成（立即生效，重启后自动恢复）。

---

## 6. 卸载与回滚

| 做了什么 | 怎么撤 |
| --- | --- |
| `pi install ...` | `pi remove <同一个地址>` |
| `setx PI_WEB_HOSTNAME 0.0.0.0` | `setx PI_WEB_HOSTNAME ""` 后重开终端 |
| `/remote password` 生成过密码 | `/remote password` → 「关闭密码」，或删 `~/.pi/agent/pi-web-remote.json` |
| 启用了域名白名单 | 同上，删掉 `pi-web-remote.json` 里的 `allowedHosts` |
| 人设迁移（改名） | 迁移只改文件名；按 dry-run 清单把名字改回去即可，内容不受影响 |

---

## 7. 与其它插件的冲突（先检查，再装）

- **`pi-prompt-compat`（本仓库里也有）**：它把 `PERSONALITY.md` 常驻注入。和本包的
  `persona` 都属于"决定模型身份"的功能，**同时开会重复注入身份**。
  → 建议二选一；要都留，就只能靠本包的「只留一个身份」逻辑去剥对方的块，行为不一定符合预期。
- **单文件版旧插件**（如果 `~/.pi/agent/extensions/` 里已有同名功能）：本包是包形式安装，
  不会覆盖 `extensions/` 下的单文件，但两份会同时加载 → **重复的命令名会冲突**，先卸旧的再装。
- **任何自带 `retry` / `guard` 状态的扩展**：状态栏是一行共用的，装完看一眼是否太挤；
  本仓库的 `cmd-guard` 与 `retry-level` 已经把状态压成短文本并且可点。
